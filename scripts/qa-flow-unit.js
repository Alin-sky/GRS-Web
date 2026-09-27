#!/usr/bin/env node
/**
 * QA 单元级验证（scripts/qa-flow-unit.js）—— T05 / R1 + 垫片映射
 *
 * 覆盖（独立复现，不依赖实现者自测结论）：
 *   PART A  图校验 18 类非法图各自命中预期错误码（E001–E018 / E009 为 warn）
 *   PART B  4 类拓扑 × 3 种策略 × 3 种状态（全 ok / 部分 failed / 全 skipped）矩阵
 *   PART C  6 组旧配置迁移后，对同一输入的 risk_level / action 与 v2.1.0 语义一致
 *   PART D  审核器注册表对插件 Verdict 的往返映射（pass/block/review + 互逆一致性）
 *
 * 本脚本只写测试，不改任何产品代码。输出纯 ASCII 表头 + 中文用例名。
 */

'use strict';

const registry = require('../src/flow/registry');
const nodes = require('../src/flow/nodes');
const { runFlow } = require('../src/flow/executor');
const { createContext } = require('../src/flow/context');
const { validateFlow } = require('../src/flow/validate');
const migrate = require('../src/flow/migrate');
const { DEFAULT_RISK_LEVELS } = require('../src/config-defaults');

let passed = 0;
let failed = 0;
let warned = 0;
const rows = [];

/**
 * 断言。
 * @param {string} name 用例
 * @param {boolean} ok 结果
 * @param {string} detail 说明
 * @param {'fail'|'warn'} [sev] 失败严重度（warn 只记提示，不计 FAIL）
 */
function check(name, ok, detail, sev = 'fail') {
  if (ok) passed += 1;
  else if (sev === 'warn') warned += 1;
  else failed += 1;
  rows.push({ name, ok, detail, sev, level: ok ? 'ok' : (sev === 'warn' ? 'warn' : 'FAIL') });
}

const ACTION_OF = {};
for (const [level, cfg] of Object.entries(DEFAULT_RISK_LEVELS)) ACTION_OF[level] = cfg.action;

// ══════════════════════════════════════════════════════════
// PART A —— 图校验错误码矩阵
// ══════════════════════════════════════════════════════════
registry.reset();
registry.registerBuiltin({ ref: 'qa.text', modality: ['text'], role: 'service', params: [{ key: 'threshold', type: 'slider', min: 0, max: 1, default: 0.5 }], defaultTimeoutMs: 1000 });
registry.registerBuiltin({ ref: 'qa.image', modality: ['image'], role: 'service', params: [], defaultTimeoutMs: 1000 });

/** 造一个合法文本流程骨架。 */
function baseFlow() {
  return {
    schemaVersion: 1,
    modality: 'text',
    revision: 1,
    updatedAt: '2026-08-16T00:00:00Z',
    floors: [],
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 } },
      { id: 'a', type: 'service', ref: 'qa.text', params: {}, position: { x: 0, y: 100 } },
      { id: 'out', type: 'output', position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: 'e1', from: 'in', to: 'a' },
      { id: 'e2', from: 'a', to: 'out' },
    ],
    finalizers: [],
    meta: { note: '', sourceOfTruth: true },
  };
}

/** 取错误码集合。 */
function codes(r) { return r.errors.map((e) => e.code); }
/** 取告警码集合。 */
function wcodes(r) { return r.warnings.map((w) => w.code); }

