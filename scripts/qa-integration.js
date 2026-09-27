#!/usr/bin/env node
/**
 * QA 集成 / 失败注入验证（scripts/qa-integration.js）—— T05 / R2 + R4
 *
 * 做法与 scripts/e2e-regression.js 同构：本文件既是父进程也是子进程入口。
 *   - 父进程：起一个 mock Ollama（可切换 500 / 坏 JSON / 伪造 risk_level / 延迟），
 *             spawn 子进程跑真实 src/server.js（独立端口 + 沙箱配置）
 *   - 子进程：把内存配置改成沙箱模式后再 require src/server.js
 *             （不写 config/default.json：QA_GUARD_CONFIG_WRITE=1 由 preload 拦截）
 *
 * R2：/api/moderate/text 在 4 种拓扑下端到端正确；拓扑保存/读回往返一致；非法拓扑 400 且零写入
 * R4：http500 / 断网 / 超时 / 非法 JSON / 伪造 risk_level → fail-closed；
 *     全 skipped → 合法降级而非放行；skipped ≠ safe
 *
 * 不修改 src/ public/ plugins/；不写 config/default.json；审计记录按标记回收。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const SANDBOX_PORT = Number(process.env.QA_PORT || 11553);
const TEST_TAG = `qa-int-${Date.now().toString(36)}`;
const ADMIN_PASS = 'qa-pass';
const PRELOAD = path.join(__dirname, 'qa-runtime-preload.js');
const CFG_BACKUP = path.join(PROJECT_ROOT, '.workbuddy', 'tmp', '_qa_config_backup.json');
const STATE_BACKUP = path.join(PROJECT_ROOT, '.workbuddy', 'tmp', '_qa_plugins_state_backup.json');

// T11 审计目录隔离：本脚本（含 --child 子进程）绝不读-改-写生产 `data/audit_records/`。
//   必须在任何 src 模块被 require 之前设置（audit-store 在加载期即解析该目录）；
//   子进程用 `...process.env` 继承，故只需在父进程设置一次。
const AUDIT_DIR = process.env.GRS_AUDIT_DIR || path.join(os.tmpdir(), `grs-audit-qaint-${process.pid}`);
process.env.GRS_AUDIT_DIR = AUDIT_DIR;
fs.mkdirSync(AUDIT_DIR, { recursive: true });

const V = {
  safe: { risk_level: 'safe', categories: [], category_scores: {}, confidence: 0.95, reason: 'mock safe', suggestion: '', policy_version: 'grs-policy-1' },
  low: { risk_level: 'low', categories: [], category_scores: {}, confidence: 0.8, reason: 'mock low', suggestion: '', policy_version: 'grs-policy-1' },
  medium: { risk_level: 'medium', categories: ['marketing'], category_scores: { marketing: 55 }, confidence: 0.8, reason: 'mock medium', suggestion: '', policy_version: 'grs-policy-1' },
  high: { risk_level: 'high', categories: ['abuse'], category_scores: { abuse: 88 }, confidence: 0.92, reason: 'mock high', suggestion: 'block', policy_version: 'grs-policy-1' },
  forged: { risk_level: 'totally_safe', categories: [], category_scores: {}, confidence: 0.99, reason: 'forged', suggestion: '', policy_version: 'grs-policy-1' },
};

// ══════════════════════════════════════════════════════════
// 子进程模式：沙箱化配置后启动真实服务
// ══════════════════════════════════════════════════════════
if (process.argv.includes('--child')) {
  const { loadConfig, setModelConfig } = require('../src/config');
  const cfg = loadConfig();
  cfg.moderationMode = 'local';
  cfg.moderation.reviewChannels = { local: true, cloud: false, contentSafety: false, disputeStrategy: 'highest' };
  cfg.moderation.dualMode = false;
  cfg.moderation.doubleCheck = false;
  cfg.qwenCloud.enabled = false;
  cfg.contentSafety.enabled = false;
  cfg.logging.console = false;
  cfg.ollama.visionHost = cfg.ollama.host;
  cfg.adminPassword = ADMIN_PASS;
  if (process.env.QA_NO_LOCAL === '1') {
    cfg.moderation.reviewChannels.local = false;
    cfg.ollama.textModel = '';
    cfg.ollama.visionModel = '';
  }
  setModelConfig('text', cfg.ollama.textModel || '');
  setModelConfig('vision', cfg.ollama.visionModel || '');
  require('../src/server.js');
  return;
}

// ══════════════════════════════════════════════════════════
// 父进程
// ══════════════════════════════════════════════════════════
const results = [];
const add = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail || '' });

/** 启动 mock Ollama。 */
function startMock() {
  const state = { status: 200, verdict: V.safe, contentRaw: null, delayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qa-mock-text' }, { name: 'qa-mock-vision' }] }));
        return;
      }
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.status !== 200) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock error' }));
        return;
      }
      const content = state.contentRaw != null ? state.contentRaw : JSON.stringify(state.verdict);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'qa-mock', done: true, message: { role: 'assistant', content }, eval_duration: 1000, total_duration: 2000000 }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

