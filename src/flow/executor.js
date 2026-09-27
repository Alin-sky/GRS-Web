/**
 * DAG 执行器（src/flow/executor.js）
 * 设计依据：GRS v2.2.0 架构 §6.2（依赖就绪调度）、§6.3（节点结果三分与 trace）。
 * 采用「依赖就绪调度」而非「严格分层」：快节点不被慢节点阻塞，尾延迟更短。
 * 执行流程：
 * ① 建立依赖表（indeg / dependents）
 * ② runnable 队列 = indeg 0 且非 input（且必须落在 input→output 通路上）
 * ③ 并发执行本批（每节点独立 timeoutMs + AbortSignal）
 * ④ 逐节点记录 NodeTrace
 * ⑤ 解锁后继；队列空后取 output 的入边结果为 trunk
 * ⑥ 由调用方（moderator facade）按 trunk 三分状态做最终装配
 * 未接线节点（孤立）不执行，仅由 validate 以 E009(warn) 提示。
 */

'use strict';

const schema = require('./schema');
const registry = require('./registry');
const nodes = require('./nodes');
const mergeEngine = require('./merge');
const { toTrace, TRACE_LAYERS } = require('./context');
const imagePolicy = require('../image-policy');

/** 带超时的 Promise 竞速。*/
function withTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('node timeout');
      e.failureType = 'timeout';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 建立依赖表并返回可执行节点集合。
 * @param {object} flow 流程
 * @returns {{nodeById: Map, adj: Map, indeg: Map, edgeByTarget: Map, executable: Set}}
 */
function buildGraph(flow) {
  const nodeById = new Map();
  for (const n of flow.nodes) if (n && n.id) nodeById.set(n.id, n);
  const adj = new Map();
  const indeg = new Map();
  const edgeByTarget = new Map();
  for (const id of nodeById.keys()) { adj.set(id, []); indeg.set(id, 0); edgeByTarget.set(id, []); }
  for (const e of flow.edges || []) {
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
    edgeByTarget.get(e.to).push(e);
  }

  const inputId = (flow.nodes.find((n) => n && n.type === 'input') || {}).id || null;
  const outputId = (flow.nodes.find((n) => n && n.type === 'output') || {}).id || null;

  // 可达性：仅在 input→output 通路上的节点参与执行
  const reachFwd = new Set();
  if (inputId) {
    const st = [inputId];
    while (st.length) { const id = st.pop(); if (reachFwd.has(id)) continue; reachFwd.add(id); for (const x of adj.get(id) || []) st.push(x); }
  }
  const reachBack = new Set();
  if (outputId) {
    const st = [outputId];
    const radj = new Map();
    for (const [from, list] of adj.entries()) for (const to of list) { if (!radj.has(to)) radj.set(to, []); radj.get(to).push(from); }
    while (st.length) { const id = st.pop(); if (reachBack.has(id)) continue; reachBack.add(id); for (const x of radj.get(id) || []) st.push(x); }
  }
  const executable = new Set();
  for (const id of nodeById.keys()) {
    const node = nodeById.get(id);
    if (node.type === 'input' || node.type === 'output') continue;
    if (inputId && outputId && !(reachFwd.has(id) && reachBack.has(id))) continue;
    executable.add(id);
  }

  // 有效入度 = 仅统计「可执行的前驱」（input 视为已完成，故不计入）
  for (const id of nodeById.keys()) indeg.set(id, 0);
  for (const e of flow.edges || []) {
    if (executable.has(e.from) && executable.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1);
  }
  return { nodeById, adj, indeg, edgeByTarget, executable, inputId, outputId };
}

/**
 * 执行整张图。
 * @param {object} flow 流程（假定已通过 validateFlow）
 * @param {object} input 输入载荷
 * @param {object} [opts] 选项 { modality, strictness, requestId, precheckHint, signal, flowTimeoutMs }
 * @returns {Promise<object>} 执行结果
 */
