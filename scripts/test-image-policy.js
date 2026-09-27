/**
 * 图像审核策略回归 —— scripts/test-image-policy.js
 *
 * 运行：node scripts/test-image-policy.js
 *
 * 覆盖四件增量功能（v0.2.0 · src/image-policy.js）：
 *   A. 发送前缩图（moderation.imagePolicy.maxImagePx）—— sharp 缺失时降级为发送原图
 *   B. 判定缓存（audit-db.verdict_cache）—— 同图+同模型+同档位 第二次 cached=true 且 0 次云端调用
 *   C. 泳装/暴露档位（exposure.mode: off/lenient/standard/strict）——
 * 用**真实代码构造的提示词**打**真实 API** 逐档实测 risk_level（提示词契约不验证 = 白改）
 *   D. WD14 联动开关（useWd14Linkage）—— 关闭 ⇒ 终裁层按 skipped + 明确 skip_reason，可逆
 *   S. /api/image-policy GET/PUT 路由（含参数校验）
 *
 * 真实 API 部分会产生**真实计费**（视觉模型取配置里的 qwenCloud.visionModel，默认 qwen3.8-flash），
 *   全部用例合计 < 1 万 prompt tokens，成本可忽略。凭据缺失时 R 段自动 SKIPPED 并如实上报。
 *
 * 隔离：GRS_AUDIT_DB / GRS_BLOB_DIR / GRS_PLUGIN_* 全部指向 TEMP；
 *       QA_GUARD_CONFIG_WRITE=1 拦截一切对 config/default.json 的写入（本脚本只改内存配置）。
 * 输出：`[PASS]/[FAIL]/[SKIP] 名称 | 详情` + `passed=N failed=M skipped=K` + `OVERALL: PASS|FAIL`
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.IMGPOL_PORT || 11562);
const BASE = `http://127.0.0.1:${PORT}`;

// ── 测试隔离（必须在任何 src 模块被 require 之前）──
const SANDBOX = path.join(os.tmpdir(), `grs-imgpol-${process.pid}`);
process.env.GRS_AUDIT_DIR = process.env.GRS_AUDIT_DIR || path.join(SANDBOX, 'audit_records');
process.env.GRS_AUDIT_DB = process.env.GRS_AUDIT_DB || path.join(SANDBOX, 'audit.db');
process.env.GRS_BLOB_DIR = process.env.GRS_BLOB_DIR || path.join(SANDBOX, 'image_blobs');
process.env.GRS_PLUGIN_CONFIG = process.env.GRS_PLUGIN_CONFIG || path.join(SANDBOX, 'plugin-config.json');
process.env.GRS_PLUGIN_STATE = process.env.GRS_PLUGIN_STATE || path.join(SANDBOX, 'plugins-state.json');
fs.mkdirSync(SANDBOX, { recursive: true });

// config 写守卫：本脚本只改**内存**配置；任何意外写盘都被静默拦截
const PRELOAD = path.join(__dirname, 'qa-runtime-preload.js');
process.env.QA_GUARD_CONFIG_WRITE = '1';
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

// 云端调用计数器：在任何 src 模块之前 patch global.fetch，
//   用于证明「缓存命中 ⇒ 云端调用数为 0」（B 的核心判据）。
const CLOUD_HOST_RE = /dashscope\.aliyuncs\.com|token-plan.*aliyuncs\.com/i;
const cloudCallLog = [];
const _origFetch = global.fetch;
if (typeof _origFetch === 'function') {
  global.fetch = function countedFetch(url, ...rest) {
    try {
      const u = String(url || '');
      if (CLOUD_HOST_RE.test(u)) cloudCallLog.push({ url: u, t: Date.now() });
    } catch { /* 计数失败不影响调用 */ }
    return _origFetch.call(this, url, ...rest);
  };
}

// ══════════════════════════════════════════════════════════
// 子进程模式：沙箱化配置后启动真实服务（S 段用；云端关闭，绝不计费）
// ══════════════════════════════════════════════════════════
if (process.argv.includes('--child')) {
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig();
  cfg.moderationMode = 'local';
  if (!cfg.moderation) cfg.moderation = {};
  cfg.moderation.reviewChannels = { local: true, cloud: false, contentSafety: false, disputeStrategy: 'highest' };
  cfg.moderation.dualMode = false;
  cfg.moderation.doubleCheck = false;
  if (!cfg.qwenCloud) cfg.qwenCloud = {};
  cfg.qwenCloud.enabled = false; // S 段绝不真打云端
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
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), skipped: false });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail === undefined || detail === '' ? '' : ' | ' + detail}`);
}
function skip(name, detail) {
  results.push({ name, ok: false, skipped: true });
  console.log(`[SKIP] ${name}${detail ? ' | ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return v === undefined ? '"__u__"' : JSON.stringify(v);
}
const deepEqual = (a, b) => canon(a) === canon(b);

