/**
 * 审核器注册表 v1（src/flow/adjudicators.js）
 * 定位：**不是第二份真相源**，而是 `flow/registry` 之上的一层**只读投影**。
 * 同一个 Map、同一个 normalize()、同一个 computeReadiness() —— 「画布可用 ⇔ 对比可见」
 * 由结构保证，而不是靠两处同步。
 * 为什么需要它：`flow/registry` 描述的是「拓扑里的一个节点」，而对比 / 一次性调用需要的是
 * 「一个能独立出一次判定的审核器」，两者字段集不同（runner / comparable / costHint 等）。
 * 把这份差异收敛成一个投影函数，避免每个消费方各写一份「哪些 ref 算审核器」的判断。
 * 加载期成本：本模块只在加载期 require `./registry` 与 `../capability-broker`；
 * `../host-api/contract` 等更重的依赖一律**函数内惰性 require**。
 * 依赖方向：核心层模块，不得反向依赖插件层（由 scripts/lint-plugin-boundary.js 把关）。
 */

'use strict';

const registry = require('./registry');
const broker = require('../capability-broker');

/** 注册表结构版本号：字段集合变更时递增，供消费方做形状兜底。*/
const ADJUDICATOR_VERSION = 1;

/**
 * service 角色但不是「可独立出判定的审核器」的 ref。
 * 预检（builtin.precheck）是下限护栏，无法对一段内容给出可与他人交叉对比的独立判定。
 */
const NON_ADJUDICATOR_REFS = Object.freeze(['builtin.precheck']);

/**
 * 已下线 ref → 后继 ref（按模态）。
 * 跨文件约定（架构 §6.2）：核心**不得硬编码任何插件 ref**。本张表是唯一例外——
 * 它承载的是「历史配置迁移」的事实，而不是运行时依赖：表里出现的 ref 永远不会被注册，
 * 只是让历史上存在的 `builtin.contentSafety` 能被识别、被引导到它的继任者。
 */
const RETIRED_REFS = Object.freeze({
  'builtin.contentSafety': {
    text: 'plugin.aliyun-content-safety.text',
    image: 'plugin.aliyun-content-safety.image',
  },
});

/**
 * 核心内置节点 → 内置运行器标识。
 * 内置 ref 由核心自己注册，认识它们不算越界；插件 ref 一律不许出现在这类常量里。
 */
const BUILTIN_RUNNERS = Object.freeze({
  'builtin.localModel': 'localModel',
  'builtin.cloudModel': 'cloudModel',
});

/** @type {Map<string, string[]>} modality → 已勾选的 ref 列表（本期全局一套）*/
const _selected = new Map();

/**
 * 归一化模态取值。
 * @param {string} [modality] 模态
 * @returns {'text'|'image'} 模态
 */
function normModality(modality) {
  return modality === 'image' ? 'image' : 'text';
}

/**
 * 取注册表中的全部节点描述符（异常一律降级为空数组：注册表坏了不能拖垮整个审核链路）。
 * @returns {Array<object>} 节点描述符列表
 */
function allNodes() {
  try {
    return registry.list();
  } catch {
    return [];
  }
}

/**
 * 某节点描述符是否算「一个可独立出判定的审核器」。
 * @param {object} node 节点描述符
 * @returns {boolean} 是否纳入注册表
 */
function isAdjudicatorNode(node) {
  if (!node || !node.ref) return false;
  if (node.role !== 'service') return false;
  if (node.hidden === true) return false;
  if (NON_ADJUDICATOR_REFS.includes(node.ref)) return false;
  return true;
}

/**
 * 决定某 ref 用哪种运行器出一次判定。
 * @param {object} node 节点描述符
 * @returns {'localModel'|'cloudModel'|'pluginVerdict'|null} 运行器标识；null = 无法直接出判定
 */
function runnerOf(node) {
  if (BUILTIN_RUNNERS[node.ref]) return BUILTIN_RUNNERS[node.ref];
  if (node.kind === 'plugin') return 'pluginVerdict';
  return null;
}

/**
 * 把一个注册描述符投影为审核器条目。
 * ready / reason / installHint 一律取自 `registry.computeReadiness()`（唯一入口，不许自己算）。
 * @param {object} node 注册描述符
 * @returns {object} AdjudicatorEntry
 */
