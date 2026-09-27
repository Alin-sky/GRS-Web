/**
 * nsfwjs 推理封装（plugins/nsfwjs-image-guard/lib/classifier.js）
 *
 * 职责：
 *  1. 惰性加载 TF.js 后端 + nsfwjs 模型（首次调用时加载，按「后端 + 模型路径」缓存）；
 *  2. 把 base64 / Buffer / 原始像素解码为 3 通道张量；
 *  3. 调 model.classify 拿到五分类分数（Drawing / Hentai / Neutral / Porn / Sexy）；
 *  4. 批量调用（复用批量图片流程），带并发上限与总量上限。
 *
 * ★ 安全约定：
 *   - 任何异常都向上抛出，绝不吞掉后返回「安全」；由执行器按节点 failed → fail-closed 处理；
 *   - 日志只打印字节数、后端、耗时，**不打印图片二进制、不打印完整路径**。
 */
'use strict';

const deps = require('./deps');

/** nsfwjs 固定输出的五个类别 */
const NSFW_CLASSES = Object.freeze(['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy']);

/** 单次批量调用的图片数上限（防一次请求打满内存） */
const MAX_BATCH_IMAGES = 64;

/** 模型缓存：`${backend}|${modelPath||'default'}` → Promise<nswfjsModel> */
const _models = new Map();

/** 后端模块缓存：backendId → tf 模块 */
const _backends = new Map();

/** 可选的宿主图像解码器（sharp 由主工程提供，缺失时不做强依赖） */
let _sharpTried = false;
let _sharp = null;

/**
 * 取宿主提供的 sharp（可选；缺失返回 null）。
 * @returns {any|null} sharp 模块
 */
function optionalSharp() {
  if (!_sharpTried) {
    _sharpTried = true;
    _sharp = deps.tryLoad('sharp');
  }
  return _sharp;
}

/**
 * 加载并缓存 TF.js 后端模块。
 * @param {string} backendId 后端 id（tfjs-node / tfjs）
 * @returns {any} tf 模块
 */
function loadBackend(backendId) {
  if (_backends.has(backendId)) return _backends.get(backendId);
  const pkg = backendId === 'tfjs' ? '@tensorflow/tfjs' : '@tensorflow/tfjs-node';
  const mod = deps.tryLoad(pkg);
  if (!mod) {
    const err = new Error(`计算后端不可用：${pkg} 未安装（安装命令：${deps.installHintFor(backendId)}）`);
    err.code = 'MISSING_BACKEND';
    throw err;
  }
  _backends.set(backendId, mod);
  return mod;
}

/**
 * 带超时的 Promise 包装。
 * @param {Promise<any>} promise 目标
 * @param {number} timeoutMs 超时毫秒
 * @param {string} what 描述
 * @returns {Promise<any>}
 */
function withTimeout(promise, timeoutMs, what) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${what}超时（${timeoutMs}ms）`);
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 加载（并缓存）nsfwjs 模型。
 * @param {string} backendId 后端 id
 * @param {string} modelPath 自定义模型路径/URL（空串用默认）
 * @param {number} timeoutMs 加载超时
 * @returns {Promise<any>} nsfwjs 模型
 */
function loadModel(backendId, modelPath, timeoutMs) {
  const key = `${backendId}|${modelPath || 'default'}`;
  if (_models.has(key)) return _models.get(key);

  const task = (async () => {
    loadBackend(backendId);
    const nsfwjs = deps.tryLoad('nsfwjs');
    if (!nsfwjs) {
      const err = new Error(`缺少可选依赖 nsfwjs（安装命令：${deps.installHintFor(backendId)}）`);
      err.code = 'MISSING_DEPS';
      throw err;
    }
    // 优先用调用方指定的模型；其次尝试默认加载；最后回退到随包分发的本地模型目录
    const candidates = [];
    if (modelPath) candidates.push(modelPath);
    candidates.push(null);
    const pkgDir = deps.packageDir('nsfwjs');
    if (pkgDir) candidates.push(`file://${pkgDir.replace(/\\/g, '/')}/model`);

    let lastErr = null;
    for (const candidate of candidates) {
      try {
        const model = await withTimeout(
          candidate === null ? nsfwjs.load() : nsfwjs.load(candidate),
          timeoutMs,
          'nsfwjs 模型加载',
        );
        if (model) return model;
      } catch (err) {
        lastErr = err;
      }
    }
    const err = new Error(`nsfwjs 模型加载失败：${lastErr ? lastErr.message : '无可用模型源'}`);
    err.code = 'MODEL_LOAD_FAILED';
    throw err;
  })();

  // 失败不缓存，允许下次重试（例如用户刚装好依赖）
  task.catch(() => _models.delete(key));
  _models.set(key, task);
  return task;
}

/**
 * 把输入解码为 3 通道张量。
 * @param {any} tf tf 模块
 * @param {string} backendId 后端 id
 * @param {{base64?: string, buffer?: Buffer, pixels?: {data: any, width: number, height: number}}} input 输入
 * @returns {any} tensor3d
 */
