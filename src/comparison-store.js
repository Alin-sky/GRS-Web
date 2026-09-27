/**
 * 对比结果存储与源数据读取（src/comparison-store.js）
 * v2.3.0（Req5）新增：把「对比结果的落盘/读取」与「审核记录的读取」收敛为一份实现，
 * 供两个消费者共用，**彻底消除内置路径与插件路径各写一套导致的格式漂移**：
 * ① 内置对比引擎 src/comparator.js
 * ② 对比审核插件 plugins/comparison-suite（经 ctx.inject('comparisonStore') 拿到）
 * 存储布局（与历史数据完全兼容，不迁移）：
 * data/comparisons/<YYYY-MM-DD>.json —— 单日对比结果（date / run_at / total_records / results / summary）
 * 依赖方向：核心层模块，只依赖本层 utilities。
 */
const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');
const { getAuditRecords } = require('./audit-store');
const { logInfo } = require('./logger');

const COMPARISON_DIR = path.join(getProjectRoot(), 'data', 'comparisons');

if (!fs.existsSync(COMPARISON_DIR)) {
  fs.mkdirSync(COMPARISON_DIR, { recursive: true });
}

/** 日期合法性（严格 YYYY-MM-DD，且分量真实存在）*/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 判定日期字符串是否合法（防路径穿越：`../` 等一律拒绝）。
 * @param {string} dateStr 日期
 * @returns {boolean} 是否合法
 */
function isValidDate(dateStr) {
  if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // 反向格式化比对，排除 2026-02-31 这类「格式对但不存在」的日期
  return d.toISOString().slice(0, 10) === dateStr;
}

/**
 * 取指定日期的对比结果文件路径。
 * @param {string} dateStr 日期
 * @returns {string|null} 绝对路径（日期非法时 null）
 */
function filePathOf(dateStr) {
  if (!isValidDate(dateStr)) return null;
  return path.join(COMPARISON_DIR, `${dateStr}.json`);
}

/**
 * 取昨天的日期字符串（本地时区）。
 * @returns {string} YYYY-MM-DD
 */
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 读取指定日期的审核记录（透传 audit-store）。
 * @param {string} dateStr 日期
 * @returns {Array<object>} 记录数组
 */
function readAuditRecords(dateStr) {
  return getAuditRecords(dateStr);
}

/**
 * 写入单日对比结果（原子写：先写 .tmp 再 rename，避免半截文件）。
 * @param {string} dateStr 日期
 * @param {object} payload 对比结果
 * @returns {string|null} 实际写入路径（失败 null）
 */
function writeResult(dateStr, payload) {
  const target = filePathOf(dateStr);
  if (!target) {
    logInfo('comparison-store', `拒绝写入非法日期: ${dateStr}`);
    return null;
  }
  try {
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
    return target;
  } catch (err) {
    logInfo('comparison-store', `写入对比结果失败 (${dateStr}): ${err.message}`);
    return null;
  }
}

/**
 * 读取单日对比结果。
 * @param {string} dateStr 日期
 * @returns {object|null} 对比结果，或 null
 */
function readResult(dateStr) {
  const target = filePathOf(dateStr);
  if (!target) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 列出全部对比结果（按日期倒序）。
 * @returns {Array<object>} 列表项 { date, total_records, agreement_rate, agreed, disagreed, run_at, modalities }
 */
function listResults() {
  try {
    const files = fs.readdirSync(COMPARISON_DIR).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      const date = f.replace(/\.json$/, '');
      const data = readResult(date);
      if (!data) return { date, total_records: 0, agreement_rate: 0 };
      // 兼容历史：早期字段名 agreement_rate/agreed/disagreed 在 summary 顶层，
      // 新格式（v2.2.0 起三通道交叉）把每对通道的一致率放在 summary.comparisons。
      const comps = (data.summary && data.summary.comparisons) || {};
      const pairs = Object.values(comps);
      const first = pairs[0] || {};
      const aggAgreed = pairs.reduce((n, p) => n + (p.agreed || 0), 0);
      const aggDisagreed = pairs.reduce((n, p) => n + (p.disagreed || 0), 0);
      const rate = pairs.length
        ? Math.round((pairs.reduce((n, p) => n + (p.agreement_rate || 0), 0) / pairs.length) * 10) / 10
        : (data.summary && data.summary.agreement_rate) || 0;
      return {
        date,
        total_records: data.total_records,
        agreement_rate: rate,
        agreed: pairs.length ? aggAgreed : (first.agreed || 0),
        disagreed: pairs.length ? aggDisagreed : (first.disagreed || 0),
        run_at: data.run_at,
        modalities: (data.summary && data.summary.modalities) || ['text'],
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  } catch {
    return [];
  }
}

/**
 * 生成「空结果」骨架（无记录时使用，保持与有记录时同构）。
 * @param {string} dateStr 日期
 * @param {string} [modality] 模态
 * @returns {object} 空结果
 */
function emptyResult(dateStr, modality = 'text') {
  return {
    date: dateStr,
    run_at: new Date().toISOString(),
    total_records: 0,
    message: '无审核记录',
    results: [],
    summary: {
      total: 0,
      valid: 0,
      deduplicated: 0,
      channels: [],
      models: [],
      comparisons: {},
      skipped_errors: 0,
      modalities: [modality],
    },
  };
}

module.exports = {
  COMPARISON_DIR,
  isValidDate,
  filePathOf,
  yesterdayStr,
  readAuditRecords,
  writeResult,
  readResult,
  listResults,
  emptyResult,
};