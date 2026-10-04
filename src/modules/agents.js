/*
 * Zotero Sideline：统一 Agent 注册表。
 * 输入：用户扫描/添加/选择/检测/调用；输出：验证后的安装、分阶段诊断、模型及回答。
 * 依赖：白名单 agentinstall 与三种适配器。持久化的路径每次使用均重新校验；不读取凭据内容。
 */
Sideline.agents = (function () {
  const active = new Map();
  const observations = new Map();
  function adapters() { return { codex: Sideline.codex, opencode: Sideline.opencode, dsh: Sideline.dsh }; }
  function diagnostic(input) {
    let text = String(input || "").replace(/\x1b\[[0-9;]*m/g, "");
    for (const key of ["secretKey", "textSecretKey", "visionSecretKey"]) {
      const secret = Sideline.config.str(key); if (secret) text = text.split(secret).join("[已隐藏]");
    }
    if (/free tier can only be used from within OpenCode/i.test(text)) {
      text = "OpenCode 默认免费模型限制外部客户端调用；请在 OpenCode 中配置可供 ACP 使用的服务商并选择其模型。";
    }
    return text.replace(/(?:Bearer\s+)[^\s"']+/gi, "Bearer [已隐藏]")
      .replace(/\bsk-[A-Za-z0-9_-]+/g, "[已隐藏]")
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)\s*[=:]\s*)[^\s,;}]+/gi, "$1[已隐藏]")
      .slice(0, 1600);
  }
  function records() {
    try { const value = JSON.parse(Sideline.config.str("agentInstalls")); return Array.isArray(value) ? value : []; }
    catch (_) { return []; }
  }
  function save(list) {
    Sideline.config.set("agentInstalls", JSON.stringify(list.map(({ id, type, path, source, version }) => ({ id, type, path, source, version }))));
  }
  function display(install) { return `${install.name} · ${install.version || "版本待检测"} · ${install.path}${install.source === "manual" ? "（手动）" : ""}`; }
  async function validated(record) {
    const value = await Sideline.agentinstall.validateInstall(record.path, record.source);
    if (record.type && value.type !== record.type) throw new Error("安装类型发生变化，请重新扫描");
    return value;
  }
  async function list() {
    const out = [];
    for (const record of records()) {
      try { const install = await validated(record); if (!install.version) install.version = record.version || "";
        out.push(Object.assign(install, observations.get(install.id) || {})); }
      catch (error) { out.push(Object.assign({}, record, { name: Sideline.agentinstall.NAMES[record.type],
        status: "missing", error: diagnostic(error.message), models: [] })); }
    }
    return out;
  }
  async function discover() {
    const manual = [];
    for (const record of records().filter((entry) => entry.source === "manual")) {
      try { manual.push(await validated(record)); } catch (_) { /* 无效记录保留供用户移除 */ }
    }
    const found = Sideline.agentinstall.dedupe((await Sideline.agentinstall.discover()).concat(manual));
    for (const install of found) {
      try { const result = await version(install); install.version = result.version; install.error = result.error; }
      catch (error) { install.error = diagnostic(error.message); }
    }
    save(found.concat(records().filter((entry) => entry.source === "manual" && !manual.some((valid) => valid.id === entry.id))));
    if (!Sideline.config.str("agentInstallId") && found.length) {
      const preferred = Sideline.config.str("provider") === "codex" ? found.find((entry) => entry.type === "codex") : found[0];
      Sideline.config.set("agentInstallId", (preferred || found[0]).id);
    }
    return list();
  }
  async function add(path, { replaceDetected = false } = {}) {
    const install = await Sideline.agentinstall.validateInstall(path, "manual");
    if (replaceDetected) {
      // 设置页主动切换到手动路径：校验成功才丢弃旧扫描记录，失败仍保留原配置。
      const manual = (await list()).filter((entry) => entry.source === "manual" && entry.id !== install.id);
      // 持久记录不含 command/args，先验证后才能按原生入口去重；失效手动记录仅保留供诊断。
      save(Sideline.agentinstall.dedupe(manual.filter((entry) => entry.status !== "missing").concat(install))
        .concat(manual.filter((entry) => entry.status === "missing")));
      observations.clear();
      Sideline.config.set("agentInstallId", install.id);
      Sideline.config.set("agentModel", ""); Sideline.config.set("agentEffort", "");
      return install;
    }
    const prior = await list(), selectedId = Sideline.config.str("agentInstallId");
    const binaryKey = (entry) => `${entry.command.replace(/\\/g, "/").toLowerCase()}|${entry.args.join("|")}`;
    const selectedInstall = prior.find((entry) => entry.id === selectedId && entry.status !== "missing");
    const previous = prior.find((entry) => entry.status !== "missing" && binaryKey(entry) === binaryKey(install));
    if (!install.version && previous) install.version = previous.version;
    const merged = prior.filter((entry) => entry.id !== install.id && entry.status !== "missing");
    const saved = Sideline.agentinstall.dedupe(merged.concat(install));
    save(saved);
    // 同一个原生入口可能由不同目录识别；去重替换记录时同步映射，不能让当前选择悬空。
    if (!selectedId) Sideline.config.set("agentInstallId", install.id);
    else if (!saved.some((entry) => entry.id === selectedId) && selectedInstall) {
      const replacement = saved.find((entry) => binaryKey(entry) === binaryKey(selectedInstall));
      if (replacement) Sideline.config.set("agentInstallId", replacement.id);
    }
    return install;
  }
  function remove(id) {
    const record = records().find((entry) => entry.id === id);
    if (!record || record.source !== "manual") throw new Error("只能移除手动安装记录");
    save(records().filter((entry) => entry.id !== id)); observations.delete(id);
    if (Sideline.config.str("agentInstallId") === id) Sideline.config.set("agentInstallId", "");
  }
  function resetPaths() {
    // 只重置插件保存的路径及其能力选择，不删除程序、凭据或文献会话。
    save([]); observations.clear();
    for (const key of ["agentInstallId", "agentModel", "agentEffort"]) Sideline.config.set(key, "");
  }
  async function selected(config = Sideline.config.read()) {
    const id = config.agentInstallId;
    if (id) {
      const record = records().find((entry) => entry.id === id);
      if (!record) throw new Error("已选 Agent 安装记录失效，请重新扫描或选择");
      return validated(record);
    }
    // 0.8.3 的 Codex 用户保持可用；仅验证旧确定路径，不触发安装扫描。
    if (config.provider === "codex" && !Sideline.config.hasUserValue("agentInstallId")) return Sideline.codex.legacyInstall();
    throw new Error("尚未选择 Agent，请点击「扫描本地 Agent」或添加安装目录");
  }
  async function version(install) {
    const result = await Sideline.proc.run(install.command, install.args.concat("--version"), {
      environment: install.environment, timeoutMs: 15000 });
    const match = String(result.stdout).match(/\b\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?/);
    return { version: match ? match[0] : "", error: result.timedOut ? "读取版本超时"
      : result.exitCode !== 0 ? `读取版本失败（退出码 ${result.exitCode}）：${diagnostic(result.stderr)}`
        : !match ? "无法读取版本" : "" };
  }
  async function probe(id) {
    let install;
    try { install = id ? await validated(records().find((entry) => entry.id === id) || {}) : await selected(); }
    catch (error) { return { id, status: "missing", error: diagnostic(error.message), stages: { program: "fail" } }; }
    const state = Object.assign({}, install, { stages: { program: "pass", version: "not-tested",
      authentication: "unknown", protocol: "not-tested", models: "not-tested", request: "not-tested" }, lastProbe: new Date().toISOString() });
    try {
      const result = await version(install); state.version = result.version;
      state.stages.version = result.error ? "fail" : "pass";
      if (result.error) { state.error = result.error; state.status = "unavailable"; observations.set(install.id, state); return state; }
      await adapters()[install.type].probe(install, state);
    } catch (error) { state.error = diagnostic(error.message); }
    state.status = state.stages.authentication === "required" ? "authentication-required"
      : state.stages.protocol === "pass" ? "ready" : "unverified";
    observations.set(install.id, state); return state;
  }
  async function listModels(id, model = "") {
    const install = id ? await validated(records().find((entry) => entry.id === id) || {}) : await selected();
    const models = await adapters()[install.type].listModels(install, { model });
    const prior = observations.get(install.id) || {};
    observations.set(install.id, Object.assign({}, prior, { models, protocolModel: model }));
    return models;
  }
  function reconcile(models, model, effort) {
    const selectedModel = models.find((entry) => entry.id === model);
    return { model, effort: selectedModel && selectedModel.efforts.includes(effort) ? effort : "",
      efforts: selectedModel ? selectedModel.efforts : [], warning: model && !selectedModel
        ? `原模型 ${model} 已失效或未在最新列表中，请确认后重新选择` : "" };
  }
  async function run(options = {}) {
    const config = options.config || Sideline.config.read();
    const key = options.requestKey || `agent-${Date.now()}-${Math.random()}`;
    if (active.has(key)) throw new Error("该请求仍在运行");
    const state = { cancelled: false, control: null, ownerID: options.ownerID }; active.set(key, state);
    let finish;
    state.done = new Promise((resolve) => { finish = resolve; });
    try {
      const install = await selected(config);
      if (state.cancelled) { const error = new Error("请求已停止"); error.cancelled = true; error.partialContent = ""; throw error; }
      const model = config.agentModel !== undefined ? config.agentModel : (install.type === "codex" ? config.codexModel : "");
      const effort = config.agentEffort || "";
      const call = { prompt: options.prompt, images: options.images || [], messages: options.messages, ownerID: options.ownerID,
        diagnostic: !!options.diagnostic,
        rebuild: !!options.rebuild,
        onWarning: options.onWarning, model, effort,
        search: !!config.agentSearch, timeoutMs: config.agentTimeoutMs || config.codexTimeoutMs,
        onDelta: options.onDelta, onStart(control) { state.control = control; if (state.cancelled) control.cancel(); } };
      const result = options.diagnostic
        ? await adapters()[install.type].run(install, call)
        : await Sideline.agentconversation.execute(install, call);
      if (state.cancelled) throw new Error("请求已停止");
      return Object.assign({}, result, { provider: "agent", agentType: install.type,
        model: result.model || model || install.name, protocol: install.protocol });
    } finally { if (active.get(key) === state) active.delete(key); finish(); }
  }
  function cancelOwner(itemID) {
    const owner = Sideline.store ? Sideline.store.keyOf(itemID) : Number(itemID);
    for (const [key, state] of active) {
      const activeOwner = Sideline.store ? Sideline.store.keyOf(state.ownerID) : Number(state.ownerID);
      if (activeOwner === owner) cancel(key);
    }
  }
  function cancel(key) {
    for (const [id, state] of active) {
      if (key !== undefined && key !== null && id !== key) continue;
      state.cancelled = true; if (state.control) state.control.cancel();
    }
  }
  async function drain() { await Promise.all([...active.values()].map((state) => state.done)); }
  async function test(id, options = {}) {
    const previous = observations.get(id);
    const offline = await probe(id);
    if (!offline.stages || offline.stages.program !== "pass" || offline.stages.version !== "pass") throw new Error(offline.error || "离线检测未通过");
    const started = Date.now();
    const config = Object.assign({}, Sideline.config.read(), { agentInstallId: id });
    const state = Object.assign({}, offline, { stages: Object.assign({}, offline.stages), tests: {}, error: "" });
    // 连接检测会重建离线诊断，但同一版本、同一模型已核验的强度目录仍可供设置页恢复。
    if (previous?.protocolModel === config.agentModel && previous.version === offline.version) {
      state.models = previous.models; state.protocolModel = previous.protocolModel;
    }
    async function lane(kind) {
      const began = Date.now();
      try {
        const challenge = kind === "vision" ? await Sideline.agentimages.challenge() : null;
        const result = await run({ config, diagnostic: true,
          prompt: challenge ? challenge.prompt : "只回复 OK，不使用任何工具。",
          images: challenge ? [challenge.image] : [] });
        if (challenge && !Sideline.agentimages.recognized(result.content, challenge.expected)) {
          throw new Error(`视觉测试未识别测试图：${diagnostic(result.content)}`);
        }
        state.tests[kind] = { ok: true, model: result.model, elapsedMs: Date.now() - began };
      } catch (error) { state.tests[kind] = { ok: false, model: error.model || config.agentModel || offline.currentModel || "",
        elapsedMs: Date.now() - began, error: diagnostic(error.message) }; }
      state.stages[kind === "text" ? "request" : "vision"] = state.tests[kind].ok ? "pass" : "fail";
    }
    await Promise.all((options.vision ? ["text", "vision"] : ["text"]).map(lane));
    if (Object.values(state.tests).some((entry) => entry.ok)) {
      state.authentication = "verified"; state.stages.authentication = "verified";
    }
    state.testModel = state.tests.text.model;
    state.elapsedMs = Date.now() - started;
    state.error = Object.entries(state.tests).filter(([, entry]) => !entry.ok)
      .map(([kind, entry]) => `${kind === "text" ? "文字" : "视觉"}：${entry.error}`).join("\n");
    observations.set(id, state); return state;
  }
  return { discover, validateInstall: Sideline.agentinstall.validateInstall, add, remove, resetPaths, list, records,
    selected, probe, listModels, reconcile, run, cancel, cancelOwner, drain, test, diagnostic, display, version };
})();