async function runFlow(flow, input, opts = {}) {
  const { nodeById, adj, indeg, edgeByTarget, executable, outputId } = buildGraph(flow);
  const modality = opts.modality || flow.modality || 'text';
  const results = new Map();
  const traces = [];

  const controller = new AbortController();
  const flowTimeoutMs = Number(opts.flowTimeoutMs) > 0 ? Number(opts.flowTimeoutMs) : schema.DEFAULT_FLOW_TIMEOUT_MS;
  const globalTimer = setTimeout(() => controller.abort(), flowTimeoutMs);
  if (opts.signal && typeof opts.signal.addEventListener === 'function') {
    opts.signal.addEventListener('abort', () => controller.abort());
  }

  /**
   * 收集某节点的入边分支结果。
   * @param {string} id 节点 id
   * @returns {Array<object>} 分支
   */
  function branchesOf(id) {
    const list = edgeByTarget.get(id) || [];
    const node = nodeById.get(id);
    const orderHint = Array.isArray(node && node.branchOrder) ? node.branchOrder : [];
    return list.map((e, idx) => {
      const upstream = results.get(e.from) || null;
      const orderFromHint = orderHint.indexOf(e.from);
      return {
        nodeId: e.from,
        title: (nodeById.get(e.from) || {}).ref || e.from,
        status: upstream ? upstream.status : 'skipped',
        verdict: upstream ? upstream.verdict : null,
        failureType: upstream ? upstream.failureType : 'unknown',
        failurePolicy: upstream ? upstream.failurePolicy : 'inherit',
        priority: Number.isFinite(e.priority) ? e.priority : 0,
        branchOrder: orderFromHint >= 0 ? orderFromHint : idx,
      };
    });
  }

  /**
   * 执行单个节点并记录结果与轨迹。
   * @param {string} id 节点 id
   * @returns {Promise<void>}
   */
  async function runOne(id) {
    const node = nodeById.get(id);
    const descriptor = registry.get(node.ref) || {};
    const timeoutMs = Number.isFinite(node.timeoutMs) ? node.timeoutMs : descriptor.defaultTimeoutMs;

    if (node.type === 'merge') {
      const branches = branchesOf(id);
      const outcome = mergeEngine.merge(branches, node.strategy, { categoriesMerge: node.categoriesMerge });
      const result = {
        nodeId: id,
        ref: 'merge',
        title: '汇聚',
        status: outcome.status,
        elapsedMs: 0,
        failureType: outcome.status === 'failed' ? (outcome.failure && outcome.failure.failureType) || 'unknown' : null,
        skipReason: outcome.status === 'skipped' ? 'all-skipped' : null,
        verdict: outcome.verdict,
        costHint: 'free',
        message: outcome.reason || '',
        merge: outcome,
        failurePolicy: node.failurePolicy || 'inherit',
      };
      results.set(id, result);
      traces.push(toTrace(result, TRACE_LAYERS.MAIN));
      return;
    }

    // service / contribute：单入边上游
    const upstream = branchesOf(id)[0] || null;
    const runtime = {
      node,
      nodeId: id,
      params: node.params || {},
      ctx: opts.ctx,
      modality,
      strictness: opts.strictness || 'standard',
      precheckHint: opts.precheckHint || '',
      upstream,
    };

    let result;
    try {
      result = await withTimeout(nodes.invokeNode(runtime), timeoutMs);
    } catch (err) {
      result = {
        nodeId: id,
        ref: node.ref,
        title: descriptor.title || node.ref,
        status: 'failed',
        elapsedMs: 0,
        failureType: err && err.failureType ? err.failureType : 'unknown',
        skipReason: null,
        verdict: null,
        costHint: descriptor.costHint || 'free',
        message: err && err.message ? err.message : '节点执行异常',
      };
    }
    result.failurePolicy = node.failurePolicy || 'inherit';
    result.timeoutMs = timeoutMs;
    results.set(id, result);
    traces.push(toTrace(result, TRACE_LAYERS.MAIN));
  }

  try {
    const ready = [...executable].filter((id) => indeg.get(id) === 0);
    const pending = new Set(executable);
    const running = new Map(); // id → Promise

    const launch = (id) => {
      const p = runOne(id).then(() => {
        // 解锁后继（仅对可执行后继计数）
        for (const next of adj.get(id) || []) {
          if (!executable.has(next)) continue;
          indeg.set(next, indeg.get(next) - 1);
          if (indeg.get(next) === 0 && pending.has(next)) {
            pending.delete(next);
            launch(next);
          }
        }
      }).catch(() => { /* 节点异常已在 runOne 内兜底*/ });
      running.set(id, p);
      p.finally(() => running.delete(id));
    };

    for (const id of ready) { pending.delete(id); launch(id); }

    while (running.size > 0) {
      await Promise.race([...running.values()]);
    }

    // 未解锁的节点（理论上=不可达，已被 executable 过滤）
    for (const id of pending) {
      const node = nodeById.get(id);
      const result = {
        nodeId: id, ref: node ? node.ref : id, title: node ? node.ref : id,
        status: 'orphan', elapsedMs: 0, failureType: null, skipReason: 'unreachable',
        verdict: null, costHint: 'free', message: '节点不在 input→output 通路上，未执行',
      };
      results.set(id, result);
      traces.push(toTrace(result, TRACE_LAYERS.MAIN));
    }
  } finally {
    clearTimeout(globalTimer);
  }

  // trunk 结论 = output 的唯一入边来源
  const outputEdges = outputId ? (edgeByTarget.get(outputId) || []) : [];
  const trunkId = outputEdges.length > 0 ? outputEdges[0].from : null;
  const trunk = trunkId ? results.get(trunkId) || null : null;

  const all = [...results.values()];
  const failed = all.filter((r) => r.status === 'failed');
  const skipped = all.filter((r) => r.status === 'skipped');
  const ok = all.filter((r) => r.status === 'ok');
  const orphan = all.filter((r) => r.status === 'orphan');

  // v2.3.0（Req3）：主管线轨迹同步写回 ctx.traces。
  // 此前 `ctx.traces` 只由 `runFinalizers` 写入（见下），导致图片路径
  // `result.node_traces = ctx.traces` 只剩终裁层一条、主管线节点全部丢失。
  // 此处按 nodeId 去重追加，保证同一 `ctx` 多次 runFlow 也不会重复。
  if (opts.ctx && Array.isArray(opts.ctx.traces)) {
    const seen = new Set(opts.ctx.traces.map((t) => t && t.node_id));
    for (const t of traces) {
      if (t && !seen.has(t.node_id)) { opts.ctx.traces.push(t); seen.add(t.node_id); }
    }
  }

  // fail-closed 不变量（架构 §6.2 / §14 R4）：**整图任一真实失败**（failurePolicy !== 'skip'）
  // 即走失败-关闭，绝不能只看 output 直接前驱（trunk）的状态。
  // 反例：input→{A,B}→merge→C→output，A 与 merge 均失败、C 正常时，trunk=C(ok) 但整图必须 fail-closed。
  const realFailures = failed.filter((r) => (r.failurePolicy || 'inherit') !== 'skip');
  let effectiveStatus;
  if (realFailures.length > 0) effectiveStatus = 'failed';
  else if (!trunk) effectiveStatus = 'skipped';
  else if (trunk.status === 'failed') effectiveStatus = 'skipped'; // 仅由 skip 策略降级而来的失败
  else effectiveStatus = trunk.status;

  return {
    ok: effectiveStatus === 'ok',
    status: effectiveStatus,
    trunkStatus: trunk ? trunk.status : 'skipped',
    hasRealFailure: realFailures.length > 0,
    realFailures,
    // 不变量：非 ok 时**不得**暴露可用判定（fail-closed ⇒ verdict===null），
    // 否则任何「只读 verdict、不看 status」的消费方都可能 fail-open。
    // trunk 自身判定另存 trunkVerdict，仅供诊断 / 试运行展示。
    verdict: effectiveStatus === 'ok' && trunk ? trunk.verdict : null,
    trunkVerdict: trunk ? trunk.verdict : null,
    trunkNodeId: trunkId,
    trunk,
    merge: trunk && trunk.merge ? trunk.merge : null,
    results,
    nodeResults: all,
    traces,
    failed,
    skipped,
    okNodes: ok,
    orphans: orphan,
    aborted: controller.signal.aborted,
  };
}

