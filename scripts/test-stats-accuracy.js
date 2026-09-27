#!/usr/bin/env node
/**
 * 统计口径准确性回归（scripts/test-stats-accuracy.js）
 *
 * 目标：锁死 `getDetailedStats()` 的 token / 费用 / 违规分布口径，防止退回
 * 「按字数估算 token」与「跨币种求和」两种错误。
 *
 * 为什么这些断言有判别力（阳性对照）：把 `getDetailedStats()` 改回旧写法
 * （`result.tokens_in || Math.round(text.length*1.8)`）后，B/2 会立刻变红 ——
 * 因为没有 cloud_cost 的记录会被凭空编造出 1000*1.8=1800 个 token。
 *
 * 测试隔离：`GRS_AUDIT_DIR` + `GRS_AUDIT_DB` 全部指向临时目录，
 * 只写 JSONL（getDetailedStats 是纯读函数），绝不触碰生产 data/。
 *
 * 用法：node scripts/test-stats-accuracy.js
 * 退出码：全部通过为 0，否则为 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── 隔离（必须在 require 业务模块之前）───
const SANDBOX = path.join(os.tmpdir(), `grs-stats-${Date.now()}`);
const AUDIT_DIR = path.join(SANDBOX, 'audit_records');
fs.mkdirSync(AUDIT_DIR, { recursive: true });
process.env.GRS_AUDIT_DIR = AUDIT_DIR;
process.env.GRS_AUDIT_DB = path.join(SANDBOX, 'audit.db');
process.env.QA_GUARD_CONFIG_WRITE = '1';
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

const auditStore = require('../src/audit-store');

let passed = 0;
let failed = 0;

/**
 * 断言并打印一行。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 详情
 * @returns {void}
 */
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name.padEnd(52)} ${detail}`); } else { failed += 1; console.log(`  FAIL  ${name.padEnd(52)} ${detail}`); }
}

const TODAY = auditStore.getDateStr();

/**
 * 覆盖写入「今天」的 JSONL（getDetailedStats 依据日期读文件，逐场景重写可让断言精确）。
 * @param {Array<object>} records 记录数组
 * @returns {void}
 */
function writeDay(records) {
  const f = path.join(AUDIT_DIR, `${TODAY}.jsonl`);
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

/**
 * 造一条最小可用审核记录。
 * @param {object} result result 字段
 * @param {object} [extra] text / model 覆盖
 * @returns {object} 记录
 */
function rec(result, extra = {}) {
  return {
    id: `id-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    date: TODAY,
    text: extra.text !== undefined ? extra.text : 't',
    model: extra.model !== undefined ? extra.model : null,
    result,
    meta: {},
  };
}

/** 一条已定价的云调用记录 */
function priced(cost, currency, model) {
  return {
    passed: true, cloud_cost: {
      available: true, pricing_known: true, model,
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      total_cost: cost, currency,
    },
  };
}

/** 取今天的日统计 + 汇总 */
function readStats() {
  const s = auditStore.getDetailedStats(1);
  return { day: s.today, summary: s.summary };
}

console.log('--------------------------------------------------------------------------------');
console.log('统计口径准确性回归（scripts/test-stats-accuracy.js）');
console.log(`沙箱: ${SANDBOX}`);
console.log('--------------------------------------------------------------------------------');

// ══════════════════════════════════════════════════════════
console.log('\n── A 真实云用量：只认 result.cloud_cost ──');
writeDay([rec({
  passed: true, type: 'text',
  cloud_cost: {
    available: true, pricing_known: true, model: 'qwen3.8-flash',
    prompt_tokens: 2445, completion_tokens: 215, total_tokens: 2660,
    input_cost: 0.001956, output_cost: 0.000581, total_cost: 0.0025, currency: 'CNY',
    pricing_unit: 'CNY/million_tokens',
  },
})]);
{
  const { day, summary } = readStats();
  check('A/1 tokens_in 取真实 prompt_tokens', day.tokens_in === 2445, `tokens_in=${day.tokens_in}`);
  check('A/2 tokens_out 取真实 completion_tokens', day.tokens_out === 215, `tokens_out=${day.tokens_out}`);
  check('A/3 tokens_total = in + out', day.tokens_total === 2660, `tokens_total=${day.tokens_total}`);
  check('A/4 cost_by_currency.CNY = 真实 total_cost', day.cost_by_currency.CNY === 0.0025, `CNY=${day.cost_by_currency.CNY}`);
  check('A/5 cloud_calls=1 / no_cloud=0 / unpriced_calls=0',
    day.cloud_calls === 1 && day.no_cloud === 0 && day.unpriced_calls === 0,
    `cloud=${day.cloud_calls} no_cloud=${day.no_cloud} unpriced=${day.unpriced_calls}`);
  const m = day.by_model['qwen3.8-flash'];
  check('A/6 by_model 明细正确',
    Boolean(m) && m.calls === 1 && m.tokens_in === 2445 && m.tokens_out === 215 && m.cost === 0.0025 && m.currency === 'CNY',
    JSON.stringify(m));
  check('A/7 summary 与当日一致',
    summary.total_tokens === 2660 && summary.total_tokens_in === 2445 && summary.total_tokens_out === 215
    && summary.cost_by_currency.CNY === 0.0025 && summary.cloud_calls === 1 && summary.no_cloud === 0
    && summary.by_model['qwen3.8-flash'].cost === 0.0025,
    `tok=${summary.total_tokens} CNY=${summary.cost_by_currency.CNY}`);
}

