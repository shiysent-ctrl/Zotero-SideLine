/*
 * Zotero Sideline：回答里的页码引用（R04）。
 *
 * 功能：从模型回答里识别页码引用（「第 3 页」「pp.3-5」「page 3」），把纸面页码解析成 0 基页索引，
 *       并在渲染后的 HTML 里把它们包成可点击的锚点；另外提取 `>` 引用块及其所属页码，
 *       供「定位引用原文」使用。
 * 输入：markdown 原文或 util.markdownToHtml() 产出的 HTML；labels 为纸面页码数组。
 * 输出：纯数据（引用列表 / label→pageIndex 映射）与改写后的 HTML 字符串。
 * 依赖：modules/util.js（HTML 转义）；跳回由调用方（readerside）用 readertext.jump 完成。
 *
 * 设计说明：
 * 1) 只在渲染后的 HTML 上做正则替换，不改动 Markdown 渲染器；命中文本本身不含 HTML 特殊字符
 *    （中文「第 N 页」与 p.3 之类），所以替换是安全的。
 * 2) `<pre>` 代码块整段跳过，避免把代码里的 "p.3" 变成链接。
 * 3) 页码标签来自 PDF 的 getPageLabels2()，因此「第 3 页」指的是纸面页码而非物理页序号；
 *    解析不到时就保持原文，不猜。
 */

