/* 固定白名单 Agent 的离线会话能力探测；不调用模型、不读取凭据。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./agent-host.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { Sideline: S, Zotero } = createHost(root);
let index = 0;
for (const install of await S.agentinstall.discover()) {
  if (install.type === "codex") continue;
  const cwd = S.agentconversation.directory(`probe-${install.type}-${++index}`);
  await Zotero.File.createDirectoryIfMissingAsync(cwd);
  const prepared = await S.agentweb.setup(install, false, cwd);
  const client = await S.acp.connect(prepared, { cwd, timeoutMs: 45000 });
  console.log(JSON.stringify({ type: install.type, path: install.path, capabilities: client.initialized.agentCapabilities }));
  client.close();
  await client.done;
  if (process.argv.includes("--round-trip")) {
    const sessionId = await S.agentacp.create(install, { cwd });
    const resumed = await S.acp.connect(prepared, { cwd, timeoutMs: 45000 });
    try {
      const caps = resumed.initialized.agentCapabilities || {};
      const method = caps.sessionCapabilities?.resume ? "session/resume" : "session/load";
      await resumed.request(method, { sessionId, cwd, mcpServers: [] });
      await resumed.request("session/close", { sessionId });
      console.log(JSON.stringify({ type: install.type, action: "offline-create-resume-close", sessionId, method, ok: true }));
    } finally { resumed.close(); await resumed.done; }
    await S.agentacp.discard(install, { cwd, sessionId });
    console.log(JSON.stringify({ type: install.type, action: "delete-owned-session", ok: true }));
  }
}
