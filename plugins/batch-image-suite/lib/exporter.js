/**
 * ExportProfile 执行引擎（plugins/batch-image-suite/lib/exporter.js）
 *
 * 一个导出 = 「结果集（Item 列表）→ 目标文件系统的一个映射」，六个正交维度：
 *   ① 导什么（outputs）× ② 放哪（structure）× ③ 怎么放（action）
 *   × ④ 哪些要（filters）× ⑤ 叫什么（naming）× ⑥ 带什么（sidecar）
 *
 * ★ 安全红线：
 *   - action=move 仅允许「系统自建的待筛目录 → 输出目录/恢复目标」，源素材目录绝对禁止 move/删除；
 *     后端在做任何写操作前二次校验，越权直接抛错（返回 403）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sidecarOf } = require('./reporter');

const DATA_ROOT = path.join(__dirname, '..', '..', '..', 'data');
const PROFILES_FILE = path.join(DATA_ROOT, 'export-profiles.json');
const JOBS_DIR = path.join(DATA_ROOT, 'export_jobs');

/** 6 个内置预设（PRD §7.4） */
const BUILTIN_PROFILES = [
  {
    id: 'photo-organize-default', name: '照片整理 · 默认', builtin: true, scope: 'currentTask',
    outputs: { files: true, manifest: 'csv', report: true, sidecar: true, thumbs: false },
    structure: { mode: 'byYearMonthCategory', template: '{year}/{month}/{category}/{name}', unknownTimeDir: '时间未知', pendingDir: '_待后续筛选_无用候选' },
    action: 'copy',
    filters: {},
    naming: { template: '{date}_{time}_{desc}', unknownTimeTemplate: '时间未知_{desc}', descMaxLen: 16, descFallback: '未命名', collision: 'suffix', lowercaseExt: true },
    sidecar: { format: 'json', fields: ['shotAt', 'timeSource', 'scene', 'kind', 'description', 'similarGroupId', 'isGroupKeep', 'pending', 'pendingReason', 'sourcePath', 'sourceName', 'tags', 'nsfw'] },
    report: { includeSourceMap: true, includeDuplicateList: true, includePendingList: true },
    execution: { dryRunFirst: false, onError: 'continue', concurrency: 1, yieldEvery: 20, resumable: true },
  },
  {
    id: 'nsfw-by-level', name: 'NSFW 分级导出', builtin: true, scope: 'currentTask',
    outputs: { files: true, manifest: 'csv', report: true, sidecar: true, thumbs: false },
    structure: { mode: 'byLevel', template: '{level}/{name}', unknownTimeDir: '时间未知', pendingDir: '_待后续筛选_无用候选' },
    action: 'copy',
    filters: { levels: ['safe', 'low', 'medium', 'high', 'critical'] },
    naming: { template: '{date}_{time}_{desc}', unknownTimeTemplate: '时间未知_{desc}', descMaxLen: 16, descFallback: '未命名', collision: 'suffix', lowercaseExt: true },
    sidecar: { format: 'json', fields: ['shotAt', 'scene', 'kind', 'nsfw'] },
    report: { includeSourceMap: true, includeDuplicateList: false, includePendingList: false },
    execution: { dryRunFirst: false, onError: 'continue', concurrency: 1, yieldEvery: 20, resumable: true },
  },
  {
    id: 'manifest-only', name: '仅清单（不复制图片）', builtin: true, scope: 'currentTask',
    outputs: { files: false, manifest: 'both', report: true, sidecar: false, thumbs: false },
    structure: { mode: 'flat', template: '{name}', unknownTimeDir: '时间未知', pendingDir: '_待后续筛选_无用候选' },
    action: 'none',
    filters: {},
    naming: { template: '{date}_{time}_{desc}', unknownTimeTemplate: '时间未知_{desc}', descMaxLen: 16, descFallback: '未命名', collision: 'suffix', lowercaseExt: true },
    sidecar: { format: 'json', fields: [] },
    report: { includeSourceMap: true, includeDuplicateList: true, includePendingList: true },
    execution: { dryRunFirst: false, onError: 'continue', concurrency: 1, yieldEvery: 20, resumable: true },
  },
  {
    id: 'pending-only', name: '待筛候选导出', builtin: true, scope: 'pendingOnly',
    outputs: { files: true, manifest: 'csv', report: true, sidecar: true, thumbs: false },
    structure: { mode: 'template', template: '_待后续筛选_无用候选/{pendingReason}/{name}', unknownTimeDir: '时间未知', pendingDir: '_待后续筛选_无用候选' },
    action: 'copy',
    filters: { pendingOnly: true },
    naming: { template: '{date}_{time}_{desc}', unknownTimeTemplate: '时间未知_{desc}', descMaxLen: 16, descFallback: '未命名', collision: 'suffix', lowercaseExt: true },
    sidecar: { format: 'json', fields: ['pending', 'pendingReason', 'sourcePath', 'sourceName'] },
    report: { includeSourceMap: true, includeDuplicateList: false, includePendingList: true },
    execution: { dryRunFirst: false, onError: 'continue', concurrency: 1, yieldEvery: 20, resumable: true },
  },
  {
    id: 'keep-tree', name: '保留原目录结构', builtin: true, scope: 'currentTask',
    outputs: { files: true, manifest: 'csv', report: true, sidecar: false, thumbs: false },
    structure: { mode: 'keepTree', template: '{level}/{srcRelDir}/{name}', unknownTimeDir: '时间未知', pendingDir: '_待后续筛选_无用候选' },
    action: 'copy',
    filters: {},
    naming: { template: '{name}', unknownTimeTemplate: '{name}', descMaxLen: 16, descFallback: '未命名', collision: 'suffix', lowercaseExt: true },
    sidecar: { format: 'json', fields: [] },
    report: { includeSourceMap: true, includeDuplicateList: false, includePendingList: false },
    execution: { dryRunFirst: false, onError: 'continue', concurrency: 1, yieldEvery: 20, resumable: true },
  },
  {
    id: 'hardlink-zero', name: '硬链接零占用', builtin: true, scope: 'currentTask',
    outputs: { files: true, manifest: 'csv', report: true, sidecar: false, thumbs: false },
    structure: { mode: 'byYearMonthCategory', template: '{year}/{month}/{category}/{name}', unknownTimeDir: '时间未知', pendingDir: '_待后续筛选_无用候选' },
    action: 'hardlink',
    filters: {},
    naming: { template: '{date}_{time}_{desc}', unknownTimeTemplate: '时间未知_{desc}', descMaxLen: 16, descFallback: '未命名', collision: 'suffix', lowercaseExt: true },
    sidecar: { format: 'json', fields: [] },
    report: { includeSourceMap: true, includeDuplicateList: true, includePendingList: true },
    execution: { dryRunFirst: false, onError: 'continue', concurrency: 1, yieldEvery: 20, resumable: true },
  },
];

