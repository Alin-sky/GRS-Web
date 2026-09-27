/**
 * H1 回归 —— `PUT /api/dual-mode` 不得销毁审核拓扑
 * （scripts/test-h1-dual-mode-topology.js）
 *
 * 运行：node scripts/test-h1-dual-mode-topology.js
 *
 * ── 背景（H1，P0）──────────────────────────────────────────────────────────
 * 旧实现（v2.2.0 F17）在 `PUT /api/dual-mode` 里调用 `regenerateFlows()`，
 * 而该函数会 `delete config.moderation.flows.text / .image` 再按旧开关重新 migrate 生成
 * ⇒ 用户在「云端审核配置」卡片点一次「保存配置」，就**静默销毁整个自定义拓扑**：
 *   终裁层 `finalizers`、内容安全下限层 `floors`、全部节点位置、用户增删的节点与连线、
 *   以及 `revision`（重建后归 1）。日志文案还是「双审配置已更新」，
 * 排查时 grep「审核流程(...)已保存 revision=」根本找不到，极难定位。
 *
 * ── 本脚本用**真实服务**（沙箱端口）做三件事 ────────────────────────────────
 *   A. 预置（pre-seed）一份带「显式非空 finalizers + 自定义节点位置」的拓扑，
 *      断言预置成功（若这一步不成立，后面的断言无意义）。
 *   B. 调 `PUT /api/dual-mode`，断言 `flows.text` / `flows.image` **逐字段不变**
 *      （finalizers 非空且一致、节点位置一致、revision 一致、节点/连线数一致），
 *      并断言响应回报 `channelsManagedByTopology=true` + `channelNotice`。
 *   C. **阳性对照（受控复现）**：对同一份 seeded 拓扑执行 `POST /api/flow/image/reset`
 *      —— 它走的正是 `regenerateFlows()`（旧 dual-mode 路由调用的同一函数）⇒
 *      展示「破坏」确实发生（finalizers 清空 / revision 归 1 / 位置重置）。
 *      这一步证明 B 的断言**不是恒真**、确有辨别力（否则 B 可能只是巧合通过）。
 *
 * ── 隔离 ──────────────────────────────────────────────────────────────────
 * `GRS_AUDIT_DIR` / `GRS_AUDIT_DB` / `GRS_BLOB_DIR` / `GRS_PLUGIN_CONFIG` /
 * `GRS_PLUGIN_STATE` 全部重定向到 TEMP；`QA_GUARD_CONFIG_WRITE=1` + preload
 * 拦截任何对 `config/default.json` 的写入。**绝不触碰生产 data/ 与 config/**。
 *
 * 输出：`[PASS]/[FAIL] 名称 | 详情` + `passed=N failed=M` + `OVERALL: PASS|FAIL`。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.H1_PORT || 11561);
const BASE = `http://127.0.0.1:${PORT}`;
const CUSTOM_X0 = 9100; // 自定义节点起始坐标（迁移生成的默认拓扑绝不会用到这么大的值）

// ── 测试隔离（必须在任何 src 模块被 require 之前）──
const SANDBOX = path.join(os.tmpdir(), `grs-h1-${process.pid}`);
process.env.GRS_AUDIT_DIR = process.env.GRS_AUDIT_DIR || path.join(SANDBOX, 'audit_records');
process.env.GRS_AUDIT_DB = process.env.GRS_AUDIT_DB || path.join(SANDBOX, 'audit.db');
process.env.GRS_BLOB_DIR = process.env.GRS_BLOB_DIR || path.join(SANDBOX, 'image_blobs');
process.env.GRS_PLUGIN_CONFIG = process.env.GRS_PLUGIN_CONFIG || path.join(SANDBOX, 'plugin-config.json');
process.env.GRS_PLUGIN_STATE = process.env.GRS_PLUGIN_STATE || path.join(SANDBOX, 'plugins-state.json');
fs.mkdirSync(SANDBOX, { recursive: true });

// config 写守卫：本脚本只读产品配置；守卫保证任何意外写入被静默拦截（不靠自觉）
const PRELOAD = path.join(__dirname, 'qa-runtime-preload.js');
process.env.QA_GUARD_CONFIG_WRITE = '1';
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

// ══════════════════════════════════════════════════════════
// 子进程模式：沙箱化配置后启动真实服务
// ══════════════════════════════════════════════════════════
if (process.argv.includes('--child')) {
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig();
  // 只走本地，关闭云端 / 内容安全 / 控制台日志，避免真实计费与噪声
  cfg.moderationMode = 'local';
  if (!cfg.moderation) cfg.moderation = {};
  cfg.moderation.reviewChannels = { local: true, cloud: false, contentSafety: false, disputeStrategy: 'highest' };
  cfg.moderation.dualMode = false;
  cfg.moderation.doubleCheck = false;
  if (!cfg.qwenCloud) cfg.qwenCloud = {};
  cfg.qwenCloud.enabled = false;
  if (!cfg.contentSafety) cfg.contentSafety = {};
  cfg.contentSafety.enabled = false;
  if (!cfg.logging) cfg.logging = {};
  cfg.logging.console = false;
  require('../src/server.js');
  return;
}

// ══════════════════════════════════════════════════════════
// 父进程模式
// ══════════════════════════════════════════════════════════
const results = [];
/** 记录一条断言。 */
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail === undefined || detail === '' ? '' : ' | ' + detail}`);
}

/** 稳定的规范化序列化（键排序），用于逐字段深比较。 */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return v === undefined ? '"__u__"' : JSON.stringify(v);
}
/** 深比较。 */
function deepEqual(a, b) { return canon(a) === canon(b); }

/** 列出两个对象之间值不同的顶层键（用于失败时给出可读线索）。 */
function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) if (canon(a && a[k]) !== canon(b && b[k])) out.push(k);
  return out;
}

/** 极简 HTTP 客户端（只走 127.0.0.1 ⇒ isLocalRequest 放行管理密码）。 */
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(`${BASE}${urlPath}`, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = { __raw: raw.slice(0, 200) }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /health 直到就绪。 */
async function waitReady(timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', '/health');
      if (r.status === 200) return r.json;
    } catch { /* 还没起来，继续等 */ }
    await sleep(300);
  }
  return null;
}

/** 启动沙箱服务子进程。 */
function startServer() {
  return spawn(process.execPath, ['--require', PRELOAD, __filename, '--child'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, MOD_PORT: String(PORT), QA_GUARD_CONFIG_WRITE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 找当前已注册的终裁器 ref（finalizer 校验要求已注册，否则 PUT /api/flow/image 报 E004）。 */
async function discoverFinalizerRef() {
  const read = async () => {
    const cap = await request('GET', '/api/flow/capabilities?modality=image');
    const list = (cap.json && Array.isArray(cap.json.finalizers)) ? cap.json.finalizers : [];
    return list.map((f) => f && f.ref).filter(Boolean);
  };
  let refs = await read();
  if (refs.length) return refs[0];
  // 沙箱里插件默认可能未启用：显式启用 wd14-tagger（它声明了终裁器 plugin.wd14-tagger.linkage）后重试
  for (const id of ['wd14-tagger']) {
    try { await request('POST', `/api/plugins/${id}/toggle`, { enabled: true }); } catch { /* 忽略 */ }
  }
  refs = await read();
  return refs[0] || null;
}

/** 取某模态当前 flow。 */
async function getFlow(modality) {
  const r = await request('GET', `/api/flow/${modality}`);
  return { status: r.status, flow: r.json && r.json.flow };
}

/** 把基础 flow 改造成「带自定义位置 + 显式终裁层」的 seeded 拓扑。 */
function seed(baseFlow, finalizerRef) {
  const out = JSON.parse(JSON.stringify(baseFlow));
  out.nodes = (out.nodes || []).map((n, i) => ({ ...n, position: { x: CUSTOM_X0 + i, y: 8200 + i } }));
  if (finalizerRef) {
    out.finalizers = [{ ref: finalizerRef, enabled: true, title: 'H1 probe finalizer', source: 'h1-probe', params: { h1Probe: true } }];
  }
  return out;
}

/** 主流程。 */
async function main() {
  const child = startServer();
  const health = await waitReady(40);
  if (!health) {
    console.log('[FAIL] 沙箱服务未能在 40s 内就绪');
    console.log('passed=0 failed=1');
    console.log('OVERALL: FAIL');
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    process.exitCode = 1;
    return;
  }

  try {
    // ── Phase A：预置 seeded 拓扑 ──
    const finalizerRef = await discoverFinalizerRef();
    console.log(`# sandbox finalizer ref = ${finalizerRef || '(none found)'}`);

    const bImage = await getFlow('image');
    const bText = await getFlow('text');
    check('A/1 GET /api/flow/image 可用', bImage.status === 200 && !!bImage.flow, 'status=' + bImage.status);
    check('A/2 GET /api/flow/text  可用', bText.status === 200 && !!bText.flow, 'status=' + bText.status);
    if (!bImage.flow || !bText.flow) { throw new Error('基线 flow 缺失，无法继续'); }

    const seedImage = seed(bImage.flow, finalizerRef);
    const seedText = seed(bText.flow, null);
    const putImage = await request('PUT', '/api/flow/image', { flow: seedImage, baseRevision: bImage.flow.revision });
    const putText = await request('PUT', '/api/flow/text', { flow: seedText, baseRevision: bText.flow.revision });
    check('A/3 预置 image 拓扑成功（PUT /api/flow/image 200）',
      putImage.status === 200 && putImage.json && putImage.json.ok === true,
      `status=${putImage.status} body=${JSON.stringify(putImage.json).slice(0, 240)}`);
    check('A/4 预置 text 拓扑成功（PUT /api/flow/text 200）',
      putText.status === 200 && putText.json && putText.json.ok === true,
      `status=${putText.status} body=${JSON.stringify(putText.json).slice(0, 240)}`);
    if (putImage.status !== 200 || !(putImage.json && putImage.json.ok)) { throw new Error('预置 image 失败，后续断言无意义'); }

    const imageS0 = (await getFlow('image')).flow;
    const textS0 = (await getFlow('text')).flow;
    check('A/5 预置后 image.finalizers 非空',
      Array.isArray(imageS0.finalizers) && imageS0.finalizers.length >= 1,
      'finalizers=' + JSON.stringify(imageS0.finalizers));
    check('A/6 预置后 image 首节点坐标为自定义值',
      !!(imageS0.nodes && imageS0.nodes[0] && imageS0.nodes[0].position && imageS0.nodes[0].position.x === CUSTOM_X0),
      'nodes[0].position=' + JSON.stringify(imageS0.nodes && imageS0.nodes[0] && imageS0.nodes[0].position));
    const imgRev0 = imageS0.revision;
    const txtRev0 = textS0.revision;

    // ── Phase B：核心断言 —— PUT /api/dual-mode 不得改拓扑 ──
    const dm = await request('PUT', '/api/dual-mode', {
      enabled: true, cloudEnabled: true, model: 'h1-probe-model', billingSource: 'dashscope',
    });
    check('B/1 PUT /api/dual-mode 200', dm.status === 200 && dm.json && dm.json.success === true, 'status=' + dm.status);

    const imageS1 = (await getFlow('image')).flow;
    const textS1 = (await getFlow('text')).flow;

    check('B/2 flows.image 逐字段不变', deepEqual(imageS0, imageS1),
      'changedKeys=' + JSON.stringify(diffKeys(imageS0, imageS1)));
    check('B/3 flows.text 逐字段不变', deepEqual(textS0, textS1),
      'changedKeys=' + JSON.stringify(diffKeys(textS0, textS1)));
    check('B/4 image.finalizers 仍非空且逐条一致',
      Array.isArray(imageS1.finalizers) && imageS1.finalizers.length >= 1 && deepEqual(imageS0.finalizers, imageS1.finalizers),
      'S0=' + JSON.stringify(imageS0.finalizers) + ' S1=' + JSON.stringify(imageS1.finalizers));
    check('B/5 image 节点坐标系不变',
      deepEqual((imageS0.nodes || []).map((n) => n.position), (imageS1.nodes || []).map((n) => n.position)),
      'S0=' + JSON.stringify((imageS0.nodes || []).map((n) => n.position)) + ' S1=' + JSON.stringify((imageS1.nodes || []).map((n) => n.position)));
    check('B/6 image.revision 不变', imageS1.revision === imgRev0, `S0=${imgRev0} S1=${imageS1.revision}`);
    check('B/7 text.revision 不变', textS1.revision === txtRev0, `S0=${txtRev0} S1=${textS1.revision}`);
    check('B/8 image 节点/连线数不变',
      (imageS0.nodes || []).length === (imageS1.nodes || []).length && (imageS0.edges || []).length === (imageS1.edges || []).length,
      `nodes ${(imageS0.nodes || []).length}->${(imageS1.nodes || []).length} edges ${(imageS0.edges || []).length}->${(imageS1.edges || []).length}`);
    check('B/9 响应回报 channelsManagedByTopology=true',
      !!(dm.json && dm.json.channelsManagedByTopology === true),
      'body=' + JSON.stringify(dm.json && dm.json.channelsManagedByTopology));
    check('B/10 响应带 channelNotice 提示文案',
      !!(dm.json && typeof dm.json.channelNotice === 'string' && dm.json.channelNotice.length > 0),
      'notice=' + JSON.stringify(dm.json && dm.json.channelNotice));

    // ── Phase C：阳性对照（受控复现）──
    // POST /api/flow/:modality/reset 走的就是 regenerateFlows()（旧 dual-mode 路由调用的同一函数）。
    // 若它**也不**能破坏 seeded 拓扑，说明「B 的断言」可能只是恒真 ⇒ 这组对照用来证明判据有辨别力。
    const reset = await request('POST', '/api/flow/image/reset', {});
    check('C/1 POST /api/flow/image/reset 200', reset.status === 200 && reset.json && reset.json.ok === true, 'status=' + reset.status);

    const imageS2 = (await getFlow('image')).flow;
    const textS2 = (await getFlow('text')).flow;
    const resetBrokeImage = !deepEqual(imageS0, imageS2);
    check('C/2 [阳性对照] reset 后 image 拓扑确实被破坏（证明 B 断言非恒真）', resetBrokeImage,
      'changedKeys=' + JSON.stringify(diffKeys(imageS0, imageS2)));
    check('C/3 [阳性对照] reset 后 image.finalizers 被清空',
      Array.isArray(imageS2.finalizers) && imageS2.finalizers.length === 0,
      'finalizers=' + JSON.stringify(imageS2.finalizers));
    check('C/4 [阳性对照] reset 后 image.revision 归 1', imageS2.revision === 1, 'revision=' + imageS2.revision);
    check('C/5 [阳性对照] reset 后 image 首节点坐标被重置（不再是自定义值）',
      !(imageS2.nodes && imageS2.nodes[0] && imageS2.nodes[0].position && imageS2.nodes[0].position.x === CUSTOM_X0),
      'nodes[0].position=' + JSON.stringify(imageS2.nodes && imageS2.nodes[0] && imageS2.nodes[0].position));
    check('C/6 [阳性对照] reset 连带重建 text 拓扑（regenerateFlows 是全局的）', !deepEqual(textS0, textS2),
      'changedKeys=' + JSON.stringify(diffKeys(textS0, textS2)));
  } catch (err) {
    check('内联异常', false, err && err.message);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('');
  console.log(`# 沙箱: ${SANDBOX}`);
  console.log(`passed=${passed} failed=${failed}`);
  console.log(`OVERALL: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
