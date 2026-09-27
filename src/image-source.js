/**
 * 远程图片拉取 + 转码（src/image-source.js）
 *
 * 用户诉求（Alin）：「给图片 api 支持只传入 url，然后 grs 自己对图像进行转码」。
 * 也就是让机器人**只传 URL**，由服务端下载并转码后，再走既有审核链路。
 *
 * 设计要点：
 * ① **只做「字节来源」的归一化**：本模块把 URL 变成 base64 字节，交回既有
 *    `moderator.moderateImage()`。它**不感知拓扑**、不新增任何主动调用 —— 审核能力
 *    仍只由画布拓扑决定（踩线风险为零）。
 * ② **SSRF 是安全红线**：用自定义 `lookup` 在**连接用的那一次 DNS 解析结果**上做校验，
 *    而不是只校验域名。这样每次 connect 都被校验，消除「先解析校验、再解析连接」的
 *    DNS 重绑定窗口（残余风险见 `makeSafeLookup` 注释）。重定向每一跳都重新过校验。
 * ③ **体积上限在流式阶段强制**：读到一个 chunk 就累加，超限**立即 abort**，绝不先
 *    `arrayBuffer()` 再判断大小（那等于把攻击载荷整个读进内存）。
 * ④ **转码失败绝不抛**：sharp 缺失/异常一律降级为「原样返回」，风格与 `image-policy.js`
 *    的 `resizeForModel()` 完全一致（图片链路永不阻断审核）。
 * ⑤ **可逆**：`moderation.imageSource.enabled=false` ⇒ 端点收到 URL 输入直接结构化拒绝，
 *    不拉取、不转码，行为等同该能力不存在。
 */

'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const { loadConfig } = require('./config');
const { logWarn } = require('./logger');
const imageRef = require('./image-ref');

/** 默认单图上限（与 imageCapture 对齐；`maxBytes<=0` 时回落到它）。*/
const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 3;
const ALLOWED_TRANSCODE_MODES = Object.freeze(['auto', 'off', 'force']);
const ALLOWED_TRANSCODE_FORMATS = Object.freeze(['jpeg', 'webp']);

/** sharp 缺失只告警一次，避免每张图刷屏（与 image-policy 同策略）。*/
let _sharpMissingWarned = false;

/**
 * 取 [min,max] 内的整数，非法值回落 fallback。
 * @param {*} value 原始值
 * @param {number} fallback 兜底值
 * @param {number} min 下界
 * @param {number} max 上界
 * @returns {number} 归一化整数
 */
function intInRange(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  return rounded < min || rounded > max ? fallback : rounded;
}

/**
 * 读取并规范化 `moderation.imageSource` 配置（字段缺失/非法时按默认值兜底，绝不抛）。
 * @param {object} [config] 配置对象（缺省时 loadConfig()）
 * @returns {object} 归一化配置
 */
function getImageSourceCfg(config) {
  let cfg = config;
  if (!cfg) {
    try { cfg = loadConfig(); } catch { cfg = null; }
  }
  const raw = (cfg && cfg.moderation && cfg.moderation.imageSource) || {};
  const rawMode = String(raw.transcode || '').toLowerCase();
  const rawFormat = String(raw.transcodeFormat || '').toLowerCase();
  return {
    enabled: raw.enabled !== false,
    fetchTimeoutMs: intInRange(raw.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS, 100, 120000),
    maxRedirects: intInRange(raw.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, 10),
    allowPrivateHosts: raw.allowPrivateHosts === true,
    hostAllowlist: Array.isArray(raw.hostAllowlist)
      ? raw.hostAllowlist.map((h) => String(h).trim().toLowerCase()).filter(Boolean)
      : [],
    transcode: ALLOWED_TRANSCODE_MODES.includes(rawMode) ? rawMode : 'auto',
    transcodeFormat: ALLOWED_TRANSCODE_FORMATS.includes(rawFormat) ? rawFormat : 'jpeg',
    transcodeQuality: intInRange(raw.transcodeQuality, 88, 1, 100),
    // 0 ⇒ 沿用 imageCapture.maxBytes（单一真相，避免两处上限漂移）
    maxBytes: Number(raw.maxBytes) > 0 ? Math.round(Number(raw.maxBytes)) : 0,
  };
}

