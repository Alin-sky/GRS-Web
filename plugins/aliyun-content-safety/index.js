/**
 * 阿里云内容安全插件（plugins/aliyun-content-safety/index.js）
 *
 * 定位：文本 + 图像两个模态各暴露一个**判定型审核节点**（capabilities: `text.verdict` / `image.verdict`），
 *       把原核心内建的绿网调用迁到插件，核心侧退化为兼容垫片（见 src/content_safety.js）。
 *
 * ★ 0 依赖红线（架构 §8.1）：`@alicloud/green20220302` 走**可选依赖**——
 *   未安装 → 宿主置 `missing-deps`，插件不装载、不注册能力，核心冷启动不受影响。
 *
 * ★ 密钥归属（决策 D-7 方案 C）：插件**不复制**核心的 `contentSafety.*` 配置（避免两份真相源），
 *   非密钥字段读宿主 config 投影；AccessKey 经宿主 `secrets` 白名单按需下发明文。
 *   本插件从不打印 AccessKey、送审文本或图片内容。
 *
 * ★ 失败语义（绝不把异常变成放行）：
 *   - 未装 SDK → MISSING_DEPS；未配置/未启用 → NOT_CONFIGURED；通道被关 → CHANNEL_DISABLED；
 *     上游返回异常 / 全部服务失败 / 超时 → 向上抛出。
 *   以上一律由执行器按节点 `failed` → fail-closed 处理，节点不会返回「安全」。
 *   （理想语义是「未配置 → skipped」，需宿主把 manifest 的 `readinessRpc` 接进节点就绪度，见 README。）
 */
'use strict';

const client = require('./lib/green-client');
const { buildViewSchema } = require('./lib/view-schema');

/** 插件 id */
const PLUGIN_ID = 'aliyun-content-safety';

/** 节点 ref */
const NODE_REF_TEXT = 'plugin.aliyun-content-safety.text';
const NODE_REF_IMAGE = 'plugin.aliyun-content-safety.image';

/** 核心配置中的内容安全段（唯一真相源，本插件不复制这些开关） */
const CORE_CONFIG_PATH = 'config.contentSafety.*';

/**
 * 插件自身配置。
 * ★ 只放「插件范围内、与核心不重叠」的项：核心的 enabled / textEnabled / imageEnabled /
 *   accessKeyId 与 accessKeySecret / region / textServices 等一律以 config/default.json 为唯一真相源，不在此重复。
 */
const CONFIG_SCHEMA = {
  name: PLUGIN_ID,
  title: '阿里云内容安全',
  version: '1.0.0',
  description: '阿里云绿网内容安全的审核节点插件（文本 / 图片）。SDK 为可选依赖，未安装或未配置时核心与其它插件均不受影响。开关与密钥请到「审核配置 → 阿里云内容安全配置」维护。',
  groups: [
    { id: 'perf', title: '性能与成本', desc: '文本审核按次计费，缓存可显著降低成本。' },
  ],
  fields: [
    { key: 'cacheEnabled', type: 'boolean', label: '启用文本结果缓存', default: true, group: 'perf',
      desc: '相同文本 24 小时内复用上次云端结果，避免重复计费（关闭后每次均实打云端接口）。' },
    { key: 'logLabels', type: 'boolean', label: '判定理由中列出命中的绿网标签', default: false, group: 'perf',
      desc: '开启后 reason 会带上命中的标签 id（英文枚举，如 porn/politics），便于排查；关闭只报数量。' },
  ],
};

// ─── 工具 ───

/**
 * 归一化调用入参：兼容 (request) 与 (owner, request) 两种 emitCall 约定。
 * @param {...any} args 原始入参
 * @returns {object|null} 请求对象
 */
function normalizeRequest(...args) {
  let best = null;
  for (const arg of args) {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
    if ('payload' in arg || 'params' in arg || 'ref' in arg || 'meta' in arg) best = arg;
  }
  if (best) {
    return {
      ref: best.ref || '',
      params: best.params && typeof best.params === 'object' ? best.params : {},
      payload: best.payload && typeof best.payload === 'object' ? best.payload : {},
      meta: best.meta && typeof best.meta === 'object' ? best.meta : {},
    };
  }
  const first = args.find((a) => typeof a === 'string' && a.length > 0);
  return first ? { ref: '', params: {}, payload: { text: first }, meta: {} } : null;
}