/**
 * 运行终裁层（finalizers）。
 * 不变量：终裁层不得把 fail_closed 结果降为放行。
 * @param {object} flow 流程
 * @param {object} result 已装配的审核结果（原地修改）
 * @param {object} ctx 执行上下文
 * @returns {Promise<object>} 结果
 */
async function runFinalizers(flow, result, ctx) {
  const list = (flow && flow.finalizers) || [];
  if (list.length === 0) return result;
  const broker = require('../capability-broker');
  // v0.2.0（D·WD14 联动开关）：关闭时该终裁器**不执行**，按 skipped 记入 trace。
  // 可逆原则：绝不从磁盘删除 finalizers 配置 —— 重新打开开关即恢复执行。
  // 判据见 image-policy.isWd14LinkageRef（ref 前缀 plugin.wd14-tagger.* / owner===wd14-tagger），
  // 避免误伤其它插件声明的终裁器。
  const wd14LinkageEnabled = imagePolicy.getImagePolicyCfg().useWd14Linkage;
  for (const f of list) {
    if (!f || f.enabled === false) continue;
    const descriptor = registry.get(f.ref) || {};
    if (!wd14LinkageEnabled && imagePolicy.isWd14LinkageRef(f.ref, descriptor)) {
      const started = Date.now();
      ctx.addTrace({
        node_id: `finalize:${f.ref}`,
        ref: f.ref,
        title: f.title || descriptor.title || f.ref,
        layer: TRACE_LAYERS.FINALIZERS,
        status: 'skipped',
        elapsed_ms: Date.now() - started,
        failure_type: null,
        skip_reason: 'wd14-linkage-disabled-by-policy',
        risk_level: null,
        action: null,
        confidence: null,
        cost_hint: descriptor.costHint || 'free',
        message: '图像审核策略已关闭 WD14 联动（可在「系统信息 → 图像审核策略」重新开启，配置未删除、可随时恢复）',
      });
      continue;
    }
    const capability = descriptor.capability || f.capability || 'image.linkage';
    const started = Date.now();
    // T08a：把本请求内 contribute 节点收集到的**原始贡献**透传给终裁层。
    // 此前这里硬编码 `[]` ⇒ WD14 联动永远看不到标签贡献 ⇒ `wd14_status` 恒为 down、
    // `decision_source` 误报「标签服务不可用」。贡献来自 ctx（每请求新建）。
    const contributions = Array.isArray(ctx && ctx.pluginContributions) ? ctx.pluginContributions : [];
    let replacement;
    try {
      replacement = await broker.invokeFirst(capability, result, contributions);
    } catch {
      replacement = undefined;
    }
    const wasFailClosed = result.fail_closed === true;
    const status = (!replacement || typeof replacement !== 'object' || !replacement.risk_level) ? 'skipped' : 'ok';
    if (status === 'ok') {
      // 合并：终裁层可升可降，但 fail_closed 结果不得被降为放行
      if (!wasFailClosed) {
        result.risk_level = replacement.risk_level;
        if (replacement.categories) result.categories = replacement.categories;
        if (replacement.category_scores) result.category_scores = replacement.category_scores;
        if (Number.isFinite(replacement.confidence)) result.confidence = replacement.confidence;
        if (replacement.reason) result.reason = `${result.reason ? `${result.reason}；` : ''}${replacement.reason}`;
        if (replacement.suggestion) result.suggestion = replacement.suggestion;
        result.finalized_by = f.ref;
      } else {
        result.finalizer_skipped_reason = 'fail-closed 结果不允许被终裁层降级';
      }
    }
    ctx.addTrace({
      node_id: `finalize:${f.ref}`,
      ref: f.ref,
      title: f.title || descriptor.title || f.ref,
      layer: TRACE_LAYERS.FINALIZERS,
      status,
      elapsed_ms: Date.now() - started,
      failure_type: null,
      skip_reason: status === 'ok' ? null : 'no-result',
      risk_level: status === 'ok' ? replacement.risk_level : null,
      action: null,
      confidence: null,
      cost_hint: descriptor.costHint || 'free',
      message: status === 'ok' ? '终裁层生效' : '终裁层未产出结果',
    });
  }
  // 不变量断言：fail_closed ⇒ passed!==true 且 confidence===0
  if (result.fail_closed === true) {
    result.passed = false;
    result.error = true;
    result.confidence = 0;
  }
  return result;
}

/**
 * 读取下限层声明（v2.3.0 / Req3）。
 * 定位：下限层语义是「只升不降」，且**不得改变既有判定路径**。
 * precheck 与内容安全的真实调用发生在 moderator（precheck 预先算 hint、
 * 内容安全与主管线并行），因此本函数只做**声明查询**，不产出轨迹；
 * 真实轨迹由 moderator 在拿到结果后用 `context.buildFloorTraces()` 构造
 * （带真实 risk_level / 耗时 / declared / applied）。
 * @param {object} flow 流程
 * @returns {{refs: string[], enabled: object[]}} 已启用的下限层声明
 */
function floorRefs(flow) {
  const list = (flow && flow.floors) || [];
  const enabled = list.filter((f) => f && f.ref && f.enabled !== false);
  return { refs: enabled.map((f) => f.ref), enabled };
}

module.exports = { runFlow, runFinalizers, floorRefs, buildGraph, withTimeout };
