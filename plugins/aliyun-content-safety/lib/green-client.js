/**
 * 阿里云绿网客户端（plugins/aliyun-content-safety/lib/green-client.js）
 *
 * 从 `src/content_safety.js` 迁出的「客户端构造 + 响应归一化 + 文本/图片调用 + 文本 MD5 缓存」，
 * 差别只有两点：
 *   ① SDK 一律**惰性加载**（可选依赖机制）：未安装 → 返回 missing-deps，不抛加载期异常；
 *   ② 密钥不再读 `config.contentSafety.*` 明文，而是由调用方（插件 index.js）经
 *      宿主 secrets 白名单注入，本模块只接收装配好的连接参数。
 *
 * ★ 隐私/日志：不打印 AccessKey、不打印送审文本与图片二进制，只打印服务名、建议、耗时、命中标签数。
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

/** 以插件目录为基准的解析器（向上冒泡到工程 node_modules） */
const pluginRequire = createRequire(path.join(__dirname, '..', 'index.js'));

/** 可选依赖包名 */
const SDK_PACKAGE = '@alicloud/green20220302';

/** 安装命令（未装 SDK 时的界面提示） */
const INSTALL_HINT = `npm i ${SDK_PACKAGE}`;

/** 默认连接参数 */
const DEFAULTS = Object.freeze({
  region: 'cn-shanghai',
  endpoint: 'green-cip.cn-shanghai.aliyuncs.com',
  timeout: 10000,
  textServices: ['comment_detection'],
  imageService: 'query_security_check',
});

/** 文本审核结果缓存（绿网按次计费，24h 内相同文本复用结果） */
const _textCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 20000;

/** 绿网标签 → 本系统分类 id（与核心 content_safety.js 保持一致） */
const CATEGORY_MAP = Object.freeze({
  politics: 'political',
  political: 'political',
  porn: 'pornographic',
  pornography: 'pornographic',
  sexy: 'pornographic',
  ad: 'marketing',
  advertisement: 'marketing',
  spam: 'marketing',
  marketing: 'marketing',
  terrorism: 'violence',
  violent: 'violence',
  violence: 'violence',
  abuse: 'abuse',
  insult: 'abuse',
  harassment: 'abuse',
  contraband: 'illegal',
  illegal: 'illegal',
  gambling: 'gambling',
  fraud: 'gambling',
  privacy: 'privacy',
  personal: 'privacy',
  disgusting: 'grotesque',
  grotesque: 'grotesque',
});

// ─── SDK 惰性加载 ───

/** @type {null|{GreenClient: Function, models: object}|false} null=未探测 false=不可用 */
let _sdk = null;

/**
 * 探测并加载 SDK（失败返回 null，不抛异常）。
 * @returns {{GreenClient: Function, models: object}|null} SDK
 */
function loadSdk() {
  if (_sdk && _sdk !== false) return _sdk;
  if (_sdk === false) return null;
  try {
    const GreenClient = pluginRequire(SDK_PACKAGE).default;
    const models = pluginRequire(`${SDK_PACKAGE}/dist/models/model`);
    _sdk = { GreenClient, models };
    return _sdk;
  } catch {
    _sdk = false;
    return null;
  }
}

/**
 * SDK 是否已安装（不抛异常）。
 * @returns {boolean} 是否已安装
 */
function isSdkInstalled() {
  return loadSdk() !== null;
}

/** 重置 SDK 探测缓存（测试或安装后热重载用） */
function resetSdk() {
  _sdk = null;
}

// ─── 文本缓存 ───

/** 文本 MD5（缓存键） */
function textMd5(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex');
}

/**
 * 读缓存。
 * @param {string} key 键
 * @returns {object|null} 结果或 null
 */
function cacheGet(key) {
  const entry = _textCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _textCache.delete(key);
    return null;
  }
  return entry.result;
}

/**
 * 写缓存（LRU 上限保护）。
 * @param {string} key 键
 * @param {object} result 结果
 */
function cacheSet(key, result) {
  if (_textCache.size >= CACHE_MAX) {
    const oldest = _textCache.keys().next().value;
    if (oldest !== undefined) _textCache.delete(oldest);
  }
  _textCache.set(key, { result, ts: Date.now() });
}

/** 清空文本缓存 */
function clearTextCache() {
  const n = _textCache.size;
  _textCache.clear();
  return n;
}

// ─── 客户端 ───

/** @type {object|null} */
let _client = null;
let _clientKey = '';

/**
 * 构造（并缓存）绿网客户端。
 * @param {{accessKeyId: string, accessKeySecret: string, region?: string, endpoint?: string, timeout?: number}} conn 连接参数
 * @returns {object} SDK 客户端
 */
