/**
 * 待匹配文本来源收集（plugins/keyword-image-guard/lib/sources.js）
 *
 * 从调用载荷中按「已勾选的来源」收集待匹配文本：
 *   filename（文件名） / exif（图片元数据） / caption（附带文本） / upstreamTags（上游标签）
 *
 * ★ 只返回「文本 + 来源标识」，不落盘、不打印；文件名只取 basename，不含完整路径。
 */
'use strict';

const path = require('path');
const exif = require('./exif');

/** 支持的来源枚举（与 manifest 节点参数 options 一致） */
const ALL_SOURCES = Object.freeze(['filename', 'exif', 'caption', 'upstreamTags']);

/** 单条文本长度上限 */
const MAX_TEXT_LEN = 4096;

/**
 * 归一化来源勾选。
 * @param {any} value 用户配置
 * @returns {string[]} 生效来源
 */
function normalizeSources(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' && value ? value.split(',') : []);
  const out = list.map((s) => String(s).trim()).filter((s) => ALL_SOURCES.includes(s));
  return out.length ? [...new Set(out)] : ['filename', 'caption', 'upstreamTags'];
}

/**
 * 取文件名的 basename 并去掉扩展名（不含目录，避免泄漏完整路径）。
 * @param {any} value 文件名或路径
 * @returns {string} 文件名主干
 */
function basenameStem(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let name = raw;
  try {
    name = path.basename(raw.replace(/[\\/]+$/, ''));
  } catch {
    name = raw;
  }
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 6) name = name.slice(0, dot);
  return name.slice(0, MAX_TEXT_LEN);
}

/**
 * 从载荷中取第一个非空字符串字段。
 * @param {object} obj 对象
 * @param {string[]} keys 候选键
 * @returns {string} 值
 */
function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/**
 * 取图片二进制（Buffer 优先，其次 base64）。不打印内容与长度以外的一切信息。
 * @param {object} payload 载荷
 * @returns {Buffer|null} 二进制
 */
function bufferOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Buffer.isBuffer(payload.buffer)) return payload.buffer;
  const b64 = firstString(payload, ['base64', 'imageBase64', 'image']);
  if (b64) {
    try { return Buffer.from(b64, 'base64'); } catch { return null; }
  }
  return null;
}

/**
 * 收集上游标签文本（支持字符串数组与 {name|tag|label, score} 数组）。
 * @param {any} value 标签集合
 * @param {number} maxCount 上限
 * @returns {Array<{name: string, text: string}>} 标签文本
 */
function collectTags(value, maxCount) {
  const out = [];
  const push = (item, idx) => {
    if (out.length >= maxCount) return;
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) out.push({ name: `tag#${idx + 1}`, text: text.slice(0, MAX_TEXT_LEN) });
      return;
    }
    if (item && typeof item === 'object') {
      const text = firstString(item, ['name', 'tag', 'label', 'text', 'value']);
      if (text) out.push({ name: `tag#${idx + 1}`, text: text.slice(0, MAX_TEXT_LEN) });
    }
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (typeof value === 'string' && value.trim()) {
    value.split(/[,，\s]+/).forEach((t, i) => push(t, i));
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach((k, i) => push(k, i));
  }
  return out.slice(0, maxCount);
}

/**
 * 按来源收集待匹配文本。
 * @param {{payload?: object, meta?: object}} request 请求
 * @param {{sources?: any, maxTagCount?: number}} options 选项
 * @returns {{items: Array<{source: string, name: string, text: string}>, stats: object}}
 */
function collectTexts(request = {}, options = {}) {
  const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
  const meta = request.meta && typeof request.meta === 'object' ? request.meta : {};
  const sources = normalizeSources(options.sources);
  const maxTagCount = Math.min(200, Math.max(1, Number(options.maxTagCount) || 50));
  const items = [];

  if (sources.includes('filename')) {
    const value = firstString(payload, ['filename', 'fileName', 'name', 'file', 'path'])
      || firstString(meta, ['filename', 'fileName', 'name', 'path']);
    const stem = basenameStem(value);
    if (stem) items.push({ source: 'filename', name: 'filename', text: stem });
  }

  if (sources.includes('caption')) {
    const value = firstString(payload, ['caption', 'text', 'description', 'note', 'alt', 'title'])
      || firstString(meta, ['caption', 'text', 'description']);
    if (value) items.push({ source: 'caption', name: 'caption', text: value.slice(0, MAX_TEXT_LEN) });
  }

  if (sources.includes('upstreamTags')) {
    // 上游标签可能出现在 payload（节点透传）或 work 工作上下文（contribute 节点写入）
    const raw = payload.upstreamTags || payload.tags || payload.labels
      || request.work && (request.work.tags || request.work.labels);
    const tags = collectTags(raw, maxTagCount);
    for (const tag of tags) items.push({ source: 'upstreamTags', name: tag.name, text: tag.text });
  }

  if (sources.includes('exif')) {
    // ① 调用方直接给出的 EXIF（字符串或键值对象）
    const direct = payload.exif || meta.exif;
    if (typeof direct === 'string' && direct.trim()) {
      items.push({ source: 'exif', name: 'exif:inline', text: direct.slice(0, MAX_TEXT_LEN) });
    } else if (direct && typeof direct === 'object') {
      for (const key of Object.keys(direct)) {
        const v = direct[key];
        if (typeof v === 'string' && v.trim()) items.push({ source: 'exif', name: `exif:${key}`, text: v.slice(0, MAX_TEXT_LEN) });
        if (items.length > 200) break;
      }
    }
    // ② 从图片二进制中解析
    const buffer = bufferOf(payload);
    if (buffer) {
      const extracted = exif.extractMetadataStrings(buffer);
      for (const field of extracted.fields) {
        items.push({ source: 'exif', name: field.name, text: field.text });
      }
    }
  }

  const stats = {
    sources,
    itemCount: items.length,
    bySource: items.reduce((acc, it) => {
      acc[it.source] = (acc[it.source] || 0) + 1;
      return acc;
    }, {}),
  };
  return { items, stats };
}

module.exports = {
  ALL_SOURCES,
  MAX_TEXT_LEN,
  normalizeSources,
  basenameStem,
  bufferOf,
  collectTags,
  collectTexts,
};
