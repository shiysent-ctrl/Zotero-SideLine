/*
 * Sideline 会话存档的数据编解码规则。
 * 输入：未验证的 JSON 数据及宿主条目 ID；输出：保持 v3 格式的归一化记录。
 * 依赖：无 Zotero、文件或请求依赖。旧多会话选择、显示元数据和批次日志规则集中于此。
 * messageId 同时供内存消息与旧存档补号使用；编号不改变消息顺序或原始正文。
 */
Sideline.storecodec = (function () {
  const VERSION = 3;
  const MARKER = "zotero-sideline-sessions";
  let messageSequence = 0;

  function messageId() {
    return `m-${Date.now().toString(36)}-${(++messageSequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function emptyRecord(ownerID, title) {
    return {
      version: VERSION,
      marker: MARKER,
      itemID: ownerID,
      title: title || "",
      updated: Date.now(),
      activeId: "",
      sessions: [],
    };
  }

  function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
      .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant")
        && typeof entry.content === "string")
      .map((entry) => ({
        role: entry.role,
        id: String(entry.id || messageId()),
        uiHidden: !!entry.uiHidden,
        localOnly: !!entry.localOnly,
        highlightBatch: sanitizeHighlightBatch(entry.highlightBatch),
        content: entry.content,
        time: entry.time || "",
        model: entry.model || "",
        question: entry.question || "",
        display: entry.display || "",
        functionId: entry.functionId || "",
        provider: entry.provider || "",
        elapsedMs: Number(entry.elapsedMs) || 0,
        usage: entry.usage && typeof entry.usage === "object" ? entry.usage : null,
        citations: sanitizeCitations(entry.citations),
        images: entry.role === "user" && Array.isArray(entry.images)
          ? entry.images.filter((url) => typeof url === "string" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) : [],
      }));
  }

  /** 引用锚点：来源标签 + 页码 + 页面空间矩形，用于重启后仍能跳回原文 */
  function sanitizeCitations(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      out.push({
        kind: entry.kind === "pageref" ? "pageref" : "anchor",
        label: String(entry.label || "").slice(0, 200),
        pageIndex: Number.isFinite(entry.pageIndex) ? entry.pageIndex : null,
        pageLabel: entry.pageLabel == null ? "" : String(entry.pageLabel),
        rects: Array.isArray(entry.rects) ? entry.rects : null,
      });
    }
    return out;
  }

  function sanitizeRecord(parsed, ownerID) {
    const record = emptyRecord(ownerID, String((parsed && parsed.title) || ""));
    if (!parsed || typeof parsed !== "object") return record;
    record.updated = Number(parsed.updated) || Date.now();
    record.activeId = String(parsed.activeId || "");
    // 旧版多会话只保留更新时间最近的一条；与旧 activeId 无关。
    const list = (Array.isArray(parsed.sessions) ? parsed.sessions : [])
      .filter((entry) => entry && typeof entry === "object")
      .sort((a, b) => (Number(b.updated) || Number(b.created) || 0)
        - (Number(a.updated) || Number(a.created) || 0)).slice(0, 1);
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const messages = sanitizeMessages(entry.messages);
      record.sessions.push({
        id: String(entry.id || `s${record.sessions.length + 1}`),
        name: String(entry.name || `会话 ${record.sessions.length + 1}`),
        created: Number(entry.created) || record.updated,
        updated: Number(entry.updated) || record.updated,
        messages,
        writes: sanitizeWrites(entry.writes),
      });
    }
    if (!record.sessions.some((entry) => entry.id === record.activeId)) {
      record.activeId = record.sessions.length ? record.sessions[0].id : "";
    }
    return record;
  }

  /** 写入审计记录：只保留插件自己新建/改动的对象，供「撤销最近一次」使用 */
  function sanitizeWrites(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const kind = String(entry.kind || "");
      if (kind !== "note" && kind !== "annotation" && kind !== "review") continue;
      out.push({
        id: String(entry.id || `w${out.length + 1}`),
        kind,
        targetID: Number(entry.targetID) || 0,
        key: String(entry.key || ""),
        summary: String(entry.summary || "").slice(0, 300),
        sessionId: String(entry.sessionId || ""),
        time: String(entry.time || ""),
        timestamp: Number(entry.timestamp) || 0,
        undone: !!entry.undone,
        detail: sanitizeWriteDetail(entry.detail),
      });
    }
    return out;
  }

  /** 结构化总结的撤销需要额外信息：本次新增的标签、Extra 的旧值、子笔记是新建还是更新 */
  function sanitizeWriteDetail(value) {
    if (!value || typeof value !== "object") return null;
    const detail = {};
    if (value.batchId) detail.batchId = String(value.batchId).slice(0, 120);
    if (value.attachmentKey) detail.attachmentKey = String(value.attachmentKey).slice(0, 16);
    if (Number.isSafeInteger(value.libraryID) && value.libraryID > 0) detail.libraryID = value.libraryID;
    if (typeof value.snapshot === "string" && value.snapshot.length <= 100000) detail.snapshot = value.snapshot;
    if (["pending", "created", "failed"].includes(value.state)) detail.state = value.state;
    if (Array.isArray(value.tagsAdded)) {
      detail.tagsAdded = value.tagsAdded.map((tag) => String(tag)).filter(Boolean).slice(0, 32);
    }
    if (typeof value.extraBefore === "string") detail.extraBefore = value.extraBefore.slice(0, 2000);
    if (typeof value.extraAfter === "string") detail.extraAfter = value.extraAfter.slice(0, 2000);
    if (value.noteAction === "create" || value.noteAction === "update") detail.noteAction = value.noteAction;
    if (value.noteID) detail.noteID = Number(value.noteID) || 0;
    if (value.parentID) detail.parentID = Number(value.parentID) || 0;
    if (value.noteKey) detail.noteKey = String(value.noteKey);
    if (Number.isFinite(value.noteBeforeChars)) detail.noteBeforeChars = Number(value.noteBeforeChars);
    return Object.keys(detail).length ? detail : null;
  }

  /** 结果回执独立于原始模型正文，恢复时不把 UI 信息混入模型历史。 */
  function sanitizeHighlightBatch(value) {
    if (!value || typeof value !== "object" || !value.id) return null;
    const counts = (object) => Object.fromEntries(["created", "skipped", "failed", "removed", "edited", "missing"]
      .map((key) => [key, Math.max(0, Math.floor(Number(object && object[key]) || 0))]));
    return Object.assign(counts(value), {
      id: String(value.id).slice(0, 120),
      status: ["running", "complete", "partial", "stopped", "failed"].includes(value.status) ? value.status : "failed",
      attachmentKey: String(value.attachmentKey || "").slice(0, 16),
      libraryID: Math.max(0, Number(value.libraryID) || 0),
      coverage: String(value.coverage || "").slice(0, 500),
      cost: value.cost && typeof value.cost === "object" ? Object.fromEntries(["calls", "reportedCalls", "tokens", "estimatedInput"]
        .map((key) => [key, Math.max(0, Math.floor(Number(value.cost[key]) || 0))])) : null,
      errors: Array.isArray(value.errors) ? value.errors.slice(0, 64).map((e) => ({
        page: String(e.page || "").slice(0, 30), quote: String(e.quote || "").slice(0, 100),
        reason: String(e.reason || "").slice(0, 500) })) : [],
      undo: value.undo && typeof value.undo === "object" ? Object.assign(counts(value.undo), {
        errors: Array.isArray(value.undo.errors) ? value.undo.errors.slice(0, 64).map((e) => String(e).slice(0, 500)) : [] }) : null,
    });
  }

  return { VERSION, MARKER, messageId, emptyRecord, sanitizeRecord, sanitizeMessages, sanitizeWriteDetail };
})();
