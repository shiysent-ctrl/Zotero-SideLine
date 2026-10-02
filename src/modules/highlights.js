/*
 * Zotero Sideline：重点高亮候选（R07 的定位侧）。
 *
 * 功能：把「自动高亮建议」功能返回的 JSON 候选，逐条在 PDF 里定位成可写入的批注坐标，
 *       供界面先预览再创建；解析与定位分开，任何一条定位失败只影响该条。
 * 输入：reader（阅读器对象）、候选数组 [{page, quote, reason}]、可选的纸面页码数组。
 * 输出：{ok, pageIndex, pageLabel, quote, reason, rects, approximate, error} 数组（纯数据）。
 * 依赖：readertext.js（locate/rectsForRange/pageLabels）、annotations.js（写入）、config.js（条数上限）。
 *
 * 设计说明：
 * 1) 模型只负责挑句子与给页码，坐标一律由插件从 pdf.js 文本片段算出，不采信模型给的数字；
 * 2) 定位失败（页码对不上、该页找不到原句、算不出矩形）的候选保留在结果里并带 error，
 *    界面据此显示「N 条可写入、M 条需人工处理」，不会静默丢弃；
 * 3) 只做「新增批注」，不修改既有批注；写入由用户点击确认后逐条执行。
 */

Sideline.highlights = (function () {
  const DEFAULT_MAX_ITEMS = 12;

  function limitOf() {
    const value = Sideline.config.num("highlightMaxItems");
    return value > 0 ? value : DEFAULT_MAX_ITEMS;
  }

  /**
   * 宽松解析模型输出里的高亮候选。
   * 与大纲解析同一态度：拿不到合法数组、数组为空或条目全不可用时直接报错，不猜内容。
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
      throw new Error(`高亮建议不是合法 JSON：${Sideline.util.message(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error("高亮建议不是数组");
    const out = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const quote = String(entry.quote || entry.text || entry.原文 || "").trim();
      if (!quote) continue;
      out.push({
        page: entry.page === undefined || entry.page === null ? "" : String(entry.page),
        quote,
        reason: String(entry.reason || entry.理由 || "").trim(),
      });
    }
    if (!out.length) throw new Error("高亮建议里没有可用条目（缺少 quote 字段）");
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
    for (const candidate of candidates || []) {
      const record = {
        ok: false,
        page: candidate.page,
        pageLabel: candidate.page,
        pageIndex: null,
        quote: candidate.quote,
        reason: candidate.reason || "",
        rects: null,
        approximate: false,
        error: "",
      };
      const resolved = resolvePage(candidate.page, labels);
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
        const located = await Sideline.readertext.locate(reader, {
          pageIndex: resolved.pageIndex,
          text: candidate.quote,
        });
        if (!located.found) {
          record.error = located.error || "在该页没有找到这段原文";
          prepared.push(record);
          continue;
        }
        const range = await Sideline.readertext.rectsForRange(reader, resolved.pageIndex, located.from, located.to);
        if (!range.rects.length) {
          record.error = "无法由文本片段算出坐标";
          prepared.push(record);
          continue;
        }
        record.ok = true;
        record.rects = range.rects;
        record.approximate = !!located.approximate;
        record.matched = located.match || candidate.quote;
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
  async function commit({ attachment, entries, color, commentOf }) {
    const created = [];
    for (const entry of entries || []) {
      if (!entry) continue;
      const record = {
        ok: false,
        pageIndex: Number.isFinite(entry.pageIndex) ? entry.pageIndex : null,
        pageLabel: entry.pageLabel || "",
        quote: entry.quote || "",
        key: "",
        id: 0,
        error: "",
      };
      // 未定位成功的条目也返回一条记录（带原因），界面据此说明「哪几条没写进去」
      if (!entry.ok) {
        record.error = entry.error || "该条未定位成功，未写入";
        created.push(record);
        continue;
      }
      try {
        const annotation = {
          type: "highlight",
          text: entry.quote,
          pageLabel: entry.pageLabel,
          position: { pageIndex: entry.pageIndex, rects: entry.rects },
        };
        const comment = typeof commentOf === "function" ? commentOf(entry) : (entry.reason || "");
        // eslint-disable-next-line no-await-in-loop
        const saved = await Sideline.annotations.saveHighlightComment({
          attachment,
          annotation,
          comment,
          color,
        });
        record.ok = true;
        record.key = saved && saved.key ? String(saved.key) : "";
        record.id = saved && saved.id ? Number(saved.id) : 0;
      }
      catch (error) {
        record.error = Sideline.util.message(error);
      }
      created.push(record);
    }
    return created;
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
  };
})();
