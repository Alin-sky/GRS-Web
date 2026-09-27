#!/usr/bin/env node
/**
 * QA 冷启动验证（scripts/qa-coldstart.js）—— T05 / R6
 *
 * 「别人电脑能不能跑起来」三种场景，每种都必须：
 *   ① 服务能启动（GET /health 200）
 *   ② 完成一次正常审核（mock 判定 safe → passed=true）
 *   ③ 完成一次 fail-closed 路径（mock 500 → error=true / fail_closed=true）
 *
 * 场景：
 *   S1 删掉全部 optionalDependencies  → 屏蔽 @alicloud/green20220302（preload 模拟未安装）
 *   S2 plugins/ 只留 1 个插件         → 只暴露 wd14-tagger
 *   S3 plugins.enabled = false        → 插件系统整体关闭
 *
 * 不修改 src/ public/ plugins/；不写 config/default.json（preload 拦截）；审计按标记回收。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.QA_CS_PORT || 11554);
const TAG = `qa-cold-${Date.now().toString(36)}`;
const ADMIN_PASS = 'qa-pass';
const PRELOAD = path.join(__dirname, 'qa-runtime-preload.js');
const CFG_BACKUP = path.join(PROJECT_ROOT, '.workbuddy', 'tmp', '_qa_config_backup_cs.json');
const STATE_BACKUP = path.join(PROJECT_ROOT, '.workbuddy', 'tmp', '_qa_plugins_state_backup_cs.json');

// T11 审计目录隔离：本脚本（含 --child 子进程）绝不读-改-写生产 `data/audit_records/`。
//   必须在任何 src 模块被 require 之前设置（audit-store 在加载期即解析该目录）；
//   子进程用 `Object.assign({}, process.env, …)` 继承，故只需在父进程设置一次。
const AUDIT_DIR = process.env.GRS_AUDIT_DIR || path.join(os.tmpdir(), `grs-audit-qacs-${process.pid}`);
process.env.GRS_AUDIT_DIR = AUDIT_DIR;
fs.mkdirSync(AUDIT_DIR, { recursive: true });

const SAFE = { risk_level: 'safe', categories: [], category_scores: {}, confidence: 0.95, reason: 'mock safe', suggestion: '', policy_version: 'grs-policy-1' };

// ── 子进程模式 ──
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
  if (process.env.QA_PLUGINS_OFF === '1') cfg.plugins.enabled = false;
  setModelConfig('text', cfg.ollama.textModel || '');
  setModelConfig('vision', cfg.ollama.visionModel || '');
  require('../src/server.js');
  return;
}

// ── 父进程 ──
const results = [];
const add = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail || '' });

function startMock() {
  const state = { status: 200, verdict: SAFE };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qa-mock-text' }] }));
        return;
      }
      if (state.status !== 200) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'qa-mock', done: true, message: { role: 'assistant', content: JSON.stringify(state.verdict) }, eval_duration: 1000, total_duration: 2000000 }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

function request(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method, timeout: 30000,
      headers: Object.assign({ 'x-admin-password': ADMIN_PASS }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* ignore */ } resolve({ status: res.statusCode, body, json }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function waitReady(tries = 45) {
  for (let i = 0; i < tries; i++) {
    try { const r = await request('GET', '/health'); if (r.status === 200) return r; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

async function boot(mock, extraEnv) {
  const child = spawn(process.execPath, ['--require', PRELOAD, __filename, '--child'], {
    cwd: PROJECT_ROOT,
    env: Object.assign({}, process.env, extraEnv, {
      QA_GUARD_CONFIG_WRITE: '1',
      MOD_PORT: String(PORT),
      OLLAMA_HOST: `http://127.0.0.1:${mock.port}`,
      OLLAMA_TEXT_MODEL: 'qa-mock-text',
      OLLAMA_VISION_MODEL: 'qa-mock-text',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += String(c); });
  const health = await waitReady();
  return { child, health, stderrOf: () => stderr };
}
function stop(child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }

function auditFilePath() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(AUDIT_DIR, `${ymd}.jsonl`);
}
function purgeTaggedAuditRecords() {
  const file = auditFilePath();
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf-8');
    const trailing = raw.endsWith('\n');
    const kept = []; let removed = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) { kept.push(line); continue; }
      if (line.includes(TAG)) { removed += 1; continue; }
      kept.push(line);
    }
    if (removed > 0) { let out = kept.join('\n'); if (trailing && !out.endsWith('\n')) out += '\n'; fs.writeFileSync(file, out, 'utf-8'); }
    return removed;
  } catch { return -1; }
}

/** 跑一个场景：启动 → health → 正常审核 → fail-closed 审核。 */
async function runScenario(name, extraEnv, extraChecks) {
  const mock = await startMock();
  let b = null;
  try {
    b = await boot(mock, extraEnv);
    const health = b.health;
    add(`${name}/startup-health-200`, Boolean(health && health.status === 200), health ? `status=${health.status}` : 'no health response');

    const normal = await request('POST', '/api/moderate/text', { text: 'Good morning, the weather is nice today.', userId: TAG });
    add(`${name}/moderate-normal`, normal.status === 200 && normal.json && normal.json.passed === true && normal.json.error !== true,
      `http=${normal.status} passed=${normal.json && normal.json.passed} risk=${normal.json && normal.json.risk_level}`);

    mock.state.status = 500;
    const fc = await request('POST', '/api/moderate/text', { text: 'Neutral probe payload for cold-start failure path.', userId: TAG });
    const ok = fc.status === 200 && fc.json && fc.json.passed === false && fc.json.error === true && fc.json.fail_closed === true && Number(fc.json.confidence) === 0;
    add(`${name}/moderate-fail-closed`, ok,
      `http=${fc.status} passed=${fc.json && fc.json.passed} error=${fc.json && fc.json.error} fail_closed=${fc.json && fc.json.fail_closed} risk=${fc.json && fc.json.risk_level}`);

    mock.state.status = 200; // 复位，避免影响后续检查
    if (extraChecks) await extraChecks({ request, add, name });
  } finally {
    if (b) stop(b.child);
    mock.server.close();
  }
  await new Promise((r) => setTimeout(r, 600));
}

async function main() {
  const cfgPath = path.join(PROJECT_ROOT, 'config', 'default.json');
  const statePath = path.join(PROJECT_ROOT, 'data', 'plugins-state.json');
  try { fs.copyFileSync(cfgPath, CFG_BACKUP); } catch { /* ignore */ }
  try { fs.copyFileSync(statePath, STATE_BACKUP); } catch { /* ignore */ }
  const cfgHashBefore = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf-8') : '';

  // S1：删掉全部 optionalDependencies（屏蔽 @alicloud）
  await runScenario('S1-no-optional-deps', { QA_BLOCK_OPTIONAL: '@alicloud/green20220302' }, async ({ request: req, add: a, name }) => {
    const plugins = await req('GET', '/api/plugins');
    const list = Array.isArray(plugins.json) ? plugins.json : (plugins.json && plugins.json.plugins) || [];
    const cs = list.find((p) => p.id === 'aliyun-content-safety');
    a(`${name}/aliyun-missing-deps`, cs ? cs.status === 'missing-deps' : false,
      `http=${plugins.status} count=${list.length} aliyun=${cs ? cs.status : 'not-listed'} hint=${cs ? cs.installHint : '-'}`);
  });

  // S2：plugins/ 只留 1 个插件
  await runScenario('S2-single-plugin', { QA_ONLY_PLUGIN: 'wd14-tagger' }, async ({ request: req, add: a, name }) => {
    const plugins = await req('GET', '/api/plugins');
    const list = Array.isArray(plugins.json) ? plugins.json : (plugins.json && plugins.json.plugins) || [];
    a(`${name}/only-one-plugin`, plugins.status === 200 && list.length === 1 && list[0] && list[0].id === 'wd14-tagger',
      `http=${plugins.status} count=${list.length} ids=${list.map((p) => p.id).join(',')}`);
  });

  // S3：plugins.enabled = false
  await runScenario('S3-plugins-disabled', { QA_PLUGINS_OFF: '1' }, async ({ request: req, add: a, name }) => {
    const host = await req('GET', '/api/plugins/host/status');
    const phase = host.json && (host.json.phase || (host.json.status && host.json.status.phase));
    a(`${name}/host-phase-disabled`, host.status === 200 && phase === 'disabled', `http=${host.status} phase=${phase}`);
    const mod = await req('POST', '/api/moderate/text', { text: 'Good morning, the weather is nice today.', userId: TAG });
    a(`${name}/moderate-still-works`, mod.status === 200 && mod.json && mod.json.passed === true, `http=${mod.status} passed=${mod.json && mod.json.passed}`);
  });

  const purged = purgeTaggedAuditRecords();
  try {
    if (fs.readFileSync(cfgPath, 'utf-8') !== cfgHashBefore) { fs.copyFileSync(CFG_BACKUP, cfgPath); add('cleanup/config-restored', true, 'config 曾被改动，已还原'); }
    else add('cleanup/config-untouched', true, 'config/default.json 未改动');
  } catch { /* ignore */ }
  try { fs.copyFileSync(STATE_BACKUP, statePath); } catch { /* ignore */ }

  const line = '-'.repeat(100);
  console.log(line);
  console.log('GRS v2.2.0 QA cold-start verification (R6)');
  console.log(line);
  console.log(`sandbox port=${PORT}  tag=${TAG}  audit purged=${purged}`);
  console.log(line);
  for (const r of results) console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(46)} ${r.detail}`);
  console.log(line);
  const okCount = results.filter((r) => r.ok).length;
  console.log(`passed=${okCount} failed=${results.length - okCount}`);
  console.log(okCount === results.length ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = okCount === results.length ? 0 : 1;
}

main().catch((err) => { console.log('FATAL: ' + (err && err.stack ? err.stack : String(err))); process.exitCode = 1; });