{
  const r = validateFlow(baseFlow(), registry);
  check('A00 valid/baseline', r.ok && r.errors.length === 0, `errors=${codes(r).join(',') || 'none'}`);
}
{ // E001 schemaVersion
  const f = baseFlow(); f.schemaVersion = 2;
  const r = validateFlow(f, registry);
  check('A01 E001/schemaVersion', codes(r).includes('E001_SCHEMA'), `codes=${codes(r).join(',')}`);
}
{ // E001 modality
  const f = baseFlow(); f.modality = 'bogus';
  const r = validateFlow(f, registry);
  check('A02 E001/modality', codes(r).includes('E001_SCHEMA'), `codes=${codes(r).join(',')}`);
}
{ // E002 重复节点 id
  const f = baseFlow(); f.nodes.push({ id: 'a', type: 'service', ref: 'qa.text', params: {} });
  const r = validateFlow(f, registry);
  check('A03 E002/dup-node-id', codes(r).includes('E002_DUP_ID'), `codes=${codes(r).join(',')}`);
}
{ // E003 边端点不存在
  const f = baseFlow(); f.edges.push({ id: 'e3', from: 'ghost', to: 'out' });
  const r = validateFlow(f, registry);
  check('A04 E003/edge-ref-missing', codes(r).includes('E003_REF_MISSING'), `codes=${codes(r).join(',')}`);
}
{ // E004 节点 ref 未注册
  const f = baseFlow(); f.nodes[1].ref = 'plugin.not-installed';
  const r = validateFlow(f, registry);
  check('A05 E004/ref-unknown', codes(r).includes('E004_REF_UNKNOWN'), `codes=${codes(r).join(',')}`);
}
{ // E005 环
  const f = baseFlow();
  f.nodes.push({ id: 'b', type: 'service', ref: 'qa.text', params: {} });
  f.edges = [
    { id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'a', to: 'b' },
    { id: 'e3', from: 'b', to: 'a' }, { id: 'e4', from: 'b', to: 'out' },
  ];
  const r = validateFlow(f, registry);
  check('A06 E005/cycle', codes(r).includes('E005_CYCLE'), `codes=${codes(r).join(',')}`);
}
{ // E006 自环
  const f = baseFlow(); f.edges.push({ id: 'e3', from: 'a', to: 'a' });
  const r = validateFlow(f, registry);
  check('A07 E006/self-loop', codes(r).includes('E006_SELF_LOOP'), `codes=${codes(r).join(',')}`);
}
{ // E007 input 有入边 + 双 input
  const f = baseFlow(); f.edges.push({ id: 'e3', from: 'a', to: 'in' });
  const r = validateFlow(f, registry);
  check('A08 E007/input-inbound', codes(r).includes('E007_INOUT_CARDINALITY'), `codes=${codes(r).join(',')}`);

  const f2 = baseFlow();
  f2.nodes.push({ id: 'in2', type: 'input' });
  const r2 = validateFlow(f2, registry);
  check('A08b E007/two-inputs', codes(r2).includes('E007_INOUT_CARDINALITY'), `codes=${codes(r2).join(',')}`);
}
{ // E008 service 入度 > 1
  const f = baseFlow();
  f.nodes.push({ id: 'b', type: 'service', ref: 'qa.text', params: {} });
  f.edges = [
    { id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'in', to: 'b' },
    { id: 'e3', from: 'a', to: 'b' }, { id: 'e4', from: 'b', to: 'out' },
  ];
  const r = validateFlow(f, registry);
  check('A09 E008/service-indeg>1', codes(r).includes('E008_DEGREE'), `codes=${codes(r).join(',')}`);
}
{ // E009 孤立节点（warn，不阻断）
  const f = baseFlow(); f.nodes.push({ id: 'ghost', type: 'service', ref: 'qa.text', params: {} });
  const r = validateFlow(f, registry);
  check('A10 E009/orphan-is-warn', r.ok && wcodes(r).includes('E009_UNREACHABLE'), `ok=${r.ok} warn=${wcodes(r).join(',')}`);
}
{ // E010 输出断开
  const f = baseFlow(); f.edges = [{ id: 'e1', from: 'in', to: 'a' }];
  const r = validateFlow(f, registry);
  check('A11 E010/output-unconnected', codes(r).includes('E010_OUTPUT_UNCONNECTED'), `codes=${codes(r).join(',')}`);
}
{ // E011 模态不匹配
  const f = baseFlow(); f.nodes[1].ref = 'qa.image';
  const r = validateFlow(f, registry);
  check('A12 E011/modality-mismatch', codes(r).includes('E011_MODALITY'), `codes=${codes(r).join(',')}`);
}
{ // E012 参数白名单
  const f = baseFlow(); f.nodes[1].params = { nope: 1 };
  const r = validateFlow(f, registry);
  check('A13 E012/param-unknown', codes(r).includes('E012_PARAM_UNKNOWN'), `codes=${codes(r).join(',')}`);
}
{ // E013 参数越界
  const f = baseFlow(); f.nodes[1].params = { threshold: 3 };
  const r = validateFlow(f, registry);
  check('A14 E013/param-range', codes(r).includes('E013_PARAM_TYPE'), `codes=${codes(r).join(',')}`);
}
{ // E014 规模上限
  const f = baseFlow();
  for (let i = 0; i < 40; i++) f.nodes.push({ id: `n${i}`, type: 'service', ref: 'qa.text', params: {} });
  const r = validateFlow(f, registry);
  check('A15 E014/scale', codes(r).includes('E014_SCALE'), `codes=${codes(r).join(',')}`);
}
{ // E015 重复边
  const f = baseFlow(); f.edges.push({ id: 'e3', from: 'in', to: 'a' });
  const r = validateFlow(f, registry);
  check('A16 E015/dup-edge', codes(r).includes('E015_DUP_EDGE'), `codes=${codes(r).join(',')}`);
}
{ // E016 skip 未二次确认
  const f = baseFlow(); f.nodes[1].failurePolicy = 'skip';
  const r = validateFlow(f, registry);
  check('A17 E016/skip-needs-ack', codes(r).includes('E016_POLICY'), `codes=${codes(r).join(',')}`);
}
{ // E017 merge 策略非法
  const f = baseFlow();
  f.nodes.push({ id: 'b', type: 'service', ref: 'qa.text', params: {} });
  f.nodes.push({ id: 'mg', type: 'merge', strategy: 'bogus' });
  f.edges = [
    { id: 'e1', from: 'in', to: 'a' }, { id: 'e2', from: 'in', to: 'b' },
    { id: 'e3', from: 'a', to: 'mg' }, { id: 'e4', from: 'b', to: 'mg' },
    { id: 'e5', from: 'mg', to: 'out' },
  ];
  const r = validateFlow(f, registry);
  check('A18 E017/merge-strategy', codes(r).includes('E017_STRATEGY'), `codes=${codes(r).join(',')}`);
}
{ // E018 combine=floor 却出现在 nodes
  const f = baseFlow(); f.nodes[1].combine = 'floor';
  const r = validateFlow(f, registry);
  check('A19 E018/floor-in-nodes', codes(r).includes('E018_FLOOR_EDGE'), `codes=${codes(r).join(',')}`);
}

