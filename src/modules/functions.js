/*
 * Zotero Sideline：功能注册表。
 *
 * 功能：维护「功能名 ↔ 提示词 ↔ 作用范围」的映射。界面上只显示功能名（下拉栏里选），
 *       提示词在发送时拼进用户消息，并可在设置里逐条改写（首选项 prompt<功能名>）。
 * 输入/输出：list/byId/promptOf/scopeOf/resolveScope 供阅读器侧栏与划词面板使用；
 *           popupFunctions 只给划词弹窗取「快捷功能」（见下 popup 标记）。
 * 依赖：modules/config.js（首选项）、modules/summary.js（全文总结的提示词来自那里）。
 *
 * 作用范围：
 *   selection  只作用于当前选区（没有选区时自动降级）
 *   page       作用于当前页正文
 *   document   作用于整篇附件正文
 * 降级顺序 selection → page → document → selection（都没有材料时保持原范围并提示）。
 *
 * 只保留用户点名的四个功能，并把「每个功能一个首选项」作为唯一改写入口
 * （原来的 functionPrompts JSON 与 functionButtons 已删除）。
 */

Sideline.functions = (function () {
  const SCOPES = ["selection", "page", "document"];

  const BUILTIN = [
    {
      id: "summarize",
      pref: "promptSummarize",
      name: "全文总结",
      scope: "document",
      // 实际生效的是 summary.js 里那份与 paper-review 逐字一致的提示词（见 promptOf）；
      // 这里保留兜底文本，避免模块加载顺序或单测环境缺模块时拿到空提示词。
      prompt: "请阅读材料中的全文正文，按 paper-review 的结构化要求做总结，并给出 4–8 个检索标签"
        + "与 15 字以内的短总结；材料里没有的内容必须写「原文未涉及」。",
    },
    {
      id: "explain",
      pref: "promptExplain",
      name: "解释选区",
      scope: "selection",
      prompt: "面向初次接触该方向的研究者解释选区内容：先给结论，再给必要的前提与推导步骤。"
        + "公式用 Markdown 数学格式书写。不要引入材料中没有的事实。",
    },
    {
      id: "translate",
      pref: "promptTranslate",
      name: "文本翻译",
      scope: "selection",
      // popup：是否出现在划词弹窗的快捷按钮里。划词弹窗只保留「文本翻译」一个快捷功能，
      // 其余功能只在侧栏功能下拉栏里出现，故不写该标记。
      popup: true,
      prompt: "把选区内容翻译成规范的学术中文，只输出译文；公式、符号与文献编号保持原样。",
    },
    {
      id: "highlight",
      pref: "promptHighlight",
      name: "自动高亮",
      scope: "document",
      prompt: "从材料中挑出值得高亮的原文片段（关键结论、核心公式、重要定义）。"
        + "只输出一个 JSON 数组，不要输出解释或代码围栏；每项形如 "
        + "{\"page\":纸面页码,\"quote\":原文片段,\"reason\":入选理由}，最多 12 项，"
        + "quote 必须是材料中逐字出现的片段。",
    },
  ];

  /** 单项生效提示词：首选项优先，否则用内置；全文总结用 summary.js 的那份 */
  function builtinOf(entry) {
    if (entry.id === "summarize" && Sideline.summary && Sideline.summary.SUMMARY_PROMPT) {
      return Sideline.summary.SUMMARY_PROMPT;
    }
    return entry.prompt;
  }

  /** @returns {object[]} 生效的功能列表 */
  function list() {
    return BUILTIN.map((entry) => {
      const override = String(Sideline.config.str(entry.pref) || "").trim();
      return {
        id: entry.id,
        name: entry.name,
        scope: entry.scope,
        pref: entry.pref,
        builtin: builtinOf(entry),
        prompt: override || builtinOf(entry),
        customized: !!override,
        // 透传弹窗标记（BUILTIN 里没写的按 false 处理），供 popupFunctions 过滤
        popup: entry.popup === true,
      };
    });
  }

  function byId(id) {
    return list().find((entry) => entry.id === String(id)) || null;
  }

  function promptOf(id) {
    const entry = byId(id);
    return entry ? entry.prompt : "";
  }

  function scopeOf(id) {
    const entry = byId(id);
    return entry ? entry.scope : "selection";
  }

  /** 侧栏下拉栏里的功能（顺序即界面顺序） */
  function menu() {
    return list();
  }

  /** 作用范围为选区的功能：侧栏与既有调用方在用，语义保持不变 */
  function selectionFunctions() {
    return list().filter((entry) => entry.scope === "selection");
  }

  /**
   * 划词弹窗里的快捷功能：只取带 popup 标记的功能。
   * 语义上独立于作用范围——selectionFunctions 仍然返回全部选区功能。
   */
  function popupFunctions() {
    return list().filter((entry) => entry.popup === true);
  }

  /**
   * 按当前可用材料决定实际作用范围。
   * @param {string} id 功能 id
   * @param {object} available {selection:boolean, page:boolean, document:boolean}
   * @returns {{scope:string, requested:string, downgraded:boolean, reason:string}}
   */
  function resolveScope(id, available = {}) {
    const requested = scopeOf(id);
    const has = {
      selection: available.selection !== false && !!available.selection,
      page: available.page !== false && !!available.page,
      document: available.document !== false && !!available.document,
    };
    if (has[requested]) {
      return { scope: requested, requested, downgraded: false, reason: "" };
    }
    const order = SCOPES.slice(SCOPES.indexOf(requested) + 1);
    for (const scope of order) {
      if (has[scope]) {
        return {
          scope,
          requested,
          downgraded: true,
          reason: scope === "document"
            ? `没有${requested === "selection" ? "选区" : "当前页"}材料，改用全文正文`
            : "没有选区材料，改用当前页正文",
        };
      }
    }
    for (const scope of SCOPES) {
      if (has[scope]) {
        return { scope, requested, downgraded: true, reason: "所需的材料缺失，改用可用范围" };
      }
    }
    return { scope: requested, requested, downgraded: false, reason: "" };
  }

  function scopeText(scope) {
    if (scope === "selection") return "选区";
    if (scope === "page") return "当前页";
    if (scope === "document") return "全文";
    return scope;
  }

  return {
    SCOPES,
    BUILTIN,
    list,
    byId,
    promptOf,
    scopeOf,
    menu,
    selectionFunctions,
    popupFunctions,
    buttons: menu,
    resolveScope,
    scopeText,
  };
})();
