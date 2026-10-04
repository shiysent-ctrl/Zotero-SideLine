/*
 * Sideline 假宿主的公共 DOM 夹具。
 * 输入：标签、选择器及合成节点；输出：测试节点、查询结果和阅读器外壳。
 * 依赖：无文件、Zotero 或模型依赖。只实现测试需要的 DOM 子集，不代表 Gecko 渲染已验证。
 */
/** 最小 DOM 桩：只实现 util.element 与界面代码用到的那部分能力 */
export function makeFakeElement(tag) {
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
    contains(node) {
      for (let current = node; current; current = current.parentNode) {
        if (current === element) return true;
      }
      return false;
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
export function queryAll(root, selector) {
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

export function queryOne(root, selector) {
  return queryAll(root, selector)[0] || null;
}

export function findAll(node, predicate, result = []) {
  if (predicate(node)) result.push(node);
  for (const child of node.children || []) {
    findAll(child, predicate, result);
  }
  return result;
}

export function findByClass(node, className) {
  return findAll(node, (item) => String(item.className).split(/\s+/).includes(className))[0] || null;
}

export function findByTag(node, tag) {
  return findAll(node, (item) => item.tagName === String(tag).toUpperCase())[0] || null;
}

export function findByText(node, text) {
  return findAll(node, (item) => item.tagName === "BUTTON" && item.textContent.includes(text))[0] || null;
}

/** 阅读器外壳 DOM 桩：支持 id/class 查询、XHTML 建元素与 style 变量 */
export function makeReaderShellDom() {
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
export function buildSidebarShell(doc) {
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
