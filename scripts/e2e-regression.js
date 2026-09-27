/**
 * 发布前端到端回归 —— scripts/e2e-regression.js
 *
 * 运行：node scripts/e2e-regression.js
 *
 * 做法：本文件既是父进程也是子进程入口（`--child` 时作为被托管的服务进程启动）。
 *   - 父进程：起一个 mock Ollama，spawn 子进程（在独立端口上跑真实 src/server.js）
 *   - 子进程：先把内存配置改成「沙箱模式」（只走本地 mock，云端与内容安全一律关闭），
 *             再 require src/server.js —— 因此**不会**打到线上真实 API；对 config/default.json 的写入
 *             由 QA 守卫（`QA_GUARD_CONFIG_WRITE` + qa-runtime-preload）**强制拦截**，不靠自觉
 *
 * 覆盖（发布前最后一道自检）：
 *   ① 服务能正常启动，GET /health 返回 200 且带 channels / conflicts
 *   ② 文本审核接口正常：正常内容不被误伤；模型判定违规时能拦
 *   ③ 图片审核接口可用；无图片通道时优雅跳过（返回 200 + 明确原因，而不是报错）
 *   ④ 统计 / 日志 / 分类 / 阈值接口正常
 *   ⑤ 插件接口正常（不 5xx）
 *   ⑥ 审核产生的审计记录按测试标记回收，不污染生产数据
 *
 * 输出纯 ASCII。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const SANDBOX_PORT = Number(process.env.E2E_PORT || 11552);
const TEST_TAG = `e2e-probe-${Date.now().toString(36)}`;

// T11 审计目录隔离：本脚本（含 --child 子进程）**绝不**读-改-写生产
//   `data/audit_records/`。2026-09-16 的审计文件损坏事故根因之一就是「测试把生产
//   审计文件纳入读写作用域」。改为指向临时目录后，测试的写/清只发生在 TEMP。
//   必须在任何 src 模块被 require 之前设置（audit-store 在加载期即解析该目录）。
const AUDIT_DIR = process.env.GRS_AUDIT_DIR || path.join(os.tmpdir(), `grs-audit-e2e-${process.pid}`);
process.env.GRS_AUDIT_DIR = AUDIT_DIR;
fs.mkdirSync(AUDIT_DIR, { recursive: true });

// v0.2.0：同理隔离两个**新增**写路径 —— 审核记录 DB 投影（data/audit.db）与图片内容寻址
//   落盘（data/image_blobs/）。本脚本的图片用例会真的走一遍审核 ⇒ 若不隔离，
//   子进程启动即建生产 audit.db、图片用例即向生产 image_blobs/ 落盘。
const E2E_DB = process.env.GRS_AUDIT_DB || path.join(os.tmpdir(), `grs-e2e-${process.pid}`, 'audit.db');
const E2E_BLOBS = process.env.GRS_BLOB_DIR || path.join(os.tmpdir(), `grs-e2e-${process.pid}`, 'image_blobs');
process.env.GRS_AUDIT_DB = E2E_DB;
process.env.GRS_BLOB_DIR = E2E_BLOBS;
fs.mkdirSync(path.dirname(E2E_DB), { recursive: true });
fs.mkdirSync(E2E_BLOBS, { recursive: true });

// v0.2.0 收尾：插件「配置 / 启用状态」两个文件同样隔离。本脚本会调插件接口（toggle / config），
//   若不隔离，子进程会改写用户真实的 `data/plugin-config.json` 与 `data/plugins-state.json`
//   —— 后者记录「哪些插件被启用」，被测试改写=**静默改变用户的插件启用状态**。
const E2E_PLUGIN_CFG = process.env.GRS_PLUGIN_CONFIG || path.join(os.tmpdir(), `grs-e2e-${process.pid}`, 'plugin-config.json');
const E2E_PLUGIN_STATE = process.env.GRS_PLUGIN_STATE || path.join(os.tmpdir(), `grs-e2e-${process.pid}`, 'plugins-state.json');
process.env.GRS_PLUGIN_CONFIG = E2E_PLUGIN_CFG;
process.env.GRS_PLUGIN_STATE = E2E_PLUGIN_STATE;
fs.mkdirSync(path.dirname(E2E_PLUGIN_CFG), { recursive: true });
fs.mkdirSync(path.dirname(E2E_PLUGIN_STATE), { recursive: true });

// 守卫收口：让「测试不触碰生产」由**守卫统一兜底**，而不是靠「本脚本恰好不写 config」。
//   e2e 的子进程会 require src/server.js，而服务端自身存在写 `config/default.json` 的路径
//   （插件 toggle → reconcile、流程保存等）。此前本脚本只隔离了 audit / blob / plugin-* 五类文件，
//   **没有**装 config 写守卫 —— 下一个人加一行「保存配置」的用例就会静默改写用户配置。
//   装法与 qa-t06-t08 / qa-integration 完全一致：先置开关，再 require preload
//   （preload 会 patch fs.writeFileSync/renameSync，拦下对 config/default.json 的写入；
//   内存配置照常更新，GET 仍能读回）。必须在任何 src 模块被 require 之前生效。
// 上面 5 个 GRS_* 隔离变量均已**显式**设置，preload 的兜底重定向（仅在该变量未设置时生效）
//     不会覆盖它们 ⇒ 隔离口径不变。
const PRELOAD = path.join(__dirname, 'qa-runtime-preload.js');
process.env.QA_GUARD_CONFIG_WRITE = '1';
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

const COMPLIANT = JSON.stringify({
  risk_level: 'safe',
  categories: [],
  category_scores: {},
  confidence: 0.95,
  reason: 'Everyday conversation',
  suggestion: '',
  policy_version: 'grs-policy-1',
});

const VIOLATION = JSON.stringify({
  risk_level: 'high',
  categories: ['abuse'],
  category_scores: { abuse: 88 },
  confidence: 0.92,
  reason: 'Mock model verdict: abusive language detected',
  suggestion: 'block',
  policy_version: 'grs-policy-1',
});

const IMAGE_VERDICT = JSON.stringify({
  risk_level: 'low',
  categories: [],
  category_scores: {},
  confidence: 0.7,
  reason: 'Mock vision verdict: nothing notable',
  suggestion: '',
  image_description: 'mock image',
  policy_version: 'grs-policy-1',
});

// ══════════════════════════════════════════════════════════
// 子进程模式：沙箱化配置后启动真实服务
// ══════════════════════════════════════════════════════════
if (process.argv.includes('--child')) {
  const { loadConfig, setModelConfig } = require('../src/config');
  const cfg = loadConfig();

  // 只走本地 mock：云端/内容安全一律关闭，避免真实计费与不可复现结果
  cfg.moderationMode = 'local';
  cfg.moderation.reviewChannels = {
    local: true, cloud: false, contentSafety: false, disputeStrategy: 'highest',
  };
  cfg.qwenCloud.enabled = false;
  cfg.contentSafety.enabled = false;
  cfg.moderation.dualMode = false;
  cfg.moderation.doubleCheck = false;
  cfg.logging.console = false;
  // 视觉通道必须一起指向 mock：config/default.json 里的 visionHost 仍指向真实 Ollama，
  // 不改的话图片审核会去打 127.0.0.1:11434 并因连接失败走 fail-closed（掩盖真实用例）
  cfg.ollama.visionHost = cfg.ollama.host;
  // 「没有可用图片通道」要模拟成通道被关闭，而不是只清空模型名：
  // 清空模型名仍会真的发起调用并（正确地）fail-closed，那是另一条语义。
  if (process.env.E2E_NO_IMAGE_CHANNEL === '1') cfg.moderation.reviewChannels.local = false;
  if (process.env.E2E_NO_TEXT === '1') cfg.ollama.textModel = '';

  setModelConfig('text', cfg.ollama.textModel || '');
  setModelConfig('vision', cfg.ollama.visionModel || '');

  require('../src/server.js');
  return;
}

// ══════════════════════════════════════════════════════════
// 父进程模式
// ══════════════════════════════════════════════════════════
function startMockOllama() {
  const state = { next: COMPLIANT, status: 200 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'e2e-mock-text' }, { name: 'e2e-mock-vision' }] }));
        return;
      }
      if (state.status !== 200) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'e2e-mock',
        done: true,
        message: { role: 'assistant', content: state.next },
        eval_duration: 1000,
        total_duration: 2000000,
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

/**
 * 简易 HTTP 客户端。
 * @param {string} method 方法
 * @param {string} urlPath 路径
 * @param {object} [payload] JSON 请求体
 * @returns {Promise<{status: number, body: string, json: object|null}>} 响应
 */
