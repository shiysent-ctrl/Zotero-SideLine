/*
 * Sideline 同页正文相似匹配。
 * 输入：原生字符序列、引用和出现序号；输出：字符范围与相似度，或可读的拒绝原因。
 * 依赖：无宿主依赖，不读取 PDF 或生成坐标。readertext 只在精确匹配零命中后调用 locate。
 * 保留 UTF-16 编辑距离、80% 阈值和次佳候选 10 个百分点分差；短句与公式不回退。
 */
Sideline.prosematch = (function () {
  const PROSE_THRESHOLD = 0.8;
  const PROSE_MARGIN = 0.1;
  const PROSE_MAX_LENGTH = 1200;

  /** 比较正文顺序，不判断数学含义；原字符不变，引用编号及排版符号仅在评分时忽略。 */
  function proseText(value) {
    return String(value || "").normalize("NFKC").toLowerCase()
      .replace(/\[\s*\d+(?:\s*[-–—,;]\s*\d+)*\s*\]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function hasProse(value, normalized) {
    const han = (String(value).match(/\p{Script=Han}/gu) || []).length;
    const words = (String(value).match(/[a-zA-Z]{2,}/g) || []).length;
    const operators = (String(value).match(/[=<>≤≥≠+×÷∑∫]/g) || []).length;
    // 30 个正文长度单位（汉字计两单位），且有自然语言词汇；短句和纯公式保留精确路径。
    return normalized.length + han >= 30 && words + Math.floor(han / 3) >= 6
      && !(han === 0 && operators >= 2 && operators * 2 >= words);
  }

  /** 候选评分沿用规范化编辑距离；只裁掉不可能达到候选下限的路径，保留次佳候选比较。 */
  function proseScore(a, b) {
    const length = Math.max(a.length, b.length);
    if (!length || Math.min(a.length, b.length) / length < PROSE_THRESHOLD - PROSE_MARGIN) return 0;
    if (a === b) return 1;
    // 下限含 10 个百分点的候选余量，不能只按 80% 剪枝。向上取整略放宽计算带，
    // 浮点临界值仍由原评分和排序过滤核验；带外路径已有过多插入/删除，不可能成为有效候选。
    const budget = Math.ceil((1 - (PROSE_THRESHOLD - PROSE_MARGIN)) * length), exceeded = budget + 1;
    let previous = new Uint16Array(b.length + 1);
    let current = new Uint16Array(b.length + 1);
    previous.fill(exceeded);
    for (let j = 0; j <= Math.min(b.length, budget); j++) previous[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const from = Math.max(1, i - budget), to = Math.min(b.length, i + budget);
      current[0] = Math.min(i, exceeded);
      if (from > 1) current[from - 1] = exceeded;
      let minimum = current[0];
      for (let j = from; j <= to; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        minimum = Math.min(minimum, current[j]);
      }
      // 两行数组交替使用，必须覆盖右边界，避免下一行读到早先残留的低分路径。
      if (to < b.length) current[to + 1] = exceeded;
      if (minimum > budget) return 0;
      [previous, current] = [current, previous];
    }
    return previous[b.length] > budget ? 0 : 1 - previous[b.length] / length;
  }

  /** 同页按句界建立连续候选，只在本地使用；不向模型发送编号或字符坐标。 */
  function proseCandidates(chars) {
    let raw = "";
    const owners = [];
    chars.forEach((char, index) => {
      const value = String(char.u || "");
      raw += value;
      for (let i = 0; i < value.length; i++) owners.push(index);
      if (char.lineBreakAfter || char.paragraphBreakAfter || char.spaceAfter) { raw += " "; owners.push(-1); }
    });
    const sentences = [];
    let start = 0;
    const push = (end) => {
      let from = start, to = end;
      while (from <= to && (owners[from] < 0 || /\s/.test(raw[from]))) from++;
      while (to >= from && (owners[to] < 0 || /\s/.test(raw[to]))) to--;
      if (from <= to) sentences.push({ start: from, end: to });
      start = end + 1;
    };
    for (let i = 0; i < raw.length; i++) {
      if (!/[.!?。！？]/.test(raw[i])) continue;
      if (raw[i] === ".") {
        if (/\d/.test(raw[i - 1] || "") && /\d/.test(raw[i + 1] || "")) continue;
        const before = raw.slice(Math.max(start, i - 24), i);
        if (/\b[ei]$/i.test(before) && /^[ge]\./i.test(raw.slice(i + 1, i + 3))) continue;
        if (/\b[A-Z]$/.test(before) && /^[A-Z]\./.test(raw.slice(i + 1, i + 3))) continue;
        if (/\b(?:[A-Z]\.)+[A-Z]$/.test(before)) continue;
        if (/\b(?:figs?|eqs?|refs?|secs?|dr|mr|mrs|prof|vs|etc|al|approx|e\.g|i\.e)$/i.test(before)) continue;
      }
      push(i);
    }
    push(raw.length - 1);
    const candidates = [];
    for (let i = 0; i < sentences.length; i++) {
      // 支持连续的一至三句，不拼接不相邻区域；句子匹配不能退化成短前缀命中。
      for (let count = 1; count <= 3 && i + count <= sentences.length; count++) {
        const first = sentences[i], last = sentences[i + count - 1];
        const value = raw.slice(first.start, last.end + 1);
        const text = proseText(value);
        if (text.length > PROSE_MAX_LENGTH) break;
        candidates.push({ from: owners[first.start], to: owners[last.end], text });
      }
    }
    return candidates;
  }

  function highlightProseRange(page, quote, occurrence) {
    const needle = proseText(quote);
    if (!hasProse(quote, needle) || needle.length > PROSE_MAX_LENGTH) {
      throw new Error("该页未找到完整原文；正文过短、过长或为公式，未启用相似匹配");
    }
    if (occurrence !== undefined && occurrence !== 1) throw new Error("指定出现序号需要完整原文匹配，未自动选择相似句");
    const candidates = page.prose || (page.prose = proseCandidates(page.chars));
    const ranked = candidates.map((candidate) => ({ ...candidate, score: proseScore(needle, candidate.text) }))
      .filter((candidate) => candidate.score >= PROSE_THRESHOLD - PROSE_MARGIN)
      .sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);
    const best = ranked[0];
    if (!best || best.score + 1e-9 < PROSE_THRESHOLD) throw new Error("该页未找到完整原文；正文相似度未达到 80%");
    // 包含同一句的不同连续窗口只算一个位置；不相交或仅少量重叠的候选仍参与歧义判断。
    const runner = ranked.find((candidate) => {
      const overlap = Math.max(0, Math.min(best.to, candidate.to) - Math.max(best.from, candidate.from) + 1);
      return overlap / Math.min(best.to - best.from + 1, candidate.to - candidate.from + 1) < 0.8;
    });
    if (runner && best.score - runner.score + 1e-9 < PROSE_MARGIN) throw new Error("同页有多个相近句子，无法确定位置");
    return { from: best.from, to: best.to, approximate: true, similarity: best.score };
  }

  return { score: proseScore, locate: highlightProseRange };
})();