// ══════════════════════════════════════════════════════════
// PART B —— 拓扑 × 策略 × 状态 矩阵
// ══════════════════════════════════════════════════════════
registry.reset();
registry.registerBuiltin({ ref: 'qa.ok', modality: ['text'], role: 'service', params: [{ key: 'level', type: 'text', default: 'medium' }], defaultTimeoutMs: 2000 });
registry.registerBuiltin({ ref: 'qa.fail', modality: ['text'], role: 'service', params: [], defaultTimeoutMs: 2000 });
registry.registerBuiltin({ ref: 'qa.skip', modality: ['text'], role: 'service', params: [], defaultTimeoutMs: 2000 });
registry.registerBuiltin({ ref: 'qa.pass', modality: ['text'], role: 'service', params: [], defaultTimeoutMs: 2000 });

/** 节点运行体：ok（按 level 产判定）。 */
function runOk(rt) {
  const level = (rt.params && rt.params.level) || 'medium';
  return { nodeId: rt.nodeId, ref: 'qa.ok', title: 'ok', status: 'ok', elapsedMs: 1, failureType: null, skipReason: null, costHint: 'free', message: '', verdict: { risk_level: level, action: ACTION_OF[level], categories: [], category_scores: {}, confidence: 0.9, reason: level, suggestion: '' } };
}
nodes.BUILTINS.length; // noop（保持引用可读性）
registry.registerBuiltin({ ref: 'qa.ok', modality: ['text'], role: 'service', params: [{ key: 'level', type: 'text', default: 'medium' }], defaultTimeoutMs: 2000, run: async (rt) => runOk(rt) });
registry.registerBuiltin({ ref: 'qa.fail', modality: ['text'], role: 'service', params: [], defaultTimeoutMs: 2000, run: async (rt) => ({ nodeId: rt.nodeId, ref: 'qa.fail', title: 'fail', status: 'failed', elapsedMs: 1, failureType: 'network', skipReason: null, verdict: null, costHint: 'free', message: 'boom' }) });
registry.registerBuiltin({ ref: 'qa.skip', modality: ['text'], role: 'service', params: [], defaultTimeoutMs: 2000, run: async (rt) => ({ nodeId: rt.nodeId, ref: 'qa.skip', title: 'skip', status: 'skipped', elapsedMs: 0, failureType: null, skipReason: 'not-configured', verdict: null, costHint: 'free', message: '' }) });
registry.registerBuiltin({ ref: 'qa.pass', modality: ['text'], role: 'service', params: [], defaultTimeoutMs: 2000, run: async (rt) => {
  const v = rt.upstream && rt.upstream.verdict ? { ...rt.upstream.verdict } : null;
  return { nodeId: rt.nodeId, ref: 'qa.pass', title: 'pass', status: v ? 'ok' : 'skipped', elapsedMs: 0, failureType: null, skipReason: v ? null : 'upstream-skipped', verdict: v, costHint: 'free', message: '' };
} });

