/*
 * Zotero Sideline：全文结构化总结（R06，取代 paper-review 的写入环节）。
 *
 * 功能：把 paper-review 的内置总结提示词搬进插件，对**任意条目**（不再限于 Z-文献暂存）生成结构化总结，
 *       并在同一次模型输出里取回 4–8 个检索标签与 15 字以内短总结；写入前给出完整预览，
 *       经确认后才创建/更新子笔记、追加标签、维护父条目 Extra 里的 `总结:` 行。
 * 输入：条目（普通条目）、附件（PDF）、可选阅读器（用于逐页覆盖统计）。
 * 输出：{note, tags, shortSummary} 与 plan/commit 两个阶段的对象。
 * 依赖：modules/prompts.js（回答要求）、modules/readertext.js（逐页覆盖）、modules/context.js（全文兜底）、
 *       modules/notes.js 的写入思路、Zotero.Items。
 *
 * 与 paper-review / Paper Workflow Bridge 的兼容约定（照抄其实现，务必保持一致）：
 * 1) 子笔记 HTML 根节点带 `data-paper-review-note="structured-summary-v1"`，
 *    桥接插件据此识别「已有 Paper Review 子笔记」，避免两个工具各写一份；
 * 2) 五个固定二级标题：摘要翻译 / 正文引言 / 问题讨论 / 提炼总结 / 作者承认的局限（桥接的兜底识别用）；
 * 3) 标签只追加（`item.addTag(tag, 0)`），按不区分大小写去重，绝不删除既有标签；
 * 4) 短总结写在父条目 `extra` 的 `总结: …` 行；默认保留用户已编辑的旧行，只有用户显式勾选「覆盖」才改；
 * 5) 提示词保留原始 paper-review 文本，基准随项目存放在 `test/fixtures/summary-prompt.md`；
 *    修改时同步 SUMMARY_PROMPT 与测试基准，无需读取项目外的 Skill 文件。
 */

