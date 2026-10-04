/*
 * Zotero Sideline：子进程调用。
 * 功能：白名单 Agent 的 Gecko 子进程传输；一次性调用与持续 stdin/逐行协议共用生命周期。
 * 依赖：resource://gre/modules/Subprocess.sys.mjs（Zotero 自身也在用，见 xpom/utilities_internal.js:30,709-726）。
 * 说明：Zotero.Utilities.Internal.subprocess 只返回 stdout、不支持 stdin 与增量读取，
 *       因此这里直接调 Subprocess.call({stdin, stdout, stderr})，由调用方决定怎么消费输出。
 */

Sideline.proc = (function () {
  let subprocessModule = null;
  let loadError = "";

  function module() {
    if (subprocessModule || loadError) return subprocessModule;
    try {
      subprocessModule = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
    }
    catch (error) {
      try {
        subprocessModule = ChromeUtils.import("resource://gre/modules/Subprocess.jsm").Subprocess;
      }
      catch (inner) {
        loadError = Sideline.util.message(error);
      }
    }
    return subprocessModule;
  }

  function available() {
    return !!module();
  }

  function unavailableReason() {
    return loadError;
  }

  /**
   * 运行一个进程并等到结束。
   * @param {string} command 可执行文件绝对路径
   * @param {string[]} args 参数
   * @param {object} [options] stdinText / onStdout / onStderr / timeoutMs
   * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, timedOut: boolean}>}
   */
  async function start(command, args, options = {}) {
    const subprocess = module();
    if (!subprocess) {
      throw new Error(`无法加载 Subprocess 模块：${loadError || "未知原因"}`);
    }
    const proc = await subprocess.call({
      command,
      arguments: args,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      environment: options.environment,
      environmentAppend: true,
      workdir: options.cwd,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const tools = Sideline.util.windowTools();

    const pump = async (stream, onChunk, sink) => {
      const decoder = typeof stream.read === "function" && tools.TextDecoder
        ? new tools.TextDecoder("utf-8") : null;
      for (;;) {
        let chunk = "";
        try {
          if (decoder) {
            const bytes = await stream.read();
            if (!bytes.byteLength) break;
            chunk = decoder.decode(bytes, { stream: true });
            // 单个 UTF-8 字符可能跨管道块；空的解码结果并不表示 EOF。
            if (!chunk) continue;
          } else chunk = await stream.readString();
        }
        catch (error) {
          break;
        }
        if (!chunk) break;
        sink(chunk);
        if (onChunk) {
          try {
            onChunk(chunk);
          }
          catch (error) {
            Sideline.util.error(error);
          }
        }
      }
    };

    const work = (async () => {
      const pumps = [
        pump(proc.stdout, options.onStdout, (text) => {
          stdout = (stdout + text).slice(-4 * 1024 * 1024);
        }),
        pump(proc.stderr, options.onStderr, (text) => {
          stderr = (stderr + text).slice(-64 * 1024);
        }),
      ];
      const [status] = await Promise.all([proc.wait(), ...pumps]);
      return status;
    })();

    const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : 0;
    let timer = null;
    if (timeoutMs && tools.setTimeout) {
      timer = tools.setTimeout(() => {
        timedOut = true;
        try {
          proc.kill(0);
        }
        catch (error) {
          Sideline.util.error(error);
        }
      }, timeoutMs);
    }

    const done = work.then((status) => ({
      exitCode: status && typeof status.exitCode === "number" ? status.exitCode : null,
      stdout, stderr, timedOut, cancelled,
    })).finally(() => {
      settled = true;
      if (timer && tools.clearTimeout) tools.clearTimeout(timer);
    });
    // 连续 write 串行化，防止并发 JSON-RPC 把两行拼成交错字节。
    let writes = Promise.resolve();
    const handle = {
      done,
      write(text) {
        writes = writes.then(() => { if (settled || cancelled || timedOut) throw new Error("进程已终止");
          return proc.stdin.write(String(text)); });
        return writes;
      },
      closeInput() { return writes.then(() => proc.stdin.close()); },
      cancel() { if (!settled && !cancelled) { cancelled = true; proc.kill(0); } },
      snapshot() { return { stdout, stderr, timedOut, cancelled }; },
    };
    if (options.onStart) {
      try { options.onStart(handle); }
      catch (error) { handle.cancel(); await done.catch(() => {}); throw error; }
    }
    return handle;
  }

  async function run(command, args, options = {}) {
    const handle = await start(command, args, options);
    try {
      if (options.stdinText !== undefined) await handle.write(options.stdinText);
      await handle.closeInput();
      return await handle.done;
    }
    catch (error) {
      handle.cancel();
      await handle.done.catch(() => {});
      throw error;
    }
  }

  return { available, unavailableReason, run, start };
})();
