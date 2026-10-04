/*
 * Zotero Sideline：本机 HTTP 端点。
 * 功能：把插件能力暴露为 127.0.0.1:23119 上的 JSON 接口，供外部脚本或 agent 调用：
 *       GET  /sideline/status   运行状态、启动诊断与配置摘要（不含密钥）
 *       POST /sideline/selftest 只读自检：配置、各挂载点、指定条目的附件与正文可用性
 *       POST /sideline/context  取某个条目的元数据与 PDF 全文上下文
 *       POST /sideline/chat     一次性问答（非流式，可要求同时存为子笔记，也可指定 functionId）
 *       POST /sideline/note     把已有问答存为子笔记
 *       POST /sideline/sessions 列出会话，或按 itemID 查单个条目（多会话时带 sessions 列表）
 *       POST /sideline/sessions/delete 删除某个条目的会话（可只删一条会话）
 *       POST /sideline/functions 列出功能注册表（功能名/作用范围/是否被改写），只读
 *       POST /sideline/provider 报告当前文本通道与视觉通道的选择，只读
 *       POST /sideline/diag/codex  验证用：子进程通道与 Codex CLI（version 不调用模型）
 *       POST /sideline/diag/reader 验证用：阅读器文本层结构（页/文本/几何）
 *       POST /sideline/diag/readertext 验证用：新的按页取文与覆盖状态（只读）
 *       POST /sideline/diag/sessions   验证用：会话 JSON 附件的解析与读写（probe=write 会写入插件自己的会话附件）
 * 说明：与 paper-push 桥接插件同一模式；端点仅监听本机，任何本机进程都可调用，
 *       因此不在响应中回显密钥，也只做「读 + 新增笔记/批注 + 插件自己的会话附件」，
 *       不修改既有条目字段、标签或原有批注。
 */

