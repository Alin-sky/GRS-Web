/**
 * 图片元数据字符串提取（plugins/keyword-image-guard/lib/exif.js）
 *
 * 零依赖实现：只取「可能承载文本的结构化字段」，不解析像素、不解码图片。
 * 支持：
 *   - JPEG：APP1 Exif（TIFF IFD 中的 ASCII / UNDEFINED 字段，含 UserComment 字符集前缀）、
 *           APP1 XMP（`<x:xmpmeta>` 文本块）
 *   - PNG：tEXt / zTXt / iTXt 文本块（zTXt/iTXt 用内置 zlib 解压）
 *   - WebP：RIFF 容器中的 EXIF / XMP 块
 *   - GIF：注释扩展块
 *   - 兜底：对文件头部做一次「可打印字符连续段」扫描（覆盖未识别容器）
 *
 * ★ 返回的是**元数据文本**，调用方只做敏感词匹配；这些文本与命中结果都不会被打印。
 */
'use strict';

const zlib = require('zlib');

/** 单次最多解析的字节数（元数据都在文件头部，避免大图全量扫描） */
const MAX_SCAN_BYTES = 512 * 1024;
/** 单个字段文本上限 */
const MAX_FIELD_LEN = 2048;
/** 字段数量上限 */
const MAX_FIELDS = 64;
/** 合计字符上限 */
const MAX_TOTAL_CHARS = 16384;

/** 可视为「文本」的字符区间（拉丁 / 中日韩 / 韩文 / 兼容区） */
const TEXT_RUN_RE = /[\u0020-\u007E\u00A0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]+/g;

/**
 * 宽松解码字节为文本：优先 UTF-8（现实中的 Exif/PNG 文本常为 UTF-8），
 * 出现替换字符时回退 Latin-1（Exif 规范定义的字符集）。
 * @param {Buffer} buf 字节
 * @returns {string} 文本
 */
function decodeText(buf) {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return buf.toString('latin1');
}

/**
 * 从任意文本中抽取长度达标的连续文本段。
 * @param {string} text 文本
 * @param {number} [minLen=3] 最短长度
 * @returns {string[]} 文本段
 */