function request(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: SANDBOX_PORT,
      path: urlPath,
      method,
      timeout: 20000,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
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

/**
 * 等待 /health 就绪。
 * @param {number} tries 重试次数
 * @returns {Promise<object|null>} health 响应
 */
async function waitReady(tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) return res;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** 审计文件路径（当天）—— T11 起指向隔离的临时审计目录，不再是生产目录。 */
function auditFilePath() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(AUDIT_DIR, `${ymd}.jsonl`);
}

/**
 * 只删除本次回归产生的审计记录（按 userId 标记匹配），保留其它记录。
 * @returns {number} 删除条数
 */
function purgeTaggedAuditRecords() {
  const file = auditFilePath();
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf-8');
    const hadTrailingNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      if (!line.trim()) { kept.push(line); continue; }
      if (line.includes(TEST_TAG)) { removed += 1; continue; }
      kept.push(line);
    }
    if (removed > 0) {
      let out = kept.join('\n');
      if (hadTrailingNewline && !out.endsWith('\n')) out += '\n';
      fs.writeFileSync(file, out, 'utf-8');
    }
    return removed;
  } catch {
    return -1;
  }
}

/**
 * 启动一个沙箱子进程并等待就绪。
 * @param {object} mock mock 服务
 * @param {object} extraEnv 额外环境变量
 * @returns {Promise<{child: object, health: object|null}>} 子进程与 health
 */
