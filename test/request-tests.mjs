/*
 * 请求边界回归：验证端点参数、会话保存失败反馈与异步取文期间的请求互斥。
 * 输入：已装载真实源码的假宿主、断言及 DOM 夹具；输出：检查结果。
 * 模型、取文和落盘故障均为确定替身；不操作用户文献或调用真实服务。
 */
export async function runRequestTests(h) {
  const { Sideline: s, Zotero: z, check, equal, sleep, makeRegularItem,
    makeAttachment, makeReaderShellDom, buildSidebarShell } = h;
  makeRegularItem({ id: 100040, fields: { title: "请求边界回归" } });
  makeAttachment({ id: 100041, parentID: 100040 });
  const doc = makeReaderShellDom();
  buildSidebarShell(doc);
  const state = s.readerside.attach({ itemID: 100041, type: "pdf", tabID: "request-boundaries",
    _iframeWindow: { document: doc },
    _internalReader: { toggleSidebar: () => doc.body.classList.add("sidebar-open") } });
  await sleep(20);
  const before = {
    chat: s.providers.chat, abort: s.providers.abort, page: s.readertext.page,
    flush: s.store.flush, flushItem: s.store.flushItem, saveError: s.store.saveError,
    channel: z.Prefs.get("sideline.textChannel"), persist: z.Prefs.get("sideline.persistSessions"),
    endpointsRegistered: !!z.Server.Endpoints["/sideline/chat"],
  };
  let modelCalls = 0;
  const prefix = (name) => `request-boundary: ${name}`;
  try {
    if (!before.endpointsRegistered) s.endpoints.register();
    z.Prefs.set("sideline.textChannel", "api");
    z.Prefs.set("sideline.persistSessions", true);
    s.providers.chat = async () => {
      modelCalls++;
      return { content: "合成回答", provider: "api", model: "fixture",
        usage: { prompt_tokens: 11, completion_tokens: 6 } };
    };

    const endpoint = new z.Server.Endpoints["/sideline/chat"]();
    const beforeInvalid = modelCalls;
    for (const maxTokens of [1.5, 0, -1, null, "12junk", "", "1e309"]) {
      const [status, , body] = await endpoint.init({ data: { itemID: state.ownerID,
        question: "预算校验", mode: "metadata", maxTokens } });
      equal(prefix(`端点拒绝非法预算 ${JSON.stringify(maxTokens)}`), status, 400);
      check(prefix(`非法预算保留可读原因 ${JSON.stringify(maxTokens)}`), JSON.parse(body).error.includes("正整数"));
    }
    equal(prefix("非法预算不请求模型"), modelCalls, beforeInvalid);
    for (const maxTokens of [32, "32"]) {
      const [status] = await endpoint.init({ data: { itemID: state.ownerID,
        question: "有效预算", mode: "metadata", maxTokens } });
      equal(prefix(`端点保留有效预算 ${JSON.stringify(maxTokens)}`), status, 200);
    }
    // 模型上限仍由客户端按当前模型执行，端点不能用自己的取整绕过。
    const oldValidate = s.client.validateTokens;
    try {
      s.client.validateTokens = () => { throw new Error("最大输出 tokens 超过当前模型上限"); };
      const beforeLimit = modelCalls;
      const [status] = await endpoint.init({ data: { itemID: state.ownerID,
        question: "超过模型上限", mode: "metadata", maxTokens: 32 } });
      equal(prefix("端点沿用客户端模型上限"), status, 400);
      equal(prefix("超过模型上限不请求模型"), modelCalls, beforeLimit);
    } finally { s.client.validateTokens = oldValidate; }

    const flushedOwners = [];
    s.store.flush = async () => { throw new Error("不应依赖全库保存结果"); };
    s.store.flushItem = async (ownerID) => { flushedOwners.push(ownerID); return false; };
    s.store.saveError = () => "合成磁盘故障";
    state.els.textarea.value = "保存失败反馈";
    await s.readerside.send(state);
    check(prefix("回答生成成功而保存失败时保留回答"), s.session.list(state.ownerID).at(-1).content === "合成回答");
    check(prefix("保存失败显示本篇实际原因"), state.els.statusEl.textContent.includes("合成磁盘故障")
      && state.els.statusEl.classList.contains("sideline-error"));
    check(prefix("保存只核验本篇且不重复请求模型"), flushedOwners.length === 1
      && flushedOwners[0] === state.ownerID && modelCalls === beforeInvalid + 3);
    equal(prefix("统一兼容 chat-completions 用量字段"), s.session.totals(state.ownerID).tokens, 17);
    z.Prefs.set("sideline.persistSessions", false);
    state.els.textarea.value = "关闭保存";
    await s.readerside.send(state);
    equal(prefix("关闭会话保存不尝试落盘"), flushedOwners.length, 1);
    check(prefix("关闭保存不冒充写入失败"), !state.els.statusEl.textContent.includes("保存失败"));
    z.Prefs.set("sideline.persistSessions", true);
    s.store.flushItem = async () => { throw new Error("合成队列异常"); };
    state.els.textarea.value = "保存队列异常";
    await s.readerside.send(state);
    check(prefix("保存抛异常仍保留回答并反馈实际原因"), s.session.list(state.ownerID).at(-1).content === "合成回答"
      && state.els.statusEl.textContent.includes("合成队列异常") && !state.busy);
    s.store.flush = before.flush;
    s.store.flushItem = before.flushItem;
    s.store.saveError = before.saveError;

    const beforeEmpty = modelCalls;
    state.els.textarea.value = "";
    await s.readerside.send(state);
    check(prefix("空输入不占用请求或影响下一次发送"), !state.busy && modelCalls === beforeEmpty);

    let releasePage;
    let pageCalls = 0;
    s.readertext.page = () => {
      pageCalls++;
      return new Promise((resolve) => { releasePage = resolve; });
    };
    const page = { state: "ok", pageIndex: 0, label: "1", spans: [{ str: "合成页正文" }] };
    state.materials = [];
    state.els.textarea.value = "异步准备材料";
    const beforePreparing = modelCalls;
    const first = s.readerside.send(state, { functionId: "explain" });
    check(prefix("材料准备期间已占用请求"), state.busy && pageCalls === 1);
    await s.readerside.send(state, { functionId: "explain" });
    equal(prefix("重复发送不再次取文"), pageCalls, 1);
    equal(prefix("取文完成前不请求模型"), modelCalls, beforePreparing);
    releasePage(page);
    await first;
    equal(prefix("取文完成只请求一次模型"), modelCalls, beforePreparing + 1);
    check(prefix("请求结束释放忙碌状态"), !state.busy && !state.requestKey);

    const abortKeys = [];
    s.providers.abort = (key) => abortKeys.push(key);
    state.materials = [];
    state.els.textarea.value = "准备阶段停止";
    const stopped = s.readerside.send(state, { functionId: "explain" });
    state.els.stopButton.dispatch("click");
    equal(prefix("准备阶段停止不取消其他文献"), abortKeys.length, 0);
    releasePage(page);
    await stopped;
    equal(prefix("准备阶段停止不发出模型请求"), modelCalls, beforePreparing + 1);
    check(prefix("准备阶段停止保留输入并释放状态"), state.els.textarea.value === "准备阶段停止"
      && !state.busy && !state.aborted && state.els.statusEl.textContent.includes("已停止"));
  } finally {
    if (!before.endpointsRegistered) s.endpoints.unregister();
    s.providers.chat = before.chat;
    s.providers.abort = before.abort;
    s.readertext.page = before.page;
    s.store.flush = before.flush;
    s.store.flushItem = before.flushItem;
    s.store.saveError = before.saveError;
    z.Prefs.set("sideline.textChannel", before.channel);
    z.Prefs.set("sideline.persistSessions", before.persist);
  }
}
