/*
 * Sideline 自动高亮任务流程。
 * 输入：阅读器请求状态、配置和重试选项；输出：批次回执、失败段及已创建批注。
 * 依赖：highlights/writes、session/store、providers 和 modelrequest；视图操作通过 create 注入。
 * 本模块拥有本次批次、页面缓存和重试队列；候选正文保留于历史，不渲染到气泡。
 * 侧栏负责宿主挂载与 DOM 生命周期；本模块不能扫描 Agent 或更改其权限。
 */
Sideline.readerhighlights = (function () {
  function create({ view }) {
    const { setStatus, setPendingFunction, renderMessages, refreshTotals, bubble } = view;
    /**
     * 自动高亮：模型只输出候选，插件直接保存并生成 UI 回执；原始模型历史独立保留。
     * 输入：阅读器 state 与发送选项；依赖 highlights、writes、session，不改变 Agent 权限。
     */
    async function sendHighlights(state, { typed, config, retry }) {
      const attachment = Zotero.Items.get(state.attachmentID);
      if (!attachment || !attachment.libraryID) { setStatus(state, "找不到目标 PDF 附件", true); return; }
      const owner = Sideline.store.ownerOf(state.ownerID);
      if (!Sideline.config.bool("persistSessions") || !owner || !owner.persistable) {
        setStatus(state, "自动高亮需要启用会话保存，并将 PDF 归属到文献条目，以保存批次撤销记录", true); return;
      }
      if (retry && (!state.highlightRetry || !state.highlightRetry.jobs.length)) {
        setStatus(state, "没有待重试的正文；再次标注请重新选择自动高亮", false); return;
      }
      state.aborted = false;
      let reply = null, pending = "", saveError = "", sessionWarning = "";
      const batch = { id: `b-${Sideline.session.messageId()}`, attachmentKey: attachment.key,
        libraryID: attachment.libraryID, status: "running", created: 0, skipped: 0, failed: 0, errors: [], coverage: "",
        cost: { calls: 0, reportedCalls: 0, tokens: 0, estimatedInput: 0 } };
      const processed = new Set(), retryJobs = [], pageCache = new Map();
      const prompt = [Sideline.functions.promptOf("highlight"), typed, Sideline.highlights.contract()].filter(Boolean).join("\n\n");
      const addError = (page, quote, reason) => { batch.failed++; batch.errors.push({ page, quote: String(quote || "").slice(0, 100), reason }); };
      const persist = async () => {
        if (reply) await Sideline.session.updateDisplay(state.ownerID, reply.id, { highlightBatch: batch });
        renderMessages(state);
      };
      try {
        setStatus(state, "正在检查会话存档能否保存…", false);
        await Sideline.store.prepareWrite(state.ownerID);
        if (state.aborted) throw new Error("已停止存档检查");
        setPendingFunction(state, "");
        if (state.els.textarea) state.els.textarea.value = "";
        setStatus(state, "正在按页读取正文…", false);
        const source = retry && state.highlightRetry && state.highlightRetry.jobs.length
          ? { chunks: state.highlightRetry.jobs, errors: [], pageCount: Sideline.readertext.pageCount(state.reader) }
          : await Sideline.highlights.documentChunks(state.reader, Math.max(1000, config.maxContextChars - prompt.length - 1000), () => state.aborted, { pageCache });
        for (const error of source.errors) addError(error.page, "", error.reason);
        batch.coverage = `共 ${source.pageCount} 页；${source.chunks.length} 段正文；${source.errors.length} 页未取得正文。`;
        state.lastRequest = { functionId: "highlight", typed, prompt, display: "自动高亮", citations: [], baseMessages: [] };
        if (!source.chunks.length) throw new Error(state.aborted ? "已停止正文读取" : "没有可处理正文；扫描 PDF 需要带位置的 OCR");
        for (let index = 0; index < source.chunks.length; index++) {
          if (state.aborted) break;
          const job = source.chunks[index];
          const requestPrompt = source.chunks.length > 1 ? `${prompt}\n\n本次处理第 ${index + 1}/${source.chunks.length} 段，只标注本段材料。` : prompt;
          Sideline.session.append(state.ownerID, "user", requestPrompt, { display: `自动高亮${typed ? `｜${typed}` : ""}`,
            question: typed, functionId: "highlight", uiHidden: index > 0 });
          renderMessages(state);
          const history = Sideline.providers.current(config) === "agent" ? Sideline.session.list(state.ownerID) : Sideline.session.history(state.ownerID);
          const messages = [{ role: "system", content: `${Sideline.prompts.systemFor(config)}\n\n【本段 PDF 正文】\n${job.text}` },
            ...Sideline.modelrequest.historyMessages(history)];
          const estimate = Sideline.providers.estimateRequestTokens(messages, []);
          setStatus(state, `正在识别第 ${index + 1}/${source.chunks.length} 段（PDF 第 ${job.pages.map((page) => page + 1).join("、")} 页；输入估算 ${estimate.total} tokens）…`, false);
          const progress = bubble(state, { role: "assistant", content: `正在识别重点（${index + 1}/${source.chunks.length} 段）…` });
          state.els.messagesEl.appendChild(progress.wrapper);
          state.requestKey = Sideline.modelrequest.key(state.key);
          const started = Date.now();
          let result;
          pending = "";
          batch.cost.calls++; batch.cost.estimatedInput += estimate.total;
          job.pages.forEach((page) => processed.add(page));
          try {
            result = await Sideline.providers.chat({ ownerID: state.ownerID, messages, images: [], config,
              requestKey: state.requestKey, onWarning: (warning) => { sessionWarning = warning; setStatus(state, warning, true); },
              onDelta: (_piece, whole) => { pending = whole; } });
          } catch (error) {
            pending = pending || error.partialContent || "";
            if (pending) {
              Sideline.session.append(state.ownerID, "assistant", pending, { functionId: "highlight", uiHidden: !!reply,
                highlightBatch: reply ? null : batch, stopped: state.aborted || !!error.cancelled });
              if (!reply) reply = Sideline.session.list(state.ownerID).slice(-1)[0];
            }
            retryJobs.push(...source.chunks.slice(index));
            throw error;
          }
          pending = "";
          const usage = result.usage || {};
          const tokens = Sideline.modelrequest.usageTokens(usage);
          if (tokens > 0) { batch.cost.reportedCalls++; batch.cost.tokens += tokens; }
          Sideline.session.append(state.ownerID, "assistant", result.content || "", { functionId: "highlight", uiHidden: !!reply,
            highlightBatch: reply ? null : batch, model: result.model, provider: result.provider, usage: result.usage,
            elapsedMs: Date.now() - started, question: requestPrompt });
          if (!reply) reply = Sideline.session.list(state.ownerID).slice(-1)[0];
          await persist();
          if (state.aborted) { retryJobs.push(...source.chunks.slice(index)); break; }
          try {
            const candidates = Sideline.highlights.parse(result.content || "");
            setStatus(state, `正在定位并保存第 ${index + 1}/${source.chunks.length} 段批注…`, false);
            const prepared = await Sideline.highlights.prepare(state.reader, candidates, { allowedPages: job.pages, pageCache });
            const created = await Sideline.highlights.commit({ attachment, entries: prepared,
              color: config.readerAnnotationColor, ownerID: state.ownerID, batchId: batch.id, shouldStop: () => state.aborted });
            let failed = false;
            for (const item of created) {
              if (item.ok) batch.created++;
              if (item.skipped) batch.skipped++;
              if (item.error) { failed = true; addError(item.pageLabel, item.quote, item.error); }
            }
            if (failed || state.aborted) retryJobs.push(job);
          } catch (error) { addError(job.pages.map((page) => page + 1).join("、"), "", Sideline.util.message(error)); retryJobs.push(job); }
          await persist();
          if (result.sessionWarning) { sessionWarning = result.sessionWarning; setStatus(state, sessionWarning, true); }
          if (state.aborted) { retryJobs.push(...source.chunks.slice(index + 1)); break; }
        }
        batch.status = state.aborted ? "stopped" : batch.failed ? "partial" : "complete";
        batch.coverage += ` 已请求识别 ${batch.cost.calls}/${source.chunks.length} 段，涉及 ${processed.size} 页；${retryJobs.length} 段未完成或需重试。`;
      } catch (error) {
        batch.status = state.aborted || error.cancelled ? "stopped" : "failed";
        addError("", "", state.aborted || error.cancelled ? "已停止，未开始的候选未保存" : Sideline.util.message(error));
      } finally {
        pageCache.clear();
        if (!reply) {
          // 未得到模型回答时，回执是本地 UI 记录；组装 API/Agent 历史时必须排除。
          Sideline.session.append(state.ownerID, "assistant", "", { functionId: "highlight", localOnly: true, highlightBatch: batch });
          reply = Sideline.session.list(state.ownerID).slice(-1)[0];
        }
        state.highlightRetry = { jobs: retryJobs };
        try { await persist(); } catch (error) { saveError = `结果记录未能保存：${Sideline.util.message(error)}`; }
        state.requestKey = null;
        state.aborted = false;
        renderMessages(state); refreshTotals(state);
        setStatus(state, saveError || sessionWarning || `已创建 ${batch.created} 条批注${batch.failed ? `；${batch.failed} 项未完成，原因见回复` : ""}`, !!saveError || !!sessionWarning || batch.status === "failed");
      }
    }

    return { sendHighlights };
  }
  return { create };
})();
