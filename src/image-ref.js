/**
 * 图片引用归一化 + 内容寻址落盘（src/image-ref.js）
 * v0.2.0：让「图片」成为一等公民的唯一抽象层。设计要点：
 * ① **内容寻址**：blob 以 `sha256(imageBytes)[:16]` 命名 ⇒ 同图天然去重、天然可关联
 * （审核记录 ↔ 对比结果用同一个 hash 就能对上）、天然可逆（删目录即回滚）。
 * ② **同步/异步分离**：`fromBase64()` 是**同步**的（只做 sha256 + 图片头解析，~5–15ms），
 * `capture()` 是**异步 fire-and-forget**（写 blob + 生成 webp 缩略图）—— 因此落盘
 * **绝不进入审核关键路径的 await 链**。
 * ③ **`stored` 是「捕获决定」不是「存活保证」**：落盘异步，记录先写 ⇒ 字节是否真的在盘上
 * 必须由读取端 `resolveImageRef()` 的**存在性检查**裁决，`stored` 字段不作准。
 * ④ **永不写字节进 JSONL/DB**：记录里只放相对路径与元数据。
 * 测试隔离：环境变量 `GRS_BLOB_DIR` 可把 blob 根重定向到临时目录（默认 `<projectRoot>/data/image_blobs`，
 * 与生产行为完全一致）。回归脚本**必须**设置它，绝不触碰生产 `data/image_blobs/`。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getProjectRoot, loadConfig } = require('./config');
const { logWarn } = require('./logger');

/** 单图上限（与 comparison-source.MAX_IMAGE_BYTES 对齐）*/
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** blob 相对目录（写入记录时的稳定字面量，与 blob 根是否被重定向无关）*/
const BLOB_DIR_REL = 'data/image_blobs';
/** 缩略图相对目录*/
const THUMB_DIR_REL = 'data/image_blobs/thumb';
/** hash 形态：16 位小写 hex（ 同时是防目录穿越的唯一闸门）*/
const HASH_RE = /^[0-9a-f]{16}$/;
/** 扩展名形态*/
const EXT_RE = /^[a-z0-9]{1,8}$/;

/** 图片格式 → 扩展名*/
const EXT_BY_FORMAT = Object.freeze({
  jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp',
  avif: 'avif', tiff: 'tiff', unknown: 'bin',
});

/** 图片捕获配置的兜底值（配置缺失/加载失败时使用）*/
const FALLBACK_CAPTURE = Object.freeze({
  enabled: true,
  maxBytes: DEFAULT_MAX_BYTES,
  thumbMaxDim: 320,
  thumbQuality: 72,
  capacity: { limitBytes: 5 * 1024 * 1024 * 1024, warnPct: 80, onExceed: 'stop-capture' },
});

/**
 * blob 根目录。 测试用 `GRS_BLOB_DIR` 重定向；默认与生产完全一致。
 * @type {string}
 */
const BLOB_ROOT = process.env.GRS_BLOB_DIR
  ? path.resolve(process.env.GRS_BLOB_DIR)
  : path.join(getProjectRoot(), 'data', 'image_blobs');

/** 进程内容量缓存（字节）；初始 0，由 `ensureCapacityFresh()` 异步刷新*/
let _usedBytes = 0;
/** 容量刷新定时器*/
let _capacityTimer = null;

/**
 * 读取 `moderation.imageCapture` 配置（含兜底）。
 * @returns {object} 归一化后的捕获配置
 */
function getImageCaptureCfg() {
  try {
    const cfg = loadConfig();
    const ic = (cfg && cfg.imageCapture) || {};
    const cap = (ic.capacity && typeof ic.capacity === 'object') ? ic.capacity : {};
    return {
      enabled: ic.enabled !== false,
      maxBytes: Number(ic.maxBytes) > 0 ? Number(ic.maxBytes) : DEFAULT_MAX_BYTES,
      thumbMaxDim: Number(ic.thumbMaxDim) > 0 ? Number(ic.thumbMaxDim) : 320,
      thumbQuality: Number(ic.thumbQuality) > 0 ? Number(ic.thumbQuality) : 72,
      capacity: {
        limitBytes: Number(cap.limitBytes) > 0 ? Number(cap.limitBytes) : FALLBACK_CAPTURE.capacity.limitBytes,
        warnPct: Number(cap.warnPct) > 0 ? Number(cap.warnPct) : FALLBACK_CAPTURE.capacity.warnPct,
        onExceed: cap.onExceed ? String(cap.onExceed) : FALLBACK_CAPTURE.capacity.onExceed,
      },
    };
  } catch {
    return FALLBACK_CAPTURE;
  }
}

