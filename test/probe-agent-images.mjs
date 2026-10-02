/*
 * 三种 Agent 的真实图片与会话恢复验收；输入为插件自带合成图，输出为脱敏 JSON。
 * --minimal 才调用模型。经真实 providers/会话管理/适配器，不配置 HTTP API、不读凭据。
 * 第二轮重建 Node 宿主，验证恢复原会话且不再发送图片。仅清理本次生成的测试会话。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./agent-host.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv.includes("--minimal")) throw new Error("真实图片调用需要 --minimal");
const dataDirectory = path.join(root, "runtime", `agent-image-probe-${Date.now()}`);
const report = { timestamp: new Date().toISOString(), host: "Node bridge; not Zotero UI/Gecko", tests: [] };
const paths = { codex: path.join(process.env.APPDATA, "npm/node_modules/@openai/codex"),
  opencode: path.join(process.env.APPDATA, "npm/node_modules/opencode-ai"),
  dsh: path.join(process.env.LOCALAPPDATA, "Programs/DeepSeek Harness") };
for (const [index, type] of ["opencode", "codex", "dsh"].entries()) {
  if (process.argv.includes("--dsh-only") && type !== "dsh") continue;
  let h = createHost(root, { dataDirectory }), s = h.Sideline;
  const ownerID = 188001 + index, row = { type };
  try {
    const install = await s.agentinstall.validateInstall(paths[type], "manual");
    s.config.set("agentInstalls", JSON.stringify([install]));
    const probe = await s.agents.probe(install.id);
    row.version = probe.version; row.protocol = install.protocol;
    row.offline = probe.stages;
    if (probe.stages.protocol !== "pass") throw new Error(probe.error || "离线协议失败");
    const models = probe.models || [];
    const model = type === "opencode" ? models.find((m) => m.id === "deepseek/deepseek-flash")
      : type === "dsh" ? models.find((m) => m.id === '["deepseek-official","deepseek-flash"]') || models[0]
        : models.find((m) => /mini|flash|luna/i.test(m.id)) || models[0];
    if (!model) throw new Error("模型目录为空");
    row.model = model.id;
    const config = { textChannel: "agent", agentInstallId: install.id, agentModel: model.id,
      agentEffort: "", agentSearch: false, agentTimeoutMs: 120000,
      textApi: "", textSecretKey: "", textModel: "", visionApi: "", visionSecretKey: "", visionModel: "", visionUseText: false };
    const fixture = await s.agentimages.challenge();
    const messages = [{ role: "system", content: "只回答测试问题，不使用任何工具。" },
      { role: "user", content: fixture.prompt, images: [fixture.image] }];
    const first = await s.providers.chat({ ownerID, messages, images: [fixture.image], config });
    row.first = { answer: first.content, elapsedMs: first.elapsedMs, recognizesImage: s.agentimages.recognized(first.content, fixture.expected) };
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: "请只回复刚才图片中的三位数字。这次没有新图片，不使用工具。" });
    h = createHost(root, { dataDirectory }); s = h.Sideline;
    s.config.set("agentInstalls", JSON.stringify([install]));
    const second = await s.providers.chat({ ownerID, messages, config });
    row.second = { answer: second.content, elapsedMs: second.elapsedMs,
      sameSession: first.sessionId === second.sessionId, recalled: second.content.includes(fixture.expected.digits),
      warning: second.sessionWarning || "" };
    row.ok = row.first.recognizesImage && row.second.sameSession && row.second.recalled && !row.second.warning;
  } catch (error) { row.error = s.agents.diagnostic(error.message); row.ok = false; }
  finally {
    try { s.config.set("textChannel", "api"); await s.agentconversation.reset(ownerID); row.testSessionRemoved = true; }
    catch (error) { row.cleanupError = s.agents.diagnostic(error.message); }
    report.tests.push(row);
    fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(root, "runtime", process.argv.includes("--dsh-only") ? "dsh-image-probe.json" : "agent-image-probe.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(row));
  }
}
if (report.tests.some((row) => !row.ok || row.cleanupError)) process.exitCode = 1;
