/*
 * Zotero Sideline：请求路由。
 * 输入：消息、图片和请求标识；输出：统一回答、用量、模型及耗时。
 * 默认通道为 Agent 时文字和图片均交给 Agent；API 模式按文字/图片选用两个接口。
 * 依赖：config/client/agents；路由从不根据 Agent 可用性隐式改道。
 */
Sideline.providers = (function () {
  const DEEPSEEK = "api"; // 旧导出名仅供兼容，实际与服务商无关
  const CODEX = "agent";
  const IDS = ["api", "agent", "vision"];
  const LABELS = { api: "文字 API", agent: "本地 Agent", vision: "视觉 API" };
  function current(config) {
    const value = config || Sideline.config.read();
    return value.textChannel === "agent" || (!value.textChannel && value.provider === "codex") ? "agent" : "api";
  }
  function route(options = {}) {
    const legacy = { deepseek: "api", codex: "agent" };
    const requested = legacy[options.provider] || options.provider || current(options.config);
    if (!IDS.includes(requested)) throw new Error(`未知的模型通道：${requested}`);
    const images = Array.isArray(options.images) ? options.images.filter(Boolean) : [];
    const forcedByImages = images.length > 0 && requested === "api";
    return { provider: forcedByImages ? "vision" : requested, forcedByImages, requested };
  }
  function supportsImages(id) { return id === "vision" || id === "agent"; }
  function label(id) { return LABELS[id] || id; }
  function deepseekVisionModel(config) { return Sideline.config.apiConfig(config, true).model || ""; }
  function describe() {
    const config = Sideline.config.read();
    return { provider: current(config), providerLabel: label(current(config)),
      visionProvider: current(config) === "agent" ? "agent" : "vision",
      visionProviderLabel: label(current(config) === "agent" ? "agent" : "vision"),
      visionModel: current(config) === "agent" ? config.agentModel : deepseekVisionModel(config),
      agentInstallId: config.agentInstallId, agentModel: config.agentModel,
      available: IDS.map((id) => ({ id, label: label(id), supportsImages: supportsImages(id) })) };
  }
  function checkVision(images, config) {
    if (!Array.isArray(images) || !images.length) return { ok: true, reason: "" };
    const value = Sideline.config.apiConfig(config, true);
    if (!value.model) return { ok: false, reason: "未配置视觉模型，请到设置填写视觉接口" };
    if (!value.api || !value.secretKey) return { ok: false, reason: "未配置视觉 API 基址或密钥，请到设置填写视觉接口" };
    return { ok: true, reason: "" };
  }
  function checkRequest(config, images = []) {
    const value = config || Sideline.config.read();
    if (current(value) === "agent") return { ok: true, reason: "" };
    if (images.length) return checkVision(images, value);
    return { ok: Sideline.config.isConfigured(value), reason: "未配置文字 API 基址、模型或密钥" };
  }

  /**
   * 把图片挂到最后一条 user 消息上，并把该消息的 content 转成块数组。
   * 图片不能放在 system/assistant 消息里（DeepSeek 会返回 400），这里只改 user 消息。
   */
  function attachImages(messages, images) {
    const list = (messages || []).map((message) => Object.assign({}, message));
    if (!images || !images.length) return list;
    let index = -1;
    for (let cursor = list.length - 1; cursor >= 0; cursor--) {
      if (list[cursor].role === "user") {
        index = cursor;
        break;
      }
    }
    if (index < 0) {
      list.push({ role: "user", content: "" });
      index = list.length - 1;
    }
    const target = list[index];
    const blocks = [];
    if (typeof target.content === "string" && target.content) {
      blocks.push({ type: "text", text: target.content });
    }
    else if (Array.isArray(target.content)) {
      blocks.push(...target.content);
    }
    for (const url of images) {
      blocks.push({ type: "image_url", image_url: { url: String(url) } });
    }
    target.content = blocks;
    return list;
  }

  /** 把消息数组拍平成单段提示词，供只接受 stdin 文本的 Codex 使用 */
  function renderPrompt(messages) {
    const parts = [];
    for (const message of messages || []) {
      const role = String(message.role || "user");
      let content = message.content;
      if (Array.isArray(content)) {
        content = content
          .filter((block) => block && block.type === "text")
          .map((block) => String(block.text || ""))
          .join("\n");
      }
      const text = String(content == null ? "" : content).trim();
      if (!text) continue;
      if (role === "system") parts.push(`【系统指令】\n${text}`);
      else if (role === "assistant") parts.push(`【此前的回答】\n${text}`);
      else parts.push(text);
    }
    return parts.join("\n\n");
  }

  async function chat(options = {}) {
    if (!Array.isArray(options.messages) || !options.messages.length) throw new Error("消息为空");
    const images = Array.isArray(options.images) ? options.images.filter(Boolean) : [];
    const config = options.config || Sideline.config.read();
    const routeInfo = route(Object.assign({}, options, { images }));
    const check = routeInfo.provider === "agent" ? { ok: true } : checkRequest(
      Object.assign({}, config, { textChannel: "api" }), images);
    if (!check.ok) throw new Error(check.reason);
    const started = Date.now();
    let result;
    try {
    if (routeInfo.provider === "agent") {
      result = await Sideline.agents.run({ config, prompt: renderPrompt(options.messages),
        images,
        ownerID: options.ownerID, messages: options.messages, onWarning: options.onWarning,
        rebuild: !!options.rebuildAgent,
        requestKey: options.requestKey, onDelta: options.onDelta });
    } else {
      const api = Sideline.config.apiConfig(config, routeInfo.provider === "vision");
      result = await Sideline.client.chat({ messages: attachImages(options.messages, images),
        config: api, onDelta: options.onDelta, requestKey: options.requestKey });
    }
    } catch (error) {
      const wrapped = new Error(Sideline.agents.diagnostic(error.message));
      wrapped.partialContent = error.partialContent || "";
      wrapped.cancelled = error.cancelled;
      throw wrapped;
    }
    if (!result.content || !result.content.trim()) throw new Error(Sideline.client.emptyReason(result));
    return Object.assign({}, result, { provider: routeInfo.provider, images: images.length,
      elapsedMs: Date.now() - started, errors: result.errors || [],
      forcedByImages: routeInfo.forcedByImages, requestedProvider: routeInfo.requested });
  }
  function abort(requestKey) { Sideline.client.abort(requestKey); Sideline.agents.cancel(requestKey); }

  /**
   * 粗略估算 token 数（R12）。
   * DeepSeek 未公布精确换算，这里按「中日韩字符约 1 token、其它字符约 3.5 字符 1 token」估算，
   * 界面上一律标注为「估算」，真实用量以响应里的 usage 为准。
   */
  function estimateTokens(text) {
    const source = String(text == null ? "" : text);
    if (!source) return 0;
    let cjk = 0;
    for (const char of source) {
      const code = char.codePointAt(0);
      if ((code >= 0x3000 && code <= 0x303f) || (code >= 0x3400 && code <= 0x9fff)
        || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
        cjk++;
      }
    }
    const other = source.length - cjk;
    return Math.ceil(cjk + other / 3.5);
  }

  /** 估算一次请求的输入 token：全部消息文本 + 图片按每张 1024 的上限粗算 */
  function estimateRequestTokens(messages, images) {
    let text = "";
    for (const message of messages || []) {
      if (typeof message.content === "string") text += message.content;
      else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && block.type === "text") text += String(block.text || "");
        }
      }
    }
    const imageCount = Array.isArray(images) ? images.length : 0;
    return { text: estimateTokens(text), images: imageCount * 1024, total: estimateTokens(text) + imageCount * 1024 };
  }

  return {
    IDS,
    DEEPSEEK,
    CODEX,
    current,
    route,
    deepseekVisionModel,
    supportsImages,
    checkVision,
    checkRequest,
    attachImages,
    renderPrompt,
    label,
    describe,
    chat,
    estimateTokens,
    estimateRequestTokens,
    abort,
  };
})();
