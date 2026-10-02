/*
 * Zotero Sideline：启动诊断。
 * 功能：记录每个挂载点（端点、本地化注入、侧栏、划词面板、设置面板）的注册结果与失败原因，
 *       由 /sideline/status 与 /sideline/selftest 输出，便于第一次真机运行时直接定位问题。
 * 说明：只保存结构化结果与错误文本，不保存密钥；每次插件启动重置一次。
 */

Sideline.diagnostics = (function () {
  const state = {
    startedAt: Date.now(),
    startupMs: null,
    items: {},
    errors: [],
    notes: [],
  };

  function record(key, value) {
    state.items[key] = value;
    return value;
  }

  function ok(key, extra) {
    return record(key, Object.assign({ ok: true }, extra || {}));
  }

  function fail(key, cause, extra) {
    const message = cause && cause.message ? String(cause.message) : String(cause);
    state.errors.push({ key, message, at: Date.now() });
    return record(key, Object.assign({ ok: false, error: message }, extra || {}));
  }

  function note(text) {
    state.notes.push(String(text));
  }

  function finish() {
    state.startupMs = Date.now() - state.startedAt;
  }

  function snapshot() {
    return {
      startedAt: new Date(state.startedAt).toISOString(),
      startupMs: state.startupMs,
      items: Object.assign({}, state.items),
      errors: state.errors.slice(),
      notes: state.notes.slice(),
    };
  }

  return { record, ok, fail, note, finish, snapshot };
})();
