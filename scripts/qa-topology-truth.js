#!/usr/bin/env node
/**
 * QA 拓扑唯一真相验证（scripts/qa-topology-truth.js）—— T07 / R4 + R7 + T03 派生层
 *
 * 覆盖（起一个真服务，全程 **只读生产配置**）：
 *   1. `GET /api/flow/text` 与 `/api/flow/image` 的**每个 node 都带 boolean `onPath`**（不是 undefined）
 * 2. 「孤岛不得静默」：`onPath === false` 的节点**允许存在**（云端单通道下云端路径的 `loc` 刻意
 *      保留未接线，切回双通道接线即启用 —— 可逆铁律），但**必须**被启动日志的 X21 警告声明；
 *      若存在孤岛而日志无 `[X21]` ⇒ 静默孤岛 ⇒ 违反「未用上的节点不静默占位」的唯一真相铁律。
 * 3. 落盘纯净性：调 GET 前后 `config/default.json` 的 sha256 **不变**
 *      （派生位只挂在**响应浅克隆副本**上，绝不污染内存活对象/磁盘）
 * 4. `PUT /api/flow/:modality` 请求体里**故意带 `onPath`** ⇒ 落盘 payload 里**不得**出现 `onPath`
 * 5. `GET /api/flow/faults` 契约 `{ok, faults[], scannedAt}`；且**两轴语义**：
 *      「未接入通路（onPath=false）」的节点**不得**被算成故障
 * 6. `derivePanelChannels` 定义位置**在 T06-C 块之外**（契约块内不得出现该函数定义）
 *
 * 存盘纯净性是怎么测的（关键，避免「空壳通过」）：
 *   本脚本用 `--require scripts/qa-runtime-preload.js --require <本文件>` 起子进程，
 *   并在子进程里以 `QA_TT_PRELOAD=1` 让**本文件自己**充当第二个 preload：
 *   它包裹 `fs.writeFileSync`，把**真正要写进 config/default.json 的字节**复制到 TEMP 侧录一份，
 *   再交给 QA 守卫（`QA_GUARD_CONFIG_WRITE=1`）**静默丢弃** ——
 *   ⇒ 既拿到「PUT 实际想落盘的 payload」做断言，又保证**生产配置一个字节都没动**。
 *   （若只在守卫下读磁盘文件，则「磁盘没有 onPath」只因写入被拦截，无法证明 `stripDerived` 生效。）
 *
 * 输出格式与其它 `qa-*.js` 一致；全过 exit 0，任一失败 exit 1。
 * 本脚本只读产品代码，唯一写入是 TEMP 下的临时侧录文件（用完即删）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SELF = path.join(__dirname, 'qa-topology-truth.js');
const PRELOAD = path.join(__dirname, 'qa-runtime-preload.js');
const CONFIG_PATH = path.join(ROOT, 'config', 'default.json');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const CAPTURE_FILE = path.join(os.tmpdir(), `grs-t07a-capture-${process.pid}.json`);

let passed = 0;
let failed = 0;
const rows = [];

/**
 * 记录一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 证据串
 * @returns {void}
 */
function check(name, ok, detail) {
  if (ok) passed += 1; else failed += 1;
  rows.push({ name, ok, detail: detail || '' });
}

/**
 * 子进程 preload 分支：侧录「即将写入 config/default.json 的字节」。
 * 必须在 QA 守卫之后加载 ⇒ `realWrite` 已是守卫版（对 config 写入静默丢弃），
 * 因此本函数只做「复制一份到 TEMP」，不改变任何落盘行为。
 * @returns {void}
 */
function installCaptureHook() {
  const target = process.env.QA_TT_CAPTURE_FILE;
  const realWrite = fs.writeFileSync;
  const isCfg = (p) => String(p).replace(/\\/g, '/').endsWith('/config/default.json');
  fs.writeFileSync = function patched(file, data, ...rest) {
    if (target && isCfg(file)) {
      try {
        realWrite(target, typeof data === 'string' ? data : Buffer.from(data));
      } catch { /* 侧录失败不影响被测行为 */ }
    }
    return realWrite.call(this, file, data, ...rest);
  };
}

/** 文件 sha256。 */
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/**
 * 轮询等待某段文本出现在（流式到达的）启动日志里。
 * 用于「孤岛必须被 X21 声明」的断言：日志是**流式**的，断言不能假设它已经到达；
 * 超时不算失败，而是返回「未观察到」交给调用方判定（避免 flaky）。
 * @param {() => string} getLog 读取当前累计日志
 * @param {string} needle 期待出现的子串
 * @param {number} [timeoutMs] 超时毫秒
 * @returns {Promise<boolean>} 是否观察到
 */