function getClient(conn) {
  const sdk = loadSdk();
  if (!sdk) {
    const err = new Error(`未安装内容安全 SDK（${SDK_PACKAGE}）：${INSTALL_HINT}`);
    err.code = 'MISSING_DEPS';
    throw err;
  }
  const region = conn.region || DEFAULTS.region;
  const endpoint = conn.endpoint || DEFAULTS.endpoint;
  const timeout = Number(conn.timeout) > 0 ? Number(conn.timeout) : DEFAULTS.timeout;
  const key = [conn.accessKeyId, region, endpoint, timeout].join('|');
  if (_client && _clientKey === key) return _client;

  _client = new sdk.GreenClient({
    accessKeyId: conn.accessKeyId,
    accessKeySecret: conn.accessKeySecret,
    regionId: region,
    endpoint,
    connectTimeout: Math.min(timeout, 3000),
    readTimeout: timeout,
  });
  _clientKey = key;
  return _client;
}

// ─── 响应归一化 ───

function toPlain(value) {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * 递归收集响应中的判定条目。
 * @param {any} value 响应片段
 * @param {Array<object>} items 收集结果
 * @param {Set} visited 已访问集合
 * @returns {Array<object>} 条目
 */
function collectResultItems(value, items = [], visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return items;
  visited.add(value);

  const label = String(value.label || value.Label || '').toLowerCase();
  const suggestion = String(value.suggestion || value.Suggestion || '').toLowerCase();
  const level = String(value.level || value.Level || '').toLowerCase();
  const confidence = Number(value.confidence ?? value.Confidence);
  if (label || suggestion || level || Number.isFinite(confidence)) {
    items.push({ label, suggestion, level, confidence });
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectResultItems(child, items, visited);
  }
  return items;
}

/**
 * 归一化绿网响应为统一结构。
 * @param {any} response SDK 响应
 * @param {string} channel 通道（text/image）
 * @param {number} elapsedMs 耗时
 * @returns {object} 归一化结果
 */
function normalizeResponse(response, channel, elapsedMs) {
  const body = toPlain(response && response.body ? response.body : response) || {};
  const code = Number(body.code ?? body.Code ?? (response && response.statusCode) ?? 0);
  const message = body.message || body.Message || '';
  const requestId = body.requestId || body.RequestId || '';

  if (code !== 200) {
    const err = new Error(`阿里云内容安全返回异常：code=${code || 'unknown'}${message ? `, message=${String(message).slice(0, 120)}` : ''}`);
    err.code = 'UPSTREAM_ERROR';
    throw err;
  }

  const data = body.data || body.Data || {};
  const items = collectResultItems(data);
  const suggestions = items.map((item) => item.suggestion).filter(Boolean);
  const globalSuggestion = String(data.suggestion || data.Suggestion || '').toLowerCase();
  const suggestion = globalSuggestion === 'block' || suggestions.includes('block')
    ? 'block'
    : globalSuggestion === 'review' || suggestions.includes('review')
      ? 'review'
      : 'pass';

  const categoryScores = {};
  const categories = new Set();
  const labels = [];
  let maxConfidence = 0;
  for (const item of items) {
    const category = CATEGORY_MAP[item.label];
    if (!category) continue;
    const score = Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(100, Math.round(item.confidence)))
      : suggestion === 'block' ? 85 : 60;
    categoryScores[category] = Math.max(categoryScores[category] || 0, score);
    categories.add(category);
    maxConfidence = Math.max(maxConfidence, score);
    labels.push(item.label);
  }

  // 服务建议拦截但无可映射标签 → 记为通用违法风险，避免结果被静默忽略
  if (suggestion === 'block' && categories.size === 0) {
    categories.add('illegal');
    categoryScores.illegal = 85;
    maxConfidence = 85;
  }

  const confidence = maxConfidence > 0
    ? maxConfidence / 100
    : suggestion === 'pass' ? 1 : suggestion === 'review' ? 0.6 : 0.85;

  return {
    available: true,
    provider: 'aliyun-content-safety',
    channel,
    suggestion,
    categories: Array.from(categories),
    category_scores: categoryScores,
    confidence: Math.round(confidence * 1000) / 1000,
    labels: labels.slice(0, 5),
    request_id: requestId,
    elapsed_ms: elapsedMs,
  };
}

/**
 * 合并多个文本服务的归一化结果（取最高建议/等级，分类分数取最大）。
 * @param {Array<object>} results 各服务结果
 * @param {Array<string>} services 服务名列表
 * @param {number} elapsed 耗时
 * @returns {object} 合并结果
 */
