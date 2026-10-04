/*
 * Zotero Sideline：本轮材料清单。
 *
 * 功能：把「这一次提问实际要送进模型的东西」组织成一份可见清单：每项有种类、来源标签、
 *       字数与截断状态，可逐项移除；发送前由 assemble() 按上下文预算裁剪，并如实报告
 *       实际送入的字数、被丢弃的项与失败原因（R02/R09 的可见上下文）。
 * 输入：由调用方（阅读器侧栏、划词面板）用 from* 构造材料对象；材料只保存纯数据。
 * 输出：assemble() 返回 {blocks, items, text, chars, images, truncated, dropped}。
 * 依赖：无（纯数据层，不接触 Zotero API），因此可在沙箱测试里独立验证。
 *
 * 材料字段：
 *   id        自增字符串，用于逐项移除
 *   kind      selection | page | document | note | annotation | paste | path | item | image
 *   label     界面上显示的名称（如「选区原文（第 3 页）」）
 *   detail    界面上的第二行（字符数、页范围、失败原因等）
 *   text      送模型的正文（image 为空）
 *   chars     text 的字数
 *   pageIndex 0 基页索引（可空）
 *   pageLabel 纸面页码（可空）
 *   rects     页面空间矩形数组（可空，供跳回原文与批注预览）
 *   dataUrl   图片的 data URL（仅 image）
 *   state     ok | empty | error
 *   error     失败原因（state 为 error 时）
 *   removable 是否允许用户移除（默认 true）
 */

