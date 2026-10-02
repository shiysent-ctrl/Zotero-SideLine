/*
 * Zotero Sideline 逻辑测试。
 *
 * 作用：在 Node 的 vm 沙箱里加载 src/ 下的真实代码，用假的 Zotero 对象替换宿主环境，
 *       检查配置解析、Markdown 渲染、上下文构建、会话与存档、笔记与批注写入、
 *       模型客户端（含 SSE 解析）、本机端点契约、启动诊断、侧栏与划词面板逻辑、激活事件
 *       绑定，以及 bootstrap 的注册/注销。
 * 输入：无参数；路径按本文件位置解析。
 * 输出：逐项 PASS/FAIL 与汇总；有失败时退出码为 1。
 * 边界：这不是 Zotero 内验证——界面渲染、真实 PDF 全文索引、真实模型调用仍需按
 *       docs/验收.md 在 Zotero 中人工验收。
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(projectRoot, "src");
const rootURI = "file:///sideline-test/src/";
const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"));

const results = [];
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  }
  else {
    failures++;
    results.push({ name, ok: false, detail });
    console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

function equal(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 src/prefs.js 解析默认首选项（键为完整名），顺带验证默认值本身可解析 */
function loadDefaultPrefs() {
  const text = fs.readFileSync(path.join(srcDir, "prefs.js"), "utf8");
  const store = {};
  const pattern = /pref\("(extensions\.zotero\.sideline\.[A-Za-z0-9_.]+)",\s*([\s\S]+?)\);/g;
  for (const match of text.matchAll(pattern)) {
    store[match[1]] = JSON.parse(match[2].trim());
  }
  return store;
}

// 与 Zotero.Prefs 一致：短名自动补 extensions.zotero. 前缀
function resolvePrefKey(name) {
  return name.startsWith("extensions.zotero.") ? name : `extensions.zotero.${name}`;
}

/** 最小 DOM 桩：只实现 util.element 与界面代码用到的那部分能力 */
function makeFakeElement(tag) {
  const classes = new Set();
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    parentNode: null,
    hidden: false,
    disabled: false,
    value: "",
    scrollTop: 0,
    scrollHeight: 0,
    style: {
      _props: {},
      setProperty(name, value) {
        this._props[name] = String(value);
      },
      getPropertyValue(name) {
        return this._props[name] || "";
      },
      removeProperty(name) {
        delete this._props[name];
      },
    },
    _text: "",
    _html: "",
    get text() {
      return element.textContent;
    },
    get textContent() {
      // innerHTML 设过的内容不解析成子节点，这里按纯文本粗略还原（去标签），
      // 便于断言「渲染后的回答里包含某段文字」
      const html = element._html ? String(element._html).replace(/<[^>]+>/g, "") : "";
      return element._text + element.children.map((child) => child.textContent).join("") + html;
    },
    set textContent(value) {
      element._text = String(value);
      element.children = [];
    },
    get innerHTML() {
      return element._html;
    },
    set innerHTML(value) {
      element._html = String(value);
      // innerHTML 变了，之前扫出来的节点桩作废
      element.__queryCache = null;
    },
    /** 是否挂在标记为文档根的节点下（readerside 用 isConnected 判断是否被 React 摘掉） */
    get isConnected() {
      let node = element;
      while (node) {
        if (node.__connected === true) return true;
        node = node.parentNode;
      }
      return false;
    },
    get options() {
      return element.children.filter((child) => child.tagName === "OPTION");
    },
    get selectedIndex() {
      const index = element.options
        .findIndex((option) => (option.attributes.value || option.value) === element.value);
      return index < 0 ? 0 : index;
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
      if (name.startsWith("data-")) {
        element.dataset[name.slice(5).replace(/-([a-z])/g, (match, char) => char.toUpperCase())] = String(value);
      }
    },
    getAttribute(name) {
      return element.attributes[name];
    },
    removeAttribute(name) {
      delete element.attributes[name];
    },
    appendChild(child) {
      element.children.push(child);
      child.parentNode = element;
      return child;
    },
    removeChild(child) {
      element.children = element.children.filter((entry) => entry !== child);
      child.parentNode = null;
      return child;
    },
    replaceChildren(...nodes) {
      element.children = nodes;
      for (const node of nodes) node.parentNode = element;
    },
    remove() {
      if (element.parentNode) element.parentNode.removeChild(element);
    },
    addEventListener(type, handler) {
      (element.listeners[type] = element.listeners[type] || []).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of element.listeners[type] || []) handler(Object.assign({ type }, event));
    },
    focus() {},
    /**
     * 0.8.0：菜单定位要量触发按钮与面板的矩形。默认给一个 300×400 的矩形，
     * 需要精确断言的用例可以直接设 `element.rect = {top,left,width,height}`。
     */
    getBoundingClientRect() {
      const rect = element.rect || { top: 0, left: 0, width: 300, height: 400 };
      const width = Number(rect.width) || 0;
      const height = Number(rect.height) || 0;
      return {
        top: Number(rect.top) || 0,
        left: Number(rect.left) || 0,
        width,
        height,
        bottom: (Number(rect.top) || 0) + height,
        right: (Number(rect.left) || 0) + width,
      };
    },
    querySelectorAll(selector) {
      // 带缓存：innerHTML 扫出来的节点桩要被界面代码与断言看到同一份（事件、类名）
      const key = String(selector);
      if (!element.__queryCache) element.__queryCache = new Map();
      if (!element.__queryCache.has(key)) element.__queryCache.set(key, queryAll(element, selector));
      return element.__queryCache.get(key);
    },
    querySelector(selector) {
      return element.querySelectorAll(selector)[0] || null;
    },
    classList: {
      add(name) {
        classes.add(String(name));
      },
      remove(name) {
        classes.delete(String(name));
      },
      contains(name) {
        return classes.has(String(name));
      },
      toggle(name, force) {
        const wanted = force === undefined ? !classes.has(String(name)) : !!force;
        if (wanted) classes.add(String(name));
        else classes.delete(String(name));
        return wanted;
      },
    },
  };
  // className 与 classList 共享同一份集合，避免出现「className 有、classList 没有」的不一致
  Object.defineProperty(element, "className", {
    get: () => [...classes].join(" "),
    set: (value) => {
      classes.clear();
      for (const name of String(value == null ? "" : value).split(/\s+/)) {
        if (name) classes.add(name);
      }
    },
  });
  return element;
}

/** 极简选择器：支持 tag、.class、#id、[attr="value"] 及其后代组合 */
function parseSelector(selector) {
  return String(selector).trim().split(/\s+/).map((part) => {
    const head = part.match(/^([a-zA-Z]*)(.*)$/);
    const spec = { tag: head[1] ? head[1].toUpperCase() : "", classes: [], id: "", attrs: {} };
    for (const token of head[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || []) {
      if (token[0] === ".") spec.classes.push(token.slice(1));
      else if (token[0] === "#") spec.id = token.slice(1);
      else {
        const attr = token.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"'\]]*)["']?)?$/);
        if (attr) spec.attrs[attr[1]] = attr[2] === undefined ? "" : attr[2];
      }
    }
    return spec;
  });
}

function matchesSpec(node, spec) {
  if (!node || !node.tagName) return false;
  if (spec.tag && node.tagName !== spec.tag) return false;
  if (spec.id && node.attributes.id !== spec.id) return false;
  const classes = String(node.className || "").split(/\s+/);
  if (!spec.classes.every((name) => classes.includes(name))) return false;
  for (const [key, value] of Object.entries(spec.attrs)) {
    if (node.attributes[key] === undefined) return false;
    if (value && String(node.attributes[key]) !== value) return false;
  }
  return true;
}

/** 按选择器查找节点（后代组合按顺序匹配祖先链） */
function queryAll(root, selector) {
  const chain = parseSelector(selector);
  const out = [];
  const walk = (node, depth) => {
    for (const child of node.children || []) {
      if (matchesSpec(child, chain[depth])) {
        if (depth === chain.length - 1) out.push(child);
        else walk(child, depth + 1);
      }
      walk(child, depth);
    }
    // 假宿主不解析 innerHTML，这里用正则扫一遍标签，供界面断言与事件绑定使用
    if (typeof node._html === "string" && node._html) {
      for (const stub of scanHtmlNodes(node._html, selector)) out.push(stub);
    }
  };
  walk(root, 0);
  return out;
}

/** 把 innerHTML 字符串里匹配单段选择器的标签扫成轻量节点（只支持 tag/.class/[attr]） */
function scanHtmlNodes(html, selector) {
  const chain = parseSelector(selector);
  if (chain.length !== 1) return [];
  const spec = chain[0];
  const out = [];
  const tagPattern = /<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\/?>/g;
  let match = tagPattern.exec(String(html));
  while (match) {
    const node = makeFakeElement(match[1].toLowerCase());
    const attrPattern = /([\w-]+)(?:="([^"]*)")?/g;
    let attr = attrPattern.exec(match[2] || "");
    while (attr) {
      if (attr[1] === "class") node.className = attr[2] || "";
      else node.setAttribute(attr[1], attr[2] === undefined ? "" : attr[2]);
      attr = attrPattern.exec(match[2] || "");
    }
    if (matchesSpec(node, spec)) out.push(node);
    match = tagPattern.exec(String(html));
  }
  return out;
}

function queryOne(root, selector) {
  return queryAll(root, selector)[0] || null;
}

function findAll(node, predicate, result = []) {
  if (predicate(node)) result.push(node);
  for (const child of node.children || []) {
    findAll(child, predicate, result);
  }
  return result;
}

function findByClass(node, className) {
  return findAll(node, (item) => String(item.className).split(/\s+/).includes(className))[0] || null;
}

function findByTag(node, tag) {
  return findAll(node, (item) => item.tagName === String(tag).toUpperCase())[0] || null;
}

function findByText(node, text) {
  return findAll(node, (item) => item.tagName === "BUTTON" && item.textContent.includes(text))[0] || null;
}

// ---- 假 Zotero 宿主 ----

const prefs = loadDefaultPrefs();
let httpResponder = null;
const calls = {
  http: [],
  indexItems: [],
  sections: [],
  sectionUnregister: [],
  readerListeners: [],
  readerUnregister: [],
  panes: [],
  paneUnregister: [],
  l10n: [],
  ftlResources: [],
  notes: [],
  annotations: [],
  clipboard: [],
  logs: [],
  menus: [],
  menuUnregister: [],
  progressWindows: [],
  alerts: [],
  confirmations: [],
  prompts: [],
  savedAttachments: [],
  importedAttachments: [],
  searches: [],
  navigate: [],
  scrollPageIntoView: [],
  pickerInit: [],
  pickerOpen: [],
};

const fakeFs = new Map();
/** 二进制文件表：路径 → 二进制字符串（每字符一字节），供 getBinaryContentsAsync 使用 */
const fakeBinaries = new Map();
const items = new Map();
const collections = new Map();
let noteCounter = 0;
let generatedKeys = 0;
/** 附件文件表：附件 ID → 文件路径；Attachments.importFromFile 会把源文件复制一份 */
const attachmentFiles = new Map();
let attachmentCounter = 60000;

/** 假的 Subprocess 模块：可脚本化 stdout/stderr/退出码，支持挂起与 kill */
const subprocessState = { stdout: "", stderr: "", exitCode: 0, stdin: "", killCount: 0, calls: [], hang: false };
const fakeSubprocess = {
  call: async (options) => {
    subprocessState.calls.push(options);
    let stdoutSent = false;
    let stderrSent = false;
    let resolveWait = null;
    const waitPromise = new Promise((resolve) => {
      resolveWait = resolve;
    });
    return {
      stdout: {
        read: subprocessState.rawChunks ? async () => subprocessState.rawChunks.shift() || new ArrayBuffer(0) : undefined,
        readString: async () => {
          if (stdoutSent) return "";
          stdoutSent = true;
          return subprocessState.stdout;
        },
      },
      stderr: {
        readString: async () => {
          if (stderrSent) return "";
          stderrSent = true;
          return subprocessState.stderr;
        },
      },
      stdin: {
        write: async (text) => {
          subprocessState.stdin += text;
        },
        close: async () => {},
      },
      wait: async () => {
        if (subprocessState.hang) return waitPromise;
        return { exitCode: subprocessState.exitCode };
      },
      kill: () => {
        subprocessState.killCount++;
        if (resolveWait) resolveWait({ exitCode: null });
      },
    };
  },
};

/** 假进度窗口：只实现 batch.js 用到的那几个方法 */
function FakeProgressWindow(options) {
  const win = this;
  this.options = options;
  this.headline = "";
  this.lines = [];
  this.closeTimer = 0;
  this.changeHeadline = (text) => {
    win.headline = String(text);
  };
  this.show = () => {
    calls.progressWindows.push(win);
  };
  this.startCloseTimer = (ms) => {
    win.closeTimer = ms;
  };
  this.ItemProgress = function FakeItemProgress(itemType, text) {
    this.itemType = itemType;
    this.text = String(text);
    this.progress = 0;
    this.error = false;
    this.setText = (value) => {
      this.text = String(value);
    };
    this.setProgress = (value) => {
      this.progress = value;
    };
    this.setError = () => {
      this.error = true;
    };
    win.lines.push(this);
  };
}

function makeRegularItem(options) {
  const item = {
    id: options.id,
    key: options.key || `KEY${options.id}`,
    libraryID: 1,
    parentID: null,
    deleted: false,
    _attachments: [],
    _notes: options.notes ? options.notes.slice() : [],
    fields: Object.assign({ extra: "" }, options.fields),
    tags: options.tags ? options.tags.map((tag) => ({ tag })) : [],
    saved: 0,
    isRegularItem: () => true,
    isAttachment: () => false,
    isNote: () => false,
    getField: (name) => item.fields[name] || "",
    setField: (name, value) => {
      item.fields[name] = String(value);
    },
    getCreators: () => options.creators || [],
    getBestAttachment: async () => options.attachment || null,
    getNotes: () => item._notes.slice(),
    getAttachments: () => item._attachments.slice(),
    getTags: () => item.tags.map((entry) => Object.assign({}, entry)),
    addTag: (tag) => {
      if (!item.tags.some((entry) => entry.tag.toLocaleLowerCase() === String(tag).toLocaleLowerCase())) {
        item.tags.push({ tag: String(tag) });
      }
    },
    removeTag: (tag) => {
      item.tags = item.tags.filter((entry) => entry.tag !== String(tag));
    },
    save: async () => {
      item.saved++;
    },
    saveTx: async () => {
      item.saved++;
    },
    eraseTx: async () => {
      item.deleted = true;
    },
  };
  items.set(item.id, item);
  return item;
}

/**
 * 假附件条目。
 * 会话存档需要一个能读写文件的附件：getFilePathAsync() 返回磁盘路径，
 * saveTx() 记录调用（store.markForUpload 会用它标记待上传）。
 */
function makeAttachment(options) {
  const item = {
    id: options.id,
    key: options.key || `ATT${options.id}`,
    libraryID: 1,
    parentID: options.parentID || null,
    deleted: false,
    attachmentContentType: options.contentType || "application/pdf",
    attachmentCharset: options.charset || "",
    attachmentSyncState: null,
    isRegularItem: () => false,
    isAttachment: () => true,
    isStoredFileAttachment: () => options.path !== undefined,
    getField: (name) => (name === "title" ? options.title || "Full Text PDF" : ""),
    getCreators: () => [],
    getFilePathAsync: async () => options.path || null,
    saveTx: async () => {
      calls.savedAttachments.push(item);
    },
  };
  if (options.path) attachmentFiles.set(item.id, options.path);
  items.set(item.id, item);
  if (item.parentID) {
    const parent = items.get(item.parentID);
    if (parent && Array.isArray(parent._attachments) && !parent._attachments.includes(item.id)) {
      parent._attachments.push(item.id);
    }
  }
  return item;
}

function makeNoteItem() {
  const note = {
    itemType: "note",
    id: 9000 + (noteCounter++),
    key: `NOTE${noteCounter}`,
    libraryID: null,
    parentID: null,
    note: "",
    saved: false,
    isNote: () => true,
    isAttachment: () => false,
    isRegularItem: () => false,
    deleted: false,
    setNote(html) {
      this.note = html;
    },
    getNote() {
      return this.note;
    },
    getField: () => "",
    async save() {
      this.saved = true;
      registerNoteChild(this);
      calls.notes.push(this);
    },
    async saveTx() {
      this.saved = true;
      registerNoteChild(this);
      calls.notes.push(this);
    },
    async eraseTx() {
      this.deleted = true;
      const parent = this.parentID ? items.get(this.parentID) : null;
      if (parent && Array.isArray(parent._notes)) {
        parent._notes = parent._notes.filter((id) => id !== this.id);
      }
    },
  };
  items.set(note.id, note);
  return note;
}

/** Zotero 在保存子笔记时会把它挂到父条目的子列表上；假宿主补上这一步 */
function registerNoteChild(note) {
  if (!note || !note.parentID) return;
  const parent = items.get(note.parentID);
  if (!parent || !Array.isArray(parent._notes)) return;
  if (!parent._notes.includes(note.id)) parent._notes.push(note.id);
}

const fakeWindow = {
  // 真机的主窗口有 browsingContext；nsIFilePicker.init() 要的正是它（Gecko 140 契约）
  browsingContext: { id: "bc-main" },
  fetch: null,
  AbortController: globalThis.AbortController,
  TextDecoder: globalThis.TextDecoder,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  document: {
    l10n: {
      addResourceIds: (ids) => calls.l10n.push(ids),
    },
  },
};

