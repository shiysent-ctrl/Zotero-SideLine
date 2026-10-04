/*
 * Zotero Sideline：Harness 实时正文桥接的固定 Cordis 模块。
 * 输入：Harness 的进程内文本事件；输出：Sideline 专用 JSON-RPC 通知。
 * 依赖：已校验的 Harness ACP profile；只转发正文，不导出思考、工具参数或凭据。
 * 模块源随插件维护，复制到插件自有目录加载，不修改 Harness 安装或用户配置。
 */
Sideline.dshstream = (function () {
  function apply(ctx) {
    const attempts = new Map();
    const notify = (sessionId, update) => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "sideline/assistant-stream",
        params: { sessionId, update: Object.assign({ sessionUpdate: "sideline_stream" }, update) } }) + "\n");
    };
    ctx.on("agent/assistant-stream", ({ agent, frame }) => {
      const sessionId = agent.session.id;
      if (frame.type === "start") {
        attempts.set(sessionId, { id: frame.attemptId, next: 0 });
        notify(sessionId, { phase: "start", attemptId: frame.attemptId });
      } else if (frame.type === "chunk") {
        const attempt = attempts.get(sessionId);
        if (!attempt || attempt.id !== frame.attemptId || frame.index !== attempt.next) return;
        attempt.next++;
        if (frame.chunk.type === "text-delta" && typeof frame.chunk.text === "string") {
          notify(sessionId, { phase: "delta", attemptId: attempt.id, text: frame.chunk.text });
        }
      }
    });
    ctx.on("session/event", (session, event) => {
      if (event.type !== "assistant/message") return;
      const attempt = attempts.get(session.header.id);
      if (!attempt) return;
      const text = event.data.message.content.filter((block) => block.type === "text")
        .map((block) => block.text).join("");
      notify(session.header.id, { phase: "commit", attemptId: attempt.id, text });
      attempts.delete(session.header.id);
    });
  }
  const source = `export const name = "sideline-text-stream";\nexport ${apply.toString()}\n`;
  return { source };
})();
