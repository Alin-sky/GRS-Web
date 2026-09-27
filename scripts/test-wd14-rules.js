#!/usr/bin/env node
/**
 * WD14 规则层误报防护回归（scripts/test-wd14-rules.js）
 *
 * 覆盖：critical 级标签独立门槛（rules.criticalTagMinScore）、rating/general 冲突守卫
 *   （rules.ratingConflictGuard / ratingConflictMinConfidence），以及「改前行为可逆」证明。
 *
 * 为什么自带一份旧规则副本：本次要求「门槛调到 ≤ generalThreshold 且关掉守卫时，行为与改动前
 *   逐字节等价」。只有当**旧实现本身**可以独立复现时，这个等价才可被检验；否则等价断言会退化成
 *   恒真。副本仅本文件使用。
 *
 * 为什么每条用例都配一组「反例对照」：单元断言最容易变成恒真（怎么改都通过）。每条主断言都要求
 *   一个**同形状但预期相反**的对照断言（通常是把开关调回/调离阈值），二者必须一个为真、一个为假，
 *   才计通过 —— 这样「守卫真的起作用」与「守卫只是没被执行」才能被区分开。
 *
 * 用法：node scripts/test-wd14-rules.js
 * 退出码：存在失败断言时为 1，否则为 0。
 */
'use strict';

const { mapTagsToRisk, RULE_DEFAULTS } = require('../plugins/wd14-tagger/rules');

// ─── 旧规则（改动前的 mapTagsToRisk，逐行复刻，仅供基线对照）───
const RATING_RULES = {
  explicit: { level: 'critical', score: 90, label: 'explicit 评级' },
  questionable: { level: 'high', score: 70, label: 'questionable 评级' },
  sensitive: { level: 'medium', score: 55, label: 'sensitive 评级' },
  general: { level: null, score: 0, label: 'general 评级' },
};
const TAG_RULES = require('../plugins/wd14-tagger/rules').TAG_RULES;
const LEVEL_ORDER = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

function legacyMapTagsToRisk(wd14Result, opts = {}) {
  const generalThreshold = opts.generalThreshold ?? 0.35;
  const scoreScale = opts.scoreScale ?? 1.0;
  if (!wd14Result || !wd14Result.available) {
    return { available: false, hits: [], suggestedLevel: null, suggestedScore: 0 };
  }
  const hits = [];
  let worstLevel = 'safe';
  let worstScore = 0;
  const scale = (s) => Math.min(100, Math.round(s * scoreScale));
  const rating = wd14Result.rating || {};
  const ratingScores = Object.entries(rating).sort((a, b) => b[1] - a[1]);
  if (ratingScores.length > 0) {
    const [topRating, topScore] = ratingScores[0];
    const rule = RATING_RULES[topRating];
    if (rule && rule.level && topScore > 0.5) {
      hits.push({ tag: 'rating:' + topRating, level: rule.level, score: scale(rule.score), label: rule.label });
      if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[worstLevel]) { worstLevel = rule.level; worstScore = scale(rule.score); }
    }
  }
  const general = wd14Result.general || {};
  for (const [tag, score] of Object.entries(general)) {
    const rule = TAG_RULES[tag];
    if (rule && score >= generalThreshold) {
      hits.push({ tag, level: rule.level, score: scale(rule.score), label: rule.label });
      if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[worstLevel]) { worstLevel = rule.level; worstScore = scale(rule.score); }
    }
  }
  return {
    available: true,
    rating: Object.keys(rating).reduce((acc, k) => { acc[k] = Math.round(rating[k] * 100); return acc; }, {}),
    hits,
    suggestedLevel: hits.length > 0 ? worstLevel : null,
    suggestedScore: worstScore,
  };
}

