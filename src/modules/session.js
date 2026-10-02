/*
 * Zotero Sideline：每篇文献唯一会话的内存镜像。
 * 输入：宿主条目、消息；输出：同步消息列表及恢复/持久化结果。依赖：store。
 * API 历史按 historyTurns 截取；Agent 由 agentconversation 管理原生会话和增量上下文。
 * clear 只清内存，界面/端点必须同时重置 Agent 映射并 await store.remove。
 */

Sideline.session = (function () {
  /** 宿主条目 ID → {sessionId, name, messages} */
  const mirror = new Map();

  function keyOf(itemID) {
    try {
      return Sideline.store.keyOf(itemID);
    }
    catch (error) {
      return Number(itemID);
    }
  }

  function entryOf(itemID) {
    const id = keyOf(itemID);
    if (!mirror.has(id)) mirror.set(id, { sessionId: "", name: "", messages: [] });
    return mirror.get(id);
  }

  function list(itemID) {
    return entryOf(itemID).messages;
  }

  /** 存档里记录的标题：附件条目上溯到父条目 */
  function titleOf(itemID) {
    try {
      const item = Zotero.Items.get(Number(itemID));
      if (!item) return "";
      if (item.parentID) {
        const parent = Zotero.Items.get(item.parentID);
        if (parent) return parent.getField("title") || "";
      }
      return item.getField("title") || "";
    }
    catch (error) {
      return "";
    }
  }

  function persist(itemID) {
    const entry = entryOf(itemID);
    try {
      void Sideline.store.touch(itemID, {
        title: titleOf(itemID),
        messages: entry.messages,
        sessionId: entry.sessionId,
        sessionName: entry.name,
      }).catch((error) => Sideline.util.warn(`会话存档失败：${Sideline.util.message(error)}`));
    }
    catch (error) {
      Sideline.util.warn(`会话存档失败：${Sideline.util.message(error)}`);
    }
  }

  /** 送模型的历史：按配置截取最近 N 轮（一轮 = 一问一答） */
  function history(itemID) {
    const turns = Math.max(1, Sideline.config.num("historyTurns"));
    return list(itemID)
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .slice(-turns * 2)
      .map((entry) => ({ role: entry.role, content: entry.content }));
  }

  function append(itemID, role, content, extra = {}) {
    const entry = entryOf(itemID);
    entry.messages.push(Object.assign({ role, content, time: Sideline.util.nowText() }, extra));
    persist(itemID);
    return entry.messages;
  }

  /** 用 store 返回的记录覆盖内存镜像 */
  function adopt(itemID, record) {
    const entry = entryOf(itemID);
    entry.sessionId = record && record.sessionId ? String(record.sessionId) : entry.sessionId;
    entry.name = record && record.sessionName ? String(record.sessionName) : entry.name;
    entry.messages = record && Array.isArray(record.messages)
      ? record.messages.map((message) => Object.assign({}, message))
      : [];
    return entry;
  }

  /**
   * 从附件恢复当前会话；内存里已有内容时不覆盖。
   * @returns {Promise<object|null>} 命中的记录，未命中返回 null
   */
  async function restore(itemID) {
    if (list(itemID).length) return null;
    const record = await Sideline.store.get(itemID);
    if (!record) return null;
    adopt(itemID, record);
    return record;
  }

  /** 当前会话的累计用量（R12）：调用次数、token、耗时与正文字数 */
  function totals(itemID) {
    let calls = 0;
    let tokens = 0;
    let elapsedMs = 0;
    let chars = 0;
    for (const message of list(itemID)) {
      chars += String(message.content || "").length;
      if (message.role !== "assistant") continue;
      if (message.model) calls++;
      const usage = message.usage || {};
      tokens += Number(usage.total_tokens)
        || ((Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0));
      elapsedMs += Number(message.elapsedMs) || 0;
    }
    return { calls, tokens, elapsedMs, chars };
  }

  /** 当前会话标识（未建立会话时为空串） */
  function currentSession(itemID) {
    const entry = entryOf(itemID);
    return { id: entry.sessionId, name: entry.name };
  }

  /** 用给定的消息列表替换当前会话（失败回滚等场景使用），并立即安排落盘 */
  function replace(itemID, messages) {
    const entry = entryOf(itemID);
    entry.messages = Array.isArray(messages) ? messages.map((message) => Object.assign({}, message)) : [];
    persist(itemID);
    return entry.messages;
  }

  function clear(itemID) {
    mirror.delete(keyOf(itemID));
  }

  function clearAll() {
    mirror.clear();
  }

  function count(itemID) {
    return list(itemID).length;
  }

  return {
    list,
    history,
    append,
    replace,
    restore,
    clear,
    clearAll,
    count,
    titleOf,
    totals,
    currentSession,
    keyOf,
  };
})();