const Zotero = {
  version: "10.0.3-test",
  initializationPromise: Promise.resolve(),
  uiReadyPromise: Promise.resolve(),
  debug: (message) => calls.logs.push(message),
  warn: (message) => calls.logs.push(`WARN ${message}`),
  logError: (error) => calls.logs.push(`ERROR ${error && error.message ? error.message : error}`),
  getMainWindows: () => [fakeWindow],
  getMainWindow: () => fakeWindow,
  Prefs: {
    get: (name) => prefs[resolvePrefKey(name)],
    set: (name, value) => {
      prefs[resolvePrefKey(name)] = value;
    },
  },
  File: {
    getContentsAsync: async (filePath) => {
      if (fakeFs.has(filePath)) return fakeFs.get(filePath);
      throw new Error(`ENOENT: ${filePath}`);
    },
    getBinaryContentsAsync: async (filePath) => {
      if (!fakeBinaries.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
      return fakeBinaries.get(filePath);
    },
    putContentsAsync: async (filePath, data) => {
      fakeFs.set(filePath, String(data));
    },
    pathToFile: (filePath) => ({ path: filePath, exists: () => fakeFs.has(filePath.replace(/\\/g, "/")) }),
    createDirectoryIfMissingAsync: async () => {},
    removeIfExists: (filePath) => fakeFs.delete(filePath),
    getResourceAsync: async (url) => {
      const index = url.indexOf("content/");
      if (index < 0) throw new Error(`unexpected resource url: ${url}`);
      return fs.readFileSync(path.join(srcDir, url.slice(index)), "utf8");
    },
  },
  getTempDirectory: () => ({ path: "/fake-temp" }),
  Attachments: {
    LINK_MODE_IMPORTED_FILE: 0,
    LINK_MODE_LINKED_FILE: 2,
    /** 假 importFromFile：把源文件复制到 storage 目录并登记到父条目的附件列表 */
    importFromFile: async (options) => {
      const source = String(options.file);
      if (!fakeFs.has(source)) throw new Error(`importFromFile: 找不到源文件 ${source}`);
      const id = ++attachmentCounter;
      const target = `/fake-storage/${id}/sideline-sessions.json`;
      fakeFs.set(target, fakeFs.get(source));
      const attachment = makeAttachment({
        id,
        parentID: options.parentItemID,
        title: options.title,
        contentType: options.contentType,
        charset: options.charset,
        path: target,
      });
      calls.importedAttachments.push({ options, attachment, target });
      return attachment;
    },
  },
  Sync: { Storage: { Local: { SYNC_STATE_TO_UPLOAD: 1, SYNC_STATE_IN_SYNC: 0 } } },
  Libraries: { getAll: () => [{ libraryID: 1, name: "My Library" }], userLibraryID: 1 },
  /** 假 Zotero.Search：支持 itemType / title / DOI / extra 条件，用于 store.list() 与按标题/DOI 找条目 */
  Search: class FakeSearch {
    constructor() {
      this.libraryID = null;
      this.conditions = [];
    }

    addCondition(condition, operator, value) {
      this.conditions.push({ condition, operator, value });
    }

    async search() {
      calls.searches.push({ libraryID: this.libraryID, conditions: this.conditions.slice() });
      // 测试里有些条目是手写的轻量对象（可能没有 getField），这里统一兜底，避免桩自身抛错
      const readField = (item, name) => (typeof item.getField === "function"
        ? String(item.getField(name) || "") : "");
      let results = [...items.values()];
      for (const entry of this.conditions) {
        const needle = String(entry.value);
        if (entry.condition === "itemType" && needle === "attachment") {
          results = results.filter((item) => item.isAttachment && item.isAttachment());
          continue;
        }
        if (entry.condition === "title") {
          results = results.filter((item) => readField(item, "title").includes(needle));
          continue;
        }
        if (entry.condition === "DOI") {
          results = results.filter((item) => readField(item, "DOI") === needle);
          continue;
        }
        if (entry.condition === "extra") {
          results = results.filter((item) => readField(item, "extra").includes(needle));
          continue;
        }
        if (entry.condition === "itemType" && needle === "note") {
          results = results.filter((item) => item.isNote && item.isNote());
          continue;
        }
        if (entry.condition === "note") {
          results = results.filter((item) => (typeof item.getNote === "function"
            ? String(item.getNote() || "") : "").toLowerCase().includes(needle.toLowerCase()));
          continue;
        }
        // 其它条件在假宿主里不生效，返回空以暴露"依赖了未实现条件"的用例
        results = [];
      }
      return results.map((item) => item.id).filter((id) => Number.isFinite(id));
    }
  },
  DataDirectory: {
    dir: "/fake-data",
    getSubdirectory: (name) => `/fake-data/${name}`,
  },
  Fulltext: {
    canIndex: () => true,
    indexItems: async (ids, options) => {
      calls.indexItems.push({ ids, options });
    },
    getPages: async () => ({ indexedPages: 3, totalPages: 10 }),
    getIndexedState: async () => ({ indexed: true, partial: false }),
    getItemCacheFile: (item) => ({ path: `/fake/${item.id}/.zotero-ft-cache` }),
  },
  HTTP: {
    request: async (method, url, options) => {
      calls.http.push({ method, url, options });
      if (httpResponder) return httpResponder(method, url, options);
      const body = options && options.body ? JSON.parse(options.body) : {};
      return {
        response: {
          model: body.model || "unknown",
          choices: [{ message: { content: "  非流式回答  " } }],
          usage: { total_tokens: 11 },
        },
        responseText: "",
      };
    },
  },
  Items: {
    get: (id) => items.get(id) || null,
    getAsync: async (ids) => (Array.isArray(ids) ? ids.map((id) => items.get(id)).filter(Boolean) : []),
    getByLibraryAndKey: (libraryID, key) => [...items.values()]
      .find((item) => item.key === key) || null,
    getByLibraryAndKeyAsync: async (libraryID, key) => [...items.values()]
      .find((item) => item.key === key) || null,
  },
  DB: {
    executeTransaction: async (fn) => fn(),
  },
  Collections: {
    get: (id) => collections.get(id) || null,
  },
  MenuManager: {
    registerMenu: (options) => {
      calls.menus.push(options);
      return `MENU${calls.menus.length}`;
    },
    unregisterMenu: (id) => calls.menuUnregister.push(id),
  },
  ProgressWindow: FakeProgressWindow,
  DataObjectUtilities: {
    generateKey: () => `GEN${++generatedKeys}`,
  },
  Annotations: {
    saveFromJSON: async (attachment, json, options) => {
      calls.annotations.push({ attachment, json, options });
      return { itemType: "annotation", key: json.key, parentID: attachment.id };
    },
  },
  Item: makeNoteItem,
  Reader: {
    registerEventListener: (type, handler, pluginID) => calls.readerListeners.push({ type, handler, pluginID }),
    unregisterEventListener: (type, handler) => calls.readerUnregister.push({ type, handler }),
  },
  ItemPaneManager: {
    registerSection: (options) => {
      calls.sections.push(options);
      return `${options.pluginID}-${options.paneID}`;
    },
    unregisterSection: (id) => calls.sectionUnregister.push(id),
  },
  PreferencePanes: {
    register: async (options) => {
      calls.panes.push(options);
      return options.id;
    },
    unregister: (id) => calls.paneUnregister.push(id),
  },
  Server: { Endpoints: {} },
  ftl: {
    addResourceIds: (ids) => calls.ftlResources.push(ids),
  },
};

// ---- 建沙箱并加载真实源码 ----

/** 假文件选择器状态：Gecko 140 的 init(browsingContext)/open(callback) 契约要用到 */
const pickerState = { ret: 3, files: [], file: null, filters: [], openCallbacks: [] };

const context = vm.createContext({
  Sideline: {},
  Zotero,
  Components: {
    interfaces: {
      nsIClipboardHelper: {},
      // 0.7.1：文件选择器（pickFiles 只用这些常量与工厂）
      nsIFilePicker: {
        modeOpen: 0,
        modeOpenMultiple: 1,
        modeSave: 2,
        returnCancel: 3,
        returnOK: 4,
        filterImages: 5,
        filterAll: 6,
      },
    },
    classes: {
      "@mozilla.org/widget/clipboardhelper;1": {
        getService: () => ({ copyString: (text) => calls.clipboard.push(text) }),
      },
      "@mozilla.org/filepicker;1": {
        createInstance: () => ({
          init: (...args) => calls.pickerInit.push(args),
          appendFilter: (title, mask) => pickerState.filters.push(`f:${title}|${mask}`),
          appendFilters: (mask) => pickerState.filters.push(`m:${mask}`),
          // Gecko 140 只有 open(callback)（show() 已移除）；回调由假主线程在 processNextEvent 里触发
          open: (callback) => {
            pickerState.openCallbacks.push(callback);
            calls.pickerOpen.push(callback);
          },
          get files() {
            return pickerState.files;
          },
          get file() {
            return pickerState.file;
          },
        }),
      },
    },
  },
  Ci: {},
  Cc: {},
  Cu: {},
  ChromeUtils: {
    importESModule: (uri) => (String(uri).includes("Subprocess") ? { Subprocess: fakeSubprocess } : {}),
    import: (uri) => (String(uri).includes("Subprocess") ? { Subprocess: fakeSubprocess } : {}),
    waiveXrays: (value) => (value && value.__unwrapped ? value.__unwrapped : value),
  },
  Services: {
    // 假主线程：picker.open(cb) 之后由 processNextEvent 触发回调（对应真机的嵌套事件循环）
    tm: {
      currentThread: {
        processNextEvent: () => {
          const callback = pickerState.openCallbacks.shift();
          if (callback) callback(pickerState.ret);
          return true;
        },
      },
    },
    scriptloader: {
      loadSubScript: (url, scope) => {
        for (const [key, value] of Object.entries(scope)) {
          context[key] = value;
        }
        const relative = url.slice(rootURI.length);
        const code = fs.readFileSync(path.join(srcDir, relative), "utf8");
        vm.runInContext(code, context, { filename: relative });
      },
    },
    prompt: {
      alert: (win, title, text) => calls.alerts.push({ title, text }),
      confirm: (win, title, text) => {
        calls.confirmations.push({ title, text });
        return true;
      },
      prompt: (win, title, text, input) => {
        calls.prompts.push({ title, text, before: input.value });
        input.value = "重命名会话";
        return true;
      },
    },
  },
  console,
});

vm.runInContext(fs.readFileSync(path.join(srcDir, "bootstrap.js"), "utf8"), context, {
  filename: "bootstrap.js",
});
context.SidelineBootstrap.load(rootURI);
const Sideline = context.Sideline;

console.log("== 首选项面板片段 ==");
// Zotero 把片段嵌进 <div> 之后再按 XML 解析（_parseXHTMLToFragment），
// 文档中间的 <?xml?> 声明是语法错误，表现为「设置里能看到 Sideline 但点开空白」。
const paneFragment = fs.readFileSync(path.join(srcDir, "content/prefs-pane.xhtml"), "utf8")
  .replace(/^\uFEFF/, "");
check("pane: 片段不以 XML 声明开头", !paneFragment.trimStart().toLowerCase().startsWith("<?xml"));
check("pane: 片段以注释或元素开头", /^\s*(<!--|<[a-zA-Z])/.test(paneFragment));
check("pane: 含根元素 vbox 且闭合", /<vbox[\s>]/.test(paneFragment) && paneFragment.includes("</vbox>"));
check("pane: 每个 preference 都用完整键名",
  !/preference="(?!extensions\.zotero\.sideline\.)/.test(paneFragment));

console.log("");
console.log("== 激活事件绑定 ==");
const activateNode = makeFakeElement("button");
let activateRuns = 0;
Sideline.util.onActivate(activateNode, () => {
  activateRuns++;
});
activateNode.listeners.click[0]({ type: "click" });
activateNode.listeners.command[0]({ type: "command" });
equal("onActivate: 同一次激活的 command+click 只执行一次", activateRuns, 1);
activateNode.listeners.click[0]({ type: "click" });
equal("onActivate: 连续两次同类型点击都执行（不吞双击）", activateRuns, 2);

console.log("");
console.log("== 配置与端点规范化 ==");
equal("endpoint: 裸域名补 path", Sideline.config.endpoint("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
equal("endpoint: /v1 结尾去掉尾斜杠", Sideline.config.endpoint("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
equal("endpoint: 完整端点保持不变", Sideline.config.endpoint("https://x.example/v1/chat/completions"), "https://x.example/v1/chat/completions");
equal("endpoint: 空值返回空串", Sideline.config.endpoint("   "), "");
equal("config: 默认上下文模式来自 prefs.js", Sideline.config.read().contextMode, "metadata+fulltext");
check("config: 未填密钥时 configured 为假", Sideline.config.isConfigured() === false);
Zotero.Prefs.set("sideline.secretKey", "test-key");
const summary = Sideline.config.summary();
check("config: summary 标记密钥存在", summary.keyPresent === true);
check("config: summary 不回显密钥", !("secretKey" in summary) && !JSON.stringify(summary).includes("test-key"));

console.log("");
console.log("== 模板 ==");
const builtin = Sideline.prompts.list();
check(`prompts: 内置模板 ${builtin.length} 个`, builtin.length >= 6);
check("prompts: 内置含 translate/explain 且不含已删除的大纲模板",
  ["translate", "explain"].every((id) => builtin.some((entry) => entry.id === id))
  && !builtin.some((entry) => entry.id === "outline"));
Zotero.Prefs.set("sideline.prompts", JSON.stringify([{ name: "自定义", text: "自定义指令" }]));
equal("prompts: 自定义覆盖内置", Sideline.prompts.list().length, 1);
Zotero.Prefs.set("sideline.prompts", "{不是JSON}");
equal("prompts: JSON 非法时回落内置", Sideline.prompts.list().length, builtin.length);
Zotero.Prefs.set("sideline.prompts", "");
const subset = Sideline.prompts.subset("translate,explain");
check("prompts: subset 按 id 取模板", subset.length === 2 && subset[0].id === "translate");
check("prompts: subset 无效 id 时回落前三个", Sideline.prompts.subset("nope").length === 3);

console.log("");
console.log("== Markdown 渲染 ==");
const md = Sideline.util.markdownToHtml;
equal("md: 标题", md("## 结论"), "<h2>结论</h2>");
check("md: 段落在 <p> 内", md("普通一行").includes("<p>普通一行</p>"));
check("md: 行内代码与粗体", md("用 `x` 表示 **重点**").includes("<code>x</code>")
  && md("用 `x` 表示 **重点**").includes("<strong>重点</strong>"));
check("md: 链接", md("[站点](https://example.org/a)").includes('href="https://example.org/a"'));
check("md: 列表", md("- 甲\n- 乙").includes("<ul>") && md("- 甲\n- 乙").includes("<li>甲</li>"));
check("md: 有序列表", md("1. 甲\n2. 乙").includes("<ol>"));
const fence = md("```python\nprint('<b>')\n```");
check("md: 围栏代码块转义", fence.includes("&lt;b&gt;") && !fence.includes("<b>"));
const table = md("|项目|内容|\n|--|--|\n|方法|DFT|");
check("md: 表格", table.includes("<th>项目</th>") && table.includes("<td>DFT</td>"));
const xss = md("<img src=x onerror=alert(1)>");
check("md: 原始 HTML 被转义", xss.includes("&lt;img") && !xss.includes("<img"));
check("md: 引用", md("> 引用一行").includes("<blockquote>引用一行</blockquote>"));
const inlineMath = md("费米函数 $V(r)=-\\frac{V_R}{1+e^x}$ 用于势场。");
check("md: 行内公式交给内置 KaTeX 渲染",
  inlineMath.includes('class="sl-math sl-math-inline"') && inlineMath.includes('class="katex"'));
const displayMath = md("$$E=mc^2$$");
check("md: 行间公式交给内置 KaTeX 渲染",
  displayMath.includes('class="sl-math sl-math-display"') && displayMath.includes('class="katex-display"'));
check("md: 代码围栏中的美元符号不被当作公式",
  md("```text\n$not_math$\n```").includes("$not_math$")
  && !md("```text\n$not_math$\n```").includes("sl-math-inline"));
equal("truncate: 未超限不改写", Sideline.util.truncate("abc", 10).truncated, false);
check("truncate: 超限截断并标记", Sideline.util.truncate("abcdef", 3).text === "abc"
  && Sideline.util.truncate("abcdef", 3).truncated === true);
equal("escapeHtml: 转义尖括号与 &", Sideline.util.escapeHtml('<a href="x"> & </a>'), '&lt;a href="x"&gt; &amp; &lt;/a&gt;');
equal("escapeAttr: 额外转义引号", Sideline.util.escapeAttr('a "b"'), "a &quot;b&quot;");
check("timeText: 固定时间戳格式", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(Sideline.util.timeText(1700000000000)));

console.log("");
console.log("== 上下文构建 ==");
const attachment = makeAttachment({ id: 200, parentID: 100 });
const paper = makeRegularItem({
  id: 100,
  fields: {
    title: "核结构中的手征有效场论",
    date: "2024-05-01",
    publicationTitle: "Physical Review C",
    DOI: "10.1103/PhysRevC.100.000000",
    abstractNote: "本文讨论……",
  },
  creators: [{ firstName: "San", lastName: "Zhang" }],
  attachment,
});
fakeFs.set("/fake/200/.zotero-ft-cache", "甲".repeat(120));

const metaOnly = await Sideline.context.build(paper, { mode: "metadata" });
check("context: metadata 模式含标题", metaOnly.text.includes("标题：核结构中的手征有效场论"));
check("context: 作者按 first+last 拼接", metaOnly.text.includes("San Zhang"));
equal("context: metadata 模式不请求全文", metaOnly.stats.fullTextState, "not-requested");
equal("context: metadata 模式不触发索引", calls.indexItems.length, 0);

const withText = await Sideline.context.build(paper, { mode: "metadata+fulltext", maxChars: 40 });
check("context: 全文模式写入正文", withText.text.includes("【PDF 全文（已截断至 40 字"));
equal("context: 截断后字数", withText.stats.fullTextChars, 40);
equal("context: 原文总字数", withText.stats.fullTextTotalChars, 120);
equal("context: 全文状态", withText.stats.fullTextState, "ok");
check("context: 全文模式触发一次索引", calls.indexItems.length === 1 && calls.indexItems[0].ids[0] === 200);
check("context: 页数来自 getPages", withText.stats.pages.indexedPages === 3);

// 真机 Zotero.Fulltext.getPages() 返回 mozStorage row；直接 JSON.stringify 会探测不存在的
// toJSON 列并抛错。context 必须先拷贝成纯数据对象。
const previousGetPages = Zotero.Fulltext.getPages;
const storageRow = { indexedPages: 4, total: 12 };
Object.defineProperty(storageRow, "toJSON", {
  get() {
    throw new Error("DB column 'toJSON' not found");
  },
});
Zotero.Fulltext.getPages = async () => storageRow;
const storageRowContext = await Sideline.context.build(paper, { mode: "metadata+fulltext", maxChars: 20 });
check("context: mozStorage 页数行先归一为可序列化纯对象",
  storageRowContext.stats.pages.indexedPages === 4
  && storageRowContext.stats.pages.totalPages === 12
  && JSON.stringify(storageRowContext.stats).includes('"totalPages":12'));
Zotero.Fulltext.getPages = previousGetPages;

const selectionContext = await Sideline.context.build(paper, { mode: "metadata", selection: "选中一段话" });
check("context: 选中文字入上下文", selectionContext.text.includes("【选中文字】\n选中一段话"));

const noAttachment = makeRegularItem({ id: 101, fields: { title: "无附件条目" } });
const noAttachmentContext = await Sideline.context.build(noAttachment, { mode: "fulltext" });
equal("context: 无附件时的全文状态", noAttachmentContext.stats.fullTextState, "no-attachment");
check("context: 无附件时给出说明", noAttachmentContext.text.includes("没有可用的 PDF/EPUB 附件"));

const missingFile = makeRegularItem({
  id: 102,
  fields: { title: "索引缺失" },
  attachment: makeAttachment({ id: 202, parentID: 102 }),
});
const missingContext = await Sideline.context.build(missingFile, { mode: "metadata+fulltext" });
equal("context: 缓存文件缺失时的状态", missingContext.stats.fullTextState, "missing");

const attachmentContext = await Sideline.context.build(attachment, { mode: "metadata+fulltext", maxChars: 10 });
check("context: 附件条目直接取自身", attachmentContext.stats.attachment.id === 200
  && attachmentContext.stats.fullTextChars === 10);

console.log("");
console.log("== 会话 ==");
Zotero.Prefs.set("sideline.historyTurns", 2);
for (let turn = 1; turn <= 4; turn++) {
  Sideline.session.append(100, "user", `问题${turn}`);
  Sideline.session.append(100, "assistant", `回答${turn}`);
}
const history = Sideline.session.history(100);
equal("session: 按轮数裁剪历史", history.length, 4);
equal("session: 裁剪保留最近一轮问题", history[0].content, "问题3");
equal("session: 角色顺序", history.map((entry) => entry.role).join(","), "user,assistant,user,assistant");
equal("session: 消息计数", Sideline.session.count(100), 8);
Sideline.session.clear(100);
equal("session: 清空后无历史", Sideline.session.history(100).length, 0);
Zotero.Prefs.set("sideline.historyTurns", 4);

console.log("");
console.log("== 会话存档（条目下的 JSON 附件）==");
await Sideline.store.clear();
const storeItem = makeRegularItem({ id: 5001, fields: { title: "存档测试条目" } });
const truncateItem = makeRegularItem({ id: 5002, fields: { title: "截断测试条目" } });
const capItems = [5010, 5011, 5012, 5013].map((id) => makeRegularItem({ id, fields: { title: `条目${id}` } }));
const removeItem = makeRegularItem({ id: 5020, fields: { title: "待删条目" } });
const offItem = makeRegularItem({ id: 5021, fields: { title: "关闭持久化条目" } });
const raceItem = makeRegularItem({ id: 5030, fields: { title: "竞态条目" } });
// 会话以宿主条目为键：从阅读器进来的是 PDF 附件 ID，必须上溯到父条目
const childAttachment = makeAttachment({ id: 5100, parentID: 5001, title: "Full Text PDF" });
equal("store: 附件 ID 归一为宿主条目 ID", Sideline.store.keyOf(5100), 5001);

await Sideline.store.clear();
equal("store: 初始无存档", (await Sideline.store.list()).length, 0);
const storeStats = await Sideline.store.stats();
check("store: 默认开启且模式为附件", storeStats.enabled === true && storeStats.mode === "attachment");
check("store: 上限来自首选项", storeStats.limits.items === 200 && storeStats.limits.messages === 60
  && storeStats.limits.sessions === 1);

await Sideline.store.touch(5001, {
  title: "存档测试",
  messages: [{ role: "user", content: "问题" }, { role: "assistant", content: "回答", model: "m" }],
});
const storedList = await Sideline.store.list();
equal("store: 写入后列出 1 条", storedList.length, 1);
equal("store: 标题与消息数", `${storedList[0].title}|${storedList[0].messageCount}`, "存档测试|2");
check("store: 未 flush 前标记 dirty", (await Sideline.store.stats()).dirty === 1);
check("store: flush 建立会话附件", (await Sideline.store.flush()) === true);
check("store: 落盘后 dirty 清除", (await Sideline.store.stats()).dirty === 0);

const sessionAttachment = await Sideline.store.resolveAttachment(5001);
check("store: 会话附件挂到宿主条目下", sessionAttachment.ownerID === 5001
  && !!sessionAttachment.attachmentID && sessionAttachment.exists === true);
const sessionAttachmentItem = items.get(sessionAttachment.attachmentID);
check("store: 附件标题以「Sideline 会话」开头",
  String(sessionAttachmentItem.getField("title")).startsWith("Sideline 会话"));
check("store: 附件类型为 application/json",
  sessionAttachmentItem.attachmentContentType === "application/json");
const writtenAttachment = JSON.parse(fakeFs.get(sessionAttachment.path));
check("store: 附件带标记与版本", writtenAttachment.marker === "zotero-sideline-sessions"
  && writtenAttachment.version === 3);
check("store: 附件里只有一条会话且消息完整", writtenAttachment.sessions.length === 1
  && writtenAttachment.sessions[0].messages.length === 2
  && writtenAttachment.sessions[0].messages[1].content === "回答");
check("store: 附件落在临时文件之外（已复制进 storage）",
  sessionAttachment.path.startsWith("/fake-storage/") && !fakeFs.has("/fake-temp/sideline-sessions-5001.json"));

await Sideline.store.touch(5001, {
  title: "存档测试",
  messages: [
    { role: "user", content: "问题" },
    { role: "assistant", content: "回答", model: "m" },
    { role: "user", content: "追问" },
  ],
});
await Sideline.store.flush();
const secondResolve = await Sideline.store.resolveAttachment(5001);
check("store: 第二次写入复用同一附件", secondResolve.attachmentID === sessionAttachment.attachmentID);
check("store: 内容更新到附件", JSON.parse(fakeFs.get(secondResolve.path)).sessions[0].messages.length === 3);
check("store: 更新后标记附件待上传", sessionAttachmentItem.attachmentSyncState === "to_upload");

// Upgrade keeps the newest entry, even when the older entry was active.
const legacy = JSON.parse(fakeFs.get(secondResolve.path));
legacy.sessions.push({ id: "latest", name: "latest", updated: Date.now() + 1000,
  messages: [{ role: "user", content: "newest" }], writes: [] });
fakeFs.set(secondResolve.path, JSON.stringify(legacy));
await Sideline.store.clear();
const latest = await Sideline.store.get(5001);
check("store: upgrade keeps newest instead of active", latest.messages[0].content === "newest");
check("store: upgrade removes other entries on disk", JSON.parse(fakeFs.get(secondResolve.path)).sessions.length === 1);
check("store: multi-conversation mutations removed", !Sideline.store.createSession && !Sideline.session.switchTo);

await Sideline.store.touch(5001, { title: "存档测试", messages: [] });
check("store: 会话清空后不再返回记录", (await Sideline.store.get(5001)) === null);
await Sideline.store.flush();
check("store: 清空会写回空会话列表而不是留下旧内容",
  JSON.parse(fakeFs.get(secondResolve.path)).sessions.length === 0);

Zotero.Prefs.set("sideline.maxStoredMessages", 4);
const manyMessages = [];
for (let index = 1; index <= 10; index++) manyMessages.push({ role: "user", content: `问题${index}` });
await Sideline.store.touch(5002, { title: "截断测试", messages: manyMessages });
const truncatedRecord = await Sideline.store.get(5002);
check("store: 超长会话按上限截断且保留最新", truncatedRecord.messages.length === 4
  && truncatedRecord.messages[3].content === "问题10");
Zotero.Prefs.set("sideline.maxStoredMessages", 60);

// 单条目字符总量上限：附件不能无限增长，超出时丢最旧的消息
const bigItem = makeRegularItem({ id: 5060, fields: { title: "大消息条目" } });
const bigMessages = [];
for (let index = 0; index < 6; index++) {
  bigMessages.push({ role: "user", content: `${index}:${"x".repeat(500000)}` });
}
await Sideline.store.touch(bigItem.id, { title: "大消息", messages: bigMessages });
await Sideline.store.flush();
const bigAttachment = await Sideline.store.resolveAttachment(bigItem.id);
const bigWritten = JSON.parse(fakeFs.get(bigAttachment.path));
check("store: 单条目字符超限时丢最旧消息并保留最新",
  bigWritten.sessions[0].messages.length < 6
  && bigWritten.sessions[0].messages.slice(-1)[0].content.startsWith("5:"));
check("store: 写入后的附件体积受上限约束", JSON.stringify(bigWritten).length <= 2000000);

Zotero.Prefs.set("sideline.maxStoredItems", 2);
await Sideline.store.clear();
for (const item of capItems) {
  await Sideline.store.touch(item.id, {
    title: item.getField("title"),
    messages: [{ role: "user", content: `内容${item.id}` }],
  });
  await Sideline.store.flush();
  await sleep(5);
}
const cappedList = (await Sideline.store.list())
  .filter((entry) => entry.itemID >= 5010 && entry.itemID <= 5013);
check("store: 超出条目上限淘汰最旧", cappedList.length === 2
  && !cappedList.some((entry) => entry.itemID === 5010)
  && cappedList.some((entry) => entry.itemID === 5013));
check("store: 淘汰会把附件内容也清空", JSON.parse(
  fakeFs.get((await Sideline.store.resolveAttachment(5010)).path),
).sessions.length === 0);
Zotero.Prefs.set("sideline.maxStoredItems", 200);

await Sideline.store.touch(removeItem.id, { title: "待删", messages: [{ role: "user", content: "x" }] });
await Sideline.store.flush();
check("store: remove 生效", (await Sideline.store.remove(removeItem.id)) === true);
check("store: 重复 remove 返回 false", (await Sideline.store.remove(removeItem.id)) === false);

Zotero.Prefs.set("sideline.persistSessions", false);
check("store: 关闭持久化后不写入", (await Sideline.store.touch(offItem.id, {
  title: "x",
  messages: [{ role: "user", content: "y" }],
})) === null);
Zotero.Prefs.set("sideline.persistSessions", true);

// 串行化：并发的「先写后删」不能把存档复活
await Sideline.store.clear();
const raceWrite = Sideline.store.touch(raceItem.id, { title: "竞态", messages: [{ role: "user", content: "z" }] });
const raceRemove = Sideline.store.remove(raceItem.id);
await Promise.all([raceWrite, raceRemove]);
check("store: 先写后删的顺序被串行化保持",
  (await Sideline.store.list()).every((entry) => entry.itemID !== raceItem.id)
  && (await Sideline.store.get(raceItem.id)) === null);

// 独立附件没有父条目：只在内存保留，并明确报告不可持久化
const orphanAttachment = makeAttachment({ id: 5150, title: "独立 PDF" });
const orphanInfo = await Sideline.store.resolveAttachment(orphanAttachment.id);
check("store: 独立附件报告不可持久化", orphanInfo.ok === false && orphanInfo.reason.includes("父条目"));
await Sideline.store.touch(orphanAttachment.id, { messages: [{ role: "user", content: "孤立会话" }] });
check("store: 独立附件的会话只在内存", (await Sideline.store.get(orphanAttachment.id)).messages.length === 1
  && (await Sideline.store.stats()).warnings.join(" ").includes("独立附件"));

// 附件损坏：保留 .corrupt 副本并重建
const corruptItem = makeRegularItem({ id: 5040, fields: { title: "损坏附件条目" } });
const corruptPath = "/fake-storage/5200/sideline-sessions.json";
fakeFs.set(corruptPath, "{ 这不是合法 JSON");
makeAttachment({ id: 5200, parentID: 5040, title: Sideline.store.TITLE_PREFIX, contentType: "application/json", path: corruptPath });
await Sideline.store.clear();
const corruptRecord = await Sideline.store.get(5040);
check("store: 损坏附件按空处理", corruptRecord === null);
const corruptStats = await Sideline.store.stats();
check("store: 记录损坏原因", corruptStats.loadError.length > 0);
check("store: 保留 .corrupt 副本",
  [...fakeFs.keys()].some((key) => key.endsWith("sessions-attachment-5040.json.corrupt")));

console.log("");
console.log("== 子进程通道 ==");
check("proc: Subprocess 模块可用", Sideline.proc.available() === true);
subprocessState.stdout = "codex-cli 0.154.0\n";
subprocessState.stderr = "";
subprocessState.exitCode = 0;
subprocessState.stdin = "";
subprocessState.calls = [];
const procResult = await Sideline.proc.run("C:/fake/.codex/bin/codex.exe", ["--version"], { stdinText: "hello" });
equal("proc: 返回退出码", procResult.exitCode, 0);
check("proc: 捕获 stdout", procResult.stdout.includes("codex-cli 0.154.0"));
equal("proc: 写入 stdin", subprocessState.stdin, "hello");
equal("proc: 三项流都按 pipe 打开",
  `${subprocessState.calls[0].stdin}/${subprocessState.calls[0].stdout}/${subprocessState.calls[0].stderr}`,
  "pipe/pipe/pipe");
check("proc: 正常结束不标记超时", procResult.timedOut === false);

subprocessState.stdout = "abc";
const streamedChunks = [];
await Sideline.proc.run("x", [], { onStdout: (chunk) => streamedChunks.push(chunk) });
check("proc: onStdout 收到分块", streamedChunks.join("") === "abc");

const fragmentedUtf8 = new TextEncoder().encode("中文正文\n");
subprocessState.rawChunks = Array.from(fragmentedUtf8, (byte) => new Uint8Array([byte]).buffer);
const unicodeChunks = [];
const unicodeResult = await Sideline.proc.run("x", [], { onStdout: (piece) => unicodeChunks.push(piece) });
check("proc: split UTF-8 characters do not terminate live stream", unicodeResult.stdout === "中文正文\n" && unicodeChunks.join("") === "中文正文\n");
delete subprocessState.rawChunks;
subprocessState.hang = true;
subprocessState.killCount = 0;
const timeoutResult = await Sideline.proc.run("x", [], { timeoutMs: 60 });
subprocessState.hang = false;
check("proc: 超时会终止进程", timeoutResult.timedOut === true && subprocessState.killCount === 1);

console.log("");
console.log("== Codex 接入 ==");
// 夹具取自本机实测（codex-cli 0.154.0，2026-09-29，--json）
const codexJsonl = [
  '{"type":"thread.started","thread_id":"01a0e8d8-44ef-7902-8542-60b390ade89b"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-6-sol` not found."}}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"无法读取图片，请重新上传。"}}',
  '{"type":"turn.completed","usage":{"input_tokens":45946,"cached_input_tokens":3712,"output_tokens":11,"reasoning_output_tokens":0}}',
].join("\n") + "\n";

fakeFs.set("C:/fake/.codex/bin/codex.exe", "stub");
fakeFs.set("C:/fake/.codex/bin", "directory");
Zotero.Prefs.set("sideline.codexPath", "C:/fake/.codex/bin/codex.exe");
equal("codex: 用首选项里的路径", Sideline.codex.executable(), "C:/fake/.codex/bin/codex.exe");

subprocessState.stdout = "codex-cli 0.154.0\n";
subprocessState.exitCode = 0;
const codexVersion = await Sideline.codex.version();
check("codex: version 取到版本号", codexVersion.stdout.includes("codex-cli")
  && codexVersion.procAvailable === true);

subprocessState.stdout = codexJsonl;
subprocessState.stdin = "";
subprocessState.calls = [];
const codexRun = await Sideline.codex.run({ prompt: "这张图片里的文字是什么？", images: [] });
equal("codex: 提取 agent_message 文本", codexRun.content, "无法读取图片，请重新上传。");
equal("codex: 汇总线程 ID", codexRun.threadId, "01a0e8d8-44ef-7902-8542-60b390ade89b");
check("codex: 汇总 token 用量", codexRun.usage && codexRun.usage.input_tokens === 45946
  && codexRun.usage.output_tokens === 11);
check("codex: 收集错误项", codexRun.errors.some((line) => line.includes("Model metadata")));
const codexArgs = subprocessState.calls[subprocessState.calls.length - 1].arguments;
check("codex: 只读沙箱 + 免审批 + 跳过 git 检查 + 持久会话",
  codexArgs.includes("--sandbox") && codexArgs[codexArgs.indexOf("--sandbox") + 1] === "read-only"
  && codexArgs.includes("approval_policy=never") && codexArgs.includes("--skip-git-repo-check")
  && !codexArgs.includes("--ephemeral"));
check("codex: 不向 CLI 传图片", !codexArgs.includes("-i"));
check("codex: prompt 走 stdin 且参数以 - 结尾",
  subprocessState.stdin.includes("这张图片") && codexArgs[codexArgs.length - 1] === "-");
check("codex: 推理强度取自首选项", codexArgs.includes("model_reasoning_effort=low"));

Zotero.Prefs.set("sideline.codexPath", "");
fakeFs.delete("C:/fake/.codex/bin/codex.exe");
let codexMissingError = "";
try {
  await Sideline.codex.version();
}
catch (error) {
  codexMissingError = error.message;
}
check("codex: 找不到可执行文件时报错", codexMissingError.includes("Codex"));
Zotero.Prefs.set("sideline.codexPath", "C:/fake/.codex/bin/codex.exe");
fakeFs.set("C:/fake/.codex/bin/codex.exe", "stub");
fakeFs.set("C:/fake/.codex/bin", "directory");

console.log("");
console.log("== 阅读器探针 ==");
const probeSpan = makeFakeElement("span");
probeSpan.textContent = "手征有效场论的核力";
probeSpan.attributes.style = "left: 10px; top: 20px;";
probeSpan.getBoundingClientRect = () => ({ x: 12, y: 34, width: 56, height: 9 });
const probeLayer = makeFakeElement("div");
probeLayer.appendChild(probeSpan);
probeLayer.querySelectorAll = (selector) => (selector === "span" ? [probeSpan] : []);
const probePage = makeFakeElement("div");
probePage.attributes["data-page-number"] = "3";
probePage.attributes["data-page-label"] = "3";
probePage.querySelector = (selector) => (selector === ".textLayer" ? probeLayer : null);
const probeDoc = { querySelectorAll: (selector) => (selector === ".page" ? [probePage] : []) };
const probeReader = { itemID: 100, tabID: "tab-1", _iframeWindow: { document: probeDoc } };
Zotero.Reader._readers = [probeReader];
equal("readerprobe: 统计已打开阅读器", Sideline.readerprobe.count(), 1);
const probes = Sideline.readerprobe.snapshotAll(100);
equal("readerprobe: 返回一个快照", probes.length, 1);
equal("readerprobe: 页数", probes[0].pageCount, 1);
equal("readerprobe: 有文本层的页数", probes[0].textLayerPages, 1);
check("readerprobe: 取到页号与文本", probes[0].sample.pageNumber === "3"
  && probes[0].sample.text.startsWith("手征"));
check("readerprobe: 取到 span 几何", probes[0].sample.rect && probes[0].sample.rect.width === 56);
check("readerprobe: 页标签被记录", probes[0].pageLabels[0].label === "3");
check("readerprobe: 不匹配的 itemID 返回空", Sideline.readerprobe.snapshotAll(999).length === 0);
Zotero.Reader._readers = [];

console.log("");
console.log("== 阅读器深入探针（嵌套 frame + pdf.js 按页取文）==");
const fakeDocOf = (map) => ({ querySelectorAll: (selector) => map[selector] || [] });
const pdfTextItem = { str: "摘要：本文讨论核结构", transform: [1, 0, 0, 1, 72, 700], width: 90, height: 10 };
const pdfPageObject = {
  getTextContent: async () => ({ items: [pdfTextItem, { str: "第二行", transform: [1, 0, 0, 1, 72, 680] }] }),
  getViewport: () => ({ width: 612, height: 792, rotation: 0 }),
};
const pdfWin = {
  location: { href: "resource://reader/pdf/web/viewer.html" },
  PDFViewerApplication: { pdfDocument: { numPages: 7, getPage: async () => pdfPageObject }, page: 3 },
};
pdfWin.document = fakeDocOf({ "*": [1, 2, 3], ".page": [{}], ".textLayer": [{}], canvas: [{}], "[class]": [] });
const pdfFrameElement = { localName: "iframe", id: "pdf-viewer", contentWindow: pdfWin };
const rootWin = {
  location: { href: "resource://reader/reader.html" },
  document: fakeDocOf({
    "*": [1, 2],
    ".page": [],
    ".textLayer": [],
    canvas: [],
    "[class]": [],
    "iframe, browser": [pdfFrameElement],
  }),
};
const deepReader = {
  itemID: 100,
  _iframeWindow: rootWin,
  _internalReader: { getSelectedText() {}, addAnnotation() {} },
};
Zotero.Reader._readers = [deepReader];
const deepProbes = await Sideline.readerprobe.deepSnapshotAll(100, 1);
equal("readerprobe(deep): 遍历到两层 frame", deepProbes[0].frames.length, 2);
check("readerprobe(deep): 外层无页、内层有页", deepProbes[0].frames[0].pageCount === 0
  && deepProbes[0].frames[1].pageCount === 1 && deepProbes[0].frames[1].textLayerCount === 1);
check("readerprobe(deep): 记录 pdf.js 文档页数", deepProbes[0].frames[1].pdfViewer.numPages === 7);
check("readerprobe(deep): 按页取到正文", deepProbes[0].pageText.itemCount === 2
  && deepProbes[0].pageText.firstItems[0].str.startsWith("摘要"),
  JSON.stringify({ pageText: deepProbes[0].pageText, pdfWindow: deepProbes[0].pdfWindow, error: deepProbes[0].error }));
check("readerprobe(deep): 取到 transform 与视口", deepProbes[0].pageText.firstItems[0].transform.length === 6
  && deepProbes[0].pageText.viewport.width === 612);
check("readerprobe(deep): 记录内部 reader 方法名",
  deepProbes[0].internalReaderKeys.includes("getSelectedText"));
check("readerprobe(deep): 记录命中 frame 的路径",
  String(deepProbes[0].pageTextFrame).includes("pdf-viewer"));
check("readerprobe(deep): 列出候选窗口", deepProbes[0].windowCandidates.some((label) => label.includes("frame:")));
Zotero.Reader._readers = [];

// Zotero 自身路径：PDFViewerApplication 挂在视图对象的 _iframeWindow 上
const viewWin = {
  location: { href: "resource://reader/pdf/web/viewer.html" },
  PDFViewerApplication: { pdfDocument: { numPages: 12, getPage: async () => pdfPageObject }, page: 1 },
};
viewWin.document = fakeDocOf({ "*": [1], ".page": [], ".textLayer": [], canvas: [], "[class]": [] });
const zoteroStyleReader = {
  itemID: 200,
  _iframeWindow: { location: { href: "resource://reader/reader.html" }, document: fakeDocOf({ "*": [], ".page": [], ".textLayer": [], canvas: [], "[class]": [], "iframe, browser": [] }) },
  _internalReader: { _activePrimaryView: { _iframeWindow: viewWin } },
};
Zotero.Reader._readers = [zoteroStyleReader];
const zoteroStyleProbes = await Sideline.readerprobe.deepSnapshotAll(200, 1);
check("readerprobe(deep): 走 Zotero 自身的 _pdfView 路径也能命中",
  String(zoteroStyleProbes[0].pdfWindow).includes("_activePrimaryView")
  && zoteroStyleProbes[0].pageText.itemCount === 2);
Zotero.Reader._readers = [];

// 文本层兜底：没有 pdf.js 应用时用已渲染页的 span 取文本与几何
const layerSpan = makeFakeElement("span");
layerSpan.textContent = "兜底文本";
layerSpan.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 8 });
const fallbackDoc = fakeDocOf({
  "*": [1],
  ".page": [{}],
  ".textLayer": [{}],
  canvas: [],
  "[class]": [],
  'iframe, browser': [],
  '.page[data-page-number="1"] .textLayer span': [layerSpan],
});
const fallbackReader = {
  itemID: 300,
  _iframeWindow: { location: { href: "resource://reader/reader.html" }, document: fallbackDoc },
  _internalReader: {},
};
Zotero.Reader._readers = [fallbackReader];
const fallbackProbes = await Sideline.readerprobe.deepSnapshotAll(300, 1);
check("readerprobe(deep): 无应用时退化到文本层", fallbackProbes[0].pageText
  && fallbackProbes[0].pageText.source === "textLayer"
  && fallbackProbes[0].pageText.items[0].str === "兜底文本"
  && fallbackProbes[0].pageText.items[0].rect.width === 30);
Zotero.Reader._readers = [];

// 主路径：getPageData（Zotero 的 pdf.js fork 提供按页字符与几何）
const pageDataChars = [{ u: "核", x: 10, y: 20 }, { u: "力", x: 20, y: 20 }, { u: "场", x: 30, y: 20 }];
const pageDataWin = {
  location: { href: "resource://reader/pdf/web/viewer.html" },
  PDFViewerApplication: {
    pdfDocument: {
      numPages: 9,
      getPageData: async () => ({ chars: pageDataChars, width: 612, height: 792 }),
      getPageLabels2: async () => ["i", "ii", "1"],
      getOutline2: async () => [{ title: "引言" }, { title: "方法" }],
    },
  },
};
pageDataWin.document = fakeDocOf({ "*": [], ".page": [], ".textLayer": [], canvas: [], "[class]": [] });
Zotero.Reader._readers = [{ itemID: 400, _iframeWindow: pageDataWin, _internalReader: {} }];
const pageDataProbes = await Sideline.readerprobe.deepSnapshotAll(400, 2);
check("readerprobe(deep): 主路径走 getPageData", pageDataProbes[0].pageText.source === "pageData"
  && pageDataProbes[0].pageText.charCount === 3
  && pageDataProbes[0].pageText.text.startsWith("核力场"),
  JSON.stringify(pageDataProbes[0].pageText));
check("readerprobe(deep): 记录字符几何字段", pageDataProbes[0].pageText.charKeys.includes("x")
  && pageDataProbes[0].pageText.firstChars[0].u === "核");
check("readerprobe(deep): 取到页码标签", Array.isArray(pageDataProbes[0].pageLabels)
  && pageDataProbes[0].pageLabels[2] === "1");
check("readerprobe(deep): 取到大纲条数", pageDataProbes[0].outline.count === 2
  && pageDataProbes[0].outline.first[0] === "引言");
Zotero.Reader._readers = [];

// Xray 解包路径：page 对象经 waiveXrays 后才看得到原型方法
const unwrappedPage = {
  getTextContent: async () => ({ items: [{ str: "解包后文本", transform: [1, 0, 0, 1, 1, 2] }] }),
  getViewport: () => ({ width: 100, height: 200, rotation: 0 }),
};
const xrayWin = {
  location: { href: "resource://reader/pdf/web/viewer.html" },
  PDFViewerApplication: {
    pdfDocument: { numPages: 3, getPage: async () => ({ __unwrapped: unwrappedPage }) },
  },
};
xrayWin.document = fakeDocOf({ "*": [], ".page": [], ".textLayer": [], canvas: [], "[class]": [] });
Zotero.Reader._readers = [{ itemID: 500, _iframeWindow: xrayWin, _internalReader: {} }];
const xrayProbes = await Sideline.readerprobe.deepSnapshotAll(500, 1);
check("readerprobe(deep): Xray 对象解包后可取文", xrayProbes[0].pageText.source === "pdfjs"
  && xrayProbes[0].pageText.firstItems[0].str === "解包后文本",
  JSON.stringify(xrayProbes[0].pageText));
Zotero.Reader._readers = [];

console.log("");
console.log("== 子笔记写入 ==");
const note = await Sideline.notes.saveAnswer({
  item: paper,
  question: "这篇文章做了什么？",
  answer: "结论：<script>alert(1)</script> 以及 **重点**",
  model: "test-model",
});
check("notes: 笔记挂到父条目", note.parentID === 100 && note.libraryID === 1);
check("notes: 笔记已保存", note.saved === true);
check("notes: 含问题、回答与模型", note.note.includes("这篇文章做了什么？")
  && note.note.includes("test-model") && note.note.includes("重点"));
check("notes: 回答中的 HTML 被转义", note.note.includes("&lt;script&gt;") && !note.note.includes("<script>"));
check("notes: 含生成时间", /生成时间：\d{4}-\d{2}-\d{2}/.test(note.note));
const attachmentNote = await Sideline.notes.saveAnswer({ item: attachment, question: "q", answer: "a" });
check("notes: 附件条目挂到父条目", attachmentNote.parentID === 100);

check("notes: 已移除大纲子笔记写入入口", typeof Sideline.notes.saveOutline === "undefined");

console.log("");
console.log("== 批注写入 ==");
const selectable = {
  type: "highlight",
  color: "#ff6666",
  sortIndex: "00001|00000042",
  pageLabel: "3",
  text: "被选中的原文",
  position: { pageIndex: 2, rects: [[10, 20, 30, 40]] },
};
check("annotations: 有坐标时可写", Sideline.annotations.canWrite(selectable).ok === true);
check("annotations: 缺文字时不可写", Sideline.annotations.canWrite({ position: selectable.position }).ok === false);
check("annotations: 缺坐标时不可写并给出原因", (() => {
  const result = Sideline.annotations.canWrite({ text: "只有文字" });
  return result.ok === false && result.reason.includes("坐标");
})());
check("annotations: 空 rects 视为无坐标", Sideline.annotations.canWrite({
  text: "x",
  position: { pageIndex: 0, rects: [] },
}).ok === false);

const builtAnnotation = Sideline.annotations.buildJSON(selectable, "模型回答", "#00ff00");
check("annotations: 生成新 key", typeof builtAnnotation.key === "string" && builtAnnotation.key.startsWith("GEN"));
equal("annotations: 颜色用覆盖值", builtAnnotation.color, "#00ff00");
equal("annotations: 评论为回答", builtAnnotation.comment, "模型回答");
equal("annotations: 页码与排序沿用选区", `${builtAnnotation.pageLabel}|${builtAnnotation.sortIndex}`, "3|00001|00000042");
check("annotations: 坐标原样传递", builtAnnotation.position.pageIndex === 2
  && builtAnnotation.position.rects.length === 1);
equal("annotations: 类型缺省为 highlight",
  Sideline.annotations.buildJSON({ text: "x", position: selectable.position }, "c").type, "highlight");
equal("annotations: 颜色缺省值",
  Sideline.annotations.buildJSON({ text: "x", position: selectable.position }, "c").color, "#ffd400");

const annotationsBefore = calls.annotations.length;
const createdAnnotation = await Sideline.annotations.saveHighlightComment({
  attachment,
  annotation: selectable,
  comment: "回答",
  color: "#00ff00",
});
equal("annotations: 调用一次 saveFromJSON", calls.annotations.length, annotationsBefore + 1);
const lastAnnotationCall = calls.annotations[calls.annotations.length - 1];
check("annotations: 传入附件并跳过选中", lastAnnotationCall.attachment.id === 200
  && lastAnnotationCall.options.skipSelect === true);
equal("annotations: 返回的 key 与写入一致", createdAnnotation.key, lastAnnotationCall.json.key);

let noPositionError = "";
try {
  await Sideline.annotations.saveHighlightComment({ attachment, annotation: { text: "无坐标" }, comment: "c" });
}
catch (error) {
  noPositionError = error.message;
}
check("annotations: 坐标缺失时报错且不写库",
  noPositionError.includes("坐标") && calls.annotations.length === annotationsBefore + 1);

let unsavedAttachmentError = "";
try {
  await Sideline.annotations.saveHighlightComment({
    attachment: { id: 1, key: "X" },
    annotation: selectable,
    comment: "c",
  });
}
catch (error) {
  unsavedAttachmentError = error.message;
}
check("annotations: 附件未保存时报错", unsavedAttachmentError.includes("附件"));

console.log("");
console.log("== 模型客户端 ==");
const baseConfig = Sideline.config.read();
const messages = [{ role: "user", content: "你好" }];
const httpStart = calls.http.length;

const once = await Sideline.client.chat({ messages, config: Object.assign({}, baseConfig, { stream: false }) });
equal("client: 非流式返回内容并去空白", once.content, "非流式回答");
equal("client: 非流式标记", once.streamed, false);
check("client: 非流式请求体 stream=false", JSON.parse(calls.http[httpStart].options.body).stream === false);
equal("client: 请求端点", calls.http[httpStart].url, "https://api.deepseek.com/v1/chat/completions");
equal("client: 携带 Bearer 头", calls.http[httpStart].options.headers.Authorization, "Bearer test-key");
check("client: usage 透传", once.usage.total_tokens === 11);

const chunks = [
  'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"cho',
  'ices":[{"delta":{"content":"好"}}],"model":"fake-model"}\n\ndata: [DONE]\n\n',
];
let chunkIndex = 0;
const encoder = new TextEncoder();
fakeWindow.fetch = async () => ({
  ok: true,
  body: {
    getReader: () => ({
      read: async () => (chunkIndex < chunks.length
        ? { value: encoder.encode(chunks[chunkIndex++]), done: false }
        : { value: undefined, done: true }),
    }),
  },
});
const deltas = [];
const streamed = await Sideline.client.chat({
  messages,
  config: Object.assign({}, baseConfig, { stream: true }),
  onDelta: (piece, whole) => deltas.push({ piece, whole }),
});
equal("client: 流式拼接结果", streamed.content, "你好");
equal("client: 流式标记", streamed.streamed, true);
equal("client: 流式取 chunk 中的 model", streamed.model, "fake-model");
equal("client: 增量回调次数", deltas.length, 2);
equal("client: 增量回调累计内容", deltas[1].whole, "你好");
equal("client: 流式时不再走 Zotero.HTTP", calls.http.length, httpStart + 1);

fakeWindow.fetch = async (url, options) => new Promise((resolve, reject) => {
  if (options && options.signal) {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }
});
let aborted = false;
const pending = Sideline.client.chat({
  messages,
  config: Object.assign({}, baseConfig, { stream: true }),
  onDelta: () => {},
}).catch(() => {
  aborted = true;
});
await sleep(10);
Sideline.client.abort();
await pending;
check("client: abort 能中断流式请求", aborted === true);

const concurrentState = { aAborted: false, bAborted: false, bSettled: false };
fakeWindow.fetch = async (url, options) => new Promise((resolve, reject) => {
  const body = JSON.parse(options.body || "{}");
  const marker = String(body.messages && body.messages[0] && body.messages[0].content || "");
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      if (marker === "并发 A") concurrentState.aAborted = true;
      if (marker === "并发 B") concurrentState.bAborted = true;
      reject(new Error(`aborted ${marker}`));
    });
  }
});
const concurrentA = Sideline.client.chat({
  messages: [{ role: "user", content: "并发 A" }],
  config: Object.assign({}, baseConfig, { stream: true }),
  requestKey: "reader-a",
  onDelta: () => {},
}).catch(() => {});
const concurrentB = Sideline.client.chat({
  messages: [{ role: "user", content: "并发 B" }],
  config: Object.assign({}, baseConfig, { stream: true }),
  requestKey: "reader-b",
  onDelta: () => {},
}).then(() => {
  concurrentState.bSettled = true;
}).catch(() => {
  concurrentState.bSettled = true;
});
await sleep(10);
Sideline.client.abort("reader-a");
await concurrentA;
check("client: 指定阅读器的停止不会中断另一个并发请求",
  concurrentState.aAborted === true && concurrentState.bAborted === false
  && concurrentState.bSettled === false);
Sideline.client.abort("reader-b");
await concurrentB;
check("client: 第二个并发请求仍可单独停止", concurrentState.bAborted === true);

fakeWindow.fetch = async () => ({
  ok: false,
  status: 401,
  text: async () => '{"error":"bad key"}',
});
let errorMessage = "";
try {
  await Sideline.client.chat({
    messages,
    config: Object.assign({}, baseConfig, { stream: true }),
    onDelta: () => {},
  });
}
catch (error) {
  errorMessage = error.message;
}
check("client: HTTP 错误带状态码与响应片段", errorMessage.includes("401") && errorMessage.includes("bad key"));

fakeWindow.fetch = null;
await Sideline.client.chat({ messages, config: Object.assign({}, baseConfig, { stream: true }), onDelta: () => {} });
check("client: 无 fetch 时回退一次性请求", calls.http.length === httpStart + 2);

console.log("");
console.log("== 本机端点 ==");
Sideline.endpoints.register();
check("endpoints: 注册 19 个路径", Object.keys(Zotero.Server.Endpoints).length === 19
  && Object.keys(Zotero.Server.Endpoints).every((key) => key.startsWith("/sideline/")));

// 端点契约：Zotero 用 init.length 判断签名，0 个参数会被当成旧式端点而永不响应
const contractIssues = [];
for (const [endpointPath, Endpoint] of Object.entries(Zotero.Server.Endpoints)) {
  const instance = new Endpoint();
  if (typeof instance.init !== "function" || instance.init.length !== 1) {
    contractIssues.push(`${endpointPath}: init 形参个数应为 1，实际 ${instance.init ? instance.init.length : "无 init"}`);
  }
  if (!Array.isArray(instance.supportedMethods) || !instance.supportedMethods.length) {
    contractIssues.push(`${endpointPath}: supportedMethods 缺失`);
  }
  if (!Array.isArray(instance.supportedDataTypes)
    || !instance.supportedDataTypes.includes("application/json")) {
    contractIssues.push(`${endpointPath}: supportedDataTypes 未声明 application/json`);
  }
  if (instance.permitBookmarklet !== false) {
    contractIssues.push(`${endpointPath}: permitBookmarklet 应为 false`);
  }
}
check("endpoints: 契约一致（init 单形参、声明方法、声明 JSON、禁用 bookmarklet）",
  contractIssues.length === 0, contractIssues.join("；"));

const statusEndpoint = new Zotero.Server.Endpoints["/sideline/status"]();
const [statusCode, statusType, statusBody] = await statusEndpoint.init({});
equal("endpoints: status 返回 200", statusCode, 200);
equal("endpoints: status 内容类型", statusType, "application/json; charset=utf-8");
const statusJson = JSON.parse(statusBody);
check("endpoints: status ready 与版本", statusJson.ready === true
  && statusJson.pluginVersion === manifest.version);
check("endpoints: status 不回显密钥", !statusBody.includes("test-key"));
check("endpoints: status 列出端点", statusJson.endpoints.length === 19);
check("endpoints: 已移除文献大纲端点",
  !statusJson.endpoints.includes("/sideline/outline")
  && !statusJson.endpoints.includes("/sideline/outline/batch"));
check("endpoints: status 带诊断快照", statusJson.diagnostics && typeof statusJson.diagnostics.items === "object"
  && Array.isArray(statusJson.diagnostics.errors));
check("endpoints: status 带功能注册表与通道摘要",
  Array.isArray(statusJson.functions) && statusJson.functions.includes("summarize")
  && statusJson.providers.provider === "api" && statusJson.providers.visionProvider === "vision");

const contextEndpoint = new Zotero.Server.Endpoints["/sideline/context"]();
const [, , contextBody] = await contextEndpoint.init({ data: { itemID: 100, mode: "metadata", includeText: false } });
const contextJson = JSON.parse(contextBody);
check("endpoints: context 返回条目摘要", contextJson.item.id === 100 && contextJson.item.title.includes("手征"));
check("endpoints: includeText=false 时不返回正文", !("text" in contextJson));
const [badContextCode] = await contextEndpoint.init({ data: { itemID: "abc" } });
equal("endpoints: context 非法 itemID 返回 400", badContextCode, 400);
const [missingContextCode] = await contextEndpoint.init({ data: { itemID: 999999 } });
equal("endpoints: context 不存在的条目返回 400", missingContextCode, 400);

const chatEndpoint = new Zotero.Server.Endpoints["/sideline/chat"]();
const [, , noQuestionBody] = await chatEndpoint.init({ data: { itemID: 100 } });
check("endpoints: chat 缺 question 返回 400", JSON.parse(noQuestionBody).error.includes("question"));
Zotero.Prefs.set("sideline.secretKey", "");
const [, , unconfiguredBody] = await chatEndpoint.init({ data: { itemID: 100, question: "q" } });
check("endpoints: chat 未配置返回 503", JSON.parse(unconfiguredBody).error.includes("未配置"));
Zotero.Prefs.set("sideline.secretKey", "test-key");
const chatCallCount = calls.http.length;
const [chatCode, , chatBody] = await chatEndpoint.init({
  data: { itemID: 100, question: "这篇文章的结论是什么？", mode: "metadata", model: "override-model", save: true },
});
equal("endpoints: chat 返回 200", chatCode, 200);
const chatJson = JSON.parse(chatBody);
equal("endpoints: chat 回答", chatJson.answer, "非流式回答");
equal("endpoints: chat 使用指定模型", chatJson.model, "override-model");
check("endpoints: chat 返回 stats 与耗时", chatJson.stats.contextChars > 0 && chatJson.elapsedMs >= 0);
check("endpoints: chat 触发一次请求", calls.http.length === chatCallCount + 1);
check("endpoints: chat save=true 写入子笔记", chatJson.note && chatJson.note.parentID === 100);
check("endpoints: chat 请求体含上下文", JSON.parse(calls.http[calls.http.length - 1].options.body)
  .messages[0].content.includes("核结构中的手征有效场论"));

const noteEndpoint = new Zotero.Server.Endpoints["/sideline/note"]();
const [, , noteMissingBody] = await noteEndpoint.init({ data: { itemID: 100 } });
check("endpoints: note 缺 answer 返回 400", JSON.parse(noteMissingBody).error.includes("answer"));
const [noteCode, , noteBody] = await noteEndpoint.init({ data: { itemID: 100, question: "q", answer: "外部写入的回答" } });
equal("endpoints: note 返回 200", noteCode, 200);
const noteJson = JSON.parse(noteBody);
check("endpoints: note 返回 noteKey 与父条目", noteJson.parentID === 100 && typeof noteJson.noteKey === "string");
check("endpoints: note 内容写入", calls.notes[calls.notes.length - 1].note.includes("外部写入的回答"));

console.log("");
console.log("== 验证用诊断端点 ==");
const diagCodexEndpoint = new Zotero.Server.Endpoints["/sideline/diag/codex"]();
subprocessState.stdout = "codex-cli 0.154.0\n";
subprocessState.exitCode = 0;
const [diagVersionCode, , diagVersionBody] = await diagCodexEndpoint.init({ data: { probe: "version" } });
equal("diag: codex version 返回 200", diagVersionCode, 200);
const diagVersionJson = JSON.parse(diagVersionBody);
check("diag: 报告进程通道与版本", diagVersionJson.procAvailable === true
  && diagVersionJson.stdout.includes("codex-cli") && diagVersionJson.executable.includes("codex"));

subprocessState.stdout = codexJsonl;
const [diagChatCode, , diagChatBody] = await diagCodexEndpoint.init({ data: { probe: "chat", prompt: "hi" } });
equal("diag: codex chat 返回 200", diagChatCode, 200);
const diagChatJson = JSON.parse(diagChatBody);
check("diag: chat 返回正文、用量与事件类型", diagChatJson.content.includes("无法读取图片")
  && diagChatJson.usage.input_tokens === 45946
  && diagChatJson.eventTypes.includes("turn.completed")
  && typeof diagChatJson.elapsedMs === "number");

const [, , diagBadBody] = await diagCodexEndpoint.init({ data: { probe: "nope" } });
check("diag: 未知 probe 返回 400", JSON.parse(diagBadBody).error.includes("probe"));

const diagReaderEndpoint = new Zotero.Server.Endpoints["/sideline/diag/reader"]();
Zotero.Reader._readers = [probeReader];
const [diagReaderCode, , diagReaderBody] = await diagReaderEndpoint.init({ data: {} });
equal("diag: reader 返回 200", diagReaderCode, 200);
const diagReaderJson = JSON.parse(diagReaderBody);
check("diag: reader 返回页与文本层结构", diagReaderJson.openReaders === 1
  && diagReaderJson.readers[0].sample.text.startsWith("手征")
  && diagReaderJson.readers[0].sample.rect.width === 56);
Zotero.Reader._readers = [];

Zotero.Reader._readers = [deepReader];
const [diagDeepCode, , diagDeepBody] = await diagReaderEndpoint.init({ data: { deep: true, page: 2 } });
equal("diag: reader deep 返回 200", diagDeepCode, 200);
const diagDeepJson = JSON.parse(diagDeepBody);
check("diag: deep 模式返回 frame 树与按页正文", diagDeepJson.deep === true
  && diagDeepJson.readers[0].frames.length === 2
  && diagDeepJson.readers[0].pageText.firstItems[0].str.startsWith("摘要"));
Zotero.Reader._readers = [];

const sessionsEndpoint = new Zotero.Server.Endpoints["/sideline/sessions"]();
const [sessionsCode, , sessionsBody] = await sessionsEndpoint.init({ data: {} });
equal("endpoints: sessions 返回 200", sessionsCode, 200);
const sessionsJson = JSON.parse(sessionsBody);
check("endpoints: sessions 返回列表与统计", typeof sessionsJson.count === "number"
  && sessionsJson.stats.mode === "attachment" && Array.isArray(sessionsJson.sessions));
const [, , singleSessionBody] = await sessionsEndpoint.init({ data: { itemID: 100 } });
const singleSessionJson = JSON.parse(singleSessionBody);
check("endpoints: sessions 单条查询", singleSessionJson.itemID === 100);
check("endpoints: sessions 单条查询带会话列表与附件信息",
  Array.isArray(singleSessionJson.sessions) && singleSessionJson.attachment
  && singleSessionJson.attachment.ownerID === 100);
const [badSessionCode] = await sessionsEndpoint.init({ data: { itemID: 999999 } });
equal("endpoints: sessions 无效条目返回 400", badSessionCode, 400);

const sessionDeleteEndpoint = new Zotero.Server.Endpoints["/sideline/sessions/delete"]();
Sideline.session.append(100, "user", "删除前的内存消息");
await Sideline.store.touch(100, { title: "待删存档", messages: [{ role: "user", content: "删除前的存档消息" }] });
await Sideline.store.flush();
const [deleteCode, , deleteBody] = await sessionDeleteEndpoint.init({ data: { itemID: 100 } });
equal("endpoints: sessions/delete 返回 200", deleteCode, 200);
check("endpoints: 删除同时清空内存与存档", JSON.parse(deleteBody).deleted === true
  && Sideline.session.count(100) === 0 && (await Sideline.store.get(100)) === null);
const [deleteAgainBody] = (await sessionDeleteEndpoint.init({ data: { itemID: 100 } })).slice(2);
check("endpoints: 再次删除返回 deleted=false", JSON.parse(deleteAgainBody).deleted === false);

console.log("");
console.log("== 首选项面板脚本 ==");
const paneScript = fs.readFileSync(path.join(srcDir, "content/prefs-pane.js"), "utf8");
check("prefs-pane: 使用固定服务桥与去重激活", paneScript.includes("Zotero.SidelinePrefs") && paneScript.includes("service.onActivate"));
check("prefs-pane: API 与 Agent 分别测试", paneFragment.includes("sideline-text-test") && paneFragment.includes("sideline-vision-test") && paneFragment.includes("sideline-agent-probe") && paneFragment.includes("sideline-agent-test"));
check("prefs-pane: 模型下拉可编辑", ["text", "vision", "agent"].every((kind) => paneFragment.includes(`id="sideline-${kind}-model-toggle"`) && paneFragment.includes(`<html:select id="sideline-${kind}-models"`)));

console.log("");
console.log("== bootstrap 注册 ==");
await context.SidelineBootstrap.startup();
check("bootstrap: 注册划词监听与阅读器工具栏监听",
  calls.readerListeners.length === 2
  && calls.readerListeners.some((entry) => entry.type === "renderTextSelectionPopup")
  && calls.readerListeners.some((entry) => entry.type === "renderToolbar"));
check("bootstrap: 划词监听带 pluginID",
  calls.readerListeners.every((entry) => entry.pluginID === "zotero-sideline@shiys.local"));
check("bootstrap: 注册首选项面板", calls.panes.length === 1 && calls.panes[0].src.endsWith("content/prefs-pane.xhtml"));
check("bootstrap: 首选项面板带脚本与样式", calls.panes[0].scripts.length === 1
  && calls.panes[0].stylesheets.length === 1);
check("bootstrap: 启动日志", calls.logs.some((line) => line.includes(`启动 v${manifest.version}`)));

console.log("");
console.log("== 启动诊断 ==");
const diagnostics = Sideline.diagnostics.snapshot();
check("diagnostics: 记录版本", diagnostics.items.version
  && diagnostics.items.version.pluginVersion === manifest.version
  && diagnostics.items.version.zoteroVersion === "10.0.3-test");
check("diagnostics: 记录端点", diagnostics.items.endpoints && diagnostics.items.endpoints.ok === true
  && diagnostics.items.endpoints.paths.length === 19);
check("diagnostics: 记录阅读器侧栏面板", diagnostics.items.readerPanel
  && diagnostics.items.readerPanel.ok === true && diagnostics.items.readerPanel.event === "renderToolbar");
check("diagnostics: 记录划词与设置面板", diagnostics.items.reader.ok === true
  && diagnostics.items.prefsPane.ok === true);
check("diagnostics: 记录启动耗时", typeof diagnostics.startupMs === "number" && diagnostics.startupMs >= 0);
check("diagnostics: 启动过程无错误", diagnostics.errors.length === 0);
check("diagnostics: 快照不含密钥", !JSON.stringify(diagnostics).includes("test-key"));
check("diagnostics: 只记录会话存档，不再记录 AI 大纲与右键菜单",
  diagnostics.items.store && diagnostics.items.store.mode === "attachment"
  && !diagnostics.items.outline && !diagnostics.items.menu);
check("bootstrap: 不再注册 AI 大纲右键菜单", calls.menus.length === 0);


console.log("");
console.log("== 自检端点 ==");
const selfTestEndpoint = new Zotero.Server.Endpoints["/sideline/selftest"]();
const [selfTestCode, , selfTestBody] = await selfTestEndpoint.init({ data: {} });
equal("selftest: 返回 200", selfTestCode, 200);
const selfTestJson = JSON.parse(selfTestBody);
check("selftest: 无 itemID 时不失败", selfTestJson.ok === true && selfTestJson.failed === 0);
check("selftest: 跳过条目与模型检查", selfTestJson.checks.some((entry) => entry.name === "条目检查"
  && entry.status === "skip") && selfTestJson.checks.some((entry) => entry.name === "模型调用"
  && entry.status === "skip"));
check("selftest: 带回启动诊断", !!selfTestJson.diagnostics.items.readerPanel);
check("selftest: 带配置摘要且无密钥", selfTestJson.config.keyPresent === true
  && !JSON.stringify(selfTestJson).includes("test-key"));

const [selfTestItemCode, , selfTestItemBody] = await selfTestEndpoint.init({ data: { itemID: 100 } });
const selfTestItem = JSON.parse(selfTestItemBody);
equal("selftest: 带 itemID 返回 200", selfTestItemCode, 200);
check("selftest: 报告条目与附件", selfTestItem.checks.some((entry) => entry.name === "条目"
  && entry.status === "pass") && selfTestItem.checks.some((entry) => entry.name === "条目类型"
  && entry.detail === "普通文献条目") && selfTestItem.checks.some((entry) => entry.name === "PDF/EPUB 附件"
  && entry.status === "pass"));
check("selftest: 报告正文可用", selfTestItem.checks.some((entry) => entry.name === "正文可读取"
  && entry.status === "pass" && entry.detail.includes("120")));
check("selftest: 带 itemID 时全部通过", selfTestItem.ok === true && selfTestItem.failed === 0);

const noAttachmentSelfTest = JSON.parse((await selfTestEndpoint.init({ data: { itemID: 101 } }))[2]);
check("selftest: 无附件时跳过附件检查", noAttachmentSelfTest.checks.some((entry) => entry.name === "PDF/EPUB 附件"
  && entry.status === "skip") && noAttachmentSelfTest.ok === true);
const [, , selfTestBadBody] = await selfTestEndpoint.init({ data: { itemID: 999999 } });
const selfTestBad = JSON.parse(selfTestBadBody);
check("selftest: 无效条目报失败", selfTestBad.ok === false && selfTestBad.failed >= 1);

console.log("");
console.log("== 划词面板批注写回 ==");
const popupDoc = {
  documentElement: makeFakeElement("window"),
  head: null,
  createElement: (tag) => makeFakeElement(tag),
  createElementNS: (ns, tag) => makeFakeElement(tag),
  querySelector: () => null,
};
popupDoc.head = popupDoc.documentElement.appendChild(makeFakeElement("head"));
const appended = [];
const popupAnnotation = {
  type: "highlight",
  color: "#ffd400",
  sortIndex: "00001|00000010",
  pageLabel: "1",
  text: "选区原文一段",
  position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
};
// 提示词改写要在弹窗构建前生效（按钮在构建时取当前生效的提示词）
Zotero.Prefs.set("sideline.promptTranslate", "把这段翻成英文，只给译文");
calls.readerListeners[0].handler({
  doc: popupDoc,
  reader: { itemID: 200 },
  params: { annotation: popupAnnotation },
  append: (element) => appended.push(element),
});
equal("reader: 追加一个面板容器", appended.length, 1);
const popup = appended[0];
check("reader: 面板含文本翻译按钮与多行输入区（不再有单行输入框）",
  !!findByText(popup, "文本翻译") && !!findByTag(popup, "TEXTAREA")
  && !findByTag(popup, "INPUT"));
// 0.8.1：快捷功能与「加入对话」并排放在同一行（用户反馈原来各占一行太浪费空间）
const actionRow = findAll(popup, (node) => node.tagName === "DIV"
  && String(node.className).split(/\s+/).includes("sideline-reader-row")
  && node.children.some((child) => child.tagName === "BUTTON"
    && child.textContent.trim() === "加入对话"))[0] || null;
check("reader: 快捷功能与「加入对话」在同一行，且快捷功能在前",
  !!actionRow
  && actionRow.children.filter((child) => child.tagName === "BUTTON")
    .map((child) => child.textContent.trim()).join("|") === "文本翻译|加入对话");
check("reader: 「加入对话」带主操作类 sideline-reader-primary",
  String(findByText(popup, "加入对话").className).includes("sideline-reader-primary"));
check("reader: 存为批注/存为笔记/复制回答 仍在独立工具行里",
  (() => {
    const tools = findByClass(popup, "sideline-reader-tools");
    return !!tools && tools.children.filter((child) => child.tagName === "BUTTON")
      .map((child) => child.textContent.trim()).join("|") === "存为批注|存为笔记|复制回答";
  })());
// 弹窗样式取自 reader.js 里那段 CSS 模板字符串（这里单独读一次，别依赖后面才定义的变量）
const readerSource = fs.readFileSync(path.join(projectRoot, "src", "modules", "reader.js"), "utf8");
check("样式: 弹窗按钮平时就有浅底与描边（不再是透明幽灵态）",
  /\.sideline-reader button\{[^}]*background:var\(--slr-btn\)/.test(readerSource)
  && /\.sideline-reader button\{[^}]*border:1px solid var\(--slr-border\)/.test(readerSource)
  && !/\.sideline-reader button\{[^}]*background:transparent/.test(readerSource));
check("样式: 引用卡片用强调浅底，和输入框/回答区分开",
  /\.sideline-reader-card\{[^}]*background:var\(--slr-accent-soft\)/.test(readerSource));
check("reader: 输入区是 3 行文本区且没有「提问」按钮（回车发送）",
  findByTag(popup, "TEXTAREA").attributes.rows === "3"
  && !findAll(popup, (node) => node.tagName === "BUTTON" && node.textContent.trim() === "提问").length);

findByText(popup, "翻译").listeners.click[0]();
await sleep(140);
const popupAnswer = findByClass(popup, "sideline-reader-answer");
check("reader: 模板提问得到回答", popupAnswer.textContent.includes("非流式回答"));
check("reader: 弹窗回答也渲染成 HTML",
  String(popupAnswer.innerHTML).includes("<p>")
  && !String(popupAnswer.innerHTML).includes("**"));
check("reader: 弹窗只留带 popup 标记的功能（当前只有文本翻译）",
  !!findByText(popup, "文本翻译")
  && !findByText(popup, "解释选区") && !findByText(popup, "逻辑数理")
  && !findByText(popup, "全文总结") && !findByText(popup, "自动高亮"));
check("reader: 弹窗保留加入对话与写回入口",
  !!findByText(popup, "加入对话") && !!findByText(popup, "存为批注")
  && !!findByText(popup, "存为笔记") && !!findByText(popup, "复制回答"));
check("reader: 已改写的功能在按钮上注明",
  String(findByText(popup, "文本翻译").attributes.title).includes("改写过"));
const popupCallsBefore = calls.http.length;
findByText(popup, "文本翻译").listeners.click[0]();
await sleep(140);
check("reader: 弹窗提问用设置里的同名提示词",
  calls.http.length === popupCallsBefore + 1
  && JSON.parse(calls.http[calls.http.length - 1].options.body).messages
    .some((message) => String(message.content).includes("把这段翻成英文，只给译文")));
Zotero.Prefs.set("sideline.promptTranslate", "");

// 弹窗输入区：回车发送、Shift+Enter 换行（用户要求，删掉了「提问」按钮）
const popupInput = findByTag(popup, "TEXTAREA");
popupInput.value = "画个重点";
const popupCallsBeforeEnter = calls.http.length;
let popupEnterPrevented = false;
popupInput.dispatch("keydown", { key: "Enter", shiftKey: false, preventDefault: () => { popupEnterPrevented = true; } });
await sleep(140);
check("reader: 弹窗里回车即发送（不需要点按钮）",
  popupEnterPrevented === true && calls.http.length === popupCallsBeforeEnter + 1);
let popupShiftPrevented = false;
popupInput.dispatch("keydown", { key: "Enter", shiftKey: true, preventDefault: () => { popupShiftPrevented = true; } });
await sleep(60);
check("reader: 弹窗里 Shift+Enter 只换行不发送",
  popupShiftPrevented === false && calls.http.length === popupCallsBeforeEnter + 1);

const annotateButton = findByText(popup, "存为批注");
check("reader: 有坐标时批注按钮可用", !!annotateButton && annotateButton.disabled === false);
const beforeAnnotate = calls.annotations.length;
annotateButton.listeners.click[0]();
await sleep(60);
equal("reader: 点击后写入一条批注", calls.annotations.length, beforeAnnotate + 1);
const readerAnnotation = calls.annotations[calls.annotations.length - 1];
check("reader: 批注评论为模型回答", readerAnnotation.json.comment.includes("非流式回答"));
check("reader: 批注写入到阅读器的附件", readerAnnotation.attachment.id === 200);
equal("reader: 批注颜色取首选项", readerAnnotation.json.color, "#ffd400");
check("reader: 状态行提示已写入",
  findByClass(popup, "sideline-reader-status").textContent.includes("已写入批注"));

Zotero.Prefs.set("sideline.readerAnnotationWrite", false);
annotateButton.listeners.click[0]();
await sleep(40);
equal("reader: 关闭开关后不写库", calls.annotations.length, beforeAnnotate + 1);
check("reader: 关闭开关时给出说明",
  findByClass(popup, "sideline-reader-status").textContent.includes("关闭"));
Zotero.Prefs.set("sideline.readerAnnotationWrite", true);

const appendedWithoutPosition = [];
calls.readerListeners[0].handler({
  doc: popupDoc,
  reader: { itemID: 200 },
  params: { annotation: { text: "没有坐标的选区" } },
  append: (element) => appendedWithoutPosition.push(element),
});
const disabledAnnotate = findByText(appendedWithoutPosition[0], "存为批注");
check("reader: 无坐标时批注按钮禁用并说明原因", !!disabledAnnotate && disabledAnnotate.disabled === true
  && String(disabledAnnotate.attributes.title || "").includes("坐标"));

console.log("");
console.log("== 本轮材料清单 ==");
const materialList = [];
const selectionMaterial = Sideline.materials.fromSelection({
  text: "选中的一段原文",
  pageIndex: 4,
  pageLabel: "3",
  rects: [[10, 20, 30, 40]],
});
equal("materials: 选区标签带页码", selectionMaterial.label, "选区原文（第 3 页）");
equal("materials: 选区字数与状态", `${selectionMaterial.chars}|${selectionMaterial.state}`, "7|ok");
check("materials: 同内容选区可判重", !!Sideline.materials.duplicateOf([selectionMaterial],
  Sideline.materials.fromSelection({ text: "选中的一段原文", pageIndex: 4, pageLabel: "3" })));
Sideline.materials.add(materialList, selectionMaterial);
Sideline.materials.add(materialList, Sideline.materials.fromPage({
  text: "第 3 页正文内容",
  pageIndex: 2,
  pageLabel: "3",
}));
Sideline.materials.add(materialList, Sideline.materials.fromPaste({ text: "粘贴进来的文字" }));
const documentMaterial = Sideline.materials.fromDocument({
  text: "全文正文",
  pages: [0, 1],
  pageCount: 3,
  emptyPages: [2],
  truncated: false,
});
check("materials: 全文材料详情报告覆盖页与空白页",
  documentMaterial.detail.includes("覆盖 2 页") && documentMaterial.detail.includes("空白页 3"));
Sideline.materials.add(materialList, documentMaterial);
Sideline.materials.add(materialList, Sideline.materials.fromImage({
  name: "图.png",
  dataUrl: "data:image/png;base64,AAAA",
}));
Sideline.materials.add(materialList, Sideline.materials.create("path", {
  label: "文件：缺失.pdf",
  error: "文件不存在",
}));
equal("materials: 清单共 6 项", materialList.length, 6);
check("materials: 汇总文本报出失败项",
  Sideline.materials.summaryText(materialList).includes("1 项读取失败"));
check("materials: 移除按 id 生效",
  Sideline.materials.remove([...materialList], selectionMaterial.id) !== null);

const fullAssembly = Sideline.materials.assemble(materialList, { maxChars: 0 });
check("materials: 读取失败的材料不送入",
  fullAssembly.items.find((item) => item.kind === "path").included === false
  && fullAssembly.items.find((item) => item.kind === "path").reason.includes("文件不存在"));
check("materials: 图片单独进入 images 且不计文本",
  fullAssembly.images.length === 1 && fullAssembly.images[0].startsWith("data:image/png"));
check("materials: 文本块带页码标记",
  fullAssembly.text.includes("【选区原文（第 3 页）】") && fullAssembly.text.includes("【第 3 页正文】"));
check("materials: 全文材料的块标题为 PDF 正文", fullAssembly.text.includes("【PDF 正文】"));
check("materials: 选区材料附带引用锚点（可跳回）",
  selectionMaterial.rects.length === 1 && selectionMaterial.pageIndex === 4);

const budgeted = Sideline.materials.assemble(materialList, { maxChars: 16 });
check("materials: 预算不足时截断并标记", budgeted.truncated === true
  && budgeted.items.some((item) => item.truncated && item.sentChars < item.chars));
check("materials: 预算耗尽后的材料不送入", budgeted.dropped.length > 0);
check("materials: 装配字数不超过预算", budgeted.chars <= 16);

console.log("");
console.log("== 功能注册表 ==");
const functionList = Sideline.functions.list();
check("functions: 只保留用户点名的四个功能",
  functionList.length === 4
  && ["summarize", "explain", "translate", "highlight"]
    .every((id) => functionList.some((entry) => entry.id === id))
  && !functionList.some((entry) => entry.id === "page" || entry.id === "keypoints"));
check("functions: 功能名与用户给的一致",
  functionList.map((entry) => entry.name).join(",") === "全文总结,解释选区,文本翻译,自动高亮");
equal("functions: 全文总结作用于全文", Sideline.functions.scopeOf("summarize"), "document");
equal("functions: 文本翻译作用于选区", Sideline.functions.scopeOf("translate"), "selection");
equal("functions: 自动高亮作用于全文", Sideline.functions.scopeOf("highlight"), "document");
check("functions: 下拉栏列出全部四个功能", Sideline.functions.menu().length === 4);
check("functions: 划词弹窗只用选区功能",
  Sideline.functions.selectionFunctions().map((entry) => entry.id).join(",") === "explain,translate");
check("functions: 划词弹窗实际只列带 popup 标记的功能（当前仅文本翻译）",
  Sideline.functions.popupFunctions().map((entry) => entry.id).join(",") === "translate");
check("functions: popup 标记不影响侧栏下拉与选区功能列表",
  Sideline.functions.menu().length === 4
  && Sideline.functions.selectionFunctions().length === 2
  && Sideline.functions.list().filter((entry) => entry.popup).length === 1);
check("functions: 选区缺失时降级到全文",
  Sideline.functions.resolveScope("translate", { selection: false, page: false, document: true }).scope === "document");
check("functions: 选区缺失但有当前页时降级到当前页",
  Sideline.functions.resolveScope("translate", { selection: false, page: true, document: true }).scope === "page");
check("functions: 范围齐备时不降级",
  Sideline.functions.resolveScope("translate", { selection: true }).downgraded === false);
check("functions: 范围说明可读", Sideline.functions.scopeText("document") === "全文");
check("functions: 全文总结用 paper-review 提示词",
  Sideline.functions.promptOf("summarize").includes("摘要翻译")
  && Sideline.functions.promptOf("summarize").includes("附加输出"));
check("functions: 每个功能都绑定了一个可改写的首选项",
  functionList.every((entry) => entry.pref && entry.pref.startsWith("prompt")));
Zotero.Prefs.set("sideline.promptExplain", "改写后的解释提示词");
check("functions: 设置里可逐条改写提示词",
  Sideline.functions.promptOf("explain") === "改写后的解释提示词"
  && Sideline.functions.byId("explain").customized === true
  && Sideline.functions.byId("explain").builtin.includes("面向初次接触"));
check("functions: 未改写的功能仍用内置提示词",
  Sideline.functions.promptOf("translate").includes("学术中文")
  && Sideline.functions.byId("translate").customized === false);
Zotero.Prefs.set("sideline.promptExplain", "");
check("functions: 清空首选项后回到内置提示词",
  Sideline.functions.promptOf("explain").includes("面向初次接触"));

console.log("");
console.log("== 模型通道与视觉路由 ==");
check("providers: 默认文本通道为 deepseek", Sideline.providers.current() === "api");
check("providers: 视觉模型留空时沿用主模型",
  Sideline.providers.deepseekVisionModel({ model: "deepseek-flash" }) === "deepseek-flash");
check("providers: 视觉模型可单独指定",
  Sideline.providers.deepseekVisionModel({ model: "x", deepseekVisionModel: "v-model" }) === "v-model");
check("providers: Agent 和视觉 API 均可承载图片",
  Sideline.providers.supportsImages("vision") === true
  && Sideline.providers.supportsImages("agent") === true);
Zotero.Prefs.set("sideline.provider", "codex");
const codexTextRoute = Sideline.providers.route({ images: [], config: Sideline.config.read() });
check("providers: 纯文本请求按文本通道走", codexTextRoute.provider === "agent"
  && codexTextRoute.forcedByImages === false);
const codexImageRoute = Sideline.providers.route({
  images: ["data:image/png;base64,AA"],
  config: Sideline.config.read(),
});
check("providers: Agent 图片不改道视觉 API",
  codexImageRoute.provider === "agent" && codexImageRoute.forcedByImages === false
  && codexImageRoute.requested === "agent");
check("providers: 含图片时视觉校验只要求模型名可用",
  Sideline.providers.checkVision(["data:image/png;base64,AA"]).ok === true);
check("providers: 视觉模型与主模型都为空时报错", (() => {
  const savedModel = Zotero.Prefs.get("sideline.model");
  const savedVision = Zotero.Prefs.get("sideline.deepseekVisionModel");
  Zotero.Prefs.set("sideline.model", "");
  Zotero.Prefs.set("sideline.deepseekVisionModel", "");
  const result = Sideline.providers.checkVision(["data:image/png;base64,AA"]);
  Zotero.Prefs.set("sideline.model", savedModel || "deepseek-chat");
  Zotero.Prefs.set("sideline.deepseekVisionModel", savedVision || "");
  return result.ok === false && result.reason.includes("视觉模型");
})());
check("providers: 无图片时不做视觉校验", Sideline.providers.checkVision([]).ok === true);
Zotero.Prefs.set("sideline.provider", "deepseek");

const multimodal = Sideline.providers.attachImages([
  { role: "system", content: "system" },
  { role: "user", content: "看这张图" },
], ["data:image/png;base64,AA"]);
check("providers: 图片挂到最后一条 user 消息的块数组上",
  Array.isArray(multimodal[1].content) && multimodal[1].content[0].type === "text"
  && multimodal[1].content[1].type === "image_url"
  && multimodal[1].content[1].image_url.url === "data:image/png;base64,AA");
check("providers: system 消息保持纯文本", typeof multimodal[0].content === "string");
check("providers: 没有 user 消息时补一条",
  Sideline.providers.attachImages([{ role: "system", content: "s" }], ["data:image/png;base64,AA"])
    .slice(-1)[0].role === "user");
check("providers: Codex 提示词把系统与历史拍平",
  Sideline.providers.renderPrompt([
    { role: "system", content: "系统指令" },
    { role: "user", content: "问题" },
    { role: "assistant", content: "回答" },
  ]).includes("【系统指令】\n系统指令"));
check("providers: describe 报告两条通道与固定的视觉通道",
  Sideline.providers.describe().available.length === 3
  && Sideline.providers.describe().visionProvider === "vision"
  && Sideline.providers.label("agent") === "本地 Agent");

const visionCallStart = calls.http.length;
const visionResult = await Sideline.providers.chat({
  messages: [{ role: "user", content: "描述这张图" }],
  images: ["data:image/png;base64,AA"],
  config: Object.assign({}, Sideline.config.read(), { stream: false }),
});
const visionBody = JSON.parse(calls.http[visionCallStart].options.body);
equal("providers: 视觉请求走 deepseek 通道", visionResult.provider, "vision");
equal("providers: 视觉请求模型沿用主模型", visionBody.model, "deepseek-chat");
check("providers: 视觉请求体含 image_url 块", Array.isArray(visionBody.messages[0].content)
  && visionBody.messages[0].content.some((block) => block.type === "image_url"));
check("providers: 结果带耗时与图片数",
  typeof visionResult.elapsedMs === "number" && visionResult.images === 1);
check("providers: 文本通道选 codex 时图片请求走 Agent", (() => {
  Zotero.Prefs.set("sideline.provider", "codex");
  const routed = Sideline.providers.route({
    images: ["data:image/png;base64,AA"],
    config: Sideline.config.read(),
  });
  Zotero.Prefs.set("sideline.provider", "deepseek");
  return routed.provider === "agent" && routed.forcedByImages === false;
})());

console.log("");
console.log("== 阅读器按页取文与锚定 ==");
/** 阅读器外壳 DOM 桩：支持 id/class 查询、XHTML 建元素与 style 变量 */
function makeReaderShellDom() {
  const doc = {
    head: makeFakeElement("head"),
    body: makeFakeElement("body"),
    documentElement: makeFakeElement("html"),
  };
  doc.documentElement.__connected = true;
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.createElementNS = (ns, tag) => {
    const element = makeFakeElement(tag);
    element.namespaceURI = ns || "http://www.w3.org/1999/xhtml";
    return element;
  };
  doc.createElement = (tag) => doc.createElementNS(null, tag);
  // 0.8.0：菜单的"点外面收起/Esc 收起/滚动收起"要靠文档级监听，假文档也要能注册与记账
  doc.listeners = {};
  doc.addEventListener = (type, handler) => {
    (doc.listeners[type] = doc.listeners[type] || []).push(handler);
  };
  doc.removeEventListener = (type, handler) => {
    doc.listeners[type] = (doc.listeners[type] || []).filter((entry) => entry !== handler);
  };
  doc.getElementById = (id) => queryAll(doc.documentElement, `[id="${id}"]`)[0] || null;
  doc.querySelector = (selector) => queryOne(doc.documentElement, selector);
  doc.querySelectorAll = (selector) => queryAll(doc.documentElement, selector);
  return doc;
}

/** 阅读器外壳：Zotero 的侧栏容器与三个视图按钮由 React 渲染，这里手工搭出同样的结构 */
function buildSidebarShell(doc) {
  const container = doc.createElementNS(null, "div");
  container.setAttribute("id", "sidebarContainer");
  const toolbar = doc.createElementNS(null, "div");
  toolbar.className = "sidebar-toolbar";
  const start = doc.createElementNS(null, "div");
  start.className = "start";
  toolbar.appendChild(start);
  container.appendChild(toolbar);
  const content = doc.createElementNS(null, "div");
  content.setAttribute("id", "sidebarContent");
  container.appendChild(content);
  for (const id of ["viewThumbnail", "viewAnnotations", "viewOutline"]) {
    const button = doc.createElementNS(null, "button");
    button.setAttribute("id", id);
    container.appendChild(button);
  }
  doc.body.appendChild(container);
  return { container, start, content };
}

// 同时打开两篇 PDF 时不能因为 tabID/itemID 复用而共享状态；同一实例若 iframe 文档被
// Zotero 重建，也必须丢弃旧 DOM 状态并新建。
const identityDocA = makeReaderShellDom();
const identityDocB = makeReaderShellDom();
const identityStateA = Sideline.readerside.stateOf({
  itemID: 6901, tabID: "shared-tab", _instanceID: "reader-instance-a",
  _iframeWindow: { document: identityDocA },
});
const identityStateB = Sideline.readerside.stateOf({
  itemID: 6902, tabID: "shared-tab", _instanceID: "reader-instance-b",
  _iframeWindow: { document: identityDocB },
});
check("readerside: 两个 PDF 阅读器实例各自拥有独立状态",
  identityStateA !== identityStateB && identityStateA.key !== identityStateB.key);
const identityDocA2 = makeReaderShellDom();
const identityStateA2 = Sideline.readerside.stateOf({
  itemID: 6901, tabID: "shared-tab", _instanceID: "reader-instance-a",
  _iframeWindow: { document: identityDocA2 },
});
check("readerside: 同一实例的 iframe 文档重建后会刷新状态",
  identityStateA2 !== identityStateA && identityStateA2.doc === identityDocA2);
Sideline.readerside.states.delete("reader-instance-a");
Sideline.readerside.states.delete("reader-instance-b");

const fakePdfItems = [
  { str: "摘要", transform: [10, 0, 0, 10, 72, 700], width: 20, height: 10 },
  { str: "本文讨论核结构", transform: [10, 0, 0, 10, 95, 700], width: 90, height: 10 },
  { str: "第二行内容", transform: [10, 0, 0, 10, 72, 680], width: 60, height: 10 },
];
const fakePageObject = {
  getTextContent: async () => ({ items: fakePdfItems }),
  // 实测：跨 compartment 后 width/height 会变 null，只剩 rotation；此时必须退回 page.view
  getViewport: ({ scale }) => ({
    width: null,
    height: null,
    rotation: 0,
    convertToViewportRectangle: (rect) => [
      rect[0] * scale, 792 - rect[3] * scale, rect[2] * scale, 792 - rect[1] * scale,
    ],
  }),
  view: [0, 0, 612, 792],
};
const pdfDocDom = makeReaderShellDom();
const pdfPageElement = pdfDocDom.createElementNS(null, "div");
pdfPageElement.className = "page";
pdfPageElement.setAttribute("data-page-number", "2");
pdfPageElement.clientWidth = 1224;
pdfPageElement.scrollIntoView = () => {
  pdfPageElement.scrolled = true;
};
pdfDocDom.body.appendChild(pdfPageElement);
const fakePdfDocument = {
  numPages: 3,
  getPage: async () => fakePageObject,
  getPageLabels2: async () => ["i", "1", "2"],
};
const pdfWindow = {
  // 阅读器窗口也有自己的 browsingContext：用来验证"没有拿它当父窗口"
  browsingContext: { id: "bc-reader" },
  PDFViewerApplication: { pdfDocument: fakePdfDocument, page: 2 },
  document: pdfDocDom,
  MutationObserver: null,
};
const textReader = { itemID: 8001, tabID: "tab-text", type: "pdf", _iframeWindow: pdfWindow, _internalReader: {} };
Zotero.Reader._readers = [textReader];
Sideline.readertext.clearCache();
check("readertext: 找到 pdf.js 应用",
  !!Sideline.readertext.resolve(textReader));
equal("readertext: 总页数来自 pdfDocument", Sideline.readertext.pageCount(textReader), 3);
const textPage = await Sideline.readertext.page(textReader, 1);
equal("readertext: 按页取到文本片段", textPage.spans.length, 3);
equal("readertext: 页状态与来源", `${textPage.state}|${textPage.source}`, "ok|pdfjs");
check("readertext: 片段带页面空间矩形（e/f 换成包围盒）",
  textPage.spans[0].rect[0] === 72 && textPage.spans[0].rect[2] === 92
  && textPage.spans[0].rect[1] < 700 && textPage.spans[0].rect[3] > 700);
check("readertext: 视口为 null 时退回 page.view",
  textPage.viewport.width === 612 && textPage.viewport.height === 792);
equal("readertext: 纸面页码取自 getPageLabels2", await Sideline.readertext.labelOf(textReader, 1), "1");
equal("readertext: 单页纯文本", await Sideline.readertext.pageText(textReader, 1), "摘要本文讨论核结构第二行内容");
check("readertext: 页缓存生效", Sideline.readertext.cacheStats().pages >= 1);

const located = await Sideline.readertext.locate(textReader, { pageIndex: 1, text: "本文讨论核结构" });
check("readertext: 反查原文命中片段区间",
  located.found === true && located.from === 1 && located.to === 1 && located.match.includes("核结构"));
const strictMissing = await Sideline.readertext.locate(textReader,
  { pageIndex: 1, text: "本文讨论核结构以及不存在的额外句子", exact: true });
check("readertext: sentence anchors reject matching only a short prefix", !strictMissing.found);
const strictJoined = await Sideline.readertext.locate(textReader,
  { pageIndex: 1, text: "本文讨论 核结构", exact: true });
check("readertext: exact anchors tolerate layout whitespace", strictJoined.found && !strictJoined.approximate);
const getPageBeforeStrict = fakePdfDocument.getPage;
try {
  fakePdfDocument.getPage = async () => ({ ...fakePageObject,
    getTextContent: async () => ({ items: [{ ...fakePdfItems[0], str: "😀" }, { ...fakePdfItems[1], str: "A sufficiently long literal source sentence ends here." }] }) });
  const fabricatedTail = await Sideline.readertext.locate({ ...textReader, itemID: 59331 },
    { pageIndex: 1, text: "A sufficiently long literal invented remainder", exact: true });
  check("readertext: full quotation rejects a matching 24-character prefix with an invented remainder", !fabricatedTail.found);
  const afterSymbol = await Sideline.readertext.locate({ ...textReader, itemID: 59331 },
    { pageIndex: 1, text: "A sufficiently long literal source sentence ends here.", exact: true });
  check("readertext: non-BMP symbols do not shift sentence geometry", afterSymbol.found && afterSymbol.from === 1 && afterSymbol.to === 1);
} finally { fakePdfDocument.getPage = getPageBeforeStrict; }
const locatedMissing = await Sideline.readertext.locate(textReader, { pageIndex: 1, text: "这一段并不存在" });
check("readertext: 反查失败时给出原因", locatedMissing.found === false && locatedMissing.error.includes("未找到"));
const rangeRects = await Sideline.readertext.rectsForRange(textReader, 1, 0, 2);
check("readertext: 区间矩形按行合并", rangeRects.rects.length === 2 && rangeRects.spans === 3);

const documentTextResult = await Sideline.readertext.documentText(textReader, { maxChars: 0 });
check("readertext: 全文拼装带页码标记", documentTextResult.text.includes("【第 1 页】")
  && documentTextResult.pages.length === 3 && documentTextResult.emptyPages.length === 0);
check("readertext: 全文受限时标记截断",
  (await Sideline.readertext.documentText(textReader, { maxChars: 10 })).truncated === true);
const coverage = await Sideline.readertext.coverage(textReader);
check("readertext: 覆盖状态逐页统计", coverage.pageCount === 3 && coverage.okPages.length === 3
  && coverage.emptyPages.length === 0 && coverage.failedPages.length === 0 && coverage.complete === true);
const jumped = await Sideline.readertext.jump(textReader, { pageIndex: 1, rects: rangeRects.rects });
check("readertext: 跳回原文会滚动并画高亮",
  jumped.ok === true && jumped.flashed === 2 && pdfPageElement.scrolled === true);

// 0.7.1：跳转分层——优先 Zotero 阅读器自己的 navigate，其次是 pdf.js，最后才是滚 DOM 元素
calls.navigate.length = 0;
calls.scrollPageIntoView.length = 0;
pdfPageElement.scrolled = false;
textReader.navigate = async (location) => {
  calls.navigate.push(location);
};
const jumpedViaReader = await Sideline.readertext.jump(textReader, { pageIndex: 1 });
const jumpedAtSentence = await Sideline.readertext.jump(textReader, { pageIndex: 1, rects: rangeRects.rects });
check("readertext: sentence navigation passes a locally computed position to native highlight",
  jumpedAtSentence.ok && jumpedAtSentence.flashed === rangeRects.rects.length
  && calls.navigate.at(-1).position.pageIndex === 1 && calls.navigate.at(-1).position.rects === rangeRects.rects);
calls.navigate.pop();
delete textReader.navigate;
check("readertext: 跳转优先用 reader.navigate({pageIndex})，不退回 DOM 滚动",
  jumpedViaReader.ok === true
  && calls.navigate.length === 1 && calls.navigate[0].pageIndex === 1
  && calls.scrollPageIntoView.length === 0 && pdfPageElement.scrolled === false);
calls.navigate.length = 0;
pdfWindow.PDFViewerApplication.pdfViewer = {
  scrollPageIntoView: (arg) => calls.scrollPageIntoView.push(arg),
};
const jumpedViaPdfjs = await Sideline.readertext.jump(textReader, { pageIndex: 2, rects: rangeRects.rects });
delete pdfWindow.PDFViewerApplication.pdfViewer;
check("readertext: 没有 navigate 时退回 pdf.js 的 scrollPageIntoView",
  calls.scrollPageIntoView.length === 1 && calls.scrollPageIntoView[0].pageNumber === 3);
// 0.8.1：ok 表示"跳转有没有完成"，高亮只是附加效果——页面没渲染出来不再整体报失败
check("readertext: 有 rects 但页面没渲染出来时仍算跳转成功，只说明没画高亮",
  jumpedViaPdfjs.ok === true && jumpedViaPdfjs.flashed === 0
  && jumpedViaPdfjs.reason.includes("没有渲染出来")
  && jumpedViaPdfjs.reason.includes("没有画高亮"));
// 无 rects（回答里的页码链接）时不等页面、直接成功
calls.scrollPageIntoView.length = 0;
pdfWindow.PDFViewerApplication.pdfViewer = {
  scrollPageIntoView: (arg) => calls.scrollPageIntoView.push(arg),
};
const jumpedNoRects = await Sideline.readertext.jump(textReader, { pageIndex: 2 });
delete pdfWindow.PDFViewerApplication.pdfViewer;
check("readertext: 无 rects 时（页码链接）翻页成功即返回成功、不轮询",
  jumpedNoRects.ok === true && jumpedNoRects.flashed === 0 && jumpedNoRects.reason === "");
check("readertext: 跳转返回值契约不变（ok/pageIndex/reason/flashed）",
  Object.keys(jumpedViaReader).sort().join(",") === "flashed,ok,pageIndex,reason"
  && typeof jumpedViaReader.ok === "boolean" && typeof jumpedViaReader.pageIndex === "number"
  && typeof jumpedViaReader.reason === "string" && typeof jumpedViaReader.flashed === "number");
const jumpedNoReader = await Sideline.readertext.jump(null, { pageIndex: 0 });
check("readertext: 拿不到阅读器时如实报错且不抛异常",
  jumpedNoReader.ok === false && jumpedNoReader.reason.includes("阅读器文档"));

// 0.7.2：文件选择器。Gecko 140 的 nsIFilePicker.init() 只收 browsingContext（不是 window），
// 且 show() 已被移除、只剩 open(callback)——所以父窗口取 .browsingContext，取消/选中走回调。
calls.pickerInit.length = 0;
pickerState.filters.length = 0;
pickerState.openCallbacks.length = 0;
pickerState.ret = 3; // 假宿主的 returnCancel
const pickedCancel = Sideline.inputs.pickFiles({ win: pdfWindow });
check("inputs: init() 收到的是主窗口的 browsingContext（不是阅读器窗口，也不是窗口本身）",
  calls.pickerInit.length === 1
  && calls.pickerInit[0][0] === fakeWindow.browsingContext
  && calls.pickerInit[0][0] !== pdfWindow.browsingContext
  && calls.pickerInit[0][0] !== fakeWindow);
check("inputs: 走 open 回调后同步返回 {cancelled:true, paths:[]}（不是 Promise）",
  pickedCancel.cancelled === true && pickedCancel.paths.length === 0
  && !(pickedCancel instanceof Promise)
  && pickerState.openCallbacks.length === 0);
check("inputs: 过滤器里同时含文本与 PDF 扩展名",
  pickerState.filters.some((entry) => String(entry).includes("*.pdf")));
calls.pickerInit.length = 0;
pickerState.ret = 4; // 假宿主的 returnOK
pickerState.files = [{ path: "C:\\tmp\\a.md" }, { path: "C:\\tmp\\b.png" }];
const pickedOk = Sideline.inputs.pickFiles({ win: pdfWindow });
pickerState.ret = 3;
pickerState.files = [];
check("inputs: 选中文件时返回路径数组",
  pickedOk.cancelled === false
  && pickedOk.paths.join(",") === "C:\\tmp\\a.md,C:\\tmp\\b.png");
calls.pickerInit.length = 0;
const savedCancel = Sideline.history.pickSavePath("sessions.md", { win: pdfWindow });
check("history: 另存为对话框同样传主窗口 browsingContext + modeSave，取消返回空串",
  calls.pickerInit.length === 1
  && calls.pickerInit[0][0] === fakeWindow.browsingContext
  && calls.pickerInit[0][2] === context.Components.interfaces.nsIFilePicker.modeSave
  && savedCancel === "");
const labelsToPages = await Sideline.readertext.pagesFromLabels(textReader, "1-2");
check("readertext: 纸面页码可解析成页索引",
  labelsToPages.pages.join(",") === "1,2" && labelsToPages.missing.length === 0);

const diagReaderTextEndpoint = new Zotero.Server.Endpoints["/sideline/diag/readertext"]();
const [, , diagReaderTextBody] = await diagReaderTextEndpoint.init({ data: { probe: "coverage" } });
const diagReaderTextJson = JSON.parse(diagReaderTextBody);
check("endpoints: diag/readertext 报告页数与覆盖状态",
  diagReaderTextJson.openReaders === 1 && diagReaderTextJson.readers[0].coverage.pageCount === 3
  && diagReaderTextJson.readers[0].coverage.okPages === 3);
const [, , diagPageBody] = await diagReaderTextEndpoint.init({ data: { page: 2, locate: "本文讨论核结构" } });
const diagPageJson = JSON.parse(diagPageBody);
check("endpoints: diag/readertext 单页样本含几何与反查",
  diagPageJson.readers[0].page.spans === 3 && diagPageJson.readers[0].locate.found === true
  && diagPageJson.readers[0].page.viewport.width === 612);

console.log("== 阅读器侧栏面板 ==");
const panelItem = makeRegularItem({ id: 7000, fields: { title: "侧栏测试文献" } });
const panelAttachment = makeAttachment({ id: 7001, parentID: 7000, title: "Full Text PDF" });
const shellDoc = makeReaderShellDom();
const shell = buildSidebarShell(shellDoc);
const observerCallbacks = [];
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    observerCallbacks.push(this);
  }

  observe() {}

  disconnect() {
    this.disconnected = true;
  }
}

