/**
 * 整理规则：时间修复 / 命名 / 目录结构 / 分类（plugins/batch-image-suite/lib/organizer.js）
 *
 * ★ 安全红线：本模块只计算「目标路径」，文件搬运由 pipeline 用 fs.copyFile 完成；
 *   源目录全程只读，绝不 rename / unlink 源文件。
 */

/** 四类分类目录（PRD R-B18 + 用户定稿） */
const CATEGORIES = ['人物', '旅行风景', '美食物件宠物', '证件文档截图'];
/** 未命中任何分类时的归属 */
const FALLBACK_CATEGORY = '未分类';
/** 待筛目录名（位于**输出目录内**） */
const PENDING_DIR = '_待后续筛选_无用候选';
/** 时间未知目录名 */
const UNKNOWN_TIME_DIR = '时间未知';
/** 格式不支持目录名 */
const UNSUPPORTED_DIR = '格式不支持';

/** 种类键值 → 四类分类的映射 */
const KIND_TO_CATEGORY = {
  人物: '人物', 合影: '人物', 肖像: '人物', 自拍: '人物', 儿童: '人物', 宠物: '美食物件宠物',
  风景: '旅行风景', 城市: '旅行风景', 建筑: '旅行风景', 旅行: '旅行风景', 自然: '旅行风景', 夜景: '旅行风景',
  美食: '美食物件宠物', 物件: '美食物件宠物', 商品: '美食物件宠物', 植物: '美食物件宠物', 动物: '美食物件宠物',
  证件: '证件文档截图', 文档: '证件文档截图', 票据: '证件文档截图', 截图: '证件文档截图', 聊天记录: '证件文档截图',
  角色立绘: '人物', 场景图: '旅行风景', 色情: '人物', 摄影: '旅行风景',
};

/**
 * 把模型输出的 kind 映射到四类分类之一。
 * @param {string} kind 种类键值
 * @param {string} [category] 模型输出的分类（优先使用）
 * @returns {string} 分类目录名
 */
function categoryOf(kind, category) {
  if (category && CATEGORIES.includes(category)) return category;
  if (kind && KIND_TO_CATEGORY[kind]) return KIND_TO_CATEGORY[kind];
  if (category && category === '未分类') return FALLBACK_CATEGORY;
  return FALLBACK_CATEGORY;
}

/**
 * 时间四级修复（PRD R-B15）：
 *   ① EXIF → ② 文件名内嵌日期 → ③ 文件 birthtime/mtime → ④ AI 推断年代 → ⑤ 时间未知
 * ★ 命中 ⑤ 时绝不填充任何具体日期。
 *
 * @param {{srcName: string, birthtimeMs: number, mtimeMs: number}} file 文件信息
 * @param {{shotAt?: string|null, aiEra?: string|null}} [extra] 额外信息（EXIF 结果 / AI 年代）
 * @returns {{shotAt: string|null, timeSource: string}} timeSource: exif|filename|fs|ai_era|unknown
 */
function repairTime(file, extra = {}) {
  // ① EXIF
  if (extra.shotAt) return { shotAt: extra.shotAt, timeSource: 'exif' };
  // ② 文件名内嵌日期
  const fromName = parseNameDate(file.srcName);
  if (fromName) return { shotAt: fromName, timeSource: 'filename' };
  // ③ 文件系统时间（取 birthtime 与 mtime 中较早者，更接近拍摄时间）
  const bt = Number(file.birthtimeMs) || 0;
  const mt = Number(file.mtimeMs) || 0;
  const t = Math.min(bt || mt, mt || bt) || mt;
  if (t) return { shotAt: formatDateTime(new Date(t)), timeSource: 'fs' };
  // ④ AI 推断年代（只给年代，不给精确日期；shotAt 置 null，另存 aiEra）
  if (extra.aiEra) return { shotAt: null, timeSource: 'ai_era' };
  // ⑤ 时间未知
  return { shotAt: null, timeSource: 'unknown' };
}

/** 从文件名解析日期（复用 exif 模块的正则） */
function parseNameDate(name) {
  try {
    const { parseDateFromName } = require('./exif');
    return parseDateFromName(name);
  } catch {
    return null;
  }
}

/**
 * 格式化 Date 为 'YYYY-MM-DD HH:MM:SS'。
 * @param {Date} d 日期
 * @returns {string}
 */
function formatDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 把 'YYYY-MM-DD HH:MM:SS' 拆成日期与时间片段。
 * @param {string|null} shotAt 时间串
 * @returns {{year: string, month: string, day: string, date: string, time: string}|null}
 */
