/**
 * 任务落盘与续跑（plugins/batch-image-suite/lib/task-store.js）
 *
 * 设计要点：
 * - 每个任务一个 JSON：data/batch_tasks/<taskId>.json
 * - 指纹 = sha256(路径｜size｜mtimeMs)，已完成集合存任务内 → 断点续跑自动跳过
 * - 每 10 项增量落盘（沿用 batch-scan.js 的 INCREMENTAL_PERSIST_EVERY 思路）
 * - 重启后扫描 status==='running' 的任务 → 孤儿恢复（R-B06 / R-B10）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = path.join(__dirname, '..', '..', '..', 'data');
const TASKS_DIR = path.join(DATA_ROOT, 'batch_tasks');
/** 兼容旧目录（双读，不硬迁移） */
const LEGACY_DIR = path.join(DATA_ROOT, 'batch_results');
/** 每处理 N 项落盘一次 */
const PERSIST_EVERY = 10;

function ensureDir() {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
}

/**
 * 计算文件指纹。
 * @param {string} filePath 路径
 * @param {number} size 大小
 * @param {number} mtimeMs 修改时间
 * @returns {string} 指纹
 */
function fingerprint(filePath, size, mtimeMs) {
  return crypto.createHash('sha256').update(`${filePath}|${size}|${mtimeMs}`).digest('hex').slice(0, 32);
}

/**
 * 创建新任务。
 * @param {object} cfg 任务配置
 * @returns {object} 任务对象
 */
function createTask(cfg) {
  ensureDir();
  const id = crypto.randomBytes(6).toString('hex');
  const now = new Date().toISOString();
  const task = {
    id,
    mode: cfg.mode || 'organize',
    sourceDir: cfg.sourceDir || '',
    outputDir: cfg.outputDir || '',
    recursive: cfg.recursive !== false,
    formats: cfg.formats || ['jpg', 'jpeg', 'png', 'webp'],
    maxFileSizeMb: cfg.maxFileSizeMb || 20,
    stages: cfg.stages || ['scan', 'decode', 'exif', 'phash', 'classify', 'dedupe', 'triage', 'materialize', 'report'],
    aiScope: cfg.aiScope || { timeUnknown: true, fsExifGap: true, needDescription: false, lowConfidencePending: true, nsfwMedium: true },
    naming: cfg.naming || { template: '{date}_{time}_{desc}', descMaxLen: 16, collision: 'suffix' },
    status: 'running',
    phase: 'scan',
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    items: [],
    doneFingerprints: [],
    logs: [],
    stats: {},
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
  };
  saveTask(task);
  return task;
}

/**
 * 落盘（原子替换）。
 * @param {object} task 任务
 */
function saveTask(task) {
  ensureDir();
  task.updatedAt = new Date().toISOString();
  const file = path.join(TASKS_DIR, `${task.id}.json`);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(task), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    // 落盘失败不阻断任务
    try { fs.writeFileSync(file, JSON.stringify(task), 'utf-8'); } catch { /* 忽略 */ }
  }
}

/**
 * 增量落盘：每 PERSIST_EVERY 项写一次。
 * @param {object} task 任务
 * @param {boolean} [force=false] 是否强制立即落盘
 */
function tickPersist(task, force = false) {
  task._sinceSave = (task._sinceSave || 0) + 1;
  if (force || task._sinceSave >= PERSIST_EVERY) {
    task._sinceSave = 0;
    saveTask(task);
  }
}

/**
 * 读取任务（新目录优先，兼容旧目录）。
 * @param {string} id 任务 id
 * @returns {object|null}
 */
function getTask(id) {
  const file = path.join(TASKS_DIR, `${id}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
  }
  // 双读兼容：旧 data/batch_results 下同名文件
  const legacy = path.join(LEGACY_DIR, `${id}.json`);
  if (fs.existsSync(legacy)) {
    try { return JSON.parse(fs.readFileSync(legacy, 'utf-8')); } catch { return null; }
  }
  return null;
}

/**
 * 列出全部任务（按更新时间倒序）。
 * @returns {Array<object>} 任务摘要
 */
function listTasks() {
  ensureDir();
  const out = [];
  for (const name of fs.readdirSync(TASKS_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, name), 'utf-8'));
      out.push(summary(t));
    } catch { /* 损坏文件跳过 */ }
  }
  out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return out;
}

/**
 * 任务摘要（不含 items 全量，避免列表接口过大）。
 * @param {object} t 任务
 * @returns {object}
 */
function summary(t) {
  return {
    id: t.id,
    mode: t.mode,
    sourceDir: t.sourceDir,
    outputDir: t.outputDir,
    status: t.status,
    phase: t.phase,
    total: t.total || 0,
    done: t.done || 0,
    failed: t.failed || 0,
    skipped: t.skipped || 0,
    startedAt: t.startedAt,
    updatedAt: t.updatedAt,
    finishedAt: t.finishedAt || null,
    error: t.error || null,
  };
}

/**
 * 删除任务。
 * @param {string} id 任务 id
 * @returns {boolean}
 */
function deleteTask(id) {
  const file = path.join(TASKS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * 清空全部任务。
 * @returns {number} 删除数量
 */
function clearAllTasks() {
  ensureDir();
  let n = 0;
  for (const name of fs.readdirSync(TASKS_DIR)) {
    if (!name.endsWith('.json')) continue;
    try { fs.unlinkSync(path.join(TASKS_DIR, name)); n++; } catch { /* 忽略 */ }
  }
  return n;
}

/**
 * 找出孤儿任务（进程被 kill 时停留在 running 的任务）。
 * 同一源目录只保留最新一个，避免重复续跑（沿用 batch-scan.js:653-709 的去重逻辑）。
 * @returns {Array<object>} 待恢复的任务
 */
function findOrphanTasks() {
  ensureDir();
  const running = [];
  for (const name of fs.readdirSync(TASKS_DIR)) {
    if (!name.endsWith('.json')) continue;
    let t = null;
    try { t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, name), 'utf-8')); } catch { continue; }
    if (t && (t.status === 'running' || t.status === 'scanning')) running.push(t);
  }
  // 按源目录去重：只保留每个目录最新启动的那个
  const byDir = new Map();
  for (const t of running) {
    const key = String(t.sourceDir || '');
    const prev = byDir.get(key);
    if (!prev || String(t.startedAt) > String(prev.startedAt)) byDir.set(key, t);
  }
  return [...byDir.values()];
}

/** 取任务目录 */
function tasksDir() {
  return TASKS_DIR;
}

module.exports = {
  TASKS_DIR,
  PERSIST_EVERY,
  fingerprint,
  createTask,
  saveTask,
  tickPersist,
  getTask,
  listTasks,
  summary,
  deleteTask,
  clearAllTasks,
  findOrphanTasks,
  tasksDir,
  ensureDir,
};
