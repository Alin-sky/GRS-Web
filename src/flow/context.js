/**
 * 执行上下文与工作上下文（src/flow/context.js）
 * - FlowContext：一次执行的全部状态（payload / meta / work / traces / requestId）。
 * - WorkContext：节点间传递的轻量工作上下文（标签 / 标注 / 证据），供 contribute 写入、
 * 下游节点读取（PRD §4.3「上游标签」）。
 * 每次请求新建，绝不共享；节点不得写全局变量（架构 §6.2 幂等/无共享约定）。
 */

'use strict';

const { riskOrder } = require('./risk');

/**
 * 新建工作上下文。
 * @returns {{tags: string[], labels: string[], evidence: Array<object>}} 工作上下文
 */
function createWorkContext() {
  return { tags: [], labels: [], evidence: [] };
}

/**
 * 新建执行上下文。
 * @param {object} options 选项
 * @param {'text'|'image'} options.modality 模态
 * @param {object} [options.payload] 输入载荷（{text} 或 {imageBase64, caption}）
 * @param {object} [options.meta] 元数据
 * @param {string} [options.requestId] 请求 id
 * @param {string} [options.strictness] 严格程度
 * @returns {object} 执行上下文
 */
function createContext(options = {}) {
  return {
    modality: options.modality || 'text',
    payload: options.payload || {},
    meta: options.meta || {},
    work: createWorkContext(),
    traces: [],
    /**
     * 本请求内各 contribute 节点收集到的**原始插件贡献**。
     * 为什么需要：contribute 节点此前只把「合并后的标签」写进 work，
     * 终裁层（如 WD14 联动）拿不到原始贡献（含 risk/error）⇒ 误判「标签服务不可用」。
     * 每请求新建、绝不共享（架构 §6.2）。
     */
    pluginContributions: [],
    requestId: options.requestId || '',
    strictness: options.strictness || 'standard',
    startedAt: Date.now(),
    /**
     * 追加一条节点轨迹。
     * @param {object} trace 轨迹
     * @returns {object} 轨迹
     */
    addTrace(trace) {
      this.traces.push(trace);
      return trace;
    },
    /**
     * 把贡献写入工作上下文（去重）。
     * @param {{tags?: string[], labels?: string[], evidence?: Array<object>}} contribution 贡献
     * @returns {number} 新增标签数
     */
    mergeWork(contribution) {
      if (!contribution || typeof contribution !== 'object') return 0;
      let added = 0;
      for (const tag of contribution.tags || []) {
        if (typeof tag === 'string' && tag && !this.work.tags.includes(tag)) {
          this.work.tags.push(tag);
          added += 1;
        }
      }
      for (const label of contribution.labels || []) {
        if (typeof label === 'string' && label && !this.work.labels.includes(label)) {
          this.work.labels.push(label);
        }
      }
      for (const item of contribution.evidence || []) {
        if (item && typeof item === 'object') this.work.evidence.push(item);
      }
      return added;
    },
    /**
     * 登记插件贡献原文（供终裁层复用）。非对象条目直接忽略。
     * @param {Array<object>} list 贡献数组
     * @returns {number} 实际登记条数
     */
    addPluginContributions(list) {
      if (!Array.isArray(list)) return 0;
      let n = 0;
      for (const item of list) {
        if (item && typeof item === 'object') { this.pluginContributions.push(item); n += 1; }
      }
      return n;
    },
  };
}

/** 轨迹层归属枚举（v2.3.0）：下限层 / 主管线 / 终裁层。*/
const TRACE_LAYERS = Object.freeze({
  FLOORS: 'floors',
  MAIN: 'main',
  FINALIZERS: 'finalizers',
});

/**
 * 构造一条标准化节点轨迹（不含任何待审核内容）。
 * v2.3.0：新增 `layer`（层归属）与 `declared`（是否在下限层显式声明）两个字段，
 * 供「审核记录 / 文本审核结果」按实际拓扑分层呈现（Req3）。
 * @param {object} result NodeResult
 * @param {'floors'|'main'|'finalizers'} [layer] 层归属，默认 main
 * @returns {object} 轨迹对象
 */
