/**
 * 编排层对外门面（src/flow/index.js）
 * 供三类调用方使用（T03 画布 UI / T04 插件 / src/moderator.js）：
 * - 注册表：registerBuiltins / snapshot
 * - 校验：validateFlow
 * - 执行：runFlow / runFinalizers
 * - 迁移：ensureFlows / getFlow / reconcileFinalizers
 * 本模块是核心可依赖的稳定接口；画布 UI 与插件只通过它与编排层交互。
 */

'use strict';

const schema = require('./schema');
const risk = require('./risk');
const registry = require('./registry');
const validate = require('./validate');
const mergeEngine = require('./merge');
const executor = require('./executor');
const migrate = require('./migrate');
const context = require('./context');
const nodes = require('./nodes');
const adjudicators = require('./adjudicators');
const pathProps = require('./path-props');
const { logWarn } = require('../logger');

/** 确保内置节点已登记（幂等）。*/
function ensureBuiltins() {
  return nodes.registerBuiltins();
}

/**
 * 流程总开关是否启用。
 * @param {object} config 配置
 * @returns {boolean}
 */
function isEnabled(config) {
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows) return false;
  return flows.enabled !== false;
}

/**
 * 取某模态的流程定义（假定 ensureFlows 已执行）。
 * @param {object} config 配置
 * @param {'text'|'image'} modality 模态
 * @returns {object|null} 流程或 null
 */
function getFlow(config, modality) {
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows) return null;
  const flow = flows[modality];
  if (!flow || typeof flow !== 'object') return null;
  return flow;
}

/**
 * 取可用（通过校验）的流程；不合法返回 null（调用方应回退旧引擎）。
 * 用**运行期口径**校验（`{ runtime: true }`，T08 缺陷修复 2026-09-17）：
 * 「插件被禁用/未装载 ⇒ 画布上残留 `plugin.*` 节点」属于**可执行**状态 ——
 * `invokeNode` 会把这些节点按 `skipReason='missing-deps'` 跳过，其余支线照常出判定。
 * 若这里按授权期口径判死，`getValidFlow` 就返回 null ⇒ **整条链路静默退回旧引擎**，
 * 正是 X25/X26 注释里说的「缺一个插件不该把整套编排降级」。
 * 未注册引用会出现在 `validation.warnings[]` 里，不会静默消失。
 * @param {object} config 配置
 * @param {'text'|'image'} modality 模态
 * @returns {{flow: object|null, validation: object}} 结果
 */
function getValidFlow(config, modality) {
  ensureBuiltins();
  const flow = getFlow(config, modality);
  if (!flow) return { flow: null, validation: { ok: false, errors: [{ code: 'E999', message: '流程未迁移' }], warnings: [] } };
  const validation = validate.validateFlow(flow, registry, { runtime: true });
  return { flow: validation.ok ? flow : null, validation };
}

/**
 * 插件装载后对齐图像拓扑的终裁层（两件事，幂等，**只改内存、不改磁盘**）：
 * ① 补齐：`finalizers` 为空且注册表存在 finalize 角色时，把终裁器显式化到拓扑里；
 * ② T08 陈旧回收：`finalizers` 里存在**注册表已无对应终裁器**的 ref（插件被禁用/卸载）
 * 时，把该条从内存移除 + 打 warn。否则 validateFlow 会报 E004_REF_UNKNOWN →
 * `getValidFlow(config,'image')` 返回 null → 整条图像审核链路静默降级旧引擎。
 * 与 `reconcileContentSafetyFloors`（X25）保持对称；磁盘原值保留，插件重新启用后自动恢复。
 * @param {object} config 配置（原地修改，仅内存）
 * @returns {{changed: boolean, added: string[], dropped: string[]}} 结果
 */
function reconcileFinalizers(config) {
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows || !flows.image) return { changed: false, added: [], dropped: [] };
  ensureBuiltins();
  const image = flows.image;
  const existing = Array.isArray(image.finalizers) ? image.finalizers : [];

  if (existing.length === 0) {
    // ① 补齐（沿用原逻辑）
    const registered = registry.listFinalizers('image');
    if (registered.length === 0) return { changed: false, added: [], dropped: [] };
    image.finalizers = registered.map((f) => ({
      ref: f.ref,
      enabled: f.enabled !== false,
      title: f.title || f.ref,
      source: f.owner || '',
      params: {},
    }));
    return { changed: true, added: registered.map((f) => f.ref), dropped: [] };
  }

  // ② T08 陈旧回收：剔除注册表里已不存在的终裁器 ref
  const kept = [];
  const dropped = [];
  for (const item of existing) {
    const ref = item && item.ref;
    if (ref && registry.hasFinalizer(ref)) kept.push(item);
    else dropped.push(ref || '(no-ref)');
  }
  if (dropped.length === 0) return { changed: false, added: [], dropped: [] };

  image.finalizers = kept;
  logWarn('flow', `[X26] 图像拓扑终裁层引用了未注册的终裁器（插件已禁用/卸载），本次启动已从内存剔除：${dropped.join(', ')}`
    + '（磁盘配置未改动，重新启用该插件后自动恢复）');
  return { changed: true, added: [], dropped };
}