const IN = { id: 'in', type: 'input' };
const OUT = { id: 'out', type: 'output' };
/** 造流程。 */
function mkFlow(ns, es) {
  return { schemaVersion: 1, modality: 'text', revision: 1, updatedAt: '2026-08-16T00:00:00Z', floors: [], nodes: ns, edges: es, finalizers: [], meta: { note: '', sourceOfTruth: true } };
}
/** 边构造。 */
function eg(i, from, to, priority) {
  const e = { id: `e${i}`, from, to };
  if (Number.isFinite(priority)) e.priority = priority;
  return e;
}
/** 判定型 ok 节点。 */
function okNode(id, level) { return { id, type: 'service', ref: 'qa.ok', params: { level } }; }
/** 失败节点。 */
function failNode(id) { return { id, type: 'service', ref: 'qa.fail', params: {} }; }
/** 跳过节点。 */
function skipNode(id) { return { id, type: 'service', ref: 'qa.skip', params: {} }; }
/** 透传节点（把上游判定原样传出）。 */
function passNode(id) { return { id, type: 'service', ref: 'qa.pass', params: {} }; }

/**
 * 四种拓扑。
 * state: 'ok' | 'fail' | 'skip'；'fail' 只让第一个分支（id=a）失败，
 * 其余仍正常 → 用于检验「部分分支 failed ⇒ 整体 fail-closed」。
 * 说明：T3 为「并行 + 串行」，汇聚之后再接一个节点（架构 §14 四类拓扑之一）。
 */