function toTrace(result, layer) {
  if (!result || typeof result !== 'object') return null;
  const owner = result.layer || layer || TRACE_LAYERS.MAIN;
  const trace = {
    node_id: result.nodeId,
    ref: result.ref,
    title: result.title || result.ref,
    layer: owner,
    status: result.status,
    elapsed_ms: Number.isFinite(result.elapsedMs) ? Math.round(result.elapsedMs) : 0,
    failure_type: result.failureType || null,
    skip_reason: result.skipReason || null,
    risk_level: result.verdict ? result.verdict.risk_level : null,
    action: result.verdict ? result.verdict.action || null : null,
    confidence: result.verdict && Number.isFinite(result.verdict.confidence) ? result.verdict.confidence : null,
    cost_hint: result.costHint || null,
    message: result.message || '',
  };
  // 下限层专属：declared=false 表示该层未在 flow.floors 显式声明（核心保底仍在运行）
  if (owner === TRACE_LAYERS.FLOORS) {
    trace.declared = result.declared !== false;
    trace.applied = result.applied === true;
  }
  return trace;
}

/**
 * 构造下限层轨迹（v2.3.0 / Req3）。
 * 背景：下限层（precheck / contentSafety）在 v2.2 里是「核心直接调用 + 只升不降」，
 * 并未经由 DAG 执行器，因此历史记录中**完全没有下限层轨迹**，记录无法反映真实拓扑。
 * 本函数把这两次真实调用投影为带 `layer='floors'` 的轨迹，供前端按层呈现。
 * declared：来自 `flow.floors` 的实际声明，用于区分
 * 「拓扑里配了」与「拓扑里没配、但核心仍在跑」两种情况。
 * v0.1.0（决策 A）：内容安全已插件化，本函数**不再凭空构造它的轨迹**。
 * 下限层里唯一由核心保证的节点是敏感词预检；内容安全若参与执行，它一定显式出现在
 * `flow.nodes` 里（作为 `plugin.*` 服务节点），其轨迹由执行器产出，无需在此处虚构。
 * 历史审核记录里的旧 trace 不受影响——前端按 ref 渲染，展示侧仍然可用。
 * @param {object} opts 选项
 * @param {'text'|'image'} opts.modality 模态
 * @param {object} [opts.precheckResult] precheck() 结果（仅文本）
 * @param {number} [opts.precheckMs] 预检耗时
 * @param {string[]} [opts.declaredRefs] flow.floors 中已声明的 ref 列表
 * @returns {object[]} 轨迹数组
 */
function buildFloorTraces(opts = {}) {
  const declared = new Set(Array.isArray(opts.declaredRefs) ? opts.declaredRefs : []);
  const out = [];

  if (opts.modality === 'text') {
    const hits = (opts.precheckResult && opts.precheckResult.hits) || [];
    const hasHit = Boolean(opts.precheckResult && opts.precheckResult.hasHit);
    let level = 'safe';
    for (const h of hits) {
      if (riskOrder(h && h.level) > riskOrder(level)) level = h.level;
    }
    out.push({
      nodeId: 'floor:pc',
      ref: 'builtin.precheck',
      title: '敏感词预检',
      layer: TRACE_LAYERS.FLOORS,
      status: 'ok',
      elapsedMs: Number.isFinite(opts.precheckMs) ? opts.precheckMs : 0,
      failureType: null,
      skipReason: null,
      verdict: { risk_level: level, action: null, confidence: hasHit ? 1 : 0 },
      costHint: 'free',
      declared: declared.has('builtin.precheck'),
      applied: Boolean(opts.precheckApplied),
      message: hasHit ? `命中 ${hits.length} 个敏感词（含谐音变体）` : '词库未命中',
    });
  }

  return out.map((t) => toTrace(t));
}

module.exports = { createContext, createWorkContext, toTrace, buildFloorTraces, TRACE_LAYERS };
