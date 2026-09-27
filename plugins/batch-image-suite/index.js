/**
 * 批量图片处理套件（plugins/batch-image-suite/index.js）
 *
 * 同一插件两种模式（PRD G3）：
 *   organize —— 100GB 本地磁盘图片整理（★ 源目录字节级不变，全部复制输出）
 *   nsfw     —— 动漫图 NSFW 审查（WD14 标签器 + 视觉模型联动）
 *
 * 纯 Schema 驱动：本插件只返回 JSON，不产出任何 JS/CSS；界面由前端统一渲染器渲染。
 * 所有应用逻辑放在服务端 RPC，前端通过 Binding 把结果接回 UI 状态。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fsService = require('./lib/fs-service');
const taskStore = require('./lib/task-store');
const pipeline = require('./lib/pipeline');
const reporter = require('./lib/reporter');
const organizer = require('./lib/organizer');
const promptService = require('./lib/prompt-service');
const exporter = require('./lib/exporter');
const nsfwLib = require('./lib/nsfw');

/** 插件 id */
const PLUGIN_ID = 'batch-image-suite';

/** 运行中的任务（内存索引，落盘由 task-store 负责） */
const activeTasks = new Map();
/** 停止信号：taskId → true */
const stopFlags = new Map();
/** 任务日志缓冲：taskId → string[] */
const logBuffers = new Map();
/** 导出任务：jobId → job */
const exportJobs = new Map();

// ─── 配置 Schema ───

