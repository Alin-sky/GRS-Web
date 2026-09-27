/**
 * 拓扑派生层（src/flow/path-props.js）
 * 单一职责：把「内存在跑的真实拓扑」派生为**只读响应位**，供画布渲染与故障告警条消费。
 * 本模块**从不修改入参**：所有函数都返回新对象（浅克隆），因此内存 `config` 永不出现派生字段。
 * 唯一真相红线（架构 §3.1）：
 * - `onPath` **只在响应副本**上附加（`annotateFlow`），**绝不**写入 `config.moderation.flows`；
 * - `PUT /api/flow/:modality` 存盘前必须 `stripDerived()`，把画布可能回传的 `onPath` 摘掉；
 * - 故 `flowSignature()` / `E009` / 节点字段集**零改动**。
 * 图遍历复用 `config-conflicts.onPathNodes`（input 可达 ∩ output 可达），本模块不重写算法。
 * 两轴正交（架构 §3.2）：通路轴（`onPath`）只决定灰显（中性）；就绪轴（`ready`）只决定
 * 「未启用」（中性）vs「不可用」（警示）。**未接入通路**的节点即使未就绪也**不是**故障。
 */

'use strict';

const { onPathNodes } = require('../config-conflicts');

/** 参与「孤岛」判定的节点类型（`input`/`output` 不参与）。*/
const ORPHAN_TYPES = Object.freeze(['service', 'contribute', 'merge']);

/** 参与「真故障」判定的节点类型（`merge` 无 ref ⇒ 无 ready 概念，排除）。*/
const FAULT_TYPES = Object.freeze(['service', 'contribute']);

/** 派生层附加到节点上的字段名（剥离时按此删除）。*/
const DERIVED_NODE_FIELDS = Object.freeze(['onPath', 'onPathCount', 'orphanCount']);

/** 未就绪原因 → 兜底文案（与画布 `NR_FALLBACK` 同源；描述符自带 `notReadyMessage` 时优先）。*/
const REASON_MESSAGE = Object.freeze({
  'missing-deps': '该服务所需的可选依赖未安装，因此处于不可用状态。',
  'not-configured': '该服务尚未完成配置（缺少服务地址或凭据），因此处于不可用状态。',
  'service-unreachable': '无法连接到该服务，请确认服务已启动且地址填写正确。',
  'worddb-empty': '该服务依赖的词库为空，判定结果不可靠。',
  'probe-failed': '就绪度探测过程中发生异常，请检查该服务的配置。',
  'not-registered': '该节点未在服务端注册表中，可能对应插件已卸载。',
  DEFAULT: '该服务当前处于不可用状态。',
});

/** 未就绪原因 → 修复落点（跳转的 Tab）。与画布 `NR_GOTO` 同源。*/
const REASON_GOTO = Object.freeze({ 'worddb-empty': 'worddb' });

/**
 * 计算某模态流程的通路节点集合。
 * @param {object} flow 流程
 * @returns {Set<string>} 通路节点 id 集合
 */
function pathSet(flow) {
  if (!flow || typeof flow !== 'object') return new Set();
  return onPathNodes(flow);
}

/**
 * 在**响应副本**上为每个节点附加只读位 `onPath`（浅克隆，不改入参）。
 * @param {object} flow 流程
 * @returns {object} 新流程对象（`nodes[i]` 均为新对象）
 */
function annotateFlow(flow) {
  if (!flow || typeof flow !== 'object') return flow;
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const onPath = pathSet(flow);
  return {
    ...flow,
    nodes: nodes.map((node) => {
      if (!node || typeof node !== 'object') return node;
      return { ...node, onPath: onPath.has(node.id) };
    }),
  };
}

/**
 * 枚举「孤岛」节点 id：`type ∈ {service, contribute, merge}` 且不在通路上。
 * @param {object} flow 流程
 * @returns {string[]} 孤岛节点 id 列表
 */
function orphanIds(flow) {
  if (!flow || typeof flow !== 'object') return [];
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const onPath = pathSet(flow);
  const out = [];
  for (const node of nodes) {
    if (!node || !node.id || !ORPHAN_TYPES.includes(node.type)) continue;
    if (!onPath.has(node.id)) out.push(node.id);
  }
  return out;
}