Sideline.citations = (function () {
  // 页码引用的常见写法，合并成一个正则按顺序尝试：
  //   1) 第 3 页 / 第 5–7 页（中文）
  //   2) 5–7 页（没有「第」的区间）
  //   3) p.3 / pp.3-5
  //   4) page 3 / pages 3-5
  // 合并成一个正则而不是多个正则依次 replace，是为了避免同一段文字被包两层锚点。
  const ALTERNATIVES = [
    { source: "第\\s*([0-9]{1,4}|[ivxlcdmIVXLCDM]{1,7})\\s*(?:[-–—~至]\\s*([0-9]{1,4}|[ivxlcdmIVXLCDM]{1,7})\\s*)?页", groups: [1, 2] },
    { source: "([0-9]{1,4})\\s*[-–—~]\\s*([0-9]{1,4})\\s*页", groups: [3, 4] },
    { source: "\\bpp?\\.\\s*([0-9]{1,4})(?:\\s*[-–—~]\\s*([0-9]{1,4}))?", groups: [5, 6] },
    { source: "\\bpages?\\s+([0-9]{1,4})(?:\\s*[-–—~]\\s*([0-9]{1,4}))?", groups: [7, 8] },
  ];
  const PAGE_PATTERN = new RegExp(ALTERNATIVES.map((entry) => `(?:${entry.source})`).join("|"), "gi");

  /** 从匹配结果里取出「起始标签 + 可选结束标签」；四组候选按顺序找第一组有值的 */
  function labelsOf(match) {
    for (const entry of ALTERNATIVES) {
      const start = match[entry.groups[0]];
      if (start !== undefined && start !== null && start !== "") {
        const end = match[entry.groups[1]];
        return { label: String(start), label2: end === undefined || end === null ? "" : String(end) };
      }
    }
    return null;
  }

  function scan(source, onMatch) {
    PAGE_PATTERN.lastIndex = 0;
    let match = PAGE_PATTERN.exec(source);
    while (match) {
      const labels = labelsOf(match);
      if (labels) onMatch(match, labels);
      if (match.index === PAGE_PATTERN.lastIndex) PAGE_PATTERN.lastIndex++;
      match = PAGE_PATTERN.exec(source);
    }
  }

  /**
   * 找出文本里的全部页码引用。
   * @returns {{start:number,end:number,raw:string,label:string,label2:string}[]} 按出现位置排序
   */
  function find(text) {
    const source = String(text == null ? "" : text);
    const out = [];
    scan(source, (match, labels) => {
      out.push({
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
        label: labels.label,
        label2: labels.label2,
      });
    });
    return out.sort((a, b) => a.start - b.start);
  }

  /** 单个标签 → 0 基页索引；labels 为空时按「数字即 1 基页序号」猜测，猜不到返回 null */
  function labelToIndex(label, labels) {
    const wanted = String(label == null ? "" : label).trim();
    if (!wanted) return null;
    if (Array.isArray(labels) && labels.length) {
      const index = labels.findIndex((value) => String(value) === wanted);
      if (index >= 0) return index;
      return null;
    }
    const number = parseInt(wanted, 10);
    return Number.isFinite(number) && number >= 1 ? number - 1 : null;
  }

  /**
   * 把引用列表解析成 {label, pageIndex}；解析不到的项直接丢掉（宁可不做锚点，也不跳到错页）。
   */
  function resolve(refs, labels) {
    const seen = new Set();
    const out = [];
    for (const ref of refs || []) {
      const pageIndex = labelToIndex(ref.label, labels);
      if (pageIndex === null || pageIndex < 0) continue;
      const key = `${ref.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        label: String(ref.label),
        label2: ref.label2 ? String(ref.label2) : "",
        raw: ref.raw || `第 ${ref.label} 页`,
        pageIndex,
      });
    }
    return out;
  }

  /** label → pageIndex 的查表对象，供 annotate 使用；优先用纸面页码，其次才是显示标签 */
  function toMap(entries) {
    const map = {};
    for (const entry of entries || []) {
      if (!entry) continue;
      const key = entry.pageLabel === undefined || entry.pageLabel === null || entry.pageLabel === ""
        ? String(entry.label)
        : String(entry.pageLabel);
      map[key] = Number(entry.pageIndex);
    }
    return map;
  }

  /** 从消息里已经存下的引用（citations）取出 label→pageIndex；重启后无 PDF 也能用 */
  function mapFromCitations(citations) {
    const map = {};
    for (const entry of citations || []) {
      if (!entry || entry.pageIndex === null || entry.pageIndex === undefined) continue;
      const source = String(entry.pageLabel || entry.label || "");
      const match = source.match(/([0-9]{1,4}|[ivxlcdmIVXLCDM]{1,7})/);
      if (match) map[match[1]] = Number(entry.pageIndex);
    }
    return map;
  }

  function annotateSegment(segment, lookup) {
    return String(segment).replace(PAGE_PATTERN, (match, ...rest) => {
      // replace 回调的 rest 从「第 1 个分组」开始，而 labelsOf 按 exec 结果的形状取值
      // （下标 0 是整个匹配），因此这里要把整段匹配补回数组开头
      const groups = [match].concat(rest.slice(0, ALTERNATIVES.length * 2));
      const labels = labelsOf(groups);
      if (!labels) return match;
      const pageIndex = lookup(labels.label);
      if (pageIndex === null || pageIndex === undefined || !Number.isFinite(Number(pageIndex))) {
        return match;
      }
      return `<span class="sideline-pageref" data-sideline-page="${Number(pageIndex)}"`
        + ` role="link" tabindex="0" title="跳到该页">${match}</span>`;
    });
  }

  /**
   * 在渲染后的 HTML 里把页码引用包成锚点。
   * @param {string} html util.markdownToHtml() 的输出
   * @param {object|Function} map label→pageIndex 的对象，或 (label)=>index 的函数
   */
  function annotate(html, map) {
    const source = String(html == null ? "" : html);
    const lookup = typeof map === "function"
      ? map
      : (label) => (map && Object.prototype.hasOwnProperty.call(map, label) ? map[label] : null);
    // 用捕获分组切分，奇数下标是 <pre> 代码块，整段跳过
    const segments = source.split(/(<pre[\s\S]*?<\/pre>)/g);
    return segments
      .map((segment, index) => (index % 2 === 1 ? segment : annotateSegment(segment, lookup)))
      .join("");
  }

  /**
   * 提取 `>` 引用块，并带上该引用所属的页码标签（同一行有页码用它，否则用最近一次出现的页码）。
   */
  function quotes(text) {
    const lines = String(text == null ? "" : text).split(/\r?\n/);
    const out = [];
    let lastLabels = [];
    for (const line of lines) {
      const labels = find(line).map((ref) => ref.label);
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        const body = String(quote[1]).replace(/[*`]/g, "").trim();
        if (body) out.push({ text: body, labels: labels.length ? labels : lastLabels.slice() });
        continue;
      }
      if (labels.length) lastLabels = labels;
    }
    return out;
  }

  /** 原文锚点只保存引句；坐标必须点击时从当前 PDF 反查，绝不接受模型位置。 */
  function render(markdown, map) {
    const anchors = [];
    const source = String(markdown || "").split(/(```[\s\S]*?```)/g).map((part, index) => {
      if (index % 2) return part;
      return part.replace(/（(第\s*([0-9]{1,4}|[ivxlcdmIVXLCDM]{1,7})\s*页)[；;]\s*原文[：:]\s*“([^”\r\n]{8,500})”）/g,
        (match, label, number, quote) => {
          const pageIndex = map && Object.prototype.hasOwnProperty.call(map, number) ? map[number] : null;
          if (!Number.isInteger(pageIndex) || pageIndex < 0) return match;
          const token = `\uFFF4${anchors.length}\uFFF5`;
          anchors.push(`<span class="sideline-pageref" data-sideline-page="${pageIndex}"`
            + ` data-sideline-quote="${Sideline.util.escapeAttr(quote)}" role="link" tabindex="0"`
            + ` title="定位原文：${Sideline.util.escapeAttr(quote)}">${Sideline.util.escapeHtml(label)}</span>`);
          return `（${token}）`;
        });
    }).join("");
    let html = annotate(Sideline.util.markdownToHtml(source), map);
    anchors.forEach((anchor, index) => { html = html.split(`\uFFF4${index}\uFFF5`).join(anchor); });
    return html;
  }

  function summaryText(entries) {
    if (!entries || !entries.length) return "没有可跳转的页码引用";
    const labels = [...new Set(entries.map((entry) => String(entry.label)))];
    return `可跳转页码：${labels.join("、")}`;
  }

  return {
    ALTERNATIVES,
    PAGE_PATTERN,
    find,
    resolve,
    labelToIndex,
    toMap,
    mapFromCitations,
    annotate,
    render,
    quotes,
    summaryText,
  };
})();