let sidebarToggles = 0;
const panelReader = {
  itemID: 7001,
  tabID: "tab-panel",
  type: "pdf",
  _iframeWindow: {
    document: shellDoc,
    MutationObserver: FakeMutationObserver,
  },
  _internalReader: {
    toggleSidebar: () => {
      sidebarToggles++;
      shellDoc.body.classList.add("sidebar-open");
    },
  },
};
Zotero.Reader._readers = [panelReader];
const toolbarListener = calls.readerListeners.find((entry) => entry.type === "renderToolbar");
check("readerside: bootstrap 已注册 renderToolbar 监听", !!toolbarListener);
const toolbarHost = makeFakeElement("div");
toolbarListener.handler({
  reader: panelReader,
  doc: shellDoc,
  append: (node) => toolbarHost.appendChild(node),
});
await sleep(60);
const panelState = Sideline.readerside.stateOf(panelReader);
equal("readerside: 会话挂在宿主条目上", panelState.ownerID, 7000);
check("readerside: 面板注入到 Zotero 侧栏容器",
  !!shellDoc.getElementById("sideline-panel")
  && shellDoc.getElementById("sideline-panel").isConnected === true);
check("readerside: 侧栏里出现 AI 标签按钮",
  !!queryOne(shell.start, ".sideline-panel-toggle"));
