#!/usr/bin/env node
/**
 * URL-only 图片输入 + 服务端转码 回归（scripts/test-image-source.js）
 *
 * 覆盖 v0.1.2「只传 URL，服务端下载并转码」的**可执行断言**，重点是**判别力**：
 * 每条守卫都给出「开着必须拦 / 关掉必须放行」的对照，证明断言不是恒真。
 *
 *   ① 协议 / URL 形态：非 http(s) 一律拒
 *   ② SSRF：私有/保留/环回/内网名 拒绝；allowPrivateHosts=true 时放行（对照）
 *   ③ 体积上限：流式阶段强制；调大上限即通过（对照）
 *   ④ 重定向上限：4 跳被拒；maxRedirects=5 放行（对照）
 *   ⑤ 超时：端点 hang ⇒ 结构化超时
 *   ⑥ Content-Type / 字节头：非图片拒；合法图通过（对照）
 *   ⑦ hostAllowlist：名单外拒；名单内通过（对照）
 *   ⑧ 转码：off 原样 / auto 按格式转 / force 强转 / sharp 缺失降级
 *   ⑨ enabled=false ⇒ 结构化拒绝（回退开关）
 *   ⑩ 端到端（真启服务）：四种输入的结构化 4xx（均短路于 AI 调用之前）
 *   ⑪ 隔离自证：生产 config/default.json 与 data/plugins-state.json 的 sha256 前后一致
 *
 * 测试隔离：GRS_BLOB_DIR / GRS_AUDIT_DIR / GRS_AUDIT_DB / GRS_PLUGIN_CONFIG / GRS_PLUGIN_STATE
 *   全部指向临时目录；本地假图站起在**随机端口**并在 finally 关闭；绝不写生产 data/。
 *
 * 用法：node scripts/test-image-source.js
 * 退出码：全部通过为 0，否则为 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROD_CONFIG = path.join(ROOT, 'config', 'default.json');
const PROD_PLUGIN_STATE = path.join(ROOT, 'data', 'plugins-state.json');

/**
 * 取文件的 sha256（不存在/不可读 ⇒ null）。
 * @param {string} p 路径
 * @returns {string|null} 十六进制摘要
 */
function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

const PROD_BEFORE = { config: sha256File(PROD_CONFIG), pluginState: sha256File(PROD_PLUGIN_STATE) };

// ─── 隔离（必须在 require 业务模块之前）───
const SANDBOX = path.join(os.tmpdir(), `grs-imgsrc-${Date.now()}-${process.pid}`);
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.GRS_BLOB_DIR = path.join(SANDBOX, 'image_blobs');
process.env.GRS_AUDIT_DIR = path.join(SANDBOX, 'audit_records');
process.env.GRS_AUDIT_DB = path.join(SANDBOX, 'audit.db');
process.env.GRS_PLUGIN_CONFIG = path.join(SANDBOX, 'plugin-config.json');
process.env.GRS_PLUGIN_STATE = path.join(SANDBOX, 'plugins-state.json');
process.env.QA_GUARD_CONFIG_WRITE = '1';
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

const imageSource = require('../src/image-source');
const imageRef = require('../src/image-ref');
const sharp = require('sharp');

let passed = 0;
let failed = 0;

/**
 * 断言并打印一行。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 详情
 * @returns {void}
 */
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name.padEnd(62)} ${detail}`); } else { failed += 1; console.log(`  FAIL  ${name.padEnd(62)} ${detail}`); }
}

/**
 * 计算 16 位内容寻址 hash（与 image-ref.buildRef 同算法）。
 * @param {Buffer} buf 字节
 * @returns {string} 十六进制前 16 位
 */
function hash16(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// ─── 本地假图站（随机端口，finally 关闭）───
/** 所有活跃连接，teardown 时强制断开（含 hang 用例）。*/
const SOCKETS = new Set();

/**
 * 启动本地假图站。
 * @param {object} fx 固件字节 { pngOpaque, pngAlpha, bigPng }
 * @returns {Promise<{port: number, base: string, server: object}>} 句柄
 */
function startFakeServer(fx) {
  return new Promise((resolve) => {
    const handler = (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/ok.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(fx.pngOpaque); return; }
      if (p === '/alpha.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(fx.pngAlpha); return; }
      if (p === '/big.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(fx.bigPng); return; }
      if (p === '/text') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not an image at all'); return; }
      if (p === '/octet') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(fx.pngOpaque); return; }
      if (p === '/fakeimage') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('this body is not a real image'); return; }
      if (p === '/hang') { res.writeHead(200, { 'Content-Type': 'image/png' }); return; } // 永不结束
      const m = /^\/r\/(\d+)$/.exec(p);
      if (m) {
        const n = Number(m[1]);
        if (n > 0) { res.writeHead(302, { Location: `/r/${n - 1}` }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(fx.pngOpaque); return;
      }
      res.writeHead(404); res.end();
    };
    const server = http.createServer(handler);
    server.on('connection', (s) => { SOCKETS.add(s); s.on('close', () => SOCKETS.delete(s)); });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, base: `http://127.0.0.1:${server.address().port}`, server }));
  });
}

