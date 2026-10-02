/*
 * Zotero Sideline：材料采集（R09）。
 *
 * 功能：把用户粘贴的文字/链接/路径解析成可核对的材料：Zotero 条目链接（zotero://select/…）、
 *       DOI 或 arXiv 号（在当前库里查条目）、本地文件路径（文本 / 图片 / 当前条目的 PDF 附件）、
 *       其它链接与纯文本；图片读成 base64 data URL，供视觉通道使用。
 * 输入：粘贴的字符串，或通过文件选择器选中的路径。
 * 输出：{ok, kind, fields, descriptor, reason}；fields 直接交给 materials.from*（path/item/image/paste）。
 * 依赖：Zotero.File.getBinaryContentsAsync（或 IOUtils）、Zotero.Search、nsIFilePicker
 *       （父窗口取主窗口：Zotero.getMainWindow()，见 pickerWindow；init() 的第一个参数只收
 *        browsingContext，见 pickerParent；Zotero 10.0.3 的 Gecko 140 已删掉同步 show()，
 *        同步契约由 showPickerSync 的嵌套事件循环维持）、util.base64FromBytes。
 *
 * 设计说明：
 * 1) 路径必须解析到真实实体：读不到文件就返回 ok:false 与原因，不把路径当正文塞进上下文；
 * 2) 任意 PDF 无法直接取文（Zotero 只索引导入过的附件），因此只有当该路径等于**当前条目的附件**
 *    时才给出可用的正文材料，否则明确说明要先把 PDF 作为附件导入；
 * 3) 插件不联网下载：http(s) 链接只作为文本入上下文，并在材料说明里写清楚；
 * 4) 图片大小按 DeepSeek 的限制把关（单图 32 MiB 硬上限，8 MiB 以上提示可能变慢）；
 * 5) 文件选择器不用 Zotero 的 modules/filePicker.mjs：它没有同步入口（show() 返回 Promise，
 *    内部就是 await nsIFilePicker.open()），而 pickFiles/pickSavePath 的对外契约是同步返回，
 *    所以沿用原生 picker，自己传 browsingContext、自己等回调（见 showPickerSync）。
 */

