/*
 * Zotero Sideline：阅读器正文与锚定。
 *
 * 功能：把已打开的 PDF 阅读器解析为「页 → 文本片段 → 几何」，供对话上下文与来源定位使用；
 *       提供按页取文、纸面页码、矩形合并、文本反查（locate）、覆盖状态与跳回原文。
 * 输入：reader（Zotero.Reader._readers 中的元素，含 itemID 与 _iframeWindow）；
 *       页码一律使用 **0 基** pageIndex（与 Zotero 批注 position.pageIndex 一致），
 *       对外接口内部再换算成 pdf.js 的 1 基 pageNumber。
 * 输出：纯数据对象（可安全跨 compartment 传递），不返回 pdf.js 的对象。
 * 依赖：readerprobe.js 的 candidateWindows/findPdfWindow（已实测的 pdf.js 定位路径）、
 *       pdfDocument.getPage(n).getTextContent()（实测可用）、getPageLabels2()（实测可用）、
 *       reader.navigate({pageIndex})（Zotero 10.0.3 的 reader.js:755，见 jump 的实测依据）。
 * 说明：1) page 对象的原型方法经 Xray 不可见，必须用 wrappedJSObject 或 ChromeUtils.waiveXrays；
 *       2) getPageData/getOutline2 跨 compartment 会抛「could not be cloned」，因此不走它们；
 *       3) 文本层 DOM 只覆盖已渲染页，仅作为拿不到 pdf.js 时的兜底；
 *       4) 坐标约定：transform 的 e/f 是页面空间（y 轴向上）的左边界与基线，
 *          Zotero 批注 rect 用的也是页面空间 [x1,y1,x2,y2]；跳回原文时再换算成 CSS 像素。
 */

