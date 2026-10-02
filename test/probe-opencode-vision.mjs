/*
 * OpenCode + DeepSeek 视觉实测：读取本地已配置模型，经真实 ACP 发送合成测试图片。
 * 输入：src 自带的合成视觉测试资源；输出：脱敏能力、所选模型、正文与耗时报告。
 * 依赖：agent-host 与 src/acp；不读凭据、不修改用户配置、不提供文件/终端权限。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./agent-host.mjs";

if (!process.argv.includes("--minimal")) throw new Error("真实图片调用需要显式 --minimal");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "runtime", "opencode-vision-probe-work");
fs.mkdirSync(directory, { recursive: true });
const { Sideline: s } = createHost(root, { dataDirectory: directory });
const fixture = await s.agentimages.challenge();
const report = { timestamp: new Date().toISOString(), host: "Node ACP bridge; not Zotero UI",
  expected: fixture.expected, tests: [] };
const image = s.agentimages.parse(fixture.image).data;
let client, session, install;
try {
  install = await s.agentinstall.validateInstall(path.join(process.env.APPDATA, "npm/node_modules/opencode-ai"), "manual");
  const prepared = await s.agentweb.setup(install, false, directory);
  report.install = { version: install.version, type: install.type };
  let answer = "";
  const started = Date.now();
  client = await s.acp.connect(prepared, { cwd: directory, timeoutMs: 120000, allowWeb: false,
    onUpdate(params) {
      const update = params.update || {};
      if (session && params.sessionId === session.sessionId && update.sessionUpdate === "agent_message_chunk"
        && update.content?.type === "text") answer += update.content.text || "";
    } });
  report.capabilities = client.initialized.agentCapabilities || {};
  session = await s.acp.newSession(client, directory);
  const catalog = s.acp.catalog(session);
  report.deepseekModels = catalog.models.filter((model) => model.id.startsWith("deepseek/")).map(({ id, name }) => ({ id, name }));
  console.log(JSON.stringify({ capabilities: report.capabilities, deepseekModels: report.deepseekModels }));
  const model = report.deepseekModels.find((m) => m.id === "deepseek/deepseek-flash")
    || report.deepseekModels.find((m) => /flash/i.test(m.id));
  if (!model) throw new Error("OpenCode 未返回可选的 DeepSeek Flash 模型");
  await s.acp.selectModel(client, session, model.id);
  const modes = session.modes?.availableModes || [];
  if (modes.some((m) => m.id === "plan")) await client.request("session/set_mode", { sessionId: session.sessionId, modeId: "plan" });
  const testStarted = Date.now();
  const test = { model: s.acp.catalog(session).currentModel, acceptedImage: false, recognizesImage: false };
  try {
    const reply = await client.request("session/prompt", { sessionId: session.sessionId, prompt: [
      { type: "text", text: fixture.prompt },
      { type: "image", mimeType: "image/png", data: image },
    ] }, 90000);
    test.acceptedImage = reply.stopReason === "end_turn";
    test.stopReason = reply.stopReason;
    test.answer = s.agents.diagnostic(answer.trim());
    test.recognizesImage = answer.includes(report.expected.digits) && /红/.test(answer) && /圆/.test(answer) && /蓝/.test(answer) && /矩形|长方形/.test(answer);
  } catch (error) { test.error = s.agents.diagnostic(error.message); test.answer = s.agents.diagnostic(answer.trim()); }
  test.elapsedMs = Date.now() - testStarted; report.tests.push(test); report.totalElapsedMs = Date.now() - started;
  console.log(JSON.stringify({ test }));
} catch (error) { report.error = s.agents.diagnostic(error.message); console.log(JSON.stringify({ error: report.error })); }
finally {
  if (client) { client.close(); await client.done.catch(() => {}); }
  if (install && session?.sessionId) {
    try { await s.agentacp.discard(install, { sessionId: session.sessionId, cwd: directory }); report.testSessionRemoved = true; }
    catch (error) { report.cleanupError = s.agents.diagnostic(error.message); }
  }
  fs.writeFileSync(path.join(root, "runtime/opencode-vision-probe.json"), JSON.stringify(report, null, 2), "utf8");
}

if (report.error || report.cleanupError || report.tests.length !== 1 || !report.tests[0].recognizesImage) process.exitCode = 1;