// 纯 Node 生成 PNG（零第三方依赖）：R-A 的 768px tokens 对照图。
// 背景：沙箱禁用 Add-Type/反射加载，本机未安装 sharp ⇒ 无法真实缩放。
// Qwen-VL 的 image_tokens 只由**像素尺寸**决定、与图像内容无关，因此用
// 与「原图等比缩到长边 768」同像素尺寸的 PNG 做对照，tokens 结论等价
// （输出日志中已注明该近似，回报时如实说明）。
function makePng(width, height) {
  const zlib = require('zlib');
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  // 轻微渐变填充（非纯色，避免被判为异常图）
  for (let y = 0; y < height; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 3;
      raw[p] = (x * 255 / Math.max(1, width - 1)) | 0;
      raw[p + 1] = (y * 255 / Math.max(1, height - 1)) | 0;
      raw[p + 2] = ((x + y) * 127 / Math.max(1, width + height - 2)) | 0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

async function waitReady(timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try { const r = await request('GET', '/health'); if (r.status === 200) return r.json; } catch { /* retry */ }
    await sleep(300);
  }
  return null;
}

function startServer() {
  return spawn(process.execPath, ['--require', PRELOAD, __filename, '--child'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, MOD_PORT: String(PORT), QA_GUARD_CONFIG_WRITE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 记录 config/default.json 的指纹（跑前/跑后对照，证明本脚本没写用户配置）。 */
function cfgFingerprint() {
  const p = path.join(PROJECT_ROOT, 'config', 'default.json');
  try {
    const st = fs.statSync(p);
    const crypto = require('crypto');
    const fp = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    return { mtime: st.mtime.toISOString(), size: st.size, fp: fp.slice(0, 12) };
  } catch { return null; }
}

async function main() {
  const cfgBefore = cfgFingerprint();
  const { loadConfig } = require('../src/config');
  const config = loadConfig();
  if (!config.moderation.imagePolicy || typeof config.moderation.imagePolicy !== 'object') {
    config.moderation.imagePolicy = { maxImagePx: 768, cacheVerdicts: true, exposure: { mode: 'standard' }, useWd14Linkage: true };
  }

  const imagePolicy = require('../src/image-policy');
  const auditDb = require('../src/audit-db');
  const imageRef = require('../src/image-ref');
  const shared = require('../src/flow/nodes/shared');
  const executor = require('../src/flow/executor');

  // ════════ U：单元 / 配置（无网络） ════════
  console.log('\n──── U. 单元 / 配置 ────');
  // U/1-U/4 断言的是「**模块内置默认值**」⇒ 必须用**合成的空配置**取，不能读用户的
  //   config/default.json。原因（2026-09-17 回归教训）：用户在 UI 上把 maxImagePx 改成了
  //   1024，于是「默认值=768」这条断言变成了读用户配置，测试对生产环境产生了硬依赖。
  const cfg0 = imagePolicy.getImagePolicyCfg({ moderation: {} });
  check('U/1 内置默认 maxImagePx=768（不读用户配置）', cfg0.maxImagePx === 768, JSON.stringify(cfg0));
  check('U/2 内置默认 cacheVerdicts=true', cfg0.cacheVerdicts === true);
  check('U/3 内置默认 exposureMode=standard', cfg0.exposureMode === 'standard');
  check('U/4 内置默认 useWd14Linkage=true', cfg0.useWd14Linkage === true);

  // U/1b：真实配置仍然走同一套归一化函数（用户值合法即可读回，不受上面的改动影响）
  const cfgEff = imagePolicy.getImagePolicyCfg(config);
  check('U/1b 真实配置经同一归一化函数得到合法策略',
    (cfgEff.maxImagePx === 0 || (cfgEff.maxImagePx >= 128 && cfgEff.maxImagePx <= 4096))
    && imagePolicy.EXPOSURE_MODES.includes(cfgEff.exposureMode),
    JSON.stringify(cfgEff));

  const savedPolicy = JSON.parse(JSON.stringify(config.moderation.imagePolicy));
  try {
    config.moderation.imagePolicy = { maxImagePx: 99999, cacheVerdicts: false, exposure: { mode: 'bogus' }, useWd14Linkage: false };
    const cfgBad = imagePolicy.getImagePolicyCfg(config);
    check('U/5 非法档位兜底为 standard', cfgBad.exposureMode === 'standard', `got=${cfgBad.exposureMode}`);
    check('U/6 超界 maxImagePx 收敛到 4096', cfgBad.maxImagePx === 4096, `got=${cfgBad.maxImagePx}`);
    check('U/7 cacheVerdicts=false 可读回', cfgBad.cacheVerdicts === false);
    config.moderation.imagePolicy = { maxImagePx: 0 };
    check('U/8 maxImagePx=0（原图）可读回', imagePolicy.getImagePolicyCfg(config).maxImagePx === 0);
  } finally {
    config.moderation.imagePolicy = savedPolicy;
  }

  // U/9：缓存键的 hash 必须与 image_ref 的落盘 hash 同算法（否则缓存与审计记录对不上）。
  // image-ref 未导出 hash 函数 ⇒ 双重对照：① sha256[:16] 公式；② 生产环境真实
  // blob 的文件名（data/image_blobs/<h2>/<hash>.<ext> 的 <hash> 就是 image_ref.capture
  // 当年算出的值，用 imagePolicy.imageHash 重新计算必须一致）。
  const probeBuf = Buffer.from('grs-image-policy-hash-probe-bytes');
  const expectProbe = require('crypto').createHash('sha256').update(probeBuf).digest('hex').slice(0, 16);
  check('U/9a imageHash 算法 = sha256(bytes)[:16]', imagePolicy.imageHash(probeBuf) === expectProbe,
    `got=${imagePolicy.imageHash(probeBuf)}`);
  const realBlob9 = path.join(PROJECT_ROOT, 'data', 'image_blobs', '4a', '4a9a5dc502a77eb3.jpg');
  if (fs.existsSync(realBlob9)) {
    const realHash9 = imagePolicy.imageHash(fs.readFileSync(realBlob9));
    check('U/9b imageHash 与生产 blob 文件名一致（image_ref 同算法实证）', realHash9 === '4a9a5dc502a77eb3',
      `computed=${realHash9}`);
  } else {
    skip('U/9b imageHash 与生产 blob 文件名一致', '找不到真实 blob ' + realBlob9);
  }

  // U/10-U/13：暴露档位提示词段
  const blockOff = imagePolicy.exposurePolicyBlock('off');
  const blockLen = imagePolicy.exposurePolicyBlock('lenient');
  const blockStd = imagePolicy.exposurePolicyBlock('standard');
  const blockStr = imagePolicy.exposurePolicyBlock('strict');
  check('U/10 off 档不注入策略段（空串）', blockOff === '', `len=${blockOff.length}`);
  check('U/11 其余三档策略段非空且互不相同',
    blockLen.length > 0 && blockStd.length > 0 && blockStr.length > 0
    && !deepEqual(blockLen, blockStd) && !deepEqual(blockStd, blockStr) && !deepEqual(blockLen, blockStr),
    `len=${blockLen.length} std=${blockStd.length} strict=${blockStr.length}`);
  check('U/12 未知档位兜底为不注入', imagePolicy.exposurePolicyBlock('nonsense') === '');
  check('U/13 严格档明确要求 high / 宽松档明确要求 safe',
    blockStr.includes('high') && blockLen.includes('safe') && blockStd.includes('medium'));

  // U/14-U/16：D 的 ref 判据（精确匹配，避免误伤其它插件）
  check('U/14 wd14 linkage ref 命中', imagePolicy.isWd14LinkageRef('plugin.wd14-tagger.linkage', {}) === true);
  check('U/15 其它插件 ref 不命中', imagePolicy.isWd14LinkageRef('plugin.some-other.linkage', {}) === false);
  check('U/16 owner=wd14-tagger 命中（ref 变名也能兜住）', imagePolicy.isWd14LinkageRef('plugin.x.linkage', { owner: 'wd14-tagger' }) === true);

  // U/17： sharp 缺失降级实测（本机现状）
  const bigImg = path.join(PROJECT_ROOT, 'data', 'image_blobs', '4a', '4a9a5dc502a77eb3.jpg');
  let sharpProbeBuf = null;
  let haveBigImg = false;
  if (fs.existsSync(bigImg)) {
    sharpProbeBuf = fs.readFileSync(bigImg);
    haveBigImg = true;
  } else {
    sharpProbeBuf = Buffer.from(probeBuf);
  }
  let sharpAvailable = false;
  try { require('sharp'); sharpAvailable = true; } catch { sharpAvailable = false; }
  const rz = await imagePolicy.resizeForModel(sharpProbeBuf, 768);
  if (!sharpAvailable) {
    check('U/17 sharp 缺失 ⇒ 降级为发送原图（绝不失败）',
      rz.applied === false && rz.reason === 'sharp-unavailable' && rz.buffer === sharpProbeBuf,
      `reason=${rz.reason} applied=${rz.applied} bytes=${rz.toBytes}/${rz.fromBytes}`);
  } else {
    check('U/17 sharp 可用 ⇒ 正常缩图到长边 ≤768', rz.applied === true && rz.toPx > 0 && rz.toPx <= 768,
      `from=${rz.fromPx} to=${rz.toPx} bytes=${rz.fromBytes}→${rz.toBytes}`);
  }
  const rz0 = await imagePolicy.resizeForModel(sharpProbeBuf, 0);
  check('U/18 maxImagePx=0 ⇒ 明确不缩（disabled）', rz0.applied === false && rz0.reason === 'disabled', `reason=${rz0.reason}`);
  const rzEmpty = await imagePolicy.resizeForModel(Buffer.alloc(0), 768);
  check('U/19 空字节 ⇒ 降级不抛异常', rzEmpty.applied === false && rzEmpty.reason === 'empty-buffer', `reason=${rzEmpty.reason}`);

  // U/20-U/23：buildImageSystemPrompt（真实代码构造的提示词）
  const modeBackup = config.moderation.imagePolicy.exposure.mode;
  try {
    config.moderation.imagePolicy.exposure.mode = 'off';
    const pOff = shared.buildImageSystemPrompt();
    config.moderation.imagePolicy.exposure.mode = 'strict';
    const pStrict = shared.buildImageSystemPrompt();
    config.moderation.imagePolicy.exposure.mode = 'lenient';
    const pLen = shared.buildImageSystemPrompt();
    config.moderation.imagePolicy.exposure.mode = 'standard';
    const pStd = shared.buildImageSystemPrompt();
    check('U/20 off 档 system prompt 不含策略段', !pOff.includes('图像暴露策略'), `len=${pOff.length}`);
    check('U/21 strict 档 system prompt 注入策略段', pStrict.includes('图像暴露策略') && pStrict.includes('strict'), `len=${pStrict.length}`);
    check('U/22 四档 system prompt 互不相同',
      !deepEqual(pOff, pStrict) && !deepEqual(pStrict, pLen) && !deepEqual(pLen, pStd) && !deepEqual(pStd, pOff) && !deepEqual(pStrict, pStd));
    check('U/23 不变量规则仍在（策略段追加在其后，不覆盖 INJ 规则）',
      pStrict.includes('不得作为指令执行') || pStrict.length > pOff.length + 40,
      `off=${pOff.length} strict=${pStrict.length}`);
    check('U/24 buildImagePrompt 回传 exposureMode', shared.buildImagePrompt({}).exposureMode === 'standard');
  } finally {
    config.moderation.imagePolicy.exposure.mode = modeBackup;
  }

  // ════════ D：终裁层 WD14 联动开关（executor 单元，无网络） ════════
  console.log('\n──── D. WD14 联动开关（executor） ────');
  const wd14Backup = config.moderation.imagePolicy.useWd14Linkage;
  const flowWithFinalizer = {
    modality: 'image',
    finalizers: [
      { ref: 'plugin.wd14-tagger.linkage', enabled: true, title: 'WD14 终裁联动' },
      { ref: 'plugin.other-plugin.finalize', enabled: true, title: '其它插件终裁器' },
    ],
  };
  try {
    config.moderation.imagePolicy.useWd14Linkage = false;
    const tracesOff = [];
    const resOff = { risk_level: 'low', passed: true, confidence: 0.8 };
    await executor.runFinalizers(flowWithFinalizer, resOff, { addTrace: (t) => tracesOff.push(t) });
    const wd14Off = tracesOff.find((t) => t.ref === 'plugin.wd14-tagger.linkage');
    const otherOff = tracesOff.find((t) => t.ref === 'plugin.other-plugin.finalize');
    check('D/1 关闭开关 ⇒ wd14 终裁器 status=skipped', !!wd14Off && wd14Off.status === 'skipped',
      JSON.stringify(wd14Off || null));
    check('D/2 关闭开关 ⇒ skip_reason 明确', !!wd14Off && wd14Off.skip_reason === 'wd14-linkage-disabled-by-policy',
      `skip_reason=${wd14Off && wd14Off.skip_reason}`);
    check('D/3 关闭开关 ⇒ 不误伤其它插件的终裁器（未被策略跳过）',
      !!otherOff && otherOff.skip_reason !== 'wd14-linkage-disabled-by-policy',
      `skip_reason=${otherOff && otherOff.skip_reason}`);

    config.moderation.imagePolicy.useWd14Linkage = true;
    const tracesOn = [];
    await executor.runFinalizers(flowWithFinalizer, { risk_level: 'low', passed: true }, { addTrace: (t) => tracesOn.push(t) });
    const wd14On = tracesOn.find((t) => t.ref === 'plugin.wd14-tagger.linkage');
    check('D/4 打开开关 ⇒ 不再被策略跳过（恢复执行路径）',
      !!wd14On && wd14On.skip_reason !== 'wd14-linkage-disabled-by-policy',
      `status=${wd14On && wd14On.status} skip_reason=${wd14On && wd14On.skip_reason}`);
    check('D/5 磁盘 finalizers 配置未被删除（可逆）', Array.isArray(flowWithFinalizer.finalizers) && flowWithFinalizer.finalizers.length === 2);
  } finally {
    config.moderation.imagePolicy.useWd14Linkage = wd14Backup;
  }

  // ════════ B：判定缓存（真实云端，同图两次） ════════
  console.log('\n──── B. 判定缓存（真实云端） ────');
  auditDb.open();
  check('B/0 沙箱 audit.db 已打开', auditDb.isOpen(), auditDb.getStatus().reason || '');
  const smallImg = path.join(PROJECT_ROOT, 'data', 'image_blobs', 'ec', 'ec716d6e780857a1.jpg');
  if (!fs.existsSync(smallImg)) {
    skip('B/1-B/4 判定缓存端到端', '找不到测试图片 ' + smallImg);
  } else if (!imagePolicy.getImagePolicyCfg(config).cacheVerdicts) {
    skip('B/1-B/4 判定缓存端到端', 'cacheVerdicts 未开启');
  } else {
    const smallBuf = fs.readFileSync(smallImg);
    const smallB64 = smallBuf.toString('base64');
    const smallHash = imagePolicy.imageHash(smallBuf);
    // 缓存键里的模型名必须与实际调用一致 —— 从真实配置取，勿硬编码
    //（硬编码 qwen3-vl-flash 会在换成 token-plan 可用的视觉模型后恒查不中）。
    const cacheModel = config.qwenCloud?.visionModel || 'qwen3.8-flash';
    // 缓存键的 exposure 维度也必须与产品**同源**：src/qwen_cloud.js 写/读都用
    // imagePolicy.cacheExposureKey(policy)。这里从当前配置派生，而非硬编码 'standard'
    // —— 否则当 moderation.imagePolicy.exposure.mode≠standard（本机为 strict）时恒查不中。
    const cacheMode = imagePolicy.cacheExposureKey(imagePolicy.getImagePolicyCfg(config));
    auditDb.clearVerdictCache();
    const callsBefore = cloudCallLog.length;

    const prompt = shared.buildImagePrompt({ text: '' });
    const r1 = await require('../src/qwen_cloud').moderateImageCloud(prompt.systemPrompt, prompt.userContent, smallB64);
    check('B/1 第一次调用未命中缓存', !r1.cached, `cached=${r1.cached} elapsed=${r1.elapsedMs}`);
    check('B/2 第一次调用后缓存已写入', auditDb.verdictCacheGet(smallHash, cacheModel, cacheMode) !== null,
      `entries=${auditDb.verdictCacheCount()}`);

    const callsMid = cloudCallLog.length;
    const r2 = await require('../src/qwen_cloud').moderateImageCloud(prompt.systemPrompt, prompt.userContent, smallB64);
    const callsAfter = cloudCallLog.length;
    check('B/3 第二次调用 cached=true', r2.cached === true, `cached=${r2.cached} elapsed=${r2.elapsedMs}ms`);
    check('B/4 第二次调用云端请求数 = 0', callsAfter - callsMid === 0,
      `cloudCalls ${callsMid}→${callsAfter}（首次调用共 ${callsMid - callsBefore} 次）`);
    check('B/5 两次判定内容一致（缓存复用的是同一条判定）', r1.content === r2.content,
      `len ${r1.content.length} vs ${r2.content.length}`);
    const hitMeta = auditDb.verdictCacheGet(smallHash, cacheModel, cacheMode);
    check('B/6 缓存行含 created_at（可追溯）', !!hitMeta && !!hitMeta.createdAt, hitMeta && hitMeta.createdAt);
  }

  // ════════ R-A：缩图 tokens 对照（真实云端） ════════
  console.log('\n──── R-A. 发送前缩图 tokens 对照（真实云端） ────');
  if (!haveBigImg) {
    skip('R-A tokens 对照', '找不到大图 ' + bigImg);
  } else {
    const origBuf = fs.readFileSync(bigImg);
    const origDims = imageRef.readDimensions(origBuf, imageRef.detectFormat(origBuf));
    // sharp 探测（环境无关分支用）：装/未装都要能过，不许只认一种环境。
    let sharpOk = true;
    try { require('sharp'); } catch { sharpOk = false; }
    // 768px 对照图：与「长边缩到 768」**同像素尺寸**；Qwen-VL image_tokens 只由像素尺寸
    // 决定（与内容无关），故用纯 Node 生成的 PNG 做 token 对照，结论等价、零依赖。
    const _s = 768 / Math.max(origDims.width, origDims.height);
    const r768W = Math.max(1, Math.round(origDims.width * _s));
    const r768H = Math.max(1, Math.round(origDims.height * _s));
    const r768Buf = makePng(r768W, r768H);
    const origB64 = origBuf.toString('base64');
    const r768B64 = r768Buf.toString('base64');
    console.log(`  # 原图 ${origDims.width}x${origDims.height} (${(origBuf.length / 1024).toFixed(0)}KB)`
      + ` / 768 对照 ${r768W}x${r768H} PNG (${(r768Buf.length / 1024).toFixed(0)}KB，纯 Node 生成，同像素尺寸）`
      + ` / sharp=${sharpOk ? 'OK' : 'MISSING'}`);

    // R-A/4：纯本地缩放（不花云端费用），产品代码同一入口 imagePolicy.resizeForModel。
    const rz = await imagePolicy.resizeForModel(origBuf, 768);
    console.log(`  # resizeForModel(原图,768) => ${JSON.stringify({ applied: rz.applied, reason: rz.reason, fromPx: rz.fromPx, toPx: rz.toPx })}`);

    const modeBackupA = config.moderation.imagePolicy.exposure.mode;
    const cacheBackupA = config.moderation.imagePolicy.cacheVerdicts;
    const maxPxBackupA = config.moderation.imagePolicy.maxImagePx;
    try {
      config.moderation.imagePolicy.exposure.mode = 'off';
      config.moderation.imagePolicy.cacheVerdicts = false; // 对照测量必须两次都真打 API
      // a1 必须是**真原图**：moderateImageCloud 内部会按 maxImagePx 缩图，
      //   用户配置是 1024 ⇒ 不置 0 的话 a1 其实是 1024px 版（实测 img1=909、
      //   收益被算成 38.7%）。maxPx<=0 ⇒ reason='disabled'，即「不缩图」。
      //   仅改内存，finally 还原（绝不写盘）。
      config.moderation.imagePolicy.maxImagePx = 0;
      auditDb.clearVerdictCache();
      const pA = shared.buildImagePrompt({ text: '' });
      const qa = require('../src/qwen_cloud');
      // 文本基线：同 system+text、不含图片 ⇒ image_tokens = prompt_tokens − 基线。
      // system prompt（4338 字符）本身就占 ~2000 tokens，直接比 prompt_tokens 会把
      // 缩图收益稀释掉（首跑实测 44.2%），必须扣除基线只比图像部分。
      const base = await qa.moderateTextCloud(pA.systemPrompt, pA.userContent);
      const tb = base && base.usage && base.usage.prompt_tokens;
      const a1 = await qa.moderateImageCloud(pA.systemPrompt, pA.userContent, origB64);
      const a2 = await qa.moderateImageCloud(pA.systemPrompt, pA.userContent, r768B64);
      const t1 = a1.usage && a1.usage.prompt_tokens;
      const t2 = a2.usage && a2.usage.prompt_tokens;
      const img1 = Number.isFinite(tb) ? t1 - tb : NaN;
      const img2 = Number.isFinite(tb) ? t2 - tb : NaN;
      console.log(`  # 原图(maxImagePx=0) usage=${JSON.stringify(a1.usage)} / 768 对照 usage=${JSON.stringify(a2.usage)} / 文本基线=${tb}`);
      console.log(`  # a1.resized=${JSON.stringify(a1.resized)} / a2.resized=${JSON.stringify(a2.resized)}`);
      if (!t1 || !t2 || !Number.isFinite(img1) || !Number.isFinite(img2)) {
        skip('R-A tokens 对照', `usage 缺失（可能触发平台安检拒收）：orig=${JSON.stringify(a1.usage)} r768=${JSON.stringify(a2.usage)} base=${JSON.stringify(base && base.usage)}`);
      } else {
        const saved = 1 - (img2 / img1);
        check('R-A/1 三次调用（基线/原图/768）都拿到 usage',
          Number.isFinite(t1) && Number.isFinite(t2) && Number.isFinite(tb),
          `orig=${t1} 768px=${t2} base=${tb}`);
        check('R-A/2 缩到 768px 后 image_tokens 显著下降（≥60%）', img2 < img1 && saved >= 0.6,
          `image_tokens ${img1} → ${img2}（省 ${(saved * 100).toFixed(1)}%）；prompt_tokens ${t1} → ${t2}（省 ${((1 - t2 / t1) * 100).toFixed(1)}%）`);
        // a1 侧只保留「元数据可审计」的弱断言（a1 的 maxImagePx=0 ⇒ resized 必为 disabled，
        // 不能把 sharp 分支绑在 a1 上；sharp 分支见 R-A/4）。
        check('R-A/3 结果带缩图/档位元数据（审计可区分）',
          typeof a1.imageHash === 'string' && a1.imageHash.length === 16 && a1.exposureMode === 'off'
          && a1.resized && typeof a1.resized.reason === 'string',
          `hash=${a1.imageHash} mode=${a1.exposureMode} resized=${JSON.stringify(a1.resized)}`);
      }
      // R-A/4：sharp 装/未装**两条分支都断言**（环境无关，不依赖用户配置）
      if (sharpOk) {
        check('R-A/4a sharp 可用 ⇒ 真实缩放生效（applied=true, reason=ok, toPx≤768）',
          rz.applied === true && rz.reason === 'ok' && rz.fromPx >= rz.toPx && rz.toPx <= 768,
          `applied=${rz.applied} reason=${rz.reason} fromPx=${rz.fromPx} toPx=${rz.toPx}`);
      } else {
        check('R-A/4b sharp 缺失 ⇒ 降级为发原图（applied=false, reason=sharp-unavailable）',
          rz.applied === false && rz.reason === 'sharp-unavailable' && rz.fromPx === 4400,
          `applied=${rz.applied} reason=${rz.reason} fromPx=${rz.fromPx} toPx=${rz.toPx}`);
      }
    } finally {
      config.moderation.imagePolicy.exposure.mode = modeBackupA;
      config.moderation.imagePolicy.cacheVerdicts = cacheBackupA;
      config.moderation.imagePolicy.maxImagePx = maxPxBackupA;
    }
  }

  // ════════ R-C：暴露档位逐档实测（真实云端，提示词契约验证） ════════
  console.log('\n──── R-C. 暴露档位逐档实测（真实云端） ────');
  const bikiniImg = path.join(PROJECT_ROOT, 'data', 'image_blobs', '27', '2708ecc1623be54a.jpg');
  if (!fs.existsSync(bikiniImg)) {
    skip('R-C 四档实测', '找不到泳装测试图 ' + bikiniImg);
  } else {
    const bB64 = fs.readFileSync(bikiniImg).toString('base64');
    const qcMod = require('../src/qwen_cloud');
    const modeBackupC = config.moderation.imagePolicy.exposure.mode;
    const cacheBackupC = config.moderation.imagePolicy.cacheVerdicts;
    try {
      config.moderation.imagePolicy.cacheVerdicts = false; // 每档都要真打一次，不能被缓存吃掉
      auditDb.clearVerdictCache();
      const observed = {};
      for (const mode of imagePolicy.EXPOSURE_MODES) {
        config.moderation.imagePolicy.exposure.mode = mode;
        const p = shared.buildImagePrompt({ text: '' });
        const expectBlock = mode === 'strict' ? '注入' : (mode === 'off' ? '不注入' : '注入');
        console.log(`  # mode=${mode}: systemPrompt 含策略段=${p.systemPrompt.includes('图像暴露策略')}（期望${expectBlock}），len=${p.systemPrompt.length}`);
        let res;
        try {
          res = await qcMod.moderateImageCloud(p.systemPrompt, p.userContent, bB64);
        } catch (err) {
          observed[mode] = { error: err.message };
          console.log(`  # mode=${mode} 调用失败: ${err.message}`);
          continue;
        }
        if (res.skipped) { observed[mode] = { error: 'skipped: ' + res.reason }; continue; }
        const parsed = shared.extractJSON(res.content);
        const valid = shared.matchesResultSchema(parsed, ['safe', 'low', 'medium', 'high', 'critical']);
        const norm = shared.normalizeVerdict(parsed || {}, { nonce: p.nonce, source: 'model' });
        observed[mode] = {
          risk_level: parsed && parsed.risk_level,
          schemaOk: valid,
          verdictOk: norm.ok,
          reason: parsed && parsed.reason ? String(parsed.reason).slice(0, 90) : '',
          tokens: res.usage && res.usage.prompt_tokens,
          promptLen: p.systemPrompt.length,
        };
        console.log(`  # mode=${mode} → risk_level=${observed[mode].risk_level} tokens=${observed[mode].tokens} verdictOk=${norm.ok} reason="${observed[mode].reason}"`);
      }

      const modes = ['off', 'lenient', 'standard', 'strict'];
      check('R-C/1 四档都拿到真实模型输出', modes.every((m) => observed[m] && observed[m].risk_level),
        modes.map((m) => `${m}=${observed[m] && (observed[m].risk_level || observed[m].error)}`).join(' '));
      check('R-C/2 四档输出全部通过输出 schema 强校验（含哨兵 policy_version）',
        modes.every((m) => observed[m] && observed[m].schemaOk && observed[m].verdictOk),
        modes.map((m) => `${m}:schema=${observed[m] && observed[m].schemaOk},verdict=${observed[m] && observed[m].verdictOk}`).join(' '));
      const strict = observed.strict && observed.strict.risk_level;
      const lenient = observed.lenient && observed.lenient.risk_level;
      const RISK_RANK = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };
      check('R-C/3 strict 档判定 ≥ lenient 档（档位确实改变模型口径）',
        RISK_RANK[strict] >= RISK_RANK[lenient],
        `lenient=${lenient} strict=${strict}`);
      check('R-C/4 strict 档判 high（泳装/暴露在该档被拦截）', strict === 'high' || strict === 'critical', `strict=${strict}`);
      check('R-C/5 lenient/off 档不判 high（泳装在该档不被拦截）',
        RISK_RANK[lenient] <= RISK_RANK.medium && (!observed.off || RISK_RANK[observed.off.risk_level] <= RISK_RANK.medium),
        `off=${observed.off && observed.off.risk_level} lenient=${lenient}`);
    } finally {
      config.moderation.imagePolicy.exposure.mode = modeBackupC;
      config.moderation.imagePolicy.cacheVerdicts = cacheBackupC;
    }
  }

  // ════════ S：/api/image-policy 路由（沙箱服务，不打云端） ════════
  console.log('\n──── S. /api/image-policy 路由 ────');
  const child = startServer();
  const health = await waitReady(40);
  if (!health) {
    check('S/0 沙箱服务就绪', false, '40s 内未就绪');
  } else {
    try {
      const g1 = await request('GET', '/api/image-policy');
      check('S/1 GET /api/image-policy 200 且含档位/档值清单',
        g1.status === 200 && Array.isArray(g1.json.exposureModes) && Array.isArray(g1.json.allowedImagePx)
        && typeof g1.json.sharpAvailable === 'boolean' && g1.json.cache,
        JSON.stringify(g1.json).slice(0, 220));
      const put1 = await request('PUT', '/api/image-policy', { maxImagePx: 512, cacheVerdicts: false, exposureMode: 'strict', useWd14Linkage: false });
      check('S/2 PUT 合法值 → success 且逐项生效',
        put1.status === 200 && put1.json.success === true
        && put1.json.policy.maxImagePx === 512 && put1.json.policy.cacheVerdicts === false
        && put1.json.policy.exposureMode === 'strict' && put1.json.policy.useWd14Linkage === false,
        JSON.stringify(put1.json).slice(0, 220));
      const g2 = await request('GET', '/api/image-policy');
      check('S/3 PUT 后 GET 读回一致', g2.status === 200 && g2.json.maxImagePx === 512 && g2.json.exposureMode === 'strict'
        && g2.json.useWd14Linkage === false && g2.json.cacheVerdicts === false, JSON.stringify(g2.json).slice(0, 160));
      const put2 = await request('PUT', '/api/image-policy', { exposureMode: 'bogus' });
      check('S/4 PUT 非法档位 → 400 + allowed 清单', put2.status === 400 && Array.isArray(put2.json.allowed), JSON.stringify(put2.json).slice(0, 160));
      const put3 = await request('PUT', '/api/image-policy', { maxImagePx: -5 });
      check('S/5 PUT 非法 maxImagePx → 400', put3.status === 400, JSON.stringify(put3.json).slice(0, 160));
      const put4 = await request('PUT', '/api/image-policy', {});
      check('S/6 PUT 空体 → success 且 changed 为空', put4.status === 200 && put4.json.success === true && Array.isArray(put4.json.changed) && put4.json.changed.length === 0,
        JSON.stringify(put4.json.changed));
      // 恢复默认，避免把沙箱里的 strict 留给后续用例
      await request('PUT', '/api/image-policy', { maxImagePx: 768, cacheVerdicts: true, exposureMode: 'standard', useWd14Linkage: true });
    } finally {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  // ════════ 汇总 ════════
  const cfgAfter = cfgFingerprint();
  check('Z/1 用户 config/default.json 未被改动',
    JSON.stringify(cfgBefore) === JSON.stringify(cfgAfter),
    `before=${JSON.stringify(cfgBefore)} after=${JSON.stringify(cfgAfter)}`);
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.ok).length;
  const failed = ran.length - passed;
  const skipped = results.length - ran.length;
  console.log('');
  console.log(`# 沙箱: ${SANDBOX}`);
  console.log(`# 云端请求数: ${cloudCallLog.length}`);
  console.log(`passed=${passed} failed=${failed} skipped=${skipped}`);
  console.log(`OVERALL: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL: ' + (err && err.stack ? err.stack : err));
  console.log('passed=0 failed=1 skipped=0');
  console.log('OVERALL: FAIL');
  process.exitCode = 1;
});