Sideline.readertext = (function () {
  const PAGE_CACHE_LIMIT = 300;
  const LABEL_CACHE_LIMIT = 8;

  /** 页数据缓存：key 为 `${itemID}:${pageIndex}`，PDF 内容不变因此不做失效，只做条数淘汰 */
  const pageCache = new Map();
  /** 纸面页码缓存：key 为 itemID */
  const labelsCache = new Map();

  function readers(itemID) {
    return Sideline.readerprobe.readers(itemID);
  }

  function firstReader(itemID) {
    return readers(itemID)[0] || null;
  }

  /**
   * 找到该阅读器里 pdf.js 应用所在的窗口。
   * 找不到时返回 null，调用方应退回文本层或报「未找到正文」。
   */
  function resolve(reader) {
    if (!reader) return null;
    let found = null;
    try {
      found = Sideline.readerprobe.findPdfWindow(Sideline.readerprobe.candidateWindows(reader));
    }
    catch (error) {
      Sideline.util.warn(`定位 pdf.js 失败：${Sideline.util.message(error)}`);
      return null;
    }
    if (!found || !found.app || !found.app.pdfDocument) return null;
    return { win: found.win, app: found.app, pdfDocument: found.app.pdfDocument, label: found.label };
  }

  function own(value, key) {
    try {
      return value == null ? undefined : value[key];
    }
    catch (error) {
      return undefined;
    }
  }

  function finite(value) {
    // 注意：Number(null) 与 Number("") 都是 0，会把「跨 compartment 后变成 null 的尺寸」
    // 误当成 0，因此先显式排除 null/undefined/空串。
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  /**
   * 取页对象并把原型方法还原出来。
   * 跨 compartment 时 Xray 包装会隐藏 getTextContent，因此优先 wrappedJSObject，
   * 必要时再用 ChromeUtils.waiveXrays 解包（与 readerprobe 的实测结论一致）。
   */
  async function pageObject(pdfDocument, pageNumber) {
    let page = await pdfDocument.getPage(pageNumber);
    if (page && typeof own(page, "getTextContent") !== "function") {
      try {
        page = ChromeUtils.waiveXrays(page);
      }
      catch (error) {
        Sideline.util.warn(`解包页对象失败：${Sideline.util.message(error)}`);
      }
    }
    if (!page || typeof own(page, "getTextContent") !== "function") {
      throw new Error("page.getTextContent 不是函数（Xray 未解包）");
    }
    return page;
  }

  /**
   * 页面尺寸。
   * 实测：getViewport({scale:1}) 跨 compartment 后 width/height 会变成 null（只剩 rotation），
   * 因此逐字段取数值，失败时退回 page.view（[x0,y0,x1,y1]，普通数组可安全传递）。
   */
  function viewportOf(page) {
    const size = { width: null, height: null, rotation: 0 };
    try {
      const viewport = page.getViewport({ scale: 1 });
      size.width = finite(own(viewport, "width"));
      size.height = finite(own(viewport, "height"));
      const rotation = finite(own(viewport, "rotation"));
      size.rotation = rotation === null ? 0 : rotation;
    }
    catch (error) {
      // 落到 page.view
    }
    if (size.width === null || size.height === null) {
      const view = own(page, "view");
      if (Array.isArray(view) && view.length >= 4) {
        const width = finite(view[2]) - finite(view[0]);
        const height = finite(view[3]) - finite(view[1]);
        if (width > 0 && height > 0) {
          size.width = size.width === null ? width : size.width;
          size.height = size.height === null ? height : size.height;
        }
      }
    }
    return size;
  }

  /**
   * 单个文本片段的页面空间矩形。
   * pdf.js 文本矩阵 [a,b,c,d,e,f] 中 e/f 为左边界与基线，a=d 为字号；
   * 这里按基线上下各取一段得到包围盒，坐标与 Zotero 批注 rect 同系（原点左下、y 向上）。
   */
  function itemRect(item) {
    const transform = own(item, "transform");
    if (!Array.isArray(transform) || transform.length < 6) return null;
    const size = Math.abs(finite(transform[3])) || Math.abs(finite(transform[0])) || 0;
    const x = finite(transform[4]);
    const baseline = finite(transform[5]);
    const width = finite(own(item, "width"));
    const height = finite(own(item, "height")) || size;
    if (x === null || baseline === null || width === null || !width) return null;
    return [
      Math.round(x * 100) / 100,
      Math.round((baseline - height * 0.28) * 100) / 100,
      Math.round((x + width) * 100) / 100,
      Math.round((baseline + height * 0.82) * 100) / 100,
    ];
  }

  /** 把 pdf.js 文本片段整理成纯数据 span 列表 */
  function toSpans(items, pageIndex) {
    const spans = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const str = String(own(item, "str") == null ? "" : own(item, "str"));
      if (!str.trim()) continue;
      spans.push({
        index: spans.length,
        id: `${pageIndex}:${index}`,
        str,
        rect: itemRect(item),
        hasEOL: !!own(item, "hasEOL"),
      });
    }
    return spans;
  }

  /** 文本层兜底：只有已渲染页才有 span，几何是 CSS 像素，不能当页面空间坐标用 */
  function textLayerSpans(reader, pageIndex) {
    const win = reader && reader._iframeWindow;
    const doc = win && win.document;
    if (!doc) return null;
    try {
      const spans = Array.from(doc.querySelectorAll(
        `.page[data-page-number="${pageIndex + 1}"] .textLayer span`,
      ));
      if (!spans.length) return null;
      const out = [];
      for (const span of spans) {
        const text = String(span.textContent || "");
        if (!text.trim()) continue;
        out.push({ index: out.length, id: `css:${pageIndex}:${out.length}`, str: text, rect: null, hasEOL: false });
      }
      return out.length ? out : null;
    }
    catch (error) {
      return null;
    }
  }

  function putCache(cache, key, value, limit) {
    cache.set(key, value);
    while (cache.size > limit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function cacheKey(reader, pageIndex) {
    return `${(reader && reader.itemID) || 0}:${pageIndex}`;
  }

  /**
   * 取一页的文本与几何（带缓存）。
   * @returns {Promise<{pageIndex:number,label:string,spans:object[],chars:number,state:string,source:string,error:string}>}
   *          state: ok（有正文）/ empty（该页无文字，可能是扫描页或空白页）/ error（取文失败）
   */
  async function page(reader, pageIndex, options = {}) {
    const index = Math.max(0, parseInt(pageIndex, 10) || 0);
    const key = cacheKey(reader, index);
    if (!options.refresh && pageCache.has(key)) return pageCache.get(key);

    const record = {
      pageIndex: index,
      label: "",
      spans: [],
      chars: 0,
      state: "error",
      source: "",
      error: "",
    };
    const target = resolve(reader);
    if (!target) {
      record.error = "没有找到 pdf.js 的 pdfDocument";
    }
    else {
      try {
        const pageObj = await pageObject(target.pdfDocument, index + 1);
        const content = await pageObj.getTextContent();
        const items = content && Array.isArray(content.items) ? content.items : [];
        record.spans = toSpans(items, index);
        record.chars = record.spans.reduce((sum, span) => sum + span.str.length, 0);
        record.state = record.spans.length ? "ok" : "empty";
        record.source = "pdfjs";
        record.viewport = viewportOf(pageObj);
      }
      catch (error) {
        record.error = Sideline.util.message(error);
      }
    }

    if (record.state === "error") {
      const fallback = textLayerSpans(reader, index);
      if (fallback && fallback.length) {
        record.spans = fallback;
        record.chars = fallback.reduce((sum, span) => sum + span.str.length, 0);
        record.state = "ok";
        record.source = "textLayer";
        record.error = "";
      }
    }

    if (!record.label) record.label = await labelOf(reader, index);
    putCache(pageCache, key, record, PAGE_CACHE_LIMIT);
    return record;
  }

  /** 纸面页码标签数组（如 "1","2","i"），取不到返回 null */
  async function pageLabels(reader, options = {}) {
    const itemID = (reader && reader.itemID) || 0;
    if (!options.refresh && labelsCache.has(itemID)) return labelsCache.get(itemID);
    const target = resolve(reader);
    if (!target || typeof target.pdfDocument.getPageLabels2 !== "function") return null;
    try {
      const labels = await target.pdfDocument.getPageLabels2();
      const list = Array.isArray(labels) ? labels.map((value) => String(value)) : null;
      if (list) putCache(labelsCache, itemID, list, LABEL_CACHE_LIMIT);
      return list;
    }
    catch (error) {
      Sideline.util.warn(`读取页码标签失败：${Sideline.util.message(error)}`);
      return null;
    }
  }

  /** 单页纸面页码；没有标签时退回 1 基序号 */
  async function labelOf(reader, pageIndex) {
    const labels = await pageLabels(reader);
    if (labels && labels[pageIndex]) return labels[pageIndex];
    return String(pageIndex + 1);
  }

  /** 总页数 */
  function pageCount(reader) {
    const target = resolve(reader);
    const numPages = target ? finite(own(target.pdfDocument, "numPages")) : null;
    if (numPages) return numPages;
    const win = reader && reader._iframeWindow;
    try {
      const pages = win && win.document ? win.document.querySelectorAll(".page") : [];
      return pages.length || 0;
    }
    catch (error) {
      return 0;
    }
  }

  /** 按行把片段矩形合并成较少的矩形（y 方向重叠即视为同一行） */
  function mergeRects(rects) {
    const sorted = rects.filter(Boolean).slice().sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
    const lines = [];
    for (const rect of sorted) {
      const line = lines.find((entry) => !(rect[1] > entry[3] || rect[3] < entry[1]));
      if (line) {
        line[0] = Math.min(line[0], rect[0]);
        line[1] = Math.min(line[1], rect[1]);
        line[2] = Math.max(line[2], rect[2]);
        line[3] = Math.max(line[3], rect[3]);
      }
      else {
        lines.push(rect.slice());
      }
    }
    return lines.map((line) => line.map((value) => Math.round(value * 100) / 100));
  }

  /** 指定页上 [from,to] 片段的页面空间矩形（行合并后），供批注书写与高亮预览使用 */
  async function rectsForRange(reader, pageIndex, from, to) {
    const record = await page(reader, pageIndex);
    const spans = record.spans.slice(Math.max(0, from), Math.max(0, to) + 1);
    const rects = spans.map((span) => span.rect).filter(Boolean);
    return { rects: mergeRects(rects), spans: spans.length, pageIndex: record.pageIndex };
  }

  /** 规范化检索串：折叠空白、统一空格，便于跨片段匹配 */
  function normalize(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  }

  /**
   * 在某一页上反查一段文字，返回片段区间。
   * 供 R04「引用可跳回」使用：模型给出的原文片段 → 页码与几何。
   * @returns {Promise<{found:boolean,from:number,to:number,pageIndex:number,match:string,error:string}>}
   */
  async function locate(reader, options = {}) {
    const index = Math.max(0, parseInt(options.pageIndex, 10) || 0);
    const record = await page(reader, index);
    const result = { found: false, from: -1, to: -1, pageIndex: index, match: "", error: "" };
    if (record.state !== "ok") {
      result.error = record.error || (record.state === "empty" ? "该页没有可用文字" : "取文失败");
      return result;
    }
    const needle = normalize(options.text);
    if (!needle) {
      result.error = "待定位的文字为空";
      return result;
    }

    // 拼接时记录每个字符落在哪个片段上，命中后即可换回片段区间
    let haystack = "";
    const owners = [];
    const joins = [];
    for (const span of record.spans) {
      if (haystack && !/\s$/.test(haystack)) {
        haystack += " ";
        owners.push(-1);
      }
      joins.push(haystack.length);
      // indexOf 使用 UTF-16 偏移；辅助索引也按代码单元计数，避免非 BMP 符号错位。
      const normalized = normalize(span.str);
      for (let offset = 0; offset < normalized.length; offset++) {
        haystack += normalized[offset];
        owners.push(span.index);
      }
    }

    const wanted = Number.isFinite(options.occurrence) && options.occurrence > 0
      ? parseInt(options.occurrence, 10)
      : 1;
    let cursor = -1;
    let hit = -1;
    for (let count = 0; count < wanted; count++) {
      cursor = haystack.indexOf(needle, cursor + 1);
      if (cursor < 0) break;
      hit = cursor;
    }
    if (hit < 0 && options.exact) {
      // PDF 的字块/换行会增加空格；只消除排版空白，不把短前缀命中当作完整引句。
      const compact = [], positions = [];
      for (let i = 0; i < haystack.length; i++) {
        if (!/\s/.test(haystack[i])) { compact.push(haystack[i]); positions.push(i); }
      }
      const candidate = needle.replace(/\s/g, "");
      const start = compact.join("").indexOf(candidate);
      if (start >= 0) {
        result.found = true;
        result.from = owners[positions[start]];
        result.to = owners[positions[start + candidate.length - 1]];
        result.match = needle;
        return result;
      }
    }
    if (hit < 0) {
      if (options.exact) { result.error = "该页未找到完整原文"; return result; }
      // 退一步：用前若干字符重试，容忍模型引用时的轻微改写
      const head = normalize(needle).slice(0, 24);
      if (head.length >= 8) {
        const retry = haystack.indexOf(head);
        if (retry >= 0) {
          result.found = true;
          result.from = owners[retry];
          result.to = owners[Math.min(owners.length - 1, retry + head.length - 1)];
          result.match = haystack.slice(retry, retry + head.length);
          result.approximate = true;
          return result;
        }
      }
      result.error = "该页未找到这段文字";
      return result;
    }

    result.found = true;
    result.from = owners[hit];
    result.to = owners[Math.min(owners.length - 1, hit + needle.length - 1)];
    result.match = haystack.slice(hit, hit + needle.length);
    return result;
  }

  /** 浮层挂载与定位依赖 .page 自带 position:relative，因此先取页元素 */
  function pageElement(win, pageIndex) {
    try {
      return (win && win.document)
        ? win.document.querySelector(`.page[data-page-number="${pageIndex + 1}"]`)
        : null;
    }
    catch (error) {
      return null;
    }
  }

  /**
   * 把页面空间矩形换算成「相对 .page 容器」的 CSS 像素矩形（用于跳回与高亮浮层）。
   * 缩放系数由 .page 的实际渲染宽度与 scale=1 视口宽度之比推出，不依赖 pdf.js 的
   * currentScale 内部字段；.pdfViewer .page 自带 position:relative，浮层可直接绝对定位。
   */
  async function cssRects(reader, pageIndex, rects) {
    const target = resolve(reader);
    if (!target || !rects || !rects.length) return [];
    try {
      const pageObj = await pageObject(target.pdfDocument, pageIndex + 1);
      const base = pageObj.getViewport({ scale: 1 });
      const baseWidth = finite(own(base, "width")) || viewportOf(pageObj).width;
      const pageEl = pageElement(target.win, pageIndex);
      let scale = 1;
      if (pageEl && baseWidth) {
        const rendered = finite(pageEl.clientWidth) || finite(pageEl.getBoundingClientRect
          ? pageEl.getBoundingClientRect().width : null);
        if (rendered) scale = rendered / baseWidth;
      }
      const viewport = pageObj.getViewport({ scale });
      const list = [];
      for (const rect of rects) {
        const converted = viewport.convertToViewportRectangle(rect);
        if (!converted || converted.length < 4) continue;
        const values = Array.from(converted).map(Number);
        if (values.some((value) => !Number.isFinite(value))) continue;
        list.push([
          Math.min(values[0], values[2]),
          Math.min(values[1], values[3]),
          Math.max(values[0], values[2]),
          Math.max(values[1], values[3]),
        ]);
      }
      return list;
    }
    catch (error) {
      Sideline.util.warn(`换算 CSS 坐标失败：${Sideline.util.message(error)}`);
      return [];
    }
  }

  /**
   * 取指定页的 .page 元素与它所属的窗口。
   * 优先用 resolve 得到的 pdf.js 窗口（页元素就在它的文档里），
   * 拿不到 pdf.js 时退回阅读器外壳窗口；都取不到则报「拿不到阅读器文档」。
   */
  function jumpContext(reader, pageIndex) {
    let target = null;
    try {
      target = resolve(reader);
    }
    catch (error) {
      target = null;
    }
    const win = (target && target.win) || (reader && reader._iframeWindow) || null;
    let doc = null;
    try {
      doc = (win && win.document) || null;
    }
    catch (error) {
      doc = null;
    }
    const pageEl = doc ? pageElement(win, pageIndex) : null;
    return { win, doc, pageEl };
  }

  /** 以 setTimeout 轮询页元素是否渲染完成；返回时一定会停止轮询 */
  function waitPage(win, pageIndex) {
    const first = pageElement(win, pageIndex);
    if (first) return Promise.resolve({ pageEl: first, timedOut: false });
    const tools = Sideline.util.windowTools();
    if (!tools.setTimeout) {
      // 沙箱里没有定时器（理论上只在测试宿主出现）：只能同步判定一次，不谎报成功
      return Promise.resolve({ pageEl: pageElement(win, pageIndex), timedOut: true });
    }
    return new Promise((resolve) => {
      const deadline = Date.now() + 1500;
      let timer = null;
      const done = (result) => {
        if (timer) {
          try {
            if (tools.clearTimeout) tools.clearTimeout(timer);
          }
          catch (error) {
            // 清定时器失败不影响结果
          }
          timer = null;
        }
        resolve(result);
      };
      const tick = () => {
        const pageEl = pageElement(win, pageIndex);
        if (pageEl) {
          done({ pageEl, timedOut: false });
          return;
        }
        const rest = deadline - Date.now();
        if (rest <= 0) {
          done({ pageEl: null, timedOut: true });
          return;
        }
        timer = tools.setTimeout(tick, Math.min(100, rest));
      };
      timer = tools.setTimeout(tick, 100);
    });
  }

  /** pdf.js 的 scrollPageIntoView：Zotero 阅读器自己就用它翻页 */
  async function scrollViaPdfjs(win, index) {
    const app = own(win, "PDFViewerApplication");
    const viewer = app && own(app, "pdfViewer");
    if (!viewer || typeof own(viewer, "scrollPageIntoView") !== "function") return false;
    await viewer.scrollPageIntoView({ pageNumber: index + 1 });
    return true;
  }

  /** 兜底：直接把页元素滚进视野 */
  async function scrollViaElement(pageEl) {
    if (!pageEl || typeof own(pageEl, "scrollIntoView") !== "function") return false;
    pageEl.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }

  /** 在页元素上叠一层黄色浮层并定时移除；返回画出的矩形数 */
  function flashRects(doc, pageEl, boxes) {
    const layer = Sideline.util.element(doc, "div", {
      className: "sideline-flash-layer",
      style: "position:absolute;inset:0;pointer-events:none;z-index:5",
    });
    for (const box of boxes) {
      layer.appendChild(Sideline.util.element(doc, "div", {
        className: "sideline-flash",
        style: `position:absolute;left:${box[0]}px;top:${box[1]}px;`
          + `width:${Math.max(2, box[2] - box[0])}px;height:${Math.max(2, box[3] - box[1])}px;`
          + "background:var(--accent-blue);opacity:.3;border-radius:2px",
      }));
    }
    pageEl.appendChild(layer);
    const tools = Sideline.util.windowTools();
    if (tools.setTimeout) {
      tools.setTimeout(() => {
        try {
          layer.remove();
        }
        catch (error) {
          // 页面已被 React 重渲染时忽略
        }
      }, 1800);
    }
    return boxes.length;
  }

  /**
   * 跳回原文：滚动到目标页并在对应位置闪一下高亮（分层，先导航再等高亮）。
   *
   * 实测依据（本机 Zotero 10.0.3，omni.ja 解包到 runtime/zotero-probe/）：
   * 1) chrome/content/zotero/xpcom/reader.js:755 `async navigate(location)`，
   *    它把 location cloneInto 阅读器 iframe 后交给 _internalReader；
   * 2) resource/reader/reader.js 里 PDF 视图的 navigate 分支：
   *    `Number.isInteger(location.pageIndex)` → `pdfViewer.scrollPageIntoView({pageNumber: pageIndex + 1})`；
   *    `location.position` → navigateToPosition(position) 并高亮该位置；
   * 3) 页面滚动容器是阅读器 iframe 里的 `#viewerContainer`，.page 由 pdf.js 虚拟渲染
   *    按需创建/回收，因此「立即 querySelector + scrollIntoView」在真机上会
   *    取不到元素（报尚未渲染）或滚错容器。
   * 所以顺序是：Zotero navigate → pdf.js scrollPageIntoView → .page.scrollIntoView；
   * 需要画高亮（传了 rects）时再轮询等目标页渲染出来，无 rects 时不等待。
   *
   * ok 的语义是「跳转有没有完成」，高亮只是附加效果：
   * 1) 没有 rects（回答里的页码链接）：三层导航里任意一层成功即 ok:true，不等页面元素，flashed 恒为 0；
   * 2) 有 rects 且页面渲染出来：ok:true，画高亮并给出 flashed；
   * 3) 有 rects 但页面始终没渲染出来：只要有一层导航成功就仍判 ok:true（flashed:0，reason 说明未画高亮），
   *    因为虚拟渲染下 .page 是按需创建的，页面没出现不代表翻页动作没生效；
   * 4) 三层导航全失败：ok:false，reason 逐层汇总。
   *
   * @param {object} options pageIndex 必填；rects 为页面空间矩形（可省略，省略时只翻页）
   * @returns {Promise<{ok:boolean, pageIndex:number, reason:string, flashed:number}>} 不抛异常
   */
  async function jump(reader, options = {}) {
    const index = Math.max(0, parseInt(options.pageIndex, 10) || 0);
    const out = { ok: false, pageIndex: index, reason: "", flashed: 0 };
    const context = jumpContext(reader, index);
    if (!context.doc) {
      out.reason = "拿不到阅读器文档（reader 未初始化或 iframe 未就绪）";
      return out;
    }

    // 第一层：Zotero 阅读器自己的导航接口（它会等待 initializedPromise，并由 pdf.js 换页）
    let navigated = false;
    const failures = [];
    const readerObject = reader || null;
    const navigateFn = typeof own(readerObject, "navigate") === "function"
      ? own(readerObject, "navigate").bind(readerObject)
      : null;
    if (navigateFn) {
      const tools = Sideline.util.windowTools();
      let timedOut = false;
      const guard = tools.setTimeout
        ? new Promise((resolve) => {
          tools.setTimeout(() => {
            timedOut = true;
            resolve();
          }, 1500);
        })
        : null;
      try {
        // navigate 会等 initializedPromise；加超时守卫，避免阅读器未就绪时永远 await
        await (guard
          ? Promise.race([Promise.resolve(navigateFn(Array.isArray(options.rects) && options.rects.length
              ? { position: { pageIndex: index, rects: options.rects } } : { pageIndex: index })), guard])
          : Promise.resolve(navigateFn(Array.isArray(options.rects) && options.rects.length
              ? { position: { pageIndex: index, rects: options.rects } } : { pageIndex: index })));
        // 超时守卫自己也会 resolve 竞速，因此用标志位判定是哪一边先返回
        if (timedOut) failures.push("reader.navigate 超过 1.5 秒未返回");
        else navigated = true;
      }
      catch (error) {
        failures.push(`reader.navigate 失败：${Sideline.util.message(error)}`);
      }
    }
    else failures.push("阅读器实例没有 navigate 接口");

    // 第二层：pdf.js 的规范做法（Zotero 的 PDF 视图内部就是这一步）
    if (!navigated) {
      try {
        if (await scrollViaPdfjs(context.win, index)) navigated = true;
        else failures.push("pdf.js 的 pdfViewer.scrollPageIntoView 不可用");
      }
      catch (error) {
        failures.push(`pdf.js 翻页失败：${Sideline.util.message(error)}`);
      }
    }

    // 第三层：直接滚页元素
    if (!navigated) {
      try {
        if (await scrollViaElement(context.pageEl)) navigated = true;
        else failures.push(`第 ${index + 1} 页尚未渲染，页元素不可滚动`);
      }
      catch (error) {
        failures.push(`页元素滚动失败：${Sideline.util.message(error)}`);
      }
    }

    // Zotero 的 position 导航会滚到句子并用原生 _highlightPosition 短暂高亮。
    // 避免在 Xray 包装或虚拟页面上再画一层偏移的浮层。
    if (navigated && navigateFn && !failures.length && Array.isArray(options.rects) && options.rects.length) {
      out.ok = true; out.flashed = options.rects.length; return out;
    }
    // 回答里的页码链接（attachPageRefs）只传 pageIndex：翻页动作发出就已经满足需求，
    // 不必等 .page 元素。pdf.js 虚拟渲染不会立刻建出远处页面的 DOM，原来在这里轮询，
    // 超时后会把已经生效的翻页误报成「跳转失败」（用户截图就是这个现象）。
    const wantsFlash = Array.isArray(options.rects) && options.rects.length > 0;
    if (!wantsFlash) {
      if (navigated) {
        out.ok = true;
        return out;
      }
      out.reason = `第 ${index + 1} 页没能跳过去：${failures.join("；") || "没有可用的导航接口"}`;
      return out;
    }

    // 有 rects 才需要等页面真的渲染出来再画高亮（pdf.js 虚拟渲染按需创建目标页 DOM）
    const waited = await waitPage(context.win, index);
    const pageEl = waited.pageEl
      // 挂 navigate 的窗口与 pdf.js 所在窗口不一定是同一个，渲染判定要两个都看
      || pageElement(reader && reader._iframeWindow, index);
    if (!pageEl) {
      if (!navigated) {
        // 三层导航全失败，页面也没渲染出来：如实报失败并逐层给原因
        out.reason = `第 ${index + 1} 页没能跳过去：页面在 1.5 秒内没有渲染出来`
          + (failures.length ? `（${failures.join("；")}）` : "");
        return out;
      }
      // 三层里至少有一层返回成功 = 翻页动作已经发出并生效，只是页面还没渲染出来；
      // 高亮只是附加效果，画不出来不代表跳转失败，因此这里仍返回成功。
      out.ok = true;
      out.reason = `已跳到第 ${index + 1} 页，但页面在 1.5 秒内没有渲染出来，因此没有画高亮`
        + (failures.length ? `（${failures.join("；")}）` : "");
      return out;
    }
    if (!navigated) {
      // 页元素出现了，但三层导航都没成功：不能假装跳转完成，也不画高亮
      out.reason = `第 ${index + 1} 页没能跳过去：${failures.join("；") || "没有可用的导航接口"}`
        + "（目标页已经渲染出来，但没有任何一层导航生效）";
      return out;
    }
    out.ok = true;

    const boxes = await cssRects(reader, index, options.rects);
    if (!boxes.length) {
      out.reason = "坐标换算失败，只完成了翻页";
      return out;
    }
    try {
      out.flashed = flashRects(pageEl.ownerDocument || context.doc, pageEl, boxes);
    }
    catch (error) {
      out.reason = `高亮浮层插入失败：${Sideline.util.message(error)}`;
      return out;
    }
    return out;
  }

  /** 取指定页的纯文本（片段之间按 pdf.js 的 hasEOL 断行） */
  async function pageText(reader, pageIndex) {
    const record = await page(reader, pageIndex);
    return joinSpans(record.spans);
  }

  function joinSpans(spans) {
    const parts = [];
    for (const span of spans) {
      parts.push(span.str);
      if (span.hasEOL) parts.push("\n");
    }
    return parts.join("").replace(/[ \t]+\n/g, "\n").trim();
  }

  /**
   * 拼装用于上下文的正文。
   * @param {object} options pageIndexes 只取这些页（0 基）；maxChars 上限；markPages 是否加页码标记
   */
  async function documentText(reader, options = {}) {
    const total = pageCount(reader) || (Array.isArray(options.pageIndexes) ? options.pageIndexes.length : 0);
    const wanted = Array.isArray(options.pageIndexes) && options.pageIndexes.length
      ? options.pageIndexes.map((value) => Math.max(0, parseInt(value, 10) || 0))
      : Array.from({ length: total }, (unused, index) => index);
    const limit = options.maxChars > 0 ? options.maxChars : 0;
    const out = {
      text: "",
      chars: 0,
      totalChars: 0,
      pages: [],
      emptyPages: [],
      failedPages: [],
      truncated: false,
      pageCount: total,
    };
    const blocks = [];
    for (const index of wanted) {
      const record = await page(reader, index);
      if (record.state === "ok") {
        out.pages.push(record.pageIndex);
        out.totalChars += record.chars;
        const label = record.label || String(index + 1);
        const body = joinSpans(record.spans);
        blocks.push(options.markPages === false ? body : `【第 ${label} 页】\n${body}`);
      }
      else if (record.state === "empty") {
        out.emptyPages.push(record.pageIndex);
      }
      else {
        out.failedPages.push({ pageIndex: record.pageIndex, error: record.error });
      }
    }
    let text = blocks.join("\n\n");
    if (limit && text.length > limit) {
      text = text.slice(0, limit);
      out.truncated = true;
    }
    out.text = text;
    out.chars = text.length;
    return out;
  }

  /**
   * 全文覆盖状态（R10）：逐页取文并统计成功/空白/失败页。
   * 空白页与失败页必须分别报告：前者可能是扫描页需要 OCR，后者是取文通道出错。
   */
  async function coverage(reader, options = {}) {
    const total = pageCount(reader);
    const maxPages = options.maxPages > 0 ? options.maxPages : total;
    const out = {
      pageCount: total,
      scanned: 0,
      okPages: [],
      emptyPages: [],
      failedPages: [],
      totalChars: 0,
      source: "",
    };
    for (let index = 0; index < Math.min(total, maxPages); index++) {
      const record = await page(reader, index, { refresh: options.refresh === true });
      out.scanned++;
      if (record.source) out.source = record.source;
      if (record.state === "ok") {
        out.okPages.push(index);
        out.totalChars += record.chars;
      }
      else if (record.state === "empty") {
        out.emptyPages.push(index);
      }
      else {
        out.failedPages.push({ pageIndex: index, error: record.error });
      }
    }
    out.complete = out.scanned >= total;
    return out;
  }

  /** 把「纸面页码」解析成 0 基页索引；支持 "3"、"3-5"、"3,5" */
  async function pagesFromLabels(reader, spec) {
    const labels = await pageLabels(reader);
    if (!labels) return { pages: [], error: "该 PDF 没有页码标签" };
    const tokens = String(spec || "").split(/[,，、\s]+/).filter(Boolean);
    const pages = [];
    for (const token of tokens) {
      const range = token.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
      if (range) {
        for (let value = parseInt(range[1], 10); value <= parseInt(range[2], 10); value++) {
          pages.push(String(value));
        }
      }
      else {
        pages.push(token.replace(/^p{1,2}\.?/i, ""));
      }
    }
    const indexes = [];
    const missing = [];
    for (const wanted of pages) {
      const index = labels.findIndex((label) => label === wanted);
      if (index >= 0) indexes.push(index);
      else missing.push(wanted);
    }
    return { pages: [...new Set(indexes)].sort((a, b) => a - b), missing, labels };
  }

  function clearCache(itemID) {
    if (itemID === undefined) {
      pageCache.clear();
      labelsCache.clear();
      return;
    }
    const prefix = `${itemID}:`;
    for (const key of [...pageCache.keys()]) {
      if (String(key).startsWith(prefix)) pageCache.delete(key);
    }
    labelsCache.delete(itemID);
  }

  function cacheStats() {
    return { pages: pageCache.size, labels: labelsCache.size };
  }

  return {
    readers,
    firstReader,
    resolve,
    page,
    pageCount,
    pageLabels,
    labelOf,
    pageText,
    joinSpans,
    documentText,
    coverage,
    locate,
    rectsForRange,
    mergeRects,
    cssRects,
    jump,
    pagesFromLabels,
    clearCache,
    cacheStats,
  };
})();