// ─── 迷你断言器：每用例 = 主断言 + 反例对照（预期相反）───
let pass = 0;
const failed = [];
const out = (s) => process.stdout.write(`${s}\n`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 运行一条「主断言 + 反例对照」用例。
 * @param {string} name 用例名
 * @param {Function} mainFn 主断言取值函数
 * @param {*} mainWant 主断言期望
 * @param {Function} counterFn 反例对照取值函数
 * @param {*} counterWant 反例对照期望（必须与主断言相反）
 */
function run(name, mainFn, mainWant, counterFn, counterWant) {
  const m = mainFn();
  const c = counterFn();
  const okMain = eq(m, mainWant);
  const okCounter = eq(c, counterWant);
  const flipped = !eq(m, c);
  if (okMain && okCounter && flipped) { pass += 1; return; }
  failed.push(name);
  out(`  FAIL ${name}`);
  out(`       主断言 got ${JSON.stringify(m)} want ${JSON.stringify(mainWant)} ${okMain ? 'ok' : 'MISMATCH'}`);
  out(`       反例对照 got ${JSON.stringify(c)} want ${JSON.stringify(counterWant)} ${okCounter ? 'ok' : 'MISMATCH'}`);
  if (!flipped) out('       主/反例结果相同 —— 断言恒真，判别力不足');
}

const mk = (rating, general, character = {}) => ({ available: true, rating, general, character });
const LOW_CONF_RATING = { general: 0.60, sensitive: 0.30, questionable: 0.20, explicit: 0.05 };
const CONF_GENERAL = { general: 0.90, sensitive: 0.05, questionable: 0.03, explicit: 0.02 };

// ─── 全白空图真实标签（hash=8596c6b1cb828c28，1760B 640x640，id=1790139476690-hb0r4a）───
// 来源：data/audit_records/2026-09-23.jsonl，改前落盘判定 wd14_hits=[{nude,critical,90}]。
const WHITE = mk(
  { general: 0.7835381031036377, sensitive: 0.2420801818370819, questionable: 0.1825045645236969, explicit: 0.050849735736846924 },
  {
    '1girl': 0.7361066341400146,
    solo: 0.5332099795341492,
    simple_background: 0.7113776206970215,
    white_background: 0.4397086501121521,
    monochrome: 0.5297998785972595,
    comic: 0.4817812442779541,
    nude: 0.3894606828689575,
    no_humans: 0.5149123072624207,
    transparent_background: 0.813370943069458,
    polka_dot: 0.4767329692840576,
    white_theme: 0.4789936828613281,
    pale_color: 0.5690658092498779,
    negative_space: 0.9235572814941406,
  },
  {},
);

const REVERT_OPTS = { generalThreshold: 0.35, scoreScale: 1.0, criticalTagMinScore: 0.10, ratingConflictGuard: false };
const OLD_OPTS = { generalThreshold: 0.35, scoreScale: 1.0 };

out('WD14 规则层误报防护回归（scripts/test-wd14-rules.js）');
out(`  默认值：${JSON.stringify(RULE_DEFAULTS)}`);
out('');

// ─── 1. 白图回归 ───
const whiteProbe = (o) => {
  const r = mapTagsToRisk(WHITE, o);
  return { level: r.suggestedLevel, score: r.suggestedScore, nude: r.hits.some((h) => h.tag === 'nude'), hasCritical: r.hits.some((h) => h.level === 'critical') };
};
out('1. 全白空图回归（改前：nude 0.389 -> critical/90）');
run('1.1 默认规则下白图不再产出 critical 命中',
  () => whiteProbe(),
  { level: null, score: 0, nude: false, hasCritical: false },
  () => whiteProbe(REVERT_OPTS),
  { level: 'critical', score: 90, nude: true, hasCritical: true });

// ─── 2. 可逆性对照 ───
out('');
out('2. 可逆性对照');
const battery = [
  WHITE,
  mk({}, { nude: 0.99 }),
  mk({}, { nude: 0.39, barefoot: 0.7, swimsuit: 0.5 }),
  mk({ explicit: 0.9, general: 0.05 }, { nude: 0.8, spread_legs: 0.6 }),
  mk({ questionable: 0.7, general: 0.2 }, { no_panties: 0.81, underwear_only: 0.55 }),
  mk({ sensitive: 0.62, general: 0.3 }, { cleavage: 0.6, large_breasts: 0.66 }),
  mk({ general: 0.95 }, { nude: 0.9, ahegao: 0.5, bikini: 0.6 }),
];
const jsonAll = (opts, fn) => JSON.stringify(battery.map((b) => fn(b, opts)));
run('2.1 门槛<=generalThreshold 且关守卫 ⇒ 与旧实现逐字节等价',
  () => jsonAll(REVERT_OPTS, mapTagsToRisk) === jsonAll(OLD_OPTS, legacyMapTagsToRisk),
  true,
  () => jsonAll({}, mapTagsToRisk) === jsonAll(OLD_OPTS, legacyMapTagsToRisk),
  false);

run('2.2 仅把门槛调到 0.10（守卫仍开）⇒ 命中保留但降级为 low',
  () => {
    const r = mapTagsToRisk(WHITE, { criticalTagMinScore: 0.10 });
    return { level: r.suggestedLevel, nude: r.hits.find((h) => h.tag === 'nude') };
  },
  { level: 'low', nude: { tag: 'nude', level: 'low', score: 45, label: '裸露', downgradedBy: 'rating-conflict-guard', originalLevel: 'critical', originalScore: 90 } },
  () => {
    const r = mapTagsToRisk(WHITE, REVERT_OPTS);
    return { level: r.suggestedLevel, nude: r.hits.find((h) => h.tag === 'nude') };
  },
  { level: 'critical', nude: { tag: 'nude', level: 'critical', score: 90, label: '裸露' } });

run('2.3 守卫关闭 ⇒ 不再降级',
  () => {
    const r = mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.9 }), { ratingConflictGuard: false });
    return { level: r.suggestedLevel, marked: r.hits.some((h) => h.downgradedBy) };
  },
  { level: 'critical', marked: false },
  () => {
    const r = mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.9 }));
    return { level: r.suggestedLevel, marked: r.hits.some((h) => h.downgradedBy) };
  },
  { level: 'low', marked: true });

