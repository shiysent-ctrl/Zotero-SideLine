/*
 * Zotero Sideline：提示模板。
 * 功能：内置中文科研阅读模板，并允许用首选项 sideline.prompts（JSON 数组）整体覆盖。
 * 说明：模板只提供指令，不回带原文；原文由 context.js 作为上下文注入。
 */

Sideline.prompts = (function () {
  const BUILTIN = [
    {
      id: "translate",
      name: "翻译",
      text: "把上面的内容翻译成规范的学术中文，只输出译文，保留公式与符号。",
    },
    {
      id: "explain",
      name: "解释",
      text: "面向初次接触该领域的研究者解释上面的内容：先给结论，再给必要的推导与前提，使用 Markdown。",
    },
    {
      id: "summarize",
      name: "概括",
      text: "概括上面的内容，保持准确简洁，可直接用于学术写作引用，不要添加原文没有的结论。",
    },
    {
      id: "abstract-table",
      name: "摘要表",
      text: "根据上述内容填写下表，未提及的项用“-”表示，输出 Markdown 表格：\n\n"
        + "|项目|内容|\n|--|--|\n|研究背景| |\n|研究目的| |\n|研究方法| |\n|研究对象| |\n|研究结论| |\n|创新点| |",
    },
    {
      id: "questions",
      name: "提问题",
      text: "基于上面的内容提出 3-5 个值得研究的问题，并给出每个问题的依据（引用原文并译为中文）。"
        + "输出 Markdown 表格：|序号|问题|为什么提出这个问题|",
    },
    {
      id: "terms",
      name: "术语",
      text: "提取上面内容中的关键术语和符号，逐个给出简明定义，并说明它在本文中的作用。输出 Markdown 表格。",
    },
  ];

  /**
   * 通用回答要求（R04）：有依据、可定位、区分原文与概括。
   * 与首选项 systemPrompt 拼接后作为系统消息；材料里的【第 N 页】标记是页码的唯一依据。
   * 0.6.0 起明确要求"不写开场白、不复述问题"，回答直接给结论（用户反馈模型话太多）。
   */
  const GROUNDING = [
    "【回答要求】",
    "0. 直接回答：不要写「好的」「让我来分析」「根据您提供的材料」之类的开场白，不要复述问题，"
      + "不要用「综上所述」「希望对你有帮助」收尾。第一句就是结论或答案。",
    "1. 只使用「本轮材料」中的内容。材料里没有的信息必须写「材料未提及」，不要用先验知识补写。",
    "2. 引用原文时标注页码，格式为（第 N 页）；页码以材料中的【第 N 页】标记为准。",
    "2a. 普通文献回答中的页码引用应附带可定位的原文短句（8–500 字符，不翻译、不改写）："
      + "格式为（第 N 页；原文：“原文短句”）。短句必须逐字出现在该页材料里；无原文依据时只写页码。"
      + "严格 JSON、翻译全文等有固定格式的输出不增加这种标记。",
    "3. 区分原文与概括：直接引用放在 > 引用块里，你的概括另起一段并以「概括：」开头。",
    "4. 输出简体中文与 Markdown；公式用 $...$ 或 $$...$$。能用一两句说清就不要写成一大段。",
  ].join("\n");

  /**
   * 组装系统消息：用户提示词 + 通用回答要求。
   * @param {object} config 配置
   * @param {object} [options] itemCount 本轮材料里的条目数（>1 时追加「逐条标注来源文献」的要求，R14）
   */
  function systemFor(config, options = {}) {
    const base = String(
      (config && config.systemPrompt) || Sideline.config.str("systemPrompt") || "",
    ).trim();
    const parts = [base || GROUNDING];
    if (base) parts.push(GROUNDING);
    const itemCount = Number(options.itemCount) || 0;
    if (itemCount > 1) {
      parts.push([
        "【跨文献要求】",
        `本轮材料来自 ${itemCount} 篇不同文献。每条结论后面必须用材料里的条目标题标注它来自哪一篇，`,
        "例如「（来自：<条目标题>）」。不要跨文献合并成一条没有出处的结论；",
        "某篇文献没有涉及的问题就写「<条目标题>未涉及」，不要用另一篇的内容代替。",
      ].join("\n"));
    }
    return parts.join("\n\n");
  }

  function normalize(entry, index) {
    if (!entry || typeof entry !== "object") return null;
    const name = String(entry.name || "").trim();
    const text = String(entry.text || "").trim();
    if (!name || !text) return null;
    return { id: String(entry.id || `custom-${index}`), name, text, custom: true };
  }

  /** @returns {object[]} 当前生效的模板列表 */
  function list() {
    const raw = Sideline.config.str("prompts");
    if (raw && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const custom = parsed.map(normalize).filter(Boolean);
          if (custom.length) return custom;
        }
      }
      catch (error) {
        Sideline.util.warn(`模板 JSON 解析失败，改用内置模板：${Sideline.util.message(error)}`);
      }
    }
    return BUILTIN.map((entry) => Object.assign({ custom: false }, entry));
  }

  function byId(id) {
    return list().find((entry) => entry.id === id) || null;
  }

  /** 阅读器弹窗按 id 列表取模板 */
  function subset(ids) {
    const all = list();
    const wanted = String(ids || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const picked = wanted.map((id) => all.find((entry) => entry.id === id)).filter(Boolean);
    return picked.length ? picked : all.slice(0, 3);
  }

  return { list, byId, subset, systemFor, GROUNDING };
})();