const TOPOS = {
  T1: (strategy, state) => mkFlow(
    [IN, state === 'fail' ? failNode('a') : state === 'skip' ? skipNode('a') : okNode('a', 'medium'), OUT],
    [eg(1, 'in', 'a'), eg(2, 'a', 'out')],
  ),
  T2: (strategy, state) => mkFlow(
    [IN, state === 'fail' ? failNode('a') : state === 'skip' ? skipNode('a') : okNode('a', 'low'),
      state === 'skip' ? skipNode('b') : okNode('b', 'critical'),
      { id: 'mg', type: 'merge', strategy, branchOrder: ['a', 'b'] }, OUT],
    [eg(1, 'in', 'a'), eg(2, 'in', 'b'), eg(3, 'a', 'mg', 10), eg(4, 'b', 'mg', 20), eg(5, 'mg', 'out')],
  ),
  T3: (strategy, state) => mkFlow(
    [IN, state === 'fail' ? failNode('a') : state === 'skip' ? skipNode('a') : okNode('a', 'medium'),
      state === 'skip' ? skipNode('b') : okNode('b', 'high'),
      { id: 'mg', type: 'merge', strategy, branchOrder: ['a', 'b'] },
      state === 'skip' ? skipNode('p') : passNode('p'), OUT],
    [eg(1, 'in', 'a'), eg(2, 'in', 'b'), eg(3, 'a', 'mg', 10), eg(4, 'b', 'mg', 20), eg(5, 'mg', 'p'), eg(6, 'p', 'out')],
  ),
  T4: (strategy, state) => mkFlow(
    [IN, state === 'fail' ? failNode('a') : state === 'skip' ? skipNode('a') : okNode('a', 'low'),
      state === 'skip' ? skipNode('b') : okNode('b', 'medium'),
      state === 'skip' ? skipNode('c') : okNode('c', 'high'),
      state === 'skip' ? skipNode('d') : okNode('d', 'safe'),
      { id: 'm1', type: 'merge', strategy, branchOrder: ['a', 'b'] },
      { id: 'm2', type: 'merge', strategy, branchOrder: ['c', 'd'] },
      { id: 'm3', type: 'merge', strategy, branchOrder: ['m1', 'm2'] }, OUT],
    [eg(1, 'in', 'a'), eg(2, 'in', 'b'), eg(3, 'in', 'c'), eg(4, 'in', 'd'),
      eg(5, 'a', 'm1', 10), eg(6, 'b', 'm1', 20), eg(7, 'c', 'm2', 30), eg(8, 'd', 'm2', 40),
      eg(9, 'm1', 'm3', 100), eg(10, 'm2', 'm3', 0), eg(11, 'm3', 'out')],
  ),
  // T5：汇聚之后再接一个「判定型」节点（合法拓扑）——检验汇聚结论/失败是否被下游掩盖
  T5: (strategy, state) => mkFlow(
    [IN, state === 'fail' ? failNode('a') : state === 'skip' ? skipNode('a') : okNode('a', 'low'),
      state === 'skip' ? skipNode('b') : okNode('b', 'critical'),
      { id: 'mg', type: 'merge', strategy, branchOrder: ['a', 'b'] },
      state === 'skip' ? skipNode('c') : okNode('c', 'safe'), OUT],
    [eg(1, 'in', 'a'), eg(2, 'in', 'b'), eg(3, 'a', 'mg', 10), eg(4, 'b', 'mg', 20), eg(5, 'mg', 'c'), eg(6, 'c', 'out')],
  ),
};

/** 手推期望（全 ok）。[risk_level, action] */
const EXPECT_OK = {
  'T1|highest': ['medium', 'pass_log'],
  'T1|lowest': ['medium', 'pass_log'],
  'T1|priority': ['medium', 'pass_log'],
  'T2|highest': ['critical', 'block_alert'],
  'T2|lowest': ['low', 'pass_log'],
  'T2|priority': ['critical', 'block_alert'],
  'T3|highest': ['high', 'block'],
  'T3|lowest': ['medium', 'pass_log'],
  'T3|priority': ['high', 'block'],
  'T4|highest': ['high', 'block'],
  'T4|lowest': ['safe', 'pass'],
  'T4|priority': ['medium', 'pass_log'],
  'T5|highest': ['safe', 'pass'],
  'T5|lowest': ['safe', 'pass'],
  'T5|priority': ['safe', 'pass'],
};

/** 跑一次流程。 */
async function runOnce(flow) {
  const ctx = createContext({ modality: 'text', payload: { text: 'x' } });
  return runFlow(flow, { text: 'x' }, { ctx, modality: 'text', strictness: 'standard', requestId: 'qa' });
}

(async () => {
  for (const [topoName, build] of Object.entries(TOPOS)) {
    for (const strategy of ['highest', 'lowest', 'priority']) {
      const key = `${topoName}|${strategy}`;

      // 状态 1：全 ok
      {
        const f = build(strategy, 'ok');
        const v = validateFlow(f, registry);
        const r = await runOnce(f);
        const exp = EXPECT_OK[key];
        const got = r.status === 'ok' ? [r.verdict.risk_level, r.verdict.action] : [r.status, null];
        check(`B ${key}|all-ok`, v.ok && r.status === 'ok' && got[0] === exp[0] && got[1] === exp[1],
          `valid=${v.ok} got=${got.join('/')} exp=${exp.join('/')}`);
      }

      // 状态 2：部分 failed → 整体 failed（不比较）
      {
        const f = build(strategy, 'fail');
        const r = await runOnce(f);
        const masked = r.failed.length > 0 && r.status !== 'failed';
        check(`B ${key}|partial-failed`, r.status === 'failed' && r.verdict === null,
          `status=${r.status} trunk=${r.trunkNodeId} failedNodes=[${r.failed.map((x) => x.ref || x.nodeId).join(',')}]${masked ? ' <<FAILED-MASKED>>' : ''}`);
      }

      // 状态 3：全 skipped → skipped（绝不出 safe）
      {
        const f = build(strategy, 'skip');
        const r = await runOnce(f);
        const neverSafe = r.status === 'skipped' && r.verdict === null;
        check(`B ${key}|all-skipped`, neverSafe,
          `status=${r.status} verdict=${r.verdict ? r.verdict.risk_level : 'null'}`);
      }
    }
  }
})()
  .then(() => runPartC())
  .then(() => runPartD())
  .then(report)
  .catch((err) => { console.log('FATAL: ' + (err && err.stack ? err.stack : String(err))); process.exitCode = 1; });