function extractRuns(text, minLen = 3) {
  if (!text) return [];
  const matches = String(text).match(TEXT_RUN_RE) || [];
  const out = [];
  for (const m of matches) {
    const trimmed = m.trim();
    if (trimmed.length >= minLen) out.push(trimmed);
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

/**
 * 规范化 EXIF UserComment：按前缀判断字符集。
 * @param {Buffer} buf 原始字节
 * @returns {string} 文本
 */
function decodeUserComment(buf) {
  if (!buf || buf.length <= 8) return buf ? buf.toString('utf8') : '';
  const prefix = buf.slice(0, 8).toString('latin1');
  const body = buf.slice(8);
  if (prefix.startsWith('ASCII')) return decodeText(body);
  if (prefix.startsWith('UNICODE')) {
    // EXIF 规范为 UTF-16，字节序未声明时按 LE 读取（Windows/Android 常见）
    const le = body.toString('utf16le');
    if (le && !le.includes('\uFFFD') && /[\S]/.test(le)) return le;
    return decodeText(body);
  }
  return decodeText(body);
}

/**
 * 解析 TIFF 结构（Exif IFD0 + 一层子 IFD），收集 ASCII / UNDEFINED 字段。
 * @param {Buffer} buf 以 TIFF 头开始的缓冲
 * @param {Array<{name: string, text: string}>} out 输出
 */
function parseTiff(buf, out) {
  if (buf.length < 8) return;
  const little = buf.slice(0, 2).toString('latin1') === 'II';
  const readU16 = (off) => (little ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
  const readU32 = (off) => (little ? buf.readUInt32LE(off) : buf.readUInt32BE(off));

  const walk = (ifdOffset, depth) => {
    if (depth > 2 || ifdOffset <= 0 || ifdOffset + 2 > buf.length) return;
    let count = 0;
    try { count = readU16(ifdOffset); } catch { return; }
    if (count <= 0 || count > 512) return;

    for (let i = 0; i < count; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > buf.length || out.length >= MAX_FIELDS) return;
      let tag = 0;
      let type = 0;
      let num = 0;
      let valueOffset = 0;
      try {
        tag = readU16(entry);
        type = readU16(entry + 2);
        num = readU32(entry + 4);
        valueOffset = readU32(entry + 8);
      } catch {
        return;
      }
      if (num <= 0 || num > MAX_FIELD_LEN * 4) continue;

      const inline = num <= 4;
      const dataStart = inline ? entry + 8 : valueOffset;
      const size = Math.min(num, MAX_FIELD_LEN);
      if (dataStart < 0 || dataStart + 1 > buf.length) continue;

      // type 1=BYTE 2=ASCII 7=UNDEFINED 为主要文本载体
      if (type !== 1 && type !== 2 && type !== 7) continue;
      let slice = null;
      try { slice = buf.slice(dataStart, Math.min(buf.length, dataStart + size)); } catch { continue; }
      if (!slice || slice.length === 0) continue;

      let text = '';
      if (tag === 0x9286) text = decodeUserComment(slice);
      else text = decodeText(slice);
      text = text.replace(/\0+$/g, '').trim();
      if (!text) continue;
      out.push({ name: `exif:0x${tag.toString(16)}`, text: text.slice(0, MAX_FIELD_LEN) });

      // ExifIFD 指针（0x8769）继续下钻一层
      if (tag === 0x8769 && type === 4) {
        try { walk(readU32(dataStart), depth + 1); } catch { /* 忽略子 IFD 解析失败 */ }
      }
    }
  };

  walk(readU32(4), 0);
}

/**
 * 解析 JPEG：APP1 Exif / APP1 XMP / COM 注释段。
 * @param {Buffer} buf 文件缓冲
 * @param {Array<{name: string, text: string}>} out 输出
 */
function parseJpeg(buf, out) {
  let offset = 2;
  while (offset + 4 < buf.length && out.length < MAX_FIELDS) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xda) break; // 进入压缩数据，后面没有元数据
    let len = 0;
    try { len = buf.readUInt16BE(offset + 2); } catch { break; }
    if (len < 2) break;
    const payload = buf.slice(offset + 4, Math.min(buf.length, offset + 2 + len));
    if (marker === 0xe1) {
      const head = payload.slice(0, 29).toString('latin1');
      if (head.startsWith('Exif\0\0')) {
        parseTiff(payload.slice(6), out);
      } else if (head.includes('xap/1.0/') || payload.slice(0, 64).toString('latin1').includes('x:xmpmeta')) {
        const text = payload.toString('utf8');
        const start = text.indexOf('<x:xmpmeta');
        const end = text.indexOf('</x:xmpmeta>');
        const body = start >= 0 ? text.slice(start, end >= 0 ? end : Math.min(text.length, start + MAX_FIELD_LEN)) : text;
        // XMP 是 XML，抓标签属性里的文本段
        const attrs = body.match(/="([^"]{3,})"/g) || [];
        for (const a of attrs) {
          if (out.length >= MAX_FIELDS) break;
          out.push({ name: 'xmp', text: a.slice(2, -1).slice(0, MAX_FIELD_LEN) });
        }
      }
    } else if (marker === 0xfe) {
      out.push({ name: 'jpeg:comment', text: decodeText(payload).replace(/\0+$/g, '').trim().slice(0, MAX_FIELD_LEN) });
    }
    offset += 2 + len;
  }
}

/**
 * 解析 PNG 文本块（tEXt / zTXt / iTXt）。
 * @param {Buffer} buf 文件缓冲
 * @param {Array<{name: string, text: string}>} out 输出
 */
function parsePng(buf, out) {
  let offset = 8;
  while (offset + 8 < buf.length && out.length < MAX_FIELDS) {
    let len = 0;
    try { len = buf.readUInt32BE(offset); } catch { break; }
    const type = buf.slice(offset + 4, offset + 8).toString('latin1');
    if (len < 0 || offset + 12 + len > buf.length) break;
    const data = buf.slice(offset + 8, offset + 8 + len);
    try {
      if (type === 'tEXt') {
        const zero = data.indexOf(0);
        if (zero > 0) {
          out.push({ name: `png:${data.slice(0, zero).toString('latin1')}`, text: decodeText(data.slice(zero + 1)).slice(0, MAX_FIELD_LEN) });
        }
      } else if (type === 'zTXt') {
        const zero = data.indexOf(0);
        if (zero > 0 && data[zero + 1] === 0) {
          const text = decodeText(zlib.inflateSync(data.slice(zero + 2)));
          out.push({ name: `png:${data.slice(0, zero).toString('latin1')}`, text: text.slice(0, MAX_FIELD_LEN) });
        }
      } else if (type === 'iTXt') {
        const zero = data.indexOf(0);
        if (zero > 0) {
          const compressed = data[zero + 1] === 1;
          // keyword\0 flag\0 method\0 lang\0 translated\0 text
          let idx = zero + 3;
          for (let k = 0; k < 2 && idx < data.length; k++) {
            const next = data.indexOf(0, idx);
            if (next < 0) break;
            idx = next + 1;
          }
          let body = data.slice(idx);
          if (compressed) body = zlib.inflateSync(body);
          out.push({ name: `png:${data.slice(0, zero).toString('latin1')}`, text: decodeText(body).slice(0, MAX_FIELD_LEN) });
        }
      }
    } catch { /* 单个文本块失败不影响其它块 */ }
    if (type === 'IEND') break;
    offset += 12 + len;
  }
}