function timeParts(shotAt) {
  if (!shotAt) return null;
  const m = String(shotAt).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return { year: m[1], month: m[2], day: m[3], date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}${m[5]}` };
}

/**
 * 净化描述文本：去除文件系统非法字符，截断到指定长度。
 * @param {string} desc 原始描述
 * @param {number} [maxLen=16] 最大长度
 * @param {string} [fallback='未命名'] 空值回落
 * @returns {string}
 */
function sanitizeDesc(desc, maxLen = 16, fallback = '未命名') {
  let s = String(desc || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim();
  if (!s) s = fallback;
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/**
 * 计算目标相对路径（YYYY/MM/分类/文件名）。
 * @param {object} item 条目
 * @param {{structure?: string}} [opts] 选项
 * @returns {string} 相对输出目录的路径（含文件名）
 */
function targetRelativePath(item, opts = {}) {
  const parts = timeParts(item.shotAt);
  const category = categoryOf(item.kind, item.category);
  const name = buildFileName(item, opts);
  // 废图：进输出目录内的待筛目录，按原因分子目录
  if (item.pending) {
    return pathJoin(PENDING_DIR, item.pendingReason || '其他', name);
  }
  if (item.unsupported) {
    return pathJoin(UNSUPPORTED_DIR, name);
  }
  if (!parts) {
    // ★ 时间未知：归入顶层「时间未知/」，文件名中不含任何日期串（R-B25）
    return pathJoin(UNKNOWN_TIME_DIR, name.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/__+/g, '_'));
  }
  return pathJoin(parts.year, parts.month, category, name);
}

/** 拼接相对路径（统一用 / ，避免平台差异） */
function pathJoin(...segs) {
  return segs.filter((s) => s !== undefined && s !== null && s !== '').join('/');
}

/**
 * 生成文件名：YYYY-MM-DD_HHMM_简短描述.后缀
 * @param {object} item 条目
 * @param {{naming?: string}} [opts] 选项
 * @returns {string}
 */
function buildFileName(item, opts = {}) {
  const ext = (item.ext || '.jpg').toLowerCase();
  const desc = sanitizeDesc(item.description, 16, '未命名');
  const parts = timeParts(item.shotAt);
  if (!parts) {
    // 时间未知：文件名不含日期
    const n = item.naming && item.naming.unknownTimeTemplate ? item.naming.unknownTimeTemplate : '时间未知_{desc}';
    return `${n.replace('{desc}', desc)}${ext}`;
  }
  const template = (item.naming && item.naming.template) || '{date}_{time}_{desc}';
  return `${template
    .replace(/\{date\}/g, parts.date)
    .replace(/\{time\}/g, parts.time)
    .replace(/\{desc\}/g, desc)
    .replace(/\{year\}/g, parts.year)
    .replace(/\{month\}/g, parts.month)
    .replace(/\{day\}/g, parts.day)}${ext}`;
}

/**
 * 组内保留画质最好的一张（PRD R-B21）：
 *   score = 0.45×像素数归一 + 0.35×sharpness归一 + 0.20×文件大小归一
 *   并列时取拍摄时间最早的一张。
 * @param {Array<object>} group 同组条目
 * @returns {object|null} 应保留的条目
 */
function pickGroupKeep(group) {
  const valid = (group || []).filter((it) => it && !it.unsupported);
  if (!valid.length) return null;
  const pixels = valid.map((it) => (Number(it.width) || 0) * (Number(it.height) || 0));
  const sizes = valid.map((it) => Number(it.size) || 0);
  const sharps = valid.map((it) => Number(it.sharpness) || 0);
  const maxP = Math.max(...pixels, 1);
  const maxS = Math.max(...sizes, 1);
  const maxSh = Math.max(...sharps, 1);

  let best = null;
  let bestScore = -1;
  valid.forEach((it, i) => {
    const score = 0.45 * (pixels[i] / maxP) + 0.35 * (sharps[i] / maxSh) + 0.20 * (sizes[i] / maxS);
    it.qualityScore = Number(score.toFixed(4));
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = it;
    } else if (Math.abs(score - bestScore) <= 1e-9 && best) {
      // 并列：取拍摄时间更早的
      const a = best.shotAt || '9999-99-99';
      const b = it.shotAt || '9999-99-99';
      if (b < a) best = it;
    }
  });
  return best;
}

/**
 * 目标路径冲突处理：加后缀 / 跳过 / 覆盖。
 * @param {string} target 目标绝对路径
 * @param {'suffix'|'skip'|'overwrite'} [collision='suffix'] 策略
 * @returns {{path: string, action: 'write'|'skip'}}
 */
function resolveCollision(target, collision = 'suffix') {
  const fs = require('fs');
  if (!fs.existsSync(target)) return { path: target, action: 'write' };
  if (collision === 'overwrite') return { path: target, action: 'write' };
  if (collision === 'skip') return { path: target, action: 'skip' };
  const ext = require('path').extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}_${i}${ext}`;
    if (!fs.existsSync(candidate)) return { path: candidate, action: 'write' };
  }
  return { path: target, action: 'skip' };
}

module.exports = {
  CATEGORIES,
  FALLBACK_CATEGORY,
  PENDING_DIR,
  UNKNOWN_TIME_DIR,
  UNSUPPORTED_DIR,
  KIND_TO_CATEGORY,
  categoryOf,
  repairTime,
  timeParts,
  formatDateTime,
  sanitizeDesc,
  targetRelativePath,
  buildFileName,
  pickGroupKeep,
  resolveCollision,
  pathJoin,
};
