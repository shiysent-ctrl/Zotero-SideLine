/*
 * Sideline 侧栏消息视图。
 * 输入：readerside 持有的阅读器状态/消息与状态、页码、菜单回调；输出：气泡 DOM、正文选择/复制、引用定位和累计用量。
 * 依赖：util、citations、readertext、session、highlights，以及所属文档的 Selection/Range；不创建会话或请求模型。
 * HTML 缓存仍由阅读器状态持有并由 readerside 在卸载时释放；不改变节点重建与绑定行为。
 */
Sideline.readermessages = (function () {
  const RENDER_CACHE_LIMIT = 60;
  const RENDER_CACHE_CHARS = 2000000;
  function create({ setStatus, currentPageIndex, openAnswerMenu, openMenu }) {
    function scrollToEnd(state) {
      const el = state.els && state.els.messagesEl;
      if (el) el.scrollTop = el.scrollHeight;
    }

    /** 只滚动插件自己的消息容器；不重绘或滚动 Zotero 外层界面。 */
    function scrollToMessage(state, messageId) {
      const el = state.els && state.els.messagesEl;
      if (!el || !messageId) return false;
      // 隐藏消息不生成节点，不能用可见气泡序号替代存档消息的 ID。
      const target = Array.from(el.children).find((node) => node.getAttribute("data-message-id") === messageId);
      if (!target) return false;
      const top = el.getBoundingClientRect().top + (el.clientTop || 0);
      el.scrollTop = Math.max(0, el.scrollTop + target.getBoundingClientRect().top - top - 8);
      return true;
    }

    /** 只缓存已入会话的正文 HTML；节点、按钮和页码事件仍按当前阅读器重新创建。 */
    function answerHtml(state, message) {
      const source = message.content || "", map = Sideline.citations.mapFromCitations(message.citations);
      const mapKey = JSON.stringify(map || null), cache = state.renderCache;
      const prior = message.id && cache.get(message.id);
      if (prior && prior.source === source && prior.mapKey === mapKey && prior.renderer === Sideline.citations.render) {
        cache.delete(message.id); cache.set(message.id, prior);
        return prior.html;
      }
      const html = Sideline.citations.render(source, map);
      if (message.id && html.length <= RENDER_CACHE_CHARS) {
        if (prior) state.renderCacheChars -= prior.html.length;
        cache.delete(message.id); cache.set(message.id, { source, mapKey, html, renderer: Sideline.citations.render });
        state.renderCacheChars += html.length;
        while (cache.size > RENDER_CACHE_LIMIT || state.renderCacheChars > RENDER_CACHE_CHARS) {
          const id = cache.keys().next().value;
          state.renderCacheChars -= cache.get(id).html.length; cache.delete(id);
        }
      }
      else if (prior) { state.renderCacheChars -= prior.html.length; cache.delete(message.id); }
      return html;
    }

    function bubble(state, message) {
      const wrapper = Sideline.util.element(state.doc, "div", {
        className: `sideline-msg sideline-msg-${message.role === "user" ? "user" : "assistant"}`,
        attrs: { "data-message-id": message.id || "" },
      });
      wrapper.appendChild(Sideline.util.element(state.doc, "div", {
        className: "sideline-role",
        text: message.role === "user" ? "我" : `Sideline${message.model ? `（${message.model}）` : ""}`,
      }));
      const body = Sideline.util.element(state.doc, "div", { className: "sideline-text" });
      if (message.role === "assistant") {
        if (message.functionId === "highlight") {
          body.textContent = Sideline.highlights.receipt(message.highlightBatch);
          body.style.whiteSpace = "pre-wrap";
        } else {
          // 回答里的页码引用变成可点击锚点（R04）：优先用消息里存下的引用，重启后在无 PDF 时也能渲染
          body.innerHTML = answerHtml(state, message);
          attachPageRefs(state, body, message);
          attachQuoteLocators(state, body, message);
        }
      }
      else body.textContent = message.display || message.content || "";
      attachTextMenu(state, body);
      wrapper.appendChild(body);
      for (const citation of message.citations || []) {
        // 页码引用已经在正文里变成锚点，不再重复显示成卡片
        if (!citation.label || citation.kind === "pageref") continue;
        wrapper.appendChild(citationCard(state, citation));
      }
      const tools = Sideline.util.element(state.doc, "div", { className: "sideline-tools" });
      wrapper.appendChild(tools);
      return { wrapper, body, tools };
    }

    /** 选区只接受当前正文内的范围；PDF、其他气泡和输入框的选区不进入复制。 */
    function selectedText(state, body) {
      try {
        const selection = state.doc.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return "";
        const range = selection.getRangeAt(0);
        return body.contains(range.startContainer) && body.contains(range.endContainer)
          ? selection.toString() : "";
      } catch (error) { return ""; }
    }

    function selectBody(state, body) {
      try {
        const selection = state.doc.getSelection(), range = state.doc.createRange();
        range.selectNodeContents(body);
        selection.removeAllRanges();
        selection.addRange(range);
        setStatus(state, "已全选当前气泡正文", false);
      } catch (error) { setStatus(state, `全选失败：${Sideline.util.message(error)}`, true); }
    }

    function attachTextMenu(state, body) {
      // Zotero FocusManager 在 window 的冒泡 pointerdown 上取消普通元素的默认行为。
      // 在自己的正文内截断冒泡，但不 preventDefault，浏览器才能执行原生拖选。
      body.addEventListener("pointerdown", (event) => event.stopPropagation());
      body.addEventListener("contextmenu", (event) => {
        event.preventDefault(); event.stopPropagation();
        // 打开菜单就保存文本；点击菜单按钮可能改变焦点或清空选区。
        const text = selectedText(state, body) || body.innerText || body.textContent || "";
        const point = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
          && (event.clientX || event.clientY)
          ? { getBoundingClientRect: () => ({ left: event.clientX, top: event.clientY, bottom: event.clientY }) }
          : body;
        openMenu(state, [
          { label: "全选", run: () => selectBody(state, body) },
          { label: "复制", disabled: !text, run: () => {
            const copied = Sideline.util.copyText(text);
            setStatus(state, copied ? "已复制" : "复制失败", !copied);
          } },
        ], { placement: "anchor", anchor: point });
      });
    }

    /** 给回答里的页码锚点绑定「跳回该页」 */
    function attachPageRefs(state, body, message) {
      let nodes = [];
      try {
        nodes = Array.from(body.querySelectorAll("[data-sideline-page]"));
      }
      catch (error) {
        nodes = [];
      }
      for (const node of nodes) {
        const pageIndex = Number(node.getAttribute("data-sideline-page"));
        if (!Number.isFinite(pageIndex) || pageIndex < 0) continue;
        const jump = () => void locatePageReference(state, node, pageIndex);
        node.addEventListener("click", (event) => { event.stopPropagation(); jump(); });
        node.addEventListener("keydown", (event) => {
          if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); jump(); }
        });

      }
      if (nodes.length && !message.pageRefCount) {
        message.pageRefCount = nodes.length;
      }
    }

    /** 页码引用优先匹配原文锚点；转述或旧回答无法匹配时，只执行明确的页级导航。 */
    async function locatePageReference(state, node, pageIndex) {
      setStatus(state, "正在定位原文…", false);
      try {
        let text = node.getAttribute("data-sideline-quote") || "";
        if (!text && typeof node.closest === "function") {
          const paragraph = node.closest("p, li, blockquote");
          if (paragraph) text = String(paragraph.textContent || "").replace(Sideline.citations.PAGE_PATTERN, "").trim();
        }
        const located = text.length >= 8 ? await Sideline.readertext.locate(state.reader,
          { pageIndex, text, exact: true }) : { found: false };
        const range = located.found ? await Sideline.readertext.rectsForRange(state.reader, pageIndex, located.from, located.to) : null;
        const result = await Sideline.readertext.jump(state.reader, { pageIndex, rects: range && range.rects });
        const label = await Sideline.readertext.labelOf(state.reader, pageIndex);
        setStatus(state, !result.ok ? `跳转失败：${result.reason}`
          : located.found && result.flashed ? `已定位第 ${label} 页原文，已短暂高亮`
          : located.found ? `已匹配第 ${label} 页原文；${result.reason || "未能显示高亮"}`
          : `已跳到第 ${label} 页；未找到匹配原文，仅定位到页码`, !result.ok);
      } catch (error) { setStatus(state, `定位失败：${Sideline.util.message(error)}`, true); }
    }

    /** 回答里的 > 引用块可点击定位原文（R04：可定位到段落） */
    function attachQuoteLocators(state, body, message) {
      const quotes = Sideline.citations.quotes(message.content || "");
      if (!quotes.length) return;
      let nodes = [];
      try {
        nodes = Array.from(body.querySelectorAll("blockquote"));
      }
      catch (error) {
        nodes = [];
      }
      nodes.forEach((node, index) => {
        const quote = quotes[index];
        if (!quote) return;
        node.setAttribute("title", "点击定位这段原文");
        node.classList.add("sideline-quote-link");
        node.addEventListener("click", () => {
          void locateQuote(state, quote);
        });
      });
    }

    /** 在引用块标注的页码（或当前页起逐页）里反查这段原文并跳过去 */
    async function locateQuote(state, quote) {
      const labels = await Sideline.readertext.pageLabels(state.reader);
      const wanted = quote.labels
        .map((label) => Sideline.citations.labelToIndex(label, labels))
        .filter((index) => index !== null && index >= 0);
      const total = Sideline.readertext.pageCount(state.reader);
      const order = wanted.length ? wanted : [currentPageIndex(state)];
      if (!wanted.length) {
        for (let index = 0; index < total; index++) {
          if (!order.includes(index)) order.push(index);
        }
      }
      setStatus(state, "正在定位引用原文…", false);
      for (const pageIndex of order) {
        // eslint-disable-next-line no-await-in-loop
        const located = await Sideline.readertext.locate(state.reader, { pageIndex, text: quote.text, exact: true });
        if (located.found) {
          // eslint-disable-next-line no-await-in-loop
          const range = await Sideline.readertext.rectsForRange(state.reader, pageIndex, located.from, located.to);
          // eslint-disable-next-line no-await-in-loop
          const jumped = await Sideline.readertext.jump(state.reader, { pageIndex, rects: range.rects });
          setStatus(state, jumped.ok
            ? `已定位到第 ${(await Sideline.readertext.labelOf(state.reader, pageIndex))} 页原文${jumped.flashed ? "，已短暂高亮" : `；${jumped.reason || "未能显示高亮"}`}`
            : `定位到第 ${pageIndex + 1} 页，但跳转失败：${jumped.reason}`, !jumped.ok);
          return;
        }
      }
      setStatus(state, "在正文里没有找到这段引用原文（可能是模型转述或该页未渲染）", true);
    }

    function citationCard(state, citation) {
      const card = Sideline.util.element(state.doc, "div", { className: "sideline-cite" });
      card.appendChild(Sideline.util.element(state.doc, "div", {
        text: citation.label || "选区原文",
      }));
      if (Number.isFinite(citation.pageIndex) && citation.pageIndex >= 0) {
        const jump = Sideline.util.element(state.doc, "span", {
          className: "sideline-material-link",
          text: `跳到第 ${citation.pageLabel || (citation.pageIndex + 1)} 页`,
        });
        jump.addEventListener("click", () => {
          void Sideline.readertext.jump(state.reader, {
            pageIndex: citation.pageIndex,
            rects: citation.rects || null,
          });
        });
        card.appendChild(jump);
      }
      return card;
    }

    /** 每条回答只保留一个「⋯」按钮，具体操作在菜单里（原来是排一排按钮） */
    function attachAssistantTools(state, node, message) {
      node.tools.replaceChildren();
      const more = Sideline.util.element(state.doc, "button", {
        className: "sl-msg-more",
        text: "⋯",
        attrs: { title: "回答操作：重试 / 修改提问 / 复制" },
      });
      Sideline.util.onActivate(more, () => openAnswerMenu(state, message, node, more));
      node.tools.appendChild(more);
    }

    /** 面板顶部的小字：本会话累计用量（没有调用时不显示） */
    function refreshTotals(state) {
      const totals = Sideline.session.totals(state.ownerID);
      state.totalsText = totals.calls
        ? `${totals.calls} 次 · ${totals.tokens ? `${totals.tokens} tokens` : "token 未返回"}`
          + `${totals.elapsedMs ? ` · ${(totals.elapsedMs / 1000).toFixed(1)}s` : ""}`
        : "";
      const host = state.els && state.els.totalsEl;
      if (host) host.textContent = state.totalsText;
    }

    function renderMessages(state) {
      const el = state.els && state.els.messagesEl;
      if (!el) return;
      el.replaceChildren();
      const messages = Sideline.session.list(state.ownerID);
      const visible = new Set(messages.filter((message) => message.role === "assistant" && !message.uiHidden && message.functionId !== "highlight").map((message) => message.id));
      for (const [id, cached] of state.renderCache) if (!visible.has(id)) {
        state.renderCacheChars -= cached.html.length; state.renderCache.delete(id);
      }
      if (!messages.length) {
        el.appendChild(Sideline.util.element(state.doc, "div", {
          className: "sideline-hint",
          text: "还没有对话。在 PDF 里划词，或用输入区的「＋」加入材料；选好功能后发送即可（提示词在设置里配置，不会显示在对话里）。",
        }));
        refreshTotals(state);
        return;
      }
      messages.forEach((message) => {
        if (message.uiHidden) return;
        const node = bubble(state, message);
        if (message.role === "assistant") {
          attachAssistantTools(state, node, message);
        }
        el.appendChild(node.wrapper);
      });
      refreshTotals(state);
      scrollToEnd(state);
    }

    return { scrollToEnd, scrollToMessage, answerHtml, bubble, attachPageRefs, attachQuoteLocators,
      attachAssistantTools, renderMessages, refreshTotals };
  }
  return { create };
})();