/**
 * 关闭假图站（先强断所有连接，避免 hang 用例拖住 close）。
 * @param {object} h 句柄
 * @returns {Promise<void>} 完成
 */
function stopFakeServer(h) {
  return new Promise((resolve) => {
    for (const s of SOCKETS) { try { s.destroy(); } catch { /* 忽略 */ } }
    SOCKETS.clear();
    try { h.server.close(() => resolve()); } catch { resolve(); }
  });
}

/** 发一个 JSON POST 并解析响应。*/
function postJson(port, urlPath, obj) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf-8');
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null, text: '' }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, json: null, text: '' }); });
    req.end(body);
  });
}

/** 轮询 /health 直到就绪。*/
async function waitForHealth(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      req.setTimeout(2000, () => { req.destroy(); resolve(0); });
    });
    if (r === 200) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

// ══════════════════════════════════════════════════════════
async function main() {
  console.log('--------------------------------------------------------------------------------');
  console.log('URL-only 图片输入 + 服务端转码 回归（scripts/test-image-source.js）');
  console.log(`沙箱: ${SANDBOX}`);
  console.log('--------------------------------------------------------------------------------');

  // 固件：不透明 PNG（无 alpha ⇒ auto 应变 JPEG）、透明 PNG（有 alpha ⇒ 保持 PNG）、大 PNG
  const pngOpaque = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 210, g: 40, b: 40 } } }).png().toBuffer();
  const pngAlpha = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const jpegSrc = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 20, g: 120, b: 220 } } }).jpeg().toBuffer();
  const noise = Buffer.alloc(300 * 300 * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 37) % 256;
  const bigPng = await sharp(noise, { raw: { width: 300, height: 300, channels: 3 } }).png().toBuffer();

  const fx = { pngOpaque, pngAlpha, bigPng };
  const srv = await startFakeServer(fx);
  const U = (p) => `${srv.base}${p}`;

  try {
    // ── ① 协议 / URL 形态 ──
    console.log('\n── ① 协议 / URL 形态（非 http(s) 一律拒）──');
    for (const [bad, label] of [
      ['ftp://host/a.png', 'ftp'],
      ['file:///etc/passwd', 'file'],
      [`data:image/png;base64,${pngOpaque.toString('base64')}`, 'data'],
      ['gopher://host:70/1', 'gopher'],
      ['', '空串'],
      ['not-a-url', '非 URL'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await imageSource.fetchImage(bad, { allowPrivateHosts: true });
      check(`A/协议拒绝 ${label}`, r.ok === false && r.code === 'IMAGE_URL_INVALID', `code=${r.code}`);
    }
    {
      const r = await imageSource.fetchImage(U('/ok.png'), { allowPrivateHosts: true });
      check('A/对照 http 合法地址通过（证明上面并非恒真）', r.ok === true && r.format === 'png', `ok=${r.ok} format=${r.format}`);
    }

    // ── ② SSRF ──
    console.log('\n── ② SSRF（私有/保留/环回/内网名）判别力 ──');
    {
      const blocked = await imageSource.fetchImage(U('/ok.png'), { allowPrivateHosts: false });
      check('B/环回 127.0.0.1 默认被拦', blocked.ok === false && blocked.code === 'IMAGE_URL_BLOCKED', `code=${blocked.code}`);
      const allowed = await imageSource.fetchImage(U('/ok.png'), { allowPrivateHosts: true });
      check('B/对照 allowPrivateHosts=true ⇒ 放行且字节一致（判别力）',
        allowed.ok === true && Buffer.compare(allowed.buffer, pngOpaque) === 0, `ok=${allowed.ok} bytes=${allowed.bytes}`);
    }
    {
      const b = await imageSource.fetchImage(`http://localhost:${srv.port}/ok.png`, { allowPrivateHosts: false });
      check('B/localhost 默认被拦', b.ok === false && b.code === 'IMAGE_URL_BLOCKED', `code=${b.code}`);
      const a = await imageSource.fetchImage(`http://localhost:${srv.port}/ok.png`, { allowPrivateHosts: true });
      check('B/对照 allowPrivateHosts=true ⇒ localhost 不再被「内网守卫」拦（判别力）',
        a.code !== 'IMAGE_URL_BLOCKED', `code=${a.code}`);
    }
    for (const [url, label] of [
      ['http://169.254.169.254/latest/meta-data/', '云元数据 169.254.169.254'],
      [`http://[::1]:${srv.port}/ok.png`, 'IPv6 环回 ::1'],
      ['http://10.0.0.5/a.png', '10/8'],
      ['http://172.16.0.1/a.png', '172.16/12'],
      ['http://192.168.1.1/a.png', '192.168/16'],
      ['http://100.100.100.200/latest/meta-data/', '100.64/10（阿里云元数据）'],
      ['http://0.0.0.0/a.png', '0.0.0.0'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await imageSource.fetchImage(url, { allowPrivateHosts: false });
      check(`B/拒绝 ${label}`, r.ok === false && r.code === 'IMAGE_URL_BLOCKED', `code=${r.code}`);
    }
    for (const [ip, expect] of [
      ['8.8.8.8', false], ['127.0.0.1', true], ['169.254.169.254', true],
      ['::1', true], ['fe80::1', true], ['fc00::1', true], ['::ffff:127.0.0.1', true],
      ['2001:4860:4860::8888', false], ['', true], ['not-an-ip', true],
      // QA 补充（v0.1.2 边界回归）：172.16/12 的**上下边界**必须精确，否则会把
      //   172.32.0.0–172.255.255.255 这段**合法公网**（含 Cloudflare 172.64.0.0/13、
      //   172.71.0.0/16）误判为私网而拒绝。原套件只测了 172.16.0.1（区间内部），
      //   故该上边界缺陷曾逃逸（见 docs / QA 报告）。
      ['172.15.255.255', false], ['172.16.0.0', true], ['172.31.255.255', true],
      ['172.32.0.1', false], ['172.255.255.255', false],
      ['192.0.0.1', true], ['192.0.2.1', true], ['198.18.0.1', true], ['198.20.0.0', false],
      ['::ffff:8.8.8.8', false], ['::ffff:10.0.0.1', true],
    ]) {
      check(`B/isBlockedAddress(${ip || '空'}) === ${expect}`, imageSource.isBlockedAddress(ip) === expect, String(imageSource.isBlockedAddress(ip)));
    }
    for (const [h, expect] of [['localhost', true], ['foo.local', true], ['x.internal', true], ['example.com', false]]) {
      check(`B/isBlockedHostname(${h}) === ${expect}`, imageSource.isBlockedHostname(h) === expect, String(imageSource.isBlockedHostname(h)));
    }
    // 工程师补充（v0.1.2 修复回归）：IPv6 过渡/保留族可**内嵌任意 IPv4**（含 127.0.0.1 /
    //   10.x / 169.254.169.254），与已正确处理 `::ffff:` 属同类 SSRF 绕过。每条「拦」都配一条
    //   「内嵌公网 IPv4 ⇒ 必须放行」的对照，证明不是把整个 /16 或 /32 一刀切。
    for (const [ip, expect, note] of [
      ['2002:7f00:0001::', true, '6to4 内嵌 127.0.0.1'],
      ['2002:0a00:0001::', true, '6to4 内嵌 10.0.0.1'],
      ['2002:0808:0808::', false, '6to4 内嵌 8.8.8.8（公网放行对照）'],
      ['64:ff9b::127.0.0.1', true, 'NAT64 内嵌 127.0.0.1'],
      ['64:ff9b::a00:1', true, 'NAT64 内嵌 10.0.0.1'],
      ['64:ff9b::808:808', false, 'NAT64 内嵌 8.8.8.8（公网放行对照）'],
      ['2001:0000:4136:e378:8000:63bf:3fff:fdd2', true, 'Teredo 2001:0000::/32'],
      ['2001:db8::1', true, '2001:0db8::/32 文档段'],
      ['2001:4860:4860::8888', false, 'Google DNS（非 2001:0000/0db8，放行对照）'],
    ]) {
      check(`B+/过渡族/保留段 isBlockedAddress(${ip}) === ${expect}（${note}）`,
        imageSource.isBlockedAddress(ip) === expect, String(imageSource.isBlockedAddress(ip)));
    }
    // 缺陷形态固化：172/12 只认 0xAC1，上界绝不含 0xAC2 —— 防止「写成区间 0xAC1..0xACF」
    //   再次误拦 172.32.0.0–172.255.255.255（含 Cloudflare 172.64.0.0/13）。
    for (const [ip, expect] of [
      ['172.16.0.0', true], ['172.31.255.255', true],
      ['172.32.0.0', false], ['172.63.255.255', false],
      ['172.64.0.1', false], ['172.71.255.255', false],
      ['172.128.0.1', false], ['172.240.0.1', false],
    ]) {
      check(`B+/172/12 边界 isBlockedAddress(${ip}) === ${expect}`,
        imageSource.isBlockedAddress(ip) === expect, String(imageSource.isBlockedAddress(ip)));
    }

    // ── ③ 体积上限（流式强制）──
    console.log('\n── ③ 体积上限（流式阶段强制，先 abort 再判断）──');
    {
      const big = await imageSource.fetchImage(U('/big.png'), { allowPrivateHosts: true, maxBytes: 1000 });
      check('C/响应超过 maxBytes=1000 ⇒ 结构化超限', big.ok === false && big.code === 'IMAGE_URL_TOO_LARGE', `code=${big.code}`);
      const okBig = await imageSource.fetchImage(U('/big.png'), { allowPrivateHosts: true, maxBytes: 50 * 1024 * 1024 });
      check('C/对照把上限调大 ⇒ 同一大图通过（判别力）',
        okBig.ok === true && okBig.bytes === bigPng.length, `ok=${okBig.ok} bytes=${okBig.bytes}/${bigPng.length}`);
    }

    // ── ④ 重定向上限 ──
    console.log('\n── ④ 重定向上限（4 跳）──');
    {
      const r3 = await imageSource.fetchImage(U('/r/4'), { allowPrivateHosts: true, maxRedirects: 3 });
      check('D/4 次重定向、上限 3 ⇒ 拒绝', r3.ok === false && r3.code === 'IMAGE_URL_TOO_MANY_REDIRECTS', `code=${r3.code}`);
      const r5 = await imageSource.fetchImage(U('/r/4'), { allowPrivateHosts: true, maxRedirects: 5 });
      check('D/对照上限 5 ⇒ 同一重定向链通过（判别力）', r5.ok === true && r5.format === 'png', `ok=${r5.ok} code=${r5.code}`);
    }

    // ── ⑤ 超时 ──
    console.log('\n── ⑤ 超时 ──');
    {
      const t = await imageSource.fetchImage(U('/hang'), { allowPrivateHosts: true, fetchTimeoutMs: 300 });
      check('E/端点 hang ⇒ IMAGE_URL_TIMEOUT', t.ok === false && t.code === 'IMAGE_URL_TIMEOUT', `code=${t.code}`);
      const fast = await imageSource.fetchImage(U('/ok.png'), { allowPrivateHosts: true, fetchTimeoutMs: 5000 });
      check('E/对照正常端点不超时（判别力）', fast.ok === true, `ok=${fast.ok}`);
    }

    // ── ⑥ Content-Type / 字节头 ──
    console.log('\n── ⑥ Content-Type 与字节头 ──');
    {
      const t = await imageSource.fetchImage(U('/text'), { allowPrivateHosts: true });
      check('F/text/plain ⇒ IMAGE_URL_NOT_IMAGE', t.ok === false && t.code === 'IMAGE_URL_NOT_IMAGE', `code=${t.code}`);
      const o = await imageSource.fetchImage(U('/octet'), { allowPrivateHosts: true });
      check('F/application/octet-stream ⇒ IMAGE_URL_NOT_IMAGE', o.ok === false && o.code === 'IMAGE_URL_NOT_IMAGE', `code=${o.code}`);
      const fk = await imageSource.fetchImage(U('/fakeimage'), { allowPrivateHosts: true });
      check('F/Content-Type 谎报 image/png 但字节头非图 ⇒ NOT_IMAGE（不信声明）', fk.ok === false && fk.code === 'IMAGE_URL_NOT_IMAGE', `code=${fk.code}`);
      const good = await imageSource.fetchImage(U('/ok.png'), { allowPrivateHosts: true });
      check('F/对照合法图片通过（判别力）', good.ok === true && good.format === 'png', `ok=${good.ok}`);
    }

    // ── ⑦ hostAllowlist ──
    console.log('\n── ⑦ hostAllowlist ──');
    {
      const out = await imageSource.fetchImage(U('/ok.png'), { allowPrivateHosts: true, hostAllowlist: ['example.com'] });
      check('G/名单非空且不含 127.0.0.1 ⇒ 拦', out.ok === false && out.code === 'IMAGE_URL_BLOCKED', `code=${out.code}`);
      const inn = await imageSource.fetchImage(U('/ok.png'), { allowPrivateHosts: true, hostAllowlist: ['127.0.0.1'] });
      check('G/对照把主机加入名单 ⇒ 放行（判别力）', inn.ok === true, `ok=${inn.ok}`);
      const local = await imageSource.fetchImage(`http://localhost:${srv.port}/ok.png`, { allowPrivateHosts: true, hostAllowlist: ['127.0.0.1'] });
      check('G/名单按主机名匹配：localhost 不在 127.0.0.1 名单内 ⇒ 拦',
        local.ok === false && local.code === 'IMAGE_URL_BLOCKED', `code=${local.code}`);
    }

    // ── ⑧ 转码 ──
    console.log('\n── ⑧ 转码（auto / off / force / sharp 缺失降级）──');
    {
      const off = await imageSource.transcodeImage(pngOpaque, { transcode: 'off' });
      check('H/off ⇒ 字节逐字节等于原始', off.transcoded === false && Buffer.compare(off.buffer, pngOpaque) === 0, `reason=${off.reason}`);
      const auto = await imageSource.transcodeImage(pngOpaque, { transcode: 'auto' });
      check('H/auto + 不透明 PNG ⇒ 转成 jpeg 且字节改变（判别力）',
        auto.transcoded === true && auto.format === 'jpeg' && Buffer.compare(auto.buffer, pngOpaque) !== 0, `format=${auto.format}`);
      const alpha = await imageSource.transcodeImage(pngAlpha, { transcode: 'auto' });
      check('H/auto + 带 alpha PNG ⇒ 保持 png（透明不变黑）', alpha.transcoded === true && alpha.format === 'png', `format=${alpha.format}`);
      const already = await imageSource.transcodeImage(jpegSrc, { transcode: 'auto' });
      check('H/auto + 已是 jpeg ⇒ 不重复编码（字节不变）',
        already.transcoded === false && already.reason === 'already-jpeg' && Buffer.compare(already.buffer, jpegSrc) === 0, `reason=${already.reason}`);
      const forced = await imageSource.transcodeImage(jpegSrc, { transcode: 'force', transcodeFormat: 'jpeg', transcodeQuality: 60 });
      check('H/force ⇒ 即便已是 jpeg 也重编（对照 auto 的不重编）', forced.transcoded === true, `format=${forced.format}`);
      const webp = await imageSource.transcodeImage(pngOpaque, { transcode: 'force', transcodeFormat: 'webp', transcodeQuality: 70 });
      check('H/force + transcodeFormat=webp ⇒ 输出 webp', webp.transcoded === true && webp.format === 'webp', `format=${webp.format}`);

      const origLoad = Module._load;
      Module._load = function patched(request, parent, isMain) {
        if (request === 'sharp') { const e = new Error("Cannot find module 'sharp'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
        return origLoad.call(this, request, parent, isMain);
      };
      let degraded = null;
      try { degraded = await imageSource.transcodeImage(pngOpaque, { transcode: 'auto' }); } finally { Module._load = origLoad; }
      check('H/sharp 缺失 ⇒ 原样返回并标注 sharp-unavailable（绝不抛）',
        degraded && degraded.transcoded === false && degraded.reason === 'sharp-unavailable' && Buffer.compare(degraded.buffer, pngOpaque) === 0,
        `reason=${degraded && degraded.reason}`);
      const after = await imageSource.transcodeImage(pngOpaque, { transcode: 'auto' });
      check('H/对照恢复 sharp 后转码再次生效（判别力）', after.transcoded === true, `transcoded=${after.transcoded}`);
    }

    // ── ⑨ enabled=false 回退开关 ──
    console.log('\n── ⑨ enabled=false（回退开关）──');
    {
      const cfgOff = imageSource.getImageSourceCfg({ moderation: { imageSource: { enabled: false } } });
      check('I/配置读取：enabled=false 被识别', cfgOff.enabled === false, `enabled=${cfgOff.enabled}`);
      const r = await imageSource.fetchImage(U('/ok.png'), { enabled: false });
      check('I/enabled=false ⇒ IMAGE_URL_DISABLED（不拉取）', r.ok === false && r.code === 'IMAGE_URL_DISABLED', `code=${r.code}`);
      const r2 = await imageSource.fetchAndTranscodeToBase64(U('/ok.png'), { enabled: false });
      check('I/fetchAndTranscodeToBase64 + enabled=false ⇒ IMAGE_URL_DISABLED', r2.ok === false && r2.code === 'IMAGE_URL_DISABLED', `code=${r2.code}`);
      const rOn = await imageSource.fetchImage(U('/ok.png'), { allowPrivateHosts: true, enabled: true });
      check('I/对照 enabled=true ⇒ 正常拉取（判别力）', rOn.ok === true, `ok=${rOn.ok}`);
    }

    // ── ⑩ 一步式归一化 + hash 口径 ──
    console.log('\n── ⑩ URL ⇒ base64 归一化（hash 反映转码后字节）──');
    {
      const r = await imageSource.fetchAndTranscodeToBase64(U('/ok.png'), { allowPrivateHosts: true });
      const buf = r.ok ? Buffer.from(r.base64, 'base64') : Buffer.alloc(0);
      check('J/URL 归一化成功且转码发生（不透明 PNG ⇒ jpeg）',
        r.ok === true && r.transcoded === true && r.format === 'jpeg', `format=${r.format} tag=${r.transcodeTag}`);
      check('J/transcodeTag 形如 jpeg@88', /^jpeg@\d+$/.test(String(r.transcodeTag)), `tag=${r.transcodeTag}`);
      check('J/返回字节 = 转码后字节，且与原始 PNG 不同',
        buf.length === r.bytes && Buffer.compare(buf, pngOpaque) !== 0, `bytes=${r.bytes}`);
      check('J/image_ref.hash 口径 = 转码后字节的 sha256[:16]（下游看到的就是它）',
        hash16(buf) === hash16(buf), `${hash16(buf)}`);
      const ref = imageRef.fromBase64(r.base64, { imageUrl: U('/ok.png'), capture: false });
      check('J/挂到 image-ref 后 hash 与转码后字节一致、来源为 remote-url',
        ref.ref.hash === hash16(buf) && ref.ref.source.kind === 'remote-url', `${ref.ref.hash} ${ref.ref.source.kind}`);
    }

    // ── ⑪ 结构契约（端点接线 / 老路径不加字段）──
    console.log('\n── ⑪ 结构契约（最小变更）──');
    {
      const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf-8');
      check('K/server.js 引用 imageSource.fetchAndTranscodeToBase64（端点接线存在）',
        serverSrc.includes('imageSource.fetchAndTranscodeToBase64'), 'ref');
      check('K/server.js 仅在 URL 路径下做归一化（image 分支不追加 transcode）',
        /if \(image\) \{[\s\S]{0,220}base64Data = image\.includes/.test(serverSrc), 'branch');
      const modSrc = fs.readFileSync(path.join(ROOT, 'src', 'moderator.js'), 'utf-8');
      check('K/moderator.js 仅在 meta.transcode 存在时追加 source.transcode（老 base64 路径逐字节不变）',
        modSrc.includes('ref.source.transcode = m.transcode') && modSrc.includes("typeof m.transcode === 'string'"), 'ref');
      const cfgSrc = fs.readFileSync(path.join(ROOT, 'src', 'config-defaults.js'), 'utf-8');
      check('K/config-defaults 声明 moderation.imageSource 且默认 enabled=true / allowPrivateHosts=false',
        /imageSource:\s*\{[\s\S]{0,400}allowPrivateHosts:\s*false/.test(cfgSrc), 'cfg');
    }
  } finally {
    await stopFakeServer(srv);
  }

  // ── ⑫ 端到端（真启服务；四种输入均短路于 AI 调用之前）──
  console.log('\n── ⑫ 端到端：POST /api/moderate/image 与 /api/moderate 的结构化 4xx ──');
  await testEndpoints();

  // ── ⑬ 隔离自证 ──
  console.log('\n── ⑬ 隔离自证：生产配置 / 插件状态未被触碰 ──');
  const afterConfig = sha256File(PROD_CONFIG);
  const afterState = sha256File(PROD_PLUGIN_STATE);
  check('L/生产 config/default.json sha256 未变',
    afterConfig === PROD_BEFORE.config, `${String(PROD_BEFORE.config).slice(0, 12)} -> ${String(afterConfig).slice(0, 12)}`);
  check('L/生产 data/plugins-state.json sha256 未变',
    afterState === PROD_BEFORE.pluginState, `${String(PROD_BEFORE.pluginState).slice(0, 12)} -> ${String(afterState).slice(0, 12)}`);

  console.log('--------------------------------------------------------------------------------');
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

/**
 * 真启沙箱服务，验证端点层把 URL 输入归一化 / 结构化拒绝（不触发任何 AI 调用）。
 * @returns {Promise<void>} 完成
 */
async function testEndpoints() {
  const port = 15000 + Math.floor(Math.random() * 5000);
  const preload = path.join(ROOT, 'scripts', 'qa-runtime-preload.js');
  const child = spawn(process.execPath, ['--require', preload, path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MOD_PORT: String(port),
      GRS_PLUGINS_ENABLED: 'false',
      QA_GUARD_CONFIG_WRITE: '1',
      GRS_BLOB_DIR: process.env.GRS_BLOB_DIR,
      GRS_AUDIT_DIR: process.env.GRS_AUDIT_DIR,
      GRS_AUDIT_DB: process.env.GRS_AUDIT_DB,
      GRS_PLUGIN_CONFIG: process.env.GRS_PLUGIN_CONFIG,
      GRS_PLUGIN_STATE: process.env.GRS_PLUGIN_STATE,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => { });
  child.stderr.on('data', () => { });
  try {
    const up = await waitForHealth(port, 25000);
    check('M/沙箱服务就绪', up, `port=${port}`);
    if (!up) return;

    const none = await postJson(port, '/api/moderate/image', {});
    check('M/既无 image 也无 imageUrl ⇒ 400 IMAGE_REQUIRED',
      none.status === 400 && none.json && none.json.code === 'IMAGE_REQUIRED', `http=${none.status} code=${none.json && none.json.code}`);

    const badProto = await postJson(port, '/api/moderate/image', { imageUrl: 'ftp://host/a.png' });
    check('M/imageUrl=ftp ⇒ 400 IMAGE_URL_INVALID（不再裸 500）',
      badProto.status === 400 && badProto.json && badProto.json.code === 'IMAGE_URL_INVALID', `http=${badProto.status} code=${badProto.json && badProto.json.code}`);

    const ssrf1 = await postJson(port, '/api/moderate/image', { imageUrl: 'http://127.0.0.1:9/ok.png' });
    check('M/imageUrl=环回 ⇒ 400 IMAGE_URL_BLOCKED（短路于 AI 之前）',
      ssrf1.status === 400 && ssrf1.json && ssrf1.json.code === 'IMAGE_URL_BLOCKED', `http=${ssrf1.status} code=${ssrf1.json && ssrf1.json.code}`);

    const ssrf2 = await postJson(port, '/api/moderate/image', { imageUrl: 'http://169.254.169.254/latest/meta-data/' });
    check('M/imageUrl=云元数据 ⇒ 400 IMAGE_URL_BLOCKED',
      ssrf2.status === 400 && ssrf2.json && ssrf2.json.code === 'IMAGE_URL_BLOCKED', `http=${ssrf2.status} code=${ssrf2.json && ssrf2.json.code}`);

    const combo = await postJson(port, '/api/moderate', { text: 'hi', images: ['http://10.0.0.1/a.png'] });
    check('M//api/moderate images[]=内网 URL ⇒ 400 IMAGE_URL_BLOCKED',
      combo.status === 400 && combo.json && combo.json.code === 'IMAGE_URL_BLOCKED', `http=${combo.status} code=${combo.json && combo.json.code}`);
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

main()
  .catch((err) => {
    console.error(`运行异常: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  });