check("readerside: 工具栏按钮也加了一个入口",
  !!findByText(toolbarHost, "AI"));
equal("readerside: 面板默认收起", shellDoc.body.classList.contains("sideline-panel-open"), false);
check("readerside: 面板渲染出输入框与发送按钮",
  !!findByTag(panelState.els.panel, "TEXTAREA") && !!panelState.els.sendButton
  && !!panelState.els.stopButton && !!panelState.els.statusEl);
check("readerside: 输入框提高为三行且空白时显示操作提示",
  panelState.els.textarea.attributes.rows === "3"
  && String(panelState.els.textarea.attributes.placeholder).includes("Shift+Enter 换行"));
check("readerside: 阅读器文档注入 KaTeX 样式",
  !!shellDoc.getElementById("sideline-katex-style")
  && String(shellDoc.getElementById("sideline-katex-style").getAttribute("href")).includes("vendor/katex/katex.min.css"));
check("readerside: 无会话时提示还没有对话",
  findByClass(panelState.els.panel, "sideline-hint") !== null);

const httpBeforeSelection = calls.http.length;
const selectionEntry = Sideline.readerside.addSelection(panelReader, {
  text: "选区一：核力是短程吸引",
  pageIndex: 1,
  pageLabel: "2",
  rects: [[10, 20, 30, 40]],
});
await sleep(60);
check("readerside: 选区进入材料清单",
  !!selectionEntry && panelState.materials.some((entry) => entry.kind === "selection"));
