/**
 * 能力中介（src/capability-broker.js）
 * R2：核心只认识 broker，插件层只认识注入的 ctx。
 * 插件层启动时把 manifest 声明的能力注册到 broker；核心只查询「有无提供者」并调用
 * broker 的语义化方法。plugins/ 目录清空 → broker 为空 → 返回空结果，
 * 主流程与「无插件」逐字节一致（PLG-01）。
 * v2.2.0：能力注册表改为 `capabilityId → Map(owner → entry)`。
 * 一个能力可被**多个插件**提供（如 `image.verdict` 同时有 keyword-image-guard 与
 * aliyun-content-safety），旧实现用能力 id 作全局键会互相覆盖，导致 `providers()/has()`
 * 误判提供者数量与归属。派发（invokeCall）本来就按 owner 点对点，不受影响。
 * 本文件**不 require 任何 plugin-* / cordis-* 模块**：与插件层的连接通过 setTransport()
 * 注入（由 src/plugin-runtime.js 完成）。核心 require 本文件永远不会拉起插件层。
 * 设计依据：docs/architecture-2026-09-14.md §3.2（R1/R2/R3）；GRS v2.2.0 架构 §4.2 / §8.3
 */
const { CAPABILITIES, DEFAULT_MAX_OUTPUT_BYTES } = require('./host-api/contract');
const eventRegistry = require('./host-api/event-registry');
const gate = require('./host-api/plugin-gate');

/**
 * 能力注册表：capabilityId → Map(owner → { capabilityId, event, mode, pluginId, maxOutputBytes })
 * @type {Map<string, Map<string, object>>}
 */
const _capabilities = new Map();

/** 事件传输层（由 plugin-runtime 注入；未注入时为空实现）*/
let _transport = {
  emitCollect: async () => [],
  emitFirst: async () => undefined,
  emitCall: async () => undefined,
};

/** 是否已被插件层接管*/
let _connected = false;

/**
 * 注入事件传输层（plugin-runtime 调用；核心不会调用）。
 * @param {{emitCollect: Function, emitFirst: Function, emitCall?: Function, hasHandlers?: Function}} transport 传输实现
 */
function setTransport(transport) {
  if (!transport || typeof transport.emitCollect !== 'function' || typeof transport.emitFirst !== 'function') {
    throw new Error('能力中介传输层必须提供 emitCollect / emitFirst');
  }
  _transport = {
    emitCollect: transport.emitCollect,
    emitFirst: transport.emitFirst,
    emitCall: typeof transport.emitCall === 'function' ? transport.emitCall : async () => undefined,
  };
  _connected = true;
}

/** 是否已接入插件层（未接入时所有能力调用走空实现）*/
function isConnected() {
  return _connected;
}

/**
 * 取某能力的 owner → entry 表（不存在返回 null）。
 * @param {string} capabilityId 能力 id
 * @returns {Map<string, object>|null} 内部表
 */
function _byCapability(capabilityId) {
  return _capabilities.get(capabilityId) || null;
}

/**
 * 注册一项能力（幂等，同一 owner 重复注册覆盖）。
 * @param {string} pluginId 插件 id
 * @param {object} capability manifest.contributes.capabilities[i]
 * @returns {{ok: boolean, errors?: string[], event?: string}}
 */
function register(pluginId, capability) {
  const check = eventRegistry.validateCapability(capability);
  if (!check.ok) return check;
  const event = check.event;
  const def = eventRegistry.getEvent(event);
  const entry = {
    capabilityId: capability.id,
    event,
    mode: def.mode,
    pluginId,
    maxOutputBytes: Number(capability.maxOutputBytes) > 0
      ? Number(capability.maxOutputBytes)
      : DEFAULT_MAX_OUTPUT_BYTES,
  };
  let inner = _capabilities.get(capability.id);
  if (!inner) {
    inner = new Map();
    _capabilities.set(capability.id, inner);
  }
  inner.set(pluginId, entry);
  return { ok: true, event };
}

/**
 * 批量注册某插件的全部能力。
 * @param {string} pluginId 插件 id
 * @param {Array<object>} capabilities 能力声明列表
 * @returns {{ok: boolean, errors: string[], registered: string[]}}
 */
function registerAll(pluginId, capabilities) {
  const errors = [];
  const registered = [];
  for (const cap of Array.isArray(capabilities) ? capabilities : []) {
    const res = register(pluginId, cap);
    if (res.ok) registered.push(cap.id);
    else errors.push(...(res.errors || ['能力注册失败']));
  }
  return { ok: errors.length === 0, errors, registered };
}

/**
 * 摘除某插件的全部能力（插件禁用/卸载时调用）。
 * 仅摘除该 owner 的提供者；其它插件对同一能力 id 的提供者保持不变。
 * @param {string} pluginId 插件 id
 * @returns {string[]} 被完全摘除（不再有提供者）的能力 id
 */
