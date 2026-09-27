/**
 * nsfwjs 本地审图插件（plugins/nsfwjs-image-guard/index.js）
 *
 * 定位：图像模态的**判定型审核节点**（role=judge），产出标准 ModerationVerdict，
 *       通过宿主能力 image.verdict / 事件 moderation:verdict:image 被拓扑执行器调用。
 *
 * ★ 可选依赖红线（本项目的「0 依赖、可解耦运行」硬要求）：
 *   - nsfwjs 与 @tensorflow/tfjs-node 不进主工程 package.json 的任何依赖区；
 *   - 插件装载时探测依赖，缺失 → **本插件不提供服务、不注册能力、不挂钩子**，
 *     并抛出带安装命令的明确错误，由宿主把插件置为 missing-deps / disabled；
 *   - 探测与装载全程不触碰核心、不影响其它插件与审核主流程。
 *
 * ★ 失败语义：任何异常都向上抛出（不吞、不返回 safe）。
 *   执行器会按节点 failed → fail-closed 处理，插件异常绝不可能变成「放行」。
 *
 * ★ 日志：只打印字节数 / 后端 / 耗时 / 命中类别，不打印图片二进制与完整路径。
 */
'use strict';

const deps = require('./lib/deps');
const classifier = require('./lib/classifier');
const mapping = require('./lib/mapping');
const { buildViewSchema } = require('./lib/view-schema');

/** 本插件在能力注册表中的节点 ref（与 manifest.contributes.nodes[].ref 一致） */
const NODE_REF = 'plugin.nsfwjs-image-guard.image';

/** 插件 id（日志前缀 / 服务命名空间） */
const PLUGIN_ID = 'nsfwjs-image-guard';

/** 插件配置表单（前端「图片审核」面板据此渲染） */
const CONFIG_SCHEMA = {
  name: PLUGIN_ID,
  title: 'nsfwjs 本地审图',
  version: '1.0.0',
  description: '用 nsfwjs 做图片 NSFW 五分类（Drawing/Hentai/Neutral/Porn/Sexy），按阈值与等级映射产出本系统风险判定。为可选依赖插件：未安装依赖时插件自动禁用，核心与其它插件不受影响。',
  groups: [
    { id: 'basic', title: '基础', desc: '开关、判定阈值与后端选择。' },
    { id: 'mapping', title: '类别 → 风险等级映射', desc: '把 nsfwjs 的五个类别映射到本系统风险等级。' },
    { id: 'perf', title: '性能与批量', desc: '批量调用参数与超时。' },
  ],
  fields: [
    { key: 'enabled', type: 'boolean', label: '启用 nsfwjs 审图节点', default: true, group: 'basic',
      desc: '关闭后本插件不再挂载审核钩子（等同于该节点不参与拓扑）；修改后需重载插件生效。' },
    { key: 'threshold', type: 'slider', label: '判定阈值', min: 0, max: 1, step: 0.05, default: 0.6, group: 'basic',
      desc: '某类别分数达到该值才输出对应风险等级；全部低于阈值则判定 safe。' },
    { key: 'topK', type: 'number', label: '取前 K 个预测写入 reason', min: 1, max: 5, default: 3, group: 'basic',
      desc: '仅影响判定理由的可读性，不影响判定结果。' },
    {
      key: 'backend', type: 'select', label: '计算后端', default: 'tfjs-node', group: 'basic',
      desc: 'tfjs-node 为原生后端（推荐，性能好但体积大）；tfjs 为纯 JS 后端（体积小、较慢，Node 下需要调用方提供像素或可用解码器）。',
      options: [
        { value: 'tfjs-node', label: 'tfjs-node（原生，推荐）' },
        { value: 'tfjs', label: 'tfjs（纯 JS 回退）' },
      ],
    },
    { key: 'modelPath', type: 'text', label: '自定义模型路径/URL', default: '', group: 'basic',
      desc: '留空使用 nsfwjs 自带模型；可填写本地目录（file:///…）或远端 URL。' },
    { key: 'categoryId', type: 'text', label: '命中后写入的分类 id', default: 'pornographic', group: 'basic',
      desc: '与系统分类表（config.categories）的 id 对齐，默认 pornographic。' },

    { key: 'level.Porn', type: 'select', label: 'Porn → 风险等级', default: 'high', group: 'mapping',
      desc: '显式色情内容映射到的等级（默认 high）。',
      options: [{ value: 'safe', label: 'safe' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'critical', label: 'critical' }] },
    { key: 'level.Hentai', type: 'select', label: 'Hentai → 风险等级', default: 'high', group: 'mapping',
      desc: '色情向二次元内容映射到的等级（默认 high）。',
      options: [{ value: 'safe', label: 'safe' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'critical', label: 'critical' }] },
    { key: 'level.Sexy', type: 'select', label: 'Sexy → 风险等级', default: 'medium', group: 'mapping',
      desc: '挑逗/暴露但非显式色情映射到的等级（默认 medium）。',
      options: [{ value: 'safe', label: 'safe' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'critical', label: 'critical' }] },
    { key: 'level.Drawing', type: 'select', label: 'Drawing → 风险等级', default: 'safe', group: 'mapping',
      desc: '非色情的绘画/插画映射到的等级（默认 safe）。',
      options: [{ value: 'safe', label: 'safe' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'critical', label: 'critical' }] },
    { key: 'level.Neutral', type: 'select', label: 'Neutral → 风险等级', default: 'safe', group: 'mapping',
      desc: '中性安全内容映射到的等级（默认 safe）。',
      options: [{ value: 'safe', label: 'safe' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'critical', label: 'critical' }] },

    { key: 'concurrency', type: 'number', label: '批量并发', min: 1, max: 8, default: 2, group: 'perf',
      desc: '批量调用时的最大并发推理数。' },
    { key: 'maxBatch', type: 'number', label: '批量上限（张）', min: 1, max: 64, default: 16, group: 'perf',
      desc: '单次批量调用最多处理的图片数，超出部分不处理。' },
    { key: 'timeoutMs', type: 'number', label: '单张超时（毫秒）', min: 1000, max: 120000, default: 20000, group: 'perf',
      desc: '模型加载与单张推理的超时，超时按节点失败处理（fail-closed）。' },
  ],
};