equal("readerside: 加入选区不自动发送", calls.http.length, httpBeforeSelection);
check("readerside: 加入选区后打开面板并展开 Zotero 侧栏",
  shellDoc.body.classList.contains("sideline-panel-open") === true && sidebarToggles >= 1);
check("readerside: 材料清单默认收起，不占地方", panelState.els.materialsEl.hidden === true);
check("readerside: 面板上没有一排材料按钮（用户要求的收纳）",
  !findByText(panelState.els.panel, "加入当前页")
  && !findByText(panelState.els.panel, "加入全文")
  && !findByText(panelState.els.panel, "选文件")
  && !findByText(panelState.els.panel, "清空材料")
  && !findByText(panelState.els.panel, "圈选区域")
  && !findByText(panelState.els.panel, "把输入当作材料"));
check("readerside: 功能入口只有一个按钮，未打开时看不到功能名",
  !!panelState.els.functionButton
  && String(panelState.els.functionButton.textContent).includes("功能")
  && !findByText(panelState.els.panel, "全文总结"));
panelState.els.functionButton.listeners.click[0]();
const functionMenu = findByClass(panelState.els.panel, "sl-menu");
check("readerside: 功能菜单列出 5 个功能且带作用范围说明",
  !!functionMenu
  && Sideline.functions.menu().every((fn) => !!findByText(functionMenu, fn.name))
  && String(findByText(functionMenu, "全文总结").textContent).includes("全文"));
findByText(functionMenu, "文本翻译").listeners.click[0]();
check("readerside: 选中功能后出现待执行功能标签（提示词不进对话）",
  String(panelState.els.pendingEl.textContent).includes("文本翻译")
  && !String(panelState.els.pendingEl.textContent).includes("学术中文"));
equal("readerside: 选中功能后隐藏输入框操作提示", panelState.els.textarea.attributes.placeholder, "");
check("readerside: 待执行功能标签位于输入壳内并把光标区右移",
  panelState.els.pendingEl.parentNode === panelState.els.inputShell
  && panelState.els.inputShell.classList.contains("has-pending")
  && Number.parseFloat(panelState.els.inputShell.style.getPropertyValue("--sl-pending-offset")) > 0);
panelState.els.pendingEl.children[1].listeners.click[0]({ type: "click" });
check("readerside: 可取消待执行功能且空输入框恢复操作提示",
  panelState.els.pendingEl.hidden === true
  && String(panelState.els.textarea.attributes.placeholder).includes("Enter 发送"));
panelState.els.textarea.value = "已经输入文字";
panelState.els.textarea.dispatch("input");
equal("readerside: 输入文字后隐藏输入框操作提示", panelState.els.textarea.attributes.placeholder, "");
panelState.els.textarea.value = "";
panelState.els.textarea.dispatch("input");
check("readerside: 清空文字后恢复输入框操作提示",
  String(panelState.els.textarea.attributes.placeholder).includes("Enter 发送"));
panelState.els.contextToggle.listeners.click[0]();
check("readerside: 展开后材料卡片显示页码与跳转入口",
  String(findByClass(panelState.els.materialsEl, "sl-context-item-label").textContent).includes("第 2 页")
  && !!findByClass(panelState.els.materialsEl, "sl-link"));
check("readerside: 材料条概述显示条目数与实际送入字数",
  String(panelState.els.contextSummary.textContent).includes("1 项材料")
  && String(panelState.els.contextSummary.textContent).includes("送入"));
const addButton = findByText(panelState.els.panel, "＋");
addButton.listeners.click[0]();
const materialMenu = findByClass(panelState.els.panel, "sl-menu");
check("readerside: 「＋」菜单收纳全部材料入口",
  !!materialMenu
  && ["加入当前页", "加入全文", "选择文件…", "检索笔记"]
    .every((label) => !!findByText(materialMenu, label)));
check("readerside: 「＋」菜单里不再有清空材料与把输入当作材料",
  !findByText(materialMenu, "清空材料")
  && !findByText(materialMenu, "把输入当作材料"));
// 0.8.0：菜单改成贴着触发按钮"向上展开"，并且点菜单外/按 Esc/滚动都会收起
panelState.els.panel.rect = { top: 0, left: 0, width: 320, height: 600 };
addButton.rect = { top: 544, left: 60, width: 28, height: 28 };
addButton.listeners.click[0]();
const placedMenu = findByClass(panelState.els.panel, "sl-menu");
check("readerside: 菜单贴着触发按钮向上展开（贴不到上方才退到下方）",
  !!placedMenu
  && String(placedMenu.attributes.style).includes("top:")
  && !String(placedMenu.attributes.style).includes("bottom:")
  && Number((String(placedMenu.attributes.style).match(/top:(-?\d+)px/) || [])[1]) < 544);
placedMenu.rect = { top: 0, left: 0, width: 220, height: 120 };
addButton.listeners.click[0]();
const placedMenu2 = findByClass(panelState.els.panel, "sl-menu");
check("readerside: 菜单高度改变后仍贴着按钮上方（不越出面板顶）",
  !!placedMenu2
  && Number((String(placedMenu2.attributes.style).match(/top:(-?\d+)px/) || [])[1]) >= 4
  && Number((String(placedMenu2.attributes.style).match(/top:(-?\d+)px/) || [])[1]) < 544);
check("readerside: 打开菜单时注册了菜单外点击/Esc/滚动监听",
  (shellDoc.listeners.mousedown || []).length === 1
  && (shellDoc.listeners.pointerdown || []).length === 1
  && (shellDoc.listeners.keydown || []).length === 1
  && (shellDoc.listeners.scroll || []).length === 1);
shellDoc.listeners.mousedown[0]({ target: panelState.els.textarea });
check("readerside: 点菜单以外的位置（含输入框）即收起菜单",
  panelState.menu === null && !findByClass(panelState.els.panel, "sl-menu"));
addButton.listeners.click[0]();
check("readerside: 重新打开菜单后按 Esc 也能收起", (() => {
  if (!findByClass(panelState.els.panel, "sl-menu")) return false;
  shellDoc.listeners.keydown[0]({ key: "Escape" });
  return panelState.menu === null && !findByClass(panelState.els.panel, "sl-menu");
})());
addButton.listeners.click[0]();
check("readerside: 面板滚动也会收起菜单", (() => {
  if (!findByClass(panelState.els.panel, "sl-menu")) return false;
  shellDoc.listeners.scroll[0]({});
  return panelState.menu === null;
})());
// 0.8.2：状态行仍在输入壳上方；待执行功能标签进入输入框视觉区域
check("readerside: 状态行在输入框上方（输入框下移）",
  (() => {
    const composer = findByClass(panelState.els.panel, "sl-composer");
    const kids = composer.children || [];
    const statusAt = kids.indexOf(panelState.els.statusEl);
    const shellAt = kids.indexOf(panelState.els.inputShell);
    return statusAt >= 0 && shellAt >= 0 && statusAt < shellAt
      && panelState.els.textarea.parentNode === panelState.els.inputShell
      && panelState.els.pendingEl.parentNode === panelState.els.inputShell;
  })());
// 0.8.0：清空材料挪到材料统计行（「展开/收起」之前）
check("readerside: 材料统计行里有「清空」且在「展开」之前",
  (() => {
    const bar = findByClass(panelState.els.panel, "sl-context-bar");
    const clear = findByText(bar, "清空");
    const toggle = findByText(bar, "展开") || findByText(bar, "收起");
    if (!clear || !toggle) return false;
    return (bar.children || []).indexOf(clear) < (bar.children || []).indexOf(toggle);
  })());
const materialsBeforeClear = panelState.materials.length;
findByText(findByClass(panelState.els.panel, "sl-context-bar"), "清空").listeners.click[0]({ type: "click" });
check("readerside: 点「清空」清空本轮材料并提示",
  materialsBeforeClear > 0 && panelState.materials.length === 0
  && String(panelState.els.statusEl.textContent).includes("已清空本轮材料"));
// 0.8.0：输入框粘贴图片 → 图片材料（用户改走这条路线）
// 收尾时会把图片材料移除、恢复成原来那条选区材料，避免影响后面「发送」相关用例的报文形状
Sideline.readerside.addSelection(panelReader, {
  text: "选区一：核力是短程吸引",
  pageIndex: 1,
  pageLabel: "2",
  rects: [[10, 20, 30, 40]],
});
context.FileReader = class FakeFileReader {
  readAsDataURL() {
    this.result = "data:image/png;base64,UEFTVEVE";
    if (typeof this.onload === "function") this.onload();
  }
};
const materialsBeforePaste = panelState.materials.length;
panelState.els.textarea.dispatch("paste", {
  clipboardData: {
    items: [{
      type: "image/png",
      getAsFile: () => ({ type: "image/png", size: 4096 }),
    }],
  },
  preventDefault() {},
});
await sleep(40);
check("readerside: 粘贴剪贴板图片会变成图片材料",
  panelState.materials.length === materialsBeforePaste + 1
  && panelState.materials.slice(-1)[0].kind === "image"
  && String(panelState.materials.slice(-1)[0].dataUrl).startsWith("data:image/png;base64,"));
check("readerside: 纯文本粘贴不会被拦（没有图片时不 preventDefault）", (() => {
  let prevented = false;
  panelState.els.textarea.dispatch("paste", {
    clipboardData: { items: [{ type: "text/plain" }] },
    preventDefault: () => {
      prevented = true;
    },
  });
  return prevented === false;
})());
// 把粘贴进来的图片材料移除，恢复成"只有一条选区材料"，不要影响后续发送用例
for (const entry of panelState.materials.slice()) {
  if (entry.kind === "image") Sideline.materials.remove(panelState.materials, entry.id);
}
check("readerside: 清空与粘贴用例结束后材料恢复成一条选区",
  panelState.materials.length === 1 && panelState.materials[0].kind === "selection");
const headMore = findByText(panelState.els.panel, "⋯");
headMore.listeners.click[0]();
const sessionMenu = findByClass(panelState.els.panel, "sl-menu");
check("readerside: session menu retains exports/clear and removes undo",
  !!sessionMenu && ["导出为 Markdown", "导出为 JSON", "清空本会话"].every((label) => !!findByText(sessionMenu, label))
  && !String(sessionMenu.textContent).includes("撤销最近一次"));
check("readerside: removed conversation selector and mutations", !panelState.els.sessionSelect
  && !findByText(sessionMenu, "\u65b0\u5efa\u4f1a\u8bdd")
  && !findByText(sessionMenu, "\u91cd\u547d\u540d\u5f53\u524d\u4f1a\u8bdd")
  && !findByText(sessionMenu, "\u5220\u9664\u5f53\u524d\u4f1a\u8bdd"));
check("readerside: function retains label and arrow without SVG", !findByClass(panelState.els.functionButton, "sl-icon")
  && !!findByClass(panelState.els.functionButton, "sl-function-label") && !!findByClass(panelState.els.functionButton, "sl-function-arrow"));
// 0.7.1：顶栏不再放「×」，会话检索改成输入区「＋」旁边的放大镜按钮
const headEl = findByClass(panelState.els.panel, "sl-head");
const headButtons = (headEl.children || []).filter((node) => node.tagName === "BUTTON");
check("readerside: 顶栏只保留「⋯」一个按钮（关闭入口取消）",
  headButtons.length === 1 && String(headButtons[0].textContent).includes("⋯"));
check("readerside: 输入区里「＋」旁边是放大镜搜索按钮",
  !!panelState.els.searchButton
  && String(panelState.els.searchButton.className).includes("sl-search-btn")
  && (panelState.els.searchButton.listeners.click || []).length === 1
  && String(panelState.els.searchButton.attributes.title).includes("搜索会话"));
check("readerside: 输入区一行是 功能 + ＋ + 搜索 + 停止 + 发送",
  (() => {
    const row = findByClass(panelState.els.panel, "sl-composer-row");
    const names = (row.children || []).map((node) => node.tagName + ":"
      + String(node.className).split(/\s+/).filter((part) => part.startsWith("sl-")).join("."));
    return names.length === 5
      && names[1].includes("sl-icon-btn")
      && names[2].includes("sl-search-btn");
  })());
// 0.7.1：Enter 直接发送、Shift+Enter 换行（输入框为空时回车只提示，不会发出请求）
check("readerside: 输入框回车即发送、Shift+Enter 换行",
  (() => {
    const handlers = panelState.els.textarea.listeners.keydown || [];
    if (!handlers.length) return false;
    let enterPrevented = false;
    handlers[0]({ key: "Enter", shiftKey: false, preventDefault: () => { enterPrevented = true; } });
    let shiftPrevented = false;
    handlers[0]({ key: "Enter", shiftKey: true, preventDefault: () => { shiftPrevented = true; } });
    let otherKeyPrevented = false;
    handlers[0]({ key: "a", preventDefault: () => { otherKeyPrevented = true; } });
    return enterPrevented === true && shiftPrevented === false && otherKeyPrevented === false;
  })());

const panelHttpBeforeSend = calls.http.length;
const explainPrompt = Sideline.functions.promptOf("explain");
await Sideline.readerside.send(panelState, { functionId: "explain" });
equal("readerside: 功能请求走一次模型调用", calls.http.length, panelHttpBeforeSend + 1);
const panelSendBody = JSON.parse(calls.http[calls.http.length - 1].options.body);
check("readerside: 系统消息含回答要求（有依据、可定位）",
  panelSendBody.messages[0].content.includes("【回答要求】")
  && panelSendBody.messages[0].content.includes("材料未提及"));
check("readerside: 材料写进系统消息并带页码标记",
  panelSendBody.messages[0].content.includes("【选区原文（第 2 页）】")
  && panelSendBody.messages[0].content.includes("选区一：核力是短程吸引"));
check("readerside: 隐藏提示词送入模型",
  panelSendBody.messages.some((message) => String(message.content).includes(explainPrompt.slice(0, 12))));
const sessionMessages = Sideline.session.list(panelState.ownerID);
const userEntry = sessionMessages.find((entry) => entry.role === "user");
equal("readerside: 对话里只显示功能名", userEntry.display, "解释选区");
const userBubble = findByClass(panelState.els.messagesEl, "sideline-msg-user");
check("readerside: 用户气泡不显示提示词正文",
  String(userBubble.textContent).includes("解释选区")
  && !String(userBubble.textContent).includes("面向初次接触"));
check("readerside: 回答进入会话并渲染",
  sessionMessages.some((entry) => entry.role === "assistant" && entry.content.includes("非流式回答")));
check("readerside: 状态行回报通道、模型、上下文、token 与耗时", (() => {
  const text = String(panelState.els.statusEl.textContent);
  return text.includes("文字 API") && text.includes("deepseek-chat")
    && text.includes("字上下文") && /\d+\.\d+s/.test(text);
})());
const answerMore = findByClass(panelState.els.messagesEl, "sl-msg-more");
check("readerside: 每条回答只留一个「⋯」入口",
  !!answerMore && (answerMore.listeners.click || []).length === 1);
answerMore.listeners.click[0]();
const answerMenu = findByClass(panelState.els.panel, "sl-menu");
check("readerside: 回答菜单保留重试、修改和复制",
  !!answerMenu
  && ["重试上一次", "修改提问", "复制回答"]
    .every((label) => !!findByText(answerMenu, label)));
check("readerside: 普通回答不出现总结与高亮写入项",
  !findByText(answerMenu, "预览并写入总结") && !findByText(answerMenu, "整理为笔记")
  && !findByText(answerMenu, "保存为子笔记"));

const httpBeforeRetry = calls.http.length;
await Sideline.readerside.send(panelState, { retry: true });
equal("readerside: 重试复用上一次请求", calls.http.length, httpBeforeRetry + 1);
equal("readerside: 重试不重复追加用户消息",
  Sideline.session.list(panelState.ownerID).filter((entry) => entry.role === "user").length, 1);

// 自愈：React 重渲染会摘掉注入节点，MutationObserver 触发后应重新挂载
const mountedPanel = shellDoc.getElementById("sideline-panel");
mountedPanel.remove();
check("readerside: 面板被摘掉后 isConnected 为假", mountedPanel.isConnected === false);
equal("readerside: 已注册 DOM 变化监听", observerCallbacks.length, 1);
observerCallbacks[0].callback();
await sleep(320);
const remounted = shellDoc.getElementById("sideline-panel");
check("readerside: 自愈重新挂载面板并保留会话内容",
  !!remounted && remounted.isConnected === true
  && Sideline.session.list(panelState.ownerID).length === 2);
check("readerside: 面板打开状态在重挂载后保持",
  shellDoc.body.classList.contains("sideline-panel-open") === true);

const sessionsEndpoint2 = new Zotero.Server.Endpoints["/sideline/sessions"]();
const [, , panelSessionsBody] = await sessionsEndpoint2.init({ data: { itemID: 7000 } });
const panelSessionsJson = JSON.parse(panelSessionsBody);
check("readerside: 会话通过端点可读出（唯一会话）",
  Array.isArray(panelSessionsJson.sessions) && panelSessionsJson.sessions.length === 1
  && panelSessionsJson.session.messages.length === 2);

// R12：会话累计用量来自每条回答的 usage 与耗时
const panelTotals = Sideline.session.totals(panelState.ownerID);
check("readerside: 会话累计用量统计调用次数与 token",
  panelTotals.calls >= 1 && panelTotals.tokens >= 11
  && String(panelState.els.totalsEl.textContent).includes("次")
  && String(panelState.els.totalsEl.textContent).includes("tokens"));
check("readerside: 回答落盘保留 usage 与耗时",
  Sideline.session.list(panelState.ownerID)
    .some((entry) => entry.role === "assistant" && entry.usage && entry.usage.total_tokens === 11));