/**
 * 计算某未就绪节点的修复动作（服务端下发，前端零推断）。
 * 与画布 `fixActionFor()` 同源：描述符自带 `fixAction` 优先，其次 `installHint`，
 * 再次 `builtin.localModel` / `worddb-empty` 特判，最后兜底跳「审核配置」。
 * @param {object|null} desc 节点描述符（`registry.get()` 的产物）
 * @param {string} ref 节点 ref
 * @returns {{type: string, label: string, payload: string}|null} 修复动作或 null
 */
function fixActionOf(desc, ref) {
  const self = desc && desc.fixAction;
  if (self && typeof self === 'object' && self.type) {
    const type = self.type === 'copy-command' ? 'copy' : self.type;
    const raw = self.payload;
    const payload = typeof raw === 'string' && raw ? raw : ((desc && desc.installHint) || '');
    return { type, label: type === 'copy' ? '复制安装命令' : '前往配置', payload };
  }
  if (!ref) return null;
  if (desc && desc.installHint) return { type: 'copy', label: '复制安装命令', payload: desc.installHint };
  if (String(ref).indexOf('builtin.localModel') === 0) {
    return { type: 'goto', label: '前往「本地模型」', payload: 'models' };
  }
  const reason = desc && (desc.notReadyReason || desc.reason);
  if (reason && REASON_GOTO[reason]) {
    return { type: 'goto', label: '前往「词库管理」', payload: REASON_GOTO[reason] };
  }
  return { type: 'goto', label: '前往「审核配置」', payload: 'flow' };
}

/**
 * 列出某模态拓扑里的**真故障**：已接入通路（`onPath === true`）却未就绪的 service/contribute 节点。
 * 只读：不改入参、不写 config。
 * 与「孤岛」判定条件**不同**（勿合并）：孤岛看通路轴，故障看就绪轴 ∧ 通路轴。
 * @param {object} flow 流程
 * @param {'text'|'image'|string} modality 模态（仅用于回填 fault.modality）
 * @param {(ref: string) => object|null} [resolveDesc] 描述符解析器（通常为 `registry.get`）
 * @returns {Array<object>} Fault 列表（无故障时为 `[]`）
 */
function listFaults(flow, modality, resolveDesc) {
  const faults = [];
  if (!flow || typeof flow !== 'object') return faults;
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const onPath = pathSet(flow);
  const resolve = typeof resolveDesc === 'function' ? resolveDesc : () => null;

  for (const node of nodes) {
    if (!node || !FAULT_TYPES.includes(node.type)) continue;
    const ref = node.ref;
    if (!ref || !onPath.has(node.id)) continue;

    let desc = null;
    try { desc = resolve(ref); } catch { desc = null; }
    if (desc && desc.ready === true) continue;

    const reason = (desc && (desc.notReadyReason || desc.reason)) || 'not-registered';
    const message = (desc && (desc.notReadyMessage || desc.message))
      || REASON_MESSAGE[reason] || REASON_MESSAGE.DEFAULT;

    faults.push({
      modality: modality || '',
      nodeId: node.id,
      ref,
      title: (desc && desc.title) || ref,
      reason,
      message,
      installHint: (desc && desc.installHint) || '',
      configHint: (desc && desc.configHint) || '',
      fixAction: fixActionOf(desc, ref),
    });
  }
  return faults;
}

/**
 * 从流程副本上摘掉派生字段（`PUT` 存盘前调用），保证磁盘永不出现 `onPath`。
 * @param {object} flow 流程（可能带派生字段）
 * @returns {object} 新流程对象（`nodes[i]` 已剔除派生字段）
 */
function stripDerived(flow) {
  if (!flow || typeof flow !== 'object') return flow;
  const out = { ...flow };
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  out.nodes = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    const copy = { ...node };
    for (const field of DERIVED_NODE_FIELDS) delete copy[field];
    return copy;
  });
  return out;
}

module.exports = {
  annotateFlow,
  orphanIds,
  listFaults,
  stripDerived,
  fixActionOf,
  pathSet,
  ORPHAN_TYPES,
  FAULT_TYPES,
  REASON_MESSAGE,
  REASON_GOTO,
  DERIVED_NODE_FIELDS,
};
