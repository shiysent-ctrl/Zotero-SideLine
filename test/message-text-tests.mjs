/*
 * 气泡正文选择/复制回归：真实消息视图与菜单配合最小 Selection/Range 桩。
 * 输入：Sideline 与公共 DOM/断言宿主；输出：选择边界、菜单、剪贴板及清理断言。
 * 不调用模型、不写文献；不能代替真实 Gecko 拖选与系统剪贴板验收。
 */
export async function runMessageTextTests({ Sideline: s, check, equal, makeReaderShellDom, findByClass, findByText }) {
  const prefix = (name) => `message-text: ${name}`;
  const doc = makeReaderShellDom(), panel = doc.createElementNS(null, "div");
  doc.body.appendChild(panel);
  let status = null, selection = null, selectedBody = null, clipboard = "";
  const state = { doc, els: { panel }, renderCache: new Map(), renderCacheChars: 0 };
  const view = s.readermessages.create({ setStatus: (_state, text, error) => { status = { text, error }; }, openMenu: s.readermenu.open });
  doc.getSelection = () => selection;
  doc.createRange = () => ({
    selectNodeContents(body) { selectedBody = body; this.startContainer = body; this.endContainer = body; },
  });
  const user = view.bubble(state, { id: "user-text", role: "user", content: "内部提示词", display: "可见提问\n第二行" });
  const answer = view.bubble(state, { id: "answer-text", role: "assistant", content: "**回答**\n\n后段" });
  const receipt = view.bubble(state, { id: "receipt-text", role: "assistant", functionId: "highlight", content: '[{"quote":"内部 JSON"}]' });
  panel.appendChild(user.wrapper); panel.appendChild(answer.wrapper); panel.appendChild(receipt.wrapper);
  const copyBefore = s.util.copyText;
  const collapsed = () => ({ rangeCount: 0, isCollapsed: true,
    removeAllRanges() { this.rangeCount = 0; }, addRange(range) {
      this.rangeCount = 1; this.isCollapsed = false; this.range = range;
    }, getRangeAt() { return this.range; }, toString() { return this.range?.startContainer.textContent || ""; } });
  const partial = (start, end, text) => ({ rangeCount: 1, isCollapsed: false,
    getRangeAt: () => ({ startContainer: start, endContainer: end }), toString: () => text });
  const open = (body) => {
    let prevented = false, stopped = false;
    body.dispatch("contextmenu", { clientX: 90, clientY: 180,
      preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    return { prevented, stopped, menu: state.menu };
  };
  try {
    s.util.copyText = (text) => { clipboard = text; return true; };
    let stopped = false, prevented = false, hostCalls = 0;
    const event = { button: 0, stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } };
    user.body.dispatch("pointerdown", event);
    // 模拟 FocusManager 的 window 冒泡监听：到达宿主时会取消默认拖选。
    if (!stopped) { hostCalls++; event.preventDefault(); }
    check(prefix("正文鼠标按下不抵达宿主的默认行为阻断"), stopped && !prevented && hostCalls === 0);
    check(prefix("不把正文改为可编辑输入区"), !user.body.getAttribute("contenteditable"));
    check(prefix("菜单只绑定正文，角色和工具条不拦截选择"), !user.wrapper.listeners.pointerdown && !user.tools.listeners.contextmenu);

    selection = collapsed();
    let opened = open(user.body);
    check(prefix("右键替代宿主菜单，防止同时弹出两个菜单"), opened.prevented && opened.stopped);
    equal(prefix("右键菜单只有全选与复制"), opened.menu.children.length, 2);
    doc.listeners.mousedown[0]({ target: findByText(opened.menu, "复制") });
    check(prefix("按下菜单内部按钮不会被当作点外关闭"), state.menu === opened.menu);
    check(prefix("两个命令使用公共激活绑定"), findByText(opened.menu, "全选").listeners.command.length === 1
      && findByText(opened.menu, "复制").listeners.click.length === 1);
    findByText(opened.menu, "复制").dispatch("click");
    equal(prefix("无选区复制当前可见提问，不泄露内部模板"), clipboard, "可见提问\n第二行");
    check(prefix("复制成功显示状态并关闭菜单"), status.text === "已复制" && !status.error && state.menu === null);

    const child = doc.createElementNS(null, "span"); child.textContent = "选中片段"; answer.body.appendChild(child);
    selection = partial(child, child, "  选中片段\n");
    opened = open(answer.body);
    selection = collapsed(); // 点击菜单后选区消失，仍应复制右键时捕获的片段。
    findByText(opened.menu, "复制").dispatch("command");
    equal(prefix("复制右键时的局部选区，保留空白与换行"), clipboard, "  选中片段\n");
    selection = partial(user.body, user.body, "其他气泡的提问");
    opened = open(answer.body); findByText(opened.menu, "复制").dispatch("click");
    equal(prefix("其他气泡选区不进入当前回答复制"), clipboard, answer.body.textContent);
    selection = partial(child, user.body, "跨气泡选区");
    opened = open(answer.body); findByText(opened.menu, "复制").dispatch("click");
    equal(prefix("跨气泡选区不复制其他正文"), clipboard, answer.body.textContent);

    selection = collapsed();
    opened = open(answer.body); findByText(opened.menu, "全选").dispatch("click");
    check(prefix("全选只创建当前正文的 Range"), selectedBody === answer.body && selection.rangeCount === 1
      && selection.range.startContainer === answer.body && selection.range.endContainer === answer.body);
    check(prefix("全选报告当前气泡并关闭菜单"), status.text === "已全选当前气泡正文" && !status.error && state.menu === null);
    opened = open(answer.body); findByText(opened.menu, "复制").dispatch("click");
    equal(prefix("全选后重新右键可复制整个正文"), clipboard, answer.body.textContent);
    check(prefix("选择与复制保留气泡节点和正文"), answer.wrapper.parentNode === panel && answer.body.parentNode === answer.wrapper
      && user.body.textContent === "可见提问\n第二行");

    selection = collapsed();
    opened = open(receipt.body); findByText(opened.menu, "复制").dispatch("click");
    check(prefix("高亮右键复制可读回执，不复制候选 JSON"), clipboard === receipt.body.textContent && !clipboard.includes("内部 JSON"));
    s.util.copyText = () => false;
    opened = open(user.body); findByText(opened.menu, "复制").dispatch("click");
    check(prefix("剪贴板失败显示错误状态"), status.text === "复制失败" && status.error);
    selection = null;
    opened = open(user.body); findByText(opened.menu, "全选").dispatch("click");
    check(prefix("缺少 Selection 不声称已全选"), status.text.startsWith("全选失败") && status.error);

    const empty = view.bubble(state, { role: "user", content: "" }); panel.appendChild(empty.wrapper);
    opened = open(empty.body);
    check(prefix("空正文禁用复制"), findByText(opened.menu, "复制").disabled);
    doc.listeners.keydown[0]({ key: "Escape" });
    check(prefix("Escape 关闭菜单并移除文档监听"), !state.menu && ["pointerdown", "mousedown", "keydown", "scroll"].every((type) => !doc.listeners[type].length));
    opened = open(user.body);
    doc.listeners.mousedown[0]({ target: panel });
    check(prefix("点击菜单外仍可收起"), !state.menu && !findByClass(panel, "sl-menu"));
    open(user.body);
    doc.listeners.scroll[0]();
    check(prefix("滚动关闭右键菜单并移除监听"), !state.menu && !doc.listeners.scroll.length);
  } finally { s.util.copyText = copyBefore; s.readermenu.close(state); }
}