/**
 * 解析 WebP（RIFF）中的 EXIF / XMP 块。
 * @param {Buffer} buf 文件缓冲
 * @param {Array<{name: string, text: string}>} out 输出
 */
function parseWebp(buf, out) {
  let offset = 12;
  while (offset + 8 < buf.length && out.length < MAX_FIELDS) {
    const type = buf.slice(offset, offset + 4).toString('latin1');
    let len = 0;
    try { len = buf.readUInt32LE(offset + 4); } catch { break; }
    if (len < 0 || offset + 8 + len > buf.length) break;
    const data = buf.slice(offset + 8, offset + 8 + len);
    if (type === 'EXIF') parseTiff(data.slice(6), out);
    else if (type === 'XMP ') {
      for (const run of extractRuns(data.toString('utf8'))) {
        if (out.length >= MAX_FIELDS) break;
        out.push({ name: 'xmp', text: run.slice(0, MAX_FIELD_LEN) });
      }
    }
    offset += 8 + len + (len % 2);
  }
}

/**
 * 解析 GIF 注释扩展块。
 * @param {Buffer} buf 文件缓冲
 * @param {Array<{name: string, text: string}>} out 输出
 */
function parseGif(buf, out) {
  let offset = 6;
  // 跳过逻辑屏幕描述符 + 全局颜色表
  if (buf.length < 13) return;
  const flags = buf[10];
  offset += 7;
  if (flags & 0x80) offset += 3 * (1 << ((flags & 0x07) + 1));
  while (offset + 2 < buf.length && out.length < MAX_FIELDS) {
    const block = buf[offset];
    if (block === 0x3b) break;
    if (block === 0x21 && buf[offset + 1] === 0xfe) {
      offset += 2;
      const parts = [];
      while (offset < buf.length && buf[offset] !== 0) {
        const size = buf[offset];
        parts.push(buf.slice(offset + 1, offset + 1 + size));
        offset += 1 + size;
      }
      out.push({ name: 'gif:comment', text: decodeText(Buffer.concat(parts)).slice(0, MAX_FIELD_LEN) });
      offset += 1;
      continue;
    }
    if (block === 0x21) {
      // 其它扩展块：跳过
      offset += 2;
      while (offset < buf.length && buf[offset] !== 0) offset += 1 + buf[offset];
      offset += 1;
      continue;
    }
    break;
  }
}

/**
 * 提取图片元数据中的文本字段。永不抛异常。
 * @param {Buffer} buffer 图片缓冲
 * @returns {{fields: Array<{name: string, text: string}>, totalChars: number, truncated: boolean}}
 */
function extractMetadataStrings(buffer) {
  const out = [];
  const empty = { fields: [], totalChars: 0, truncated: false };
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 8) return empty;
  const buf = buffer.length > MAX_SCAN_BYTES ? buffer.slice(0, MAX_SCAN_BYTES) : buffer;
  const truncated = buffer.length > MAX_SCAN_BYTES;

  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) parseJpeg(buf, out);
    else if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') parsePng(buf, out);
    else if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') parseWebp(buf, out);
    else if (buf.slice(0, 4).toString('latin1') === 'GIF8') parseGif(buf, out);
  } catch { /* 结构化解析失败 → 走下面的兜底扫描 */ }

  // 兜底：未识别容器或结构化解析为空时，做可打印段扫描
  if (out.length === 0) {
    const head = buf.slice(0, Math.min(buf.length, 64 * 1024)).toString('utf8');
    for (const run of extractRuns(head, 4)) {
      if (out.length >= MAX_FIELDS) break;
      out.push({ name: 'scan', text: run.slice(0, MAX_FIELD_LEN) });
    }
  }

  // 汇总裁剪
  const fields = [];
  let totalChars = 0;
  for (const f of out) {
    if (fields.length >= MAX_FIELDS || totalChars >= MAX_TOTAL_CHARS) break;
    const text = String(f.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const clipped = text.slice(0, Math.min(MAX_FIELD_LEN, MAX_TOTAL_CHARS - totalChars));
    fields.push({ name: f.name, text: clipped });
    totalChars += clipped.length;
  }
  return { fields, totalChars, truncated: truncated || fields.length >= MAX_FIELDS };
}

module.exports = {
  MAX_SCAN_BYTES,
  MAX_FIELD_LEN,
  MAX_FIELDS,
  decodeText,
  extractRuns,
  decodeUserComment,
  extractMetadataStrings,
};
