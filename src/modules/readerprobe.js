/*
 * Zotero Sideline：阅读器探针（验证用，不属于功能路径）。
 * 功能：枚举已打开的 Reader，读取其 iframe 文档里的「页 → 文本层 → span 几何」结构，
 *       用来判断能否据此做来源锚定（页码 / 坐标）与选区跳转。
 * 输入：可选 itemID；输出：每个 Reader 的页数、有文本层的页数、首个可用 span 的文本与几何。
 * 依赖：Zotero.Reader._readers（reader.js 内部数组）与 reader._iframeWindow
 *       （另一插件 zoteropdftranslate 也用这个入口访问阅读器 iframe）。
 * 说明：只读 DOM，不修改任何 Zotero 数据；结果中的几何是 iframe 内 CSS 像素，
 *       是否等于 PDF 坐标系需要与 Zotero.Annotations 的 rect 约定对照后才能确定。
 *       deepSnapshot 会遍历嵌套 frame（reader.xhtml 里是 <browser id="reader">，
 *       其中的 reader.html 再把 pdf.js 放在更深一层），并尝试用 pdf.js 的
 *       PDFViewerApplication.pdfDocument.getPage(n).getTextContent() 取按页正文与几何。
 */

Sideline.readerprobe = (function () {
  function readers(itemID) {
    const all = (Zotero.Reader && Zotero.Reader._readers) || [];
    const wanted = parseInt(itemID, 10);
    if (!Number.isFinite(wanted) || wanted <= 0) return all;
    return all.filter((reader) => reader.itemID === wanted);
  }

  function count() {
    return ((Zotero.Reader && Zotero.Reader._readers) || []).length;
  }

  function firstSpanInfo(layer) {
    const spans = layer.querySelectorAll("span");
    for (const span of spans) {
      const text = String(span.textContent || "").trim();
      if (!text) continue;
      let rect = null;
      try {
        const box = span.getBoundingClientRect();
        rect = {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }
      catch (error) {
        rect = null;
      }
      return {
        text: text.slice(0, 60),
        rect,
        style: span.getAttribute("style") || "",
        dataL10n: span.getAttribute("data-l10n-id") || "",
      };
    }
    return null;
  }

  function snapshot(reader) {
    const out = {
      itemID: reader.itemID,
      tabID: reader.tabID || null,
      pageCount: 0,
      textLayerPages: 0,
      sample: null,
      pageLabels: [],
      error: "",
    };
    try {
      const win = reader._iframeWindow;
      const doc = win && win.document;
      if (!doc) {
        out.error = "无法访问阅读器 iframe 文档";
        return out;
      }
      const pages = doc.querySelectorAll(".page");
      out.pageCount = pages.length;
      let index = 0;
      for (const page of pages) {
        index++;
        if (out.pageLabels.length < 5) {
          out.pageLabels.push({
            order: index,
            pageNumber: page.getAttribute("data-page-number") || null,
            label: page.getAttribute("data-page-label") || null,
          });
        }
        const layer = page.querySelector(".textLayer");
        if (!layer) continue;
        const info = firstSpanInfo(layer);
        if (!info) continue;
        out.textLayerPages++;
        if (!out.sample) {
          out.sample = Object.assign({
            pageNumber: page.getAttribute("data-page-number") || null,
            pageLabel: page.getAttribute("data-page-label") || null,
          }, info);
        }
      }
    }
    catch (error) {
      out.error = Sideline.util.message(error);
    }
    return out;
  }

  function snapshotAll(itemID) {
    return readers(itemID).map(snapshot);
  }

  // readers/candidateWindows/findPdfWindow 由 readertext.js 复用：探针本身只读不改数据，
  // 把「怎样找到 pdf.js 应用」这条已实测的路径集中在这里，避免正式取文逻辑另写一套。
  return { count, readers, snapshotAll, deepSnapshotAll, candidateWindows, findPdfWindow };

  /** 遍历嵌套 frame 的深入探测：页/文本层/canvas 计数、pdf.js 按页取文与几何 */
  function frameElements(doc) {
    try {
      return Array.from(doc.querySelectorAll("iframe, browser"));
    }
    catch (error) {
      return [];
    }
  }

  function documentSummary(win, path) {
    const summary = {
      path,
      href: "",
      elements: 0,
      pageCount: 0,
      textLayerCount: 0,
      canvasCount: 0,
      classSample: [],
      pdfViewer: null,
      error: "",
    };
    try {
      const doc = win.document;
      summary.href = String((win.location && win.location.href) || "");
      summary.elements = doc.querySelectorAll("*").length;
      summary.pageCount = doc.querySelectorAll(".page").length;
      summary.textLayerCount = doc.querySelectorAll(".textLayer").length;
      summary.canvasCount = doc.querySelectorAll("canvas").length;
      const counts = new Map();
      for (const node of doc.querySelectorAll("[class]")) {
        for (const name of String(node.getAttribute("class") || "").split(/\s+/)) {
          if (name) counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
      summary.classSample = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => `${name}:${count}`);
      const app = win.PDFViewerApplication;
      if (app) {
        summary.pdfViewer = {
          hasDocument: !!app.pdfDocument,
          numPages: app.pdfDocument ? app.pdfDocument.numPages : null,
          pageNumber: app.page === undefined ? null : app.page,
        };
      }
    }
    catch (error) {
      summary.error = Sideline.util.message(error);
    }
    return summary;
  }

  /**
   * 收集可能持有 pdf.js 应用的窗口。
   * 依据 Zotero 自身代码（resource/reader/reader.js）：
   *   this._pdfView._iframeWindow.PDFViewerApplication.pdfDocument.getPage(n)
   *   this._iframeWindow.PDFViewerApplication.pdfDocument.getOutline2({}) / getPageLabels2()
   * 也就是说 PDFViewerApplication 挂在「视图对象的 _iframeWindow」上，
   * 不一定是外壳 reader._iframeWindow 或它的直接子 frame。因此这里多路径枚举，
   * 并对同一窗口同时尝试原始对象与 wrappedJSObject。
   */
  function candidateWindows(reader) {
    const list = [];
    const seen = new Set();
    const push = (label, win) => {
      if (!win) return;
      let wrapped = null;
      try {
        wrapped = win.wrappedJSObject;
      }
      catch (error) {
        wrapped = null;
      }
      // 先放 wrappedJSObject：pdf.js 的 page 对象是 content compartment 的对象，
      // 经 Xray 访问时原型方法（如 getTextContent）不可见，必须走内容侧对象。
      if (wrapped && !seen.has(wrapped)) {
        seen.add(wrapped);
        list.push({ label: `${label}:wrapped`, win: wrapped });
      }
      if (!seen.has(win)) {
        seen.add(win);
        list.push({ label, win });
      }
    };

    push("reader._iframeWindow", reader._iframeWindow);
    const internal = reader._internalReader;
    if (internal) {
      push("internal._activePrimaryView._iframeWindow",
        internal._activePrimaryView && internal._activePrimaryView._iframeWindow);
      push("internal._activeSecondaryView._iframeWindow",
        internal._activeSecondaryView && internal._activeSecondaryView._iframeWindow);
      push("internal._lastView._iframeWindow", internal._lastView && internal._lastView._iframeWindow);
      let views = internal._views;
      if (views) {
        try {
          const iterable = typeof views.values === "function" ? Array.from(views.values()) : Array.from(views);
          for (const view of iterable) {
            push("internal._views[]._iframeWindow", view && view._iframeWindow);
          }
        }
        catch (error) {
          // 忽略不可遍历的情况
        }
      }
    }
    return list;
  }

  /** 在该窗口的文档里，用文本层 DOM 取指定页的文本与几何（仅已渲染的页有文本层） */
  function textLayerSample(win, pageNumber) {
    const out = { source: "textLayer", pageNumber, spans: 0, items: [], error: "" };
    try {
      const doc = win.document;
      const selector = `.page[data-page-number="${pageNumber}"] .textLayer span`;
      const spans = Array.from(doc.querySelectorAll(selector));
      out.spans = spans.length;
      for (const span of spans.slice(0, 3)) {
        let rect = null;
        try {
          const box = span.getBoundingClientRect();
          rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
        }
        catch (error) {
          rect = null;
        }
        out.items.push({ str: String(span.textContent || "").slice(0, 40), rect });
      }
    }
    catch (error) {
      out.error = Sideline.util.message(error);
    }
    return out;
  }

  /** 在候选窗口列表里找到 pdf.js 应用所在的那一个 */
  function findPdfWindow(candidates) {
    for (const candidate of candidates) {
      try {
        const app = candidate.win.PDFViewerApplication
          || (candidate.win.wrappedJSObject && candidate.win.wrappedJSObject.PDFViewerApplication);
        if (app && app.pdfDocument) {
          return { label: candidate.label, win: candidate.win, app };
        }
      }
      catch (error) {
        // 继续试下一个
      }
    }
    return null;
  }
  /**
   * 首选路径：Zotero 的 pdf.js fork 在 pdfDocument 上提供 getPageData({pageIndex})，
   * 返回的 chars[] 每项带 .u（该字符文本）与几何字段。Zotero 自己的搜索与文本层就用它
   * （见 resource/reader/reader.js 中 `getPageData({ pageIndex })` 与 `char.u` 的用法）。
   */
  async function pageTextViaPageData(pdfDocument, pageNumber) {
    const out = {
      source: "pageData",
      pageNumber,
      charCount: 0,
      text: "",
      firstChars: [],
      charKeys: [],
      dataKeys: [],
      error: "",
    };
    try {
      if (!pdfDocument || typeof pdfDocument.getPageData !== "function") {
        out.error = "pdfDocument.getPageData 不存在";
        return out;
      }
      const pageData = await pdfDocument.getPageData({ pageIndex: pageNumber - 1 });
      if (!pageData) {
        out.error = "getPageData 返回空";
        return out;
      }
      out.dataKeys = Object.getOwnPropertyNames(pageData).slice(0, 30);
      const chars = Array.isArray(pageData.chars) ? pageData.chars : [];
      out.charCount = chars.length;
      if (chars.length) out.charKeys = Object.getOwnPropertyNames(chars[0]).slice(0, 20);
      out.firstChars = chars.slice(0, 5).map((char) => ({
        u: String(char.u || ""),
        keys: Object.getOwnPropertyNames(char).slice(0, 15),
      }));
      out.text = chars.slice(0, 300).map((char) => String(char.u || "")).join("");
      if (!out.text) out.error = "chars 为空（该页可能没有文字层）";
    }
    catch (error) {
      out.error = Sideline.util.message(error);
    }
    return out;
  }

  /** 页码标签（纸面页码），用于引用里的"第几页" */
  async function pageLabelsOf(pdfDocument) {
    try {
      if (!pdfDocument || typeof pdfDocument.getPageLabels2 !== "function") return null;
      const labels = await pdfDocument.getPageLabels2();
      return Array.isArray(labels) ? labels.slice(0, 6) : labels;
    }
    catch (error) {
      return { error: Sideline.util.message(error) };
    }
  }

  /** 大纲条数（章节级结构） */
  async function outlineOf(pdfDocument) {
    try {
      if (!pdfDocument || typeof pdfDocument.getOutline2 !== "function") return null;
      const outline = await pdfDocument.getOutline2({});
      if (!Array.isArray(outline)) return outline;
      return { count: outline.length, first: outline.slice(0, 3).map((entry) => String((entry && entry.title) || "")) };
    }
    catch (error) {
      return { error: Sideline.util.message(error) };
    }
  }

  async function pageTextSample(win, pageNumber, app) {
    const out = { source: "pdfjs", pageNumber, itemCount: 0, firstItems: [], viewport: null, error: "" };
    try {
      const application = app || win.PDFViewerApplication
        || (win.wrappedJSObject && win.wrappedJSObject.PDFViewerApplication);
      if (!application || !application.pdfDocument) {
        out.error = "该窗口没有 PDFViewerApplication.pdfDocument";
        return out;
      }
      let page = await application.pdfDocument.getPage(pageNumber);
      if (page && typeof page.getTextContent !== "function") {
        // Xray 包装会隐藏原型方法，解包后重试
        try {
          page = ChromeUtils.waiveXrays(page);
        }
        catch (error) {
          out.error = `解包失败：${Sideline.util.message(error)}`;
        }
      }
      if (!page || typeof page.getTextContent !== "function") {
        out.pageKeys = ownNames(page, 25);
        out.pageProtoKeys = ownNames(page ? Object.getPrototypeOf(page) : null, 25);
        out.error = out.error || "page.getTextContent 不是函数";
        return out;
      }
      const content = await page.getTextContent();
      out.itemCount = content.items.length;
      out.firstItems = content.items.slice(0, 3).map((item) => ({
        str: String(item.str || "").slice(0, 40),
        transform: Array.isArray(item.transform)
          ? item.transform.map((value) => Math.round(value * 1000) / 1000)
          : null,
        width: item.width,
        height: item.height,
      }));
      const viewport = page.getViewport({ scale: 1 });
      out.viewport = {
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        rotation: viewport.rotation,
      };
    }
    catch (error) {
      out.error = Sideline.util.message(error);
    }
    return out;
  }

  function ownNames(object, limit) {
    try {
      if (!object) return [];
      return Object.getOwnPropertyNames(object).slice(0, limit);
    }
    catch (error) {
      return [];
    }
  }

  async function deepSnapshot(reader, pageNumber) {
    const result = {
      itemID: reader.itemID,
      frames: [],
      pageText: null,
      internalReaderKeys: ownNames(reader._internalReader, 60),
      internalReaderProtoKeys: ownNames(
        reader._internalReader ? Object.getPrototypeOf(reader._internalReader) : null,
        60,
      ),
      error: "",
    };
    try {
      const root = reader._iframeWindow;
      if (!root) {
        result.error = "reader 没有 _iframeWindow";
        return result;
      }
      const queue = [{ win: root, path: "iframeWindow", depth: 0 }];
      const visited = [];
      while (queue.length && visited.length < 8) {
        const current = queue.shift();
        let doc = null;
        try {
          doc = current.win.document;
        }
        catch (error) {
          result.frames.push({ path: current.path, error: Sideline.util.message(error) });
          continue;
        }
        const summary = documentSummary(current.win, current.path);
        result.frames.push(summary);
        visited.push({ win: current.win, summary });
        if (current.depth < 3) {
          for (const element of frameElements(doc)) {
            let childWin = null;
            try {
              childWin = element.contentWindow;
            }
            catch (error) {
              childWin = null;
            }
            if (childWin) {
              queue.push({
                win: childWin,
                path: `${current.path}>${String(element.localName)}#${element.id || "?"}`,
                depth: current.depth + 1,
              });
            }
          }
        }
      }
      // 优先按 Zotero 自身的路径找 pdf.js 应用（视图对象的 _iframeWindow），
      // 找不到再退化为「用已渲染页的文本层 DOM 取文本与几何」。
      const target = pageNumber > 0 ? pageNumber : 1;
      const candidates = candidateWindows(reader);
      for (const entry of visited) {
        candidates.push({ label: `frame:${entry.summary.path}`, win: entry.win });
      }
      const found = findPdfWindow(candidates);
      result.windowCandidates = candidates.map((entry) => entry.label);
      result.viewKeys = ownNames(reader._internalReader && reader._internalReader._activePrimaryView, 40);
      if (found) {
        result.pdfWindow = found.label;
        result.pageTextFrame = found.label;
        const pdfDocument = found.app.pdfDocument;
        // 主路径：fork 自带的按页数据（含字符与几何）
        result.pageText = await pageTextViaPageData(pdfDocument, target);
        if (result.pageText.error) {
          const secondary = await pageTextSample(found.win, target, found.app);
          result.pageTextFallbacks = [{ source: "getTextContent", error: result.pageText.error }];
          result.pageText = secondary;
        }
        if (result.pageText && result.pageText.error) {
          const layer = textLayerSample(found.win, target);
          result.pageTextFallbacks = (result.pageTextFallbacks || [])
            .concat([{ source: "textLayer", error: result.pageText.error }]);
          if (layer.spans > 0) result.pageText = layer;
        }
        result.pageLabels = await pageLabelsOf(pdfDocument);
        result.outline = await outlineOf(pdfDocument);
      }
      else {
        result.error = "没有找到 PDFViewerApplication.pdfDocument，改用文本层兜底";
        const fallback = visited.map((entry) => ({
          path: entry.summary.path,
          sample: textLayerSample(entry.win, target),
        })).filter((entry) => entry.sample.spans > 0);
        result.pageText = fallback.length ? fallback[0].sample : null;
        result.pageTextFrame = fallback.length ? fallback[0].path : "";
        result.textLayerFallbackTried = visited.map((entry) => entry.summary.path);
      }
    }
    catch (error) {
      result.error = Sideline.util.message(error);
    }
    return result;
  }

  async function deepSnapshotAll(itemID, pageNumber) {
    const list = readers(itemID);
    const out = [];
    for (const reader of list) {
      out.push(await deepSnapshot(reader, pageNumber));
    }
    return out;
  }
})();
