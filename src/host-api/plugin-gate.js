/**
 * 插件输入/输出 gate（src/host-api/plugin-gate.js）
 * R3：插件不可信。插件注册参数、RPC 入参、钩子返回值全部过本模块。
 * 非法即丢弃 + 记 plugin_rejected（可选置插件 error），绝不让插件返回值改变核心判定。
 * 与核心共用同一套输出强校验：ModerationVerdict 走 src/security/output-schema.js 的
 * validateVerdict（与模型输出同一标准，修 C03/C17、覆盖 INJ-08 插件伪造 risk_level）。
 * 本文件**只依赖契约层与 src/security/output-schema.js**，不依赖 Express / cordis / 插件实例。
 */
const {
  DEFAULT_MAX_OUTPUT_BYTES,
  OUTPUT_SCHEMAS,
  CONFIG_DENY_KEYS,
} = require('./contract');
const { outputSchemaOf, modeOf } = require('./event-registry');

/** 插件返回值允许的顶层字段（ModerationTagContribution）*/
const TAG_CONTRIBUTION_ALLOWED_KEYS = Object.freeze([
  'source', 'provider', 'disabled', 'error', 'tags', 'risk',
  'level', 'score', 'labels', 'hits', 'note',
]);

/** 原型污染键：任何层级出现即整条丢弃*/
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** 惰性加载核心输出校验器（T02 产物），失败时退化为本地最小实现*/
let _outputSchema = null;
let _outputSchemaTried = false;
function outputSchemaModule() {
  if (_outputSchemaTried) return _outputSchema;
  _outputSchemaTried = true;
  try {
    _outputSchema = require('../security/output-schema');
  } catch {
    _outputSchema = null;
  }
  return _outputSchema;
}

/** 本地最小兜底：枚举 + 顶层类型（仅在 output-schema.js 不可用时生效）*/
const FALLBACK_RISK_LEVELS = Object.freeze(['safe', 'low', 'medium', 'high', 'critical']);

/** 拒绝计数：event → 次数*/
const _rejections = new Map();
/** 拒绝回调（由 plugin-runtime 注入，用于落审计）*/
let _onReject = null;

/**
 * 注册拒绝回调。
 * @param {(info: {event: string, reason: string, detail: string}) => void} fn 回调
 */
function onReject(fn) {
  _onReject = typeof fn === 'function' ? fn : null;
}

/**
 * 记录一次拒绝并触发回调（回调异常被吞掉，不影响主流程）。
 * @param {string} event 事件名
 * @param {string} reason 拒绝码
 * @param {string} detail 详情
 */
function recordReject(event, reason, detail) {
  const key = event || '(unknown)';
  _rejections.set(key, (_rejections.get(key) || 0) + 1);
  if (_onReject) {
    try {
      _onReject({ event: key, reason, detail });
    } catch { /* 审计失败不影响审核主流程*/ }
  }
}

/** 拒绝统计快照*/
function rejectStats() {
  return Object.fromEntries(_rejections.entries());
}

/** 重置统计（测试用）*/
function resetStats() {
  _rejections.clear();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 值是否为 JSON 可安全序列化的有限结构（含深度与键数上限）*/
function hasForbiddenKey(value, depth = 0) {
  if (depth > 24) return false;
  if (!value || typeof value !== 'object') return false;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) return true;
    if (hasForbiddenKey(value[key], depth + 1)) return true;
  }
  return false;
}

/**
 * 估算 JSON 序列化后的字节数（序列化失败返回 Infinity，视为超限）。
 * @param {any} value 值
 * @returns {number}
 */
function byteSize(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return Infinity;
    return Buffer.byteLength(text, 'utf-8');
  } catch {
    return Infinity;
  }
}

/**
 * 输入 gate：插件 RPC / 钩子入参的基础体检。
 * 只拦截明确危险与超大载荷，不做字段级白名单（避免破坏既有插件调用）。
 * @param {any} params 入参
 * @param {{maxBytes?: number}} [opts] 选项
 * @returns {{ok: true, value: any} | {ok: false, code: string, detail: string}}
 */
function gateInput(params, opts = {}) {
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 8 * 1024 * 1024;
  if (hasForbiddenKey(params)) {
    return { ok: false, code: 'prototype', detail: '入参含原型污染键' };
  }
  const size = byteSize(params);
  if (size > maxBytes) {
    return { ok: false, code: 'too_large', detail: `入参体积 ${size} 字节超过上限 ${maxBytes}` };
  }
  return { ok: true, value: params };
}