/**
 * 取 blob 根的绝对路径（供系统信息页 / 端点展示）。
 * @returns {string} 绝对路径
 */
function getBlobRoot() {
  return BLOB_ROOT;
}

// ─── 路径安全 ───

/**
 * 判定 hash 是否安全（仅 16 位小写 hex）。
 * 这是防目录穿越的**唯一闸门**：`../../` 之类既不是 16 位、也含非法字符，直接被拒。
 * @param {*} hash 待校验 hash
 * @returns {boolean} 是否安全
 */
function isHashSafe(hash) {
  if (hash === undefined || hash === null) return false;
  return HASH_RE.test(String(hash));
}

/**
 * 把「相对路径」跑赢成「blob 根内的绝对路径」。
 * @param {string} rel 相对路径（如 `data/image_blobs/ab/ab12….jpg`）
 * @returns {string|null} 绝对路径（越界或非法 ⇒ null）
 */
function relToBlobAbs(rel) {
  if (!rel || typeof rel !== 'string') return null;
  const cleaned = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  // 只接受两种合法前缀，杜绝任何 `..` / 绝对路径注入
  const prefix = cleaned.startsWith(`${BLOB_DIR_REL}/`) ? BLOB_DIR_REL : null;
  if (!prefix) return null;
  const tail = cleaned.slice(prefix.length + 1);
  if (!tail || tail.includes('..') || path.isAbsolute(tail)) return null;
  const abs = path.resolve(BLOB_ROOT, tail);
  const rootAbs = path.resolve(BLOB_ROOT);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

/**
 * 由 hash（+ 可选扩展名）算出 blob 绝对路径。
 * @param {string} hash 16 位 hex
 * @param {string} [ext] 扩展名（不含点）；省略时在目录内按前缀查找
 * @returns {string|null} 绝对路径（hash 非法 ⇒ null）
 */
function blobAbsPath(hash, ext) {
  if (!isHashSafe(hash)) return null;
  const h = String(hash);
  const dir = path.join(BLOB_ROOT, h.slice(0, 2));
  if (ext !== undefined && ext !== null && EXT_RE.test(String(ext).toLowerCase())) {
    return path.join(dir, `${h}.${String(ext).toLowerCase()}`);
  }
  try {
    const names = fs.readdirSync(dir);
    const hit = names.find((n) => n.startsWith(`${h}.`));
    return hit ? path.join(dir, hit) : path.join(dir, `${h}.bin`);
  } catch {
    return path.join(dir, `${h}.bin`);
  }
}

/**
 * 由 hash 算出缩略图绝对路径。
 * @param {string} hash 16 位 hex
 * @returns {string|null} 绝对路径（hash 非法 ⇒ null）
 */
function thumbAbsPath(hash) {
  if (!isHashSafe(hash)) return null;
  return path.join(BLOB_ROOT, 'thumb', `${String(hash)}.webp`);
}

/** 格式 → 扩展名*/
function extOf(format) {
  return EXT_BY_FORMAT[String(format || 'unknown')] || 'bin';
}

// ─── 字节头解析（零依赖：不引入新包，sharp 只用于缩略图） ───

/**
 * 由字节头判定图片格式。
 * @param {Buffer} buf 图片字节
 * @returns {string} 'jpeg'|'png'|'webp'|'gif'|'bmp'|'avif'|'tiff'|'unknown'
 */
function detectFormat(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF'
    && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'avif';
    return 'unknown';
  }
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A)
    || (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)) return 'tiff';
  return 'unknown';
}

/**
 * 解析 JPEG 的 SOF 段尺寸。
 * @param {Buffer} buf 图片字节
 * @returns {{width: number|null, height: number|null}} 尺寸
 */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i += 1; continue; }
    let marker = buf[i + 1];
    while (marker === 0xFF && i + 1 < buf.length) { i += 1; marker = buf[i + 1]; }
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len <= 0) break;
    i += 2 + len;
  }
  return { width: null, height: null };
}

/**
 * 解析 WEBP 的尺寸（VP8 / VP8L / VP8X 三种 chunk）。
 * @param {Buffer} buf 图片字节
 * @returns {{width: number|null, height: number|null}} 尺寸
 */
