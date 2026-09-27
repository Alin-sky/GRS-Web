#!/usr/bin/env node
/**
 * 合并策略单测（scripts/test-flow-merge.js）
 *
 * 覆盖验收点：
 *   - 三种策略（highest / lowest / priority）
 *   - failed 短路（不比较，整段 fail-closed）
 *   - 全部 skipped → 输出「未执行」，绝不出 safe
 *   - review 序位正确（medium < review < high）
 *   - 并列兜底：priority → branchOrder → nodeId
 *   - confidence 取全部 ok 的最小值
 */

'use strict';

const mergeEngine = require('../src/flow/merge');
const { RISK_ORDER } = require('../src/flow/risk');

let passed = 0;
let failed = 0;
const rows = [];

/**
 * 断言。
 * @param {string} name 用例
 * @param {boolean} ok 结果
 * @param {string} detail 说明
 */
function check(name, ok, detail) {
  if (ok) passed += 1; else failed += 1;
  rows.push({ name, ok, detail });
}

/**
 * 造一个 ok 分支。
 * @param {string} nodeId 节点 id
 * @param {string} level 风险等级
 * @param {object} [extra] 附加
 * @returns {object} 分支
 */
function okBranch(nodeId, level, extra = {}) {
  return {
    nodeId,
    title: nodeId,
    status: 'ok',
    priority: extra.priority || 0,
    branchOrder: extra.branchOrder || 0,
    verdict: {
      risk_level: level,
      action: extra.action || 'pass_log',
      categories: extra.categories || [],
      category_scores: {},
      confidence: Number.isFinite(extra.confidence) ? extra.confidence : 0.9,
      reason: `${nodeId}-reason`,
      suggestion: '',
    },
  };
}

// ── 1. 三种策略 ──
{
  const branches = [okBranch('loc', 'medium', { priority: 10 }), okBranch('cld', 'high', { priority: 20, branchOrder: 1 })];
  const highest = mergeEngine.merge(branches, 'highest');
  check('highest/picks-cloud', highest.status === 'ok' && highest.verdict.risk_level === 'high' && highest.won_by === 'cld',
    `risk=${highest.verdict && highest.verdict.risk_level} won_by=${highest.won_by}`);

  const lowest = mergeEngine.merge(branches, 'lowest');
  check('lowest/picks-local', lowest.status === 'ok' && lowest.verdict.risk_level === 'medium' && lowest.won_by === 'loc',
    `risk=${lowest.verdict && lowest.verdict.risk_level} won_by=${lowest.won_by}`);

  const byPriority = mergeEngine.merge(branches, 'priority');
  check('priority/picks-cloud', byPriority.status === 'ok' && byPriority.won_by === 'cld', `won_by=${byPriority.won_by}`);
}

// ── 2. review 序位：medium < review < high ──
{
  check('order/medium<review<high', RISK_ORDER.medium < RISK_ORDER.review && RISK_ORDER.review < RISK_ORDER.high,
    `medium=${RISK_ORDER.medium} review=${RISK_ORDER.review} high=${RISK_ORDER.high}`);
  const branches = [okBranch('a', 'review'), okBranch('b', 'medium'), okBranch('c', 'high')];
  const highest = mergeEngine.merge(branches, 'highest');
  check('highest/review-loses-to-high', highest.verdict.risk_level === 'high' && highest.won_by === 'c',
    `risk=${highest.verdict.risk_level} won_by=${highest.won_by}`);
  const two = mergeEngine.merge([okBranch('a', 'medium'), okBranch('b', 'review')], 'highest');
  check('highest/review-beats-medium', two.verdict.risk_level === 'review' && two.won_by === 'b',
    `risk=${two.verdict.risk_level} won_by=${two.won_by}`);
  const lowest = mergeEngine.merge([okBranch('a', 'review'), okBranch('b', 'medium')], 'lowest');
  check('lowest/picks-medium', lowest.verdict.risk_level === 'medium', `risk=${lowest.verdict.risk_level}`);
}