Sideline.inputs = (function () {
  const TEXT_EXTENSIONS = ["txt", "md", "markdown", "json", "csv", "tsv", "tex", "html", "htm",
    "xml", "yaml", "yml", "log", "bib", "rst"];
  const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
  const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
  const WARN_IMAGE_BYTES = 8 * 1024 * 1024;
  const DEFAULT_FILE_MAX_CHARS = 20000;

  const MIME_BY_EXT = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };

  function extensionOf(path) {
    const match = String(path == null ? "" : path).match(/\.([A-Za-z0-9]+)\s*$/);
    return match ? match[1].toLowerCase() : "";
  }

  function mimeOf(path, fallback) {
    return MIME_BY_EXT[extensionOf(path)] || fallback || "application/octet-stream";
  }

  function baseName(path) {
    return String(path == null ? "" : path).split(/[\\/]/).filter(Boolean).pop() || String(path || "");
  }

  /** zotero://select/library/items/<KEY> 或 zotero://select/groups/<id>/items/<KEY> */
  function parseZoteroLink(value) {
    const match = String(value == null ? "" : value).trim()
      .match(/^zotero:\/\/select\/(?:([a-zA-Z]+)\/)?(?:([0-9]+)\/)?items\/([A-Za-z0-9]{8})/);
    if (!match) return null;
    return { scope: match[1] || "library", groupID: match[2] || "", key: match[3].toUpperCase() };
  }

  function parseDoi(value) {
    const text = String(value == null ? "" : value).trim();
    const match = text.match(/\b(10\.[0-9]{4,9}\/[-._;()/:A-Za-z0-9]+)\b/);
    return match ? match[1].replace(/[.,;]$/, "") : null;
  }

  function parseArxiv(value) {
    const text = String(value == null ? "" : value).trim();
    const modern = text.match(/\b(\d{4}\.\d{4,5})(v\d+)?\b/);
    if (modern) return modern[1];
    const legacy = text.match(/\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/i);
    return legacy ? legacy[1] : null;
  }

  /** 判断粘贴内容的类型（顺序即优先级：条目链接 → 文件路径 → 链接 → DOI/arXiv → 纯文本） */
  function classifyText(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return { kind: "empty", value: "", detail: "内容为空" };
    const link = parseZoteroLink(text);
    if (link) return { kind: "zotero-item", value: text, key: link.key, detail: `Zotero 条目 ${link.key}` };
    if (/^file:\/\//i.test(text)) {
      return { kind: "file-path", value: decodeURIComponent(text.replace(/^file:\/\//i, "")), detail: "本地文件" };
    }
    if (/^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text) || /^\//.test(text)) {
      const ext = extensionOf(text);
      if (IMAGE_EXTENSIONS.includes(ext)) return { kind: "image-path", value: text, detail: `图片 ${ext}` };
      return { kind: "file-path", value: text, detail: ext ? `文件 ${ext}` : "文件" };
    }
    if (/^https?:\/\//i.test(text)) {
      const doi = parseDoi(text);
      if (doi) return { kind: "doi", value: doi, detail: `DOI ${doi}` };
      const arxiv = /arxiv\.org/i.test(text) ? parseArxiv(text) : null;
      if (arxiv) return { kind: "arxiv", value: arxiv, detail: `arXiv ${arxiv}` };
      return { kind: "url", value: text, detail: "外部链接（不会下载）" };
    }
    const bareDoi = /^10\.\d{4,9}\//.test(text) ? parseDoi(text) : null;
    if (bareDoi) return { kind: "doi", value: bareDoi, detail: `DOI ${bareDoi}` };
    if (/^arxiv:/i.test(text)) {
      const arxiv = parseArxiv(text);
      if (arxiv) return { kind: "arxiv", value: arxiv, detail: `arXiv ${arxiv}` };
    }
    return { kind: "text", value: text, detail: `${text.length} 字文本` };
  }

  /** 读原始字节；优先 IOUtils（父进程可用），退回 Zotero.File.getBinaryContentsAsync */
  async function readBinary(path) {
    try {
      if (typeof IOUtils !== "undefined" && IOUtils && typeof IOUtils.read === "function") {
        return await IOUtils.read(path);
      }
    }
    catch (error) {
      Sideline.util.warn(`IOUtils 读取失败，改用 Zotero.File：${Sideline.util.message(error)}`);
    }
    const binary = String(await Zotero.File.getBinaryContentsAsync(path) || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index) & 0xff;
    return bytes;
  }

  async function readImage(path) {
    const bytes = await readBinary(path);
    if (!bytes || !bytes.length) throw new Error("图片文件为空");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`图片 ${(bytes.length / 1048576).toFixed(1)} MiB 超过 ${MAX_IMAGE_BYTES / 1048576} MiB 上限`);
    }
    const dataUrl = `data:${mimeOf(path)};base64,${Sideline.util.base64FromBytes(bytes)}`;
    return {
      dataUrl,
      bytes: bytes.length,
      mime: mimeOf(path),
      warning: bytes.length > WARN_IMAGE_BYTES
        ? `图片 ${(bytes.length / 1048576).toFixed(1)} MiB 较大，请求会更慢也更贵`
        : "",
    };
  }

  async function readTextFile(path, options = {}) {
    const limit = options.maxChars > 0 ? options.maxChars : DEFAULT_FILE_MAX_CHARS;
    const raw = String(await Zotero.File.getContentsAsync(path) || "");
    const cut = Sideline.util.truncate(raw, limit);
    return { text: cut.text, truncated: cut.truncated, totalChars: raw.length };
  }

  /** 当前条目的附件清单（含本地路径），用于把路径匹配到 Zotero 附件 */
  async function attachmentsOf(item) {
    const out = [];
    const push = async (candidate) => {
      if (!candidate) return;
      let path = "";
      try {
        path = String(await candidate.getFilePathAsync() || "");
      }
      catch (error) {
        path = "";
      }
      out.push({
        id: candidate.id,
        key: candidate.key,
        title: String((candidate.getField && candidate.getField("title")) || ""),
        contentType: String(candidate.attachmentContentType || ""),
        path,
      });
    };
    if (!item) return out;
    if (typeof item.isAttachment === "function" && item.isAttachment()) {
      await push(item);
      if (item.parentID) {
        const parent = Zotero.Items.get(item.parentID);
        if (parent && typeof parent.getAttachments === "function") {
          const ids = parent.getAttachments() || [];
          for (const id of ids) await push(Zotero.Items.get(id));
        }
      }
      return out;
    }
    if (typeof item.getAttachments === "function") {
      for (const id of item.getAttachments() || []) await push(Zotero.Items.get(id));
    }
    return out;
  }

  async function searchItems(condition, operator, value) {
    const out = [];
    try {
      const libraries = Zotero.Libraries.getAll ? Zotero.Libraries.getAll() : [];
      for (const library of libraries) {
        const search = new Zotero.Search();
        search.libraryID = library.libraryID;
        search.addCondition(condition, operator, String(value));
        // eslint-disable-next-line no-await-in-loop
        const ids = await search.search() || [];
        for (const id of ids) {
          const item = Zotero.Items.get(id);
          if (item && !item.deleted) out.push(item);
        }
      }
    }
    catch (error) {
      Sideline.util.warn(`按 ${condition} 检索条目失败：${Sideline.util.message(error)}`);
    }
    return out;
  }

  /** 条目 → item 材料（元数据 + 可选正文） */
  async function itemMaterial(item, options = {}) {
    const isRegular = typeof item.isRegularItem === "function" && item.isRegularItem();
    const target = isRegular ? item : (item.parentID ? Zotero.Items.get(item.parentID) : item);
    const lines = Sideline.context.metadataLines(target || item);
    const fields = {
      itemID: (target || item).id,
      title: String(((target || item).getField && (target || item).getField("title")) || ""),
      text: lines,
      detail: `条目 #${(target || item).id}｜${lines.split("\n").length} 个字段`,
      source: `item:${(target || item).id}`,
    };
    if (options.includeFulltext) {
      const attachment = await Sideline.context.resolveAttachment(target || item);
      if (attachment) {
        const full = await Sideline.context.fullText(attachment, options.maxChars);
        if (full.text) {
          fields.text = `${lines}\n\n${full.text}`;
          fields.detail = `条目 #${target.id}｜含正文 ${full.chars}/${full.totalChars} 字`;
        }
      }
    }
    return fields;
  }

  /**
   * 解析一段粘贴内容。
   * @param {string} value 粘贴的文字
   * @param {object} options item 当前条目（用于路径匹配与 DOI 回退）；maxChars；includeFulltext
   * @returns {Promise<{ok:boolean, kind:string, fields:object, descriptor:object, reason:string}>}
   */
  async function resolve(value, options = {}) {
    const descriptor = classifyText(value);
    const fail = (reason) => ({ ok: false, kind: descriptor.kind, fields: {}, descriptor, reason });
    try {
      if (descriptor.kind === "empty") return fail("内容为空");
      if (descriptor.kind === "text") {
        return {
          ok: true,
          kind: "paste",
          descriptor,
          fields: { text: descriptor.value, detail: descriptor.detail, source: `paste:${descriptor.value.length}` },
          reason: "",
        };
      }
      if (descriptor.kind === "url") {
        return {
          ok: true,
          kind: "paste",
          descriptor,
          fields: {
            text: descriptor.value,
            label: `链接：${descriptor.value.replace(/^https?:\/\//i, "").split("/")[0]}`,
            detail: "外部链接（插件不下载页面，只把链接文本送入上下文）",
            source: `url:${descriptor.value}`,
          },
          reason: "",
        };
      }
      if (descriptor.kind === "zotero-item") {
        let item = null;
        try {
          item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, descriptor.key);
        }
        catch (error) {
          item = null;
        }
        if (!item && Zotero.Items.getByLibraryAndKey) {
          item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, descriptor.key);
        }
        if (!item) return fail(`在当前库里找不到条目 ${descriptor.key}`);
        return {
          ok: true,
          kind: "item",
          descriptor,
          fields: await itemMaterial(item, options),
          reason: "",
        };
      }
      if (descriptor.kind === "doi" || descriptor.kind === "arxiv") {
        const condition = descriptor.kind === "doi" ? "DOI" : "extra";
        const matches = await searchItems(condition, descriptor.kind === "doi" ? "is" : "contains", descriptor.value);
        if (!matches.length) {
          return fail(`当前库里没有 ${descriptor.kind === "doi" ? "DOI" : "arXiv"} 为 ${descriptor.value} 的条目`);
        }
        if (matches.length > 1) {
          return fail(`匹配到 ${matches.length} 个条目，请改用 zotero:// 链接或直接拖入条目`);
        }
        return {
          ok: true,
          kind: "item",
          descriptor,
          fields: await itemMaterial(matches[0], options),
          reason: "",
        };
      }
      if (descriptor.kind === "image-path") {
        const image = await readImage(descriptor.value);
        return {
          ok: true,
          kind: "image",
          descriptor,
          fields: {
            name: baseName(descriptor.value),
            dataUrl: image.dataUrl,
            detail: `${image.mime}｜${(image.bytes / 1024).toFixed(0)} KiB`
              + (image.warning ? `｜${image.warning}` : ""),
            source: `image:${descriptor.value}`,
          },
          reason: "",
        };
      }
      if (descriptor.kind === "file-path") {
        const path = descriptor.value;
        if (!Sideline.jsonfile.exists(path)) return fail(`文件不存在：${path}`);
        const ext = extensionOf(path);
        // 与当前条目的附件路径一致时，PDF/EPUB 可以直接用 Zotero 的正文索引
        const attachments = await attachmentsOf(options.item);
        const matched = attachments.find((entry) => entry.path && samePath(entry.path, path));
        if (matched && /application\/(pdf|epub)/.test(matched.contentType)) {
          const item = Zotero.Items.get(matched.id);
          const full = await Sideline.context.fullText(item, options.maxChars);
          if (!full.text) return fail(`附件已找到，但正文不可用（${Sideline.context.stateText(full.state)}）`);
          return {
            ok: true,
            kind: "path",
            descriptor,
            fields: {
              path,
              name: matched.title || baseName(path),
              text: full.text,
              detail: `Zotero 附件 #${matched.id}｜${full.chars}/${full.totalChars} 字`,
              source: `path:${path}`,
            },
            reason: "",
          };
        }
        if (TEXT_EXTENSIONS.includes(ext)) {
          const file = await readTextFile(path, options);
          return {
            ok: true,
            kind: "path",
            descriptor,
            fields: {
              path,
              name: baseName(path),
              text: file.text,
              detail: `${file.text.length}/${file.totalChars} 字${file.truncated ? "（已截断）" : ""}`,
              source: `path:${path}`,
            },
            reason: "",
          };
        }
        if (ext === "pdf" || ext === "epub") {
          return fail("该 PDF 不是当前条目的 Zotero 附件，Zotero 没有它的正文索引；请先把它作为附件加到条目下再导入");
        }
        if (IMAGE_EXTENSIONS.includes(ext)) {
          const image = await readImage(path);
          return {
            ok: true,
            kind: "image",
            descriptor,
            fields: {
              name: baseName(path),
              dataUrl: image.dataUrl,
              detail: `${image.mime}｜${(image.bytes / 1024).toFixed(0)} KiB`,
              source: `image:${path}`,
            },
            reason: "",
          };
        }
        return fail(`暂不支持的文件类型：${ext || "无扩展名"}`);
      }
      return fail(`无法识别的输入类型：${descriptor.kind}`);
    }
    catch (error) {
      return fail(Sideline.util.message(error));
    }
  }

  function samePath(a, b) {
    const norm = (value) => String(value == null ? "" : value).replace(/\\/g, "/").toLowerCase();
    return norm(a) === norm(b);
  }

  /**
   * 文件选择器的父窗口。
   * 必须给**主窗口**：调用方传来的 options.win 是阅读器 iframe 里的窗口，
   * nsIFilePicker.init() 用它做父窗口时弹不出对话框（Zotero 自己的
   * modules/filePicker.mjs 也是取主窗口的 browsingContext）。
   * 顺序：Zotero.getMainWindow() → util.mainWindows()[0] → Services.wm 的最近浏览器窗口 → 调用方传入。
   */
  function pickerWindow(options = {}) {
    try {
      if (typeof Zotero.getMainWindow === "function") {
        const win = Zotero.getMainWindow();
        if (win) return win;
      }
    }
    catch (error) {
      // 落到下面的兜底
    }
    const main = Sideline.util.mainWindows()[0];
    if (main) return main;
    try {
      if (Services && Services.wm && typeof Services.wm.getMostRecentWindow === "function") {
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        if (win) return win;
      }
    }
    catch (error) {
      // 无窗口管理器时忽略
    }
    return options.win || null;
  }

  /**
   * 父窗口 → nsIFilePicker.init() 的第一个参数。
   * Zotero 10.0.3 用的 Gecko 140 里签名是
   * `void init(in BrowsingContext browsingContext, in AString title, in nsIFilePicker_Mode mode)`，
   * 传窗口对象本身会直接抛
   * 「Could not convert JavaScript argument arg 0 [nsIFilePicker.init]」。
   * 只有老版本窗口上没有 browsingContext 属性时，才把窗口本身交给 init()。
   */
  function pickerParent(win) {
    if (!win) return null;
    return win.browsingContext || win;
  }

  /** 选择器是否正开着（嵌套事件循环期间挡住菜单的重复点击） */
  let pickerBusy = false;

  /**
   * 同步显示选择器并返回结果码。
   * Gecko 140 已经删掉 nsIFilePicker.show()，只剩异步 open(callback)；而 pickFiles /
   * pickSavePath 必须同步返回，所以这里用嵌套事件循环等回调——这正是旧 show() 的阻塞语义，
   * 也是 Zotero 自己 modules/filePicker.mjs:83 把 open() 包成 Promise 的那个原语。
   * 注意回调必须是普通函数而不是 Promise：Promise 的兑现要靠微任务检查点，
   * 在嵌套事件循环里不保证被及时 drain，会让循环等不到结果。
   * @param {object} picker nsIFilePicker 实例
   * @returns {{result:?number, error:string}} result 为 null 表示没能显示（error 写原因）
   */
  function showPickerSync(picker) {
    if (typeof picker.open === "function") {
      const thread = (typeof Services !== "undefined" && Services && Services.tm)
        ? Services.tm.currentThread
        : null;
      if (!thread || typeof thread.processNextEvent !== "function") {
        return { result: null, error: "拿不到主线程事件循环，无法打开文件选择器" };
      }
      let result = null;
      let done = false;
      picker.open((code) => {
        result = code;
        done = true;
      });
      while (!done) thread.processNextEvent(true);
      return { result, error: "" };
    }
    if (typeof picker.show === "function") {
      // 旧版 Gecko 仍有同步 show()，直接用
      return { result: picker.show(), error: "" };
    }
    return { result: null, error: "当前 Zotero 的 nsIFilePicker 既没有 open() 也没有 show()" };
  }

  /** 选择结果 → 路径数组（真实宿主给 nsISimpleEnumerator，测试宿主给数组） */
  function pickedPaths(picker) {
    const paths = [];
    const files = picker.files;
    if (files && typeof files.hasMoreElements === "function") {
      while (files.hasMoreElements()) {
        const file = files.getNext();
        paths.push(String(file.path || (file.QueryInterface
          ? file.QueryInterface(Components.interfaces.nsIFile).path : "")));
      }
    }
    else if (files && files.length !== undefined) {
      for (const file of files) paths.push(String(file.path || file));
    }
    return paths.filter(Boolean);
  }

  /**
   * 打开文件选择器。
   * @param {object} options imagesOnly 只选图片；multiple 允许多选
   * @returns {{cancelled:boolean, paths:string[], error?:string}} cancelled 为真且带 error 表示失败
   */
  function pickFiles(options = {}) {
    if (pickerBusy) return { cancelled: true, paths: [], error: "文件选择器已经打开，请先完成上一次选择" };
    pickerBusy = true;
    try {
      const win = pickerWindow(options);
      const parent = pickerParent(win);
      if (!parent) return { cancelled: true, paths: [], error: "拿不到 Zotero 主窗口，无法打开文件选择器" };
      const nsIFilePicker = Components.interfaces.nsIFilePicker;
      const picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
      picker.init(parent, options.title || "选择要加入对话的材料",
        options.multiple === false ? nsIFilePicker.modeOpen : nsIFilePicker.modeOpenMultiple);
      if (options.imagesOnly) picker.appendFilters(nsIFilePicker.filterImages);
      else {
        // 允许直接选 PDF：能否取到正文由 resolve 判断并给出可读原因
        picker.appendFilter("文本与 PDF 文件",
          "*.txt; *.md; *.json; *.csv; *.tex; *.html; *.xml; *.bib; *.pdf");
        picker.appendFilters(nsIFilePicker.filterImages);
        picker.appendFilters(nsIFilePicker.filterAll);
      }
      const shown = showPickerSync(picker);
      if (shown.error) return { cancelled: true, paths: [], error: shown.error };
      if (shown.result === nsIFilePicker.returnCancel) return { cancelled: true, paths: [] };
      return { cancelled: false, paths: pickedPaths(picker) };
    }
    catch (error) {
      return { cancelled: true, paths: [], error: Sideline.util.message(error) };
    }
    finally {
      pickerBusy = false;
    }
  }

  return {
    TEXT_EXTENSIONS,
    IMAGE_EXTENSIONS,
    MAX_IMAGE_BYTES,
    WARN_IMAGE_BYTES,
    DEFAULT_FILE_MAX_CHARS,
    extensionOf,
    mimeOf,
    baseName,
    parseZoteroLink,
    parseDoi,
    parseArxiv,
    classifyText,
    readBinary,
    readImage,
    readTextFile,
    attachmentsOf,
    itemMaterial,
    resolve,
    pickerWindow,
    pickerParent,
    showPickerSync,
    pickFiles,
  };
})();
