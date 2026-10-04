/*
 * Zotero Sideline：会话历史（R13 的检索与导出）。
 *
 * 功能：在一个条目的多条会话里检索消息（按会话名或消息正文），把结果按位置标注出来；
 *       并把会话导出成 Markdown 或 JSON——导出走文件选择器写文件，**不写子笔记**（会话只作为附件存在）。
 * 输入：itemID（或 store 返回的会话数组）；查询词；导出格式与目标路径。
 * 输出：命中数组、Markdown/JSON 文本、文件名与字符数。
 * 依赖：modules/store.js（allSessions）、Zotero.File.putContentsAsync、nsIFilePicker
 *       （父窗口与同步等待都走 modules/inputs.js 的 pickerWindow / pickerParent / showPickerSync）。
 *
 * 设计说明：
 * 1) 检索只查当前条目的会话；侧栏用 visibleOnly 检索可见正文，端点保留原始历史契约；
 * 2) 命中位置用「会话名 + 第 N 条消息 + 角色」表示，附正文片段，便于回到那一轮；
 * 3) 导出文本里带 `zotero://select/library/items/<KEY>` 与 PDF 深链，便于从导出件跳回原文；
 * 4) 导出默认只生成文本（端点返回内容），只有显式给出路径或点了「另存为」才写磁盘。
 */

