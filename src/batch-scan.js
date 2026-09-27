/**
 * 批量图片扫描模块
 * 递归扫描指定文件夹（含子文件夹）内的图片，逐张调用本地 VL 模型审核。
 * 单卡 GPU 上 Ollama 推理为串行，因此这里用顺序 for 循环（无并发），避免请求堆积超时。
 * 只读保障（Read-Only Guarantee）：
 * 本模块对用户指定文件夹只执行 fs.readdirSync / fs.statSync / fs.readFileSync（只读三件套），
 * 绝不调用任何针对目标文件夹的写操作（write / rename / unlink / rm 等）。
 * 审核结果只写入系统自身的 data/batch_results/ 目录，用户图片零改动。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logInfo, logError } = require('./logger');
const { moderateImageLocal } = require('./moderator');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 单张 20MB 上限（超大图 base64 后易超 ctx）
const RESULTS_DIR = path.join(__dirname, '..', 'data', 'batch_results');

// 内存任务表（运行中的任务）；历史任务从 data/batch_results/ 读取
const activeTasks = new Map();

/** 递归收集文件夹内的图片文件（相对 root 的绝对路径列表）*/
function collectImages(root, recursive) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logError('batch-scan', `读取目录失败: ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = fs.statSync(full);
          if (stat.size <= MAX_FILE_SIZE) {
            found.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
          } else {
            logInfo('batch-scan', `跳过超大文件: ${full} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
          }
        } catch { /* 文件消失则跳过*/ }
      }
    }
  };
  walk(root);
  return found;
}

/**
 * 文件指纹：绝对路径 + 大小 + 修改时间 → sha256。
 * 文件被替换/修改后指纹变化，缓存自动失效，确保不会跳过"改过的新图"。
 */
function fileFingerprint(file, size, mtimeMs) {
  return crypto.createHash('sha256').update(`${file}|${size}|${mtimeMs}`).digest('hex');
}

// ─── 已审核结果缓存（防重复审核 / 断点续传核心） ───
// 指纹 → 历史审核结果。同一文件（路径+大小+修改时间不变）再次扫描时直接复用历史结论，
// 不再调用模型。大文件夹分多次扫描时，已完成的部分自动跳过。
let _historyCache = null;
let _historyCacheAt = 0;
const HISTORY_CACHE_TTL = 5 * 60 * 1000; // 缓存 5 分钟，避免每次扫描都全量读盘
const INCREMENTAL_PERSIST_EVERY = 10;    // 每审核 10 张增量落盘一次，服务崩溃最多丢 10 张进度

