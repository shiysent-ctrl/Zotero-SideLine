/* 真实 CLI 两轮短对话验证；仅 --minimal 才调用模型，不使用 PDF、不读凭据。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./agent-host.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (!process.argv.includes("--minimal")) throw new Error("真实调用需要显式 --minimal");
const dataDirectory = path.join(root, "runtime", "conversation-probe-data");
const results = [];
let h = createHost(root, { dataDirectory });
const installs = await h.Sideline.agents.discover();
for (const type of ["codex", "dsh", "opencode"]) {
  const install = installs.find((entry) => entry.type === type && !/Roaming.*dsh/.test(entry.path));
  const s = h.Sideline;
  const offline = await s.agents.probe(install.id);
  if (offline.stages.protocol !== "pass") throw new Error(offline.error || "offline probe failed");
  const models = await s.agents.listModels(install.id);
  const model = type === "opencode" ? models.find((m) => m.id === "deepseek/deepseek-flash")
    : models.find((m) => /mini|flash/i.test(m.id)) || models[0];
  if (!model) throw new Error(`No test model for ${type}`);
  const config = { textChannel: "agent", agentInstallId: install.id, agentModel: model.id,
    agentSearch: false, agentEffort: "", agentTimeoutMs: 180000 };
  const ownerID = 177001 + ["codex", "dsh", "opencode"].indexOf(type);
  const messages = [{ role: "system", content: "进行会话恢复测试，不使用工具。" },
    { role: "user", content: "记住测试代号 SIDELINE-7X42，然后只回复 OK。" }];
  const first = await s.providers.chat({ ownerID, messages, config });
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: "只回复刚才的测试代号。" });
  // 重建整个 VM，确保第二轮依赖落盘 ID，而非进程/模块内存。
  h = createHost(root, { dataDirectory });
  h.Sideline.config.set("agentInstalls", JSON.stringify(installs));
  const second = await h.Sideline.providers.chat({ ownerID, messages, config });
  if (first.sessionId !== second.sessionId || !second.content.includes("SIDELINE-7X42") || second.sessionWarning) {
    throw new Error(`Persistent conversation failed: ${type}, ${second.sessionWarning || second.content}`);
  }
  h.Sideline.config.set("textChannel", "agent");
  h.Sideline.config.set("agentInstallId", install.id);
  h.Sideline.config.set("agentModel", model.id);
  await h.Sideline.agentconversation.reset(ownerID);
  const blank = await h.Sideline.agentconversation.binding(ownerID);
  if (blank && blank.sessionId === first.sessionId) throw new Error("clear reused old ID");
  const row = { type, model: model.id, protocol: install.protocol, firstSession: first.sessionId,
    secondSession: second.sessionId, firstElapsedMs: first.elapsedMs, secondElapsedMs: second.elapsedMs,
    continued: true, recalled: true, clearCreatedId: blank?.sessionId || "allocated-on-first-send" };
  results.push(row); console.log(JSON.stringify(row));
  h.Sideline.config.set("textChannel", "api");
  await h.Sideline.agentconversation.reset(ownerID);
}
fs.writeFileSync(path.join(root, "runtime", "conversation-probe.json"), JSON.stringify(results, null, 2), "utf8");
