/*
 * 流式去重回归：通过真实侧栏发送路径观察解析次数、最终气泡与会话内容。
 * 输入：假宿主、阅读器构造器及独立 VM 的 Date；输出：断言结果。模型响应和时间均为确定的替身。
 * 不使用真实模型、用户文献或真实 Zotero；测试结束恢复渲染器、时钟与通道首选项。
 */
export async function runStreamRenderTests(h) {
  const { Sideline: s, Zotero: z, check, equal, sleep, findByClass,
    makeReaderShellDom, buildSidebarShell, makeRegularItem, makeAttachment, clock } = h;
  makeRegularItem({ id: 100030, fields: { title: "流式渲染专项" } });
  makeAttachment({ id: 100031, parentID: 100030 });
  const doc = makeReaderShellDom(); buildSidebarShell(doc);
  const state = s.readerside.attach({ itemID: 100031, type: "pdf", tabID: "stream-render-fixture",
    _iframeWindow: { document: doc }, _internalReader: { toggleSidebar: () => doc.body.classList.add("sidebar-open") } });
  await sleep(20);
  const oldChat = s.providers.chat, oldRender = s.citations.render, oldNow = clock.now;
  const oldChannel = z.Prefs.get("sideline.textChannel");
  let now = oldNow(), modelCalls = 0, rendered = [];
  const input = "流式样本 $x^2$", changed = input + "，补充", last = changed + "。";
  s.citations.render = (...args) => { rendered.push(args[0]); return oldRender(...args); };
  clock.now = () => now;
  z.Prefs.set("sideline.textChannel", "api");
  const prefix = (name) => `stream-render: ${name}`;
  const delta = (options, text, elapsed) => { now += elapsed; options.onDelta("", text); };
  const run = async (chat) => {
    s.session.clear(state.ownerID); rendered = [];
    s.providers.chat = async (options) => { modelCalls++; return chat(options); };
    state.els.textarea.value = "验证流式输出";
    await s.readerside.send(state, {});
  };
  try {
    await run((options) => {
      delta(options, input, 200);
      equal(prefix("首个正文立即解析一次"), rendered.filter((x) => x === input).length, 1);
      delta(options, input, 200);
      equal(prefix("超过节流间隔的重复正文不再解析"), rendered.filter((x) => x === input).length, 1);
      delta(options, " \n" + input + " \n", 200);
      equal(prefix("原始文本不同但实际显示相同也去重"), rendered.filter((x) => x === input).length, 1);
      delta(options, changed, 1);
      equal(prefix("重复事件不占用下一次有效刷新间隔"), rendered.filter((x) => x === changed).length, 1);
      delta(options, last, 10);
      equal(prefix("新正文仍受120毫秒节流"), rendered.filter((x) => x === last).length, 0);
      delta(options, last, 120);
      equal(prefix("此前被节流的新正文随后可以显示"), rendered.filter((x) => x === last).length, 1);
      return { content: last, provider: "api", model: "fixture" };
    });
    equal(prefix("成功结束仍按最终正文重渲染"), rendered.filter((x) => x === last).length, 2);
    equal(prefix("成功入库存完整最新正文"), s.session.list(state.ownerID).at(-1).content, last);
    check(prefix("最终正文仍显示KaTeX"), findByClass(state.els.messagesEl.children.at(-1), "sideline-text").innerHTML.includes("katex"));
    await run((options) => {
      delta(options, input, 200); delta(options, input, 200);
      equal(prefix("失败请求也跳过重复解析"), rendered.filter((x) => x === input).length, 1);
      throw new Error("确定的流式失败");
    });
    check(prefix("失败后不残留生成气泡或忙碌状态"), !state.busy
      && !s.session.list(state.ownerID).some((m) => m.role === "assistant")
      && state.els.statusEl.textContent.includes("确定的流式失败"));
    await run((options) => {
      delta(options, input, 200); delta(options, input, 200);
      equal(prefix("新请求重新渲染相同首段，不跨请求去重"), rendered.filter((x) => x === input).length, 1);
      delta(options, changed, 1); delta(options, last, 1);
      state.aborted = true; throw new Error("aborted");
    });
    check(prefix("停止保存被节流的最新部分正文"), s.session.list(state.ownerID).at(-1).stopped
      && s.session.list(state.ownerID).at(-1).content === last);
    check(prefix("停止后的气泡使用完整部分正文重新渲染"), rendered.includes(last) && !state.busy);
    await run((options) => { delta(options, input, 200); return { content: input, provider: "api", model: "fixture" }; });
    equal(prefix("停止后再次发送仍有流式和最终渲染"), rendered.filter((x) => x === input).length, 2);
    equal(prefix("成功、失败、停止及重发各仅一次模型请求"), modelCalls, 4);
  } finally {
    s.providers.chat = oldChat; s.citations.render = oldRender; clock.now = oldNow;
    z.Prefs.set("sideline.textChannel", oldChannel);
  }
}