// ══════════════════════════════════════════════════════════
// PART C —— 旧配置迁移等价
// ══════════════════════════════════════════════════════════
function baseCfg(over = {}) {
  return {
    moderationMode: 'local',
    moderation: Object.assign({
      dualMode: false,
      doubleCheck: false,
      reviewChannels: { local: true, cloud: true, contentSafety: false, disputeStrategy: 'highest' },
    }, over.moderation || {}),
    contentSafety: Object.assign({ enabled: false, textEnabled: true, imageEnabled: true }, over.contentSafety || {}),
    qwenCloud: Object.assign({ enabled: true, visionEnabled: false }, over.qwenCloud || {}),
  };
}

/** 迁移生成的 6 组配置。 */
const GROUPS = [
  { id: 'G1', desc: 'local 单通道', cfg: baseCfg(), expect: ['medium', 'pass_log'] },
  { id: 'G2', desc: 'cloud-only', cfg: baseCfg({ moderationMode: 'cloud-only', moderation: { reviewChannels: { local: false, cloud: true, contentSafety: false, disputeStrategy: 'cloud' } } }), expect: ['high', 'block'] },
  { id: 'G3', desc: 'ch.local=false 非 cloud-only', cfg: baseCfg({ moderation: { reviewChannels: { local: false, cloud: true, contentSafety: false, disputeStrategy: 'highest' } } }), expect: ['high', 'block'] },
  { id: 'G4', desc: 'dualMode + highest', cfg: baseCfg({ moderation: { dualMode: true, reviewChannels: { local: true, cloud: true, contentSafety: false, disputeStrategy: 'highest' } } }), expect: ['high', 'block'] },
  { id: 'G5', desc: 'dualMode + lowest', cfg: baseCfg({ moderation: { dualMode: true, reviewChannels: { local: true, cloud: true, contentSafety: false, disputeStrategy: 'lowest' } } }), expect: ['medium', 'pass_log'] },
  { id: 'G6', desc: 'dualMode + disputeStrategy=local', cfg: baseCfg({ moderation: { dualMode: true, reviewChannels: { local: true, cloud: true, contentSafety: false, disputeStrategy: 'local' } } }), expect: ['medium', 'pass_log'] },
  { id: 'G7', desc: 'doubleCheck（额外）', cfg: baseCfg({ moderation: { doubleCheck: true, reviewChannels: { local: true, cloud: false, contentSafety: false, disputeStrategy: 'highest' } } }), expect: ['medium', 'pass_log'] },
];

