/* 会话附件写入回归：模拟 Windows 严格路径解析、原生 nsIFile 与写入失败，不访问实际文件。 */
export async function runStoreWriteTests({ Sideline: s, Zotero: z, calls, check, equal, makeRegularItem }) {
  const getTempBefore = z.getTempDirectory, putBefore = z.File.putContentsAsync;
  const name = (value) => `store-write: ${value}`;
  let cloned = 0;
  const paths = [];
  z.File.putContentsAsync = async (path, text) => {
    if (/^(?:[A-Za-z]:\\|\\\\)/.test(path) && path.includes("/")) throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH: mixed separators");
    paths.push(path); return putBefore(path, text);
  };
  try {
    for (const [offset, dir] of [[0, "C:\\SidelineTemp\\Zotero"], [1, "\\\\server\\temp\\Zotero"], [2, "/tmp/zotero"]]) {
      const owner = makeRegularItem({ id: 42000 + offset, fields: { title: "路径测试" } });
      z.getTempDirectory = () => ({ path: dir });
      await s.store.touch(owner.id, { messages: [{ role: "user", content: "测试消息" }] });
      const saved = await s.store.flushItem(owner.id);
      check(name(`${offset}: 首次会话文件可以保存`), saved);
      const expected = dir + (dir.includes("\\") ? "\\" : "/") + `sideline-sessions-${owner.id}.json`;
      check(name(`${offset}: 导入路径符合宿主分隔符`), calls.importedAttachments.some((entry) => entry.options.file === expected));
    }
    const temp = { path: "C:\\原生临时目录\\Zotero", clone: () => {
      cloned++; return { path: temp.path, append(value) { this.path += "\\" + value; } };
    } };
    z.getTempDirectory = () => temp;
    const owner = makeRegularItem({ id: 42003, fields: { title: "原生路径测试" } });
    await s.store.touch(owner.id, { messages: [{ role: "user", content: "中文路径" }] });
    check(name("原生临时文件以 clone/append 组装并保存"), await s.store.flushItem(owner.id));
    equal(name("不改变 Zotero 自己的临时目录对象"), temp.path, "C:\\原生临时目录\\Zotero");
    equal(name("实际使用原生路径接口"), cloned, 1);
    if (typeof s.store.prepareWrite !== "function") { check(name("模型前持久化预检入口存在"), false); return; }
    const emptyOwner = makeRegularItem({ id: 42004, fields: { title: "空会话预检" } });
    const importedBefore = calls.importedAttachments.length;
    await s.store.prepareWrite(emptyOwner.id);
    equal(name("首次预检建立唯一插件附件"), calls.importedAttachments.length, importedBefore + 1);
    await s.store.prepareWrite(emptyOwner.id);
    equal(name("重复预检复用附件"), calls.importedAttachments.length, importedBefore + 1);
    equal(name("预检不伪造模型消息"), s.session.list(emptyOwner.id).length, 0);
    s.session.append(owner.id, "assistant", "原始回答");
    const answer = s.session.list(owner.id).at(-1), raw = JSON.stringify(s.session.history(owner.id));
    z.File.putContentsAsync = async () => { throw new Error("EACCES: test write denied"); };
    try { await s.store.prepareWrite(owner.id); check(name("写入失败预检拒绝继续"), false); }
    catch (error) { check(name("预检报告实际写入异常"), error.message.includes("EACCES")); }
    try { await s.session.updateDisplay(owner.id, answer.id, { uiHidden: true }); check(name("保存异常不被吞掉"), false); }
    catch (error) { check(name("界面提示包含底层原因"), error.message.includes("EACCES")); }
    equal(name("显示保存失败仍不改模型历史"), JSON.stringify(s.session.history(owner.id)), raw);
    z.File.putContentsAsync = putBefore;
    await s.store.prepareWrite(emptyOwner.id);
    check(name("另一篇保存成功不能抹掉本篇失败原因"), s.store.saveError(owner.id).includes("EACCES"));
    await s.store.prepareWrite(owner.id);
    equal(name("本篇重试成功清除失败状态"), s.store.saveError(owner.id), "");
  } finally { z.getTempDirectory = getTempBefore; z.File.putContentsAsync = putBefore; }
}
