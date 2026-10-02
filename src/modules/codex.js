/*
 * Zotero Sideline：Codex provider（本机 CLI 接入）。
 * 功能：定位本机 Codex CLI、查询版本、以按明确会话 ID 恢复对话并解析 JSONL 事件流。
 * 依赖：modules/proc.js；首选项 codexPath / codexModel / codexEffort / codexTimeoutMs。
 * 说明：默认参数为「只读沙箱 + 不请求审批 + 跳过 git 检查；正常对话持久化，仅诊断临时」，
 *       避免 Codex 修改文件或在 GUI 场景里等待人工确认；prompt 走 stdin，
 *       绕开 Windows 命令行长度上限（整篇文献上下文会远超上限）。
 */

Sideline.codex = (function () {
  // 常见安装位置；%APPDATA% 之类在运行时展开。npm 的 codex.cmd 是批处理包装，
  // Subprocess 无法直接执行，因此指向 vendor 目录下的原生可执行文件。
  const CANDIDATES = [
    "%APPDATA%\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
    "%USERPROFILE%\\.codex\\bin\\codex.exe",
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ];

  function expandEnv(path) {
    return String(path).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => {
      try {
        const value = Services.env.get(name);
        return value === undefined || value === null ? match : value;
      }
      catch (error) {
        return match;
      }
    });
  }

  /** @returns {string} 可执行文件绝对路径；找不到时返回空串 */
  function executable() {
    const configured = Sideline.config.str("codexPath").trim();
    if (configured && Sideline.jsonfile.exists(configured)) return configured;
    for (const candidate of CANDIDATES) {
      const path = expandEnv(candidate);
      if (Sideline.jsonfile.exists(path)) return path;
    }
    return "";
  }

  function baseArgs(options = {}) {
    const args = options.search ? ["--search"] : [];
    args.push("exec", "--sandbox", "read-only");
    const cwd = options.cwd || (Zotero.DataDirectory && Zotero.DataDirectory.dir) || "";
    if (cwd) args.push("-C", cwd);
    if (options.sessionId) args.push("resume", options.sessionId);
    args.push("--json", "--skip-git-repo-check");
    if (options.diagnostic) args.push("--ephemeral");
    const model = String(options.model !== undefined ? options.model : Sideline.config.str("codexModel")).trim();
    if (model) args.push("-m", model);
    args.push("-c", "approval_policy=never");
    // 只保留文献问答和可选 web_search；禁用 shell、插件工具、MCP 与子 Agent。
    args.push("-c", "features.shell_tool=false", "-c", "features.plugins=false",
      "-c", "features.multi_agent=false", "-c", "mcp_servers={}");
    if (!options.search) args.push("-c", 'web_search="disabled"');
    const effort = String(options.effort !== undefined ? options.effort : Sideline.config.str("codexEffort")).trim();
    if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
    for (const path of options.imagePaths || []) args.push("--image", path);
    args.push("-");
    return args;
  }

  /**
   * 从单个 JSONL 事件里取出新增文本。
   * schema 以本机实测为准（codex-cli 0.154.0，2026-09-29 探测）：
   *   {"type":"thread.started","thread_id":"…"}
   *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"…"}}
   *   {"type":"item.completed","item":{"type":"error","message":"…"}}
   *   {"type":"turn.started"}
   *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
   * 其余形状做保守兼容，便于将来版本变化时仍能取到文本。
   */
  function extractDelta(event) {
    if (!event || typeof event !== "object") return "";
    if (event.type === "item.completed" && event.item
      && event.item.type === "agent_message" && typeof event.item.text === "string") {
      return event.item.text;
    }
    if (event.type === "agent_message" && typeof event.message === "string") return event.message;
    const nested = event.msg || event.message;
    if (nested && typeof nested === "object") {
      if (nested.type === "agent_message" && typeof nested.message === "string") return nested.message;
      if (typeof nested.delta === "string") return nested.delta;
    }
    if (typeof event.delta === "string") return event.delta;
    return "";
  }

  /** 汇总一次执行的事件：正文、用量、线程 ID 与错误项 */
  function summarize(events) {
    const summary = { content: "", usage: null, threadId: "", errors: [] };
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      if (event.type === "thread.started" && event.thread_id) summary.threadId = String(event.thread_id);
      if (event.type === "turn.completed" && event.usage) summary.usage = event.usage;
      const item = event.item;
      if (event.type === "turn.failed" || event.type === "error") {
        summary.errors.push(String((event.error && event.error.message) || event.message || "Codex 请求失败"));
      }
      if (item && item.type === "error") {
        summary.errors.push(String(item.message || "未知错误"));
      }
      const delta = extractDelta(event);
      if (delta) summary.content += delta;
    }
    summary.content = summary.content.trim();
    return summary;
  }

  function createParser(onEvent, onDelta) {
    let buffer = "";
    let content = "";
    const events = [];

    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      let event = null;
      try {
        event = JSON.parse(text);
      }
      catch (error) {
        events.push({ type: "unparsed", raw: text.slice(0, 200) });
        return;
      }
      events.push(event);
      if (onEvent) {
        try {
          onEvent(event);
        }
        catch (error) {
          Sideline.util.error(error);
        }
      }
      const delta = extractDelta(event);
      if (delta) {
        content += delta;
        if (onDelta) {
          try {
            onDelta(delta, content);
          }
          catch (error) {
            Sideline.util.error(error);
          }
        }
      }
    };

    return {
      push(chunk) {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          handleLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      },
      flush() {
        if (buffer.trim()) handleLine(buffer);
        buffer = "";
        return { events, content };
      },
    };
  }

  /**
   * 执行一次请求。
   * @param {object} options prompt / images / model / effort / cwd / timeoutMs / onEvent / onDelta
   */
  async function run(installOrOptions = {}, suppliedOptions) {
    const install = suppliedOptions ? installOrOptions : await legacyInstall();
    const options = suppliedOptions || installOrOptions;
    const exe = install.command;
    if (!exe) {
      throw new Error("未找到 Codex 可执行文件，请在「设置 → Sideline」里填写 codexPath");
    }
    if (!Sideline.proc.available()) {
      throw new Error(`无法使用子进程：${Sideline.proc.unavailableReason() || "未知原因"}`);
    }
    let sessionSave = Promise.resolve();
    const parser = createParser((event) => {
      if (options.onEvent) options.onEvent(event);
      if (event.type === "thread.started" && event.thread_id && options.onSession) {
        sessionSave = sessionSave.then(() => options.onSession(String(event.thread_id)));
        sessionSave.catch(() => {});
      }
    }, options.onDelta);
    if (options.model) {
      const models = await listModels(install);
      const model = models.find((entry) => entry.id === options.model);
      if (!model) throw new Error(`原模型 ${options.model} 已失效或未在本机缓存中，请刷新模型`);
      if (options.effort && !model.efforts.includes(options.effort)) throw new Error(`模型不支持思考强度 ${options.effort}`);
    }
    const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : Sideline.config.num("codexTimeoutMs");
    const cwd = options.cwd || Sideline.agentinstall.join(Sideline.jsonfile.directory(), "agent-work");
    await Zotero.File.createDirectoryIfMissingAsync(cwd);
    const imageFiles = await Sideline.agentimages.files(options.images || [], cwd);
    let result;
    try {
      if (options.onPrompt) await options.onPrompt();
      result = await Sideline.proc.run(exe, baseArgs(Object.assign({}, options, { cwd, imagePaths: imageFiles.paths })), {
        stdinText: String(options.prompt == null ? "" : options.prompt),
        timeoutMs,
        onStdout: (chunk) => parser.push(chunk),
        onStart: options.onStart,
      });
    } finally { imageFiles.cleanup(); }
    const { events, content } = parser.flush();
    await sessionSave;
    const summary = summarize(events);
    const answer = content.trim() || summary.content;
    if (result.cancelled || result.timedOut || result.exitCode !== 0 || !answer
      || events.some((event) => event.type === "turn.failed")) {
      const error = new Error(Sideline.agents.diagnostic(result.cancelled ? "Codex 请求已停止"
        : result.timedOut ? "Codex 调用超时"
          : `Codex ${result.exitCode !== 0 ? `退出码 ${result.exitCode}` : "返回空回答或失败事件"}：${summary.errors.join("；")} ${result.stderr}`));
      error.partialContent = answer; error.cancelled = result.cancelled;
      error.resumeFailed = !!options.sessionId && !answer
        && /no session|session.*not found|failed to load.*session|could not find.*session/i.test(summary.errors.join(" ") + result.stderr);
      throw error;
    }
    return {
      executable: exe,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stderr: result.stderr,
      events,
      content: answer,
      model: options.model || "",
      usage: summary.usage,
      threadId: summary.threadId,
      errors: summary.errors,
    };
  }

  async function discard(install, binding) {
    // 只删除本插件记录的 UUID 所对应的 rollout；不改 Codex 的凭据、缓存或其它会话。
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.sessionId)) {
      throw new Error("拒绝删除无效的 Codex 会话 ID");
    }
    const root = Sideline.agentinstall.join(Sideline.agentinstall.env("USERPROFILE"), ".codex/sessions");
    for (let offset = -1; offset <= 1; offset++) {
      const date = new Date(binding.created + offset * 86400000).toISOString().slice(0, 10).replace(/-/g, "/");
      const directory = Sideline.agentinstall.join(root, date);
      if (!Sideline.jsonfile.exists(directory)) continue;
      const entries = Zotero.File.pathToFile(directory).directoryEntries;
      while (entries.hasMoreElements()) {
        const file = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
        if (!String(file.path).endsWith(`-${binding.sessionId}.jsonl`)) continue;
        if (file.isSymlink && file.isSymlink()) throw new Error("拒绝删除符号链接会话");
        const raw = await Zotero.File.getContentsAsync(file.path);
        const header = JSON.parse(String(raw).split("\n")[0]);
        if (header.type !== "session_meta" || header.payload.id !== binding.sessionId
          || Sideline.jsonfile.nativePath(header.payload.cwd) !== binding.cwd) throw new Error("Codex 会话来源校验失败，未删除");
        file.remove(false);
      }
    }
  }

  async function version() {
    const install = await legacyInstall();
    const exe = install.command;
    if (!exe) {
      throw new Error("未找到 Codex 可执行文件");
    }
    const result = await Sideline.proc.run(exe, ["--version"], { timeoutMs: 30000 });
    return {
      executable: exe,
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      procAvailable: Sideline.proc.available(),
    };
  }

  async function legacyInstall() {
    const exe = executable();
    if (!exe) throw new Error("未找到 Codex 可执行文件，请扫描本地 Agent");
    const normalized = exe.replace(/\\/g, "/");
    const npmIndex = normalized.indexOf("/node_modules/@openai/codex/");
    const root = npmIndex >= 0 ? normalized.slice(0, npmIndex) + "/node_modules/@openai/codex"
      : normalized.replace(/\/codex\.exe$/i, "");
    const install = await Sideline.agentinstall.validateInstall(root, "auto");
    if (install.type !== "codex" || install.command.replace(/\\/g, "/").toLowerCase() !== normalized.toLowerCase()) {
      throw new Error("旧 Codex 路径未通过白名单安装校验，请重新扫描");
    }
    return install;
  }
  async function listModels() {
    const path = Sideline.agentinstall.join(Sideline.agentinstall.env("USERPROFILE"), ".codex/models_cache.json");
    if (!Sideline.jsonfile.exists(path)) throw new Error("没有 Codex 模型缓存，请先在 Codex 中登录并刷新模型");
    const data = JSON.parse(await Zotero.File.getContentsAsync(path));
    return (data.models || []).filter((model) => model.visibility !== "hide" && model.slug)
      .map((model) => ({ id: model.slug, name: model.display_name || model.slug,
        efforts: (model.supported_reasoning_levels || []).map((level) => level.effort).filter(Boolean) }));
  }
  async function probe(install, state) {
    const login = await Sideline.proc.run(install.command, ["login", "status"], { timeoutMs: 15000 });
    const loggedIn = login.exitCode === 0 && /logged in|已登录/i.test(login.stdout + login.stderr);
    state.authentication = loggedIn ? "logged-in" : "required";
    state.stages.authentication = login.timedOut ? "timeout" : state.authentication;
    // exec --help 能离线验证 JSONL 参数入口；真实协议事件必须由最小请求验证。
    const protocol = await Sideline.proc.run(install.command, ["exec", "--help"], { timeoutMs: 15000 });
    state.stages.protocol = protocol.exitCode === 0 && /--json/.test(protocol.stdout) ? "pass" : "fail";
    try { state.models = await listModels(install); state.stages.models = state.models.length ? "pass" : "empty"; }
    catch (error) { state.stages.models = "fail"; state.error = Sideline.agents.diagnostic(error.message); }
    if (!loggedIn) state.error = "Codex 未确认登录，请在 CLI 中完成登录；不读取凭据文件";
    return state;
  }
  return { executable, baseArgs, extractDelta, summarize, run, discard, version, CANDIDATES, legacyInstall,
    discover: async () => (await Sideline.agentinstall.discover()).filter((entry) => entry.type === "codex"),
    validateInstall: Sideline.agentinstall.validateInstall, listModels, probe, cancel: (control) => control.cancel() };
})();
