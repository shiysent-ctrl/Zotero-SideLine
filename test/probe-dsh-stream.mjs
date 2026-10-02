/* 实机验证 Harness 生成中的正文增量；--minimal 只发送短测试，不读取凭据或 PDF。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./agent-host.mjs";
if (!process.argv.includes("--minimal")) throw new Error("Real model call requires --minimal");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const h = createHost(root, { dataDirectory: path.join(root, "runtime", "stream-probe-data") });
const s = h.Sideline;
const installs = await s.agents.discover();
const install = installs.find((entry) => entry.type === "dsh" && !/Roaming/.test(entry.path));
const offline = await s.agents.probe(install.id);
if (offline.stages.protocol !== "pass") throw new Error(offline.error || "Offline probe failed");
const models = await s.agents.listModels(install.id);
const model = models.find((entry) => /v4-flash/.test(entry.id)) || models.find((entry) => /flash/.test(entry.id));
const config = { textChannel: "agent", agentInstallId: install.id, agentModel: model.id,
  agentSearch: false, agentEffort: "", agentTimeoutMs: 120000 };
const start = Date.now(), chunks = [];
try {
  const result = await s.providers.chat({ ownerID: 177101, config,
    messages: [{ role: "user", content: "不要调用工具。请输出编号 1 到 12，每行只写编号和一句简短的中文阅读建议。" }],
    onDelta(piece, whole) { if (piece) chunks.push({ ms: Date.now() - start, chars: whole.length }); } });
  const row = { agent: "DeepSeek Harness", version: offline.version || install.version, model: result.model,
    elapsedMs: Date.now() - start, chunks: chunks.length, firstDeltaMs: chunks[0]?.ms,
    lastDeltaMs: chunks.at(-1)?.ms, finalChars: result.content.length,
    grewDuringGeneration: chunks.length > 2 && chunks[0].chars < chunks.at(-1).chars };
  console.log(JSON.stringify(row));
  if (!row.grewDuringGeneration) throw new Error("No live text growth observed");
  fs.writeFileSync(path.join(root, "runtime", "dsh-stream-probe.json"), JSON.stringify(row, null, 2), "utf8");
} finally {
  s.config.set("textChannel", "api");
  await s.agentconversation.reset(177101);
}
