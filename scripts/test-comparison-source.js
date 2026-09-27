#!/usr/bin/env node
/**
 * D1 回归：对比审核「输入侧」消费方（scripts/test-comparison-source.js）
 *
 * 为什么必须有这个脚本：`scripts/test-image-ref.js` 测的是**生产者**（src/image-ref.js 自己），
 * 全程不 require `src/comparison-source.js`。于是 `imagePathOf()` / `collectAuditImages()`
 * 这条「消费方」路径**完全裸奔**——真实的 P0（`comparison-source.js` 用了 `imageRefModule`
 * 却从未 `require('./image-ref')`）在所有回归里都不红，直到用户点「图像对比」整条挂掉。
 * 本脚本把消费方补上，覆盖：
 *   ① imagePathOf() 的三层回退（blob → image_ref.source.ref → meta.source/filePath/result.image_path）
 *      + 「全无 ⇒ null 且不抛」
 *   ② collectAuditImages() 混合记录 ⇒ 不抛、skipped 计数正确
 *   ③ 端到端：comparison-engine 的图像分支遇到带 image_ref 的样本 ⇒ **不抛**
 *
 * 隔离：`GRS_BLOB_DIR` 指向 TEMP（绝不触碰生产 `data/image_blobs/`）、
 *       `GRS_AUDIT_DIR` 指向 TEMP、`QA_GUARD_CONFIG_WRITE=1`（preload 拦截 config 写入）。
 *
 * 用法：node scripts/test-comparison-source.js
 * 退出码：全部通过为 0，否则为 1。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── 生产数据保护（必须在 require 任何 src 模块之前）───
const SANDBOX = path.join(os.tmpdir(), `grs-cmpsrc-${process.pid}`);
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.GRS_BLOB_DIR = path.join(SANDBOX, 'image_blobs');
process.env.GRS_AUDIT_DIR = path.join(SANDBOX, 'audit_records');
process.env.QA_GUARD_CONFIG_WRITE = '1';
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

const source = require('../src/comparison-source');
const imageRef = require('../src/image-ref');
const engine = require('../src/comparison-engine');
const core = require('../src/comparison-core');

let passed = 0;
let failed = 0;

/**
 * 记录一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 细节
 */
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}${detail ? '   ' + detail : ''}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? '   ' + detail : ''}`); }
}

/**
 * 同步安全调用：把异常转成结果对象（这样「修前」不会中断脚本，能逐条打印 ReferenceError）。
 * @param {Function} fn 待调用函数
 * @returns {{ok: boolean, value?: any, error?: string}} 结果
 */
function safeCall(fn) {
  try { return { ok: true, value: fn() }; } catch (err) { return { ok: false, error: `${err && err.name}: ${err && err.message}` }; }
}

/**
 * 异步安全调用。
 * @param {Function} fn 返回 Promise 的函数
 * @returns {Promise<{ok: boolean, value?: any, error?: string}>} 结果
 */
async function safeAwait(fn) {
  try { return { ok: true, value: await fn() }; } catch (err) { return { ok: false, error: `${err && err.name}: ${err && err.message}` }; }
}

/** 1×1 PNG（合法最小图片，67 字节） */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/**
 * 主流程。
 * @returns {Promise<void>} 完成
 */
async function main() {
  console.log('--------------------------------------------------------------------------------');
  console.log('D1 对比源数据消费方回归（scripts/test-comparison-source.js）');
  console.log('--------------------------------------------------------------------------------');
  console.log(`沙箱: GRS_BLOB_DIR=${process.env.GRS_BLOB_DIR}`);

  fs.mkdirSync(process.env.GRS_BLOB_DIR, { recursive: true });

  // ── 素材准备 ──
  const { ref, buffer } = imageRef.fromBase64(PNG_B64);
  await imageRef.capture(ref, buffer); // 写 blob（缩略图依赖 sharp，未装时被 capture 内部吞掉）
  const blobAbs = imageRef.blobAbsPath(ref.hash, 'png');
  const blobOnDisk = Boolean(blobAbs) && fs.existsSync(blobAbs);

  const localPic = path.join(SANDBOX, 'local-pic.png');
  fs.writeFileSync(localPic, Buffer.from(PNG_B64, 'base64'));
  const notImage = path.join(SANDBOX, 'notes.txt');
  fs.writeFileSync(notImage, 'hello');
  const missingPic = path.join(SANDBOX, 'gone.png'); // 故意不存在

  check('P/0 沙箱 blob 已落盘（内容寻址 + 存在）', blobOnDisk, `hash=${ref.hash} blobAbs=${blobAbs}`);

  console.log('\n── imagePathOf() 三层回退 + 不抛 ──');

  // ① image_ref.blob 存在 ⇒ 用 blob（blob 绝对路径优先于任何回退）
  const rBlob = { id: 'r-blob', image_ref: ref, meta: { source: localPic }, result: { image_path: localPic } };
  const c1 = safeCall(() => source.imagePathOf(rBlob));
  check('P/1 ① blob 存在 ⇒ 用 blob（优先于 meta.source）',
    c1.ok && c1.value === blobAbs, c1.ok ? `got=${c1.value}` : `threw=${c1.error}`);

  // ② blob 文件不存在（内容寻址路径落空）⇒ 回退 meta.source
  const ghostRef = {
    hash: '0123456789abcdef', bytes: 67, format: 'png', width: 1, height: 1,
    source: { kind: 'bot-base64', ref: null },
    blob: 'data/image_blobs/01/0123456789abcdef.png', thumb: null, stored: true, storedReason: null,
  };
  const rGhost = { id: 'r-ghost', image_ref: ghostRef, meta: { source: localPic }, result: {} };
  const c2 = safeCall(() => source.imagePathOf(rGhost));
  check('P/2 ② blob 不存在 ⇒ 回退 meta.source',
    c2.ok && c2.value === localPic, c2.ok ? `got=${c2.value}` : `threw=${c2.error}`);

  // ②b image_ref.source.ref 存在且为绝对路径 ⇒ 由 resolveImageRef 直接裁决
  const fileRef = imageRef.fromFile(localPic); // source.ref = localPic；blob 恒为 null（只引用不拷贝）
  const rFileRef = { id: 'r-fileref', image_ref: fileRef, meta: {}, result: {} };
  const c3 = safeCall(() => source.imagePathOf(rFileRef));
  check('P/3 ②b image_ref.source.ref 存在 ⇒ 用之',
    c3.ok && c3.value === localPic, c3.ok ? `got=${c3.value}` : `threw=${c3.error}`);

  // ③ 无 image_ref，只有 result.image_path ⇒ 用之
  const rResultOnly = { id: 'r-result', meta: {}, result: { image_path: localPic } };
  const c4 = safeCall(() => source.imagePathOf(rResultOnly));
  check('P/4 ③ 仅 result.image_path ⇒ 用之',
    c4.ok && c4.value === localPic, c4.ok ? `got=${c4.value}` : `threw=${c4.error}`);

  // ④ 全无（含畸形输入）⇒ null 且不抛
  const nothingCases = [
    ['null 记录', null],
    ['undefined 记录', undefined],
    ['空对象', {}],
    ['meta.source 非图片扩展名', { meta: { source: notImage } }],
    ['meta.filePath 非图片扩展名', { meta: { filePath: notImage } }],
    ['result 无 image_path', { result: {} }],
    ['image_ref 是字符串（畸形）', { image_ref: 'oops' }],
    ['image_ref.hash 目录穿越（畸形）', { result: { image_ref: { hash: '../../etc/passwd' } } }],
  ];
  const nothingVals = [];
  let nothingThrew = null;
  for (const [label, rec] of nothingCases) {
    const r = safeCall(() => source.imagePathOf(rec));
    if (!r.ok) { nothingThrew = `${label} ⇒ ${r.error}`; break; }
    nothingVals.push(r.value);
  }
  check('P/5 ④ 全无/畸形 ⇒ null 且不抛',
    nothingThrew === null && nothingVals.length === nothingCases.length && nothingVals.every((v) => v === null),
    nothingThrew ? `threw=${nothingThrew}` : `vals=${JSON.stringify(nothingVals)}`);

  console.log('\n── collectAuditImages() 混合记录 ──');

  const records = [
    { id: 'a', image_ref: ref, meta: {}, result: {} },              // → item（blob）
    { id: 'b', meta: { source: localPic }, result: {} },            // → item（meta.source）
    { id: 'c', meta: { source: missingPic }, result: {} },          // → skipped（文件不存在）
    { id: 'd', meta: {}, result: {} },                              // → skipped（无任何图片信息）
    { id: 'e', meta: { source: notImage }, result: {} },            // → skipped（非图片扩展名）
  ];
  const gathered = safeCall(() => source.collectAuditImages(records));
  check('P/6 collectAuditImages 混合记录 ⇒ 不抛且 items/skipped 正确',
    gathered.ok && gathered.value.items.length === 2 && gathered.value.skipped === 3,
    gathered.ok
      ? `items=${gathered.value.items.length} skipped=${gathered.value.skipped} ids=[${gathered.value.items.map((i) => i.record.id).join(',')}]`
      : `threw=${gathered.error}`);

  console.log('\n── 端到端：comparison-engine 图像分支 ──');

  // 真实消费方（collectAuditImages / readImageBase64 全用真的），只把「记录读取」换成固定样本
  const stubSource = Object.assign({}, source, { readAuditRecords: () => records });
  const store = {
    emptyResult: (date, modality) => ({ date, modality, summary: { skipped_no_image: 0 }, results: [] }),
    writeResult: () => 'stub-result-path',
  };
  // 探针只提供编排需要的两个面；本轮禁用全部通道 ⇒ 理论上不会被调用（保留真实实现以防注册表非空）
  const probe = {
    channelAvailability: () => ({}),
    imageCloud: async () => ({ risk_level: 'safe', categories: [], confidence: 0.9, reason: '' }),
    imageSafety: async () => ({ risk_level: 'safe', categories: [], confidence: 0.9, reason: '' }),
    imageLocal: async () => ({ risk_level: 'safe', categories: [], confidence: 0.9, reason: '' }),
    adjudicatorVerdict: async () => ({ risk_level: 'safe', categories: [], confidence: 0.9, reason: '' }),
  };
  const cfg = { visionModel: '', includeCloud: false, includeContentSafety: false, comparisonModels: [] };

  const run = await safeAwait(() => engine.runComparison(
    { source: stubSource, store, probe, core, config: cfg, logger: null },
    { date: '2026-01-01', modality: 'image' },
  ));
  const out = run.ok ? run.value : null;
  check('P/7 端到端：带 image_ref 的样本不再抛（ReferenceError）',
    run.ok && Boolean(out) && Array.isArray(out.results) && out.results.length === 2
      && out.summary && out.summary.skipped_no_image === 3,
    run.ok
      ? `results=${out.results.length} total_records=${out.total_records} valid=${out.summary.valid} skipped_no_image=${out.summary.skipped_no_image}`
      : `threw=${run.error}`);

  console.log('--------------------------------------------------------------------------------');
  console.log(`passed=${passed} failed=${failed}`);
  console.log(`OVERALL: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`FATAL: ${err && err.stack ? err.stack : err}`);
  console.log('OVERALL: FAIL');
  process.exit(1);
});