async function bootSandbox(mock, extraEnv) {
  // `--require PRELOAD`：把 config 写守卫 + 兜底重定向带进**子进程**（服务端）。
  //   这是本次收口的实际生效点 —— 子进程才是 require src/server.js 的那一个。
  const child = spawn(process.execPath, ['--require', PRELOAD, __filename, '--child'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      MOD_PORT: String(SANDBOX_PORT),
      OLLAMA_HOST: `http://127.0.0.1:${mock.port}`,
      OLLAMA_TEXT_MODEL: 'e2e-mock-text',
      OLLAMA_VISION_MODEL: 'e2e-mock-vision',
      QA_GUARD_CONFIG_WRITE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const health = await waitReady(35);
  return { child, health };
}

/** 结束子进程。 */
function stopSandbox(child) {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════
async function main() {
  const mock = await startMockOllama();
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail || '' });

  // ── 场景 1：完整沙箱（文本 + 图片通道都可用）──
  let { child, health } = await bootSandbox(mock, {});
  try {
    add('1/health-200', Boolean(health && health.status === 200),
      health ? `status=${health.status}` : 'no response');

    if (health && health.json) {
      const j = health.json;
      const conflictIds = Array.isArray(j.conflicts) ? j.conflicts.map((c) => c.id).join(',') : 'missing';
      add('1/health-shape', j.status === 'ok' && j.channels && Array.isArray(j.conflicts),
        `status=${j.status} channels=${Boolean(j.channels)} conflicts=[${conflictIds}]`);
      add('1/health-local-available', Boolean(j.channels && j.channels.local && j.channels.local.available),
        `local=${j.channels && j.channels.local ? j.channels.local.available : '?'}`);
    }

    // ② 正常内容不被误伤
    mock.state.next = COMPLIANT;
    const normal = await request('POST', '/api/moderate/text', {
      text: 'Good morning, the weather is nice today.', userId: TEST_TAG,
    });
    add('2/text-normal-not-blocked',
      normal.status === 200 && normal.json && normal.json.passed === true,
      `http=${normal.status} passed=${normal.json ? normal.json.passed : '?'} action=${normal.json ? normal.json.action : '?'}`);

    // ② 违规内容能拦（模型判定 high → action block）
    mock.state.next = VIOLATION;
    const bad = await request('POST', '/api/moderate/text', {
      text: 'Probe payload reserved for mock verdict testing.', userId: TEST_TAG,
    });
    add('2/text-violation-blocked',
      bad.status === 200 && bad.json && bad.json.passed === false,
      `http=${bad.status} passed=${bad.json ? bad.json.passed : '?'} action=${bad.json ? bad.json.action : '?'} risk=${bad.json ? bad.json.risk_level : '?'}`);

    // ③ 图片审核可用
    mock.state.next = IMAGE_VERDICT;
    const img = await request('POST', '/api/moderate/image', {
      image: 'aGVsbG8gZ3JzIGUyZSBwcm9iZQ==', text: 'probe caption', userId: TEST_TAG,
    });
    add('3/image-endpoint-ok',
      img.status === 200 && img.json && typeof img.json.risk_level === 'string',
      `http=${img.status} risk=${img.json ? img.json.risk_level : '?'} action=${img.json ? img.json.action : '?'}`);

    // ④ 统计 / 日志 / 分类 / 阈值
    const stats = await request('GET', '/api/stats/summary?days=1');
    add('4/stats-summary-ok',
      stats.status === 200 && stats.json && stats.json.injection
        && typeof stats.json.injection.suspicious_injection === 'number',
      `http=${stats.status} injection=${stats.json && stats.json.injection ? JSON.stringify(stats.json.injection) : 'missing'}`);

    const logs = await request('GET', '/api/logs');
    add('4/logs-endpoint-ok', logs.status === 200, `http=${logs.status}`);

    const cats = await request('GET', '/api/categories');
    add('4/categories-endpoint-ok', cats.status === 200 && Array.isArray(cats.json), `http=${cats.status}`);

    const thresholds = await request('GET', '/api/thresholds');
    add('4/thresholds-endpoint-ok', thresholds.status === 200, `http=${thresholds.status}`);

    // ⑤ 插件接口不 5xx
    const plugins = await request('GET', '/api/plugins');
    add('5/plugins-endpoint-not-5xx', plugins.status < 500, `http=${plugins.status}`);
  } finally {
    stopSandbox(child);
  }

  await new Promise((r) => setTimeout(r, 800));

  // ── 场景 2：无图片通道 → 图片审核优雅跳过 ──
  ({ child } = await bootSandbox(mock, { E2E_NO_IMAGE_CHANNEL: '1' }));
  try {
    const ready = await request('GET', '/health');
    add('6/no-image-channel/health-200', ready.status === 200, `http=${ready.status}`);

    mock.state.next = IMAGE_VERDICT;
    const imgSkip = await request('POST', '/api/moderate/image', {
      image: 'aGVsbG8gZ3JzIGUyZSBwcm9iZQ==', text: '', userId: TEST_TAG,
    });
    const skipped = imgSkip.status === 200 && imgSkip.json
      && imgSkip.json.passed === true && imgSkip.json.error !== true;
    add('6/no-image-channel/graceful-skip', skipped,
      `http=${imgSkip.status} passed=${imgSkip.json ? imgSkip.json.passed : '?'} error=${imgSkip.json ? imgSkip.json.error : '?'} risk=${imgSkip.json ? imgSkip.json.risk_level : '?'}`);
  } finally {
    stopSandbox(child);
  }

  await new Promise((r) => setTimeout(r, 800));

  // ── 场景 3：无文本通道 → 文本审核退回预检（合法降级，不崩）──
  ({ child } = await bootSandbox(mock, { E2E_NO_TEXT: '1' }));
  try {
    const ready = await request('GET', '/health');
    add('7/no-text/health-200', ready.status === 200, `http=${ready.status}`);

    const deg = await request('POST', '/api/moderate/text', {
      text: 'Good morning, the weather is nice today.', userId: TEST_TAG,
    });
    add('7/no-text/text-degrades-not-500',
      deg.status === 200 && deg.json && typeof deg.json.risk_level === 'string',
      `http=${deg.status} passed=${deg.json ? deg.json.passed : '?'} degraded=${deg.json ? deg.json.degraded : '?'}`);
  } finally {
    stopSandbox(child);
  }

  mock.server.close();

  const purged = purgeTaggedAuditRecords();

  // ── 报告 ──
  const line = '-'.repeat(96);
  console.log(line);
  console.log('GRS end-to-end regression (publish gate)');
  console.log(line);
  console.log(`sandbox port=${SANDBOX_PORT}  test tag=${TEST_TAG}`);
  console.log(line);
  console.log('RESULT  CHECK                                    DETAIL');
  console.log(line);
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(40)} ${r.detail}`);
  }
  console.log(line);
  const okCount = results.filter((r) => r.ok).length;
  console.log(`passed=${okCount} failed=${results.length - okCount}`);
  console.log(`audit records tagged and purged: ${purged}`);
  console.log(okCount === results.length ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = okCount === results.length ? 0 : 1;
}

main().catch((err) => {
  console.log('FATAL: ' + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 1;
});
