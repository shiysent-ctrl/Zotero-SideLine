/*
 * Sideline 单次条目问答服务，供本机 /chat 端点调用。
 * 输入：create 注入条目解析器，execute 接收 JSON 数据；输出：{status, data}，不包含 HTTP 声明。
 * 依赖：context/config/functions/prompts、providers/client、session 与 notes。
 * 保留端点自己的历史与保存策略；预算校验复用客户端，不接管侧栏 UI。
 */
Sideline.chatservice = (function () {
  const resultOf = (status, data) => ({ status, data });
  const badRequest = (message) => resultOf(400, { error: message });

  function create({ itemFromID }) {
    async function execute(data = {}) {
      const question = String(data.question || "").trim();
      const functionEntry = data.functionId ? Sideline.functions.byId(data.functionId) : null;
      if (data.functionId && !functionEntry) {
        return badRequest(`未知功能：${data.functionId}`);
      }
      if (!question && !functionEntry) return badRequest("question 必填（或指定 functionId）");
      const item = itemFromID(data.itemID);
      if (!item) return badRequest("itemID 无效或条目不存在");
      const started = Date.now();
      const context = await Sideline.context.build(item, {
        mode: data.mode,
        maxChars: data.maxChars,
        selection: data.selection,
      });
      const config = Sideline.config.read();
      config.stream = false;
      if (data.systemPrompt) config.systemPrompt = String(data.systemPrompt);
      if (data.temperature !== undefined) config.temperature = String(data.temperature);
      if (Object.prototype.hasOwnProperty.call(data, "maxTokens")) config.maxTokens = data.maxTokens;
      if (data.model) config.model = String(data.model);
      if (data.provider) {
        const legacy = { codex: "agent", deepseek: "api" };
        const channel = legacy[String(data.provider)] || String(data.provider);
        if (!["api", "agent"].includes(channel)) return badRequest("provider 只能是 api 或 agent");
        config.textChannel = channel;
        config.provider = String(data.provider);
      }
      if (data.model && config.textChannel === "api") config.textModel = String(data.model);
      // 不提前取整或回退零值；沿用客户端的预算与模型上限校验。
      if (Sideline.providers.current(config) === "api") {
        try { Sideline.client.validateTokens(Sideline.config.apiConfig(config)); }
        catch (error) { return badRequest(Sideline.util.message(error)); }
      }
      const requestCheck = Sideline.providers.checkRequest(config);
      if (!requestCheck.ok) return resultOf(503, { error: requestCheck.reason });

      const messages = [{
        role: "system",
        content: `${Sideline.prompts.systemFor(config)}\n\n以下是与本次提问相关的条目上下文：\n\n${context.text}`,
      }];
      if (Array.isArray(data.history)) {
        for (const entry of data.history) {
          if (entry && entry.role && entry.content) {
            messages.push({ role: String(entry.role), content: String(entry.content) });
          }
        }
      }
      const prompt = [functionEntry ? functionEntry.prompt : "", question].filter(Boolean).join("\n\n");
      messages.push({ role: "user", content: prompt });

      if (Sideline.providers.current(config) === "agent") {
        await Sideline.session.restore(item.id);
        messages.splice(1, messages.length - 1, ...Sideline.session.list(item.id).map((entry) => ({ role: entry.role, content: entry.content })),
          { role: "user", content: prompt });
        Sideline.session.append(item.id, "user", prompt);
      }
      const result = await Sideline.providers.chat({ messages, config, ownerID: item.id });
      if (result.provider === "agent") Sideline.session.append(item.id, "assistant", result.content, { model: result.model, provider: result.provider, usage: result.usage });
      const response = {
        answer: result.content,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        item: context.meta,
        stats: context.stats,
        elapsedMs: Date.now() - started,
        sessionId: result.sessionId || "",
        sessionWarning: result.sessionWarning || "",
      };
      if (functionEntry) response.function = { id: functionEntry.id, name: functionEntry.name };
      if (!result.content) {
        return resultOf(502, { error: "模型返回空回答", model: result.model, stats: context.stats });
      }
      if (data.save === true) {
        const note = await Sideline.notes.saveAnswer({
          item,
          question,
          answer: result.content,
          model: result.model,
        });
        response.note = { id: note.id, key: note.key, parentID: note.parentID };
      }
      return resultOf(200, response);
    }

    return { execute };
  }
  return { create };
})();