function project(node) {
  const readiness = registry.computeReadiness(node.ref);
  const runner = runnerOf(node);
  return {
    ref: node.ref,
    title: node.title || node.ref,
    icon: node.icon || '',
    desc: node.desc || '',
    kind: node.kind === 'plugin' ? 'plugin' : 'builtin',
    owner: node.owner || null,
    modality: Array.isArray(node.modality) ? node.modality.slice() : ['text', 'image'],
    ready: readiness.ready === true,
    reason: readiness.ready ? '' : (readiness.notReadyReason || 'not-registered'),
    installHint: readiness.installHint || '',
    configHint: node.configHint || '',
    costHint: node.costHint || 'free',
    comparable: runner !== null,
    runner,
    /** 能力 id（插件节点的点对点调用凭据；内置节点为空串）。*/
    capability: node.capability || '',
  };
}

/**
 * 枚举某模态的全部审核器（**含未就绪**，供 UI 置灰而非隐藏）。
 * @param {'text'|'image'} [modality] 模态
 * @returns {Array<object>} AdjudicatorEntry 列表
 */
function list(modality) {
  const m = normModality(modality);
  return allNodes()
    .filter((n) => isAdjudicatorNode(n) && Array.isArray(n.modality) && n.modality.includes(m))
    .map(project);
}

/**
 * 取单个审核器条目；未注册 / 不是审核器返回 null。
 * @param {string} ref 节点 ref
 * @returns {object|null} AdjudicatorEntry 或 null
 */
function get(ref) {
  if (!ref || typeof ref !== 'string') return null;
  let node = null;
  try {
    node = registry.get(ref);
  } catch {
    node = null;
  }
  if (!node || !isAdjudicatorNode(node)) return null;
  return project(node);
}

/**
 * 读某模态的已勾选 ref（本期全局一套；缺省为空数组，由上层（对比 UI）写入）。
 * @param {'text'|'image'} [modality] 模态
 * @returns {string[]} ref 列表
 */
function getSelected(modality) {
  const m = normModality(modality);
  const arr = _selected.get(m);
  return Array.isArray(arr) ? arr.slice() : [];
}

/**
 * 写某模态的已勾选 ref（仅内存；持久化由上层负责）。
 * @param {'text'|'image'} [modality] 模态
 * @param {string[]} refs ref 列表
 * @returns {string[]} 写入后的列表
 */
function setSelected(modality, refs) {
  const m = normModality(modality);
  const clean = (Array.isArray(refs) ? refs : []).filter((r) => typeof r === 'string' && r);
  _selected.set(m, clean);
  return clean;
}

/**
 * 完整快照（供 comparisonEngine 与 GET /api/flow/adjudicators）。
 * @param {'text'|'image'} [modality] 模态
 * @returns {{version: number, hostApiVersion: string, modality: string, adjudicators: Array<object>, selected: string[]}} 快照
 */
function snapshot(modality) {
  const m = normModality(modality);
  // 惰性 require：contract 会读 package.json，不必在模块加载期就拉进来
  const contract = require('../host-api/contract');
  return {
    version: ADJUDICATOR_VERSION,
    hostApiVersion: contract.HOST_API_VERSION || '',
    modality: m,
    adjudicators: list(m),
    selected: getSelected(m),
  };
}

/**
 * 构造「未参与」结果。
 * 刻意**不带** `risk_level` / `suggestion`：任何读取方都必须先看 `available` / `skipped`，
 * 绝不因为「没判」就得到一个可以被当作 safe 的默认值（沿用 v2.1.0 的语义）。
 * @param {string} reason 跳过原因码
 * @param {string} provider 提供者标识（可能为 ''）
 * @param {number} started 起始时间戳
 * @returns {object} 与 ContentSafetyShaped 同构的跳过结果
 */
function skippedResult(reason, provider, started) {
  return {
    available: false,
    provider: provider || '',
    skipped: true,
    reason,
    categories: [],
    category_scores: {},
    confidence: 0,
    matched_labels: [],
    elapsed_ms: Math.max(0, Date.now() - started),
  };
}

/**
 * 把插件判定投影回 v2.1.0 的 contentSafetyResult 形状，
 * 确保旧调用方（如下限层叠加、对比探针）读到的字段一个都不少。
 * @param {object} entry 审核器条目
 * @param {object} verdict 插件判定（已过 gate）
 * @param {number} started 起始时间戳
 * @returns {object} ContentSafetyShaped
 */
