/* 联网冒烟：离线协议检测后每类一次公开网页请求，记录工具状态；不读取凭据、不读取 PDF。 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createHost } from "./agent-host.mjs";
if (!process.argv.includes("--offline") && !process.argv.includes("--minimal")) throw new Error("Real web/model calls require --minimal; use --offline for protocol checks only");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Sideline: s } = createHost(projectRoot);
const report = { timestamp: new Date().toISOString(), host: "Node bridge; not Zotero/Gecko", installs: [], probes: [], tests: [] };
const installs = await s.agents.discover();
report.installs = installs.map(({ type, path, version }) => ({ type, path, version }));
console.log(JSON.stringify({ installs: report.installs }));
const types = process.argv.includes("--offline") ? [] : ["opencode", "dsh"];
for (const install of installs) {
  const probe = await s.agents.probe(install.id);
  const safe = { type: install.type, path: install.path, version: probe.version, stages: probe.stages, error: probe.error || "" };
  report.probes.push(safe); console.log(JSON.stringify({ probe: safe }));
  if (!types.includes(install.type) || !probe.stages || probe.stages.protocol !== "pass") continue;
  types.splice(types.indexOf(install.type), 1);
  const model = install.type === "opencode" ? "deepseek/deepseek-flash" : probe.currentModel || "";
  const config = { ...s.config.read(), agentInstallId: install.id, agentModel: model, agentEffort: "", agentSearch: true, agentTimeoutMs: 180000 };
  const started = Date.now();
  try {
    const result = await s.agents.run({ config, diagnostic: true, prompt: "请调用网页搜索工具搜索 DeepSeek API 官方文档，然后只给出一个官方文档网址。不要使用文件、命令或其他工具。" });
    const test = { type: install.type, model: result.model, elapsedMs: Date.now() - started, tools: result.webTools,
      completedWebTool: (result.webTools || []).some((t) => /web.?search|web.?fetch/i.test(t.name) && t.status === "completed"),
      officialLinkReturned: /https:\/\/(?:api-docs\.)?deepseek\.com/.test(result.content) };
    report.tests.push(test); console.log(JSON.stringify({ test }));
  } catch (error) { const test = { type: install.type, model, elapsedMs: Date.now() - started, error: s.agents.diagnostic(error.message) };
    report.tests.push(test); console.log(JSON.stringify({ test })); }
}
fs.mkdirSync(path.join(projectRoot, "runtime"), { recursive: true });
fs.writeFileSync(path.join(projectRoot, "runtime/agent-web-probe.json"), JSON.stringify(report, null, 2), "utf8");
