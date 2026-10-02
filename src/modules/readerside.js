/*
 * Zotero Sideline：PDF 阅读器常驻侧栏对话（R01/R02/R03/R05）。
 *
 * 功能：在 Zotero 阅读器里注入一个与「缩略图/批注/大纲」并列的常驻面板，提供连续对话：
 *       历史消息、流式输出、停止、重试、多行输入、本轮材料清单（可逐项移除）、
 *       快捷功能（功能名可见、提示词隐藏）、成本与运行反馈。
 * 输入：reader（Zotero.Reader._readers 元素）；rootURI 用于取样式。
 * 输出：面板 DOM、会话（经 modules/session.js 落到条目 JSON 附件）。
 * 依赖：readertext.js（按页取文与跳回）、materials.js（材料清单）、functions.js（功能注册表）、
 *       providers.js（模型通道）、session.js/store.js（会话）、prompts.js（系统提示词）。
 *
 * 注入方式（实测依据见 docs/探测结果-第0步.md 4.4）：
 *   Zotero 没有「注册侧栏面板」的钩子，本模块只注册 renderToolbar（另见 reader.js 注册的
 *   renderTextSelectionPopup）。因此面板靠自己往阅读器文档注入：Zotero 的侧栏由 React 渲染，
 *   会随时重建，所以这里
 *   ① 只把节点挂在 React 管理的容器里，样式与显隐由 body 上的自定义类控制；
 *   ② 用 MutationObserver + 去抖检查节点是否被 React 摘掉，摘掉就重新挂载（自愈）。
 */

