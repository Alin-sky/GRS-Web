/**
 * 对比源数据读取（src/comparison-source.js）
 * v2.3.0（Req5）新增：对比审核的**输入侧**数据访问——审核记录与图片字节。
 * 与 comparison-store.js（输出侧：对比结果落盘）分离，单一职责。
 * 为什么图片字节必须单独处理：审核记录只存「判定结果」，不存图片本体。
 * 图像对比要重跑，就必须能重新拿到图片字节。本项目里图片有两条可得路径：
 * ① 审核记录的 meta.source —— 批量扫描时由 batch-scan 写入的原始文件绝对路径
 * ② 用户显式指定的文件夹（与批量扫描同一套枚举规则）
 * 拿不到字节的历史图片记录会被**显式跳过并计入 skipped_no_image**，
 * 绝不静默当作「已对比」——否则一致率会被虚假抬高。
 */
const fs = require('fs');
const path = require('path');
const { getAuditRecords } = require('./audit-store');
// D1 修复：`imagePathOf()` 依赖 `imageRefModule.resolveImageRef()` 做「blob 存在性裁决」，
// 但本文件此前**漏了这句 require** ⇒ 每次调用 `imagePathOf()` 都抛
// `ReferenceError: imageRefModule is not defined` ⇒ 图像对比整条挂（P0）。
// 依赖方向仍为「核心层 → 核心层」，不引入环（image-ref 只 require config/logger）。
const imageRefModule = require('./image-ref');

/** 支持的图片扩展名（与 batch-scan / fs-service 对齐）*/
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif']);

/** 单张图片大小上限（base64 后易超上下文，与 batch-scan 的 20MB 对齐）*/
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 判定路径是否为图片（按扩展名）。
 * @param {string} p 路径
 * @returns {boolean} 是否图片
 */
function isImagePath(p) {
  return IMAGE_EXTS.has(path.extname(String(p || '')).toLowerCase());
}

/**
 * 读取指定日期的审核记录。
 * @param {string} dateStr 日期
 * @returns {Array<object>} 记录数组
 */
function readAuditRecords(dateStr) {
  return getAuditRecords(dateStr);
}

/**
 * 取一条记录里可用的图片路径。
 * v0.2.0 取值序（前置 image_ref）：
 * ① `image_ref.blob`（内容寻址落盘，**存在才用**）
 * ② `image_ref.source.ref`（本地文件绝对路径，**存在才用**）
 * ③ 既有回退：`meta.source` → `meta.filePath` → `result.image_path`
 * ①② 由 `resolveImageRef()` 统一裁决（含存在性检查）—— 因此删掉 `data/image_blobs/` 后
 * 会自动回退到 ③，页面/对比不会报错。
 * @param {object} record 审核记录（或已被展平的记录对象）
 * @returns {string|null} 绝对路径（无则 null）
 */
function imagePathOf(record) {
  if (!record) return null;
  const resolved = imageRefModule.resolveImageRef(record);
  if (resolved && resolved.blobAbs) return resolved.blobAbs;
  const meta = record.meta || {};
  const result = record.result || {};
  const candidate = meta.source || meta.filePath || result.image_path || null;
  if (!candidate || typeof candidate !== 'string') return null;
  if (!isImagePath(candidate)) return null;
  return candidate;
}

/**
 * 读取图片并转为 base64（不含 data: 前缀）。
 * @param {string} filePath 图片绝对路径
 * @returns {{ok: boolean, imageBase64?: string, bytes?: number, error?: string}} 读取结果
 */
function readImageBase64(filePath) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: '路径为空' };
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: '不是文件' };
    if (st.size > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限` };
    }
    const buf = fs.readFileSync(filePath);
    // v0.2.0：filePath 现在可能是内容寻址 blob 的绝对路径（`data/image_blobs/<h2>/<hash>.<ext>`），
    // 本函数只按「绝对路径读字节」处理，两者完全同构，无需分支。
    return { ok: true, imageBase64: buf.toString('base64'), bytes: st.size };
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? '文件不存在' : err.message };
  }
}

/**
 * 从审核记录中挑出「图片字节可得」的图片记录。
 * @param {Array<object>} records 指定日期的审核记录
 * @returns {{items: Array<object>, skipped: number}} items = [{record, imagePath}]
 */
function collectAuditImages(records) {
  const items = [];
  let skipped = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const imagePath = imagePathOf(record);
    if (!imagePath) { skipped++; continue; }
    if (!fs.existsSync(imagePath)) { skipped++; continue; }
    items.push({ record, imagePath });
  }
  return { items, skipped };
}

/**
 * 枚举文件夹内的图片（与批量扫描同规则，只读）。
 * @param {{dir: string, recursive?: boolean, maxItems?: number}} opts 选项
 * @returns {Array<{path: string, name: string, size: number, mtimeMs: number}>} 图片列表
 */
function listFolderImages(opts) {
  const dir = opts && opts.dir;
  const recursive = !opts || opts.recursive !== false;
  const maxItems = Number(opts && opts.maxItems) > 0 ? Number(opts.maxItems) : 500;
  if (!dir || typeof dir !== 'string') return [];
  const root = path.resolve(dir);
  try {
    if (!fs.statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const out = [];
  const walk = (current, depth) => {
    if (out.length >= maxItems) return;
    let names = [];
    try { names = fs.readdirSync(current); } catch { return; }
    for (const name of names) {
      if (out.length >= maxItems) return;
      const full = path.join(current, name);
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (recursive && depth < 16) walk(full, depth + 1);
        continue;
      }
      if (!isImagePath(full)) continue;
      if (st.size > MAX_IMAGE_BYTES) continue;
      out.push({ path: full, name, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(root, 0);
  return out;
}

module.exports = {
  IMAGE_EXTS,
  MAX_IMAGE_BYTES,
  isImagePath,
  readAuditRecords,
  imagePathOf,
  readImageBase64,
  collectAuditImages,
  listFolderImages,
};