Sideline.endpoints = (function () {
  const chat = Sideline.chatservice.create({ itemFromID });
  function json(status, data) {
    return [status, "application/json; charset=utf-8", JSON.stringify(data)];
  }

  function fail(error) {
    const message = Sideline.agents.diagnostic(Sideline.util.message(error));
    Sideline.util.error(new Error(message));
    return json(500, { error: message });
  }

  function badRequest(message) {
    return json(400, { error: message });
  }

  function positiveInt(value, name) {
    const number = parseInt(value, 10);
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`${name} 必须是正整数`);
    }
    return number;
  }

  function itemFromID(value) {
    let id = null;
    try {
      id = positiveInt(value, "itemID");
    }
    catch (error) {
      return null;
    }
    const item = Zotero.Items.get(id);
    if (!item || item.deleted) return null;
    return item;
  }

  class StatusEndpoint {
    supportedMethods = ["GET"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    // 注意：Zotero 用 init.length 判断端点签名——1 个参数表示「返回 [status, contentType, body]」，
    // 0 个参数会被当成旧式三参数端点（返回值被忽略、请求永不响应），因此这里必须保留一个形参。
    async init(_request) {
      try {
        const config = Sideline.config.summary();
        return json(200, {
          ready: true,
          plugin: "Zotero Sideline",
          pluginVersion,
          pluginID,
          zoteroVersion: Zotero.version,
          config,
          diagnostics: Sideline.diagnostics.snapshot(),
          promptTemplates: Sideline.prompts.list().map((entry) => entry.id),
          functions: Sideline.functions.list().map((entry) => entry.id),
          providers: Sideline.providers.describe(),
          endpoints: Object.keys(PATHS),
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 只读自检：逐项报告配置、各挂载点注册结果与（可选）指定条目的附件与正文可用性。
   * 不调用模型，写入行为只有 Zotero 自身建立全文索引。
   */
  class SelfTestEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const checks = [];
        const push = (name, status, detail) => {
          checks.push({ name, status, detail: detail === undefined ? "" : String(detail) });
        };

        const config = Sideline.config.read();
        const channel = Sideline.providers.current(config);
        if (channel === "agent") {
          try {
            const install = await Sideline.agents.selected(config);
            push("Agent 安装", "pass", Sideline.agents.display(install));
          }
          catch (error) { push("Agent 安装", "fail", Sideline.agents.diagnostic(error.message)); }
          push("对话端点", "skip", "Agent 通道无需 HTTP API 配置；登录与协议请在设置中检测");
        }
        else {
          const apiConfig = Sideline.config.apiConfig(config, false);
          push("配置完整（api/model/key）", Sideline.config.isConfigured(apiConfig) ? "pass" : "fail",
            `api=${apiConfig.api}　model=${apiConfig.model}　keyPresent=${!!apiConfig.secretKey}`);
          push("对话端点", Sideline.config.endpoint(apiConfig.api) ? "pass" : "fail", Sideline.config.endpoint(apiConfig.api));
        }

        const diagnostics = Sideline.diagnostics.snapshot();
        for (const key of ["endpoints", "reader", "readerPanel", "prefsPane", "store"]) {
          const entry = diagnostics.items[key];
          if (!entry) push(`启动项 ${key}`, "fail", "未记录");
          else if (entry.ok) push(`启动项 ${key}`, "pass", entry.skipped ? "已跳过" : "");
          else push(`启动项 ${key}`, entry.skipped ? "skip" : "fail", entry.error || "");
        }

        if (data.itemID) {
          const item = itemFromID(data.itemID);
          push("条目", item ? "pass" : "fail",
            item ? `#${item.id} ${item.getField("title") || ""}`.trim() : "itemID 无效或条目不存在");
          if (item) {
            const isRegular = typeof item.isRegularItem === "function" && item.isRegularItem();
            const isAttachment = typeof item.isAttachment === "function" && item.isAttachment();
            push("条目类型", "pass", isRegular ? "普通文献条目" : (isAttachment ? "附件条目" : "其他类型"));
            const attachment = await Sideline.context.resolveAttachment(item);
            push("PDF/EPUB 附件", attachment ? "pass" : "skip",
              attachment ? `#${attachment.id} ${attachment.attachmentContentType || ""}`.trim() : "没有可用附件");
            if (attachment) {
              push("附件可索引", Zotero.Fulltext.canIndex(attachment) ? "pass" : "skip",
                attachment.attachmentContentType || "");
              const full = await Sideline.context.fullText(attachment, 2000);
              push("正文可读取", full.state === "ok" ? "pass" : (full.state === "unsupported" ? "skip" : "fail"),
                `${Sideline.context.stateText(full.state)}；${full.chars}/${full.totalChars} 字`);
            }
          }
        }
        else {
          push("条目检查", "skip", "未提供 itemID");
        }
        push("模型调用", "skip", "自检不调用模型，避免消耗额度");

        const failed = checks.filter((check) => check.status === "fail").length;
        return json(200, {
          ok: failed === 0,
          failed,
          checks,
          diagnostics,
          config: Sideline.config.summary(),
          note: "本自检只读：除 Zotero 自身建立全文索引外不产生数据改动。",
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  class ContextEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        const context = await Sideline.context.build(item, {
          mode: data.mode,
          maxChars: data.maxChars,
          selection: data.selection,
        });
        const response = { item: context.meta, stats: context.stats };
        if (data.includeText !== false) {
          response.text = context.text;
        }
        return json(200, response);
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  class ChatEndpoint {
    supportedMethods = ["POST"];
    supportedDataTypes = ["application/json"];
    permitBookmarklet = false;

    async init(request) {
      try {
        const result = await chat.execute(request.data || {});
        return json(result.status, result.data);
      }
      catch (error) { return fail(error); }
    }
  }

  class NoteEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        const answer = String(data.answer || "").trim();
        if (!answer) return badRequest("answer 必填");
        const note = await Sideline.notes.saveAnswer({
          item,
          question: String(data.question || "").trim(),
          answer,
          model: data.model ? String(data.model) : "",
          source: data.source ? String(data.source) : "",
        });
        return json(200, {
          noteID: note.id,
          noteKey: note.key,
          parentID: note.parentID,
          title: note.getField("title") || "",
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 会话存档：列出全部存档记录，或按 itemID 查单个条目。只读插件自己的 sessions.json。
   */
  class SessionsEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const stats = await Sideline.store.stats();
        if (data.itemID) {
          const item = itemFromID(data.itemID);
          if (!item) return badRequest("itemID 无效或条目不存在");
          const record = await Sideline.store.get(item.id);
          const sessions = await Sideline.store.listSessions(item.id);
          const attachment = await Sideline.store.resolveAttachment(item.id);
          const writes = await Sideline.store.listWrites(item.id);
          return json(200, {
            itemID: item.id,
            session: record,
            sessions,
            attachment,
            writes,
            stats,
          });
        }
        const sessions = await Sideline.store.list();
        return json(200, { count: sessions.length, sessions, stats });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 删除某个条目的会话存档。只动插件自己的 sessions.json，不修改任何 Zotero 数据。
   */
  class SessionDeleteEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        let removed = false;
        await Sideline.agentconversation.reset(item.id);
        Sideline.session.clear(item.id);
        removed = await Sideline.store.remove(item.id);
        await Sideline.store.flush();
        return json(200, {
          itemID: item.id,
          deleted: removed,
          sessions: await Sideline.store.listSessions(item.id),
          stats: await Sideline.store.stats(),
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 功能注册表（只读）：外部 agent 据此知道有哪些功能名、作用范围，以及提示词是否被改写。
   */
  class FunctionsEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(_request) {
      try {
        return json(200, {
          functions: Sideline.functions.list().map((entry) => ({
            id: entry.id,
            name: entry.name,
            scope: entry.scope,
            scopeText: Sideline.functions.scopeText(entry.scope),
            customized: entry.customized,
            promptChars: entry.prompt.length,
          })),
          buttons: Sideline.functions.buttons().map((entry) => entry.id),
          note: "提示词正文不在响应中返回；可在设置的功能卡片中逐项改写。",
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 模型通道（只读）：报告文本通道与视觉通道的选择与可用性。
   */
  class ProviderEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(_request) {
      try {
        const described = Sideline.providers.describe();
        let codex = null;
        try {
          codex = { executable: Sideline.codex.executable(), procAvailable: Sideline.proc.available() };
        }
        catch (error) {
          codex = { error: Sideline.util.message(error) };
        }
        return json(200, Object.assign({}, described, {
          codex,
          note: "Codex 通道不支持图片输入（本机实测）；带图片的请求固定使用视觉 API。",
        }));
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 验证用端点：检查子进程通道与 Codex CLI 是否可用。不属于功能路径，可随时移除。
   * probe=version 只跑 `codex --version`（不调用模型）；probe=chat 会真实调用一次 Codex。
   */
  class DiagCodexEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const probe = String(data.probe || "version");
        if (probe === "version") {
          const info = await Sideline.codex.version();
          return json(200, Object.assign({ probe, procAvailable: Sideline.proc.available() }, info));
        }
        if (probe === "chat") {
          const started = Date.now();
          const result = await Sideline.codex.run({
            diagnostic: true,
            prompt: String(data.prompt || "回复 OK"),
            images: [],
            timeoutMs: parseInt(data.timeoutMs, 10) || 0,
          });
          return json(200, {
            probe,
            executable: result.executable,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            elapsedMs: Date.now() - started,
            content: result.content,
            usage: result.usage,
            threadId: result.threadId,
            errors: result.errors,
            eventTypes: [...new Set(result.events.map((event) => (event && event.type) || "unknown"))],
            stderr: String(result.stderr || "").slice(0, 2000),
          });
        }
        return badRequest("probe 只能是 version 或 chat");
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 验证用端点：读取已打开阅读器的「页 → 文本层 → span 几何」结构。不属于功能路径。
   */
  class DiagReaderEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const base = { openReaders: Sideline.readerprobe.count() };
        if (data.deep === true) {
          const pageNumber = parseInt(data.page, 10) || 1;
          return json(200, Object.assign(base, {
            deep: true,
            readers: await Sideline.readerprobe.deepSnapshotAll(data.itemID, pageNumber),
          }));
        }
        return json(200, Object.assign(base, { readers: Sideline.readerprobe.snapshotAll(data.itemID) }));
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 验证用端点：新的按页取文与覆盖状态（readertext.js）。只读，不改任何数据。
   * probe=sample 只取一页样本；probe=coverage 逐页统计（页数多时较慢）。
   */
  class DiagReaderTextEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const readers = Sideline.readertext.readers(data.itemID);
        const out = [];
        for (const reader of readers) {
          const entry = {
            itemID: reader.itemID,
            tabID: reader.tabID || null,
            pageCount: Sideline.readertext.pageCount(reader),
            resolve: !!Sideline.readertext.resolve(reader),
          };
          try {
            const labels = await Sideline.readertext.pageLabels(reader);
            entry.pageLabels = labels ? labels.slice(0, 10) : null;
          }
          catch (error) {
            entry.pageLabelsError = Sideline.util.message(error);
          }
          const probe = String(data.probe || "sample");
          if (probe === "coverage") {
            const coverage = await Sideline.readertext.coverage(reader, {
              maxPages: parseInt(data.maxPages, 10) || 0,
            });
            entry.coverage = {
              pageCount: coverage.pageCount,
              scanned: coverage.scanned,
              okPages: coverage.okPages.length,
              emptyPages: coverage.emptyPages,
              failedPages: coverage.failedPages,
              totalChars: coverage.totalChars,
              source: coverage.source,
              complete: coverage.complete,
            };
          }
          else {
            const pageIndex = Math.max(0, (parseInt(data.page, 10) || 1) - 1);
            const record = await Sideline.readertext.page(reader, pageIndex, { refresh: true });
            entry.page = {
              pageIndex: record.pageIndex,
              label: record.label,
              state: record.state,
              source: record.source,
              spans: record.spans.length,
              chars: record.chars,
              error: record.error,
              viewport: record.viewport || null,
              firstSpans: record.spans.slice(0, 3).map((span) => ({
                str: span.str.slice(0, 40),
                rect: span.rect,
              })),
            };
            if (data.locate) {
              entry.locate = await Sideline.readertext.locate(reader, {
                pageIndex,
                text: String(data.locate),
              });
            }
            if (data.jump === true && record.spans.length) {
              entry.jump = await Sideline.readertext.jump(reader, {
                pageIndex,
                rects: (await Sideline.readertext.rectsForRange(reader, pageIndex, 0, 0)).rects,
              });
            }
          }
          out.push(entry);
        }
        return json(200, {
          openReaders: readers.length,
          cache: Sideline.readertext.cacheStats(),
          readers: out,
          note: "只读探测：不写入任何 Zotero 数据。",
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 验证用端点：会话 JSON 附件的解析与读写。
   * probe=resolve（默认）只报告会用到哪个附件；probe=write 会真正写入插件自己的会话附件，
   * 用于在没有界面的情况下确认附件创建与更新链路可用。
   */
  class DiagSessionsEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        const probe = String(data.probe || "resolve");
        const info = await Sideline.store.resolveAttachment(item.id);
        if (probe === "resolve") {
          return json(200, {
            probe,
            itemID: item.id,
            attachment: info,
            stats: await Sideline.store.stats(),
            note: info.attachmentID
              ? "已有会话附件；写入会更新该文件并把附件标记为待上传。"
              : "还没有会话附件；第一次写入消息时会建立。",
          });
        }
        if (probe === "write") {
          const text = String(data.text || `Sideline 附件写入自检 ${Sideline.util.nowText()}`);
          await Sideline.store.touch(item.id, {
            title: Sideline.session.titleOf(item.id),
            messages: [{ role: "user", content: text, time: Sideline.util.nowText() }],
            sessionName: "自检会话",
          });
          const written = await Sideline.store.flush();
          return json(200, {
            probe,
            itemID: item.id,
            written,
            attachment: await Sideline.store.resolveAttachment(item.id),
            session: await Sideline.store.get(item.id),
            note: "本探测会写入插件自己的会话附件；不再需要时请用 POST /sideline/sessions/delete 清除。",
          });
        }
        return badRequest("probe 只能是 resolve 或 write");
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 结构化总结（R06）：取代 paper-review 的写入环节，但**不限于 `Z-文献暂存`**。
   * action=prompt   只返回提示词、约束与正文覆盖情况，供外部 agent 自己跑模型
   * action=preview  传入模型输出 answer，返回完整写入预览（不修改任何数据）
   * action=commit   传入 answer 与 confirm=true 才真正写入（子笔记 + 追加标签 + `总结:` 行）
   */
  class SummaryEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        const action = String(data.action || "prompt");
        const coverage = await Sideline.summary.coverageOf(item, {
          maxChars: parseInt(data.maxChars, 10) || 0,
          maxPages: parseInt(data.maxPages, 10) || Sideline.config.num("coverageMaxPages"),
        });
        const notes = await Sideline.summary.existingNotes(item);
        const base = {
          item: Sideline.context.summaryOf(item),
          coverage,
          existingNote: notes.length ? { id: notes[0].id, key: notes[0].key } : null,
          existingSummary: Sideline.summary.existingSummary(item),
          existingTags: (typeof item.getTags === "function" ? item.getTags() : [])
            .map((entry) => String((entry && entry.tag) || entry || "")).filter(Boolean),
          constraints: {
            minTags: Sideline.summary.MIN_TAGS,
            maxTags: Sideline.summary.MAX_TAGS,
            maxSummaryChars: Sideline.summary.MAX_SUMMARY_CHARS,
            genericTags: [...Sideline.summary.GENERIC_TAGS],
          },
        };
        if (action === "prompt") {
          return json(200, Object.assign(base, {
            prompt: Sideline.summary.SUMMARY_PROMPT,
            note: "把 prompt 与正文一起交给模型，answer 回传到 action=preview/commit；"
              + "commit 需要 confirm=true，且默认不覆盖已有的 Paper Review 子笔记与已有的「总结:」行。",
          }));
        }
        const answer = String(data.answer || "");
        if (!answer.trim()) return badRequest("action=preview/commit 需要传入 answer（模型的原始输出）");
        let review = null;
        try {
          review = Sideline.summary.parse(answer);
        }
        catch (error) {
          return json(422, Object.assign(base, { error: Sideline.util.message(error) }));
        }
        const planned = await Sideline.summary.plan({
          item,
          review,
          coverage,
          replaceNote: data.replaceNote === true,
          replaceSummary: data.replaceSummary === true,
        });
        if (action === "preview") {
          return json(200, Object.assign(base, {
            plan: Object.assign({}, planned, { note: Object.assign({}, planned.note, { html: "" }) }),
            notePreview: planned.note.markdown.slice(0, 4000),
            noteHtmlChars: planned.note.html.length,
          }));
        }
        if (action !== "commit") return badRequest("action 只能是 prompt、preview 或 commit");
        if (data.confirm !== true) {
          return json(200, Object.assign(base, {
            plan: Object.assign({}, planned, { note: Object.assign({}, planned.note, { html: "" }) }),
            error: "未写入：commit 需要 confirm=true（先看 preview 再确认）",
          }));
        }
        const result = await Sideline.summary.commit(item, review, {
          plan: planned,
          replaceNote: data.replaceNote === true,
          replaceSummary: data.replaceSummary === true,
        });
        return json(200, Object.assign(base, {
          result,
          plan: Object.assign({}, planned, { note: Object.assign({}, planned.note, { html: "" }) }),
        }));
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 子笔记检索（R08）：在当前条目的子笔记里找关键词命中，返回片段与材料参数。
   */
  class NoteSearchEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        const query = String(data.query || "").trim();
        const notes = await Sideline.notetext.list(item);
        if (!query) {
          return json(200, {
            itemID: item.id,
            notes: notes.map((note) => ({ id: note.id, key: note.key, title: note.title, chars: note.chars })),
            hint: "传入 query 做关键词检索",
          });
        }
        const result = await Sideline.notetext.find(item, query, {
          maxHits: parseInt(data.maxHits, 10) || 0,
          contextChars: parseInt(data.contextChars, 10) || 0,
        });
        return json(200, {
          itemID: item.id,
          query: result.query,
          notesScanned: result.notesScanned,
          total: result.total,
          truncated: result.truncated,
          hits: result.hits,
          materials: result.materials,
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 材料解析（R09）：把粘贴的条目链接 / DOI / arXiv / 路径 / 文本解析成材料，报告实际解析结果。
   */
  class InputResolveEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const value = String(data.value || "");
        if (!value.trim()) return badRequest("value 必填");
        const item = data.itemID ? itemFromID(data.itemID) : null;
        if (data.itemID && !item) return badRequest("itemID 无效或条目不存在");
        const result = await Sideline.inputs.resolve(value, {
          item,
          maxChars: parseInt(data.maxChars, 10) || Sideline.config.num("fileMaxChars"),
          includeFulltext: data.includeFulltext === true,
        });
        const fields = Object.assign({}, result.fields);
        const textChars = String(fields.text || "").length;
        if (data.includeText === false) delete fields.text;
        else if (typeof fields.text === "string") fields.text = fields.text.slice(0, 2000);
        return json(result.ok ? 200 : 422, {
          ok: result.ok,
          kind: result.kind,
          descriptor: result.descriptor,
          reason: result.reason || "",
          fields,
          textChars,
          note: "解析结果是预览；真正加入上下文由界面或调用方决定。",
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 会话检索（R13）：在当前条目的多条会话里按关键词找消息。
   */
  class SessionSearchEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        const result = await Sideline.history.find(item.id, String(data.query || ""), {
          maxHits: parseInt(data.maxHits, 10) || Sideline.config.num("historySearchMaxHits"),
          contextChars: parseInt(data.contextChars, 10) || 0,
        });
        return json(200, {
          itemID: item.id,
          query: result.query,
          sessionsScanned: result.sessionsScanned,
          total: result.total,
          truncated: result.truncated,
          hits: result.hits,
          sessions: result.sessions,
          note: "hits 里带 sessionId 与消息序号，可据此定位到具体会话。",
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 会话导出（R13）：默认只返回内容；给出 path 时才写文件（显式动作）。
   */
  class SessionExportEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        const built = await Sideline.history.build(item.id, {
          format: data.format,
          sessionId: data.sessionId,
        });
        if (!built.sessionCount) return badRequest("该条目还没有会话可导出");
        const response = {
          itemID: item.id,
          format: built.format,
          filename: built.filename,
          sessionCount: built.sessionCount,
          messageCount: built.messageCount,
          chars: built.chars,
        };
        if (data.path) {
          const saved = await Sideline.history.save(String(data.path), built.text);
          response.saved = saved.path;
        }
        if (data.includeText !== false && !data.path) {
          response.text = built.text.slice(0, parseInt(data.maxChars, 10) || 20000);
          response.textTruncated = response.text.length < built.chars;
        }
        return json(200, response);
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  /**
   * 整理为子笔记（R16）：preview 只返回预览，commit 才写入（需要 confirm=true）。
   */
  class ExcerptEndpoint {
    supportedMethods = ["POST"];

    supportedDataTypes = ["application/json"];

    permitBookmarklet = false;

    async init(request) {
      try {
        const data = request.data || {};
        const item = itemFromID(data.itemID);
        if (!item) return badRequest("itemID 无效或条目不存在");
        const messages = Array.isArray(data.messages) && data.messages.length
          ? data.messages.map((entry) => ({
            role: entry && entry.role === "user" ? "user" : "assistant",
            content: String((entry && entry.content) || ""),
            display: String((entry && entry.display) || ""),
            model: String((entry && entry.model) || ""),
            time: String((entry && entry.time) || ""),
            citations: Array.isArray(entry && entry.citations) ? entry.citations : [],
          }))
          : [
            { role: "user", content: String(data.question || ""), display: String(data.question || "") },
            { role: "assistant", content: String(data.answer || ""), model: String(data.model || "") },
          ].filter((entry) => entry.content);
        if (!messages.length) return badRequest("需要提供 messages，或 question/answer");
        const attachment = await Sideline.context.resolveAttachment(item);
        let planned = null;
        try {
          planned = Sideline.excerpt.plan({
            item,
            messages,
            title: data.title ? String(data.title) : "",
            itemKey: item.key,
            attachmentKey: attachment ? attachment.key : "",
            itemTitle: String(item.getField("title") || ""),
          });
        }
        catch (error) {
          return json(422, { error: Sideline.util.message(error) });
        }
        const action = String(data.action || "preview");
        if (action === "preview") {
          return json(200, {
            item: Sideline.context.summaryOf(item),
            plan: {
              title: planned.title,
              chars: planned.chars,
              blockCount: planned.blockCount,
              sources: planned.sources,
            },
            markdown: planned.markdown.slice(0, 4000),
            noteHtmlChars: planned.html.length,
          });
        }
        if (action !== "commit") return badRequest("action 只能是 preview 或 commit");
        if (data.confirm !== true) {
          return json(200, {
            error: "未写入：commit 需要 confirm=true（先看 preview 再确认）",
            plan: { title: planned.title, chars: planned.chars, blockCount: planned.blockCount },
          });
        }
        const result = await Sideline.excerpt.commit({ item, plan: planned });
        return json(200, {
          item: Sideline.context.summaryOf(item),
          result,
          note: "笔记带条目与 PDF 页码深链。",
        });
      }
      catch (error) {
        return fail(error);
      }
    }
  }

  const PATHS = {
    "/sideline/status": StatusEndpoint,
    "/sideline/selftest": SelfTestEndpoint,
    "/sideline/context": ContextEndpoint,
    "/sideline/chat": ChatEndpoint,
    "/sideline/note": NoteEndpoint,
    "/sideline/sessions": SessionsEndpoint,
    "/sideline/sessions/delete": SessionDeleteEndpoint,
    "/sideline/sessions/search": SessionSearchEndpoint,
    "/sideline/sessions/export": SessionExportEndpoint,
    "/sideline/functions": FunctionsEndpoint,
    "/sideline/provider": ProviderEndpoint,
    "/sideline/summary": SummaryEndpoint,
    "/sideline/notes/search": NoteSearchEndpoint,
    "/sideline/inputs/resolve": InputResolveEndpoint,
    "/sideline/excerpt": ExcerptEndpoint,
    "/sideline/diag/codex": DiagCodexEndpoint,
    "/sideline/diag/reader": DiagReaderEndpoint,
    "/sideline/diag/readertext": DiagReaderTextEndpoint,
    "/sideline/diag/sessions": DiagSessionsEndpoint,
  };

  function register() {
    for (const [path, Endpoint] of Object.entries(PATHS)) {
      Zotero.Server.Endpoints[path] = Endpoint;
    }
    Sideline.util.log(`已注册 ${Object.keys(PATHS).length} 个本机端点`);
  }

  function unregister() {
    for (const path of Object.keys(PATHS)) {
      delete Zotero.Server.Endpoints[path];
    }
    Sideline.util.log("已注销本机端点");
  }

  return { register, unregister, paths: Object.keys(PATHS) };
})();
