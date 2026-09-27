/**
 * 流程定义 Schema 常量与默认值（src/flow/schema.js）
 * 设计依据：GRS v2.2.0 架构 §5（Flow JSON Schema）与 §7（服务端校验）。
 * 本模块只放常量与纯工厂函数，不含任何 IO / 注册表依赖，便于独立单测。
 */

'use strict';

/** 当前流程定义 schema 版本（不等于 1 一律拒绝加载）*/
const SCHEMA_VERSION = 1;

/** 节点类型枚举*/
const NODE_TYPES = Object.freeze(['input', 'service', 'contribute', 'merge', 'output']);

/** 合并策略枚举*/
const MERGE_STRATEGIES = Object.freeze(['highest', 'lowest', 'priority']);

/** categories 合并方式（union 为 P2/F24，v2.2 接受但不在 UI 暴露）*/
const CATEGORIES_MERGE = Object.freeze(['winner', 'union']);

/** 节点失败策略枚举*/
const FAILURE_POLICIES = Object.freeze(['inherit', 'block', 'review', 'skip']);

/** 模态枚举*/
const MODALITIES = Object.freeze(['text', 'image']);

/** 节点 id 规则*/
const NODE_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;

/** 规模上限（服务端硬拒绝）*/
const LIMITS = Object.freeze({
  maxNodes: 32,
  maxEdges: 64,
  maxDepth: 8,
  maxMerge: 8,
  maxFloors: 4,
  maxFinalizers: 4,
  minTimeoutMs: 100,
  maxTimeoutMs: 300000,
});

/** 缺省单节点超时*/
const DEFAULT_NODE_TIMEOUT_MS = 15000;

/** 缺省整图超时（不含下限层并行等待）*/
const DEFAULT_FLOW_TIMEOUT_MS = 120000;

/** 缺省合并节点超时*/
const DEFAULT_MERGE_TIMEOUT_MS = 1000;

/**
 * 造一个空流程骨架。
 * @param {'text'|'image'} modality 模态
 * @returns {object} 空流程
 */
function emptyFlow(modality) {
  return {
    schemaVersion: SCHEMA_VERSION,
    modality,
    revision: 0,
    updatedAt: new Date().toISOString(),
    floors: [],
    nodes: [],
    edges: [],
    finalizers: [],
    meta: { note: '', sourceOfTruth: true },
  };
}

/**
 * 深拷贝一个流程（避免外部引用污染）。
 * @param {object} flow 流程
 * @returns {object} 拷贝
 */
function cloneFlow(flow) {
  return JSON.parse(JSON.stringify(flow));
}

/**
 * 判定一个流程对象是否「结构上看起来是一个流程」（不判定合法性）。
 * @param {*} flow 待判定值
 * @returns {boolean}
 */
function isFlowShaped(flow) {
  return Boolean(flow) && typeof flow === 'object'
    && flow.schemaVersion === SCHEMA_VERSION
    && Array.isArray(flow.nodes)
    && Array.isArray(flow.edges);
}

module.exports = {
  SCHEMA_VERSION,
  NODE_TYPES,
  MERGE_STRATEGIES,
  CATEGORIES_MERGE,
  FAILURE_POLICIES,
  MODALITIES,
  NODE_ID_RE,
  LIMITS,
  DEFAULT_NODE_TIMEOUT_MS,
  DEFAULT_FLOW_TIMEOUT_MS,
  DEFAULT_MERGE_TIMEOUT_MS,
  emptyFlow,
  cloneFlow,
  isFlowShaped,
};
