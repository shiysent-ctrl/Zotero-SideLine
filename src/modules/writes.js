/*
 * Zotero Sideline：写入记录与撤销（R11）。
 *
 * 功能：记录插件自己写入的东西（子笔记、PDF 批注、结构化总结的标签与 `总结:` 行），
 *       在界面上展示「写了什么、写到哪、什么时候」，并支持撤销最近一次。
 * 输入/输出：record/list/last/undo/canUndo/describe；记录持久化在会话 JSON 附件里（跟着会话一起同步）。
 * 依赖：modules/store.js（appendWrite/listWrites/markWriteUndone）、Zotero.Items.get。
 *
 * 设计说明：
 * 1) 只有 kind 与目标对象类型一致时才允许删除（note↔isNote、annotation↔isAnnotation），
 *    防止记录被篡改或串号时误删用户数据；
 * 2) kind 为 review（结构化总结）时的撤销是「部分回滚」：本次新增且当前仍存在的标签会被移除，
 *    Extra 还原为写入前的值；若这次是**覆盖更新**已有子笔记，笔记正文不还原（不保留旧正文副本），
 *    结果里会明确说明这一点；
 * 3) 目标条目已被用户手动删掉时，撤销退化为「只标记为已撤销」，并在结果里说明；
 * 4) 撤销只针对记录里的某一条，不做批量删除；界面默认只提供「撤销最近一次」。
 */