Sideline.materials = (function () {
  const KINDS = ["selection", "page", "document", "note", "annotation", "paste", "path", "item", "image"];

  let counter = 0;

  function nextId(kind) {
    counter++;
    return `${kind}-${counter}`;
  }

  function chars(text) {
    return String(text == null ? "" : text).length;
  }

  /** 构造一项材料；未给出的字段用安全默认值补齐 */
  function create(kind, fields = {}) {
    const text = String(fields.text == null ? "" : fields.text);
    const state = fields.state || (fields.error ? "error" : (text.trim() ? "ok" : "empty"));
    const material = {
      id: fields.id || nextId(kind),
      kind: KINDS.includes(kind) ? kind : "paste",
      label: String(fields.label || defaultLabel(kind, fields)),
      detail: String(fields.detail || ""),
      text,
      chars: chars(text),
      pageIndex: Number.isFinite(fields.pageIndex) ? fields.pageIndex : null,
      pageLabel: fields.pageLabel == null ? "" : String(fields.pageLabel),
      rects: Array.isArray(fields.rects) ? fields.rects : null,
      dataUrl: fields.dataUrl ? String(fields.dataUrl) : "",
      source: fields.source ? String(fields.source) : "",
      state,
      error: fields.error ? String(fields.error) : "",
      removable: fields.removable === undefined ? true : !!fields.removable,
    };
    if (!material.detail) material.detail = defaultDetail(material);
    return material;
  }

  function defaultLabel(kind, fields) {
    const page = fields.pageLabel ? `（第 ${fields.pageLabel} 页）` : "";
    if (kind === "selection") return `选区原文${page}`;
    if (kind === "page") return `第 ${fields.pageLabel || (Number(fields.pageIndex) + 1)} 页正文`;
    if (kind === "document") return "PDF 正文";
    if (kind === "note") return `子笔记：${fields.title || "未命名"}`;
    if (kind === "annotation") return `批注${page}`;
    if (kind === "paste") return "粘贴文本";
    if (kind === "path") return `文件：${fields.name || fields.path || "未命名"}`;
    if (kind === "item") return `条目：${fields.title || "未命名"}`;
    if (kind === "image") return `图片：${fields.name || "未命名"}`;
    return kind;
  }

  function defaultDetail(material) {
    if (material.state === "error") return `读取失败：${material.error || "未知原因"}`;
    if (material.kind === "image") return "图片（按 base64 送入视觉模型）";
    if (material.state === "empty") return "没有可用内容";
    return `${material.chars} 字`;
  }

  function add(list, material) {
    list.push(material);
    return material;
  }

  function remove(list, id) {
    const index = list.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    return list.splice(index, 1)[0];
  }

  function find(list, id) {
    return list.find((entry) => entry.id === id) || null;
  }

  function clear(list) {
    list.length = 0;
    return list;
  }

  /** 同一来源的材料去重：返回已存在的项（调用方据此提示「已在清单中」） */
  function duplicateOf(list, material) {
    if (!material || material.kind === "image") return null;
    const same = (a, b) => a === b || (!a && !b);
    return list.find((entry) => entry.kind === material.kind
      && same(entry.source, material.source)
      && entry.text === material.text) || null;
  }

  // ---- 各类材料的构造器（对外只暴露 from*，避免调用方自己拼字段） ----

  function fromSelection(fields = {}) {
    return create("selection", Object.assign({}, fields, {
      source: fields.source || `selection:${fields.pageIndex}:${chars(fields.text)}`,
    }));
  }

  function fromPage(fields = {}) {
    return create("page", Object.assign({}, fields, {
      source: fields.source || `page:${fields.pageIndex}`,
    }));
  }

  function fromDocument(fields = {}) {
    const pages = Array.isArray(fields.pages) ? fields.pages : [];
    const parts = [];
    if (pages.length) parts.push(`覆盖 ${pages.length} 页`);
    if (Number.isFinite(fields.pageCount) && fields.pageCount) parts.push(`共 ${fields.pageCount} 页`);
    if (fields.emptyPages && fields.emptyPages.length) {
      parts.push(`空白页 ${fields.emptyPages.map((value) => value + 1).join(",")}`);
    }
    if (fields.failedPages && fields.failedPages.length) {
      parts.push(`取文失败 ${fields.failedPages.map((entry) => entry.pageIndex + 1).join(",")}`);
    }
    if (fields.truncated) parts.push(`已截断至 ${chars(fields.text)} 字`);
    else parts.push(`${chars(fields.text)} 字`);
    return create("document", Object.assign({}, fields, {
      detail: parts.join("；"),
      source: fields.source || "document",
    }));
  }

  function fromNote(fields = {}) {
    return create("note", Object.assign({}, fields, {
      source: fields.source || `note:${fields.noteID}`,
    }));
  }

  function fromAnnotation(fields = {}) {
    const quote = String(fields.quote || "");
    const comment = String(fields.comment || "");
    const text = comment ? `> ${quote}\n\n评论：${comment}` : `> ${quote}`;
    return create("annotation", Object.assign({}, fields, {
      text: fields.text || text,
      source: fields.source || `annotation:${fields.key || quote.slice(0, 24)}`,
    }));
  }

  function fromPaste(fields = {}) {
    return create("paste", Object.assign({}, fields, {
      source: fields.source || `paste:${chars(fields.text)}`,
    }));
  }

  function fromPath(fields = {}) {
    return create("path", Object.assign({}, fields, {
      source: fields.source || `path:${fields.path}`,
    }));
  }

  function fromItem(fields = {}) {
    return create("item", Object.assign({}, fields, {
      source: fields.source || `item:${fields.itemID}`,
    }));
  }

  function fromImage(fields = {}) {
    return create("image", Object.assign({}, fields, {
      // 页面区域截图会带一段「来自第 N 页」的说明文本；普通图片没有文本
      text: fields.text == null ? "" : String(fields.text),
      source: fields.source || `image:${fields.name || ""}:${chars(fields.dataUrl)}`,
    }));
  }

  // ---- 送模型的文本块 ----

  /** 单项材料对应的上下文块；image 没有文本块，返回空串 */
  function blockOf(material) {
    if (!material || !material.text) return "";
    const page = material.pageLabel ? `第 ${material.pageLabel} 页` : "";
    switch (material.kind) {
      case "selection":
        return `【选区原文${page ? `（${page}）` : ""}】\n${material.text}`;
      case "page":
        return `【${page || "当前页"}正文】\n${material.text}`;
      case "document":
        return `【PDF 正文】\n${material.text}`;
      case "note":
        return `【子笔记：${material.label.replace(/^子笔记：/, "")}】\n${material.text}`;
      case "annotation":
        return `【批注${page ? `（${page}）` : ""}】\n${material.text}`;
      case "paste":
        return `【用户粘贴的文本】\n${material.text}`;
      case "path":
        return `【本地文件】\n${material.text}`;
      case "item":
        return `【关联条目元数据】\n${material.text}`;
      case "image":
        return material.text;
      default:
        return material.text;
    }
  }

  /**
   * 按预算装配本轮上下文。
   * 预算按清单顺序依次消耗：先到的材料优先保留完整内容，超出部分标记 truncated；
   * 完全没有额度的材料标记 included=false，并给出原因——界面据此显示「实际送入范围」。
   * @param {object[]} list 材料清单
   * @param {object} options maxChars 上下文预算（<=0 表示不限制）
   */
  function assemble(list, options = {}) {
    const budget = options.maxChars > 0 ? options.maxChars : 0;
    let remaining = budget;
    const items = [];
    const blocks = [];
    const images = [];
    const dropped = [];
    let used = 0;

    for (const material of list) {
      const record = {
        id: material.id,
        kind: material.kind,
        label: material.label,
        chars: material.chars,
        state: material.state,
        sentChars: 0,
        truncated: false,
        included: false,
        reason: "",
      };
      if (material.state === "error") {
        record.reason = material.error || "读取失败";
        dropped.push(record);
        items.push(record);
        continue;
      }
      if (material.kind === "image") {
        images.push(material.dataUrl);
        record.included = true;
        record.sentChars = 0;
        // 页面区域截图会带一段「来自第 N 页」的说明文本，让模型知道图从哪来；普通图片没有文本
        if (material.text) {
          const block = blockOf(material);
          blocks.push(block);
          if (budget) remaining -= block.length;
          used += block.length;
          record.sentChars = block.length;
        }
        record.reason = material.text
          ? "作为图片送入，并附带页码说明"
          : "作为图片送入（不计入文本预算）";
        items.push(record);
        continue;
      }
      if (!material.text) {
        record.reason = "没有内容";
        dropped.push(record);
        items.push(record);
        continue;
      }
      const block = blockOf(material);
      const overhead = block.length - material.text.length;
      if (budget && remaining <= overhead) {
        record.reason = "超出本轮上下文预算，未送入";
        dropped.push(record);
        items.push(record);
        continue;
      }
      const room = budget ? remaining - overhead : material.text.length;
      const slice = budget && material.text.length > room ? material.text.slice(0, Math.max(0, room)) : material.text;
      const clipped = slice !== material.text;
      const finalBlock = clipped
        ? blockOf(Object.assign({}, material, { text: slice }))
        : block;
      if (budget) remaining -= finalBlock.length;
      used += finalBlock.length;
      blocks.push(finalBlock);
      record.included = true;
      record.sentChars = slice.length;
      record.truncated = clipped;
      record.reason = clipped ? `已截断（原 ${material.chars} 字）` : "";
      items.push(record);
    }

    return {
      blocks,
      items,
      text: blocks.join("\n\n"),
      chars: used,
      images,
      truncated: items.some((item) => item.truncated),
      dropped,
      budget,
    };
  }

  /** 一行摘要，供材料卡片与状态栏显示 */
  function describe(material) {
    const parts = [material.label];
    if (material.detail) parts.push(material.detail);
    if (material.state === "error") parts.push("（失败）");
    return parts.join("｜");
  }

  function summaryText(list) {
    const usable = list.filter((entry) => entry.state !== "error");
    const failed = list.length - usable.length;
    const total = usable.reduce((sum, entry) => sum + entry.chars, 0);
    const parts = [`${list.length} 项材料`, `约 ${total} 字`];
    if (failed) parts.push(`${failed} 项读取失败`);
    return parts.join("，");
  }

  return {
    KINDS,
    create,
    add,
    remove,
    find,
    clear,
    duplicateOf,
    blockOf,
    assemble,
    describe,
    summaryText,
    fromSelection,
    fromPage,
    fromDocument,
    fromNote,
    fromAnnotation,
    fromPaste,
    fromPath,
    fromItem,
    fromImage,
  };
})();
