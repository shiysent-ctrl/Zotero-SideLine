/*
 * Zotero Sideline：三类 Agent 的联网策略。
 * 输入：已验证安装、用户联网开关、ACP 工具事件；输出：固定启动参数和严格的单次权限判定。
 * 依赖：agentinstall、jsonfile、Zotero.File。DSH 只加载插件自带覆盖文件，不接受用户命令或任意 patch。
 */
Sideline.agentweb = (function () {
  const NETWORK_TOOLS = new Set(["web_search", "web_fetch", "websearch", "webfetch"]);
  const DISABLED = ["tool-plugin-manager", "tool-bash", "tool-pwsh", "tool-jobs", "tool-fs", "tool-fs-search",
    "tool-skill", "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent", "tool-subagent-fork",
    "tool-workflow", "tool-todo", "tool-goal", "tool-ralph"];
  function patch(search) {
    return DISABLED.map((id) => ({ id, disabled: true })).concat([
      { id: "tool-web", config: { search: !!search, fetch: !!search, searchTimeoutMs: 30000, fetchTimeoutMs: 30000 } },
    ]);
  }
  async function setup(install, search = false, cwd = "", model = "") {
    if (install.type === "opencode") {
      return Object.assign({}, install, { environment: Object.assign({}, install.environment, {
        // 服务商为 DeepSeek 时也显式启用 OpenCode 搜索工具；关闭时同时禁用搜索及网页读取。
        OPENCODE_ENABLE_EXA: search ? "1" : "0", OPENCODE_ENABLE_PARALLEL: "0",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "deny",
          webfetch: search ? "allow" : "deny", websearch: search ? "allow" : "deny" },
          agent: { plan: { permission: { "*": "deny", webfetch: search ? "allow" : "deny", websearch: search ? "allow" : "deny" } } } }),
      }) });
    }
    if (install.type === "dsh") {
      const directory = cwd || Sideline.agentinstall.join(Sideline.jsonfile.directory(), "agent-work");
      const path = Sideline.agentinstall.join(directory, `sideline-dsh-web-${search ? "on" : "off"}.patch.yml`);
      // JSON 是 YAML 的子集；固定内容只写插件自有文件，覆盖行替换整段 config，不修改 ~/.dsh。
      await Zotero.File.createDirectoryIfMissingAsync(directory);
      const bridge = Sideline.agentinstall.join(directory, "sideline-dsh-stream.mjs");
      await Zotero.File.putContentsAsync(bridge, Sideline.dshstream.source);
      const bridgeURL = (bridge.startsWith("/") ? "file://" : "file:///") + bridge.replace(/\\/g, "/").split("/").map((part, index) =>
        index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join("/");
      const entries = patch(search).concat([{ insert: [{ id: "sideline-text-stream", name: bridgeURL }] },
        { id: "session-persistence-jsonl",
        config: { root: Sideline.agentinstall.join(directory, "dsh-memory"), compression: "none" } }]);
      if (model) {
        let route;
        try { route = JSON.parse(model); } catch (_) { throw new Error("DeepSeek Harness 模型必须从模型列表选择有效的服务商与模型组合"); }
        if (!Array.isArray(route) || route.length !== 2 || route.some((value) => typeof value !== "string" || !value.trim())) {
          throw new Error("DeepSeek Harness 模型路由无效，请刷新模型并重新选择");
        }
        // ACP 在 initialize 时按启动模型声明图片能力，必须先选定路由，不能事后只切 session 模型。
        entries.push({ id: "acp", config: { provider: route[0], model: route[1] } });
      }
      await Zotero.File.putContentsAsync(path, JSON.stringify(entries, null, 2));
      return Object.assign({}, install, { acpArgs: ["--profile", "acp", "--patch", path],
        environment: Object.assign({}, install.environment, { DSH_PERMISSION_MODE: "read-only" }) });
    }
    return install;
  }
  function name(call) { return String(call && call.title || "").trim().toLowerCase(); }
  function publicURL(value) {
    try {
      const URL = Sideline.util.windowTools().win.URL;
      const url = new URL(value), host = url.hostname.toLowerCase();
      // URL 先规范化十进制/十六进制 IPv4 和转义字符，再检查本机、私网及链路本地地址。
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
      if (!host.includes(".") || host.startsWith("[") || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) return false;
      if (/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host)) return false;
      if (/^\d+\./.test(host) && Number(host.split(".")[0]) >= 224) return false;
      return true;
    } catch (_) { return false; }
  }
  function permission(call, options, enabled) {
    if (!enabled || !call || !NETWORK_TOOLS.has(name(call))) return null;
    // 文件位置或混入命令的参数均不视为纯联网请求。缺失上下文也默认拒绝。
    if (call.locations && call.locations.length) return null;
    const input = call.rawInput;
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const tool = name(call);
    if (/search/.test(tool)) {
      const queries = input.queries || (input.query ? [input.query] : null);
      if (!Array.isArray(queries) || !queries.length || queries.some((q) => typeof q !== "string" || !q.trim())) return null;
      if (Object.keys(input).some((key) => !["queries", "query", "numResults", "type", "livecrawl", "contextMaxCharacters"].includes(key))) return null;
    } else {
      if (Object.keys(input).some((key) => !["url", "format", "timeout"].includes(key))) return null;
      // 这里只授权公开网页检索，既不读取本地文件，也不访问本机 Zotero 端点。
      if (!publicURL(input.url)) return null;
    }
    return (options || []).find((option) => option.kind === "allow_once") || null;
  }
  function describe(install, enabled) {
    if (!install) return "先选择 Agent；联网默认关闭";
    if (install.type === "codex") return `${enabled ? "允许" : "禁止"} Codex 联网搜索；搜索开关已核对，实际检索仍需测试`;
    if (install.type === "opencode") return `${enabled ? "允许" : "禁止"} OpenCode 搜索与网页读取；搜索后端由 OpenCode 提供，服务可用性需实际检索验证`;
    return `${enabled ? "允许" : "禁止"} DeepSeek Harness 搜索与网页读取；使用自有 patch，后端凭据由 Harness 管理，服务可用性需实际检索验证`;
  }
  return { setup, patch, name, permission, describe };
})();