function webpSize(buf) {
  if (buf.length < 30) return { width: null, height: null };
  const fourcc = buf.slice(12, 16).toString('ascii');
  if (fourcc === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
  }
  if (fourcc === 'VP8L') {
    const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
    return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
  }
  if (fourcc === 'VP8X') {
    return {
      width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
      height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
    };
  }
  return { width: null, height: null };
}

/**
 * 由字节头读取尺寸。 取不到不抛、返回 null —— 绝不允许「取不到尺寸」导致丢记录。
 * @param {Buffer} buf 图片字节
 * @param {string} format 已判定格式
 * @returns {{width: number|null, height: number|null}} 尺寸
 */
function readDimensions(buf, format) {
  const out = { width: null, height: null };
  try {
    if (format === 'png' && buf.length >= 24) {
      out.width = buf.readUInt32BE(16); out.height = buf.readUInt32BE(20);
    } else if (format === 'gif' && buf.length >= 10) {
      out.width = buf.readUInt16LE(6); out.height = buf.readUInt16LE(8);
    } else if (format === 'bmp' && buf.length >= 26) {
      out.width = Math.abs(buf.readInt32LE(18)); out.height = Math.abs(buf.readInt32LE(22));
    } else if (format === 'jpeg') {
      Object.assign(out, jpegSize(buf));
    } else if (format === 'webp') {
      Object.assign(out, webpSize(buf));
    }
  } catch { /* 尺寸解析失败：保持 null，不影响记录落盘*/ }
  return out;
}

// ─── 容量守卫 ───

/**
 * 异步重算 blob 目录占用（递归求和）。
 * @returns {Promise<void>} 完成
 */
async function ensureCapacityFresh() {
  let total = 0;
  /**
   * 递归累加目录大小。
   * @param {string} dir 目录
   * @returns {Promise<void>} 完成
   */
  const walk = async (dir) => {
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st = null;
      try { st = await fs.promises.stat(full); } catch { continue; }
      if (st.isDirectory()) { await walk(full); continue; }
      total += st.size;
    }
  };
  await walk(BLOB_ROOT);
  _usedBytes = total;
}

/**
 * 容量状态（供系统信息页）。
 * @returns {{usedBytes: number, limitBytes: number, pct: number, overWarn: boolean, overLimit: boolean}} 状态
 */
function capacityStatus() {
  const cfg = getImageCaptureCfg();
  const limitBytes = cfg.capacity.limitBytes;
  const usedBytes = _usedBytes > 0 ? _usedBytes : 0;
  const pct = limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 1000) / 10 : 0;
  return {
    usedBytes,
    limitBytes,
    pct,
    overWarn: pct >= cfg.capacity.warnPct,
    overLimit: usedBytes >= limitBytes,
  };
}

/**
 * 手动设置已用字节（测试/刷新用）。
 * @param {number} bytes 字节数
 * @returns {void}
 */
function _setUsedBytes(bytes) {
  _usedBytes = Number(bytes) > 0 ? Number(bytes) : 0;
}

// ─── 归一化 ───

/**
 * base64 → Buffer（兼容 `data:image/xxx;base64,` 前缀与换行）。
 * @param {string} base64 base64 字符串
 * @returns {Buffer} 解码后的字节（解码不可行时返回空 Buffer，绝不抛）
 */