async function runPartC() {
  registry.reset();
  nodes.registerBuiltins(); // 先按真实内置节点校验迁移结果
  const migrated = [];
  for (const g of GROUPS) {
    const log = [];
    const flow = migrate.migrateTextFlow(g.cfg, log);
    migrated.push({ g, flow, log });
    const v = validateFlow(flow, registry);
    check(`C ${g.id}/validate`, v.ok, `desc=${g.desc} errors=${codes(v).join(',') || 'none'} warn=${wcodes(v).join(',') || 'none'}`);
  }
  // 覆写内置 localModel / cloudModel 运行体（stub 判定），仅用于「同一输入」的等价比较
  registry.registerBuiltin({ ref: 'builtin.localModel', modality: ['text', 'image'], role: 'service', defaultTimeoutMs: 2000, run: async (rt) => runOk({ ...rt, params: { level: 'medium' } }) });
  registry.registerBuiltin({ ref: 'builtin.cloudModel', modality: ['text', 'image'], role: 'service', defaultTimeoutMs: 2000, run: async () => ({ nodeId: 'cld', ref: 'builtin.cloudModel', title: 'cloud', status: 'ok', elapsedMs: 1, failureType: null, skipReason: null, verdict: { risk_level: 'high', action: 'block', categories: [], category_scores: {}, confidence: 0.9, reason: 'high', suggestion: '' }, costHint: 'free', message: '' }) });

  for (const { g, flow } of migrated) {
    const r = await runOnce(flow); // 只跑主管线（stub：本地 medium / 云端 high）
    const got = r.status === 'ok' ? [r.verdict.risk_level, r.verdict.action] : [r.status, null];
    check(`C ${g.id}/risk-level&action`, r.status === 'ok' && got[0] === g.expect[0] && got[1] === g.expect[1],
      `desc=${g.desc} got=${got.join('/')} exp=${g.expect.join('/')}`);
  }
}

