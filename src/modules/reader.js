/*
 * Zotero Sideline：PDF 阅读器划词面板。
 * 功能：选中 PDF 文字后，在阅读器弹窗里给出「引用卡片 + 快捷动作」：
 *       引用卡片显示选区原文、纸面页码与所在附件，并可点击跳回原文（R03）；
 *       「加入对话」把选区作为材料加进阅读器侧栏，**不自动发送**，由用户在侧栏决定怎么问；
 *       仍可就选中文字就地问答（快速路径），结果可复制、存为子笔记或写回批注。
 * 说明：监听 Zotero.Reader 的 renderTextSelectionPopup 事件；就地问答只带元数据 + 选中文字，
 *       不加载全文，避免阅读时的大请求。
 * 对外接口：register/unregister（划词事件）。
 */

Sideline.reader = (function () {
  const EVENT = "renderTextSelectionPopup";

  // 划词弹窗的样式：与阅读器侧栏一致的现代聊天风。
  // 配色取自 Zotero 阅读器自己的主题变量（同一份文档的 :root，见 reader.css），
  // 因此深浅色跟随「设置 → 外观」，不需要自己写深浅色分支。
  // 层次靠「面」：引用卡片、回答卡片各自浮起；按钮平时就有可见浅底 + 1px 边框，
  // 并按三档区分——主操作（加入对话）用强调色浅底 + 强调色描边，快捷功能（文本翻译）
  // 用中性浅底，工具行（存为批注/存为笔记/复制回答）用更浅的面 + 同款描边。
  const CSS = `
.sideline-reader{
  --slr-text:var(--fill-primary,#1f2328); --slr-muted:var(--fill-secondary,#6b7280);
  /* 小字对比度：与侧栏同一算法（--fill-primary 按 64% 混合 ≈4.5:1），旧 Gecko 回退上一行 */
  --slr-muted:color-mix(in srgb, var(--fill-primary,#1f2328) 64%, transparent);
  --slr-border:var(--color-border50,rgba(0,0,0,.08)); --slr-soft:var(--fill-quinary,rgba(0,0,0,.05));
  --slr-surface:var(--material-background,#fff);
  --slr-accent:var(--accent-blue,#4072e5); --slr-danger:var(--accent-red,#db2c3a);
  /* 按钮与引用卡片的三档「面」：只由上面这些已声明的 --slr-* 主题变量混合得到，
     没有引入任何写死颜色，深浅色仍完全交给 Zotero；
     先写静态回退再写 color-mix，与上面 --slr-muted 同一写法（Zotero 10 的 Gecko 140 支持 color-mix）。 */
  --slr-btn:var(--slr-soft);
  --slr-btn:color-mix(in srgb, var(--slr-text) 8%, var(--slr-surface));
  --slr-btn-hover:var(--slr-soft);
  --slr-btn-hover:color-mix(in srgb, var(--slr-text) 17%, var(--slr-surface));
  --slr-accent-soft:var(--slr-soft);
  --slr-accent-soft:color-mix(in srgb, var(--slr-accent) 12%, var(--slr-surface));
  --slr-accent-soft-hover:var(--slr-soft);
  --slr-accent-soft-hover:color-mix(in srgb, var(--slr-accent) 22%, var(--slr-surface));
  margin-top:10px; padding-top:10px; border-top:1px solid var(--slr-border);
  font-family:var(--font-family,inherit); font-size:var(--font-size,13px);
  line-height:1.65; max-width:460px; color:var(--slr-text);
}
/* 引用卡片：浅强调色底 + 3px 强调色左边框，和下面输入框、回答区的纯面底色明显分档 */
.sideline-reader-card{
  border:1px solid var(--slr-border); border-inline-start:3px solid var(--slr-accent);
  border-radius:12px; background:var(--slr-accent-soft); padding:8px 10px; margin:0 0 8px;
}
.sideline-reader-quote{max-height:76px; overflow:auto; font-size:12.5px; scrollbar-width:thin; scrollbar-color:var(--color-scrollbar,rgba(128,128,128,.45)) transparent}
.sideline-reader-meta{margin-top:4px; font-size:11.5px; color:var(--slr-muted); display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.sideline-reader-link{color:var(--slr-accent); cursor:pointer; background:none; border:none; padding:0; font:inherit; text-decoration:underline dotted}
.sideline-reader-link:hover{text-decoration:underline}
/* 操作行：快捷功能与「加入对话」共用一行，gap 取 6px；窄到放不下时整颗按钮换行，
   按钮是定高 + 横向内边距，不压缩按钮内文字 */
.sideline-reader-row{display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px}
/* 按钮：平时就有可见浅底 + 1px 边框 + 圆角（不再是只有 hover 才浮出底色的幽灵态） */
.sideline-reader button{
  font:inherit; height:28px; padding:0 12px; color:inherit; cursor:pointer;
  background:var(--slr-btn); border:1px solid var(--slr-border); border-radius:999px;
  transition:background .12s ease, border-color .12s ease;
}
/* hover：底色再深一档，描边转强调色 */
.sideline-reader button:hover{background:var(--slr-btn-hover); border-color:var(--slr-accent)}
.sideline-reader button:disabled{opacity:.5; cursor:default}
/* 主操作「加入对话」：强调色浅底 + 强调色描边，与中性按钮一眼分得开（比实心更耐读） */
.sideline-reader button.sideline-reader-primary{
  background:var(--slr-accent-soft); border-color:var(--slr-accent);
}
.sideline-reader button.sideline-reader-primary:hover{background:var(--slr-accent-soft-hover)}
/* 工具行（存为批注/存为笔记/复制回答）：中性面 + 同款描边，比快捷功能再浅一档 */
.sideline-reader-tools button{background:var(--slr-surface)}
.sideline-reader-tools button:hover{background:var(--slr-btn-hover)}
/* 提问输入区：多行文本区，flex-basis 100% 让它排在按钮行（快捷功能 + 加入对话）之后的单独一行 */
.sideline-reader textarea{
  flex:1 1 100%; width:100%; min-height:64px; padding:8px 10px; font:inherit; color:inherit;
  box-sizing:border-box; resize:none; line-height:1.5;
  background:var(--slr-surface); border:1px solid var(--slr-border); border-radius:10px;
  transition:border-color .12s ease, box-shadow .12s ease;
}
.sideline-reader textarea:focus{
  outline:none; border-color:var(--slr-accent); box-shadow:0 0 0 3px var(--slr-soft);
}
.sideline-reader-answer{
  white-space:normal; overflow-wrap:anywhere; max-height:260px; overflow:auto; margin-top:8px;
  background:var(--slr-surface); border:1px solid var(--slr-border);
  border-radius:12px; padding:10px 12px;
  scrollbar-width:thin; scrollbar-color:var(--color-scrollbar,rgba(128,128,128,.45)) transparent;
}
.sideline-reader-status{font-size:11.5px; color:var(--slr-muted)}
.sideline-reader-error{color:var(--slr-danger)}
/* 弹窗回答同样是渲染后的 HTML：内元素与侧栏保持同一套排版语言 */
.sideline-reader-answer > *:first-child{margin-top:0}
.sideline-reader-answer > *:last-child{margin-bottom:0}
.sideline-reader-answer p{margin:0 0 .6em}
.sideline-reader-answer h1,.sideline-reader-answer h2,.sideline-reader-answer h3,.sideline-reader-answer h4{
  margin:.8em 0 .4em; line-height:1.35;
}
.sideline-reader-answer ul,.sideline-reader-answer ol{margin:.3em 0 .6em; padding-inline-start:1.2em}
.sideline-reader-answer li{margin:2px 0}
.sideline-reader-answer code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em;
  background:var(--slr-soft); border-radius:5px; padding:1px 5px;
}
.sideline-reader-answer pre{background:var(--slr-soft); border-radius:10px; padding:8px 10px; overflow:auto; white-space:pre}
.sideline-reader-answer pre code{background:none; padding:0}
.sideline-reader-answer blockquote{
  margin:.5em 0; padding-inline-start:10px; border-inline-start:2px solid var(--slr-border); color:var(--slr-muted);
}
.sideline-reader-answer a{color:var(--slr-accent)}
.sideline-reader-answer table{width:100%; border-collapse:collapse; font-size:.95em}
.sideline-reader-answer th,.sideline-reader-answer td{border:1px solid var(--slr-border); padding:4px 6px}
.sideline-reader-answer th{background:var(--slr-soft)}
.sideline-reader-answer .sl-math-display{overflow-x:auto;overflow-y:hidden;padding:.25em 0}
.sideline-reader-answer .sl-math-display>.katex-display{margin:.4em 0}
/* 同上：.sideline-reader-row 是 display:flex，必须补这条 hidden 才会真的隐藏 */
.sideline-reader [hidden]{display:none !important}
/* 键盘可达性：弹窗里的按钮也要有可见焦点环 */
.sideline-reader button:focus-visible,
.sideline-reader textarea:focus-visible{
  outline:none; box-shadow:0 0 0 2px var(--slr-soft), 0 0 0 1px var(--slr-accent);
}
`;

  function register(pluginID) {
    const handler = (event) => {
      try {
        renderPopup(event);
      }
      catch (error) {
        Sideline.util.error(error);
      }
    };
    Zotero.Reader.registerEventListener(EVENT, handler, pluginID);
    return handler;
  }

  function unregister(handler) {
    try {
      Zotero.Reader.unregisterEventListener(EVENT, handler);
    }
    catch (error) {
      Sideline.util.error(error);
    }
  }

  function itemForReader(reader) {
    try {
      return reader && reader.itemID ? Zotero.Items.get(reader.itemID) : null;
    }
    catch (error) {
      Sideline.util.error(error);
      return null;
    }
  }

  /**
   * 选区锚点：页码（0 基与纸面）、矩形与附件，供侧栏材料与「跳回原文」共用。
   * 阅读器给的 annotation.position 已经是 Zotero 批注用的页面空间坐标，可直接复用。
   */
  function anchorOf(annotation, item) {
    const position = annotation && annotation.position;
    const pageIndex = position && Number.isFinite(position.pageIndex) ? position.pageIndex : null;
    return {
      pageIndex,
      pageLabel: annotation && annotation.pageLabel ? String(annotation.pageLabel) : "",
      rects: position && Array.isArray(position.rects) ? position.rects : null,
      attachmentID: item && item.id ? item.id : 0,
    };
  }

  /** 引用卡片：原文 + 页码 + 附件，可点击跳回 */
  function citationCard(doc, reader, anchor, selection) {
    const card = Sideline.util.element(doc, "div", { className: "sideline-reader-card" });
    card.appendChild(Sideline.util.element(doc, "div", {
      className: "sideline-reader-quote",
      text: selection.length > 180 ? `${selection.slice(0, 180)}…` : selection,
    }));
    const meta = Sideline.util.element(doc, "div", { className: "sideline-reader-meta" });
    meta.textContent = anchor.pageLabel ? `第 ${anchor.pageLabel} 页` : "页码未知";
    if (anchor.pageIndex !== null) {
      const jump = Sideline.util.element(doc, "span", {
        className: "sideline-reader-link",
        text: "　跳回选区",
      });
      jump.addEventListener("click", () => {
        void Sideline.readertext.jump(reader, {
          pageIndex: anchor.pageIndex,
          rects: anchor.rects,
        });
      });
      meta.appendChild(jump);
    }
    card.appendChild(meta);
    return card;
  }

  function renderPopup(event) {
    const { doc, reader, params, append } = event;
    const annotation = (params && params.annotation) || null;
    const selection = annotation && annotation.text ? String(annotation.text) : "";
    if (!selection.trim()) return;

    Sideline.util.ensureMathStyles(doc);
    const item = itemForReader(reader);
    const container = Sideline.util.element(doc, "div", { className: "sideline-reader" });
    const style = Sideline.util.element(doc, "style");
    style.textContent = CSS;
    container.appendChild(style);

    const anchor = anchorOf(annotation, item);
    container.appendChild(citationCard(doc, reader, anchor, selection));

    // 快捷功能与「加入对话」共用下面这一个 .sideline-reader-row：
    // DOM 顺序为「快捷功能 → 加入对话 → 输入区」，加入对话的 appendChild 在快捷功能之后。
    const row = Sideline.util.element(doc, "div", { className: "sideline-reader-row" });
    container.appendChild(row);

    // 加入对话：只把选区加进侧栏材料清单，不发送（R03 的显式要求）
    const addButton = Sideline.util.element(doc, "button", {
      text: "加入对话",
      className: "sideline-reader-primary",
    });
    Sideline.util.onActivate(addButton, () => {
      try {
        const material = Sideline.readerside.addSelection(reader, {
          text: selection,
          pageIndex: anchor.pageIndex,
          pageLabel: anchor.pageLabel,
          rects: anchor.rects,
          attachmentID: anchor.attachmentID,
        });
        setStatus(material ? "已加入侧栏材料（尚未发送）" : "无法打开侧栏面板", !material);
      }
      catch (error) {
        setStatus(`加入失败：${Sideline.util.message(error)}`, true);
      }
    });

    const status = Sideline.util.element(doc, "span", { className: "sideline-reader-status" });
    const answer = Sideline.util.element(doc, "div", {
      className: "sideline-reader-answer",
      attrs: { hidden: "hidden" },
    });
    // 工具行（存为批注/存为笔记/复制回答）：留在回答下方单独一行，不并进上面那行按钮
    const tools = Sideline.util.element(doc, "div", {
      className: "sideline-reader-row sideline-reader-tools",
    });
    tools.hidden = true;

    let busy = false;
    let currentAnswer = "";
    let currentQuestion = "";
    let currentModel = "";

    function setStatus(text, isError) {
      status.textContent = text;
      status.classList.toggle("sideline-reader-error", !!isError);
    }

    async function ask(question) {
      if (busy) return;
      if (!question || !question.trim()) return;
      const requestCheck = Sideline.providers.checkRequest();
      if (!requestCheck.ok) {
        setStatus(requestCheck.reason, true);
        return;
      }
      busy = true;
      currentQuestion = question;
      currentAnswer = "";
      answer.hidden = false;
      answer.textContent = "…";
      tools.hidden = true;
      setStatus("生成中…", false);
      const started = Date.now();
      let lastRenderAt = 0;
      try {
        const context = await Sideline.context.build(item, { mode: "metadata", selection });
        const config = Sideline.config.read();
        const messages = [
          {
            role: "system",
            content: `${Sideline.prompts.systemFor(config)}\n\n以下是条目上下文：\n\n${context.text}`,
          },
          { role: "user", content: question },
        ];
        if (Sideline.providers.current(config) === "agent") {
          await Sideline.session.restore(item.id);
          messages.splice(1, 0, ...Sideline.session.list(item.id).map((entry) => ({ role: entry.role, content: entry.content })));
          Sideline.session.append(item.id, "user", question);
        }
        const result = await Sideline.providers.chat({
          ownerID: item.id,
          onWarning: (warning) => setStatus(warning, true),
          messages,
          config,
          onDelta: (piece, whole) => {
            // 流式期间也按 Markdown 渲染（限流），避免看到一片源码
            const now = Date.now();
            if (now - lastRenderAt < 120) return;
            lastRenderAt = now;
            answer.innerHTML = Sideline.util.markdownToHtml(whole);
            answer.scrollTop = answer.scrollHeight;
          },
        });
        currentAnswer = result.content;
        if (result.provider === "agent") Sideline.session.append(item.id, "assistant", result.content, { model: result.model, provider: result.provider, usage: result.usage });
        currentModel = result.model;
        answer.innerHTML = Sideline.util.markdownToHtml(currentAnswer);
        tools.hidden = false;
        const usage = result.usage || {};
        const tokens = usage.total_tokens
          || ((usage.input_tokens || 0) + (usage.output_tokens || 0))
          || 0;
        setStatus(`${Sideline.providers.label(result.provider)} · ${result.model}`
          + `${tokens ? ` · ${tokens} tokens` : ""}`
          + ` · ${((Date.now() - started) / 1000).toFixed(1)}s`, false);
        if (result.sessionWarning) setStatus(result.sessionWarning, true);
      }
      catch (error) {
        answer.hidden = true;
        setStatus(`失败：${Sideline.util.message(error)}`, true);
      }
      finally {
        busy = false;
      }
    }

    // 快捷功能：只取功能注册表里带 popup 标记的功能（当前只有「文本翻译」）。
    // 侧栏下拉栏仍然列出全部功能，selectionFunctions() 的语义不变。
    const quickFunctions = Sideline.functions.popupFunctions();
    if (quickFunctions.length) {
      for (const entry of quickFunctions) {
        const button = Sideline.util.element(doc, "button", { text: entry.name });
        button.setAttribute("title", entry.customized ? "已在设置中改写过提示词" : "提示词可在设置 → Sideline 中改写");
        Sideline.util.onActivate(button, () => {
          void ask(entry.prompt);
        });
        row.appendChild(button);
      }
    }
    else {
      // 兜底：标记缺失或功能表被清空时，退回设置里的弹窗模板按钮，避免弹窗一个按钮都没有
      for (const template of Sideline.prompts.subset(Sideline.config.str("readerTemplates"))) {
        const templateButton = Sideline.util.element(doc, "button", { text: template.name });
        Sideline.util.onActivate(templateButton, () => {
          void ask(template.text);
        });
        row.appendChild(templateButton);
      }
    }

    // 顺序：快捷功能在前，「加入对话」在后（同一个 .sideline-reader-row，窄了靠 flex-wrap 换行）
    row.appendChild(addButton);

    // 输入区：多行文本区，Enter 发送、Shift+Enter 换行（不再有「提问」按钮）
    const input = Sideline.util.element(doc, "textarea", {
      attrs: { rows: "3", placeholder: "就选中文字提问…（Enter 发送，Shift+Enter 换行）" },
    });
    row.appendChild(input);

    input.addEventListener("keydown", (event2) => {
      if (event2.key === "Enter" && !event2.shiftKey) {
        event2.preventDefault();
        void ask(input.value.trim());
      }
    });

    // 写回批注：高亮选区原文，评论为回答。坐标来自阅读器给的选区对象，
    // 缺失时按钮禁用并说明原因，退回「存为笔记」。
    const writable = Sideline.annotations.canWrite(annotation);
    const annotateButton = Sideline.util.element(doc, "button", { text: "存为批注" });
    if (!writable.ok) {
      annotateButton.disabled = true;
      annotateButton.setAttribute("title", writable.reason);
    }
    Sideline.util.onActivate(annotateButton, () => {
      void (async () => {
        if (!Sideline.config.bool("readerAnnotationWrite")) {
          setStatus("已在设置中关闭批注写回", true);
          return;
        }
        if (!currentAnswer) {
          setStatus("请先生成回答，再写回批注", true);
          return;
        }
        try {
          const created = await Sideline.annotations.saveHighlightComment({
            attachment: item,
            annotation,
            comment: currentAnswer,
            color: Sideline.config.str("readerAnnotationColor") || undefined,
          });
          setStatus(`已写入批注 ${created && created.key ? created.key : ""}`, false);
        }
        catch (error) {
          setStatus(`写入批注失败：${Sideline.util.message(error)}`, true);
        }
      })();
    });
    tools.appendChild(annotateButton);

    const saveButton = Sideline.util.element(doc, "button", { text: "存为笔记" });
    Sideline.util.onActivate(saveButton, () => {
      void (async () => {
        try {
          const note = await Sideline.notes.saveAnswer({
            item,
            question: `${currentQuestion}\n\n（选中文字）${selection}`,
            answer: currentAnswer,
            model: currentModel,
            source: "PDF 阅读器划词",
          });
          setStatus(`已保存子笔记 ${note.key}`, false);
        }
        catch (error) {
          setStatus(`保存失败：${Sideline.util.message(error)}`, true);
        }
      })();
    });
    tools.appendChild(saveButton);

    const copyButton = Sideline.util.element(doc, "button", { text: "复制回答" });
    Sideline.util.onActivate(copyButton, () => {
      setStatus(Sideline.util.copyText(currentAnswer) ? "已复制" : "复制失败", false);
    });
    tools.appendChild(copyButton);

    container.appendChild(status);
    container.appendChild(answer);
    container.appendChild(tools);
    append(container);
    // 弹窗构建完成、挂进文档之后再聚焦一次，让用户可以直接打字；
    // 不在此期间抢焦点，避免打断用户仍在 PDF 上继续划词。
    try {
      input.focus();
    }
    catch (error) {
      Sideline.util.error(error);
    }
  }

  return { register, unregister };
})();
