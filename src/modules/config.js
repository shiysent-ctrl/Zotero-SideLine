/*
 * Zotero Sideline：配置读取。
 * 功能：把 extensions.zotero.sideline.* 首选项读成统一配置对象，并提供端点地址规范化。
 * 说明：Zotero.Prefs.get/set 的短名会自动加上 extensions.zotero. 前缀。
 */

Sideline.config = (function () {
  // 代码内兜底默认值：即使 prefs.js 未生效也能给出可用配置
  const FALLBACK = {
    api: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    secretKey: "",
    temperature: "0.7",
    maxTokens: 4096,
    stream: true,
    requestTimeoutMs: 120000,
    visionRequestTimeoutMs: 120000,
    systemPrompt: "你是 Zotero 中的文献阅读助手，输出简体中文。",
    contextMode: "metadata+fulltext",
    maxContextChars: 24000,
    historyTurns: 4,
    prompts: "",
    noteHeading: "Sideline",
    readerEnabled: true,
    readerTemplates: "translate,explain,summarize",
    readerAnnotationWrite: true,
    readerAnnotationColor: "#ffd400",
    persistSessions: true,
    maxStoredItems: 200,
    maxStoredMessages: 60,
    codexPath: "",
    codexModel: "",
    codexEffort: "low",
    codexTimeoutMs: 180000,
    provider: "deepseek",
    deepseekVisionModel: "",
    textChannel: "",
    textApi: "",
    textSecretKey: "",
    textModel: "",
    visionUseText: true,
    visionApi: "",
    visionSecretKey: "",
    visionModel: "",
    agentInstallId: "",
    agentInstalls: "[]",
    agentModel: "",
    agentEffort: "",
    agentTimeoutMs: 180000,
    agentSearch: false,
    promptSummarize: "",
    promptExplain: "",
    promptTranslate: "",
    promptHighlight: "",
    readerPanelEnabled: true,
    readerPanelWidth: 380,
    highlightMaxItems: 12,
    noteSearchMaxHits: 3,
    fileMaxChars: 20000,
    coverageMaxPages: 0,
    ocrEnabled: true,
    historySearchMaxHits: 20,
  };

  function raw(key) {
    try {
      return Zotero.Prefs.get(`sideline.${key}`);
    }
    catch (error) {
      return undefined;
    }
  }

  function str(key) {
    const value = raw(key);
    if (value === undefined || value === null) return String(FALLBACK[key] == null ? "" : FALLBACK[key]);
    return String(value);
  }

  function num(key) {
    const value = parseInt(raw(key), 10);
    return Number.isFinite(value) ? value : Number(FALLBACK[key]);
  }

  function bool(key) {
    const value = raw(key);
    if (value === undefined || value === null) return !!FALLBACK[key];
    return !!value;
  }

  function set(key, value) {
    Zotero.Prefs.set(`sideline.${key}`, value);
  }
  function hasUserValue(key) {
    try { return Services.prefs.prefHasUserValue(`extensions.zotero.sideline.${key}`); }
    catch (_) { return false; }
  }

  function compatible(key, oldKey) {
    // 明确清空新字段必须生效；仅未设置过的新字段读取旧值。
    try {
      if (Services.prefs.prefHasUserValue(`extensions.zotero.sideline.${key}`)) return str(key);
    } catch (_) { /* 假宿主或旧宿主继续使用读取回退 */ }
    return str(key) || str(oldKey);
  }

  function compatibleNumber(key, oldKey) {
    try { if (Services.prefs.prefHasUserValue(`extensions.zotero.sideline.${key}`)) return num(key); }
    catch (_) { /* 非 Gecko 宿主无用户分支标识 */ }
    return num(oldKey);
  }

  /** @returns {object} 一次性读出全部配置，供请求与界面使用 */
  function read() {
    return {
      api: str("api"),
      model: str("model"),
      secretKey: str("secretKey"),
      temperature: str("temperature"),
      // 输出预算留给最终请求校验；不能用 parseInt 把小数/错误字符串悄悄变成合法整数。
      maxTokens: raw("maxTokens") === undefined ? FALLBACK.maxTokens : raw("maxTokens"),
      stream: bool("stream"),
      requestTimeoutMs: num("requestTimeoutMs"),
      visionRequestTimeoutMs: compatibleNumber("visionRequestTimeoutMs", "requestTimeoutMs"),
      systemPrompt: str("systemPrompt"),
      contextMode: str("contextMode"),
      maxContextChars: num("maxContextChars"),
      historyTurns: num("historyTurns"),
      noteHeading: str("noteHeading"),
      readerTemplates: str("readerTemplates"),
      provider: str("provider"),
      deepseekVisionModel: str("deepseekVisionModel"),
      codexModel: str("codexModel"),
      codexEffort: str("codexEffort"),
      codexTimeoutMs: num("codexTimeoutMs"),
      textChannel: str("textChannel") || (str("provider") === "codex" ? "agent" : "api"),
      textApi: compatible("textApi", "api"),
      textSecretKey: compatible("textSecretKey", "secretKey"),
      textModel: compatible("textModel", "model"),
      visionUseText: bool("visionUseText"),
      visionApi: str("visionApi"),
      visionSecretKey: str("visionSecretKey"),
      visionModel: compatible("visionModel", "deepseekVisionModel"),
      agentInstallId: str("agentInstallId"),
      agentModel: str("agentInstallId") && !str("agentInstallId").startsWith("codex:")
        ? str("agentModel") : compatible("agentModel", "codexModel"),
      agentEffort: str("agentInstallId") && !str("agentInstallId").startsWith("codex:")
        ? str("agentEffort") : compatible("agentEffort", "codexEffort"),
      agentTimeoutMs: compatibleNumber("agentTimeoutMs", "codexTimeoutMs"),
      agentSearch: bool("agentSearch"),
    };
  }

  /**
   * 规范化对话端点：允许用户填基址或完整端点。
   * https://api.deepseek.com → https://api.deepseek.com/chat/completions
   * https://api.openai.com/v1 → https://api.openai.com/v1/chat/completions
   */
  function endpoint(base) {
    const url = String(base == null ? "" : base).trim().replace(/\s+/g, "").replace(/\/+$/, "");
    if (!url) return "";
    if (/\/chat\/completions$/.test(url)) return url;
    return `${url}/chat/completions`;
  }

  /** 只报告密钥是否存在，不回显密钥本身 */
  function summary() {
    const config = read();
    const text = apiConfig(config);
    return {
      api: text.api,
      endpoint: endpoint(text.api),
      model: text.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      stream: config.stream,
      contextMode: config.contextMode,
      maxContextChars: config.maxContextChars,
      historyTurns: config.historyTurns,
      keyPresent: !!text.secretKey,
      configured: isConfigured(config),
      textChannel: config.textChannel,
      vision: { api: apiConfig(config, true).api, model: apiConfig(config, true).model,
        keyPresent: !!apiConfig(config, true).secretKey, useText: config.visionUseText },
    };
  }

  function isConfigured(config) {
    const value = config || read();
    const api = apiConfig(value);
    return !!api.api && !!api.model && !!api.secretKey;
  }

  // 读取回退保留 0.8.3 的全部首选项；独立视觉配置绝不回退到文字密钥。
  function apiConfig(config, vision = false) {
    const value = config || read();
    const text = Object.assign({}, value, { api: value.textApi !== undefined ? value.textApi : value.api,
      secretKey: value.textSecretKey !== undefined ? value.textSecretKey : value.secretKey,
      model: value.textModel !== undefined ? value.textModel : value.model });
    if (!vision) return text;
    return Object.assign({}, value, {
      requestTimeoutMs: value.visionRequestTimeoutMs === undefined ? value.requestTimeoutMs : value.visionRequestTimeoutMs,
      api: value.visionUseText === false ? value.visionApi : text.api,
      secretKey: value.visionUseText === false ? value.visionSecretKey : text.secretKey,
      model: (value.visionModel !== undefined ? value.visionModel : value.deepseekVisionModel) || (value.visionUseText !== false ? text.model : ""),
    });
  }

  return { read, str, num, bool, set, hasUserValue, endpoint, summary, isConfigured, apiConfig };
})();