function unregisterPlugin(pluginId) {
  const removed = [];
  for (const [capabilityId, inner] of _capabilities.entries()) {
    if (inner.delete(pluginId) && inner.size === 0) {
      _capabilities.delete(capabilityId);
      removed.push(capabilityId);
    }
  }
  return removed;
}

/**
 * 是否至少有一个提供者。
 * @param {string} capabilityId 能力 id
 * @returns {boolean}
 */
function has(capabilityId) {
  const inner = _byCapability(capabilityId);
  return Boolean(inner && inner.size > 0);
}

/**
 * 某 owner 是否提供该能力。
 * @param {string} capabilityId 能力 id
 * @param {string} owner 插件 id
 * @returns {boolean}
 */
function hasOwner(capabilityId, owner) {
  const inner = _byCapability(capabilityId);
  return Boolean(inner && inner.has(owner));
}

/**
 * 列出能力提供者快照（供 /api/plugins 诊断，不暴露实现）。
 * @returns {Array<{capabilityId: string, event: string, mode: string, pluginId: string}>}
 */
function providers() {
  const out = [];
  for (const inner of _capabilities.values()) {
    for (const entry of inner.values()) {
      out.push({
        capabilityId: entry.capabilityId,
        event: entry.event,
        mode: entry.mode,
        pluginId: entry.pluginId,
      });
    }
  }
  return out;
}

/**
 * 解析能力对应的调用上下文：事件名 + gate 参数。
 * @param {string} capabilityId 能力 id
 * @param {string} [owner] 指定 owner（点对点）；未提供时取 maxOutputBytes 最大者
 * @returns {{event: string, maxBytes: number, owner: string}|null}
 */
function resolveCall(capabilityId, owner) {
  const event = eventRegistry.eventOfCapability(capabilityId);
  if (!event) return null;
  const inner = _byCapability(capabilityId);
  if (!inner || inner.size === 0) {
    return { event, maxBytes: DEFAULT_MAX_OUTPUT_BYTES, owner: owner || '(未声明能力)' };
  }
  if (owner && inner.has(owner)) {
    const entry = inner.get(owner);
    return { event, maxBytes: entry.maxOutputBytes, owner };
  }
  // 未指定 owner（或 owner 未注册）：取最宽松的体积上限，保证不误杀合法返回
  let best = null;
  for (const entry of inner.values()) {
    if (!best || entry.maxOutputBytes > best.maxOutputBytes) best = entry;
  }
  return { event, maxBytes: best ? best.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES, owner: owner || (best ? best.pluginId : '(未声明能力)') };
}

/** 插件层是否真的有人监听该事件（无人监听 → 核心走「无插件」快路径）*/
function hasHandlers(event) {
  if (!_connected) return false;
  try {
    return _transport.hasHandlers ? _transport.hasHandlers(event) === true : true;
  } catch {
    return false;
  }
}

/**
 * 收集模式调用：并行执行全部处理器，逐条过 gate，非法条目丢弃并记 plugin_rejected。
 * @param {string} capabilityId 能力 id
 * @param {...any} args 传给钩子的参数
 * @returns {Promise<Array<any>>} 通过 gate 的返回值
 */
async function invokeCollect(capabilityId, ...args) {
  const call = resolveCall(capabilityId);
  if (!call || !hasHandlers(call.event)) return [];
  let raw;
  try {
    raw = await _transport.emitCollect(call.event, ...args);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const res = gate.gateOutput(call.event, item, { maxBytes: call.maxBytes, owner: call.owner });
    if (res.ok) out.push(res.value);
  }
  return out;
}

/**
 * 短路模式调用：首个非空返回值即结果，且必须过 gate；gate 失败视为「无结果」。
 * @param {string} capabilityId 能力 id
 * @param {...any} args 传给钩子的参数
 * @returns {Promise<any>} 通过 gate 的返回值，或 undefined
 */
async function invokeFirst(capabilityId, ...args) {
  const call = resolveCall(capabilityId);
  if (!call || !hasHandlers(call.event)) return undefined;
  let raw;
  try {
    raw = await _transport.emitFirst(call.event, ...args);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw === null) return undefined;
  const res = gate.gateOutput(call.event, raw, {
    maxBytes: call.maxBytes,
    owner: call.owner,
    ctx: args[0] && typeof args[0] === 'object' ? args[0] : {},
  });
  if (!res.ok) return undefined;
  return res.value;
}

/**
 * 点对点调用模式：按 owner 定位唯一提供者，返回过 gate 的判定。
 * 语义（架构 §8.3）：
 * - owner 未提供该能力 / 无处理器 / gate 拒绝 → 返回 undefined
 * - 执行器据此把节点标为 failed（plugin_rejected）或 skipped
 * @param {string} capabilityId 能力 id（text.verdict / image.verdict）
 * @param {string} owner 目标插件 id（点对点定位）
 * @param {object} request 调用载荷
 * @returns {Promise<object|undefined>} 通过 gate 的判定，或 undefined
 */