Sideline.summary = (function () {
  const NOTE_MARKER = 'data-paper-review-note="structured-summary-v1"';
  const NOTE_HEADINGS = ["摘要翻译", "正文引言", "问题讨论", "提炼总结", "作者承认的局限"];
  const EXTRA_PATTERN = /^总结\s*[:：]\s*(.*)$/m;
  const GENERIC_TAGS = new Set([
    "论文", "核物理", "核结构", "理论研究", "实验研究", "计算结果", "能谱", "跃迁强度",
  ]);
  const MIN_TAGS = 4;
  const MAX_TAGS = 8;
  const MAX_SUMMARY_CHARS = 15;

  /** 与 test/fixtures/summary-prompt.md 逐字一致的总结提示词（末尾追加机器可读的附加输出要求） */
  const SUMMARY_PROMPT = [
    "你是一位原子核物理领域的研究专家，擅长从专业论文中提取物理图像、数学模型和论证逻辑。你的输出应严谨、结构化，面向同行研究者的后续使用。",
    "",
    "核心约束",
    "- **原文逻辑优先**：所有标题和格式只用于整理内容，具体的问题数量、层级和展开方式必须服从论文实际的论证过程。不得为了填满模板而拆分、合并或重新排列作者的问题。",
    "- **公式要求**：使用latex格式，即使用$符号的格式",
    "- **禁止编造**：如果原文某部分确实没有涉及，请写「原文未涉及」，不要推断或编造。",
    "- **可追溯性**：每个关键结论或解释后，用括号注明原文定位（如：第3节第2段，Fig.4，Eq.(5)），方便回溯。",
    "- 尽量使用原文的内容，减少AI补充内容。",
    "",
    "格式规范",
    "- 输出时，段落间空两行",
    "- 行内符号使用 `$...$`格式；",
    "- 重要物理公式、行间公式使用 `$$...$$`格式；公式前后空一行。",
    "",
    "输出结构",
    "请严格按照以下部分依次输出，不得调换顺序。",
    "---",
    "",
    "## 摘要翻译",
    "直接翻译摘要",
    "",
    "## 正文引言",
    "- **第N段重点**：(以一句中心句概括段落，尽量50字以内)",
    "(分点陈述，引用原文说明哪些内容对应了上面的中心句)",
    "  ",
    "- **第N+1段重点**：(简述重点，尽量50字以内)",
    "（同上）",
    "",
    "- **动机**：最终应该自然给出文献的动机",
    "",
    "## 理论或实验介绍",
    "",
    "(分点陈述；",
    "",
    "实验介绍应优先说明实验方法名称、研究核素、主要观测量和这些观测量服务于何种物理判断。不要展开实验装置细节、数据处理流程或误差分析，除非这些内容直接影响作者后续的物理结论。",
    "",
    "理论介绍应提取模型名称、核心假设、关键公式、主要输入参数和这些理论要素在后文图表或结论中的作用。不得泛泛介绍模型背景；只保留原文中实际用于论证的理论内容。)",
    "  ",
    "## 问题讨论",
    "",
    "（要求：",
    "- 问题的排列顺序必须要按论文的内容顺序组织。",
    "- 问题及相关讨论应全面覆盖论文内容。对于不足以构成独立问题，但包含作者的可能解释、异常现象、参数依赖、保留意见或进一步思考的内容，不要强行改写为问题；应放在与其关系最密切的问题下，标为“补充讨论”。若无法归入任何问题，则收入最后的“补充说明”。",
    "- 若某个问题没有直接对应图表，但原文有连续文字论证，也必须作为独立问题列出。",
    "- 若一张图服务于多个问题，可以在不同问题下重复引用，但每次只解释它对当前问题的作用。）",
    "",
    "### 问题一：[具体对象]中/[对于][具体物理量或机制]，[作者要判断或解释的具体物理命题是什么？]",
    "",
    "（如果涉及具体图表，应先解释图表。图表的组织服从作者的论证单元：若多张图共同回答同一个问题，应放在同一问题下连续讨论，并说明它们之间的递进、对照或相互验证关系；若各图作用不同，则分别使用以下结构。）",
    "",
    "- **Fig.X重点：用30字以内的加粗短句给出描述的对象**",
    "   （分点陈述，原文直译，对该图/表的相关讨论） ",
    "- **Table.X重点：用30字以内的加粗短句给出描述的对象**",
    "   （分点陈述，原文直译，对该图/表的相关讨论）",
    "   ",
    "- **回答问题**：参照原文组织内容，回答问题。",
    "",
    "###  问题二：[用一句话概括作者随后讨论的物理问题]",
    "同上",
    "",
    "### 问题三：[继续按原文讨论顺序排列]",
    "同上。",
    "",
    "### 补充说明",
    "收录无法自然归入前述问题，但包含作者可能的解释、异常现象、参数依赖、保留意见或进一步思考的内容。不要将这些内容强行提升为独立问题。",
    "",
    "### 逻辑梳理",
    "告诉我上面的问题是如何串联起来的。",
    "",
    "## 提炼总结",
    "",
    "(原文的总结或结论部分直译之后 ，分成下面三个部分)",
    "- **a.做了什么**:",
    "- **b.核心论断**:",
    "- **c.物理意义**：",
    "",
    "## 作者承认的局限",
    "摘录作者明确指出的局限或者后续的发展方向。若原文没有，则整个小节省略不写",
    "",
    "---",
    "",
    "附加输出（供工具读取，不要写进笔记正文）",
    "在结构化总结之后另起一段，只输出一个 JSON 对象，不要使用代码围栏，不要写解释：",
    '{"tags": ["4-8 个可直接检索的专业术语"], "short_summary": "不超过 15 个字符的单行短总结"}',
    "",
    "标签规则：只用于快速检索，不表达结论；优先覆盖具体理论/实验方法、具体核素或核区、具体物理现象、具体机制或判据、直接承担主要判断的观测量；",
    "存在更具体术语时省略宽泛上位词（用「手征双重带」而不是「能谱」，用「B(E2)」而不是「跃迁强度」）；",
    "不使用「论文」「核物理」「核结构」「理论研究」「实验研究」「计算结果」这类无法缩小范围的词；只标记核心内容，只在引言或背景里出现的概念不生成标签。",
    "短总结描述论文最值得记住的结果，单行、非空、不超过 15 个字符。",
  ].join("\n");

  // ---- 输出解析与校验 ----

  /** 从模型输出里切出结构化总结与附加 JSON；切不出来时 note 为全文、review 为空 */
  function splitAnswer(text) {
    const source = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    const fence = source.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```\s*$/);
    const candidates = [];
    if (fence) candidates.push({ body: fence[1], start: fence.index });
    const brace = source.lastIndexOf("{");
    const close = source.lastIndexOf("}");
    if (brace >= 0 && close > brace) candidates.push({ body: source.slice(brace, close + 1), start: brace });
    for (const candidate of candidates) {
      if (candidate.body.indexOf("tags") < 0) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(candidate.body);
      }
      catch (error) {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const note = source.slice(0, candidate.start).replace(/\s+$/, "");
      return { note, review: parsed };
    }
    return { note: source.trim(), review: null };
  }

  /**
   * 校验标签与短总结，返回可直接展示的问题列表。
   * 标签的宽泛词过滤与 paper_review.py 的 GENERIC_TAGS 一致。
   */
  function validateReview(review) {
    const problems = [];
    const rawTags = review && Array.isArray(review.tags) ? review.tags : [];
    const tags = [];
    const dropped = [];
    const seen = new Set();
    for (const value of rawTags) {
      const tag = String(value == null ? "" : value).trim();
      if (!tag) continue;
      if (/[\r\n]/.test(tag)) {
        problems.push(`标签「${tag}」包含换行`);
        continue;
      }
      if (GENERIC_TAGS.has(tag)) {
        dropped.push({ tag, reason: "过于宽泛" });
        continue;
      }
      const folded = tag.toLocaleLowerCase();
      if (seen.has(folded)) continue;
      seen.add(folded);
      tags.push(tag);
    }
    let shortSummary = String((review && review.short_summary) || "").trim();
    if (/[\r\n]/.test(shortSummary)) {
      problems.push("短总结必须单行");
      shortSummary = shortSummary.split(/[\r\n]/)[0].trim();
    }
    if ([...shortSummary].length > MAX_SUMMARY_CHARS) {
      problems.push(`短总结超过 ${MAX_SUMMARY_CHARS} 字（实际 ${[...shortSummary].length} 字）`);
      shortSummary = [...shortSummary].slice(0, MAX_SUMMARY_CHARS).join("");
    }
    if (tags.length < MIN_TAGS) problems.push(`标签不足 ${MIN_TAGS} 个（实际 ${tags.length} 个）`);
    if (tags.length > MAX_TAGS) {
      problems.push(`标签超过 ${MAX_TAGS} 个，已截断`);
      tags.length = MAX_TAGS;
    }
    if (!shortSummary) problems.push("缺少短总结");
    return { tags, shortSummary, dropped, problems };
  }

  /** 解析模型回答：note + 校验后的标签与短总结 */
  function parse(text) {
    const split = splitAnswer(text);
    if (!split.note || split.note.length < 200) {
      throw new Error("模型输出太短，不能当作全文结构化总结（可能是被截断或只回答了附加 JSON）");
    }
    const validated = validateReview(split.review);
    return {
      note: split.note,
      tags: validated.tags,
      shortSummary: validated.shortSummary,
      droppedTags: validated.dropped,
      problems: validated.problems,
      hasReview: !!split.review,
    };
  }

  // ---- 笔记与 Extra ----

  /**
   * Markdown → Zotero 笔记 HTML。
   * 与 paper_review.py 的 markdown_to_zotero_html 覆盖同一子集，保证两边产出的笔记结构一致：
   * 根节点带 Paper Review 标记、行内公式包 `<span class="math">`、行间公式进 `<pre class="math">`。
   */
  function toNoteHtml(markdown) {
    const out = [`<div class="zotero-note znv1" ${NOTE_MARKER}>`];
    const paragraph = [];
    let inFence = false;
    let inMath = false;
    const fenceLines = [];
    const mathLines = [];
    let listOpen = false;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${paragraph.map((line) => inline(line)).join("<br>")}</p>`);
      paragraph.length = 0;
    };
    const closeList = () => {
      if (listOpen) {
        out.push("</ul>");
        listOpen = false;
      }
    };

    const lines = String(markdown == null ? "" : markdown).replace(/\r\n?/g, "\n").split("\n");
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");
      const stripped = line.trim();

      if (inMath) {
        mathLines.push(rawLine);
        if (stripped.endsWith("$$")) {
          out.push(`<pre class="math">${escapeHtml(mathLines.join("\n"))}</pre>`);
          mathLines.length = 0;
          inMath = false;
        }
        continue;
      }
      if (stripped.startsWith("```")) {
        flushParagraph();
        closeList();
        if (inFence) {
          out.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
          fenceLines.length = 0;
          inFence = false;
        }
        else inFence = true;
        continue;
      }
      if (inFence) {
        fenceLines.push(rawLine);
        continue;
      }
      if (stripped.startsWith("$$")) {
        flushParagraph();
        closeList();
        if (stripped.length > 4 && stripped.endsWith("$$")) {
          out.push(`<pre class="math">${escapeHtml(stripped)}</pre>`);
        }
        else {
          inMath = true;
          mathLines.push(rawLine);
        }
        continue;
      }
      if (!stripped) {
        flushParagraph();
        continue;
      }
      const heading = stripped.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length;
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      if (/^-{3,}$/.test(stripped)) {
        flushParagraph();
        closeList();
        out.push("<hr>");
        continue;
      }
      const bullet = stripped.match(/^[-*+]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        if (!listOpen) {
          out.push("<ul>");
          listOpen = true;
        }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      const quote = stripped.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        closeList();
        out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }
      closeList();
      paragraph.push(stripped);
    }
    flushParagraph();
    closeList();
    if (inFence && fenceLines.length) {
      out.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
    }
    out.push("</div>");
    return out.join("\n");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** 行内元素：先护住 `$...$` 与 `$$...$$`，再处理粗体/斜体/代码，最后转义其余文本 */
  function inline(value) {
    const tokens = [];
    const stash = (html) => {
      tokens.push(html);
      return `\uFFF0${tokens.length - 1}\uFFF1`;
    };
    let text = String(value == null ? "" : value);
    text = text.replace(/\$\$(.+?)\$\$/g, (match, body) => stash(`<span class="math">$$${escapeHtml(body)}$$</span>`));
    text = text.replace(/(?<!\\)\$([^$]+?)\$(?!\$)/g, (match, body) => stash(`<span class="math">$${escapeHtml(body)}$</span>`));
    text = escapeHtml(text);
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    for (let index = 0; index < tokens.length; index++) {
      text = text.split(`\uFFF0${index}\uFFF1`).join(tokens[index]);
    }
    return text;
  }

  /** 该条目已有的 Paper Review 子笔记（按桥接的同一判据） */
  async function existingNotes(item) {
    const ids = item && typeof item.getNotes === "function" ? item.getNotes() : [];
    const notes = ids.length ? await Zotero.Items.getAsync(ids) : [];
    return notes.filter((note) => {
      if (!note || typeof note.isNote !== "function" || !note.isNote()) return false;
      const html = String(note.getNote ? note.getNote() : "");
      if (html.includes(NOTE_MARKER)) return true;
      return NOTE_HEADINGS.every((heading) => html.includes(`<h2>${heading}</h2>`));
    });
  }

  /** 父条目 Extra 里现有的 `总结:` 行 */
  function existingSummary(item) {
    const extra = String((item && item.getField && item.getField("extra")) || "");
    const match = extra.match(EXTRA_PATTERN);
    return match ? match[1].trim() : "";
  }

  /** 计算 Extra 的新值；默认保留用户已编辑的旧行 */
  function nextExtra(extra, shortSummary, replaceSummary) {
    const original = String(extra == null ? "" : extra);
    const match = original.match(EXTRA_PATTERN);
    if (match && !replaceSummary) {
      return { changed: false, status: "preserved", extra: original, summary: match[1].trim() };
    }
    const line = `总结: ${shortSummary}`;
    if (match) {
      return { changed: true, status: "updated", extra: original.replace(EXTRA_PATTERN, line), summary: shortSummary };
    }
    return {
      changed: true,
      status: "created",
      extra: original ? `${original.replace(/\s+$/, "")}\n${line}` : line,
      summary: shortSummary,
    };
  }

  // ---- 正文覆盖（R06 的「显示页数与遗漏页」） ----

  /**
   * 汇总本次总结读到的正文范围。
   * 有打开的阅读器时走 pdf.js 逐页取文（能报出空白页/失败页）；否则退回 Zotero 全文索引（只有总字数）。
   */
  async function coverageOf(item, options = {}) {
    const attachment = options.attachment || await Sideline.context.resolveAttachment(item);
    const maxChars = options.maxChars > 0 ? options.maxChars : Sideline.config.num("maxContextChars");
    const reader = options.reader || Sideline.readertext.firstReader(attachment ? attachment.id : 0);
    const result = {
      source: "none",
      pageCount: 0,
      pages: [],
      blankPages: [],
      failedPages: [],
      chars: 0,
      totalChars: 0,
      truncated: false,
      notes: [],
      attachmentID: attachment ? attachment.id : 0,
      attachmentTitle: attachment && attachment.getField ? String(attachment.getField("title") || "") : "",
    };
    if (reader) {
      const coverage = await Sideline.readertext.coverage(reader, { maxPages: options.maxPages || 0 });
      result.source = "pdfjs";
      result.pageCount = coverage.pageCount;
      result.pages = coverage.okPages;
      result.blankPages = coverage.emptyPages;
      result.failedPages = coverage.failedPages;
      result.chars = coverage.totalChars;
      result.totalChars = coverage.totalChars;
      if (!coverage.complete) {
        result.notes.push(`只扫描了前 ${coverage.scanned} 页，未覆盖全部 ${coverage.pageCount} 页`);
      }
    }
    else if (attachment) {
      const full = await Sideline.context.fullText(attachment, maxChars);
      result.source = "zotero-fulltext";
      result.chars = full.chars;
      result.totalChars = full.totalChars;
      result.truncated = full.truncated;
      if (full.pages && Number(full.pages.totalPages)) result.pageCount = Number(full.pages.totalPages);
      result.notes.push("没有打开的阅读器，逐页覆盖信息不可用（正文取自 Zotero 全文索引）");
    }
    else {
      result.notes.push("该条目没有可用的 PDF/EPUB 附件");
    }
    for (const pageIndex of result.blankPages) {
      result.notes.push(`第 ${pageIndex + 1} 页没有文字（疑似扫描页或空白页，需要 OCR）`);
    }
    for (const entry of result.failedPages) {
      result.notes.push(`第 ${entry.pageIndex + 1} 页取文失败：${entry.error}`);
    }
    if (result.truncated) {
      result.notes.push(`正文已截断至 ${result.chars} 字（原文约 ${result.totalChars} 字），后文可能未进入本次总结`);
    }
    return result;
  }

  // ---- 预览与写入 ----

  /**
   * 生成写入预览（不修改任何数据）。
   * @param {object} options item 目标条目；review parse() 的结果；coverage coverageOf() 的结果；
   *                         replaceNote 是否覆盖已有 Paper Review 子笔记；replaceSummary 是否覆盖已有短总结
   */
  async function plan(options) {
    const { item } = options;
    if (!item) throw new Error("缺少目标条目");
    const review = options.review || {};
    const noteMarkdown = String(review.note || "");
    if (!noteMarkdown.trim()) throw new Error("总结正文为空");
    const notes = await existingNotes(item);
    const existingTags = typeof item.getTags === "function" ? item.getTags() : [];
    const folded = new Map();
    for (const entry of existingTags) {
      const tag = String((entry && entry.tag) || entry || "").trim();
      if (tag) folded.set(tag.toLocaleLowerCase(), tag);
    }
    const tagsAdded = [];
    const tagsExisting = [];
    for (const tag of review.tags || []) {
      const key = String(tag).toLocaleLowerCase();
      if (folded.has(key)) tagsExisting.push(folded.get(key));
      else {
        tagsAdded.push(String(tag));
        folded.set(key, String(tag));
      }
    }
    const summaryUpdate = nextExtra(
      typeof item.getField === "function" ? item.getField("extra") : "",
      review.shortSummary || "",
      options.replaceSummary === true,
    );
    const html = toNoteHtml(noteMarkdown);
    return {
      itemID: item.id,
      itemKey: item.key,
      title: (typeof item.getField === "function" && item.getField("title")) || "",
      collectionFree: true,
      attachmentID: options.coverage ? options.coverage.attachmentID : 0,
      attachmentTitle: options.coverage ? options.coverage.attachmentTitle : "",
      coverage: options.coverage || null,
      note: {
        markdown: noteMarkdown,
        html,
        chars: [...noteMarkdown].length,
        existingKey: notes.length ? notes[0].key : "",
        action: notes.length ? (options.replaceNote === true ? "update" : "exists") : "create",
        headings: NOTE_HEADINGS.filter((heading) => noteMarkdown.includes(heading)),
      },
      tags: {
        added: tagsAdded,
        existing: tagsExisting,
        dropped: review.droppedTags || [],
      },
      summary: {
        before: summaryUpdate.status === "preserved" ? summaryUpdate.summary : existingSummary(item),
        after: review.shortSummary || "",
        status: summaryUpdate.status,
        changed: summaryUpdate.changed,
        extraBefore: typeof item.getField === "function" ? String(item.getField("extra") || "") : "",
        extraAfter: summaryUpdate.extra,
      },
      problems: (review.problems || []).slice(),
    };
  }

  /**
   * 执行写入（创建/更新子笔记 + 只追加标签 + 维护 `总结:` 行）。
   * 必须先 plan 并把 plan 展示给用户确认——本函数不做二次确认。
   * @returns {Promise<object>} 实际写入结果（含 note key、实际新增标签、短总结状态）
   */
  async function commit(item, review, options = {}) {
    if (!item) throw new Error("缺少目标条目");
    if (options.plan && options.plan.note.action === "exists" && options.replaceNote !== true) {
      throw new Error("该条目已有 Paper Review 子笔记；需要覆盖时请显式选择「覆盖已有子笔记」");
    }
    const planned = options.plan || await plan(Object.assign({}, options, { item, review }));
    const notes = await existingNotes(item);
    const summaryUpdate = nextExtra(
      typeof item.getField === "function" ? item.getField("extra") : "",
      planned.summary.after,
      options.replaceSummary === true,
    );
    let noteItem = null;
    let created = false;
    await Zotero.DB.executeTransaction(async () => {
      if (notes.length) {
        noteItem = notes[0];
        noteItem.setNote(planned.note.html);
      }
      else {
        noteItem = new Zotero.Item("note");
        noteItem.libraryID = item.libraryID;
        noteItem.parentID = item.id;
        noteItem.setNote(planned.note.html);
        created = true;
      }
      await noteItem.save();
      for (const tag of planned.tags.added) item.addTag(tag, 0);
      if (summaryUpdate.changed) item.setField("extra", summaryUpdate.extra);
      if (planned.tags.added.length || summaryUpdate.changed) await item.save();
    });
    Sideline.util.log(`总结已${created ? "创建" : "更新"}子笔记 ${noteItem.key}（条目 ${item.key}）`);
    return {
      itemID: item.id,
      noteID: noteItem.id,
      noteKey: noteItem.key,
      created,
      tagsAdded: planned.tags.added,
      tagsExisting: planned.tags.existing,
      summaryStatus: summaryUpdate.status,
      summary: summaryUpdate.summary,
      summaryExtra: summaryUpdate.extra,
      extraBefore: planned.summary.extraBefore || "",
    };
  }

  /** 判断一段回答看起来是不是结构化总结（决定是否显示「预览并写入总结」），失败不抛错 */
  function looksLikeSummary(text) {
    const source = String(text == null ? "" : text);
    if (source.length < 400) return false;
    if (!source.includes("摘要翻译")) return false;
    return source.includes("提炼总结") || source.includes('"tags"') || source.includes("问题讨论");
  }

  return {
    NOTE_MARKER,
    NOTE_HEADINGS,
    GENERIC_TAGS,
    MIN_TAGS,
    MAX_TAGS,
    MAX_SUMMARY_CHARS,
    SUMMARY_PROMPT,
    splitAnswer,
    validateReview,
    parse,
    looksLikeSummary,
    toNoteHtml,
    inline,
    existingNotes,
    existingSummary,
    nextExtra,
    coverageOf,
    plan,
    commit,
  };
})();
