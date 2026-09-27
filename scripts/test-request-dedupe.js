/**
 * request-dedupe 去重插件回归 —— scripts/test-request-dedupe.js
 *
 * 运行：node scripts/test-request-dedupe.js
 *
 * 覆盖：
 *   K. 内核通用 KV 服务（audit-db.kvSet/kvGet/kvClear）：往返 / TTL 过期 / 命名空间隔离 / 清理
 *   Y. 去重键（字节级 + 关键配置）：稳定性 / 改一字节即变 / 配置入键
 *   P. 插件 lookup/store 往返：命中跳过 AI、未命中放行、TTL 过期、重复标识
 *   H. 内核请求生命周期钩子：intercept 命中即短路、observe 写回；插件异常绝不阻断审核
 *
 * 隔离：GRS_AUDIT_DB / GRS_PLUGIN_* 指向 TEMP；不触网、不计费。
 * 输出：`[PASS]/[FAIL] 名称 | 详情` + `passed=N failed=M` + `OVERALL: PASS|FAIL`
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// ── 测试隔离（必须在任何 src 模块被 require 之前）──
const SANDBOX = path.join(os.tmpdir(), `grs-dedupe-${process.pid}`);
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.GRS_AUDIT_DIR = path.join(SANDBOX, 'audit_records');
process.env.GRS_AUDIT_DB = path.join(SANDBOX, 'audit.db');
process.env.GRS_BLOB_DIR = path.join(SANDBOX, 'image_blobs');
process.env.GRS_PLUGIN_CONFIG = path.join(SANDBOX, 'plugin-config.json');
process.env.GRS_PLUGIN_STATE = path.join(SANDBOX, 'plugins-state.json');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`[PASS] ${name}${detail ? ' | ' + detail : ''}`); }
  else { failed++; console.log(`[FAIL] ${name}${detail ? ' | ' + detail : ''}`); }
}

// ══════════════════════════════════════════════════════════════
// K. 内核通用 KV 服务
// ══════════════════════════════════════════════════════════════
const auditDb = require(path.join(PROJECT_ROOT, 'src', 'audit-db'));
auditDb.open();
check('K/00 audit-db 可用（node:sqlite）', auditDb.isOpen(), 'isOpen=' + auditDb.isOpen());

// K/01 往返：set 后 get 拿回同一值
auditDb.kvClear('t');
auditDb.kvSet('t', 'k1', '{"a":1}', { ttlSeconds: 60 });
const g1 = auditDb.kvGet('t', 'k1');
check('K/01 KV 往返', g1 && g1.valueJson === '{"a":1}', JSON.stringify(g1));

// K/02 TTL 未过期：now 在窗口内 → 命中
const g2 = auditDb.kvGet('t', 'k1', Date.now() + 30 * 1000);
check('K/02 TTL 未过期命中', g2 && g2.valueJson === '{"a":1}');

// K/03 TTL 过期：now 超过窗口 → null
const g3 = auditDb.kvGet('t', 'k1', Date.now() + 61 * 1000);
check('K/03 TTL 过期返回 null', g3 === null, 'got=' + JSON.stringify(g3));

// K/04 命名空间隔离：同 key 不同 ns 互不可见
auditDb.kvSet('nsA', 'shared', '"A"', { ttlSeconds: 60 });
auditDb.kvSet('nsB', 'shared', '"B"', { ttlSeconds: 60 });
const gA = auditDb.kvGet('nsA', 'shared');
const gB = auditDb.kvGet('nsB', 'shared');
check('K/04 命名空间隔离', gA && gA.valueJson === '"A"' && gB && gB.valueJson === '"B"',
  `A=${gA && gA.valueJson} B=${gB && gB.valueJson}`);

// K/05 ttlSeconds<=0 → 永不过期
auditDb.kvSet('t', 'forever', '"x"', { ttlSeconds: 0 });
const g5 = auditDb.kvGet('t', 'forever', Date.now() + 100 * 365 * 24 * 3600 * 1000);
check('K/05 ttl<=0 永不过期', g5 && g5.valueJson === '"x"');

// K/06 kvClear(ns) 只清该命名空间（注意：K/03 已惰性删除过期的 k1，故这里重新塞两个新键）
auditDb.kvSet('t', 'c1', '"1"', { ttlSeconds: 60 });
auditDb.kvSet('t', 'c2', '"2"', { ttlSeconds: 60 });
const cleared = auditDb.kvClear('t');
check('K/06 kvClear 只清本 ns', cleared >= 2 && auditDb.kvGet('nsA', 'shared') !== null
  && auditDb.kvGet('t', 'c1') === null, 'cleared=' + cleared);

// K/07 upsert：同 ns+key 覆盖，不产生重复
auditDb.kvSet('t', 'dup', '"v1"', { ttlSeconds: 60 });
auditDb.kvSet('t', 'dup', '"v2"', { ttlSeconds: 60 });
const g7 = auditDb.kvGet('t', 'dup');
check('K/07 KV upsert 覆盖', g7 && g7.valueJson === '"v2"', JSON.stringify(g7));

// K/08 DB 不可用时 kvGet/kvSet 安全降级（不抛）
let threw = false;
try {
  auditDb.close();
  auditDb.kvSet('t', 'x', '"y"', { ttlSeconds: 60 });
  const r = auditDb.kvGet('t', 'x');
  if (r !== null) threw = true; // 关闭后应返回 null
} catch { threw = true; }
check('K/08 DB 关闭后安全降级', !threw);
auditDb.open(); // 复位供后续段使用

// ══════════════════════════════════════════════════════════════
// Y. 去重键（字节级 + 关键配置）—— 纯函数，零依赖
// ══════════════════════════════════════════════════════════════
const { buildDedupeKey, createDedupe } = require(path.join(PROJECT_ROOT, 'plugins', 'request-dedupe', 'lib', 'dedupe'));

const baseDesc = { modality: 'text', text: '你好世界', images: [], cfg: { model: 'm1', strictness: 'standard', exposureMode: 'standard' } };
// Y/01 稳定性：同输入同键
check('Y/01 键稳定性', buildDedupeKey(baseDesc) === buildDedupeKey({ ...baseDesc }), buildDedupeKey(baseDesc).slice(0, 12));
// Y/02 文本改一字节即变
check('Y/02 文本字节敏感', buildDedupeKey(baseDesc) !== buildDedupeKey({ ...baseDesc, text: '你好世畇' }));
// Y/03 图片改一字节即变
const imgDesc = { modality: 'image', text: '', images: ['QUJD'], cfg: baseDesc.cfg };
check('Y/03 图片字节敏感', buildDedupeKey(imgDesc) !== buildDedupeKey({ ...imgDesc, images: ['QUJE'] }));
// Y/04 配置入键：strictness 变 → 键变
check('Y/04 配置入键(strictness)', buildDedupeKey(baseDesc) !== buildDedupeKey({ ...baseDesc, cfg: { ...baseDesc.cfg, strictness: 'strict' } }));
// Y/04b 配置入键：model 变 → 键变
check('Y/04b 配置入键(model)', buildDedupeKey(baseDesc) !== buildDedupeKey({ ...baseDesc, cfg: { ...baseDesc.cfg, model: 'm2' } }));
// Y/05 模态入键
check('Y/05 模态入键', buildDedupeKey(baseDesc) !== buildDedupeKey({ ...baseDesc, modality: 'image' }));
// Y/06 长度前缀防拼接歧义：text='ab',images=[] 与 text='a',images=['b'] 不得同键
const k1 = buildDedupeKey({ modality: 'text', text: 'ab', images: [], cfg: baseDesc.cfg });
const k2 = buildDedupeKey({ modality: 'text', text: 'a', images: ['b'], cfg: baseDesc.cfg });
check('Y/06 长度前缀防歧义', k1 !== k2);
// Y/07 键为 64 位 hex（sha256）
check('Y/07 键格式 sha256 hex', /^[0-9a-f]{64}$/.test(buildDedupeKey(baseDesc)));

// ══════════════════════════════════════════════════════════════
// P. 插件 lookup/store 逻辑（注入 fake kvStore，DI 可测）
// ══════════════════════════════════════════════════════════════
function fakeKv() {
  const m = new Map();
  return {
    _m: m,
    get(ns, k) { const e = m.get(ns + '\0' + k); return e ? { valueJson: e.valueJson, createdAt: e.createdAt, expiresAt: e.expiresAt } : null; },
    set(ns, k, v, opts) { m.set(ns + '\0' + k, { valueJson: v, opts, createdAt: Date.now(), expiresAt: null }); return true; },
    clear(ns) { let n = 0; for (const key of [...m.keys()]) if (key.startsWith(ns + '\0')) { m.delete(key); n++; } return n; },
  };
}
const fakeResult = { id: 'rec-orig-1', passed: false, action: 'block', risk_level: 'high', categories: ['pornographic'], category_scores: { pornographic: 88 }, confidence: 0.9, reason: '命中', timestamp: '2026-09-24T10:00:00.000Z' };

// P/01 store 后 lookup 命中，返回原结果 + dedup 标识
{
  const kv = fakeKv();
  const d = createDedupe({ kvStore: kv, namespace: 'request-dedupe', ttlSeconds: 600, enabled: true });
  d.store(baseDesc, fakeResult);
  const hit = d.lookup(baseDesc);
  check('P/01 命中返回原结果', hit && hit.risk_level === 'high' && hit.passed === false, JSON.stringify(hit && hit.dedup));
  check('P/01b dedup 标识', hit && hit.dedup && hit.dedup.hit === true && hit.dedup.of === 'rec-orig-1', JSON.stringify(hit && hit.dedup));
}
// P/02 未存过 → 未命中 null
{
  const kv = fakeKv();
  const d = createDedupe({ kvStore: kv, namespace: 'request-dedupe', ttlSeconds: 600, enabled: true });
  check('P/02 未命中返回 null', d.lookup(baseDesc) === null);
}
// P/03 enabled=false → lookup null 且 store false（不去重）
{
  const kv = fakeKv();
  const d = createDedupe({ kvStore: kv, namespace: 'request-dedupe', ttlSeconds: 600, enabled: false });
  const stored = d.store(baseDesc, fakeResult);
  check('P/03 关闭时不去重', stored === false && d.lookup(baseDesc) === null);
}
// P/04 kvStore 过期返回 null（模拟 TTL 到期）→ lookup null
{
  const kv = fakeKv();
  const d = createDedupe({ kvStore: kv, namespace: 'request-dedupe', ttlSeconds: 600, enabled: true });
  d.store(baseDesc, fakeResult);
  kv.get = () => null;   // 模拟已过期/被清
  check('P/04 过期后未命中', d.lookup(baseDesc) === null);
}
// P/05 store 把 ttlSeconds 透传给 kvStore
{
  const kv = fakeKv();
  const d = createDedupe({ kvStore: kv, namespace: 'request-dedupe', ttlSeconds: 123, enabled: true });
  d.store(baseDesc, fakeResult);
  const entry = kv._m.get('request-dedupe\0' + buildDedupeKey(baseDesc));
  check('P/05 TTL 透传', entry && entry.opts && entry.opts.ttlSeconds === 123, JSON.stringify(entry && entry.opts));
}
// P/06 不同输入不串味：另一条文本 lookup 不命中前一条
{
  const kv = fakeKv();
  const d = createDedupe({ kvStore: kv, namespace: 'request-dedupe', ttlSeconds: 600, enabled: true });
  d.store(baseDesc, fakeResult);
  check('P/06 不同输入不串味', d.lookup({ ...baseDesc, text: '完全不同的内容' }) === null);
}
// P/07 kvStore 抛异常 → fail-open（lookup null，store false，绝不冒泡）
{
  const kv = { get() { throw new Error('boom'); }, set() { throw new Error('boom'); }, clear() { return 0; } };
  const d = createDedupe({ kvStore: kv, namespace: 'request-dedupe', ttlSeconds: 600, enabled: true });
  let threw = false;
  let lk; let st;
  try { lk = d.lookup(baseDesc); st = d.store(baseDesc, fakeResult); } catch { threw = true; }
  check('P/07 KV 异常 fail-open', !threw && lk === null && st === false);
}

// ══════════════════════════════════════════════════════════════
// H. 内核请求生命周期钩子（事件注册表 + broker 非 verdict-gate 派发 + fail-open）
// ══════════════════════════════════════════════════════════════
const eventRegistry = require(path.join(PROJECT_ROOT, 'src', 'host-api', 'event-registry'));
const broker = require(path.join(PROJECT_ROOT, 'src', 'capability-broker'));

// H/01 注册表含两个生命周期事件，模式正确
check('H/01 intercept 事件=first', eventRegistry.modeOf(eventRegistry.EVENTS.REQUEST_INTERCEPT) === 'first',
  'event=' + eventRegistry.EVENTS.REQUEST_INTERCEPT);
check('H/01b observe 事件=collect', eventRegistry.modeOf(eventRegistry.EVENTS.VERDICT_OBSERVE) === 'collect',
  'event=' + eventRegistry.EVENTS.VERDICT_OBSERVE);

// 用 mock transport 驱动 broker（不依赖 cordis）
function mockTransport(handlers) {
  return {
    hasHandlers: (ev) => Boolean(handlers[ev] && handlers[ev].length),
    emitFirst: async (ev, ...args) => {
      for (const h of (handlers[ev] || [])) { const r = await h(...args); if (r !== undefined && r !== null) return r; }
      return undefined;
    },
    emitCollect: async (ev, ...args) => {
      const out = []; for (const h of (handlers[ev] || [])) { const r = await h(...args); if (r !== undefined && r !== null) out.push(r); } return out;
    },
    emitCall: async () => undefined,
  };
}

(async function main() {
  // H/02 无处理器 → invokeIntercept 返回 null（核心走正常审核）
  broker.setTransport(mockTransport({}));
  const r2 = await broker.invokeIntercept({ modality: 'text', text: 'x', images: [], cfg: {} });
  check('H/02 无拦截器→null', r2 === null, JSON.stringify(r2));

  // H/03 有拦截器返回缓存结果 → invokeIntercept 透传
  const cached = { id: 'c1', passed: true, risk_level: 'safe', action: 'pass', dedup: { hit: true, of: 'c1' } };
  broker.setTransport(mockTransport({ [eventRegistry.EVENTS.REQUEST_INTERCEPT]: [async () => cached] }));
  const r3 = await broker.invokeIntercept({ modality: 'text', text: 'x', images: [], cfg: {} });
  check('H/03 命中透传缓存结果', r3 && r3.id === 'c1' && r3.dedup && r3.dedup.hit === true, JSON.stringify(r3));

  // H/04 拦截器抛异常 → fail-open 返回 null（绝不阻断审核）
  broker.setTransport(mockTransport({ [eventRegistry.EVENTS.REQUEST_INTERCEPT]: [async () => { throw new Error('plugin boom'); }] }));
  const r4 = await broker.invokeIntercept({ modality: 'text', text: 'x', images: [], cfg: {} });
  check('H/04 拦截器异常 fail-open', r4 === null, JSON.stringify(r4));

  // H/05 拦截器返回非法形状（缺 risk_level/passed）→ 丢弃为 null
  broker.setTransport(mockTransport({ [eventRegistry.EVENTS.REQUEST_INTERCEPT]: [async () => ({ foo: 'bar' })] }));
  const r5 = await broker.invokeIntercept({ modality: 'text', text: 'x', images: [], cfg: {} });
  check('H/05 非法形状丢弃', r5 === null, JSON.stringify(r5));

  // H/06 notifyObserve 把 (descriptor, result) 送达观察者
  let seen = null;
  broker.setTransport(mockTransport({ [eventRegistry.EVENTS.VERDICT_OBSERVE]: [async (desc, res) => { seen = { desc, res }; }] }));
  await broker.notifyObserve({ modality: 'text', text: 'hi', images: [], cfg: {} }, { id: 'r1', risk_level: 'safe' });
  check('H/06 observe 送达', seen && seen.desc.text === 'hi' && seen.res.id === 'r1', JSON.stringify(seen && seen.res));

  // H/07 notifyObserve 观察者抛异常 → fail-open（不冒泡）
  broker.setTransport(mockTransport({ [eventRegistry.EVENTS.VERDICT_OBSERVE]: [async () => { throw new Error('obs boom'); }] }));
  let threw = false;
  try { await broker.notifyObserve({ modality: 'text', text: 'hi', images: [], cfg: {} }, { id: 'r1' }); } catch { threw = true; }
  check('H/07 observe 异常 fail-open', !threw);

  // ══════════════════════════════════════════════════════════════
  // I. 端到端集成：mock ctx 装载插件 + 真实 audit-db KV + broker 派发
  // ══════════════════════════════════════════════════════════════
  const requestDedupe = require(path.join(PROJECT_ROOT, 'plugins', 'request-dedupe', 'index.js'));
  // 真实 kvStore（包一层 audit-db，命名空间隔离 + TTL 由 audit-db 负责）
  const realKv = {
    get: (ns, k, now) => auditDb.kvGet(ns, k, now),
    set: (ns, k, v, opts) => auditDb.kvSet(ns, k, v, opts),
    clear: (ns) => auditDb.kvClear(ns),
    count: (ns) => auditDb.kvCount(ns),
  };
  auditDb.kvClear('request-dedupe');
  function mockCtx(pluginConfig) {
    const handlers = {};
    return {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: () => pluginConfig,
      inject: (key) => (key === 'kvStore' ? realKv : null),
      on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
      provide() {}, rpc() {},
      _handlers: handlers,
    };
  }
  const ctx = mockCtx({ enabled: true, ttlSeconds: 600 });
  requestDedupe(ctx);
  check('I/00 插件挂载了两个钩子',
    Array.isArray(ctx._handlers[eventRegistry.EVENTS.REQUEST_INTERCEPT])
    && Array.isArray(ctx._handlers[eventRegistry.EVENTS.VERDICT_OBSERVE]));
  // 把 broker 的 transport 接到 ctx 的处理器（模拟 cordis 派发）
  broker.setTransport({
    hasHandlers: (ev) => Boolean(ctx._handlers[ev] && ctx._handlers[ev].length),
    emitFirst: async (ev, ...args) => { for (const h of (ctx._handlers[ev] || [])) { const r = await h(...args); if (r !== undefined && r !== null) return r; } return undefined; },
    emitCollect: async (ev, ...args) => { const out = []; for (const h of (ctx._handlers[ev] || [])) { const r = await h(...args); if (r !== undefined && r !== null) out.push(r); } return out; },
    emitCall: async () => undefined,
  });

  const desc = { modality: 'text', text: '集成测试：完全相同的输入', images: [], cfg: { model: 'm1', strictness: 'standard', exposureMode: 'standard' } };
  const firstResult = { id: 'rec-int-1', passed: false, action: 'block', risk_level: 'high', categories: ['abuse'], category_scores: { abuse: 90 }, confidence: 0.95, reason: '辱骂', timestamp: '2026-09-24T10:00:00.000Z' };

  // I/01 首次未命中
  const i1 = await broker.invokeIntercept(desc);
  check('I/01 首次未命中→null', i1 === null, JSON.stringify(i1));
  // I/02 观察写缓存
  await broker.notifyObserve(desc, firstResult);
  check('I/02 写缓存后条目数=1', auditDb.kvCount('request-dedupe') === 1, 'count=' + auditDb.kvCount('request-dedupe'));
  // I/03 二次命中，返回首次结果 + dedup 标识
  const i3 = await broker.invokeIntercept(desc);
  check('I/03 二次命中', i3 && i3.risk_level === 'high' && i3.passed === false, JSON.stringify(i3 && i3.dedup));
  check('I/03b dedup.of 指向原记录', i3 && i3.dedup && i3.dedup.hit === true && i3.dedup.of === 'rec-int-1', JSON.stringify(i3 && i3.dedup));
  // I/04 不同文本不命中
  const i4 = await broker.invokeIntercept({ ...desc, text: '集成测试：不同的输入' });
  check('I/04 不同文本未命中', i4 === null);
  // I/05 改严格度（配置入键）不命中
  const i5 = await broker.invokeIntercept({ ...desc, cfg: { ...desc.cfg, strictness: 'strict' } });
  check('I/05 配置变即失效', i5 === null);
  // I/06 enabled=false 时不去重（lookup 返回 null）
  {
    const ctx2 = mockCtx({ enabled: false, ttlSeconds: 600 });
    requestDedupe(ctx2);
    broker.setTransport({
      hasHandlers: (ev) => Boolean(ctx2._handlers[ev] && ctx2._handlers[ev].length),
      emitFirst: async (ev, ...args) => { for (const h of (ctx2._handlers[ev] || [])) { const r = await h(...args); if (r !== undefined && r !== null) return r; } return undefined; },
      emitCollect: async () => [], emitCall: async () => undefined,
    });
    const i6 = await broker.invokeIntercept(desc);
    check('I/06 关闭时不命中', i6 === null);
  }

  console.log('---');
  console.log(`passed=${passed} failed=${failed}`);
  console.log(`OVERALL: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