// ── 3. failed 短路 ──
{
  const branches = [
    okBranch('loc', 'safe'),
    { nodeId: 'cld', title: 'cld', status: 'failed', verdict: null, failureType: 'timeout', priority: 0, branchOrder: 1, failurePolicy: 'inherit' },
  ];
  const out = mergeEngine.merge(branches, 'highest');
  check('failed/short-circuit', out.status === 'failed' && out.failure && out.failure.nodeId === 'cld',
    `status=${out.status} failure=${out.failure && out.failure.nodeId}`);
  check('failed/no-verdict', out.verdict === null, `verdict=${out.verdict}`);
}

// ── 4. 全 skipped（含 skip 策略的 failed）→ 未执行 ──
{
  const out = mergeEngine.merge([
    { nodeId: 'a', title: 'a', status: 'skipped', verdict: null, priority: 0, branchOrder: 0 },
    { nodeId: 'b', title: 'b', status: 'skipped', verdict: null, priority: 0, branchOrder: 1 },
  ], 'highest');
  check('skipped/all', out.status === 'skipped' && out.verdict === null, `status=${out.status}`);

  const out2 = mergeEngine.merge([
    { nodeId: 'a', title: 'a', status: 'failed', verdict: null, failureType: 'network', failurePolicy: 'skip', priority: 0, branchOrder: 0 },
    { nodeId: 'b', title: 'b', status: 'skipped', verdict: null, failurePolicy: 'inherit', priority: 0, branchOrder: 1 },
  ], 'highest');
  check('skipped/skip-policy-failure-downgrades', out2.status === 'skipped', `status=${out2.status}`);

  const mixed = mergeEngine.merge([
    { nodeId: 'a', title: 'a', status: 'failed', verdict: null, failureType: 'network', failurePolicy: 'skip', priority: 0, branchOrder: 0 },
    okBranch('b', 'medium'),
  ], 'highest');
  check('skipped/skip-policy-still-compares-ok', mixed.status === 'ok' && mixed.won_by === 'b', `status=${mixed.status} won_by=${mixed.won_by}`);
}

// ── 5. 并列兜底 priority → branchOrder → nodeId ──
{
  const byPriority = mergeEngine.merge([
    okBranch('a', 'medium', { priority: 5, branchOrder: 0 }),
    okBranch('b', 'medium', { priority: 9, branchOrder: 1 }),
  ], 'highest');
  check('tie/priority-wins', byPriority.won_by === 'b', `won_by=${byPriority.won_by}`);

  const byOrder = mergeEngine.merge([
    okBranch('z', 'medium', { priority: 0, branchOrder: 0 }),
    okBranch('a', 'medium', { priority: 0, branchOrder: 1 }),
  ], 'highest');
  check('tie/branchOrder-wins', byOrder.won_by === 'z', `won_by=${byOrder.won_by}`);

  const byId = mergeEngine.merge([
    okBranch('b', 'medium', { priority: 0, branchOrder: 0 }),
    okBranch('a', 'medium', { priority: 0, branchOrder: 0 }),
  ], 'highest');
  check('tie/nodeId-wins', byId.won_by === 'a', `won_by=${byId.won_by}`);
}

// ── 6. confidence 取全部 ok 最小值 ──
{
  const out = mergeEngine.merge([
    okBranch('a', 'medium', { confidence: 0.9 }),
    okBranch('b', 'high', { confidence: 0.3 }),
  ], 'highest');
  check('compose/confidence-min', out.verdict.confidence === 0.3, `confidence=${out.verdict.confidence}`);
}

// ── 报告 ──
const line = '-'.repeat(88);
console.log(line);
console.log('GRS flow merge strategy self-test');
console.log(line);
for (const r of rows) console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(40)} ${r.detail}`);
console.log(line);
console.log(`passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
process.exitCode = failed === 0 ? 0 : 1;
