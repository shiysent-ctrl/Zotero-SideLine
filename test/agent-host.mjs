/*
 * Agent 测试宿主：把真实 src 模块载入 Node vm，用文件/进程桥替代 Gecko。
 * 输入：固定项目目录与注入的文件/进程桩；输出：测试沙箱。仅供测试，不进入 XPI。
 * 真实模式的文件读取明确拒绝凭据内容，原生进程保持 windowsHide。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class Pipe {
  constructor() { this.queue = []; this.waiters = []; this.ended = false; }
  push(text) { if (this.waiters.length) this.waiters.shift()(text); else this.queue.push(text); }
  end() { this.ended = true; while (this.waiters.length) this.waiters.shift()(""); }
  readString() { if (this.queue.length) return Promise.resolve(this.queue.shift());
    return this.ended ? Promise.resolve("") : new Promise((resolve) => this.waiters.push(resolve)); }
}
function nativePipe(stream) {
  const pipe = new Pipe(), decoder = new StringDecoder("utf8");
  stream.on("data", (data) => pipe.push(data));
  stream.on("end", () => pipe.end());
  return {
    async read() {
      const bytes = await pipe.readString();
      return bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0);
    },
    async readString() {
      for (;;) {
        const bytes = await pipe.readString();
        if (!bytes) return decoder.end();
        const text = decoder.write(bytes);
        if (text) return text;
      }
    },
  };
}
export const nativeSubprocess = {
  async call(options) {
    const child = spawn(options.command, options.arguments, { cwd: options.workdir || undefined,
      env: Object.assign({}, process.env, options.environment || {}), windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const done = new Promise((resolve) => child.once("exit", (code) => resolve({ exitCode: code })));
    return { stdout: nativePipe(child.stdout), stderr: nativePipe(child.stderr),
      stdin: { write: (text) => new Promise((resolve, reject) => child.stdin.write(text, (error) => error ? reject(error) : resolve())),
        close: () => { child.stdin.end(); } }, wait: () => done, kill: () => child.kill() };
  },
};
export function createHost(projectRoot, options = {}) {
  const normalize = options.normalize || ((value) => path.resolve(value));
  const exists = options.exists || fs.existsSync;
  const read = options.read || ((file) => {
    if (/(?:^|[\\/])(?:auth\.json|credentials?(?:\..*)?)$/i.test(file)) throw new Error("测试宿主禁止读取凭据内容");
    return fs.readFileSync(file, "utf8");
  });
  const prefs = {}, userKeys = new Set(), env = options.env || process.env;
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, "src/prefs.js"), "utf8"), { pref: (key, value) => { prefs[key] = value; } });
  function file(value) {
    if (options.strictWindowsPaths && /^[A-Za-z]:/.test(value) && value.includes("/")) throw new Error(`Unexpected path value '${value}'`);
    const item = { path: normalize(value), exists: () => exists(normalize(value)),
      normalize() { this.path = normalize(this.path); }, isDirectory: () => options.isDirectory ? options.isDirectory(item.path) : fs.statSync(item.path).isDirectory(),
      isSymlink: () => options.exists ? false : fs.lstatSync(item.path).isSymbolicLink(),
      remove(recursive) {
        if (options.remove) return options.remove(item.path, recursive);
        const target = path.resolve(item.path);
        const data = path.resolve(options.dataDirectory || path.join(process.env.TEMP || "/tmp", "sideline-agent-test"));
        const codex = path.resolve(env.USERPROFILE || "", ".codex", "sessions");
        const ownData = target.startsWith(data + path.sep);
        const ownRollout = !recursive && target.startsWith(codex + path.sep)
          && /-[0-9a-f-]{36}\.jsonl$/i.test(target);
        if (!ownData && !ownRollout) throw new Error("测试宿主拒绝越界删除");
        fs.rmSync(target, { recursive: !!recursive, force: true });
      } };
    Object.defineProperty(item, "directoryEntries", { get() {
      const entries = options.directories ? options.directories(item.path) : fs.readdirSync(item.path).map((name) => path.join(item.path, name));
      let i = 0; return { hasMoreElements: () => i < entries.length,
        getNext: () => { const entry = file(entries[i++]); entry.QueryInterface = () => entry; return entry; } };
    } }); return item;
  }
  const Zotero = { Prefs: { get: (key) => prefs[`extensions.zotero.${key}`],
    set: (key, value) => { const full = `extensions.zotero.${key}`; prefs[full] = value; userKeys.add(full); } },
    DataDirectory: { dir: options.dataDirectory || path.join(process.env.TEMP || "/tmp", "sideline-agent-test"),
      getSubdirectory: () => options.dataDirectory || path.join(process.env.TEMP || "/tmp", "sideline-agent-test") },
    File: { pathToFile: file, getContentsAsync: async (file) => read(file),
      getResourceAsync: async (file) => fs.readFileSync(file, "utf8"),
      putContentsAsync: async (file, text) => { const data = typeof text === "string" ? text : Buffer.from(await text.arrayBuffer());
        if (options.write) options.write(file, data); else fs.writeFileSync(file, data); },
      createDirectoryIfMissingAsync: async (dir) => { if (options.mkdir) options.mkdir(dir); else fs.mkdirSync(dir, { recursive: true }); } },
    getMainWindows: () => [globalThis], getMainWindow: () => globalThis,
    debug: () => {}, logError: () => {}, HTTP: { request: options.http || (() => { throw new Error("测试中没有配置 HTTP 桩"); }) } };
  const context = vm.createContext({ Sideline: {}, Zotero, Components: { interfaces: { nsIFile: {} } },
    Services: { env: { get: (key) => env[key] || "" }, prefs: { prefHasUserValue: (key) => userKeys.has(key) } },
    ChromeUtils: { importESModule: () => ({ Subprocess: options.subprocess || nativeSubprocess }) },
    rootURI: path.join(projectRoot, "src") + path.sep, pluginID: "test", pluginVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, "src/manifest.json"), "utf8")).version, console });
  for (const name of ["util", "jsonfile", "config", "modelrequest", "storecodec", "client", "proc", "agentinstall", "agentimages", "dshstream", "agentweb", "acp", "agentacp", "codex", "opencode", "dsh", "agents", "agentconversation", "providers", "prefservice"]) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, `src/modules/${name}.js`), "utf8"), context, { filename: name });
  }
  return { Sideline: context.Sideline, Zotero, context, prefs, userKeys };
}
