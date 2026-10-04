/*
 * Zotero Sideline：每篇文献唯一会话的 JSON 附件存储。
 * 输入：宿主条目与消息/写入记录；输出：可同步的附件、检索和导出数据。
 * 依赖：storecodec（数据格式）、Zotero.Attachments.importFromFile、Zotero.File、条目与同步接口。
 * v3 沿用 sessions 数组的附件/导出格式，但数组最多一条，已移除新建、切换、命名和单条删除接口。
 * 启动和加载时只保留旧数据中更新时间最近的一条，直接写回附件，不备份被删除的旧会话。
 * 损坏 JSON 的 .corrupt 保护仍保留。去抖写入与清空共用串行队列；笔记/批注不随会话清空。
 */

Sideline.store = (function () {
  const { VERSION, MARKER, emptyRecord, sanitizeRecord, sanitizeMessages, sanitizeWriteDetail } = Sideline.storecodec;
  const TITLE_PREFIX = "Sideline 会话";
  const SAVE_DELAY_MS = 800;
  const MAX_CHARS = 2000000;

  /** itemID（顶层条目）→ 记录 */
  const records = new Map();
  /** itemID → 附件条目 ID（null 表示已确认该条目还没有会话附件） */
  const attachments = new Map();
  /** 传入 ID → 宿主条目 ID 的映射缓存 */
  const ownerKeys = new Map();
  /** itemID → 正在进行的加载 Promise，避免并发重复读附件 */
  const loading = new Map();
  /** 保存失败按文献隔离，避免另一篇成功写入后丢失本篇的实际错误。 */
  const saveFailures = new Map();

  let loadError = "";
  let lastWarning = "";
  let timer = null;
  let dirty = new Set();
  let lastSavedAt = 0;
  let queue = Promise.resolve();

  function serialize(task) {
    const next = queue.then(task, task);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function enabled() {
    return Sideline.config.bool("persistSessions");
  }

  function limits() {
    return {
      items: Math.max(1, Sideline.config.num("maxStoredItems")),
      messages: Math.max(2, Sideline.config.num("maxStoredMessages")),
      sessions: 1,
    };
  }

  // ---- 条目与附件的定位 ----

  /** 会话的宿主条目：PDF 附件上溯到父条目；独立附件返回自身并标记不可持久化 */
  function ownerOf(itemID) {
    let item = null;
    try {
      item = Zotero.Items.get(Number(itemID));
    }
    catch (error) {
      item = null;
    }
    if (!item || item.deleted) return null;
    const isAttachment = typeof item.isAttachment === "function" && item.isAttachment();
    if (isAttachment && item.parentID) {
      const parent = Zotero.Items.get(item.parentID);
      if (parent) return { item: parent, persistable: true };
    }
    return { item, persistable: !isAttachment };
  }

  function titleOf(item) {
    try {
      if (!item) return "";
      if (item.parentID) {
        const parent = Zotero.Items.get(item.parentID);
        if (parent) return String(parent.getField("title") || "");
      }
      return String(item.getField("title") || "");
    }
    catch (error) {
      return "";
    }
  }

  /** 在宿主条目的子附件里找插件自己的会话附件 */
  function findAttachment(owner) {
    if (!owner || typeof owner.getAttachments !== "function") return null;
    let ids = [];
    try {
      ids = owner.getAttachments() || [];
    }
    catch (error) {
      return null;
    }
    for (const id of ids) {
      const child = Zotero.Items.get(id);
      if (!child || child.deleted) continue;
      if (String(child.attachmentContentType || "") !== "application/json") continue;
      if (!String(child.getField("title") || "").startsWith(TITLE_PREFIX)) continue;
      return child;
    }
    return null;
  }

  /**
   * 把传入的 itemID（可能是 PDF 附件）归一成宿主条目的 ID。
   * 会话以宿主条目为键：否则从阅读器（附件 ID）与从条目面板（普通条目 ID）进入
   * 会各自建立一份记录，出现「同一篇文献两条会话」。
   */
  function keyOf(itemID) {
    const id = Number(itemID);
    if (ownerKeys.has(id)) return ownerKeys.get(id);
    const owner = ownerOf(id);
    const key = owner ? owner.item.id : id;
    ownerKeys.set(id, key);
    if (key !== id) ownerKeys.set(key, key);
    return key;
  }

  function activeSession(record) {
    if (!record || !record.sessions.length) return null;
    return record.sessions.find((entry) => entry.id === record.activeId) || record.sessions[0];
  }

  function ensureSession(record, name) {
    let session = activeSession(record);
    if (session) return session;
    session = {
      id: "conversation",
      name: name || "会话 1",
      created: Date.now(),
      updated: Date.now(),
      messages: [],
      writes: [],
    };
    record.sessions.push(session);
    record.activeId = session.id;
    return session;
  }

  function nextWriteId(session) {
    let max = 0;
    for (const entry of session.writes || []) {
      const match = String(entry.id || "").match(/^w(\d+)$/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return `w${max + 1}`;
  }

  // ---- 读写附件 ----

  function tempFilePath(owner) {
    let dir = "";
    try {
      const temp = Zotero.getTempDirectory();
      if (temp && typeof temp.clone === "function") {
        // nsIFile.append 使用宿主路径规则；Windows 的 OS.File 拒绝反斜杠目录中再拼接斜杠。
        const file = temp.clone();
        file.append(`sideline-sessions-${owner.id}.json`);
        return String(file.path);
      }
      dir = temp && temp.path ? String(temp.path) : "";
    }
    catch (error) {
      dir = "";
    }
    if (!dir) return "";
    const separator = dir.includes("\\") ? "\\" : "/";
    return `${dir.replace(/[\\/]+$/, "")}${separator}sideline-sessions-${owner.id}.json`;
  }

  async function createAttachment(owner, record) {
    const path = tempFilePath(owner);
    if (!path) throw new Error("无法取得临时目录，不能建立会话附件");
    const text = JSON.stringify(record);
    await Zotero.File.putContentsAsync(path, text);
    let attachment = null;
    try {
      attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID: owner.id,
        title: TITLE_PREFIX,
        contentType: "application/json",
        charset: "utf-8",
      });
    }
    finally {
      try {
        await Zotero.File.removeIfExists(path);
      }
      catch (error) {
        Sideline.util.warn(`清理临时会话文件失败：${Sideline.util.message(error)}`);
      }
    }
    Sideline.util.log(`已建立会话附件 ${attachment && attachment.key}（条目 ${owner.key}）`);
    return attachment;
  }

  /** 标附件文件为待上传，让改动尽快进入文件同步 */
  async function markForUpload(attachment) {
    try {
      if (!attachment || typeof attachment.isStoredFileAttachment !== "function"
        || !attachment.isStoredFileAttachment()) {
        return;
      }
      attachment.attachmentSyncState = "to_upload";
      await attachment.saveTx();
    }
    catch (error) {
      // 取不到 syncState 常量时跳过；Zotero 下次同步会按修改时间自行发现变化
      Sideline.util.warn(`标记附件待上传失败（不影响本地保存）：${Sideline.util.message(error)}`);
    }
  }

  /** 保留损坏副本：写到数据目录的 sideline/ 下，避免覆盖用户数据 */
  async function keepCorrupt(owner, raw) {
    try {
      if (!Zotero.DataDirectory || typeof Zotero.DataDirectory.getSubdirectory !== "function") return "";
      const dir = Zotero.DataDirectory.getSubdirectory("sideline", true);
      const path = `${dir}/sessions-attachment-${owner.id}.json.corrupt`;
      await Zotero.File.putContentsAsync(path, raw);
      return path;
    }
    catch (error) {
      return "";
    }
  }

  async function loadRecord(itemID) {
    const owner = ownerOf(itemID);
    if (!owner) return null;
    if (!owner.persistable) {
      const record = records.get(itemID) || emptyRecord(itemID, titleOf(owner.item));
      records.set(itemID, record);
      attachments.set(itemID, null);
      lastWarning = "独立附件没有父条目，无法把会话保存为子附件";
      return record;
    }
    const attachment = findAttachment(owner.item);
    if (!attachment) {
      const record = records.get(itemID) || emptyRecord(itemID, titleOf(owner.item));
      records.set(itemID, record);
      attachments.set(itemID, null);
      return record;
    }
    attachments.set(itemID, attachment.id);
    let raw = "";
    try {
      const path = await attachment.getFilePathAsync();
      if (!path) throw new Error("附件没有本地文件（可能尚未同步到本机）");
      raw = String(await Zotero.File.getContentsAsync(path) || "");
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.marker !== MARKER) throw new Error("附件内容不是 Sideline 会话数据");
      const record = sanitizeRecord(parsed, itemID);
      record.title = record.title || titleOf(owner.item);
      records.set(itemID, record);
      if (Array.isArray(parsed.sessions) && parsed.sessions.length > 1) {
        // 用户明确要求直接删除其余旧会话。仅写插件自己的附件，不触碰笔记/批注。
        try {
          await Zotero.File.putContentsAsync(path, JSON.stringify(record));
          await markForUpload(attachment);
        } catch (error) {
          // 有效数据的写入失败不能被误判为 JSON 损坏而清空。
          loadError = `旧会话清理未落盘：${Sideline.util.message(error)}`;
          Sideline.util.warn(loadError);
          scheduleSave(itemID);
        }
      }
      return record;
    }
    catch (error) {
      loadError = Sideline.util.message(error);
      const kept = raw ? await keepCorrupt(owner.item, raw) : "";
      Sideline.diagnostics.note(
        `会话附件损坏，已${kept ? `保留副本 ${kept}` : "无法保留副本"}并重建：${loadError}`,
      );
      const record = emptyRecord(itemID, titleOf(owner.item));
      records.set(itemID, record);
      return record;
    }
  }

  /** 取记录（必要时从附件加载）；并发调用共享同一次加载 */
  function ensureLoaded(itemID) {
    const id = keyOf(itemID);
    if (records.has(id)) return Promise.resolve(records.get(id));
    if (loading.has(id)) return loading.get(id);
    const task = loadRecord(id).then((record) => {
      loading.delete(id);
      return record;
    }, (error) => {
      loading.delete(id);
      loadError = Sideline.util.message(error);
      const record = emptyRecord(id, "");
      records.set(id, record);
      return record;
    });
    loading.set(id, task);
    return task;
  }

  async function saveRecord(itemID, createEmpty = false) {
    const failed = (reason) => { saveFailures.set(Number(itemID), reason); return false; };
    if (!enabled()) return failed("未启用会话保存");
    const record = records.get(Number(itemID));
    if (!record) return failed("找不到需要保存的会话记录");
    // 会话被清空但附件已存在时，仍要把空记录写回附件，否则下次加载会把旧内容读回来。
    // 没有附件时直接丢弃内存记录，不建立空附件。
    if (!createEmpty && !record.sessions.length && !attachments.get(Number(itemID))) {
      records.delete(Number(itemID));
      dirty.delete(Number(itemID));
      return false;
    }
    const owner = ownerOf(itemID);
    if (!owner || !owner.persistable) return failed("文献条目不存在或 PDF 没有父条目");
    if (record.sessions.length) record.updated = Date.now();
    enforceSize(record);
    enforceLimits();
    const text = JSON.stringify(record);
    try {
      let attachment = attachments.get(Number(itemID))
        ? Zotero.Items.get(attachments.get(Number(itemID)))
        : null;
      if (!attachment) {
        attachment = await createAttachment(owner.item, record);
        attachments.set(Number(itemID), attachment ? attachment.id : null);
      }
      else {
        const path = await attachment.getFilePathAsync();
        if (!path) throw new Error("附件没有本地文件");
        await Zotero.File.putContentsAsync(path, text);
        await markForUpload(attachment);
      }
      dirty.delete(Number(itemID));
      lastSavedAt = Date.now();
      loadError = "";
      saveFailures.delete(Number(itemID));
      recordDiagnostics();
      return true;
    }
    catch (error) {
      loadError = Sideline.util.message(error);
      saveFailures.set(Number(itemID), loadError);
      Sideline.diagnostics.note(`会话附件写入失败：${loadError}`);
      recordDiagnostics();
      return false;
    }
  }

  /**
   * 条目数、单条会话消息数与会话数上限；超限按更新时间淘汰最旧的。
   * 只统计「还有会话」的记录：已经清空的记录留在内存里只是为了避免重复读附件，
   * 若把它们也算进条数，下一次淘汰会误伤仍在使用的条目。
   */
  function enforceLimits() {
    const { items: maxItems, messages: maxMessages } = limits();
    for (const record of records.values()) {
      for (const session of record.sessions) {
        if (session.messages.length > maxMessages) {
          session.messages = session.messages.slice(-maxMessages);
        }
      }

    }
    const live = [...records.entries()].filter(([, record]) => record.sessions.length > 0);
    if (live.length <= maxItems) return;
    const byUpdatedDesc = live.sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
    // 淘汰要真正落到附件上：附件留在磁盘上，只从内存删掉会在下次加载时又被读回来
    for (const [key, record] of byUpdatedDesc.slice(maxItems)) {
      record.sessions = [];
      record.activeId = "";
      dirty.add(Number(key));
    }
  }

  /**
   * 单个条目的字符总量上限：附件不能无限增长。
   * 超出时从「最旧的会话、最旧的消息」开始丢，直到回落到上限以内。
   */
  function enforceSize(record) {
    let chars = JSON.stringify(record).length;
    if (chars <= MAX_CHARS) return false;
    let dropped = false;
    const ordered = record.sessions.slice().sort((a, b) => (a.updated || 0) - (b.updated || 0));
    for (const session of ordered) {
      let count = 0;
      while (session.messages.length - count > 1 && chars > MAX_CHARS) {
        // store 记录已归一化为普通 JSON 数据。删除一个非末尾数组项，只减少该项与一个逗号；
        // 用单项数组计长，保留 undefined/null、引号、反斜杠和 UTF-16 的原序列化规则。
        chars -= JSON.stringify([session.messages[count]]).length - 1;
        count++;
      }
      // 一次删除前缀，保留原数组身份和最新一条，避免逐次 shift 与整份记录反复序列化。
      if (count) { session.messages.splice(0, count); dropped = true; }
      if (chars <= MAX_CHARS) break;
    }
    return dropped;
  }

  function scheduleSave(itemID) {
    dirty.add(Number(itemID));
    const tools = Sideline.util.windowTools();
    if (timer && tools.clearTimeout) {
      tools.clearTimeout(timer);
      timer = null;
    }
    if (!tools.setTimeout) {
      void save();
      return;
    }
    timer = tools.setTimeout(() => {
      timer = null;
      void save();
    }, SAVE_DELAY_MS);
  }

  // ---- 对外接口（与旧存档接口同名，保证调用方无需改动） ----

  /** 立即落盘全部待写条目 */
  async function writeDirty() {
    const pending = [...dirty];
    if (!pending.length) return false;
    let wrote = 0;
    for (const itemID of pending) {
      // eslint-disable-next-line no-await-in-loop
      if (await saveRecord(itemID)) wrote++;
    }
    return wrote > 0;
  }
  function save() { return serialize(writeDirty); }

  async function flush() {
    const tools = Sideline.util.windowTools();
    if (timer && tools.clearTimeout) {
      tools.clearTimeout(timer);
      timer = null;
    }
    return serialize(writeDirty);
  }

  /** 有副作用的批注写入前必须确认本篇日志实际落盘，不用全局 flush 的布尔值猜测。 */
  function flushItem(itemID) {
    return serialize(() => saveRecord(keyOf(itemID)));
  }

  function saveError(itemID) {
    return saveFailures.get(keyOf(itemID)) || "";
  }

  /** 用户执行自动高亮时先实际写入插件自己的附件，不伪造消息，也不调用模型。 */
  function prepareWrite(itemID) {
    return serialize(async () => {
      const id = keyOf(itemID);
      await ensureLoaded(id);
      if (!(await saveRecord(id, true))) throw new Error(`无法保存会话附件：${saveError(id) || "写入未完成"}`);
      return true;
    });
  }

  /**
   * 写入某条会话的消息列表。
   * @param {number} itemID 顶层条目或它的 PDF 附件
   * @param {object} record {title, messages, sessionId, sessionName}
   */
  function touch(itemID, record) {
    return serialize(async () => {
      if (!enabled()) return null;
      const id = keyOf(itemID);
      const data = await ensureLoaded(id);
      if (!data) return null;
      const messages = sanitizeMessages(record && record.messages);
      const session = ensureSession(data, record && record.sessionName);
      if (!messages.length) {
        // 会话被清空：删掉该会话；整条记录没有会话时一并清除
        data.sessions = data.sessions.filter((entry) => entry.id !== session.id);
        if (!data.sessions.length) {
          data.activeId = "";
          dirty.add(id);
          scheduleSave(id);
          return null;
        }
        if (!data.sessions.some((entry) => entry.id === data.activeId)) {
          data.activeId = data.sessions[0].id;
        }
        scheduleSave(id);
        return null;
      }
      session.messages = messages;
      session.updated = Date.now();
      if (record && record.title) data.title = String(record.title).slice(0, 200);
      data.activeId = session.id;
      enforceLimits();
      scheduleSave(id);
      return session;
    });
  }

  function remove(itemID) {
    return serialize(async () => {
      const id = keyOf(itemID);
      if (!records.has(id) && !enabled()) return false;
      const data = await ensureLoaded(id);
      if (!data || !data.sessions.length) return false;
      records.delete(id);
      dirty.delete(id);
      // 附件本身不与条目绑定删除：清空内容后保留文件，避免触碰 Zotero 的删除流程
      data.sessions = [];
      data.activeId = "";
      records.set(id, data);
      dirty.add(id);
      await saveRecord(id);
      return true;
    });
  }

  /** 单条记录：返回活动会话的内容，形状与旧接口一致 */
  async function get(itemID) {
    await serialize(() => undefined);
    const data = await ensureLoaded(itemID);
    if (!data || !data.sessions.length) return null;
    return getSession(data.itemID, data.activeId);
  }

  /** 指定会话的内容（会话为空时返回 null） */
  async function getSession(itemID, sessionId) {
    await serialize(() => undefined);
    const data = await ensureLoaded(itemID);
    if (!data) return null;
    const session = data.sessions.find((entry) => entry.id === String(sessionId)) || activeSession(data);
    if (!session || !session.messages.length) return null;
    return {
      itemID: data.itemID,
      title: data.title || "",
      updated: session.updated || data.updated,
      messages: session.messages.map((entry) => Object.assign({}, entry)),
      sessionId: session.id,
      sessionName: session.name,
      sessionCount: data.sessions.length,
    };
  }

  /**
   * 追加一条写入记录（R11）。只记插件自己新建的子笔记/批注，供界面展示与撤销使用。
   * @param {object} entry {kind:"note"|"annotation", targetID, key, summary, sessionId}
   */
  function appendWrite(itemID, entry) {
    return serialize(async () => {
      const id = keyOf(itemID);
      const data = await ensureLoaded(id);
      if (!data) return null;
      const session = ensureSession(data);
      if (!Array.isArray(session.writes)) session.writes = [];
      const record = {
        id: nextWriteId(session),
        kind: entry && entry.kind === "note" ? "note"
          : (entry && entry.kind === "review" ? "review" : "annotation"),
        targetID: Number(entry && entry.targetID) || 0,
        key: String((entry && entry.key) || ""),
        summary: String((entry && entry.summary) || "").slice(0, 300),
        sessionId: session.id,
        time: Sideline.util.nowText(),
        timestamp: Date.now(),
        undone: false,
        detail: sanitizeWriteDetail(entry && entry.detail),
      };
      session.writes.push(record);
      scheduleSave(id);
      return record;
    });
  }

  /** 某条目（或指定会话）的写入记录，最新的在前 */
  async function listWrites(itemID, sessionId) {
    await serialize(() => undefined);
    const data = await ensureLoaded(itemID);
    if (!data) return [];
    const wanted = sessionId ? String(sessionId) : "";
    const out = [];
    for (const session of data.sessions) {
      for (const entry of session.writes || []) {
        if (wanted && entry.sessionId !== wanted) continue;
        out.push(Object.assign({}, entry));
      }
    }
    // 同一次操作里连续写入的多条记录时间戳会相同，因此再用 id 序号兜底排序（新号在前）
    const order = (id) => {
      const match = String(id || "").match(/(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    };
    return out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0) || order(b.id) - order(a.id));
  }

  /** 标记某条写入已撤销（条目本身由调用方删除，避免 store 依赖具体条目类型） */
  function markWriteUndone(itemID, writeId) {
    return serialize(async () => {
      const id = keyOf(itemID);
      const data = await ensureLoaded(id);
      if (!data) return false;
      for (const session of data.sessions) {
        const entry = (session.writes || []).find((item) => item.id === String(writeId));
        if (!entry) continue;
        entry.undone = true;
        scheduleSave(id);
        return true;
      }
      return false;
    });
  }

  /** 将预先落盘的批注写入日志补全；调用方负责 flush 后才报告完成。 */
  function updateWrite(itemID, writeId, fields) {
    return serialize(async () => {
      const id = keyOf(itemID), data = await ensureLoaded(id);
      if (!data) throw new Error("写入记录不可用");
      for (const session of data.sessions) {
        const entry = (session.writes || []).find((value) => value.id === String(writeId));
        if (!entry) continue;
        if (Number.isSafeInteger(fields.targetID)) entry.targetID = fields.targetID;
        if (fields.detail) entry.detail = sanitizeWriteDetail(Object.assign({}, entry.detail, fields.detail));
        scheduleSave(id);
        return entry;
      }
      throw new Error("找不到批注写入记录");
    });
  }

  /** 某条目的全部会话（含消息正文），供检索与导出使用 */
  async function allSessions(itemID) {
    await serialize(() => undefined);
    const data = await ensureLoaded(itemID);
    if (!data) return [];
    return data.sessions.map((session) => ({
      id: session.id,
      name: session.name,
      created: session.created || 0,
      updated: session.updated || 0,
      active: session.id === data.activeId,
      messages: session.messages.map((message) => Object.assign({}, message)),
      writes: (session.writes || []).map((entry) => Object.assign({}, entry)),
    }));
  }

  /** 某条目的全部会话（不含消息正文，供会话列表使用） */
  async function listSessions(itemID) {    await serialize(() => undefined);
    const data = await ensureLoaded(itemID);
    if (!data) return [];
    return data.sessions
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        created: entry.created || 0,
        updated: entry.updated || 0,
        messageCount: entry.messages.length,
        writeCount: (entry.writes || []).length,
        active: entry.id === data.activeId,
      }))
      .sort((a, b) => b.updated - a.updated);
  }

  /** 全部条目（跨库扫描会话附件；只在显式调用时执行） */
  async function list() {
    await serialize(() => undefined);
    const found = [];
    for (const itemID of await knownItemIDs()) {
      // eslint-disable-next-line no-await-in-loop
      const data = await ensureLoaded(itemID);
      if (!data || !data.sessions.length) continue;
      const session = activeSession(data);
      found.push({
        itemID: Number(itemID),
        title: data.title || "",
        updated: data.updated || 0,
        messageCount: session ? session.messages.length : 0,
        sessionCount: data.sessions.length,
      });
    }
    return found.sort((a, b) => b.updated - a.updated);
  }

  /** 已加载过的条目 + 通过 Zotero 搜索找到的会话附件所属条目 */
  async function knownItemIDs() {
    const ids = new Set(records.keys());
    try {
      const libraries = Zotero.Libraries.getAll ? Zotero.Libraries.getAll() : [];
      for (const library of libraries) {
        // eslint-disable-next-line no-await-in-loop
        const found = await searchAttachmentOwners(library.libraryID);
        for (const id of found) ids.add(id);
      }
    }
    catch (error) {
      Sideline.util.warn(`扫描会话附件失败：${Sideline.util.message(error)}`);
    }
    return [...ids];
  }

  /**
   * 用 Zotero.Search 找出属于本插件的 JSON 附件，返回其父条目 ID。
   * 只读查询，不触碰数据库写入。搜索不可用时返回空数组。
   */
  async function searchAttachmentOwners(libraryID) {
    const out = [];
    try {
      const search = new Zotero.Search();
      search.libraryID = libraryID;
      search.addCondition("itemType", "is", "attachment");
      search.addCondition("title", "contains", TITLE_PREFIX);
      const ids = await search.search() || [];
      for (const id of ids) {
        const item = Zotero.Items.get(id);
        if (item && item.parentID) out.push(item.parentID);
      }
    }
    catch (error) {
      // 搜索不可用时静默跳过：list() 只是诊断/导出用途
    }
    return out;
  }

  async function stats() {
    await serialize(() => undefined);
    let sessions = 0;
    let messages = 0;
    let itemCount = 0;
    for (const record of records.values()) {
      if (record.sessions.length) itemCount++;
      sessions += record.sessions.length;
      for (const session of record.sessions) messages += session.messages.length;
    }
    return {
      mode: "attachment",
      enabled: enabled(),
      itemCount,
      sessionCount: sessions,
      messageCount: messages,
      chars: JSON.stringify([...records.values()]).length,
      dirty: dirty.size,
      lastSavedAt,
      loadError: loadError || "",
      warnings: lastWarning ? [lastWarning] : [],
      limits: limits(),
    };
  }

  /** 启动时清理旧会话；同一加载路径也覆盖之后才同步到本机的附件。 */
  async function initialize() {
    for (const itemID of await knownItemIDs()) await ensureLoaded(itemID);
  }

  /** 清空内存态（不动附件），供测试与诊断使用 */
  function clear() {
    return serialize(async () => {
      records.clear();
      attachments.clear();
      dirty = new Set();
      loadError = "";
      lastWarning = "";
      saveFailures.clear();
      return true;
    });
  }

  /** 会话附件的位置信息，供诊断端点核实（不创建、不修改） */
  async function resolveAttachment(itemID) {
    const owner = ownerOf(itemID);
    if (!owner) return { ok: false, reason: "条目不存在" };
    if (!owner.persistable) return { ok: false, reason: "独立附件没有父条目，无法挂会话附件" };
    const attachment = findAttachment(owner.item);
    const info = {
      ok: true,
      ownerID: owner.item.id,
      ownerKey: owner.item.key,
      ownerTitle: titleOf(owner.item),
      attachmentID: attachment ? attachment.id : null,
      attachmentKey: attachment ? attachment.key : "",
      path: "",
      exists: false,
    };
    if (attachment) {
      try {
        info.path = String(await attachment.getFilePathAsync() || "");
        info.exists = !!info.path && Zotero.File.pathToFile(info.path).exists();
      }
      catch (error) {
        info.reason = Sideline.util.message(error);
      }
    }
    return info;
  }

  function recordDiagnostics() {
    let active = 0;
    for (const record of records.values()) {
      if (record.sessions.length) active++;
    }
    const entry = {
      ok: !loadError,
      mode: "attachment",
      enabled: enabled(),
      items: active,
      dirty: dirty.size,
      lastSavedAt,
      legacy: "会话存为条目下的 JSON 附件；旧 sessions.json 不再读写",
    };
    if (loadError) entry.error = loadError;
    Sideline.diagnostics.record("store", entry);
  }

  return {
    VERSION,
    MARKER,
    TITLE_PREFIX,
    ensureLoaded,
    get,
    getSession,
    appendWrite,
    listWrites,
    markWriteUndone,
    updateWrite,
    list,
    listSessions,
    allSessions,
    initialize,
    touch,
    remove,
    clear,
    flush,
    flushItem,
    prepareWrite,
    saveError,
    save,
    stats,
    resolveAttachment,
    recordDiagnostics,
    ownerOf,
    keyOf,
    activeSession,
  };
})();
