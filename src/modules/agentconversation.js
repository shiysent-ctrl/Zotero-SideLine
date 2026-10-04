/*
 * 每篇文献的 Agent 会话管理。输入：宿主条目、完整 Sideline 消息和当前材料；
 * 输出：复用原会话的回答，或恢复失败后重建的红色提示。依赖：agents、jsonfile、白名单适配器。
 * 本机映射只保存安装、会话 ID 和同步摘要；正文仍只存在 Zotero 会话附件中。
 */
Sideline.agentconversation = (function () {
  let bindings = null, loading = null, writes = Promise.resolve();
  const running = new Map();
  function ownerKey(itemID) {
    const id = Sideline.store ? Sideline.store.keyOf(itemID) : Number(itemID);
    if (!(id > 0)) throw new Error("Agent 对话必须关联一篇文献");
    const item = Zotero.Items && Zotero.Items.get(id);
    return item && item.key ? `${item.libraryID || 1}-${item.key}` : `item-${id}`;
  }
  async function load() {
    if (bindings) return bindings;
    if (!loading) loading = (async () => {
      const file = await Sideline.jsonfile.read("agent-bindings.json");
      const parsed = file ? JSON.parse(file.text) : {};
      bindings = new Map(Object.entries(parsed.bindings || {}));
      return bindings;
    })();
    // 映射损坏时停止，不能静默覆盖并丢失清理目标。
    return loading;
  }
  function save() {
    const text = JSON.stringify({ version: 1, bindings: Object.fromEntries(bindings) });
    writes = writes.catch(() => {}).then(async () => {
      await Zotero.File.createDirectoryIfMissingAsync(Sideline.jsonfile.directory());
      if (!await Sideline.jsonfile.write("agent-bindings.json", text)) throw new Error("Agent 会话映射保存失败");
    });
    return writes;
  }
  function digest(text) {
    let h = 2166136261;
    for (const char of String(text)) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); }
    return `${String(text).length}:${h >>> 0}`;
  }
  function clean(text) {
    const value = String(text || "").trim();
    const match = value.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    return match && !/^[\[{]/.test(match[1].trim()) ? match[1].trim() : value;
  }
  function historyDigest(messages) {
    return digest(JSON.stringify(messages.map(messageDigestParts)));
  }
  function messageDigestParts(m) {
    return m.images?.length ? [m.role, clean(m.content), m.images.map(digest)] : [m.role, clean(m.content)];
  }
  function historyTail(messages) {
    return messages.map((m) => digest(JSON.stringify(messageDigestParts(m))))
      .slice(-Math.max(2, Sideline.config.num("maxStoredMessages") || 60));
  }
  function matches(binding, prior) {
    if (!binding.historyDigest || binding.historyDigest === historyDigest(prior)) return true;
    // 附件按消息上限裁剪后，仍应继续 Agent 已有上下文；只比较双方共有的末尾。
    const tail = historyTail(prior), saved = binding.historyTail || [];
    const size = Math.min(tail.length, saved.length);
    return size > 0 && JSON.stringify(tail.slice(-size)) === JSON.stringify(saved.slice(-size));
  }
  function adapter(install) { return install.type === "codex" ? Sideline.codex : Sideline.agentacp; }
  function directory(key) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error("无效的文献标识");
    return Sideline.agentinstall.join(Sideline.jsonfile.directory(), `agent-work/${key}`);
  }
  async function discard(binding, key) {
    if (!binding || !binding.sessionId) return;
    if (binding.cwd !== directory(key)) throw new Error("Agent 记忆目录与当前文献不匹配，未删除");
    if (binding.type === "codex") return Sideline.codex.discard({}, binding);
    if (binding.type === "dsh") return Sideline.agentacp.discard({ type: "dsh" }, binding);
    const install = await Sideline.agentinstall.validateInstall(binding.path, "auto");
    if (install.type !== binding.type) throw new Error("原会话的 Agent 安装类型发生变化，无法安全清理");
    await adapter(install).discard(install, binding);
  }
  async function execute(install, options) {
    const key = ownerKey(options.ownerID);
    if (running.has(key)) throw new Error("这篇文献的 Agent 正在处理另一条请求");
    const task = (async () => {
      await load();
      const messages = options.messages.filter((m) => m.role !== "system");
      const prior = messages.slice(0, -1);
      const system = options.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      let old = bindings.get(key), warning = "";
      if (old && (options.rebuild || old.resetPending || old.installId !== install.id || !matches(old, prior))) {
        await discard(old, key);
        bindings.delete(key); await save(); old = null;
        warning = "Agent 会话已重建：通道或对话内容发生变化，已补入 Sideline 上下文";
      }
      const cwd = directory(key);
      await Zotero.File.createDirectoryIfMissingAsync(cwd);
      let binding = old || { installId: install.id, type: install.type, path: install.path,
        cwd, sessionId: "", created: Date.now(), historyDigest: "", systemDigest: "" };
      const initialPrompt = Sideline.providers.renderPrompt(options.messages);
      const images = [...new Set(options.messages.flatMap((m) => m.images || []).concat(options.images || []))];
      const incremental = [binding.systemDigest !== digest(system)
        ? `【当前指令与材料更新，替代此前材料】\n${system}` : "", messages[messages.length - 1].content].filter(Boolean).join("\n\n");
      if (!binding.sessionId && prior.length && !warning) warning = "Agent 会话已重建：已补入 Sideline 历史上下文";
      function notify() { if (warning && options.onWarning) options.onWarning(warning); }
      notify();
      let submitted = false;
      const run = async (resume) => adapter(install).run(install, Object.assign({}, options, {
        cwd, sessionId: resume ? binding.sessionId : "",
        // 原会话保留已见图片，后续只追加新图片；恢复失败重建时补入留存的图片。
        images: resume ? images.filter((url) => !(binding.imageDigests || []).includes(digest(url))) : images,
        prompt: resume && binding.systemDigest ? incremental : initialPrompt,
        async onSession(sessionId) {
          if (!sessionId) throw new Error("Agent 未返回可持久化的会话 ID");
          if (resume && binding.sessionId !== sessionId) throw new Error("Agent 恢复时返回了不同的会话 ID");
          binding.sessionId = sessionId;
          bindings.set(key, binding); await save();
        },
        async onPrompt() {
          submitted = true; binding.systemDigest = digest(system);
          binding.imageDigests = [...new Set((binding.imageDigests || []).concat(images.map(digest)))];
          binding.historyDigest = historyDigest(messages);
          binding.historyTail = historyTail(messages);
          bindings.set(key, binding); await save();
        },
      }));
      let result;
      try {
        try { result = await run(!!binding.sessionId); }
        catch (error) {
          if (!error.resumeFailed || error.cancelled) throw error;
          // 只在尚未提交 prompt 的恢复阶段重建。模型失败不能触发第二次收费请求。
          warning = `Agent 原会话无法恢复，已新建并补入上下文：${Sideline.agents.diagnostic(error.message)}`;
          notify();
          await discard(binding, key);
          binding = Object.assign({}, binding, { sessionId: "", imageDigests: [], created: Date.now() });
          result = await run(false);
        }
        binding.historyDigest = historyDigest(messages.concat({ role: "assistant", content: result.content }));
        binding.historyTail = historyTail(messages.concat({ role: "assistant", content: result.content }));
        if (!binding.sessionId) throw new Error("Agent 未返回可持久化的会话 ID");
        await save();
        return Object.assign({}, result, { sessionWarning: warning, sessionId: binding.sessionId });
      } catch (error) {
        if (binding.sessionId && submitted) {
          binding.historyDigest = historyDigest(error.partialContent
            ? messages.concat({ role: "assistant", content: error.partialContent }) : messages);
          binding.historyTail = historyTail(error.partialContent
            ? messages.concat({ role: "assistant", content: error.partialContent }) : messages);
          await save();
        }
        error.sessionWarning = warning; throw error;
      }
    })();
    running.set(key, task);
    try { return await task; } finally { if (running.get(key) === task) running.delete(key); }
  }
  async function reset(itemID) {
    const key = ownerKey(itemID);
    const pending = running.get(key);
    const task = (async () => {
      await load();
      if (pending) { Sideline.agents.cancelOwner(itemID); await pending.catch(() => {}); }
      const old = bindings.get(key);
      // 先落盘「不得恢复」状态，再清理记忆；删除失败也不能在下一次提问中恢复旧讨论。
      if (old) { old.resetPending = true; await save(); }
      await discard(old, key);
      bindings.delete(key); await save();
      const config = Sideline.config.read();
      if (Sideline.providers.current(config) === "agent") {
        const install = await Sideline.agents.selected(config);
        if (install.type !== "codex") {
          const cwd = directory(key);
          await Zotero.File.createDirectoryIfMissingAsync(cwd);
          const sessionId = await Sideline.agentacp.create(install, { cwd, model: config.agentModel,
            effort: config.agentEffort, search: config.agentSearch });
          bindings.set(key, { installId: install.id, type: install.type, path: install.path, cwd,
            sessionId, created: Date.now(), historyDigest: "", systemDigest: "" });
          await save();
        }
      }
      return !!old;
    })();
    running.set(key, task);
    try { return await task; } finally { if (running.get(key) === task) running.delete(key); }
  }
  async function binding(itemID) { await load(); return bindings.get(ownerKey(itemID)) || null; }
  return { execute, reset, binding, directory, digest, historyDigest };
})();
