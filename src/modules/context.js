/*
 * Zotero Sideline：上下文构建。
 * 功能：把 Zotero 条目解析为「条目元数据 + 选中文字 + PDF 全文」的纯文本上下文。
 * 数据来源：条目字段与 getCreators()；PDF/EPUB 正文取自 Zotero 自带的全文索引缓存
 *           （Zotero.Fulltext，索引文件 .zotero-ft-cache），不另建向量库。
 * 说明：全文按 maxChars 截断，避免超出模型上下文；截断只影响送入模型的文本，不修改 Zotero 数据。
 */

Sideline.context = (function () {
  const MODES = ["metadata", "metadata+fulltext", "fulltext"];

  const STATE_TEXT = {
    ok: "已取得正文",
    empty: "索引结果为空",
    missing: "索引缓存文件不存在",
    unsupported: "该附件类型不支持全文索引",
    "no-attachment": "没有可用的 PDF/EPUB 附件",
    "not-requested": "本次未请求全文",
  };

  function yearOf(item) {
    const match = String(item.getField("date") || "").match(/(\d{4})/);
    return match ? match[1] : "";
  }

  function creatorsOf(item) {
    try {
      return item.getCreators()
        .map((creator) => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" "))
        .filter(Boolean);
    }
    catch (error) {
      return [];
    }
  }

  function fieldOf(item, name) {
    try {
      return item.getField(name) || "";
    }
    catch (error) {
      return "";
    }
  }

  function metadataLines(item) {
    const rows = [
      ["标题", fieldOf(item, "title")],
      ["作者", creatorsOf(item).join("; ")],
      ["年份", yearOf(item)],
      [
        "来源",
        fieldOf(item, "publicationTitle")
          || fieldOf(item, "proceedingsTitle")
          || fieldOf(item, "bookTitle")
          || fieldOf(item, "university")
          || "",
      ],
      ["卷期页", [fieldOf(item, "volume"), fieldOf(item, "issue"), fieldOf(item, "pages")].filter(Boolean).join(" / ")],
      ["DOI", fieldOf(item, "DOI")],
      ["链接", fieldOf(item, "url")],
      ["摘要", fieldOf(item, "abstractNote")],
    ];
    return rows.filter((row) => row[1]).map((row) => `${row[0]}：${row[1]}`).join("\n");
  }

  function summaryOf(item) {
    return {
      id: item.id,
      key: item.key,
      libraryID: item.libraryID,
      title: fieldOf(item, "title"),
      year: yearOf(item),
      creators: creatorsOf(item),
      doi: fieldOf(item, "DOI"),
      isAttachment: typeof item.isAttachment === "function" ? item.isAttachment() : false,
      parentID: item.parentID || null,
    };
  }

  /** 附件条目返回自身，普通条目返回最佳附件 */
  async function resolveAttachment(item) {
    if (!item) return null;
    if (typeof item.isAttachment === "function" && item.isAttachment()) return item;
    if (typeof item.getBestAttachment === "function") {
      try {
        return await item.getBestAttachment();
      }
      catch (error) {
        Sideline.util.warn(`解析附件失败：${Sideline.util.message(error)}`);
        return null;
      }
    }
    return null;
  }

  /** 取附件正文：先确保已索引，再读全文索引缓存 */
  async function fullText(attachment, maxChars) {
    const result = { text: "", chars: 0, totalChars: 0, truncated: false, pages: null, state: "missing" };
    if (!attachment) {
      result.state = "no-attachment";
      return result;
    }
    if (!Zotero.Fulltext.canIndex(attachment)) {
      result.state = "unsupported";
      return result;
    }
    try {
      await Zotero.Fulltext.indexItems([attachment.id], { ignoreErrors: true });
    }
    catch (error) {
      Sideline.util.warn(`全文索引失败：${Sideline.util.message(error)}`);
    }
    try {
      // Zotero 10 的 getPages() 返回 mozStorage 行对象。它能按列名读取属性，
      // 但不能直接交给 JSON.stringify（序列化器探测 toJSON 时会被当成数据库列）。
      // 这里立即归一成普通对象，同时兼容测试桩与旧版本使用的 totalPages 字段。
      const pages = await Zotero.Fulltext.getPages(attachment.id);
      result.pages = pages ? {
        indexedPages: Number(pages.indexedPages) || 0,
        totalPages: Number(pages.totalPages === undefined ? pages.total : pages.totalPages) || 0,
      } : null;
    }
    catch (error) {
      result.pages = null;
    }
    try {
      const file = Zotero.Fulltext.getItemCacheFile(attachment);
      const path = file && file.path ? file.path : String(file);
      const text = String(await Zotero.File.getContentsAsync(path) || "");
      result.totalChars = text.length;
      const limit = maxChars > 0 ? maxChars : 24000;
      const cut = Sideline.util.truncate(text, limit);
      result.text = cut.truncated ? cut.text : text;
      result.truncated = cut.truncated;
      result.chars = result.text.length;
      result.state = result.text ? "ok" : "empty";
    }
    catch (error) {
      result.state = "missing";
    }
    return result;
  }

  /**
   * 构建送模型的上下文文本。
   * @param {Zotero.Item} item 目标条目（普通条目或 PDF 附件）
   * @param {object} [options] mode: metadata | metadata+fulltext | fulltext；selection: 选中文字；maxChars: 全文上限
   */
  async function build(item, options = {}) {
    const mode = MODES.includes(options.mode) ? options.mode : Sideline.config.str("contextMode");
    const maxChars = options.maxChars > 0 ? options.maxChars : Sideline.config.num("maxContextChars");
    const parts = [];
    const stats = {
      mode,
      contextChars: 0,
      fullTextChars: 0,
      fullTextTotalChars: 0,
      fullTextState: "not-requested",
      fullTextStateText: STATE_TEXT["not-requested"],
      truncated: false,
      pages: null,
      attachment: null,
    };

    if (mode !== "fulltext") {
      parts.push(`【条目元数据】\n${metadataLines(item) || "（无可用元数据）"}`);
    }

    const selection = String(options.selection || "").trim();
    if (selection) {
      parts.push(`【选中文字】\n${selection}`);
    }

    if (mode !== "metadata") {
      const attachment = await resolveAttachment(item);
      if (attachment) {
        stats.attachment = {
          id: attachment.id,
          key: attachment.key,
          title: fieldOf(attachment, "title") || "附件",
          contentType: attachment.attachmentContentType || "",
        };
        const full = await fullText(attachment, maxChars);
        stats.fullTextChars = full.chars;
        stats.fullTextTotalChars = full.totalChars;
        stats.fullTextState = full.state;
        stats.fullTextStateText = STATE_TEXT[full.state] || full.state;
        stats.truncated = full.truncated;
        stats.pages = full.pages || null;
        if (full.text) {
          const note = full.truncated ? `（已截断至 ${full.chars} 字，原文约 ${full.totalChars} 字）` : "";
          parts.push(`【PDF 全文${note}】\n${full.text}`);
        }
        else {
          parts.push(`【PDF 全文】\n（未取得正文：${stats.fullTextStateText}）`);
        }
      }
      else {
        stats.fullTextState = "no-attachment";
        stats.fullTextStateText = STATE_TEXT["no-attachment"];
        parts.push("【PDF 全文】\n（该条目没有可用的 PDF/EPUB 附件）");
      }
    }

    const text = parts.join("\n\n");
    stats.contextChars = text.length;
    return { text, meta: summaryOf(item), stats };
  }

  function stateText(state) {
    return STATE_TEXT[state] || state;
  }

  /** 找到可挂载子笔记的普通条目 */
  function regularItem(item) {
    if (!item) return null;
    if (typeof item.isRegularItem === "function" && item.isRegularItem()) return item;
    if (item.parentID) {
      const parent = Zotero.Items.get(item.parentID);
      if (parent && parent.isRegularItem()) return parent;
    }
    return null;
  }

  return {
    MODES,
    build,
    fullText,
    resolveAttachment,
    summaryOf,
    regularItem,
    metadataLines,
    stateText,
    STATE_TEXT,
  };
})();
