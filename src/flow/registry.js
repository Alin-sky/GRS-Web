/**
 * 节点/能力注册表（src/flow/registry.js）—— UI 与执行器的**唯一数据源**
 * 设计依据：GRS v2.2.0 架构 §4（节点模型与能力注册表）、§4.3（统一注册与发现流程）。
 * 关键约束：本模块**不认识任何插件名**。内置节点由 nodes/index.js 注册；
 * 插件节点由 src/plugin-scanner.js（生命周期唯一入口）在装载成功后注册进来。
 * 插件系统整体关闭时，注册表里只剩内置节点，执行器行为与「无插件」完全一致。
 */

'use strict';

const contract = require('../host-api/contract');

/** @type {Map<string, object>} ref → 归一化描述符*/
const _nodes = new Map();
/** @type {Map<string, object>} ref → 终裁器描述符*/
const _finalizers = new Map();
/** @type {Map<string, string[]>} owner → 该 owner 注册的 ref 列表（含终裁器）*/
const _byOwner = new Map();
/**
 * @type {Map<string, {ready: boolean, reason: string, installHint: string}>}
 * 运行时就绪度覆盖（由 plugin-scanner 依据 manifest.readinessRpc 异步探测后写入）。
 * 保持 computeReadiness 同步：探测值缓存于此，registry 只做同步读取。
 */
const _readiness = new Map();

/**
 * 归一化一个节点描述符（补齐缺省字段，统一字段形状）。
 * @param {object} raw 原始描述符
 * @returns {object} 归一化描述符
 */
function normalize(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const modality = Array.isArray(d.modality) && d.modality.length > 0 ? d.modality.slice() : ['text', 'image'];
  const role = contract.normalizeRole(d.role);
  return {
    ref: String(d.ref || ''),
    kind: d.kind === 'plugin' ? 'plugin' : 'builtin',
    owner: d.owner || null,
    title: d.title || d.ref || '',
    desc: d.desc || '',
    icon: d.icon || '',

    modality,
    output: d.output || 'ModerationVerdict',
    role,
    defaultCombine: d.defaultCombine || (role === 'contribute' ? 'branch' : 'branch'),
    combineEditable: d.combineEditable === true,
    canParallel: d.canParallel !== false,
    multiInstance: d.multiInstance !== false,

    capability: d.capability || '',
    mode: d.mode || '',

    ready: d.ready !== false,
    _readyFn: typeof d.readyFn === 'function' ? d.readyFn : null,
    notReadyReason: d.notReadyReason || '',
    notReadyMessage: d.notReadyMessage || '',
    installHint: d.installHint || '',
    configHint: d.configHint || '',
    fixAction: d.fixAction || null,
    /** 是否从画布服务面板隐藏（迁移兼容用的内置垫片节点，如 builtin.contentSafety）*/
    hidden: d.hidden === true,
    /** 插件声明的就绪度自检 RPC（由 plugin-scanner 探测后写入 _readiness）*/
    readinessRpc: d.readinessRpc || '',

    params: Array.isArray(d.params) ? d.params.map((p) => ({ ...p })) : [],

    defaultTimeoutMs: Number(d.defaultTimeoutMs) > 0 ? Number(d.defaultTimeoutMs) : 15000,
    failurePolicyOptions: Array.isArray(d.failurePolicyOptions)
      ? d.failurePolicyOptions.slice()
      : ['inherit', 'block', 'review'],
    costHint: d.costHint || 'free',

    // 执行器用的真实运行体（内置节点）/ 调用语义（插件节点）
    _run: typeof d.run === 'function' ? d.run : null,
  };
}

/**
 * 计算某 ref 的当前就绪度。
 * @param {string} ref 节点 ref
 * @returns {{ready: boolean, notReadyReason: string, installHint: string}} 就绪度
 */
function computeReadiness(ref) {
  const node = _nodes.get(ref);
  if (!node) return { ready: false, notReadyReason: 'not-registered', installHint: '' };
  // 探测/自检返回值一律「显式优先」：即使返回空串也尊重它，不回落到节点默认值
  // （否则插件刻意置空的 installHint 会被 `||` 覆盖成 manifest 里的安装命令）。
  const pickStr = (probed, fallback) => (probed === undefined || probed === null ? (fallback || '') : String(probed));
  const probed = _readiness.get(ref);
  if (probed) {
    return {
      ready: probed.ready === true,
      notReadyReason: pickStr(probed.reason, node.notReadyReason),
      installHint: pickStr(probed.installHint, node.installHint),
    };
  }
  if (node._readyFn) {
    try {
      const res = node._readyFn();
      if (res && typeof res === 'object') {
        return {
          ready: res.ready === true,
          notReadyReason: pickStr(res.reason, node.notReadyReason),
          installHint: pickStr(res.installHint, node.installHint),
        };
      }
    } catch {
      return { ready: false, notReadyReason: 'probe-failed', installHint: node.installHint || '' };
    }
  }
  return { ready: node.ready === true, notReadyReason: node.notReadyReason || '', installHint: node.installHint || '' };
}

/**
 * 写入某 ref 的运行时就绪度（plugin-scanner 依据 readinessRpc 探测后调用）。
 * @param {string} ref 节点 ref
 * @param {{ready: boolean, reason?: string, installHint?: string}} value 就绪度
 */