console.log('\n── B 无云调用：token 与费用增量必须为 0（本次修复的核心反例）──');
// 文本长 1000 字：旧实现会估算出 1000*1.8=1800 个 token
writeDay([rec({ passed: true, type: 'text' }, { text: 'x'.repeat(1000) })]);
{
  const { day } = readStats();
  check('B/1 no_cloud 计数 +1', day.no_cloud === 1, `no_cloud=${day.no_cloud}`);
  check('B/2 tokens_in = 0（未按字数编造 1800）', day.tokens_in === 0, `tokens_in=${day.tokens_in}`);
  check('B/3 tokens_out = 0', day.tokens_out === 0, `tokens_out=${day.tokens_out}`);
  check('B/4 tokens_total = 0', day.tokens_total === 0, `tokens_total=${day.tokens_total}`);
  check('B/5 费用为空（无任何币种）', Object.keys(day.cost_by_currency).length === 0,
    JSON.stringify(day.cost_by_currency));
  check('B/6 by_model 为空', Object.keys(day.by_model).length === 0, JSON.stringify(day.by_model));
}

console.log('\n── C pricing_known=false：单独计数，且不套用其它模型价格 ──');
writeDay([rec({ passed: true, cloud_cost: { available: true, pricing_known: false, model: 'qwen3.8-flash', total_cost: null } })]);
{
  const { day } = readStats();
  check('C/1 unpriced_calls = 1', day.unpriced_calls === 1, `unpriced=${day.unpriced_calls}`);
  check('C/2 cloud_calls = 1（确实发生了云调用）', day.cloud_calls === 1, `cloud=${day.cloud_calls}`);
  check('C/3 费用不增（未借用任何价格）', Object.keys(day.cost_by_currency).length === 0,
    JSON.stringify(day.cost_by_currency));
  check('C/4 by_model 该模型 cost = 0',
    Boolean(day.by_model['qwen3.8-flash']) && day.by_model['qwen3.8-flash'].cost === 0,
    JSON.stringify(day.by_model['qwen3.8-flash']));
}

console.log('\n── D 多币种：必须分键累加，绝不求和 ──');
writeDay([
  rec(priced(0.0025, 'CNY', 'qwen3.8-flash')),
  rec(priced(0.01, 'USD', 'gpt-x')),
]);
{
  const { day, summary } = readStats();
  check('D/1 cost_by_currency 分两个键', Object.keys(day.cost_by_currency).sort().join(',') === 'CNY,USD',
    `keys=${Object.keys(day.cost_by_currency).join(',')}`);
  check('D/2 CNY 独立正确', day.cost_by_currency.CNY === 0.0025, `CNY=${day.cost_by_currency.CNY}`);
  check('D/3 USD 独立正确（未被加进 CNY）', day.cost_by_currency.USD === 0.01, `USD=${day.cost_by_currency.USD}`);
  check('D/4 summary 同样分键',
    Object.keys(summary.cost_by_currency).sort().join(',') === 'CNY,USD'
    && summary.cost_by_currency.CNY === 0.0025 && summary.cost_by_currency.USD === 0.01,
    JSON.stringify(summary.cost_by_currency));
}

console.log('\n── E 违规分类分布：只统计 passed===false ──');
writeDay([
  rec({ passed: false, categories: ['pornographic'] }),
  rec({ passed: false }),
  rec({ passed: true, categories: ['political'] }),
]);
{
  const { day } = readStats();
  check('E/1 违规且有分类 => 计入', day.by_category.pornographic === 1, `pornographic=${day.by_category.pornographic}`);
  check('E/2 违规但无 categories => unclassified', day.by_category.unclassified === 1, `unclassified=${day.by_category.unclassified}`);
  check('E/3 passed===true 的分类不计入', day.by_category.political === undefined,
    `political=${day.by_category.political}`);
  check('E/4 通过/拦截只读布尔 passed', day.passed === 1 && day.blocked === 2, `passed=${day.passed} blocked=${day.blocked}`);
}

console.log('\n── F 标签口径：category_scores 原始教师分 >=50 ──');
writeDay([
  rec({ passed: false, categories: ['pornographic'], category_scores: { pornographic: 55, political: 0 } }),
  rec({ passed: false, categories: ['violence'], category_scores: { violence: 50, abuse: 49 } }),
]);
{
  const { day } = readStats();
  check('F/1 55 与 50（含边界）计入',
    day.by_category_scored.pornographic === 1 && day.by_category_scored.violence === 1,
    JSON.stringify(day.by_category_scored));
  check('F/2 0 与 49 不计入',
    day.by_category_scored.political === undefined && day.by_category_scored.abuse === undefined,
    JSON.stringify(day.by_category_scored));
}

console.log('\n── G 模态分布：result.type 优先，缺失时按 toRow 口径兜底 ──');
writeDay([
  rec({ passed: true, type: 'text' }, { text: 'hello' }),
  rec({ passed: true, type: 'image', image_ref: { hash: 'a'.repeat(16) } }, { text: '[图片审核]' }),
  rec({ passed: true }, { text: '[批量图片]' }),
  rec({ passed: true, type: 'image' }, { text: 'x' }),
]);
{
  const { day } = readStats();
  check('G/1 by_type text=1 / image=3（含 type 优先于启发式）',
    day.by_type.text === 1 && day.by_type.image === 3, JSON.stringify(day.by_type));
}

fs.rmSync(AUDIT_DIR, { recursive: true, force: true });

console.log('--------------------------------------------------------------------------------');
console.log(`passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
process.exitCode = failed === 0 ? 0 : 1;
