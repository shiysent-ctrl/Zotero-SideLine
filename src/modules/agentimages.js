/*
 * Agent 图片传输：把插件图片材料转成 ACP 块，或 Codex 所需的临时图片文件。
 * 输入：base64 data URL、插件工作目录；输出：图片块/自有临时路径及清理函数。
 * 依赖：Zotero.File、util、jsonfile；不下载 URL，不读取任意用户文件。
 */
Sideline.agentimages = (function () {
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
  function parse(url) {
    const match = String(url).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length % 4 !== 0) throw new Error("Agent 图片必须是 PNG、JPEG、WebP 或 GIF 的有效 base64 材料");
    return { type: "image", mimeType: match[1], data: match[2] };
  }
  function blocks(images = []) { return images.map(parse); }
  async function challenge() {
    // 插件自带的合成图及答案；答案只用于本地核验，不放进发送给模型的文字中。
    return JSON.parse(await Zotero.File.getResourceAsync(`${rootURI}content/vision-test.json`));
  }
  function recognized(answer, expected) {
    return String(answer).includes(expected.digits) && /红/.test(answer) && /圆/.test(answer)
      && /蓝/.test(answer) && /矩形|长方形/.test(answer);
  }
  function bytes(data) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const out = new Uint8Array(data.length / 4 * 3 - padding);
    let cursor = 0;
    for (let i = 0; i < data.length; i += 4) {
      const value = (alphabet.indexOf(data[i]) << 18) | (alphabet.indexOf(data[i + 1]) << 12)
        | (Math.max(0, alphabet.indexOf(data[i + 2])) << 6) | Math.max(0, alphabet.indexOf(data[i + 3]));
      for (const shift of [16, 8, 0]) if (cursor < out.length) out[cursor++] = (value >> shift) & 255;
    }
    return out;
  }
  async function files(images, cwd) {
    const paths = [], parsed = blocks(images);
    const BlobClass = typeof Blob !== "undefined" ? Blob : Zotero.getMainWindow()?.Blob;
    if (parsed.length && !BlobClass) throw new Error("宿主无法写入 Agent 临时图片");
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cleanup = () => {
      for (const path of paths) {
        try {
          const file = Zotero.File.pathToFile(path);
          if (file.exists()) {
            if (file.isSymlink && file.isSymlink()) throw new Error("拒绝清理符号链接图片");
            file.remove(false);
          }
        } catch (error) { Sideline.util.warn(`Agent 临时图片清理失败：${error.message}`); }
      }
    };
    try {
      for (let i = 0; i < parsed.length; i++) {
        const block = parsed[i];
        const path = Sideline.agentinstall.join(cwd, `sideline-image-${token}-${i}.${extensions[block.mimeType]}`);
        paths.push(path);
        // Zotero 10 的 putContentsAsync 支持 Blob，避免把二进制图片按 UTF-8 写坏。
        await Zotero.File.putContentsAsync(path, new BlobClass([bytes(block.data)], { type: block.mimeType }));
      }
      return { paths, cleanup };
    } catch (error) { cleanup(); throw error; }
  }
  return { parse, blocks, files, challenge, recognized };
})();
