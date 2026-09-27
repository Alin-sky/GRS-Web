/**
 * 服务端图校验（src/flow/validate.js）—— 最终权威
 * 设计依据：GRS v2.2.0 架构 §7。
 * 服务端是最终权威；前端只做即时提示。非法图**一律拒绝保存**，
 * 返回 400 + 逐条错误码，**绝不静默降级为默认拓扑**。
 * 错误码：E001–E018（见 §7.1）；E009（孤立节点）为 **warn**。
 */

'use strict';

const schema = require('./schema');
const contract = require('../host-api/contract');

/**
 * 造一个错误项。
 * @param {string} code 错误码
 * @param {string} message 说明
 * @param {string} [path] 定位路径
 * @returns {{code: string, message: string, path: string}} 错误项
 */
function err(code, message, path = '') {
  return { code, message, path };
}

/**
 * 校验单个参数的取值是否符合 paramsSchema。
 * @param {object} spec 参数规格
 * @param {*} value 取值
 * @returns {string} 错误说明（合法返回空串）
 */
function checkParamValue(spec, value) {
  const type = spec.type || 'text';
  if (type === 'switch') {
    return typeof value === 'boolean' ? '' : '应为布尔值';
  }
  if (type === 'number' || type === 'slider') {
    const num = Number(value);
    if (!Number.isFinite(num)) return '应为数字';
    if (Number.isFinite(spec.min) && num < spec.min) return `不得小于 ${spec.min}`;
    if (Number.isFinite(spec.max) && num > spec.max) return `不得大于 ${spec.max}`;
    return '';
  }
  if (type === 'select') {
    if (!Array.isArray(spec.options)) return ''; // optionsFrom 动态来源，跳过
    const allowed = spec.options.map((o) => (o && typeof o === 'object' ? o.value : o));
    return allowed.includes(value) ? '' : `应为 ${allowed.join('|')} 之一`;
  }
  if (type === 'multiselect') {
    if (!Array.isArray(value)) return '应为数组';
    if (!Array.isArray(spec.options)) return '';
    const allowed = spec.options.map((o) => (o && typeof o === 'object' ? o.value : o));
    for (const v of value) {
      if (!allowed.includes(v)) return `含非法值 ${JSON.stringify(v)}`;
    }
    return '';
  }
  if (type === 'level-map') {
    return value && typeof value === 'object' && !Array.isArray(value) ? '' : '应为对象';
  }
  if (type === 'text') {
    return typeof value === 'string' ? '' : '应为字符串';
  }
  return '';
}

/**
 * 用 DFS 三色标记检测环。
 * @param {string[]} ids 节点 id
 * @param {Map<string, string[]>} adj 邻接表
 * @returns {string[]|null} 环路径或 null
 */
function detectCycle(ids, adj) {
  const color = new Map(ids.map((id) => [id, 0]));
  const stack = [];
  const dfs = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) || []) {
      const c = color.get(next);
      if (c === 1) return stack.slice(stack.indexOf(next)).concat(next);
      if (c === 0) {
        const r = dfs(next);
        if (r) return r;
      }
    }
    color.set(id, 2);
    stack.pop();
    return null;
  };
  for (const id of ids) {
    if (color.get(id) === 0) {
      const r = dfs(id);
      if (r) return r;
    }
  }
  return null;
}

/**
 * 校验一个流程定义。
 * 两种口径（T08 缺陷修复，2026-09-17）：
 * - **授权期校验（默认，不传 options）**：未注册的 `nodes[].ref` / `floors[].ref` 报 `errors`。
 * 用于画布编辑、`POST /api/flow/:modality/validate` —— 用户应该把失效引用改对。
 * - **运行期验收（`{ runtime: true }`）**：同样的引用降为 `warnings`（code 仍是
 * `E004_REF_UNKNOWN`），`ok` 不再因此为 false。
 * 用于 `getValidFlow()` 与 `GET /api/flow/:modality`（画布加载）。
 * 为什么必须有运行期口径：`src/flow/nodes/index.js` 的 `invokeNode` 对未注册 descriptor
 * **本来就优雅跳过**（`status:'skipped', skipReason:'missing-deps'`），`config-conflicts` 的
 * X26 告警文案也承诺「这些节点会被跳过」。但校验层把同一件事判成硬错误 ⇒
 * `getValidFlow` 返回 null ⇒ **整条链路静默退回旧引擎**，与执行层承诺自相矛盾。
 * 缺一个插件不该把整套编排降级（与 X25/X26 同一条理由）。
 * @param {object} flow 流程
 * @param {object} [registry] 注册表（默认取 flow/registry）
 * @param {{runtime?: boolean}} [options] 校验口径；`runtime:true` = 运行期验收（见上）
 * @returns {{ok: boolean, errors: Array<object>, warnings: Array<object>}} 校验结果
 */
