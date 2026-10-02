/*
 * Zotero Sideline：OpenCode / DeepSeek Harness 的共用 ACP 适配器。
 * 输入：验证后的安装、模型配置及文字/图片；输出：分阶段检测或回答。依赖：acp、proc、agents、agentimages。
 * 工作目录固定为插件自己的空目录；材料经 stdin 发送，不授权文件或终端工具。
 */
Sideline.agentacp = (function () {
  async function cwd() {
    const path = Sideline.agentinstall.join(Sideline.jsonfile.directory(),
      `agent-work/diagnostic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await Zotero.File.createDirectoryIfMissingAsync(path);
    return path;
  }
  async function open(install, options = {}) {
    const directory = options.cwd || await cwd();
    const prepared = await Sideline.agentweb.setup(install, !!options.allowWeb, directory, options.model || "");
    const client = await Sideline.acp.connect(prepared, Object.assign({}, options, { cwd: directory }));
    try {
      let session;
      if (options.sessionId) {
        const caps = client.initialized.agentCapabilities || {};
        const method = caps.sessionCapabilities && caps.sessionCapabilities.resume ? "session/resume"
          : caps.loadSession ? "session/load" : "";
        try {
          if (!method) throw new Error("当前 Agent 不支持恢复已存会话");
          session = await client.request(method, { sessionId: options.sessionId, cwd: directory, mcpServers: [] });
          session.sessionId = options.sessionId;
        } catch (error) { error.resumeFailed = true; throw error; }
      } else session = await Sideline.acp.newSession(client, directory);
      if (!session.sessionId) throw new Error("ACP 未返回 sessionId");
      return { client, session, directory };
    } catch (error) { client.close(); throw error; }
  }
  async function listModels(install, options = {}) {
    const { client, session, directory } = await open(install, { timeoutMs: 45000 });
    try {
      // 切换安装时，上一 Agent 的模型 ID 可能无效；仍应返回目录，交给设置页提示重新选择。
      if (options.model && Sideline.acp.catalog(session).models.some((model) => model.id === options.model)) {
        await Sideline.acp.selectModel(client, session, options.model);
      }
      return Sideline.acp.catalog(session).models;
    } finally {
      client.close(); await client.done.catch(() => {});
      await discard(install, { sessionId: session.sessionId, cwd: directory }).catch((e) => Sideline.util.warn(e.message));
    }
  }
  async function probe(install, state) {
    const initializedHome = Sideline.jsonfile.exists(Sideline.agentinstall.join(Sideline.agentinstall.env("USERPROFILE"), ".dsh"));
    if (install.type === "dsh" && !initializedHome) {
      state.stages.protocol = "not-tested";
      state.stages.models = "not-tested";
      state.error = "首次 ACP 启动可能初始化 ~/.dsh；真实测试前请阅读初始化提示";
      return state;
    }
    try {
      const { client, session, directory } = await open(install, { timeoutMs: 45000 });
      try {
        state.stages.protocol = "pass";
        state.models = Sideline.acp.catalog(session).models;
        state.currentModel = Sideline.acp.catalog(session).currentModel;
        state.stages.models = state.models.length ? "pass" : "empty";
        state.authentication = "session-ready";
        state.stages.authentication = "session-ready";
      } finally {
        client.close(); await client.done.catch(() => {});
        await discard(install, { sessionId: session.sessionId, cwd: directory }).catch((e) => Sideline.util.warn(e.message));
      }
    } catch (error) {
      state.error = Sideline.agents.diagnostic(error.message);
      if (/auth|login|credential|登录|凭据|401|403/i.test(state.error)) {
        state.authentication = "required"; state.stages.authentication = "required";
      }
      state.stages.protocol = "fail";
    }
    return state;
  }
  async function run(install, options) {
    let content = "", connection = null, sessionId = "", cancelled = false, accepting = false, selectedModel = options.model || "";
    const webTools = new Map();
    let live = "", attemptId = "", bridgeActive = false;
    const publish = (piece = "") => { if (options.onDelta) options.onDelta(piece, content + live); };
    const control = { cancel() { cancelled = true; if (connection) connection.cancel(sessionId); } };
    if (options.onStart) options.onStart(control);
    let opened;
    try {
      opened = await open(install, { timeoutMs: options.timeoutMs, cwd: options.cwd, sessionId: options.sessionId,
        model: options.model,
        allowWeb: !!options.search,
        onConnect(client) { connection = client; if (cancelled) client.close(); },
        onUpdate(params) {
          // session/load 会重放历史；恢复阶段不把旧回答当成本轮流式内容。
          if (!accepting) return;
          if (sessionId && params.sessionId !== sessionId) return;
          const update = params.update || {};
          if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
            const old = webTools.get(update.toolCallId) || {};
            webTools.set(update.toolCallId, { name: update.title || old.name || "", status: update.status || old.status || "" });
          }
          if (install.type === "dsh" && update.sessionUpdate === "sideline_stream") {
            if (update.phase === "start" && typeof update.attemptId === "string") {
              bridgeActive = true; attemptId = update.attemptId; live = ""; publish();
            } else if (bridgeActive && update.attemptId === attemptId && typeof update.text === "string") {
              if (update.phase === "delta") { live += update.text; publish(update.text); }
              else if (update.phase === "commit") { content += update.text; live = ""; publish(); }
            }
            return;
          }
          // 桥接预览来自实时事件；标准 ACP 完成消息只在无桥接时使用，防止重复正文。
          if (!bridgeActive && update.sessionUpdate === "agent_message_chunk" && update.content && update.content.type === "text") {
            const piece = update.content.text || ""; content += piece;
            if (options.onDelta) options.onDelta(piece, content);
          }
        } });
      sessionId = opened.session.sessionId;
      if (options.onSession) await options.onSession(sessionId);
      if (cancelled) throw new Error("请求已停止");
      await Sideline.acp.selectModel(connection, opened.session, options.model || "");
      selectedModel = Sideline.acp.catalog(opened.session).currentModel;
      await Sideline.acp.selectEffort(connection, opened.session, options.effort || "");
      const imageBlocks = Sideline.agentimages.blocks(options.images || []);
      const caps = connection.initialized.agentCapabilities || {};
      if (imageBlocks.length && caps.promptCapabilities?.image === false) {
        throw new Error(`当前 ${install.name || install.type} 未声明支持图片，请选择支持视觉的 Agent 与模型`);
      }
      const modes = opened.session.modes && opened.session.modes.availableModes || [];
      if (install.type === "opencode" && modes.some((entry) => entry.id === "plan")) {
        await connection.request("session/set_mode", { sessionId, modeId: "plan" });
      }
      accepting = true;
      if (options.onPrompt) await options.onPrompt();
      const result = await connection.request("session/prompt", { sessionId,
        prompt: [{ type: "text", text: options.prompt }, ...imageBlocks] }, options.timeoutMs || 180000);
      if (cancelled || result.stopReason === "cancelled") throw new Error("请求已停止");
      if (result.stopReason && !["end_turn", "max_tokens"].includes(result.stopReason)) {
        throw new Error(`Agent 停止原因：${result.stopReason}`);
      }
      if (!content.trim()) throw new Error("Agent 返回空回答");
      return { content: content.trim(), model: Sideline.acp.catalog(opened.session).currentModel,
        usage: result.usage || null, protocol: "acp", streamed: !!options.onDelta,
        sessionId, webTools: [...webTools.values()] };
    } catch (error) {
      const wrapped = new Error(Sideline.agents.diagnostic(error.message));
      wrapped.partialContent = content + live; wrapped.cancelled = cancelled;
      wrapped.model = selectedModel;
      wrapped.resumeFailed = error.resumeFailed;
      throw wrapped;
    } finally {
      if (connection) {
        const caps = connection.initialized && connection.initialized.agentCapabilities || {};
        if (sessionId && caps.sessionCapabilities && caps.sessionCapabilities.close) {
          await connection.request("session/close", { sessionId }, 10000).catch(() => {});
        }
        connection.close(); await connection.done.catch(() => {});
        if (options.diagnostic && opened && sessionId) {
          await discard(install, { sessionId, cwd: opened.directory }).catch((e) => Sideline.util.warn(e.message));
        }
      }
    }
  }
  async function create(install, options) {
    const { client, session } = await open(install, { cwd: options.cwd, allowWeb: !!options.search, model: options.model });
    try {
      await Sideline.acp.selectModel(client, session, options.model || "");
      await Sideline.acp.selectEffort(client, session, options.effort || "");
      return session.sessionId;
    } finally {
      const caps = client.initialized.agentCapabilities || {};
      if (caps.sessionCapabilities && caps.sessionCapabilities.close) {
        await client.request("session/close", { sessionId: session.sessionId }, 10000).catch(() => {});
      }
      client.close(); await client.done.catch(() => {});
    }
  }
  async function discard(install, binding) {
    if (install.type === "opencode") {
      const prepared = await Sideline.agentweb.setup(install, false);
      const result = await Sideline.proc.run(prepared.command, prepared.args.concat(["session", "delete", binding.sessionId]),
        { cwd: binding.cwd, environment: prepared.environment, timeoutMs: 30000 });
      if (result.exitCode !== 0 && !/not found|does not exist/i.test(result.stdout + result.stderr)) {
        throw new Error(`OpenCode 旧会话删除失败：${Sideline.agents.diagnostic(result.stderr)}`);
      }
    } else {
      // DSH 的固定 patch 把该文献的会话存储放在插件自有目录，禁止删除 ~/.dsh。
      const expected = Sideline.agentinstall.join(binding.cwd, "dsh-memory");
      const root = Sideline.agentinstall.join(Sideline.jsonfile.directory(), "agent-work");
      if (!binding.cwd.startsWith(root + (/^[A-Za-z]:/.test(root) ? "\\" : "/"))) throw new Error("拒绝清理插件目录之外的 Agent 记忆");
      const file = Zotero.File.pathToFile(Sideline.jsonfile.nativePath(expected));
      if (file.exists()) {
        const parent = Zotero.File.pathToFile(Sideline.jsonfile.nativePath(binding.cwd));
        if (parent.isSymlink && parent.isSymlink()) throw new Error("拒绝清理符号链接工作目录");
        if (file.isSymlink && file.isSymlink()) throw new Error("拒绝清理符号链接记忆目录");
        file.remove(true);
      }
    }
  }
  return { probe, listModels, run, create, discard, cancel: (control) => control.cancel() };
})();
