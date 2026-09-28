/**
 * 审核记录筛查纯函数回归 —— scripts/test-audit-filter.js
 *
 * 运行：node scripts/test-audit-filter.js
 *
 * 覆盖：
 *   F. matchesCategory —— 普通类目命中/未命中、unclassified 口径（违规且无类目）、空值容错
 *   K. matchesKeyword  —— 大小写不敏感、多词 AND、命中 text/reason/id/meta、空词不过滤
 *   I. matchesId       —— 字符串/数字 id 等价、空 id 不过滤
 *   X. filterRecords   —— 组合叠加、不改写入参、非法入参优雅退化
 *   P. 口径一致性       —— JSONL 记录 与 DB 重建记录（result_json 解析回来）判定必须逐条相同
 *   B. 本轮缺陷回归     —— category_scores 有该类目但 categories 为空 ⇒ 不得算类目命中；
 *                          而按 id 精确定位仍必须能找到（证明「按 id 取单条」是正确跳转方式）
 *
 * 隔离：零依赖纯函数，不起服务、不触网、不碰生产数据。
 */

'use strict';

const path = require('path');
const PROJECT_ROOT = path.join(__dirname, '..');
const f = require(path.join(PROJECT_ROOT, 'src', 'audit-filter'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`[PASS] ${name}${detail ? ' | ' + detail : ''}`); }
  else { failed++; console.log(`[FAIL] ${name}${detail ? ' | ' + detail : ''}`); }
}

const rec = (id, result, extra = {}) => Object.assign({ id, timestamp: '2026-09-28T00:00:00.000Z', text: '', result }, extra);

const blockedPorn = rec('r1', { passed: false, risk_level: 'high', categories: ['pornographic'], reason: '含色情低俗内容' },
  { text: '裸照福利视频', meta: { userId: 'u100', scene: 'afdian-rank-remark' } });
const blockedNoCat = rec('r2', { passed: false, risk_level: 'medium', categories: [], reason: '拦截但无类目' }, { text: 'abc' });
const passedRec = rec('r3', { passed: true, risk_level: 'safe', categories: [], reason: '无违规' }, { text: '大家好' });
const scoredOnly = rec('r4', { passed: false, risk_level: 'low', categories: [], category_scores: { marketing: 42 }, reason: '弱信号' }, { text: 'x' });

console.log('\n── F. 分类口径 ──');
check('F/01 普通类目命中', f.matchesCategory(blockedPorn, 'pornographic') === true);
check('F/02 普通类目未命中', f.matchesCategory(blockedPorn, 'gambling') === false);
check('F/03 unclassified = 违规且无类目', f.matchesCategory(blockedNoCat, 'unclassified') === true);
check('F/04 放行的空类目不得算 unclassified', f.matchesCategory(passedRec, 'unclassified') === false,
  'passed=true + cats=[] 应为 false');
check('F/05 空 category = 不过滤', f.matchesCategory(passedRec, null) === true && f.matchesCategory(passedRec, '') === true);
check('F/06 缺 result 对象优雅退化', f.matchesCategory({ id: 'x' }, 'pornographic') === false
  && f.matchesCategory({ id: 'x' }, 'unclassified') === false);
check('F/07 categories 里的空值被剔除', f.matchesCategory(rec('r5', { passed: false, categories: ['', 'marketing'] }), 'marketing') === true);

console.log('\n── K. 关键词筛查 ──');
check('K/01 大小写不敏感命中 text', f.matchesKeyword(blockedPorn, '裸照') === true);
check('K/02 英文大小写不敏感', f.matchesKeyword(rec('k', { passed: true, reason: 'OK' }, { text: 'Hello World' }), 'hELLO') === true);
check('K/03 命中 reason', f.matchesKeyword(blockedPorn, '色情低俗') === true);
check('K/04 命中记录 id', f.matchesKeyword(blockedPorn, 'r1') === true);
check('K/05 命中 meta.userId / scene', f.matchesKeyword(blockedPorn, 'u100') === true && f.matchesKeyword(blockedPorn, 'afdian-rank') === true);
check('K/06 多词 AND（缺一不命中）', f.matchesKeyword(blockedPorn, '裸照 色情') === true
  && f.matchesKeyword(blockedPorn, '裸照 不存在的词') === false);
check('K/07 空串/纯空白 = 不过滤', f.matchesKeyword(blockedPorn, '') === true && f.matchesKeyword(blockedPorn, '   ') === true);
check('K/08 未命中返回 false', f.matchesKeyword(passedRec, '赌博') === false);