// ─── 工具 ───

/**
 * 归一化调用入参：兼容 (request) 与 (owner, request) 两种 emitCall 约定。
 * @param {...any} args 原始入参
 * @returns {object|null} 归一化后的请求对象
 */
function normalizeRequest(...args) {
  let best = null;
  for (const arg of args) {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
    const looksLikeRequest = 'payload' in arg || 'params' in arg || 'ref' in arg || 'mode' in arg;
    if (looksLikeRequest) best = arg;
  }
  if (best) {
    return {
      ref: best.ref || NODE_REF,
      params: best.params && typeof best.params === 'object' ? best.params : {},
      payload: best.payload && typeof best.payload === 'object' ? best.payload : {},
      meta: best.meta && typeof best.meta === 'object' ? best.meta : {},
    };
  }
  // 兜底：直接传入 base64 字符串的旧式调用
  const first = args.find((a) => typeof a === 'string' && a.length > 0);
  if (first) return { ref: NODE_REF, params: {}, payload: { base64: first }, meta: {} };
  return null;
}

/**
 * 从 payload 中提取待判定图片（支持单张与批量）。
 * @param {object} payload 载荷
 * @returns {Array<object>} 图片输入列表
 */
function extractImages(payload) {
  const list = [];
  const pushOne = (value) => {
    if (!value) return;
    if (typeof value === 'string') { if (value) list.push({ base64: value }); return; }
    if (Buffer.isBuffer(value)) { list.push({ buffer: value }); return; }
    if (typeof value === 'object') {
      if (typeof value.base64 === 'string' && value.base64) { list.push({ base64: value.base64 }); return; }
      if (Buffer.isBuffer(value.buffer)) { list.push({ buffer: value.buffer }); return; }
      if (value.pixels && typeof value.pixels === 'object') { list.push({ pixels: value.pixels }); }
    }
  };
  if (Array.isArray(payload.images)) payload.images.forEach(pushOne);
  pushOne(payload.imageBase64);
  pushOne(payload.image);
  pushOne(payload.base64);
  pushOne(payload.buffer ? { buffer: payload.buffer } : null);
  pushOne(payload.pixels ? { pixels: payload.pixels } : null);
  return list;
}

