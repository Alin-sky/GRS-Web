/**
 * 文件系统服务（plugins/batch-image-suite/lib/fs-service.js）
 *
 * 只做**只读**枚举：目录统计、目录树懒加载、盘符列表、图片文件收集。
 * ★ 安全红线：本模块绝不写/删/改任何文件，源素材目录全程只读。
 */
const fs = require('fs');
const path = require('path');

/** 支持的图片扩展名 */
const FORMAT_EXT_MAP = {
  jpg: '.jpg', jpeg: '.jpeg', png: '.png', webp: '.webp',
  gif: '.gif', bmp: '.bmp', tiff: '.tiff', avif: '.avif',
};

/** 默认勾选的格式（沿用 batch-scan.js） */
const DEFAULT_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

/**
 * 把格式名数组转换为扩展名集合。
 * @param {string[]} formats 格式名数组
 * @returns {Set<string>} 扩展名集合
 */
function formatsToExts(formats) {
  const list = Array.isArray(formats) && formats.length ? formats : DEFAULT_FORMATS;
  return new Set(list.map((f) => FORMAT_EXT_MAP[String(f).toLowerCase()]).filter(Boolean));
}

/**
 * 收集目录下的图片文件（只读）。
 * @param {{dir: string, recursive?: boolean, formats?: string[], maxFileSizeMb?: number}} opts 选项
 * @returns {{ok: boolean, error?: string, files?: Array<{path: string, name: string, size: number, mtimeMs: number, relDir: string}>, truncated?: boolean}}
 */
function collectImages(opts) {
  const { dir, recursive = true, formats, maxFileSizeMb = 20 } = opts || {};
  const out = { ok: false, files: [], truncated: false };
  if (!dir || typeof dir !== 'string') {
    out.error = '路径为空';
    return out;
  }
  const root = path.resolve(dir);
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) {
      out.error = '不是目录';
      return out;
    }
  } catch {
    out.error = '目录不存在';
    return out;
  }
  const exts = formatsToExts(formats);
  const maxBytes = (Number(maxFileSizeMb) || 20) * 1024 * 1024;
  const files = [];
  let scanned = 0;
  const MAX_SCAN = 200000;

  const walk = (current, depth) => {
    if (scanned >= MAX_SCAN) { out.truncated = true; return; }
    let names = [];
    try { names = fs.readdirSync(current); } catch { return; }
    for (const name of names) {
      if (scanned >= MAX_SCAN) { out.truncated = true; return; }
      const full = path.join(current, name);
      let st2 = null;
      try { st2 = fs.statSync(full); } catch { continue; }
      scanned++;
      if (st2.isDirectory()) {
        if (recursive && depth < 32) walk(full, depth + 1);
        continue;
      }
      if (!exts.has(path.extname(name).toLowerCase())) continue;
      files.push({
        path: full,
        name,
        size: st2.size,
        mtimeMs: st2.mtimeMs,
        birthtimeMs: st2.birthtimeMs || st2.mtimeMs,
        relDir: path.relative(root, current) || '',
        overSize: st2.size > maxBytes,
      });
    }
  };
  walk(root, 0);
  out.ok = true;
  out.files = files;
  return out;
}

/**
 * 目录统计（供 folder-picker 校验）。
 * @param {string} dir 目录
 * @param {{recursive?: boolean}} [opts] 选项
 * @returns {object}
 */
function statDir(dir, opts = {}) {
  const res = collectImages({ dir, recursive: opts.recursive !== false, maxFileSizeMb: 100000 });
  const out = {
    exists: false, isDir: false, path: dir || '', imageCount: 0,
    fileCount: 0, estBytes: 0, dirCount: 0, sampleNames: [], truncated: false,
  };
  if (!dir) return out;
  const abs = path.resolve(dir);
  out.path = abs;
  try {
    const st = fs.statSync(abs);
    out.exists = true;
    if (!st.isDirectory()) return out;
    out.isDir = true;
  } catch { return out; }
  if (res.ok) {
    out.imageCount = res.files.length;
    out.estBytes = res.files.reduce((s, f) => s + f.size, 0);
    out.sampleNames = res.files.slice(0, 12).map((f) => f.name);
    out.truncated = !!res.truncated;
  }
  // 单独统计目录数与总文件数
  try {
    const countWalk = (d, depth) => {
      let names = [];
      try { names = fs.readdirSync(d); } catch { return; }
      for (const n of names) {
        const full = path.join(d, n);
        let s = null;
        try { s = fs.statSync(full); } catch { continue; }
        if (s.isDirectory()) { out.dirCount++; if (depth < 32) countWalk(full, depth + 1); }
        else out.fileCount++;
      }
    };
    countWalk(abs, 0);
  } catch { /* 忽略 */ }
  return out;
}

/**
 * 列出目录一级内容（目录树懒加载）。
 * @param {string} dir 目录
 * @returns {{ok: boolean, path?: string, entries?: Array<object>, error?: string}}
 */
function listDir(dir) {
  const out = { ok: false, path: dir || '', entries: [] };
  if (!dir) { out.error = '路径为空'; return out; }
  try {
    const abs = path.resolve(dir);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) { out.error = '不是目录'; return out; }
    const names = fs.readdirSync(abs);
    const entries = [];
    for (const name of names) {
      if (name === '$RECYCLE.BIN' || name === 'System Volume Information') continue;
      const full = path.join(abs, name);
      try {
        const s = fs.statSync(full);
        if (s.isDirectory()) entries.push({ name, path: full, type: 'dir', hasChildren: true });
      } catch { /* 无权限跳过 */ }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    out.ok = true;
    out.path = abs;
    out.entries = entries;
    return out;
  } catch (err) {
    out.error = err.code === 'ENOENT' ? '目录不存在' : (err.code === 'EACCES' ? '无访问权限' : err.message);
    return out;
  }
}

/**
 * 列出可用盘符/根目录。
 * @returns {Array<{name: string, path: string}>}
 */
function roots() {
  const out = [];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;
      try { if (fs.existsSync(root)) out.push({ name: `${letter}:`, path: root }); } catch { /* 忽略 */ }
    }
  } else {
    out.push({ name: '/', path: '/' });
  }
  return out;
}

/**
 * 确保目录存在（仅用于输出目录，绝不用于源目录）。
 * @param {string} dir 目录
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  FORMAT_EXT_MAP,
  DEFAULT_FORMATS,
  formatsToExts,
  collectImages,
  statDir,
  listDir,
  roots,
  ensureDir,
};