console.log('\n── I. 精确 id ──');
check('I/01 字符串 id 命中', f.matchesId(blockedPorn, 'r1') === true);
check('I/02 数字与字符串 id 等价', f.matchesId(rec(12, { passed: true }), '12') === true);
check('I/03 空 id = 不过滤', f.matchesId(blockedPorn, '') === true && f.matchesId(blockedPorn, undefined) === true);
check('I/04 错 id 不命中', f.matchesId(blockedPorn, 'nope') === false);

console.log('\n── X. 组合过滤 ──');
const all = [blockedPorn, blockedNoCat, passedRec, scoredOnly];
check('X/01 id + category + q 叠加（AND）',
  f.filterRecords(all, { id: 'r1' }).length === 1
  && f.filterRecords(all, { category: 'pornographic' }).map((r) => r.id).join() === 'r1'
  && f.filterRecords(all, { q: '裸照 色情' }).map((r) => r.id).join() === 'r1',
  f.filterRecords(all, { category: 'pornographic' }).map((r) => r.id).join());
check('X/02 unclassified = 全部「违规且无类目」的记录（r2 与 r4），放行的 r3 排除',
  f.filterRecords(all, { category: 'unclassified' }).map((r) => r.id).join() === 'r2,r4',
  f.filterRecords(all, { category: 'unclassified' }).map((r) => r.id).join());
check('X/03 无 criteria = 全量', f.filterRecords(all).length === 4);
check('X/04 不改写入参', (() => { const before = all.length; f.filterRecords(all, { q: 'zzz' }); return all.length === before; })());
check('X/05 非法入参优雅退化', f.filterRecords(null, { q: 'a' }).length === 0 && f.filterRecords([], { id: 'x' }).length === 0);

console.log('\n── P. JSONL 与 DB 重建记录口径一致 ──');
// 复刻 audit-db.query() 的重建方式：result 存 result_json，取出时 JSON.parse 回对象
const dbRebuilt = {
  id: blockedPorn.id, timestamp: blockedPorn.timestamp, date: '2026-09-28',
  text: blockedPorn.text, model: null,
  result: JSON.parse(JSON.stringify(blockedPorn.result)),
  meta: JSON.parse(JSON.stringify(blockedPorn.meta)),
};
const crits = [
  { category: 'pornographic' }, { category: 'unclassified' }, { q: '裸照' },
  { q: 'afdian-rank' }, { id: 'r1' }, { id: 'r1', category: 'pornographic', q: '裸照' },
];
let parityOk = true;
for (const c of crits) {
  const a = JSON.stringify(all.filter((r) => f.matchesCategory(r, c.category) && f.matchesKeyword(r, c.q) && f.matchesId(r, c.id)).map((r) => r.id));
  const b = JSON.stringify([dbRebuilt, blockedNoCat, passedRec, scoredOnly].filter((r) => f.matchesCategory(r, c.category) && f.matchesKeyword(r, c.q) && f.matchesId(r, c.id)).map((r) => r.id));
  if (a !== b) { parityOk = false; console.log(`   [i] 口径分歧 criteria=${JSON.stringify(c)} jsonl=${a} db=${b}`); }
}
check('P/01 两条路径逐条同结果', parityOk, 'criteria 共 ' + crits.length + ' 组');

console.log('\n── B. 本轮缺陷回归（统计下钻「点不开」）──');
// 饼图「scores 口径」会出现只在 category_scores 里、不在 categories 里的类目。
check('B/01 scores 有该类目但 categories 未列出 ⇒ 不算类目命中',
  f.matchesCategory(scoredOnly, 'marketing') === false,
  '这就是下钻 cat 与记录 data-cats 不一致、导致目标被过滤藏掉的根源');
check('B/02 该记录仍必须能被精确 id 定位 ⇒ 跳转应按 id 取单条',
  f.filterRecords(all, { id: 'r4' }).map((r) => r.id).join() === 'r4');
check('B/03 id 定位不受 category/q 误配影响（单独用 id 时命中）',
  f.matchesId(scoredOnly, 'r4') === true && f.matchesCategory(scoredOnly, 'marketing') === false);

console.log('---');
console.log(`passed=${passed} failed=${failed}`);
console.log(`OVERALL: ${failed === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failed === 0 ? 0 : 1);