function validateFlow(flow, registry, options = {}) {
  const reg = registry || require('./registry');
  const runtime = Boolean(options && options.runtime);
  const errors = [];
  const warnings = [];

  // ① E001 结构
  if (!flow || typeof flow !== 'object') {
    return { ok: false, errors: [err('E001_SCHEMA', '流程必须是 JSON 对象')], warnings };
  }
  if (flow.schemaVersion !== schema.SCHEMA_VERSION) {
    errors.push(err('E001_SCHEMA', `schemaVersion 必须为 ${schema.SCHEMA_VERSION}，实际为 ${JSON.stringify(flow.schemaVersion)}`, 'schemaVersion'));
  }
  if (!schema.MODALITIES.includes(flow.modality)) {
    errors.push(err('E001_SCHEMA', `modality 必须为 text|image，实际为 ${JSON.stringify(flow.modality)}`, 'modality'));
  }
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : null;
  const edges = Array.isArray(flow.edges) ? flow.edges : null;
  const floors = Array.isArray(flow.floors) ? flow.floors : [];
  const finalizers = Array.isArray(flow.finalizers) ? flow.finalizers : [];
  if (!nodes) errors.push(err('E001_SCHEMA', 'nodes 必须是数组', 'nodes'));
  if (!edges) errors.push(err('E001_SCHEMA', 'edges 必须是数组', 'edges'));
  if (!nodes || !edges) return { ok: false, errors, warnings };

  const modality = flow.modality;

  // ④ E014 规模
  if (nodes.length > schema.LIMITS.maxNodes) errors.push(err('E014_SCALE', `节点数 ${nodes.length} 超过上限 ${schema.LIMITS.maxNodes}`));
  if (edges.length > schema.LIMITS.maxEdges) errors.push(err('E014_SCALE', `边数 ${edges.length} 超过上限 ${schema.LIMITS.maxEdges}`));
  if (floors.length > schema.LIMITS.maxFloors) errors.push(err('E014_SCALE', `下限层 ${floors.length} 超过上限 ${schema.LIMITS.maxFloors}`));
  if (finalizers.length > schema.LIMITS.maxFinalizers) errors.push(err('E014_SCALE', `终裁层 ${finalizers.length} 超过上限 ${schema.LIMITS.maxFinalizers}`));

  // ② E002 重复 id
  const nodeIds = new Set();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') { errors.push(err('E001_SCHEMA', '节点必须是对象')); continue; }
    if (!n.id || typeof n.id !== 'string' || !schema.NODE_ID_RE.test(n.id)) {
      errors.push(err('E001_SCHEMA', `节点 id 非法：${JSON.stringify(n.id)}（需匹配 ${schema.NODE_ID_RE}）`, 'nodes[].id'));
      continue;
    }
    if (nodeIds.has(n.id)) errors.push(err('E002_DUP_ID', `节点 id 重复：${n.id}`, 'nodes[].id'));
    nodeIds.add(n.id);
    if (!schema.NODE_TYPES.includes(n.type)) {
      errors.push(err('E001_SCHEMA', `节点 ${n.id} 的 type 非法：${JSON.stringify(n.type)}`, `nodes.${n.id}.type`));
    }
  }
  const edgeIds = new Set();
  for (const e of edges) {
    if (!e || typeof e !== 'object') { errors.push(err('E001_SCHEMA', '边必须是对象')); continue; }
    if (!e.id || typeof e.id !== 'string') errors.push(err('E001_SCHEMA', '边必须带字符串 id', 'edges[].id'));
    else if (edgeIds.has(e.id)) errors.push(err('E002_DUP_ID', `边 id 重复：${e.id}`, 'edges[].id'));
    edgeIds.add(e.id);
  }

  // ③ E003 边端点存在
  const nodeById = new Map(nodes.filter((n) => n && n.id).map((n) => [n.id, n]));
  const validEdges = [];
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    if (!nodeById.has(e.from)) errors.push(err('E003_REF_MISSING', `边 ${e.id} 的 from 指向不存在的节点：${e.from}`, `edges.${e.id}.from`));
    if (!nodeById.has(e.to)) errors.push(err('E003_REF_MISSING', `边 ${e.id} 的 to 指向不存在的节点：${e.to}`, `edges.${e.id}.to`));
    if (nodeById.has(e.from) && nodeById.has(e.to)) validEdges.push(e);
  }

  // ⑥ E006 自环 + ⑦ E015 重复边
  const seenPair = new Set();
  for (const e of validEdges) {
    if (e.from === e.to) errors.push(err('E006_SELF_LOOP', `边 ${e.id} 指向自身（${e.from}）`, `edges.${e.id}`));
    const key = `${e.from}->${e.to}`;
    if (seenPair.has(key)) errors.push(err('E015_DUP_EDGE', `重复连线：${key}`, `edges.${e.id}`));
    seenPair.add(key);
  }

  // 邻接表
  const adj = new Map();
  const radj = new Map();
  const indeg = new Map();
  const outdeg = new Map();
  for (const id of nodeIds) { adj.set(id, []); radj.set(id, []); indeg.set(id, 0); outdeg.set(id, 0); }
  for (const e of validEdges) {
    if (e.from === e.to) continue;
    // F2：非法 id 的节点不在 nodeIds 里（L184 未为其建邻接槽），但 nodeById（L161）会收进来，
    // 于是 validEdges 可能带非法端点 → 直接 push 会读到 undefined 抛 TypeError（HTTP 500）。
    // 这里跳过这类边，让邻接运算与 nodeIds 口径一致（非法 id 已由 E001_SCHEMA 报出）。
    if (!adj.has(e.from) || !radj.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    radj.get(e.to).push(e.from);
    outdeg.set(e.from, outdeg.get(e.from) + 1);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }

  // ⑤ E005 环
  const cycle = detectCycle([...nodeIds], adj);
  if (cycle) errors.push(err('E005_CYCLE', `存在环：${cycle.join(' → ')}`));

  // ⑦ E007 input/output 基数
  const inputs = nodes.filter((n) => n && n.type === 'input');
  const outputs = nodes.filter((n) => n && n.type === 'output');
  if (inputs.length !== 1) errors.push(err('E007_INOUT_CARDINALITY', `必须且仅能有 1 个 input 节点，实际 ${inputs.length} 个`, 'nodes'));
  if (outputs.length !== 1) errors.push(err('E007_INOUT_CARDINALITY', `必须且仅能有 1 个 output 节点，实际 ${outputs.length} 个`, 'nodes'));
  for (const n of inputs) {
    if (indeg.get(n.id) > 0) errors.push(err('E007_INOUT_CARDINALITY', `input 节点 ${n.id} 不得有入边`, `nodes.${n.id}`));
    if (outdeg.get(n.id) === 0) errors.push(err('E007_INOUT_CARDINALITY', `input 节点 ${n.id} 至少需要 1 条出边`, `nodes.${n.id}`));
  }
  for (const n of outputs) {
    if (outdeg.get(n.id) > 0) errors.push(err('E007_INOUT_CARDINALITY', `output 节点 ${n.id} 不得有出边`, `nodes.${n.id}`));
    if (indeg.get(n.id) === 0) errors.push(err('E010_OUTPUT_UNCONNECTED', `output 节点 ${n.id} 没有任何入边`, `nodes.${n.id}`));
    else if (indeg.get(n.id) !== 1) errors.push(err('E008_DEGREE', `output 节点 ${n.id} 入度必须为 1，实际 ${indeg.get(n.id)}`, `nodes.${n.id}`));
  }

  // ⑧ E008 度数
  let mergeCount = 0;
  for (const n of nodes) {
    if (!n || !n.id) continue;
    if (n.type === 'service' || n.type === 'contribute') {
      if (indeg.get(n.id) > 1) errors.push(err('E008_DEGREE', `${n.type} 节点 ${n.id} 入度不得超过 1，实际 ${indeg.get(n.id)}（请先添加汇聚节点）`, `nodes.${n.id}`));
      // 完全孤立的节点（入度=出度=0）只由 E009 以 warn 提示，不算度数错误
      if (outdeg.get(n.id) === 0 && indeg.get(n.id) > 0) errors.push(err('E008_DEGREE', `${n.type} 节点 ${n.id} 至少需要 1 条出边`, `nodes.${n.id}`));
    } else if (n.type === 'merge') {
      mergeCount += 1;
      if (indeg.get(n.id) < 2) errors.push(err('E008_DEGREE', `merge 节点 ${n.id} 入度至少为 2，实际 ${indeg.get(n.id)}`, `nodes.${n.id}`));
      if (outdeg.get(n.id) > 1) errors.push(err('E008_DEGREE', `merge 节点 ${n.id} 出度不得超过 1，实际 ${outdeg.get(n.id)}`, `nodes.${n.id}`));
      if (!schema.MERGE_STRATEGIES.includes(n.strategy)) {
        errors.push(err('E017_STRATEGY', `merge 节点 ${n.id} 的 strategy 非法：${JSON.stringify(n.strategy)}`, `nodes.${n.id}.strategy`));
      }
    }
  }
  if (mergeCount > schema.LIMITS.maxMerge) errors.push(err('E014_SCALE', `汇聚节点数 ${mergeCount} 超过上限 ${schema.LIMITS.maxMerge}`));

  // ④ E004/E011/E012/E013/E016/E018 节点 ref / 模态 / 参数 / 策略
  for (const n of nodes) {
    if (!n || !n.id) continue;
    if (n.combine === 'floor') errors.push(err('E018_FLOOR_EDGE', `节点 ${n.id} 标记为 floor，却出现在 nodes 中（应移除并改流入 floors）`, `nodes.${n.id}`));
    if (n.type === 'service' || n.type === 'contribute') {
      if (!n.ref) {
        errors.push(err('E001_SCHEMA', `节点 ${n.id} 缺少 ref`, `nodes.${n.id}.ref`));
        continue;
      }
      const desc = reg.get(n.ref);
      if (!desc) {
        // 运行期口径：未注册节点在 `invokeNode` 里会被跳过（skipReason='missing-deps'）。
        // 降为 warning，否则整条拓扑被判非法 ⇒ getValidFlow 返回 null ⇒ 静默退回旧引擎。
        // 授权期口径仍报 error（画布应提示用户修好这个失效引用）。
        const detail = `节点 ${n.id} 的 ref 未在注册表：${n.ref}（可能依赖缺失或插件已卸载）`;
        if (runtime) warnings.push(err('E004_REF_UNKNOWN', `${detail}；本次执行将跳过该节点（缺失依赖）`, `nodes.${n.id}.ref`));
        else errors.push(err('E004_REF_UNKNOWN', detail, `nodes.${n.id}.ref`));
      } else {
        if (Array.isArray(desc.modality) && !desc.modality.includes(modality)) {
          errors.push(err('E011_MODALITY', `节点 ${n.id} 的服务 ${n.ref} 不支持 ${modality} 模态（支持：${desc.modality.join('|')}）`, `nodes.${n.id}.ref`));
        }
        // 参数白名单 + 类型
        const specs = new Map((desc.params || []).map((p) => [p.key, p]));
        const params = n.params && typeof n.params === 'object' ? n.params : {};
        for (const [key, value] of Object.entries(params)) {
          if (key === '__ackSkipRisk') continue;
          const spec = specs.get(key);
          if (!spec) {
            errors.push(err('E012_PARAM_UNKNOWN', `节点 ${n.id} 的参数 '${key}' 不在 ${n.ref} 的 paramsSchema 中`, `nodes.${n.id}.params.${key}`));
            continue;
          }
          const detail = checkParamValue(spec, value);
          if (detail) errors.push(err('E013_PARAM_TYPE', `节点 ${n.id} 的参数 '${key}' 取值非法：${detail}`, `nodes.${n.id}.params.${key}`));
        }
      }
    }
    if (n.type === 'service' || n.type === 'contribute' || n.type === 'merge') {
      const policy = n.failurePolicy === undefined ? 'inherit' : n.failurePolicy;
      if (!schema.FAILURE_POLICIES.includes(policy)) {
        errors.push(err('E016_POLICY', `节点 ${n.id} 的 failurePolicy 非法：${JSON.stringify(n.failurePolicy)}`, `nodes.${n.id}.failurePolicy`));
      } else if (policy === 'skip' && !(n.params && n.params.__ackSkipRisk === true)) {
        errors.push(err('E016_POLICY', `节点 ${n.id} 使用高危 failurePolicy=skip，需 params.__ackSkipRisk=true 二次确认`, `nodes.${n.id}.failurePolicy`));
      }
      if (n.timeoutMs !== undefined) {
        const t = Number(n.timeoutMs);
        if (!Number.isInteger(t) || t < schema.LIMITS.minTimeoutMs || t > schema.LIMITS.maxTimeoutMs) {
          errors.push(err('E001_SCHEMA', `节点 ${n.id} 的 timeoutMs 必须在 ${schema.LIMITS.minTimeoutMs}-${schema.LIMITS.maxTimeoutMs} 之间`, `nodes.${n.id}.timeoutMs`));
        }
      }
    }
  }

  // floors 校验（ 运行期口径同样降为 warning：floors 是 declaration-only，不参与执行）
  for (const f of floors) {
    if (!f || typeof f !== 'object' || !f.ref) { errors.push(err('E001_SCHEMA', 'floor 项缺少 ref', 'floors[]')); continue; }
    const desc = reg.get(f.ref);
    if (!desc) {
      const detail = `下限层 ref 未在注册表：${f.ref}`;
      if (runtime) warnings.push(err('E004_REF_UNKNOWN', `${detail}（声明层不参与执行，已忽略）`, `floors.${f.id || f.ref}.ref`));
      else errors.push(err('E004_REF_UNKNOWN', detail, `floors.${f.id || f.ref}.ref`));
      continue;
    }
    if (Array.isArray(desc.modality) && !desc.modality.includes(modality)) {
      errors.push(err('E011_MODALITY', `下限层 ${f.ref} 不支持 ${modality} 模态`, `floors.${f.id || f.ref}`));
    }
  }

  // finalizers 校验（ 两种口径下都保持 error：陈旧 finalizer ref 由 X26
  // `reconcileFinalizers` 在启动/插件变更时回收，能残留下来说明回收没生效，属真问题）
  for (const f of finalizers) {
    if (!f || typeof f !== 'object' || !f.ref) { errors.push(err('E001_SCHEMA', 'finalizer 项缺少 ref', 'finalizers[]')); continue; }
    if (!reg.hasFinalizer(f.ref)) {
      errors.push(err('E004_REF_UNKNOWN', `终裁层 ref 未注册为 finalize 角色：${f.ref}`, `finalizers.${f.ref}`));
    }
  }

  // ⑨ E009 可达性（warn）+ E014 深度
  const inputId = inputs.length === 1 ? inputs[0].id : null;
  const outputId = outputs.length === 1 ? outputs[0].id : null;
  if (inputId && outputId && !cycle) {
    const reachFwd = new Set();
    const stackF = [inputId];
    while (stackF.length) {
      const id = stackF.pop();
      if (reachFwd.has(id)) continue;
      reachFwd.add(id);
      for (const nxt of adj.get(id) || []) stackF.push(nxt);
    }
    const reachBack = new Set();
    const stackB = [outputId];
    while (stackB.length) {
      const id = stackB.pop();
      if (reachBack.has(id)) continue;
      reachBack.add(id);
      for (const prv of radj.get(id) || []) stackB.push(prv);
    }
    for (const n of nodes) {
      if (!n || !n.id) continue;
      if (reachFwd.has(n.id) && reachBack.has(n.id)) continue;
      warnings.push(err('E009_UNREACHABLE', `节点 ${n.id}（${n.ref || n.type}）不在 input→output 的任一通路上，不会参与执行`, `nodes.${n.id}`));
    }
    // 深度（最长路径层数）
    const depth = new Map();
    const order = [];
    const q = [inputId];
    const seen = new Set();
    while (q.length) {
      const id = q.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      for (const nxt of adj.get(id) || []) {
        depth.set(nxt, Math.max(depth.get(nxt) || 0, (depth.get(id) || 0) + 1));
        q.push(nxt);
      }
    }
    let maxDepth = 0;
    for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
    if (maxDepth > schema.LIMITS.maxDepth) {
      errors.push(err('E014_SCALE', `图深度 ${maxDepth} 超过上限 ${schema.LIMITS.maxDepth}`));
    }
  }

  // 模态一致性：contribute/service 的 descriptor modality（已校验）；input/output 无 ref
  void contract;

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateFlow, detectCycle, checkParamValue, LIMITS: schema.LIMITS };
