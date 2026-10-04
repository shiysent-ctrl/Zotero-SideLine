/*
 * Zotero Sideline：写入记录与撤销（R11）。
 *
 * 功能：记录插件自己写入的东西（子笔记、PDF 批注、结构化总结的标签与 `总结:` 行），
 *       记录归属与快照，支持单项、最近一次及按回复绑定批次撤销。
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
 * 4) 自动高亮先登记日志，再保存批注；按消息绑定的 batchId 撤销，保护手动编辑。
 */

Sideline.writes = (function () {
  const KIND_TEXT = { note: "子笔记", annotation: "PDF 批注", review: "结构化总结" };
  const activeBatches = new Set();

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  }

  /** 比较所有批注可编辑内容；保存原始快照，不仅比较时刻或文本。 */
  function annotationSnapshot(value, fromJSON = false) {
    const get = (name) => fromJSON ? value[name] : value[`annotation${name[0].toUpperCase()}${name.slice(1)}`];
    let position = get("position");
    if (typeof position === "string") position = JSON.parse(position);
    if (!position) throw new Error("无法读取批注位置，保留批注");
    const norm = (text) => String(text == null ? "" : text);
    const tags = fromJSON ? (value.tags || []) : typeof value.getTags === "function" ? value.getTags() : [];
    return JSON.stringify(canonical({ type: get("type"), text: norm(get("text")), comment: norm(get("comment")),
      color: norm(get("color")), pageLabel: norm(get("pageLabel")), sortIndex: norm(get("sortIndex")),
      position, authorName: norm(get("authorName")), tags: tags.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      dateModified: !fromJSON && typeof value.getField === "function" ? norm(value.getField("dateModified")) : "",
      relations: !fromJSON && typeof value.getRelations === "function" ? value.getRelations() : (value.relations || {}) }));
  }

  function batchIdentity(entry, item) {
    const detail = entry.detail || {};
    if (detail.state !== "created" || !detail.snapshot) return { ok: false, reason: "创建记录未完成，保留批注" };
    const attachment = item.parentItem || Zotero.Items.get(item.parentID || item.parentItemID);
    if (!targetTypeOk(entry, item) || item.libraryID !== detail.libraryID || item.key !== entry.key
      || !attachment || attachment.key !== detail.attachmentKey || attachment.libraryID !== detail.libraryID) {
      return { ok: false, reason: "批注身份或附件归属不符，保留批注" };
    }
    if (annotationSnapshot(item) !== detail.snapshot) return { ok: false, edited: true, reason: "批注已编辑，保留批注" };
    return { ok: true };
  }

  async function journalAnnotation(ownerID, attachment, batchId, json) {
    const entry = await Sideline.store.appendWrite(ownerID, { kind: "annotation", key: json.key,
      summary: `批注（第 ${json.pageLabel} 页）：${json.text.slice(0, 40)}`, detail: {
        batchId, libraryID: attachment.libraryID, attachmentKey: attachment.key,
        state: "pending", snapshot: annotationSnapshot(json, true) } });
    if (!entry || !entry.detail || !entry.detail.snapshot || !(await Sideline.store.flushItem(ownerID))) {
      throw new Error(`本批次记录未能保存，未创建批注：${Sideline.store.saveError(ownerID) || "创建记录不完整"}`);
    }
    return entry;
  }

  /** 精确按批次与附件键处理较早回复，不根据页码、颜色或最近写入删除。 */
  async function undoBatch(ownerID, batch) {
    const lock = `${ownerID}:${batch.id}`;
    if (activeBatches.has(lock)) throw new Error("本批次正在撤销");
    activeBatches.add(lock);
    const result = { removed: 0, edited: 0, missing: 0, failed: 0, errors: [] };
    try {
      const entries = (await list(ownerID)).filter((entry) => entry.kind === "annotation"
        && entry.detail && entry.detail.batchId === batch.id && !entry.undone && entry.detail.state !== "failed");
      for (const entry of entries) {
        const detail = entry.detail;
        try {
          if (!detail.snapshot || detail.libraryID !== batch.libraryID || detail.attachmentKey !== batch.attachmentKey) throw new Error("批次归属不符");
          const item = Zotero.Items.getByLibraryAndKey(detail.libraryID, entry.key);
          if (!item || item.deleted) {
            // pending 可能尚未创建；没有对象时不能把一次写入尝试计成已创建后丢失。
            if (detail.state === "created") result.missing++;
            await Sideline.store.markWriteUndone(ownerID, entry.id); continue;
          }
          const identity = batchIdentity(entry, item);
          if (identity.edited) { result.edited++; continue; }
          if (!identity.ok) throw new Error(identity.reason);
          await item.eraseTx();
          result.removed++;
          await Sideline.store.markWriteUndone(ownerID, entry.id);
        } catch (error) {
          result.failed++; result.errors.push(Sideline.util.message(error).slice(0, 500));
          Sideline.util.log(`批次撤销未完成：${Sideline.util.message(error)}`);
        }
      }
      if (!(await Sideline.store.flushItem(ownerID))) { result.failed++; result.errors.push("撤销记录未能保存，重开后可能需要重新核验"); }
      return result;
    } finally { activeBatches.delete(lock); }
  }

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
    if (entry.detail && entry.detail.batchId) return batchIdentity(entry, item);
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

  return { record, list, last, canUndo, undo, undoLast, describe, kindText,
    annotationSnapshot, journalAnnotation, undoBatch };
})();
