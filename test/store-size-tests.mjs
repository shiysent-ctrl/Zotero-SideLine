/*
 * 存档字符裁剪回归：对照原逐次序列化算法，核验保留顺序、边界、返回值和数组身份。
 * 输入：源码目录与断言；输出：检查结果及整份记录序列化次数。依赖 Node fs/path/vm。
 * 私有函数仅在独立测试沙箱导出；所有记录均为合成 JSON 数据，不操作用户存档。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

function legacySize(record, limit) {
  if (JSON.stringify(record).length <= limit) return false;
  let dropped = false;
  const ordered = record.sessions.slice().sort((a, b) => (a.updated || 0) - (b.updated || 0));
  for (const session of ordered) {
    while (session.messages.length > 1 && JSON.stringify(record).length > limit) {
      session.messages.shift(); dropped = true;
    }
    if (JSON.stringify(record).length <= limit) break;
  }
  return dropped;
}

export async function runStoreSizeTests({ srcDir, check, equal }) {
  const source = fs.readFileSync(path.join(srcDir, "modules/store.js"), "utf8");
  const anchor = "    stats,\n", limitAnchor = "  const MAX_CHARS = 2000000;";
  if (source.split(anchor).length !== 2 || source.split(limitAnchor).length !== 2) throw new Error("存档裁剪测试导出锚点不唯一");
  const instantiate = (limit, stringify = JSON.stringify) => {
    const isolated = { Sideline: {}, JSON: { stringify, parse: JSON.parse } };
    vm.runInNewContext(fs.readFileSync(path.join(srcDir, "modules/storecodec.js"), "utf8"), isolated);
    vm.runInNewContext(source.replace(limitAnchor, `  const MAX_CHARS = ${limit};`)
      .replace(anchor, "    __enforceSize: enforceSize,\n" + anchor), isolated);
    return isolated.Sideline.store.__enforceSize;
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const prefix = (name) => `store-size: ${name}`;
  const compare = (record, limit, trim = instantiate(limit)) => {
    const old = clone(record), current = clone(record), arrays = current.sessions.map((s) => s.messages);
    const expected = legacySize(old, limit), actual = trim(current);
    return expected === actual && JSON.stringify(current) === JSON.stringify(old)
      && current.sessions.every((s, i) => s.messages === arrays[i]);
  };
  const tricky = { version: 3, activeId: "recent", writes: [{ id: "j", detail: { state: "pending" } }], sessions: [
    { id: "recent", updated: 20, messages: [{ content: "最近正文\\\"\n中𠮷", uiHidden: true }, { content: "最新", highlightBatch: { id: "b", undo: { removed: 2 } } }] },
    { id: "old", updated: 10, messages: [null, { content: '旧正文\t\\"'.repeat(25) }, { content: "旧会话末条" }] }
  ] };
  const full = JSON.stringify(tricky).length, outcomes = [];
  // 遍历每个整数阈值，包含恰等于上限及刚超过上限；独立沙箱只替换容量常量。
  for (let limit = 1; limit <= full + 1; limit++) outcomes.push(compare(tricky, limit));
  check(prefix("所有整数容量边界与原裁剪结果、返回值及数组身份一致"), outcomes.every(Boolean));
  const trim = instantiate(300);
  let seed = 1237;
  const random = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const symbols = ['中𠮷', '\\"\n', '\t', 'alpha', '\u0000'];
  let randomOK = true;
  for (let i = 0; i < 400; i++) {
    const record = { version: 3, activeId: "fixed", writes: [{ id: `journal-${i}`, detail: { state: "created" } }],
      sessions: Array.from({ length: random(4) }, (_, k) => ({ id: `s${k}`, updated: random(3),
        messages: Array.from({ length: random(12) }, (_, j) => ({ id: `m${j}`, content: symbols[random(symbols.length)].repeat(random(30)),
          citations: [{ pageIndex: random(5), text: '引用"\\' }], uiHidden: !!random(2) })) })) };
    randomOK = compare(record, 300, trim) && randomOK;
  }
  check(prefix("400份随机记录的旧会话排序、同时间顺序和JSON转义一致"), randomOK);
  check(prefix("无会话超限时不改写"), compare({ sessions: [], writes: [{ content: "x".repeat(500) }] }, 300, trim));
  const unshrinkable = { sessions: [{ messages: [{ content: "x".repeat(500) }] }] };
  equal(prefix("最新单条超限仍保留并返回未裁剪"), trim(unshrinkable), false);
  equal(prefix("不因超限删除会话最后一条"), unshrinkable.sessions[0].messages.length, 1);
  const sparse = { sessions: [{ messages: [undefined, , null, { content: "保留" }] }] };
  const sparseOld = { sessions: [{ messages: [undefined, , null, { content: "保留" }] }] };
  equal(prefix("空数组项按JSON的null贡献扣除"), trim(sparse), legacySize(sparseOld, 300));
  equal(prefix("空数组项不改变最终JSON"), JSON.stringify(sparse), JSON.stringify(sparseOld));
  const sparseTrim = instantiate(53);
  equal(prefix("空数组项实际被裁剪时返回值一致"), sparseTrim(sparse), legacySize(sparseOld, 53));
  equal(prefix("空数组项实际被裁剪时保留结果一致"), JSON.stringify(sparse), JSON.stringify(sparseOld));
  const big = { version: 3, sessions: [{ updated: 1, messages: Array.from({ length: 24 }, (_, i) => ({
    id: `m${i}`, content: ('中𠮷\\"\n').repeat(18000) })) }], writes: [{ id: "pending", detail: { state: "pending" } }] };
  check(prefix("真实200万字符上限与旧算法一致且保留完整写入日志"), compare(big, 2000000));
  const measured = clone(big); let fullSerializations = 0;
  const measuredTrim = instantiate(2000000, (value) => { if (value === measured) fullSerializations++; return JSON.stringify(value); });
  measuredTrim(measured);
  equal(prefix("超限裁剪仅序列化整份记录一次"), fullSerializations, 1);
  check(prefix("大量旧消息确实被裁剪"), measured.sessions[0].messages.length < big.sessions[0].messages.length
    && JSON.stringify(measured).length <= 2000000);
  console.log(`存档裁剪对照：${full + 1} 个整数边界、400 份随机记录及实际200万字符上限；整份序列化 ${fullSerializations} 次。`);
}
