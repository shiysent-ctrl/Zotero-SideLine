/* 0.9.0 Agent 回归：使用真实模块与双向协议桩验证发现、安全边界、能力、故障、取消及设置页。 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { inflateSync } from "node:zlib";
import { createHost, Pipe } from "./agent-host.mjs";

export async function runAgentTests({ projectRoot, check, equal }) {
  console.log("== 0.9.0 API / Agent / ACP ==");
  const normalize = (value) => path.win32.normalize(value).replace(/\\/g, "/").replace(/\/$/, "");
  const files = new Map(), dirs = new Set(), reads = [], starts = [], messages = [];
  const home = "C:/Users/test", npm = `${home}/AppData/Roaming/npm`, local = `${home}/AppData/Local`;
  function dir(value) { dirs.add(normalize(value)); }
  function file(value, content = "stub") { files.set(normalize(value), content); dir(path.win32.dirname(value)); }
  for (const value of [home, npm, local, `${home}/.dsh`]) dir(value);
  const codex = `${npm}/node_modules/@openai/codex`, open = `${npm}/node_modules/opencode-ai`, dsh = `${npm}/node_modules/@deepseek-ai/dsh`, desktop = `${local}/Programs/DeepSeek Harness`;
  for (const value of [codex, open, dsh, desktop]) dir(value);
  file(`${codex}/package.json`, JSON.stringify({ name: "@openai/codex", version: "0.154.0" }));
  file(`${codex}/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`);
  file(`${open}/package.json`, JSON.stringify({ name: "opencode-ai", version: "1.18.31" })); file(`${open}/bin/opencode.exe`);
  file(`${dsh}/package.json`, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.1", bin: { dsh: "lib/bin.js" } })); file(`${dsh}/lib/bin.js`);
  file("C:/Program Files/nodejs/node.exe");
  file(`${desktop}/DeepSeek Harness.exe`); file(`${desktop}/resources/app.asar`);
  const wrapper = '@echo off\nset "ELECTRON_RUN_AS_NODE=1"\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*';
  file(`${desktop}/resources/runtime/cli/bin/dsh.cmd`, wrapper);
  file(`${home}/.codex/models_cache.json`, JSON.stringify({ identity: "never-serialize-this", models: [
    { slug: "test/model", display_name: "模型一", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    { slug: "test/plain", display_name: "模型二", supported_reasoning_levels: [] } ] }));
  let behavior = "success", login = true;
  const dshModel = '["deepseek-official","test-model"]';
  const configs = (model) => [{ id: "model", category: "model", currentValue: model, options: [
    { value: model.startsWith("[") ? dshModel : "test/model", name: "模型一" }, { value: model.startsWith("[") ? '["deepseek-official","test-plain"]' : "test/plain", name: "模型二" } ] },
    ...(["test/model", dshModel].includes(model) ? [{ id: "reasoning", category: "thought_level", currentValue: "low", options: [{ value: "low" }, { value: "high" }] }] : [])];
  const subprocess = { async call(options) {
    starts.push(options);
    const stdout = new Pipe(), stderr = new Pipe();
    let resolve, ended = false, promptId = null;
    const done = new Promise((r) => { resolve = r; });
    const finish = (code = 0) => { if (!ended) { ended = true; stdout.end(); stderr.end(); resolve({ exitCode: code }); } };
    const emit = (value) => { const text = JSON.stringify(value) + "\n"; stdout.push(text.slice(0, 8)); stdout.push(text.slice(8)); };
    const args = options.arguments;
    const acp = args.includes("acp");
    let buffer = "", model = /DeepSeek Harness/.test(options.command) ? dshModel : "test/model";
    function respond(message) {
      messages.push(message);
      if (!message.method) {
        if (message.id === 88 && promptId && behavior === "unsupported") emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        if (message.id === 77 && promptId && behavior === "success") emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        if (message.id === 78 && promptId && behavior === "web") emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        return;
      }
      const result = (value) => emit({ jsonrpc: "2.0", id: message.id, result: value });
      if (message.method === "initialize") {
        if (behavior === "invalid") { stdout.push("not json\n"); return; }
        result({ protocolVersion: 1, authMethods: [], agentCapabilities: { promptCapabilities: { image: behavior !== "no-image" } } });
      } else if (message.method === "session/new") {
        if (behavior === "auth") emit({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Login required" } });
        else result({ sessionId: "session-1", configOptions: configs(model), modes: { availableModes: [{ id: "plan" }] } });
      } else if (message.method === "session/set_config_option") {
        if (message.params.configId === "model") model = message.params.value;
        result({ configOptions: configs(model) });
      } else if (message.method === "session/set_mode") result({});
      else if (message.method === "session/prompt") {
        promptId = message.id;
        if (behavior === "exit") { stderr.push("network connection refused sk-secret"); finish(7); return; }
        if (behavior === "empty") { result({ stopReason: "end_turn" }); return; }
        if (["vision-good", "vision-bad"].includes(behavior)) {
          const hasImage = message.params.prompt.some((block) => block.type === "image");
          const text = hasImage ? (behavior === "vision-good" ? "209，红色圆形，蓝色长方形" : "看不到图片") : "OK";
          emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
          result({ stopReason: "end_turn" }); return;
        }
        if (["stream", "stream-hang"].includes(behavior)) {
          const live = (update, sessionId = "session-1") => emit({ jsonrpc: "2.0", method: "sideline/assistant-stream", params: { sessionId, update: { sessionUpdate: "sideline_stream", ...update } } });
          live({ phase: "start", attemptId: "a" });
          live({ phase: "delta", attemptId: "a", text: "wrong" }, "foreign-session");
          live({ phase: "delta", attemptId: "old", text: "wrong" });
          live({ phase: "delta", attemptId: "a", text: "partial" });
          if (behavior === "stream-hang") return;
          setTimeout(() => {
            live({ phase: "start", attemptId: "retry" });
            live({ phase: "delta", attemptId: "retry", text: "correct" });
            live({ phase: "commit", attemptId: "retry", text: "correct answer" });
            emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "correct answer" } } } });
            result({ stopReason: "end_turn" });
          }, 25);
          return;
        }
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "部分回答" } } } });
        if (behavior === "web") {
          emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "tool_call", toolCallId: "web-1", title: "web_search", rawInput: { queries: ["public docs"] }, status: "in_progress" } } });
          emit({ jsonrpc: "2.0", id: 78, method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "web-1" }, options: [{ optionId: "allow-once", kind: "allow_once" }] } });
          return;
        }
        emit({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: { options: [{ optionId: "write", kind: "allow_once" }], toolCall: { title: "write file" } } });
        if (behavior === "unsupported") emit({ jsonrpc: "2.0", id: 88, method: "fs/write_text_file", params: { path: "C:/users/private" } });
      }
    }
    return { stdout, stderr, wait: () => done, kill: () => finish(-1),
      stdin: { write: async (text) => {
        buffer += text;
        if (acp) { let index; while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); respond(JSON.parse(line)); } }
      }, close: async () => {
        if (args.includes("--version")) { stdout.push(args[0] === "--version" && /opencode/.test(options.command) ? "1.18.31\n" : /DeepSeek/.test(options.command) ? "0.2.0-rc.2\n" : "0.154.0\n"); finish(); }
        else if (args[0] === "login") { stdout.push(login ? "Logged in using ChatGPT" : "Not logged in"); finish(login ? 0 : 1); }
        else if (args.includes("--help")) { stdout.push("exec --json --sandbox"); finish(); }
        else if (args.includes("session") && args.includes("delete")) finish();
        else if (!acp) {
          if (behavior === "empty") { finish(); return; }
          stdout.push('{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000001"}\n');
          stdout.push('{"type":"item.completed","item":{"type":"agent_message","text":"部分回答"}}\n');
          if (behavior === "hang") return;
          if (behavior === "exit") { stderr.push("network connection refused sk-secret"); finish(7); }
          else finish();
        }
      } } };
  } };
  const httpCalls = [];
  const h = createHost(projectRoot, { normalize, exists: (value) => files.has(normalize(value)) || dirs.has(normalize(value)),
    isDirectory: (value) => dirs.has(normalize(value)), read: (value) => { reads.push(normalize(value));
      if (!files.has(normalize(value))) throw new Error("missing fixture"); return files.get(normalize(value)); },
    directories: () => [], mkdir: dir, write: file, strictWindowsPaths: true, subprocess, dataDirectory: "C:\\fake-data\\sideline",
    remove: (value) => files.delete(normalize(value)),
    env: { USERPROFILE: home, APPDATA: `${home}/AppData/Roaming`, LOCALAPPDATA: local, ProgramFiles: "C:/Program Files", PATH: `${npm};C:/unknown`, npm_config_prefix: npm },
    http: async (method, url, options) => { httpCalls.push({ method, url, options });
      return { response: method === "GET" ? { data: [{ id: "vendor-model" }] } : { model: JSON.parse(options.body).model, choices: [{ message: { content: "OK" } }] } }; } });
  const s = h.Sideline;
  const pref = (key, value) => h.Zotero.Prefs.set(`sideline.${key}`, value);
  async function rejects(name, fn, regex) { let error; try { await fn(); } catch (caught) { error = caught; }
    check(name, !!error && regex.test(error.message), error && error.message); }
  pref("api", "https://legacy.example/v1"); pref("secretKey", "legacy-key"); pref("model", "legacy-model");
  equal("0.9 config: 旧文字接口读取回退", s.config.apiConfig().model, "legacy-model");
  pref("textSecretKey", ""); equal("0.9 config: 明确清空新密钥不复活旧密钥", s.config.apiConfig().secretKey, "");
  pref("textApi", "https://text.example/v1"); pref("textSecretKey", "text-key"); pref("textModel", "text-model");
  pref("visionUseText", false); pref("visionApi", "https://vision.example/v1"); pref("visionSecretKey", "vision-key"); pref("visionModel", "vision-model");
  pref("requestTimeoutMs", 73000);
  equal("0.10.8 timeout: 旧视觉配置沿用文字超时", s.config.apiConfig(undefined, true).requestTimeoutMs, 73000);
  pref("visionRequestTimeoutMs", 45000);
  equal("0.10.8 timeout: 视觉可独立设置", s.config.apiConfig(undefined, true).requestTimeoutMs, 45000);
  equal("0.10.8 timeout: 视觉不修改文字超时", s.config.apiConfig().requestTimeoutMs, 73000);

  await s.providers.chat({ messages: [{ role: "user", content: "文字" }], config: s.config.read() });
  equal("0.9 route: 文字服务商独立", httpCalls.at(-1).url, "https://text.example/v1/chat/completions");
  pref("textChannel", "api");
  await s.providers.chat({ messages: [{ role: "user", content: "看图" }], images: ["data:image/png;base64,AA"] });
  equal("route: API 模式图片使用独立视觉服务商", httpCalls.at(-1).url, "https://vision.example/v1/chat/completions");
  equal("0.9 route: 视觉独立密钥", httpCalls.at(-1).options.headers.Authorization, "Bearer vision-key");
  equal("0.10.8 timeout: 视觉实际 HTTP 请求使用独立超时", httpCalls.at(-1).options.timeout, 45000);
  await s.prefservice.apiTest(true);
  const testImage = JSON.parse(httpCalls.at(-1).options.body).messages[0].content.find((entry) => entry.type === "image_url").image_url.url;
  const png = Buffer.from(testImage.split(",")[1], "base64");
  const crc32 = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  let validPng = true, pixels;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString("ascii", offset + 4, offset + 8);
    validPng &&= png.readUInt32BE(offset + length + 8) === crc32(png.subarray(offset + 4, offset + 8 + length));
    if (type === "IDAT") pixels = inflateSync(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  check("0.10.8 vision: 测试 PNG 数据及所有 CRC 合法", validPng && png.readUInt32BE(16) === 64 && png.readUInt32BE(20) === 64 && pixels.length === (64 * 3 + 1) * 64);
  const originalHttp = h.Zotero.HTTP.request; let forbiddenReads = 0;
  const typed = (response) => ({ responseType: "json", response, get responseText() { forbiddenReads++; throw new Error("responseText is only available if responseType is text"); } });
  h.Zotero.HTTP.request = async () => typed({ model: "vision-model", choices: [{ message: { content: "OK" } }] });
  check("0.10.8 xhr: JSON 成功不访问 responseText", (await s.prefservice.apiTest(true)).ok && forbiddenReads === 0);
  h.Zotero.HTTP.request = async () => { throw Object.assign(new Error("HTTP 400"), { xmlhttp: typed({ error: { message: "invalid image text-key" } }) }); };
  await rejects("0.10.8 xhr: 视觉错误保留 HTTP 状态与真实原因", () => s.prefservice.apiTest(true), /HTTP 400.*invalid image/);
  try { await s.prefservice.apiTest(true); } catch (error) { check("0.10.8 xhr: 错误诊断仍隐藏密钥", !error.message.includes("text-key")); }
  equal("0.10.8 xhr: JSON 错误不触碰受限 getter", forbiddenReads, 0);
  h.Zotero.HTTP.request = async () => typed(null);
  await rejects("0.10.8 xhr: JSON 空响应给出可读原因", () => s.prefservice.apiTest(true), /没有返回有效 JSON/);
  h.Zotero.HTTP.request = async () => typed({ data: [{ id: "vision-model" }] });
  equal("0.10.8 xhr: 模型刷新也安全读取 JSON", (await s.prefservice.apiModels(true))[0], "vision-model");
  h.Zotero.HTTP.request = originalHttp;

  check("0.9 route: 配置摘要无密钥", !JSON.stringify(s.config.summary()).includes("vision-key"));
  pref("visionSecretKey", ""); await rejects("0.9 route: 视觉缺密钥不回退文字", () => s.providers.chat({ messages: [{ role: "user", content: "图" }], images: ["data:x"] }), /视觉/); pref("visionSecretKey", "vision-key");
  pref("deepseekVisionModel", "old-vision"); pref("visionModel", "");
  equal("0.9 config: 独立视觉清空不复活旧模型", s.config.apiConfig(undefined, true).model, ""); pref("visionModel", "vision-model");
  const found = await s.agents.discover();
  pref("textChannel", "agent");
  equal("0.9 discover: 三种 Agent 和两种 dsh 安装", found.length, 4);
  check("0.9 discover: 原生 dsh 优先", found.filter((entry) => entry.type === "dsh")[0].path === desktop);
  equal("0.9 discover: 多来源重复安装去重", (await s.agents.discover()).length, 4);
  check("0.9 discover: 无未知命令或包装器执行", starts.every((entry) => !/\.cmd|\.ps1|unknown/i.test(entry.command)));
  await rejects("0.9 manual: 拒绝 shell 文本", () => s.agents.add('codex && del C:'), /绝对路径/);
  dir("C:/unknown"); file("C:/unknown/codex.exe"); await rejects("0.9 manual: 同名 exe 不足以通过验证", () => s.agents.add("C:/unknown"), /已知安装结构/);
  const selectedBeforeAdd = s.config.read().agentInstallId;
  const manual = await s.agents.add(open + "/../opencode-ai");
  equal("0.10.8 manual: 添加其它路径保留已选 Agent", s.config.read().agentInstallId, selectedBeforeAdd);
  check("0.9 manual: 规范化路径并标记来源", manual.path === open && manual.source === "manual");
  s.agents.remove(manual.id); check("0.9 manual: 移除记录不删除程序", files.has(normalize(`${open}/bin/opencode.exe`)) && !s.agents.records().some((entry) => entry.id === manual.id));
  await s.agents.discover();
  const installs = await s.agents.list();
  const priorRegistry = s.config.str("agentInstalls"), priorSelection = s.config.read().agentInstallId;
  const selectedRecord = installs.find((entry) => entry.id === priorSelection), validate = s.agentinstall.validateInstall;
  const alias = { ...selectedRecord, id: `${selectedRecord.type}:c:/alias-agent`, path: "C:/alias-agent", source: "manual" };
  s.agentinstall.validateInstall = async (input, source) => input === alias.path ? { ...alias, source } : validate(input, source);
  await s.agents.add(alias.path);
  equal("0.10.8 manual: 同原生入口去重后映射当前选择", s.config.read().agentInstallId, alias.id);
  check("0.10.8 manual: 去重后的选择确实存在", s.agents.records().some((entry) => entry.id === s.config.read().agentInstallId));
  s.agentinstall.validateInstall = validate; pref("agentInstalls", priorRegistry); pref("agentInstallId", priorSelection);

  for (const type of ["codex", "opencode", "dsh"]) {
    const install = installs.find((entry) => entry.type === type);
    const probe = await s.agents.probe(install.id);
    check(`0.9 ${type}: 分阶段离线检测`, probe.stages.program === "pass" && probe.stages.version === "pass" && probe.stages.protocol === "pass" && probe.stages.request === "not-tested");
    const models = await s.agents.listModels(install.id);
    const testModel = type === "dsh" ? dshModel : "test/model";
    check(`0.9 ${type}: 模型目录与真实能力`, models.some((entry) => entry.id === testModel && entry.efforts.includes("high")));
    pref("agentInstallId", install.id); pref("agentModel", testModel); pref("agentEffort", "high");
    const beforeStart = starts.length;
    const early = s.providers.chat({ messages: [{ role: "user", content: "立刻停止" }], requestKey: `early-${type}` });
    s.providers.abort(`early-${type}`);
    await rejects(`0.9 ${type}: 启动前取消不漏请求`, () => early, /停止/);
    equal(`0.9 ${type}: 取消后不启动程序`, starts.length, beforeStart);
    behavior = "success"; const result = await s.providers.chat({ ownerID: 101 + ["codex", "opencode", "dsh"].indexOf(type), messages: [{ role: "user", content: "OK" }], requestKey: type });
    check(`0.9 ${type}: 统一回答与协议`, result.provider === "agent" && result.content === "部分回答" && result.protocol === (type === "codex" ? "jsonl" : "acp"));
    behavior = "hang"; let partial = "", release;
    const gotPartial = new Promise((resolve) => { release = resolve; });
    const running = s.providers.chat({ ownerID: 201 + ["codex", "opencode", "dsh"].indexOf(type), messages: [{ role: "user", content: "保留问题" }], requestKey: `stop-${type}`,
      onDelta: (_, whole) => { partial = whole; release(); } });
    const completion = running.then(() => null, (error) => error);
    await gotPartial; s.providers.abort(`stop-${type}`);
    const stopped = await completion;
    check(`0.9 ${type}: 真正终止且保留片段`, !!stopped && /停止|终止/.test(stopped.message) && partial === "部分回答" && stopped.partialContent === partial);
    behavior = "empty"; await rejects(`0.9 ${type}: 空回答诊断`, () => s.agents.run({ diagnostic: true, prompt: "OK" }), /空回答/);
    behavior = "exit"; await rejects(`0.9 ${type}: 退出码与 stderr 可读且隐藏密钥`, () => s.agents.run({ diagnostic: true, prompt: "OK" }), /7.*network/);
    behavior = "hang"; await rejects(`0.9 ${type}: 请求超时`, () => s.agents.run({ diagnostic: true, config: Object.assign({}, s.config.read(), { agentTimeoutMs: 60 }), prompt: "OK" }), /超时/);
    behavior = "success";
  }
  const streamInstall = installs.find((entry) => entry.type === "dsh");
  pref("agentInstallId", streamInstall.id); pref("agentModel", dshModel);
  behavior = "stream";
  let final = false;
  const progress = [];
  const liveReply = await s.agents.run({ diagnostic: true, prompt: "stream", onDelta: (_, whole) => { progress.push({ whole, beforeFinal: !final }); } });
  final = true;
  check("dsh adapter: live preview arrives before prompt completion", progress.some((e) => e.whole === "partial" && e.beforeFinal));
  equal("dsh adapter: committed answer is not duplicated by ACP completion", liveReply.content, "correct answer");
  check("dsh adapter: retry removes abandoned preview", !liveReply.content.includes("partial") && !progress.some((e) => e.whole.includes("wrong")));
  behavior = "stream-hang";
  let releaseStream;
  const gotLive = new Promise((resolve) => { releaseStream = resolve; });
  const interruptedLive = s.agents.run({ diagnostic: true, requestKey: "dsh-live-stop", prompt: "stop", onDelta: (_, whole) => { if (whole) releaseStream(); } });
  const stoppedLive = interruptedLive.catch((error) => error);
  await gotLive; s.agents.cancel("dsh-live-stop");
  equal("dsh adapter: cancellation retains transient text before commit", (await stoppedLive).partialContent, "partial");
  behavior = "success";
  check("0.9 ACP: 权限默认取消", messages.some((entry) => entry.id === 77 && entry.result && entry.result.outcome.outcome === "cancelled"));
  check("0.9 ACP: 不宣告文件/终端能力", messages.filter((entry) => entry.method === "initialize").every((entry) => entry.params.clientCapabilities.terminal === false && entry.params.clientCapabilities.fs.writeTextFile === false));
  const oi = installs.find((entry) => entry.type === "opencode");
  pref("agentInstallId", oi.id); pref("agentModel", "test/model"); pref("agentEffort", "");
  const challenge = await s.agentimages.challenge(), callsBeforeVision = httpCalls.length;
  behavior = "vision-good";
  const imageReply = await s.providers.chat({ ownerID: 95001, messages: [{ role: "user", content: "识图" }], images: [challenge.image],
    config: Object.assign({}, s.config.read(), { textApi: "", textSecretKey: "", visionApi: "", visionSecretKey: "", visionModel: "" }) });
  equal("Agent 视觉: 缺少所有 API 配置仍走 Agent", imageReply.provider, "agent");
  equal("Agent 视觉: 不发 HTTP 请求", httpCalls.length, callsBeforeVision);
  const sentImage = messages.filter((m) => m.method === "session/prompt").at(-1).params.prompt.find((b) => b.type === "image");
  check("Agent 视觉: ACP 传输原始 base64 与 MIME", sentImage.mimeType === "image/png" && sentImage.data === challenge.image.split(",")[1]);
  const composite = await s.agents.test(oi.id, { vision: true });
  check("Agent 视觉: 综合测试检验文字和图片内容", composite.stages.request === "pass" && composite.stages.vision === "pass");
  behavior = "vision-bad";
  const badVision = await s.agents.test(oi.id, { vision: true });
  check("Agent 视觉: 空洞的识图回答不算通过", badVision.stages.request === "pass" && badVision.stages.vision === "fail" && badVision.error.includes("未识别"));
  behavior = "no-image";
  const promptCount = messages.filter((m) => m.method === "session/prompt").length;
  await rejects("Agent 视觉: 不支持图片明确失败", () => s.agents.run({ diagnostic: true, prompt: "识图", images: [challenge.image] }), /未声明支持图片/);
  equal("Agent 视觉: 不支持图片时不提交推理", messages.filter((m) => m.method === "session/prompt").length, promptCount);
  equal("Agent 视觉: 失败不回退 API", httpCalls.length, callsBeforeVision);
  behavior = "success";
  await rejects("Agent 视觉: 拒绝远程地址", () => s.agents.run({ diagnostic: true, prompt: "图", images: ["https://private.example/image.png"] }), /base64/);
  const ciImage = installs.find((entry) => entry.type === "codex");
  for (const failed of [false, true]) {
    behavior = failed ? "exit" : "success";
    const imageOptions = { diagnostic: true, model: "test/model", prompt: "图片测试", images: [challenge.image] };
    if (failed) await rejects("Codex 视觉: 失败仍清理临时图片", () => s.codex.run(ciImage, imageOptions), /退出码 7/);
    else await s.codex.run(ciImage, imageOptions);
    const call = starts.filter((start) => start.arguments.includes("--image")).at(-1);
    const imagePath = call.arguments[call.arguments.indexOf("--image") + 1];
    check(`Codex 视觉: ${failed ? "失败" : "成功"} 后删除自有图片`, !files.has(normalize(imagePath)) && /sideline-image-.*\.png$/.test(imagePath));
    check("Codex 视觉: 图片参数和 stdin 提示词分开", call.arguments.at(-1) === "-" && !call.arguments.includes(challenge.image));
  }
  for (const stop of [false, true]) {
    behavior = "hang";
    const imageOptions = { diagnostic: true, model: "test/model", prompt: "图片中断测试", images: [challenge.image], timeoutMs: 50,
      onDelta() { if (stop) s.agents.cancel("image-stop"); } };
    pref("agentInstallId", ciImage.id); pref("agentModel", "test/model"); pref("agentEffort", "");
    await rejects(`Codex 视觉: ${stop ? "停止" : "超时"} 保留诊断`, () => s.agents.run({ ...imageOptions, requestKey: "image-stop",
      config: { ...s.config.read(), agentTimeoutMs: imageOptions.timeoutMs } }), stop ? /停止/ : /超时/);
    const call = starts.filter((start) => start.arguments.includes("--image")).at(-1);
    const imagePath = call.arguments[call.arguments.indexOf("--image") + 1];
    check(`Codex 视觉: ${stop ? "停止" : "超时"} 后临时图片已清理`, !files.has(normalize(imagePath)));
  }
  pref("agentInstallId", oi.id); pref("agentModel", "test/model");
  behavior = "success";
  for (const enabled of [false, true]) {
    pref("agentInstallId", oi.id); pref("agentModel", "test/model"); pref("agentSearch", enabled); behavior = "web";
    const reply = await s.agents.run({ diagnostic: true, prompt: "search" });
    const permission = messages.filter((entry) => entry.id === 78 && entry.result).at(-1).result.outcome;
    equal(`0.9.1 ACP: 只有 ID 的权限请求关联工具上下文 ${enabled}`, permission.outcome, enabled ? "selected" : "cancelled");
    equal("0.9.1 ACP: 返回实际观察到的工具状态", reply.webTools[0].name, "web_search");
  }
  pref("agentSearch", false);
  pref("agentInstallId", oi.id); pref("agentModel", "test/model"); behavior = "unsupported";
  await s.agents.run({ diagnostic: true, prompt: "OK" });
  check("0.9 ACP: 拒绝反向文件写入 RPC", messages.some((entry) => entry.id === 88 && entry.error && entry.error.code === -32601));
  const safetyArgs = s.codex.baseArgs({ search: false });
  check("0.9 Codex: 默认禁用 shell、MCP、插件与搜索", ["features.shell_tool=false", "mcp_servers={}", "features.plugins=false", 'web_search="disabled"'].every((value) => safetyArgs.includes(value)));
  check("0.9 Codex: 搜索显式开启", s.codex.baseArgs({ search: true })[0] === "--search");
  pref("agentInstallId", oi.id); behavior = "invalid";
  await rejects("0.9 ACP: 非协议 stdout 可读诊断", () => s.agents.run({ diagnostic: true, prompt: "OK" }), /JSON-RPC|协议/);
  behavior = "auth"; const auth = await s.agents.probe(oi.id); check("0.9 ACP: 未登录单独显示", auth.stages.authentication === "required");
  behavior = "success";
  login = false; const ci = installs.find((entry) => entry.type === "codex");
  const codexAuth = await s.agents.probe(ci.id); check("0.9 Codex: 未登录与协议分别检测", codexAuth.authentication === "required" && codexAuth.stages.protocol === "pass"); login = true;
  const di = installs.find((entry) => entry.type === "dsh"); dirs.delete(normalize(`${home}/.dsh`));
  const beforeFirst = messages.length, first = await s.agents.probe(di.id);
  check("0.9 dsh: 首次初始化提示与离线探测不启动 ACP", first.stages.protocol === "not-tested" && first.error.includes("初始化") && messages.length === beforeFirst);
  dir(`${home}/.dsh`);
  const modelState = s.agents.reconcile([{ id: "plain", efforts: [] }], "plain", "high");
  equal("0.9 model: 不支持强度不得沿用", modelState.effort, "");
  check("0.9 model: 失效模型保留并提示", s.agents.reconcile([], "old", "high").warning.includes("old"));
  const plain = await s.agents.listModels(oi.id, "test/plain");
  check("0.9 model: ACP 切换模型重新枚举强度", plain.find((entry) => entry.id === "test/plain").efforts.length === 0);
  pref("agentModel", "removed-model");
  const currentCatalog = await s.agents.listModels(oi.id, "removed-model");
  check("model: 旧模型失效仍返回可选目录并保留原选择", currentCatalog.length > 0 && s.config.read().agentModel === "removed-model");
  await rejects("model: 真实调用不静默替换失效模型", () => s.agents.run({ diagnostic: true, prompt: "OK" }), /失效/);
  pref("agentInstallId", "missing-id"); await rejects("0.9 agent: 失效安装不隐式改道", () => s.agents.run({ diagnostic: true, prompt: "OK" }), /失效/);
  check("0.9 credentials: 只读清单与模型缓存", reads.every((entry) => !/auth\.json|credential/i.test(entry)));
  check("0.9 cache: 不序列化身份元数据", !JSON.stringify(await s.codex.listModels()).includes("never-serialize-this"));
  check("0.9 diagnostic: 隐藏密钥与 token", !s.agents.diagnostic("Bearer token text-key sk-secret access_token=abc").includes("text-key") && !s.agents.diagnostic("sk-secret").includes("sk-secret"));
  // 面板控制器用真正 DOM 操作接口的轻量替代，运行真实 prefs-pane.js。
  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { tagName: id.endsWith("models") || id.endsWith("options") || id.endsWith("effort") || id.endsWith("install") || id === "text-channel" ? "html:select" : "html:input",
    get localName() { return this.tagName.split(":").pop(); },
    value: "", checked: false, disabled: false, textContent: "", dataset: {}, children: [], listeners: {},
    replaceChildren() { this.children = []; if (this.localName === "select") this.value = ""; },
    appendChild(child) { this.children.push(child); if (this.localName === "select" && this.children.length === 1) this.value = child.value; },
    setAttribute(name, value) { this[name] = value; }, focus() {}, contains(other) { return other === this; },
    setCustomValidity(value) { this.validationMessage = value; }, reportValidity() { this.validityReported = true; },
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); } }); return nodes.get(id); };
  const root = { dataset: {}, querySelector: (selector) => node(selector.replace("#sideline-", "")) };
  node("prompt-summarize").value = "已经保存的自定义提示词";
  let ticks, scans = 0, confirm = false, confirmations = 0;
  const bridge = Object.assign({}, s.prefservice, { scan: async () => { scans++; return s.agents.discover(); } });
  const prefsContext = vm.createContext({ Zotero: { SidelinePrefs: bridge },
    document: { getElementById: () => root, createElementNS: () => ({ value: "", textContent: "" }) },
    window: { confirm: () => { confirmations++; return confirm; } }, setInterval: (fn) => { ticks = fn; return 1; }, clearInterval: () => {} });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, "src/content/prefs-pane.js"), "utf8"), prefsContext);
  ticks(); await new Promise((resolve) => setTimeout(resolve, 10));
  equal("0.9 prefs: 打开设置不自动扫描", scans, 0);
  // 扫描后的显式选择与可见下拉必须和原 preference 保持一致。
  const savedList = bridge.list, savedInstallId = s.config.read().agentInstallId;
  bridge.list = async () => []; pref("agentInstallId", "");
  await root.sidelineController.renderInstalls();
  equal("0.10.7 prefs: 无扫描记录时 Agent 框为空", node("agent-install-display").value, "");
  bridge.list = savedList;
  node("agent-scan").listeners.click[0]({ type: "click" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  equal("0.10.7 prefs: 扫描后不自动选择 Agent", s.config.read().agentInstallId, "");
  equal("0.10.7 prefs: 扫描后显示请选择Agent", node("agent-install-display").value, "请选择Agent");
  const installMenu = root.sidelineController.modelMenus.install;
  installMenu.open();
  equal("0.10.7 prefs: 可用 Agent 显示在下拉中", node("agent-install-options").children.length, (await bridge.list()).length);
  node("agent-install-options").value = oi.id; installMenu.choose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  equal("0.10.7 prefs: 下拉选择保存 Agent", s.config.read().agentInstallId, oi.id);
  check("0.10.7 prefs: 框中显示选择的 Agent", node("agent-install-display").value.includes("OpenCode") && node("agent-install-popup").hidden);
  await root.sidelineController.renderInstalls();
  equal("0.10.7 prefs: 重新加载保留所选 Agent", node("agent-install").value, oi.id);
  const addRegistry = s.config.str("agentInstalls"), startsBeforeAdd = starts.length;
  node("agent-model").value = "test/plain"; pref("agentModel", "test/plain");
  node("agent-directory").value = codex; node("agent-add").listeners.click[0]({ type: "click" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  equal("0.10.8 prefs: 手动添加其它路径不清空 Agent 选择", node("agent-install").value, oi.id);
  equal("0.10.8 prefs: 非当前路径添加保留当前模型", node("agent-model").value, "test/plain");
  equal("0.10.8 prefs: 添加路径不自动检测模型", starts.length, startsBeforeAdd);
  equal("0.10.8 prefs: 添加后的下一步提示", node("agent-status").textContent, "安装记录已添加，需要离线检测模型");
  pref("agentInstalls", addRegistry); node("agent-directory").value = "";
  const beforeVersionList = bridge.list, startsBeforeVersion = starts.length;
  bridge.list = async () => (await beforeVersionList()).map(entry => entry.id === oi.id ? { ...entry, version: "changed-version" } : entry);
  node("agent-model").value = "old/model"; pref("agentModel", "old/model"); pref("agentEffort", "high");
  await root.sidelineController.renderInstalls();
  equal("0.10.8 prefs: 当前 Agent 版本变化清空旧模型", node("agent-model").value, "");
  equal("0.10.8 prefs: 当前 Agent 版本变化清空旧强度", s.config.read().agentEffort, "");
  equal("0.10.8 prefs: 环境变化不自动启动协议", starts.length, startsBeforeVersion);
  bridge.list = beforeVersionList; await root.sidelineController.renderInstalls();

  node("agent-scan").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 30));
  equal("0.10.7 prefs: 再次扫描保留已选择 Agent", node("agent-install").value, oi.id);
  const actualList = bridge.list;
  bridge.list = async () => [{ ...oi, status: "missing" }]; await root.sidelineController.renderInstalls();
  installMenu.open();
  equal("0.10.7 prefs: 失效安装不作为可用下拉选项", node("agent-install-options").children.length, 0);
  equal("0.10.7 prefs: 失效安装仍保留原配置供诊断", s.config.read().agentInstallId, oi.id);
  bridge.list = actualList; await root.sidelineController.renderInstalls();

  installMenu.open(); node("agent-install-options").listeners.keydown[0]({ key: "Escape" });
  equal("0.10.7 prefs: Agent 下拉可按 Escape 收起", node("agent-install-popup").hidden, true);
  node("agent-directory").value = "uncommitted-path"; node("agent-directory").listeners.input[0]();
  check("0.10.7 prefs: 未添加路径也可重置", !node("agent-remove").disabled);
  const resetRecords = s.config.str("agentInstalls");
  node("agent-remove").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 10));
  equal("0.10.7 prefs: 重置清空路径输入", node("agent-directory").value, "");
  equal("0.10.7 prefs: 重置输入不删除自动安装记录", s.config.str("agentInstalls"), resetRecords);
  const savedRemove = bridge.remove; let resetId = "", removedCustom = false;
  bridge.list = async () => removedCustom ? [] : [{ ...oi, source: "manual" }];
  bridge.remove = (id) => { resetId = id; removedCustom = true; pref("agentInstallId", ""); };
  await root.sidelineController.renderInstalls();
  node("agent-directory").value = "manual-path";
  node("agent-remove").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 10));
  equal("0.10.7 prefs: 重置只移除当前手动路径记录", resetId, oi.id);
  equal("0.10.7 prefs: 手动路径重置后取消选择", s.config.read().agentInstallId, "");
  equal("0.10.7 prefs: 手动路径重置清空输入", node("agent-directory").value, "");
  equal("0.10.7 prefs: 重置路径后不保留旧强度", s.config.read().agentEffort, "");
  bridge.remove = savedRemove; bridge.list = savedList;

  pref("agentInstallId", savedInstallId); await root.sidelineController.renderInstalls();

  equal("0.10.2 prefs: 控制器保留宿主恢复的提示词", node("prompt-summarize").value, "已经保存的自定义提示词");
  equal("0.10.2 prefs: 已有提示词的折叠状态准确", node("prompt-summarize-state").textContent, "已自定义");
  check("0.9 prefs: 扫描按钮用统一事件", node("agent-scan").listeners.command.length === 1 && node("agent-scan").listeners.click.length === 1);
  const beforeRequest = starts.length;
  node("agent-test").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 10));
  equal("0.9 prefs: 额度提示取消后不调用", starts.length, beforeRequest);
  pref("agentInstallId", oi.id); node("agent-model").value = "test/plain"; await root.sidelineController.renderInstalls();
  equal("0.9.2 prefs: 带前缀的 Agent select 刷新后恢复所选值", node("agent-install").value, oi.id);
  node("agent-probe").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 15));
  node("agent-model").value = "test/plain"; node("agent-model").listeners.change.at(-1)();
  await root.sidelineController.refreshModels();
  check("0.10.9 prefs: 模型列表与无效强度清除", node("agent-models").children.length === 2 && s.config.read().agentEffort === "");
  for (const type of ["codex", "opencode", "dsh"]) {
    const install = installs.find((entry) => entry.type === type);
    node("agent-model").value = "old/model"; pref("agentModel", "old/model"); pref("agentEffort", "high");
    const startsBeforeSelect = starts.length;
    node("agent-install").value = install.id;
    node("agent-install").listeners.change[0](); await new Promise((resolve) => setTimeout(resolve, 10));
    equal(`0.9.2 prefs: ${type} 点击选择后不回空`, node("agent-install").value, install.id);
    equal(`0.9.2 prefs: ${type} 保存所选安装`, s.config.read().agentInstallId, install.id);
    check(`0.10.8 prefs: ${type} 选择后清空旧模型和强度`, !node("agent-search").disabled && node("agent-model").value === "" && s.config.read().agentModel === "" && s.config.read().agentEffort === "" && node("agent-models").children.length === 0);
    equal(`0.10.8 prefs: ${type} 选择不自动启动检测`, starts.length, startsBeforeSelect);
    equal(`0.10.8 prefs: ${type} 选择后的手动步骤提示`, node("agent-status").textContent, "安装记录已添加，需要离线检测模型");
    node("agent-probe").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 15));
    check(`0.10.9 prefs: ${type} 手动离线检测加载模型`, node("agent-models").children.length === 2 && node("agent-status").textContent === "模型列表已刷新，请选择模型" && node("agent-model").value === "");
    const modelMenu = root.sidelineController.modelMenus.agent, effortMenu = root.sidelineController.modelMenus.effort;
    effortMenu.open(); equal(`0.10.9 prefs: ${type} 协议验证前不能选择强度`, node("agent-effort-popup").hidden, true);
    modelMenu.open(); node("agent-models").value = node("agent-models").children[0].value;
    const startsBeforeModel = starts.length; modelMenu.choose();
    equal(`0.10.9 prefs: ${type} 选择模型不自动验证`, starts.length, startsBeforeModel);
    equal(`0.10.9 prefs: ${type} 选好模型提示协议步骤`, node("agent-status").textContent, "模型选择完成，请验证请求协议");
    node("agent-model-refresh").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 15));
    equal(`0.10.9 prefs: ${type} 协议验证提示选择强度`, node("agent-status").textContent, "思考协议验证完成，请选择思考强度");
    effortMenu.open(); node("agent-effort-options").value = ""; effortMenu.choose();
    equal(`0.10.9 prefs: ${type} 明确选择默认也进入连接测试步骤`, node("agent-status").textContent, "请测试连接状态");
    effortMenu.open(); node("agent-effort-options").value = "high"; effortMenu.choose();
    equal(`0.10.9 prefs: ${type} 改强度不退回离线阶段`, node("agent-status").textContent, "请测试连接状态");
    modelMenu.open(); node("agent-models").value = node("agent-models").children[1].value; modelMenu.choose();
    check(`0.10.9 prefs: ${type} 换模型要求重验并清空强度`, node("agent-status").textContent === "模型选择完成，请验证请求协议" && s.config.read().agentEffort === "" && node("agent-effort-options").children.length === 0);
    await root.sidelineController.renderInstalls();
    equal(`0.9.2 prefs: ${type} 再次刷新仍保留选择`, node("agent-install").value, install.id);
  }
  const realModels = bridge.models;
  bridge.models = async () => { throw new Error("模型目录读取失败"); };
  node("agent-install").value = oi.id; node("agent-install").listeners.change[0]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  node("agent-probe").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 15));
  node("agent-model").value = "test/model"; node("agent-model").listeners.change.at(-1)();
  node("agent-model-refresh").listeners.click[0]({ type: "click" }); await new Promise((resolve) => setTimeout(resolve, 10));
  equal("0.9.2 prefs: 模型刷新失败也不撤销 Agent 选择", node("agent-install").value, oi.id);
  check("0.9.2 prefs: 模型失败独立报告", node("agent-result").textContent.includes("模型目录读取失败"));
  bridge.models = realModels;
  pref("agentEffort", "high"); node("agent-model").value = "test/model";
  await root.sidelineController.refreshModels();
  equal("0.10.9 prefs: 重新验证协议等待明确选择强度", node("agent-effort").value, "");
  const effortMenu = root.sidelineController.modelMenus.effort;
  effortMenu.open(); node("agent-effort-options").value = ""; effortMenu.choose();
  equal("0.10.7 prefs: 思考强度下拉可恢复默认", s.config.read().agentEffort, "");
  equal("0.10.7 prefs: 默认强度显示同步", node("agent-effort-display").value, "默认 / 不指定");
  effortMenu.open(); node("agent-effort-options").value = "high"; effortMenu.choose();
  equal("0.10.7 prefs: 思考强度选择持久化", s.config.read().agentEffort, "high");
  equal("0.10.7 prefs: 思考强度选择后显示并收起", node("agent-effort-display").value, "high");
  equal("0.10.7 prefs: 思考强度下拉已关闭", node("agent-effort-popup").hidden, true);

  for (const kind of ["text", "vision", "agent"]) {
    const menu = root.sidelineController.modelMenus[kind];
    menu.set([{ value: "model/a", label: "Alpha" }, { value: "model/b", label: "Beta" }]);
    node(`${kind}-model`).value = "manual/model";
    menu.open(); equal(`0.9.1 prefs: ${kind} 下拉显式打开`, node(`${kind}-model-popup`).hidden, false);
    node(`${kind}-model-filter`).value = "Beta"; node(`${kind}-model-filter`).listeners.input[0]();
    equal(`0.9.1 prefs: ${kind} 名称过滤`, node(`${kind}-models`).children.length, 1);
    equal(`0.9.1 prefs: ${kind} 刷新不替换手填模型`, node(`${kind}-model`).value, "manual/model");
    node(`${kind}-models`).value = "model/b"; menu.choose();
    equal(`0.9.1 prefs: ${kind} 选择落入配置`, s.config.read()[`${kind}Model`], "model/b");
    equal(`0.9.1 prefs: ${kind} 选择后关闭`, node(`${kind}-model-popup`).hidden, true);
    menu.open(); node(`${kind}-model-filter`).listeners.keydown[0]({ key: "Escape" });
    equal(`0.9.1 prefs: ${kind} Escape 关闭`, node(`${kind}-model-popup`).hidden, true);
  }
  root.sidelineController.stages(first); check("prefs: 展示阶段及初始化原因", node("agent-result").textContent.includes("文字请求：未测试") && node("agent-result").textContent.includes("初始化"));
  // 首选项单位适配及异步状态：用控制器实际事件验证保存语义与过期结果，不调用真实模型。
  const fire = (id, event = "change") => { for (const callback of node(id).listeners[event] || []) callback({ type: event }); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const markup = fs.readFileSync(path.join(projectRoot, "src/content/prefs-pane.xhtml"), "utf8");
  check("0.10.9 prefs: Agent 模型只读，API 模型仍可编辑",
    /id="sideline-agent-model"[^>]*readonly="readonly"/.test(markup)
    && !/id="sideline-(?:text|vision)-model"[^>]*readonly=/.test(markup));
  check("0.10.9 prefs: 功能标题说明与删除项落在实际页面",
    markup.includes("<html:h3>功能</html:h3>")
    && markup.includes("展开需要修改的功能；留空使用内置提示词；提示词不显示在对话里；划词弹窗的翻译功能与文本翻译提示词一致")
    && !markup.includes("sideline-prompt-logic"));
  fire("agent-probe", "click"); await settle();
  equal("0.10.9 prefs: 重刷列表要求重新选择并清空旧强度", node("agent-status").textContent, "模型列表已刷新，请选择模型");
  const agentModelMenu = root.sidelineController.modelMenus.agent;
  node("agent-model").listeners.click[0]();
  equal("0.10.9 prefs: 只读模型框点击可展开", node("agent-model-popup").hidden, false);
  node("agent-models").value = "test/plain"; agentModelMenu.choose();
  fire("agent-model-refresh", "click"); await settle();
  check("0.10.9 prefs: 无思考强度的模型仍允许选择默认",
    node("agent-status").textContent === "思考协议验证完成，请选择思考强度"
    && node("agent-effort-options").children.length === 1 && node("agent-effort-options").children[0].value === "");
  effortMenu.open(); node("agent-effort-options").value = ""; effortMenu.choose();
  node("agent-search").checked = !node("agent-search").checked; fire("agent-search");
  equal("0.10.9 prefs: 修改联网参数仅要求重新测试连接", node("agent-status").textContent, "请测试连接状态");
  let finishProtocol;
  bridge.models = () => new Promise((resolve) => { finishProtocol = resolve; });
  fire("agent-model-refresh", "click");
  agentModelMenu.open(); node("agent-models").value = "test/model"; agentModelMenu.choose();
  finishProtocol([{ id: "test/plain", efforts: [] }]); await settle();
  check("0.10.9 prefs: 旧协议结果不覆盖新模型与步骤",
    node("agent-model").value === "test/model" && node("agent-status").textContent === "模型选择完成，请验证请求协议"
    && node("agent-effort-options").children.length === 0);
  bridge.models = async () => [{ id: "test/plain", efforts: [] }];
  fire("agent-model-refresh", "click"); await settle();
  check("0.10.9 prefs: 协议目录丢失所选模型不能宣称完成",
    node("agent-status").dataset.state === "fail" && node("agent-result").textContent.includes("所选模型已不在协议返回的列表中"));
  bridge.models = realModels;
  const timeoutBefore = s.config.read().agentTimeoutMs;
  equal("0.10.2 prefs: API 超时以秒读取", node("text-timeout-seconds").value, String(s.config.read().requestTimeoutMs / 1000));
  equal("0.10.8 prefs: 视觉超时以秒读取", node("vision-timeout-seconds").value, "45");
  const priorTextTimeout = s.config.read().requestTimeoutMs;
  node("vision-timeout-seconds").value = "67.5"; fire("vision-timeout-seconds");
  equal("0.10.8 prefs: 视觉超时独立持久化", s.config.read().visionRequestTimeoutMs, 67500);
  equal("0.10.8 prefs: 修改视觉超时不改文字", s.config.read().requestTimeoutMs, priorTextTimeout);

  equal("0.10.2 prefs: Agent 超时以秒读取", node("agent-timeout-seconds").value, String(timeoutBefore / 1000));
  node("agent-timeout-seconds").value = "180.5"; fire("agent-timeout-seconds");
  equal("0.10.2 prefs: 秒转换为原有毫秒整数", s.config.read().agentTimeoutMs, 180500);
  equal("0.10.2 prefs: 毫秒绑定镜像同步", node("agent-timeout-ms").value, "180500");
  for (const value of ["", "-1", "0", "2147483.648", "Infinity"]) {
    node("agent-timeout-seconds").value = value; fire("agent-timeout-seconds");
    equal(`0.10.2 prefs: 无效秒数 ${value || "空"} 不覆盖配置`, s.config.read().agentTimeoutMs, 180500);
    check(`0.10.2 prefs: 无效秒数 ${value || "空"} 有反馈`, !!node("agent-timeout-seconds").validationMessage);
  }
  node("agent-timeout-ms").value = "120501"; fire("agent-timeout-ms", "syncfrompreference");
  equal("0.10.2 prefs: 宿主毫秒同步保留小数秒", node("agent-timeout-seconds").value, "120.501");
  check("0.10.2 prefs: 宿主同步清除旧输入错误", !node("agent-timeout-seconds").validationMessage);
  pref("agentTimeoutMs", timeoutBefore); node("agent-timeout-ms").value = String(timeoutBefore); fire("agent-timeout-ms", "syncfrompreference");
  node("prompt-explain").value = "自定义提示词"; fire("prompt-explain", "input");
  equal("0.10.2 prefs: 折叠摘要显示自定义状态", node("prompt-explain-state").textContent, "已自定义");
  node("prompt-explain").value = "  "; fire("prompt-explain", "syncfrompreference");
  equal("0.10.2 prefs: 宿主同步空提示词使用内置", node("prompt-explain-state").textContent, "使用内置");
  const offline = { stages: { program: "pass", protocol: "pass", request: "not-tested" } };
  equal("0.10.2 prefs: 离线通过不宣称真实请求可用", root.sidelineController.agentOutcome(offline, false).state, "catalog");
  equal("0.10.2 prefs: 未验证的真实请求不标绿", root.sidelineController.agentOutcome(offline, true).state, "idle");
  equal("0.10.2 prefs: 真实请求通过才标绿", root.sidelineController.agentOutcome({ stages: { request: "pass" } }, true).state, "pass");
  equal("0.10.2 prefs: 部分通过不能掩盖失败阶段", root.sidelineController.agentOutcome({ stages: { request: "pass", authentication: "required" } }, true).state, "fail");
  const originalTest = bridge.apiTest, originalApiModels = bridge.apiModels, originalProbe = bridge.probe;
  const reply = { model: "ui/test", protocol: "HTTP", elapsedMs: 1200, request: { max_tokens: 2048, max_tokens_type: "number" } };
  let finishTest, testCalls = 0;
  bridge.apiTest = () => { testCalls++; return new Promise((resolve) => { finishTest = resolve; }); };
  confirm = true; node("text-test").textContent = "测试连接"; fire("text-test", "click");
  check("0.10.2 prefs: 检测期间按钮与状态反馈", node("text-test").disabled && node("text-test")["aria-busy"] === "true" && node("text-status").dataset.state === "busy");
  node("text-model").value = "ui/new"; fire("text-model"); finishTest(reply); await settle();
  check("0.10.2 prefs: 修改模型后过期请求不标绿", node("text-status").dataset.state === "idle" && !node("text-result").textContent);
  check("0.10.2 prefs: 完成后恢复按钮标题与可用状态", !node("text-test").disabled && node("text-test").textContent === "测试连接" && node("text-test")["aria-busy"] === "false");
  bridge.apiTest = async () => { testCalls++; return reply; };
  fire("text-test", "click"); await settle();
  check("0.10.2 prefs: 当前配置测试成功有耗时和详情", node("text-status").dataset.state === "pass" && node("text-status").textContent.includes("1.2") && node("text-result").textContent.includes("2048"));
  const callsBeforeDirect = testCalls, promptsBeforeDirect = confirmations; confirm = false; fire("text-test", "click"); await settle();
  check("0.10.3 prefs: API 点击直接测试且无额度弹窗", testCalls === callsBeforeDirect + 1 && confirmations === promptsBeforeDirect && node("text-status").dataset.state === "pass");
  const visionBefore = testCalls;
  let testedVision = false;
  bridge.apiTest = async (vision) => { testCalls++; testedVision = vision; return reply; };
  node("vision-use-text").checked = true; fire("vision-use-text");
  node("vision-model").value = ""; fire("vision-model");
  equal("0.10.3 prefs: 沿用基址密钥且模型空白也先显示已配置未检测", node("vision-status").textContent, "已配置 · 未检测");
  fire("vision-test", "click"); await settle();
  check("0.10.3 prefs: 沿用文字接口仍独立执行视觉测试", testedVision === true && testCalls === visionBefore + 1 && confirmations === promptsBeforeDirect && node("vision-status").dataset.state === "pass");
  check("0.10.3 prefs: 视觉测试成功保持文字检测结果", node("text-status").dataset.state === "pass");
  node("vision-use-text").checked = false; fire("vision-use-text");
  for (const id of ["vision-api", "vision-key"]) { node(id).value = ""; fire(id); }
  equal("0.10.3 prefs: 独立接口缺少基址密钥显示未配置完整", node("vision-status").textContent, "未配置完整");
  node("vision-api").value = "https://vision.example/v1"; fire("vision-api");
  equal("0.10.3 prefs: 独立接口只有基址仍未配置完整", node("vision-status").textContent, "未配置完整");
  node("vision-key").value = "ui-vision-key"; fire("vision-key");
  equal("0.10.3 prefs: 独立基址密钥齐全显示已配置未检测", node("vision-status").textContent, "已配置 · 未检测");
  fire("vision-test", "click"); await settle();
  node("text-api").value = "https://unrelated.example/v1"; fire("text-api");
  equal("0.10.3 prefs: 独立视觉接口不受文字基址修改影响", node("vision-status").dataset.state, "pass");
  node("vision-use-text").checked = true; fire("vision-use-text"); fire("vision-test", "click"); await settle();
  node("text-key").value = "ui-changed-key"; fire("text-key");
  equal("0.10.3 prefs: 沿用密钥变动清除视觉连接成功", node("vision-status").textContent, "已配置 · 未检测");
  let finishModels;
  bridge.apiModels = () => new Promise((resolve) => { finishModels = resolve; });
  root.sidelineController.modelMenus.text.set([{ value: "ui/current" }]);
  fire("text-refresh", "click"); node("text-api").value = "https://changed.example/v1"; fire("text-api");
  finishModels(["ui/obsolete"]); await settle();
  check("0.10.2 prefs: 过期模型目录不覆盖新配置列表", node("text-models").children.some((entry) => entry.value === "ui/current") && !node("text-models").children.some((entry) => entry.value === "ui/obsolete"));
  bridge.apiModels = async () => ["ui/a", "ui/b"]; fire("text-refresh", "click"); await settle();
  check("0.10.3 prefs: 模型目录成功仍保持未检测状态", node("text-status").dataset.state === "idle" && node("text-status").textContent.includes("未检测"));
  bridge.apiTest = async () => reply; fire("text-test", "click"); await settle();
  fire("text-refresh", "click"); await settle();
  equal("0.10.3 prefs: 刷新目录不撤销同一配置连接成功", node("text-status").dataset.state, "pass");
  bridge.apiTest = () => new Promise((resolve) => { finishTest = resolve; });
  fire("text-test", "click"); fire("text-refresh", "click"); await settle(); finishTest(reply); await settle();
  check("0.10.3 prefs: 并发操作结束后不残留检测中", node("text-status").dataset.state !== "busy" && !node("text-test").disabled && !node("text-refresh").disabled);
  bridge.apiTest = async () => { throw new Error("请求被拒绝"); }; confirm = true;
  fire("text-test", "click"); await settle();
  check("0.10.2 prefs: 失败可见且恢复按钮", node("text-status").dataset.state === "fail" && node("text-result").textContent.includes("请求被拒绝") && !node("text-test").disabled);
  let finishProbe;
  bridge.probe = () => new Promise((resolve) => { finishProbe = resolve; });
  fire("agent-probe", "click"); node("agent-install").value = ci.id; fire("agent-install"); await settle();
  finishProbe({ name: "old-agent", stages: { program: "pass", protocol: "pass", request: "pass" } }); await settle();
  check("0.10.2 prefs: 切换 Agent 后旧检测不覆盖新状态", node("agent-status").dataset.state !== "pass" && !node("agent-result").textContent.includes("old-agent") && node("agent-install").value === ci.id);
  // 综合检测按当前文字通道路由，视觉始终独立；下拉仅用文字按钮，不调用系统选中标记菜单。
  const originalAgentTest = bridge.test, channel = root.sidelineController.channelMenu;
  channel.open(); equal("0.10.4 prefs: 通道下拉显式展开", node("channel-popup").hidden, false);
  channel.choose("api"); equal("0.10.4 prefs: 通道选择持久化", s.config.read().textChannel, "api");
  equal("0.10.8 prefs: 通道框显示 API", node("channel-display").value, "API");
  check("0.10.4 prefs: 选择后收起并同步无图标选项的辅助状态", node("channel-popup").hidden && node("channel-api")["aria-selected"] === "true" && node("channel-agent")["aria-selected"] === "false");
  channel.open(); node("channel-api").listeners.keydown[0]({ key: "Escape" });
  equal("0.10.4 prefs: 通道下拉 Escape 收起", node("channel-popup").hidden, true);
  let callsForCombined = [], agentCombined = 0;
  bridge.apiTest = async (vision) => { callsForCombined.push(vision ? "vision" : "text"); return reply; };
  bridge.test = async (_, options) => { agentCombined++; return { stages: { program: "pass", protocol: "pass", request: "pass", vision: options?.vision ? "pass" : "not-tested" } }; };
  fire("route-test", "click"); await settle();
  check("0.10.4 prefs: API 综合测试同时探测文字及视觉", callsForCombined.join(",") === "text,vision" && agentCombined === 0);
  check("0.10.4 prefs: 两项成功才显示综合成功", node("route-status").dataset.state === "pass" && node("route-result").textContent.includes("文字 API") && node("route-result").textContent.includes("视觉 API"));
  callsForCombined = [];
  bridge.apiTest = async (vision) => { callsForCombined.push(vision ? "vision" : "text"); if (!vision) throw new Error("文字失败"); return reply; };
  fire("route-test", "click"); await settle();
  check("0.10.4 prefs: 文字失败仍执行视觉且综合失败", callsForCombined.join(",") === "text,vision" && node("vision-status").dataset.state === "pass" && node("route-status").dataset.state === "fail");
  check("0.10.4 prefs: 综合失败显示两项诊断", node("route-result").textContent.includes("文字失败") && node("route-result").textContent.includes("视觉 API：连接成功"));
  bridge.apiTest = async (vision) => { if (vision) throw new Error("视觉失败"); return reply; };
  fire("route-test", "click"); await settle();
  check("0.10.4 prefs: 视觉失败不能被文字成功掩盖", node("text-status").dataset.state === "pass" && node("route-status").dataset.state === "fail");
  channel.choose("agent"); callsForCombined = [];
  bridge.apiTest = async (vision) => { callsForCombined.push(vision ? "vision" : "text"); return reply; };
  fire("route-test", "click"); await settle();
  check("prefs: Agent 综合测试不调用任何 API", agentCombined === 1 && callsForCombined.length === 0 && node("route-status").dataset.state === "pass");
  check("prefs: Agent 文字和视觉结果分别显示", node("agent-status").dataset.state === "pass" && node("route-result").textContent.includes("文字（Agent）") && node("route-result").textContent.includes("视觉（Agent）"));
  node("vision-model").value = "unused-model"; fire("vision-model");
  equal("prefs: Agent 综合成功不受未使用的视觉 API 设置影响", node("route-status").dataset.state, "pass");
  bridge.test = async () => ({ stages: { request: "pass", vision: "fail" }, error: "不支持图片" });
  fire("route-test", "click"); await settle();
  equal("prefs: Agent 只有文字通过时不能标绿", node("route-status").dataset.state, "fail");
  bridge.test = async () => ({ stages: { program: "pass", protocol: "pass", request: "fail" }, error: "Agent 不可用" });
  fire("route-test", "click"); await settle();
  equal("0.10.4 prefs: Agent 返回失败阶段导致综合失败", node("route-status").dataset.state, "fail");
  check("0.10.4 prefs: 综合完成恢复按钮", !node("route-test").disabled && node("route-test")["aria-busy"] === "false");
  channel.choose("api");
  let finishTextCombined, finishVisionCombined;
  bridge.apiTest = (vision) => new Promise((resolve) => { if (vision) finishVisionCombined = resolve; else finishTextCombined = resolve; });
  fire("route-test", "click");
  check("0.10.4 prefs: 两项请求均在完成前启动", !!finishTextCombined && !!finishVisionCombined && node("route-test").disabled);
  finishTextCombined(reply); await settle();
  equal("0.10.4 prefs: 一项完成仍等待另一项", node("route-status").dataset.state, "busy");
  finishVisionCombined(reply); await settle();
  equal("0.10.4 prefs: 最后一项完成才综合成功", node("route-status").dataset.state, "pass");
  fire("route-test", "click"); channel.choose("agent");
  finishTextCombined(reply); finishVisionCombined(reply); await settle();
  check("0.10.4 prefs: 检测期间切换通道不采用旧成功", node("route-status").dataset.state === "idle" && !node("route-result").textContent);
  check("0.10.4 prefs: 失效综合测试不留下子项检测中", node("text-status").dataset.state !== "busy" && node("vision-status").dataset.state !== "busy");
  channel.choose("api");
  fire("route-test", "click"); node("vision-model").value = "another-vision"; fire("vision-model");
  finishTextCombined(reply); finishVisionCombined(reply); await settle();
  equal("0.10.4 prefs: 检测期间视觉参数变更不采用旧成功", node("route-status").dataset.state, "idle");
  bridge.apiTest = async () => reply; fire("route-test", "click"); await settle();
  node("agent-search").checked = !node("agent-search").checked; fire("agent-search");
  equal("0.10.4 prefs: API 通道不受未使用的 Agent 设置影响", node("route-status").dataset.state, "pass");
  fire("vision-test", "click"); await settle();
  equal("0.10.4 prefs: 单项重新检测清除旧综合成功", node("route-status").dataset.state, "idle");
  node("text-channel").value = "agent"; fire("text-channel", "syncfrompreference");
  equal("0.10.4 prefs: 宿主同步恢复通道显示", node("channel-display").value, "Agent");
  bridge.test = originalAgentTest;
  Object.assign(bridge, { apiTest: originalTest, apiModels: originalApiModels, probe: originalProbe });
  return { Sideline: s, use(type) {
    behavior = "hang";
    const install = installs.find((entry) => entry.type === type);
    pref("agentInstallId", install.id); pref("agentModel", type === "dsh" ? dshModel : "test/model"); pref("agentEffort", "");
    pref("textChannel", "agent");
  } };
}