/**
 * 内容安全下限层对齐（决策 A 的收口动作）。
 * 背景：v0.1.0 起内容安全只由 `plugins/aliyun-content-safety` 提供，内置节点
 * `builtin.contentSafety` 已下线。但**磁盘上的旧配置仍保留原条目**（数据不丢），
 * 而 `validateFlow` 会校验 floors 的 ref 是否在注册表 → 未注册会产生 E004 →
 * `getValidFlow` 返回 null → 整条链路退回旧引擎。缺一个插件就把整套编排降级是不可接受的。
 * 处置（主理人裁决 B2）：**磁盘保留，本次启动的内存拓扑里做两件事**
 * ① ref 是已下线 ref（或其后继）且后继已注册 → 内存改写为后继 ref（保住功能）
 * ② 后继也没注册 → 本次启动把它从内存 floors 里剔除 + 打 warn（X25 语义）
 * 两种情况都不改磁盘；重新启用插件后下次启动自动恢复。
 * 调用时机：由 src/plugin-runtime.js ⑤ 区（插件装载后）调用；plugins.enabled=false 时同样调用，
 * 否则关闭插件系统会连带把拓扑判成非法。
 * @param {object} config 配置（原地修改，仅内存）
 * @returns {{changed: boolean, rewritten: string[], dropped: string[], advisory: boolean}} 结果
 */
function reconcileContentSafetyFloors(config) {
  const result = { changed: false, rewritten: [], dropped: [], advisory: false };
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows) return result;

  ensureBuiltins();
  const targets = new Set(adjudicators.retiredTargets());

  for (const modality of ['text', 'image']) {
    const flow = flows[modality];
    if (!flow || !Array.isArray(flow.floors) || flow.floors.length === 0) continue;

    const kept = [];
    for (const floor of flow.floors) {
      const ref = floor && floor.ref;
      if (!ref || (!targets.has(ref) && !adjudicators.isRetiredRef(ref))) {
        kept.push(floor);
        continue;
      }
      result.advisory = true;
      const successor = targets.has(ref) ? ref : adjudicators.successorOf(ref, modality);
      if (successor && registry.has(successor)) {
        // 只改一个 ref 字段：id / params / timeoutMs / enabled 全部保留
        kept.push({ ...floor, ref: successor });
        if (successor !== ref) result.rewritten.push(`${modality}:${ref} -> ${successor}`);
        continue;
      }
      result.dropped.push(`${modality}:${ref}`);
    }

    if (kept.length !== flow.floors.length || result.rewritten.length > 0) {
      flow.floors = kept;
      result.changed = true;
    }
  }

  if (result.dropped.length > 0) {
    logWarn('flow', `[X25] 拓扑下限层引用了内容安全节点，但插件未装载，本次启动已从内存剔除：${result.dropped.join(', ')}`
      + '（磁盘配置未改动，启用「阿里云内容安全」插件后自动恢复）');
  }
  if (result.advisory) {
    // 下限层只是历史声明，**不参与执行**：真正的调用必须由画布上的拓扑节点驱动。
    logWarn('flow', '检测到历史的内容安全下限层声明（declaration-only，不参与执行）。'
      + '内容安全已插件化：如需继续生效，请在画布上添加「阿里云内容安全」服务节点并接入通路');
  }
  return result;
}

/**
 * 能力/节点快照（GET /api/flow/capabilities 的唯一数据源）。
 * @param {'text'|'image'} [modality] 模态
 * @returns {object} 快照
 */
function snapshot(modality) {
  ensureBuiltins();
  return registry.snapshot(modality);
}

/**
 * 执行流程。
 * @param {object} flow 流程
 * @param {object} input 输入载荷
 * @param {object} opts 选项
 * @returns {Promise<object>} 执行结果
 */
async function runFlow(flow, input, opts) {
  ensureBuiltins();
  return executor.runFlow(flow, input, opts);
}

/**
 * 取某模态的**已标注流程**：在响应副本上附加只读位 `onPath`（浅克隆，不改内存 config）。
 * 供 `GET /api/flow/:modality` 作为响应体使用 —— 这是唯一在流程上附加 `onPath` 的地方。
 * @param {object} config 配置
 * @param {'text'|'image'} modality 模态
 * @returns {object|null} 已标注流程副本或 null
 */
function getAnnotatedFlow(config, modality) {
  const flow = getFlow(config, modality);
  if (!flow) return null;
  return pathProps.annotateFlow(flow);
}

/**
 * 收集两个模态的**真故障**（已接入通路却未就绪的节点）。
 * 只读：`getFlow` → `pathProps.listFaults`，不写 config、不落盘。
 * @param {object} config 配置
 * @returns {Array<object>} Fault 列表（无故障时为 `[]`）
 */
function collectFaults(config) {
  ensureBuiltins();
  const faults = [];
  for (const modality of ['text', 'image']) {
    const flow = getFlow(config, modality);
    if (!flow) continue;
    faults.push(...pathProps.listFaults(flow, modality, (ref) => registry.get(ref)));
  }
  return faults;
}

module.exports = {
  // 子模块
  schema,
  risk,
  registry,
  validate,
  merge: mergeEngine,
  executor,
  migrate,
  context,
  nodes,
  adjudicators,
  // 语义接口
  ensureBuiltins,
  isEnabled,
  getFlow,
  getValidFlow,
  getAnnotatedFlow,
  collectFaults,
  // 拓扑派生层（只读；转发给 src/flow/path-props.js）
  pathProps,
  annotateFlow: pathProps.annotateFlow,
  orphanIds: pathProps.orphanIds,
  listFaults: pathProps.listFaults,
  stripDerived: pathProps.stripDerived,
  reconcileFinalizers,
  reconcileContentSafetyFloors,
  snapshot,
  runFlow,
  runFinalizers: executor.runFinalizers,
  validateFlow: validate.validateFlow,
  ensureFlows: migrate.ensureFlows,
  retireReviewChannels: migrate.retireReviewChannels,
  backupConfigFile: migrate.backupConfigFile,
};