async function invokeCall(capabilityId, owner, request) {
  if (owner && !hasOwner(capabilityId, owner)) return undefined;
  const call = resolveCall(capabilityId, owner);
  if (!call || !hasHandlers(call.event)) return undefined;
  let raw;
  try {
    raw = await _transport.emitCall(call.event, owner, request);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw === null) return undefined;
  const res = gate.gateOutput(call.event, raw, {
    maxBytes: call.maxBytes,
    owner: owner || call.owner,
    ctx: { source: 'plugin' },
  });
  if (!res.ok) return undefined;
  return res.value;
}

// ─── v2.4.0：请求生命周期钩子（非 verdict-gate；回放可信结果 / 观察副作用）───

/** intercept 返回体积上限（防插件回放超大对象撑爆内存）。*/
const INTERCEPT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 审核前拦截：短路模式派发 moderation:request:intercept。
 * 首个返回「合法形状的可信结果」的插件即短路整条 AI 管线（如去重缓存命中）。
 * 与 invokeFirst 的区别：**不过 verdict 白名单 gate**——回放的是此前已被信任管线产出并校验过的
 * 完整结果（含 gate 会丢弃的请求级字段），故只做体积上限 + 最小形状守卫。
 * 任何异常 / 未接入插件层 / 形状非法 ⇒ 返回 null（核心据此走正常审核，绝不阻断）。
 * @param {object} descriptor 请求描述符 { modality, text, images, cfg, ... }
 * @returns {Promise<object|null>} 命中的可信结果，或 null
 */
async function invokeIntercept(descriptor) {
  const event = eventRegistry.EVENTS.REQUEST_INTERCEPT;
  if (!hasHandlers(event)) return null;
  let raw;
  try {
    raw = await _transport.emitFirst(event, descriptor);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // 最小形状守卫：必须像一个审核结果（有 risk_level 与 passed）
  if (typeof raw.risk_level !== 'string' || typeof raw.passed !== 'boolean') return null;
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(raw), 'utf8'); } catch { return null; }
  if (size > INTERCEPT_MAX_BYTES) return null;
  return raw;
}

/**
 * 判定后观察：收集模式派发 moderation:verdict:observe，供插件做写缓存等副作用。
 * 返回值被忽略；任何异常都吞掉（fail-open，绝不影响审核结果）。
 * @param {object} descriptor 请求描述符
 * @param {object} result 最终审核结果
 * @returns {Promise<void>}
 */
async function notifyObserve(descriptor, result) {
  const event = eventRegistry.EVENTS.VERDICT_OBSERVE;
  if (!hasHandlers(event)) return;
  try {
    await _transport.emitCollect(event, descriptor, result);
  } catch {
    /* fail-open：观察失败绝不影响审核 */
  }
}

// ─── 核心面向的语义化 API（核心只调这些，不认识事件名） ───

/**
 * 收集图片标签贡献（供核心图片审核链路调用）。
 * 插件不存在 / 未就绪 / 全部被 gate 拒绝 → 返回空数组，核心行为与无插件一致。
 * @param {string} imageBase64 base64 图片
 * @returns {Promise<Array<object>>} 各插件的贡献
 */
async function collectImageTags(imageBase64) {
  try {
    return await invokeCollect(CAPABILITIES.IMAGE_TAG, imageBase64);
  } catch {
    return [];
  }
}

/**
 * 解析图片审核联动判定（短路模式，返回值过完整 validateVerdict）。
 * gate 失败 → 返回 undefined，核心回落原判定（PLG-02 / INJ-08）。
 * @param {object} result 当前审核判定
 * @param {Array<object>} contributions 标签贡献
 * @returns {Promise<object|undefined>} 融合后的判定，或 undefined
 */
async function resolveImageLinkage(result, contributions) {
  try {
    return await invokeFirst(CAPABILITIES.IMAGE_LINKAGE, result, contributions);
  } catch {
    return undefined;
  }
}

/** 供测试使用的状态重置*/
function _reset() {
  _capabilities.clear();
  _transport = {
    emitCollect: async () => [],
    emitFirst: async () => undefined,
    emitCall: async () => undefined,
  };
  _connected = false;
}

module.exports = {
  setTransport,
  isConnected,
  register,
  registerAll,
  unregisterPlugin,
  has,
  hasOwner,
  providers,
  resolveCall,
  invokeCollect,
  invokeFirst,
  invokeCall,
  invokeIntercept,
  notifyObserve,
  collectImageTags,
  resolveImageLinkage,
  _reset,
};