Sideline.readerside = (function () {
  const PANEL_ID = "sideline-panel";
  const BUTTON_ID = "viewSideline";
  const BODY_CLASS = "sideline-panel-open";
  const TOOLBAR_EVENT = "renderToolbar";
  const REMOUNT_DELAY_MS = 200;
  const INPUT_PLACEHOLDER = "就当前文献提问；Enter 发送，Shift+Enter 换行，可直接粘贴图片";
  let requestSequence = 0;

  // 读不到 content/reader-panel.css 时的兜底：只保证结构可用与可读（正式样式在 CSS 文件里）
  const FALLBACK_CSS = `
#sideline-panel{display:none}
body.sideline-panel-open #sideline-panel{display:flex}
body.sideline-panel-open #sidebarContent{visibility:hidden}
#sideline-panel{position:absolute;top:41px;bottom:0;inset-inline-start:0;width:var(--sidebar-width);
  min-width:0;max-width:100%;z-index:12;flex-direction:column;background:var(--material-sidepane,#f2f2f2);color:var(--fill-primary,#1f2328);font-size:13px;line-height:1.6}
.sl-head,.sl-context-bar,.sl-composer{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--color-border50,rgba(0,0,0,.08))}
.sl-composer{flex-direction:column;align-items:stretch;border-top:1px solid #e3e6ea;border-bottom:none}
.sl-title{font-weight:600}
.sl-totals,.sl-status,.sl-context-summary{font-size:11.5px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sl-context-list{max-height:34%;overflow:auto;padding:4px 10px 8px;display:flex;flex-direction:column;gap:4px}
.sl-context-item{display:flex;gap:6px;padding:4px 6px;border-radius:8px;background:#f4f6f8}
.sl-context-item-main{flex:1 1 auto;min-width:0}
.sl-context-item-label{font-weight:600;font-size:12px}
.sl-context-item-detail{font-size:11.5px;color:#6b7280}
.sl-messages{flex:1 1 auto;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:14px}
.sideline-msg{display:flex;flex-direction:column;gap:4px}
.sideline-msg-user{align-items:flex-end}
.sideline-role{font-size:11px;font-weight:600;color:#6b7280}
.sideline-text{overflow-wrap:anywhere}
.sideline-msg-user .sideline-text{background:#e8f0fe;border-radius:10px;padding:7px 11px;max-width:88%;white-space:pre-wrap}
.sideline-text pre{background:#f4f6f8;border-radius:8px;padding:8px;white-space:pre-wrap}
.sideline-tools{display:flex;justify-content:flex-end;height:20px}
  .sl-msg-more{opacity:.7;background:transparent;border:none;cursor:pointer}
.sl-hint-list{max-height:30%;overflow:auto;padding:6px 10px;display:flex;flex-direction:column;gap:6px}
.sl-hint-item{display:flex;flex-direction:column;gap:2px;padding:4px 6px;border-radius:8px;background:#f4f6f8}
.sl-hint-snippet{font-size:11.5px;color:#6b7280}
  .sl-input-shell{position:relative;width:100%}
  .sl-pending{position:absolute;inset-inline-start:8px;top:7px;display:flex;align-items:center;gap:4px;z-index:1}
.sl-chip{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:rgba(37,99,235,.12);color:#2563eb}
.sl-chip-x,.sl-link{background:none;border:none;color:#2563eb;cursor:pointer;font:inherit}
  .sl-composer textarea{width:100%;min-height:68px;resize:vertical;font:inherit;box-sizing:border-box}
  .sl-input-shell.has-pending textarea{padding-inline-start:var(--sl-pending-offset,120px)}
.sl-composer-row{display:flex;align-items:center;gap:6px}
.sl-btn,.sl-icon-btn,.sl-function{font:inherit;height:40px;border:1px solid #e3e6ea;border-radius:8px;background:#f4f6f8;cursor:pointer}
.sl-btn.sl-primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}
.sl-menu{position:absolute;background:#fff;border:1px solid #e3e6ea;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.18);padding:4px;display:flex;flex-direction:column;z-index:20}
.sl-menu-item{display:flex;flex-direction:column;align-items:flex-start;background:none;border:none;padding:6px 8px;cursor:pointer;font:inherit}
.sl-menu-item:hover{background:#f4f6f8}
.sl-menu-sep{height:1px;background:#e3e6ea;margin:4px 2px}
.sl-menu-detail{font-size:11px;color:#6b7280}
.sideline-highlights{border:1px solid #e3e6ea;border-radius:10px;background:#f4f6f8;padding:8px;display:flex;flex-direction:column;gap:6px}
.sideline-panel-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sideline-material-main{flex:1 1 auto;min-width:0}
.sideline-material-label{font-weight:600;font-size:12px}
.sideline-material-detail,.sideline-hint{font-size:11.5px;color:#6b7280}
.sideline-pageref{color:#2563eb;cursor:pointer;text-decoration:underline dotted}
.sideline-error{color:#dc2626}
.sl-selected-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;margin-bottom:6px;border:1px solid #e3e6ea;border-radius:8px}
.sl-selected-count{margin-inline-end:auto;font-size:12px;font-weight:600;color:#2563eb}
.sideline-msg-user .sideline-text{background:#e8f0fe;border-radius:10px;padding:7px 11px;max-width:88%}
.sideline-msg-selected .sideline-text{box-shadow:0 0 0 2px #2563eb}
#sideline-panel [hidden]{display:none !important}
`;

  /** 阅读器 tabID（或 itemID）→ 面板状态 */
  const states = new Map();
  let cssText = "";
  let cssLoading = null;
  let pluginRootURI = "";
  let toolbarHandler = null;

  function keyOf(reader) {
    if (!reader) return "unknown";
    return String(reader._instanceID || reader.tabID || `item-${reader.itemID}`);
  }

  /**
   * 去掉「整段被代码围栏包住」的外层围栏。
   * 模型（尤其 Codex）常把整篇回答包在 ```markdown 里，直接渲染会显示成一大块源码；
   * 只处理"整段就是一个围栏"的情况，且 JSON/数组内容不动（那边渲染成代码块更合适）。
   */
  function stripOuterFence(text) {
    const source = String(text == null ? "" : text).trim();
    const match = source.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```$/);
    if (!match) return source;
    const body = match[1];
    if (/^\s*[{[]/.test(body)) return source;
    return body;
  }

  /** 阅读器外壳窗口与文档；优先内容侧对象，避免 Xray 包装带来的属性差异 */
  function docOf(reader) {
    let win = null;
    try {
      win = reader && reader._iframeWindow;
    }
    catch (error) {
      win = null;
    }
    if (!win) return null;
    let contentWin = null;
    try {
      contentWin = win.wrappedJSObject || win;
    }
    catch (error) {
      contentWin = win;
    }
    try {
      const doc = contentWin.document;
      if (!doc) return null;
      return { win: contentWin, doc };
    }
    catch (error) {
      return null;
    }
  }

  async function ensureCss() {
    if (cssText) return cssText;
    if (cssLoading) return cssLoading;
    cssLoading = (async () => {
      try {
        const loaded = String(
          await Zotero.File.getResourceAsync(`${pluginRootURI}content/reader-panel.css`) || "",
        );
        cssText = loaded.trim() ? loaded : FALLBACK_CSS;
      }
      catch (error) {
        Sideline.util.warn(`读取阅读器面板样式失败，改用内置样式：${Sideline.util.message(error)}`);
        cssText = FALLBACK_CSS;
      }
      return cssText;
    })();
    return cssLoading;
  }

  function injectStyles(doc) {
    try {
      Sideline.util.ensureMathStyles(doc);
      if (doc.getElementById("sideline-panel-style")) return;
      const style = Sideline.util.element(doc, "style", { attrs: { id: "sideline-panel-style" } });
      style.textContent = cssText || FALLBACK_CSS;
      (doc.head || doc.documentElement).appendChild(style);
    }
    catch (error) {
      Sideline.util.warn(`注入阅读器面板样式失败：${Sideline.util.message(error)}`);
    }
  }

  // ---- 挂载与自愈 ----

  function sidebarContainer(doc) {
    try {
      return doc.getElementById("sidebarContainer");
    }
    catch (error) {
      return null;
    }
  }

  /** 面板是否已经挂好（React 重渲染会把它摘掉，这里据此判断自愈是否必要） */
  function isMounted(state) {
    const panel = state.panel;
    const button = state.button;
    return !!(panel && panel.isConnected && button && button.isConnected);
  }

  /**
   * 构建面板。布局刻意保持"对话优先"：
   *   顶栏一行（标题 + ⋯）；会话累计用量显示在材料条右侧
   *   上下文条一行（N 项材料 · 送入字数 + 展开/收起）——展开才逐项列出
   *   消息区（占满剩余高度）
   *   检索/候选提示区（默认隐藏）
   *   输入区（待执行功能 chip + 输入框 + 状态行 + 功能下拉/「＋」/停止/发送）
   * 能力入口只有三处：功能下拉、一个「＋」菜单、每条回答的「⋯」菜单。
   */
  /**
   * 内联 SVG 图标（0.8.1）。阅读器外壳是 HTML 文档，可以直接写内联 SVG；
   * 统一规格：16 视框、1.6 线宽、圆头、`stroke="currentColor"`（跟随主题），
   * 因此不依赖任何图片资源（`data:` 背景图会被 Zotero 的 CSP 拦）。
   * 极简宿主或解析失败时退回文字符号，按钮功能不受影响。
   */
  const ICON_PATHS = {
    // 会话检索：放大镜
    search: '<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3L14 14"/>',
    // 加入材料：方框 + 右上角加号（与放大镜同一套线条风格）
    add: '<rect x="2.5" y="3.2" width="8.2" height="8.2" rx="2.4"/><path d="M12.6 9v4.6M10.3 11.3h4.6"/>',
  };

  function setIcon(button, name) {
    const body = ICON_PATHS[name] || "";
    if (!body) return;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16"'
      + ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
      + ' stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
    try {
      button.innerHTML = svg;
      if (!button.children || !button.children.length) throw new Error("svg 未生效");
      return;
    }
    catch (error) {
      button.textContent = name === "search" ? "⌕" : (name === "add" ? "＋" : "≡");
    }
  }

  function buildPanel(state) {
    const doc = state.doc;
    const panel = Sideline.util.element(doc, "div", { attrs: { id: PANEL_ID } });
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "Sideline 对话");

    // 顶栏
    const head = Sideline.util.element(doc, "div", { className: "sl-head" });
    const title = Sideline.util.element(doc, "div", { className: "sl-title", text: "Sideline" });
    head.appendChild(title);
    const moreButton = Sideline.util.element(doc, "button", {
      className: "sl-icon-btn",
      text: "⋯",
      attrs: { title: "更多：导出、清空会话" },
    });
    Sideline.util.onActivate(moreButton, () => openSessionMenu(state, moreButton));
    head.appendChild(moreButton);
    // 关闭入口只在工具栏与侧栏的「AI」标签上（顶栏不再放「×」，避免误点）
    const totalsEl = Sideline.util.element(doc, "div", { className: "sl-totals" });
    panel.appendChild(head);

    // 上下文条（材料）
    const contextBar = Sideline.util.element(doc, "div", { className: "sl-context-bar" });
    const contextSummary = Sideline.util.element(doc, "span", { className: "sl-context-summary" });
    contextBar.appendChild(contextSummary);
    // 清空材料放在材料统计行里（用户要求：＋ 菜单不再放"清空材料"）
    const contextClear = Sideline.util.element(doc, "button", {
      className: "sl-link",
      text: "清空",
      attrs: { title: "清空本轮材料" },
    });
    Sideline.util.onActivate(contextClear, () => {
      if (!state.materials.length && !(state.failedPages || []).length) {
        setStatus(state, "本轮还没有材料", false);
        return;
      }
      state.materials.length = 0;
      state.failedPages = [];
      renderMaterials(state);
      setStatus(state, "已清空本轮材料", false);
    });
    contextBar.appendChild(contextClear);
    const contextToggle = Sideline.util.element(doc, "button", {
      className: "sl-link",
      text: "展开",
      attrs: { title: "查看/移除本轮材料" },
    });
    Sideline.util.onActivate(contextToggle, () => {
      state.contextOpen = !state.contextOpen;
      renderMaterials(state);
    });
    contextBar.appendChild(contextToggle);
    // 会话累计用量放在材料条右侧，顶栏保留标题与操作菜单。
    contextBar.appendChild(totalsEl);
    panel.appendChild(contextBar);
    const materialsEl = Sideline.util.element(doc, "div", { className: "sl-context-list" });
    materialsEl.hidden = true;
    panel.appendChild(materialsEl);

    const messagesEl = Sideline.util.element(doc, "div", { className: "sl-messages" });
    panel.appendChild(messagesEl);

    // 会话检索结果 / 跨文献候选
    const historyEl = Sideline.util.element(doc, "div", { className: "sl-hint-list" });
    historyEl.hidden = true;
    panel.appendChild(historyEl);

    // 输入区
    const composer = Sideline.util.element(doc, "div", { className: "sl-composer" });
    // 选中回答后的操作条：只在有选中项时出现
    const selectedBar = Sideline.util.element(doc, "div", { className: "sl-selected-bar" });
    selectedBar.hidden = true;
    const selectedCount = Sideline.util.element(doc, "span", {
      className: "sl-selected-count",
      text: "",
    });
    const selectedNoteButton = Sideline.util.element(doc, "button", {
      className: "sl-btn sl-primary",
      text: "加入子笔记",
    });
    Sideline.util.onActivate(selectedNoteButton, () => {
      void saveSelectionToNote(state);
    });
    const selectedClearButton = Sideline.util.element(doc, "button", {
      className: "sl-btn",
      text: "取消选择",
    });
    Sideline.util.onActivate(selectedClearButton, () => {
      state.selectedTimes.clear();
      renderMessages(state);
      setStatus(state, "已取消选择", false);
    });
    selectedBar.appendChild(selectedCount);
    selectedBar.appendChild(selectedNoteButton);
    selectedBar.appendChild(selectedClearButton);
    composer.appendChild(selectedBar);
    // 待执行功能放在输入槽内部；textarea 用动态左内边距把第一处输入位置让到标签之后。
    const pendingEl = Sideline.util.element(doc, "div", { className: "sl-pending" });
    pendingEl.hidden = true;
    // 状态行放在输入框**上方**（0.8.0 调整：原来在下方，用户要求下移输入框）
    const statusEl = Sideline.util.element(doc, "div", { className: "sl-status" });
    composer.appendChild(statusEl);
    const inputShell = Sideline.util.element(doc, "div", { className: "sl-input-shell" });
    inputShell.appendChild(pendingEl);
    const textarea = Sideline.util.element(doc, "textarea", {
      attrs: { rows: "3", placeholder: INPUT_PLACEHOLDER },
    });
    inputShell.appendChild(textarea);
    composer.appendChild(inputShell);
    // 粘贴图片（0.8.0）：剪贴板里有图就作为图片材料加入（按默认通道处理），纯文本粘贴不受影响
    textarea.addEventListener("paste", (event) => {
      void handleImagePaste(state, event);
    });
    textarea.addEventListener("input", () => syncInputHint(state));
    const actions = Sideline.util.element(doc, "div", { className: "sl-composer-row" });

    // 功能入口：按钮 + 从按钮向上展开的菜单。
    // 原来用原生 <select>，但下拉箭头的方向与样式无法控制，自绘箭头又只能靠 data: 背景图，
    // 而 Zotero 的 CSP 会拦掉 data:（用户实测箭头不显示），所以改成与「＋」一致的按钮 + 菜单。
    const functionButton = Sideline.util.element(doc, "button", {
      className: "sl-function",
      attrs: { title: "选择功能：只显示功能名，提示词在「设置 → Sideline」里改" },
    });
    // 0.8.1：加一个"滑块"图标，和放大镜/加号用同一套线条风格，一眼能区分三个按钮
    functionButton.appendChild(Sideline.util.element(doc, "span", {
      className: "sl-function-label",
      text: "功能",
    }));
    functionButton.appendChild(Sideline.util.element(doc, "span", { className: "sl-function-arrow" }));
    Sideline.util.onActivate(functionButton, () => openFunctionMenu(state, functionButton));
    actions.appendChild(functionButton);

    // 材料入口：一个「＋」菜单（0.8.1 起用"方框 + 加号"图标，与放大镜同风格）
    const addButton = Sideline.util.element(doc, "button", {
      className: "sl-icon-btn sl-add-btn",
      attrs: { title: "加入材料：当前页/全文/文件/检索笔记" },
    });
    setIcon(addButton, "add");
    Sideline.util.onActivate(addButton, () => openMaterialMenu(state, addButton));
    actions.appendChild(addButton);

    // 会话检索：从顶栏「⋯」菜单搬到这里，用放大镜图标（用户要求）
    const searchButton = Sideline.util.element(doc, "button", {
      className: "sl-icon-btn sl-search-btn",
      attrs: { title: "搜索会话：把输入框关键词写进去，再点这里" },
    });
    setIcon(searchButton, "search");
    Sideline.util.onActivate(searchButton, () => void searchHistory(state));
    actions.appendChild(searchButton);

    const stopButton = Sideline.util.element(doc, "button", { className: "sl-btn", text: "停止" });
    stopButton.hidden = true;
    Sideline.util.onActivate(stopButton, () => {
      state.aborted = true;
      Sideline.providers.abort(state.requestKey);
      setStatus(state, "已请求停止", false);
    });
    actions.appendChild(stopButton);
    const sendButton = Sideline.util.element(doc, "button", {
      className: "sl-btn sl-primary",
      text: "发送",
    });
    Sideline.util.onActivate(sendButton, () => {
      void send(state, {});
    });
    actions.appendChild(sendButton);
    composer.appendChild(actions);
    panel.appendChild(composer);

    textarea.addEventListener("keydown", (event) => {
      // Enter 直接发送，Shift+Enter 换行（用户要求；Ctrl/Cmd+Enter 也照旧可用）
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send(state, {});
      }
    });

    state.panel = panel;
    state.els = {
      panel,
      title,
      totalsEl,
      contextBar,
      contextSummary,
      contextToggle,
      contextClear,
      materialsEl,
      messagesEl,
      historyEl,
      pendingEl,
      inputShell,
      selectedBar,
      selectedCount,
      textarea,
      statusEl,
      functionButton,
      searchButton,
      addButton,
      stopButton,
      sendButton,
    };
    return panel;
  }

  // ---- 弹出菜单（面板内唯一的"能力入口"形式） ----

  function closeMenu(state) {
    if (state.menu) {
      try {
        state.menu.remove();
      }
      catch (error) {
        // 面板可能已重建
      }
      state.menu = null;
    }
    if (state.menuCloser && state.doc) {
      try {
        state.doc.removeEventListener("mousedown", state.menuCloser, true);
        state.doc.removeEventListener("pointerdown", state.menuCloser, true);
      }
      catch (error) {
        // 忽略
      }
    }
    if (state.doc) {
      try {
        if (state.menuKeyCloser) state.doc.removeEventListener("keydown", state.menuKeyCloser, true);
        if (state.menuScrollCloser) state.doc.removeEventListener("scroll", state.menuScrollCloser, true);
      }
      catch (error) {
        // 忽略
      }
    }
    state.menuCloser = null;
    state.menuKeyCloser = null;
    state.menuScrollCloser = null;
  }

  /**
   * 在面板内打开一个菜单。
   * @param {object[]} items {label, detail?, separator?, disabled?, run?}
   * @param {object} options {placement:"head"|"composer"|"anchor", anchor}
   */
  function openMenu(state, items, options = {}) {
    closeMenu(state);
    if (!state.els || !state.els.panel) return null;
    const doc = state.doc;
    const menu = Sideline.util.element(doc, "div", { className: "sl-menu" });
    let hasItem = false;
    for (const item of items || []) {
      if (!item) continue;
      if (item.separator) {
        if (hasItem) menu.appendChild(Sideline.util.element(doc, "div", { className: "sl-menu-sep" }));
        continue;
      }
      const button = Sideline.util.element(doc, "button", { className: "sl-menu-item" });
      button.appendChild(Sideline.util.element(doc, "span", { text: item.label }));
      if (item.detail) {
        button.appendChild(Sideline.util.element(doc, "span", { className: "sl-menu-detail", text: item.detail }));
      }
      if (item.disabled || typeof item.run !== "function") {
        button.disabled = true;
      }
      else {
        Sideline.util.onActivate(button, () => {
          closeMenu(state);
          try {
            item.run();
          }
          catch (error) {
            Sideline.util.error(error);
          }
        });
      }
      menu.appendChild(button);
      hasItem = true;
    }
    if (!hasItem) return null;
    state.els.panel.appendChild(menu);
    state.menu = menu;

    // 定位（0.8.0 重做）：**贴着触发按钮向上展开**——菜单从面板底部弹出，向下会盖住内容。
    // 上方放不下才退到按钮下方；左右夹紧在面板宽度内。菜单尺寸用真实/估测高度算。
    const placement = options.placement || "composer";
    const style = ["position:absolute", "z-index:20", "min-width:190px", "max-width:260px"];
    const panelEl = state.els.panel;
    let anchored = false;
    if (options.anchor && typeof options.anchor.getBoundingClientRect === "function"
      && typeof panelEl.getBoundingClientRect === "function") {
      try {
        const a = options.anchor.getBoundingClientRect();
        const p = panelEl.getBoundingClientRect();
        const size = measureMenu(menu, options);
        const gap = 4;
        // 向上：按钮顶边 - 菜单高度；放不下再落到按钮下方
        let top = a.top - p.top - size.height - gap;
        if (top < gap) top = a.bottom - p.top + gap;
        top = Math.max(gap, Math.min(top, Math.max(gap, p.height - size.height - gap)));
        const left = Math.max(gap, Math.min(a.left - p.left, Math.max(gap, p.width - size.width - gap)));
        style.push(`top:${Math.round(top)}px`, `left:${Math.round(left)}px`);
        anchored = true;
      }
      catch (error) {
        anchored = false;
      }
    }
    if (!anchored) {
      // 拿不到几何信息时给个保守位置：顶栏菜单贴顶、输入区菜单贴底
      if (placement === "head") style.push("top:34px", "inset-inline-end:6px");
      else style.push("bottom:52px", "inset-inline-end:6px");
    }
    menu.setAttribute("style", style.join(";"));

    // 点菜单以外的任何位置都收起（面板内外都算），另外 Esc 与面板滚动也收起
    const closer = (event) => {
      const target = event && event.target;
      let inside = false;
      try {
        inside = typeof menu.contains === "function" && target ? menu.contains(target) : false;
      }
      catch (error) {
        inside = false;
      }
      if (inside) return;
      closeMenu(state);
    };
    const onKey = (event) => {
      if (event && event.key === "Escape") closeMenu(state);
    };
    const onScroll = () => closeMenu(state);
    state.menuCloser = closer;
    state.menuKeyCloser = onKey;
    state.menuScrollCloser = onScroll;
    try {
      doc.addEventListener("mousedown", closer, true);
      doc.addEventListener("pointerdown", closer, true);
      doc.addEventListener("keydown", onKey, true);
      doc.addEventListener("scroll", onScroll, true);
    }
    catch (error) {
      state.menuCloser = null;
    }
    return menu;
  }

  /** 估测菜单尺寸：优先量真实高度，量不到按条数估（每项约 30px + 内边距） */
  function measureMenu(menu, options) {
    let width = 220;
    let height = 0;
    try {
      if (typeof menu.getBoundingClientRect === "function") {
        const box = menu.getBoundingClientRect();
        if (box && Number(box.height) > 0) {
          return { width: Number(box.width) || width, height: Number(box.height) };
        }
      }
    }
    catch (error) {
      // 量不到就估
    }
    const count = (menu.children || []).length || (options && options.estimateItems) || 4;
    height = Math.min(320, 16 + count * 30);
    return { width, height };
  }

  /** 选中/取消待执行功能（对话里只显示功能名） */
  function syncInputHint(state) {
    const textarea = state.els && state.els.textarea;
    if (!textarea) return;
    const hasInput = !!String(textarea.value || "") || !!state.pendingFunction;
    textarea.setAttribute("placeholder", hasInput ? "" : INPUT_PLACEHOLDER);
  }

  function setPendingFunction(state, id) {
    state.pendingFunction = id ? String(id) : "";
    const host = state.els && state.els.pendingEl;
    const shell = state.els && state.els.inputShell;
    if (!host) return;
    host.replaceChildren();
    if (!state.pendingFunction) {
      host.hidden = true;
      if (shell) {
        shell.classList.remove("has-pending");
        shell.style.removeProperty("--sl-pending-offset");
      }
      syncInputHint(state);
      return;
    }
    const fn = Sideline.functions.byId(state.pendingFunction);
    const label = `${fn ? fn.name : state.pendingFunction}（${fn ? Sideline.functions.scopeText(fn.scope) : "?"}）`;
    host.hidden = false;
    host.appendChild(Sideline.util.element(state.doc, "span", {
      className: "sl-chip",
      text: label,
    }));
    const drop = Sideline.util.element(state.doc, "button", {
      className: "sl-chip-x",
      text: "×",
      attrs: { title: "取消该功能" },
    });
    Sideline.util.onActivate(drop, () => {
      // 0.8.1：取消功能不再往状态行写「已取消功能」（用户觉得看不懂），直接清掉即可
      setPendingFunction(state, "");
    });
    host.appendChild(drop);
    if (shell) {
      shell.classList.add("has-pending");
      let width = 0;
      try {
        const rect = host.getBoundingClientRect && host.getBoundingClientRect();
        width = rect && Number(rect.width);
      }
      catch (error) {
        width = 0;
      }
      // 假宿主量不到尺寸时按字符数估；真机取实际宽度。上限防止窄侧栏没有输入余量。
      const offset = Math.min(210, Math.max(78, (width || (label.length * 7 + 34)) + 8));
      shell.style.setProperty("--sl-pending-offset", `${offset}px`);
    }
    if (state.els.textarea) {
      syncInputHint(state);
      try {
        state.els.textarea.focus();
      }
      catch (error) {
        // 忽略
      }
    }
  }

  /** 输入区「功能」菜单：锚在按钮上、向上展开；选中后成为本轮待执行功能 */
  function openFunctionMenu(state, anchor) {
    const items = Sideline.functions.menu().map((fn) => ({
      label: fn.name,
      detail: `${Sideline.functions.scopeText(fn.scope)}`
        + `${fn.customized ? "｜已在设置里改写过提示词" : ""}`,
      run: () => setPendingFunction(state, fn.id),
    }));
    openMenu(state, items, { placement: "composer", anchor, estimateItems: items.length });
  }

  /**
   * 输入框粘贴图片（0.8.0）：剪贴板里有图片就转成 image 材料（按默认通道处理）；
   * 没有图片时什么都不做，纯文本粘贴保持默认行为。
   */
  function clipboardImageFile(event) {
    const data = event && event.clipboardData;
    if (!data) return null;
    let items = [];
    try {
      items = data.items ? Array.from(data.items) : [];
    }
    catch (error) {
      items = [];
    }
    for (const item of items) {
      if (item && typeof item.type === "string" && item.type.startsWith("image/")
        && typeof item.getAsFile === "function") {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
    let files = [];
    try {
      files = data.files ? Array.from(data.files) : [];
    }
    catch (error) {
      files = [];
    }
    return files.find((file) => file && typeof file.type === "string"
      && file.type.startsWith("image/")) || null;
  }

  /** FileReader 在插件沙箱里不一定有，退回主窗口的实现 */
  function fileReaderClass() {
    if (typeof FileReader !== "undefined") return FileReader;
    try {
      const win = Sideline.util.mainWindows()[0];
      if (win && win.FileReader) return win.FileReader;
    }
    catch (error) {
      // 拿不到就返回 null
    }
    return null;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      const Reader = fileReaderClass();
      if (!Reader) {
        resolve("");
        return;
      }
      try {
        const reader = new Reader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve("");
        reader.readAsDataURL(file);
      }
      catch (error) {
        resolve("");
      }
    });
  }

  async function handleImagePaste(state, event) {
    const file = clipboardImageFile(event);
    if (!file) return;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl) {
        setStatus(state, "读取剪贴板图片失败（拿不到 FileReader）", true);
        return;
      }
      const sizeKb = Math.max(1, Math.round((Number(file.size) || dataUrl.length) / 1024));
      const material = Sideline.materials.fromImage({
        name: `粘贴的图片（第 ${(state.materials.filter((entry) => entry.kind === "image").length || 0) + 1} 张）`,
        dataUrl,
        text: "以下是用户从剪贴板粘贴的图片，请据此回答。",
        detail: `${file.type || "image"}｜约 ${sizeKb} KB`,
        source: `paste:${state.ownerID}:${Date.now()}`,
      });
      addMaterial(state, material);
      const imageChannel = Sideline.providers.current() === "agent" ? "当前 Agent" : "视觉 API";
      setStatus(state, `已把剪贴板里的图片加入材料；图片将交给${imageChannel}处理`, false);
    }
    catch (error) {
      setStatus(state, `粘贴图片失败：${Sideline.util.message(error)}`, true);
    }
  }

  /** 顶栏「⋯」：会话导出与清空（「搜索会话」已移到输入区的放大镜按钮） */
  function openSessionMenu(state, anchor) {
    openMenu(state, [
      { label: "导出为 Markdown", run: () => void exportHistory(state, "markdown") },
      { label: "导出为 JSON", run: () => void exportHistory(state, "json") },
      { label: "清空本会话", disabled: state.busy, run: () => void clearSession(state) },
      { separator: true },
      { label: state.totalsText || "本会话：暂无调用", disabled: true },
    ], { placement: "head", anchor });
  }

  /**
   * 输入区「＋」：材料入口（0.8.0 精简）。
   * 用户明确删除：加入其它文献、圈选页面区域、加入图像标注…、把输入当作材料、清空材料
   * （清空材料移到材料统计行的「清空」；图片改走输入框粘贴）。
   */
  function openMaterialMenu(state, anchor) {
    openMenu(state, [
      { label: "加入当前页", run: () => void withStatus(state, "加入当前页", () => addCurrentPage(state)) },
      { label: "加入全文", run: () => void withStatus(state, "加入全文", () => addDocument(state)) },
      { separator: true },
      { label: "选择文件…", detail: "文本或图片", run: () => void addPickedFiles(state) },
      {
        label: "检索笔记",
        detail: "全库；同行空格=同时，换行=任一",
        run: () => void searchNotes(state),
      },
    ], { placement: "composer", anchor });
  }

  /** 每条回答的「⋯」：把原来的一排按钮收进菜单 */
  function editQuestion(state, message) {
    const list = Sideline.session.list(state.ownerID);
    let answerIndex = list.indexOf(message);
    if (answerIndex < 0) {
      answerIndex = list.findIndex((entry) => entry.role === "assistant"
        && entry.time === message.time && entry.content === message.content);
    }
    let userIndex = answerIndex - 1;
    while (userIndex >= 0 && list[userIndex].role !== "user") userIndex--;
    if (userIndex < 0) {
      setStatus(state, "没有找到这条回答对应的原问题", true);
      return;
    }
    const user = list[userIndex];
    state.editing = { from: userIndex };
    state.els.textarea.value = user.question === undefined ? String(user.content || "") : String(user.question || "");
    setPendingFunction(state, message.functionId || user.functionId || "");
    setStatus(state, "正在修改原问题；重新发送后会替换该问答及其后的分支", false, {
      label: "取消修改",
      run: () => {
        state.editing = null;
        setPendingFunction(state, "");
        setStatus(state, "已取消修改，原对话保持不变", false);
      },
    });
    try {
      state.els.textarea.focus();
      const end = state.els.textarea.value.length;
      if (typeof state.els.textarea.setSelectionRange === "function") {
        state.els.textarea.setSelectionRange(end, end);
      }
    }
    catch (error) {
      // 聚焦失败不影响编辑状态
    }
  }

  function openAnswerMenu(state, message, node, anchor) {
    const items = [];
    if (Sideline.highlights.looksLikeCandidates(message.content)) {
      items.push({ label: "预览并标记重点", run: () => void openHighlightPanel(state, message, node.wrapper) });
    }
    if (state.lastRequest) {
      items.push({
        label: "重试上一次",
        run: () => void send(state, Object.assign({}, state.lastRequest, { retry: true })),
      });
    }
    items.push({
      label: "修改提问",
      detail: "重发后替换原问答",
      run: () => editQuestion(state, message),
    });
    items.push({ separator: true });
    items.push({
      label: "复制回答",
      run: () => setStatus(state, Sideline.util.copyText(message.content) ? "已复制回答" : "复制失败", false),
    });
    openMenu(state, items, { placement: "anchor", anchor });
  }

  /** 统一的"执行 + 报错"包装，避免每个菜单项都写一遍 try/catch */
  async function withStatus(state, label, task) {
    try {
      await task();
    }
    catch (error) {
      setStatus(state, `${label}失败：${Sideline.util.message(error)}`, true);
    }
  }

  async function clearSession(state) {
    if (state.busy) return;
    state.resetting = true;
    setBusy(state, true);
    // 先清除可见消息；生成入口保持禁用，直到对应 Agent 的删除与新建完成。
    Sideline.session.clear(state.ownerID);
    state.lastRequest = null;
    state.editing = null;
    state.selectedTimes.clear();
    renderMessages(state);
    refreshTotals(state);
    setStatus(state, "已清空消息；正在重置 Agent 会话…", false);
    try {
      const reset = Sideline.agentconversation.reset(state.ownerID);
      // 两边独立清理并等待全部结束；任一失败都不能提前释放发送按钮。
      const settled = await Promise.allSettled([reset, Sideline.store.remove(state.ownerID).then(() => Sideline.store.flush())]);
      const failure = settled.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      setStatus(state, "已清空本会话；Agent 将从新会话开始", false);
    } catch (error) { setStatus(state, `消息已清空，但重置失败：${Sideline.util.message(error)}`, true); }
    finally { state.resetting = false; setBusy(state, false); }
  }

  function buildButton(state) {
    const doc = state.doc;
    const button = Sideline.util.element(doc, "button", {
      className: "toolbar-button sideline-panel-toggle",
      attrs: { id: BUTTON_ID, title: "Sideline 对话", role: "tab", "aria-selected": "false" },
    });
    button.appendChild(Sideline.util.element(doc, "span", { text: "AI" }));
    Sideline.util.onActivate(button, () => activate(state, !state.open));
    state.button = button;
    return button;
  }

  /** 把面板与工具栏按钮挂到 Zotero 的侧栏容器上；容器不存在时返回 false */
  function mount(state) {
    const container = sidebarContainer(state.doc);
    if (!container) return false;
    try {
      if (!state.panel || !state.panel.isConnected) {
        buildPanel(state);
        container.appendChild(state.panel);
      }
      const toolbar = container.querySelector(".sidebar-toolbar .start") || container.querySelector(".sidebar-toolbar");
      if (toolbar && (!state.button || !state.button.isConnected)) {
        buildButton(state);
        toolbar.appendChild(state.button);
      }
      // Zotero 的三个视图按钮点了就把我们的面板让出去
      for (const id of ["viewThumbnail", "viewAnnotations", "viewOutline"]) {
        const node = state.doc.getElementById(id);
        if (!node || node.dataset.sidelineBound === "1") continue;
        node.dataset.sidelineBound = "1";
        node.addEventListener("click", () => setPanelVisible(state, false));
      }
    }
    catch (error) {
      Sideline.util.warn(`挂载阅读器面板失败：${Sideline.util.message(error)}`);
      return false;
    }
    return true;
  }

  function setPanelVisible(state, visible) {
    state.open = !!visible;
    try {
      state.doc.body.classList.toggle(BODY_CLASS, state.open);
      if (state.button) {
        state.button.classList.toggle("active", state.open);
        state.button.setAttribute("aria-selected", state.open ? "true" : "false");
      }
      if (state.open) {
        applyPanelWidth(state);
        if (state.els && state.els.textarea) state.els.textarea.focus();
      }
      else {
        restorePanelWidth(state);
      }
    }
    catch (error) {
      Sideline.util.warn(`切换阅读器面板显示失败：${Sideline.util.message(error)}`);
    }
  }

  /** 让 Zotero 的侧栏宽度适配对话面板 */
  function applyPanelWidth(state) {
    const width = Sideline.config.num("readerPanelWidth");
    if (!(width > 0)) return;
    const root = state.doc.documentElement;
    if (!root) return;
    if (state.previousWidth === undefined) {
      state.previousWidth = root.style.getPropertyValue("--sidebar-width") || "";
    }
    root.style.setProperty("--sidebar-width", `${width}px`);
  }

  function restorePanelWidth(state) {
    if (state.previousWidth === undefined) return;
    const root = state.doc.documentElement;
    if (!root) return;
    if (state.previousWidth) root.style.setProperty("--sidebar-width", state.previousWidth);
    else root.style.removeProperty("--sidebar-width");
    state.previousWidth = undefined;
  }

  /** 打开/收起面板；打开时确保 Zotero 侧栏本身是展开的 */
  function activate(state, visible) {
    if (visible) {
      ensureSidebarOpen(state);
      mount(state);
    }
    setPanelVisible(state, visible);
    if (visible) {
      void (async () => {
        await Sideline.store.flush();
        renderMessages(state);

      })();
    }
  }

  function ensureSidebarOpen(state) {
    try {
      const reader = state.reader;
      const internal = reader && reader._internalReader;
      const open = state.doc.body.classList.contains("sidebar-open");
      if (!open && internal && typeof internal.toggleSidebar === "function") {
        internal.toggleSidebar(true);
      }
    }
    catch (error) {
      Sideline.util.warn(`展开 Zotero 侧栏失败：${Sideline.util.message(error)}`);
    }
  }

  /** 自愈：React 重渲染会摘掉注入的节点，发现掉线就重挂 */
  function startSelfHeal(state) {
    if (state.observer || !state.doc.body) return;
    const schedule = () => {
      if (state.remountTimer) return;
      const tools = Sideline.util.windowTools();
      if (!tools.setTimeout) return;
      state.remountTimer = tools.setTimeout(() => {
        state.remountTimer = null;
        try {
          if (isMounted(state)) return;
          if (!mount(state)) return;
          if (state.open) setPanelVisible(state, true);
          renderMaterials(state);
          renderMessages(state);

        }
        catch (error) {
          Sideline.util.warn(`阅读器面板自愈失败：${Sideline.util.message(error)}`);
        }
      }, REMOUNT_DELAY_MS);
    };
    try {
      const Observer = state.win.MutationObserver
        || (state.win.wrappedJSObject && state.win.wrappedJSObject.MutationObserver);
      if (Observer) {
        state.observer = new Observer(schedule);
        state.observer.observe(state.doc.body, { childList: true, subtree: true });
      }
    }
    catch (error) {
      Sideline.util.warn(`无法监听阅读器 DOM 变化，面板自愈降级：${Sideline.util.message(error)}`);
    }
    // 兜底：即使拿不到 MutationObserver，也在渲染事件时检查一次（见 register）
    state.scheduleRemount = schedule;
  }

  function stopSelfHeal(state) {
    try {
      if (state.observer) state.observer.disconnect();
    }
    catch (error) {
      // 忽略
    }
    state.observer = null;
  }

  function disposeState(state) {
    if (!state) return;
    stopSelfHeal(state);
    try {
      const tools = Sideline.util.windowTools();
      if (state.remountTimer && tools.clearTimeout) tools.clearTimeout(state.remountTimer);
    }
    catch (error) {
      // 忽略
    }
    state.remountTimer = null;
    try {
      if (state.panel && state.panel.parentNode) state.panel.parentNode.removeChild(state.panel);
      if (state.button && state.button.parentNode) state.button.parentNode.removeChild(state.button);
      if (state.doc && state.doc.body) state.doc.body.classList.remove(BODY_CLASS);
    }
    catch (error) {
      // 阅读器文档可能已经销毁
    }
  }

  // ---- 状态对象 ----

  function stateOf(reader) {
    const key = keyOf(reader);
    const resolved = docOf(reader);
    if (states.has(key)) {
      const existing = states.get(key);
      if (resolved && existing.doc === resolved.doc) {
        existing.win = resolved.win;
        return existing;
      }
      // Zotero 可能复用 tabID，但换掉阅读器 iframe；旧 doc 上的节点与 observer 必须丢弃。
      disposeState(existing);
      states.delete(key);
    }
    const state = {
      key,
      reader,
      win: resolved ? resolved.win : null,
      doc: resolved ? resolved.doc : null,
      ownerID: 0,
      attachmentID: 0,
      materials: [],
      failedPages: [],
      open: false,
      busy: false,
      aborted: false,
      requestKey: null,
      panel: null,
      button: null,
      els: null,
      observer: null,
      remountTimer: null,
      scheduleRemount: null,
      previousWidth: undefined,
      lastRequest: null,
      totalsText: "",
      pendingFunction: "",
      editing: null,
      contextOpen: false,
      // 被点选中的回答（键由 msgKey 生成）：选中后可一次性写入子笔记
      selectedTimes: new Set(),
      menu: null,
      menuCloser: null,
    };
    states.set(key, state);
    return state;
  }

  /** 建立（或找回）某个阅读器的面板；由 bootstrap 在启动时对已打开的阅读器调用 */
  function attach(reader, options = {}) {
    try {
      if (!reader) return null;
      const type = String(reader.type || "pdf");
      if (type !== "pdf" && type !== "epub") return null;
      const state = stateOf(reader);
      if (!state.doc) return null;
      const owner = Sideline.store.ownerOf(reader.itemID);
      state.ownerID = owner ? owner.item.id : reader.itemID;
      state.attachmentID = reader.itemID;
      void (async () => {
        await ensureCss();
        injectStyles(state.doc);
        if (!mount(state)) return;
        startSelfHeal(state);
        await Sideline.store.flush();
        // 把当前会话的消息读回内存（附件里已有的对话在重启后要能显示）
        try {
          await Sideline.session.restore(state.ownerID);
        }
        catch (error) {
          Sideline.util.warn(`恢复会话失败：${Sideline.util.message(error)}`);
        }
        renderMaterials(state);
        renderMessages(state);

        refreshTotals(state);
        if (options.open) activate(state, true);
      })();
      return state;
    }
    catch (error) {
      Sideline.util.error(error);
      return null;
    }
  }

  /** 对当前所有已打开的阅读器挂载面板 */
  function attachAll(options = {}) {
    const readers = (Zotero.Reader && Zotero.Reader._readers) || [];
    const out = [];
    const live = new Set(readers.map((reader) => keyOf(reader)));
    for (const [key, state] of states.entries()) {
      if (live.has(key)) continue;
      disposeState(state);
      states.delete(key);
    }
    for (const reader of readers) {
      const state = attach(reader, options);
      if (state) out.push(state.key);
    }
    return out;
  }

  // ---- 材料 ----

  function addMaterial(state, material) {
    const duplicate = Sideline.materials.duplicateOf(state.materials, material);
    if (duplicate) {
      setStatus(state, `「${material.label}」已在材料清单中`, false);
      return duplicate;
    }
    Sideline.materials.add(state.materials, material);
    renderMaterials(state);
    setStatus(state, `已加入「${material.label}」（${Sideline.materials.summaryText(state.materials)}）`, false);
    return material;
  }

  function currentPageIndex(state) {
    try {
      const target = Sideline.readertext.resolve(state.reader);
      const page = target ? Number(target.app.page) : 0;
      if (page > 0) return page - 1;
    }
    catch (error) {
      // 落到 0
    }
    return 0;
  }

  async function addCurrentPage(state) {
    const index = currentPageIndex(state);
    const record = await Sideline.readertext.page(state.reader, index);
    if (record.state !== "ok") {
      throw new Error(record.error || (record.state === "empty" ? "该页没有可提取的文字（可能是扫描页）" : "取文失败"));
    }
    const material = Sideline.materials.fromPage({
      text: Sideline.readertext.joinSpans(record.spans),
      pageIndex: record.pageIndex,
      pageLabel: record.label,
    });
    return addMaterial(state, material);
  }

  async function addDocument(state) {
    setStatus(state, "正在按页读取正文…", false);
    const result = await Sideline.readertext.documentText(state.reader, {
      maxChars: Sideline.config.num("maxContextChars"),
    });
    if (!result.chars) {
      const attachment = await Sideline.context.resolveAttachment(
        Zotero.Items.get(state.ownerID) || state.reader.itemID,
      );
      const fallback = attachment ? await Sideline.context.fullText(attachment, Sideline.config.num("maxContextChars")) : null;
      if (!fallback || !fallback.text) {
        throw new Error("没有取到正文；若是扫描版 PDF，需要先做 OCR");
      }
      return addMaterial(state, Sideline.materials.fromDocument({
        text: fallback.text,
        truncated: fallback.truncated,
        detail: `${fallback.chars}/${fallback.totalChars} 字（取自 Zotero 全文索引，无逐页标记）`,
      }));
    }
    const material = Sideline.materials.fromDocument({
      text: result.text,
      pages: result.pages,
      pageCount: result.pageCount,
      emptyPages: result.emptyPages,
      failedPages: result.failedPages,
      truncated: result.truncated,
    });
    state.failedPages = result.failedPages || [];
    addMaterial(state, material);
    if (result.emptyPages.length) {
      setStatus(state, `正文已加入；第 ${result.emptyPages.map((v) => v + 1).join(",")} 页没有文字（可能是扫描页，需 OCR）`, false);
    }
    else if (result.failedPages.length) {
      setStatus(state, `正文已加入；第 ${result.failedPages.map((v) => v.pageIndex + 1).join(",")} 页取文失败，可重试`, true);
    }
    return material;
  }

  /** 供划词面板调用：把选区加入材料清单（不自动发送） */
  function addSelection(reader, payload = {}) {
    const state = attach(reader, { open: true });
    if (!state) return null;
    const material = Sideline.materials.fromSelection({
      text: String(payload.text || ""),
      pageIndex: Number.isFinite(payload.pageIndex) ? payload.pageIndex : null,
      pageLabel: payload.pageLabel || "",
      rects: payload.rects || null,
      detail: payload.rects ? "选区原文（可跳回）" : "选区原文（无坐标，无法跳回）",
    });
    addMaterial(state, material);
    activate(state, true);
    return material;
  }

  // ---- 渲染 ----

  /**
   * 上下文条：默认只显示一行摘要（N 项材料 · 送入字数），展开才逐项列出。
   * 每项显示名称、字数/页范围与失败原因，右侧「×」移除；不占用常驻高度。
   */
  function renderMaterials(state) {
    const assembled = Sideline.materials.assemble(state.materials, {
      maxChars: Sideline.config.num("maxContextChars"),
    });
    const summaryEl = state.els && state.els.contextSummary;
    if (summaryEl) {
      if (!state.materials.length) {
        summaryEl.textContent = "未加入材料（用「＋」加入页面/全文，或在 PDF 里划词）";
      }
      else {
        const parts = [`${state.materials.length} 项材料`, `送入 ${assembled.chars} 字`];
        if (assembled.truncated) parts.push("有截断");
        if (assembled.dropped.length) parts.push(`${assembled.dropped.length} 项未送入`);
        summaryEl.textContent = parts.join(" · ");
        summaryEl.setAttribute("title", state.materials.map((entry) => Sideline.materials.describe(entry)).join("\n"));
      }
    }
    if (state.els && state.els.contextToggle) {
      state.els.contextToggle.textContent = state.contextOpen ? "收起" : "展开";
      state.els.contextToggle.hidden = !state.materials.length;
    }
    // 「清空」与「展开/收起」同一条显示规则：没有材料就不显示（用户 0.8.1 要求）
    if (state.els && state.els.contextClear) {
      state.els.contextClear.hidden = !state.materials.length;
    }
    const el = state.els && state.els.materialsEl;
    if (!el) return;
    el.hidden = !(state.contextOpen && state.materials.length);
    if (el.hidden) return;
    el.replaceChildren();
    const byId = new Map(assembled.items.map((item) => [item.id, item]));
    for (const material of state.materials) {
      const info = byId.get(material.id);
      const row = Sideline.util.element(state.doc, "div", {
        className: `sl-context-item${material.state === "error" ? " sl-context-item-error" : ""}`,
      });
      const main = Sideline.util.element(state.doc, "div", { className: "sl-context-item-main" });
      main.appendChild(Sideline.util.element(state.doc, "div", {
        className: "sl-context-item-label",
        text: material.label,
      }));
      const detail = info && info.reason ? info.reason : material.detail;
      if (detail) {
        main.appendChild(Sideline.util.element(state.doc, "div", {
          className: "sl-context-item-detail",
          text: detail,
        }));
      }
      if (material.pageIndex !== null && material.pageIndex !== undefined && material.pageIndex >= 0) {
        const jump = Sideline.util.element(state.doc, "button", {
          className: "sl-link",
          text: `第 ${material.pageLabel || (material.pageIndex + 1)} 页`,
          attrs: { title: "跳到该页并高亮范围" },
        });
        Sideline.util.onActivate(jump, () => {
          void Sideline.readertext.jump(state.reader, {
            pageIndex: material.pageIndex,
            rects: material.rects || null,
          });
        });
        main.appendChild(jump);
      }
      row.appendChild(main);
      if (material.removable) {
        const remove = Sideline.util.element(state.doc, "button", {
          className: "sl-chip-x",
          text: "×",
          attrs: { title: "移除该材料" },
        });
        Sideline.util.onActivate(remove, () => {
          Sideline.materials.remove(state.materials, material.id);
          renderMaterials(state);
        });
        row.appendChild(remove);
      }
      el.appendChild(row);
    }

    // 失败页可重试（R10）
    const failedPages = state.failedPages || [];
    if (failedPages.length) {
      const row = Sideline.util.element(state.doc, "div", { className: "sl-context-item sl-context-item-error" });
      const main = Sideline.util.element(state.doc, "div", { className: "sl-context-item-main" });
      main.appendChild(Sideline.util.element(state.doc, "div", {
        className: "sl-context-item-detail",
        text: `第 ${failedPages.map((entry) => entry.pageIndex + 1).join("、")} 页取文失败`,
      }));
      row.appendChild(main);
      const retry = Sideline.util.element(state.doc, "button", { className: "sl-link", text: "重试" });
      Sideline.util.onActivate(retry, () => {
        void retryFailedPages(state);
      });
      row.appendChild(retry);
      el.appendChild(row);
    }

    if (state.materials.some((entry) => entry.kind === "image")) {
      el.appendChild(Sideline.util.element(state.doc, "div", {
        className: "sl-context-item-detail",
        text: Sideline.providers.current() === "agent" ? "图片交给当前 Agent" : "图片使用视觉 API",
      }));
    }
  }

  function scrollToEnd(state) {
    const el = state.els && state.els.messagesEl;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function bubble(state, message) {
    const wrapper = Sideline.util.element(state.doc, "div", {
      className: `sideline-msg sideline-msg-${message.role === "user" ? "user" : "assistant"}`,
    });
    wrapper.appendChild(Sideline.util.element(state.doc, "div", {
      className: "sideline-role",
      text: message.role === "user" ? "我" : `Sideline${message.model ? `（${message.model}）` : ""}`,
    }));
    const body = Sideline.util.element(state.doc, "div", { className: "sideline-text" });
    if (message.role === "assistant") {
      // 回答里的页码引用变成可点击锚点（R04）：优先用消息里存下的引用，重启后在无 PDF 时也能渲染
      const map = Sideline.citations.mapFromCitations(message.citations);
      body.innerHTML = Sideline.citations.render(message.content || "", map);
      attachPageRefs(state, body, message);
      attachQuoteLocators(state, body, message);
    }
    else body.textContent = message.display || message.content || "";
    wrapper.appendChild(body);
    for (const citation of message.citations || []) {
      // 页码引用已经在正文里变成锚点，不再重复显示成卡片
      if (!citation.label || citation.kind === "pageref") continue;
      wrapper.appendChild(citationCard(state, citation));
    }
    const tools = Sideline.util.element(state.doc, "div", { className: "sideline-tools" });
    wrapper.appendChild(tools);
    return { wrapper, body, tools };
  }

  /** 给回答里的页码锚点绑定「跳回该页」 */
  function attachPageRefs(state, body, message) {
    let nodes = [];
    try {
      nodes = Array.from(body.querySelectorAll("[data-sideline-page]"));
    }
    catch (error) {
      nodes = [];
    }
    for (const node of nodes) {
      const pageIndex = Number(node.getAttribute("data-sideline-page"));
      if (!Number.isFinite(pageIndex) || pageIndex < 0) continue;
      const jump = () => void locatePageReference(state, node, pageIndex);
      node.addEventListener("click", (event) => { event.stopPropagation(); jump(); });
      node.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); jump(); }
      });

    }
    if (nodes.length && !message.pageRefCount) {
      message.pageRefCount = nodes.length;
    }
  }

  /** 页码引用优先匹配原文锚点；转述或旧回答无法匹配时，只执行明确的页级导航。 */
  async function locatePageReference(state, node, pageIndex) {
    setStatus(state, "正在定位原文…", false);
    try {
      let text = node.getAttribute("data-sideline-quote") || "";
      if (!text && typeof node.closest === "function") {
        const paragraph = node.closest("p, li, blockquote");
        if (paragraph) text = String(paragraph.textContent || "").replace(Sideline.citations.PAGE_PATTERN, "").trim();
      }
      const located = text.length >= 8 ? await Sideline.readertext.locate(state.reader,
        { pageIndex, text, exact: true }) : { found: false };
      const range = located.found ? await Sideline.readertext.rectsForRange(state.reader, pageIndex, located.from, located.to) : null;
      const result = await Sideline.readertext.jump(state.reader, { pageIndex, rects: range && range.rects });
      const label = await Sideline.readertext.labelOf(state.reader, pageIndex);
      setStatus(state, !result.ok ? `跳转失败：${result.reason}`
        : located.found && result.flashed ? `已定位第 ${label} 页原文，已短暂高亮`
        : located.found ? `已匹配第 ${label} 页原文；${result.reason || "未能显示高亮"}`
        : `已跳到第 ${label} 页；未找到匹配原文，仅定位到页码`, !result.ok);
    } catch (error) { setStatus(state, `定位失败：${Sideline.util.message(error)}`, true); }
  }

  /** 回答里的 > 引用块可点击定位原文（R04：可定位到段落） */
  function attachQuoteLocators(state, body, message) {
    const quotes = Sideline.citations.quotes(message.content || "");
    if (!quotes.length) return;
    let nodes = [];
    try {
      nodes = Array.from(body.querySelectorAll("blockquote"));
    }
    catch (error) {
      nodes = [];
    }
    nodes.forEach((node, index) => {
      const quote = quotes[index];
      if (!quote) return;
      node.setAttribute("title", "点击定位这段原文");
      node.classList.add("sideline-quote-link");
      node.addEventListener("click", () => {
        void locateQuote(state, quote);
      });
    });
  }

  /** 在引用块标注的页码（或当前页起逐页）里反查这段原文并跳过去 */
  async function locateQuote(state, quote) {
    const labels = await Sideline.readertext.pageLabels(state.reader);
    const wanted = quote.labels
      .map((label) => Sideline.citations.labelToIndex(label, labels))
      .filter((index) => index !== null && index >= 0);
    const total = Sideline.readertext.pageCount(state.reader);
    const order = wanted.length ? wanted : [currentPageIndex(state)];
    if (!wanted.length) {
      for (let index = 0; index < total; index++) {
        if (!order.includes(index)) order.push(index);
      }
    }
    setStatus(state, "正在定位引用原文…", false);
    for (const pageIndex of order) {
      // eslint-disable-next-line no-await-in-loop
      const located = await Sideline.readertext.locate(state.reader, { pageIndex, text: quote.text, exact: true });
      if (located.found) {
        // eslint-disable-next-line no-await-in-loop
        const range = await Sideline.readertext.rectsForRange(state.reader, pageIndex, located.from, located.to);
        // eslint-disable-next-line no-await-in-loop
        const jumped = await Sideline.readertext.jump(state.reader, { pageIndex, rects: range.rects });
        setStatus(state, jumped.ok
          ? `已定位到第 ${(await Sideline.readertext.labelOf(state.reader, pageIndex))} 页原文${jumped.flashed ? "，已短暂高亮" : `；${jumped.reason || "未能显示高亮"}`}`
          : `定位到第 ${pageIndex + 1} 页，但跳转失败：${jumped.reason}`, !jumped.ok);
        return;
      }
    }
    setStatus(state, "在正文里没有找到这段引用原文（可能是模型转述或该页未渲染）", true);
  }

  function citationCard(state, citation) {
    const card = Sideline.util.element(state.doc, "div", { className: "sideline-cite" });
    card.appendChild(Sideline.util.element(state.doc, "div", {
      text: citation.label || "选区原文",
    }));
    if (Number.isFinite(citation.pageIndex) && citation.pageIndex >= 0) {
      const jump = Sideline.util.element(state.doc, "span", {
        className: "sideline-material-link",
        text: `跳到第 ${citation.pageLabel || (citation.pageIndex + 1)} 页`,
      });
      jump.addEventListener("click", () => {
        void Sideline.readertext.jump(state.reader, {
          pageIndex: citation.pageIndex,
          rects: citation.rects || null,
        });
      });
      card.appendChild(jump);
    }
    return card;
  }

  /** 每条回答只保留一个「⋯」按钮，具体操作在菜单里（原来是排一排按钮） */
  function attachAssistantTools(state, node, message) {
    node.tools.replaceChildren();
    const more = Sideline.util.element(state.doc, "button", {
      className: "sl-msg-more",
      text: "⋯",
      attrs: { title: "回答操作：重试 / 修改提问 / 复制" },
    });
    Sideline.util.onActivate(more, () => openAnswerMenu(state, message, node, more));
    node.tools.appendChild(more);
  }

  /**
   * 高亮预览面板（R07 的「先在 PDF 预览再创建」）。
   * 先把模型的候选逐条定位成坐标，用户逐条预览/勾选后再写入；定位失败的条目不写，只显示原因。
   */
  async function openHighlightPanel(state, message, host) {
    let candidates = [];
    try {
      candidates = Sideline.highlights.parse(message.content);
    }
    catch (error) {
      setStatus(state, `高亮建议无法解析：${Sideline.util.message(error)}`, true);
      return;
    }
    let panel = null;
    try {
      panel = Array.from(host.querySelectorAll("[data-sideline-highlights]"))
        .find((node) => node.getAttribute("data-sideline-highlights") === String(message.time || "x"));
    }
    catch (error) {
      panel = null;
    }
    if (!panel) {
      panel = Sideline.util.element(state.doc, "div", {
        className: "sideline-highlights",
        attrs: { "data-sideline-highlights": String(message.time || "x") },
      });
      host.appendChild(panel);
    }
    panel.replaceChildren();
    const status = Sideline.util.element(state.doc, "div", { className: "sideline-hint", text: "正在按页定位原文…" });
    panel.appendChild(status);

    const attachment = Zotero.Items.get(state.attachmentID);
    if (!attachment) {
      status.textContent = "找不到目标 PDF 附件，无法定位";
      status.classList.add("sideline-error");
      return;
    }
    const prepared = await Sideline.highlights.prepare(state.reader, candidates);
    const info = Sideline.highlights.summary(prepared);
    panel.replaceChildren();
    panel.appendChild(Sideline.util.element(state.doc, "div", {
      className: "sideline-hint",
      text: `将写入 ${attachment.getField("title") || attachment.key}：`
        + `${info.ok} 条可写入，${info.failed} 条需人工处理`
        + `${info.pages.length ? `；页码 ${info.pages.join("、")}` : ""}`
        + `${info.approximate ? `；其中 ${info.approximate} 条为近似匹配` : ""}`,
    }));

    const boxes = [];
    for (const entry of prepared) {
      const row = Sideline.util.element(state.doc, "div", {
        className: `sideline-highlight-row${entry.ok ? "" : " sideline-material-error"}`,
      });
      const box = Sideline.util.element(state.doc, "input", {
        attrs: { type: "checkbox", "aria-label": "选择该条" },
      });
      box.checked = !!entry.ok;
      box.disabled = !entry.ok;
      boxes.push({ box, entry });
      row.appendChild(box);
      const main = Sideline.util.element(state.doc, "div", { className: "sideline-material-main" });
      main.appendChild(Sideline.util.element(state.doc, "div", {
        className: "sideline-material-label",
        text: `第 ${entry.pageLabel} 页：${entry.quote.slice(0, 60)}`,
      }));
      main.appendChild(Sideline.util.element(state.doc, "div", {
        className: "sideline-material-detail",
        text: entry.ok
          ? (entry.reason || "模型未给出理由")
          : `不写入：${entry.error}`,
      }));
      row.appendChild(main);
      if (entry.ok) {
        const previewButton = Sideline.util.element(state.doc, "button", { text: "预览" });
        Sideline.util.onActivate(previewButton, () => {
          void (async () => {
            const result = await Sideline.highlights.preview(state.reader, entry);
            setStatus(state, result.ok
              ? `已预览第 ${entry.pageLabel} 页的范围（黄色高亮闪一下）`
              : `预览失败：${result.reason}`, !result.ok);
          })();
        });
        row.appendChild(previewButton);
      }
      panel.appendChild(row);
    }

    const actions = Sideline.util.element(state.doc, "div", { className: "sideline-panel-row" });
    const commitButton = Sideline.util.element(state.doc, "button", { text: "确认写入选中的批注" });
    Sideline.util.onActivate(commitButton, () => {
      void (async () => {
        const entries = boxes.filter((item) => item.box.checked && item.entry.ok).map((item) => item.entry);
        if (!entries.length) {
          setStatus(state, "没有勾选任何可写入的条目", true);
          return;
        }
        commitButton.disabled = true;
        setStatus(state, `正在写入 ${entries.length} 条批注…`, false);
        const created = await Sideline.highlights.commit({
          attachment,
          entries,
          color: Sideline.config.str("readerAnnotationColor") || undefined,
          commentOf: (entry) => entry.reason || "",
        });
        const okList = created.filter((entry) => entry.ok);
        for (const entry of okList) {
          // eslint-disable-next-line no-await-in-loop
          await Sideline.writes.record(state.ownerID, {
            kind: "annotation",
            targetID: entry.id,
            key: entry.key,
            summary: `批注（第 ${entry.pageLabel} 页）：${entry.quote.slice(0, 40)}`,
          });
        }

        commitButton.disabled = false;
        const failed = created.filter((entry) => !entry.ok);
        setStatus(state, `已写入 ${okList.length} 条批注`
          + `${failed.length ? `，${failed.length} 条失败：${failed[0].error}` : ""}`
          + ``, failed.length > 0 && okList.length === 0);
      })();
    });
    actions.appendChild(commitButton);
    panel.appendChild(actions);
  }

  /** 面板顶部的会话累计用量（R12） */
  /** 面板顶部的小字：本会话累计用量（没有调用时不显示） */
  function refreshTotals(state) {
    const totals = Sideline.session.totals(state.ownerID);
    state.totalsText = totals.calls
      ? `${totals.calls} 次 · ${totals.tokens ? `${totals.tokens} tokens` : "token 未返回"}`
        + `${totals.elapsedMs ? ` · ${(totals.elapsedMs / 1000).toFixed(1)}s` : ""}`
      : "";
    const host = state.els && state.els.totalsEl;
    if (host) host.textContent = state.totalsText;
  }

  function renderMessages(state) {
    const el = state.els && state.els.messagesEl;
    if (!el) return;
    el.replaceChildren();
    const messages = Sideline.session.list(state.ownerID);
    if (!messages.length) {
      el.appendChild(Sideline.util.element(state.doc, "div", {
        className: "sideline-hint",
        text: "还没有对话。在 PDF 里划词，或用输入区的「＋」加入材料；选好功能后发送即可（提示词在设置里配置，不会显示在对话里）。",
      }));
      refreshSelection(state);
      refreshTotals(state);
      return;
    }
    messages.forEach((message, index) => {
      const node = bubble(state, message);
      if (message.role === "assistant") {
        attachAssistantTools(state, node, message);
        // 点击回答卡片即选中/取消选中，选中的可批量写入子笔记；键盘也能操作（Tab 到卡片后回车/空格）
        const key = msgKey(message, index);
        const selected = state.selectedTimes.has(key);
        node.wrapper.classList.toggle("sideline-msg-selected", selected);
        node.wrapper.setAttribute("title", "点击选中这条回答，可一次加入子笔记");
        node.wrapper.setAttribute("tabindex", "0");
        node.wrapper.setAttribute("role", "button");
        node.wrapper.setAttribute("aria-pressed", selected ? "true" : "false");
        node.wrapper.addEventListener("click", (event) => {
          onMessageClick(state, event, key, node.wrapper);
        });
        node.wrapper.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onMessageClick(state, {}, key, node.wrapper);
        });
      }
      el.appendChild(node.wrapper);
    });
    refreshSelection(state);
    refreshTotals(state);
    scrollToEnd(state);
  }

  /**
   * 回答消息的稳定标识。
   * 只用 time 不够：同一分钟内连续几轮回答会撞车（nowText 是分钟级），
   * 因此拼上会话内的序号；渲染顺序不变，序号就稳定。
   */
  function msgKey(message, index) {
    const time = message && message.time ? String(message.time) : "";
    return `${time}#${index}`;
  }

  /** 点回答卡片＝选中/取消；点链接、按钮、页码锚点或正在划词时不切换 */
  function onMessageClick(state, event, key, wrapper) {
    const target = event && event.target;
    if (target && typeof target.closest === "function"
      && target.closest("a, button, input, select, textarea, [data-sideline-page]")) {
      return;
    }
    try {
      const win = state.doc && state.doc.defaultView;
      const selection = win && win.getSelection ? win.getSelection() : null;
      if (selection && selection.isCollapsed === false) return;
    }
    catch (error) {
      // 拿不到选区信息时按普通点击处理
    }
    if (state.selectedTimes.has(key)) state.selectedTimes.delete(key);
    else state.selectedTimes.add(key);
    const selected = state.selectedTimes.has(key);
    wrapper.classList.toggle("sideline-msg-selected", selected);
    try {
      wrapper.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    catch (error) {
      // 极简宿主可能没有 setAttribute
    }
    refreshSelection(state);
  }

  /** 选中的回答数 → 操作条文案与显隐 */
  function refreshSelection(state) {
    const bar = state.els && state.els.selectedBar;
    const count = state.selectedTimes ? state.selectedTimes.size : 0;
    if (state.els && state.els.selectedCount) {
      state.els.selectedCount.textContent = count ? `已选 ${count} 条回答` : "";
    }
    if (bar) bar.hidden = !count;
  }

  /**
   * 把选中的回答（连同各自的提问）写进一条**新建**的子笔记：
   * 复用 excerpt.plan/commit（带来源深链、绝不覆盖已有笔记），写入后登记审计记录。
   */
  async function saveSelectionToNote(state) {
    if (!state.selectedTimes.size) {
      setStatus(state, "还没有选中任何回答", true);
      return;
    }
    const item = ownerItem(state);
    if (!item) {
      setStatus(state, "找不到目标条目，无法写入子笔记", true);
      return;
    }
    const list = Sideline.session.list(state.ownerID);
    const picked = [];
    list.forEach((message, index) => {
      if (!message || message.role !== "assistant") return;
      if (!state.selectedTimes.has(msgKey(message, index))) return;
      const previous = list[index - 1];
      if (previous && previous.role === "user" && !picked.includes(previous)) picked.push(previous);
      if (!picked.includes(message)) picked.push(message);
    });
    if (!picked.length) {
      setStatus(state, "选中的回答已经不在当前会话里", true);
      return;
    }
    const attachment = Zotero.Items.get(state.attachmentID);
    let planned = null;
    try {
      planned = Sideline.excerpt.plan({
        item,
        messages: picked,
        itemKey: item.key,
        attachmentKey: attachment ? attachment.key : "",
        itemTitle: String((item.getField && item.getField("title")) || ""),
      });
    }
    catch (error) {
      setStatus(state, `无法写入子笔记：${Sideline.util.message(error)}`, true);
      return;
    }
    try {
      setStatus(state, `正在写入子笔记（${planned.blockCount} 段对话）…`, false);
      const result = await Sideline.excerpt.commit({ item, plan: planned });
      await Sideline.writes.record(state.ownerID, {
        kind: "note",
        targetID: result.noteID,
        key: result.noteKey,
        summary: `选中回答写入子笔记：${result.title}`,
      });

      state.selectedTimes.clear();
      renderMessages(state);
      setStatus(state, `已把 ${planned.blockCount} 段对话写入子笔记 ${result.noteKey}`, false);
    }
    catch (error) {
      setStatus(state, `写入子笔记失败：${Sideline.util.message(error)}`, true);
    }
  }

  function setStatus(state, text, isError, action) {
    const el = state.els && state.els.statusEl;
    if (!el) return;
    const value = String(text == null ? "" : text);
    el.replaceChildren();
    el.appendChild(Sideline.util.element(state.doc, "span", { text: value }));
    if (action && action.label && typeof action.run === "function") {
      const button = Sideline.util.element(state.doc, "button", {
        className: "sl-status-action",
        text: String(action.label),
      });
      Sideline.util.onActivate(button, action.run);
      el.appendChild(button);
    }
    // 状态行只保留一行；完整信息放 title，避免把面板塞满
    el.setAttribute("title", value);
    el.classList.toggle("sideline-error", !!isError);
  }

  function setBusy(state, busy) {
    state.busy = !!busy;
    if (!state.els) return;
    if (state.els.sendButton) state.els.sendButton.disabled = !!busy;
    if (state.els.stopButton) state.els.stopButton.hidden = !busy || !!state.resetting;
  }

  // ---- 材料采集与笔记检索（R08/R09/R10） ----

  /** 当前条目的普通条目对象（材料构造与写入都以它为目标） */
  function ownerItem(state) {
    try {
      return Zotero.Items.get(state.ownerID) || null;
    }
    catch (error) {
      return null;
    }
  }

  /** R09：文件选择器 → 逐个解析成材料，解析失败也以材料形式入清单并写明原因 */
  async function addPickedFiles(state) {
    const picked = Sideline.inputs.pickFiles({ win: state.win });
    if (picked.error) {
      setStatus(state, `打开文件选择器失败：${picked.error}`, true);
      return;
    }
    if (picked.cancelled || !picked.paths.length) {
      setStatus(state, "没有选择文件", false);
      return;
    }
    const item = ownerItem(state);
    let added = 0;
    for (const path of picked.paths) {
      // eslint-disable-next-line no-await-in-loop
      const result = await Sideline.inputs.resolve(path, {
        item,
        maxChars: Sideline.config.num("fileMaxChars"),
      });
      if (result.ok) {
        addMaterial(state, materialFromResolved(result, path));
        added++;
      }
      else {
        Sideline.materials.add(state.materials, Sideline.materials.create("path", {
          label: `文件：${Sideline.inputs.baseName(path)}`,
          path,
          state: "error",
          error: result.reason,
        }));
        renderMaterials(state);
      }
    }
    setStatus(state, added
      ? `已加入 ${added} 个文件材料（${Sideline.materials.summaryText(state.materials)}）`
      : `没有可用的文件：${picked.paths.length} 个解析失败`, added === 0);
  }

  /** 把 inputs.resolve 的结果转成材料（按 kind 选构造器） */
  function materialFromResolved(result, source) {
    const fields = result.fields || {};
    if (result.kind === "item") {
      return Sideline.materials.fromItem({
        itemID: fields.itemID,
        title: fields.title,
        text: fields.text,
        detail: fields.detail,
        source: fields.source,
      });
    }
    if (result.kind === "image") {
      return Sideline.materials.fromImage({
        name: fields.name,
        dataUrl: fields.dataUrl,
        detail: fields.detail,
        source: fields.source,
      });
    }
    if (result.kind === "path") {
      return Sideline.materials.fromPath({
        path: fields.path || source,
        name: fields.name,
        text: fields.text,
        detail: fields.detail,
        source: fields.source,
      });
    }
    return Sideline.materials.fromPaste({
      text: fields.text,
      label: fields.label,
      detail: fields.detail,
      source: fields.source,
    });
  }

  /** R08：用输入框里的关键词检索当前条目的子笔记，命中片段进入材料 */
  /**
   * 检索笔记（0.7.1 起改为**全库**检索）。
   * 查询语法：同一行内空格分隔 = 这些词必须同时出现；换行分隔 = 满足任意一行即可。
   */
  async function searchNotes(state) {
    const textarea = state.els && state.els.textarea;
    const query = String((textarea && textarea.value) || "").trim();
    if (!query) {
      setStatus(state, "请先在输入框里写检索关键词：同行空格表示同时包含，换行表示任意一行即可", true);
      return;
    }
    const parsed = Sideline.notetext.parseQuery(query);
    setStatus(state, `正在检索全库笔记（${parsed.groups.length} 组条件）…`, false);
    try {
      const result = await Sideline.notetext.findEverywhere(query, {
        maxHits: Sideline.config.num("noteSearchMaxHits"),
      });
      if (!result.notesScanned) {
        setStatus(state, "全库没有可检索的笔记", true);
        return;
      }
      if (!result.hits.length) {
        setStatus(state, `在 ${result.notesScanned} 篇笔记里没有找到符合「${query.replace(/\s+/g, " ")}」的段落`, true);
        return;
      }
      for (const options of result.materials) {
        const material = Sideline.materials.fromNote(options);
        if (!Sideline.materials.duplicateOf(state.materials, material)) {
          Sideline.materials.add(state.materials, material);
        }
      }
      renderMaterials(state);
      setStatus(state, `命中 ${result.total} 处，已加入 ${result.hits.length} 段`
        + `${result.truncated ? `（还有 ${result.truncated} 处未加入，可用更具体的关键词）` : ""}`
        + `${result.scannedTruncated ? `（只扫了前 ${result.notesScanned} 篇笔记）` : ""}`
        + `；来源：${result.hits.map((hit) => `${hit.noteTitle} 第 ${hit.paragraphIndex} 段`).join("；")}`, false);
    }
    catch (error) {
      setStatus(state, `检索笔记失败：${Sideline.util.message(error)}`, true);
    }
  }

  /** R10：重试上一轮取文失败的页；成功后更新覆盖信息 */
  async function retryFailedPages(state) {
    const failed = (state.failedPages || []).slice();
    if (!failed.length) {
      setStatus(state, "没有需要重试的页", false);
      return;
    }
    setStatus(state, `正在重试第 ${failed.map((entry) => entry.pageIndex + 1).join("、")} 页…`, false);
    const stillFailed = [];
    for (const entry of failed) {
      // eslint-disable-next-line no-await-in-loop
      const record = await Sideline.readertext.page(state.reader, entry.pageIndex, { refresh: true });
      if (record.state !== "ok") stillFailed.push({ pageIndex: entry.pageIndex, error: record.error });
    }
    state.failedPages = stillFailed;
    if (!stillFailed.length) {
      setStatus(state, "重试成功：失败页已经可以取文，请重新点「加入全文」更新材料", false);
    }
    else {
      setStatus(state, `仍有 ${stillFailed.length} 页取文失败：`
        + stillFailed.map((entry) => `第 ${entry.pageIndex + 1} 页（${entry.error}）`).join("；"), true);
    }
    renderMaterials(state);
  }

  // ---- R13：会话检索与导出 ----

  /** R13：在会话历史里检索（会话名或消息正文） */
  async function searchHistory(state) {
    const textarea = state.els && state.els.textarea;
    const query = String((textarea && textarea.value) || "").trim();
    if (!query) {
      setStatus(state, "请先在输入框里写检索关键词，再点「搜索会话」", true);
      return;
    }
    setStatus(state, "正在检索会话历史…", false);
    try {
      const result = await Sideline.history.find(state.ownerID, query, {
        maxHits: Sideline.config.num("historySearchMaxHits"),
      });
      if (!result.sessionsScanned) {
        setStatus(state, "该条目还没有会话可检索", true);
        return;
      }
      if (!result.hits.length) {
        setStatus(state, `在 ${result.sessionsScanned} 条会话里没有找到「${query}」`, true);
        return;
      }
      state.historyHits = result.hits;
      renderHistoryHits(state);
      setStatus(state, `命中 ${result.total} 处，显示前 ${result.hits.length} 处`
        + `${result.truncated ? `（还有 ${result.truncated} 处未显示，可用更具体的关键词）` : ""}`
        + `；会话：${[...new Set(result.hits.map((hit) => hit.sessionName))].join("、")}`, false);
    }
    catch (error) {
      setStatus(state, `检索会话失败：${Sideline.util.message(error)}`, true);
    }
  }

  /** 把会话命中渲染成可点回原会话的列表（紧凑两行一项） */
  function renderHistoryHits(state) {
    const host = state.els && state.els.historyEl;
    if (!host) return;
    host.replaceChildren();
    const hits = state.historyHits || [];
    if (!hits.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const head = Sideline.util.element(state.doc, "div", { className: "sl-hint-head" });
    head.appendChild(Sideline.util.element(state.doc, "span", { text: `会话检索：${hits.length} 处` }));
    const close = Sideline.util.element(state.doc, "button", { className: "sl-link", text: "关闭" });
    Sideline.util.onActivate(close, () => {
      state.historyHits = [];
      host.hidden = true;
      host.replaceChildren();
    });
    head.appendChild(close);
    host.appendChild(head);
    for (const hit of hits) {
      const row = Sideline.util.element(state.doc, "div", { className: "sl-hint-item" });
      const link = Sideline.util.element(state.doc, "button", {
        className: "sl-link",
        text: hit.index >= 0
          ? `${hit.sessionName} · 第 ${hit.index + 1} 条（${hit.roleText}）`
          : `${hit.sessionName} · 会话名匹配`,
      });
      Sideline.util.onActivate(link, () => {
        void (async () => {
          await Sideline.store.flush();
          renderMessages(state);

          setStatus(state, `已定位当前会话第 ${hit.index + 1} 条`, false);
        })();
      });
      row.appendChild(link);
      row.appendChild(Sideline.util.element(state.doc, "div", {
        className: "sl-hint-snippet",
        text: hit.snippet,
      }));
      host.appendChild(row);
    }
  }

  /** R13：导出会话（Markdown 或 JSON，另存为文件） */
  async function exportHistory(state, format) {
    try {
      const wanted = format === "json" ? "json" : "markdown";
      const built = await Sideline.history.build(state.ownerID, { format: wanted });
      if (!built.sessionCount) {
        setStatus(state, "该条目还没有会话可导出", true);
        return;
      }
      const path = Sideline.history.pickSavePath(built.filename, { win: state.win });
      if (!path) {
        setStatus(state, `已取消导出（${wanted === "json" ? "JSON" : "Markdown"}）`, false);
        return;
      }
      await Sideline.history.save(path, built.text);
      setStatus(state, `已导出 ${built.sessionCount} 会话 / ${built.messageCount} 条消息`, false);
    }
    catch (error) {
      setStatus(state, `导出失败：${Sideline.util.message(error)}`, true);
    }
  }

  /** 按作用范围确保有对应材料；缺失时自动补齐当前页或全文 */
  async function ensureScope(state, scope) {
    if (scope === "selection") {
      const selection = state.materials.filter((entry) => entry.kind === "selection").pop();
      if (!selection) {
        return { ok: false, reason: "还没有选区材料：请在 PDF 里划词后点「加入对话」" };
      }
      return { ok: true, material: selection };
    }
    if (scope === "page") {
      const index = currentPageIndex(state);
      const existing = state.materials.find((entry) => entry.kind === "page" && entry.pageIndex === index);
      if (existing) return { ok: true, material: existing };
      try {
        const record = await Sideline.readertext.page(state.reader, index);
        if (record.state !== "ok") {
          return { ok: false, reason: record.error || "当前页没有可提取的文字" };
        }
        const material = Sideline.materials.fromPage({
          text: Sideline.readertext.joinSpans(record.spans),
          pageIndex: record.pageIndex,
          pageLabel: record.label,
        });
        addMaterial(state, material);
        return { ok: true, material };
      }
      catch (error) {
        return { ok: false, reason: Sideline.util.message(error) };
      }
    }
    if (scope === "document") {
      const existing = state.materials.find((entry) => entry.kind === "document");
      if (existing) return { ok: true, material: existing };
      try {
        const material = await addDocument(state);
        return { ok: true, material };
      }
      catch (error) {
        return { ok: false, reason: Sideline.util.message(error) };
      }
    }
    return { ok: false, reason: `未知的作用范围：${scope}` };
  }

  /**
   * 发送一轮消息。
   * @param {object} options functionId 功能 id；retry 重试上一次请求
   */
  async function send(state, options = {}) {
    if (state.busy) return;
    if (!state.els) return;
    const config = Sideline.config.read();
    const textarea = state.els.textarea;
    const retry = options.retry === true && !!state.lastRequest;
    const typed = retry
      ? String(state.lastRequest.typed || "")
      : String((textarea && textarea.value) || "").trim();
    // 功能来自下拉栏选中的待执行功能，或调用方显式指定
    const functionId = retry ? (state.lastRequest.functionId || "") : String(options.functionId || state.pendingFunction || "");

    let functionEntry = null;
    let scopeInfo = null;
    let promptText = "";
    let displayText = "";
    let citations = [];

    if (retry) {
      // 重试沿用上一次的提示词、显示文本与引用，并替换原来的整轮问答。
      const last = state.lastRequest;
      promptText = last.prompt;
      displayText = last.display;
      citations = last.citations || [];
    }
    else {
      if (functionId) {
        functionEntry = Sideline.functions.byId(functionId);
        if (!functionEntry) {
          setStatus(state, `未知功能：${functionId}`, true);
          return;
        }
        scopeInfo = Sideline.functions.resolveScope(functionEntry.id, {
          selection: state.materials.some((entry) => entry.kind === "selection"),
          page: true,
          document: true,
        });
        const scope = await ensureScope(state, scopeInfo.scope);
        if (!scope.ok) {
          setStatus(state, scope.reason, true);
          return;
        }
      }
      else if (!typed) {
        setStatus(state, "请输入问题，或先加入材料", true);
        return;
      }
      promptText = functionEntry
        ? [functionEntry.prompt, typed].filter(Boolean).join("\n\n")
        : typed;
      displayText = functionEntry
        ? `${functionEntry.name}${typed ? `｜${typed}` : ""}${scopeInfo && scopeInfo.downgraded ? `（${scopeInfo.reason}）` : ""}`
        : typed;
      citations = state.materials
        .filter((entry) => entry.kind === "selection" || entry.kind === "annotation")
        .map((entry) => ({
          label: `${entry.label}：${String(entry.text || "").slice(0, 80)}`,
          pageIndex: entry.pageIndex,
          pageLabel: entry.pageLabel,
          rects: entry.rects,
        }));
    }

    const images = state.materials.filter((entry) => entry.kind === "image").map((entry) => entry.dataUrl);
    const vision = Sideline.providers.checkRequest(config, images);
    if (!vision.ok) {
      setStatus(state, vision.reason, true);
      return;
    }

    setBusy(state, true);
    if (textarea && !retry) {
      textarea.value = "";
      syncInputHint(state);
    }

    const assembled = Sideline.materials.assemble(state.materials, {
      maxChars: Sideline.config.num("maxContextChars"),
    });
    const currentMessages = Sideline.session.list(state.ownerID);
    const rebuildAgent = !!retry || !!state.editing;
    const baseMessages = retry
      ? (state.lastRequest.baseMessages || []).map((message) => Object.assign({}, message))
      : (state.editing && state.editing.from >= 0
        ? currentMessages.slice(0, state.editing.from).map((message) => Object.assign({}, message))
        : currentMessages.map((message) => Object.assign({}, message)));
    if (retry || state.editing) {
      Sideline.session.replace(state.ownerID, baseMessages);
    }
    state.editing = null;
    state.lastRequest = {
      functionId,
      typed,
      prompt: promptText,
      display: displayText,
      citations,
      baseMessages,
    };
    // 功能已被这一轮消耗；重试所需的 functionId 已保存在 lastRequest。
    if (state.pendingFunction) setPendingFunction(state, "");

    Sideline.session.append(state.ownerID, "user", promptText, {
      display: displayText,
      question: typed,
      functionId,
      citations,
      images: Sideline.providers.current(config) === "agent"
        ? images.filter((url) => !baseMessages.some((entry) => (entry.images || []).includes(url))) : [],
    });
    renderMessages(state);

    const systemParts = [Sideline.prompts.systemFor(config, {
      // R14：本轮材料里有多个条目时，追加「逐条标注来源文献」的要求
      itemCount: state.materials.filter((entry) => entry.kind === "item").length,
    })];
    if (assembled.text) systemParts.push(`【本轮材料】\n${assembled.text}`);
    else systemParts.push("【本轮材料】\n（本轮没有材料，只能依据对话历史回答；缺少依据时要说明。）");
    const messages = [{ role: "system", content: systemParts.join("\n\n") }];
    const history = Sideline.providers.current(config) === "agent"
      ? Sideline.session.list(state.ownerID) : Sideline.session.history(state.ownerID);
    for (const entry of history) {
      messages.push({ role: entry.role, content: entry.content, images: entry.images || [] });
    }
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      messages.push({ role: "user", content: promptText });
    }

    const assistantNode = bubble(state, { role: "assistant", content: "…" });
    state.els.messagesEl.appendChild(assistantNode.wrapper);
    // 发送前先报一次估算用量（R12）；真实用量在响应回来后替换
    const estimate = Sideline.providers.estimateRequestTokens(messages, images);
    setStatus(state, `生成中…（约 ${estimate.total} tokens）`, false);
    scrollToEnd(state);

    // 流式过程中就按 Markdown 渲染（每 120ms 一次，避免逐字重排），结束时再定稿
    let lastRenderAt = 0;
    const renderStream = (whole) => {
      const now = Date.now();
      if (now - lastRenderAt < 120) return;
      lastRenderAt = now;
      assistantNode.body.innerHTML = Sideline.citations.render(stripOuterFence(whole), null);
      scrollToEnd(state);
    };

    let streamed = "";
    let answerStored = false;
    const started = Date.now();
    const requestKey = `${state.key}:${Date.now()}:${++requestSequence}`;
    state.requestKey = requestKey;
    try {
      const result = await Sideline.providers.chat({
        ownerID: state.ownerID,
        rebuildAgent,
        onWarning: (warning) => setStatus(state, warning, true),
        messages,
        images,
        config,
        requestKey,
        onDelta: (piece, whole) => {
          streamed = whole;
          renderStream(whole);
        },
      });
      if (state.aborted) throw new Error("aborted");
      const answer = result.content || streamed;
      if (!answer.trim()) throw new Error("模型返回了空回答");

      // 回答里的页码引用解析成锚点（R04）：用纸面页码表反查，解析不到就不做锚点
      let pageRefs = [];
      try {
        const labels = await Sideline.readertext.pageLabels(state.reader);
        pageRefs = Sideline.citations
          .resolve(Sideline.citations.find(answer), labels)
          .map((entry) => ({
            kind: "pageref",
            label: `第 ${entry.label} 页`,
            pageLabel: entry.label,
            pageIndex: entry.pageIndex,
            rects: null,
          }));
      }
      catch (error) {
        pageRefs = [];
      }

      const extra = {
        model: result.model,
        provider: result.provider,
        question: promptText,
        functionId,
        elapsedMs: Date.now() - started,
        usage: result.usage || null,
        citations: pageRefs,
      };
      const clean = stripOuterFence(answer);
      Sideline.session.append(state.ownerID, "assistant", clean, extra);
      answerStored = true;
      const stored = Object.assign({ role: "assistant", content: clean }, extra);
      assistantNode.body.innerHTML = Sideline.citations.render(
        clean,
        Sideline.citations.toMap(pageRefs),
      );
      attachPageRefs(state, assistantNode.body, stored);
      attachQuoteLocators(state, assistantNode.body, stored);
      attachAssistantTools(state, assistantNode, stored);
      await Sideline.store.flush();
      refreshTotals(state);

      const usage = result.usage || {};
      const tokens = usage.total_tokens
        || ((usage.input_tokens || 0) + (usage.output_tokens || 0))
        || 0;
      const extras = [];
      if (images.length && result.forcedByImages) extras.push("含图片，使用视觉 API");
      if (pageRefs.length) extras.push(`${pageRefs.length} 处页码可点击`);
      if (Sideline.highlights.looksLikeCandidates(clean)) extras.push("可标记重点");
      setStatus(state, [
        `${Sideline.providers.label(result.provider)} · ${result.model}`,
        `${assembled.chars} 字上下文`,
        tokens ? `${tokens} tokens` : `约 ${estimate.total} tokens（估算）`,
        `${((Date.now() - started) / 1000).toFixed(1)}s`,
      ].concat(extras).join(" · "), false);
      if (result.sessionWarning) setStatus(state, result.sessionWarning, true);
    }
    catch (error) {
      try {
        assistantNode.wrapper.remove();
      }
      catch (inner) {
        // 忽略
      }
      const stopped = state.aborted || !!error.cancelled;
      const partial = stripOuterFence(streamed || error.partialContent || "");
      // 停止时保留已经显示出来的部分回答；即便还没收到首个片段，也保留用户问题。
      if (stopped && partial && !answerStored) {
        const provider = Sideline.providers.current(config);
        Sideline.session.append(state.ownerID, "assistant", partial, {
          model: images.length ? Sideline.config.apiConfig(config, true).model
            : provider === "agent" ? config.agentModel : Sideline.config.apiConfig(config).model,
          provider,
          question: promptText,
          functionId,
          elapsedMs: Date.now() - started,
          usage: null,
          citations: [],
          stopped: true,
        });
      }
      renderMessages(state);
      if (!answerStored) {
        setStatus(state, stopped
          ? "已停止；问题与已生成内容已保留"
          : `失败：${Sideline.util.message(error)}`, !stopped, {
          label: "重试",
          run: () => void send(state, { retry: true }),
        });
      }
    }
    finally {
      setBusy(state, false);
      if (state.requestKey === requestKey) state.requestKey = null;
      state.aborted = false;
      if (state.materials.length) renderMaterials(state);
      // 无论正常结束、停止还是失败，都从已存消息重渲染一遍：
      // 保证气泡里的内容一定是渲染后的 Markdown，而不是流式过程中的中间态
      renderMessages(state);
      refreshTotals(state);
    }
  }

  /** 阅读器工具栏按钮：打开/收起面板（renderToolbar 是 Zotero 已有的钩子） */
  function registerToolbar(pluginID) {
    const handler = (event) => {
      try {
        const reader = event.reader;
        const state = attach(reader);
        if (!state) return;
        const doc = event.doc || state.doc;
        if (!doc) return;
        const button = Sideline.util.element(doc, "button", {
          className: "toolbar-button sideline-panel-toggle",
          attrs: { title: "Sideline 对话", "aria-label": "Sideline 对话" },
        });
        button.appendChild(Sideline.util.element(doc, "span", { text: "AI" }));
        Sideline.util.onActivate(button, () => activate(state, !state.open));
        event.append(button);
      }
      catch (error) {
        Sideline.util.error(error);
      }
    };
    Zotero.Reader.registerEventListener(TOOLBAR_EVENT, handler, pluginID);
    return handler;
  }

  function register(pluginID, rootURI) {
    pluginRootURI = rootURI || pluginRootURI;
    toolbarHandler = registerToolbar(pluginID);
    return toolbarHandler;
  }

  function unregister() {
    try {
      if (toolbarHandler) Zotero.Reader.unregisterEventListener(TOOLBAR_EVENT, toolbarHandler);
    }
    catch (error) {
      Sideline.util.error(error);
    }
    toolbarHandler = null;
    for (const state of states.values()) {
      disposeState(state);
    }
    states.clear();
  }

  return {
    PANEL_ID,
    BUTTON_ID,
    BODY_CLASS,
    register,
    unregister,
    attach,
    attachAll,
    addSelection,
    addCurrentPage,
    addDocument,
    stateOf,
    states,
    send,
    activate,
  };
})();
