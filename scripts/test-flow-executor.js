#!/usr/bin/env node
/**
 * 执行器单测（scripts/test-flow-executor.js）
 *
 * 覆盖：
 *   - 纯串行（in → service → out）
 *   - 并行扇出 + 汇聚（highest / lowest）
 *   - 并行段任一 failed → 整体 failed（短路，不比较）
 *   - 全 skipped → 输出未执行（绝不出 safe）
 *   - contribute 节点写入工作上下文
 *   - 孤立节点不执行（不产生 trace）
 */

'use strict';

const registry = require('../src/flow/registry');
const { runFlow } = require('../src/flow/executor');
const { createContext } = require('../src/flow/context');

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

/** 注册测试节点（含延迟模拟并行）。 */
registry.reset();
registry.registerBuiltin({
  ref: 'test.ok',
  modality: ['text', 'image'],
  role: 'service',
  params: [{ key: 'level', type: 'text', default: 'medium' }],
  defaultTimeoutMs: 2000,
  run: async (runtime) => {
    await new Promise((r) => setTimeout(r, 10));
    const level = (runtime.params && runtime.params.level) || 'medium';
    return {
      nodeId: runtime.nodeId, ref: 'test.ok', title: 'ok', status: 'ok', elapsedMs: 10,
      failureType: null, skipReason: null, costHint: 'free', message: '',
      verdict: { risk_level: level, action: 'pass_log', categories: [], category_scores: {}, confidence: 0.8, reason: `${level}`, suggestion: '' },
    };
  },
});
registry.registerBuiltin({
  ref: 'test.fail',
  modality: ['text', 'image'],
  role: 'service',
  params: [],
  defaultTimeoutMs: 2000,
  run: async (runtime) => ({ nodeId: runtime.nodeId, ref: 'test.fail', title: 'fail', status: 'failed', elapsedMs: 5, failureType: 'network', skipReason: null, verdict: null, costHint: 'free', message: 'boom' }),
});
registry.registerBuiltin({
  ref: 'test.skip',
  modality: ['text', 'image'],
  role: 'service',
  params: [],
  defaultTimeoutMs: 2000,
  run: async (runtime) => ({ nodeId: runtime.nodeId, ref: 'test.skip', title: 'skip', status: 'skipped', elapsedMs: 0, failureType: null, skipReason: 'not-configured', verdict: null, costHint: 'free', message: '' }),
});
registry.registerBuiltin({
  ref: 'test.contribute',
  modality: ['image'],
  role: 'contribute',
  params: [],
  defaultTimeoutMs: 2000,
  run: async (runtime) => {
    runtime.ctx.mergeWork({ tags: ['tag-a', 'tag-b'] });
    return { nodeId: runtime.nodeId, ref: 'test.contribute', title: 'contrib', status: runtime.upstream ? 'ok' : 'skipped', elapsedMs: 0, failureType: null, skipReason: null, costHint: 'free', message: '', verdict: runtime.upstream ? runtime.upstream.verdict : null };
  },
});

/** 造流程。 */
function flow(nodes, edges, extra = {}) {
  return { schemaVersion: 1, modality: 'text', revision: 1, updatedAt: new Date().toISOString(), floors: [], nodes, edges, finalizers: [], meta: { note: '', sourceOfTruth: true }, ...extra };
}
const inp = { id: 'in', type: 'input' };
const out = { id: 'out', type: 'output' };

/** 跑一次。 */
async function run(f, payload = { text: 'x' }, modality = 'text') {
  const ctx = createContext({ modality, payload });
  return runFlow(f, payload, { ctx, modality, strictness: 'standard', requestId: 't' });
}

