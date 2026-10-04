/*
 * 正文评分优化回归：用完整编辑距离作独立参照，验证候选阈值与带状计算的等价性。
 * 输入：源码目录和宿主断言；输出：检查结果及合成样本计算次数。依赖 Node fs/path/vm。
 * 直接测试纯数据模块，不改写源码以导出私有函数，不读用户 PDF 或调用模型。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// 保留优化前的完整两行矩阵，作为独立参照；候选过滤下限沿用原浮点表达式。
function legacyScore(a, b) {
  const length = Math.max(a.length, b.length);
  if (!length || Math.min(a.length, b.length) / length < 0.8 - 0.1) return 0;
  let previous = new Uint16Array(b.length + 1), current = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(
      previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [previous, current] = [current, previous];
  }
  return 1 - previous[b.length] / length;
}

export async function runProseScoreTests({ srcDir, check, equal }) {
  const source = fs.readFileSync(path.join(srcDir, "modules/prosematch.js"), "utf8");
  let cells = 0;
  const measuredMath = Object.create(Math);
  measuredMath.min = (...args) => { if (args.length === 3) cells++; return Math.min(...args); };
  const isolated = { Sideline: {}, Math: measuredMath };
  vm.runInNewContext(source, isolated);
  const score = isolated.Sideline.prosematch.score;
  const equivalent = (a, b) => {
    const expected = legacyScore(a, b), actual = score(a, b);
    // 下限以下不会进入排序；剪枝返回零可接受，下限及以上必须保留原浮点评分。
    return actual === expected || (expected < 0.8 - 0.1 && actual === 0);
  };
  const verify = (name, pairs) => {
    const failure = pairs.find(([a, b]) => !equivalent(a, b));
    check(`prose-score: ${name}`, !failure, failure ? JSON.stringify(failure) : "");
  };
  let words = [""], layer = [""];
  for (let n = 1; n <= 5; n++) {
    layer = layer.flatMap((s) => [s + "a", s + "b"]); words.push(...layer);
  }
  verify("穷举3969对短串，与完整编辑距离一致", words.flatMap((a) => words.map((b) => [a, b])));
  const boundaries = [];
  for (const length of [10, 11, 20, 33, 50, 99, 100, 101, 300, 1200]) {
    for (const fraction of [0.1, 0.2, 0.3]) {
      for (const offset of [-1, 0, 1]) {
        const edits = Math.max(0, Math.floor(length * fraction) + offset), a = "a".repeat(length);
        boundaries.push([a, "b".repeat(edits) + "a".repeat(length - edits)], [a, a.slice(edits)], [a.slice(edits), a]);
      }
    }
  }
  verify("候选下限、80%及10个百分点附近270对边界一致", boundaries);
  let seed = 7919;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = ["a", "b", "c", "中", "文", "𠮷"];
  const samples = [];
  for (let n = 0; n < 400; n++) {
    const original = Array.from({ length: 10 + random(140) }, () => alphabet[random(alphabet.length)]);
    const changed = original.slice();
    for (let i = 0, edits = random(original.length); i < edits; i++) {
      const at = random(changed.length + 1), op = random(3);
      if (op === 0) changed.splice(at, 1);
      else if (op === 1) changed.splice(at, 0, alphabet[random(alphabet.length)]);
      else if (at < changed.length) changed[at] = alphabet[random(alphabet.length)];
    }
    samples.push([original.join(""), changed.join("")], [changed.join(""), original.join("")]);
  }
  verify("800对固定随机插入、删除、替换及中英文UTF-16样本一致", samples);
  equal("prose-score: 完全一致长串直接得分1", score("a".repeat(1200), "a".repeat(1200)), 1);
  equal("prose-score: 空串保留原评分0", score("", ""), 0);
  // 0.79 的最佳候选仍应拒绝；0.90/0.81 不消除歧义，0.90/0.80 保留恰好10个百分点边界。
  for (const edits of [19, 20, 21, 29, 30, 31]) {
    const a = "a".repeat(100), b = "b".repeat(edits) + "a".repeat(100 - edits);
    const expected = legacyScore(a, b), actual = score(a, b);
    check(`prose-score: ${edits}%编辑距离的候选过滤保持`, (actual >= 0.8 - 0.1) === (expected >= 0.8 - 0.1));
  }
  const near = "b".repeat(120) + "a".repeat(1080);
  cells = 0; score("a".repeat(1200), near); const nearCells = cells;
  check("prose-score: 1200字符近似样本矩阵单元减少", nearCells < 1200 * 1200);
  cells = 0; score("a".repeat(1200), "b".repeat(1200)); const farCells = cells;
  check("prose-score: 无关长串提前终止且计算量更少", farCells < nearCells);
  console.log(`正文评分合成基准：完整矩阵 1440000 单元；近似样本 ${nearCells}；无关样本 ${farCells}。`);
}