const CONFIG_SCHEMA = {
  name: PLUGIN_ID,
  title: '批量图片处理套件',
  description: '本地磁盘图片整理 / 动漫图 NSFW 审查，同一插件两种模式。全程不修改原始素材。',
  groups: [
    { id: 'mode', title: '运行模式', desc: '选择本套件的处理模式：整理本地图片，或审查动漫图 NSFW 风险。' },
    { id: 'source', title: '来源与读取', desc: '指定只读源目录、输出目录，以及读取范围、格式与去重阈值。' },
    { id: 'pipeline', title: '流水线阶段', desc: '勾选需要启用的处理阶段；未勾选的阶段将被跳过。' },
    { id: 'naming', title: '命名与元数据', desc: '控制输出文件的命名模板、重名处理与 sidecar 元数据生成。' },
    { id: 'ai', title: 'AI 视觉模型', desc: '决定哪些图片进入第二遍视觉模型，以及使用的 Prompt 分类与种类键值。' },
    { id: 'nsfw', title: 'NSFW 审查通道', desc: '仅在 NSFW 模式下生效：启用 WD14 标签器通道并设置关注等级阈值。' },
  ],
  fields: [
    {
      key: 'mode', type: 'radio-group', label: '运行模式', default: 'organize', group: 'mode',
      desc: '本地图片整理 = 按拍摄时间归档并预筛废片；动漫图 NSFW 审查 = WD14 标签器 + 视觉模型双通道判定风险等级。',
      options: [
        { value: 'organize', label: '本地图片整理', desc: '按拍摄时间整理成年/月/分类目录，废图进待筛区' },
        { value: 'nsfw', label: '动漫图 NSFW 审查', desc: 'WD14 标签器 + 视觉模型双通道判定风险等级' },
      ],
    },
    // 来源与读取
    { key: 'sourceDir', type: 'folder-picker', label: '源文件夹（只读）', default: '', placeholder: 'E:\\pictures\\待整理', group: 'source',
      desc: '要整理的源文件夹，全程只读，不会改动其中任何文件。' },
    { key: 'outputDir', type: 'folder-picker', label: '输出目录', default: '', placeholder: 'E:\\pictures\\已整理', group: 'source',
      desc: '整理结果的输出目录，所有文件复制到这里（源盘字节级不变）。', visibleWhen: { 'config.mode': ['organize'] } },
    { key: 'recursive', type: 'switch', label: '递归读取所有子文件夹', default: true, group: 'source',
      desc: '开启后递归扫描所有子文件夹；关闭则只处理源目录第一层。' },
    {
      key: 'formats', type: 'checkbox-group', label: '图片格式', selectAll: true, group: 'source',
      desc: '只处理勾选的图片格式，其余文件一律忽略。',
      default: ['jpg', 'jpeg', 'png', 'webp'],
      options: [
        { value: 'jpg', label: 'JPG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' },
        { value: 'webp', label: 'WebP' }, { value: 'gif', label: 'GIF' }, { value: 'bmp', label: 'BMP' },
        { value: 'tiff', label: 'TIFF' }, { value: 'avif', label: 'AVIF' },
      ],
    },
    { key: 'maxFileSizeMb', type: 'number', label: '单张大小上限(MB)', min: 1, max: 200, default: 20, group: 'source',
      desc: '超过该大小的图片将被跳过，避免超大文件拖慢流水线。' },
    { key: 'dedupeThreshold', type: 'slider', label: '相似度阈值（汉明距离）', min: 0, max: 20, step: 1, default: 6, group: 'source',
      desc: '感知哈希去重的汉明距离阈值：越小越严格（更容易判为重复），越大越宽松。' },

    // 流水线阶段
    {
      key: 'stages', type: 'checkbox-group', label: '启用的流水线阶段', selectAll: true, group: 'pipeline',
      desc: '勾选需要执行的阶段；例如只想做去重时可关闭分类与实体化输出。',
      default: ['scan', 'decode', 'exif', 'phash', 'classify', 'dedupe', 'triage', 'materialize', 'report'],
      options: [
        { value: 'scan', label: '扫描' }, { value: 'decode', label: '解码' }, { value: 'exif', label: 'EXIF' },
        { value: 'phash', label: '感知哈希' }, { value: 'classify', label: 'AI 分类' }, { value: 'dedupe', label: '去重' },
        { value: 'triage', label: '废片预筛' }, { value: 'materialize', label: '实体化输出' }, { value: 'report', label: '生成报告' },
      ],
    },

    // 命名与元数据
    { key: 'namingTemplate', type: 'path-template', label: '命名模板', default: '{date}_{time}_{desc}', group: 'naming',
      desc: '输出文件名的构成模板，支持 {date}/{time}/{desc} 等占位符。', visibleWhen: { 'config.mode': ['organize'] } },
    { key: 'descMaxLen', type: 'number', label: '描述最大字数', min: 4, max: 40, default: 16, group: 'naming',
      desc: '视觉模型生成的描述在文件名中保留的最大字数，超出部分截断。', visibleWhen: { 'config.mode': ['organize'] } },
    {
      key: 'collision', type: 'select', label: '重名处理', default: 'suffix', group: 'naming',
      desc: '目标位置已存在同名文件时的处理方式。',
      options: [
        { value: 'suffix', label: '加序号 _1/_2' }, { value: 'skip', label: '跳过' }, { value: 'overwrite', label: '覆盖' },
      ],
    },
    { key: 'sidecar', type: 'switch', label: '生成同名 .json 元数据', default: true, group: 'naming',
      desc: '为每张输出图生成同名 .json，记录 EXIF、分类、描述等元数据，供后续检索。' },

    // AI 视觉模型
    {
      key: 'aiScope', type: 'checkbox-group', label: '进第二遍（视觉模型）的规则', selectAll: true, group: 'ai',
      desc: '命中任一勾选规则的图片会进入第二遍视觉模型（耗时更高但更准确）。',
      default: ['timeUnknown', 'fsExifGap', 'lowConfidencePending', 'nsfwMedium'],
      options: [
        { value: 'timeUnknown', label: '时间未知' },
        { value: 'fsExifGap', label: 'EXIF 与文件时间差 >5 年' },
        { value: 'needDescription', label: '用户标记需描述' },
        { value: 'lowConfidencePending', label: '待筛置信度低' },
        { value: 'nsfwMedium', label: 'NSFW ≥ medium' },
      ],
    },
    { key: 'categoryId', type: 'select', label: 'Prompt 分类', default: 'general', group: 'ai',
      desc: '选择用于视觉模型的 Prompt 分类，影响描述与分类的措辞。',
      options: [{ value: 'general', label: '普通图片' }, { value: 'anime', label: '动漫图片' }, { value: 'photo', label: '摄影图片' }] },
    { key: 'kindKey', type: 'text', label: 'Prompt 种类键值（auto=自动识别）', default: 'auto', group: 'ai',
      desc: 'Prompt 种类键值；填写 auto 时按图片内容自动识别。' },

    // NSFW 审查通道
    { key: 'useWd14', type: 'switch', label: '启用 WD14 标签器通道', default: true, group: 'nsfw',
      desc: 'NSFW 模式下启用 WD14 标签器作为辅助判据，与视觉模型联动。', visibleWhen: { 'config.mode': ['nsfw'] } },
    { key: 'nsfwThreshold', type: 'slider', label: '关注等级阈值', min: 0, max: 4, step: 1, default: 2, group: 'nsfw',
      desc: '达到该风险等级即重点关注；等级越高越严格，2 = medium。', visibleWhen: { 'config.mode': ['nsfw'] } },
  ],
};

