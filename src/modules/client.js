/*
 * Zotero Sideline：大模型客户端。
 * 功能：以 OpenAI 兼容协议调用 /chat/completions，支持 SSE 流式增量回调。
 * 输入：{messages, onDelta?, config?}；onDelta(piece, whole) 存在且配置允许流式时走流式。
 * 输出：{content, model, usage}
 * 说明：流式用主窗口的 fetch + ReadableStream（沙箱本身没有 fetch）；
 *       不可用时回退到 Zotero.HTTP.request 一次性返回。abort() 终止当前请求。
 */

Sideline.client = (function () {
  // requestKey → 中断句柄。每个阅读器各用自己的 key，避免同时打开两篇 PDF 时
  // 后发请求覆盖前一个请求的 AbortController。
  const active = new Map();
  const modelLimits = new Map();

  function isDeepSeek(api) { return /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(String(api || "")); }
  function rememberModels(api, entries) {
    const prefix = `${Sideline.config.endpoint(api)}|`;
    for (const key of modelLimits.keys()) if (key.startsWith(prefix)) modelLimits.delete(key);
    for (const entry of entries || []) {
      const limit = entry && entry.max_output_tokens;
      if (entry && entry.id && Number.isSafeInteger(limit) && limit > 0) modelLimits.set(`${Sideline.config.endpoint(api)}|${entry.id}`, limit);
    }
  }
  function tokenLimit(config) {
    return modelLimits.get(`${Sideline.config.endpoint(config.api)}|${config.model}`)
      || (isDeepSeek(config.api) ? 393216 : null);
  }
  function validateTokens(config, value = config.maxTokens) {
    // 不截断、不静默钳制用户值；先验检查阻止 0、负数、小数、NaN 与已知超限预算。
    const number = Sideline.modelrequest.positiveBudget(value);
    const limit = tokenLimit(config);
    if (limit && number > limit) throw new Error(`最大输出 tokens ${number} 超过当前模型上限 ${limit}，请修改设置；原值未被改写`);
    return number;
  }
  function buildRequest(options) {
    const config = options.config || Sideline.config.read();
    const url = Sideline.config.endpoint(config.api);
    if (!url) throw new Error("未配置 API 地址，请在「设置 → Sideline」中填写");
    if (!config.model) throw new Error("未配置模型名称，请在「设置 → Sideline」中填写");
    if (!Array.isArray(options.messages) || !options.messages.length) throw new Error("消息为空");
    const tools = Sideline.util.windowTools();
    const useStream = !!options.onDelta && !!config.stream && !!tools.fetch && !!tools.TextDecoder;
    const body = { model: config.model, messages: options.messages, temperature: Number(config.temperature) || 0,
      max_tokens: validateTokens(config, options.maxTokens !== undefined ? options.maxTokens : config.maxTokens), stream: useStream };
    if (options.testNoThinking && isDeepSeek(config.api)) body.thinking = { type: "disabled" };
    return { config, url, body, tools, useStream };
  }
  function requestSummary(request) {
    return { endpoint: request.url.replace(/\?.*$/, "").replace(/^(https?:\/\/)[^/]*@/i, "$1[hidden]@"), model: request.body.model,
      max_tokens: request.body.max_tokens, max_tokens_type: typeof request.body.max_tokens,
      stream: request.body.stream, thinking: request.body.thinking && request.body.thinking.type || "服务商默认" };
  }
  function responseDetails(json) {
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    return { finishReason: choice && choice.finish_reason || "", choicesPresent: !!choice,
      reasoningPresent: !!(choice && choice.message && choice.message.reasoning_content) };
  }
  function emptyReason(result) {
    if (result.finishReason === "length") return "输出预算已耗尽，尚未返回最终正文；请调整预算或思考模式";
    if (result.reasoningPresent) return "仅返回思考内容，未返回最终正文";
    if (result.choicesPresent === false) return "响应格式不兼容：缺少 choices[0]";
    return "接口返回空回答";
  }

  /** 终止指定请求；未给 key 时为兼容旧调用而终止全部活动 HTTP 请求。 */
  function abort(requestKey) {
    const targets = requestKey === undefined || requestKey === null
      ? [...active.entries()]
      : (active.has(requestKey) ? [[requestKey, active.get(requestKey)]] : []);
    for (const [key, handle] of targets) {
      try {
        if (handle && typeof handle.abort === "function") handle.abort();
      }
      catch (error) {
        Sideline.util.warn(`终止请求失败：${Sideline.util.message(error)}`);
      }
      active.delete(key);
    }
  }

  function buildHeaders(config) {
    const headers = { "Content-Type": "application/json" };
    if (config.secretKey) headers.Authorization = `Bearer ${config.secretKey}`;
    return headers;
  }

  function extractContent(json) {
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    if (!choice) return "";
    if (choice.message && typeof choice.message.content === "string") return choice.message.content;
    if (choice.message && Array.isArray(choice.message.content)) return choice.message.content.filter((block) => block && block.type === "text").map((block) => block.text || "").join("");
    if (typeof choice.text === "string") return choice.text;
    return "";
  }

  // JSON 类型的 XHR 禁止访问 responseText；成功解析和错误诊断共用类型安全读取。
  function responseBody(xhr) {
    if (!xhr) return null;
    try { if (xhr.response !== undefined && xhr.response !== null) return xhr.response; } catch (_) { /* 宿主响应不可读 */ }
    try {
      if (xhr.responseType && xhr.responseType !== "text") return null;
      return xhr.responseText || null;
    } catch (_) { return null; }
  }
  function responseJSON(xhr) {
    const data = responseBody(xhr);
    if (data && typeof data === "object") return data;
    if (typeof data === "string" && data.trim()) {
      try { return JSON.parse(data); } catch (_) { throw new Error("接口返回非 JSON 响应，请核对 API 地址或查看服务商状态"); }
    }
    throw new Error("接口没有返回有效 JSON 响应");
  }

  async function requestOnce({ url, headers, body, timeout }) {
    const xhr = await Zotero.HTTP.request("POST", url, {
      body: JSON.stringify(body),
      headers,
      responseType: "json",
      timeout,
      successCodes: [200],
    });
    const json = responseJSON(xhr);
    return Object.assign({
      content: extractContent(json).trim(),
      model: json.model || body.model,
      usage: json.usage || null,
    }, responseDetails(json));
  }

  async function requestStream({ url, headers, body, timeout, onDelta, tools, requestKey }) {
    const controller = tools.AbortController ? new tools.AbortController() : null;
    const key = requestKey === undefined || requestKey === null
      ? `anonymous-${Date.now()}-${Math.random()}`
      : requestKey;
    let timedOut = false;
    const timer = tools.setTimeout
      ? tools.setTimeout(() => {
        timedOut = true;
        if (controller) controller.abort();
      }, timeout)
      : null;

    const handle = { abort: controller ? () => controller.abort() : null };
    active.set(key, handle);
    try {
      const response = await tools.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}：${String(detail).slice(0, 500)}`);
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        const text = await response.text();
        const json = JSON.parse(text);
        const content = extractContent(json).trim();
        if (content) onDelta(content, content);
        return Object.assign({ content, model: json.model || body.model, usage: json.usage || null }, responseDetails(json));
      }

      const reader = response.body.getReader();
      const decoder = new tools.TextDecoder("utf-8");
      let buffer = "";
      let content = "";
      let usage = null;
      let model = body.model;
      let finishReason = "", reasoningPresent = false, choicesPresent = false;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload && payload !== "[DONE]") {
              let chunk = null;
              try {
                chunk = JSON.parse(payload);
              }
              catch (error) {
                chunk = null;
              }
              if (chunk) {
                if (chunk.model) model = chunk.model;
                if (chunk.usage) usage = chunk.usage;
                const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
                if (choice) { choicesPresent = true; if (choice.finish_reason) finishReason = choice.finish_reason; }
                const delta = choice ? (choice.delta || choice.message) : null;
                if (delta && delta.reasoning_content) reasoningPresent = true;
                const piece = delta && typeof delta.content === "string" ? delta.content : "";
                if (piece) {
                  content += piece;
                  try {
                    onDelta(piece, content);
                  }
                  catch (error) {
                    Sideline.util.error(error);
                  }
                }
              }
            }
          }
          newline = buffer.indexOf("\n");
        }
      }
      return { content: content.trim(), model, usage, finishReason, reasoningPresent, choicesPresent };
    }
    catch (error) {
      if (timedOut) {
        throw new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`);
      }
      throw error;
    }
    finally {
      if (timer && tools.clearTimeout) tools.clearTimeout(timer);
      if (active.get(key) === handle) active.delete(key);
    }
  }

  /**
   * 发起一次对话。
   * @param {object} options messages 必填；onDelta 存在且 config.stream 为真时使用流式
   * @returns {Promise<{content: string, model: string, usage: object|null, streamed: boolean}>}
   */
  async function chat(options = {}) {
    const request = buildRequest(options);
    const { config, url, body, tools, useStream } = request;
    const headers = buildHeaders(config);
    const timeout = config.requestTimeoutMs > 0 ? config.requestTimeoutMs : 120000;

    try { if (useStream) {
      const result = await requestStream({
        url, headers, body, timeout, onDelta: options.onDelta, tools, requestKey: options.requestKey,
      });
      return Object.assign({ streamed: true, request: requestSummary(request) }, result);
    }
    const result = await requestOnce({ url, headers, body, timeout });
    return Object.assign({ streamed: false, request: requestSummary(request) }, result);
    } catch (error) {
      const xhr = error.xmlhttp || error.xhr;
      const data = responseBody(xhr);
      const detail = typeof data === "string" ? data : data ? JSON.stringify(data) : "";
      const cause = `${error.message || error}${detail && !String(error).includes(detail) ? `：${String(detail).slice(0, 1200)}` : ""}`.replaceAll(config.secretKey || "\u0000", "[hidden]");
      const safe = Sideline.agents ? Sideline.agents.diagnostic(cause).slice(0, 1200) : cause.replaceAll(config.secretKey || "\u0000", "[hidden]").slice(0, 1200);
      const wrapped = new Error(`${safe}\n发送参数：model=${body.model}，max_tokens=${body.max_tokens}（number），stream=${body.stream}`);
      wrapped.request = requestSummary(request); throw wrapped;
    }
  }

  return { chat, abort, responseJSON, buildRequest, requestSummary, validateTokens, tokenLimit, rememberModels, isDeepSeek, emptyReason };
})();