function setReadiness(ref, value) {
  if (!ref || !_nodes.has(ref)) return;
  _readiness.set(ref, {
    ready: value && value.ready === true,
    reason: (value && value.reason) || '',
    installHint: (value && value.installHint) || '',
  });
}

/** 清除某 ref 的运行时就绪度覆盖。*/
function clearReadiness(ref) {
  _readiness.delete(ref);
}

/**
 * 注册一个内置节点描述符。
 * @param {object} descriptor 描述符
 * @returns {object} 归一化描述符
 */
function registerBuiltin(descriptor) {
  const node = normalize({ ...descriptor, kind: 'builtin', owner: null });
  if (!node.ref) throw new Error('内置节点描述符缺少 ref');
  _nodes.set(node.ref, node);
  _bumpOwner(null, node.ref);
  return node;
}

/**
 * 注册某插件（owner）的节点与终裁器。重复注册会先摘除旧项（幂等）。
 * @param {string} owner 插件 id
 * @param {Array<object>} nodes 节点描述符
 * @param {Array<object>} [finalizers] 终裁器描述符
 * @returns {string[]} 本次注册的 ref 列表
 */
function registerPluginNodes(owner, nodes, finalizers = []) {
  if (!owner) throw new Error('注册插件节点必须提供 owner');
  unregisterOwner(owner);
  const refs = [];
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    const node = normalize({ ...raw, kind: 'plugin', owner });
    if (!node.ref) continue;
    _nodes.set(node.ref, node);
    refs.push(node.ref);
  }
  for (const raw of Array.isArray(finalizers) ? finalizers : []) {
    const f = {
      ref: String(raw.ref || ''),
      kind: 'plugin',
      owner,
      role: 'finalize',
      title: raw.title || raw.ref || '',
      modality: Array.isArray(raw.modality) ? raw.modality.slice() : ['image'],
      capability: raw.capability || '',
      mode: raw.mode || 'first',
      enabled: raw.enabled !== false,
      params: Array.isArray(raw.params) ? raw.params.map((p) => ({ ...p })) : [],
      costHint: raw.costHint || 'free',
    };
    if (!f.ref) continue;
    _finalizers.set(f.ref, f);
    refs.push(f.ref);
  }
  _byOwner.set(owner, refs);
  return refs;
}

/**
 * 摘除某 owner 注册的全部节点与终裁器（插件禁用/卸载时调用）。
 * @param {string} owner 插件 id
 * @returns {string[]} 被摘除的 ref
 */
function unregisterOwner(owner) {
  const refs = _byOwner.get(owner) || [];
  for (const ref of refs) {
    _nodes.delete(ref);
    _finalizers.delete(ref);
    _readiness.delete(ref);
  }
  _byOwner.delete(owner);
  return refs;
}

/** 记录 owner（内置为 null 的统一 owner 键）。*/
function _bumpOwner(owner, ref) {
  const key = owner === null ? '__builtin__' : owner;
  const list = _byOwner.get(key) || [];
  if (!list.includes(ref)) list.push(ref);
  _byOwner.set(key, list);
}

/**
 * 取节点描述符（附运行时就绪度）。
 * @param {string} ref 节点 ref
 * @returns {object|null} 描述符副本或 null
 */
function get(ref) {
  const node = _nodes.get(ref);
  if (!node) return null;
  const readiness = computeReadiness(ref);
  return { ...node, ...readiness };
}

/** 是否存在该 ref。*/
function has(ref) {
  return _nodes.has(ref);
}

/** 列出全部节点描述符（附就绪度）。*/
function list() {
  return [..._nodes.keys()].map((ref) => get(ref));
}

/**
 * 按模态过滤节点。
 * @param {'text'|'image'} modality 模态
 * @returns {Array<object>} 描述符列表
 */
function listByModality(modality) {
  return list().filter((n) => n && Array.isArray(n.modality) && n.modality.includes(modality));
}

/**
 * 列出终裁器（可按模态过滤）。
 * @param {'text'|'image'} [modality] 模态
 * @returns {Array<object>} 终裁器描述符
 */
function listFinalizers(modality) {
  const out = [..._finalizers.values()];
  if (!modality) return out.map((f) => ({ ...f }));
  return out.filter((f) => f.modality.includes(modality)).map((f) => ({ ...f }));
}

/** 是否存在该终裁器 ref。*/
function hasFinalizer(ref) {
  return _finalizers.has(ref);
}

/**
 * 注册表快照（供 GET /api/flow/capabilities）。
 * 隐藏迁移兼容用的内置垫片节点（hidden=true），避免与插件节点在面板上重复。
 * @param {'text'|'image'} [modality] 可选模态过滤
 * @returns {{nodes: Array<object>, finalizers: Array<object>, hostApiVersion: string}} 快照
 */
function snapshot(modality) {
  const nodes = (modality ? listByModality(modality) : list()).filter((n) => n && n.hidden !== true);
  return {
    nodes,
    finalizers: listFinalizers(modality),
    hostApiVersion: contract.HOST_API_VERSION,
  };
}

/** 清空注册表（仅供测试）。*/
function reset() {
  _nodes.clear();
  _finalizers.clear();
  _byOwner.clear();
  _readiness.clear();
}

module.exports = {
  registerBuiltin,
  registerPluginNodes,
  unregisterOwner,
  get,
  has,
  list,
  listByModality,
  listFinalizers,
  hasFinalizer,
  computeReadiness,
  setReadiness,
  clearReadiness,
  snapshot,
  reset,
};
