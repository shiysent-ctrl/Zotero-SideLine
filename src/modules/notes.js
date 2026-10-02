/*
 * Zotero Sideline：写入 Zotero。
 * 功能：把问答或任意文本保存为目标的子笔记（Zotero 原生 note 条目）。
 * 说明：只新增笔记，不修改原条目字段、标签或附件；附件条目统一挂到其父条目下。
 */

Sideline.notes = (function () {
  function buildHtml({ heading, question, answer, model, source }) {
    const blocks = [`<h1>${Sideline.util.escapeHtml(heading)}</h1>`];
    if (source) {
      blocks.push(`<p><b>来源</b>：${Sideline.util.escapeHtml(source)}</p>`);
    }
    if (question) {
      blocks.push(`<h2>问题</h2>\n<p>${Sideline.util.escapeHtml(question)}</p>`);
    }
    blocks.push(`<h2>回答</h2>\n${Sideline.util.markdownToHtml(answer)}`);
    blocks.push(`<p><i>模型：${Sideline.util.escapeHtml(model || Sideline.config.str("model"))}`
      + `　生成时间：${Sideline.util.escapeHtml(Sideline.util.nowText())}</i></p>`);
    return blocks.join("\n");
  }

  /**
   * 保存为子笔记。
   * @param {object} options item 目标条目；question/answer 内容；source 可选来源标注
   * @returns {Promise<Zotero.Item>} 新建的笔记条目
   */
  async function saveAnswer({ item, question, answer, model, source }) {
    const parent = Sideline.context.regularItem(item);
    if (!parent) throw new Error("找不到可挂载笔记的父条目");
    const note = new Zotero.Item("note");
    note.libraryID = parent.libraryID;
    note.parentID = parent.id;
    note.setNote(buildHtml({
      heading: Sideline.config.str("noteHeading"),
      question,
      answer,
      model,
      source,
    }));
    await note.saveTx();
    Sideline.util.log(`已保存子笔记 ${note.key}（父条目 ${parent.key}）`);
    return note;
  }

  return { saveAnswer };
})();
