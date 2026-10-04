/*
 * Sideline 侧栏回复操作。
 * 输入：具体回复、阅读器状态和 readerside 的面板/请求控制回调；输出：回复菜单及编辑、保存、撤销反馈。
 * 依赖：session、store、writes、excerpt、highlights；普通隐藏只改显示，高亮撤销使用消息绑定批次。
 * create 注入控制职责，保留 readerside 原入口、菜单布局、写入记录和 Agent/API 会话语义。
 */
Sideline.readerreplies = (function () {
  function create({ setPendingFunction, setStatus, setBusy, renderMessages, send,
    openMenu, openHighlightPanel, ownerItem }) {
    /** 每条回答的「⋯」：把原来的一排按钮收进菜单 */
    function editQuestion(state, message) {
      const list = Sideline.session.list(state.ownerID);
      let answerIndex = list.indexOf(message);
      if (answerIndex < 0) {
        answerIndex = list.findIndex((entry) => entry.role === "assistant"
          && entry.time === message.time && entry.content === message.content);
      }
      let userIndex = answerIndex - 1;
      while (userIndex >= 0 && list[userIndex].role !== "user") userIndex--;
      if (userIndex < 0) {
        setStatus(state, "没有找到这条回答对应的原问题", true);
        return;
      }
      const user = list[userIndex];
      state.editing = { from: userIndex };
      state.els.textarea.value = user.question === undefined ? String(user.content || "") : String(user.question || "");
      setPendingFunction(state, message.functionId || user.functionId || "");
      setStatus(state, "正在修改原问题；重新发送后会替换该问答及其后的分支", false, {
        label: "取消修改",
        run: () => {
          state.editing = null;
          setPendingFunction(state, "");
          setStatus(state, "已取消修改，原对话保持不变", false);
        },
      });
      try {
        state.els.textarea.focus();
        const end = state.els.textarea.value.length;
        if (typeof state.els.textarea.setSelectionRange === "function") {
          state.els.textarea.setSelectionRange(end, end);
        }
      }
      catch (error) {
        // 聚焦失败不影响编辑状态
      }
    }

    function openAnswerMenu(state, message, node, anchor) {
      const items = [];
      if (message.functionId !== "highlight" && Sideline.highlights.looksLikeCandidates(message.content)) {
        items.push({ label: "预览并标记重点", run: () => void openHighlightPanel(state, message, node.wrapper) });
      }
      if (state.lastRequest) {
        items.push({
          label: "重试上一次",
          disabled: state.busy || !!(state.lastRequest.functionId === "highlight"
            && (!state.highlightRetry || !state.highlightRetry.jobs.length)),
          run: () => void send(state, Object.assign({}, state.lastRequest, { retry: true })),
        });
      }
      items.push({
        label: "修改提问",
        disabled: message.functionId === "highlight",
        detail: message.functionId === "highlight" ? "高亮批次请撤销后重新执行" : "重发后替换原问答",
        run: () => editQuestion(state, message),
      });
      items.push({ separator: true });
      items.push({ label: "保存为子笔记", disabled: state.busy || state.resetting,
        detail: "将此回答及对应提问保存为新子笔记",
        run: () => void saveReplyToNote(state, message) });
      const batch = message.highlightBatch;
      items.push({ label: "撤销此回复", disabled: state.busy || state.resetting
        || !!(batch && batch.undo && !batch.undo.failed),
        detail: batch ? "撤销本次新增批注，保留已编辑批注" : "仅从界面移除这条回答",
        run: () => void undoReply(state, message) });
      items.push({
        label: "复制回答",
        run: () => setStatus(state, Sideline.util.copyText(message.functionId === "highlight"
          ? Sideline.highlights.receipt(batch) : message.content) ? "已复制回答" : "复制失败", false),
      });
      openMenu(state, items, { placement: "anchor", anchor });
    }

    async function undoReply(state, message) {
      if (state.busy || state.resetting) return;
      state.undoing = true;
      setBusy(state, true);
      try {
        if (message.highlightBatch) {
          const batch = message.highlightBatch;
          const result = await Sideline.writes.undoBatch(state.ownerID, batch);
          const before = batch.undo || {};
          batch.undo = Object.assign({}, result, { removed: (before.removed || 0) + result.removed,
            missing: (before.missing || 0) + result.missing });
          await Sideline.session.updateDisplay(state.ownerID, message.id, { highlightBatch: batch });
          setStatus(state, "撤销结果已显示在对应回复中", result.failed > 0);
        } else {
          await Sideline.session.updateDisplay(state.ownerID, message.id, { uiHidden: true });
          setStatus(state, `已从界面移除回答${Sideline.config.bool("persistSessions") ? "" : "（未启用会话保存）"}`, false);
        }
      } catch (error) { setStatus(state, `撤销失败：${Sideline.util.message(error)}`, true); }
      finally { state.undoing = false; setBusy(state, false); renderMessages(state); }
    }

    /**
     * 菜单绑定具体回复，保存该回复及其对应提问；复用 excerpt，新建子笔记并登记写入。
     * 高亮只保存用户可见回执，不把内部候选 JSON 放入笔记，也不修改模型会话历史。
     */
    async function saveReplyToNote(state, message) {
      if (state.busy || state.resetting) return;
      const item = ownerItem(state);
      if (!item) {
        setStatus(state, "找不到目标条目，无法写入子笔记", true);
        return;
      }
      const list = Sideline.session.list(state.ownerID);
      const index = list.findIndex((entry) => entry === message || (message.id && entry.id === message.id));
      const reply = list[index];
      if (!reply || reply.role !== "assistant" || reply.uiHidden) {
        setStatus(state, "这条回答已经不在当前界面里", true);
        return;
      }
      const picked = [];
      const previous = list[index - 1];
      if (previous && previous.role === "user") picked.push(previous);
      picked.push(reply.functionId === "highlight"
        ? Object.assign({}, reply, { content: Sideline.highlights.receipt(reply.highlightBatch) }) : reply);
      const attachment = Zotero.Items.get(state.attachmentID);
      let planned = null;
      try {
        planned = Sideline.excerpt.plan({
          item,
          messages: picked,
          itemKey: item.key,
          attachmentKey: attachment ? attachment.key : "",
          itemTitle: String((item.getField && item.getField("title")) || ""),
        });
      }
      catch (error) {
        setStatus(state, `无法写入子笔记：${Sideline.util.message(error)}`, true);
        return;
      }
      state.savingReply = true;
      setBusy(state, true);
      try {
        setStatus(state, `正在写入子笔记（${planned.blockCount} 段对话）…`, false);
        const result = await Sideline.excerpt.commit({ item, plan: planned });
        await Sideline.writes.record(state.ownerID, {
          kind: "note",
          targetID: result.noteID,
          key: result.noteKey,
          summary: `回复保存为子笔记：${result.title}`,
        });

        setStatus(state, `已把 ${planned.blockCount} 段对话写入子笔记 ${result.noteKey}`, false);
      }
      catch (error) {
        setStatus(state, `写入子笔记失败：${Sideline.util.message(error)}`, true);
      }
      finally { state.savingReply = false; setBusy(state, false); }
    }

    return { openAnswerMenu };
  }
  return { create };
})();