function decodeBase64(base64) {
  try {
    let s = String(base64 || '');
    const comma = s.indexOf(',');
    if (s.startsWith('data:') && comma >= 0) s = s.slice(comma + 1);
    s = s.replace(/\s+/g, '');
    if (!s) return Buffer.alloc(0);
    return Buffer.from(s, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * 由「已解码的字节」构造 ImageRef（同步，不落盘）。
 * @param {Buffer} buffer 图片字节
 * @param {object} [opts] 选项
 * @param {string|null} [opts.imageUrl] 远程 URL（存在 ⇒ source.kind='remote-url'）
 * @param {string|null} [opts.sourcePath] 本地绝对路径（存在 ⇒ source.kind='local-file'）
 * @param {boolean} [opts.capture] 是否请求捕获（默认 true；false ⇒ 只引用）
 * @param {number} [opts.maxBytes] 单图上限覆盖
 * @returns {object} ImageRef
 */
function buildRef(buffer, opts = {}) {
  const cfg = getImageCaptureCfg();
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : cfg.maxBytes;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const format = detectFormat(buf);
  const dims = readDimensions(buf, format);
  const sourcePath = opts.sourcePath ? String(opts.sourcePath) : null;
  const imageUrl = opts.imageUrl ? String(opts.imageUrl) : null;
  const source = sourcePath
    ? { kind: 'local-file', ref: sourcePath }
    : imageUrl
      ? { kind: 'remote-url', ref: imageUrl }
      : { kind: 'bot-base64', ref: null };

  const ref = {
    hash,
    bytes: buf.length,
    format,
    width: dims.width,
    height: dims.height,
    source,
    blob: null,
    thumb: null,
    stored: false,
    // 附加字段（对 §3.1 契约的**纯增量**扩展）：记录「为何未纳入内容寻址存储」，
    // 用于满足 R1-9「超限仍落盘、stored=false 且带失败原因」。不影响既有 9 个字段的语义。
    storedReason: null,
  };

  if (buf.length === 0) {
    ref.storedReason = '图片字节为空（base64 解码结果为空）';
    return ref;
  }
  if (sourcePath) {
    // 本地文件只做引用，不重复拷贝已有文件（stored 恒为 false）
    ref.storedReason = '本地文件仅引用，不重复拷贝';
    return ref;
  }
  if (buf.length > maxBytes) {
    const mb = maxBytes / 1024 / 1024;
    ref.storedReason = mb >= 1
      ? `图片超过 ${Math.round(mb)}MB 单图上限`
      : `图片超过 ${maxBytes} 字节单图上限`;
    return ref;
  }
  if (!cfg.enabled) {
    ref.storedReason = '图片捕获已关闭（imageCapture.enabled=false）';
    return ref;
  }
  if (opts.capture === false) {
    ref.storedReason = '未请求捕获（仅引用）';
    return ref;
  }
  const cap = capacityStatus();
  if (cap.overLimit) {
    ref.storedReason = `已超过容量上限（${cap.limitBytes} 字节），已停止新捕获`;
    return ref;
  }
  // 确定性路径：同图两次 ⇒ 同 hash ⇒ 同 blob/thumb（内容寻址去重的前提）
  ref.blob = `${BLOB_DIR_REL}/${hash.slice(0, 2)}/${hash}.${extOf(format)}`;
  ref.thumb = `${THUMB_DIR_REL}/${hash}.webp`;
  ref.stored = true;
  return ref;
}

/**
 * 【同步】base64 → { ref, buffer }。只做 sha256 + 头解析（尺寸/格式），**不落盘**。
 * @param {string} base64 base64 图片（含/不含 data: 前缀均可）
 * @param {object} [opts] 选项 { imageUrl, maxBytes, capture }
 * @returns {{ref: object, buffer: Buffer|null}} 结果
 */
function fromBase64(base64, opts = {}) {
  const buffer = decodeBase64(base64);
  const ref = buildRef(buffer, opts);
  return { ref, buffer: buffer.length > 0 ? buffer : null };
}

/**
 * 【同步】本地文件 → ImageRef（**只引用，不拷贝** ⇒ stored:false、source.kind='local-file'）。
 * @param {string} absPath 文件绝对路径
 * @param {object} [opts] 选项（保留位；当前不影响「只引用」语义）
 * @returns {object|null} ImageRef，路径为空时 null
 */
function fromFile(absPath, opts = {}) {
  void opts; // 本地文件一律只引用，不因调用方传参而改变语义
  const p = absPath ? String(absPath) : '';
  if (!p) return null;
  let buf = null;
  try { buf = fs.readFileSync(p); } catch { buf = null; }
  if (!buf) {
    return {
      hash: null,
      bytes: 0,
      format: 'unknown',
      width: null,
      height: null,
      source: { kind: 'local-file', ref: p },
      blob: null,
      thumb: null,
      stored: false,
      storedReason: '本地文件不存在或不可读',
    };
  }
  return buildRef(buf, { sourcePath: p });
}

/**
 * 【异步·fire-and-forget】写 blob + 生成 webp 缩略图。
 * 绝不出现在审核关键路径的 await 链上；失败只 logWarn，不抛。
 * @param {object} ref ImageRef
 * @param {Buffer} buffer 图片字节
 * @returns {Promise<void>} 完成
 */
async function capture(ref, buffer) {
  if (!ref || !ref.stored || !ref.blob || !Buffer.isBuffer(buffer) || buffer.length === 0) return;
  try {
    const abs = relToBlobAbs(ref.blob);
    if (!abs) return;
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    let blobExists = false;
    try { await fs.promises.access(abs); blobExists = true; } catch { blobExists = false; }
    if (!blobExists) {
      await fs.promises.writeFile(abs, buffer);
      _usedBytes += buffer.length;
    }

    if (!ref.thumb) return;
    const tAbs = relToBlobAbs(ref.thumb);
    if (!tAbs) return;
    let thumbExists = false;
    try { await fs.promises.access(tAbs); thumbExists = true; } catch { thumbExists = false; }
    if (thumbExists) return;
    await fs.promises.mkdir(path.dirname(tAbs), { recursive: true });
    const cfg = getImageCaptureCfg();
    // 惰性 require：sharp 是既有依赖，但只在真需要缩略图时加载
    const sharp = require('sharp');
    const out = await sharp(buffer, { failOn: 'none' })
      .resize({
        width: cfg.thumbMaxDim, height: cfg.thumbMaxDim, fit: 'inside', withoutEnlargement: true,
      })
      .webp({ quality: cfg.thumbQuality })
      .toBuffer();
    await fs.promises.writeFile(tAbs, out);
    _usedBytes += out.length;
  } catch (err) {
    logWarn('image-ref', `图片落盘/缩略图失败（已忽略，不影响审核）: ${err && err.message}`);
  }
}

/**
 * 由 ImageRef 的 blob 相对路径还原绝对路径（经 hash + ext 重建，杜绝字符串拼接注入）。
 * @param {object} ref ImageRef
 * @returns {string|null} 绝对路径
 */
function refBlobAbsPath(ref) {
  if (!ref || !isHashSafe(ref.hash)) return null;
  const ext = ref.blob ? (path.extname(String(ref.blob)) || '').replace(/^\./, '') : '';
  return blobAbsPath(ref.hash, ext || undefined);
}

/**
 * 【读取端唯一消费点】按优先级解析出**可用**的图片字节路径（含存在性检查）：
 * `image_ref.blob`（存在）→ `image_ref.source.ref`（存在且为绝对路径）→ 都不行 ⇒ null。
 * 调用方（comparison-source）再回退既有的 `meta.source` / `meta.filePath` / `result.image_path`。
 * @param {object} record 审核记录（或已被展平的记录对象）
 * @returns {{hash: (string|null), blobAbs: (string|null), thumbAbs: (string|null)}|null} 解析结果
 */
function resolveImageRef(record) {
  if (!record || typeof record !== 'object') return null;
  const ref = (record.image_ref && typeof record.image_ref === 'object')
    ? record.image_ref
    : ((record.result && record.result.image_ref && typeof record.result.image_ref === 'object')
      ? record.result.image_ref
      : null);
  if (!ref) return null;

  const hash = typeof ref.hash === 'string' ? ref.hash : null;
  const tAbs = isHashSafe(hash) ? thumbAbsPath(hash) : null;
  const thumbAbs = tAbs && fs.existsSync(tAbs) ? tAbs : null;

  // ① 内容寻址 blob（存在才用；blob 目录被删 ⇒ 优雅退化）
  const blobAbs = ref.blob ? refBlobAbsPath(ref) : null;
  if (blobAbs && fs.existsSync(blobAbs)) return { hash, blobAbs, thumbAbs };

  // ② source.ref（本地文件绝对路径 / 已下载的远程引用）
  const srcRef = ref.source && typeof ref.source.ref === 'string' ? ref.source.ref : null;
  if (srcRef && path.isAbsolute(srcRef) && fs.existsSync(srcRef)) {
    return { hash, blobAbs: srcRef, thumbAbs };
  }
  return null;
}

// ─── 容量刷新调度（fire-and-forget，定时器 unref 不阻塞退出） ───
setImmediate(() => { ensureCapacityFresh().catch(() => { /* 容量刷新失败不影响功能*/ }); });
_capacityTimer = setInterval(() => {
  ensureCapacityFresh().catch(() => { /* 忽略*/ });
}, 5 * 60 * 1000);
if (_capacityTimer && typeof _capacityTimer.unref === 'function') _capacityTimer.unref();

module.exports = {
  DEFAULT_MAX_BYTES,
  BLOB_DIR_REL,
  THUMB_DIR_REL,
  getBlobRoot,
  getImageCaptureCfg,
  fromBase64,
  fromFile,
  capture,
  resolveImageRef,
  capacityStatus,
  ensureCapacityFresh,
  blobAbsPath,
  thumbAbsPath,
  isHashSafe,
  relToBlobAbs,
  detectFormat,
  readDimensions,
  _setUsedBytes,
};
