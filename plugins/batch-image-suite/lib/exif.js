/**
 * 零依赖 EXIF 最小解析（plugins/batch-image-suite/lib/exif.js）
 *
 * 目标：只取「拍摄时间」，不引入任何 npm 包。
 * 两条路径：
 *   ① 结构化解析：JPEG APP1 (Exif) → TIFF IFD0 → 0x0132，ExifIFD(0x8769) → 0x9003 / 0x9004
 *   ② 明文兜底：前 128KB 内正则匹配 YYYY:MM:DD HH:MM:SS / YYYY-MM-DD HH:MM:SS
 *
 * @returns 形如 '2023-05-12 14:30:00' 的字符串，失败返回 null
 */
const fs = require('fs');

const TIFF_BE = 0x4d4d; // 'MM'
const TIFF_LE = 0x4949; // 'II'

/**
 * 读取 TIFF 中的一个 IFD，返回 tag → 值的偏移信息。
 * @param {Buffer} buf 完整缓冲
 * @param {number} tiffStart TIFF 头偏移
 * @param {number} ifdOffset IFD 相对偏移
 * @param {boolean} le 是否小端
 * @returns {Map<number, {type: number, count: number, valueOffset: number}>}
 */
function readIFD(buf, tiffStart, ifdOffset, le) {
  const map = new Map();
  const base = tiffStart + ifdOffset;
  if (base + 2 > buf.length) return map;
  const count = le ? buf.readUInt16LE(base) : buf.readUInt16BE(base);
  for (let i = 0; i < count; i++) {
    const entry = base + 2 + i * 12;
    if (entry + 12 > buf.length) break;
    const tag = le ? buf.readUInt16LE(entry) : buf.readUInt16BE(entry);
    const type = le ? buf.readUInt16LE(entry + 2) : buf.readUInt16BE(entry + 2);
    const num = le ? buf.readUInt32LE(entry + 4) : buf.readUInt32BE(entry + 4);
    // ASCII 类型（type=2）且长度 ≤ 4 时值内联在 valueOffset 字段里
    const valueOffset = entry + 8;
    map.set(tag, { type, count: num, valueOffset });
  }
  return map;
}

/**
 * 读取 ASCII 类型的 tag 值。
 * @param {Buffer} buf 缓冲
 * @param {number} tiffStart TIFF 头偏移
 * @param {{type: number, count: number, valueOffset: number}} entry IFD 条目
 * @param {boolean} le 是否小端
 * @returns {string|null}
 */
function readAscii(buf, tiffStart, entry, le) {
  if (!entry || entry.type !== 2) return null;
  const len = entry.count;
  if (len <= 4) {
    return buf.slice(entry.valueOffset, entry.valueOffset + Math.min(len, 4)).toString('ascii').replace(/\0+$/, '').trim() || null;
  }
  const rel = le ? buf.readUInt32LE(entry.valueOffset) : buf.readUInt32BE(entry.valueOffset);
  const start = tiffStart + rel;
  if (start + len > buf.length) return null;
  return buf.slice(start, start + len).toString('ascii').replace(/\0+$/, '').trim() || null;
}

/** 把 '2023:05:12 14:30:00' 归一为 '2023-05-12 14:30:00' */
function normalizeDateString(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[-:/](\d{1,2})[-:/](\d{1,2})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const hh = m[4] ? parseInt(m[4], 10) : 0;
  const mi = m[5] ? parseInt(m[5], 10) : 0;
  const ss = m[6] ? parseInt(m[6], 10) : 0;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)} ${p(hh)}:${p(mi)}:${p(ss)}`;
}

/**
 * 结构化解析 JPEG 的 EXIF 拍摄时间。
 * @param {Buffer} buf 文件缓冲（至少前若干 KB）
 * @returns {string|null}
 */
function parseExifStructure(buf) {
  if (!buf || buf.length < 12 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    // SOF / SOS 之后就是图像数据，不再有 APP1
    if (marker === 0xda || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) break;
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) break;
    if (marker === 0xe1) {
      const segStart = offset + 4;
      if (buf.slice(segStart, segStart + 4).toString('ascii') === 'Exif') {
        const tiffStart = segStart + 6;
        if (tiffStart + 8 > buf.length) return null;
        const bom = buf.readUInt16BE(tiffStart);
        const le = bom === TIFF_LE;
        if (bom !== TIFF_BE && bom !== TIFF_LE) return null;
        const ifd0Offset = le ? buf.readUInt32LE(tiffStart + 4) : buf.readUInt32BE(tiffStart + 4);
        const ifd0 = readIFD(buf, tiffStart, ifd0Offset, le);
        // ExifIFD 优先（0x9003 DateTimeOriginal / 0x9004 DateTimeDigitized）
        const exifEntry = ifd0.get(0x8769);
        if (exifEntry) {
          const exifIfdOffset = le ? buf.readUInt32LE(exifEntry.valueOffset) : buf.readUInt32BE(exifEntry.valueOffset);
          const exifIfd = readIFD(buf, tiffStart, exifIfdOffset, le);
          for (const tag of [0x9003, 0x9004]) {
            const v = readAscii(buf, tiffStart, exifIfd.get(tag), le);
            const norm = normalizeDateString(v);
            if (norm) return norm;
          }
        }
        // 回退 IFD0 的 0x0132 DateTime
        const dt = readAscii(buf, tiffStart, ifd0.get(0x0132), le);
        return normalizeDateString(dt);
      }
    }
    offset += 2 + segLen;
  }
  return null;
}

/**
 * 明文正则兜底（应对 EXIF 损坏 / PNG / WebP 等容器）。
 * @param {Buffer} buf 文件缓冲
 * @returns {string|null}
 */
function parseExifPlain(buf) {
  if (!buf) return null;
  const head = buf.slice(0, Math.min(buf.length, 128 * 1024)).toString('latin1');
  const m = head.match(/(20\d{2})[-:/](\d{2})[-:/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return normalizeDateString(`${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`);
}

/**
 * 从文件读取拍摄时间（结构化优先，明文兜底）。
 * ★ 异步化：使用 fs.promises 避免同步 IO 阻塞事件循环（并发扫描时收益明显）。
 * @param {string} filePath 图片路径
 * @param {{maxBytes?: number}} [opts] 选项
 * @returns {Promise<string|null>} 'YYYY-MM-DD HH:MM:SS'
 */
async function readShotAt(filePath, opts = {}) {
  let handle = null;
  try {
    const maxBytes = opts.maxBytes || 256 * 1024;
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    return parseExifStructure(buf) || parseExifPlain(buf);
  } catch {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* 忽略关闭失败 */ }
    }
  }
}

/** 从文件名中提取日期（如 IMG_20230512_143000.jpg / 2023-05-12 14-30-00.jpg） */
function parseDateFromName(name) {
  if (!name) return null;
  const patterns = [
    /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[-_. T]?(\d{2})?[-_.:]?(\d{2})?[-_.:]?(\d{2})?/,
    /(19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/,
  ];
  for (const re of patterns) {
    const m = String(name).match(re);
    if (!m) continue;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const p = (n) => String(n).padStart(2, '0');
    return `${y}-${p(mo)}-${p(d)} ${p(parseInt(m[4] || '0', 10))}:${p(parseInt(m[5] || '0', 10))}:${p(parseInt(m[6] || '0', 10))}`;
  }
  return null;
}

module.exports = { readShotAt, parseExifStructure, parseExifPlain, parseDateFromName, normalizeDateString };
