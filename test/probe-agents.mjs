/*
 * 本机 Agent 冒烟：用真实 src 适配器和 Node 进程桥检测安装/版本/协议/模型。
 * 默认不推理；--minimal 在离线检测后每类只执行一次最小请求，不读 PDF 或凭据内容。
 * 与 Zotero 的 Gecko Subprocess/UI 验收分开，报告不可据此宣称 Zotero 已通过。
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createHost } from "./agent-host.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const h = createHost(projectRoot);
const s = h.Sideline;
const deepseekOnly = process.argv.includes("--opencode-deepseek");
const minimal = process.argv.includes("--minimal") || deepseekOnly;
const result = { timestamp: new Date().toISOString(), host: "Node bridge; not Zotero UI/Gecko",
  inferenceRequested: minimal, installs: [], probes: [], tests: [] };
const installs = await s.agents.discover();
for (const install of installs) result.installs.push({ id: install.id, type: install.type, path: install.path,
  command: install.command, version: install.version, status: install.status, source: install.source, protocol: install.protocol, error: install.error });
console.log(JSON.stringify({ discovered: result.installs }, null, 2));
for (const type of ["codex", "opencode", "dsh"]) {
  if (deepseekOnly && type !== "opencode") continue;
  const install = installs.find((entry) => entry.type === type);
  if (!install) { result.probes.push({ type, error: "未发现安装" }); continue; }
  const started = Date.now();
  const probe = await s.agents.probe(install.id);
  const safe = { type, version: probe.version, authentication: probe.authentication, protocol: probe.protocol,
    stages: probe.stages, models: (probe.models || []).map(({ id, name, efforts }) => ({ id, name, efforts })),
    elapsedMs: Date.now() - started, error: probe.error || "" };
  result.probes.push(safe); console.log(JSON.stringify({ probe: safe }, null, 2));
  if (minimal && probe.stages && probe.stages.version === "pass") {
    h.Zotero.Prefs.set("sideline.agentInstallId", install.id);
    h.Zotero.Prefs.set("sideline.agentModel", deepseekOnly ? "deepseek/deepseek-flash"
      : type === "codex" && safe.models.length ? safe.models[0].id : "");
    h.Zotero.Prefs.set("sideline.agentEffort", "");
    const tested = await s.agents.test(install.id);
    const test = { type, protocol: tested.protocol, model: tested.testModel || "", elapsedMs: tested.elapsedMs,
      request: tested.stages && tested.stages.request, error: tested.error || "" };
    result.tests.push(test); console.log(JSON.stringify({ test }, null, 2));
  }
}
fs.mkdirSync(path.join(projectRoot, "runtime"), { recursive: true });
const output = deepseekOnly ? "runtime/opencode-deepseek-probe.json" : "runtime/agent-probe.json";
fs.writeFileSync(path.join(projectRoot, output), JSON.stringify(result, null, 2), "utf8");
console.log(`Saved ${output}; credentials never read.`);