/** 构造带错误码的异常 */
function taggedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 整数参数收敛 */
function intParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 默认「服务建议 → 风险等级」映射 */
const DEFAULT_LEVEL_MAP = Object.freeze({ block: 'high', review: 'medium', pass: 'safe' });

/** 输出允许的风险等级（review 是链路失效态，不由内容判定产出） */
const OUTPUT_LEVELS = Object.freeze(['safe', 'low', 'medium', 'high', 'critical']);

/**
 * 归一化等级映射。
 * @param {object} raw 用户配置
 * @returns {Object<string,string>} 映射
 */
function normalizeLevelMap(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_LEVEL_MAP)) {
    const value = String(src[key] === undefined ? DEFAULT_LEVEL_MAP[key] : src[key]).toLowerCase();
    out[key] = OUTPUT_LEVELS.includes(value) ? value : DEFAULT_LEVEL_MAP[key];
  }
  return out;
}

// ─── 插件主体 ───

/**
 * 插件入口。
 * @param {object} ctx 宿主桥接上下文
 */
function aliyunContentSafety(ctx) {
  const logger = (ctx && ctx.logger) || console;
  const config = ctx.config(CONFIG_SCHEMA);

  /** 核心配置投影（脱敏冻结；密钥字段为 ***，仅用于读开关与 region 等非密钥项） */
  function coreConfig() {
    try {
      if (ctx.host && ctx.host.config) return ctx.host.config;
    } catch { /* 忽略 */ }
    try {
      const injected = typeof ctx.inject === 'function' ? ctx.inject('config', false) : null;
      if (injected && typeof injected === 'object') return injected;
    } catch { /* 忽略 */ }
    return {};
  }

  /**
   * 受控取密钥（宿主 secrets 白名单下发；白名单外/Vault 未注入一律 null）。
   * @param {string} path 配置路径
   * @returns {string|null} 明文或 null
   */
  function secret(path) {
    try {
      const svc = ctx.secrets || (typeof ctx.inject === 'function' ? ctx.inject('secrets', false) : null);
      if (!svc || typeof svc.get !== 'function') return null;
      const value = svc.get(path);
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  /** 是否已被插件装载前的可选依赖探测拦下（正常情况下不会走到这里） */
  const sdkInstalled = client.isSdkInstalled();
  if (!sdkInstalled) {
    logger.warn(`[${PLUGIN_ID}] 未安装可选依赖 ${client.SDK_PACKAGE}（${client.INSTALL_HINT}），插件不可用`);
    throw taggedError('MISSING_DEPS', `${PLUGIN_ID} 已自动禁用：未安装 ${client.SDK_PACKAGE}。安装：${client.INSTALL_HINT}`);
  }

  /**
   * 当前生效设置（核心 config 为唯一真相源 + 宿主 secrets 下发密钥）。
   * @returns {object} 设置
   */
  function settings() {
    const cs = (coreConfig().contentSafety) || {};
    const accessKeyId = secret('contentSafety.accessKeyId');
    const accessKeySecret = secret('contentSafety.accessKeySecret');
    const textServices = Array.isArray(cs.textServices) && cs.textServices.length > 0
      ? cs.textServices.filter(Boolean)
      : (cs.textService ? [cs.textService] : ['comment_detection']);
    return {
      enabled: cs.enabled !== false,
      installed: sdkInstalled,
      accessKeyId,
      accessKeySecret,
      configured: Boolean(accessKeyId && accessKeySecret),
      region: cs.region || 'cn-shanghai',
      endpoint: cs.endpoint || 'green-cip.cn-shanghai.aliyuncs.com',
      timeout: Number(cs.timeout) > 0 ? Number(cs.timeout) : 10000,
      textEnabled: cs.textEnabled !== false,
      imageEnabled: cs.imageEnabled !== false,
      textServices,
      imageService: cs.imageService || 'query_security_check',
      cacheEnabled: config.cacheEnabled !== false,
      logLabels: config.logLabels === true,
    };
  }

  /**
   * 调用前的统一体检：不满足即抛错（fail-closed，绝不静默放行）。
   * @param {'text'|'image'} channel 通道
   * @returns {object} 设置
   */
  function assertCallable(channel) {
    const st = settings();
    if (!st.installed) {
      throw taggedError('MISSING_DEPS', `未安装 ${client.SDK_PACKAGE}，请执行：${client.INSTALL_HINT}`);
    }
    if (!st.enabled) {
      throw taggedError('NOT_CONFIGURED', `内容安全未启用（${CORE_CONFIG_PATH}.enabled=false），请在「审核配置 → 阿里云内容安全配置」开启`);
    }
    if (!st.configured) {
      throw taggedError('NOT_CONFIGURED', `未配置 AccessKey（${CORE_CONFIG_PATH}.accessKeyId / accessKeySecret），请在「审核配置 → 阿里云内容安全配置」填写`);
    }
    if (channel === 'text' && !st.textEnabled) {
      throw taggedError('CHANNEL_DISABLED', '内容安全文本审核已关闭（config.contentSafety.textEnabled=false）');
    }
    if (channel === 'image' && !st.imageEnabled) {
      throw taggedError('CHANNEL_DISABLED', '内容安全图片审核已关闭（config.contentSafety.imageEnabled=false）');
    }
    return st;
  }

  /**
   * 归一化结果 → ModerationVerdict。
   * @param {object} result 客户端归一化结果
   * @param {object} options {levelMap, logLabels}
   * @param {string} channel 通道
   * @returns {object} ModerationVerdict
   */
  function toVerdict(result, options, channel) {
    const levelMap = normalizeLevelMap(options.levelMap);
    const level = levelMap[result.suggestion] || 'safe';
    const labels = Array.isArray(result.labels) ? result.labels : [];
    const services = Array.isArray(result.services) ? result.services.join('/') : 'text';
    const labelText = options.logLabels && labels.length > 0 ? `，标签=${labels.join(',')}` : `，命中标签 ${labels.length} 个`;
    return {
      risk_level: level,
      categories: Array.isArray(result.categories) ? result.categories : [],
      category_scores: result.category_scores && typeof result.category_scores === 'object' ? result.category_scores : {},
      confidence: Number(result.confidence) || 0,
      reason: `阿里云内容安全[${channel}:${services}] suggestion=${result.suggestion}${labelText}，耗时 ${result.elapsed_ms || 0}ms`.slice(0, 200),
      suggestion: level === 'safe'
        ? '云端内容安全未发现风险'
        : `云端内容安全建议 ${result.suggestion}，按 ${level} 等级处置`,
    };
  }

  /** 取节点参数并合并插件配置 */
  function resolveTextOptions(params) {
    const p = params || {};
    return {
      timeoutMs: intParam(p.timeoutMs, settings().timeout, 1000, 60000),
      maxChars: intParam(p.maxChars, 2000, 1, 20000),
      levelMap: p.levelMap || DEFAULT_LEVEL_MAP,
      logLabels: settings().logLabels,
    };
  }

  /** 文本判定节点入口 */
  async function handleVerdictText(...args) {
    const request = normalizeRequest(...args);
    if (!request) throw taggedError('BAD_REQUEST', '无法识别的调用入参（期望 { ref, params, payload }）');
    const st = assertCallable('text');
    const text = typeof request.payload.text === 'string'
      ? request.payload.text
      : (typeof request.payload.content === 'string' ? request.payload.content : '');
    const options = resolveTextOptions(request.params);
    const result = await client.moderateText(text, {
      conn: st,
      services: st.textServices,
      timeoutMs: options.timeoutMs,
      maxChars: options.maxChars,
      useCache: st.cacheEnabled,
    });
    logger.info(`[${PLUGIN_ID}] 文本判定完成：suggestion=${result.suggestion}，服务=${st.textServices.join('/')}，耗时=${result.elapsed_ms}ms`);
    return toVerdict(result, options, 'text');
  }

  /** 图片判定节点入口 */
  async function handleVerdictImage(...args) {
    const request = normalizeRequest(...args);
    if (!request) throw taggedError('BAD_REQUEST', '无法识别的调用入参（期望 { ref, params, payload }）');
    const st = assertCallable('image');
    const payload = request.payload;
    const imageBase64 = typeof payload.imageBase64 === 'string' && payload.imageBase64
      ? payload.imageBase64
      : (typeof payload.image === 'string' ? payload.image : (typeof payload.base64 === 'string' ? payload.base64 : ''));
    const withCaption = request.params.withCaption !== false;
    const caption = withCaption && typeof payload.caption === 'string' ? payload.caption : '';
    const options = { levelMap: request.params.levelMap || DEFAULT_LEVEL_MAP, logLabels: st.logLabels };
    const result = await client.moderateImage(imageBase64, caption, {
      conn: st,
      timeoutMs: intParam(request.params.timeoutMs, st.timeout, 1000, 60000),
    });
    logger.info(`[${PLUGIN_ID}] 图片判定完成：suggestion=${result.suggestion}，耗时=${result.elapsed_ms}ms`);
    return toVerdict(result, options, 'image');
  }

  /** 就绪度自报（供宿主按 manifest 的 readinessRpc 取用） */
  function status() {
    const st = settings();
    const ready = st.installed && st.enabled && st.configured && (st.textEnabled || st.imageEnabled);
    let notReadyReason = '';
    let notReadyMessage = '';
    if (!st.installed) {
      notReadyReason = 'missing-deps';
      notReadyMessage = `未安装 ${client.SDK_PACKAGE}`;
    } else if (!st.enabled) {
      notReadyReason = 'disabled';
      notReadyMessage = '内容安全已关闭（config.contentSafety.enabled=false）';
    } else if (!st.configured) {
      notReadyReason = 'not-configured';
      notReadyMessage = '未配置 AccessKey（config.contentSafety.accessKeyId / accessKeySecret）';
    } else if (!st.textEnabled && !st.imageEnabled) {
      notReadyReason = 'not-configured';
      notReadyMessage = '文本与图片审核均已关闭（textEnabled=false 且 imageEnabled=false）';
    }
    return {
      ready,
      notReadyReason,
      notReadyMessage,
      installHint: st.installed ? '' : client.INSTALL_HINT,
      configHint: '在「审核配置 → 阿里云内容安全配置」维护开关与 AccessKey（本插件不复制这些配置，避免两份真相源）',
      installed: st.installed,
      configured: st.configured,
      enabled: st.enabled,
      textEnabled: st.textEnabled,
      imageEnabled: st.imageEnabled,
      region: st.region,
      endpoint: st.endpoint,
      textServices: st.textServices,
      imageService: st.imageService,
      cacheEnabled: st.cacheEnabled,
      nodes: [
        nodeReadiness(NODE_REF_TEXT, 'text', st),
        nodeReadiness(NODE_REF_IMAGE, 'image', st),
      ],
    };
  }

  /**
   * 逐节点就绪度（供宿主按 ref 精确置灰 / 走 skipped，而不是整插件一刀切）。
   * @param {string} ref 节点 ref
   * @param {'text'|'image'} modality 模态
   * @param {object} st 当前设置
   * @returns {{ref: string, modality: string, ready: boolean, notReadyReason: string, notReadyMessage: string, installHint: string}}
   */
  function nodeReadiness(ref, modality, st) {
    const modalEnabled = modality === 'text' ? st.textEnabled : st.imageEnabled;
    let reason = '';
    let message = '';
    let hint = '';
    if (!st.installed) {
      reason = 'missing-deps';
      message = `未安装 ${client.SDK_PACKAGE}`;
      hint = client.INSTALL_HINT;
    } else if (!st.enabled) {
      reason = 'disabled';
      message = '内容安全已关闭（config.contentSafety.enabled=false）';
    } else if (!st.configured) {
      reason = 'not-configured';
      message = '未配置 AccessKey（config.contentSafety.accessKeyId / accessKeySecret）';
    } else if (!modalEnabled) {
      reason = 'modal-disabled';
      message = modality === 'text'
        ? '文本审核已关闭（config.contentSafety.textEnabled=false）'
        : '图片审核已关闭（config.contentSafety.imageEnabled=false）';
    }
    return {
      ref,
      modality,
      ready: reason === '',
      notReadyReason: reason,
      notReadyMessage: message,
      installHint: hint,
    };
  }

  // ① 提供服务
  ctx.provide('aliyunContentSafety', {
    name: PLUGIN_ID,
    status,
    isSdkInstalled: client.isSdkInstalled,
    moderateText: (text, params) => client.moderateText(text, {
      conn: assertCallable('text'),
      services: settings().textServices,
      timeoutMs: intParam(params && params.timeoutMs, settings().timeout, 1000, 60000),
      maxChars: intParam(params && params.maxChars, 2000, 1, 20000),
      useCache: settings().cacheEnabled,
    }),
    moderateImage: (imageBase64, caption, params) => client.moderateImage(imageBase64, caption, {
      conn: assertCallable('image'),
      timeoutMs: intParam(params && params.timeoutMs, settings().timeout, 1000, 60000),
    }),
    clearTextCache: () => client.clearTextCache(),
    schema: CONFIG_SCHEMA,
    config,
  });

  // ② 挂载两个模态的判定钩子
  ctx.on('moderation:verdict:text', handleVerdictText);
  ctx.on('moderation:verdict:image', handleVerdictImage);
  logger.info(`[${PLUGIN_ID}] 已挂载 text.verdict / image.verdict 钩子（节点 ref=${NODE_REF_TEXT} / ${NODE_REF_IMAGE}）`);
  logger.info(`[${PLUGIN_ID}] 就绪度：${JSON.stringify({ ready: status().ready, reason: status().notReadyReason || 'ready' })}`);

  // ③ RPC
  ctx.rpc('aliyunContentSafety.status', () => status());
  ctx.rpc('aliyunContentSafety.clearCache', () => ({ cleared: client.clearTextCache() }));
  ctx.rpc('aliyunContentSafety.selfTest', async (params = {}) => {
    // 合成一条中性样本（不含任何真实敏感内容），只验证「配置 + SDK + 上游连通性」
    const text = typeof params.text === 'string' && params.text ? params.text : '这是一条用于连通性自检的中性文本。';
    try {
      const st = assertCallable('text');
      const result = await client.moderateText(text, {
        conn: st,
        services: st.textServices,
        timeoutMs: st.timeout,
        maxChars: 2000,
        useCache: false,
      });
      return { ok: true, suggestion: result.suggestion, categories: result.categories, elapsedMs: result.elapsed_ms, services: st.textServices };
    } catch (err) {
      logger.error(`[${PLUGIN_ID}] 自检失败：${err.message}`);
      return { ok: false, code: err.code || 'SELFTEST_FAILED', error: err.message };
    }
  });
  ctx.rpc('aliyunContentSafety.config', () => {
    const st = settings();
    return {
      // 只回显非密钥项；密钥只回「是否已配置」
      enabled: st.enabled,
      textEnabled: st.textEnabled,
      imageEnabled: st.imageEnabled,
      configured: st.configured,
      region: st.region,
      endpoint: st.endpoint,
      textServices: st.textServices,
      imageService: st.imageService,
      cacheEnabled: st.cacheEnabled,
      logLabels: st.logLabels,
      nodes: status().nodes,
    };
  });

  // ④ 参数界面 schema
  ctx.rpc('viewSchema', () => buildViewSchema(status(), { text: NODE_REF_TEXT, image: NODE_REF_IMAGE }));
}

Object.defineProperty(aliyunContentSafety, 'name', { value: PLUGIN_ID, configurable: true });
aliyunContentSafety.description = '阿里云内容安全（文本 / 图片审核节点，SDK 为可选依赖）';
aliyunContentSafety.version = '1.0.0';

module.exports = aliyunContentSafety;
module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;
module.exports.NODE_REF_TEXT = NODE_REF_TEXT;
module.exports.NODE_REF_IMAGE = NODE_REF_IMAGE;