(async () => {
  // ── 1. 纯串行 ──
  {
    const f = flow([inp, { id: 'a', type: 'service', ref: 'test.ok', params: { level: 'high' } }, out],
      [{ id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'a', to: 'out' }]);
    const r = await run(f);
    check('serial/ok', r.status === 'ok' && r.verdict.risk_level === 'high', `status=${r.status} risk=${r.verdict && r.verdict.risk_level}`);
  }

  // ── 2. 并行扇出 + 汇聚 highest ──
  {
    const f = flow([inp,
      { id: 'a', type: 'service', ref: 'test.ok', params: { level: 'low' } },
      { id: 'b', type: 'service', ref: 'test.ok', params: { level: 'critical' } },
      { id: 'mg', type: 'merge', strategy: 'highest', branchOrder: ['a', 'b'] }, out],
    [{ id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'in', to: 'b' }, { id: 'e3', from: 'a', to: 'mg' }, { id: 'e4', from: 'b', to: 'mg' }, { id: 'e5', from: 'mg', to: 'out' }]);
    const r = await run(f);
    check('parallel/highest', r.status === 'ok' && r.verdict.risk_level === 'critical' && r.merge.won_by === 'b', `risk=${r.verdict && r.verdict.risk_level} won_by=${r.merge && r.merge.won_by}`);
  }

  // ── 3. lowest ──
  {
    const f = flow([inp,
      { id: 'a', type: 'service', ref: 'test.ok', params: { level: 'low' } },
      { id: 'b', type: 'service', ref: 'test.ok', params: { level: 'critical' } },
      { id: 'mg', type: 'merge', strategy: 'lowest', branchOrder: ['a', 'b'] }, out],
    [{ id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'in', to: 'b' }, { id: 'e3', from: 'a', to: 'mg' }, { id: 'e4', from: 'b', to: 'mg' }, { id: 'e5', from: 'mg', to: 'out' }]);
    const r = await run(f);
    check('parallel/lowest', r.status === 'ok' && r.verdict.risk_level === 'low', `risk=${r.verdict && r.verdict.risk_level}`);
  }

  // ── 4. 并行段任一 failed → 整体 failed ──
  {
    const f = flow([inp,
      { id: 'a', type: 'service', ref: 'test.ok', params: { level: 'low' } },
      { id: 'b', type: 'service', ref: 'test.fail', params: {} },
      { id: 'mg', type: 'merge', strategy: 'highest' }, out],
    [{ id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'in', to: 'b' }, { id: 'e3', from: 'a', to: 'mg' }, { id: 'e4', from: 'b', to: 'mg' }, { id: 'e5', from: 'mg', to: 'out' }]);
    const r = await run(f);
    check('parallel/failed-short-circuit', r.status === 'failed', `status=${r.status}`);
  }

  // ── 5. 全 skipped → skipped ──
  {
    const f = flow([inp, { id: 'a', type: 'service', ref: 'test.skip', params: {} }, out],
      [{ id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'a', to: 'out' }]);
    const r = await run(f);
    check('all-skipped', r.status === 'skipped' && r.verdict === null, `status=${r.status}`);
  }

  // ── 5b. 回归（QA Round1）：非 trunk 节点失败也必须整体 fail-closed，且不得暴露 verdict ──
  {
    // input → {A(ok), F(fail)} → merge → C(ok) → output
    // 旧缺陷：status 只看 trunk(=C, ok) → ok 放行；必须为 failed 且 verdict=null
    const f = flow([inp,
      { id: 'a', type: 'service', ref: 'test.ok', params: { level: 'high' } },
      { id: 'xf', type: 'service', ref: 'test.fail', params: {} },
      { id: 'mg', type: 'merge', strategy: 'highest', branchOrder: ['a', 'xf'] },
      { id: 'c', type: 'service', ref: 'test.ok', params: { level: 'safe' } }, out],
    [{ id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'in', to: 'xf' },
      { id: 'e3', from: 'a', to: 'mg' }, { id: 'e4', from: 'xf', to: 'mg' },
      { id: 'e5', from: 'mg', to: 'c' }, { id: 'e6', from: 'c', to: 'out' }]);
    const r = await run(f);
    check('partial-failed/non-trunk-must-fail-closed', r.status === 'failed' && r.verdict === null && r.hasRealFailure === true,
      `status=${r.status} verdict=${r.verdict} hasRealFailure=${r.hasRealFailure} trunkStatus=${r.trunkStatus}`);
  }

  // ── 5c. 回归：仅 failurePolicy=skip 的失败 → 降级为 skipped（非 fail-closed） ──
  {
    const f = flow([inp, { id: 'xf', type: 'service', ref: 'test.fail', params: {}, failurePolicy: 'skip' }, out],
      [{ id: 'e1', from: 'in', to: 'xf' }, { id: 'e2', from: 'xf', to: 'out' }]);
    const r = await run(f);
    check('skip-policy/failure-degrades-to-skipped', r.status === 'skipped' && r.hasRealFailure === false,
      `status=${r.status} hasRealFailure=${r.hasRealFailure}`);
  }

  // ── 6. contribute 写入工作上下文 ──
  {
    const f = flow([inp,
      { id: 'c', type: 'contribute', ref: 'test.contribute', params: {} },
      { id: 'a', type: 'service', ref: 'test.ok', params: { level: 'medium' } }, out],
    [{ id: 'e1', from: 'in', to: 'c' }, { id: 'e2', from: 'c', to: 'a' }, { id: 'e3', from: 'a', to: 'out' }],
    { modality: 'image' });
    const ctx = createContext({ modality: 'image', payload: { imageBase64: 'x' } });
    const r = await runFlow(f, { imageBase64: 'x' }, { ctx, modality: 'image', strictness: 'standard', requestId: 't' });
    check('contribute/writes-work', ctx.work.tags.includes('tag-a') && ctx.work.tags.includes('tag-b'),
      `tags=${ctx.work.tags.join(',')}`);
    check('contribute/status-ok', r.status === 'ok', `status=${r.status}`);
  }

  // ── 7. 孤立节点不执行 ──
  {
    const f = flow([inp,
      { id: 'a', type: 'service', ref: 'test.ok', params: { level: 'medium' } },
      { id: 'ghost', type: 'service', ref: 'test.ok', params: { level: 'critical' } }, out],
    [{ id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'a', to: 'out' }]);
    const r = await run(f);
    const ghostTrace = r.traces.find((t) => t.node_id === 'ghost');
    check('orphan/not-executed', !ghostTrace && r.verdict.risk_level === 'medium',
      `ghostTrace=${Boolean(ghostTrace)} risk=${r.verdict && r.verdict.risk_level}`);
  }

  // ── 8. trace 记录 ──
  {
    const f = flow([inp, { id: 'a', type: 'service', ref: 'test.ok', params: {} }, out],
      [{ id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'a', to: 'out' }]);
    const r = await run(f);
    check('trace/present', r.traces.length >= 1 && r.traces[0].node_id === 'a' && r.traces[0].status === 'ok',
      `traces=${r.traces.map((t) => `${t.node_id}:${t.status}`).join(',')}`);
  }

  // ── 9. 回归（QA Round1）：doubleCheck 迁移必须产出完整拓扑 ──
  {
    const migrate = require('../src/flow/migrate');
    const f = migrate.migrateTextFlow({
      moderationMode: 'local',
      moderation: { doubleCheck: true, reviewChannels: { local: true, cloud: false } },
      contentSafety: { enabled: false },
      qwenCloud: { enabled: true },
    }, []);
    check('migrate/doubleCheck-structural', f.nodes.length === 6 && f.edges.length === 5,
      `nodes=${f.nodes.length} edges=${f.edges.length}`);
  }

  const line = '-'.repeat(88);
  console.log(line);
  console.log('GRS flow executor self-test');
  console.log(line);
  for (const r of rows) console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(34)} ${r.detail}`);
  console.log(line);
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
})();