async function waitForLog(getLog, needle, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (String(getLog() || '').includes(needle)) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** 输出报告。 */
function report() {
  const line = '-'.repeat(96);
  console.log(line);
  console.log('GRS QA topology single-source-of-truth (T07 / R4+R7)');
  console.log(line);
  for (const r of rows) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(46)} ${r.detail}`);
  }
  console.log(line);
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

/** 主流程。 */
async function main() {
  const shaBefore = sha256(CONFIG_PATH);
  const flows = {};
  let child = null;

  try {
    const port = 15000 + Math.floor(Math.random() * 3000);
    child = spawn(process.execPath, ['--require', PRELOAD, '--require', SELF, path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        MOD_PORT: String(port),
        GRS_PLUGINS_ENABLED: 'false',
        QA_GUARD_CONFIG_WRITE: '1',
        QA_TT_PRELOAD: '1',
        QA_TT_CAPTURE_FILE: CAPTURE_FILE,
      }),
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });

    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 80; i += 1) {
      try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break; } } catch { /* retry */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 400));
    }
    check('server/starts', up, up ? `port=${port}` : `no /health within 32s; log tail=${log.slice(-200)}`);
    if (!up) return;

    // ── 1 & 2：两个模态的 node.onPath 全覆盖 + 零误判 ──
    for (const modality of ['text', 'image']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${base}/api/flow/${modality}`);
      // eslint-disable-next-line no-await-in-loop
      const j = await res.json();
      const nodes = (j.flow && Array.isArray(j.flow.nodes)) ? j.flow.nodes : [];
      flows[modality] = nodes;
      const nonBool = nodes.filter((n) => typeof n.onPath !== 'boolean').map((n) => n.id);
      const offPath = nodes.filter((n) => n.onPath === false).map((n) => n.id);
      check(`flow/${modality}-http-200`, res.status === 200 && nodes.length > 0, `status=${res.status} nodes=${nodes.length}`);
      check(`flow/${modality}-every-node-boolean-onPath`, nodes.length > 0 && nonBool.length === 0,
        `nonBoolean=[${nonBool.join(',')}] of ${nodes.length}`);

      // 「孤岛不得静默」：offPath 允许存在（可逆），但必须被启动日志的 X21 声明。
      // 等待 X21 出现（流式日志；超时记为「未观察到」，不算 flaky 失败以外的假阴性）。
      const x21Seen = offPath.length === 0
        ? false
        // eslint-disable-next-line no-await-in-loop
        : await waitForLog(() => log, '[X21]', 6000);
      const declared = offPath.length === 0 || x21Seen;
      check(`flow/${modality}-offpath-declared`, declared,
        offPath.length === 0
          ? 'offPath=0（理想态，无孤岛）'
          : (x21Seen
            ? `offPath=[${offPath.join(',')}] 已被启动日志 [X21] 声明`
            : `静默孤岛：offPath=[${offPath.join(',')}] 存在但启动日志无 [X21]`));
      // 孤岛 id 作为**证据**打印（不做断言）—— 报告里人肉可查，X21 文案本身不含 id。
      check(`flow/${modality}-offpath-ids`, true,
        `offPath=[${offPath.join(',') || 'none'}] count=${offPath.length}`);
    }

    // ── 5：faults 契约 + 两轴语义 ──
    const faultsRes = await fetch(`${base}/api/flow/faults`);
    const faultsJson = await faultsRes.json();
    const keys = Object.keys(faultsJson).sort().join(',');
    check('faults/contract-shape', faultsRes.status === 200 && keys === 'faults,ok,scannedAt'
      && faultsJson.ok === true && Array.isArray(faultsJson.faults) && !Number.isNaN(Date.parse(faultsJson.scannedAt)),
      `status=${faultsRes.status} keys=${keys} ok=${faultsJson.ok} n=${Array.isArray(faultsJson.faults) ? faultsJson.faults.length : 'n/a'} scannedAt=${faultsJson.scannedAt}`);

    const faultList = Array.isArray(faultsJson.faults) ? faultsJson.faults : [];
    const badAxis = [];
    const dangling = [];
    for (const f of faultList) {
      const nodes = flows[f.modality];
      if (!nodes) { dangling.push(`${f.modality}/${f.nodeId}`); continue; }
      const node = nodes.find((n) => n.id === f.nodeId);
      if (!node) { dangling.push(`${f.modality}/${f.nodeId}`); continue; }
      if (node.onPath !== true) badAxis.push(`${f.modality}/${f.nodeId}(onPath=${node.onPath})`);
    }
    check('faults/every-fault-is-onPath-true', badAxis.length === 0 && dangling.length === 0,
      `faults=${faultList.length} offPathAsFault=[${badAxis.join(',')}] dangling=[${dangling.join(',')}]`);

    const offPathNodes = [];
    for (const modality of ['text', 'image']) {
      for (const n of (flows[modality] || [])) if (n.onPath === false) offPathNodes.push(`${modality}/${n.id}`);
    }
    const offPathReported = faultList.filter((f) => offPathNodes.includes(`${f.modality}/${f.nodeId}`));
    check('faults/no-offPath-node-reported', offPathReported.length === 0,
      `offPath nodes=[${offPathNodes.join(',') || 'none'}] reported=${offPathReported.length}`);

    // ── 4：PUT 带 onPath ⇒ 落盘 payload 摘掉 onPath ──
    const getRes = await fetch(`${base}/api/flow/text`);
    const getJson = await getRes.json();
    const body = { flow: getJson.flow, baseRevision: getJson.flow.revision };
    const bodyHasOnPath = JSON.stringify(body).includes('onPath');
    check('put/request-body-carries-onPath', bodyHasOnPath, `body contains onPath = ${bodyHasOnPath}`);

    const putRes = await fetch(`${base}/api/flow/text`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const putJson = await putRes.json().catch(() => ({}));
    check('put/http-200', putRes.status === 200 && putJson.ok === true, `status=${putRes.status} body=${JSON.stringify(putJson).slice(0, 200)}`);

    await new Promise((r) => setTimeout(r, 300)); // 等侧录落定
    let captured = '';
    try { captured = fs.readFileSync(CAPTURE_FILE, 'utf-8'); } catch { captured = ''; }
    check('put/persisted-payload-captured', captured.length > 0, `capturedBytes=${Buffer.byteLength(captured)}`);
    check('put/persisted-payload-has-no-onPath', captured.length > 0 && !captured.includes('onPath'),
      captured.length > 0 ? `contains "onPath" = ${captured.includes('onPath')}` : 'no capture');
    // 侧录到的确实是 PUT 之后的态（revision 递增）⇒ 证明我们断言的是「PUT 想写的那份」
    let capturedRevision = -1;
    try { capturedRevision = JSON.parse(captured).moderation.flows.text.revision; } catch { capturedRevision = -1; }
    check('put/persisted-payload-is-post-put-state', capturedRevision === getJson.flow.revision + 1,
      `captured revision=${capturedRevision} expect=${getJson.flow.revision + 1}`);

    // ── 3：落盘纯净性（整轮跑完） ──
    const shaAfter = sha256(CONFIG_PATH);
    check('config/sha256-unchanged', shaAfter === shaBefore, `before=${shaBefore.slice(0, 16)} after=${shaAfter.slice(0, 16)}`);
    check('config/file-has-no-onPath', !fs.readFileSync(CONFIG_PATH, 'utf-8').includes('onPath'), 'disk config contains "onPath" = false');
  } catch (err) {
    check('run/no-uncaught-exception', false, `threw: ${err && err.message}`);
  } finally {
    try { if (child && child.exitCode === null) child.kill(); } catch { /* ignore */ }
    try { if (fs.existsSync(CAPTURE_FILE)) fs.unlinkSync(CAPTURE_FILE); } catch { /* ignore */ }
  }

  // ── 6：derivePanelChannels 位于 T06-C 契约块之外（静态） ──
  try {
    const html = fs.readFileSync(INDEX_PATH, 'utf-8');
    const blockStart = html.indexOf('T06-C:');
    const blockEnd = html.indexOf('end T06-C');
    const defIdx = html.indexOf('function derivePanelChannels');
    check('t06c/markers-present', blockStart >= 0 && blockEnd > blockStart,
      `start@${blockStart} end@${blockEnd}`);
    const insideBlock = defIdx >= 0 && defIdx > blockStart && defIdx < blockEnd;
    check('t06c/derivePanelChannels-outside-block', defIdx >= 0 && !insideBlock,
      `def@${defIdx} block=[${blockStart},${blockEnd}] inside=${insideBlock}`);
  } catch (err) {
    check('t06c/read-index', false, `read failed: ${err && err.message}`);
  }
}

if (process.env.QA_TT_PRELOAD === '1') {
  installCaptureHook();
} else {
  main().then(report).catch((err) => {
    check('fatal', false, String(err && err.stack ? err.stack : err));
    report();
  });
}