/** 构建历史结果缓存：遍历所有已结束任务（done/stopped/error），映射文件指纹 → 结果*/
function buildHistoryCache() {
  const cache = new Map();
  try {
    if (!fs.existsSync(RESULTS_DIR)) return cache;
    for (const f of fs.readdirSync(RESULTS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const taskId = f.replace('.json', '');
      if (activeTasks.has(taskId)) continue; // 运行中的任务结果不算历史
      try {
        const t = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8'));
        if (!t || !t.results || !t.folderPath) continue;
        // 只把"该文件夹自己的、已结束任务"纳入缓存，避免跨文件夹误跳
        for (const r of t.results || []) {
          if (r && r.file && !r.error) {
            cache.set(fileFingerprint(r.file, r.size || 0, r.mtimeMs || 0), r);
          }
        }
      } catch { /* 单个坏文件跳过*/ }
    }
  } catch (err) {
    logError('batch-scan', `构建历史缓存失败: ${err.message}`);
  }
  return cache;
}

/** 获取历史缓存（带 TTL）*/
function getHistoryCache() {
  if (!_historyCache || Date.now() - _historyCacheAt > HISTORY_CACHE_TTL) {
    _historyCache = buildHistoryCache();
    _historyCacheAt = Date.now();
  }
  return _historyCache;
}

/** 启动批量扫描任务（立即返回 taskId，后台异步执行）*/
function startBatchScan({ folderPath, recursive = true, strictness = 'standard' }) {
  const absPath = path.resolve(folderPath);
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new Error(`路径不存在或无法访问: ${absPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`不是文件夹: ${absPath}`);
  }

  const taskId = crypto.randomBytes(6).toString('hex');
  const task = {
    id: taskId,
    folderPath: absPath,
    recursive: !!recursive,
    strictness: ['relaxed', 'standard', 'strict'].includes(strictness) ? strictness : 'standard',
    status: 'scanning',      // scanning -> running -> done | stopped | error
    total: 0,
    done: 0,
    skipped: 0,
    cached: 0,               // 历史已审核、本次直接复用的数量（防重复审核）
    current: null,
    results: [],             // { file, size, mtimeMs, risk_level, passed, categories, reason, suggestion, latency_ms, model, error?, cached? }
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stopRequested: false,
  };
  activeTasks.set(taskId, task);

  // 异步执行，不阻塞
  runTask(task).catch((err) => {
    task.status = 'error';
    task.error = err.message;
    task.finishedAt = new Date().toISOString();
    logError('batch-scan', `任务 ${taskId} 异常终止: ${err.message}`);
    persistTask(task);
  });

  return taskSummary(task);
}

/** 顺序执行审核（本地 VL 单卡串行），复用历史缓存避免重复审核
 * @param {object} task 任务对象
 * @param {object} [opts]
 * @param {boolean} [opts.isResume] 崩溃续扫标记：续扫时把任务自身的历史结果注入缓存，
 * 使已审核图片直接命中缓存跳过，而不是重新调模型
 */
async function runTask(task, { isResume = false } = {}) {
  const images = collectImages(task.folderPath, task.recursive);
  task.total = images.length;
  task.status = 'running';
  const historyCache = getHistoryCache();

  // 续扫：把任务自身已落盘的结果预热进缓存，避免重复审核已完成部分
  // （buildHistoryCache 会跳过 activeTasks 中的任务，所以这里手动注入）
  if (isResume && Array.isArray(task.results) && task.results.length > 0) {
    let seeded = 0;
    for (const r of task.results) {
      if (r && r.file && !r.error) {
        historyCache.set(fileFingerprint(r.file, r.size || 0, r.mtimeMs || 0), r);
        seeded++;
      }
    }
    logInfo('batch-scan', `续扫任务 ${task.id}: 预热 ${seeded} 条历史结果进缓存`);
  }

  // 重置累计计数器与结果数组：防止续扫/重启时 done 叠加导致进度 > 100%
  // 下面会重新遍历所有图片（已审核的命中缓存直接跳过），结果逐条重建
  task.done = 0;
  task.cached = 0;
  task.skipped = 0;
  task.results = [];

  logInfo('batch-scan', `批量任务 ${task.id} ${isResume ? '续扫' : '开始'}: ${task.total} 张图片 (${task.folderPath}${task.recursive ? '，含子文件夹' : ''})`);

  if (task.total === 0) {
    task.status = 'done';
    task.finishedAt = new Date().toISOString();
    persistTask(task);
    return;
  }

  for (const { file, size, mtimeMs } of images) {
    if (task.stopRequested) {
      task.status = 'stopped';
      break;
    }
    task.current = file;
    const entry = { file, size, mtimeMs, risk_level: 'error', passed: true, categories: [], reason: '', suggestion: '', latency_ms: 0, model: null };

    // ─── 缓存跳过：该文件历史已审核且未变化 → 直接复用结论，不再调模型 ───
    const fp = fileFingerprint(file, size, mtimeMs);
    const cached = historyCache.get(fp);
    if (cached) {
      entry.risk_level = cached.risk_level || 'safe';
      entry.passed = cached.passed !== false;
      entry.categories = cached.categories || [];
      entry.reason = cached.reason || '';
      entry.suggestion = cached.suggestion || '';
      entry.latency_ms = cached.latency_ms || 0;
      entry.model = cached.model || null;
      entry.error = false;
      entry.cached = true;
      // 透传完整判定链路字段（续扫/缓存命中时保持画廊展示完整）
      entry.timestamp = cached.timestamp;
      entry.image_hash = cached.image_hash || null;
      entry.confidence = cached.confidence;
      entry.decision_source = cached.decision_source;
      entry.vl_level = cached.vl_level;
      entry.vl_reason = cached.vl_reason;
      entry.wd14_hits = cached.wd14_hits;
      entry.wd14_level = cached.wd14_level;
      entry.wd14_tags = cached.wd14_tags;
      entry.plugin_override = cached.plugin_override;
      task.results.push(entry);
      task.done++;
      task.cached++;
      // 实时更新缓存，本任务后续重复文件也能命中
      historyCache.set(fp, entry);
      continue;
    }

    try {
      const buf = fs.readFileSync(file);
      const base64 = buf.toString('base64');
      const result = await moderateImageLocal(base64, '', { userId: 'batch-scan', source: file }, { skipAudit: true, strictness: task.strictness });
      entry.risk_level = result.risk_level || 'safe';
      entry.passed = result.passed !== false;
      entry.categories = result.categories || [];
      entry.reason = result.reason || '';
      entry.suggestion = result.suggestion || '';
      entry.latency_ms = result.latency_ms || 0;
      entry.model = result.model || null;
      // v0.2.0：批量结果带上内容寻址 hash（与审核记录 result.image_ref.hash 同一关联键）
      entry.image_hash = (result.image_ref && result.image_ref.hash) || null;
      entry.error = !!result.error;
      // ─── 完整判定链路信息（画廊视图展示用） ───
      entry.timestamp = result.timestamp || new Date().toISOString();
      entry.confidence = result.confidence;
      entry.decision_source = result.decision_source || (result.wd14_hits ? 'WD14 标签器' : 'VL 模型');
      entry.vl_level = result.vl_level;
      entry.vl_reason = result.vl_reason;
      entry.wd14_hits = result.wd14_hits || [];
      entry.wd14_level = result.wd14_level;
      entry.wd14_tags = result.wd14_tags;
      entry.plugin_override = result.plugin_override || false;
      if (!entry.error) historyCache.set(fp, entry); // 成功结果进缓存，后续扫描直接复用
    } catch (err) {
      entry.reason = `处理失败: ${err.message}`;
      entry.error = true;
      task.skipped++;
    }
    task.results.push(entry);
    task.done++;

    // 增量落盘：服务崩溃最多丢最近 INCREMENTAL_PERSIST_EVERY 张进度
    if (task.done % INCREMENTAL_PERSIST_EVERY === 0) persistTask(task);
  }

  if (task.status !== 'stopped') task.status = 'done';
  task.current = null;
  task.finishedAt = new Date().toISOString();
  const st = riskStats(task);
  logInfo('batch-scan', `批量任务 ${task.id} 完成: ${task.done}/${task.total}（新审核 ${task.done - task.cached}，缓存跳过 ${task.cached}）, ${st.high + st.critical} 张中高风险`);
  persistTask(task);
}

/** 风险等级统计*/
function riskStats(task) {
  const stats = { safe: 0, low: 0, medium: 0, high: 0, critical: 0, error: 0 };
  for (const r of task.results) {
    const lvl = stats[r.risk_level] !== undefined ? r.risk_level : 'error';
    stats[lvl]++;
  }
  return stats;
}

/** 任务摘要（不含 results 大数组，用于进度轮询）*/
function taskSummary(task) {
  return {
    id: task.id,
    folderPath: task.folderPath,
    recursive: task.recursive,
    strictness: task.strictness || 'standard',
    readOnly: true, // 只读扫描：不移动/不修改/不删除用户文件，结果仅存系统 data 目录
    status: task.status,
    total: task.total,
    done: task.done,
    skipped: task.skipped,
    cached: task.cached || 0, // 历史已审核、本次直接复用的数量
    current: task.current,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    stats: riskStats(task),
    error: task.error || null,
  };
}

/** 任务详情（含 results）*/
function getTaskResults(taskId) {
  const task = activeTasks.get(taskId) || loadPersistedTask(taskId);
  if (!task) return null;
  return { ...taskSummary(task), results: task.results };
}

// 图片预览 MIME 映射（白名单：只允许扫描过的图片扩展名）
const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/**
 * 获取任务结果中第 index 条对应的原图文件信息（前端预览用）
 * 安全设计：只能访问"该任务结果里已记录"的文件路径，不开放任意路径读取
 * @returns {{filePath: string, contentType: string, info: object} | null}
 */
function getTaskImage(taskId, index) {
  const task = activeTasks.get(taskId) || loadPersistedTask(taskId);
  if (!task || !Array.isArray(task.results)) return null;
  const idx = parseInt(index, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= task.results.length) return null;
  const entry = task.results[idx];
  if (!entry || !entry.file) return null;
  const ext = path.extname(entry.file).toLowerCase();
  if (!IMAGE_MIME[ext]) return null; // 白名单外的扩展名拒绝
  try {
    fs.accessSync(entry.file, fs.constants.R_OK);
  } catch {
    return null; // 文件已被移动/删除
  }
  return { filePath: entry.file, contentType: IMAGE_MIME[ext], info: entry };
}

/**
 * 生成任务结果第 index 条图片的缩略图 Buffer（画廊视图用，避免加载 4K 原图）
 * 懒加载 sharp，未安装时返回 null（前端降级为不显示缩略图）
 * @returns {Promise<{buffer: Buffer, contentType: string} | null>}
 */
async function getTaskThumb(taskId, index, width = 360) {
  const img = getTaskImage(taskId, index);
  if (!img) return null;
  try {
    const sharp = require('sharp');
    const buffer = await sharp(img.filePath)
      .rotate() // 按 EXIF 方向自动旋转
      .resize({ width, height: width, fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: 70, progressive: true })
      .toBuffer();
    return { buffer, contentType: 'image/jpeg' };
  } catch (err) {
    logError('batch-scan', `缩略图生成失败: ${err.message}`);
    return null;
  }
}


/** 进度状态（含最近几条结果，便于前端实时刷新表格）*/
function getTaskStatus(taskId) {
  const task = activeTasks.get(taskId);
  if (task) {
    return { ...taskSummary(task), recent: task.results.slice(-5) };
  }
  const persisted = loadPersistedTask(taskId);
  if (persisted) return taskSummary(persisted);
  return null;
}

/** 请求停止任务*/
function stopTask(taskId) {
  const task = activeTasks.get(taskId);
  if (!task) return false;
  if (task.status === 'running' || task.status === 'scanning') {
    task.stopRequested = true;
    return true;
  }
  return false;
}

/** 任务列表（活跃 + 历史）*/
function listTasks() {
  const list = [];
  for (const task of activeTasks.values()) list.push(taskSummary(task));
  try {
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
    for (const f of fs.readdirSync(RESULTS_DIR)) {
      if (f.endsWith('.json') && !activeTasks.has(f.replace('.json', ''))) {
        const t = loadPersistedTask(f.replace('.json', ''));
        if (t) list.push(taskSummary(t));
      }
    }
  } catch (err) {
    logError('batch-scan', `读取历史任务失败: ${err.message}`);
  }
  return list.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

/** 删除单个扫描任务（内存 + 落盘结果）*/
function deleteTask(taskId) {
  if (!/^[a-f0-9]+$/i.test(taskId)) return false; // 防路径穿越
  let deleted = false;
  // 运行中的任务先请求停止，再删除（落盘结果一并清除）
  const active = activeTasks.get(taskId);
  if (active) {
    active.stopRequested = true;
    activeTasks.delete(taskId);
    deleted = true;
  }
  const file = path.join(RESULTS_DIR, `${taskId}.json`);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      deleted = true;
    }
  } catch (err) {
    logError('batch-scan', `删除任务 ${taskId} 失败: ${err.message}`);
  }
  if (deleted) logInfo('batch-scan', `扫描任务已删除: ${taskId}`);
  return deleted;
}

/** 清空全部扫描任务（内存 + 全部落盘结果）*/
function clearAllTasks() {
  let count = 0;
  // 停止并移除所有活跃任务
  for (const [id, task] of activeTasks) {
    task.stopRequested = true;
    activeTasks.delete(id);
    count++;
  }
  // 清空 data/batch_results/ 下所有 .json
  try {
    if (fs.existsSync(RESULTS_DIR)) {
      for (const f of fs.readdirSync(RESULTS_DIR)) {
        if (f.endsWith('.json')) {
          fs.unlinkSync(path.join(RESULTS_DIR, f));
          count++;
        }
      }
    }
  } catch (err) {
    logError('batch-scan', `清空扫描任务失败: ${err.message}`);
  }
  logInfo('batch-scan', `已清空扫描记录，共移除 ${count} 个任务`);
  return count;
}

/** 任务落盘*/
function persistTask(task) {
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2), 'utf-8');
  } catch (err) {
    logError('batch-scan', `保存任务结果失败: ${err.message}`);
  }
}

/** 读取历史任务*/
function loadPersistedTask(taskId) {
  if (!/^[a-f0-9]+$/i.test(taskId)) return null; // 防路径穿越
  const file = path.join(RESULTS_DIR, `${taskId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** 导出 CSV（带 BOM，Excel 中文兼容）*/
function exportCsv(taskId) {
  const task = activeTasks.get(taskId) || loadPersistedTask(taskId);
  if (!task) return null;
  const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const lines = [
    ['文件', '风险等级', '是否放行', '违规类别', '理由', '建议', '耗时ms', '模型', '来源'].map(esc).join(','),
  ];
  for (const r of task.results || []) {
    lines.push([
      r.file, r.risk_level, r.passed ? '放行' : '拦截',
      (r.categories || []).join('|'), r.reason, r.suggestion, r.latency_ms || 0, r.model || '',
      r.cached ? '历史已审核(缓存)' : (r.error ? '失败' : '本次新审核'),
    ].map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

// ─── 按审核结果分类导出 ───
const VALID_LEVELS = ['safe', 'low', 'medium', 'high', 'critical'];
// 分类导出任务的进度表（内存），前端可轮询
const exportJobs = new Map();

/** 生成不冲突的目标路径（重名时追加 _1/_2...）*/
async function uniqueDest(dir, filename) {
  let dest = path.join(dir, filename);
  try { await fs.promises.access(dest); } catch { return dest; }
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let i = 1;
  for (;;) {
    dest = path.join(dir, `${base}_${i}${ext}`);
    try { await fs.promises.access(dest); } catch { return dest; }
    i++;
  }
}

/**
 * 按风险等级把扫描结果中的图片导出（复制/移动）到不同子文件夹
 * 目标目录结构（keepFolders=false）：
 * targetDir/safe/ 安全
 * targetDir/low/ 低风险
 * targetDir/medium/ 中风险
 * targetDir/high/ 高风险
 * targetDir/critical/ 严重
 * 目标目录结构（keepFolders=true，保留原图库子文件夹层级）：
 * targetDir/safe/10002/xxx.jpg
 * targetDir/high/90017/yyy.jpg （相对路径 = 原文件相对扫描根目录的路径）
 * @param {string} taskId 扫描任务 ID
 * @param {string} targetDir 目标根目录（会自动创建子文件夹）
 * @param {object} [opts]
 * @param {string[]} [opts.levels] 要导出的等级，默认全部
 * @param {'copy'|'move'} [opts.mode] copy=复制（原文件不动），move=移动（原文件被移走）
 * @param {boolean} [opts.keepFolders] 保留原图库的子文件夹层级（相对扫描根目录的路径）
 * @returns {{jobId: string, total: number}} 导出任务句柄，可用 getExportStatus 查进度
 */
function startExportByCategory(taskId, targetDir, { levels, mode = 'copy', keepFolders = false } = {}) {
  const task = activeTasks.get(taskId) || loadPersistedTask(taskId);
  if (!task || !Array.isArray(task.results)) throw new Error('任务不存在或无结果');
  if (!['copy', 'move'].includes(mode)) throw new Error('mode 必须是 copy 或 move');
  const wantLevels = Array.isArray(levels) && levels.length > 0
    ? levels.filter((l) => VALID_LEVELS.includes(l))
    : VALID_LEVELS;
  if (wantLevels.length === 0) throw new Error('未选择有效的风险等级');

  const absTarget = path.resolve(targetDir);
  const scanRoot = path.resolve(task.folderPath || '');

  /** 计算目标子目录：等级文件夹 + （可选）原相对子文件夹路径*/
  const destDirFor = (file, riskLevel) => {
    let dir = path.join(absTarget, riskLevel);
    if (keepFolders && scanRoot) {
      // 防路径穿越：相对路径不允许跳出扫描根目录
      let rel;
      try {
        rel = path.relative(scanRoot, path.dirname(file));
      } catch { rel = '..'; }
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        dir = path.join(dir, rel);
      }
    }
    return dir;
  };

  // 收集待导出条目（按文件去重，重复条目取最后一条结果）
  const byFile = new Map();
  for (const r of task.results) {
    if (r && r.file && !r.error && wantLevels.includes(r.risk_level)) {
      byFile.set(r.file, r);
    }
  }
  const items = [...byFile.entries()];
  if (items.length === 0) throw new Error('所选等级下没有可导出的图片');

  const jobId = crypto.randomBytes(6).toString('hex');
  const job = {
    id: jobId, taskId, mode, targetDir: absTarget,
    levels: wantLevels, keepFolders: !!keepFolders, status: 'running',
    total: items.length, done: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null,
    current: null, error: null,
  };
  exportJobs.set(jobId, job);

  // 后台顺序执行（异步复制，避免同步 fs 阻塞事件循环导致进度接口无响应）
  (async () => {
    try {
      // 创建等级子目录
      for (const lvl of wantLevels) {
        await fs.promises.mkdir(path.join(absTarget, lvl), { recursive: true });
      }
      logInfo('batch-scan', `分类导出开始 ${jobId}: ${items.length} 张 → ${absTarget}（${mode === 'move' ? '移动' : '复制'}，等级: ${wantLevels.join('/')}${keepFolders ? '，保留子文件夹' : ''}）`);

      for (const [file, r] of items) {
        job.current = file;
        try {
          await fs.promises.access(file, fs.constants.R_OK);
          const destDir = destDirFor(file, r.risk_level);
          await fs.promises.mkdir(destDir, { recursive: true }); // 保留子文件夹时按需创建深层目录
          const dest = await uniqueDest(destDir, path.basename(file));
          await fs.promises.copyFile(file, dest);
          if (mode === 'move') {
            try { await fs.promises.unlink(file); } catch (e) { job.failed++; logError('batch-scan', `移动时删除源文件失败: ${file}: ${e.message}`); }
          }
        } catch (e) {
          job.failed++;
          logError('batch-scan', `导出失败 ${file}: ${e.message}`);
        }
        job.done++;
        // 每复制 20 张让出一次事件循环，保证进度查询/健康检查接口能及时响应
        if (job.done % 20 === 0) await new Promise((r) => setImmediate(r));
      }

      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.current = null;
      logInfo('batch-scan', `分类导出完成 ${jobId}: 成功 ${job.done - job.failed}，失败 ${job.failed}`);
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      logError('batch-scan', `分类导出异常 ${jobId}: ${err.message}`);
    }
  })();

  return { jobId, total: items.length };
}

/** 查询分类导出进度*/
function getExportStatus(jobId) {
  return exportJobs.get(jobId) || null;
}

/** 定期清理：任务结束 30 分钟后从内存表移除（结果已落盘）*/
setInterval(() => {
  const now = Date.now();
  for (const [id, task] of activeTasks) {
    if (['done', 'stopped', 'error'].includes(task.status) && task.finishedAt
      && now - new Date(task.finishedAt).getTime() > 30 * 60 * 1000) {
      activeTasks.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

/**
 * 恢复崩溃遗留的孤儿任务（服务重启时调用）
 * 场景：守护模式下服务崩溃，看门狗重启。崩溃时正在运行的批量扫描任务
 * 会以 running/scanning 状态残留在 data/batch_results/ 里。重启后这些任务
 * 不再在内存 activeTasks 中，但历史缓存机制（指纹→结果）会自动跳过已审核的图片，
 * 所以重新执行 runTask 即可无缝续扫，不会重复审核已完成部分。
 * 去重：同一目录可能残留多个孤儿任务（用户曾多次启动扫描），只恢复进度最靠前
 * （已审核最多）的那个，其余标记为 stopped，避免多个任务同时抢 GPU。
 * @returns {number} 恢复的任务数量
 */
function resumeOrphanedTasks() {
  let resumed = 0;
  try {
    if (!fs.existsSync(RESULTS_DIR)) return 0;

    // 收集所有孤儿任务
    const orphans = [];
    for (const f of fs.readdirSync(RESULTS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const taskId = f.replace('.json', '');
      if (activeTasks.has(taskId)) continue;
      const t = loadPersistedTask(taskId);
      if (!t || (t.status !== 'running' && t.status !== 'scanning')) continue;
      orphans.push({ taskId, t });
    }

    // 按目录去重：同一 folderPath 只保留已审核最多的那个
    const bestByFolder = new Map();
    for (const { taskId, t } of orphans) {
      const key = t.folderPath || '';
      const existing = bestByFolder.get(key);
      if (!existing || (t.results?.length || 0) > (existing.t.results?.length || 0)) {
        bestByFolder.set(key, { taskId, t });
      }
    }

    // 把重复的孤儿任务标记为 stopped 并落盘
    const resumedIds = new Set([...bestByFolder.values()].map((x) => x.taskId));
    for (const { taskId, t } of orphans) {
      if (resumedIds.has(taskId)) continue;
      t.status = 'stopped';
      t.stopRequested = false;
      t.finishedAt = new Date().toISOString();
      persistTask(t);
      logInfo('batch-scan', `跳过重复孤儿任务 ${taskId}（目录已有更完整的任务）: ${t.folderPath}`);
    }

    // 恢复去重后的任务
    for (const { taskId, t } of bestByFolder.values()) {
      t.stopRequested = false;
      t.current = null;
      activeTasks.set(taskId, t);
      logInfo('batch-scan', `恢复未完成扫描任务 ${taskId}: ${t.folderPath}（已审核 ${t.results?.length || 0}/${t.total || '?'}，续扫剩余）`);
      runTask(t, { isResume: true }).catch((err) => {
        t.status = 'error';
        t.error = err.message;
        t.finishedAt = new Date().toISOString();
        logError('batch-scan', `恢复任务 ${taskId} 异常终止: ${err.message}`);
        persistTask(t);
      });
      resumed++;
    }
  } catch (err) {
    logError('batch-scan', `恢复孤儿任务失败: ${err.message}`);
  }
  return resumed;
}

module.exports = { startBatchScan, getTaskStatus, getTaskResults, getTaskImage, getTaskThumb, stopTask, listTasks, exportCsv, deleteTask, clearAllTasks, resumeOrphanedTasks, startExportByCategory, getExportStatus };