/**
 * 审核判定 gate：直接复用核心的 validateVerdict（与模型输出同一标准）。
 * @param {any} raw 插件返回的判定
 * @param {object} [ctx] 校验上下文（categories / nonce / source）
 * @returns {{ok: true, value: object, notes: string[]} | {ok: false, code: string, detail: string}}
 */
function gateVerdict(raw, ctx = {}) {
  const mod = outputSchemaModule();
  if (mod && typeof mod.validateVerdict === 'function') {
    return mod.validateVerdict(raw, { source: 'plugin', ...ctx });
  }
  // 兜底：output-schema.js 不可用时也要挡住伪造枚举
  if (!isPlainObject(raw)) return { ok: false, code: 'schema', detail: '判定必须是 JSON 对象' };
  const level = raw.risk_level;
  if (typeof level !== 'string' || !FALLBACK_RISK_LEVELS.includes(level)) {
    return { ok: false, code: 'enum', detail: `risk_level 缺失或非法（实际为 ${JSON.stringify(level)}）` };
  }
  return { ok: true, value: { ...raw }, notes: ['fallback_validator'] };
}

/**
 * 标签贡献 gate：顶层字段白名单 + 体积上限 + 原型安全。
 * @param {any} raw 插件返回值
 * @param {{maxBytes?: number, owner?: string}} [opts] 选项
 * @returns {{ok: true, value: object, notes: string[]} | {ok: false, code: string, detail: string}}
 */
function gateContribution(raw, opts = {}) {
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_OUTPUT_BYTES;
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'schema', detail: `贡献值应为 JSON 对象，实际为 ${Array.isArray(raw) ? 'array' : typeof raw}` };
  }
  if (hasForbiddenKey(raw)) {
    return { ok: false, code: 'prototype', detail: '贡献值含原型污染键' };
  }
  const notes = [];
  const clean = {};
  for (const key of Object.keys(raw)) {
    if (!TAG_CONTRIBUTION_ALLOWED_KEYS.includes(key)) {
      notes.push(`dropped_field:${key}`);
      continue;
    }
    clean[key] = raw[key];
  }
  if (Object.keys(clean).length === 0) {
    // 字段全被白名单剔除（如只返回 {risk_level:'totally_safe'}）→ 视为无效贡献，直接丢弃
    return { ok: false, code: 'empty', detail: '贡献值在字段白名单过滤后为空' };
  }
  const size = byteSize(clean);
  if (size > maxBytes) {
    return { ok: false, code: 'too_large', detail: `贡献值体积 ${size} 字节超过上限 ${maxBytes}` };
  }
  return { ok: true, value: clean, notes };
}

/**
 * 统一输出 gate：按事件声明的 outputSchema 分派。
 * @param {string} event 事件名
 * @param {any} raw 插件返回值
 * @param {{maxBytes?: number, owner?: string, ctx?: object, silent?: boolean}} [opts] 选项
 * @returns {{ok: true, value: any, notes: string[]} | {ok: false, code: string, detail: string}}
 */
function gateOutput(event, raw, opts = {}) {
  const schema = outputSchemaOf(event);
  let result;
  if (schema === OUTPUT_SCHEMAS.MODERATION_VERDICT) {
    result = gateVerdict(raw, opts.ctx || {});
  } else if (schema === OUTPUT_SCHEMAS.MODERATION_TAG_CONTRIBUTION) {
    result = gateContribution(raw, opts);
  } else {
    // 未在注册表声明的事件：只做原型安全 + 体积体检，保证既有自研事件不被打断
    if (hasForbiddenKey(raw)) {
      result = { ok: false, code: 'prototype', detail: '返回值含原型污染键' };
    } else {
      result = { ok: true, value: raw, notes: modeOf(event) ? [] : ['unregistered_event'] };
    }
  }
  if (!result.ok && !opts.silent) {
    recordReject(event, result.code, `${result.detail}${opts.owner ? `（${opts.owner}）` : ''}`);
  }
  return result;
}

module.exports = {
  TAG_CONTRIBUTION_ALLOWED_KEYS,
  FORBIDDEN_KEYS,
  gateInput,
  gateOutput,
  gateVerdict,
  gateContribution,
  byteSize,
  hasForbiddenKey,
  onReject,
  rejectStats,
  resetStats,
  CONFIG_DENY_KEYS,
};