// ─── 任务日志 ───

/**
 * 追加任务日志（尾部保留 200 行）。
 * @param {string} taskId 任务 id
 * @param {string} line 日志行
 */
function pushLog(taskId, line) {
  if (!logBuffers.has(taskId)) logBuffers.set(taskId, []);
  const buf = logBuffers.get(taskId);
  buf.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  if (buf.length > 200) buf.splice(0, buf.length - 200);
}

// ─── 缩略图 ───

/**
 * 生成（或复用）缩略图，返回绝对路径。
 * @param {object} item 条目
 * @param {string} taskId 任务 id
 * @param {object} sharp sharp 模块
 * @returns {Promise<string|null>}
 */
async function ensureThumb(item, taskId, sharp) {
  if (!sharp) return null;
  const dir = path.join(taskStore.TASKS_DIR, 'thumbs', taskId);
  const file = path.join(dir, `${item.id}.jpg`);
  if (fs.existsSync(file)) return file;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await sharp(item.outPath && fs.existsSync(item.outPath) ? item.outPath : item.srcPath)
      .resize(360, 360, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(file);
    return file;
  } catch {
    return null;
  }
}

// ─── 插件主体 ───

function batchImageSuite(ctx) {
  const config = ctx.config(CONFIG_SCHEMA);
  const sharp = ctx.inject('sharp', false);

  // 缩略图目录需要加入 asset 白名单（缩略图是插件自己创建的输出）
  ctx.allowAssetRoot(path.join(taskStore.TASKS_DIR, 'thumbs'));
  if (config.outputDir) ctx.allowAssetRoot(config.outputDir);

  /**
   * 取任务（优先内存，其次磁盘）。
   * @param {string} taskId 任务 id
   * @returns {object|null}
   */
  const resolveTask = (taskId) => activeTasks.get(taskId) || taskStore.getTask(taskId);

  /**
   * 把条目转成画廊行。
   * @param {object} it 条目
   * @param {string} taskId 任务 id
   * @param {boolean} withAsset 是否附带签名资源
   * @returns {Promise<object>}
   */
  async function toRow(it, taskId, withAsset = true) {
    const row = {
      id: it.id,
      title: it.outName || it.srcName,
      subtitle: it.shotAt ? `${it.shotAt} · ${it.category || '未分类'}` : `${it.timeSource || 'unknown'} · ${it.category || '未分类'}`,
      badges: [],
      meta: {
        srcName: it.srcName,
        srcPath: it.srcPath,
        outPath: it.outPath || '',
        shotAt: it.shotAt,
        timeSource: it.timeSource,
        category: it.category,
        kind: it.kind,
        description: it.description,
        group: it.similarGroupId || '',
        keep: !!it.isGroupKeep,
        pending: !!it.pending,
        pendingReason: it.pendingReason || '',
        level: (it.nsfw && it.nsfw.level) || '',
        score: (it.nsfw && it.nsfw.score) || 0,
      },
    };
    if (it.pending) row.badges.push({ text: `待筛·${it.pendingReason || '其他'}`, tone: 'warn' });
    if (it.isGroupKeep) row.badges.push({ text: '组内保留', tone: 'ok' });
    if (it.nsfw && it.nsfw.level && it.nsfw.level !== 'safe') {
      row.badges.push({ text: it.nsfw.level, tone: ['high', 'critical'].includes(it.nsfw.level) ? 'danger' : 'warn' });
    }
    if (withAsset) {
      const thumb = await ensureThumb(it, taskId, sharp);
      if (thumb) {
        const signed = ctx.signAsset(thumb);
        if (signed) row.asset = signed;
      }
    }
    return row;
  }

  // ─── 文件系统 RPC（读方法）───
  ctx.rpc('fs.statDir', async (p) => fsService.statDir(p && p.path, { recursive: p && p.recursive }));
  ctx.rpc('fs.listDir', async (p) => fsService.listDir(p && p.path));
  ctx.rpc('fs.roots', async () => fsService.roots());

  // ─── 任务 RPC ───
  /**
   * 启动任务的实际实现（供 task.start / batch.scan / batchImage 服务复用）。
   * @param {object} ctxRef BridgeContext
   * @param {object} p 参数
   * @returns {Promise<{taskId: string, total: number, mode: string}>}
   */
  async function startTaskImpl(ctxRef, p = {}) {
    const mode = p.mode || config.mode || 'organize';
    const sourceDir = p.sourceDir || config.sourceDir;
    if (!sourceDir) throw new Error('请先选择源文件夹');
    if (mode === 'organize' && !(p.outputDir || config.outputDir)) {
      throw new Error('整理模式必须先指定输出目录（源目录全程只读）');
    }
    const task = taskStore.createTask({
      mode,
      sourceDir,
      outputDir: p.outputDir || config.outputDir || '',
      recursive: p.recursive !== undefined ? p.recursive : config.recursive !== false,
      formats: p.formats || config.formats,
      maxFileSizeMb: p.maxFileSizeMb || config.maxFileSizeMb || 20,
      stages: p.stages || config.stages,
      dedupeThreshold: p.dedupeThreshold !== undefined ? p.dedupeThreshold : (config.dedupeThreshold || 6),
      sidecar: config.sidecar !== false,
      aiScope: {
        timeUnknown: (p.aiScope || config.aiScope || []).includes('timeUnknown'),
        fsExifGap: (p.aiScope || config.aiScope || []).includes('fsExifGap'),
        needDescription: (p.aiScope || config.aiScope || []).includes('needDescription'),
        lowConfidencePending: (p.aiScope || config.aiScope || []).includes('lowConfidencePending'),
        nsfwMedium: (p.aiScope || config.aiScope || []).includes('nsfwMedium'),
      },
      naming: {
        template: p.namingTemplate || config.namingTemplate || '{date}_{time}_{desc}',
        unknownTimeTemplate: '时间未知_{desc}',
        descMaxLen: config.descMaxLen || 16,
        collision: p.collision || config.collision || 'suffix',
      },
    });
    activeTasks.set(task.id, task);
    stopFlags.delete(task.id);
    pushLog(task.id, `任务已启动：${mode} · ${sourceDir}`);

    // 异步执行，不阻塞 RPC 返回
    (async () => {
      try {
        await pipeline.runTask(task, ctxRef, {
          shouldStop: () => stopFlags.get(task.id) === true,
          onProgress: (t) => {
            taskStore.tickPersist(t);
            pushLog(t.id, `${t.phase}：${t.done}/${t.total}`);
          },
        });
        taskStore.saveTask(task);
        pushLog(task.id, `任务完成：成功 ${task.done}，失败 ${task.failed}，跳过 ${task.skipped}`);
      } catch (err) {
        task.status = 'error';
        task.error = err.message;
        taskStore.saveTask(task);
        pushLog(task.id, `任务异常：${err.message}`);
      } finally {
        activeTasks.delete(task.id);
      }
    })();

    return { taskId: task.id, total: task.total || 0, mode };
  }

  ctx.rpc('task.start', (p = {}) => startTaskImpl(ctx, p), { write: true });

  ctx.rpc('task.stop', async (p = {}) => {
    const id = p.taskId || (Array.isArray(p) ? p[0] : null);
    if (!id) return { success: false, error: '缺少 taskId' };
    stopFlags.set(id, true);
    const t = resolveTask(id);
    if (t) { t.status = 'stopped'; taskStore.saveTask(t); }
    pushLog(id, '已请求停止');
    return { success: true };
  }, { write: true });

  ctx.rpc('task.status', async (p = {}) => {
    const id = p.taskId || (Array.isArray(p) ? p[0] : null);
    const t = resolveTask(id);
    if (!t) return { status: 'notfound' };
    return {
      taskId: t.id,
      status: t.status,
      phase: t.phase,
      done: t.done || 0,
      total: t.total || 0,
      failed: t.failed || 0,
      skipped: t.skipped || 0,
      current: t.current || null,
      secondPass: t.secondPassTotal ? { done: t.secondPassDone || 0, total: t.secondPassTotal } : null,
      stats: t.stats || null,
      error: t.error || null,
    };
  });

  ctx.rpc('task.results', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return null;
    return {
      taskId: t.id,
      mode: t.mode,
      status: t.status,
      total: t.total,
      done: t.done,
      failed: t.failed,
      skipped: t.skipped,
      outputDir: t.outputDir,
      stats: t.stats || reporter.buildStats(t),
      items: (t.items || []).filter((i) => i.status === 'done').map((i) => ({
        id: i.id, srcName: i.srcName, srcPath: i.srcPath, outName: i.outName,
        shotAt: i.shotAt, timeSource: i.timeSource, category: i.category,
        pending: i.pending, pendingReason: i.pendingReason, level: i.nsfw && i.nsfw.level,
      })),
    };
  });

  ctx.rpc('task.tasks', async () => ({ tasks: taskStore.listTasks() }));

  ctx.rpc('task.deleteTask', async (p = {}) => {
    const id = p.taskId || (Array.isArray(p) ? p[0] : null);
    activeTasks.delete(id);
    return { success: taskStore.deleteTask(id), deleted: 1 };
  }, { write: true });

  ctx.rpc('task.clearTasks', async () => {
    activeTasks.clear();
    return { success: true, deleted: taskStore.clearAllTasks() };
  }, { write: true });

  ctx.rpc('task.log', async (p = {}) => ({ lines: logBuffers.get(p.taskId) || [] }));

  ctx.rpc('task.resume', async () => {
    const orphans = taskStore.findOrphanTasks();
    if (!orphans.length) return { resumed: 0 };
    let resumed = 0;
    for (const t of orphans) {
      activeTasks.set(t.id, t);
      stopFlags.delete(t.id);
      pushLog(t.id, '断点续跑：恢复未完成任务');
      (async () => {
        try {
          await pipeline.runTask(t, ctx, {
            isResume: true,
            shouldStop: () => stopFlags.get(t.id) === true,
            onProgress: (x) => taskStore.tickPersist(x),
          });
          taskStore.saveTask(t);
        } catch (err) {
          t.status = 'error';
          t.error = err.message;
          taskStore.saveTask(t);
        } finally {
          activeTasks.delete(t.id);
        }
      })();
      resumed++;
    }
    return { resumed, taskId: orphans[0].id };
  }, { write: true });

  // ─── 结果画廊（服务端分页）───
  ctx.rpc('result.page', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return { rows: [], total: 0, page: 1 };
    const page = Math.max(1, Number(p.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(p.pageSize) || 60));
    let list = (t.items || []).filter((i) => i.status === 'done');
    if (p.filter && p.filter !== 'all') {
      if (p.filter === 'pending') list = list.filter((i) => i.pending);
      else if (p.filter === 'keep') list = list.filter((i) => i.isGroupKeep);
      else if (p.filter === 'dup') list = list.filter((i) => i.similarGroupId);
      else list = list.filter((i) => (i.nsfw && i.nsfw.level) === p.filter);
    }
    if (p.groupBy === 'similarGroupId') {
      list = [...list].sort((a, b) => String(a.similarGroupId || '').localeCompare(String(b.similarGroupId || '')));
    }
    const start = (page - 1) * pageSize;
    const slice = list.slice(start, start + pageSize);
    const rows = [];
    for (const it of slice) rows.push(await toRow(it, t.id));
    return { rows, total: list.length, page, pageSize, pages: Math.ceil(list.length / pageSize) };
  });

  // ─── P2：关键词检索（基于 sidecar/manifest 的内存索引，子串匹配 + 字段加权）───
  ctx.rpc('search', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return { rows: [], total: 0 };
    const q = String(p.q || '').trim().toLowerCase();
    if (!q) return { rows: [], total: 0 };
    const fields = p.fields && p.fields.length ? p.fields : ['description', 'category', 'kind', 'srcName', 'outPath', 'tags'];
    const scored = [];
    for (const it of (t.items || [])) {
      if (it.status !== 'done') continue;
      let score = 0;
      const bag = {
        description: it.description || '',
        category: it.category || '',
        kind: it.kind || '',
        srcName: it.srcName || '',
        outPath: it.outPath || it.outRelPath || '',
        tags: it.nsfw && it.nsfw.tags ? Object.keys(it.nsfw.tags.general || {}).join(' ') : '',
      };
      for (const f of fields) {
        const v = String(bag[f] || '').toLowerCase();
        if (!v) continue;
        const idx = v.indexOf(q);
        if (idx < 0) continue;
        // 字段加权：描述/分类权重高，路径权重低
        const weight = f === 'description' ? 5 : (f === 'category' || f === 'kind' ? 4 : (f === 'srcName' ? 3 : 1));
        score += weight * (idx === 0 ? 2 : 1);
      }
      if (score > 0) scored.push({ it, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const page = Math.max(1, Number(p.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(p.pageSize) || 60));
    const slice = scored.slice((page - 1) * pageSize, page * pageSize);
    const rows = [];
    for (const s of slice) rows.push(await toRow(s.it, t.id));
    return { rows, total: scored.length, page, pages: Math.ceil(scored.length / pageSize), query: q };
  });

  // ─── P2：待筛浏览 + 批量恢复 ───
  ctx.rpc('pending.page', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return { rows: [], total: 0 };
    let list = (t.items || []).filter((i) => i.status === 'done' && i.pending);
    if (Array.isArray(p.reasons) && p.reasons.length) list = list.filter((i) => p.reasons.includes(i.pendingReason));
    const page = Math.max(1, Number(p.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(p.pageSize) || 60));
    const slice = list.slice((page - 1) * pageSize, page * pageSize);
    const rows = [];
    for (const it of slice) rows.push(await toRow(it, t.id));
    return {
      rows, total: list.length, page, pages: Math.ceil(list.length / pageSize),
      reasons: [...new Set(list.map((i) => i.pendingReason || '其他'))],
    };
  });

  ctx.rpc('pending.restore', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return { restored: 0 };
    const ids = new Set(Array.isArray(p.ids) ? p.ids : []);
    let restored = 0;
    for (const it of t.items || []) {
      if (!ids.has(it.id) || !it.pending) continue;
      it.pending = false;
      const oldReason = it.pendingReason;
      it.pendingReason = null;
      // 恢复到它应在的年/月/分类目录：清掉旧输出文件，重新计算目标路径
      const rel = organizer.targetRelativePath(it);
      it.outRelPath = rel;
      it.outName = path.basename(rel);
      if (t.outputDir && it.outPath && fs.existsSync(it.outPath)) {
        const dest = path.join(t.outputDir, rel);
        if (path.resolve(dest) !== path.resolve(it.outPath)) {
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(it.outPath, dest);
            fs.unlinkSync(it.outPath); // 仅删除输出目录内的副本，源盘零写操作
            it.outPath = dest;
          } catch (err) {
            it.error = `恢复失败: ${err.message}`;
          }
        }
      }
      pushLog(t.id, `已恢复 ${it.srcName}（原待筛原因：${oldReason || '其他'}）`);
      restored++;
    }
    taskStore.saveTask(t);
    return { restored };
  }, { write: true });

  // ─── P2：人工指定组内保留图 ───
  ctx.rpc('dedupe.setKeep', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return { ok: false };
    const target = (t.items || []).find((i) => i.id === p.id);
    if (!target || !target.similarGroupId) return { ok: false, error: '该图不在任何相似组内' };
    for (const it of t.items || []) {
      if (it.similarGroupId !== target.similarGroupId) continue;
      const shouldKeep = it.id === target.id;
      if (it.isGroupKeep && !shouldKeep) {
        it.isGroupKeep = false;
        if (!it.pending) { it.pending = true; it.pendingReason = 'duplicate'; }
      }
      it.isGroupKeep = shouldKeep;
      if (shouldKeep && it.pending && it.pendingReason === 'duplicate') {
        it.pending = false;
        it.pendingReason = null;
      }
    }
    taskStore.saveTask(t);
    return { ok: true };
  }, { write: true });

  // ─── Prompt JSON 编辑 ───
  ctx.rpc('prompt.get', async () => promptService.load());
  ctx.rpc('prompt.validate', async (p = {}) => promptService.validate(p.json));
  ctx.rpc('prompt.preview', async (p = {}) => {
    const built = promptService.buildPrompt({ categoryId: p.categoryId, kindKey: p.kindKey }, p.json);
    if (!built.ok) return { ok: false, error: built.error };
    return { ok: true, prompt: built.prompt, preview: promptService.preview(built.prompt, p.json), tokens: promptService.estimateTokens(built.prompt) };
  });
  ctx.rpc('prompt.save', async (p = {}) => promptService.save(p.json), { write: true });
  ctx.rpc('prompt.reset', async () => promptService.reset(), { write: true });

  // ─── 导出（ExportProfile）───
  ctx.rpc('export.profiles', async () => ({ profiles: exporter.listProfiles() }));
  ctx.rpc('export.upsert', async (p = {}) => exporter.upsertProfile(p.profile), { write: true });
  ctx.rpc('export.delete', async (p = {}) => exporter.deleteProfile(p.id), { write: true });
  ctx.rpc('export.plan', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return { rows: [], stats: { total: 0 } };
    const profile = exporter.getProfile(p.profileId);
    if (!profile) return { error: '预设不存在' };
    const prof = { ...profile, _sourceDir: t.sourceDir };
    return exporter.plan(prof, t.items || [], p.targetDir || t.outputDir || '', p.limit || 200);
  });
  ctx.rpc('export.start', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return { error: '任务不存在' };
    const profile = exporter.getProfile(p.profileId);
    if (!profile) return { error: '预设不存在' };
    const targetDir = p.targetDir || t.outputDir;
    if (!targetDir) return { error: '缺少目标目录' };
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      taskId: t.id,
      profileId: p.profileId,
      targetDir,
      profile: { ...profile, _sourceDir: t.sourceDir },
      status: 'running',
      total: 0, done: 0, failed: 0, skipped: 0, bytes: 0,
      doneSet: [],
      startedAt: new Date().toISOString(),
    };
    exportJobs.set(job.id, job);
    (async () => {
      await exporter.run(job, {
        items: t.items || [],
        shouldStop: () => job.status === 'stopping',
      });
    })();
    return { jobId: job.id, total: job.total };
  }, { write: true });
  ctx.rpc('export.status', async (p = {}) => {
    const j = exportJobs.get(p.jobId) || exporter.getJob(p.jobId);
    if (!j) return null;
    return { jobId: j.id, status: j.status, phase: 'export', done: j.done, total: j.total, failed: j.failed, skipped: j.skipped, bytes: j.bytes, current: j.current, error: j.error || j.lastError || null };
  });
  ctx.rpc('export.stop', async (p = {}) => {
    const j = exportJobs.get(p.jobId);
    if (!j) return { success: false };
    j.status = 'stopping';
    return { success: true };
  }, { write: true });

  // ─── 动态视图 Schema（按 config.mode 返回不同界面）───
  ctx.rpc('viewSchema', async (p = {}) => {
    const mode = config.mode || 'organize';
    const file = mode === 'nsfw' ? 'views/nsfw.schema.json' : (p.viewId === 'export' ? 'views/export.schema.json' : 'views/organize.schema.json');
    if (p.viewId === 'export') {
      return JSON.parse(fs.readFileSync(path.join(__dirname, 'views/export.schema.json'), 'utf-8'));
    }
    return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf-8'));
  });

  ctx.rpc('plugin.config', async () => ({
    mode: config.mode,
    sourceDir: config.sourceDir,
    outputDir: config.outputDir,
    recursive: config.recursive,
    formats: config.formats,
    maxFileSizeMb: config.maxFileSizeMb,
  }));

  // ─── 旧 /api/batch/* 双轨兼容（6 个月）：保持与内置 batch-scan 相同的响应结构 ───
  ctx.rpc('batch.scan', async (p = {}) => {
    const started = await startTaskImpl(ctx, {
      mode: 'nsfw',
      sourceDir: p.folderPath,
      outputDir: '',
      recursive: p.recursive !== false,
    });
    const t = resolveTask(started.taskId);
    return {
      task: {
        id: t.id,
        folderPath: p.folderPath,
        recursive: p.recursive !== false,
        strictness: p.strictness || 'standard',
        readOnly: true,
        status: 'scanning',
        total: t.total || 0,
        done: 0,
        skipped: 0,
        cached: 0,
        current: null,
        startedAt: t.startedAt,
      },
    };
  }, { write: true });

  ctx.rpc('batch.status', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return null;
    return {
      id: t.id,
      status: t.status === 'done' ? 'done' : (t.status === 'stopped' ? 'stopped' : 'running'),
      phase: t.phase,
      total: t.total || 0,
      done: t.done || 0,
      skipped: t.skipped || 0,
      cached: (t.doneFingerprints || []).length,
      failed: t.failed || 0,
      current: t.current || null,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      recent: (t.items || []).filter((i) => i.status === 'done').slice(-5).map((i) => ({
        fileName: i.srcName,
        risk_level: (i.nsfw && i.nsfw.level) || 'safe',
        reason: (i.nsfw && i.nsfw.decisionSource) || '',
        filePath: i.srcPath,
      })),
    };
  });

  ctx.rpc('batch.results', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return null;
    return {
      id: t.id,
      status: t.status,
      total: t.total || 0,
      results: (t.items || []).map((i) => ({
        fileName: i.srcName,
        filePath: i.srcPath,
        risk_level: (i.nsfw && i.nsfw.level) || 'safe',
        reason: (i.nsfw && i.nsfw.decisionSource) || '',
        categories: i.nsfw && i.nsfw.level && i.nsfw.level !== 'safe' ? ['pornographic'] : [],
        category_scores: { pornographic: (i.nsfw && i.nsfw.score) || 0 },
        error: i.error || null,
      })),
    };
  });

  ctx.rpc('batch.stop', async (p = {}) => {
    stopFlags.set(p.taskId, true);
    const t = resolveTask(p.taskId);
    if (t) { t.status = 'stopped'; taskStore.saveTask(t); }
    return { success: true };
  }, { write: true });

  ctx.rpc('batch.tasks', async () => ({
    tasks: taskStore.listTasks().map((t) => ({
      id: t.id,
      folderPath: t.sourceDir,
      recursive: t.recursive,
      strictness: 'standard',
      readOnly: true,
      status: t.status === 'done' ? 'done' : (t.status === 'stopped' ? 'stopped' : 'running'),
      total: t.total || 0,
      done: t.done || 0,
      skipped: t.skipped || 0,
      cached: 0,
      current: null,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt || null,
    })),
  }));

  ctx.rpc('batch.deleteTask', async (p = {}) => ({ success: taskStore.deleteTask(p.taskId), deleted: 1 }), { write: true });
  ctx.rpc('batch.clearTasks', async () => ({ success: true, deleted: taskStore.clearAllTasks() }), { write: true });

  ctx.rpc('batch.exportCategory', async (p = {}) => {
    const t = resolveTask(p.taskId);
    if (!t) return { error: '任务不存在' };
    const levels = p.levels && p.levels.length ? p.levels : null;
    const profile = {
      ...exporter.getProfile('nsfw-by-level'),
      _sourceDir: t.sourceDir,
      action: p.mode === 'move' ? 'copy' : (p.mode || 'copy'),
      filters: levels ? { levels } : {},
      structure: p.keepFolders
        ? { mode: 'keepTree', template: '{level}/{srcRelDir}/{name}', unknownTimeDir: '时间未知', pendingDir: '_待后续筛选_无用候选' }
        : { mode: 'byLevel', template: '{level}/{name}', unknownTimeDir: '时间未知', pendingDir: '_待后续筛选_无用候选' },
    };
    const planned = exporter.plan(profile, t.items || [], p.targetDir, 1000000);
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      taskId: t.id,
      profileId: 'nsfw-by-level',
      targetDir: p.targetDir,
      profile,
      status: 'running',
      total: 0, done: 0, failed: 0, skipped: 0, bytes: 0,
      doneSet: [],
      startedAt: new Date().toISOString(),
    };
    exportJobs.set(job.id, job);
    (async () => { await exporter.run(job, { items: t.items || [], shouldStop: () => job.status === 'stopping' }); })();
    return { success: true, jobId: job.id, total: planned.stats.total };
  }, { write: true });

  ctx.rpc('batch.exportStatus', async (p = {}) => {
    const j = exportJobs.get(p.jobId) || exporter.getJob(p.jobId);
    if (!j) return null;
    return { jobId: j.id, status: j.status === 'done' ? 'done' : j.status, done: j.done, total: j.total, failed: j.failed, targetDir: j.targetDir };
  });

  // 提供 batchImage 服务，供其他插件 ctx.inject('batchImage') 复用
  ctx.provide('batchImage', {
    startTask: (params) => startTaskImpl(ctx, params),
    getTask: resolveTask,
    listTasks: () => taskStore.listTasks(),
    exportProfiles: () => exporter.listProfiles(),
  });

  // 清理：插件卸载时停止所有任务
  ctx.onDispose(() => {
    for (const id of activeTasks.keys()) stopFlags.set(id, true);
    activeTasks.clear();
  });
}

Object.defineProperty(batchImageSuite, 'name', { value: PLUGIN_ID, configurable: true });
batchImageSuite.description = '本地磁盘图片整理 + 动漫图 NSFW 审查（同一插件两种模式）';
batchImageSuite.version = '1.0.0';

module.exports = batchImageSuite;
module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;
