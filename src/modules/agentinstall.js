/*
 * Zotero Sideline：本地 Agent 安装识别。
 * 输入：安装目录；输出：规范化白名单启动描述或可读拒绝原因。
 * 依赖：Zotero.File、Services.env；只读固定清单与官方包装器，不执行扫描到的未知程序。
 */
Sideline.agentinstall = (function () {
  const NAMES = { codex: "Codex", opencode: "OpenCode", dsh: "DeepSeek Harness" };
  let lastScan = { candidates: 0, installs: 0, failures: [] };
  function env(name) { try { return Services.env.get(name) || ""; } catch (_) { return ""; } }
  function join(base, tail) { return Sideline.jsonfile.nativePath(`${String(base).replace(/[\\/]+$/, "")}/${tail}`); }
  function normalize(path) {
    const value = String(path || "").trim();
    if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value) || /[\x00-\x1f]/.test(value)) {
      throw new Error("请输入安装目录的绝对路径");
    }
    const file = Zotero.File.pathToFile(Sideline.jsonfile.nativePath(value));
    if (file.normalize) file.normalize();
    return String(file.path).replace(/[\\/]+$/, "");
  }
  function exists(path) { return Sideline.jsonfile.exists(path); }
  async function manifest(base, expected) {
    const path = join(base, "package.json");
    if (!exists(path)) return null;
    try { const data = JSON.parse(await Zotero.File.getContentsAsync(path));
      return data.name === expected ? data : null; } catch (_) { return null; }
  }
  function descriptor(type, path, command, args, source, version = "", environment = {}) {
    const normalized = normalize(path);
    const nativeCommand = normalize(command);
    return { id: `${type}:${normalized.replace(/\\/g, "/").toLowerCase()}`, type,
      name: NAMES[type], path: normalized, command: nativeCommand, args, source, version,
      protocol: type === "codex" ? "jsonl" : "acp", environment,
      supportsSearch: true, supportsStream: true, supportsCancel: true,
      authentication: "unknown", status: "found", models: [], lastProbe: null, error: "" };
  }
  async function validateInstall(input, source = "manual") {
    const root = normalize(input);
    if (!exists(root)) throw new Error("安装目录不存在");
    const file = Zotero.File.pathToFile(Sideline.jsonfile.nativePath(root));
    if (file.isDirectory && !file.isDirectory()) throw new Error("请填写安装目录，不能填写命令或包装器");

    const codexRoots = [root, join(root, "node_modules/@openai/codex"), join(root, "@openai/codex")];
    for (const base of codexRoots) {
      const data = await manifest(base, "@openai/codex");
      const exe = join(base, "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
      if (data && exists(exe)) return descriptor("codex", base, exe, [], source, data.version);
    }
    // 原生桌面版只接受官方目录布局；普通目录下同名 exe 不作为安装证据。
    for (const tail of ["resources/codex.exe", "app/resources/codex.exe", "bin/codex.exe"]) {
      const exe = join(root, tail);
      if (exists(exe) && (exists(join(root, "Codex.exe")) || exists(join(root, "app/Codex.exe")))) {
        return descriptor("codex", root, exe, [], source);
      }
    }
    if (exists(join(root, "codex.exe")) && /[\\/]\.codex[\\/]bin$/i.test(root)) {
      return descriptor("codex", root, join(root, "codex.exe"), [], source);
    }
    if (/[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][A-Za-z0-9_-]+$/i.test(root)
      && exists(join(root, "codex.exe")) && exists(join(root, "codex-command-runner.exe"))
      && exists(join(root, "codex-windows-sandbox-setup.exe"))) {
      return descriptor("codex", root, join(root, "codex.exe"), [], source);
    }
    for (const base of [root, join(root, "node_modules/opencode-ai"), join(root, "opencode-ai")]) {
      const data = await manifest(base, "opencode-ai");
      if (data && exists(join(base, "bin/opencode.exe"))) {
        return descriptor("opencode", base, join(base, "bin/opencode.exe"), [], source, data.version);
      }
    }
    if (exists(join(root, "OpenCode.exe")) && exists(join(root, "opencode-cli.exe"))) {
      return descriptor("opencode", root, join(root, "opencode-cli.exe"), [], source);
    }
    const wrapper = join(root, "resources/runtime/cli/bin/dsh.cmd");
    if (exists(join(root, "DeepSeek Harness.exe")) && exists(join(root, "resources/app.asar")) && exists(wrapper)) {
      const text = String(await Zotero.File.getContentsAsync(wrapper));
      // 只识别官方固定模板，不求值任何批处理语句或用户参数。
      if (!text.includes('set "ELECTRON_RUN_AS_NODE=1"')
        || !text.includes('"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals')
        || !text.includes('app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*')) {
        throw new Error("DeepSeek Harness 官方 CLI 包装器结构不匹配");
      }
      return descriptor("dsh", root, join(root, "DeepSeek Harness.exe"), ["--expose-internals",
        join(root, "resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js")],
      source, "", { ELECTRON_RUN_AS_NODE: "1" });
    }
    for (const base of [root, join(root, "node_modules/@deepseek-ai/dsh"), join(root, "@deepseek-ai/dsh")]) {
      const data = await manifest(base, "@deepseek-ai/dsh");
      const script = join(base, "lib/bin.js");
      if (!data || !exists(script) || !data.bin || data.bin.dsh !== "lib/bin.js") continue;
      const nodes = [join(env("ProgramFiles"), "nodejs/node.exe"),
        join(env("LOCALAPPDATA"), "Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe")];
      const node = nodes.find(exists);
      if (!node) throw new Error("已找到 npm DeepSeek Harness，但未找到已知 Node.js 运行时");
      return descriptor("dsh", base, node, [script], source, data.version);
    }
    throw new Error("未识别为 Codex、OpenCode 或 DeepSeek Harness 的已知安装结构");
  }
  function directories(path) {
    if (!exists(path)) return [];
    try { const entries = Zotero.File.pathToFile(Sideline.jsonfile.nativePath(path)).directoryEntries; const out = [];
      while (entries && entries.hasMoreElements() && out.length < 100) {
        const entry = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
        if (entry.isDirectory()) out.push(entry.path);
      } return out;
    } catch (_) { return []; }
  }
  function candidates() {
    const app = env("APPDATA"), local = env("LOCALAPPDATA"), home = env("USERPROFILE");
    const roots = [join(app, "npm"), join(home, ".codex/bin"),
      join(local, "Programs/Codex"), join(local, "Programs/OpenCode"),
      join(local, "Programs/DeepSeek Harness"), env("npm_config_prefix")];
    for (const path of env("PATH").split(";")) if (path) roots.push(path);
    for (const path of env("NODE_PATH").split(";")) if (path) roots.push(path);
    // Store 和版本化桌面目录只做一层有界枚举，避免全盘搜索。
    for (const parent of [join(env("ProgramFiles"), "WindowsApps"), join(local, "OpenAI"), join(local, "Codex")]) {
      for (const path of directories(parent)) if (/codex|openai/i.test(path)) roots.push(path);
    }
    roots.push(...directories(join(local, "OpenAI/Codex/bin")));
    return [...new Set(roots.filter(Boolean))];
  }
  function dedupe(records) {
    const map = new Map();
    for (const record of records) {
      const key = record.command.replace(/\\/g, "/").toLowerCase() + "|" + record.args.join("|");
      if (!map.has(key) || record.source === "manual") map.set(key, record);
    }
    return [...map.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      if (a.type === "dsh") {
        const nativeA = a.environment.ELECTRON_RUN_AS_NODE === "1";
        const nativeB = b.environment.ELECTRON_RUN_AS_NODE === "1";
        if (nativeA !== nativeB) return nativeA ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    });
  }
  async function discover() {
    const found = [];
    const roots = candidates();
    lastScan = { candidates: roots.length, installs: 0, failures: [] };
    async function inspect(path) {
      if (!exists(path)) return;
      try { found.push(await validateInstall(path, "auto")); }
      catch (error) { if (lastScan.failures.length < 24) lastScan.failures.push({ path, reason: String(error.message || error) }); }
    }
    for (const path of roots) {
      await inspect(path);
      for (const tail of ["node_modules/@openai/codex", "node_modules/opencode-ai", "node_modules/@deepseek-ai/dsh"]) {
        await inspect(join(path, tail));
      }
    }
    const result = dedupe(found); lastScan.installs = result.length; return result;
  }
  return { env, join, normalize, validateInstall, discover, dedupe, candidates, NAMES, scanReport: () => lastScan };
})();
