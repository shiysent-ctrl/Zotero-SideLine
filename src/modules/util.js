/*
 * Zotero Sideline：通用工具。
 * 功能：日志、主窗口与窗口级能力获取、文本截断、HTML 转义、Markdown 渲染、DOM 助手。
 * 说明：沙箱里没有 window 的 fetch/AbortController/定时器，一律通过 windowTools() 从主窗口取。
 */

Sideline.util = (function () {
  const NAME = "Zotero Sideline";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  function log(text) {
    try {
      Zotero.debug(`${NAME}: ${text}`);
    }
    catch (error) {
      // 日志失败不影响功能
    }
  }

  function warn(text) {
    try {
      Zotero.warn(`${NAME}: ${text}`);
    }
    catch (error) {
      // 同上
    }
  }

  function message(cause) {
    if (!cause) return "未知错误";
    return cause.message ? String(cause.message) : String(cause);
  }

  function error(cause) {
    try {
      Zotero.logError(cause instanceof Error ? cause : new Error(message(cause)));
    }
    catch (inner) {
      // 忽略
    }
  }

  /** @returns {Window[]} 全部主窗口，取不到时返回空数组 */
  function mainWindows() {
    try {
      if (typeof Zotero.getMainWindows === "function") {
        const windows = Zotero.getMainWindows();
        if (windows && windows.length) return windows;
      }
    }
    catch (cause) {
      // 落到下面的兜底
    }
    try {
      const win = Zotero.getMainWindow();
      if (win) return [win];
    }
    catch (cause) {
      // 无主窗口
    }
    return [];
  }

  /** @returns {object} 从主窗口取得的能力集合，缺项为 null */
  function windowTools() {
    const win = mainWindows()[0] || null;
    const bind = (name) => (win && typeof win[name] === "function" ? win[name].bind(win) : null);
    return {
      win,
      fetch: bind("fetch"),
      setTimeout: bind("setTimeout"),
      clearTimeout: bind("clearTimeout"),
      AbortController: win && win.AbortController ? win.AbortController : null,
      TextDecoder: win && win.TextDecoder ? win.TextDecoder : null,
    };
  }

  function truncate(text, max) {
    const value = String(text == null ? "" : text);
    if (!max || value.length <= max) return { text: value, truncated: false };
    return { text: value.slice(0, max), truncated: true };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  /** KaTeX 渲染；失败时保留可读的 TeX 源码，不让一条坏公式破坏整段回答。 */
  function mathToHtml(tex, displayMode) {
    const source = String(tex == null ? "" : tex).trim();
    if (!source) return "";
    try {
      if (typeof katex !== "undefined" && katex && typeof katex.renderToString === "function") {
        const rendered = katex.renderToString(source, {
          displayMode: !!displayMode,
          throwOnError: false,
          strict: "ignore",
          trust: false,
          output: "htmlAndMathml",
        });
        return displayMode
          ? `<div class="sl-math sl-math-display">${rendered}</div>`
          : `<span class="sl-math sl-math-inline">${rendered}</span>`;
      }
    }
    catch (error) {
      warn(`公式渲染失败：${message(error)}`);
    }
    const escaped = escapeHtml(source);
    return displayMode
      ? `<pre class="sl-math-fallback">$$${escaped}$$</pre>`
      : `<code class="sl-math-fallback">$${escaped}$</code>`;
  }

  /** 行内 Markdown：数学、`code`、**粗体**、*斜体*、[文字](链接) */
  function inline(text) {
    const math = [];
    const protectedText = String(text == null ? "" : text).replace(/(^|[^\\])\$([^$\n]+?)\$/g,
      (match, prefix, tex) => {
        const token = `\uFFF2${math.length}\uFFF3`;
        math.push(mathToHtml(tex, false));
        return `${prefix}${token}`;
      });
    let out = escapeHtml(protectedText);
    out = out.replace(/`([^`]+)`/g, (match, code) => `<code>${code}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (match, label, href) => {
      return `<a href="${escapeAttr(href)}">${label}</a>`;
    });
    math.forEach((html, index) => {
      out = out.split(`\uFFF2${index}\uFFF3`).join(html);
    });
    return out;
  }

  function renderTable(rows) {
    const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    const header = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    const head = header.map((cell) => `<th>${inline(cell)}</th>`).join("");
    const rest = body
      .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
      .join("\n");
    return `<table><thead><tr>${head}</tr></thead><tbody>${rest}</tbody></table>`;
  }

  /**
   * 把 Markdown 渲染为 HTML。先整体转义再补标签，因此模型输出里的原始 HTML 不会生效。
   * 支持标题、段落、引用、有序/无序列表、围栏代码块、表格与行内元素。
   */
  function markdownToHtml(markdown) {
    const lines = String(markdown == null ? "" : markdown).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let listType = null;
    let index = 0;

    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };

    while (index < lines.length) {
      const line = lines[index];
      const fence = line.match(/^\s*```(.*)$/);
      if (fence) {
        closeList();
        const lang = fence[1].trim();
        const code = [];
        index++;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index++;
        }
        index++;
        const attr = lang ? ` data-lang="${escapeAttr(lang)}"` : "";
        out.push(`<pre class="sideline-code"><code${attr}>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      if (!line.trim()) {
        closeList();
        index++;
        continue;
      }

      const displayOneLine = line.match(/^\s*\$\$([\s\S]*?)\$\$\s*$/);
      if (displayOneLine) {
        closeList();
        out.push(mathToHtml(displayOneLine[1], true));
        index++;
        continue;
      }

      if (/^\s*\$\$\s*$/.test(line)) {
        closeList();
        const formula = [];
        index++;
        while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index])) {
          formula.push(lines[index]);
          index++;
        }
        if (index < lines.length) index++;
        out.push(mathToHtml(formula.join("\n"), true));
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        index++;
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        closeList();
        out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        index++;
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
        closeList();
        const rows = [];
        while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
          rows.push(lines[index]);
          index++;
        }
        out.push(renderTable(rows));
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || ordered) {
        const wanted = bullet ? "ul" : "ol";
        if (listType !== wanted) {
          closeList();
          out.push(`<${wanted}>`);
          listType = wanted;
        }
        out.push(`<li>${inline((bullet || ordered)[1])}</li>`);
        index++;
        continue;
      }

      closeList();
      out.push(`<p>${inline(line)}</p>`);
      index++;
    }

    closeList();
    return out.join("\n");
  }

  /** 把时间戳格式化为本地「YYYY-MM-DD HH:mm」 */
  function timeText(timestamp) {
    const date = timestamp ? new Date(timestamp) : new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function nowText() {
    return timeText(Date.now());
  }

  /**
   * 在 Zotero 的 XUL 文档里建 HTML 元素。
   * 主窗口与阅读器文档都是 XUL 文档，createElement('textarea') 会建出无法渲染的 XUL 元素，
   * 因此表单控件与容器统一走 XHTML 命名空间。
   */
  function element(doc, tag, options = {}) {
    const node = doc.createElementNS
      ? doc.createElementNS(XHTML_NS, tag)
      : doc.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text != null) node.textContent = String(options.text);
    if (options.html != null) node.innerHTML = String(options.html);
    if (options.style) node.setAttribute("style", options.style);
    if (options.attrs) {
      for (const [key, value] of Object.entries(options.attrs)) {
        node.setAttribute(key, String(value));
      }
    }
    return node;
  }

  /** 给阅读器文档加载随插件打包的 KaTeX 样式；重复调用不会重复插入。 */
  function ensureMathStyles(doc) {
    if (!doc || !rootURI) return null;
    const existing = doc.getElementById && doc.getElementById("sideline-katex-style");
    if (existing) return existing;
    const link = element(doc, "link", {
      attrs: {
        id: "sideline-katex-style",
        rel: "stylesheet",
        href: `${rootURI}vendor/katex/katex.min.css`,
      },
    });
    (doc.head || doc.documentElement).appendChild(link);
    return link;
  }

  /**
   * 绑定激活事件。XUL 按钮派发 command、HTML 元素派发 click，同一次点击可能两者都来，
   * 因此同时监听并只忽略「紧接着的另一种事件」；同类型事件的重复（例如真双击、快速重试）
   * 必须照常执行，否则会把用户的第二次点击吞掉。
   */
  function onActivate(node, handler) {
    let lastType = "";
    let lastTime = 0;
    const run = (event) => {
      const type = event && event.type ? String(event.type) : "";
      const now = Date.now();
      if (type && type !== lastType && now - lastTime < 400) return;
      lastType = type;
      lastTime = now;
      try {
        handler(event);
      }
      catch (error) {
        Sideline.util.error(error);
      }
    };
    node.addEventListener("command", run);
    node.addEventListener("click", run);
    return node;
  }

  /** 复制纯文本到系统剪贴板 */
  function copyText(text) {
    try {
      // 用 Components.interfaces 而非裸 Ci：后者在插件 bootstrap 沙箱里没有保证
      const helper = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      helper.copyString(String(text));
      return true;
    }
    catch (error) {
      warn(`复制失败：${message(error)}`);
      return false;
    }
  }

  const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  /**
   * 把字节数组编码成 base64。
   * 沙箱里没有 btoa，也不能对长数组做 String.fromCharCode(...)，因此手工按 3 字节一组编码；
   * 图片走这一条路（R09/R15 的视觉输入）。
   * @param {Uint8Array|number[]} bytes
   */
  function base64FromBytes(bytes) {
    const data = bytes || [];
    let out = "";
    for (let index = 0; index < data.length; index += 3) {
      const b1 = data[index] & 0xff;
      const has2 = index + 1 < data.length;
      const has3 = index + 2 < data.length;
      const b2 = has2 ? data[index + 1] & 0xff : 0;
      const b3 = has3 ? data[index + 2] & 0xff : 0;
      out += BASE64_ALPHABET[b1 >> 2];
      out += BASE64_ALPHABET[((b1 & 3) << 4) | (b2 >> 4)];
      out += has2 ? BASE64_ALPHABET[((b2 & 15) << 2) | (b3 >> 6)] : "=";
      out += has3 ? BASE64_ALPHABET[b3 & 63] : "=";
    }
    return out;
  }

  /** 把「每字符一字节」的二进制字符串编码成 base64（Zotero.File.getBinaryContentsAsync 的输出） */
  function base64FromBinary(binary) {
    const source = String(binary == null ? "" : binary);
    const bytes = new Uint8Array(source.length);
    for (let index = 0; index < source.length; index++) bytes[index] = source.charCodeAt(index) & 0xff;
    return base64FromBytes(bytes);
  }

  return {
    log,
    warn,
    error,
    message,
    mainWindows,
    windowTools,
    truncate,
    escapeHtml,
    escapeAttr,
    mathToHtml,
    markdownToHtml,
    nowText,
    timeText,
    element,
    ensureMathStyles,
    onActivate,
    copyText,
    base64FromBytes,
    base64FromBinary,
  };
})();