// ─── 3. 不误伤 ───
out('');
out('3. 不误伤（高置信命中仍 critical；非 general 的 rating 不触发守卫）');
run('3.1 nude=0.9 高置信仍为 critical',
  () => {
    const r = mapTagsToRisk(mk({}, { nude: 0.9 }));
    return { level: r.suggestedLevel, nude: r.hits.find((h) => h.tag === 'nude').level };
  },
  { level: 'critical', nude: 'critical' },
  () => {
    const r = mapTagsToRisk(mk({}, { nude: 0.9 }), { criticalTagMinScore: 0.95 });
    return { level: r.suggestedLevel, nude: r.hits.some((h) => h.tag === 'nude') };
  },
  { level: null, nude: false });

run('3.2 rating=explicit 时守卫不得降级 critical',
  () => {
    const r = mapTagsToRisk(mk({ explicit: 0.9, general: 0.02 }, { nude: 0.9 }));
    return { level: r.suggestedLevel, downgraded: r.hits.filter((h) => h.downgradedBy).length };
  },
  { level: 'critical', downgraded: 0 },
  () => {
    const r = mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.9 }));
    return { level: r.suggestedLevel, downgraded: r.hits.filter((h) => h.downgradedBy).length };
  },
  { level: 'low', downgraded: 1 });

run('3.3 rating=questionable 时守卫不得降级 critical',
  () => mapTagsToRisk(mk({ questionable: 0.9, general: 0.05 }, { nude: 0.9 })).suggestedLevel,
  'critical',
  () => mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.9 }, {})).suggestedLevel,
  'low');

run('3.4 rating=sensitive 时守卫不得降级 critical',
  () => mapTagsToRisk(mk({ sensitive: 0.9, general: 0.08 }, { nude: 0.9 })).suggestedLevel,
  'critical',
  () => mapTagsToRisk(mk({ general: 0.9, sensitive: 0.08 }, { nude: 0.9 })).suggestedLevel,
  'low');

run('3.5 rating 判 general 但置信度低于守卫阈值 ⇒ 不降级',
  () => mapTagsToRisk(mk(LOW_CONF_RATING, { nude: 0.9 })).suggestedLevel,
  'critical',
  () => mapTagsToRisk(mk({ general: 0.8, sensitive: 0.15 }, { nude: 0.9 })).suggestedLevel,
  'low');