// R04：回答里的页码引用变成可点击锚点
const pageRefAnswer = await (async () => {
  const previous = httpResponder;
  httpResponder = async (method, url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    return {
      response: {
        model: body.model || "unknown",
        choices: [{ message: { content: "结论见（第 1 页；原文：“摘要 本文讨论核结构”）。\n\n> 摘要\n\n概括：该文讨论了核结构。" } }],
        usage: { total_tokens: 7 },
      },
      responseText: "",
    };
  };
  try {
    panelState.els.textarea.value = "这一页的结论是什么？";
    await Sideline.readerside.send(panelState, {});
  }
  finally {
    httpResponder = previous;
  }
  return Sideline.session.list(panelState.ownerID).slice(-1)[0];
})();
check("readerside: 回答里的页码被存成引用锚点",
  pageRefAnswer.citations.some((entry) => entry.kind === "pageref" && entry.pageIndex === 0));
const lastBubble = findAll(panelState.els.messagesEl,
  (node) => String(node.className).includes("sideline-msg-assistant")).slice(-1)[0];
const lastBubbleBody = findByClass(lastBubble, "sideline-text");
const anchorNodes = lastBubbleBody.querySelectorAll("[data-sideline-page]");
check("readerside: 页码锚点已渲染且绑定了跳转",
  anchorNodes.length === 1 && anchorNodes[0].getAttribute("data-sideline-page") === "0"
  && (anchorNodes[0].listeners.click || []).length === 1);
{
  const oldLocate = Sideline.readertext.locate, oldRange = Sideline.readertext.rectsForRange,
    oldJump = Sideline.readertext.jump, oldLabel = Sideline.readertext.labelOf;
  const navigation = [], verifiedRect = [[72, 680, 185, 710]];
  let matched = true, queried;
  try {
    Sideline.readertext.locate = async (_, options) => { queried = options; return { found: matched, from: 0, to: 1 }; };
    Sideline.readertext.rectsForRange = async () => ({ rects: verifiedRect });
    Sideline.readertext.jump = async (_, options) => { navigation.push(options); return { ok: true, flashed: options.rects?.length || 0 }; };
    Sideline.readertext.labelOf = async () => "1";
    anchorNodes[0].dispatch("click", { stopPropagation() {} });
    await sleep(10);
    check("readerside: citation uses strict verified source and locally derived rectangles",
      queried.exact && queried.text === "摘要 本文讨论核结构" && navigation[0].rects === verifiedRect
      && panelState.els.statusEl.textContent.includes("短暂高亮"));
    matched = false;
    anchorNodes[0].dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    await sleep(10);
    check("readerside: unmatched sentence falls back to page with explicit notice",
      navigation[1].pageIndex === 0 && !navigation[1].rects && panelState.els.statusEl.textContent.includes("仅定位到页码"));
  } finally {
    Sideline.readertext.locate = oldLocate; Sideline.readertext.rectsForRange = oldRange;
    Sideline.readertext.jump = oldJump; Sideline.readertext.labelOf = oldLabel;
  }
}
const quoteNodes = lastBubbleBody.querySelectorAll("blockquote");
check("readerside: 引用块被标记为可定位并绑定点击",
  quoteNodes.length === 1 && String(quoteNodes[0].className).includes("sideline-quote-link")
  && (quoteNodes[0].listeners.click || []).length === 1);
// 0.6.0：回答一律按 Markdown 渲染（用户反馈「都是源码」）
check("readerside: 回答气泡里是渲染后的 HTML 而不是 Markdown 源码",
  String(lastBubbleBody.innerHTML).includes("<blockquote>")
  && String(lastBubbleBody.innerHTML).includes("<p>")
  && !String(lastBubbleBody.innerHTML).includes("> 摘要"));
const fencedAnswer = await (async () => {
  const previous = httpResponder;
  httpResponder = async (method, url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    return {
      response: {
        model: body.model || "unknown",
        choices: [{ message: { content: "```markdown\n## 结论\n\n- 第一条\n- 第二条\n```" } }],
        usage: { total_tokens: 5 },
      },
      responseText: "",
    };
  };
  try {
    panelState.els.textarea.value = "给个结论";
    await Sideline.readerside.send(panelState, {});
  }
  finally {
    httpResponder = previous;
  }
  return Sideline.session.list(panelState.ownerID).slice(-1)[0];
})();
check("readerside: 整段代码围栏在入库前被剥掉",
  fencedAnswer.content.startsWith("## 结论") && !fencedAnswer.content.includes("```"));
const fencedBubble = findAll(panelState.els.messagesEl,
  (node) => String(node.className).includes("sideline-msg-assistant")).slice(-1)[0];
const fencedBody = findByClass(fencedBubble, "sideline-text");
check("readerside: 剥掉围栏后渲染出标题与列表",
  String(fencedBody.innerHTML).includes("<h2>结论</h2>")
  && String(fencedBody.innerHTML).includes("<li>"));
check("readerside: 渲染后的气泡里不再出现围栏标记",
  !String(fencedBody.innerHTML).includes("```"));

// 0.7.0：回答卡片可点选，选中的回答一次写入新建子笔记
const assistBubbles = findAll(panelState.els.messagesEl,
  (node) => String(node.className).includes("sideline-msg-assistant"));
const firstAssist = assistBubbles[0];
check("readerside: 回答卡片绑定了点选事件且默认未选中",
  !!firstAssist && (firstAssist.listeners.click || []).length === 1
  && !String(firstAssist.className).includes("sideline-msg-selected"));
check("readerside: 回答卡片可键盘操作（tabindex / role / aria-pressed 齐备）",
  !!firstAssist && firstAssist.getAttribute("tabindex") === "0"
  && firstAssist.getAttribute("role") === "button"
  && firstAssist.getAttribute("aria-pressed") === "false"
  && (firstAssist.listeners.keydown || []).length === 1);
firstAssist.listeners.keydown[0]({ type: "keydown", key: "Enter", preventDefault() {} });
check("readerside: 回车也能选中回答并同步 aria-pressed",
  String(firstAssist.className).includes("sideline-msg-selected")
  && firstAssist.getAttribute("aria-pressed") === "true");
firstAssist.listeners.keydown[0]({ type: "keydown", key: "Enter", preventDefault() {} });
check("readerside: 再按一次回车取消选中",
  !String(firstAssist.className).includes("sideline-msg-selected")
  && firstAssist.getAttribute("aria-pressed") === "false");
check("readerside: 没有选中项时不显示操作条", panelState.els.selectedBar.hidden === true);
firstAssist.listeners.click[0]({ type: "click" });
check("readerside: 点一下即选中并出现操作条",
  String(firstAssist.className).includes("sideline-msg-selected")
  && panelState.els.selectedBar.hidden === false
  && String(panelState.els.selectedCount.textContent).includes("已选 1 条"));
firstAssist.listeners.click[0]({ type: "click" });
check("readerside: 再点一下取消选中且操作条收起",
  !String(firstAssist.className).includes("sideline-msg-selected")
  && panelState.els.selectedBar.hidden === true);
check("readerside: 会话里有两条以上回答可多选", assistBubbles.length >= 2);
assistBubbles[0].listeners.click[0]({ type: "click" });
assistBubbles[1].listeners.click[0]({ type: "click" });
check("readerside: 多选计数随选择累加",
  String(panelState.els.selectedCount.textContent).includes("已选 2 条"));
const notesBeforeSelection = panelItem._notes.length;
const writesBeforeSelection = (await Sideline.writes.list(7000)).length;
findByText(panelState.els.selectedBar, "加入子笔记").listeners.click[0]();
await sleep(80);
check("readerside: 选中的回答写入一条新建子笔记",
  panelItem._notes.length === notesBeforeSelection + 1);
const selectionNote = items.get(panelItem._notes[panelItem._notes.length - 1]);
check("readerside: 子笔记含回答正文与来源深链",
  String(selectionNote.note).includes("非流式回答")
  && String(selectionNote.note).includes("zotero://")
  && String(selectionNote.note).includes("来源"));
check("readerside: 写入后自动清空选择",
  panelState.els.selectedBar.hidden === true && panelState.selectedTimes.size === 0);
const selectionWrites = await Sideline.writes.list(7000);
check("readerside: 该次写入登记到写入记录且可撤销",
  selectionWrites.length === writesBeforeSelection + 1
  && selectionWrites[0].kind === "note");

// 0.8.2：从回答菜单修改原问题，重新发送后替换原问答（并截断其后的分支）。
const fencedMore = findByClass(fencedBubble, "sl-msg-more");
fencedMore.dispatch("click");
const editMenu = findByClass(panelState.els.panel, "sl-menu");
findByText(editMenu, "修改提问").dispatch("click");
check("readerside: 修改提问会把原问题放回输入框",
  panelState.els.textarea.value === "给个结论"
  && String(panelState.els.statusEl.textContent).includes("替换该问答"));
panelState.els.textarea.value = "替换后的问题";
await Sideline.readerside.send(panelState, {});
const editedMessages = Sideline.session.list(panelState.ownerID);
check("readerside: 重发后替换原问答并保留修改后的新问答",
  !editedMessages.some((entry) => entry.role === "user" && entry.question === "给个结论")
  && editedMessages.filter((entry) => entry.role === "user" && entry.question === "替换后的问题").length === 1
  && editedMessages.some((entry) => entry.role === "assistant" && entry.question === "替换后的问题"));

// 停止流式回答时保留用户问题与已收到的片段，并提供真正可点的重试动作。
const providerChatBeforeStop = Sideline.providers.chat;
let releaseStoppedRequest = null;
let stoppedRequestKey = "";
Sideline.providers.chat = async (options) => {
  stoppedRequestKey = options.requestKey;
  options.onDelta("半个", "半个回答");
  await new Promise((resolve) => {
    releaseStoppedRequest = resolve;
  });
  throw new Error("aborted");
};
panelState.els.textarea.value = "停止测试问题";
const stoppedSend = Sideline.readerside.send(panelState, {});
await sleep(20);
panelState.els.stopButton.dispatch("click");
releaseStoppedRequest();
await stoppedSend;
Sideline.providers.chat = providerChatBeforeStop;
const stoppedMessages = Sideline.session.list(panelState.ownerID);
check("readerside: 停止后保留问题与已生成片段",
  !!stoppedRequestKey
  && stoppedMessages.some((entry) => entry.role === "user" && entry.question === "停止测试问题")
  && stoppedMessages.some((entry) => entry.role === "assistant" && entry.stopped === true
    && entry.content === "半个回答"));
const retryAction = findByText(panelState.els.statusEl, "重试");
check("readerside: 停止提示里的重试是可点击动作",
  !!retryAction && (retryAction.listeners.click || []).length === 1);
retryAction.dispatch("click");
await sleep(80);
const retriedMessages = Sideline.session.list(panelState.ownerID);
check("readerside: 停止后的重试替换中断轮次而不重复问题",
  retriedMessages.filter((entry) => entry.role === "user" && entry.question === "停止测试问题").length === 1
  && !retriedMessages.some((entry) => entry.role === "assistant" && entry.stopped === true)
  && retriedMessages.some((entry) => entry.role === "assistant" && entry.question === "停止测试问题"));

// R07：高亮候选先定位、预览，再确认写入
const highlightAnswer = "建议如下：\n```json\n"
  + JSON.stringify([
    { page: "1", quote: "摘要", reason: "核心结论" },
    { page: "9", quote: "不存在的句子", reason: "页码超出范围" },
  ])
  + "\n```";
const preparedHighlights = await Sideline.highlights.prepare(textReader, Sideline.highlights.parse(highlightAnswer));
check("highlights: 逐条定位，可写入的算出坐标",
  preparedHighlights[0].ok === true && preparedHighlights[0].pageIndex === 1
  && preparedHighlights[0].rects.length >= 1);
check("highlights: 页码对不上的条目给出原因且不写入",
  preparedHighlights[1].ok === false && preparedHighlights[1].error.includes("9"));
const highlightSummary = Sideline.highlights.summary(preparedHighlights);
check("highlights: 概览统计可写入与需人工处理条数",
  highlightSummary.total === 2 && highlightSummary.ok === 1 && highlightSummary.failed === 1
  && highlightSummary.pages[0] === "1");
const highlightPreview = await Sideline.highlights.preview(textReader, preparedHighlights[0]);
check("highlights: 预览会跳到该页并高亮范围",
  highlightPreview.ok === true && highlightPreview.flashed >= 1);
const annotationsBeforeCommit = calls.annotations.length;
const committedHighlights = await Sideline.highlights.commit({
  attachment: panelAttachment,
  entries: preparedHighlights,
  color: "#ffd400",
  commentOf: (entry) => entry.reason,
});
check("highlights: 未定位的条目返回原因但不写库",
  committedHighlights.length === 2 && committedHighlights[1].ok === false
  && committedHighlights[1].error.includes("9"));
check("highlights: 只写入已定位的条目",  committedHighlights.length === 2 && committedHighlights.filter((entry) => entry.ok).length === 1
  && calls.annotations.length === annotationsBeforeCommit + 1);
check("highlights: 批注内容是原文与理由",
  calls.annotations[calls.annotations.length - 1].json.text === "摘要"
  && calls.annotations[calls.annotations.length - 1].json.comment === "核心结论");
check("highlights: 批注坐标来自插件算出的矩形",
  calls.annotations[calls.annotations.length - 1].json.position.pageIndex === 1
  && calls.annotations[calls.annotations.length - 1].json.position.rects.length >= 1);

// R11：写入记录与撤销
await Sideline.store.clear();
Sideline.session.clear(panelState.ownerID);
await Sideline.store.remove(panelState.ownerID);
const noteWrite = await Sideline.writes.record(panelState.ownerID, {
  kind: "note",
  targetID: 9001,
  key: "NOTEW1",
  summary: "子笔记：测试",
});
const annotationWrite = await Sideline.writes.record(panelState.ownerID, {
  kind: "annotation",
  targetID: 9002,
  key: "ANNOTW1",
  summary: "批注（第 1 页）：摘要",
});
await Sideline.store.flush();
check("writes: 记录写入并带时间与 id",
  !!noteWrite && noteWrite.id === "w1" && !!noteWrite.time && noteWrite.undone === false
  && annotationWrite.id === "w2");
const writeList = await Sideline.writes.list(panelState.ownerID);
check("writes: 列表按时间倒序且只含本插件的写入",
  writeList.length === 2 && writeList[0].id === "w2");
check("writes: last 取最近一次未撤销的",
  (await Sideline.writes.last(panelState.ownerID)).id === "w2");
check("writes: 描述文本含类型与摘要",
  Sideline.writes.describe(writeList[0]).includes("PDF 批注")
  && Sideline.writes.describe(writeList[0]).includes("摘要"));
// 目标条目类型不符时必须拒绝删除
const wrongTypeItem = makeNoteItem();
items.set(9002, wrongTypeItem);
check("writes: 目标类型与记录不符时拒绝删除",
  (await Sideline.writes.undo(panelState.ownerID, "w2")).reason.includes("不符"));
// 正常撤销：删除我们刚建的批注条目
const erasableAnnotation = {
  id: 9003,
  key: "ANNOTW2",
  deleted: false,
  isNote: () => false,
  isAnnotation: () => true,
  erased: false,
  eraseTx: async () => {
    erasableAnnotation.erased = true;
  },
};
items.set(9003, erasableAnnotation);
await Sideline.writes.record(panelState.ownerID, {
  kind: "annotation",
  targetID: 9003,
  key: "ANNOTW2",
  summary: "批注（第 2 页）：可撤销",
});
const undoResult = await Sideline.writes.undoLast(panelState.ownerID);
check("writes: 撤销删除目标条目并标记状态",
  undoResult.ok === true && undoResult.removed === true && erasableAnnotation.erased === true);
check("writes: 撤销后 last 落到上一条", (await Sideline.writes.last(panelState.ownerID)).id === "w2");
check("writes: 重复撤销被拒绝",
  (await Sideline.writes.undo(panelState.ownerID, "w3")).ok === false);
// 目标条目已被用户删掉时，退化为只标记
await Sideline.writes.record(panelState.ownerID, {
  kind: "note",
  targetID: 999999,
  key: "GONE",
  summary: "子笔记：已删除",
});
const undoMissing = await Sideline.writes.undoLast(panelState.ownerID);
check("writes: 目标已不存在时只标记不报错",
  undoMissing.ok === true && undoMissing.removed === false && undoMissing.reason.includes("不存在"));
await Sideline.store.flush();
const writesRaw = JSON.parse(fakeFs.get((await Sideline.store.resolveAttachment(panelState.ownerID)).path));
check("writes: 写入记录随会话附件落盘",
  Array.isArray(writesRaw.sessions[0].writes) && writesRaw.sessions[0].writes.length === 4);
const writeEndpoint = new Zotero.Server.Endpoints["/sideline/sessions"]();
const [, , writeBody] = await writeEndpoint.init({ data: { itemID: panelState.ownerID } });
const writeJson = JSON.parse(writeBody);
check("endpoints: sessions 带出写入记录与会话写入计数",
  Array.isArray(writeJson.writes) && writeJson.writes.length === 4
  && writeJson.sessions.some((entry) => entry.writeCount >= 1));

console.log("");
console.log("== 新增端点 ==");
const functionsEndpoint = new Zotero.Server.Endpoints["/sideline/functions"]();
const [, , functionsBody] = await functionsEndpoint.init({});
const functionsJson = JSON.parse(functionsBody);
check("endpoints: functions 列出功能与作用范围",
  functionsJson.functions.some((entry) => entry.id === "summarize" && entry.scope === "document")
  && functionsJson.functions.length === 4 && functionsJson.buttons.length === 4
  && !functionsJson.functions.some((entry) => entry.id === "logic"));
check("endpoints: functions 不返回提示词正文", !functionsBody.includes("结构化总结"));
const providerEndpoint = new Zotero.Server.Endpoints["/sideline/provider"]();
const [, , providerBody] = await providerEndpoint.init({});
const providerJson = JSON.parse(providerBody);
check("endpoints: provider 报告两条通道与图片支持",
  providerJson.provider === "api" && providerJson.available.length === 3
  && providerJson.available.find((entry) => entry.id === "agent").supportsImages === true);
check("endpoints: provider 带 Codex 可执行文件探测", typeof providerJson.codex === "object");
const diagSessionsEndpoint = new Zotero.Server.Endpoints["/sideline/diag/sessions"]();
const [, , diagSessionsBody] = await diagSessionsEndpoint.init({ data: { itemID: 7000 } });
const diagSessionsJson = JSON.parse(diagSessionsBody);
check("endpoints: diag/sessions 只读报告附件解析结果",
  diagSessionsJson.probe === "resolve" && diagSessionsJson.attachment.ownerID === 7000);
const [diagSessionsBadCode] = await diagSessionsEndpoint.init({ data: { itemID: 7000, probe: "nope" } });
equal("endpoints: diag/sessions 未知 probe 返回 400", diagSessionsBadCode, 400);
Zotero.Reader._readers = [];

console.log("");
console.log("== 页码引用锚点 ==");
const citeText = "如第 3 页所述，截面在 5–7 页给出（见 p.12 与 pages 20-21）。";
const citeRefs = Sideline.citations.find(citeText);
check("citations: 识别中文页码与区间",
  citeRefs.some((ref) => ref.label === "3") && citeRefs.some((ref) => ref.label === "5" && ref.label2 === "7"));
check("citations: 识别 p./pp./page 写法",
  citeRefs.some((ref) => ref.label === "12") && citeRefs.some((ref) => ref.label === "20" && ref.label2 === "21"));
const citeLabels = ["i", "ii", "1", "2", "3", "4"];
const citeResolved = Sideline.citations.resolve(citeRefs, citeLabels);
check("citations: 纸面页码解析成 0 基页索引",
  citeResolved.some((entry) => entry.label === "3" && entry.pageIndex === 4));
check("citations: 解析不到的页码被丢掉",
  citeResolved.every((entry) => entry.pageIndex !== null) && !citeResolved.some((entry) => entry.label === "12"));
check("citations: 没有页码表时按 1 基序号猜测",
  Sideline.citations.labelToIndex("3", null) === 2 && Sideline.citations.labelToIndex("x", null) === null);
const citeHtml = Sideline.citations.annotate(
  Sideline.util.markdownToHtml("见第 3 页的公式\n\n```\np.3 应保持不变\n```"),
  Sideline.citations.toMap(citeResolved),
);
check("citations: 正文里的页码被包成可点击锚点",
  citeHtml.includes('data-sideline-page="4"') && citeHtml.includes("第 3 页"));
check("citations: 代码块内的 p.3 不被改写", citeHtml.includes("p.3 应保持不变"));
check("citations: 解析不到的页码保持原文", !citeHtml.includes('data-sideline-page="11"'));
check("citations: 由已存引用还原 label→页索引",
  Sideline.citations.mapFromCitations([{ pageLabel: "3", pageIndex: 4 }])["3"] === 4);
const sourceAnchorHtml = Sideline.citations.render('结论（第 3 页；原文：“This is the exact source sentence.”）', { "3": 2 });
check("citations: sentence anchor collapses original quote into safe metadata",
  sourceAnchorHtml.includes('data-sideline-quote="This is the exact source sentence."')
  && sourceAnchorHtml.includes('data-sideline-page="2"') && !sourceAnchorHtml.includes('原文：“'));
const unsafeAnchor = Sideline.citations.render('（第 3 页；原文：“A quote with " onclick="evil and <script> tags”）', { "3": 2 });
check("citations: source quote cannot inject HTML attributes", !unsafeAnchor.includes(' onclick="evil') && !unsafeAnchor.includes('<script>'));
const codeAnchor = Sideline.citations.render('```\n（第 3 页；原文：“This is the exact source sentence.”）\n```', { "3": 2 });
check("citations: code block is not turned into a source link", !codeAnchor.includes('data-sideline-quote'));
const citeQuotes = Sideline.citations.quotes("结论见第 3 页：\n\n> 截面随能量升高而下降。\n\n下一段。");
check("citations: 引用块继承前文页码",
  citeQuotes.length === 1 && citeQuotes[0].labels.includes("3") && citeQuotes[0].text.includes("截面"));

console.log("");
console.log("== 重点高亮候选 ==");
const highlightJson = "好的：\n```json\n"
  + JSON.stringify([{ page: "1", quote: "摘要", reason: "关键结论" }, { quote: "没有页码" }])
  + "\n```";
const highlightCandidates = Sideline.highlights.parse(highlightJson);
check("highlights: 宽松解析候选数组", highlightCandidates.length === 2
  && highlightCandidates[0].page === "1" && highlightCandidates[0].reason === "关键结论");
let highlightParseError = "";
try {
  Sideline.highlights.parse("这里没有数组");
}
catch (error) {
  highlightParseError = Sideline.util.message(error);
}
check("highlights: 没有 JSON 数组时报错", highlightParseError.includes("JSON"));
check("highlights: 只含空条目的数组报错", (() => {
  try {
    Sideline.highlights.parse('[{"foo":1}]');
    return false;
  }
  catch (error) {
    return Sideline.util.message(error).includes("quote");
  }
})());
check("highlights: looksLikeCandidates 对普通回答返回假",
  Sideline.highlights.looksLikeCandidates("这是一段普通回答") === false);
check("highlights: 页码解析优先用纸面页码表",
  Sideline.highlights.resolvePage("2", ["i", "1", "2"]).pageIndex === 2);
check("highlights: 没有页码表时按 1 基序号猜测",
  Sideline.highlights.resolvePage("2", null).pageIndex === 1
  && Sideline.highlights.resolvePage("2", null).guessed === true);
check("highlights: 页码对不上时返回 null",
  Sideline.highlights.resolvePage("99", ["1", "2"]).pageIndex === null);
check("highlights: 条数上限来自首选项",
  Sideline.highlights.limitOf() === 12);
Zotero.Prefs.set("sideline.highlightMaxItems", 2);
check("highlights: 超出上限时截断候选",
  Sideline.highlights.parse(JSON.stringify(
    Array.from({ length: 5 }, (unused, index) => ({ page: "1", quote: `句子${index}` })),
  )).length === 2);
Zotero.Prefs.set("sideline.highlightMaxItems", 12);

console.log("");
console.log("== 成本估算 ==");
check("providers: 纯中文按 1 字 1 token 估算",
  Sideline.providers.estimateTokens("中文五个字") === 5);
check("providers: 英文按约 3.5 字符 1 token 估算",
  Sideline.providers.estimateTokens("abcdefg") === 2);
check("providers: 空文本估算为 0", Sideline.providers.estimateTokens("") === 0);
const requestEstimate = Sideline.providers.estimateRequestTokens([
  { role: "system", content: "系统" },
  { role: "user", content: "问题" },
], ["data:image/png;base64,AA"]);
check("providers: 请求估算含文本与图片（每张按 1024 上限粗算）",
  requestEstimate.text === 4 && requestEstimate.images === 1024 && requestEstimate.total === 1028);

console.log("");
console.log("== 结构化总结（R06）==");
// 提示词保真：发布仓库携带原始 paper-review 基准，缺失或内容不符必须失败。
const skillPromptPath = path.join(projectRoot, "test", "fixtures", "summary-prompt.md");
const skillPromptLines = fs.readFileSync(skillPromptPath, "utf8")
  .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const promptBase = Sideline.summary.SUMMARY_PROMPT.split("\n---\n\n附加输出")[0];
