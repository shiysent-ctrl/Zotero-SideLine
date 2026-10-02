/*
 * Zotero Sideline 插件入口。
 *
 * 功能：装载 modules/ 下的模块，并在 Zotero 中注册 PDF 阅读器侧栏对话、阅读器划词面板、
 *       首选项面板与本机 HTTP 端点；shutdown 时逐项注销。
 * 输入：Zotero 调用 install/startup/shutdown/uninstall，startup 的 data.rootURI 指向插件根目录。
 * 输出：全局对象 SidelineBootstrap（仅本插件作用域内可见），无返回值。
 * 依赖：Zotero 10 的 PreferencePanes、Reader、Server.Endpoints。
 *
 * 设计说明：入口只做装载与注册，任何功能实现都放在 modules/ 中，避免入口膨胀；
 *           模块通过 loadSubScript 装入同一个沙箱对象，共享 Sideline 命名空间。
 *           0.6.0 起不再注册条目面板侧栏（用户明确不需要右侧区块），因此也不再需要
 *           Fluent 资源注入——阅读器侧栏与划词面板都用普通 DOM 文本。
 */

const SIDELINE_ID = "zotero-sideline@shiys.local";
const SIDELINE_VERSION = "1.0.0";
const SIDELINE_MODULES = [
  "util",
  "diagnostics",
  "jsonfile",
  "config",
  "prompts",
  "functions",
  "materials",
  "citations",
  "context",
  "readertext",
  "highlights",
  "summary",
  "notetext",
  "inputs",
  "history",
  "excerpt",
  "client",
  "providers",
  "session",
  "notes",
  "annotations",
  "store",
  "writes",
  "proc",
  "agentinstall",
  "agentimages",
  "dshstream",
  "agentweb",
  "acp",
  "agentacp",
  "codex",
  "opencode",
  "dsh",
  "agents",
  "agentconversation",
  "prefservice",
  "readerprobe",
  "reader",
  "readerside",
  "endpoints",
];

