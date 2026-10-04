/*
 * Sideline 侧栏菜单视图。
 * 输入：菜单所属阅读器视图、选项与锚点；输出：菜单 DOM 及关闭监听器。
 * 依赖：util。只修改 menu/menuCloser/menuKeyCloser/menuScrollCloser，不读写请求或会话。
 * 关闭时移除文档级监听；保留点外、Escape、滚动关闭以及同一侧栏菜单互斥。
 */
Sideline.readermenu = (function () {
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

  return { open: openMenu, close: closeMenu };
})();
