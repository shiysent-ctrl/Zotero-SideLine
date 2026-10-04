/*
 * Zotero Sideline：PDF 批注写入。
 * 功能：把阅读器划词与模型回答写回为 PDF 高亮批注（高亮文本为选区原文，评论为回答）。
 * 输入：attachment（PDF 附件条目）、annotation（阅读器 renderTextSelectionPopup 给的选区对象）、
 *       comment（评论正文）、color（可选颜色）。
 * 输出：新建的 annotation 条目。
 * 依据：选区对象由阅读器 getAnnotationFromRange 产出，形如
 *       {type, color, sortIndex, pageLabel, position:{pageIndex, rects}, text}；
 *       保存还需要有效颜色与 sortIndex；自动高亮的排序来自 readertext 字符几何。
 * 边界：只新增批注，不修改既有条目、标签或附件；坐标缺失时拒绝写入并给出原因，
 *       调用方应退回「保存为笔记」。
 */

Sideline.annotations = (function () {
  const DEFAULT_COLOR = "#ffd400";

  /** 取可用坐标：必须有 pageIndex 与至少一个 rect */
  function positionOf(annotation) {
    const position = annotation && annotation.position;
    if (!position || !Array.isArray(position.rects) || !position.rects.length) return null;
    if (!Number.isSafeInteger(position.pageIndex) || position.pageIndex < 0) return null;
    if (!position.rects.every((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
      && r[0] < r[2] && r[1] < r[3])) return null;
    return position;
  }

  /** 判断选区能否写回批注 */
  function canWrite(annotation) {
    if (!annotation || !annotation.text) {
      return { ok: false, reason: "选区没有文字" };
    }
    if (!positionOf(annotation)) {
      return { ok: false, reason: "选区没有可用坐标（position.rects/pageIndex），无法写回批注" };
    }
    return { ok: true };
  }

  /** 组装 saveFromJSON 需要的 JSON；key 必须由调用方生成 */
  function buildJSON(annotation, comment, color) {
    const position = positionOf(annotation);
    if (!position) throw new Error("选区没有可用坐标，无法组装批注");
    return {
      key: Zotero.DataObjectUtilities.generateKey(),
      type: annotation.type || "highlight",
      color: color || annotation.color || DEFAULT_COLOR,
      comment: String(comment == null ? "" : comment),
      text: annotation.text,
      pageLabel: annotation.pageLabel || "",
      sortIndex: annotation.sortIndex || "",
      position,
    };
  }

  /**
   * 新建一条高亮批注。
   * @returns {Promise<Zotero.Item>} 新建的批注条目
   */
  async function saveHighlightComment({ attachment, annotation, comment, color }) {
    if (!attachment || !attachment.libraryID) {
      throw new Error("找不到可写入批注的 PDF 附件");
    }
    const check = canWrite(annotation);
    if (!check.ok) throw new Error(check.reason);
    const json = buildJSON(annotation, comment, color);
    return saveJSON(attachment, json);
  }

  /** 只保存插件新生成的批注键；先登记日志的自动高亮与划词共用宿主校验。 */
  async function saveJSON(attachment, json) {
    if (!attachment || !attachment.libraryID) throw new Error("找不到可写入批注的 PDF 附件");
    if (!json || !json.key || !canWrite(json).ok) throw new Error("批注原文、键或坐标无效");
    if (!positionOf(json)) throw new Error("批注坐标无效");
    if (!/^\d{5}\|\d{6}\|\d{5}$/.test(json.sortIndex || "")) throw new Error("批注排序字段无效");
    if (!/^#[0-9a-f]{6}$/i.test(json.color || "")) throw new Error("批注颜色无效");
    if (attachment.library && attachment.library.editable === false) throw new Error("目标文献库不可写");
    if (typeof attachment.isPDFAttachment === "function" && !attachment.isPDFAttachment()) throw new Error("目标附件不是 PDF");
    if (Zotero.Items.getByLibraryAndKey && Zotero.Items.getByLibraryAndKey(attachment.libraryID, json.key)) throw new Error("批注键已经存在，拒绝覆盖");
    const item = await Zotero.Annotations.saveFromJSON(attachment, json, { skipSelect: true });
    Sideline.util.log(`已写入批注 ${item && item.key ? item.key : "?"}（附件 ${attachment.key}）`);
    return item;
  }

  return { canWrite, buildJSON, saveHighlightComment, saveJSON, positionOf, DEFAULT_COLOR };
})();