var SidelineBootstrap = {
  rootURI: null,
  sideline: null,
  readerHandler: null,
  readerSideHandler: null,

  /**
   * 把 modules/ 下的脚本装入同一个沙箱，形成共享的 Sideline 命名空间。
   * @param {string} rootURI 插件根目录 URI，末尾带斜杠
   * @returns {object} Sideline 命名空间
   */
  load(rootURI) {
    // 只传有保证存在的宿主全局：ChromeUtils 在插件 bootstrap 沙箱里可用（Better BibTeX 同样直接用），
    // 裸 Cc/Ci/Cu 则不一定存在，需要时统一走 Components。
    const scope = {
      Sideline: {},
      Zotero,
      Services,
      Components,
      ChromeUtils,
      rootURI,
      pluginID: SIDELINE_ID,
      pluginVersion: SIDELINE_VERSION,
    };
    // KaTeX 作为插件内置依赖先装入同一沙箱；util.markdownToHtml 会在遇到
    // $...$ / $$...$$ 时调用它。离线打包可避免依赖 CDN 与 Zotero 未公开的内部 MathJax。
    Services.scriptloader.loadSubScript(`${rootURI}vendor/katex/katex.min.js`, scope, "UTF-8");
    for (const name of SIDELINE_MODULES) {
      Services.scriptloader.loadSubScript(`${rootURI}modules/${name}.js`, scope, "UTF-8");
    }
    this.rootURI = rootURI;
    this.sideline = scope.Sideline;
    return this.sideline;
  },

  async startup() {
    const sideline = this.sideline;
    Zotero.SidelinePrefs = sideline.prefservice;
    const util = sideline.util;
    const diagnostics = sideline.diagnostics;
    util.log(`启动 v${SIDELINE_VERSION}（${SIDELINE_ID}）`);
    diagnostics.record("version", {
      pluginID: SIDELINE_ID,
      pluginVersion: SIDELINE_VERSION,
      zoteroVersion: Zotero.version,
    });

    try {
      sideline.endpoints.register(SIDELINE_ID);
      diagnostics.ok("endpoints", { paths: sideline.endpoints.paths });
    }
    catch (error) {
      util.error(error);
      diagnostics.fail("endpoints", error);
    }

    try {
      await sideline.store.initialize();
      sideline.store.recordDiagnostics();
    }
    catch (error) {
      util.error(error);
      diagnostics.fail("store", error);
    }

    await Zotero.uiReadyPromise;

    if (sideline.config.bool("readerEnabled")) {
      try {
        this.readerHandler = sideline.reader.register(SIDELINE_ID);
        if (this.readerHandler) {
          diagnostics.ok("reader", { event: "renderTextSelectionPopup" });
        }
        else {
          diagnostics.fail("reader", "registerEventListener 未返回处理函数");
        }
        util.log(`PDF 划词面板注册结果：${this.readerHandler ? "成功" : "失败"}`);
      }
      catch (error) {
        util.error(error);
        diagnostics.fail("reader", error);
      }
    }
    else {
      diagnostics.record("reader", { ok: false, skipped: true, error: "首选项 readerEnabled 为假" });
    }

    // 阅读器侧栏对话（R01）：面板靠自己注入阅读器文档，注册的是工具栏事件；
    // 已打开的 PDF 在这里补挂一次，之后新开的阅读器由 renderToolbar 触发。
    if (sideline.config.bool("readerPanelEnabled")) {
      try {
        this.readerSideHandler = sideline.readerside.register(SIDELINE_ID, this.rootURI);
        const attached = sideline.readerside.attachAll();
        diagnostics.ok("readerPanel", {
          event: "renderToolbar",
          attached,
        });
        util.log(`阅读器侧栏注册结果：${this.readerSideHandler ? "成功" : "失败"}，已挂载 ${attached.length} 个阅读器`);
      }
      catch (error) {
        util.error(error);
        diagnostics.fail("readerPanel", error);
      }
    }
    else {
      diagnostics.record("readerPanel", { ok: false, skipped: true, error: "首选项 readerPanelEnabled 为假" });
    }

    try {
      await Zotero.PreferencePanes.register({
        pluginID: SIDELINE_ID,
        id: "sideline-preferences",
        src: `${this.rootURI}content/prefs-pane.xhtml`,
        label: "Sideline",
        image: `${this.rootURI}content/icons/sideline.svg`,
        scripts: [`${this.rootURI}content/prefs-pane.js`],
        stylesheets: [`${this.rootURI}content/prefs-pane.css`],
      });
      diagnostics.ok("prefsPane", { id: "sideline-preferences" });
      util.log("首选项面板注册成功");
    }
    catch (error) {
      util.error(error);
      diagnostics.fail("prefsPane", error);
    }

    diagnostics.finish();
    util.log(`启动完成，用时 ${diagnostics.snapshot().startupMs} ms`);
  },

  /**
   * 注销全部注册项，并在此之前把待写的会话存档落盘。
   * 返回 Promise：Zotero 会等待插件 shutdown 返回的 Promise，因此去抖窗口内的
   * 最后一次写入不会因为退出而丢失。
   */
  async shutdown() {
    const sideline = this.sideline;
    if (!sideline) {
      return;
    }
    try {
      sideline.providers.abort();
      await sideline.agents.drain();
      if (Zotero.SidelinePrefs === sideline.prefservice) delete Zotero.SidelinePrefs;
    }
    catch (error) {
      sideline.util.error(error);
    }
    try {
      await sideline.store.flush();
    }
    catch (error) {
      sideline.util.error(error);
    }
    try {
      sideline.endpoints.unregister();
    }
    catch (error) {
      sideline.util.error(error);
    }
    try {
      if (this.readerHandler) {
        sideline.reader.unregister(this.readerHandler);
      }
    }
    catch (error) {
      sideline.util.error(error);
    }
    try {
      if (this.readerSideHandler) {
        sideline.readerside.unregister();
      }
    }
    catch (error) {
      sideline.util.error(error);
    }
    try {
      Zotero.PreferencePanes.unregister("sideline-preferences");
    }
    catch (error) {
      sideline.util.error(error);
    }
    this.readerHandler = null;
    this.readerSideHandler = null;
    sideline.util.log("已卸载全部注册项");
  },
};

function install() {
}

async function startup(data, reason) {
  try {
    await Zotero.initializationPromise;
    const rootURI = data && data.rootURI;
    if (!rootURI) {
      throw new Error("启动参数缺少 rootURI");
    }
    SidelineBootstrap.load(rootURI);
    await SidelineBootstrap.startup();
  }
  catch (error) {
    Zotero.logError(error);
  }
}

async function shutdown() {
  try {
    await SidelineBootstrap.shutdown();
  }
  catch (error) {
    Zotero.logError(error);
  }
}

function uninstall() {
}