// ─── SSRF 地址分类（零依赖，纯计算） ───

/**
 * IPv4 字符串 → 32 位无符号整数。
 * @param {string} ip IPv4
 * @returns {number|null} 整数（非法 ⇒ null）
 */
function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n >>> 0;
}

/**
 * 是否私有/保留/不可路由 IPv4（SSRF 目标黑名单）。
 * @param {string} ip IPv4
 * @returns {boolean} 是否应拒绝
 */
function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  if ((n >>> 24) === 0) return true;            // 0.0.0.0/8（含 0.0.0.0）
  if ((n >>> 24) === 10) return true;           // 10/8
  if ((n >>> 24) === 127) return true;          // 127/8 环回
  if ((n >>> 24) >= 224) return true;           // 224/4 组播 + 240/4 保留 + 广播
  // 172.16/12：前 12 位恒为 0xAC1（172.16.0.0 = 0xAC10_0000 与 172.31.255.255 = 0xAC1F_FFFF
  //   同值）⇒ 只能等值比较。写成区间 0xAC1..0xACF 会把 172.32.0.0–172.255.255.255 一并拦掉，
  //   其中含 Cloudflare 172.64.0.0/13 等**合法公网 CDN**（解析到它们的域名会被连坐拒绝）。
  if ((n >>> 20) === 0xAC1) return true;
  const p16 = n >>> 16;
  if (p16 === 0xC0A8) return true;              // 192.168/16
  if (p16 === 0xA9FE) return true;              // 169.254/16（含云元数据 169.254.169.254）
  if ((n >>> 22) === 0x191) return true;        // 100.64/10 CGNAT
  if (p16 === 0xC000 || p16 === 0xC002) return true; // 192.0.0/24 + 192.0.2/24
  if ((n >>> 17) === 0x6309) return true;       // 198.18/15 基准测试段
  return false;
}

/**
 * 把 IPv6（含压缩与 IPv4 内嵌写法）展开为 8 个 16 位分组。
 * @param {string} ip IPv6
 * @returns {number[]|null} 8 个分组（非法 ⇒ null）
 */
