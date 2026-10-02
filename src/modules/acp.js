/*
 * Zotero Sideline：ACP v1 JSON-RPC 客户端。
 * 输入：已验证启动描述、文字/图片 prompt；输出：模型/配置枚举及流式回答。
 * 依赖：proc.js；不提供文件与终端能力，权限请求默认拒绝，未知反向请求返回方法不存在。
 */
Sideline.acp = (function () {
  function values(option) {
    const out = [];
    for (const entry of (option && option.options) || []) {
      if (Array.isArray(entry.options)) out.push(...entry.options);
      else out.push(entry);
    }
    return out;
  }
  function catalog(session) {
    const configs = session.configOptions || [];
    const modelOption = configs.find((entry) => entry.category === "model" || entry.id === "model");
    const effortOption = configs.find((entry) => entry.category === "thought_level"
      || /reasoning|effort|thinking/i.test(entry.id));
    const models = modelOption ? values(modelOption).map((entry) => ({ id: entry.value,
      name: entry.name || entry.value, efforts: [] }))
      : ((session.models && session.models.availableModels) || []).map((entry) => ({
        id: entry.modelId, name: entry.name || entry.modelId, efforts: [] }));
    // 思考强度仅属于当前模型；切换模型后必须重新枚举，不能分发给整个模型列表。
    const current = modelOption ? modelOption.currentValue : session.models && session.models.currentModelId;
    const selected = models.find((entry) => entry.id === current);
    if (selected && effortOption) selected.efforts = values(effortOption).map((entry) => String(entry.value));
    return { models, currentModel: current || "", modelOption, effortOption, configs };
  }
  async function connect(install, options = {}) {
    let sequence = 0, buffer = "", closed = false, handle = null;
    const pending = new Map();
    const toolCalls = new Map();
    const tools = Sideline.util.windowTools();
    let sendQueue = Promise.resolve();
    function send(message) {
      sendQueue = sendQueue.then(() => handle.write(JSON.stringify(message) + "\n"));
      return sendQueue;
    }
    function rejectAll(error) {
      closed = true;
      for (const entry of pending.values()) { if (entry.timer) tools.clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
    }
    function dispatch(message) {
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (entry.timer) tools.clearTimeout(entry.timer);
        if (message.error) {
          const error = new Error(`ACP ${entry.method}：${Sideline.agents.diagnostic(message.error.message || "协议错误")}`);
          error.rpcCode = message.error.code;
          entry.reject(error);
        } else entry.resolve(message.result || {});
        return;
      }
      if (message.method === "session/request_permission" && message.id !== undefined) {
        const params = message.params || {}, requested = params.toolCall || {};
        const known = toolCalls.get(`${params.sessionId}|${requested.toolCallId}`);
        const call = known || requested;
        const grant = Sideline.agentweb.permission(call, params.options, options.allowWeb);
        void send({ jsonrpc: "2.0", id: message.id, result: { outcome: grant
          ? { outcome: "selected", optionId: grant.optionId } : { outcome: "cancelled" } } })
          .catch((error) => rejectAll(error));
        return;
      }
      if (message.id !== undefined) {
        void send({ jsonrpc: "2.0", id: message.id, error: { code: -32601,
          message: "Sideline 不提供文件、命令执行或其他外部操作" } }).catch((error) => rejectAll(error));
        return;
      }
      if (message.method === "session/update" || (install.type === "dsh" && message.method === "sideline/assistant-stream")) {
        const params = message.params || {}, update = params.update || {};
        if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
          const key = `${params.sessionId}|${update.toolCallId}`;
          if (toolCalls.size > 1000) toolCalls.clear();
          toolCalls.set(key, Object.assign({}, toolCalls.get(key) || {}, update));
        }
        if (options.onUpdate) options.onUpdate(params);
      }
    }
    handle = await Sideline.proc.start(install.command, install.args.concat(install.acpArgs || (install.type === "dsh"
      ? ["--profile", "acp"] : ["acp"])), {
      environment: install.environment, cwd: options.cwd, timeoutMs: options.timeoutMs || 180000,
      onStdout(chunk) {
        buffer += chunk;
        if (buffer.length > 8 * 1024 * 1024) { rejectAll(new Error("ACP 协议行过长")); if (handle) handle.cancel(); return; }
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line) continue;
          try { dispatch(JSON.parse(line)); }
          catch (_) { rejectAll(new Error("ACP stdout 不是有效 JSON-RPC，协议无法启动")); if (handle) handle.cancel(); }
        }
      },
    });
    handle.done.then((result) => {
      rejectAll(new Error(result.timedOut ? "Agent 进程超时" : result.cancelled ? "请求已停止"
        : `Agent 进程退出（退出码 ${result.exitCode}）${Sideline.agents.diagnostic(result.stderr)}`));
    }, rejectAll);
    function request(method, params, timeoutMs = 30000) {
      if (closed) return Promise.reject(new Error("ACP 连接已关闭"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = tools.setTimeout(() => {
          pending.delete(id); reject(new Error(`ACP ${method} 超时`)); handle.cancel();
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        void send({ jsonrpc: "2.0", id, method, params }).catch((error) => { rejectAll(error); handle.cancel(); });
      });
    }
    const client = { request, notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
      close() { handle.cancel(); }, done: handle.done,
      cancel(sessionId) {
        const timer = tools.setTimeout(() => handle.cancel(), 200);
        void send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
          .catch(() => {}).finally(() => { tools.clearTimeout(timer); handle.cancel(); });
      }, snapshot: handle.snapshot };
    if (options.onConnect) options.onConnect(client);
    try {
      client.initialized = await request("initialize", { protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "zotero-sideline", version: pluginVersion } });
      if (client.initialized.protocolVersion !== 1) throw new Error("不支持的 ACP 协议版本");
      return client;
    } catch (error) { client.close(); throw error; }
  }
  async function newSession(client, cwd) {
    return client.request("session/new", { cwd, mcpServers: [] }, 45000);
  }
  async function selectModel(client, session, model) {
    let info = catalog(session);
    if (!model) return session;
    if (!info.models.some((entry) => entry.id === model)) throw new Error(`原模型 ${model} 已失效或未由 Agent 返回，请重新选择模型`);
    if (info.currentModel !== model) {
      const response = info.modelOption
        ? await client.request("session/set_config_option", { sessionId: session.sessionId, configId: info.modelOption.id, value: model })
        : await client.request("session/set_model", { sessionId: session.sessionId, modelId: model });
      if (response.configOptions) session.configOptions = response.configOptions;
      if (session.models) session.models.currentModelId = model;
    }
    return session;
  }
  async function selectEffort(client, session, effort) {
    if (!effort) return;
    const info = catalog(session);
    if (!info.effortOption || !values(info.effortOption).some((entry) => entry.value === effort)) {
      throw new Error(`当前模型不支持思考强度 ${effort}，请重新选择`);
    }
    await client.request("session/set_config_option", { sessionId: session.sessionId,
      configId: info.effortOption.id, value: effort });
  }
  return { connect, catalog, values, newSession, selectModel, selectEffort };
})();