function decodeToTensor(tf, backendId, input) {
  if (input.pixels && input.pixels.data && input.pixels.width > 0 && input.pixels.height > 0) {
    const raw = input.pixels.data;
    const arr = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
    return tf.tensor3d(arr, [input.pixels.height, input.pixels.width, 3], 'int32');
  }

  let buffer = input.buffer || null;
  if (!buffer && typeof input.base64 === 'string' && input.base64) {
    buffer = Buffer.from(input.base64, 'base64');
  }
  if (!buffer || buffer.length === 0) {
    const err = new Error('缺少图片数据（base64 / buffer / pixels 至少提供一项）');
    err.code = 'EMPTY_INPUT';
    throw err;
  }

  // 原生后端自带解码器
  if (backendId === 'tfjs-node' && tf.node && typeof tf.node.decodeImage === 'function') {
    return tf.node.decodeImage(buffer, 3);
  }

  // 纯 JS 后端：退化为宿主提供的 sharp（若可用）
  const sharp = optionalSharp();
  if (sharp) {
    // sharp 是同步解码，这里只取原始像素，尺寸由 sharp 给出
    const decoded = sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded && decoded.data && decoded.info) {
      const ch = decoded.info.channels || 4;
      const { width, height } = decoded.info;
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < width * height; i++) {
        rgb[j++] = decoded.data[i * ch];
        rgb[j++] = decoded.data[i * ch + 1];
        rgb[j++] = decoded.data[i * ch + 2];
      }
      return tf.tensor3d(rgb, [height, width, 3], 'int32');
    }
  }

  const err = new Error('纯 JS 后端在 Node 下无法自行解码 JPEG/PNG：请在 payload 中提供 pixels，或安装 @tensorflow/tfjs-node / sharp');
  err.code = 'NO_DECODER';
  throw err;
}

/**
 * 对单张图片做 NSFW 五分类。
 * @param {{base64?: string, buffer?: Buffer, pixels?: object}} input 图片输入
 * @param {{backend?: string, modelPath?: string, timeoutMs?: number}} options 选项
 * @returns {Promise<{predictions: Array<{className: string, probability: number}>, backend: string, elapsedMs: number}>}
 */
async function classify(input, options = {}) {
  const startedAt = Date.now();
  const backendId = options.backend === 'tfjs' ? 'tfjs' : 'tfjs-node';
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;

  const model = await loadModel(backendId, options.modelPath || '', timeoutMs);
  const tf = loadBackend(backendId);

  let tensor = null;
  try {
    tensor = decodeToTensor(tf, backendId, input || {});
    // 取全部五个类别：阈值判定需要完整分数，topK 只影响 reason 的可读性
    const all = await withTimeout(model.classify(tensor, NSFW_CLASSES.length), timeoutMs, 'nsfwjs 推理');
    const predictions = (Array.isArray(all) ? all : [])
      .filter((p) => p && typeof p.className === 'string')
      .map((p) => ({ className: p.className, probability: Number(p.probability) || 0 }))
      .sort((a, b) => b.probability - a.probability);
    return { predictions, backend: backendId, elapsedMs: Date.now() - startedAt };
  } finally {
    if (tensor && typeof tensor.dispose === 'function') {
      try { tensor.dispose(); } catch { /* 释放失败不影响判定 */ }
    }
  }
}

/**
 * 批量分类（复用批量图片流程）。并发上限默认 2（模型推理是 CPU/内存密集操作）。
 * @param {Array<object>} inputs 图片输入数组
 * @param {{backend?: string, modelPath?: string, timeoutMs?: number, topK?: number, concurrency?: number}} options 选项
 * @returns {Promise<Array<{ok: boolean, predictions?: Array<object>, elapsedMs?: number, error?: string}>>}
 */
async function classifyBatch(inputs, options = {}) {
  const list = Array.isArray(inputs) ? inputs.slice(0, MAX_BATCH_IMAGES) : [];
  const concurrency = Math.min(8, Math.max(1, Number(options.concurrency) || 2));
  const results = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        const res = await classify(list[index], options);
        results[index] = { ok: true, predictions: res.predictions, elapsedMs: res.elapsedMs };
      } catch (err) {
        results[index] = { ok: false, error: err && err.message ? err.message : String(err) };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(list.length, 1)) }, worker));
  return results;
}

/** 清空模型缓存（后端或模型路径变更时使用） */
function clearCache() {
  _models.clear();
}

/** 缓存状态（诊断用，不含任何图片数据） */
function cacheState() {
  return { models: [..._models.keys()], backends: [..._backends.keys()] };
}

module.exports = {
  NSFW_CLASSES,
  MAX_BATCH_IMAGES,
  classify,
  classifyBatch,
  loadModel,
  clearCache,
  cacheState,
};