function expandV6(ip) {
  let s = String(ip).toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.indexOf('.') >= 0) {
    const lastColon = s.lastIndexOf(':');
    const v4 = s.slice(lastColon + 1);
    const n = ipv4ToInt(v4);
    if (n === null) return null;
    const h1 = ((n >>> 16) & 0xffff).toString(16);
    const h2 = (n & 0xffff).toString(16);
    s = `${s.slice(0, lastColon + 1)}${h1}:${h2}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some((x) => !Number.isInteger(x))) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/**
 * 由两个 16 位分组还原内嵌 IPv4 点分十进制（用于 6to4 / NAT64 内嵌地址）。
 * @param {number} a 高 16 位
 * @param {number} b 低 16 位
 * @returns {string} 点分十进制
 */
function hextetsToIPv4(a, b) {
  return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
}

/**
 * 是否私有/保留/不可路由 IPv6。
 * @param {string} ip IPv6
 * @returns {boolean} 是否应拒绝
 */
function isBlockedIPv6(ip) {
  const h = expandV6(ip);
  if (!h) return true;
  const first = h[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（已废弃）
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (h.every((x) => x === 0)) return true;     // :: 未指定
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 环回
  // IPv6 过渡/保留族可**内嵌任意 IPv4**（含 127.0.0.1 / 10.x / 169.254.169.254），
  // 属与 ::ffff: 同类的 SSRF 绕过 ⇒ 同等对待（fail-closed）。
  if (first === 0x2002) return isBlockedIPv4(hextetsToIPv4(h[1], h[2]));          // 2002::/16 6to4（内嵌 IPv4 在 h[1]:h[2]）
  if (first === 0x0064 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIPv4(hextetsToIPv4(h[6], h[7]));                              // 64:ff9b::/96 NAT64（内嵌 IPv4 在 h[6]:h[7]）
  }
  if (first === 0x2001 && h[1] === 0x0000) return true;                           // 2001:0000::/32 Teredo
  if (first === 0x2001 && h[1] === 0x0db8) return true;                           // 2001:0db8::/32 文档段
  // ::ffff:a.b.c.d 等 IPv4 内嵌：前 5 组为 0、第 6 组为 0 或 ffff ⇒ 校验内嵌 IPv4
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0 || h[5] === 0xffff)) {
    const v4 = `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`;
    return isBlockedIPv4(v4);
  }
  return false;
}

/**
 * 判定一个 IP 字面量是否应被拒绝（未知形态一律拒绝 = fail-closed）。
 * @param {string} ip IP 字面量
 * @returns {boolean} 是否应拒绝
 */
function isBlockedAddress(ip) {
  const s = String(ip || '').trim();
  if (!s) return true;
  if (net.isIPv4(s)) return isBlockedIPv4(s);
  if (net.isIPv6(s)) return isBlockedIPv6(s);
  return true;
}

/** 明显本地/内网主机名（域名形态；IP 形态由 `isBlockedAddress` 覆盖）。*/
const BLOCKED_HOST_SUFFIXES = Object.freeze(['.localhost', '.local', '.internal', '.home.arpa', '.lan']);
const BLOCKED_HOST_EXACT = Object.freeze(['localhost', 'metadata.google.internal', 'metadata']);

/**
 * 判定主机名是否属于「明显本地/内网」。
 * @param {string} host 主机名（小写，不含方括号）
 * @returns {boolean} 是否应拒绝
 */
function isBlockedHostname(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (BLOCKED_HOST_EXACT.includes(h)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/**
 * 构造带 SSRF 校验的 `lookup`。
 *
 * 为什么不用全局 `fetch`：`fetch` 不允许注入 `lookup`，无法在**连接用的那一次解析**上
 * 做校验，只能「先自己解析校验、再让 fetch 重新解析」——两次解析之间存在 DNS 重绑定窗口。
 * 用 `http(s).request` + 自定义 `lookup`，校验与连接共用同一次解析结果，窗口被消除。
 * 残余风险：连接建立后对端若通过其他方式改变响应内容（与被访问 IP 无关）不在本层防御范围；
 * 另 `allowPrivateHosts=true` 会整体关闭该校验（默认必须为 false）。
 * @param {boolean} allowPrivate 是否允许私有地址
 * @returns {Function} dns.lookup 兼容函数
 */
function makeSafeLookup(allowPrivate) {
  return function safeLookup(hostname, options, callback) {
    const opts = options && typeof options === 'object' ? options : {};
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [];
      const allowed = allowPrivate ? list : list.filter((a) => !isBlockedAddress(a.address));
      if (allowed.length === 0) {
        const e = new Error('解析结果全部为私有/保留地址（SSRF 防护）');
        e.code = 'SSRF_BLOCKED';
        return callback(e);
      }
      if (opts.all) return callback(null, allowed);
      return callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

// ─── 结构化失败 ───

/**
 * 统一的失败返回（形状与成功返回对齐，调用方只需看 `ok`）。
 * @param {string} code 结构化错误码
 * @param {string} message 可读信息
 * @param {string} hint 可操作提示
 * @returns {object} 失败结果
 */
function fail(code, message, hint) {
  return {
    ok: false,
    buffer: null,
    bytes: 0,
    format: 'unknown',
    contentType: null,
    finalUrl: null,
    error: message,
    code,
    reason: code,
    message,
    hint,
  };
}

/** 是否是重定向状态码。*/
function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// ─── HTTP 抓取 ───

/**
 * 发一次 GET 请求，流式读响应并在超限时立即中断。
 * @param {URL} urlObj 目标 URL
 * @param {object} cfg { signal, lookup, maxBytes }
 * @returns {Promise<{status: number, headers: object, buffer: Buffer}>} 响应
 */
function requestOnce(urlObj, cfg) {
  return new Promise((resolve, reject) => {
    const mod = urlObj.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    let req;
    try {
      req = mod.request(urlObj, {
        method: 'GET',
        signal: cfg.signal,
        lookup: cfg.lookup,
        headers: {
          'User-Agent': 'GRS-ImageSource/1.0 (+moderation)',
          Accept: 'image/*,*/*;q=0.8',
        },
      }, (res) => {
        const chunks = [];
        let total = 0;
        let aborted = false;
        res.on('data', (chunk) => {
          if (aborted) return;
          total += chunk.length;
          if (total > cfg.maxBytes) {
            aborted = true;
            const e = new Error(`响应体超过 ${cfg.maxBytes} 字节上限`);
            e.code = 'IMAGE_URL_TOO_LARGE';
            res.destroy();
            req.destroy(e);
            done(reject, e);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          done(resolve, { status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) });
        });
        res.on('error', (e) => { if (!aborted) done(reject, e); });
      });
    } catch (err) {
      done(reject, err);
      return;
    }

    req.on('error', (err) => done(reject, err));
    req.end();
  });
}

/**
 * 归一化一次请求的生效选项（配置默认 + 调用方覆盖）。
 * @param {object} [opts] 覆盖项
 * @returns {object} 生效选项
 */
function resolveFetchOpts(opts) {
  const o = opts || {};
  const base = getImageSourceCfg();
  const pick = (k) => (o[k] !== undefined ? o[k] : base[k]);
  const maxBytes = Number(pick('maxBytes'));
  return {
    enabled: pick('enabled') !== false,
    fetchTimeoutMs: intInRange(pick('fetchTimeoutMs'), base.fetchTimeoutMs, 100, 120000),
    maxRedirects: intInRange(pick('maxRedirects'), base.maxRedirects, 0, 10),
    allowPrivateHosts: pick('allowPrivateHosts') === true,
    hostAllowlist: Array.isArray(pick('hostAllowlist'))
      ? pick('hostAllowlist').map((h) => String(h).trim().toLowerCase()).filter(Boolean)
      : base.hostAllowlist,
    maxBytes: maxBytes > 0 ? Math.round(maxBytes) : imageRef.getImageCaptureCfg().maxBytes,
  };
}

/**
 * 校验主机名（协议外的第二道闸门；私有 IP 的字面量在此被拦）。
 * @param {URL} urlObj 目标 URL
 * @param {object} o 生效选项
 * @returns {{ok: boolean, code?: string, message?: string, hint?: string}} 结果
 */
function checkHostAllowed(urlObj, o) {
  const host = String(urlObj.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return { ok: false, code: 'IMAGE_URL_INVALID', message: '无法解析主机名', hint: '请检查图片 URL 是否完整。' };
  if (o.hostAllowlist.length > 0) {
    const allowed = o.hostAllowlist.some((h) => h === host || host.endsWith(`.${h}`));
    if (!allowed) {
      return {
        ok: false,
        code: 'IMAGE_URL_BLOCKED',
        message: `主机 ${host} 不在允许列表内`,
        hint: '若确需访问该主机，请把它加入 config/default.json 的 moderation.imageSource.hostAllowlist。',
      };
    }
  }
  if (!o.allowPrivateHosts) {
    if (isBlockedHostname(host)) {
      return {
        ok: false,
        code: 'IMAGE_URL_BLOCKED',
        message: `主机 ${host} 属于本地/内网地址，已按 SSRF 防护拒绝`,
        hint: '如需访问内网图片地址，把 moderation.imageSource.allowPrivateHosts 置为 true（不推荐，会让服务可被用作内网探测跳板）。',
      };
    }
    if (net.isIP(host) && isBlockedAddress(host)) {
      return {
        ok: false,
        code: 'IMAGE_URL_BLOCKED',
        message: `IP ${host} 属于私有/保留地址，已按 SSRF 防护拒绝`,
        hint: '如需访问内网图片地址，把 moderation.imageSource.allowPrivateHosts 置为 true（不推荐）。',
      };
    }
  }
  return { ok: true };
}

/**
 * 把底层网络异常映射为结构化失败。
 * @param {Error} err 异常
 * @param {AbortSignal} signal 超时信号
 * @param {object} o 生效选项
 * @returns {object} 失败结果
 */
function mapFetchError(err, signal, o) {
  const code = err && err.code;
  if (code === 'IMAGE_URL_TOO_LARGE') {
    return fail('IMAGE_URL_TOO_LARGE', `远程图片超过 ${o.maxBytes} 字节上限`, '请换一张更小的图片，或调大 moderation.imageSource.maxBytes / imageCapture.maxBytes。');
  }
  if (code === 'SSRF_BLOCKED') {
    return fail('IMAGE_URL_BLOCKED', '目标解析到私有/保留地址，已按 SSRF 防护拒绝', '这是安全防护；如确需访问内网地址，需显式开启 moderation.imageSource.allowPrivateHosts。');
  }
  const name = err && err.name;
  if ((signal && signal.aborted) || name === 'AbortError' || name === 'TimeoutError') {
    return fail('IMAGE_URL_TIMEOUT', `拉取远程图片超时（>${o.fetchTimeoutMs}ms）`, '可适当调大 moderation.imageSource.fetchTimeoutMs，或改为直接传 image（base64）。');
  }
  return fail('IMAGE_URL_FETCH_FAILED', `拉取远程图片失败：${(err && err.message) || '未知网络错误'}`, '请确认图片地址可公开访问、网络可达；必要时改为直接传 image（base64）。');
}

/**
 * 【主入口】按 URL 下载图片（含 SSRF 校验、重定向上限、超时、流式体积上限）。
 * @param {string} rawUrl 图片 URL（仅允许 http / https）
 * @param {object} [opts] 覆盖项：enabled / fetchTimeoutMs / maxRedirects / allowPrivateHosts / hostAllowlist / maxBytes
 * @returns {Promise<{ok: boolean, buffer: (Buffer|null), bytes: number, format: string, contentType: (string|null), finalUrl: (string|null), error: (string|null), code: (string|null), reason: string, message?: (string|null), hint?: (string|null)}>} 结果
 */
async function fetchImage(rawUrl, opts = {}) {
  const o = resolveFetchOpts(opts);
  if (!o.enabled) {
    return fail('IMAGE_URL_DISABLED', '按 URL 拉取图片的能力已在服务端关闭', '在 config/default.json 把 moderation.imageSource.enabled 置为 true 后重试，或改为直接传 image（base64）。');
  }

  let parsed = null;
  try { parsed = new URL(String(rawUrl || '')); } catch { parsed = null; }
  if (!parsed || !parsed.hostname) {
    return fail('IMAGE_URL_INVALID', '无效的图片 URL', '请传入合法的绝对地址，例如 https://cdn.example.com/a.png。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('IMAGE_URL_INVALID', `不支持的协议：${parsed.protocol}`, '只接受 http / https 地址（file:、data:、ftp: 等一律拒绝）。');
  }

  const signal = AbortSignal.timeout(o.fetchTimeoutMs);
  const lookup = makeSafeLookup(o.allowPrivateHosts);
  let current = parsed;
  let hops = 0;

  for (;;) {
    const pre = checkHostAllowed(current, o);
    if (!pre.ok) return fail(pre.code, pre.message, pre.hint);

    let res;
    // eslint-disable-next-line no-await-in-loop
    try { res = await requestOnce(current, { signal, lookup, maxBytes: o.maxBytes }); } catch (err) { return mapFetchError(err, signal, o); }

    if (isRedirect(res.status) && res.headers.location) {
      hops += 1;
      if (hops > o.maxRedirects) {
        return fail('IMAGE_URL_TOO_MANY_REDIRECTS', `重定向次数超过上限（${o.maxRedirects}）`, '请检查图片地址的重定向链，或适当调大 moderation.imageSource.maxRedirects。');
      }
      let next = null;
      try { next = new URL(String(res.headers.location), current); } catch { next = null; }
      if (!next || (next.protocol !== 'http:' && next.protocol !== 'https:')) {
        return fail('IMAGE_URL_INVALID', '重定向目标不是合法 http/https 地址', '请检查图片地址的重定向链。');
      }
      current = next;
      continue;
    }

    const ctypeHeader = res.headers['content-type'] ? String(res.headers['content-type']) : '';
    if (ctypeHeader && !/^image\//i.test(ctypeHeader)) {
      return fail('IMAGE_URL_NOT_IMAGE', `响应不是图片（Content-Type: ${ctypeHeader.split(';')[0].trim()}）`, '请提供直接指向图片资源的 URL（Content-Type 应为 image/*）。');
    }
    const buffer = res.buffer;
    const format = imageRef.detectFormat(buffer);
    if (!buffer || buffer.length === 0 || format === 'unknown') {
      return fail('IMAGE_URL_NOT_IMAGE', '响应内容不是可识别的图片格式', '请确认 URL 直接指向一张图片（支持 jpeg / png / webp / gif / bmp / avif / tiff）。');
    }
    return {
      ok: true,
      buffer,
      bytes: buffer.length,
      format,
      contentType: ctypeHeader ? ctypeHeader.split(';')[0].trim() : null,
      finalUrl: current.href,
      error: null,
      code: null,
      reason: 'ok',
      message: null,
      hint: null,
    };
  }
}

// ─── 转码 ───

/**
 * 【转码】把远程/任意图片字节规整成适合审核链路的格式。
 * 任何失败（sharp 缺失 / 解码失败）都降级为「原样返回」并标注 reason，绝不抛。
 *
 * 默认策略 `auto`：
 * - 源已是 jpeg ⇒ 不重复编码（省一次质量损失）→ `reason='already-jpeg'`
 * - 带 alpha 的 png/webp ⇒ 编码为 **png**（避免透明区域变黑）→ `reason='alpha-preserved'`
 * - 其余（unknown / avif / tiff / bmp / gif 等）⇒ 按 `transcodeFormat` 编码（默认 jpeg）
 * 输出一律**不带 EXIF/ICC 等元数据**（隐私 + 体积），并通过 `.rotate()` 把 EXIF 方向烘进像素。
 * @param {Buffer} buffer 图片字节
 * @param {object} [opts] 覆盖项：transcode('auto'|'off'|'force') / transcodeFormat / transcodeQuality
 * @returns {Promise<{ok: boolean, buffer: Buffer, format: string, transcoded: boolean, reason: string, quality: number}>} 结果
 */
async function transcodeImage(buffer, opts = {}) {
  const cfg = getImageSourceCfg();
  const o = opts || {};
  const mode = ALLOWED_TRANSCODE_MODES.includes(String(o.transcode || '').toLowerCase())
    ? String(o.transcode).toLowerCase()
    : cfg.transcode;
  const targetFormat = ALLOWED_TRANSCODE_FORMATS.includes(String(o.transcodeFormat || '').toLowerCase())
    ? String(o.transcodeFormat).toLowerCase()
    : cfg.transcodeFormat;
  const quality = intInRange(o.transcodeQuality, cfg.transcodeQuality, 1, 100);

  const out = {
    ok: true,
    buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0),
    format: imageRef.detectFormat(buffer),
    transcoded: false,
    reason: '',
    quality,
  };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) { out.reason = 'empty-buffer'; return out; }
  if (mode === 'off') { out.reason = 'transcode-off'; return out; }

  let sharp;
  try {
    // 惰性 require：sharp 是既有依赖，但缺失必须降级而不是崩（与 image-policy 同策略）
    sharp = require('sharp');
  } catch (err) {
    out.reason = 'sharp-unavailable';
    if (!_sharpMissingWarned) {
      _sharpMissingWarned = true;
      logWarn('image-source', `sharp 未安装，URL 图片转码已降级为「使用原始字节」（不影响审核）: ${err && err.message}`);
    }
    return out;
  }

  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const srcFormat = meta.format || out.format;
    const hasAlpha = meta.hasAlpha === true;
    let encodeFormat = targetFormat;
    if (mode !== 'force') {
      if (srcFormat === 'jpeg') { out.reason = 'already-jpeg'; return out; }
      if ((srcFormat === 'png' || srcFormat === 'webp') && hasAlpha) {
        encodeFormat = 'png';
        out.reason = 'alpha-preserved';
      }
    }
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate();
    if (encodeFormat === 'png') pipeline = pipeline.png({ compressionLevel: 9 });
    else if (encodeFormat === 'webp') pipeline = pipeline.webp({ quality });
    else pipeline = pipeline.jpeg({ quality });
    const encoded = await pipeline.toBuffer();
    if (!Buffer.isBuffer(encoded) || encoded.length === 0) { out.reason = 'sharp-returned-empty'; return out; }
    const detected = imageRef.detectFormat(encoded);
    out.buffer = encoded;
    out.format = detected === 'unknown' ? encodeFormat : detected;
    out.transcoded = true;
    out.reason = out.reason || 'ok';
    return out;
  } catch (err) {
    out.reason = `sharp-failed: ${(err && err.message) || 'unknown'}`;
    return out;
  }
}

/**
 * 供端点使用的一步式归一化：URL ⇒ 拉取 ⇒ 转码 ⇒ base64。
 * 失败时返回结构化 code / message / hint（端点据此回 4xx，绝不 500）。
 * @param {string} url 图片 URL
 * @param {object} [opts] 覆盖项（透传给 fetchImage / transcodeImage）
 * @returns {Promise<object>} { ok, base64, bytes, format, contentType, finalUrl, transcoded, transcodeTag, reason, code?, message?, hint? }
 */
async function fetchAndTranscodeToBase64(url, opts = {}) {
  const cfg = getImageSourceCfg();
  const o = opts || {};
  const enabled = o.enabled !== undefined ? o.enabled !== false : cfg.enabled;
  if (!enabled) {
    return fail('IMAGE_URL_DISABLED', '按 URL 拉取图片的能力已在服务端关闭', '在 config/default.json 把 moderation.imageSource.enabled 置为 true 后重试，或改为直接传 image（base64）。');
  }
  const fetched = await fetchImage(url, opts);
  if (!fetched.ok) return fetched;
  const tr = await transcodeImage(fetched.buffer, opts);
  const quality = tr.quality;
  const tag = tr.transcoded
    ? ((tr.format === 'jpeg' || tr.format === 'webp') ? `${tr.format}@${quality}` : tr.format)
    : 'none';
  return {
    ok: true,
    base64: tr.buffer.toString('base64'),
    bytes: tr.buffer.length,
    format: tr.format,
    contentType: fetched.contentType,
    finalUrl: fetched.finalUrl,
    transcoded: tr.transcoded,
    transcodeTag: tag,
    reason: tr.reason,
    code: null,
    message: null,
    hint: null,
  };
}

module.exports = {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  ALLOWED_TRANSCODE_MODES,
  ALLOWED_TRANSCODE_FORMATS,
  getImageSourceCfg,
  fetchImage,
  transcodeImage,
  fetchAndTranscodeToBase64,
  isBlockedAddress,
  isBlockedHostname,
  ipv4ToInt,
  expandV6,
};