function shapeVerdict(entry, verdict, started) {
  const level = verdict.risk_level;
  const suggestion = (level === 'high' || level === 'critical')
    ? 'block'
    : (level === 'medium' || level === 'review') ? 'review' : 'pass';
  return {
    available: true,
    provider: entry.owner || 'plugin',
    skipped: false,
    reason: verdict.reason || '',
    suggestion,
    risk_level: level,
    categories: Array.isArray(verdict.categories) ? verdict.categories : [],
    category_scores: verdict.category_scores || {},
    confidence: Number.isFinite(verdict.confidence) ? verdict.confidence : 0.8,
    matched_labels: [],
    elapsed_ms: Math.max(0, Date.now() - started),
  };
}

/**
 * 通用一次性调用（旧场景「按 ref 判一次」的唯一入口）。
 * 语义：
 * - 只对 `kind === 'plugin'` 生效；内置 ref 返回 skipped（builtin-not-invocable）
 * - 失败一律 skipped，**不抛异常、绝不当作 safe**（跳过 / 失败由调用方决定）
 * 注意：此处**不用** `entry.ready` 做前置闸门——就绪度是给 UI 置灰用的提示，
 * 它可能因 readinessRpc 未探测而滞后；真正的可用性由 broker.hasOwner + gate 兜底，
 * 插件自己也会 respond 失败。这样既不会因为一次探测失败就永久关掉通道。
 * @param {string} ref 审核器 ref
 * @param {object} payload 载荷（{text} 或 {imageBase64, caption}）
 * @param {'text'|'image'} [modality] 模态
 * @returns {Promise<object>} ContentSafetyShaped
 */
async function invoke(ref, payload, modality) {
  const started = Date.now();
  const m = normModality(modality);
  const entry = get(ref);
  if (!entry) return skippedResult('not-registered', '', started);
  if (entry.kind !== 'plugin') return skippedResult('builtin-not-invocable', entry.owner || '', started);
  if (!entry.modality.includes(m)) return skippedResult('modality-mismatch', entry.owner || '', started);

  const capability = entry.capability || (m === 'image' ? 'image.verdict' : 'text.verdict');
  if (!broker.hasOwner(capability, entry.owner)) {
    return skippedResult('plugin_disabled', entry.owner || '', started);
  }

  const request = {
    ref: entry.ref,
    params: {},
    payload: payload || {},
    modality: m,
    work: { tags: [], labels: [], evidence: [] },
    meta: { source: 'adjudicators.invoke' },
  };

  let verdict = null;
  try {
    verdict = await broker.invokeCall(capability, entry.owner, request);
  } catch {
    return skippedResult('plugin-error', entry.owner || '', started);
  }
  if (!verdict) return skippedResult('plugin-empty', entry.owner || '', started);
  return shapeVerdict(entry, verdict, started);
}

/**
 * 取已下线 ref 的后继 ref（历史迁移专用）。
 * @param {string} ref 已下线的 ref，如 'builtin.contentSafety'
 * @param {'text'|'image'} [modality] 模态
 * @returns {string|null} 后继 ref；不是已下线 ref 或没有后继时返回 null
 */
function successorOf(ref, modality) {
  if (!ref || typeof ref !== 'string') return null;
  const target = RETIRED_REFS[ref];
  if (!target) return null;
  return target[normModality(modality)] || null;
}

/** 是否属于已下线 ref（永不注册，仅用于识别）。*/
function isRetiredRef(ref) {
  return Boolean(ref) && Object.prototype.hasOwnProperty.call(RETIRED_REFS, ref);
}

/**
 * 全部已下线 ref 的后继 ref 列表（去重）。
 * 用于「这些内容安全 ref 里有没有一个已经装载」这类判断，避免核心各处散落插件 ref 字面量。
 * @returns {string[]} ref 列表
 */
function retiredTargets() {
  const out = [];
  for (const map of Object.values(RETIRED_REFS)) {
    for (const value of Object.values(map || {})) {
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/** 清空内存中的勾选态（仅供测试）。*/
function _resetSelected() {
  _selected.clear();
}

module.exports = {
  ADJUDICATOR_VERSION,
  NON_ADJUDICATOR_REFS,
  RETIRED_REFS,
  BUILTIN_RUNNERS,
  list,
  get,
  snapshot,
  invoke,
  getSelected,
  setSelected,
  successorOf,
  isRetiredRef,
  retiredTargets,
  _resetSelected,
};
