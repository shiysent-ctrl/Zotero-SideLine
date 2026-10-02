/*
 * Zotero Sideline：插件数据目录与通用文件辅助。
 * 功能：统一 <Zotero 数据目录>/sideline/ 下的文件路径与文本读写，并提供文件存在检查。
 * 输入：插件自有文件名或完整路径。
 * 输出：数据目录路径、文件内容或写入结果。
 * 依赖：Zotero.DataDirectory 与 Zotero.File。
 */

Sideline.jsonfile = (function () {
  const FOLDER = "sideline";

  // Windows 的 nsIFile.initWithPath 拒绝正斜杠；在进入宿主文件接口前统一转换。
  // 不依赖运行宿主的 OS 标志，以兼容保存过的混合分隔符和测试中的 Windows 路径。
  function nativePath(path) {
    const value = String(path || "");
    return /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(value) ? value.replace(/\//g, "\\") : value;
  }

  /** @returns {string} 目录路径；不可用时返回空串 */
  function directory() {
    try {
      if (Zotero.DataDirectory && typeof Zotero.DataDirectory.getSubdirectory === "function") {
        return Zotero.DataDirectory.getSubdirectory(FOLDER, true);
      }
      if (Zotero.DataDirectory && Zotero.DataDirectory.dir) {
        return `${Zotero.DataDirectory.dir}/${FOLDER}`;
      }
    }
    catch (error) {
      Sideline.util.warn(`无法定位插件数据目录：${Sideline.util.message(error)}`);
    }
    return "";
  }

  function pathFor(name) {
    const dir = directory();
    return dir ? `${dir}/${name}` : "";
  }

  function exists(path) {
    if (!path) return false;
    try {
      return Zotero.File.pathToFile(nativePath(path)).exists();
    }
    catch (error) {
      return false;
    }
  }

  /** @returns {Promise<{path: string, text: string}|null>} 文件不存在时返回 null */
  async function read(name) {
    const path = pathFor(name);
    if (!path || !exists(path)) return null;
    const text = String(await Zotero.File.getContentsAsync(nativePath(path)) || "");
    return { path, text };
  }

  async function write(name, text) {
    const path = pathFor(name);
    if (!path) return false;
    await Zotero.File.putContentsAsync(nativePath(path), String(text));
    return true;
  }

  return { directory, pathFor, exists, read, write, nativePath };
})();