/** structure.mode → 等价 template */
const MODE_TEMPLATES = {
  flat: '{name}',
  byLevel: '{level}/{name}',
  byCategory: '{category}/{name}',
  byYearMonth: '{year}/{month}/{name}',
  byYearMonthCategory: '{year}/{month}/{category}/{name}',
  keepTree: '{level}/{srcRelDir}/{name}',
  template: null,
};

// ─── 预设管理 ───

/** 读取用户保存的预设 */
function loadUserProfiles() {
  try {
    if (!fs.existsSync(PROFILES_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 保存用户预设（内置预设不可删除） */
function saveUserProfiles(list) {
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    const tmp = `${PROFILES_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8');
    fs.renameSync(tmp, PROFILES_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出全部预设（内置 + 用户）。
 * @returns {Array<object>}
 */
function listProfiles() {
  return [...BUILTIN_PROFILES, ...loadUserProfiles()];
}

/**
 * 取单个预设。
 * @param {string} id 预设 id
 * @returns {object|null}
 */
function getProfile(id) {
  return listProfiles().find((p) => p.id === id) || null;
}

/**
 * 保存（新增或覆盖）一个用户预设。
 * @param {object} profile 预设
 * @returns {{ok: boolean, error?: string}}
 */
function upsertProfile(profile) {
  if (!profile || !profile.id) return { ok: false, error: '预设缺少 id' };
  if (BUILTIN_PROFILES.some((p) => p.id === profile.id)) {
    return { ok: false, error: '内置预设不可覆盖，请另存为新预设' };
  }
  const list = loadUserProfiles().filter((p) => p.id !== profile.id);
  list.push({ ...profile, builtin: false });
  saveUserProfiles(list);
  return { ok: true };
}

/**
 * 删除用户预设。
 * @param {string} id 预设 id
 * @returns {{ok: boolean, error?: string}}
 */
function deleteProfile(id) {
  if (BUILTIN_PROFILES.some((p) => p.id === id)) return { ok: false, error: '内置预设不可删除' };
  const list = loadUserProfiles().filter((p) => p.id !== id);
  saveUserProfiles(list);
  return { ok: true };
}

// ─── 过滤与路径计算 ───

/**
 * 按 filters 过滤条目。
 * @param {Array<object>} items 条目
 * @param {object} filters 过滤条件
 * @returns {Array<object>}
 */
function applyFilters(items, filters = {}) {
  return items.filter((it) => {
    if (it.status !== 'done') return false;
    if (filters.pendingOnly && !it.pending) return false;
    if (filters.excludePending && it.pending) return false;
    if (Array.isArray(filters.levels) && filters.levels.length) {
      const lvl = (it.nsfw && it.nsfw.level) || 'safe';
      if (!filters.levels.includes(lvl)) return false;
    }
    if (Array.isArray(filters.categories) && filters.categories.length) {
      if (!filters.categories.includes(it.category)) return false;
    }
    if (filters.timeFrom || filters.timeTo) {
      const t = it.shotAt || '';
      if (filters.timeFrom && t && t < filters.timeFrom) return false;
      if (filters.timeTo && t && t > filters.timeTo) return false;
    }
    if (filters.minScore !== null && filters.minScore !== undefined) {
      if (((it.nsfw && it.nsfw.score) || 0) < filters.minScore) return false;
    }
    if (filters.maxScore !== null && filters.maxScore !== undefined) {
      if (((it.nsfw && it.nsfw.score) || 0) > filters.maxScore) return false;
    }
    return true;
  });
}

/**
 * 渲染路径/命名模板。
 * @param {string} template 模板
 * @param {object} item 条目
 * @returns {string}
 */
function renderTemplate(template, item) {
  const parts = (item.shotAt || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  const year = parts ? parts[1] : '';
  const month = parts ? parts[2] : '';
  const day = parts ? parts[3] : '';
  const date = parts ? `${parts[1]}-${parts[2]}-${parts[3]}` : '';
  const time = parts ? `${parts[4]}${parts[5]}` : '';
  const desc = (item.description || '').replace(/[\\/:*?"<>|]/g, '').slice(0, 16) || '未命名';
  const ext = item.ext || path.extname(item.srcName || '') || '.jpg';
  return String(template || '')
    .replace(/\{year\}/g, year)
    .replace(/\{month\}/g, month)
    .replace(/\{day\}/g, day)
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{desc\}/g, desc)
    .replace(/\{category\}/g, item.category || '未分类')
    .replace(/\{kind\}/g, item.kind || '')
    .replace(/\{level\}/g, (item.nsfw && item.nsfw.level) || 'safe')
    .replace(/\{group\}/g, item.similarGroupId || '')
    .replace(/\{srcName\}/g, path.basename(item.srcName || '', path.extname(item.srcName || '')))
    .replace(/\{srcDir\}/g, path.basename(path.dirname(item.srcPath || '')))
    .replace(/\{srcRelDir\}/g, item.srcRelDir || '')
    .replace(/\{name\}/g, (item.outName || item.srcName || 'unnamed') + ext);
}

/**
 * 计算某条目在导出中的目标相对路径。
 * @param {object} profile 预设
 * @param {object} item 条目
 * @returns {string}
 */
function destRelativePath(profile, item) {
  const st = profile.structure || {};
  const template = st.mode === 'template' || !MODE_TEMPLATES[st.mode] ? (st.template || '{name}') : MODE_TEMPLATES[st.mode];
  let rel = renderTemplate(template, item);
  // 时间未知 / 待筛 的分目录
  if (item.pending && st.pendingDir) rel = `${st.pendingDir}/${item.pendingReason || '其他'}/${path.basename(rel)}`;
  else if (!item.shotAt && st.unknownTimeDir) rel = `${st.unknownTimeDir}/${path.basename(rel)}`;
  return rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\//, '');
}

// ─── 安全校验 ───

/**
 * ★ 后端二次校验 move 动作的白名单（源素材目录绝对禁止 move/删除）。
 * @param {string} src 源绝对路径
 * @param {string} dest 目标绝对路径
 * @param {object} profile 预设
 * @returns {{ok: boolean, error?: string}}
 */
function checkMoveAllowed(src, dest, profile) {
  const wl = profile.actionWhitelist || {};
  const srcAbs = path.resolve(src);
  // 源素材目录绝对禁止
  const blocked = Array.isArray(wl.blockMoveFrom) ? wl.blockMoveFrom : [];
  const taskSourceDir = profile._sourceDir ? path.resolve(profile._sourceDir) : null;
  if (taskSourceDir && srcAbs.startsWith(taskSourceDir + path.sep)) {
    return { ok: false, error: '源素材目录禁止移动/删除（安全红线）' };
  }
  for (const b of blocked) {
    if (b && b.endsWith('/*')) {
      const dir = b.slice(0, -2);
      if (srcAbs.startsWith(path.resolve(dir) + path.sep)) return { ok: false, error: `来源目录在禁止移动列表中: ${b}` };
    }
  }
  const allowedFrom = Array.isArray(wl.allowMoveFrom) ? wl.allowMoveFrom : [];
  if (allowedFrom.length) {
    const ok = allowedFrom.some((a) => {
      const p = a.endsWith('/*') ? a.slice(0, -2) : a;
      return srcAbs.startsWith(path.resolve(p) + path.sep) || srcAbs === path.resolve(p);
    });
    if (!ok) return { ok: false, error: '来源目录不在 move 白名单内' };
  }
  void dest;
  return { ok: true };
}

// ─── 计划与执行 ───

/**
 * 生成导出计划（dry-run，不写盘）。
 * @param {object} profile 预设
 * @param {Array<object>} items 条目
 * @param {string} targetDir 目标根目录
 * @param {number} [limit=200] 返回条数上限
 * @returns {{rows: Array<object>, stats: object, truncated: boolean}}
 */
function plan(profile, items, targetDir, limit = 200) {
  const picked = applyFilters(items, profile.filters);
  const rows = [];
  for (const it of picked) {
    const rel = destRelativePath(profile, it);
    rows.push({
      src: it.outPath || it.srcPath,
      srcName: it.srcName,
      destRel: rel,
      dest: path.join(targetDir, rel),
      action: profile.action || 'copy',
    });
  }
  const stats = {
    total: picked.length,
    byAction: rows.reduce((a, r) => { a[r.action] = (a[r.action] || 0) + 1; return a; }, {}),
    bytes: picked.reduce((s, it) => s + (it.size || 0), 0),
  };
  return { rows: rows.slice(0, limit), stats, truncated: rows.length > limit };
}

/** 确保导出任务目录存在 */
function ensureJobsDir() {
  if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
}

/** 任务文件指纹（幂等用） */
function jobFingerprint(src, dest, mtimeMs) {
  return crypto.createHash('sha256').update(`${src}|${dest}|${mtimeMs || 0}`).digest('hex').slice(0, 32);
}

/**
 * 执行导出任务（异步 + 进度 + 幂等续跑）。
 * @param {object} job 任务对象 { id, profileId, targetDir, taskId }
 * @param {object} ctx 上下文（提供 items 与停止信号）
 * @returns {Promise<object>} 完成后的 job
 */
async function run(job, ctx) {
  ensureJobsDir();
  const profile = getProfile(job.profileId) || job.profile;
  const items = ctx.items || [];
  const picked = applyFilters(items, profile.filters);
  job.status = 'running';
  job.total = picked.length;
  job.done = 0;
  job.failed = 0;
  job.skipped = 0;
  job.bytes = 0;
  job.doneSet = new Set(job.doneSet || []);
  job.startedAt = job.startedAt || new Date().toISOString();
  const yieldEvery = (profile.execution && profile.execution.yieldEvery) || 20;
  const onError = (profile.execution && profile.execution.onError) || 'continue';

  const persist = () => {
    const file = path.join(JOBS_DIR, `${job.id}.json`);
    const snapshot = { ...job, doneSet: [...job.doneSet] };
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
      fs.renameSync(tmp, file);
    } catch { /* 忽略 */ }
  };

  for (let i = 0; i < picked.length; i++) {
    if (ctx.shouldStop && ctx.shouldStop()) { job.status = 'stopped'; break; }
    const it = picked[i];
    const rel = destRelativePath(profile, it);
    const dest = path.join(job.targetDir, rel);
    const src = it.outPath || it.srcPath;
    const fp = jobFingerprint(src, dest, it.mtimeMs);
    job.current = it.srcName;

    if (job.doneSet.has(fp)) { job.skipped++; job.done++; continue; }

    try {
      if (profile.action !== 'none' && (profile.outputs || {}).files !== false) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const st = fs.statSync(src);
        const finalDest = uniqueDest(dest);
        if (profile.action === 'move') {
          const check = checkMoveAllowed(src, finalDest, profile);
          if (!check.ok) throw new Error(check.error);
          fs.renameSync(src, finalDest);
        } else if (profile.action === 'hardlink') {
          try { fs.linkSync(src, finalDest); } catch { fs.copyFileSync(src, finalDest); }
        } else if (profile.action === 'symlink') {
          fs.symlinkSync(src, finalDest);
        } else {
          fs.copyFileSync(src, finalDest); // ★ 默认 copy：绝不改动源
        }
        job.bytes += st.size;
        // sidecar
        if ((profile.outputs || {}).sidecar) {
          try { fs.writeFileSync(`${finalDest}.json`, JSON.stringify(sidecarOf(it), null, 2), 'utf-8'); } catch { /* 忽略 */ }
        }
        it.exportedPath = finalDest;
      }
      job.doneSet.add(fp);
      job.done++;
    } catch (err) {
      job.failed++;
      job.lastError = err.message;
      if (onError === 'abort') { job.status = 'error'; job.error = err.message; persist(); return job; }
    }
    if ((i + 1) % yieldEvery === 0) {
      persist();
      await new Promise((r) => setImmediate(r)); // 让出事件循环，保证进度接口响应
    }
  }
  job.status = job.status === 'running' ? 'done' : job.status;
  job.finishedAt = new Date().toISOString();
  persist();
  return job;
}

/** 目标已存在时按 collision 策略处理（默认加后缀） */
function uniqueDest(dest) {
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const c = `${base}_${i}${ext}`;
    if (!fs.existsSync(c)) return c;
  }
  return dest;
}

/**
 * 列出导出任务。
 * @param {string} [jobId] 任务 id
 * @returns {object|Array<object>|null}
 */
function getJob(jobId) {
  ensureJobsDir();
  if (jobId) {
    const f = path.join(JOBS_DIR, `${jobId}.json`);
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
  }
  const out = [];
  for (const n of fs.readdirSync(JOBS_DIR)) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(JOBS_DIR, n), 'utf-8'))); } catch { /* 忽略 */ }
  }
  return out;
}

module.exports = {
  BUILTIN_PROFILES,
  MODE_TEMPLATES,
  listProfiles,
  getProfile,
  upsertProfile,
  deleteProfile,
  applyFilters,
  renderTemplate,
  destRelativePath,
  checkMoveAllowed,
  plan,
  run,
  getJob,
  jobFingerprint,
  JOBS_DIR,
};