Sideline.history = (function () {
  const DEFAULT_MAX_HITS = 20;
  const DEFAULT_CONTEXT_CHARS = 240;

  function normalize(value) {
    return String(value == null ? "" : value).trim().toLocaleLowerCase();
  }

  /** 消息在导出/展示时的角色名 */
  function roleText(role) {
    return role === "user" ? "我" : "Sideline";
  }

  /** 界面检索复用气泡的文字含义；隐藏消息不参与命中，原记录与模型历史不变。 */
  function visibleText(message) {
    if (message.uiHidden) return null;
    if (message.role === "assistant" && message.functionId === "highlight") {
      return Sideline.highlights.receipt(message.highlightBatch);
    }
    return String(message.role === "user" && message.display ? message.display : message.content || "");
  }

  /**
   * 在会话数组里检索。
   * @param {object[]} sessions store.allSessions() 的输出
   * @param {string} query 关键词；多词按「全部出现」匹配；同时匹配会话名
   * @param {object} options visibleOnly 仅侧栏启用；默认仍检索原始正文，保留端点契约。
   */
  function search(sessions, query, options = {}) {
    const wanted = normalize(query);
    if (!wanted) return { hits: [], total: 0, truncated: 0, query: "", sessionsScanned: (sessions || []).length };
    const terms = wanted.split(/\s+/).filter(Boolean);
    const maxHits = options.maxHits > 0 ? options.maxHits : DEFAULT_MAX_HITS;
    const contextChars = options.contextChars > 0 ? options.contextChars : DEFAULT_CONTEXT_CHARS;
    const hits = [];
    for (const session of sessions || []) {
      const nameHit = terms.some((term) => normalize(session.name).includes(term));
      const messages = session.messages || [];
      const searchable = messages.map((message) => options.visibleOnly ? visibleText(message) : String(message.content || ""));
      const messageCount = searchable.filter((text) => text !== null).length;
      let matchedInBody = false;
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        // 保留原消息序号；先过滤数组会让命中位置偏移到其他问答。
        const text = searchable[index];
        if (text === null) continue;
        const haystack = normalize(text);
        const display = options.visibleOnly ? "" : normalize(message.display || "");
        const allInBody = terms.every((term) => haystack.includes(term));
        const allInDisplay = terms.length && terms.every((term) => display.includes(term));
        if (!allInBody && !allInDisplay) continue;
        matchedInBody = true;
        const first = terms.find((term) => haystack.includes(term)) || terms[0];
        const at = haystack.indexOf(first);
        const half = Math.floor(contextChars / 2);
        const start = Math.max(0, at - half);
        const snippet = text.slice(start, start + contextChars).trim();
        hits.push({
          sessionId: session.id,
          sessionName: session.name,
          index,
          // 侧栏按稳定 ID 定位气泡，原始历史端点的返回结构保持不变。
          ...(options.visibleOnly ? { messageId: message.id } : {}),
          role: message.role,
          roleText: roleText(message.role),
          time: message.time || "",
          model: message.model || "",
          matchedName: false,
          snippet: snippet.length < text.length ? `${snippet}…` : snippet,
        });
      }
      // 只有会话名命中时也给一条结果，避免"看得见会话名却搜不到"
      if (nameHit && !matchedInBody && messageCount) {
        hits.push({
          sessionId: session.id,
          sessionName: session.name,
          index: -1,
          role: "",
          roleText: "会话",
          time: "",
          model: "",
          matchedName: true,
          snippet: `会话名匹配「${session.name}」（共 ${messageCount} 条消息）`,
        });
      }
    }
    const total = hits.length;
    const kept = hits.slice(0, maxHits);
    return {
      hits: kept,
      total,
      truncated: Math.max(0, total - kept.length),
      query: String(query || "").trim(),
      sessionsScanned: (sessions || []).length,
    };
  }

  /** 便捷入口：读会话 + 检索 */
  async function find(itemID, query, options = {}) {
    const sessions = await Sideline.store.allSessions(itemID);
    if (!query || !String(query).trim()) {
      return {
        hits: [],
        total: 0,
        truncated: 0,
        query: "",
        sessionsScanned: sessions.length,
        sessions: sessions.map((session) => ({
          id: session.id,
          name: session.name,
          messageCount: (session.messages || []).length,
          updated: session.updated,
          active: session.active,
        })),
      };
    }
    const result = search(sessions, query, options);
    result.sessions = sessions.map((session) => ({
      id: session.id,
      name: session.name,
      messageCount: (session.messages || []).length,
      updated: session.updated,
      active: session.active,
    }));
    return result;
  }

  // ---- 导出 ----

  function pdfLink(attachmentKey, pageLabel) {
    if (!attachmentKey) return "";
    const page = String(pageLabel || "").trim();
    return `zotero://open-pdf/library/items/${attachmentKey}${page ? `?page=${encodeURIComponent(page)}` : ""}`;
  }

  /** 一条消息的来源行：页码引用 + 选区锚点 + PDF 深链 */
  function sourceLines(message, attachmentKey) {
    const lines = [];
    for (const citation of message.citations || []) {
      if (!citation) continue;
      if (citation.kind === "pageref") {
        const link = pdfLink(attachmentKey, citation.pageLabel);
        lines.push(link
          ? `- 第 ${citation.pageLabel || "?"} 页 → [打开原文](${link})`
          : `（${citation.pageLabel ? `第 ${citation.pageLabel} 页` : "页码未知"}）`);
        continue;
      }
      const label = String(citation.label || "").trim();
      if (!label) continue;
      const link = pdfLink(attachmentKey, citation.pageLabel);
      lines.push(link ? `- ${label} → [打开原文](${link})` : `- ${label}`);
    }
    return lines;
  }

  function safeFileName(value, fallback) {
    const text = String(value == null ? "" : value).replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim();
    const cut = [...text].slice(0, 60).join("").replace(/[. ]+$/, "");
    return cut || fallback;
  }

  /**
   * 导出为 Markdown。
   * @param {object} options item 条目（取标题与 key）；sessions 会话数组；attachmentKey PDF 附件 key；nowText 导出时间
   */
  function toMarkdown(options) {
    const item = options.item || {};
    const sessions = options.sessions || [];
    const title = String(options.title || (item.getField && item.getField("title")) || "未命名条目");
    const itemKey = String(options.itemKey || item.key || "");
    const lines = [
      `# Sideline 会话导出：${title}`,
      "",
      `- 条目：${title}${itemKey ? `（[在 Zotero 中打开](zotero://select/library/items/${itemKey})）` : ""}`,
      `- 导出时间：${options.nowText || Sideline.util.nowText()}`,
      `- 会话数：${sessions.length}`,
      "",
    ];
    for (const session of sessions) {
      lines.push(`## ${session.name || "会话"}${session.active ? "（当前会话）" : ""}`);
      lines.push("");
      lines.push(`- 消息 ${(session.messages || []).length} 条｜最后更新 ${Sideline.util.timeText(session.updated)}`);
      lines.push("");
      for (const message of session.messages || []) {
        lines.push(`### ${roleText(message.role)}${message.model ? `（${message.model}）` : ""}${message.time ? `｜${message.time}` : ""}`);
        lines.push("");
        const body = message.role === "user" && message.display ? message.display : String(message.content || "");
        lines.push(body);
        lines.push("");
        const sources = sourceLines(message, options.attachmentKey);
        if (sources.length) {
          lines.push("> 来源：");
          for (const line of sources) lines.push(line.startsWith("- ") ? `> ${line}` : `> ${line}`);
          lines.push("");
        }
      }
    }
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  /** 导出为 JSON（保留完整字段，便于外部工具消费） */
  function toJson(options) {
    const item = options.item || {};
    const sessions = options.sessions || [];
    return {
      schema: "zotero-sideline-sessions/v1",
      exportedAt: options.nowText || Sideline.util.nowText(),
      item: {
        id: item.id || 0,
        key: String(options.itemKey || item.key || ""),
        title: String(options.title || (item.getField && item.getField("title")) || ""),
      },
      attachmentKey: options.attachmentKey || "",
      sessions: sessions.map((session) => ({
        id: session.id,
        name: session.name,
        created: session.created || 0,
        updated: session.updated || 0,
        active: !!session.active,
        messages: (session.messages || []).map((message) => ({
          role: message.role,
          content: message.content || "",
          display: message.display || "",
          time: message.time || "",
          model: message.model || "",
          provider: message.provider || "",
          functionId: message.functionId || "",
          elapsedMs: message.elapsedMs || 0,
          usage: message.usage || null,
          citations: (message.citations || []).map((citation) => ({
            kind: citation.kind || "anchor",
            label: citation.label || "",
            pageIndex: citation.pageIndex,
            pageLabel: citation.pageLabel || "",
          })),
        })),
      })),
    };
  }

  /**
   * 生成导出内容（不写盘）。
   * @returns {Promise<{format:string, text:string, filename:string, chars:number, sessionCount:number}>}
   */
  async function build(itemID, options = {}) {
    const format = options.format === "json" ? "json" : "markdown";
    const item = Zotero.Items.get(Number(itemID));
    const sessions = options.sessionId
      ? (await Sideline.store.allSessions(itemID)).filter((session) => session.id === String(options.sessionId))
      : await Sideline.store.allSessions(itemID);
    const attachment = item ? await Sideline.context.resolveAttachment(item) : null;
    const payload = {
      item,
      itemKey: item ? item.key : "",
      title: item && item.getField ? String(item.getField("title") || "") : "",
      attachmentKey: attachment ? attachment.key : "",
      sessions,
    };
    const text = format === "json"
      ? `${JSON.stringify(toJson(payload), null, 2)}\n`
      : toMarkdown(payload);
    const base = safeFileName(payload.title || payload.itemKey, "sideline-sessions");
    return {
      format,
      text,
      filename: `${base}-sideline.${format === "json" ? "json" : "md"}`,
      chars: text.length,
      sessionCount: sessions.length,
      messageCount: sessions.reduce((sum, session) => sum + (session.messages || []).length, 0),
    };
  }

  /** 写文件（只在用户显式给了路径时调用） */
  async function save(path, text) {
    if (!path) throw new Error("没有导出路径");
    await Zotero.File.putContentsAsync(path, String(text));
    return { path, chars: String(text).length };
  }

  /**
   * 文件选择器（保存模式）；取消时返回空串。
   * 父窗口必须用主窗口并转成 browsingContext：Zotero 10.0.3（Gecko 140）的
   * `nsIFilePicker.init(in BrowsingContext browsingContext, in AString title, in Mode mode)`
   * 只收 browsingContext，传窗口对象本身会抛
   * 「Could not convert JavaScript argument arg 0 [nsIFilePicker.init]」；
   * 而阅读器窗口弹不出对话框（0.7.1 已改）。
   * Gecko 140 没有同步 show()，同步语义交给 Sideline.inputs.showPickerSync。
   */
  function pickSavePath(suggestedName, options = {}) {
    try {
      const inputs = Sideline.inputs || {};
      if (typeof inputs.pickerWindow !== "function" || typeof inputs.showPickerSync !== "function") {
        Sideline.util.warn("打开导出对话框失败：Sideline.inputs 的文件选择器接口不可用");
        return "";
      }
      const win = inputs.pickerWindow(options);
      const parent = typeof inputs.pickerParent === "function" ? inputs.pickerParent(win) : (win || null);
      if (!parent) {
        Sideline.util.warn("打开导出对话框失败：拿不到 Zotero 主窗口");
        return "";
      }
      const nsIFilePicker = Components.interfaces.nsIFilePicker;
      const picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
      picker.init(parent, "导出 Sideline 会话", nsIFilePicker.modeSave);
      picker.defaultString = String(suggestedName || "sideline-sessions.md");
      if (/\.json$/i.test(suggestedName || "")) picker.appendFilter("JSON", "*.json");
      else picker.appendFilter("Markdown", "*.md");
      picker.appendFilters(nsIFilePicker.filterAll);
      const shown = inputs.showPickerSync(picker);
      if (shown.error) {
        Sideline.util.warn(`打开导出对话框失败：${shown.error}`);
        return "";
      }
      if (shown.result === nsIFilePicker.returnCancel) return "";
      const file = picker.file;
      return file ? String(file.path || "") : "";
    }
    catch (error) {
      Sideline.util.warn(`打开导出对话框失败：${Sideline.util.message(error)}`);
      return "";
    }
  }

  return {
    DEFAULT_MAX_HITS,
    DEFAULT_CONTEXT_CHARS,
    roleText,
    search,
    find,
    sourceLines,
    pdfLink,
    safeFileName,
    toMarkdown,
    toJson,
    build,
    save,
    pickSavePath,
  };
})();
