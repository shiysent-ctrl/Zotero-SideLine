/*
 * Zotero Sideline：把回答/片段整理为子笔记（R16）。
 *
 * 功能：把选中的对话消息（默认是某个回答及其对应提问）整理成一份带**来源链接**的子笔记，
 *       写入前生成完整预览（标题、正文、来源清单、是否已有同名笔记），确认后写入并登记到写入记录。
 * 输入：条目、附件（用于生成 PDF 深链）、消息数组（会话里的原始消息对象）。
 * 输出：plan（预览）与 commit（写入）两个阶段的对象。
 * 依赖：modules/history.js（来源行与 PDF 深链）、modules/summary.js（Markdown→Zotero 笔记 HTML）、
 *       Zotero.Items / Zotero.DB。
 *
 * 设计说明：
 * 1) 来源链接用 Zotero 自己的深链：条目 `zotero://select/library/items/<KEY>`、
 *    PDF `zotero://open-pdf/library/items/<KEY>?page=<纸面页码>`；同时保留纯文字页码，链接失效也能核对；
 * 2) 不覆盖已有笔记：每次「整理为笔记」都新建一条，标题带时间戳，避免把用户写过的内容改掉；
 * 3) 笔记 HTML 复用 summary 的转换器（标题/列表/公式/转义同一套），因此 ZotLit 能重新导出成 Markdown。
 */

Sideline.excerpt = (function () {
  /** 一条消息 → 笔记里的一个段落块 */
  function blocksOf(messages, options = {}) {
    const blocks = [];
    const list = Array.isArray(messages) ? messages : [];
    for (const message of list) {
      if (!message || !message.role) continue;
      const content = String(message.content || "").trim();
      if (!content) continue;
      blocks.push({
        role: message.role,
        roleText: Sideline.history.roleText(message.role),
        display: String(message.display || "").trim(),
        content,
        model: String(message.model || ""),
        time: String(message.time || ""),
        citations: Array.isArray(message.citations) ? message.citations : [],
        include: options.roles ? options.roles.includes(message.role) : true,
      });
    }
    return blocks.filter((block) => block.include);
  }

  /** 收集用到的来源：条目深链、PDF 深链与页码 */
  function sourcesOf(blocks, options = {}) {
    const itemKey = String(options.itemKey || "");
    const attachmentKey = String(options.attachmentKey || "");
    const pages = new Set();
    const anchors = [];
    for (const block of blocks) {
      for (const citation of block.citations || []) {
        if (citation.pageLabel) pages.add(String(citation.pageLabel));
        if (citation.kind !== "pageref" && citation.label) anchors.push(String(citation.label));
      }
    }
    return {
      itemKey,
      attachmentKey,
      itemLink: itemKey ? `zotero://select/library/items/${itemKey}` : "",
      pages: [...pages],
      pdfLinks: [...pages]
        .map((page) => ({ page, link: Sideline.history.pdfLink(attachmentKey, page) }))
        .filter((entry) => entry.link),
      anchors,
    };
  }

  function defaultTitle(options = {}) {
    const title = String(options.title || "").trim();
    if (title) return title;
    const base = String(options.itemTitle || "").trim() || "文献";
    return `Sideline 摘录：${base}（${Sideline.util.nowText()}）`;
  }

  /**
   * 生成预览（不写任何数据）。
   * @param {object} options item；title；blocks；sources；itemKey；attachmentKey
   */
  function plan(options = {}) {
    const blocks = options.blocks || blocksOf(options.messages, options);
    if (!blocks.length) throw new Error("没有可整理的消息");
    const sources = options.sources || sourcesOf(blocks, options);
    const title = defaultTitle(Object.assign({}, options, {
      itemTitle: options.itemTitle || (options.item && options.item.getField
        ? String(options.item.getField("title") || "") : ""),
    }));
    const lines = [`# ${title}`, ""];
    for (const block of blocks) {
      lines.push(`## ${block.roleText}${block.model ? `（${block.model}）` : ""}${block.time ? `｜${block.time}` : ""}`);
      lines.push("");
      lines.push(block.role === "user" && block.display ? block.display : block.content);
      lines.push("");
      const citations = (block.citations || []).filter((citation) => citation.label);
      if (citations.length) {
        lines.push("- 来源：");
        for (const citation of citations) {
          const link = citation.pageLabel ? Sideline.history.pdfLink(sources.attachmentKey, citation.pageLabel) : "";
          const text = citation.kind === "pageref"
            ? `第 ${citation.pageLabel} 页`
            : String(citation.label);
          lines.push(link ? `  - ${text} → [打开原文](${link})` : `  - ${text}`);
        }
        lines.push("");
      }
    }
    if (sources.itemLink) {
      lines.push("---");
      lines.push("");
      lines.push(`- 条目：${options.itemTitle || sources.itemKey} → [在 Zotero 中打开](${sources.itemLink})`);
      if (sources.pdfLinks.length) {
        lines.push(`- 原文位置：${sources.pdfLinks
          .map((entry) => `[第 ${entry.page} 页](${entry.link})`).join("、")}`);
      }
    }
    const markdown = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
    const html = Sideline.summary.toNoteHtml(markdown);
    return {
      title,
      markdown,
      html,
      chars: [...markdown].length,
      blockCount: blocks.length,
      sources,
      itemID: options.item ? options.item.id : 0,
      itemKey: sources.itemKey,
      attachmentKey: sources.attachmentKey,
      noteAction: "create",
    };
  }

  /**
   * 写入子笔记（必须先 plan 并让用户确认）。
   * @returns {Promise<{noteID:number, noteKey:string, title:string, chars:number, sources:object}>}
   */
  async function commit(options = {}) {
    const item = options.item;
    if (!item) throw new Error("缺少目标条目");
    const planned = options.plan || plan(options);
    let noteItem = null;
    await Zotero.DB.executeTransaction(async () => {
      noteItem = new Zotero.Item("note");
      noteItem.libraryID = item.libraryID;
      noteItem.parentID = item.id;
      noteItem.setNote(planned.html);
      await noteItem.save();
    });
    Sideline.util.log(`已把 ${planned.blockCount} 段对话整理为子笔记 ${noteItem.key}（条目 ${item.key}）`);
    return {
      noteID: noteItem.id,
      noteKey: noteItem.key,
      title: planned.title,
      chars: planned.chars,
      sources: planned.sources,
    };
  }

  return { blocksOf, sourcesOf, defaultTitle, plan, commit };
})();