/** HTTP 请求。 */
function request(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: SANDBOX_PORT,
      path: urlPath,
      method,
      timeout: 30000,
      headers: Object.assign(
        { 'x-admin-password': ADMIN_PASS },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      ),
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

/** 等待 /health 就绪。 */
async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await request('GET', '/health'); if (r.status === 200) return r; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

/** 当天审计文件（T11 起为隔离的临时审计目录，非生产目录）。 */
function auditFilePath() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(AUDIT_DIR, `${ymd}.jsonl`);
}

/** 回收本次测试的审计记录。 */
function purgeTaggedAuditRecords() {
  const file = auditFilePath();
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf-8');
    const trailing = raw.endsWith('\n');
    const kept = [];
    let removed = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) { kept.push(line); continue; }
      if (line.includes(TEST_TAG)) { removed += 1; continue; }
      kept.push(line);
    }
    if (removed > 0) {
      let out = kept.join('\n');
      if (trailing && !out.endsWith('\n')) out += '\n';
      fs.writeFileSync(file, out, 'utf-8');
    }
    return removed;
  } catch { return -1; }
}

/** 启动沙箱子进程。 */
async function boot(mock, extraEnv) {
  const child = spawn(process.execPath, ['--require', PRELOAD, __filename, '--child'], {
    cwd: PROJECT_ROOT,
    env: Object.assign({}, process.env, extraEnv, {
      QA_GUARD_CONFIG_WRITE: '1',
      MOD_PORT: String(SANDBOX_PORT),
      OLLAMA_HOST: `http://127.0.0.1:${mock.port}`,
      OLLAMA_TEXT_MODEL: 'qa-mock-text',
      OLLAMA_VISION_MODEL: 'qa-mock-vision',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const health = await waitReady();
  return { child, health };
}

function stop(child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }

/** 造文本流程 JSON。 */
function textFlow(nodes, edges, floors) {
  return { schemaVersion: 1, modality: 'text', revision: 1, updatedAt: new Date().toISOString(), floors: floors || [], nodes, edges, finalizers: [], meta: { note: '', sourceOfTruth: true } };
}
const IN = { id: 'in', type: 'input', position: { x: 0, y: 0 } };
const OUT = { id: 'out', type: 'output', position: { x: 0, y: 400 } };
const loc = (id, timeoutMs) => Object.assign({ id, type: 'service', ref: 'builtin.localModel', params: { model: '', useSafeguardPrompt: false }, failurePolicy: 'inherit' }, Number.isFinite(timeoutMs) ? { timeoutMs } : {});
const eg = (i, from, to, priority) => {
  const e = { id: `e${i}`, from, to };
  if (Number.isFinite(priority)) e.priority = priority;
  return e;
};

const TOPO = {
  serial: () => textFlow([IN, loc('loc'), OUT], [eg(1, 'in', 'loc'), eg(2, 'loc', 'out')]),
  chain: () => textFlow([IN, loc('a'), loc('b'), OUT], [eg(1, 'in', 'a'), eg(2, 'a', 'b'), eg(3, 'b', 'out')]),
  fanout: () => textFlow([IN, loc('a'), loc('b'), { id: 'mg', type: 'merge', strategy: 'highest', branchOrder: ['a', 'b'] }, OUT],
    [eg(1, 'in', 'a'), eg(2, 'in', 'b'), eg(3, 'a', 'mg', 10), eg(4, 'b', 'mg', 20), eg(5, 'mg', 'out')]),
  multimerge: () => textFlow([IN, loc('a'), loc('b'), loc('c'), loc('d'),
    { id: 'm1', type: 'merge', strategy: 'highest', branchOrder: ['a', 'b'] },
    { id: 'm2', type: 'merge', strategy: 'highest', branchOrder: ['c', 'd'] },
    { id: 'm3', type: 'merge', strategy: 'highest', branchOrder: ['m1', 'm2'] }, OUT],
  [eg(1, 'in', 'a'), eg(2, 'in', 'b'), eg(3, 'in', 'c'), eg(4, 'in', 'd'),
    eg(5, 'a', 'm1', 10), eg(6, 'b', 'm1', 20), eg(7, 'c', 'm2', 10), eg(8, 'd', 'm2', 20),
    eg(9, 'm1', 'm3', 10), eg(10, 'm2', 'm3', 20), eg(11, 'm3', 'out')]),
  /** 部分失败：loc1 超时（100ms），loc2 正常（5000ms）；mock 延迟 700ms */
  partialFail: () => textFlow([IN, loc('a', 100), loc('b', 5000), { id: 'mg', type: 'merge', strategy: 'highest', branchOrder: ['a', 'b'] }, OUT],
    [eg(1, 'in', 'a'), eg(2, 'in', 'b'), eg(3, 'a', 'mg', 10), eg(4, 'b', 'mg', 20), eg(5, 'mg', 'out')]),
  /** 超时：单节点 100ms，mock 延迟 700ms */
  timeout: () => textFlow([IN, loc('loc', 100), OUT], [eg(1, 'in', 'loc'), eg(2, 'loc', 'out')]),
  /** 非法：成环 */
  cycle: () => textFlow([IN, loc('a'), loc('b'), OUT], [eg(1, 'in', 'a'), eg(2, 'a', 'b'), eg(3, 'b', 'a'), eg(4, 'b', 'out')]),
};

/** PUT 一个拓扑。 */
async function putFlow(flow) { return request('PUT', '/api/flow/text', { flow }); }
/** 审核一条中性文本。 */
async function moderate(text) { return request('POST', '/api/moderate/text', { text, userId: TEST_TAG }); }

/** 断言 fail-closed 形状（onAiFailure=block → risk=high/action=block；review 策略 → review）。 */
function isFailClosed(r) {
  return Boolean(r)
    && r.passed === false
    && r.error === true
    && r.fail_closed === true
    && Number(r.confidence) === 0
    && (r.risk_level === 'high' || r.risk_level === 'review')
    && (r.action === 'block' || r.action === 'review');
}

async function main() {
  // 备份（双保险）
  const cfgPath = path.join(PROJECT_ROOT, 'config', 'default.json');
  const statePath = path.join(PROJECT_ROOT, 'data', 'plugins-state.json');
  try { fs.copyFileSync(cfgPath, CFG_BACKUP); } catch { /* ignore */ }
  try { fs.copyFileSync(statePath, STATE_BACKUP); } catch { /* ignore */ }
  const cfgHashBefore = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf-8') : '';

  const mock = await startMock();
  let { child, health } = await boot(mock, {});

  try {
    add('R2/health-200', Boolean(health && health.status === 200), health ? `status=${health.status}` : 'no response');

    // ── R2：4 种拓扑端到端 ──
    const cases = [
      { name: 'serial', flow: TOPO.serial(), verdict: V.safe, expect: 'safe' },
      { name: 'chain', flow: TOPO.chain(), verdict: V.high, expect: 'high' },
      { name: 'fanout', flow: TOPO.fanout(), verdict: V.medium, expect: 'medium' },
      { name: 'multimerge', flow: TOPO.multimerge(), verdict: V.low, expect: 'low' },
    ];
    for (const c of cases) {
      mock.state.status = 200; mock.state.contentRaw = null; mock.state.delayMs = 0;
      mock.state.verdict = c.verdict;
      // eslint-disable-next-line no-await-in-loop
      const put = await putFlow(c.flow);
      add(`R2/${c.name}/save-200`, put.status === 200 && put.json && put.json.ok === true, `http=${put.status} ${put.json && put.json.error ? put.json.error : ''}`);
      // eslint-disable-next-line no-await-in-loop
      const m = await moderate('Good morning, the weather is nice today.');
      const ok = m.status === 200 && m.json && m.json.risk_level === c.expect && Array.isArray(m.json.node_traces);
      add(`R2/${c.name}/moderate-risk`, ok, `http=${m.status} risk=${m.json && m.json.risk_level} exp=${c.expect} traces=${m.json && m.json.node_traces ? m.json.node_traces.length : '?'}`);
    }

    // ── R2：往返一致 ──
    {
      const flow = TOPO.fanout();
      await putFlow(flow);
      const got = await request('GET', '/api/flow/text');
      const gf = got.json && (got.json.flow || got.json);
      const same = gf
        && gf.nodes.length === flow.nodes.length
        && gf.edges.length === flow.edges.length
        && (gf.nodes.find((n) => n.id === 'mg') || {}).strategy === 'highest'
        && gf.nodes.every((n) => flow.nodes.some((x) => x.id === n.id && x.type === n.type));
      add('R2/roundtrip/nodes&edges&strategy', Boolean(same),
        `http=${got.status} nodes=${gf ? gf.nodes.length : '?'} edges=${gf ? gf.edges.length : '?'} strategy=${gf ? (gf.nodes.find((n) => n.id === 'mg') || {}).strategy : '?'} rev=${gf && gf.revision}`);
      add('R2/roundtrip/fields-present', Boolean(gf && 'floors' in gf && 'finalizers' in gf && 'meta' in gf), `floors=${gf && gf.floors ? gf.floors.length : '?'} finalizers=${gf && gf.finalizers ? gf.finalizers.length : '?'}`);
    }

    // ── R2：非法拓扑 400 且零写入 ──
    {
      const before = await request('GET', '/api/flow/text');
      const revBefore = before.json && before.json.flow ? before.json.flow.revision : null;
      const bad = await putFlow(TOPO.cycle());
      add('R2/invalid-topology-400', bad.status === 400 && bad.json && (bad.json.errors || []).some((e) => e.code === 'E005_CYCLE'),
        `http=${bad.status} codes=${bad.json && bad.json.errors ? bad.json.errors.map((e) => e.code).join(',') : '?'}`);
      const after = await request('GET', '/api/flow/text');
      const revAfter = after.json && after.json.flow ? after.json.flow.revision : null;
      add('R2/invalid-topology-zero-write', revBefore === revAfter, `revBefore=${revBefore} revAfter=${revAfter}`);
    }

    // ── R4：http500 / 非法 JSON / 伪造 risk_level ──
    await putFlow(TOPO.serial());
    {
      mock.state.contentRaw = null; mock.state.delayMs = 0; mock.state.verdict = V.safe;
      mock.state.status = 500;
      const r = await moderate('Neutral probe payload for mock failure testing.');
      add('R4/http500-fail-closed', r.status === 200 && isFailClosed(r.json),
        `http=${r.status} passed=${r.json && r.json.passed} error=${r.json && r.json.error} risk=${r.json && r.json.risk_level} conf=${r.json && r.json.confidence}`);

      mock.state.status = 200; mock.state.contentRaw = 'this is definitely not json <<<';
      const r2 = await moderate('Neutral probe payload for mock failure testing.');
      add('R4/bad-json-fail-closed', r2.status === 200 && isFailClosed(r2.json),
        `http=${r2.status} passed=${r2.json && r2.json.passed} error=${r2.json && r2.json.error} risk=${r2.json && r2.json.risk_level}`);

      mock.state.contentRaw = null; mock.state.verdict = V.forged;
      const r3 = await moderate('Neutral probe payload for mock failure testing.');
      add('R4/forged-risk-level-fail-closed', r3.status === 200 && isFailClosed(r3.json),
        `http=${r3.status} passed=${r3.json && r3.json.passed} error=${r3.json && r3.json.error} risk=${r3.json && r3.json.risk_level}`);
      mock.state.verdict = V.safe;
    }

    // ── R4：超时 ──
    {
      mock.state.status = 200; mock.state.contentRaw = null; mock.state.verdict = V.safe; mock.state.delayMs = 700;
      await putFlow(TOPO.timeout());
      const r = await moderate('Neutral probe payload for mock timeout testing.');
      const t = r.json && Array.isArray(r.json.node_traces) ? r.json.node_traces.find((x) => x.node_id === 'loc') : null;
      add('R4/timeout-fail-closed', r.status === 200 && isFailClosed(r.json),
        `http=${r.status} passed=${r.json && r.json.passed} risk=${r.json && r.json.risk_level} traceStatus=${t && t.status} failureType=${t && t.failure_type}`);

      // ── R4：部分分支 failed ⇒ 整体 fail-closed ──
      await putFlow(TOPO.partialFail());
      const p = await moderate('Neutral probe payload for mock partial-failure testing.');
      const tc = p.json && Array.isArray(p.json.node_traces) ? p.json.node_traces.map((x) => `${x.node_id}:${x.status}`).join(',') : '?';
      add('R4/partial-failed-fail-closed', p.status === 200 && isFailClosed(p.json),
        `http=${p.status} passed=${p.json && p.json.passed} risk=${p.json && p.json.risk_level} traces=[${tc}]`);
      mock.state.delayMs = 0;
    }

    // ── R4：断网（关掉 mock 后再审一次）──
    {
      mock.state.delayMs = 0; mock.state.status = 200; mock.state.contentRaw = null; mock.state.verdict = V.safe;
      await putFlow(TOPO.serial());
      await new Promise((r) => { mock.server.close(() => r()); });
      const r = await moderate('Neutral probe payload for network failure testing.');
      add('R4/network-refused-fail-closed', r.status === 200 && isFailClosed(r.json),
        `http=${r.status} passed=${r.json && r.json.passed} error=${r.json && r.json.error} risk=${r.json && r.json.risk_level} fail_closed=${r.json && r.json.fail_closed}`);
    }
  } finally {
    stop(child);
  }

  await new Promise((r) => setTimeout(r, 600));

  // ── R4：全 skipped → 合法降级（而非放行）──
  {
    const mock2 = await startMock();
    let b2;
    try {
      b2 = await boot(mock2, { QA_NO_LOCAL: '1' });
      const r = await moderate('Good morning, the weather is nice today.');
      const j = r.json || {};
      const degraded = r.status === 200 && j.passed === true && j.error !== true && j.risk_level !== 'safe' && j.action === 'pass_log' && Number(j.confidence) === 0;
      add('R4/all-skipped-degraded-not-pass-safe', degraded,
        `http=${r.status} passed=${j.passed} error=${j.error} risk=${j.risk_level} action=${j.action} conf=${j.confidence}`);
      add('R4/skipped-is-never-safe', j.risk_level !== 'safe', `risk=${j.risk_level}`);
    } finally {
      if (b2) stop(b2.child);
      mock2.server.close();
    }
  }

  const purged = purgeTaggedAuditRecords();

  // 还原（双保险；child 已被 guard 拦截，理论上文件未变）
  try {
    if (fs.readFileSync(cfgPath, 'utf-8') !== cfgHashBefore) {
      fs.copyFileSync(CFG_BACKUP, cfgPath);
      add('cleanup/config-restored', true, 'config/default.json 曾被改动，已还原');
    } else {
      add('cleanup/config-untouched', true, 'config/default.json 未改动');
    }
  } catch { /* ignore */ }
  try { fs.copyFileSync(STATE_BACKUP, statePath); } catch { /* ignore */ }

  // 报告
  const line = '-'.repeat(100);
  console.log(line);
  console.log('GRS v2.2.0 QA integration / failure-injection (R2 + R4)');
  console.log(line);
  console.log(`sandbox port=${SANDBOX_PORT}  tag=${TEST_TAG}  audit purged=${purged}`);
  console.log(line);
  for (const r of results) console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(42)} ${r.detail}`);
  console.log(line);
  const okCount = results.filter((r) => r.ok).length;
  console.log(`passed=${okCount} failed=${results.length - okCount}`);
  console.log(okCount === results.length ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = okCount === results.length ? 0 : 1;
}

main().catch((err) => { console.log('FATAL: ' + (err && err.stack ? err.stack : String(err))); process.exitCode = 1; });
