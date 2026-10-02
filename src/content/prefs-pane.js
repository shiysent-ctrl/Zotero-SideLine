/*
 * Zotero Sideline 首选项控制器。
 * 输入：设置页固定操作；输出：处理通道、综合/分项检测状态、模型选项和秒/毫秒同步。
 * 依赖：bootstrap 注册的 Zotero.SidelinePrefs；打开面板只恢复记录，不扫描或调用模型。
 */
(function () {
  const NS = "http://www.w3.org/1999/xhtml";
  function attach() {
    const root = document.getElementById("sideline-prefs-root"), service = Zotero.SidelinePrefs;
    if (!root || !service) return false;
    if (root.dataset.sidelineBound === "1") return true;
    root.dataset.sidelineBound = "1";
    const node = (id) => root.querySelector(`#sideline-${id}`);
    let models = [], installs = [], generation = 0, hasScanned = false, environment, agentStep = "install";
    const modelMenus = {};
    const revisions = { text: 0, vision: 0, agent: 0, route: 0 }, requests = { text: 0, vision: 0, agent: 0, route: 0 };
    function message(id, text) { const target = node(id); if (target) target.textContent = text; }
    function status(kind, state, text) {
      const target = node(`${kind}-status`); if (!target) return;
      target.dataset.state = state; target.textContent = text;
    }
    function untested(kind) {
      if (kind === "route") return "未检测";
      if (kind === "agent") return currentId() ? ({
        install: "安装记录已添加，需要离线检测模型",
        catalog: "模型列表已刷新，请选择模型",
        model: "模型选择完成，请验证请求协议",
        protocol: "思考协议验证完成，请选择思考强度",
        ready: "请测试连接状态",
      }[agentStep]) : "未选择 Agent";
      const config = service.read(), reuse = kind === "vision" && config.visionUseText;
      const api = config[reuse ? "textApi" : `${kind}Api`], key = config[reuse ? "textSecretKey" : `${kind}SecretKey`];
      // 视觉状态先报告连接信息是否齐全；是否支持所选视觉模型仍由独立图片测试验证。
      return kind === "vision" ? (reuse || api && key ? "已配置 · 未检测" : "未配置完整")
        : api && key && config.textModel ? "已配置 · 未检测" : "未配置完整";
    }
    function invalidate(kind) {
      revisions[kind]++; if (kind === "agent") generation++;
      status(kind, "idle", untested(kind)); message(`${kind}-result`, "");
      const textKind = node("text-channel").value === "agent" ? "agent" : "text";
      if (kind === textKind || textKind === "text" && kind === "vision") invalidateRoute();
    }
    function invalidateRoute() {
      revisions.route++; status("route", "idle", untested("route")); message("route-result", "");
    }
    function bindChannelMenu() {
      const select = node("text-channel"), display = node("channel-display"), popup = node("channel-popup");
      const choices = ["api", "agent"];
      function sync() {
        display.value = select.value === "agent" ? "Agent" : "API";
        for (const value of choices) node(`channel-${value}`).setAttribute("aria-selected", String(select.value === value));
      }
      function close() { popup.hidden = true; display.setAttribute("aria-expanded", "false"); }
      function open() {
        for (const menu of Object.values(modelMenus)) menu.close();
        popup.hidden = false; display.setAttribute("aria-expanded", "true");
        node(`channel-${select.value === "agent" ? "agent" : "api"}`).focus();
      }
      function choose(value) {
        if (!choices.includes(value)) return;
        const changed = select.value !== value;
        select.value = value; service.set("textChannel", value); sync(); close(); display.focus();
        if (changed) invalidateRoute();
      }
      service.onActivate(node("channel-toggle"), () => popup.hidden ? open() : close());
      display.addEventListener("click", () => popup.hidden ? open() : close());
      display.addEventListener("keydown", (event) => {
        if (["ArrowDown", "Enter", " "].includes(event.key)) { event.preventDefault(); open(); }
        if (event.key === "Escape") close();
      });
      for (const value of choices) {
        service.onActivate(node(`channel-${value}`), () => choose(value));
        node(`channel-${value}`).addEventListener("keydown", (event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); node(`channel-${value === "api" ? "agent" : "api"}`).focus(); }
          if (event.key === "Escape") { close(); display.focus(); }
        });
      }
      for (const event of ["change", "syncfrompreference"]) select.addEventListener(event, () => { sync(); invalidateRoute(); });
      if (document.addEventListener) document.addEventListener("mousedown", (event) => {
        if (!popup.hidden && !node("channel-combo").contains(event.target)) close();
      });
      const menu = { close, open, choose, sync }; modelMenus.channel = menu; sync(); close(); return menu;
    }
    // 持久化仍使用原有毫秒键。可见字段不带 preference，避免宿主直接把秒写入毫秒键。
    function bindTimeout(kind, key) {
      const input = node(`${kind}-timeout-seconds`), raw = node(`${kind}-timeout-ms`);
      function sync() { input.value = String(Number(raw.value) / 1000); if (input.setCustomValidity) input.setCustomValidity(""); }
      raw.value = String(service.read()[key]); sync();
      raw.addEventListener("syncfrompreference", () => { sync(); invalidate(kind); if (kind === "text") invalidate("vision"); });
      input.addEventListener("input", () => { if (input.setCustomValidity) input.setCustomValidity(""); });
      input.addEventListener("change", () => {
        const seconds = input.value.trim() === "" ? NaN : Number(input.value), ms = Math.round(seconds * 1000);
        if (!Number.isFinite(seconds) || !Number.isSafeInteger(ms) || ms < 1 || ms > 2147483647) {
          if (input.setCustomValidity) input.setCustomValidity("请填写大于 0 且不超过 2147483.647 的秒数。");
          if (input.reportValidity) input.reportValidity(); return;
        }
        service.set(key, ms); raw.value = String(ms); sync(); invalidate(kind);
        if (kind === "text") invalidate("vision");
      });
    }
    function bindPrompt(id) {
      const input = node(id);
      // 提示词由宿主的 preference 绑定恢复；配置快照不包含所有提示词，不能用空值覆盖控件。
      function sync() { message(`${id}-state`, input.value.trim() ? (id === "system-prompt" ? "已设置" : "已自定义") : "使用内置"); }
      sync();
      input.addEventListener("input", sync); input.addEventListener("syncfrompreference", sync);
    }
    function options(target, entries, current, blank = false) {
      if (!target) return;
      target.replaceChildren();
      if (blank) entries = [{ value: "", label: target === node("agent-install") ? (hasScanned || installs.length ? "请选择Agent" : "") : "默认 / 不指定" }].concat(entries);
      if (current && !entries.some((entry) => entry.value === current)) entries = [{ value: current, label: `${current}（需重新确认）` }].concat(entries);
      for (const entry of entries) {
        const option = document.createElementNS(NS, "option"); option.value = entry.value;
        option.textContent = entry.label || entry.value; target.appendChild(option);
      }
      // XHTML 片段保留 html: 前缀，tagName 可能是 "html:select"；localName 才是控件类型。
      if (target.localName === "select") target.value = current || "";
      if (target === node("agent-install")) modelMenus.install?.sync();
      if (target === node("agent-effort")) modelMenus.effort?.sync();
    }
    // 可见下拉沿用模型框的样式；隐藏 select 保留宿主 preference 绑定。
    function bindChoiceMenu(kind, key, selected) {
      const select = node(`agent-${kind}`), display = node(`agent-${kind}-display`);
      const list = node(`agent-${kind}-options`), popup = node(`agent-${kind}-popup`), container = node(`agent-${kind}-combo`);
      function entries() { return Array.from(select.children).map((option) => ({ value: option.value, label: option.textContent })); }
      function sync() {
        const choices = entries();
        display.value = choices.find((entry) => entry.value === select.value)?.label || "";
        display.setAttribute("title", display.value);
        const shown = kind === "install" ? choices.filter((entry) => entry.value
          && installs.some((install) => install.id === entry.value && install.status !== "missing")) : choices;
        options(list, shown, shown.some((entry) => entry.value === select.value) ? select.value : "");
      }
      function close() { popup.hidden = true; display.setAttribute("aria-expanded", "false"); }
      function open() {
        for (const menu of Object.values(modelMenus)) menu.close();
        if (kind === "effort" && !["protocol", "ready"].includes(agentStep)) return;
        sync();
        if (!list.children.length) return;
        popup.hidden = false; display.setAttribute("aria-expanded", "true"); list.focus();
      }
      function choose() {
        if (popup.hidden || !Array.from(list.children).some((entry) => entry.value === list.value) || kind === "install" && !list.value) return;
        const changed = select.value !== list.value;
        select.value = list.value; service.set(key, select.value); sync(); close(); display.focus();
        // 默认 / 不指定也算一次明确选择，不要求它与空首选项值不同。
        if (changed || kind === "effort") selected();
      }
      service.onActivate(node(`agent-${kind}-toggle`), () => popup.hidden ? open() : close());
      display.addEventListener("click", () => popup.hidden ? open() : close());
      display.addEventListener("keydown", (event) => {
        if (["ArrowDown", "Enter", " "].includes(event.key)) { event.preventDefault(); open(); }
        if (event.key === "Escape") close();
      });
      list.addEventListener("click", choose);
      list.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); choose(); }
        if (event.key === "Escape") { close(); display.focus(); }
      });
      if (document.addEventListener) document.addEventListener("mousedown", (event) => {
        if (!popup.hidden && !container.contains(event.target)) close();
      });
      const menu = { sync, open, close, choose }; modelMenus[kind] = menu; sync(); close(); return menu;
    }
    function currentId() { return node("agent-install").value; }
    function bindModelMenu(kind, key, selected) {
      const input = node(`${kind}-model`), list = node(`${kind}-models`), popup = node(`${kind}-model-popup`);
      const filter = node(`${kind}-model-filter`), container = node(`${kind}-combo`);
      let entries = [];
      function render() {
        const query = filter.value.trim().toLowerCase();
        const shown = entries.filter((entry) => `${entry.value} ${entry.label || ""}`.toLowerCase().includes(query));
        options(list, shown, "");
        message(`${kind}-model-count`, entries.length ? `${shown.length} / ${entries.length} 个模型` : kind === "agent" ? "请先离线检测模型" : "请先刷新模型；仍可手动输入");
      }
      function close() { popup.hidden = true; input.setAttribute("aria-expanded", "false"); }
      function open() {
        for (const menu of Object.values(modelMenus)) menu.close();
        filter.value = ""; render(); popup.hidden = false; input.setAttribute("aria-expanded", "true");
        if (filter.focus) filter.focus();
      }
      function choose() {
        if (popup.hidden || !list.value || !entries.some((entry) => entry.value === list.value)) return;
        input.value = list.value; service.set(key, input.value); close();
        if (input.focus) input.focus(); if (selected) selected();
      }
      service.onActivate(node(`${kind}-model-toggle`), () => popup.hidden ? open() : close());
      filter.addEventListener("input", render);
      filter.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); if (list.focus) list.focus(); }
        if (event.key === "Escape") close();
      });
      input.addEventListener("keydown", (event) => { if (event.key === "ArrowDown") { event.preventDefault(); open(); } if (event.key === "Escape") close(); });
      if (kind === "agent") input.addEventListener("click", () => popup.hidden ? open() : close());
      list.addEventListener("click", choose);
      list.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); choose(); } if (event.key === "Escape") close(); });
      if (document.addEventListener) document.addEventListener("mousedown", (event) => { if (!popup.hidden && !container.contains(event.target)) close(); });
      const menu = { open, close, choose, set(entries_) { entries = entries_; render(); } };
      modelMenus[kind] = menu; close(); return menu;
    }
    function modelEntries(entries) { return entries.map((entry) => ({ value: entry.id,
      label: entry.name && entry.name !== entry.id ? `${entry.name} · ${entry.id}` : entry.id })); }
    function budgetWarning() { message("budget-warning", service.apiBudgetWarning(false, node("max-tokens").value)); }
    function webStatus() {
      const install = installs.find((entry) => entry.id === currentId());
      message("agent-web-status", service.webStatus(install, node("agent-search").checked));
    }
    function confirmStart(extra = "") {
      return window.confirm(`${extra}${extra ? "\n" : ""}将发起一次真实最小模型请求，会消耗额度。只发送「回复 OK」，不发送文献。继续？`);
    }
    function confirmInit() {
      const warning = service.initializationWarning(currentId());
      return !warning || window.confirm(`${warning}\n继续启动 ACP profile？`);
    }
    function stages(state) {
      const names = { program: "程序", version: "版本", authentication: "登录/凭据", protocol: "协议", models: "模型列表", request: "文字请求", vision: "视觉请求" };
      const labels = { pass: "通过", fail: "失败", "not-tested": "未测试", unknown: "未确认",
        "logged-in": "已登录", required: "需要登录/凭据", "session-ready": "可建会话（推理凭据待真实请求验证）",
        verified: "已由真实请求验证", empty: "返回空列表", timeout: "超时" };
      message("agent-result", [service.display(state),
        ...Object.keys(names).map((key) => `${names[key]}：${labels[(state.stages || {})[key]] || (state.stages || {})[key] || "未检测"}`),
        state.protocol ? `协议类型：${state.protocol}` : "",
        state.testModel ? `测试模型：${state.testModel} · ${(state.elapsedMs / 1000).toFixed(1)}s` : "",
        ...Object.entries(state.tests || {}).map(([kind, result]) => `${kind === "text" ? "文字" : "视觉"}：${result.ok ? "通过" : "失败"} · ${result.model} · ${(result.elapsedMs / 1000).toFixed(1)}s${result.error ? ` · ${result.error}` : ""}`),
        state.error ? `诊断：${service.diagnostic(state.error)}` : ""].filter(Boolean).join("\n"));
    }
    function syncEffort() {
      if (!["protocol", "ready"].includes(agentStep)) {
        options(node("agent-effort"), [], "");
        modelMenus.effort?.close();
        message("agent-warning", ""); return;
      }
      const model = node("agent-model").value.trim(), oldEffort = node("agent-effort").value || service.read().agentEffort;
      const state = service.reconcile(models, model, oldEffort);
      options(node("agent-effort"), state.efforts.map((value) => ({ value })), state.effort, true);
      service.set("agentEffort", state.effort); message("agent-warning", state.warning);
    }
    async function refreshModels(context) {
      if (!currentId()) throw new Error("请先扫描并选择 Agent");
      const model = node("agent-model").value.trim();
      if (!models.some((entry) => entry.id === model)) throw new Error("请先离线检测模型并从列表选择模型");
      if (!confirmInit()) return;
      // 协议能力属于所选模型；重验或换模型后，旧强度不能继续视为已确认。
      agentStep = "model"; service.set("agentEffort", ""); syncEffort();
      const token = ++generation, id = currentId();
      const revision = revisions.agent, request = context ? requests.agent : ++requests.agent;
      const valid = () => token === generation && id === currentId() && revision === revisions.agent
        && request === requests.agent && (!context || context.valid());
      if (!context) status("agent", "busy", "正在验证请求协议…");
      let found;
      try { found = await service.models(id, model); } catch (error) { if (!valid()) return; throw error; }
      if (!valid()) return;
      if (!found.some((entry) => entry.id === model)) throw new Error("所选模型已不在协议返回的列表中，请重新离线检测模型");
      models = found; agentStep = "protocol";
      modelMenus.agent.set(modelEntries(models)); syncEffort();
      message("agent-result", `已验证模型 ${model} 的协议；请选择思考强度（可选默认 / 不指定），再测试连接`);
      if (!context) status("agent", "catalog", untested("agent"));
      return { state: "catalog", text: untested("agent") };
    }
    function clearAgentModel() {
      models = []; agentStep = "install";
      node("agent-model").value = ""; service.set("agentModel", ""); service.set("agentEffort", "");
      modelMenus.agent.set([]); syncEffort(); message("agent-warning", "");
    }
    async function renderInstalls(observed = false) {
      installs = await service.list();
      options(node("agent-install"), installs.map((entry) => ({ value: entry.id,
        label: `${service.display(entry)} · ${entry.status}${entry.error ? ` · ${entry.error}` : ""}` })), service.read().agentInstallId, true);
      const install = installs.find((entry) => entry.id === currentId());
      const identity = JSON.stringify([currentId(), install?.type || "", install?.path || "", install?.version || ""]);
      if (environment !== undefined && environment !== identity) {
        clearAgentModel();
        // 手动检测可接收本次读到的新版本；普通扫描/路径变化使旧检测失效。
        if (!observed) invalidate("agent");
      }
      environment = identity;
      node("agent-remove").disabled = !canResetPath();
      node("agent-search").disabled = !install;
      webStatus();
    }
    function canResetPath() {
      return !!node("agent-directory").value.trim() || installs.some((entry) => entry.id === currentId() && entry.source === "manual");
    }
    function action(id, fn, resultId = "agent-result") {
      const button = node(id); if (!button) return;
      const kind = resultId.split("-")[0];
      let running = false;
      service.onActivate(button, () => {
        if (running) return;
        if (["text-test", "vision-test", "agent-test"].includes(id)
          && (kind === (node("text-channel").value === "agent" ? "agent" : "text")
            || kind === "vision" && node("text-channel").value !== "agent")) invalidateRoute();
        running = true; button.disabled = true; button.setAttribute("aria-busy", "true");
        const title = button.textContent, previous = { state: node(`${kind}-status`).dataset.state, text: node(`${kind}-status`).textContent };
        // 并行点击另一操作时，不能把已经结束的进行中状态恢复回来。
        if (previous.state === "busy") { previous.state = "idle"; previous.text = untested(kind); }
        const revision = revisions[kind], ticket = ++requests[kind];
        const context = { valid: () => revision === revisions[kind] && ticket === requests[kind] };
        const pending = id === "agent-model-refresh" ? "正在验证请求协议…" : id.includes("refresh") ? "正在读取模型…" : {
          "agent-scan": "正在扫描…", "agent-add": "正在添加路径…", "agent-remove": "正在重置路径…",
          "agent-probe": "正在模型离线检测…"
        }[id] || "正在测试连接…";
        button.textContent = pending; status(kind, "busy", pending);
        void (async () => {
          try {
            const result = await fn(context);
            if (context.valid()) status(kind, result && result.state || previous.state, result && result.text || previous.text);
          }
          catch (error) {
            if (context.valid()) {
              const detail = service.diagnostic(error.message || error);
              message(resultId, detail); status(kind, "fail", `检测失败 · ${String(detail).split("\n")[0].slice(0, 100)}`);
            }
          }
          finally { running = false; button.textContent = title; button.setAttribute("aria-busy", "false"); button.disabled = id === "agent-remove"
            && !canResetPath(); }
        })();
      });
    }
    const config = service.read();
    bindTimeout("text", "requestTimeoutMs"); bindTimeout("vision", "visionRequestTimeoutMs"); bindTimeout("agent", "agentTimeoutMs");
    for (const id of ["prompt-summarize", "prompt-explain", "prompt-translate", "prompt-highlight",
      "system-prompt", "fallback-prompts"]) bindPrompt(id);
    node("max-tokens").value = String(config.maxTokens);
    for (const kind of ["text", "vision", "agent", "route"]) service.onActivate(node(`${kind}-copy`), () => service.copyDiagnostic(node(`${kind}-result`).textContent));
    function modelChanged() {
      agentStep = models.some((entry) => entry.id === node("agent-model").value.trim()) ? "model" : models.length ? "catalog" : "install";
      service.set("agentEffort", ""); syncEffort(); invalidate("agent");
    }
    function effortChanged() {
      if (["protocol", "ready"].includes(agentStep)) { syncEffort(); agentStep = "ready"; }
      invalidate("agent");
    }
    for (const [kind, key] of [["text", "textModel"], ["vision", "visionModel"], ["agent", "agentModel"]])
      bindModelMenu(kind, key, kind === "agent" ? modelChanged : () => { invalidate(kind); budgetWarning(); });
    for (const [id, key] of Object.entries({ "text-api": "textApi", "text-key": "textSecretKey", "text-model": "textModel",
      "vision-api": "visionApi", "vision-key": "visionSecretKey", "vision-model": "visionModel",
      "text-channel": "textChannel", "agent-model": "agentModel" })) {
      node(id).value = config[key] || "";
      node(id).addEventListener("change", () => service.set(key, node(id).value));
    }
    const channelMenu = bindChannelMenu(); status("route", "idle", untested("route"));
    node("vision-use-text").checked = config.visionUseText;
    node("agent-search").checked = !!config.agentSearch;
    node("agent-search").addEventListener("change", () => { service.set("agentSearch", node("agent-search").checked); webStatus(); });
    node("max-tokens").addEventListener("input", budgetWarning);
    node("max-tokens").addEventListener("change", budgetWarning);
    budgetWarning();
    function syncVision() {
      const useText = node("vision-use-text").checked;
      node("vision-api").disabled = useText; node("vision-key").disabled = useText;
    }
    syncVision();
    node("vision-use-text").addEventListener("change", () => { service.set("visionUseText", node("vision-use-text").checked); syncVision(); });
    // 操作期间改了配置时，旧请求可以完成，但不得将新配置标为可用或覆盖新模型列表。
    for (const kind of ["text", "vision", "agent"]) {
      const fields = kind === "agent" ? ["agent-model", "agent-effort", "agent-search"] : [`${kind}-api`, `${kind}-key`, `${kind}-model`];
      if (kind === "text") fields.push("max-tokens", "temperature");
      if (kind === "vision") fields.push("vision-use-text");
      for (const id of fields) for (const event of ["input", "change", "syncfrompreference"]) {
        if (id === "agent-model" || id === "agent-effort") continue;
        node(id).addEventListener(event, () => {
        invalidate(kind);
        if (kind === "text" && (node("vision-use-text").checked || ["max-tokens", "temperature"].includes(id))) invalidate("vision");
        });
      }
      status(kind, "idle", untested(kind));
    }
    async function testApi(kind, context) {
      const result = await service.apiTest(kind === "vision");
      if (!context.valid()) return;
      message(`${kind}-result`, `通过 · ${result.model} · ${result.protocol} · ${(result.elapsedMs / 1000).toFixed(1)}s\n测试 max_tokens=${result.request.max_tokens}（${result.request.max_tokens_type}）${result.warning ? `\n普通对话配置警告：${result.warning}` : ""}`);
      return { state: "pass", text: `连接成功 · ${(result.elapsedMs / 1000).toFixed(1)} 秒${result.warning ? " · 对话配置有警告" : ""}` };
    }
    for (const kind of ["text", "vision"]) {
      action(`${kind}-refresh`, async (context) => {
        const ids = await service.apiModels(kind === "vision"); if (!context.valid()) return;
        modelMenus[kind].set(ids.map((value) => ({ value })));
        budgetWarning();
        const selected = node(`${kind}-model`).value;
        message(`${kind}-result`, selected && !ids.includes(selected)
          ? `已返回 ${ids.length} 个模型，原模型 ${selected} 不在列表中，请确认` : `已返回 ${ids.length} 个模型，点击模型框右侧 ▾ 可展开选择`);
        // 模型目录不验证推理连接，也不撤销同一配置已经取得的连接成功状态。
      }, `${kind}-result`);
      action(`${kind}-test`, (context) => testApi(kind, context), `${kind}-result`);
    }
    action("agent-scan", async (context) => {
      const selectedId = service.read().agentInstallId, selectionRevision = revisions.agent;
      message("agent-result", "正在扫描已知安装目录…"); await service.scan(); hasScanned = true;
      // 首次扫描等待显式选择；已有选择或扫描期间的新选择不能被清空。
      if (!selectedId && selectionRevision === revisions.agent) service.set("agentInstallId", "");
      await renderInstalls();
      if (!context.valid()) return;
      const report = service.scanReport();
      message("agent-result", [`已识别 ${installs.length} 个安装；检查 ${report.candidates} 个候选目录`,
        ...(installs.length ? [] : report.failures.map((entry) => `${entry.path}：${entry.reason}`)),
        installs.length ? "选择后可离线检测" : "请核对安装目录；没有执行未知程序"].join("\n"));
      return { state: "idle", text: `已发现 ${installs.length} 个安装 · ${untested("agent")}` }; });
    action("agent-add", async (context) => { const install = await service.add(node("agent-directory").value); await renderInstalls();
      if (context.valid()) message("agent-result", `已添加 ${service.display(install)}`);
      return { state: "idle", text: "安装记录已添加，需要离线检测模型" }; });
    action("agent-remove", async (context) => {
      const manual = installs.some((entry) => entry.id === currentId() && entry.source === "manual");
      node("agent-directory").value = "";
      if (manual) {
        service.remove(currentId()); service.set("agentEffort", "");
        options(node("agent-effort"), [], "", true); invalidate("agent");
      }
      await renderInstalls();
      if (context.valid() || manual) message("agent-result", manual ? "已重置自定义路径，实际程序未删除" : "已清空自定义路径输入");
      return manual ? { state: "idle", text: untested("agent") } : undefined;
    });
    node("agent-directory").addEventListener("input", () => { node("agent-remove").disabled = !canResetPath(); });
    function agentOutcome(result, real) {
      const checks = Object.values(result.stages || {});
      if (result.error || checks.some((value) => ["fail", "timeout", "required", "empty"].includes(value)))
        return { state: "fail", text: "检测未通过 · 展开诊断查看原因" };
      if (real && (result.stages || {}).request === "pass") return { state: "pass", text: "真实请求成功" };
      if (!real && (result.stages || {}).program === "pass" && (result.stages || {}).protocol === "pass")
        return { state: "catalog", text: "模型列表已刷新，请选择模型" };
      return { state: "idle", text: "检测未完成 · 展开诊断查看阶段" };
    }
    action("route-test", async (context) => {
      const textKind = node("text-channel").value === "agent" ? "agent" : "text";
      if (textKind === "agent" && !confirmInit()) return;
      const lanes = (textKind === "agent" ? ["agent"] : ["text", "vision"]).map((kind) => {
        const revision = revisions[kind], ticket = ++requests[kind];
        const owns = () => revisions[kind] === revision && requests[kind] === ticket;
        return { kind, owns, valid: () => context.valid() && owns() };
      });
      // API 模式测两个接口；Agent 模式在当前 Agent 内测文字与真实识图，不依赖 HTTP 配置。
      const results = await Promise.all(lanes.map(async (lane) => {
        status(lane.kind, "busy", "正在测试连接…");
        let outcome;
        try {
          if (lane.kind === "agent") {
            if (!currentId()) throw new Error("请选择 Agent");
            const result = await service.test(currentId(), { vision: true });
            if (lane.valid()) stages(result);
            outcome = agentOutcome(result, true);
            if (result.stages?.vision !== "pass") outcome = { state: "fail", text: "视觉未通过 · 展开诊断查看原因" };
            if (lane.valid()) message("route-result", ["text", "vision"].map((kind) => {
              const test = result.tests?.[kind];
              return `${kind === "text" ? "文字（Agent）" : "视觉（Agent）"}：${test
                ? `${test.ok ? "通过" : "失败"} · ${test.model} · ${(test.elapsedMs / 1000).toFixed(1)}s${test.error ? ` · ${test.error}` : ""}`
                : result.stages?.[kind === "text" ? "request" : "vision"] === "pass" ? "通过" : result.error || "未通过"}`;
            }).join("\n"));
          } else outcome = await testApi(lane.kind, lane);
        } catch (error) {
          const detail = service.diagnostic(error.message || error);
          if (lane.valid()) message(`${lane.kind}-result`, detail);
          if (lane.kind === "agent" && lane.valid()) message("route-result", `Agent 文字与视觉检测未完成：${detail}`);
          outcome = { state: "fail", text: `检测失败 · ${String(detail).split("\n")[0].slice(0, 100)}` };
        }
        if (lane.valid() && outcome) status(lane.kind, outcome.state, outcome.text);
        return outcome;
      }));
      if (!context.valid()) {
        // 切换通道会使整轮失效，未改配置的另一项也应结束进行中状态；保留新操作的状态。
        for (const lane of lanes) if (lane.owns() && node(`${lane.kind}-status`).dataset.state === "busy")
          status(lane.kind, "idle", untested(lane.kind));
        return;
      }
      if (lanes.some((lane) => !lane.valid())) return { state: "idle", text: "检测已变更 · 请重新测试" };
      const passed = results.every((result) => result && result.state === "pass");
      if (textKind !== "agent") message("route-result", results.map((result, index) => `${index === 0 ? "文字 API" : "视觉 API"}：${result && result.text || "未完成"}`).join("\n"));
      return { state: passed ? "pass" : "fail", text: passed ? "连接成功 · 文字与视觉均通过" : "连接失败 · 文字或视觉未通过" };
    }, "route-result");
    action("agent-probe", async (context) => {
      if (!currentId()) throw new Error("请选择 Agent");
      clearAgentModel();
      const result = await service.probe(currentId());
      if (!context.valid()) return;
      await renderInstalls(true);
      if (!context.valid()) return;
      const outcome = agentOutcome(result, false);
      if (outcome.state === "catalog") {
        models = result.models || []; agentStep = "catalog";
        if (!models.length) { agentStep = "install"; outcome.state = "fail"; outcome.text = "未获得可选模型，请展开诊断查看原因"; }
      }
      modelMenus.agent.set(modelEntries(models)); syncEffort();
      stages(result); return outcome;
    });
    action("agent-test", async (context) => { if (!currentId()) throw new Error("请选择 Agent");
      if (!confirmStart(service.initializationWarning(currentId()))) return;
      const result = await service.test(currentId()); if (context.valid()) stages(result);
      await renderInstalls(); return agentOutcome(result, true); });
    action("agent-model-refresh", refreshModels);
    node("agent-model").addEventListener("change", modelChanged);
    node("agent-model").addEventListener("syncfrompreference", modelChanged);
    function installChanged() {
      modelMenus.install.sync(); service.set("agentInstallId", currentId());
      clearAgentModel(); environment = undefined; invalidate("agent");
      const revision = revisions.agent;
      void renderInstalls().catch((error) => {
        if (revision !== revisions.agent) return;
        message("agent-warning", service.diagnostic(error.message)); message("agent-result", service.diagnostic(error.message));
        status("agent", "fail", "无法读取安装记录");
      });
    }
    bindChoiceMenu("install", "agentInstallId", installChanged);
    bindChoiceMenu("effort", "agentEffort", effortChanged);
    node("agent-install").addEventListener("change", installChanged);
    node("agent-install").addEventListener("syncfrompreference", () => { modelMenus.install.sync(); });
    node("agent-effort").addEventListener("change", effortChanged);
    node("agent-effort").addEventListener("syncfrompreference", () => { syncEffort(); invalidate("agent"); });
    syncEffort();
    root.sidelineController = { refreshModels, renderInstalls, syncEffort, stages, modelMenus, agentOutcome, channelMenu };
    const initialRevision = revisions.agent, initialRequest = requests.agent;
    void renderInstalls().then(() => { if (initialRevision === revisions.agent && initialRequest === requests.agent) status("agent", "idle", untested("agent")); }).catch((error) => {
      if (initialRevision !== revisions.agent || initialRequest !== requests.agent) return;
      message("agent-result", service.diagnostic(error.message)); status("agent", "fail", "无法读取安装记录");
    });
    return true;
  }
  let tries = 0;
  const timer = setInterval(() => { if (attach() || ++tries > 40) clearInterval(timer); }, 100);
})();