run('3.6 守卫只降 critical/high，不动 medium',
  () => {
    const r = mapTagsToRisk(mk(CONF_GENERAL, { large_breasts: 0.9 }));
    return { level: r.suggestedLevel, downgraded: r.hits.some((h) => h.downgradedBy) };
  },
  { level: 'medium', downgraded: false },
  () => {
    const r = mapTagsToRisk(mk(CONF_GENERAL, { spread_legs: 0.9 }));
    return { level: r.suggestedLevel, downgraded: r.hits.some((h) => h.downgradedBy) };
  },
  { level: 'low', downgraded: true });

// ─── 4. 降级可见（可追溯标记）───
out('');
out('4. 降级可见（保留命中 + 可追溯标记）');
run('4.1 被守卫降级的 hit 带 downgradedBy / originalLevel / originalScore',
  () => mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.8 })).hits,
  [{ tag: 'nude', level: 'low', score: 45, label: '裸露', downgradedBy: 'rating-conflict-guard', originalLevel: 'critical', originalScore: 90 }],
  () => mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.8 }), { ratingConflictGuard: false }).hits,
  [{ tag: 'nude', level: 'critical', score: 90, label: '裸露' }]);

run('4.2 未降级的命中不带 downgradedBy 字段',
  () => Object.prototype.hasOwnProperty.call(mapTagsToRisk(mk({}, { nude: 0.9 })).hits[0], 'downgradedBy'),
  false,
  () => Object.prototype.hasOwnProperty.call(mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.9 })).hits[0], 'downgradedBy'),
  true);

// ─── 5. 边界 ───
out('');
out('5. 门槛边界（默认 0.60）');
run('5.1 nude=0.60 命中；nude=0.59 不命中',
  () => {
    const a = mapTagsToRisk(mk({}, { nude: 0.60 }));
    const b = mapTagsToRisk(mk({}, { nude: 0.59 }));
    return { hit60: a.hits.some((h) => h.tag === 'nude'), level60: a.suggestedLevel, hit59: b.hits.some((h) => h.tag === 'nude'), level59: b.suggestedLevel };
  },
  { hit60: true, level60: 'critical', hit59: false, level59: null },
  () => {
    const a = mapTagsToRisk(mk({}, { nude: 0.60 }), { criticalTagMinScore: 0.61 });
    const b = mapTagsToRisk(mk({}, { nude: 0.59 }), { criticalTagMinScore: 0.35 });
    return { hit60: a.hits.some((h) => h.tag === 'nude'), level60: a.suggestedLevel, hit59: b.hits.some((h) => h.tag === 'nude'), level59: b.suggestedLevel };
  },
  { hit60: false, level60: null, hit59: true, level59: 'critical' });

run('5.2 门槛边界与守卫叠加：general 自信 + nude=0.60 ⇒ 命中但降级 low',
  () => mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.60 })).suggestedLevel,
  'low',
  () => mapTagsToRisk(mk(CONF_GENERAL, { nude: 0.60 }), { criticalTagMinScore: 0.61 }).suggestedLevel,
  null);

run('5.3 high 级同类降级：spread_legs=0.8 + rating general 自信 ⇒ low（originalLevel=high）',
  () => {
    const h = mapTagsToRisk(mk(CONF_GENERAL, { spread_legs: 0.8 })).hits.find((x) => x.tag === 'spread_legs');
    return { level: h.level, originalLevel: h.originalLevel, mark: h.downgradedBy };
  },
  { level: 'low', originalLevel: 'high', mark: 'rating-conflict-guard' },
  () => {
    const h = mapTagsToRisk(mk({ questionable: 0.8, general: 0.1 }, { spread_legs: 0.8 })).hits.find((x) => x.tag === 'spread_legs');
    return { level: h.level, marked: Object.prototype.hasOwnProperty.call(h, 'downgradedBy') };
  },
  { level: 'high', marked: false });

out('');
out(`通过 ${pass} 条，失败 ${failed.length} 条`);
if (failed.length === 0) out('RESULT: PASS');
else out('RESULT: FAIL');
process.exitCode = failed.length === 0 ? 0 : 1;