/** 取整数参数（带范围收敛） */
function intParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 取数字参数（带范围收敛） */
function numParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 字节数（仅用于日志，不含图片内容） */
function bytesOf(input) {
  if (input.buffer) return input.buffer.length;
  if (input.base64) return Math.floor((input.base64.length * 3) / 4);
  if (input.pixels && input.pixels.data) return input.pixels.data.length || 0;
  return 0;
}

/** 构造带错误码的异常（便于执行器识别 failureType） */
function taggedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─── 插件主体 ───

/**
 * 插件入口。
 * @param {object} ctx 宿主桥接上下文（BridgeContext）
 */
function nsfwjsImageGuard(ctx) {
  const logger = (ctx && ctx.logger) || console;
  const config = ctx.config(CONFIG_SCHEMA);

  // ① 可选依赖探测：缺失即「本插件自动禁用」，绝不冒泡到核心
  const probed = deps.probe();
  if (!probed.ok) {
    logger.warn(`[${PLUGIN_ID}] ${probed.message}`);
    throw taggedError(
      'MISSING_DEPS',
      `${PLUGIN_ID} 已自动禁用：${probed.message}。安装后重载插件即可启用（核心与其它插件不受影响）。`,
    );
  }
  logger.info(`[${PLUGIN_ID}] 可选依赖探测通过：${probed.message}`);

  /** 当前生效的判定参数（节点参数 > 插件配置） */
  function resolveOptions(params = {}) {
    const p = params && typeof params === 'object' ? params : {};
    const nodeMapping = p.levelMapping && typeof p.levelMapping === 'object' ? p.levelMapping : null;
    const configMapping = {
      Porn: config['level.Porn'],
      Hentai: config['level.Hentai'],
      Sexy: config['level.Sexy'],
      Drawing: config['level.Drawing'],
      Neutral: config['level.Neutral'],
    };
    const backend = p.backend || config.backend || 'tfjs-node';
    const resolved = deps.resolveBackend(backend, probed.backends);
    return {
      threshold: numParam(p.threshold !== undefined ? p.threshold : config.threshold, mapping.DEFAULT_THRESHOLD, 0, 1),
      topK: intParam(p.topK !== undefined ? p.topK : config.topK, mapping.DEFAULT_TOP_K, 1, 5),
      levelMapping: mapping.normalizeLevelMapping(nodeMapping || configMapping),
      categoryId: typeof p.categoryId === 'string' && p.categoryId ? p.categoryId : (config.categoryId || mapping.DEFAULT_CATEGORY_ID),
      backend: resolved.id || backend,
      backendRequested: resolved.requested,
      backendFellBack: resolved.fellBack,
      modelPath: typeof p.modelPath === 'string' && p.modelPath ? p.modelPath : (config.modelPath || ''),
      timeoutMs: intParam(p.timeoutMs !== undefined ? p.timeoutMs : config.timeoutMs, 20000, 1000, 120000),
      concurrency: intParam(p.concurrency !== undefined ? p.concurrency : config.concurrency, 2, 1, 8),
      maxBatch: intParam(p.maxBatch !== undefined ? p.maxBatch : config.maxBatch, 16, 1, classifier.MAX_BATCH_IMAGES),
    };
  }

  /**
   * 对一批图片做判定，返回「最严重」的一条 verdict（批量时取最严重者，符合审核语义）。
   * @param {Array<object>} images 图片输入
   * @param {object} options 选项
   * @returns {Promise<object>} ModerationVerdict
   */
  async function evaluateImages(images, options) {
    const list = images.slice(0, options.maxBatch);
    if (list.length === 0) {
      throw taggedError('EMPTY_INPUT', '未收到任何图片数据（payload 需提供 base64 / buffer / pixels）');
    }

    const results = await classifier.classifyBatch(list, {
      backend: options.backend,
      modelPath: options.modelPath,
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
    });

    // 任一张失败 → 整体失败（绝不「部分失败算通过」）
    const failed = results.findIndex((r) => !r || r.ok !== true);
    if (failed >= 0) {
      const detail = results[failed] && results[failed].error ? results[failed].error : '未知错误';
      throw taggedError('CLASSIFY_FAILED', `第 ${failed + 1}/${list.length} 张图片推理失败：${detail}`);
    }

    const verdicts = results.map((r) => mapping.buildVerdict(r.predictions, options));
    let worstIndex = 0;
    for (let i = 1; i < verdicts.length; i++) {
      const a = verdicts[i].verdict.risk_level;
      const b = verdicts[worstIndex].verdict.risk_level;
      if ((mapping.RISK_ORDER[a] || 0) > (mapping.RISK_ORDER[b] || 0)) worstIndex = i;
    }

    const picked = verdicts[worstIndex].verdict;
    if (verdicts.length > 1) {
      return {
        ...picked,
        reason: `批量 ${verdicts.length} 张，最严重为第 ${worstIndex + 1} 张：${picked.reason}`.slice(0, 200),
      };
    }
    return picked;
  }

  /**
   * 统一入口：归一化入参 → 判定。
   * @param {...any} args 原始入参
   * @returns {Promise<object>} ModerationVerdict
   */
  async function handleVerdictImage(...args) {
    const request = normalizeRequest(...args);
    if (!request) {
      throw taggedError('BAD_REQUEST', '无法识别的调用入参（期望 { ref, params, payload }）');
    }
    if (config.enabled === false) {
      // fail-closed：配置里关掉了本通道就不判定，绝不放行（宿主应先按 readinessRpc 把节点判为 skipped）
      throw taggedError('CHANNEL_DISABLED', 'nsfwjs 审图节点已在插件配置中关闭（enabled=false）：请在插件设置中开启，或从拓扑中删除该节点');
    }
    const options = resolveOptions(request.params);
    if (options.backendFellBack) {
      logger.warn(`[${PLUGIN_ID}] 请求的后端 ${options.backendRequested} 不可用，已回退到 ${options.backend}`);
    }
    const images = extractImages(request.payload);
    const totalBytes = images.reduce((sum, img) => sum + bytesOf(img), 0);
    logger.info(`[${PLUGIN_ID}] 开始判定：${images.length} 张，共 ${totalBytes} 字节，后端 ${options.backend}`);
    const verdict = await evaluateImages(images, options);
    logger.info(`[${PLUGIN_ID}] 判定完成：${verdict.risk_level}（confidence=${verdict.confidence}）`);
    return verdict;
  }

  /** 就绪度自报（供宿主注册表 computeReadiness 复用） */
  function status() {
    const ready = probed.ok && config.enabled !== false;
    const notReadyReason = probed.ok ? (config.enabled === false ? 'disabled' : '') : 'missing-deps';
    const notReadyMessage = probed.ok ? (config.enabled === false ? '插件配置中已关闭' : '') : probed.message;
    return {
      ready,
      notReadyReason,
      notReadyMessage,
      installHint: probed.ok ? '' : probed.installHint,
      configHint: '在「图片审核 → nsfwjs-image-guard」调整阈值、后端与类别映射',
      backends: probed.backends,
      availableBackends: probed.availableBackends,
      cache: classifier.cacheState(),
      ref: NODE_REF,
      // 逐节点就绪度（宿主按 ref 精确置灰；单节点插件与顶层值一致）
      nodes: [
        {
          ref: NODE_REF,
          modality: 'image',
          ready,
          notReadyReason,
          notReadyMessage,
          installHint: probed.ok ? '' : probed.installHint,
        },
      ],
    };
  }

  // ② 提供服务（宿主与其它插件可通过 ctx.inject('nsfwjsGuard') 取用）
  ctx.provide('nsfwjsGuard', {
    name: PLUGIN_ID,
    ref: NODE_REF,
    probe: () => deps.probe(),
    status,
    classify: (input, params) => classifier.classify(input, resolveOptions(params)),
    classifyBatch: (inputs, params) => classifier.classifyBatch(inputs, resolveOptions(params)),
    mapPredictions: (predictions, params) => mapping.buildVerdict(predictions, resolveOptions(params)),
    clearModelCache: () => classifier.clearCache(),
    schema: CONFIG_SCHEMA,
    config,
  });

  // ③ 注册能力钩子
  // ★ 始终挂载：配置里的 `enabled` 只决定「节点是否就绪」，由 status().ready=false +
  //   manifest 的 readinessRpc 让宿主把节点判为 skipped；避免出现「节点已注册但无处理器」
  //   的半状态（那种情况下调用会落成 failed/plugin_rejected，把可选的本地通道变成全局拦截）。
  ctx.on('moderation:verdict:image', handleVerdictImage);
  logger.info(`[${PLUGIN_ID}] 已挂载 image.verdict 钩子（节点 ref=${NODE_REF}）`);
  if (config.enabled === false) {
    logger.warn(`[${PLUGIN_ID}] 配置中已关闭（enabled=false）：nsfwjs.status 报 ready=false，宿主据此把该节点判为 skipped`);
  }

  // ④ RPC：状态 / 自检 / 批量 / 配置只读（供 UI 与运维使用，均不含图片内容）
  ctx.rpc('nsfwjs.status', () => status());

  ctx.rpc('nsfwjs.selfTest', async (params = {}) => {
    const options = resolveOptions(params || {});
    // 合成一张 64×64 渐变图（不读磁盘、不打印路径），仅验证「模型可加载 + 推理链路可跑通」
    const width = 64;
    const height = 64;
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        data[i] = Math.round((x / (width - 1)) * 255);
        data[i + 1] = Math.round((y / (height - 1)) * 255);
        data[i + 2] = 128;
      }
    }
    try {
      const res = await classifier.classify({ pixels: { data, width, height } }, options);
      const built = mapping.buildVerdict(res.predictions, options);
      return {
        ok: true,
        backend: res.backend,
        elapsedMs: res.elapsedMs,
        predictions: res.predictions,
        verdict: built.verdict,
      };
    } catch (err) {
      logger.error(`[${PLUGIN_ID}] 自检失败：${err.message}`);
      return { ok: false, backend: options.backend, error: err.message, code: err.code || 'SELFTEST_FAILED' };
    }
  });

  ctx.rpc('nsfwjs.classifyBatch', async (params = {}) => {
    const options = resolveOptions(params || {});
    const images = extractImages(params || {});
    if (images.length === 0) return { ok: false, error: '未提供图片（images / base64 / buffer）' };
    try {
      const results = await classifier.classifyBatch(images.slice(0, options.maxBatch), options);
      return {
        ok: true,
        count: results.length,
        backend: options.backend,
        results: results.map((r) => (r && r.ok
          ? { ok: true, verdict: mapping.buildVerdict(r.predictions, options).verdict }
          : { ok: false, error: (r && r.error) || '推理失败' })),
      };
    } catch (err) {
      logger.error(`[${PLUGIN_ID}] 批量判定失败：${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ctx.rpc('nsfwjs.config', () => ({
    enabled: config.enabled !== false,
    threshold: config.threshold,
    topK: config.topK,
    backend: config.backend,
    modelPath: config.modelPath ? '(已配置)' : '',
    categoryId: config.categoryId,
    levelMapping: {
      Porn: config['level.Porn'],
      Hentai: config['level.Hentai'],
      Sexy: config['level.Sexy'],
      Drawing: config['level.Drawing'],
      Neutral: config['level.Neutral'],
    },
    ref: NODE_REF,
  }));

  // ⑤ 参数界面 schema（manifest.contributes.views[].schemaResolver = 'viewSchema'）
  // 视图 schema 单独放在 lib/view-schema.js，便于单测与依赖缺失时复用
  ctx.rpc('viewSchema', () => buildViewSchema(status(), NODE_REF));

  logger.info(`[${PLUGIN_ID}] 插件已装载（backend=${config.backend || 'tfjs-node'}，threshold=${config.threshold}）`);
}

Object.defineProperty(nsfwjsImageGuard, 'name', { value: PLUGIN_ID, configurable: true });
nsfwjsImageGuard.description = 'nsfwjs 本地 NSFW 五分类审图节点（可选依赖）';
nsfwjsImageGuard.version = '1.0.0';

module.exports = nsfwjsImageGuard;
module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;
module.exports.NODE_REF = NODE_REF;
