/*
 * Sideline 模型请求的共同规则。
 * 输入：输出预算、服务商 usage、模型消息和流式正文；输出：校验结果、统计及节流回调。
 * 依赖：无宿主依赖。请求路由、会话更新与 DOM 操作由调用者承担。
 * 流式状态只属于一次请求；最终重渲染仍由调用者执行，不能用节流结果代替最终正文。
 */
Sideline.modelrequest = (function () {
  let sequence = 0;

  function key(scope) {
    return `${scope}:${Date.now()}:${++sequence}`;
  }

  function positiveBudget(value) {
    const number = typeof value === "string" && value.trim() ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error("最大输出 tokens 必须是正整数");
    }
    return number;
  }

  /** 兼容两种常见字段；服务商未报告用量时返回零，不把估算混入实际用量。 */
  function usageTokens(usage = {}) {
    return Number(usage.total_tokens)
      || (Number(usage.input_tokens || usage.prompt_tokens) || 0)
        + (Number(usage.output_tokens || usage.completion_tokens) || 0);
  }

  function historyMessages(messages) {
    return messages.filter((entry) => !entry.localOnly)
      .map((entry) => ({ role: entry.role, content: entry.content, images: entry.images || [] }));
  }

  /** 只移除覆盖整篇回答的围栏；JSON 候选保留围栏供专用解析器处理。 */
  function answerText(text) {
    const source = String(text == null ? "" : text).trim();
    const match = source.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```$/);
    if (!match || /^\s*[{[]/.test(match[1])) return source;
    return match[1];
  }

  function streamRenderer(render, { normalize = (text) => text, intervalMs = 120 } = {}) {
    let lastAt = 0;
    let lastSource = null;
    return (whole) => {
      const source = normalize(whole);
      if (source === lastSource) return;
      const now = Date.now();
      if (now - lastAt < intervalMs) return;
      render(source);
      lastAt = now;
      lastSource = source;
    };
  }

  return { key, positiveBudget, usageTokens, historyMessages, answerText, streamRenderer };
})();
