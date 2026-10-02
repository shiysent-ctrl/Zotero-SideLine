/*
 * Zotero Sideline：同条目子笔记的读取与检索（R08）。
 *
 * 功能：读取当前条目的子笔记，按关键词在笔记正文里定位命中片段，输出「笔记名 + 段落位置 + 片段」，
 *       供界面把命中内容作为材料加入本轮上下文。
 * 输入：条目（普通条目或其附件）；查询词；可选 {maxHits, contextChars, minChars}。
 * 输出：命中数组（纯数据），以及可直接交给 materials 的材料构造参数。
 * 依赖：Zotero.Items.getAsync；不依赖网络与模型，因此可完全在沙箱里验证。
 *
 * 设计说明：
 * 1) 只在**当前条目**的子笔记里搜索（R08 的显式约束），不遍历整库；
 * 2) 位置以「第 N 段」表示（按空行分段），段落文本原样保留，便于用户核对；
 * 3) 笔记正文里带 HTML（Zotero 笔记是 HTML），这里先转成纯文本再检索，返回的片段是纯文本；
 * 4) 命中过多时按 maxHits 截断，并在结果里说明截断了多少条，不静默丢弃。
 */

Sideline.notetext = (function () {
  const DEFAULT_MAX_HITS = 3;
  const DEFAULT_CONTEXT_CHARS = 600;

  /**
   * Zotero 笔记 HTML → 纯文本。
   * 块级标签换成**空行**（这样按空行分段时，HTML 里的每个段落/列表项就是一个段落，
   * 「第 N 段」的位置才对得上用户在笔记里看到的结构），`<br>` 换成单换行，
   * 其余标签去掉并解码常见实体。
   */
  function toPlainText(html) {
    let text = String(html == null ? "" : html);
    text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(p|div|li|h[1-6]|blockquote|tr|pre)>/gi, "\n\n");
    text = text.replace(/<li[^>]*>/gi, "- ");
    text = text.replace(/<[^>]+>/g, "");
    text = text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    text = text.replace(/\u00a0/g, " ");
    return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /** 按空行把纯文本切成段落，带序号（1 基，便于用户按「第 N 段」核对） */
  function paragraphsOf(text) {
    return String(text == null ? "" : text)
      .split(/\n\s*\n/)
      .map((entry) => entry.replace(/\s+\n/g, "\n").trim())
      .filter(Boolean)
      .map((entry, index) => ({ index: index + 1, text: entry }));
  }

  function noteTitle(note) {
    const title = (typeof note.getField === "function" && note.getField("title")) || "";
    return String(title || "未命名笔记");
  }

  /** 一条笔记 → 检索用的记录（读纯文本与分段） */
  function recordOf(note) {
    if (!note || typeof note.isNote !== "function" || !note.isNote()) return null;
    const html = String(note.getNote ? note.getNote() : "");
    const text = toPlainText(html);
    return {
      id: note.id,
      key: note.key,
      title: noteTitle(note),
      html,
      text,
      chars: text.length,
      paragraphs: paragraphsOf(text),
    };
  }

  /** 读取条目的子笔记；不是笔记类型的子条目会被跳过 */
  async function list(item) {
    if (!item || typeof item.getNotes !== "function") return [];
    const ids = item.getNotes() || [];
    if (!ids.length) return [];
    const items = await Zotero.Items.getAsync(ids);
    const out = [];
    for (const note of items || []) {
      const record = recordOf(note);
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * 解析检索语法（用户 2026-09-29 要求）：
   *   同一行内用空格分隔 → 这些词必须**同时**出现（AND）
   *   用换行分隔 → 满足**任意一行**即可（OR）
   * 单行查询因此与旧行为一致（所有词都要出现）。
   * @returns {{groups: string[][], terms: string[]}} groups = 每个 OR 组内的 AND 词表
   */
  function parseQuery(query) {
    const groups = [];
    for (const line of String(query == null ? "" : query).split(/\r?\n/)) {
      const terms = normalize(line).split(/\s+/).filter(Boolean);
      if (terms.length) groups.push(terms);
    }
    return { groups, terms: groups.reduce((all, group) => all.concat(group), []) };
  }

  function normalize(value) {
    return String(value == null ? "" : value).trim().toLocaleLowerCase();
  }

  /**
   * 在给定笔记里检索关键词。
   * @param {object[]} notes {@link list} 的输出
   * @param {string} query 关键词：同行空格=AND、换行=OR（见 {@link parseQuery}）
   */
  function search(notes, query, options = {}) {
    const parsed = parseQuery(query);
    if (!parsed.groups.length) return { hits: [], total: 0, truncated: 0, query: "" };
    const maxHits = options.maxHits > 0 ? options.maxHits : DEFAULT_MAX_HITS;
    const contextChars = options.contextChars > 0 ? options.contextChars : DEFAULT_CONTEXT_CHARS;
    const hits = [];
    for (const note of notes || []) {
      const titleText = normalize(note.title);
      for (const paragraph of note.paragraphs || []) {
        const haystack = normalize(paragraph.text);
        // 命中条件：任意一个 OR 组，组内每个词都在正文或标题里出现
        const group = parsed.groups.find((terms) => terms.every((term) => (
          haystack.includes(term) || titleText.includes(term)
        )));
        if (!group) continue;
        const first = group.find((term) => haystack.includes(term));
        const at = first ? haystack.indexOf(first) : 0;
        const half = Math.floor(contextChars / 2);
        const start = Math.max(0, at - half);
        const snippet = paragraph.text.slice(start, start + contextChars).trim();
        hits.push({
          noteID: note.id,
          noteKey: note.key,
          noteTitle: note.title,
          paragraphIndex: paragraph.index,
          offset: at,
          terms: group,
          snippet: snippet.length < paragraph.text.length ? `${snippet}…` : snippet,
          paragraphChars: paragraph.text.length,
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
      notesScanned: (notes || []).length,
      groups: parsed.groups,
    };
  }

  /** 命中 → materials.fromNote 的构造参数（标出笔记名与段落位置） */
  function toMaterialOptions(hit, options = {}) {
    const position = `第 ${hit.paragraphIndex} 段`;
    return {
      noteID: hit.noteID,
      title: hit.noteTitle,
      text: hit.snippet,
      label: `子笔记：${hit.noteTitle}（${position}）`,
      detail: `${hit.snippet.length} 字｜${position}${hit.paragraphChars > hit.snippet.length ? `｜该段共 ${hit.paragraphChars} 字（已截取）` : ""}`,
      source: options.source || `note:${hit.noteID}:${hit.paragraphIndex}`,
    };
  }

  /** 便捷入口：读取 + 检索 + 生成材料参数；供侧栏与端点共用 */
  async function find(item, query, options = {}) {
    const notes = await list(item);
    if (!notes.length) {
      return { hits: [], total: 0, truncated: 0, query: String(query || "").trim(), notesScanned: 0, materials: [] };
    }
    const result = search(notes, query, options);
    result.notesScanned = notes.length;
    result.materials = result.hits.map((hit) => toMaterialOptions(hit, options));
    return result;
  }

  /** 全库扫描时最多看多少篇笔记（避免大库卡死） */
  const DEFAULT_MAX_SCAN = 400;

  /**
   * 取全库候选笔记：每个 OR 组各用一个最长词做 Zotero.Search 粗筛，再合并候选，
   * 搜索不可用时退回逐库遍历（到上限即停并标记截断）。
   * @returns {Promise<{records:object[], truncated:boolean, usedSearch:boolean}>}
   */
  async function candidateNotes(parsed, options = {}) {
    const maxNotes = options.maxNotes > 0 ? options.maxNotes : DEFAULT_MAX_SCAN;
    // 只用全局最长词会漏掉“不含该词、但命中其它换行组”的笔记。
    const probes = parsed.groups
      .map((terms) => terms.slice().sort((a, b) => b.length - a.length)[0] || "")
      .filter(Boolean);
    const libraries = (Zotero.Libraries && Zotero.Libraries.getAll ? Zotero.Libraries.getAll() : []) || [];
    const ids = new Set();
    let usedSearch = false;
    try {
      for (const library of libraries) {
        if (!library || !library.libraryID || library.libraryID < 1) continue;
        for (const probe of probes) {
          const searcher = new Zotero.Search();
          searcher.libraryID = library.libraryID;
          searcher.addCondition("itemType", "is", "note");
          searcher.addCondition("note", "contains", probe);
          // eslint-disable-next-line no-await-in-loop
          const found = await searcher.search();
          usedSearch = true;
          for (const id of found || []) ids.add(id);
        }
      }
    }
    catch (error) {
      usedSearch = false;
      ids.clear();
    }

    let notes = [];
    let truncated = false;
    if (usedSearch) {
      if (ids.size > maxNotes) truncated = true;
      const list = await Zotero.Items.getAsync([...ids].slice(0, maxNotes));
      notes = (list || []).filter(Boolean);
    }
    else {
      for (const library of libraries) {
        if (!library || !library.libraryID || library.libraryID < 1) continue;
        const all = Zotero.Items.getAll(library.libraryID) || [];
        for (const item of all) {
          if (!item || typeof item.isNote !== "function" || !item.isNote()) continue;
          notes.push(item);
          if (notes.length >= maxNotes) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
    }
    const records = [];
    for (const note of notes) {
      const record = recordOf(note);
      if (record) records.push(record);
    }
    return { records, truncated, usedSearch };
  }

  /**
   * 全库检索（用户要求：不再只查当前条目的子笔记）。
   * 语法：同行空格=AND，换行=OR。
   * @returns {Promise<object>} 与 {@link find} 同形，另带 libraryWide / scannedTruncated / usedSearch
   */
  async function findEverywhere(query, options = {}) {
    const parsed = parseQuery(query);
    if (!parsed.groups.length) {
      return {
        hits: [], total: 0, truncated: 0, query: "", notesScanned: 0, materials: [], libraryWide: true,
      };
    }
    const candidates = await candidateNotes(parsed, options);
    const result = search(candidates.records, query, options);
    result.notesScanned = candidates.records.length;
    result.scannedTruncated = candidates.truncated;
    result.usedSearch = candidates.usedSearch;
    result.libraryWide = true;
    result.materials = result.hits.map((hit) => toMaterialOptions(hit, options));
    return result;
  }

  return {
    DEFAULT_MAX_HITS,
    DEFAULT_CONTEXT_CHARS,
    DEFAULT_MAX_SCAN,
    toPlainText,
    paragraphsOf,
    recordOf,
    list,
    parseQuery,
    search,
    toMaterialOptions,
    find,
    candidateNotes,
    findEverywhere,
  };
})();
