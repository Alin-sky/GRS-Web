/**
 * 流水线编排（plugins/batch-image-suite/lib/pipeline.js）
 *
 * 9 个阶段（可勾选，R-B11）：
 *   scan → decode → exif → phash → classify → dedupe → triage → materialize → report
 *
 * ★ 两遍策略（Q2 决策）：
 *   第一遍（无模型）：scan + decode + exif + phash + dedupe + 规则分类 + 目录结构
 *   第二遍（VL）    ：仅对命中 aiScope 规则的图片调用视觉模型（时间未知 / 时间跨度异常 /
 *                     用户标记需描述 / 待筛置信度低 / organize 模式下 NSFW ≥ medium）
 *
 * ★ 安全红线：materialize 阶段只做 fs.copyFile（读源写目标），源目录字节级不变。
 */
const fs = require('fs');
const path = require('path');
const { collectImages, ensureDir } = require('./fs-service');
const { readShotAt } = require('./exif');
const { dHashFile, groupBySimilarity } = require('./phash');
const organizer = require('./organizer');
const reporter = require('./reporter');
const promptService = require('./prompt-service');
const nsfwLib = require('./nsfw');

/** 是否在输出目录内（安全校验：绝不允许把文件写到源目录） */
function isInsideRoot(target, root) {
  const t = path.resolve(target);
  const r = path.resolve(root);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * 提取模型返回中的 JSON。
 * @param {string} text 文本
 * @returns {object|null}
 */
function extractJSON(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 规则预分类（第一遍，不调用模型）：识别截图 / 票据 / 模糊 / 黑图。
 * @param {object} item 条目
 * @param {object} meta { width, height, sharpness, size, ext }
 * @returns {{pending: boolean, pendingReason: string|null, kind: string|null}}
 */
function ruleTriage(item, meta) {
  const w = Number(meta.width) || 0;
  const h = Number(meta.height) || 0;
  const sharpness = Number(meta.sharpness) || 0;
  // 截图：常见分辨率 + 极低体积（PNG/JPG 压缩后的纯色界面）
  const ratio = h ? w / h : 0;
  const isScreenRatio = (ratio > 1.7 && ratio < 2.3) || (ratio > 0.45 && ratio < 0.6);
  if (isScreenRatio && w >= 720 && (item.size || 0) < 700 * 1024) {
    return { pending: true, pendingReason: 'screenshot', kind: '截图' };
  }
  // 黑图/大面积遮挡：sharpness 极低且平均亮度极低（用 sharpness 近似）
  if (sharpness > 0 && sharpness < 1.2 && (item.size || 0) < 300 * 1024) {
    return { pending: true, pendingReason: 'black', kind: null };
  }
  // 模糊废片：清晰度显著低于同分辨率正常水平
  if (sharpness > 0 && sharpness < 2 && w * h > 200000) {
    return { pending: true, pendingReason: 'blurry', kind: null };
  }
  return { pending: false, pendingReason: null, kind: null };
}

/**
 * 判定某条目是否需要进第二遍（VL）。
 * @param {object} item 条目
 * @param {object} aiScope 规则开关
 * @returns {boolean}
 */
function needSecondPass(item, aiScope = {}) {
  if (aiScope.timeUnknown !== false && item.timeSource === 'unknown') return true;
  if (aiScope.fsExifGap !== false && item.timeSource === 'fs' && item.exifGapYears !== undefined && item.exifGapYears > 5) return true;
  if (aiScope.needDescription === true && item.needDescription) return true;
  if (aiScope.lowConfidencePending !== false && item.pending && (item.confidence || 0) < 0.7) return true;
  if (aiScope.nsfwMedium !== false && item.nsfw && ['medium', 'high', 'critical'].includes(item.nsfw.level)) return true;
  return false;
}

/**
 * 调用视觉模型做第二遍（描述 / 年代推断 / 分类）。
 * @param {object} item 条目
 * @param {object} ctx BridgeContext
 * @param {{model?: string, categoryId?: string, kindKey?: string}} opts 选项
 * @returns {Promise<boolean>} 是否成功
 */
async function classifyWithAI(item, ctx, opts = {}) {
  const vision = ctx.inject('vision', false);
  const sharp = ctx.inject('sharp', false);
  const config = ctx.inject('config', false) || {};
  if (!vision || typeof vision.chat !== 'function') return false;
  try {
    let b64 = fs.readFileSync(item.srcPath).toString('base64');
    if (sharp) {
      try {
        b64 = (await sharp(item.srcPath).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()).toString('base64');
      } catch { /* 缩放失败则用原图 */ }
    }
    const built = promptService.buildPrompt({ categoryId: opts.categoryId, kindKey: opts.kindKey });
    if (!built.ok) return false;
    const model = opts.model || (config.ollama && config.ollama.visionModel) || 'qwen3-vl:8b-instruct';
    const raw = await vision.chat(model, built.prompt, '请按输出 JSON 字段要求回答。', [b64], null);
    const parsed = extractJSON(raw && raw.content ? raw.content : raw);
    if (!parsed) return false;
    item.kind = parsed.kind || item.kind || '';
    item.category = parsed.category || item.category || '';
    item.description = parsed.description || item.description || '';
    item.confidence = parsed.confidence !== undefined ? Number(parsed.confidence) : 0.8;
    if (parsed.era_hint && parsed.era_hint !== 'unknown') {
      item.aiEra = parsed.era_hint;
      // 只给年代，不给精确日期
      const m = String(parsed.era_hint).match(/(\d{4})s/);
      if (m && !item.shotAt) item.timeSource = 'ai_era';
    }
    if (parsed.is_screenshot) { item.pending = true; item.pendingReason = 'screenshot'; }
    else if (parsed.is_document) { item.pending = true; item.pendingReason = 'document'; }
    else if (parsed.is_blurry) { item.pending = true; item.pendingReason = 'blurry'; }
    else if (parsed.is_black) { item.pending = true; item.pendingReason = 'black'; }
    return true;
  } catch (err) {
    item.aiError = err.message;
    return false;
  }
}

/**
 * 运行任务主流程。
 * @param {object} task 任务对象
 * @param {object} ctx BridgeContext
 * @param {{isResume?: boolean, shouldStop?: Function, onProgress?: Function}} [opts] 选项
 * @returns {Promise<object>} 完成后的任务
 */
async function runTask(task, ctx, opts = {}) {
  const shouldStop = opts.shouldStop || (() => false);
  const stages = new Set(task.stages || []);
  const sharp = ctx.inject('sharp', false);
  const config = ctx.inject('config', false) || {};

  // ─── 阶段 1：scan（首次运行时收集文件；续跑时复用已有 items） ───
  task.phase = 'scan';
  if (!task.items || task.items.length === 0) {
    const res = collectImages({
      dir: task.sourceDir,
      recursive: task.recursive,
      formats: task.formats,
      maxFileSizeMb: task.maxFileSizeMb,
    });
    if (!res.ok) {
      task.status = 'error';
      task.error = res.error;
      return task;
    }
    task.items = res.files.map((f, i) => ({
      id: `i${String(i + 1).padStart(6, '0')}`,
      srcPath: f.path,
      srcName: f.name,
      srcRelDir: f.relDir,
      ext: path.extname(f.name).toLowerCase(),
      size: f.size,
      mtimeMs: f.mtimeMs,
      birthtimeMs: f.birthtimeMs,
      status: f.overSize ? 'skipped' : 'pending',
      skipReason: f.overSize ? '超过单张大小上限' : null,
      timeSource: 'unknown',
      shotAt: null,
      dhash: null,
      pending: false,
      pendingReason: null,
      category: '',
      kind: '',
      description: '',
    }));
  }
  task.total = task.items.length;
  task.done = task.items.filter((i) => i.status === 'done').length;
  task.skipped = task.items.filter((i) => i.status === 'skipped').length;

  const toProcess = task.items.filter((i) => i.status === 'pending' || i.status === 'processing');
  const scanConcurrency = Math.max(1, Math.min(32, Number(task.scanConcurrency) || 8));

  // ★ 收敛 libvips 线程池：默认 VIPS_CONCURRENCY=CPU 核数（本机 56），多路并发解码时
  //   线程严重过订阅反而更慢；实测 8 路最稳（比默认核数快约 2.5x）。
  if (sharp && typeof sharp.concurrency === 'function') {
    sharp.concurrency(scanConcurrency);
  }

  /**
   * 处理单张图片（第一遍无模型阶段）。
   * 解码成功置 done，解码失败置 skipped；其他异常抛出由并发池统一兜底。
   * @param {object} item 条目
   * @returns {Promise<void>}
   */
  async function processFirstPassItem(item) {
    // decode：宽高 + 清晰度。
    // ★ 保留全分辨率 stats：实测缩略图(256px)的 sharpness 会抬高模糊/黑图的值，
    //   使「模糊」与「清晰」图片数值区间重叠，导致 ruleTriage 阈值(1.2/2.0)完全失效；
    //   因此清晰度仍对原图计算（这是唯一昂贵的一步，约 394ms），其余步骤本就很便宜：
    //   metadata 只读头部(8ms)，dHashFile 走 shrink-on-load(28ms)。
    if (stages.has('decode') && sharp) {
      try {
        const meta = await sharp(item.srcPath).metadata();
        item.width = meta.width || 0;
        item.height = meta.height || 0;
        const st = await sharp(item.srcPath).stats();
        item.sharpness = st.sharpness || 0;
      } catch {
        item.unsupported = true;
        item.status = 'skipped';
        item.skipReason = '格式不支持（无法解码）';
        task.skipped++;
        return;
      }
    }

    // exif：拍摄时间 + 四级修复（readShotAt 已异步化，不阻塞事件循环）
    if (stages.has('exif')) {
      const shotAt = await readShotAt(item.srcPath);
      const fixed = organizer.repairTime(item, { shotAt });
      item.shotAt = fixed.shotAt;
      item.timeSource = fixed.timeSource;
      if (shotAt && item.mtimeMs) {
        const gapMs = Math.abs(item.mtimeMs - new Date(shotAt.replace(' ', 'T')).getTime());
        item.exifGapYears = gapMs / (365.25 * 24 * 3600 * 1000);
      }
    }

    // phash：感知哈希（原图 resize(9,8) 与旧逻辑逐位一致）
    if (stages.has('phash')) {
      item.dhash = await dHashFile(item.srcPath, sharp);
    }

    // 规则分类（第一遍）
    if (stages.has('triage')) {
      const t = ruleTriage(item, item);
      if (t.pending) {
        item.pending = true;
        item.pendingReason = t.pendingReason;
        if (t.kind) item.kind = t.kind;
      }
    }

    item.status = 'done';
    task.done++;
  }

  // ─── 第一遍：无模型（并发扫描） ───
  task.phase = 'first-pass';
  let cursor = 0; // 共享游标，worker 同步取号（JS 单线程，无竞态）
  let stopped = false;
  let pendingProgress = 0; // 距上次进度回调已处理张数（节流用）

  async function firstPassWorker() {
    while (true) {
      if (stopped) break;
      if (shouldStop()) { stopped = true; break; }
      const idx = cursor++;
      if (idx >= toProcess.length) break;
      const item = toProcess[idx];
      item.status = 'processing';
      task.current = item.srcName;
      try {
        await processFirstPassItem(item);
      } catch (err) {
        item.error = err.message;
        item.status = 'skipped';
        item.skipReason = `处理失败：${err.message}`;
        task.skipped++;
      }
      pendingProgress++;
      if (pendingProgress >= 50) {
        pendingProgress = 0;
        task.updatedAt = new Date().toISOString();
        if (opts.onProgress) opts.onProgress(task);
      }
      // 让出事件循环，保证停止信号 / 进度可被及时响应
      await new Promise((r) => setImmediate(r));
    }
  }

  const workerCount = Math.min(scanConcurrency, toProcess.length);
  await Promise.all(Array.from({ length: workerCount }, () => firstPassWorker()));

  if (stopped || shouldStop()) { task.status = 'stopped'; return task; }
  if (pendingProgress > 0) {
    task.updatedAt = new Date().toISOString();
    if (opts.onProgress) opts.onProgress(task);
  }

  // ─── dedupe：相似分组 + 组内保留 ───
  if (stages.has('dedupe') && stages.has('phash')) {
    task.phase = 'dedupe';
    const doneItems = task.items.filter((i) => i.status === 'done');
    groupBySimilarity(doneItems, task.dedupeThreshold || 6);
    const groups = new Map();
    for (const it of doneItems) {
      if (!it.similarGroupId) continue;
      if (!groups.has(it.similarGroupId)) groups.set(it.similarGroupId, []);
      groups.get(it.similarGroupId).push(it);
    }
    for (const list of groups.values()) {
      if (list.length < 2) { if (list[0]) list[0].isGroupKeep = true; continue; }
      const keep = organizer.pickGroupKeep(list);
      for (const it of list) {
        it.isGroupKeep = it === keep;
        if (!it.isGroupKeep && !it.pending) {
          it.pending = true;
          it.pendingReason = 'duplicate';
        }
      }
    }
  }

  // ─── 第二遍：VL（仅对命中 aiScope 的条目） ───
  const secondPass = stages.has('classify') ? task.items.filter((i) => i.status === 'done' && needSecondPass(i, task.aiScope)) : [];
  if (secondPass.length) {
    task.phase = 'second-pass';
    task.secondPassTotal = secondPass.length;
    task.secondPassDone = 0;
    for (const item of secondPass) {
      if (shouldStop()) { task.status = 'stopped'; return task; }
      task.current = item.srcName;
      if (task.mode === 'nsfw') {
        const wd14 = ctx.inject('wd14', false);
        let wd14Cfg = {};
        try {
          if (wd14 && wd14.config) wd14Cfg = wd14.config;
        } catch { /* 忽略 */ }
        await nsfwLib.analyzeItem(item, ctx, { config: task, wd14Cfg });
      } else {
        await classifyWithAI(item, ctx, { model: config.ollama && config.ollama.visionModel });
      }
      task.secondPassDone++;
      if (task.secondPassDone % 5 === 0) {
        if (opts.onProgress) opts.onProgress(task);
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  // ─── materialize：只读复制到输出目录 ───
  if (stages.has('materialize') && task.outputDir) {
    task.phase = 'materialize';
    ensureDir(task.outputDir);
    const outRoot = path.resolve(task.outputDir);
    for (const item of task.items) {
      if (item.status !== 'done') continue;
      if (shouldStop()) { task.status = 'stopped'; return task; }
      item.naming = task.naming;
      const rel = organizer.targetRelativePath(item);
      const dest = path.join(outRoot, rel);
      // ★ 安全校验：目标必须落在输出目录内；源与目标不能是同一文件
      if (!isInsideRoot(dest, outRoot)) {
        item.status = 'failed';
        item.error = '目标路径越权，已拒绝写入';
        task.failed++;
        continue;
      }
      if (path.resolve(item.srcPath) === dest) {
        item.status = 'failed';
        item.error = '源与目标相同，已拒绝（绝不原地改写源素材）';
        task.failed++;
        continue;
      }
      try {
        ensureDir(path.dirname(dest));
        const finalDest = organizer.resolveCollision(dest, (task.naming && task.naming.collision) || 'suffix');
        if (finalDest.action === 'skip') {
          item.outPath = finalDest.path;
          item.outRelPath = rel;
          item.outName = path.basename(finalDest.path);
        } else {
          fs.copyFileSync(item.srcPath, finalDest.path); // ★ 只读复制
          item.outPath = finalDest.path;
          item.outRelPath = path.relative(outRoot, finalDest.path).replace(/\\/g, '/');
          item.outName = path.basename(finalDest.path);
          if (task.sidecar !== false) reporter.writeSidecar(finalDest.path, item);
        }
      } catch (err) {
        item.status = 'failed';
        item.error = err.message;
        task.failed++;
      }
    }
  } else {
    // 未实体化时也要算出输出名，供报告/导出使用
    for (const item of task.items) {
      if (item.status !== 'done') continue;
      item.naming = task.naming;
      item.outRelPath = organizer.targetRelativePath(item);
      item.outName = path.basename(item.outRelPath);
    }
  }

  // ─── report ───
  if (stages.has('report')) {
    task.phase = 'report';
    if (task.outputDir) reporter.writeReports(task, task.outputDir);
  }

  task.status = 'done';
  task.phase = 'done';
  task.finishedAt = new Date().toISOString();
  task.stats = reporter.buildStats(task);
  return task;
}

module.exports = { runTask, ruleTriage, needSecondPass, classifyWithAI, extractJSON, isInsideRoot };
