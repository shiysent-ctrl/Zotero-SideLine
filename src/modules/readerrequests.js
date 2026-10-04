/*
 * Sideline 普通侧栏对话流程。
 * 输入：阅读器请求状态与发送/重试选项；输出：模型消息、保存结果和视图反馈。
 * 依赖：materials/functions、session/store、providers、citations 与 modelrequest；DOM 更新经 create 回调注入。
 * 请求流程负责 lastRequest/editing/requestKey/aborted；不改变宿主挂载、菜单或材料采集实现。
 * uiHidden 只影响显示，localOnly 不进入模型历史；停止保留部分正文，重试替换原轮次。
 */
Sideline.readerrequests = (function () {
  /**
   * @param {object} dependencies view 只提供界面操作；ensureScope 只准备材料；sendHighlights 处理专用批次。
   * 请求状态字段：busy/aborted/requestKey/lastRequest/editing/pendingFunction；生命周期由 send 统一收尾。
   * reader、ownerID、attachmentID、materials 由侧栏提供，本模块不替换阅读器或挂载节点。
   */
  function create({ view, ensureScope, sendHighlights }) {
    const { setStatus, setBusy, setPendingFunction, syncInputHint, renderMessages,
      renderMaterials, refreshTotals, bubble, scrollToEnd, answerHtml, attachPageRefs,
      attachQuoteLocators, attachAssistantTools } = view;
    /** 请求占用覆盖材料准备到最终渲染；异步取文时重复激活不能发起第二次请求。 */
    async function send(state, options = {}) {
      if (state.busy || !state.els) return;
      const retry = options.retry === true && !!state.lastRequest;
      if (!retry && !options.functionId && !state.pendingFunction
        && !String(state.els.textarea?.value || "").trim()) {
        setStatus(state, "请输入问题，或先加入材料", true);
        return;
      }
      state.aborted = false;
      setBusy(state, true);
      try { return await sendPrepared(state, options); }
      catch (error) {
        setStatus(state, state.aborted ? "已停止；输入内容已保留" : `失败：${Sideline.util.message(error)}`, !state.aborted);
      }
      finally { state.aborted = false; setBusy(state, false); }
    }

    /** 区分模型成功与持久化成功；只核验当前文献，不以另一篇保存成功代替。 */
    async function saveAnswer(ownerID) {
      if (!Sideline.config.bool("persistSessions") || !Sideline.store.ownerOf(ownerID)?.persistable) return "";
      let reason = "";
      try {
        if (await Sideline.store.flushItem(ownerID)) return "";
        reason = Sideline.store.saveError(ownerID) || "写入未完成";
      }
      catch (error) { reason = Sideline.util.message(error); }
      return `回答已生成，但会话保存失败：${reason}；重开后可能丢失本轮对话`;
    }

    async function sendPrepared(state, options = {}) {
      if (!state.els) return;
      const config = Sideline.config.read();
      const textarea = state.els.textarea;
      const retry = options.retry === true && !!state.lastRequest;
      const typed = retry
        ? String(state.lastRequest.typed || "")
        : String((textarea && textarea.value) || "").trim();
      // 功能来自下拉栏选中的待执行功能，或调用方显式指定
      const functionId = retry ? (state.lastRequest.functionId || "") : String(options.functionId || state.pendingFunction || "");
      if (functionId === "highlight") return sendHighlights(state, { typed, config, retry });

      let functionEntry = null;
      let scopeInfo = null;
      let promptText = "";
      let displayText = "";
      let citations = [];

      if (retry) {
        // 重试沿用上一次的提示词、显示文本与引用，并替换原来的整轮问答。
        const last = state.lastRequest;
        promptText = last.prompt;
        displayText = last.display;
        citations = last.citations || [];
      }
      else {
        if (functionId) {
          functionEntry = Sideline.functions.byId(functionId);
          if (!functionEntry) {
            setStatus(state, `未知功能：${functionId}`, true);
            return;
          }
          scopeInfo = Sideline.functions.resolveScope(functionEntry.id, {
            selection: state.materials.some((entry) => entry.kind === "selection"),
            page: true,
            document: true,
          });
          const scope = await ensureScope(state, scopeInfo.scope);
          if (state.aborted) {
            setStatus(state, "已停止；输入内容已保留", false);
            return;
          }
          if (!scope.ok) {
            setStatus(state, scope.reason, true);
            return;
          }
        }
        else if (!typed) {
          setStatus(state, "请输入问题，或先加入材料", true);
          return;
        }
        promptText = functionEntry
          ? [functionEntry.prompt, typed].filter(Boolean).join("\n\n")
          : typed;
        displayText = functionEntry
          ? `${functionEntry.name}${typed ? `｜${typed}` : ""}${scopeInfo && scopeInfo.downgraded ? `（${scopeInfo.reason}）` : ""}`
          : typed;
        citations = state.materials
          .filter((entry) => entry.kind === "selection" || entry.kind === "annotation")
          .map((entry) => ({
            label: `${entry.label}：${String(entry.text || "").slice(0, 80)}`,
            pageIndex: entry.pageIndex,
            pageLabel: entry.pageLabel,
            rects: entry.rects,
          }));
      }

      const images = state.materials.filter((entry) => entry.kind === "image").map((entry) => entry.dataUrl);
      const vision = Sideline.providers.checkRequest(config, images);
      if (!vision.ok) {
        setStatus(state, vision.reason, true);
        return;
      }

      if (textarea && !retry) {
        textarea.value = "";
        syncInputHint(state);
      }

      const assembled = Sideline.materials.assemble(state.materials, {
        maxChars: Sideline.config.num("maxContextChars"),
      });
      const currentMessages = Sideline.session.list(state.ownerID);
      const rebuildAgent = !!retry || !!state.editing;
      const baseMessages = retry
        ? (state.lastRequest.baseMessages || []).map((message) => Object.assign({}, message))
        : (state.editing && state.editing.from >= 0
          ? currentMessages.slice(0, state.editing.from).map((message) => Object.assign({}, message))
          : currentMessages.map((message) => Object.assign({}, message)));
      if (retry || state.editing) {
        Sideline.session.replace(state.ownerID, baseMessages);
      }
      state.editing = null;
      state.lastRequest = {
        functionId,
        typed,
        prompt: promptText,
        display: displayText,
        citations,
        baseMessages,
      };
      // 功能已被这一轮消耗；重试所需的 functionId 已保存在 lastRequest。
      if (state.pendingFunction) setPendingFunction(state, "");

      Sideline.session.append(state.ownerID, "user", promptText, {
        display: displayText,
        question: typed,
        functionId,
        citations,
        images: Sideline.providers.current(config) === "agent"
          ? images.filter((url) => !baseMessages.some((entry) => (entry.images || []).includes(url))) : [],
      });
      renderMessages(state);

      const systemParts = [Sideline.prompts.systemFor(config, {
        // R14：本轮材料里有多个条目时，追加「逐条标注来源文献」的要求
        itemCount: state.materials.filter((entry) => entry.kind === "item").length,
      })];
      if (assembled.text) systemParts.push(`【本轮材料】\n${assembled.text}`);
      else systemParts.push("【本轮材料】\n（本轮没有材料，只能依据对话历史回答；缺少依据时要说明。）");
      const messages = [{ role: "system", content: systemParts.join("\n\n") }];
      const history = Sideline.providers.current(config) === "agent"
        ? Sideline.session.list(state.ownerID) : Sideline.session.history(state.ownerID);
      messages.push(...Sideline.modelrequest.historyMessages(history));
      if (!messages.length || messages[messages.length - 1].role !== "user") {
        messages.push({ role: "user", content: promptText });
      }

      const assistantNode = bubble(state, { role: "assistant", content: "…" });
      state.els.messagesEl.appendChild(assistantNode.wrapper);
      // 发送前先报一次估算用量（R12）；真实用量在响应回来后替换
      const estimate = Sideline.providers.estimateRequestTokens(messages, images);
      setStatus(state, `生成中…（约 ${estimate.total} tokens）`, false);
      scrollToEnd(state);

      // 流式过程中就按 Markdown 渲染（每 120ms 一次，避免逐字重排），结束时再定稿
      const renderStream = Sideline.modelrequest.streamRenderer((source) => {
        assistantNode.body.innerHTML = Sideline.citations.render(source, null);
        scrollToEnd(state);
      }, { normalize: Sideline.modelrequest.answerText });

      let streamed = "";
      let answerStored = false;
      const started = Date.now();
      const requestKey = Sideline.modelrequest.key(state.key);
      state.requestKey = requestKey;
      try {
        const result = await Sideline.providers.chat({
          ownerID: state.ownerID,
          rebuildAgent,
          onWarning: (warning) => setStatus(state, warning, true),
          messages,
          images,
          config,
          requestKey,
          onDelta: (piece, whole) => {
            streamed = whole;
            renderStream(whole);
          },
        });
        if (state.aborted) throw new Error("aborted");
        const answer = result.content || streamed;
        if (!answer.trim()) throw new Error("模型返回了空回答");

        // 回答里的页码引用解析成锚点（R04）：用纸面页码表反查，解析不到就不做锚点
        let pageRefs = [];
        try {
          const labels = await Sideline.readertext.pageLabels(state.reader);
          pageRefs = Sideline.citations
            .resolve(Sideline.citations.find(answer), labels)
            .map((entry) => ({
              kind: "pageref",
              label: `第 ${entry.label} 页`,
              pageLabel: entry.label,
              pageIndex: entry.pageIndex,
              rects: null,
            }));
        }
        catch (error) {
          pageRefs = [];
        }

        const extra = {
          model: result.model,
          provider: result.provider,
          question: promptText,
          functionId,
          elapsedMs: Date.now() - started,
          usage: result.usage || null,
          citations: pageRefs,
        };
        const clean = Sideline.modelrequest.answerText(answer);
        Sideline.session.append(state.ownerID, "assistant", clean, extra);
        answerStored = true;
        const stored = Sideline.session.list(state.ownerID).slice(-1)[0];
        assistantNode.body.innerHTML = answerHtml(state, stored);
        attachPageRefs(state, assistantNode.body, stored);
        attachQuoteLocators(state, assistantNode.body, stored);
        attachAssistantTools(state, assistantNode, stored);
        const saveWarning = await saveAnswer(state.ownerID);
        refreshTotals(state);

        const usage = result.usage || {};
        const tokens = Sideline.modelrequest.usageTokens(usage);
        const extras = [];
        if (images.length && result.forcedByImages) extras.push("含图片，使用视觉 API");
        if (pageRefs.length) extras.push(`${pageRefs.length} 处页码可点击`);
        if (Sideline.highlights.looksLikeCandidates(clean)) extras.push("可标记重点");
        setStatus(state, [
          `${Sideline.providers.label(result.provider)} · ${result.model}`,
          `${assembled.chars} 字上下文`,
          tokens ? `${tokens} tokens` : `约 ${estimate.total} tokens（估算）`,
          `${((Date.now() - started) / 1000).toFixed(1)}s`,
        ].concat(extras).join(" · "), false);
        if (saveWarning || result.sessionWarning) setStatus(state, [saveWarning, result.sessionWarning].filter(Boolean).join("；"), true);
      }
      catch (error) {
        try {
          assistantNode.wrapper.remove();
        }
        catch (inner) {
          // 忽略
        }
        const stopped = state.aborted || !!error.cancelled;
        const partial = Sideline.modelrequest.answerText(streamed || error.partialContent || "");
        // 停止时保留已经显示出来的部分回答；即便还没收到首个片段，也保留用户问题。
        if (stopped && partial && !answerStored) {
          const provider = Sideline.providers.current(config);
          Sideline.session.append(state.ownerID, "assistant", partial, {
            model: images.length ? Sideline.config.apiConfig(config, true).model
              : provider === "agent" ? config.agentModel : Sideline.config.apiConfig(config).model,
            provider,
            question: promptText,
            functionId,
            elapsedMs: Date.now() - started,
            usage: null,
            citations: [],
            stopped: true,
          });
        }
        renderMessages(state);
        if (!answerStored) {
          setStatus(state, stopped
            ? "已停止；问题与已生成内容已保留"
            : `失败：${Sideline.util.message(error)}`, !stopped, {
            label: "重试",
            run: () => void send(state, { retry: true }),
          });
        }
      }
      finally {
        if (state.requestKey === requestKey) state.requestKey = null;
        state.aborted = false;
        if (state.materials.length) renderMaterials(state);
        // 无论正常结束、停止还是失败，都从已存消息重渲染一遍：
        // 保证气泡里的内容一定是渲染后的 Markdown，而不是流式过程中的中间态
        renderMessages(state);
        refreshTotals(state);
      }
    }

    return { send };
  }
  return { create };
})();
