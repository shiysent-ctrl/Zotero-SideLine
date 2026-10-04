/*
 * 自动高亮与回复撤销回归：加载真实业务模块，用原生字符几何、存档与 UI 替身验证安全边界。
 * 输入：run-tests.mjs 的宿主与断言工具；输出：检查结果。没有网络、真实 Zotero 或用户文献写入。
 */
export async function runHighlightTests(h) {
  const { Sideline: s, Zotero: z, items, calls, check, equal, sleep, findAll,
    findByClass, findByText, makeReaderShellDom, buildSidebarShell, makeRegularItem, makeAttachment } = h;
  const prefix = (name) => `auto-highlight: ${name}`;
  async function rejected(name, action, pattern) {
    try { await action(); check(prefix(name), false, "未拒绝"); }
    catch (error) { check(prefix(name), pattern.test(error.message), error.message); }
  }
  let readerSequence = 0;
  const line = (text, x = 10, y = 100, rotation = 0) => Array.from(text).map((u, i) => ({
    u, rotation, rect: rotation === 90 || rotation === 270 ? [x, y + i * 4, x + 10, y + (i + 1) * 4]
      : [x + i * 4, y, x + (i + 1) * 4, y + 10],
    lineBreakAfter: i === Array.from(text).length - 1,
  }));
  function readerFor(chars, pages = 1, body = "重要结论 模型假设 适用限制", labels = ["i", "1", "2"]) {
    const doc = makeReaderShellDom(); buildSidebarShell(doc);
    const pdf = { numPages: pages, getPageData: async () => ({ viewBox: [0, 0, 600, 800], chars }),
      getPageLabels2: async () => labels,
      getPage: async () => ({ view: [0, 0, 600, 800], getViewport: () => ({ width: 600, height: 800 }),
        getTextContent: async () => ({ items: [{ str: body, transform: [10, 0, 0, 10, 10, 100], width: 300, height: 10 }] }) }) };
    const reader = { itemID: 9951, _instanceID: `highlight-fixture-${++readerSequence}`, type: "pdf",
      _iframeWindow: { document: doc, PDFViewerApplication: { pdfDocument: pdf, page: 1 } },
      _internalReader: { toggleSidebar: () => doc.body.classList.add("sidebar-open") } };
    return { reader, pdf };
  }
  const owner = makeRegularItem({ id: 9950, fields: { title: "自动高亮专用替身" } });
  const attachment = makeAttachment({ id: 9951, parentID: owner.id });
  attachment.getAnnotations = () => [...items.values()].filter((item) => item.parentID === attachment.id && item.itemType === "annotation" && !item.deleted);
  const baseChars = [...line("重要结论"), ...line("模型假设", 10, 80), ...line("适用限制", 10, 60)];
  const { reader } = readerFor(baseChars);
  const precise = await s.readertext.highlightRange(reader, 0, "要结");
  // 批次缓存只复用读取/索引，精确与宽松定位的结果必须和独立调用完全相同。
  const cacheFixture = readerFor(baseChars), pageCache = new Map(); let nativeReads = 0;
  const nativeRead = cacheFixture.pdf.getPageData;
  cacheFixture.pdf.getPageData = async (...args) => { nativeReads++; return nativeRead(...args); };
  await s.readertext.highlightText(cacheFixture.reader, 0, { pageCache });
  for (const quote of ["重要结论", "模型假设", "适用限制"]) {
    const cached = await s.readertext.highlightRange(cacheFixture.reader, 0, quote, undefined, { pageCache });
    const plain = await s.readertext.highlightRange(reader, 0, quote);
    equal(prefix(`批次缓存不改变原文及几何：${quote}`), JSON.stringify(cached), JSON.stringify(plain));
  }
  equal(prefix("同页取文和多条定位共用一次字符读取"), nativeReads, 1);
  await s.readertext.highlightRange(cacheFixture.reader, 0, "模型假设", undefined, { pageCache: new Map() });
  equal(prefix("下一批次重新读取页面，不跨操作缓存"), nativeReads, 2);
  const otherPdf = readerFor(line("另一阅读器的正文")); let otherReads = 0;
  const otherRead = otherPdf.pdf.getPageData;
  otherPdf.pdf.getPageData = async (...args) => { otherReads++; return otherRead(...args); };
  const otherRange = await s.readertext.highlightRange(otherPdf.reader, 0, "另一阅读器的正文", undefined, { pageCache });
  check(prefix("相同附件页码但不同 PDF 实例不共用旧字符"), otherReads === 1 && otherRange.text === "另一阅读器的正文");
  const concurrentCache = new Map(); nativeReads = 0;
  await Promise.all(["重要结论", "模型假设"].map((quote) => s.readertext.highlightRange(cacheFixture.reader, 0, quote, undefined, { pageCache: concurrentCache })));
  equal(prefix("同批次并发定位也只读取一次"), nativeReads, 1);
  const failingCache = new Map(); let attempts = 0;
  cacheFixture.pdf.getPageData = async (...args) => { if (++attempts === 1) throw new Error("temporary page failure"); return nativeRead(...args); };
  await rejected("页面读取失败仍报告原始原因", () => s.readertext.highlightRange(cacheFixture.reader, 0, "重要结论", undefined, { pageCache: failingCache }), /temporary/);
  equal(prefix("失败的页面 Promise 不保留在批次缓存"), failingCache.size, 0);
  check(prefix("同批次失败后可重新取得页面"), (await s.readertext.highlightRange(cacheFixture.reader, 0, "重要结论", undefined, { pageCache: failingCache })).text === "重要结论" && attempts === 2);
  cacheFixture.pdf.getPageData = async (...args) => { nativeReads++; return nativeRead(...args); };
  const boundedCache = new Map(); nativeReads = 0;
  for (let page = 0; page < 10; page++) await s.readertext.highlightText(cacheFixture.reader, page, { pageCache: boundedCache });
  equal(prefix("批次字符缓存最多保留八页"), boundedCache.size, 8);
  await s.readertext.highlightText(cacheFixture.reader, 0, { pageCache: boundedCache });
  equal(prefix("淘汰页重新读取"), nativeReads, 11);
  await s.readertext.highlightText(cacheFixture.reader, 9, { pageCache: boundedCache });
  equal(prefix("最近页仍能复用"), nativeReads, 11);
  nativeReads = 0;
  await s.highlights.prepare(cacheFixture.reader, ["重要结论", "模型假设", "适用限制"].map((quote) => ({ pageIndex: 0, quote })));
  equal(prefix("独立 prepare 操作也复用同页字符"), nativeReads, 1);
  equal(prefix("裁剪首尾字符，不扩大到整个文本块"), JSON.stringify(precise.rects), JSON.stringify([[14, 100, 22, 110]]));
  equal(prefix("排序字段带页、实际字符偏移与距页顶坐标"), precise.sortIndex, "00000|000001|00690");
  await rejected("改写句尾不能使用短前缀写入", () => s.readertext.highlightRange(reader, 0, "重要结论但是改写"), /完整原文/);
  const columns = readerFor([...line("左右", 10), ...line("两栏", 350)]).reader;
  const across = await s.readertext.highlightRange(columns, 0, "左右两栏");
  check(prefix("双栏矩形不横跨空白"), across.rects.length === 2 && across.rects.every((r) => r[2] - r[0] < 50));
  const duplicate = readerFor([...line("相同原文"), ...line("相同原文", 10, 60)]).reader;
  await rejected("重复原文无序号拒绝定位", () => s.readertext.highlightRange(duplicate, 0, "相同原文"), /多个/);
  equal(prefix("出现序号选择正确的第二处"), (await s.readertext.highlightRange(duplicate, 0, "相同原文", 2)).rects[0][1], 60);
  await rejected("序号不存在不退回第一处", () => s.readertext.highlightRange(duplicate, 0, "相同原文", 3), /序号/);
  for (const rotation of [0, 90, 180, 270]) {
    const rotated = await s.readertext.highlightRange(readerFor(line("旋转文本", 10, 100, rotation)).reader, 0, "转文");
    check(prefix(`${rotation} 度字符几何有效`), rotated.rects.length === 1 && rotated.rects[0].every(Number.isFinite));
  }
  await rejected("不支持的旋转不冒充可写", () => s.readertext.highlightRange(readerFor(line("倾斜", 10, 100, 45)).reader, 0, "倾斜"), /旋转/);
  const ligatures = readerFor(line("oﬃce")).reader;
  equal(prefix("连字规范化保持原始文本"), (await s.readertext.highlightRange(ligatures, 0, "office")).text, "oﬃce");
  await rejected("连字内部边界不扩大", () => s.readertext.highlightRange(ligatures, 0, "fi"), /连字/);
  const hyphenChars = [...line("nuclear-"), ...line("structure", 10, 80)];
  const hyphenRange = await s.readertext.highlightRange(readerFor(hyphenChars).reader, 0, "nuclearstructure");
  check(prefix("行末断词保留实际原字符与两行范围"), hyphenRange.rects.length === 2 && hyphenRange.text.includes("nuclear-"));
  // 同一句可同时包含复合词连字符与排版断词，必须逐处判断，不能整句一律删除。
  const mixedChars = [...line("two-"), ...line("particle inte-", 10, 80), ...line("grals", 10, 60)];
  const mixedReader = readerFor(mixedChars).reader;
  const mixedRange = await s.readertext.highlightRange(mixedReader, 0, "two-particle integrals");
  check(prefix("同句复合词连字符保留，排版断词合并"), mixedRange.rects.length === 3
    && mixedRange.text === "two- particle inte- grals");
  equal(prefix("混合断词仍映射真实起始字符"), mixedRange.sortIndex, "00000|000000|00690");
  await rejected("混合断词不允许改写完整句尾", () => s.readertext.highlightRange(mixedReader, 0, "two-particle integralx"), /完整原文/);
  await rejected("行内连字符不能按断词删除", () => s.readertext.highlightRange(readerFor(line("two-particle inte-grals")).reader, 0, "two-particle integrals"), /完整原文/);
  await rejected("数学减号不按行末连字符删除", () => s.readertext.highlightRange(readerFor([...line("E−"), ...line("V", 10, 80)]).reader, 0, "EV"), /完整原文/);
  await rejected("长横线不按行末连字符删除", () => s.readertext.highlightRange(readerFor([...line("two–"), ...line("particle", 10, 80)]).reader, 0, "twoparticle"), /完整原文/);
  const mixedDuplicate = readerFor([...mixedChars, ...line("two-particle integrals", 10, 40)]).reader;
  await rejected("完整命中与混合断词命中同时存在时不得静默选第一处", () => s.readertext.highlightRange(mixedDuplicate, 0, "two-particle integrals"), /多个/);
  equal(prefix("混合断词出现序号仍按页面物理顺序"), (await s.readertext.highlightRange(mixedDuplicate, 0, "two-particle integrals", 2)).rects[0][1], 40);
  await rejected("混合断词序号越界仍拒绝定位", () => s.readertext.highlightRange(mixedDuplicate, 0, "two-particle integrals", 3), /序号/);
  const normalizedDuplicate = readerFor([...line("nuclearstructure"), ...hyphenChars.map(c => ({ ...c, rect: c.rect.map((v, i) => i % 2 ? v - 60 : v) }))]).reader;
  await rejected("无断词与去断词的等价原文均计入歧义", () => s.readertext.highlightRange(normalizedDuplicate, 0, "nuclearstructure"), /多个/);
  equal(prefix("引用停在连字符前不扩大范围"), (await s.readertext.highlightRange(readerFor(hyphenChars).reader, 0, "nuclear")).rects[0][2], 38);
  equal(prefix("引用明确包含末尾连字符时保留边界"), (await s.readertext.highlightRange(readerFor(hyphenChars).reader, 0, "nuclear-")).rects[0][2], 42);
  const manyHyphenChars = [], manyHyphenParts = [];
  for (let i = 0; i < 40; i++) {
    manyHyphenChars.push(...line(`word${i}-`, 10, 600 - i * 12), ...line(`part${i} `, 10, 594 - i * 12));
    manyHyphenParts.push(`word${i}${i % 2 ? "" : "-"}part${i}`);
  }
  check(prefix("多处混合断词不枚举所有删除组合"), (await s.readertext.highlightRange(readerFor(manyHyphenChars).reader, 0, manyHyphenParts.join(" "))).rects.length === 80);
  await rejected("无文字层不生成批注", () => s.readertext.highlightRange(readerFor([]).reader, 0, "原文"), /OCR/);
  const missingGeometry = readerFor(baseChars); delete missingGeometry.pdf.getPageData;
  await rejected("没有原生字符 API 不均分字块坐标", () => s.readertext.highlightRange(missingGeometry.reader, 0, "重要结论"), /字符级/);
  const invalidGeometry = readerFor([{ u: "字", rect: [0, 0, NaN, 2] }]);
  await rejected("非有限坐标拒绝写入", () => s.readertext.highlightRange(invalidGeometry.reader, 0, "字"), /坐标/);

  // 正文回退完全使用本测试的合成句子与坐标，不依赖用户论文或私有诊断文件。
  const proseSource = "The measured response remains stable during the entire observation period [12–14].";
  const proseQuote = "The measured response remains stable during the entire observation period.";
  const proseReader = readerFor(line(proseSource)).reader;
  const citationRange = await s.readertext.highlightRange(proseReader, 0, proseQuote);
  check(prefix("省略引用编号后按同页正文定位并保留实际原文"), citationRange.approximate && citationRange.similarity === 1
    && citationRange.text === proseSource && citationRange.pageIndex === 0);
  check(prefix("完整原文仍优先精确匹配"), !(await s.readertext.highlightRange(proseReader, 0, proseSource)).approximate);
  check(prefix("正文比较容忍英文大小写及标点差异"), (await s.readertext.highlightRange(proseReader, 0, proseQuote.toUpperCase().replace("period.", "period!"))).approximate);
  const thresholdSource = "alpha bravo charl delta echoo foxtt golfx hotel india julie.";
  const thresholdReader = readerFor(line(thresholdSource)).reader;
  const atThreshold = await s.readertext.highlightRange(thresholdReader, 0, "zzzzz xxxxx charl delta echoo foxtt golfx hotel india julie.");
  check(prefix("正文相似度恰为80%可接受且范围仍取原文"), Math.abs(atThreshold.similarity - 0.8) < 1e-9 && atThreshold.text === thresholdSource);
  await rejected("正文相似度低于80%拒绝", () => s.readertext.highlightRange(thresholdReader, 0, "zzzzz xxxxx yyyyy delta echoo foxtt golfx hotel india julie."), /80%/);
  const ambiguousProse = readerFor([...line(proseSource), ...line(proseSource.replace("[12–14]", "[20–21]"), 10, 60)]).reader;
  await rejected("去引用编号后多个同页正文命中拒绝", () => s.readertext.highlightRange(ambiguousProse, 0, proseQuote), /多个相近/);
  await rejected("相似回退不按模型序号消除歧义", () => s.readertext.highlightRange(ambiguousProse, 0, proseQuote, 2), /出现序号/);
  const runnerClose = readerFor([...line(proseSource), ...line(proseSource.replace("stable", "steady"), 10, 60)]).reader;
  await rejected("最佳候选与次佳差距不足10个百分点拒绝", () => s.readertext.highlightRange(runnerClose, 0, proseQuote), /多个相近/);
  const runnerFar = readerFor([...line(proseSource), ...line("The observed result varies rapidly across a separate measurement interval.", 10, 60)]).reader;
  check(prefix("同页无接近候选时接受唯一正文匹配"), (await s.readertext.highlightRange(runnerFar, 0, proseQuote)).rects[0][1] === 100);
  const atMargin = readerFor([...line(thresholdSource.replace("julie.", "julie [1].")), ...line(thresholdSource.replace("julie.", "zzzzz [2]."), 10, 60)]).reader;
  check(prefix("最佳与次佳相差恰为10个百分点可接受"), (await s.readertext.highlightRange(atMargin, 0, thresholdSource)).rects[0][1] === 100);
  for (const [name, reader, quote, expected] of [
    ["正文回退", proseReader, proseQuote, citationRange],
    ["80%临界值", thresholdReader, "zzzzz xxxxx charl delta echoo foxtt golfx hotel india julie.", atThreshold],
    ["10个百分点临界值", atMargin, thresholdSource, await s.readertext.highlightRange(atMargin, 0, thresholdSource)]
  ]) {
    const pageCache = new Map();
    await s.readertext.highlightRange(reader, 0, quote, undefined, { pageCache });
    equal(prefix(`缓存后${name}原文、坐标与评分不变`), JSON.stringify(await s.readertext.highlightRange(reader, 0, quote, undefined, { pageCache })), JSON.stringify(expected));
  }
  const ambiguousCache = new Map();
  await s.readertext.highlightText(ambiguousProse, 0, { pageCache: ambiguousCache });
  await rejected("复用页面后仍拒绝多个相近正文", () => s.readertext.highlightRange(ambiguousProse, 0, proseQuote, undefined, { pageCache: ambiguousCache }), /多个相近/);
  await rejected("复用正文候选后仍拒绝多个相近正文", () => s.readertext.highlightRange(ambiguousProse, 0, proseQuote, undefined, { pageCache: ambiguousCache }), /多个相近/);
  await rejected("正文匹配不跨到其他页", () => s.readertext.highlightRange(readerFor(line("An unrelated passage occupies the requested page and contains no relevant result.")).reader, 0, proseQuote), /80%/);
  await rejected("短句不使用宽松匹配", () => s.readertext.highlightRange(readerFor(line("稳定结果 [3].")).reader, 0, "稳定结果。"), /正文过短/);
  await rejected("纯公式不使用宽松匹配", () => s.readertext.highlightRange(readerFor(line("valueAlpha=valueBeta+valueGamma+valueDelta+valueTheta+valueOmega")).reader, 0,
    "valueAlpha=valueBeta+valueGamma+valueDelta+valueTheta+valueSigma"), /为公式/);
  const chineseSource = "实验结果表明该计算方法能够稳定描述不同条件下的变化规律[3–5]。";
  const chineseQuote = "实验结果表明该计算方法能够稳定描述不同条件下的变化规律。";
  const chineseRange = await s.readertext.highlightRange(readerFor(line(chineseSource)).reader, 0, chineseQuote);
  check(prefix("中文正文回退保留原句及引用编号"), chineseRange.approximate && chineseRange.text === chineseSource);
  const orderedSource = "alpha bravo charl delta echoo foxtt golfx hotel india julie.";
  await rejected("相同字符数量但顺序大幅改变不接受", () => s.readertext.highlightRange(readerFor(line(orderedSource)).reader, 0,
    "julie india hotel golfx foxtt echoo delta charl bravo alpha."), /80%/);
  const equationSource = "The estimated response remains finite when the control parameter A = 0.";
  const equationQuote = "The estimated response remains finite when the control parameter A ≠ 0.";
  const equationChars = line(equationSource);
  check(prefix("长正文定位不比较数学运算符表示"), (await s.readertext.highlightRange(readerFor(equationChars).reader, 0, equationQuote)).approximate);
  const equivalentEquations = readerFor([...equationChars, ...line(equationSource.replace("A = 0", "A > 0"), 10, 60)]).reader;
  await rejected("同页不同数学条件正文相同时拒绝宽松选择", () => s.readertext.highlightRange(equivalentEquations, 0, equationQuote), /多个相近/);
  const markChars = line("The estimated response remains finite when the control parameter A ̸= 0.");
  const markIndex = markChars.findIndex(c => c.u === "̸");
  const baseRect = markChars[markIndex + 1].rect;
  markChars[markIndex].rect = [baseRect[0], baseRect[1], baseRect[0], baseRect[3]];
  const markRange = await s.readertext.highlightRange(readerFor(markChars).reader, 0, equationQuote);
  check(prefix("零宽组合斜线复用同位置等号矩形并保留原字符"), markRange.approximate && markRange.text.includes("̸=")
    && markRange.rects.every(r => r[2] > r[0] && r[3] > r[1]));
  const displacedMark = markChars.map(c => ({ ...c, rect: c.rect.slice() }));
  displacedMark[markIndex].rect[0] += 1000; displacedMark[markIndex].rect[2] += 1000;
  await rejected("组合标记无同位置基础字形时拒绝", () => s.readertext.highlightRange(readerFor(displacedMark).reader, 0, equationQuote), /有效面积/);
  await rejected("单独引用零宽标记不能借用范围外字符", () => s.readertext.highlightRange(readerFor(markChars).reader, 0, "̸"), /有效面积/);
  const zeroOrdinary = line(equationSource);
  zeroOrdinary[0].rect[2] = zeroOrdinary[0].rect[0];
  await rejected("普通字符零宽不被当作组合标记放行", () => s.readertext.highlightRange(readerFor(zeroOrdinary).reader, 0, equationQuote), /有效面积/);
  const fuzzyColumns = readerFor([...line("The measured response remains stable", 10), ...line(" during the entire observation period [12–14].", 350)]).reader;
  const fuzzyColumnRange = await s.readertext.highlightRange(fuzzyColumns, 0, proseQuote);
  check(prefix("正文回退仍按真实坐标隔离两栏"), fuzzyColumnRange.approximate && fuzzyColumnRange.rects.length === 2
    && fuzzyColumnRange.rects.every(r => r[2] - r[0] < 200));
  const multiSource = "The measured response remains stable during the entire observation period [12–14]. The observed value changes gradually across the independent measurement interval [15].";
  const multiQuote = "The measured response remains stable during the entire observation period. The observed value changes gradually across the independent measurement interval.";
  check(prefix("连续两句回退不拼接不相邻内容"), (await s.readertext.highlightRange(readerFor(line(multiSource)).reader, 0, multiQuote)).text === multiSource);
  const separatedSource = proseSource + " A completely unrelated discussion introduces a different method and describes additional technical details in a separate analysis. "
    + "The observed value changes gradually across the independent measurement interval [15].";
  await rejected("不把不相邻句子拼成引用", () => s.readertext.highlightRange(readerFor(line(separatedSource)).reader, 0, multiQuote), /80%/);
  const abbreviationSource = "As shown in Fig. 2, the measured response remains stable throughout the entire observation period [4].";
  const abbreviationQuote = "As shown in Fig. 2, the measured response remains stable throughout the entire observation period.";
  check(prefix("常见英文缩写不切断句子候选"), (await s.readertext.highlightRange(readerFor(line(abbreviationSource)).reader, 0, abbreviationQuote)).text === abbreviationSource);
  const examplesSource = "The response remains stable, e.g. during independent observations with a measured coefficient of 0.25 [4].";
  const examplesQuote = "The response remains stable, e.g. during independent observations with a measured coefficient of 0.25.";
  check(prefix("多点缩写及小数点不切断正文候选"), (await s.readertext.highlightRange(readerFor(line(examplesSource)).reader, 0, examplesQuote)).text === examplesSource);
  const longPrefix = "The measured response remains stable during the entire observation period ";
  await rejected("长段的短前缀不能代替完整候选", () => s.readertext.highlightRange(readerFor(line(longPrefix + "although a different method is required to explain the remaining observations and their complicated dependence on the model assumptions.")).reader, 0, proseQuote), /80%/);
  const preparedProse = (await s.highlights.prepare(proseReader, [{ pageIndex: 0, quote: proseQuote, color: "yellow", comment: "正文定位测试" }], { allowedPages: [0] }))[0];
  check(prefix("写入计划用实际原文而不是模型近似引用"), preparedProse.ok && preparedProse.approximate && preparedProse.quote === proseSource && preparedProse.comment === "正文定位测试");
  check(prefix("不同页约束仍在正文回退之前检查"), !(await s.highlights.prepare(proseReader, [{ pageIndex: 0, quote: proseQuote }], { allowedPages: [1] }))[0].ok);
  equal(prefix("空候选数组允许没有重点"), s.highlights.parse("[]").length, 0);
  equal(prefix("中文颜色映射"), s.highlights.colorOf("蓝色"), "#2ea8e5");
  equal(prefix("十六进制颜色规范化"), s.highlights.colorOf("#ABCDEF"), "#abcdef");
  const candidates = s.highlights.parse(JSON.stringify([
    { pageIndex: 0, quote: "重要结论", color: "黄色", comment: "重要性说明" },
    { pageIndex: 0, quote: "模型假设", color: "蓝色", comment: "假设解释" },
    { pageIndex: 0, quote: "适用限制", color: "不存在的颜色", comment: "限制" },
    { pageIndex: 0, quote: "", color: "红色" },
  ]));
  const prepared = await s.highlights.prepare(reader, candidates, { allowedPages: [0] });
  check(prefix("逐项保存颜色、评论和纸面页码"), prepared[0].color === "#ffd400" && prepared[1].color === "#2ea8e5"
    && prepared[1].comment === "假设解释" && prepared[0].pageLabel === "i");
  check(prefix("非法颜色与空原文只影响各自条目"), !prepared[2].ok && /颜色/.test(prepared[2].error) && !prepared[3].ok && prepared.slice(0, 2).every((e) => e.ok));
  check(prefix("超出本段页码不能写入"), !(await s.highlights.prepare(reader, [candidates[0]], { allowedPages: [1] }))[0].ok);
  s.session.clear(owner.id); await s.store.remove(owner.id);
  s.session.append(owner.id, "user", "批次 A");
  const a = { id: "fixture-batch-A", attachmentKey: attachment.key, libraryID: 1 };
  const b = { id: "fixture-batch-B", attachmentKey: attachment.key, libraryID: 1 };
  const aResults = await s.highlights.commit({ attachment, ownerID: owner.id, batchId: a.id, entries: prepared, color: "#aaaaaa" });
  check(prefix("实际创建成功项，失败项没有对象键"), aResults.filter((r) => r.ok).length === 2 && aResults.filter((r) => !r.ok).every((r) => !r.key));
  const aItems = aResults.filter((r) => r.ok).map((r) => items.get(r.id));
  check(prefix("每条原生批注包含相应颜色与评论"), aItems[0].annotationColor === "#ffd400" && aItems[1].annotationColor === "#2ea8e5" && aItems[1].annotationComment === "假设解释");
  const originalSnapshot = s.writes.annotationSnapshot(aItems[0]);
  for (const [label, change] of [
    ["评论空白", { annotationComment: aItems[0].annotationComment + " " }],
    ["颜色", { annotationColor: "#ffffff" }], ["原文", { annotationText: "手动改写" }],
    ["作者", { annotationAuthorName: "用户" }], ["标签", { getTags: () => [{ tag: "手动标签", type: 0 }] }],
    ["修改时间", { getField: () => "2026-10-04 12:00:00" }],
    ["位置", { annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[10, 10, 20, 20]] }) }],
  ]) check(prefix(`${label} 修改可被快照识别`), s.writes.annotationSnapshot({ ...aItems[0], ...change }) !== originalSnapshot);
  const aWrites = (await s.writes.list(owner.id)).filter((w) => w.detail?.batchId === a.id);
  check(prefix("创建日志带稳定对象键、归属和创建快照"), aWrites.length === 2 && aWrites.every((w) => w.detail.state === "created"
    && w.detail.attachmentKey === attachment.key && w.detail.snapshot && w.key));
  const duplicateResult = await s.highlights.commit({ attachment, ownerID: owner.id, batchId: "duplicate", entries: prepared.slice(0, 2) });
  check(prefix("已有同范围批注只跳过，不归属于新批次"), duplicateResult.every((r) => r.skipped) && !(await s.writes.list(owner.id)).some((w) => w.detail?.batchId === "duplicate"));
  const bPrepared = await s.highlights.prepare(reader, [{ pageIndex: 0, quote: "适用限制", comment: "限制说明", color: "红色" }]);
  const bResults = await s.highlights.commit({ attachment, ownerID: owner.id, batchId: b.id, entries: bPrepared });
  aItems[1].annotationComment += " 手动编辑";
  check(prefix("旧单条撤销入口也保护已编辑批注"), !s.writes.canUndo(aWrites.find((w) => w.targetID === aItems[1].id), aItems[1]).ok);
  const undoA = await s.writes.undoBatch(owner.id, a);
  check(prefix("创建 B 后撤销 A：只删未编辑的 A"), undoA.removed === 1 && undoA.edited === 1 && aItems[0].deleted && !aItems[1].deleted && !items.get(bResults[0].id).deleted);
  const repeatedA = await s.writes.undoBatch(owner.id, a);
  check(prefix("重复撤销不再次计数已删除项"), repeatedA.removed === 0 && repeatedA.edited === 1);
  items.get(bResults[0].id).deleted = true;
  const missingB = await s.writes.undoBatch(owner.id, b);
  check(prefix("手动删除单独计入已不存在"), missingB.missing === 1 && missingB.removed === 0);
  const cResult = await s.highlights.commit({ attachment, ownerID: owner.id, batchId: "wrong-owner", entries: prepared.slice(0, 1) });
  const cItem = items.get(cResult[0].id); cItem.parentID = owner.id; cItem.parentItem = owner;
  const wrongOwner = await s.writes.undoBatch(owner.id, { ...a, id: "wrong-owner" });
  check(prefix("附件归属改变时拒绝删除"), wrongOwner.failed === 1 && !cItem.deleted);
  cItem.parentID = attachment.id; cItem.parentItem = attachment;
  const realErase = cItem.eraseTx; cItem.eraseTx = async () => { throw new Error("数据库拒绝"); };
  equal(prefix("单项删除失败计入失败"), (await s.writes.undoBatch(owner.id, { ...a, id: "wrong-owner" })).failed, 1);
  cItem.eraseTx = realErase;
  equal(prefix("失败后可以重试剩余项"), (await s.writes.undoBatch(owner.id, { ...a, id: "wrong-owner" })).removed, 1);
  const flushBefore = s.store.flushItem;
  const saveCount = calls.annotations.length;
  s.store.flushItem = async () => false;
  try {
    const journalFail = await s.highlights.commit({ attachment, ownerID: owner.id, batchId: "disk-fail", entries: prepared.slice(0, 1) });
    check(prefix("写入日志落盘失败则不创建批注"), !journalFail[0].ok && /记录/.test(journalFail[0].error) && calls.annotations.length === saveCount);
  } finally { s.store.flushItem = flushBefore; }
  const saveBefore = z.Annotations.saveFromJSON;
  let stop = false;
  z.Annotations.saveFromJSON = async (...args) => { const item = await saveBefore(...args); stop = true; return item; };
  try {
    const partial = await s.highlights.commit({ attachment, ownerID: owner.id, batchId: "stop-after-one", entries: [prepared[0], bPrepared[0]], shouldStop: () => stop });
    check(prefix("保存中停止后不继续下一条"), partial.length === 1 && partial[0].ok);
    equal(prefix("已创建部分仍可独立撤销"), (await s.writes.undoBatch(owner.id, { ...a, id: "stop-after-one" })).removed, 1);
  } finally { z.Annotations.saveFromJSON = saveBefore; }
  const expectedJSON = s.annotations.buildJSON({ text: "x", position: { pageIndex: 0, rects: [[1, 1, 2, 2]] }, sortIndex: "00000|000000|00000" }, "评论");
  await rejected("空排序字段在保存边界拒绝", () => s.annotations.saveJSON(attachment, { ...expectedJSON, sortIndex: "" }), /排序/);
  await rejected("非法颜色在保存边界拒绝", () => s.annotations.saveJSON(attachment, { ...expectedJSON, color: "purple" }), /颜色/);
  const incomplete = await s.writes.journalAnnotation(owner.id, attachment, "pending", expectedJSON);
  const orphan = await s.annotations.saveJSON(attachment, expectedJSON);
  const pendingUndo = await s.writes.undoBatch(owner.id, { ...a, id: "pending" });
  check(prefix("创建后日志中断不能猜测删除"), pendingUndo.failed === 1 && !orphan.deleted && incomplete.detail.state === "pending");
  let releaseSave, enteredSave;
  const entered = new Promise((resolve) => { enteredSave = resolve; });
  z.Annotations.saveFromJSON = async (...args) => { enteredSave(); await new Promise((resolve) => { releaseSave = resolve; }); return saveBefore(...args); };
  const runningSave = s.highlights.commit({ attachment, ownerID: owner.id, batchId: "concurrent", entries: prepared.slice(0, 1) });
  try {
    await entered;
    await rejected("同附件重入不会重复创建", () => s.highlights.commit({ attachment, ownerID: owner.id, batchId: "reentry", entries: prepared.slice(0, 1) }), /正在保存/);
  } finally { releaseSave(); await runningSave; z.Annotations.saveFromJSON = saveBefore; }
  await s.writes.undoBatch(owner.id, { ...a, id: "concurrent" });

  s.session.append(owner.id, "assistant", "原始回答", { model: "fixture" });
  const ordinary = s.session.list(owner.id).at(-1);
  const historyBefore = JSON.stringify(s.session.history(owner.id));
  const digestBefore = s.agentconversation.historyDigest(s.session.list(owner.id));
  await s.session.updateDisplay(owner.id, ordinary.id, { uiHidden: true });
  equal(prefix("普通隐藏不改变 API 历史"), JSON.stringify(s.session.history(owner.id)), historyBefore);
  equal(prefix("普通隐藏不改变 Agent 历史摘要"), s.agentconversation.historyDigest(s.session.list(owner.id)), digestBefore);
  const metadata = { ...a, status: "partial", created: 2, skipped: 0, failed: 1, errors: [{ page: "i", quote: "错误片段", reason: "未找到完整原文" }], undo: undoA, coverage: "已处理 1 页" };
  s.session.append(owner.id, "assistant", "[{\"quote\":\"内部格式\"}]", { functionId: "highlight", highlightBatch: metadata });
  const linkedReply = s.session.list(owner.id).at(-1);
  await s.store.flushItem(owner.id);
  const savedIDs = s.session.list(owner.id).map((m) => m.id);
  check(prefix("同一时刻追加消息标识不冲突"), new Set(savedIDs).size === savedIDs.length);
  s.session.clear(owner.id); await s.session.restore(owner.id);
  equal(prefix("恢复后消息标识保持一致"), JSON.stringify(s.session.list(owner.id).map((m) => m.id)), JSON.stringify(savedIDs));
  check(prefix("恢复后隐藏状态、批次归属、撤销数量保留"), s.session.list(owner.id).find((m) => m.id === ordinary.id).uiHidden
    && s.session.list(owner.id).find((m) => m.id === linkedReply.id).highlightBatch.undo.edited === 1);
  s.session.append(owner.id, "assistant", "[]", { functionId: "highlight", highlightBatch: { ...metadata, id: "interrupted", status: "running", created: 50, errors: [], undo: null } });
  await s.store.flushItem(owner.id); s.session.clear(owner.id); await s.session.restore(owner.id);
  const interruptedBatch = s.session.list(owner.id).at(-1).highlightBatch;
  check(prefix("重启后中断批次不假装仍在运行"), interruptedBatch.status === "stopped" && interruptedBatch.created === 0 && interruptedBatch.errors[0].reason.includes("未自动继续"));
  const localRaw = JSON.stringify(s.session.history(owner.id));
  s.session.append(owner.id, "assistant", "", { localOnly: true, functionId: "highlight", highlightBatch: metadata });
  equal(prefix("本地失败回执不混入模型历史"), JSON.stringify(s.session.history(owner.id)), localRaw);
  const visibleReceipt = s.highlights.receipt(metadata);
  const searchRows = [{ id: "search-fixture", name: "仅隐藏标题", messages: [
    { role: "assistant", content: "隐藏关键词", uiHidden: true },
    { role: "user", content: "内部模板词", display: "用户可见问题" },
    { role: "assistant", content: '[{"quote":"JSON专用词"}]', functionId: "highlight", highlightBatch: metadata },
    { role: "assistant", content: "隐藏分段词", functionId: "highlight", uiHidden: true },
    { id: "visible-after-hidden", role: "assistant", content: "普通可见词" },
    { role: "assistant", content: '[{"quote":"旧高亮词"}]', functionId: "highlight" },
  ] }];
  const searchBefore = JSON.stringify(searchRows);
  const visibleSearch = (query) => s.history.search(searchRows, query, { visibleOnly: true });
  for (const word of ["隐藏关键词", "JSON专用词", "隐藏分段词", "内部模板词", "旧高亮词"]) {
    equal(prefix(`界面检索不暴露 ${word}`), visibleSearch(word).hits.length, 0);
  }
  equal(prefix("界面检索使用用户可见提问"), visibleSearch("用户可见问题").hits[0].snippet, "用户可见问题");
  const receiptHit = visibleSearch("已创建").hits[0];
  check(prefix("界面检索使用高亮回执并保留原消息序号"), receiptHit.index === 2
    && receiptHit.snippet === visibleReceipt && !receiptHit.snippet.includes("JSON专用词"));
  equal(prefix("过滤隐藏消息不移动后续命中序号"), visibleSearch("普通可见词").hits[0].index, 4);
  equal(prefix("界面命中带稳定消息 ID"), visibleSearch("普通可见词").hits[0].messageId, "visible-after-hidden");
  check(prefix("原始历史检索不新增消息 ID 字段"), !Object.hasOwn(s.history.search(searchRows, "普通可见词").hits[0], "messageId"));
  equal(prefix("无批次的旧高亮只检索可读失败回执"), visibleSearch("自动高亮未完成").hits[0].index, 5);
  const hiddenOnly = [{ id: "hidden-only", name: "只隐藏会话", messages: [searchRows[0].messages[0]] }];
  equal(prefix("全部隐藏的会话不通过标题显示摘要"), s.history.search(hiddenOnly, "只隐藏", { visibleOnly: true }).hits.length, 0);
  equal(prefix("可见标题结果只统计可见消息"), visibleSearch("仅隐藏标题").hits[0].snippet, "会话名匹配「仅隐藏标题」（共 4 条消息）");
  equal(prefix("界面检索不修改原始消息"), JSON.stringify(searchRows), searchBefore);
  check(prefix("原始历史检索接口保留隐藏正文和高亮数据契约"), s.history.search(searchRows, "隐藏关键词").total === 1
    && s.history.search(searchRows, "JSON专用词").total === 1);
  check(prefix("原始 JSON 导出继续保留消息正文"), JSON.stringify(s.history.toJson({ itemKey: "FIXTURE", sessions: searchRows })).includes("JSON专用词"));

  // 基于已发布 1.0.0 的 v3 字段构造旧记录；验证向前升级，不声称旧程序可保存新增字段。
  const legacyV3 = { version: 3, marker: s.storecodec.MARKER, itemID: owner.id, activeId: "legacy-session", updated: 1,
    sessions: [{ id: "legacy-session", name: "旧会话", created: 1, updated: 1,
      messages: [{ role: "user", content: "旧问题" }, { role: "assistant", content: "旧回答" }],
      writes: [{ id: "legacy-write", kind: "note", key: "LEGACY", detail: { parentID: owner.id } }] }] };
  const legacySource = JSON.stringify(legacyV3);
  const upgraded = s.storecodec.sanitizeRecord(legacyV3, owner.id);
  check(prefix("1.0.0 v3 升级保留正文、会话标识和旧写入记录"), upgraded.version === 3
    && upgraded.activeId === "legacy-session" && upgraded.sessions[0].messages.map((m) => m.content).join("|") === "旧问题|旧回答"
    && upgraded.sessions[0].writes[0].id === "legacy-write");
  check(prefix("旧消息补充标识与安全显示默认值"), upgraded.sessions[0].messages.every((m) => m.id && !m.uiHidden && !m.localOnly && m.highlightBatch === null));
  upgraded.sessions[0].messages[1].uiHidden = true;
  upgraded.sessions[0].messages.push({ ...linkedReply, highlightBatch: metadata });
  const roundTrip = s.storecodec.sanitizeRecord(JSON.parse(JSON.stringify(upgraded)), owner.id);
  check(prefix("升级后保存重读保留隐藏状态和批次归属"), roundTrip.sessions[0].messages[1].uiHidden
    && roundTrip.sessions[0].messages[2].highlightBatch.id === metadata.id);
  equal(prefix("升级净化不改写输入的旧记录"), JSON.stringify(legacyV3), legacySource);
  const longBody = "文".repeat(2500);
  const chunked = await s.highlights.documentChunks(readerFor(line(longBody), 2, "另一条取文路径的正文").reader, 1000);
  check(prefix("超预算单页保留页尾且每段不超预算"), chunked.chunks.length > 2 && chunked.chunks.every((c) => c.text.length <= 1000)
    && chunked.chunks.some((c) => c.pages.includes(1)));
  const formulaSource = readerFor(line("PαCM / Pα"), 1, "PCMα / Pα");
  const formulaChunks = await s.highlights.documentChunks(formulaSource.reader, 1000);
  check(prefix("模型材料沿用定位字符顺序，不使用另一条公式取文路径"),
    formulaChunks.chunks[0].text.includes("PαCM / Pα") && !formulaChunks.chunks[0].text.includes("PCMα"));
  const copied = (await s.readertext.highlightText(formulaSource.reader, 0)).trim();
  equal(prefix("按模型材料逐字复制的公式可完整定位"), (await s.readertext.highlightRange(formulaSource.reader, 0, copied)).text, copied);
  const hyphenSource = readerFor(hyphenChars, 1, "nuclear structure");
  const copiedHyphen = await s.readertext.highlightText(hyphenSource.reader, 0);
  check(prefix("模型材料保留行末断词，引用按相同规则定位"), copiedHyphen.includes("nuclear-\nstructure")
    && (await s.readertext.highlightRange(hyphenSource.reader, 0, copiedHyphen)).rects.length === 2);
  const unavailableChunks = await s.highlights.documentChunks(missingGeometry.reader, 1000);
  check(prefix("字符数据不可用时不把另一条正文送给模型"), !unavailableChunks.chunks.length
    && unavailableChunks.errors[0].reason.includes("字符级"));
  equal(prefix("停止读取不会继续取后续页"), (await s.highlights.documentChunks(reader, 1000, () => true)).chunks.length, 0);
  check(prefix("少量失败与撤销回执是普通文字"), s.highlights.receipt(metadata).includes("未找到完整原文") && s.highlights.receipt(metadata).includes("已撤销 1 条") && !s.highlights.receipt(metadata).includes("quote\""));
  const many = s.highlights.receipt({ ...metadata, errors: Array.from({ length: 15 }, () => ({ reason: "需要 OCR" })) });
  check(prefix("集中失败按原因汇总，不列 JSON"), many.includes("15 项：需要 OCR") && many.length < 200);

  // 真正调用专用发送与菜单事件，观察流式期间及最终 DOM；模型仅用确定的桩返回。
  s.session.clear(owner.id); await s.store.remove(owner.id);
  const uiFixture = readerFor(baseChars), state = s.readerside.attach(uiFixture.reader);
  await sleep(10);
  const chatBefore = s.providers.chat, resetBefore = s.agentconversation.reset, discardBefore = s.agents.cancelOwner;
  const prepareBefore = s.highlights.prepare, uiPageDataBefore = uiFixture.pdf.getPageData;
  const documentChunksBefore = s.highlights.documentChunks, materialCaches = [];
  s.highlights.documentChunks = async (...args) => {
    materialCaches.push(args[3].pageCache);
    return documentChunksBefore(...args);
  };
  let uiPageReads = 0, latestPageCache = null;
  uiFixture.pdf.getPageData = async (...args) => { uiPageReads++; return uiPageDataBefore(...args); };
  s.highlights.prepare = async (...args) => {
    latestPageCache = args[2].pageCache;
    return prepareBefore(...args);
  };
  const prefKeys = ["promptHighlight", "persistSessions", "textChannel", "maxContextChars"];
  const oldPrefs = prefKeys.map((key) => z.Prefs.get(`sideline.${key}`));
  let modelCalls = 0, resets = 0;
  const observed = [];
  z.Prefs.set("sideline.promptHighlight", "重要结论黄色，模型假设蓝色。批注用中文解释。");
  z.Prefs.set("sideline.persistSessions", true); z.Prefs.set("sideline.textChannel", "api");
  s.agentconversation.reset = async () => { resets++; };
  s.agents.cancelOwner = () => { resets++; };
  try {
    const putBeforePreflight = z.File.putContentsAsync;
    const beforePreflight = modelCalls;
    z.File.putContentsAsync = async () => { throw new Error("EACCES: preflight write denied"); };
    state.els.textarea.value = "保留这条提示词";
    try {
      await s.readerside.send(state, { functionId: "highlight" });
      equal(prefix("存档写入失败在模型调用前阻止请求"), modelCalls, beforePreflight);
      check(prefix("预检失败直接显示具体原因"), state.els.messagesEl.textContent.includes("EACCES"));
      equal(prefix("预检失败保留输入文本"), state.els.textarea.value, "保留这条提示词");
      check(prefix("预检失败回执不进入 Agent/API 历史"), s.session.list(owner.id).at(-1).localOnly && !s.session.history(owner.id).some((m) => m.content.includes("EACCES")));
    } finally { z.File.putContentsAsync = putBeforePreflight; }
    s.session.clear(owner.id); await s.store.remove(owner.id);
    state.els.textarea.value = "";
    s.providers.chat = async (options) => {
      modelCalls++; observed.push(options);
      const raw = JSON.stringify([{ pageIndex: 0, quote: "重要结论", color: "黄色", comment: "结论的意义" },
        { pageIndex: 0, quote: "定位不到的句子", color: "蓝色", comment: "失败项" }]);
      options.onDelta(raw, raw);
      check(prefix("流式 JSON 不进入气泡"), !state.els.messagesEl.textContent.includes('"pageIndex"'));
      return { content: raw, model: "fixture", provider: "api", usage: { total_tokens: 42 } };
    };
    await s.readerside.send(state, { functionId: "highlight" });
    equal(prefix("完整高亮发送共用取文与定位页面数据"), uiPageReads, 1);
    check(prefix("完整高亮发送结束释放批次页面缓存"), !!latestPageCache && latestPageCache.size === 0);
    const uiReply = s.session.list(owner.id).find((m) => m.highlightBatch);
    check(prefix("专用发送直接入库并报告失败"), uiReply.highlightBatch.created === 1 && uiReply.highlightBatch.failed === 1);
    check(prefix("自定义自然语言与固定契约同时进入请求"), observed[0].messages.some((m) => m.content.includes("重要结论黄色") && m.content.includes("插件必需的输出契约")));
    check(prefix("结果正文不显示原始 JSON 或成功批注正文"), state.els.messagesEl.textContent.includes("已创建 1 条批注")
      && state.els.messagesEl.textContent.includes("未找到完整原文") && !state.els.messagesEl.textContent.includes('"pageIndex"')
      && !state.els.messagesEl.textContent.includes("结论的意义"));
    equal(prefix("无自动修复请求，一次短文只调用一次模型"), modelCalls, 1);
    check(prefix("本批次实际用量与输入估算分开显示"), uiReply.highlightBatch.cost.tokens === 42
      && state.els.messagesEl.textContent.includes("接口报告 42 tokens") && state.els.messagesEl.textContent.includes("输入估算"));
    const bubbles = () => findAll(state.els.messagesEl, (node) => String(node.className).split(" ").includes("sideline-msg-assistant"));
    findByClass(bubbles().at(-1), "sl-msg-more").dispatch("click");
    let menu = findByClass(state.els.panel, "sl-menu");
    check(prefix("菜单有撤销入口，没有查看或批次展开控件"), !!findByText(menu, "撤销此回复")
      && !findByText(menu, "查看批注") && !findByText(menu, "查看失败项") && !findByText(menu, "预览并标记重点"));
    const beforeSaveHistory = JSON.stringify(s.session.history(owner.id));
    const notesBeforeMenu = owner._notes.length;
    findByText(menu, "保存为子笔记").dispatch("click"); await sleep(30);
    const receiptNote = items.get(owner._notes.at(-1));
    check(prefix("高亮回复菜单保存可读回执，不泄露候选 JSON"), owner._notes.length === notesBeforeMenu + 1
      && receiptNote.note.includes("已创建 1 条批注") && !receiptNote.note.includes('"pageIndex"')
      && !receiptNote.note.includes('"quote"'));
    equal(prefix("保存高亮回执不改模型历史"), JSON.stringify(s.session.history(owner.id)), beforeSaveHistory);
    equal(prefix("保存高亮回执不调用模型"), modelCalls, 1);
    findByClass(bubbles().at(-1), "sl-msg-more").dispatch("click"); menu = findByClass(state.els.panel, "sl-menu");
    const beforeUndoRaw = JSON.stringify(s.session.history(owner.id));
    findByText(menu, "撤销此回复").dispatch("click"); await sleep(30);
    check(prefix("撤销状态更新在原气泡"), state.els.messagesEl.textContent.includes("已撤销 1 条") && uiReply.highlightBatch.undo.removed === 1);
    equal(prefix("撤销无模型请求"), modelCalls, 1);
    equal(prefix("撤销无会话重置或取消"), resets, 0);
    equal(prefix("撤销批注不改原始历史"), JSON.stringify(s.session.history(owner.id)), beforeUndoRaw);
    findByClass(bubbles().at(-1), "sl-msg-more").dispatch("click"); menu = findByClass(state.els.panel, "sl-menu");
    check(prefix("成功撤销后禁用重复点击"), findByText(menu, "撤销此回复").disabled);
    state.lastRequest = null;
    s.providers.chat = async (options) => { modelCalls++; observed.push(options); return { content: "正常回答可删除", model: "fixture", provider: "api" }; };
    state.els.textarea.value = "普通问题"; await s.readerside.send(state, {});
    const ordinaryUI = s.session.list(owner.id).at(-1);
    const uiHistory = JSON.stringify(s.session.history(owner.id));
    findByClass(bubbles().at(-1), "sl-msg-more").dispatch("click"); menu = findByClass(state.els.panel, "sl-menu");
    findByText(menu, "撤销此回复").dispatch("click"); await sleep(30);
    check(prefix("普通菜单只隐藏回答，保留问题"), ordinaryUI.uiHidden && !state.els.messagesEl.textContent.includes("正常回答可删除") && state.els.messagesEl.textContent.includes("普通问题"));
    equal(prefix("普通菜单操作保留请求历史"), JSON.stringify(s.session.history(owner.id)), uiHistory);
    equal(prefix("普通菜单也不重置会话"), resets, 0);
    state.els.textarea.value = "正常回答可删除";
    state.els.searchButton.dispatch("click"); await sleep(30);
    check(prefix("侧栏检索入口不显示已隐藏回答"), state.historyHits.length === 0
      && !state.els.historyEl.textContent.includes("正常回答可删除"));
    state.els.textarea.value = "普通问题";
    state.els.searchButton.dispatch("click"); await sleep(30);
    check(prefix("侧栏检索仍显示可见问题"), state.historyHits.length > 0
      && !state.els.historyEl.hidden && state.els.historyEl.textContent.includes("普通问题"));

    // 模拟目标在视窗上方和下方；命中定位必须取自身几何，不能重绘后滚到末尾。
    const hit = state.historyHits[0], messageHost = state.els.messagesEl;
    const mounted = Array.from(messageHost.children);
    const target = mounted.find((node) => node.getAttribute("data-message-id") === hit.messageId);
    check(prefix("侧栏命中 ID 对应实际问题气泡"), !!target && target.textContent.includes("普通问题"));
    const hostRectBefore = messageHost.getBoundingClientRect, targetRectBefore = target.getBoundingClientRect;
    const oldClientTop = messageHost.clientTop, flushBeforeNavigation = s.store.flush;
    const scrollBeforeNavigation = messageHost.scrollTop, navigationModelCalls = modelCalls;
    const rawBeforeNavigation = JSON.stringify(s.session.history(owner.id));
    let navigationFlushes = 0, measuredAfterClose = false;
    try {
      s.store.flush = async () => { navigationFlushes++; };
      messageHost.clientTop = 2;
      messageHost.getBoundingClientRect = () => {
        measuredAfterClose = state.els.historyEl.hidden;
        return { top: measuredAfterClose ? 100 : 350 };
      };
      target.getBoundingClientRect = () => ({ top: -300 });
      messageHost.scrollTop = 900;
      findByClass(findByClass(state.els.historyEl, "sl-hint-item"), "sl-link").dispatch("click");
      equal(prefix("点击命中向上定位到目标气泡顶部，预留 8px"), messageHost.scrollTop, 490);
      check(prefix("关闭检索摘要后才测量位置"), measuredAfterClose && state.els.historyEl.hidden);
      check(prefix("定位保留已挂载气泡，不重绘到下一条或末尾"), mounted.length === messageHost.children.length
        && mounted.every((node, index) => messageHost.children[index] === node));
      check(prefix("定位状态报告实际命中序号"), state.els.statusEl.textContent.includes(`第 ${hit.index + 1} 条`));
      equal(prefix("定位不调用会话保存"), navigationFlushes, 0);
      equal(prefix("定位不调用模型"), modelCalls, navigationModelCalls);
      equal(prefix("定位不修改会话历史"), JSON.stringify(s.session.history(owner.id)), rawBeforeNavigation);

      state.els.searchButton.dispatch("click"); await sleep(30);
      messageHost.scrollTop = 30;
      target.getBoundingClientRect = () => ({ top: 700 });
      findByClass(findByClass(state.els.historyEl, "sl-hint-item"), "sl-link").dispatch("click");
      equal(prefix("视窗下方的命中也按目标顶部定位"), messageHost.scrollTop, 620);

      const navigation = s.readermessages.create({});
      check(prefix("隐藏气泡没有可定位节点"), !navigation.scrollToMessage(state, ordinaryUI.id));
      check(prefix("缺失气泡不回退到相邻消息"), !navigation.scrollToMessage(state, "removed-message"));
      check(prefix("空消息 ID 不匹配无编号节点"), !navigation.scrollToMessage(state, ""));
      equal(prefix("定位失败保留滚动位置"), messageHost.scrollTop, 620);
      messageHost.scrollTop = 0;
      target.getBoundingClientRect = () => ({ top: 100 });
      navigation.scrollToMessage(state, hit.messageId);
      equal(prefix("会话首条定位不产生负滚动位置"), messageHost.scrollTop, 0);

      state.els.searchButton.dispatch("click"); await sleep(30);
      state.historyHits[0].messageId = ordinaryUI.id;
      messageHost.scrollTop = 250;
      findByClass(findByClass(state.els.historyEl, "sl-hint-item"), "sl-link").dispatch("click");
      check(prefix("失效命中提示重新检索且不定位相邻气泡"), state.els.statusEl.textContent.includes("请重新检索")
        && messageHost.scrollTop === 250);

      state.els.searchButton.dispatch("click"); await sleep(30);
      state.historyHits[0].index = -1;
      findByClass(findByClass(state.els.historyEl, "sl-hint-item"), "sl-link").dispatch("click");
      check(prefix("会话名命中不声称定位第零条消息"), state.els.statusEl.textContent.includes("会话名匹配")
        && !state.els.statusEl.textContent.includes("第 0 条") && messageHost.scrollTop === 250);
    } finally {
      s.store.flush = flushBeforeNavigation;
      messageHost.getBoundingClientRect = hostRectBefore; target.getBoundingClientRect = targetRectBefore;
      messageHost.clientTop = oldClientTop; messageHost.scrollTop = scrollBeforeNavigation;
    }

    const historyFindBefore = s.history.find;
    let resolveOldSearch;
    try {
      s.history.find = (itemID, query, options) => query === "延迟旧查询"
        ? new Promise((resolve) => { resolveOldSearch = resolve; }) : historyFindBefore(itemID, query, options);
      state.els.textarea.value = "延迟旧查询"; state.els.searchButton.dispatch("click");
      state.els.textarea.value = "普通问题"; state.els.searchButton.dispatch("click"); await sleep(30);
      resolveOldSearch({ sessionsScanned: 1, total: 1, hits: [{ sessionName: "旧查询", index: 0, snippet: "不应恢复的旧摘要" }] });
      await sleep(30);
      check(prefix("迟到查询不覆盖新检索或恢复旧摘要"), state.els.historyEl.textContent.includes("普通问题")
        && !state.els.historyEl.textContent.includes("不应恢复的旧摘要"));
      state.els.textarea.value = "延迟旧查询"; state.els.searchButton.dispatch("click");
    } finally { s.history.find = historyFindBefore; }
    state.els.textarea.value = "下一轮"; await s.readerside.send(state, {});
    check(prefix("会话更新清除旧检索快照"), state.historyHits.length === 0 && state.els.historyEl.hidden);
    resolveOldSearch({ sessionsScanned: 1, total: 1, hits: [{ sessionName: "旧查询", index: 0, snippet: "不应恢复的旧摘要" }] });
    await sleep(30);
    check(prefix("会话更新后迟到查询不恢复旧结果"), state.historyHits.length === 0 && state.els.historyEl.hidden);
    state.els.textarea.value = ""; state.els.searchButton.dispatch("click");
    check(prefix("空查询使用检索对话文案且结果保持关闭"), state.els.statusEl.textContent.includes("检索对话")
      && state.els.historyEl.hidden);


    check(prefix("下一轮 API 仍带被隐藏回答"), observed.at(-1).messages.some((m) => m.role === "assistant" && m.content === "正常回答可删除"));
    s.providers.chat = async () => { modelCalls++; throw new Error("模型调用失败"); };
    const beforeFailure = modelCalls;
    await s.readerside.send(state, { functionId: "highlight" });
    equal(prefix("模型失败不会触发额外修复"), modelCalls - beforeFailure, 1);
    check(prefix("模型失败仍释放取文阶段缓存"), materialCaches.at(-1).size === 0);
    check(prefix("失败产生 UI 回执且不冒充模型消息"), s.session.list(owner.id).at(-1).localOnly && state.els.messagesEl.textContent.includes("模型调用失败"));
    const chunksBefore = s.highlights.documentChunks;
    const longFixture = readerFor(baseChars, 2), longState = s.readerside.attach(longFixture.reader);
    await sleep(10);
    const chunkInputs = [], chunkBase = modelCalls;
    s.highlights.documentChunks = async () => ({ chunks: [{ text: "第一段", pages: [0] }, { text: "第二段", pages: [1] }], errors: [], pageCount: 2 });
    s.providers.chat = async (options) => {
      modelCalls++; chunkInputs.push(options.messages[0].content);
      const firstChunk = options.messages[0].content.includes("第一段");
      return { content: JSON.stringify([{ pageIndex: firstChunk ? 0 : 1,
        quote: firstChunk ? "重要结论" : chunkInputs.length === 2 ? "缺失句子" : "模型假设" }]), model: "fixture", provider: "api" };
    };
    try {
      await s.readerside.send(longState, { functionId: "highlight" });
      const chunkMessages = s.session.list(owner.id).slice(-4), chunkBatch = chunkMessages.find((m) => m.highlightBatch).highlightBatch;
      check(prefix("长文多次响应只绑定一条结果气泡与同一批次"), chunkMessages.filter((m) => m.highlightBatch).length === 1
        && chunkMessages[2].uiHidden && chunkMessages[3].uiHidden && chunkBatch.created === 1 && chunkBatch.failed === 1,
        JSON.stringify({ chunkBatch, count: chunkInputs.length, status: longState.els.statusEl.textContent }));
      equal(prefix("无实际用量时明确显示未返回"), chunkBatch.cost.reportedCalls, 0);
      await s.readerside.send(longState, { retry: true });
      check(prefix("用户重试只请求失败段，成功段没有重读"), modelCalls - chunkBase === 3 && chunkInputs[2].includes("第二段") && !chunkInputs[2].includes("第一段"), JSON.stringify({ calls: modelCalls - chunkBase, status: longState.els.statusEl.textContent }));
      check(prefix("重试新增单独批次，旧批次关联不被覆盖"), s.session.list(owner.id).filter((m) => m.highlightBatch?.id === chunkBatch.id).length === 1
        && s.session.list(owner.id).at(-1).highlightBatch.id !== chunkBatch.id);
    } finally { s.highlights.documentChunks = chunksBefore; s.readerside.states.delete(longState.key); }
    const beforeStop = modelCalls, beforeStopCache = materialCaches.at(-1);
    s.providers.chat = async () => { modelCalls++; state.aborted = true; return { content: "[]", model: "fixture", provider: "api" }; };
    await s.readerside.send(state, { functionId: "highlight" });
    check(prefix("用户停止也释放本批次缓存且不复用上批次"), materialCaches.at(-1) !== beforeStopCache && materialCaches.at(-1).size === 0);
    equal(prefix("缓存清理不引入停止后的模型请求"), modelCalls - beforeStop, 1);
    z.Prefs.set("sideline.persistSessions", false);
    const beforeDisabled = modelCalls;
    await s.readerside.send(state, { functionId: "highlight" });
    equal(prefix("不能登记持久日志时在模型调用前阻止操作"), modelCalls, beforeDisabled);
  } finally {
    s.providers.chat = chatBefore; s.agentconversation.reset = resetBefore; s.agents.cancelOwner = discardBefore;
    s.highlights.prepare = prepareBefore; uiFixture.pdf.getPageData = uiPageDataBefore;
    s.highlights.documentChunks = documentChunksBefore;
    prefKeys.forEach((key, index) => z.Prefs.set(`sideline.${key}`, oldPrefs[index]));
    s.readerside.states.delete(state.key);
  }
}