Sideline.writes = (function () {
  const KIND_TEXT = { note: "子笔记", annotation: "PDF 批注", review: "结构化总结" };

  function kindText(kind) {
    return KIND_TEXT[kind] || kind;
  }

  /** 记录一条写入；summary 是给用户看的一行说明，detail 供结构化总结的撤销使用 */
  async function record(itemID, entry) {
    try {
      return await Sideline.store.appendWrite(itemID, entry);
    }
    catch (error) {
      Sideline.util.warn(`写入记录失败（不影响已完成的写入）：${Sideline.util.message(error)}`);
      return null;
    }
  }

  function list(itemID, sessionId) {
    return Sideline.store.listWrites(itemID, sessionId);
  }

  async function last(itemID) {
    const entries = await list(itemID);
    return entries.find((entry) => !entry.undone) || null;
  }

  /** 目标条目类型与记录是否匹配 */
  function targetTypeOk(entry, item) {
    if (!item) return false;
    if (entry.kind === "note" || entry.kind === "review") {
      return typeof item.isNote === "function" && item.isNote();
    }
    if (entry.kind === "annotation") {
      return typeof item.isAnnotation === "function" && item.isAnnotation();
    }
    return false;
  }

  /**
   * 结构化总结的撤销上下文：标签与 Extra 在**父条目**上，子笔记是另一个对象。
   * 记录里同时存了 noteID 与 parentID，缺 parentID 时用子笔记的 parentID 兜底。
   */
  function reviewContext(entry) {
    const detail = entry.detail || {};
    const noteItem = detail.noteID ? Zotero.Items.get(detail.noteID) : null;
    const parentID = detail.parentID || (noteItem ? noteItem.parentID : 0);
    const parent = parentID ? Zotero.Items.get(parentID) : null;
    return { detail, noteItem, parent, parentID };
  }

  function canUndo(entry, item) {
    if (!entry) return { ok: false, reason: "没有可撤销的写入" };
    if (entry.undone) return { ok: false, reason: "这条写入已经撤销过" };
    if (!entry.targetID) return { ok: false, reason: "记录里没有目标条目 ID" };
    if (entry.kind === "review") {
      const context = reviewContext(entry);
      if (!context.parentID) return { ok: false, reason: "记录里没有父条目 ID，无法还原标签与 Extra" };
      if (!context.parent) return { ok: true, missing: true, reason: "父条目已不存在，撤销只会标记状态" };
      if (context.parent.deleted) return { ok: true, missing: true, reason: "父条目已在回收站，撤销只会标记状态" };
      return { ok: true };
    }
    if (!item) return { ok: true, missing: true, reason: "目标条目已不存在，撤销只会标记状态" };
    if (item.deleted) return { ok: true, missing: true, reason: "目标条目已在回收站，撤销只会标记状态" };
    if (!targetTypeOk(entry, item)) {
      return { ok: false, reason: `目标条目类型与记录不符（记录为${kindText(entry.kind)}），拒绝删除` };
    }
    return { ok: true };
  }

  /**
   * 撤销结构化总结：移除本次新增且仍存在的标签、还原 Extra、删除本次新建的子笔记。
   * 覆盖更新的子笔记不还原正文，结果里会说明。
   */
  async function undoReview(entry) {
    const { detail, noteItem, parent } = reviewContext(entry);
    if (!parent) return { ok: false, removed: false, reason: "父条目已不存在，无法还原标签与 Extra" };
    const tagsAdded = Array.isArray(detail.tagsAdded) ? detail.tagsAdded : [];
    let removedTags = [];
    const existing = typeof parent.getTags === "function" ? parent.getTags() : [];
    const folded = new Set(existing.map((value) => String((value && value.tag) || value || "").toLocaleLowerCase()));
    try {
      await Zotero.DB.executeTransaction(async () => {
        removedTags = tagsAdded.filter((tag) => folded.has(String(tag).toLocaleLowerCase()));
        for (const tag of removedTags) parent.removeTag(String(tag));
        if (typeof detail.extraBefore === "string") parent.setField("extra", detail.extraBefore);
        if (detail.noteAction === "create" && noteItem && !noteItem.deleted) {
          await noteItem.eraseTx();
        }
        await parent.saveTx();
      });
    }
    catch (error) {
      return { ok: false, removed: false, reason: `撤销失败：${Sideline.util.message(error)}` };
    }
    const parts = [`已移除 ${removedTags.length} 个新增标签`];
    if (typeof detail.extraBefore === "string") parts.push("已还原 Extra");
    if (detail.noteAction === "create") parts.push("已删除新建的子笔记");
    else if (detail.noteAction === "update") parts.push("子笔记为覆盖更新，正文未回滚（需要时请手工处理）");
    return { ok: true, removed: true, reason: parts.join("；") };
  }

  /**
   * 撤销一条写入。
   * @returns {Promise<{ok:boolean, removed:boolean, reason:string}>}
   */
  async function undo(itemID, writeId) {
    const entries = await list(itemID);
    const entry = entries.find((item) => item.id === String(writeId));
    if (!entry) return { ok: false, removed: false, reason: "找不到该写入记录" };
    const item = entry.targetID ? Zotero.Items.get(entry.targetID) : null;
    const check = canUndo(entry, item);
    if (!check.ok) return { ok: false, removed: false, reason: check.reason };
    if (check.missing) {
      await Sideline.store.markWriteUndone(itemID, entry.id);
      return { ok: true, removed: false, reason: check.reason };
    }
    if (entry.kind === "review") {
      const result = await undoReview(entry);
      if (result.ok) await Sideline.store.markWriteUndone(itemID, entry.id);
      return result;
    }
    try {
      await item.eraseTx();
    }
    catch (error) {
      return { ok: false, removed: false, reason: `删除失败：${Sideline.util.message(error)}` };
    }
    await Sideline.store.markWriteUndone(itemID, entry.id);
    Sideline.util.log(`已撤销写入 ${entry.id}（${kindText(entry.kind)} ${entry.key || entry.targetID}）`);
    return { ok: true, removed: true, reason: `已删除${kindText(entry.kind)}` };
  }

  /** 撤销最近一次未撤销的写入 */
  async function undoLast(itemID) {
    const entry = await last(itemID);
    if (!entry) return { ok: false, removed: false, reason: "没有可撤销的写入" };
    return undo(itemID, entry.id);
  }

  function describe(entry) {
    if (!entry) return "";
    const state = entry.undone ? "（已撤销）" : "";
    return `${kindText(entry.kind)}${state}｜${entry.summary || entry.key}｜${entry.time}`;
  }

  return { record, list, last, canUndo, undo, undoLast, describe, kindText };
})();
