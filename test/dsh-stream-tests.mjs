/* 固定 Harness 桥接模块的事件测试；假运行时验证过滤、重试与完成消息，无模型调用。 */
import vm from "node:vm";
export function runDshStreamTests({ Sideline, check, equal }) {
  const listeners = {}, frames = [];
  vm.runInNewContext(Sideline.dshstream.source.replace(/export /g, "") + "\napply(ctx);", {
    ctx: { on(name, callback) { listeners[name] = callback; } },
    process: { stdout: { write(line) { frames.push(JSON.parse(line)); } } },
  });
  const agent = { session: { id: "paper-session" } };
  const emit = (frame) => listeners["agent/assistant-stream"]({ agent, frame });
  emit({ type: "start", attemptId: "attempt-1" });
  emit({ type: "chunk", attemptId: "attempt-1", index: 0, chunk: { type: "reasoning-delta", text: "private reasoning" } });
  emit({ type: "chunk", attemptId: "attempt-1", index: 1, chunk: { type: "text-delta", text: "first" } });
  emit({ type: "chunk", attemptId: "attempt-1", index: 1, chunk: { type: "text-delta", text: "duplicate" } });
  emit({ type: "chunk", attemptId: "foreign", index: 2, chunk: { type: "text-delta", text: "wrong attempt" } });
  emit({ type: "chunk", attemptId: "attempt-1", index: 2, chunk: { type: "tool-call-delta", argumentsDelta: "private args" } });
  emit({ type: "chunk", attemptId: "attempt-1", index: 3, chunk: { type: "text-delta", text: " second" } });
  equal("dsh bridge: forwards only ordered text deltas", frames.filter((f) => f.params.update.phase === "delta").map((f) => f.params.update.text).join(""), "first second");
  check("dsh bridge: excludes thought/tool/duplicate data", !JSON.stringify(frames).includes("private") && !JSON.stringify(frames).includes("duplicate"));
  listeners["session/event"]({ header: { id: "unrelated" } }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "foreign" }] } } });
  emit({ type: "start", attemptId: "retry" });
  listeners["session/event"]({ header: { id: "paper-session" } }, { type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "private" }, { type: "text", text: "authoritative answer" }] } } });
  const commit = frames.at(-1).params.update;
  check("dsh bridge: authoritative commit belongs to current attempt", commit.phase === "commit" && commit.attemptId === "retry" && commit.text === "authoritative answer");
  check("dsh bridge: publishes notifications without reverse RPC", frames.every((f) => f.method === "sideline/assistant-stream" && f.id === undefined && f.params.sessionId === "paper-session"));
}