const normalizePrompt = (value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n");
check(`总结提示词与随仓库基准逐行一致（比对 ${skillPromptLines.length} 行）`,
  normalizePrompt(promptBase) === skillPromptLines.join("\n"));
check("总结提示词含附加输出约定",
  Sideline.summary.SUMMARY_PROMPT.includes("附加输出") && Sideline.summary.SUMMARY_PROMPT.includes("\"short_summary\""));
check("functions: 总结全文用的是 paper-review 提示词",
  Sideline.functions.promptOf("summarize").includes("摘要翻译")
  && Sideline.functions.promptOf("summarize").includes("附加输出"));

const summaryAnswer = [
  "## 摘要翻译",
  "本文测量了镜像核的能差。",
  "",
  "## 正文引言",
  "- **第1段重点**：给出研究背景（第1节第1段）",
  "",
  "## 理论或实验介绍",
  "使用 Gamow 壳模型，核心假设是连续谱耦合（Eq.(2)）。",
  "",
  "## 问题讨论",
  "",
  "### 问题一：连续谱耦合如何改变镜像能差？",
  "- **Fig.2重点：镜像能差随质量数变化**",
  "   （原文直译）",
  "- **回答问题**：连续谱耦合使能差减小（Fig.2）。",
  "",
  "## 提炼总结",
  "- **a.做了什么**: 计算了镜像核能差",
  "- **b.核心论断**: 连续谱耦合不可忽略",
  "- **c.物理意义**：影响 N=Z 核的滴线位置",
  "",
  "## 作者承认的局限",
  "未考虑三体力。",
  "",
  "---",
  "",
  "在结构化总结之后另起一段：",
  '{"tags": ["Gamow壳模型", "18Ne", "连续谱耦合", "镜像能差", "论文"], "short_summary": "连续谱耦合改变镜像能差"}',
].join("\n");
const parsedSummary = Sideline.summary.parse(summaryAnswer);
check("summary: 从输出里切出总结与附加 JSON",
  !parsedSummary.note.includes("\"tags\"") && parsedSummary.note.includes("## 摘要翻译")
  && parsedSummary.hasReview === true);
check("summary: 标签过滤宽泛词并保留 4 个",
  parsedSummary.tags.length === 4 && !parsedSummary.tags.includes("论文")
  && parsedSummary.droppedTags.some((entry) => entry.tag === "论文"));
check("summary: 短总结按 15 字上限校验",
  parsedSummary.shortSummary === "连续谱耦合改变镜像能差"
  && [...parsedSummary.shortSummary].length <= 15);
check("summary: 标签不足时给出问题",
  Sideline.summary.validateReview({ tags: ["A", "B"], short_summary: "短" }).problems
    .some((line) => line.includes("标签不足")));
check("summary: 超长短总结被截断并记问题", (() => {
  const result = Sideline.summary.validateReview({ tags: ["A", "B", "C", "D"], short_summary: "一二三四五六七八九十十一十二十三十四十五十六" });
  return [...result.shortSummary].length === 15 && result.problems.some((line) => line.includes("短总结超过"));
})());
check("summary: 输出太短时拒绝解析", (() => {
  try {
    Sideline.summary.parse("## 摘要翻译\n太短了");
    return false;
  }
  catch (error) {
    return Sideline.util.message(error).includes("太短");
  }
})());
check("summary: looksLikeSummary 对普通回答返回假",
  Sideline.summary.looksLikeSummary("这是一段普通回答") === false
  && Sideline.summary.looksLikeSummary(summaryAnswer) === true);

const noteHtml = Sideline.summary.toNoteHtml(parsedSummary.note);
check("summary: 笔记 HTML 带 Paper Review 标记与五个标题",
  noteHtml.includes('data-paper-review-note="structured-summary-v1"')
  && noteHtml.startsWith('<div class="zotero-note znv1"')
  && Sideline.summary.NOTE_HEADINGS.every((heading) => noteHtml.includes(`<h2>${heading}</h2>`)));
check("summary: 笔记 HTML 保留标题层级与列表",
  noteHtml.includes("<h3>问题一") && noteHtml.includes("<ul>") && noteHtml.includes("<li>"));
check("summary: 笔记 HTML 转换 `---` 为分隔线", noteHtml.includes("<hr>"));
const mathHtml = Sideline.summary.toNoteHtml("行内 $E=mc^2$ 与行间\n\n$$\nH\\psi = E\\psi\n$$\n");
check("summary: 行内公式包成 math span、行间公式进 pre",
  mathHtml.includes('<span class="math">$E=mc^2$</span>')
  && mathHtml.includes('<pre class="math">') && mathHtml.includes("H\\psi = E\\psi"));
check("summary: 笔记 HTML 转义原始尖括号",
  Sideline.summary.toNoteHtml("危险 <script>alert(1)</script>").includes("&lt;script&gt;"));

const summaryItem = makeRegularItem({
  id: 7100,
  fields: { title: "总结测试论文", extra: "自定义字段: 保留\n总结: 旧的短总结" },
  tags: ["已有标签", "18Ne"],
});
const summaryNote = makeNoteItem();
summaryNote.id = 7101;
summaryNote.key = "SUMN0001";
summaryNote.parentID = 7100;
summaryNote.setNote(Sideline.summary.NOTE_MARKER
  + Sideline.summary.NOTE_HEADINGS.map((heading) => `<h2>${heading}</h2>`).join(""));
items.set(summaryNote.id, summaryNote);
summaryItem._notes.push(summaryNote.id);
const summaryItem2 = makeRegularItem({ id: 7102, fields: { title: "无子笔记论文" } });
const summaryAttachment = makeAttachment({
  id: 7103,
  parentID: 7102,
  title: "Full Text PDF",
  path: "/fake/storage/7103/full.pdf",
});
fakeFs.set("/fake/storage/7103/.zotero-ft-cache", "全文正文".repeat(20));
Zotero.Fulltext.getItemCacheFile = () => ({ path: "/fake/storage/7103/.zotero-ft-cache" });
Zotero.Fulltext.getPages = async () => ({ indexedPages: 3, totalPages: 5 });

check("summary: 识别已有 Paper Review 子笔记",
  (await Sideline.summary.existingNotes(summaryItem)).length === 1
  && (await Sideline.summary.existingNotes(summaryItem2)).length === 0);
check("summary: 读取 Extra 里已有的短总结",
  Sideline.summary.existingSummary(summaryItem) === "旧的短总结"
  && Sideline.summary.existingSummary(summaryItem2) === "");
const extraKeep = Sideline.summary.nextExtra("自定义字段: 保留\n总结: 旧的短总结", "新短总结", false);
check("summary: 默认保留用户编辑过的「总结:」行",
  extraKeep.changed === false && extraKeep.status === "preserved" && extraKeep.extra.includes("旧的短总结"));
const extraUpdate = Sideline.summary.nextExtra("自定义字段: 保留\n总结: 旧的短总结", "新短总结", true);
check("summary: 显式覆盖时替换该行且保留其它字段",
  extraUpdate.changed === true && extraUpdate.status === "updated"
  && extraUpdate.extra.includes("新短总结") && extraUpdate.extra.includes("自定义字段: 保留"));
const extraCreate = Sideline.summary.nextExtra("自定义字段: 保留", "新短总结", false);
check("summary: 没有该行时追加到 Extra 末尾",
  extraCreate.changed === true && extraCreate.status === "created"
  && extraCreate.extra === "自定义字段: 保留\n总结: 新短总结");

const summaryCoverage = await Sideline.summary.coverageOf(summaryItem2, { attachment: summaryAttachment });
check("summary: 无阅读器时覆盖信息退回全文索引",
  summaryCoverage.source === "zotero-fulltext" && summaryCoverage.chars > 0
  && summaryCoverage.pageCount === 5
  && summaryCoverage.notes.some((line) => line.includes("逐页覆盖信息不可用")));
const readerCoverage = await Sideline.summary.coverageOf(
  { id: 9999, getField: () => "" },
  { reader: textReader, attachment: summaryAttachment },
);
check("summary: 有阅读器时逐页统计覆盖页",
  readerCoverage.source === "pdfjs" && readerCoverage.pages.length === 3
  && readerCoverage.pageCount === 3);

const summaryPlan = await Sideline.summary.plan({
  item: summaryItem,
  review: parsedSummary,
  coverage: summaryCoverage,
});
check("summary: 预览报告标签新增与已存在",
  summaryPlan.tags.added.length === 3 && summaryPlan.tags.existing.length === 1
  && summaryPlan.tags.existing[0] === "18Ne");
check("summary: 预览说明已有子笔记的动作",
  summaryPlan.note.action === "exists" && summaryPlan.note.existingKey === summaryNote.key);
check("summary: 预览保留旧短总结并显示新值",
  summaryPlan.summary.before === "旧的短总结" && summaryPlan.summary.after === "连续谱耦合改变镜像能差"
  && summaryPlan.summary.changed === false);
check("summary: 预览不含写入副作用（脚本没写库）",
  summaryItem.tags.length === 2 && summaryItem.fields.extra.includes("旧的短总结"));

let summaryCommitError = "";
try {
  await Sideline.summary.commit(summaryItem, parsedSummary, { plan: summaryPlan });
}
catch (error) {
  summaryCommitError = Sideline.util.message(error);
}
check("summary: 已有子笔记且未选覆盖时拒绝写入", summaryCommitError.includes("已有 Paper Review 子笔记"));

const notesBeforeSummary = calls.notes.length;
const summaryResult = await Sideline.summary.commit(summaryItem2, parsedSummary, {
  plan: await Sideline.summary.plan({ item: summaryItem2, review: parsedSummary, coverage: summaryCoverage }),
});
check("summary: 写入创建子笔记并记录 key",
  summaryResult.created === true && summaryResult.noteKey.startsWith("NOTE")
  && calls.notes.length === notesBeforeSummary + 1);
check("summary: 子笔记挂到父条目且带标记",
  summaryItem2._notes.length === 1
  && items.get(summaryItem2._notes[0]).note.includes("structured-summary-v1"));
check("summary: 标签只追加",
  summaryItem2.tags.map((entry) => entry.tag).join(",") === "Gamow壳模型,18Ne,连续谱耦合,镜像能差"
  && summaryResult.tagsAdded.length === 4);
check("summary: Extra 新建「总结:」行",
  summaryItem2.fields.extra === "总结: 连续谱耦合改变镜像能差"
  && summaryResult.summaryStatus === "created");

console.log("");
console.log("== 子笔记检索（R08）==");
check("notetext: HTML 转纯文本保留段落",
  Sideline.notetext.toPlainText("<div><p>第一段</p><p>第二段<br>换行</p><ul><li>项</li></ul></div>")
    .split(/\n\s*\n/).length === 3);
check("notetext: 实体解码", Sideline.notetext.toPlainText("<p>a &amp; b &lt;x&gt;</p>") === "a & b <x>");
check("notetext: 段落切分带序号",
  Sideline.notetext.paragraphsOf("甲\n\n乙\n\n\n丙").map((entry) => `${entry.index}:${entry.text}`).join("|")
    === "1:甲|2:乙|3:丙");
const searchNote = makeNoteItem();
searchNote.id = 7201;
searchNote.key = "NOTES001";
searchNote.parentID = 7200;
searchNote.setNote("<p>壳模型计算给出镜像能差。</p>"
  + "<p>连续谱耦合使镜像能差减小，这是本文的核心结论。</p>"
  + "<p>无关段落，也提到能差。</p>");
items.set(searchNote.id, searchNote);
const searchItem = makeRegularItem({ id: 7200, fields: { title: "笔记检索论文" }, notes: [7201] });
const noteList = await Sideline.notetext.list(searchItem);
check("notetext: 读出子笔记正文与段落",
  noteList.length === 1 && noteList[0].paragraphs.length === 3
  && noteList[0].paragraphs[1].text.includes("连续谱耦合"));
const noteHits = await Sideline.notetext.find(searchItem, "连续谱");
check("notetext: 命中片段带笔记名与段落位置",
  noteHits.total === 1 && noteHits.hits[0].paragraphIndex === 2
  && noteHits.hits[0].noteTitle === "未命名笔记"
  && noteHits.materials[0].label.includes("第 2 段")
  && noteHits.materials[0].detail.includes("第 2 段"));
check("notetext: 多词按全部出现匹配",
  (await Sideline.notetext.find(searchItem, "连续谱 镜像")).total === 1
  && (await Sideline.notetext.find(searchItem, "连续谱 不存在词")).total === 0);
check("notetext: 命中数超过上限时截断并报告",
  (await Sideline.notetext.find(searchItem, "能差", { maxHits: 1 })).truncated === 2);
check("notetext: 没有子笔记时返回空",
  (await Sideline.notetext.find(summaryItem2, "任意词")).notesScanned === 1);
const orLeftNote = makeNoteItem();
orLeftNote.id = 7202;
orLeftNote.key = "ORLEFT01";
orLeftNote.setNote("<p>只包含 ORLEFTUNIQUE 的笔记。</p>");
items.set(orLeftNote.id, orLeftNote);
const orRightNote = makeNoteItem();
orRightNote.id = 7203;
orRightNote.key = "ORRIGHT1";
orRightNote.setNote("<p>只包含 ORRIGHTUNIQUE 的另一篇笔记。</p>");
items.set(orRightNote.id, orRightNote);
const lineOrHits = await Sideline.notetext.findEverywhere("ORLEFTUNIQUE\nORRIGHTUNIQUE", { maxHits: 10 });
check("notetext: 换行 OR 会分别粗筛每一行且不会漏掉第二行候选",
  lineOrHits.usedSearch === true && lineOrHits.total === 2
  && lineOrHits.hits.some((entry) => entry.noteID === orLeftNote.id)
  && lineOrHits.hits.some((entry) => entry.noteID === orRightNote.id));

console.log("");
console.log("== 材料采集（R09）==");
check("inputs: 识别 zotero:// 条目链接",
  Sideline.inputs.classifyText("zotero://select/library/items/ABCD1234").kind === "zotero-item"
  && Sideline.inputs.parseZoteroLink("zotero://select/library/items/abcd1234").key === "ABCD1234");
check("inputs: 识别 DOI 与 arXiv",
  Sideline.inputs.classifyText("10.1103/PhysRevC.100.014001").kind === "doi"
  && Sideline.inputs.classifyText("https://arxiv.org/abs/2401.01234").kind === "arxiv"
  && Sideline.inputs.parseDoi("见 https://doi.org/10.1103/PhysRevC.100.014001。") === "10.1103/PhysRevC.100.014001");
check("inputs: 识别 Windows 路径与图片路径",
  Sideline.inputs.classifyText("D:\\papers\\note.md").kind === "file-path"
  && Sideline.inputs.classifyText("D:\\papers\\fig1.PNG").kind === "image-path");
check("inputs: 外部链接不打下载",
  Sideline.inputs.classifyText("https://example.org/a").kind === "url"
  && Sideline.inputs.classifyText("https://example.org/a").detail.includes("不会下载"));
check("inputs: 纯文本归类为 text",
  Sideline.inputs.classifyText("这是一段普通文字").kind === "text");

const base64Bytes = Sideline.util.base64FromBytes(new Uint8Array([0x4d, 0x61, 0x6e]));
check("util: base64 编码与填充正确", base64Bytes === "TWFu");
check("util: base64 处理两字节与一字节",
  Sideline.util.base64FromBytes(new Uint8Array([0x4d, 0x61])) === "TWE="
  && Sideline.util.base64FromBytes(new Uint8Array([0x4d])) === "TQ==");
fakeFs.set("/fake/materials/notes.md", "# 标题\n\n正文若干。");
fakeFs.set("/fake/materials/other.pdf", "%PDF-1.4 假文件");
fakeBinaries.set("/fake/materials/fig.png", "PNGDATA");
const textInput = await Sideline.inputs.resolve("/fake/materials/notes.md", {});
check("inputs: 文本文件读成 path 材料",
  textInput.ok === true && textInput.kind === "path"
  && textInput.fields.text.includes("正文若干") && textInput.fields.name === "notes.md");
const imageInput = await Sideline.inputs.resolve("/fake/materials/fig.png", {});
check("inputs: 图片读成 base64 data URL",
  imageInput.ok === true && imageInput.kind === "image"
  && imageInput.fields.dataUrl.startsWith("data:image/png;base64,"));
const missingInput = await Sideline.inputs.resolve("/fake/materials/absent.md", {});
check("inputs: 路径不存在时明确报错",
  missingInput.ok === false && missingInput.reason.includes("文件不存在"));
const barePdfInput = await Sideline.inputs.resolve("/fake/materials/other.pdf", {});
check("inputs: 非条目的 PDF 说明无法取文",
  barePdfInput.ok === false && barePdfInput.reason.includes("Zotero 附件"));
const urlInput = await Sideline.inputs.resolve("https://example.org/x", {});
check("inputs: 链接入上下文并注明不下载",
  urlInput.ok === true && urlInput.fields.text === "https://example.org/x"
  && urlInput.fields.detail.includes("不下载"));
const textMaterialInput = await Sideline.inputs.resolve("一段要加入的文本", {});
check("inputs: 纯文本解析成 paste 材料",
  textMaterialInput.ok === true && textMaterialInput.kind === "paste"
  && textMaterialInput.fields.text === "一段要加入的文本");
const linkInput = await Sideline.inputs.resolve("zotero://select/library/items/SUMN0001", {});
check("inputs: 条目链接解析成 item 材料（含元数据）",
  linkInput.ok === true && linkInput.kind === "item"
  && linkInput.fields.title === "总结测试论文" && linkInput.fields.text.includes("标题：总结测试论文"));
const doiMissInput = await Sideline.inputs.resolve("10.9999/not-in-library", {});
check("inputs: DOI 在库里找不到时说明原因",
  doiMissInput.ok === false && doiMissInput.reason.includes("当前库里没有"));

console.log("");
console.log("== 结构化总结的撤销（R11）==");
const undoItem = makeRegularItem({
  id: 7300,
  fields: { title: "总结撤销论文", extra: "字段: 保留" },
  tags: ["原有标签"],
});
const undoNote = await Sideline.summary.commit(undoItem, parsedSummary, {
  plan: await Sideline.summary.plan({ item: undoItem, review: parsedSummary }),
});
const reviewWrite = await Sideline.writes.record(undoItem.id, {
  kind: "review",
  targetID: undoNote.noteID,
  key: undoNote.noteKey,
  summary: "结构化总结",
  detail: {
    tagsAdded: undoNote.tagsAdded,
    extraBefore: undoNote.extraBefore,
    extraAfter: undoNote.summaryExtra,
    noteAction: "create",
    noteID: undoNote.noteID,
    parentID: undoNote.itemID,
    noteKey: undoNote.noteKey,
  },
});
await Sideline.store.flush();
check("writes: 结构化总结写入被记录",
  reviewWrite.kind === "review" && reviewWrite.detail.tagsAdded.length === 4
  && Array.isArray(JSON.parse(fakeFs.get((await Sideline.store.resolveAttachment(undoItem.id)).path))
    .sessions[0].writes));
const undoReviewResult = await Sideline.writes.undoLast(undoItem.id);
check("writes: 撤销总结移除新增标签并还原 Extra",
  undoReviewResult.ok === true
  && undoItem.tags.map((entry) => entry.tag).join(",") === "原有标签"
  && undoItem.fields.extra === "字段: 保留");
check("writes: 撤销总结删除本次新建的子笔记",
  items.get(undoNote.noteID).deleted === true);
check("writes: 撤销结果说明回滚范围",
  undoReviewResult.reason.includes("已移除 4 个新增标签")
  && undoReviewResult.reason.includes("已删除新建的子笔记"));

console.log("");
// 0.7.0：面板与划词弹窗的配色一律跟随 Zotero 阅读器的主题变量，不再各写一套硬编码深浅色
const panelCssText = fs.readFileSync(path.join(projectRoot, "src", "content", "reader-panel.css"), "utf8");
check("样式: 面板底色与文字取自 Zotero 主题变量",
  panelCssText.includes("--sl-bg: var(--material-sidepane")
  && panelCssText.includes("--sl-text: var(--fill-primary")
  && panelCssText.includes("--sl-accent: var(--accent-blue"));
check("样式: 面板不再自带 prefers-color-scheme 分支（深浅色交给 Zotero 主题）",
  !panelCssText.includes("prefers-color-scheme"));
check("样式: 面板正文字号跟随 Zotero 字体设置",
  panelCssText.includes("font-size: var(--font-size")
  && panelCssText.includes("font-family: var(--font-family"));
const readerJsText = fs.readFileSync(path.join(projectRoot, "src", "modules", "reader.js"), "utf8");
check("样式: 划词弹窗使用同一套 Zotero 主题变量",
  readerJsText.includes("--slr-text:var(--fill-primary")
  && !readerJsText.includes("prefers-color-scheme: dark"));
check("样式: 点选回答的新元素都有配套样式",
  panelCssText.includes(".sl-selected-bar")
  && panelCssText.includes(".sl-selected-count")
  && panelCssText.includes(".sideline-msg-selected"));
check("样式: 用户气泡与助手卡片分别有样式",
  panelCssText.includes(".sideline-msg-user .sideline-text")
  && panelCssText.includes(".sideline-msg-assistant .sideline-text"));
check("样式: 面板允许随 Zotero 侧栏缩到更窄且回答菜单更清晰",
  /#sideline-panel\s*\{[\s\S]*?min-width:\s*0;/.test(panelCssText)
  && /#sideline-panel\s*\{[\s\S]*?max-width:\s*100%;/.test(panelCssText)
  && /\.sl-msg-more\s*\{[\s\S]*?opacity:\s*\.68;/.test(panelCssText));
// 作者样式里的 display:flex 会盖掉浏览器默认的 [hidden]{display:none}，必须显式补一条
const readersideJsText = fs.readFileSync(path.join(projectRoot, "src", "modules", "readerside.js"), "utf8");
check("样式: hidden 属性必须真的隐藏（否则空材料条/空操作条会一直留在面板上）",
  panelCssText.includes("#sideline-panel [hidden]")
  && readerJsText.includes(".sideline-reader [hidden]"));
// 界面里用到的每个类名都要有样式规则，避免出现"没样式所以看着像坏了"的元素
const uiClasses = [...new Set([...`${readersideJsText}\n${readerJsText}`.matchAll(/className:\s*"([^"]+)"/g)]
  .flatMap((match) => match[1].split(/\s+/))
  .filter((name) => name && !name.includes("${")))];
const styleSource = `${panelCssText}\n${readerJsText}`;
const unstyledClasses = uiClasses.filter((name) => !styleSource.includes(`.${name}`));
check(`样式: 界面用到的每个类名都有样式规则（检查 ${uiClasses.length} 个）`,
  unstyledClasses.length === 0, unstyledClasses.join("、"));

console.log("== 侧栏：材料采集 / 笔记检索 / 重试失败页 / 总结预览 ==");
/** 打开面板里的「＋」材料菜单，取出其中一项（菜单一次只开一个） */
function materialMenuItem(label) {
  findByText(panelState.els.panel, "＋").dispatch("click");
  const menu = findByClass(panelState.els.panel, "sl-menu");
  return menu ? findByText(menu, label) : null;
}
check("readerside: 材料入口都在「＋」菜单里（面板上不再是一排按钮）",
  !findByText(panelState.els.panel, "选择文件")
  && !!materialMenuItem("选择文件")
  && !!materialMenuItem("检索笔记"));

// R08（0.7.1 起）：检索**全库**笔记；同行空格=AND、换行=OR
const panelNote = makeNoteItem();
panelNote.id = 7401;
panelNote.key = "PANELNOTE";
panelNote.parentID = panelState.ownerID;
panelNote.setNote("<p>本文用 Gamow 壳模型计算镜像能差。</p><p>连续谱耦合使镜像能差减小（记号 ZZQ1）。</p>");
items.set(panelNote.id, panelNote);
panelItem._notes.push(panelNote.id);
// 另一条笔记挂在别的条目下：全库检索应该也能命中（两条笔记都用 ZZQ1 做标记，避免命中别的测试留下的笔记）
const otherOwner = makeRegularItem({ id: 7700, fields: { title: "另一篇文献" } });
const otherNote = makeNoteItem();
otherNote.id = 7402;
otherNote.key = "OTHERNOTE";
otherNote.parentID = 7700;
otherNote.setNote("<p>连续谱耦合在滴线核里同样重要（记号 ZZQ1）。</p>");
items.set(otherNote.id, otherNote);
const materialsBeforeNotes = panelState.materials.length;
panelState.els.textarea.value = "ZZQ1";
materialMenuItem("检索笔记").dispatch("click");
await sleep(60);
check("readerside: 检索笔记把命中片段加入材料",
  panelState.materials.length === materialsBeforeNotes + 2
  && panelState.materials.some((entry) => entry.kind === "note"
    && String(entry.label).includes("第 2 段")));
check("readerside: 状态行说明来源笔记与位置",
  String(panelState.els.statusEl.textContent).includes("命中 2 处")
  && String(panelState.els.statusEl.textContent).includes("第 2 段"));
check("readerside: 检索范围是全库（能命中别的条目下的笔记）",
  panelState.materials.filter((entry) => entry.kind === "note").length >= 2
  && panelState.materials.some((entry) => String(entry.source || "").includes("7402")));
// AND：同一行两个词必须同时出现（两条笔记里只有一条同时含这两个词）
panelState.els.textarea.value = "ZZQ1 滴线核";
materialMenuItem("检索笔记").dispatch("click");
await sleep(60);
check("readerside: 同行空格=同时包含（AND）",
  String(panelState.els.statusEl.textContent).includes("命中 1 处"));
// OR：换行表示任意一行即可（两条笔记各有一条命中）
panelState.els.textarea.value = "ZZQ1\n滴线核";
materialMenuItem("检索笔记").dispatch("click");
await sleep(60);
check("readerside: 换行=任意一条（OR）",
  String(panelState.els.statusEl.textContent).includes("命中 2 处"));

// R10：失败页可重试（用有 pdf.js 桩的 textReader 验证成功分支）
const previousPanelReader = panelState.reader;
panelState.reader = textReader;
panelState.failedPages = [{ pageIndex: 0, error: "模拟取文失败" }];
panelState.contextOpen = true;
// 借 addSelection 触发一次材料区重绘（它内部会调 renderMaterials）
Sideline.readerside.addSelection(panelReader, { text: "触发重绘的选区", pageIndex: 0, pageLabel: "1" });
await sleep(30);
check("readerside: 材料区出现重试失败页入口",
  !!findByText(panelState.els.materialsEl, "重试"));
findByText(panelState.els.materialsEl, "重试").dispatch("click");
await sleep(60);
check("readerside: 重试成功后清空失败页并提示重新加入全文",
  panelState.failedPages.length === 0
  && String(panelState.els.statusEl.textContent).includes("重试成功"));
// 取不到正文时如实报告仍然失败
panelState.reader = panelReader;
panelState.failedPages = [{ pageIndex: 0, error: "模拟取文失败" }];
Sideline.readerside.addSelection(panelReader, { text: "再触发一次重绘", pageIndex: 0, pageLabel: "1" });
await sleep(20);
findByText(panelState.els.materialsEl, "重试").dispatch("click");
await sleep(60);
check("readerside: 重试仍失败时如实报告页码与原因",
  panelState.failedPages.length === 1
  && String(panelState.els.statusEl.textContent).includes("仍有 1 页取文失败"));
panelState.failedPages = [];

// R06：回答像结构化总结时，「⋯」菜单里出现「预览并写入总结」，确认后才写库
const summaryTarget = makeRegularItem({ id: 7500, fields: { title: "侧栏总结条目" } });
panelState.ownerID = summaryTarget.id;
const previousResponder = httpResponder;
httpResponder = async (method, url, options) => {
  const body = options && options.body ? JSON.parse(options.body) : {};
  return {
    response: {
      model: body.model || "unknown",
      choices: [{ message: { content: summaryAnswer } }],
      usage: { total_tokens: 42 },
    },
    responseText: "",
  };
};
try {
  panelState.els.textarea.value = "请总结这篇论文";
  await Sideline.readerside.send(panelState, {});
}
finally {
  httpResponder = previousResponder;
}
const summaryMessageBubble = findAll(panelState.els.messagesEl,
  (node) => String(node.className).includes("sideline-msg-assistant")).slice(-1)[0];
findByClass(summaryMessageBubble, "sl-msg-more").dispatch("click");
const summaryMenu = findByClass(panelState.els.panel, "sl-menu");
check("readerside: summary answer no longer exposes the three removed write actions",
  ["预览并写入总结", "整理为笔记", "保存为子笔记"].every((label) => !findByText(summaryMenu, label)));
check("readerside: summary menu does not modify Zotero notes/tags/Extra",
  summaryTarget._notes.length === 0 && summaryTarget.tags.length === 0 && !summaryTarget.fields.extra);

console.log("");
console.log("== 第 3 批端点 ==");
const summaryEndpoint = new Zotero.Server.Endpoints["/sideline/summary"]();
const [, , summaryPromptBody] = await summaryEndpoint.init({ data: { itemID: 7100 } });
const summaryPromptJson = JSON.parse(summaryPromptBody);
check("endpoints: summary 返回提示词、覆盖与约束",
  summaryPromptJson.prompt.includes("附加输出")
  && summaryPromptJson.constraints.maxSummaryChars === 15
  && Array.isArray(summaryPromptJson.constraints.genericTags)
  && summaryPromptJson.existingNote
  && summaryPromptJson.existingSummary === "旧的短总结");
const [, , summaryPreviewBody] = await summaryEndpoint.init({
  data: { itemID: 7100, action: "preview", answer: summaryAnswer },
});
const summaryPreviewJson = JSON.parse(summaryPreviewBody);
check("endpoints: summary preview 返回计划且不回显整篇 HTML",
  summaryPreviewJson.plan.tags.added.length === 3
  && summaryPreviewJson.plan.note.html === ""
  && summaryPreviewJson.noteHtmlChars > 0
  && summaryPreviewJson.notePreview.includes("摘要翻译"));
const [, , summaryNoConfirmBody] = await summaryEndpoint.init({
  data: { itemID: 7102, action: "commit", answer: summaryAnswer },
});
check("endpoints: summary commit 缺少 confirm 时不写入",
  JSON.parse(summaryNoConfirmBody).error.includes("confirm"));
const summaryCommitTarget = makeRegularItem({ id: 7104, fields: { title: "端点写入论文" } });
const [, , summaryCommitBody] = await summaryEndpoint.init({
  data: { itemID: 7104, action: "commit", answer: summaryAnswer, confirm: true },
});
const summaryCommitJson = JSON.parse(summaryCommitBody);
check("endpoints: summary commit 真正写入并回报结果",
  summaryCommitJson.result.created === true
  && summaryCommitJson.result.tagsAdded.length === 4
  && summaryCommitTarget._notes.length === 1);
check("endpoints: summary commit 后再 preview 会提示已有子笔记",
  (await Sideline.summary.plan({
    item: summaryCommitTarget,
    review: Sideline.summary.parse(summaryAnswer),
  })).note.action === "exists");
const [, , badSummaryBody] = await summaryEndpoint.init({ data: { itemID: 7100, action: "nope" } });
check("endpoints: summary 未知 action 返回 400",
  JSON.parse(badSummaryBody).error.includes("action"));

const noteSearchEndpoint = new Zotero.Server.Endpoints["/sideline/notes/search"]();
const [, , noteListBody] = await noteSearchEndpoint.init({ data: { itemID: 7200 } });
check("endpoints: notes/search 无 query 时返回笔记清单",
  JSON.parse(noteListBody).notes.length === 1 && JSON.parse(noteListBody).notes[0].key === "NOTES001");
const [, , noteHitBody] = await noteSearchEndpoint.init({ data: { itemID: 7200, query: "连续谱" } });
const noteHitJson = JSON.parse(noteHitBody);
check("endpoints: notes/search 返回命中与材料参数",
  noteHitJson.total === 1 && noteHitJson.hits[0].paragraphIndex === 2
  && noteHitJson.materials[0].text.includes("连续谱"));

const inputEndpoint = new Zotero.Server.Endpoints["/sideline/inputs/resolve"]();
const [, , inputTextBody] = await inputEndpoint.init({ data: { value: "/fake/materials/notes.md" } });
check("endpoints: inputs/resolve 报告解析结果",
  JSON.parse(inputTextBody).ok === true && JSON.parse(inputTextBody).kind === "path"
  && JSON.parse(inputTextBody).textChars > 0);
const [inputMissCode, , inputMissBody] = await inputEndpoint.init({ data: { value: "/fake/absent.md" } });
check("endpoints: inputs/resolve 解析失败返回 422 与原因",
  inputMissCode === 422 && JSON.parse(inputMissBody).reason.includes("文件不存在"));
const [, , inputHiddenBody] = await inputEndpoint.init({
  data: { value: "/fake/materials/notes.md", includeText: false },
});
check("endpoints: inputs/resolve 可要求不回显正文",
  !("text" in JSON.parse(inputHiddenBody).fields));

console.log("");
console.log("== 会话历史：检索与导出（R13）==");
check("history: 角色名可读", Sideline.history.roleText("user") === "我"
  && Sideline.history.roleText("assistant") === "Sideline");
check("history: 文件名清理非法字符",
  Sideline.history.safeFileName('a/b:c*?"<>|d', "fallback") === "a_b_c_d"
  && Sideline.history.safeFileName("   ", "fallback") === "fallback");
check("history: PDF 深链格式",
  Sideline.history.pdfLink("ATTKEY01", "3") === "zotero://open-pdf/library/items/ATTKEY01?page=3"
  && Sideline.history.pdfLink("", "3") === "");
const historySessions = [
  {
    id: "s1",
    name: "第一次会话",
    created: 1,
    updated: 2,
    active: false,
    messages: [
      { role: "user", content: "连续谱耦合是什么？", display: "连续谱耦合是什么？", time: "2026-01-01 10:00" },
      {
        role: "assistant",
        content: "连续谱耦合让镜像能差减小（第 3 页）。",
        model: "deepseek-chat",
        time: "2026-01-01 10:01",
        citations: [{ kind: "pageref", label: "第 3 页", pageLabel: "3", pageIndex: 2 }],
      },
    ],
  },
  {
    id: "s2",
    name: "第二次会话",
    created: 3,
    updated: 4,
    active: true,
    messages: [{ role: "user", content: "把它和滴线联系起来", display: "把它和滴线联系起来" }],
  },
];
const historyHits = Sideline.history.search(historySessions, "连续谱");
check("history: 检索命中消息并带会话与序号",
  historyHits.total === 2 && historyHits.hits[0].sessionId === "s1"
  && historyHits.hits[0].index === 0 && historyHits.hits[0].roleText === "我");
check("history: 命中片段带正文",
  historyHits.hits[1].snippet.includes("镜像能差"));
check("history: 多词按全部出现匹配",
  Sideline.history.search(historySessions, "连续谱 滴线").total === 0);
check("history: 命中会话名也算命中",
  Sideline.history.search(historySessions, "第二次").hits.length >= 1);
check("history: 超出上限时截断并报告",
  Sideline.history.search(historySessions, "连续谱", { maxHits: 1 }).truncated === 1);
check("history: 空查询返回空结果", Sideline.history.search(historySessions, "").hits.length === 0);
const markdownExport = Sideline.history.toMarkdown({
  itemKey: "ITEMKEY1",
  title: "导出测试论文",
  attachmentKey: "ATTKEY01",
  nowText: "2026-01-01 12:00",
  sessions: historySessions,
});
check("history: Markdown 导出含标题、条目链接与深链",
  markdownExport.includes("# Sideline 会话导出：导出测试论文")
  && markdownExport.includes("zotero://select/library/items/ITEMKEY1")
  && markdownExport.includes("zotero://open-pdf/library/items/ATTKEY01?page=3"));
check("history: Markdown 导出含两条会话与消息",
  markdownExport.includes("## 第一次会话") && markdownExport.includes("## 第二次会话（当前会话）")
  && markdownExport.includes("### 我") && markdownExport.includes("### Sideline（deepseek-chat）"));
check("history: 导出不写入标签或短总结",
  !markdownExport.includes("总结: ") && !markdownExport.includes("tags"));
const jsonExport = Sideline.history.toJson({
  itemKey: "ITEMKEY1",
  title: "导出测试论文",
  attachmentKey: "ATTKEY01",
  sessions: historySessions,
});
check("history: JSON 导出保留结构与引用",
  jsonExport.schema === "zotero-sideline-sessions/v1"
  && jsonExport.item.key === "ITEMKEY1"
  && jsonExport.sessions[0].messages[1].citations[0].pageLabel === "3");

// 真实 store 上的检索与导出
const historyAttachment = makeAttachment({ id: 7601, parentID: 7600, title: "Full Text PDF" });
const historyItem = makeRegularItem({
  id: 7600,
  fields: { title: "历史检索论文" },
  attachment: historyAttachment,
});
await Sideline.store.clear();
Sideline.session.clear(historyItem.id);
await Sideline.store.remove(historyItem.id);
Sideline.session.append(historyItem.id, "user", "这篇的结论是什么？", { display: "这篇的结论是什么？" });
Sideline.session.append(historyItem.id, "assistant", "结论是连续谱耦合不可忽略（第 3 页）。", {
  model: "deepseek-chat",
  citations: [{ kind: "pageref", label: "第 3 页", pageLabel: "3", pageIndex: 2 }],
});
await Sideline.store.flush();

Sideline.session.append(historyItem.id, "user", "那滴线位置呢？", { display: "那滴线位置呢？" });
await Sideline.store.flush();
const storedHistory = await Sideline.history.find(historyItem.id, "连续谱");
check("history: 在真实 store 上检索唯一会话消息",
  storedHistory.sessionsScanned === 1 && storedHistory.total === 1
  && storedHistory.hits[0].sessionId !== "");
const storedExport = await Sideline.history.build(historyItem.id, { format: "markdown" });
check("history: 导出包含附件深链与全部会话",
  storedExport.sessionCount === 1 && storedExport.messageCount === 3
  && storedExport.text.includes("zotero://open-pdf/library/items/ATT7601?page=3")
  && storedExport.filename.includes("历史检索论文"));
const storedJson = await Sideline.history.build(historyItem.id, { format: "json" });
check("history: JSON 导出可解析", JSON.parse(storedJson.text).sessions.length === 1);
const storedSingle = await Sideline.history.build(historyItem.id, {
  format: "markdown",
  sessionId: (await Sideline.store.listSessions(historyItem.id)).find((entry) => entry.active).id,
});
check("history: 可只导出指定会话", storedSingle.sessionCount === 1);
const exportPath = "/fake/exports/sessions.md";
await Sideline.history.save(exportPath, storedExport.text);
check("history: 显式给路径时写文件", fakeFs.get(exportPath).includes("# Sideline 会话导出"));

console.log("== 图片材料与页码说明 ==");
check("materials: 带页码说明的图片材料会同时送入说明文本", (() => {
  const list = [
    Sideline.materials.fromImage({
      name: "区域",
      dataUrl: "data:image/png;base64,AA",
      text: "【页面区域截图】来自第 3 页",
      pageIndex: 2,
      pageLabel: "3",
    }),
  ];
  const assembled = Sideline.materials.assemble(list, { maxChars: 0 });
  return assembled.images.length === 1 && assembled.text.includes("来自第 3 页")
    && assembled.items[0].reason.includes("附带页码说明");
})());
check("materials: 普通图片材料不占文本预算", (() => {
  const list = [Sideline.materials.fromImage({ name: "图", dataUrl: "data:image/png;base64,AA" })];
  const assembled = Sideline.materials.assemble(list, { maxChars: 10 });
  return assembled.images.length === 1 && assembled.text === "";
})());

console.log("");
console.log("== 跨文献来源标注（R14）==");
check("prompts: 单篇材料不追加跨文献要求",
  !Sideline.prompts.systemFor(Sideline.config.read(), { itemCount: 1 }).includes("跨文献要求"));
const crossSystem = Sideline.prompts.systemFor(Sideline.config.read(), { itemCount: 3 });
check("prompts: 多篇材料追加逐条标注来源的要求",
  crossSystem.includes("【跨文献要求】") && crossSystem.includes("来自 3 篇不同文献")
  && crossSystem.includes("未涉及"));
check("prompts: 跨文献要求不取代通用回答要求",
  crossSystem.includes("【回答要求】") && crossSystem.includes("材料未提及"));

console.log("");
console.log("== 整理为子笔记（R16）==");
const excerptItem = makeRegularItem({ id: 7800, fields: { title: "整理笔记论文" } });
const excerptAttachment = makeAttachment({ id: 7801, parentID: 7800, title: "Full Text PDF" });
const excerptMessages = [
  { role: "user", content: "连续谱耦合如何影响镜像能差？", display: "连续谱耦合如何影响镜像能差？" },
  {
    role: "assistant",
    content: "连续谱耦合使镜像能差减小。",
    model: "deepseek-chat",
    time: "2026-01-01 10:01",
    citations: [
      { kind: "pageref", label: "第 3 页", pageLabel: "3", pageIndex: 2 },
      { kind: "anchor", label: "选区原文（第 4 页）：核力是短程吸引", pageLabel: "4", pageIndex: 3 },
    ],
  },
];
const excerptPlan = Sideline.excerpt.plan({
  item: excerptItem,
  messages: excerptMessages,
  itemKey: excerptItem.key,
  attachmentKey: excerptAttachment.key,
  itemTitle: "整理笔记论文",
});
check("excerpt: 预览含两段对话与来源链接",
  excerptPlan.blockCount === 2
  && excerptPlan.markdown.includes("## 我") && excerptPlan.markdown.includes("## Sideline（deepseek-chat）")
  && excerptPlan.markdown.includes("zotero://open-pdf/library/items/ATT7801?page=4"));
check("excerpt: 来源清单汇总条目、页码与锚点",
  excerptPlan.sources.itemKey === excerptItem.key
  && excerptPlan.sources.pages.join(",") === "3,4"
  && excerptPlan.sources.anchors.length === 1);
check("excerpt: 标题带条目标题与时间",
  excerptPlan.title.startsWith("Sideline 摘录：整理笔记论文（") && excerptPlan.title.endsWith("）"));
check("excerpt: 笔记 HTML 可被 ZotLit 重新导出（含标题与链接）",
  excerptPlan.html.includes("<h1>") && excerptPlan.html.includes("<h2>")
  && excerptPlan.html.includes("zotero://select/library/items/KEY7800"));
check("excerpt: 预览阶段没有写库", excerptItem._notes.length === 0);
const excerptResult = await Sideline.excerpt.commit({ item: excerptItem, plan: excerptPlan });
check("excerpt: 确认后新建子笔记",
  excerptItem._notes.length === 1 && excerptResult.noteKey.startsWith("NOTE")
  && items.get(excerptResult.noteID).note.includes("zotero://open-pdf/library/items/ATT7801?page=3"));
check("excerpt: 空消息时报错", (() => {
  try {
    Sideline.excerpt.plan({ item: excerptItem, messages: [] });
    return false;
  }
  catch (error) {
    return Sideline.util.message(error).includes("没有可整理的消息");
  }
})());
await Sideline.writes.record(excerptItem.id, {
  kind: "note",
  targetID: excerptResult.noteID,
  key: excerptResult.noteKey,
  summary: `整理为笔记：${excerptResult.title}`,
});
check("excerpt: 写入进审计记录", (await Sideline.writes.list(excerptItem.id))[0].summary.includes("整理为笔记"));

console.log("");
console.log("== 第 4 批端点 ==");
const searchEndpoint = new Zotero.Server.Endpoints["/sideline/sessions/search"]();
const [, , searchBody] = await searchEndpoint.init({ data: { itemID: 7600, query: "连续谱" } });
const searchJson = JSON.parse(searchBody);
check("endpoints: sessions/search 返回命中与会话清单",
  searchJson.total === 1 && searchJson.sessionsScanned === 1
  && searchJson.hits[0].sessionId !== "" && searchJson.sessions.length === 1);
const exportEndpoint = new Zotero.Server.Endpoints["/sideline/sessions/export"]();
const [, , exportPreviewBody] = await exportEndpoint.init({ data: { itemID: 7600, format: "markdown" } });
const exportPreviewJson = JSON.parse(exportPreviewBody);
check("endpoints: sessions/export 默认只返回内容",
  exportPreviewJson.sessionCount === 1 && exportPreviewJson.text.includes("Sideline 会话导出")
  && !exportPreviewJson.saved);
const [, , exportFileBody] = await exportEndpoint.init({
  data: { itemID: 7600, format: "json", path: "/fake/exports/sessions.json" },
});
check("endpoints: sessions/export 给路径时写文件",
  JSON.parse(exportFileBody).saved === "/fake/exports/sessions.json"
  && fakeFs.get("/fake/exports/sessions.json").includes("zotero-sideline-sessions/v1"));
const [, , exportEmptyBody] = await exportEndpoint.init({ data: { itemID: 7102 } });
check("endpoints: sessions/export 无会话时返回 400",
  JSON.parse(exportEmptyBody).error.includes("没有会话"));
const excerptEndpoint = new Zotero.Server.Endpoints["/sideline/excerpt"]();
const [, , excerptPreviewBody] = await excerptEndpoint.init({
  data: { itemID: 7800, question: "问题", answer: "回答", action: "preview" },
});
const excerptPreviewJson = JSON.parse(excerptPreviewBody);
check("endpoints: excerpt preview 返回计划与 markdown",
  excerptPreviewJson.plan.blockCount === 2 && excerptPreviewJson.markdown.includes("## 我"));
const excerptTarget = makeRegularItem({ id: 7802, fields: { title: "端点整理论文" } });
const [, , excerptNoConfirmBody] = await excerptEndpoint.init({
  data: { itemID: 7802, question: "问题", answer: "回答", action: "commit" },
});
check("endpoints: excerpt commit 缺 confirm 时不写入",
  JSON.parse(excerptNoConfirmBody).error.includes("confirm")
  && excerptTarget._notes.length === 0);
const [, , excerptCommitBody] = await excerptEndpoint.init({
  data: { itemID: 7802, question: "问题", answer: "带来源的回答", action: "commit", confirm: true },
});
check("endpoints: excerpt commit 写入并回报 key",
  JSON.parse(excerptCommitBody).result.noteKey.startsWith("NOTE")
  && excerptTarget._notes.length === 1);
console.log("== bootstrap 注销 ==");
// 注销前会先把待写存档落盘，因此 shutdown 返回 Promise
const shutdownItem = makeRegularItem({ id: 5050, fields: { title: "退出前写入条目" } });
await Sideline.store.touch(shutdownItem.id, { title: "退出前写入", messages: [{ role: "user", content: "退出测试" }] });
await context.SidelineBootstrap.shutdown();
equal("bootstrap: 注销后无端点", Object.keys(Zotero.Server.Endpoints).length, 0);
equal("bootstrap: 注销划词监听与工具栏监听", calls.readerUnregister.length, 2);
equal("bootstrap: 注销首选项面板", calls.paneUnregister.length, 1);
equal("bootstrap: 无 AI 大纲右键菜单需要注销", calls.menuUnregister.length, 0);
const shutdownAttachment = await Sideline.store.resolveAttachment(shutdownItem.id);
check("bootstrap: 注销前把待写会话落盘到附件",
  !!shutdownAttachment.attachmentID
  && JSON.parse(fakeFs.get(shutdownAttachment.path)).sessions.length === 1);

/**
 * 建一个独立沙箱：用于验证「冷启动」从条目下的会话附件读取已有对话。
 * @param {Map} fileMap 虚拟文件系统
 * @param {object[]} itemDefs 直接给出的条目定义（用 coldItem/coldAttachment 构造）
 */
function createColdSandbox(fileMap, itemDefs = []) {
  const localPrefs = Object.assign({}, prefs);
  const coldItems = new Map();
  for (const def of itemDefs) coldItems.set(def.id, def);
  const localZotero = {
    version: "10.0.3-test",
    initializationPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    debug: () => {},
    warn: () => {},
    logError: () => {},
    Prefs: {
      get: (name) => localPrefs[resolvePrefKey(name)],
      set: (name, value) => {
        localPrefs[resolvePrefKey(name)] = value;
      },
    },
    DataDirectory: { dir: "/fake-data", getSubdirectory: (name) => `/fake-data/${name}` },
    File: {
      getContentsAsync: async (filePath) => {
        if (fileMap.has(filePath)) return fileMap.get(filePath);
        throw new Error(`ENOENT: ${filePath}`);
      },
      putContentsAsync: async (filePath, data) => {
        fileMap.set(filePath, String(data));
      },
      pathToFile: (filePath) => ({ path: filePath, exists: () => fileMap.has(filePath.replace(/\\/g, "/")) }),
      createDirectoryIfMissingAsync: async () => {},
      removeIfExists: (filePath) => fileMap.delete(filePath),
      getResourceAsync: async () => "",
    },
    getTempDirectory: () => ({ path: "/cold-temp" }),
    Attachments: { LINK_MODE_IMPORTED_FILE: 0 },
    Libraries: { getAll: () => [{ libraryID: 1 }] },
    Search: class ColdSearch {
      constructor() {
        this.conditions = [];
      }

      addCondition(condition, operator, value) {
        this.conditions.push({ condition, operator, value });
      }

      async search() {
        const wanted = this.conditions.find((entry) => entry.condition === "title");
        if (!wanted) return [];
        const found = [];
        for (const item of coldItems.values()) {
          if (!item.isAttachment || !item.isAttachment()) continue;
          if (!String(item.getField("title") || "").includes(String(wanted.value))) continue;
          found.push(item.id);
        }
        return found;
      }
    },
    Items: { get: (id) => coldItems.get(id) || null },
    Fulltext: {
      canIndex: () => false,
      indexItems: async () => {},
      getPages: async () => null,
      getIndexedState: async () => null,
      getItemCacheFile: () => ({ path: "" }),
    },
    HTTP: { request: async () => { throw new Error("冷沙箱不应发起网络请求"); } },
    Server: { Endpoints: {} },
    Reader: { registerEventListener: () => {}, unregisterEventListener: () => {} },
    ItemPaneManager: { registerSection: () => "cold-pane", unregisterSection: () => {} },
    PreferencePanes: { register: async () => "cold-pane", unregister: () => {} },
    Item: function ColdItem() {},
    ftl: { addResourceIds: () => {} },
    getMainWindows: () => [],
    getMainWindow: () => null,
  };
  const coldContext = vm.createContext({
    Sideline: {},
    Zotero: localZotero,
    Components: { interfaces: {}, classes: {} },
    ChromeUtils: {
      importESModule: (uri) => (String(uri).includes("Subprocess") ? { Subprocess: fakeSubprocess } : {}),
      import: (uri) => (String(uri).includes("Subprocess") ? { Subprocess: fakeSubprocess } : {}),
    },
    Services: {
      scriptloader: {
        loadSubScript: (url, scope) => {
          for (const [key, value] of Object.entries(scope)) {
            coldContext[key] = value;
          }
          const relative = url.slice(rootURI.length);
          vm.runInContext(fs.readFileSync(path.join(srcDir, relative), "utf8"), coldContext, {
            filename: `cold:${relative}`,
          });
        },
      },
    },
    console,
  });
  vm.runInContext(fs.readFileSync(path.join(srcDir, "bootstrap.js"), "utf8"), coldContext, {
    filename: "cold:bootstrap.js",
  });
  coldContext.SidelineBootstrap.load(rootURI);
  return { Sideline: coldContext.Sideline, files: fileMap, items: coldItems };
}

/** 冷沙箱里的普通条目（自带可注册子附件的附件表） */
function coldItem(id, title) {
  const item = {
    id,
    key: `COLD${id}`,
    libraryID: 1,
    parentID: null,
    deleted: false,
    _attachments: [],
    isRegularItem: () => true,
    isAttachment: () => false,
    getField: (name) => (name === "title" ? title : ""),
    getCreators: () => [],
    getAttachments: () => item._attachments.slice(),
  };
  return item;
}

/** 冷沙箱里的会话附件 */
function coldAttachment(id, parentID, path, title = "Sideline 会话") {
  const item = {
    id,
    key: `COLDATT${id}`,
    libraryID: 1,
    parentID,
    deleted: false,
    attachmentContentType: "application/json",
    isRegularItem: () => false,
    isAttachment: () => true,
    isStoredFileAttachment: () => true,
    getField: (name) => (name === "title" ? title : ""),
    getCreators: () => [],
    getFilePathAsync: async () => path,
    saveTx: async () => {},
  };
  return item;
}

console.log("");
console.log("== 冷启动读取会话附件 ==");
const coldItemA = coldItem(777, "冷启动条目");
const coldPathA = "/fake-storage/9001/sideline-sessions.json";
coldItemA._attachments.push(9001);
const coldFiles = new Map();
coldFiles.set(coldPathA, JSON.stringify({
  version: 2,
  marker: "zotero-sideline-sessions",
  itemID: 777,
  title: "冷启动条目",
  updated: 1700000000000,
  activeId: "s1",
  sessions: [{
    id: "s1",
    name: "第一次会话",
    created: 1700000000000,
    updated: 1700000000000,
    messages: [
      { role: "user", content: "旧问题", time: "2026-01-01 10:00" },
      { role: "assistant", content: "旧回答", model: "m", time: "2026-01-01 10:01" },
    ],
  }],
}));
const cold = createColdSandbox(coldFiles, [coldItemA, coldAttachment(9001, 777, coldPathA)]);
const coldList = await cold.Sideline.store.list();
equal("store(冷启动): 读出 1 条存档", coldList.length, 1);
equal("store(冷启动): 标题与消息数", `${coldList[0].title}|${coldList[0].messageCount}|${coldList[0].sessionCount}`,
  "冷启动条目|2|1");
const coldResolve = await cold.Sideline.store.resolveAttachment(777);
check("store(冷启动): 命中已有会话附件", coldResolve.attachmentID === 9001 && coldResolve.exists === true);
const coldRecord = await cold.Sideline.session.restore(777);
check("session(冷启动): 消息恢复进内存", !!coldRecord && cold.Sideline.session.count(777) === 2
  && cold.Sideline.session.history(777)[0].content === "旧问题");
check("session(冷启动): 已有内存时不覆盖", (await cold.Sideline.session.restore(777)) === null);
check("session(冷启动): 会话名与 id 一并恢复",
  cold.Sideline.session.currentSession(777).name === "第一次会话"
  && cold.Sideline.session.currentSession(777).id === "s1");

const corruptColdItem = coldItem(888, "损坏附件条目");
const corruptColdPath = "/fake-storage/9002/sideline-sessions.json";
corruptColdItem._attachments.push(9002);
const corruptCold = createColdSandbox(new Map([[corruptColdPath, "{ 这不是合法 JSON"]]),
  [corruptColdItem, coldAttachment(9002, 888, corruptColdPath)]);
check("store(冷启动): 损坏附件按空处理", (await corruptCold.Sideline.store.get(888)) === null);
check("store(冷启动): 保留 corrupt 副本",
  corruptCold.files.has("/fake-data/sideline/sessions-attachment-888.json.corrupt"));
check("store(冷启动): 记录读取错误", (await corruptCold.Sideline.store.stats()).loadError.length > 0);

console.log("");
const { runAgentTests } = await import("./agent-tests.mjs");
const agentHarness = await runAgentTests({ projectRoot, check, equal });
const { runFixTests } = await import("./fix-tests.mjs");
await runFixTests({ projectRoot, check, equal });
const { runConversationTests } = await import("./conversation-tests.mjs");
await runConversationTests({ projectRoot, check, equal });
const originalAgents = Sideline.agents, originalRead = Sideline.config.read;
Sideline.agents = agentHarness.Sideline.agents;
Sideline.config.read = agentHarness.Sideline.config.read;
makeRegularItem({ id: 9920, fields: { title: "Agent 取消会话" } });
makeAttachment({ id: 9921, parentID: 9920, title: "Agent cancel PDF" });
const cancelDoc = makeReaderShellDom(); buildSidebarShell(cancelDoc);
const cancelReader = { itemID: 9921, tabID: "agent-cancel", _instanceID: "agent-cancel", type: "pdf",
  _iframeWindow: { document: cancelDoc, MutationObserver: FakeMutationObserver },
  _internalReader: { toggleSidebar: () => cancelDoc.body.classList.add("sidebar-open") } };
const cancelState = Sideline.readerside.attach(cancelReader);
for (const type of ["codex", "opencode", "dsh"]) {
  cancelState.ownerID = 9920 + ["codex", "opencode", "dsh"].indexOf(type);
  makeRegularItem({ id: cancelState.ownerID, fields: { title: type } });
  agentHarness.use(type);
  const selfCheck = JSON.parse((await selfTestEndpoint.init({ data: {} }))[2]);
  check(`selftest: ${type} 无需 HTTP 配置`, selfCheck.checks.some((entry) => entry.name === "Agent 安装" && entry.status === "pass")
    && !selfCheck.checks.some((entry) => entry.name === "配置完整（api/model/key）"));
  Sideline.session.clear(cancelState.ownerID);
  await Sideline.store.remove(cancelState.ownerID);
  cancelState.els.textarea.value = `保留 ${type} 问题`;
  const sending = Sideline.readerside.send(cancelState);
  for (let attempt = 0; attempt < 100 && !String(cancelState.els.messagesEl.textContent).includes("部分回答"); attempt++) await sleep(5);
  cancelState.els.stopButton.dispatch("click");
  await sending;
  const messages = Sideline.session.list(cancelState.ownerID);
  check(`readerside: ${type} 实际适配器停止后问题和片段入会话`,
    messages.some((entry) => entry.role === "user" && entry.question === `保留 ${type} 问题`)
    && messages.some((entry) => entry.role === "assistant" && entry.stopped && entry.content === "部分回答"));
}
Sideline.agents = originalAgents; Sideline.config.read = originalRead;

const chatBeforeRecovery = Sideline.providers.chat;
const resetBeforeClear = Sideline.agentconversation.reset;
let resetOwner = 0;
try {
  Sideline.providers.chat = async (options) => {
    check("readerside: Agent request carries paper identity", options.ownerID === panelState.ownerID);
    const warning = "Agent 原会话无法恢复，已新建并补入上下文";
    options.onWarning(warning);
    return { content: "恢复后的回答", provider: "agent", model: "test", sessionWarning: warning };
  };
  panelState.els.textarea.value = "恢复测试";
  await Sideline.readerside.send(panelState);
  check("readerside: recovery warning remains red after answer", panelState.els.statusEl.classList.contains("sideline-error")
    && panelState.els.statusEl.textContent.includes("原会话无法恢复"));
  let releaseReset;
  Sideline.agentconversation.reset = async (ownerID) => { resetOwner = ownerID; await new Promise((resolve) => { releaseReset = resolve; }); };
  const deletedBefore = [...items.values()].filter((item) => item.deleted).length;
  findByText(panelState.els.panel, "⋯").dispatch("click");
  findByText(findByClass(panelState.els.panel, "sl-menu"), "清空本会话").dispatch("click");
  await sleep(5);
  check("readerside: clear empties visible history before native reset resolves",
    Sideline.session.list(panelState.ownerID).length === 0 && panelState.busy && panelState.els.sendButton.disabled
    && panelState.els.stopButton.hidden && panelState.els.statusEl.textContent.includes("正在重置"));
  releaseReset();
  for (let i = 0; i < 100 && panelState.busy; i++) await sleep(5);
  check("readerside: clear resets mapped Agent and Sideline content", resetOwner === panelState.ownerID
    && Sideline.session.list(panelState.ownerID).length === 0 && await Sideline.store.get(panelState.ownerID) === null);
  equal("readerside: clear leaves written notes and annotations intact", [...items.values()].filter((item) => item.deleted).length, deletedBefore);
} finally {
  Sideline.providers.chat = chatBeforeRecovery;
  Sideline.agentconversation.reset = resetBeforeClear;
}

const beforeImageConfig = Sideline.config.read, beforeImageChat = Sideline.providers.chat;
const testImage = JSON.parse(fs.readFileSync(path.join(srcDir, "content/vision-test.json"), "utf8")).image;
try {
  Sideline.config.read = () => ({ ...beforeImageConfig(), textChannel: "agent", visionApi: "", visionSecretKey: "", visionModel: "", visionUseText: false });
  const observed = [];
  Sideline.providers.chat = async (options) => { observed.push(options); return { provider: "agent", model: "test", content: "图中有形状" }; };
  panelState.materials = [Sideline.materials.fromImage({ dataUrl: testImage, name: "test.png", mime: "image/png" })];
  panelState.els.textarea.value = "识图";
  await Sideline.readerside.send(panelState);
  check("readerside images: Agent ignores missing vision API", observed.length === 1 && observed[0].images[0] === testImage);
  check("readerside images: first user message retains image", Sideline.session.list(panelState.ownerID).find((m) => m.role === "user").images[0] === testImage);
  panelState.els.textarea.value = "继续解释";
  await Sideline.readerside.send(panelState);
  equal("readerside images: repeated material stored only once", Sideline.session.list(panelState.ownerID).filter((m) => m.role === "user").flatMap((m) => m.images || []).length, 1);
  await Sideline.store.touch(panelState.ownerID, { messages: Sideline.session.list(panelState.ownerID) });
  const persistedImages = await Sideline.store.get(panelState.ownerID);
  check("store images: JSON attachment retains user image", persistedImages.messages.some((m) => (m.images || []).includes(testImage)));
} finally { Sideline.config.read = beforeImageConfig; Sideline.providers.chat = beforeImageChat; }

const { runDshStreamTests } = await import("./dsh-stream-tests.mjs");
runDshStreamTests({ Sideline, check, equal });

console.log(`总计 ${results.length} 项检查，失败 ${failures} 项。`);
if (failures) {
  console.log("失败明细：");
  for (const entry of results.filter((item) => !item.ok)) {
    console.log(` - ${entry.name}${entry.detail ? `：${entry.detail}` : ""}`);
  }
}
console.log("提示：本测试用假宿主替换 Zotero，界面渲染、真实全文索引与真实模型调用仍需按 docs/验收.md 在 Zotero 内验收。");
process.exit(failures ? 1 : 0);
