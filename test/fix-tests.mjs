/* 0.9.1 回归：真实请求序列化、模型预算元数据与联网权限边界；注入 HTTP 响应，不调用付费服务。 */
import { createHost } from "./agent-host.mjs";

export async function runFixTests({ projectRoot, check, equal }) {
  console.log("== 0.9.1 API 请求参数 / 联网策略 ==");
  const calls = [], writes = [];
  let response = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }, failure = null;
  const h = createHost(projectRoot, { mkdir() {}, write: (file, text) => writes.push({ file, text }),
    http: async (method, url, options) => { calls.push({ method, url, body: options.body && JSON.parse(options.body) });
      if (failure) throw failure; return { response }; } });
  const s = h.Sideline, pref = (key, value) => h.Zotero.Prefs.set(`sideline.${key}`, value);
  async function rejects(label, fn, regex) {
    let caught; try { await fn(); } catch (error) { caught = error; }
    check(`0.9.1 ${label}`, !!caught && regex.test(caught.message), caught && caught.message); return caught;
  }
  await s.agentweb.setup({ type: "dsh", environment: {} }, false, "", '["deepseek-official","deepseek-flash"]');
  const imageRoute = JSON.parse(writes.at(-1).text).find((entry) => entry.id === "acp").config;
  check("DSH 视觉: 初始化前用自有 patch 预选模型", imageRoute.provider === "deepseek-official" && imageRoute.model === "deepseek-flash");
  await rejects("DSH 视觉: 拒绝无效模型路由", () => s.agentweb.setup({ type: "dsh", environment: {} }, false, "", "invalid-model"), /模型/);
  pref("textApi", "https://api.deepseek.com/v1"); pref("textModel", "deepseek-flash"); pref("textSecretKey", "test-secret"); pref("maxTokens", 999999);
  const preview = s.prefservice.apiPreview();
  equal("0.9.1 dry run: 不发 HTTP", calls.length, 0);
  equal("0.9.1 dry run: 实际测试预算", preview.max_tokens, 2048);
  check("0.9.1 dry run: 普通预算明确警告", preview.configuredBudgetWarning.includes("393216"));
  const tested = await s.prefservice.apiTest();
  equal("0.9.1 HTTP: 999999 偏好不污染测试请求", calls.at(-1).body.max_tokens, 2048);
  equal("0.9.1 HTTP: max_tokens 是数字", typeof calls.at(-1).body.max_tokens, "number");
  equal("0.9.1 HTTP: DeepSeek 连接测试关闭思考", calls.at(-1).body.thinking.type, "disabled");
  equal("0.9.1 HTTP: 测试固定非流式", calls.at(-1).body.stream, false);
  equal("0.9.1 HTTP: 用户预算没有改写", s.config.read().maxTokens, 999999);
  check("0.9.1 HTTP: 返回最终参数及配置警告", tested.request.max_tokens === 2048 && tested.warning.includes("999999"));
  const config = s.config.apiConfig(), messages = [{ role: "user", content: "OK" }];
  for (const value of [1.5, "1.5", "1000junk", "", "abc"]) {
    pref("maxTokens", value); const count = calls.length;
    await rejects(`保存的非法预算 ${String(value)} 不被 parseInt 修正`, () => s.providers.chat({ messages }), /tokens/);
    equal("0.9.1 配置非法预算未发 HTTP", calls.length, count);
  }
  pref("maxTokens", 999999);
  for (const value of [0, -1, 1.5, NaN, Infinity, "", "abc", 999999]) {
    const count = calls.length;
    await rejects(`非法预算 ${String(value)} 在联网前拒绝`, () => s.client.chat({ config: { ...config, maxTokens: value }, messages }), /tokens/);
    equal(`0.9.1 非法预算 ${String(value)} 未调用 HTTP`, calls.length, count);
  }
  const other = { ...config, api: "https://other.example/v1", maxTokens: 999999 };
  equal("0.9.1 未知服务商不套用 DeepSeek 上限", s.client.buildRequest({ config: other, messages }).body.max_tokens, 999999);
  s.client.rememberModels(config.api, [{ id: "deepseek-flash", max_output_tokens: 1000 }]);
  equal("0.9.1 模型元数据限制测试预算", s.prefservice.apiPreview().max_tokens, 1000);
  await rejects("模型元数据校验普通请求", () => s.client.chat({ config: { ...config, maxTokens: 1001 }, messages }), /1000/);
  s.client.rememberModels(config.api, [{ id: "deepseek-flash" }]);
  equal("0.9.1 刷新模型移除陈旧上限", s.prefservice.apiPreview().max_tokens, 2048);
  response = { choices: [{ message: { content: "", reasoning_content: "private reasoning" }, finish_reason: "length" }] };
  await rejects("截断与空回答区别显示", () => s.prefservice.apiTest(), /截断.*max_tokens=2048/);
  response.choices[0].finish_reason = "stop";
  const reasoning = await rejects("仅思考内容区别显示", () => s.prefservice.apiTest(), /仅返回思考/);
  check("0.9.1 诊断不回显思考正文", !reasoning.message.includes("private reasoning"));
  response = { data: "wrong format" }; await rejects("不兼容响应明确显示", () => s.prefservice.apiTest(), /choices/);
  response = { choices: [{ message: { content: "" } }] }; await rejects("实际空回答明确显示", () => s.prefservice.apiTest(), /空回答/);
  response = { choices: [{ message: { content: [{ type: "text", text: "OK" }] } }] };
  check("0.9.1 兼容文本块响应", (await s.prefservice.apiTest()).ok);
  failure = Object.assign(new Error("HTTP 400"), { xmlhttp: { responseText: 'Invalid max_tokens test-secret ' + "x".repeat(2000) } });
  const error = await rejects("400 诊断保留实际发送参数", () => s.prefservice.apiTest(), /max_tokens=2048（number）/);
  check("0.9.1 400 诊断不泄露密钥", !error.message.includes("test-secret"));
  check("0.9.1 请求摘要不含认证信息", !JSON.stringify(s.client.requestSummary(s.client.buildRequest({ config: { ...config, api: "https://name:secret@example.com/v1?token=secret", maxTokens: 20 }, messages }))).includes("secret"));

  const install = { type: "opencode", environment: { KEEP: "yes" } };
  for (const enabled of [false, true]) {
    const prepared = await s.agentweb.setup(install, enabled), policy = JSON.parse(prepared.environment.OPENCODE_CONFIG_CONTENT);
    equal(`0.9.1 OpenCode 联网 ${enabled} 策略`, policy.permission.websearch, enabled ? "allow" : "deny");
    equal(`0.9.1 OpenCode 联网 ${enabled} 网页读取`, policy.agent.plan.permission.webfetch, enabled ? "allow" : "deny");
    equal(`0.9.1 OpenCode 联网 ${enabled} 未知工具拒绝`, policy.permission["*"], "deny");
    equal(`0.9.1 OpenCode 联网 ${enabled} 后端开关`, prepared.environment.OPENCODE_ENABLE_EXA, enabled ? "1" : "0");
    const dsh = await s.agentweb.setup({ type: "dsh", environment: { ELECTRON_RUN_AS_NODE: "1" } }, enabled);
    equal(`0.9.1 DSH 联网 ${enabled} 白名单参数`, dsh.acpArgs.slice(0, 3).join(" "), "--profile acp --patch");
    equal(`0.9.1 DSH 联网 ${enabled} 保留 Node 模式`, dsh.environment.ELECTRON_RUN_AS_NODE, "1");
    equal(`0.9.1 DSH 联网 ${enabled} 只读沙箱`, dsh.environment.DSH_PERMISSION_MODE, "read-only");
    const patch = JSON.parse(writes.at(-1).text);
    check(`0.9.1 DSH 联网 ${enabled} 禁止文件命令及子代理`, ["tool-fs", "tool-bash", "tool-pwsh", "tool-subagent"].every((id) => patch.find((entry) => entry.id === id).disabled));
    equal(`0.9.1 DSH 联网 ${enabled} 真实工具配置`, patch.find((entry) => entry.id === "tool-web").config.search, enabled);
  }
  const options = [{ kind: "allow_always", optionId: "always" }, { kind: "allow_once", optionId: "once" }];
  const search = { title: "web_search", rawInput: { queries: ["DeepSeek official docs"] } };
  equal("0.9.1 联网开启仅授予单次许可", s.agentweb.permission(search, options, true).optionId, "once");
  equal("0.9.1 联网关闭拒绝网络工具", s.agentweb.permission(search, options, false), null);
  for (const call of [{ title: "bash", rawInput: { command: "curl" } }, { title: "web_search" }, { ...search, rawInput: { query: "a", command: "write" } }, { ...search, locations: [{ path: "private" }] }]) {
    equal("0.9.1 混入文件命令或缺失上下文均拒绝", s.agentweb.permission(call, options, true), null);
  }
  for (const url of ["file:///C:/private", "http://localhost:23119", "http://127.0.0.1", "http://2130706433", "http://0x7f000001", "http://169.254.1.1", "http://100.64.1.1", "http://10.1.2.3", "http://192.168.1.1", "http://172.16.0.1", "http://[::1]", "https://name:secret@example.com"]) {
    equal(`0.9.1 网页授权拒绝本地或含凭据地址 ${url}`, s.agentweb.permission({ title: "web_fetch", rawInput: { url } }, options, true), null);
  }
  equal("0.9.1 公开网页单次授权", s.agentweb.permission({ title: "web_fetch", rawInput: { url: "https://api-docs.deepseek.com" } }, options, true).optionId, "once");
}
