/*
 * Zotero Sideline：重点高亮候选（R07 的定位侧）。
 *
 * 功能：把「自动高亮建议」功能返回的 JSON 候选，逐条在 PDF 里定位成可写入的批注坐标，
 *       用户执行功能后直接保存可靠匹配，结果只显示本地回执；逐条颜色与评论独立。
 * 输入：reader、候选 [{pageIndex/page, quote, comment/reason, color, occurrence}] 及批次信息。
 * 输出：逐项定位/保存结果、正文段和 UI 回执。依赖 readertext、annotations、writes/store、config。
 *
 * 设计说明：
 * 1) 模型只负责挑句子与给页码，坐标一律由插件从 pdf.js 文本片段算出，不采信模型给的数字；
 * 2) 定位或保存失败的候选保留可读原因，界面直接报告数量，不渲染内部结构；
 * 3) 只新增批注，先保存批次日志；失败和停止不影响已创建项的归属。
 */

Sideline.highlights = (function () {
  const DEFAULT_MAX_ITEMS = 12;
  const writingAttachments = new Set();
  const COLORS = { yellow: "#ffd400", "黄色": "#ffd400", "黄": "#ffd400",
    red: "#ff6666", "红色": "#ff6666", "红": "#ff6666", green: "#5fb236", "绿色": "#5fb236", "绿": "#5fb236",
    blue: "#2ea8e5", "蓝色": "#2ea8e5", "蓝": "#2ea8e5", purple: "#a28ae5", "紫色": "#a28ae5", "紫": "#a28ae5",
    magenta: "#e56eee", "洋红": "#e56eee", orange: "#f19837", "橙色": "#f19837", gray: "#aaaaaa", grey: "#aaaaaa", "灰色": "#aaaaaa" };

  function colorOf(value) {
    const color = String(value || "").trim().toLowerCase();
    if (!color) return "";
    if (/^#[0-9a-f]{6}$/.test(color)) return color;
    if (COLORS[color]) return COLORS[color];
    throw new Error(`无法识别颜色「${color}」`);
  }

  function contract() {
    return "【插件必需的输出契约，不改变上面的阅读要求】\n"
      + "只输出 JSON 数组。每项包含 pageIndex（材料标记的 0 基 PDF 页索引）、quote（完整逐字原文）、"
      + "comment（按用户要求撰写的批注）、color（按用户要求的颜色名称或 #rrggbb；未指定可留空）。"
      + "同页重复原文需给 occurrence（从 1 开始）。不提供坐标，不改写原文，不输出额外说明。"
      + `每段最多 ${limitOf()} 项；可以返回 []。`;
  }

  function limitOf() {
    const value = Sideline.config.num("highlightMaxItems");
    return value > 0 ? value : DEFAULT_MAX_ITEMS;
  }

  /**
   * 宽松解析模型输出里的高亮候选。
   * 无合法数组或没有候选字段时报错；空数组表示没有重点，不自动请求模型修复。
   */
  function parse(text) {
    const source = String(text == null ? "" : text);
    if (!source.trim()) throw new Error("没有可解析的高亮建议");
    let body = source.replace(/```[a-zA-Z0-9_-]*\s*\n?/g, "").replace(/```/g, "");
    const start = body.indexOf("[");
    const end = body.lastIndexOf("]");
    if (start < 0 || end <= start) throw new Error("模型输出里没有 JSON 数组");
    body = body.slice(start, end + 1);
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    }
    catch (error) {
      throw new Error("高亮建议的 JSON 结构无法解析；未保存本段候选");
    }
    if (!Array.isArray(parsed)) throw new Error("高亮建议不是数组");
    const out = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      if (!["quote", "text", "原文", "page", "pageIndex", "comment", "reason", "理由", "color"].some((key) => Object.prototype.hasOwnProperty.call(entry, key))) continue;
      const quote = String(entry.quote || entry.text || entry.原文 || "").trim();
      out.push({
        page: entry.page === undefined || entry.page === null ? "" : String(entry.page),
        quote,
        reason: String(entry.reason || entry.理由 || "").trim(),
        comment: String(entry.comment === undefined ? (entry.reason || entry.理由 || "") : entry.comment).trim(),
        color: String(entry.color || ""),
        pageIndex: Number.isSafeInteger(entry.pageIndex) && entry.pageIndex >= 0 ? entry.pageIndex : null,
        occurrence: Number.isSafeInteger(entry.occurrence) && entry.occurrence > 0 ? entry.occurrence : undefined,
      });
    }
    if (!out.length && parsed.length) throw new Error("高亮建议里没有包含 quote 原文的可用条目");
    return out.slice(0, limitOf());
  }

  /** 判断一段回答看起来是不是高亮候选（用于决定是否渲染预览面板），失败不抛错 */
  function looksLikeCandidates(text) {
    const source = String(text == null ? "" : text);
    // 先用便宜的判断挡掉绝大多数普通回答，避免每条消息都做一次 JSON.parse
    if (source.indexOf("[") < 0 || source.indexOf("{") < 0 || source.indexOf("quote") < 0) return false;
    try {
      const parsed = parse(source);
      return parsed.length > 0;
    }
    catch (error) {
      return false;
    }
  }

  /** 纸面页码 → 0 基页索引 */
  function resolvePage(page, labels) {
    const wanted = String(page == null ? "" : page).trim();
    if (Array.isArray(labels) && labels.length) {
      const index = labels.findIndex((value) => String(value) === wanted);
      if (index >= 0) return { pageIndex: index, label: String(labels[index]) };
      return { pageIndex: null, label: wanted };
    }
    const number = parseInt(wanted, 10);
    if (Number.isFinite(number) && number >= 1) {
      return { pageIndex: number - 1, label: String(number), guessed: true };
    }
    return { pageIndex: null, label: wanted };
  }

  /**
   * 逐条定位候选。
   * @param {object} reader 阅读器对象
   * @param {object[]} candidates {@link parse} 的输出
   * @param {object} [options] labels 纸面页码数组（不给则自动取）
   */
  async function prepare(reader, candidates, options = {}) {
    let labels = options.labels || null;
    if (!labels) {
      try {
        labels = await Sideline.readertext.pageLabels(reader);
      }
      catch (error) {
        labels = null;
      }
    }
    const prepared = [];
    const pageCache = options.pageCache || new Map();
    for (const candidate of candidates || []) {
      const record = {
        ok: false,
        page: candidate.page,
        pageLabel: candidate.page,
        pageIndex: null,
        quote: candidate.quote,
        reason: candidate.reason || "",
        comment: candidate.comment === undefined ? candidate.reason || "" : candidate.comment,
        color: "",
        rects: null,
        approximate: false,
        error: "",
      };
      const resolved = Number.isSafeInteger(candidate.pageIndex)
        ? { pageIndex: candidate.pageIndex, label: labels && labels[candidate.pageIndex] || String(candidate.pageIndex + 1) }
        : resolvePage(candidate.page, labels);
      if (resolved.pageIndex === null) {
        record.error = candidate.page
          ? `该 PDF 的页码里没有「${candidate.page}」`
          : "模型没有给出页码";
        prepared.push(record);
        continue;
      }
      record.pageIndex = resolved.pageIndex;
      record.pageLabel = resolved.label || String(resolved.pageIndex + 1);
      record.pageIndexGuessed = !!resolved.guessed;
      try {
        if (options.allowedPages && !options.allowedPages.includes(resolved.pageIndex)) throw new Error("原文页码不在本段材料内");
        if (resolved.pageIndex >= Sideline.readertext.pageCount(reader)) throw new Error("原文页码超出 PDF 范围");
        record.color = colorOf(candidate.color);
        const range = await Sideline.readertext.highlightRange(reader, resolved.pageIndex, candidate.quote, candidate.occurrence, { pageCache });
        if (!range.rects.length) {
          record.error = "无法由文本片段算出坐标";
          prepared.push(record);
          continue;
        }
        record.ok = true;
        record.rects = range.rects;
        record.sortIndex = range.sortIndex;
        record.approximate = !!range.approximate;
        record.quote = range.text;
        record.matched = range.text;
      }
      catch (error) {
        record.error = Sideline.util.message(error);
      }
      prepared.push(record);
    }
    return prepared;
  }

  /** 概览：可写入/需人工处理各几条，供界面显示「实际会写入什么」 */
  function summary(prepared) {
    const ok = (prepared || []).filter((entry) => entry.ok);
    const failed = (prepared || []).filter((entry) => !entry.ok);
    return {
      total: (prepared || []).length,
      ok: ok.length,
      failed: failed.length,
      pages: [...new Set(ok.map((entry) => entry.pageLabel))],
      approximate: ok.filter((entry) => entry.approximate).length,
    };
  }

  /** 预览单条：滚动到该页并短暂高亮（不写任何数据） */
  function preview(reader, entry) {
    if (!entry || !entry.ok) return Promise.resolve({ ok: false, reason: entry ? entry.error : "该条不可预览" });
    return Sideline.readertext.jump(reader, { pageIndex: entry.pageIndex, rects: entry.rects });
  }

  /**
   * 写入选中的候选（只新增批注）。
   * @param {object} options attachment 目标 PDF 附件；entries 已定位的候选；color 颜色；commentOf 可选回调
   * @returns {Promise<object[]>} 逐条 {ok, key, id, pageLabel, quote, error}
   */
  async function commit(options) {
    const { attachment } = options;
    const lock = `${attachment.libraryID}:${attachment.key}`;
    if (writingAttachments.has(lock)) throw new Error("该 PDF 正在保存批注，请等待当前操作完成");
    writingAttachments.add(lock);
    try { return await commitEntries(options); }
    finally { writingAttachments.delete(lock); }
  }

  async function commitEntries({ attachment, entries, color, commentOf, ownerID, batchId, shouldStop }) {
    const created = [];
    const seen = new Set();
    const positionKey = (position) => JSON.stringify({ pageIndex: position.pageIndex, rects: position.rects });
    const existing = typeof attachment.getAnnotations === "function" ? attachment.getAnnotations() : [];
    for (const item of existing) {
      if (item.deleted || item.annotationType !== "highlight") continue;
      try { seen.add(positionKey(JSON.parse(item.annotationPosition))); } catch (_) { /* 无效外部批注不参与去重 */ }
    }
    for (const entry of entries || []) {
      if (shouldStop && shouldStop()) break;
      if (!entry) continue;
      const record = {
        ok: false,
        pageIndex: Number.isFinite(entry.pageIndex) ? entry.pageIndex : null,
        pageLabel: entry.pageLabel || "",
        quote: entry.quote || "",
        key: "",
        id: 0,
        error: "",
        skipped: false,
      };
      // 未定位成功的条目也返回一条记录（带原因），界面据此说明「哪几条没写进去」
      if (!entry.ok) {
        record.error = entry.error || "该条未定位成功，未写入";
        created.push(record);
        continue;
      }
      let journal = null;
      try {
        const annotation = {
          type: "highlight",
          text: entry.quote,
          pageLabel: entry.pageLabel,
          position: { pageIndex: entry.pageIndex, rects: entry.rects },
          sortIndex: entry.sortIndex,
        };
        const signature = positionKey(annotation.position);
        if (seen.has(signature)) { record.skipped = true; created.push(record); continue; }
        const comment = typeof commentOf === "function" ? commentOf(entry) : (entry.comment === undefined ? entry.reason || "" : entry.comment);
        const json = Sideline.annotations.buildJSON(annotation, comment, entry.color || color);
        journal = batchId ? await Sideline.writes.journalAnnotation(ownerID, attachment, batchId, json) : null;
        if (shouldStop && shouldStop()) {
          if (journal) await Sideline.store.updateWrite(ownerID, journal.id, { detail: { state: "failed" } });
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const saved = await Sideline.annotations.saveJSON(attachment, json);
        record.ok = true;
        record.key = saved && saved.key ? String(saved.key) : "";
        record.id = saved && saved.id ? Number(saved.id) : 0;
        seen.add(signature);
        if (journal) {
          try {
            await Sideline.store.updateWrite(ownerID, journal.id, { targetID: record.id, detail: {
              state: "created", snapshot: Sideline.writes.annotationSnapshot(saved) } });
            if (!(await Sideline.store.flushItem(ownerID))) throw new Error("记录落盘失败");
          } catch (error) { record.error = `批注已创建，但记录未完成：${Sideline.util.message(error)}`; }
        }
      }
      catch (error) {
        record.error = Sideline.util.message(error);
        if (journal && !record.ok) {
          // 保存中断可能发生在宿主已经写入之后；维持 pending，恢复时保留不能核验的对象。
          Sideline.util.log(`批注写入未完成，日志 ${journal.id} 保留待核验状态`);
        }
      }
      created.push(record);
    }
    return created;
  }

  /** 失败与撤销回执仅用于气泡显示，不提交为新的模型消息。 */
  function receipt(batch) {
    if (!batch) return "自动高亮未完成；未创建批注。";
    const lines = [`${batch.status === "running" ? "处理中；" : batch.status === "stopped" ? "已停止；" : ""}已创建 ${batch.created} 条批注`
      + `${batch.skipped ? `，跳过 ${batch.skipped} 条重复标注` : ""}${batch.failed ? `；${batch.failed} 项未完成` : ""}。`];
    if (batch.coverage) lines.push(batch.coverage);
    if (batch.cost && batch.cost.calls) {
      const c = batch.cost;
      lines.push(`本次调用 ${c.calls} 次；${c.reportedCalls ? `接口报告 ${c.tokens} tokens（${c.reportedCalls}/${c.calls} 次有用量）` : "接口未返回实际用量"}。`
        + ` 请求输入估算 ${c.estimatedInput} tokens。`);
    }
    const errors = batch.errors || [];
    if (errors.length <= 5) for (const error of errors) lines.push(`${error.page ? `第 ${error.page} 页：` : ""}${error.quote ? `“${error.quote}”：` : ""}${error.reason}`);
    else {
      const groups = new Map();
      for (const error of errors) groups.set(error.reason, (groups.get(error.reason) || 0) + 1);
      for (const [reason, count] of groups) lines.push(`${count} 项：${reason}`);
    }
    if (batch.undo) {
      const u = batch.undo;
      lines.push(`已撤销 ${u.removed} 条；保留 ${u.edited} 条已编辑批注`
        + `${u.missing ? `；${u.missing} 条已不存在` : ""}${u.failed ? `；${u.failed} 项撤销失败（身份、记录或保存未能核验）` : ""}。`);
      for (const reason of [...new Set(u.errors || [])]) lines.push(`撤销未完成：${reason}`);
    }
    return lines.join("\n\n");
  }

  /** 长文按连续页组成有预算的段落；正文不静默截断，内部段仍属于同一用户操作。 */
  async function documentChunks(reader, maxChars, shouldStop, options = {}) {
    const budget = Math.max(1000, Number(maxChars) || 24000), chunks = [], errors = [];
    let text = "", pages = [];
    const labels = await Sideline.readertext.pageLabels(reader);
    const push = () => { if (pages.length) chunks.push({ text, pages }); text = ""; pages = []; };
    for (let index = 0; index < Sideline.readertext.pageCount(reader); index++) {
      if (shouldStop && shouldStop()) break;
      const label = labels && labels[index] || String(index + 1);
      let body;
      try { body = await Sideline.readertext.highlightText(reader, index, options); }
      catch (error) { errors.push({ page: label, reason: Sideline.util.message(error) }); continue; }
      if (!body.trim()) { errors.push({ page: label, reason: "没有文字层，需要 OCR" }); continue; }
      const marker = `【PDF页索引=${index}；阅读器页码=${label}】\n`;
      if (marker.length + body.length > budget) {
        push();
        // 单页也可超预算：分段保留同页索引，避免丢掉页尾。相邻段共享少量正文以保留跨段句子。
        const room = Math.max(500, budget - marker.length), overlap = Math.min(300, Math.floor(room / 5));
        for (let at = 0; at < body.length; at += room - overlap) chunks.push({ text: marker + body.slice(at, at + room), pages: [index] });
        continue;
      }
      if (text.length + marker.length + body.length + 2 > budget) push();
      text += (text ? "\n\n" : "") + marker + body; pages.push(index);
    }
    push();
    return { chunks, errors, pageCount: Sideline.readertext.pageCount(reader) };
  }

  return {
    DEFAULT_MAX_ITEMS,
    limitOf,
    parse,
    looksLikeCandidates,
    resolvePage,
    prepare,
    summary,
    preview,
    commit,
    contract,
    colorOf,
    receipt,
    documentChunks,
  };
})();
