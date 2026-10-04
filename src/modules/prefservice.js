/*
 * Zotero Sideline：首选项窗口的有限服务桥。
 * 输入：固定设置操作；输出：配置、模型、安装及分阶段诊断。
 * 依赖：config/agents/client。无任意命令/凭据读取/文件删除能力，无新增 HTTP 写端点。
 */
Sideline.prefservice = (function () {
  async function apiModels(vision = false) {
    const config = Sideline.config.apiConfig(null, vision);
    const base = String(config.api || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
    if (!/^https?:\/\//i.test(base)) throw new Error("请填写有效的 HTTP(S) API 基址");
    const headers = config.secretKey ? { Authorization: `Bearer ${config.secretKey}` } : {};
    const xhr = await Zotero.HTTP.request("GET", `${base}/models`, { headers, responseType: "json",
      timeout: config.requestTimeoutMs || 20000, successCodes: [200] });
    const data = Sideline.client.responseJSON(xhr);
    const models = (data.data || []).map((entry) => entry && entry.id).filter((id) => typeof id === "string");
    Sideline.client.rememberModels(config.api, data.data || []);
    if (!models.length) throw new Error("接口可达，但未返回模型列表；可以手动填写模型并测试");
    return models;
  }
  function apiTestOptions(vision = false) {
    const config = Sideline.config.apiConfig(null, vision);
    if (!config.api || !config.model || !config.secretKey) throw new Error("请先配置 API 基址、模型和密钥");
    const content = vision ? [{ type: "text", text: "只回复 OK。" },
      // 固定 64x64 PNG（已校验数据与 CRC）；只检验所选模型接受图片，不上传文献或用户图片。
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAWElEQVR4nO3PAQ0AAAjAIPunMKoxmNtpwOxzs88V0ApoBbQCWgGtgFZAK6AV0ApoBbQCWgGtgFZAK6AV0ApoBbQCWgGtgFZAK6AV0ApoBbQCWgGtgFZgsQOa9gHDs5bgXwAAAABJRU5ErkJggg==" } }]
      : "只回复 OK。";
    // 测试预算作为显式请求覆盖，不读取普通对话的 999999 等值，也不修改其偏好。
    return { config: Object.assign({}, config, { stream: false }), maxTokens: Math.min(2048, Sideline.client.tokenLimit(config) || 2048),
      testNoThinking: true, messages: [{ role: "user", content }] };
  }
  function apiBudgetWarning(vision = false, value) {
    try { const config = Sideline.config.apiConfig(null, vision); Sideline.client.validateTokens(config, value === undefined ? config.maxTokens : value); return ""; }
    catch (error) { return error.message; }
  }
  function apiPreview(vision = false) {
    return Object.assign(Sideline.client.requestSummary(Sideline.client.buildRequest(apiTestOptions(vision))), {
      configuredBudgetWarning: apiBudgetWarning(vision) });
  }
  async function apiTest(vision = false) {
    const started = Date.now();
    const result = await Sideline.client.chat(apiTestOptions(vision));
    if (result.finishReason === "length") throw new Error(`连接测试输出被截断；max_tokens=${result.request.max_tokens}，请核实模型的思考设置`);
    if (!result.content) throw new Error(`${Sideline.client.emptyReason(result)}\n发送参数：max_tokens=${result.request.max_tokens}，stream=false`);
    return { model: result.model, elapsedMs: Date.now() - started, protocol: "HTTP Chat Completions", ok: true,
      request: result.request, warning: apiBudgetWarning(vision) };
  }
  function initializationWarning(id) {
    const record = Sideline.agents.records().find((entry) => entry.id === id);
    return record && record.type === "dsh"
      && !Sideline.jsonfile.exists(Sideline.agentinstall.join(Sideline.agentinstall.env("USERPROFILE"), ".dsh"))
      ? "DeepSeek Harness 首次启动 ACP profile 可能初始化 ~/.dsh 下的配置。" : "";
  }
  return { read: Sideline.config.read, set: Sideline.config.set, apiModels, apiTest, apiPreview, apiBudgetWarning,
    copyDiagnostic: (text) => Sideline.util.copyText(Sideline.agents.diagnostic(text)),
    scan: Sideline.agents.discover, add: (path) => Sideline.agents.add(path, { replaceDetected: true }),
    remove: Sideline.agents.remove, resetPaths: Sideline.agents.resetPaths,
    scanReport: Sideline.agentinstall.scanReport, webStatus: Sideline.agentweb.describe,
    list: Sideline.agents.list, probe: Sideline.agents.probe, models: Sideline.agents.listModels,
    reconcile: Sideline.agents.reconcile, test: Sideline.agents.test, diagnostic: Sideline.agents.diagnostic,
    display: Sideline.agents.display, onActivate: Sideline.util.onActivate, initializationWarning };
})();