function mergeTextResults(results, services, elapsed) {
  const suggestionOrder = { block: 3, review: 2, pass: 1 };
  let maxSuggestion = 'pass';
  const categoryScores = {};
  const categories = new Set();
  const labels = new Set();
  let maxConfidence = 0;

  for (const r of results) {
    if ((suggestionOrder[r.suggestion] || 0) > (suggestionOrder[maxSuggestion] || 0)) maxSuggestion = r.suggestion;
    for (const [cat, score] of Object.entries(r.category_scores || {})) {
      categoryScores[cat] = Math.max(categoryScores[cat] || 0, score);
    }
    for (const cat of r.categories || []) categories.add(cat);
    for (const label of r.labels || []) labels.add(label);
    maxConfidence = Math.max(maxConfidence, Number(r.confidence) * 100 || 0);
  }

  const confidence = maxConfidence > 0
    ? maxConfidence / 100
    : maxSuggestion === 'pass' ? 1 : maxSuggestion === 'review' ? 0.6 : 0.85;

  return {
    available: true,
    provider: 'aliyun-content-safety',
    channel: 'text',
    services,
    suggestion: maxSuggestion,
    categories: Array.from(categories),
    category_scores: categoryScores,
    confidence: Math.round(confidence * 1000) / 1000,
    labels: [...labels].slice(0, 5),
    elapsed_ms: elapsed,
    merged: true,
  };
}

// ─── 对外调用 ───

/**
 * 文本审核（支持多服务并行）。
 * @param {string} text 文本
 * @param {{conn: object, services?: string[], timeoutMs?: number, maxChars?: number, useCache?: boolean}} options 选项
 * @returns {Promise<object>} 归一化结果
 */
async function moderateText(text, options) {
  const content = String(text || '').slice(0, Number(options.maxChars) > 0 ? Number(options.maxChars) : 2000);
  if (!content.trim()) {
    const err = new Error('送审文本为空');
    err.code = 'EMPTY_INPUT';
    throw err;
  }
  const services = Array.isArray(options.services) && options.services.length > 0
    ? options.services
    : DEFAULTS.textServices;

  const cacheKey = textMd5(content);
  if (options.useCache !== false) {
    const cached = cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true, elapsed_ms: 0 };
  }

  const started = Date.now();
  const sdk = loadSdk();
  if (!sdk) {
    const err = new Error(`未安装内容安全 SDK（${SDK_PACKAGE}）：${INSTALL_HINT}`);
    err.code = 'MISSING_DEPS';
    throw err;
  }

  const settled = await Promise.allSettled(services.map(async (service) => {
    const client = getClient({ ...options.conn, timeout: options.timeoutMs });
    const request = new sdk.models.TextModerationRequest({
      service,
      serviceParameters: JSON.stringify({ content }),
    });
    return client.textModeration(request);
  }));

  const elapsed = Date.now() - started;
  const parsed = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      try {
        const one = normalizeResponse(r.value, 'text', elapsed);
        one.service = services[i];
        parsed.push(one);
      } catch (err) {
        errors.push(`${services[i]}(${err.message})`);
      }
    } else {
      errors.push(`${services[i]}(${r.reason && r.reason.message ? r.reason.message : String(r.reason)})`);
    }
  });

  // 全部服务失败 → 抛错（fail-closed：绝不把「通道故障」当成安全）
  if (parsed.length === 0) {
    const err = new Error(`阿里云内容安全文本审核全部失败：${errors.join('; ')}`);
    err.code = 'ALL_SERVICES_FAILED';
    throw err;
  }

  const merged = parsed.length === 1
    ? { ...parsed[0], services: [parsed[0].service || services[0]] }
    : mergeTextResults(parsed, services, elapsed);
  if (errors.length > 0) merged.partial_errors = errors;
  if (options.useCache !== false) cacheSet(cacheKey, merged);
  return merged;
}

/**
 * 图片审核（Base64 直传，无需落盘或上传 OSS）。
 * @param {string} imageBase64 图片 base64
 * @param {string} caption 附带文本（可空）
 * @param {{conn: object, timeoutMs?: number}} options 选项
 * @returns {Promise<object>} 归一化结果
 */
async function moderateImage(imageBase64, caption, options) {
  const b64 = String(imageBase64 || '');
  if (!b64) {
    const err = new Error('送审图片为空');
    err.code = 'EMPTY_INPUT';
    throw err;
  }
  const sdk = loadSdk();
  if (!sdk) {
    const err = new Error(`未安装内容安全 SDK（${SDK_PACKAGE}）：${INSTALL_HINT}`);
    err.code = 'MISSING_DEPS';
    throw err;
  }

  const started = Date.now();
  const client = getClient({ ...options.conn, timeout: options.timeoutMs });
  const request = new sdk.models.MultiModalGuardForBase64Request({
    service: options.conn.imageService || DEFAULTS.imageService,
    serviceParameters: JSON.stringify(caption ? { content: String(caption).slice(0, 2000) } : {}),
    imageBase64Str: b64,
  });
  const response = await client.multiModalGuardForBase64(request);
  return normalizeResponse(response, 'image', Date.now() - started);
}

module.exports = {
  SDK_PACKAGE,
  INSTALL_HINT,
  DEFAULTS,
  CATEGORY_MAP,
  loadSdk,
  isSdkInstalled,
  resetSdk,
  clearTextCache,
  collectResultItems,
  normalizeResponse,
  mergeTextResults,
  moderateText,
  moderateImage,
};