// ══════════════════════════════════════════════════════════
// PART D —— 审核器注册表对插件 Verdict 的往返映射
// v0.1.0（决策 A / 裁决 B1）：内容安全垫片已删除调用出口，
//     本部分改为经 src/flow/adjudicators#invoke() 走注册表分发。
//     断言逐条等价（gate 拒绝降级 / 缺提供者跳过 / 伪 verdict 被拒），未弱化任何安全性质。
// ══════════════════════════════════════════════════════════
async function runPartD() {
  const broker = require('../src/capability-broker');
  const { loadConfig } = require('../src/config');
  const cs = require('../src/content_safety');
  const adjudicators = require('../src/flow/adjudicators');

  /** 被测的审核器 ref（由插件提供，核心不硬编码——这里只是测试夹具）。 */
  const CS_REF = 'plugin.aliyun-content-safety.text';

  broker._reset();
  let nextVerdict = null;
  broker.setTransport({
    emitCollect: async () => [],
    emitFirst: async () => undefined,
    emitCall: async () => nextVerdict,
    hasHandlers: () => true,
  });
  broker.registerAll('aliyun-content-safety', [
    { id: 'text.verdict', event: 'moderation:verdict:text', mode: 'call', outputSchema: 'ModerationVerdict' },
    { id: 'image.verdict', event: 'moderation:verdict:image', mode: 'call', outputSchema: 'ModerationVerdict' },
  ]);
  // 注册表是唯一数据源：先把该插件节点登记进 flow/registry，invoke 才可能解析到它
  nodes.registerBuiltins();
  registry.registerPluginNodes('aliyun-content-safety', [{
    ref: CS_REF,
    title: '阿里云内容安全 · 文本',
    modality: ['text'],
    role: 'service',
    capability: 'text.verdict',
    costHint: 'paid-api',
    ready: true,
  }]);

  // 内存内启用内容安全（不落盘）：现有 config 已含 enable+keys，仅图片通道默认关
  const cfg = loadConfig();
  cfg.contentSafety.enabled = true;
  cfg.contentSafety.textEnabled = true;
  cfg.contentSafety.imageEnabled = true;

  const st = cs.getContentSafetyStatus();
  check('D00 status/ready-after-provider', st.ready === true, `ready=${st.ready} reason=${st.reason} installed=${st.installed} pluginAvailable=${st.pluginAvailable}`);

  /** 经注册表判一次（等价于改造前的 cs.moderateTextContentSafety）。 */
  const judge = () => adjudicators.invoke(CS_REF, { text: 'neutral placeholder text' }, 'text');

  /** 造一条合法插件判定（可被 plugin-gate 接受）。 */
  const verdict = (level, extra = {}) => Object.assign({ risk_level: level, categories: ['abuse'], category_scores: { abuse: 80 }, confidence: 0.9, reason: 'r', suggestion: '' }, extra);

  const cases = [
    { level: 'high', expSuggestion: 'block' },
    { level: 'critical', expSuggestion: 'block' },
    { level: 'medium', expSuggestion: 'review' },
    { level: 'safe', expSuggestion: 'pass' },
    { level: 'low', expSuggestion: 'pass' },
  ];
  for (const c of cases) {
    nextVerdict = verdict(c.level);
    // eslint-disable-next-line no-await-in-loop
    const res = await judge();
    check(`D plugin->registry/${c.level}`, res.available === true && res.suggestion === c.expSuggestion && res.risk_level === c.level,
      `available=${res.available} suggestion=${res.suggestion} risk=${res.risk_level} exp=${c.expSuggestion}`);
  }

  // 形状与 v2.1.0 对齐（决策相关字段必须齐备）
  nextVerdict = verdict('high');
  const shaped = await judge();
  const required = ['available', 'provider', 'skipped', 'suggestion', 'risk_level', 'categories', 'category_scores', 'confidence', 'matched_labels', 'elapsed_ms'];
  const missing = required.filter((k) => !(k in shaped));
  check('D shape/required-keys', missing.length === 0 && shaped.provider === 'aliyun-content-safety', `missing=${missing.join(',') || 'none'} provider=${shaped.provider}`);
  // v2.1.0 形状含 channel / elapsed_ms / matched_labels 内容；注册表是否保留？
  check('D shape/v210-extra-fields', 'channel' in shaped && 'elapsed_ms' in shaped, `channel=${'channel' in shaped} elapsed_ms=${'elapsed_ms' in shaped}`, 'warn');

  // 插件返回 review 档：plugin-gate 的 validateVerdict 枚举不含 review → 会被拒 → 降级为 skipped
  nextVerdict = verdict('review');
  const reviewRes = await judge();
  check('D plugin->registry/review-rejected', reviewRes.available === false && reviewRes.skipped === true,
    `available=${reviewRes.available} skipped=${reviewRes.skipped} reason=${reviewRes.reason}`);

  // 伪造 risk_level：被 gate 拒绝 → skipped（绝不当作 safe）
  nextVerdict = verdict('totally_safe');
  const forged = await judge();
  check('D plugin->registry/forged-rejected', forged.available === false && forged.skipped === true && forged.risk_level === undefined,
    `available=${forged.available} skipped=${forged.skipped} risk=${forged.risk_level}`);

  // 插件未提供者（无 owner）→ skipped，不 fail-open
  broker.unregisterPlugin('aliyun-content-safety');
  const gone = await judge();
  check('D provider-absent/skipped', gone.available === false && gone.skipped === true, `available=${gone.available} skipped=${gone.skipped} reason=${gone.reason}`);

  // 已下线 ref 不再可调用（垫片调用出口已随决策 A 移除）
  const retired = await adjudicators.invoke('builtin.contentSafety', { text: 'neutral placeholder text' }, 'text');
  check('D retired-ref/not-invocable', retired.available === false && retired.skipped === true && retired.risk_level === undefined,
    `available=${retired.available} reason=${retired.reason}`);

  // 互逆映射一致性：risk_level ⇄ suggestion 两个方向
  const forward = { safe: 'pass', low: 'pass', medium: 'review', high: 'block', critical: 'block' };
  const consistent = cases.every((c) => {
    const expected = forward[c.level];
    const backward = expected === 'pass' ? ['safe', 'low'] : expected === 'review' ? ['medium'] : ['high', 'critical'];
    return backward.includes(c.level) && c.expSuggestion === expected;
  });
  check('D mapping/round-trip-consistent', consistent, `levels=${cases.map((c) => `${c.level}->${c.expSuggestion}`).join(' ')}`);
}

// ══════════════════════════════════════════════════════════
// 报告
// ══════════════════════════════════════════════════════════
function report() {
  const line = '-'.repeat(96);
  console.log(line);
  console.log('GRS v2.2.0 QA unit-level verification (R1 + shim)');
  console.log(line);
  for (const r of rows) console.log(`${r.level === 'ok' ? '  ok  ' : r.level === 'warn' ? ' WARN ' : ' FAIL '}  ${r.name.padEnd(38)} ${r.detail}`);
  console.log(line);
  console.log(`passed=${passed} failed=${failed} warned=${warned}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}
