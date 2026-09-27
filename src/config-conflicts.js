/**
 * 选项冲突治理 —— 声明式冲突矩阵（架构 §4）
 * 目标：把散落各处的 `if` 判断收敛成**一份声明式规则表**，启动时统一检测、
 * 统一输出、统一给出「实际生效值」，避免「选了 A 又选 B，到底哪个生效」的模糊体验。
 * 三类处置：
 * block —— 拒绝启动（仅用于致命组合，如端口非法）
 * auto —— 自动修正 + WARN，并在报告里写清「实际生效值」
 * warn —— 只提示风险，不改配置（需要人来决定）
 * 本模块**不依赖 config.js**（避免循环依赖）：占位符判定从 config-defaults 取，
 * 日志通过 `options.log` 注入，因此可独立单元测试。
 * 统一文案（§4.3）三条要求：
 * ① 带规则 ID（便于检索文档） ② 说明实际生效值 ③ 给出消除方法
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { isValueSet: defaultIsValueSet } = require('./config-defaults');

/**
 * 深写补丁：按 'a.b.c' 路径写入值。
 * @param {object} target 目标对象（原地修改）
 * @param {Array<[string, *]>} entries [路径, 值] 列表
 */
function applyPatch(target, entries) {
  for (const [configPath, value] of entries) {
    const keys = configPath.split('.');
    let cursor = target;
    let ok = true;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!cursor[keys[i]] || typeof cursor[keys[i]] !== 'object') { ok = false; break; }
      cursor = cursor[keys[i]];
    }
    if (ok) cursor[keys[keys.length - 1]] = value;
  }
}

/**
 * 读取配置里可能不存在的嵌套字段。
 * @param {object} cfg 配置对象
 * @param {string} configPath 路径
 * @param {*} fallback 兜底值
 * @returns {*} 字段值
 */
function pick(cfg, configPath, fallback) {
  const keys = configPath.split('.');
  let cursor = cfg;
  for (const key of keys) {
    if (cursor === undefined || cursor === null || typeof cursor !== 'object') return fallback;
    cursor = cursor[key];
  }
  return cursor === undefined ? fallback : cursor;
}

/**
 * 判断本地视觉模型能否用于图片审核。
 * @param {object} cfg 配置
 * @param {Function} isSet 占位符判定
 * @returns {boolean} 是否可用
 */
function localVisionUsable(cfg, isSet) {
  if (pick(cfg, 'moderationMode', 'local') === 'cloud-only') return false;
  if (pick(cfg, 'ollama.enabled', true) === false) return false;
  if (pick(cfg, 'moderation.reviewChannels.local', true) === false) return false;
  return isSet(pick(cfg, 'ollama.visionModel', ''));
}

/**
 * 判断云端视觉模型能否用于图片审核。
 * @param {object} cfg 配置
 * @param {Function} isSet 占位符判定
 * @returns {boolean} 是否可用
 */
function cloudVisionUsable(cfg, isSet) {
  if (pick(cfg, 'qwenCloud.enabled', false) !== true) return false;
  if (pick(cfg, 'qwenCloud.visionEnabled', false) !== true) return false;
  const billing = pick(cfg, 'qwenCloud.billingSource', 'dashscope');
  const key = billing === 'token-plan'
    ? pick(cfg, 'tokenPlan.apiKey', '')
    : pick(cfg, 'qwenCloud.apiKey', '');
  return isSet(key);
}

// ══════════════════════════════════════════════════════════
// 冲突规则表（架构 §4.1 X01–X13 + 批量扫描/插件补充 X14–X16）
// ══════════════════════════════════════════════════════════
/**
 * @typedef {'block'|'auto'|'warn'} Resolution
 * @typedef {{
 * id: string,
 * title: string,
 * severity: 'error'|'warn',
 * when: (c: object, ctx: object) => boolean,
 * resolution: Resolution,
 * message: (c: object, ctx: object) => string,
 * fix: string,
 * patch?: (c: object, ctx: object) => Array<[string, *]>
 * }} ConflictRule
 */

/**
 * 取已迁移的流程定义集合（未迁移或未启用时返回空数组）。
 * @param {object} cfg 配置
 * @returns {Array<{modality: string, flow: object}>} 流程列表
 */
function activeFlows(cfg) {
  const flows = pick(cfg, 'moderation.flows', null);
  if (!flows || typeof flows !== 'object' || flows.enabled === false) return [];
  const out = [];
  for (const modality of ['text', 'image']) {
    const flow = flows[modality];
    if (flow && typeof flow === 'object' && Array.isArray(flow.nodes) && flow.nodes.length > 0) {
      out.push({ modality, flow });
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// X25–X27 专用辅助（仅在提供 options.availableRefs 时启用）
// ══════════════════════════════════════════════════════════

/** 需要「注册表现状」才能判定的规则 ID（缺省 availableRefs 时整体跳过）。*/
const REF_SCOPED_RULE_IDS = Object.freeze(['X25', 'X26', 'X27']);

/**
 * 惰性取「内容安全继任 ref」清单。
 * 惰性 require：本模块刻意不依赖任何核心业务模块（见文件头注释），
 * 而 adjudicators 只在极少数启动期路径才需要，没必要拉进加载链。
 * @returns {string[]} 继任 ref 列表
 */
function contentSafetyRefs() {
  try {
    return require('./flow/adjudicators').retiredTargets();
  } catch {
    return [];
  }
}

/**
 * 内容安全是否处于「用户以为它在跑」的状态。
 * 两个来源都算：当前开关 + 已退役的 reviewChannels 开关（用户的历史意图，已保留不删）。
 * @param {object} cfg 配置
 * @returns {boolean} 是否已配置
 */
function contentSafetyConfigured(cfg) {
  if (pick(cfg, 'contentSafety.enabled', false) === true) return true;
  if (pick(cfg, 'moderation.reviewChannels.contentSafety', false) === true) return true;
  if (pick(cfg, 'moderation.legacy.reviewChannels.contentSafety', false) === true) return true;
  return false;
}

/**
 * 拓扑里所有引用的 ref（nodes + floors），去重。
 * @param {object} cfg 配置
 * @returns {string[]} ref 列表
 */
function topologyRefs(cfg) {
  const out = [];
  for (const { flow } of activeFlows(cfg)) {
    for (const item of [...(Array.isArray(flow.nodes) ? flow.nodes : []), ...(Array.isArray(flow.floors) ? flow.floors : [])]) {
      const ref = item && typeof item.ref === 'string' ? item.ref : '';
      if (ref && !out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

/**
 * 拓扑中未在注册表里的 ref（存量失效节点）。
 * @param {object} cfg 配置
 * @param {string[]} availableRefs 注册表当前全部 ref
 * @returns {string[]} 未注册 ref 列表
 */
function unknownRefs(cfg, availableRefs) {
  const known = new Set(availableRefs);
  return topologyRefs(cfg).filter((ref) => !known.has(ref));
}

/**
 * 计算某模态流程中「在 input→output 通路上」的节点 id 集合。
 * @param {object} flow 流程
 * @returns {Set<string>} 通路节点集合
 */
function onPathNodes(flow) {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow.edges) ? flow.edges : [];
  const inputId = (nodes.find((n) => n && n.type === 'input') || {}).id;
  const outputId = (nodes.find((n) => n && n.type === 'output') || {}).id;
  const adj = new Map();
  const radj = new Map();
  for (const n of nodes) { if (n && n.id) { adj.set(n.id, []); radj.set(n.id, []); } }
  for (const e of edges) {
    if (adj.has(e.from) && adj.has(e.to)) { adj.get(e.from).push(e.to); radj.get(e.to).push(e.from); }
  }
  const walk = (start, graph) => {
    const seen = new Set();
    const st = start ? [start] : [];
    while (st.length) {
      const id = st.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const x of graph.get(id) || []) st.push(x);
    }
    return seen;
  };
  const fwd = walk(inputId, adj);
  const back = walk(outputId, radj);
  const out = new Set();
  for (const id of fwd) if (back.has(id)) out.add(id);
  return out;
}

/** @type {ConflictRule[]}*/
const CONFLICT_RULES = [
  {
    id: 'X01',
    title: 'cloud-only 模式却关闭了云端通道',
    severity: 'error',
    resolution: 'auto',
    when: (c) => pick(c, 'moderationMode', 'local') === 'cloud-only'
      && pick(c, 'moderation.reviewChannels.cloud', true) === false,
    message: () => '云端轻量模式要求启用云端通道，但 reviewChannels.cloud=false；已回落为 local 模式。'
      + '如需纯云端，请将 reviewChannels.cloud 置为 true 或改用 moderationMode=\'local\'',
    fix: 'moderationMode',
    patch: () => [['moderationMode', 'local']],
  },
  {
    id: 'X02',
    title: '三个审核通道全部关闭',
    severity: 'error',
    resolution: 'auto',
    when: (c) => pick(c, 'moderation.reviewChannels.local', true) === false
      && pick(c, 'moderation.reviewChannels.cloud', true) === false
      && pick(c, 'moderation.reviewChannels.contentSafety', false) === false,
    message: () => '三个审核通道全部关闭，审核结果将仅基于预检层（敏感词），'
      + '且不会再有任何 AI 通道参与（实际生效：仅预检）。请至少启用一个通道',
    fix: 'moderation.reviewChannels.*',
    patch: () => [['moderation.notConfigured', true]],
  },
  {
    id: 'X03',
    title: 'dualMode 与 doubleCheck 互斥',
    severity: 'warn',
    resolution: 'auto',
    when: (c) => pick(c, 'moderation.dualMode', false) === true
      && pick(c, 'moderation.doubleCheck', false) === true,
    message: () => 'dualMode 与 doubleCheck 互斥，已忽略 doubleCheck（实际生效：dualMode）',
    fix: 'moderation.doubleCheck',
    patch: () => [['moderation.doubleCheck', false]],
  },
  {
    id: 'X04',
    title: '宽松模式与涉政/暴恐类目冲突',
    severity: 'warn',
    resolution: 'warn',
    when: (c) => pick(c, 'moderation.strictness', 'standard') === 'relaxed'
      && (pick(c, 'moderation.thresholds.political.enabled', true) === true
        || pick(c, 'moderation.thresholds.violence.enabled', true) === true),
    message: () => '宽松模式下涉政/暴恐类目仍按 critical 处理，不接受阈值放宽'
      + '（实际生效：这两类不受 relaxed 影响）。若确需全局放宽，请显式关闭对应类目',
    fix: 'moderation.thresholds.political.enabled / moderation.thresholds.violence.enabled',
  },
  {
    id: 'X05',
    title: '额度来源与 Key 不匹配',
    severity: 'warn',
    resolution: 'auto',
    when: (c, ctx) => pick(c, 'qwenCloud.billingSource', 'dashscope') === 'token-plan'
      && !ctx.isValueSet(pick(c, 'tokenPlan.apiKey', '')),
    message: (c) => `额度来源为 token-plan 但未配置 tokenPlan.apiKey，已回落 ${'dashscope'}`
      + '（实际生效：dashscope 按量计费！）。请确认是否会产生费用',
    fix: 'qwenCloud.billingSource 或 tokenPlan.apiKey',
    patch: () => [['qwenCloud.billingSource', 'dashscope']],
  },
  {
    id: 'X06',
    title: '双审模式但一侧通道未配置',
    severity: 'warn',
    resolution: 'auto',
    when: (c, ctx) => pick(c, 'moderation.dualMode', false) === true
      && !(ctx.localUsable && ctx.cloudUsable),
    message: (c, ctx) => {
      const missing = [];
      if (!ctx.localUsable) missing.push('本地');
      if (!ctx.cloudUsable) missing.push('云端');
      return `双审模式已开启，但${missing.join('、')}通道未配置，本次等效为单通道审核`
        + `（实际生效：${ctx.localUsable ? '本地' : ctx.cloudUsable ? '云端' : '无（仅预检）'}）`;
    },
    fix: 'moderation.dualMode（关闭它可消除提示）或补全缺失通道的配置',
  },
  {
    id: 'X07',
    title: '内容安全已启用但 AccessKey 为占位符',
    severity: 'warn',
    resolution: 'auto',
    when: (c, ctx) => pick(c, 'contentSafety.enabled', false) === true
      && !(ctx.isValueSet(pick(c, 'contentSafety.accessKeyId', ''))
        && ctx.isValueSet(pick(c, 'contentSafety.accessKeySecret', ''))),
    message: () => '内容安全已启用但 AccessKey 为占位符/空，已按未配置处理并静默跳过'
      + '（实际生效：contentSafety.enabled=false）',
    fix: 'contentSafety.accessKeyId / contentSafety.accessKeySecret 或 contentSafety.enabled',
    patch: () => [['contentSafety.enabled', false]],
  },
  {
    id: 'X08',
    title: '未设置管理员口令',
    severity: 'error',
    resolution: 'warn',
    when: (c, ctx) => !ctx.isValueSet(pick(c, 'adminPassword', '')),
    message: () => '未设置管理员口令，所有写接口已禁用（实际生效：写接口返回 403）',
    fix: 'adminPassword（也可用环境变量 ADMIN_PASSWORD）',
  },
  {
    id: 'X09',
    title: '未设置词库口令',
    severity: 'warn',
    resolution: 'warn',
    when: (c, ctx) => !ctx.isValueSet(pick(c, 'wordDbPassword', '')),
    message: () => '未设置词库口令，词库写接口已禁用（实际生效：词库写接口返回 403）',
    fix: 'wordDbPassword',
  },
  {
    id: 'X10',
    title: '每日对比审核已开启但无可对比模型',
    severity: 'warn',
    resolution: 'auto',
    when: (c, ctx) => pick(c, 'ollama.comparisonEnabled', false) === true
      && !(ctx.localUsable && Array.isArray(pick(c, 'ollama.comparisonModels', []))
        && pick(c, 'ollama.comparisonModels', []).length > 0),
    message: () => '每日对比审核已开启但无可对比模型，已自动禁用（实际生效：comparisonEnabled=false）',
    fix: 'ollama.comparisonEnabled 或 ollama.comparisonModels',
    patch: () => [['ollama.comparisonEnabled', false]],
  },
  {
    id: 'X11',
    title: '本地与云端通道均不可用',
    severity: 'error',
    resolution: 'warn',
    when: (c, ctx) => pick(c, 'ollama.enabled', true) === false
      && pick(c, 'moderationMode', 'local') !== 'cloud-only'
      && !ctx.cloudConfigured,
    message: () => '本地与云端通道均不可用，服务以预检模式运行（实际生效：仅敏感词预检，结果标记 degraded）',
    fix: 'ollama.enabled / qwenCloud.apiKey（至少配一个通道）',
  },
  {
    id: 'X12',
    title: 'onAiFailure 取值非法',
    severity: 'error',
    resolution: 'auto',
    when: (c) => {
      const v = pick(c, 'moderation.onAiFailure', 'block');
      return v !== 'block' && v !== 'review';
    },
    message: (c) => `onAiFailure='${String(pick(c, 'moderation.onAiFailure', ''))}' 取值非法，`
      + '已回落为安全的 block（实际生效：block）',
    fix: 'moderation.onAiFailure（只能是 block 或 review）',
    patch: () => [['moderation.onAiFailure', 'block']],
  },
  {
    id: 'X13',
    title: '服务端口非法',
    severity: 'error',
    resolution: 'block',
    when: (c) => {
      const port = Number(pick(c, 'server.port', 11451));
      return !Number.isInteger(port) || port < 1 || port > 65535;
    },
    message: (c) => `端口 ${String(pick(c, 'server.port', ''))} 不可用：取值必须在 1-65535 之间`,
    fix: 'server.port（或环境变量 MOD_PORT）',
  },
  {
    id: 'X14',
    title: '启用批量扫描但没有可用的图片通道',
    severity: 'warn',
    resolution: 'warn',
    when: (c, ctx) => {
      const batchEnabled = ctx.isValueSet(pick(c, 'batch.autoScanFolder', ''))
        || pick(c, 'batch.enabled', false) === true;
      if (!batchEnabled) return false;
      return !ctx.localVisionUsable && !ctx.cloudVisionUsable;
    },
    message: (c) => '批量扫描已启用，但本地视觉模型与云端视觉模型都不可用；'
      + '扫描任务不会中断，但每张图都会按失败-关闭策略标记为「需人工复核」'
      + '（实际生效：imagePolicy=review）',
    fix: 'ollama.visionModel 或 qwenCloud.visionEnabled + 视觉模型 Key，或关闭 batch.autoScanFolder',
  },
  {
    id: 'X15',
    title: '批量扫描严格程度与实时审核不一致',
    severity: 'warn',
    resolution: 'warn',
    when: (c, ctx) => {
      const batchStrictness = pick(c, 'batch.autoScanStrictness', '');
      if (!ctx.isValueSet(batchStrictness)) return false;
      return batchStrictness !== pick(c, 'moderation.strictness', 'standard');
    },
    message: (c) => `批量扫描严格程度(${String(pick(c, 'batch.autoScanStrictness', ''))}) `
      + `与实时审核严格程度(${String(pick(c, 'moderation.strictness', 'standard'))}) 不一致，`
      + '同一张图在两条链路上可能得到不同结论（实际生效：各自按自己的设置执行）',
    fix: 'batch.autoScanStrictness 或 moderation.strictness（改为一致）',
  },
  {
    id: 'X16',
    title: '插件能力与权限不符',
    severity: 'warn',
    resolution: 'warn',
    when: (c) => {
      const plugins = pick(c, 'plugins', null);
      // 只有显式配置了 plugins 段落才检测（避免在未接入插件配置时误报）
      if (!plugins || typeof plugins !== 'object') return false;
      if (plugins.enabled === false) return false;
      const perms = plugins.permissions;
      if (!Array.isArray(perms)) return false;
      const wd14On = pick(c, 'wd14.enabled', true) !== false;
      // WD14 标签器要贡献图片标签，必须有 image:tag 能力
      return wd14On && !perms.includes('image:tag');
    },
    message: () => 'WD14 标签器已启用，但插件权限清单缺少 "image:tag"，'
      + '标签贡献会被权限闸门拒绝（实际生效：图片标签联动降级为无操作）',
    fix: 'plugins.permissions（加入 "image:tag"）或 wd14.enabled',
  },
  {
    id: 'X17',
    title: '存在「取最轻」汇聚策略（会放宽拦截）',
    severity: 'warn',
    resolution: 'warn',
    when: (c) => activeFlows(c).some(({ flow }) => (flow.nodes || []).some((n) => n && n.type === 'merge' && n.strategy === 'lowest')),
    message: () => '拓扑中存在 strategy=lowest 的汇聚节点，「取最轻」会放宽拦截（实际生效：按最轻分支结论放行）',
    fix: '把该汇聚节点的 strategy 改为 highest，或确认后保留',
  },
  {
    id: 'X18',
    title: '存在 failurePolicy=skip 的节点（高危）',
    severity: 'warn',
    resolution: 'warn',
    when: (c) => activeFlows(c).some(({ flow }) => (flow.nodes || []).some((n) => n && n.failurePolicy === 'skip')),
    message: () => '拓扑中存在 failurePolicy=skip 的节点，该节点失败时不会触发 fail-closed（实际生效：按未执行降级）',
    fix: '把该节点的 failurePolicy 改为 inherit/block/review',
  },
  {
    id: 'X19',
    title: '拓扑未接入任何有效判定节点',
    severity: 'error',
    resolution: 'warn',
    when: (c) => activeFlows(c).some(({ flow }) => {
      const path = onPathNodes(flow);
      const judges = (flow.nodes || []).filter((n) => n && (n.type === 'service' || n.type === 'contribute') && path.has(n.id));
      return judges.length === 0;
    }),
    message: () => '某模态拓扑在 input→output 通路上没有任何判定节点，该模态将只能依赖下限层（实际生效：仅下限层结论）',
    fix: '在拓扑上至少接入一个判定节点（本地/云端/插件）',
  },
  {
    id: 'X20',
    title: '拓扑接入了未就绪的服务（幽灵选项）',
    severity: 'warn',
    resolution: 'warn',
    when: (c, ctx) => activeFlows(c).some(({ flow }) => {
      const path = onPathNodes(flow);
      return (flow.nodes || []).some((n) => {
        if (!n || !path.has(n.id)) return false;
        if (n.ref === 'builtin.localModel') return ctx.localUsable !== true;
        if (n.ref === 'builtin.cloudModel') return ctx.cloudUsable !== true;
        return false;
      });
    }),
    message: () => '拓扑接入了未配置/未启用的服务（如本地或云端通道未就绪），该节点执行时会被跳过'
      + '（实际生效：skipped，不参与合并）。请补全配置或从拓扑移除该节点',
    fix: '补全对应通道配置（ollama / qwenCloud），或在画布上移除该节点',
  },
  {
    id: 'X21',
    title: '拓扑存在未接入通路的孤立节点',
    severity: 'warn',
    resolution: 'warn',
    when: (c) => activeFlows(c).some(({ flow }) => {
      const path = onPathNodes(flow);
      return (flow.nodes || []).some((n) => n && n.id && !path.has(n.id));
    }),
    message: () => '拓扑存在不在 input→output 通路上的孤立节点，它们不会参与执行'
      + '（实际生效：不执行，仅占位）。可在画布上连线或删除',
    fix: '在画布上把孤立节点接入通路，或删除它',
  },
  {
    id: 'X22',
    title: '拓扑引用了插件节点但插件系统已关闭',
    severity: 'warn',
    resolution: 'warn',
    when: (c) => pick(c, 'plugins.enabled', true) === false
      && activeFlows(c).some(({ flow }) => (flow.nodes || []).some((n) => n && typeof n.ref === 'string' && n.ref.startsWith('plugin.'))),
    message: () => '插件系统已关闭（plugins.enabled=false），但拓扑中仍存在插件节点；这些节点执行时会被跳过（实际生效：skipped）',
    fix: '启用插件系统，或在画布上移除插件节点',
  },
  {
    id: 'X23',
    title: '顶层 reviewChannels 与权威配置不一致',
    severity: 'warn',
    resolution: 'warn',
    when: (c) => {
      const top = pick(c, 'reviewChannels', null);
      const auth = pick(c, 'moderation.reviewChannels', null);
      if (!top || typeof top !== 'object' || !auth || typeof auth !== 'object') return false;
      return Object.keys(top).some((k) => k in auth && top[k] !== auth[k]);
    },
    message: () => '检测到顶层 reviewChannels 与 moderation.reviewChannels 不一致，已以 moderation.reviewChannels 为唯一权威'
      + '（实际生效：moderation.reviewChannels；顶层字段保留仅为兼容已存盘配置）',
    fix: '删除顶层 reviewChannels，或令其与 moderation.reviewChannels 一致',
  },
  {
    id: 'X24',
    title: '风险映射把「拦截」降级为放行',
    severity: 'warn',
    resolution: 'warn',
    when: (c) => activeFlows(c).some(({ flow }) => (flow.nodes || []).some((n) => {
      const levelMap = n && n.params && n.params.levelMap;
      if (!levelMap || typeof levelMap !== 'object') return false;
      if (levelMap.block === undefined) return false;
      return !['high', 'critical'].includes(levelMap.block);
    })),
    message: () => '存在 levelMap 把 block（服务建议拦截）映射到 medium/low/safe 的节点：'
      + '投影回 suggestion 时会变成 review/pass，削弱 v2.1.0 等价性（实际生效：拦截被放宽）。'
      + '建议 block 分支只映射到 high 或 critical',
    fix: '把该节点的 levelMap.block 改为 high 或 critical',
  },
  // ── X25–X27：需要「注册表现状」的规则 ──
  // 三条都要求 ctx.availableRefs（由调用方传入注册表当前的 ref 快照）。
  // 缺省时整条规则自动跳过，因此既有 24 条规则的口径与既有测试完全不受影响。
  {
    id: 'X25',
    title: '内容安全已配置但提供它的插件未装载',
    severity: 'warn',
    resolution: 'warn',
    when: (c, ctx) => Array.isArray(ctx.availableRefs)
      && contentSafetyConfigured(c)
      && !contentSafetyRefs().some((ref) => ctx.availableRefs.includes(ref)),
    message: () => '内容安全处于「已启用」状态，但提供该能力的插件当前未装载，'
      + '本次审核不会有任何内容安全判定参与（实际生效：内容安全通道整体缺席，且不产生付费调用）。'
      + '如需它生效，请启用插件「阿里云内容安全」并在画布上接入对应服务节点',
    fix: 'plugins 中启用「阿里云内容安全」插件，或把 contentSafety.enabled 置为 false',
  },
  {
    id: 'X26',
    title: '拓扑引用了未注册的 ref（存量节点已失效）',
    severity: 'warn',
    resolution: 'warn',
    when: (c, ctx) => Array.isArray(ctx.availableRefs) && unknownRefs(c, ctx.availableRefs).length > 0,
    message: (c, ctx) => {
      const list = unknownRefs(c, ctx.availableRefs);
      const shown = list.slice(0, 5).join(', ');
      return `拓扑中存在 ${list.length} 个未注册的 ref（可能依赖缺失或插件已卸载）：${shown}${list.length > 5 ? ' …' : ''}`
        + '（实际生效：这些节点会被跳过；若它们位于下限层，整条拓扑校验会失败并退回旧引擎）';
    },
    fix: '在插件管理页启用对应插件，或在画布上移除/替换这些节点',
  },
  {
    id: 'X27',
    title: '遗留 reviewChannels 尚未迁移到 legacy 位',
    severity: 'warn',
    resolution: 'warn',
    when: (c, ctx) => Array.isArray(ctx.availableRefs)
      && (pick(c, 'moderation.reviewChannels', null) !== null || pick(c, 'reviewChannels', null) !== null)
      && pick(c, 'moderation.legacy.reviewChannels', null) === null,
    message: () => '检测到旧「多重审核」配置（moderation.reviewChannels / 顶层 reviewChannels），'
      + '但尚未复制到 moderation.legacy.reviewChannels（实际生效：旧字段已不再驱动审核，唯一入口是拓扑图）。'
      + '重启服务会自动完成迁移，原字段不会被删除',
    fix: '重启服务（自动迁移），或手工把原值复制到 moderation.legacy.reviewChannels',
  },
];

/**
 * 把「配置路径」翻译成统一的消除方法文案。
 * @param {ConflictRule} rule 规则
 * @returns {string} 消除方法
 */
function buildFixHint(rule) {
  return `修改 config/default.json 的 ${rule.fix} 可消除此提示`;
}

/**
 * 启动期检测：返回报告并对 config 施加自动修正。
 * @param {object} cfg 已深合并 + 已应用环境变量的配置对象（原地修改）
 * @param {object} [options] 选项
 * @param {(v: *) => boolean} [options.isValueSet] 占位符判定（默认用 config-defaults 实现）
 * @param {(level: string, message: string) => void} [options.log] 日志输出（默认 console）
 * @param {string[]} [options.availableRefs] 注册表当前全部 ref 快照。提供后才启用 X25–X27
 * （这三条需要知道「注册表现状」）；缺省时它们整体跳过，既有规则口径不变。
 * @param {string[]} [options.ruleIds] 只跑这些规则 ID（缺省跑全部；供「只查注册表相关规则」用）
 * @returns {{rules: ConflictRule[], reports: Array<object>, patched: object, blocking: Array<object>}}
 */
function detectConflicts(cfg, options = {}) {
  const isSet = typeof options.isValueSet === 'function' ? options.isValueSet : defaultIsValueSet;
  const log = typeof options.log === 'function'
    ? options.log
    : (level, message) => {
      const line = `[config] ${level === 'error' ? 'ERROR' : 'WARN'}  ${message}`;
      if (level === 'error') console.error(line);
      else console.warn(line);
    };

  const config = cfg && typeof cfg === 'object' ? cfg : {};

  // 供 when/message 共享的上下文（避免每条规则重复推导）
  const cloudCredentialsSet = (() => {
    const billing = pick(config, 'qwenCloud.billingSource', 'dashscope');
    const key = billing === 'token-plan'
      ? pick(config, 'tokenPlan.apiKey', '')
      : pick(config, 'qwenCloud.apiKey', '');
    return isSet(key);
  })();

  const ctx = {
    isValueSet: isSet,
    localUsable: pick(config, 'ollama.enabled', true) !== false
      && pick(config, 'moderationMode', 'local') !== 'cloud-only'
      && pick(config, 'moderation.reviewChannels.local', true) !== false
      && isSet(pick(config, 'ollama.textModel', '')),
    cloudUsable: (pick(config, 'qwenCloud.enabled', false) === true
      || pick(config, 'moderationMode', 'local') === 'cloud-only') && cloudCredentialsSet,
    cloudConfigured: cloudCredentialsSet,
    localVisionUsable: localVisionUsable(config, isSet),
    cloudVisionUsable: cloudVisionUsable(config, isSet),
    // 只有显式提供注册表快照时才为数组，否则为 undefined → X25–X27 的 when 全部短路
    availableRefs: Array.isArray(options.availableRefs) ? options.availableRefs.slice() : undefined,
  };

  const reports = [];
  const applied = [];
  const onlyIds = Array.isArray(options.ruleIds) ? new Set(options.ruleIds) : null;

  for (const rule of CONFLICT_RULES) {
    if (onlyIds && !onlyIds.has(rule.id)) continue;
    let hit = false;
    try {
      hit = rule.when(config, ctx) === true;
    } catch {
      hit = false; // 规则本身出错不得影响启动
    }
    if (!hit) continue;

    let message = '';
    try {
      message = rule.message(config, ctx);
    } catch {
      message = rule.title;
    }

    const effective = rule.resolution === 'auto'
      ? '已自动修正'
      : rule.resolution === 'block'
        ? '拒绝启动'
        : '保持原值（仅提示）';

    reports.push({
      id: rule.id,
      title: rule.title,
      severity: rule.severity,
      resolution: rule.resolution,
      message,
      effective,
      fix: buildFixHint(rule),
    });

    // 统一文案：带 ID → 实际生效 → 消除方法
    log(rule.severity, `[${rule.id}] ${message}`);
    log(rule.severity === 'error' ? 'error' : 'warn', `               → ${buildFixHint(rule)}`);

    if (rule.resolution === 'auto' && typeof rule.patch === 'function') {
      try {
        const entries = rule.patch(config, ctx) || [];
        if (entries.length > 0) {
          applyPatch(config, entries);
          applied.push(...entries.map((e) => e[0]));
        }
      } catch {
        // 自动修正失败：保留告警，不影响启动
      }
    }
  }

  if (applied.length > 0) {
    log('warn', `已自动修正 ${applied.length} 处配置：${applied.join(', ')}`);
  }

  return {
    rules: CONFLICT_RULES,
    reports,
    patched: { applied },
    blocking: reports.filter((r) => r.resolution === 'block'),
  };
}

/**
 * 只跑「依赖注册表现状」的规则（X25–X27），供**插件装载后**即时告警。
 * 为什么单独一个入口：这三条规则的输入（插件是否装载、拓扑 ref 是否已注册）
 * 只有等插件系统 ready 之后才确定，无法在 config.js 首轮检测里得到。
 * R3-12 要求「内容安全已配置但插件未装载」**必须**产生告警，不允许静默。
 * 不施加任何自动修正（这三条 resolution 均为 warn），也不会重复跑其余规则。
 * @param {object} cfg 配置（只读；不会因本调用产生 patch）
 * @param {string[]} availableRefs 注册表当前全部 ref
 * @param {object} [options] 透传给 detectConflicts 的选项（log / isValueSet）
 * @returns {Array<object>} 命中的报告列表（可能为空）
 */
function detectRefConflicts(cfg, availableRefs, options = {}) {
  const result = detectConflicts(cfg, Object.assign({}, options, {
    availableRefs,
    ruleIds: REF_SCOPED_RULE_IDS,
  }));
  return result.reports;
}

/**
 * 把报告落盘到 logs/startup-<date>.log（架构 §4.3）。
 * 失败不影响启动。
 * @param {Array<object>} reports 冲突报告
 * @param {string} projectRoot 项目根目录
 */
function writeStartupLog(reports, projectRoot) {
  if (!Array.isArray(reports) || reports.length === 0) return;
  try {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dir = path.join(projectRoot || path.join(__dirname, '..'), 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = [`# ${new Date().toISOString()} startup config conflicts (${reports.length})`];
    for (const r of reports) {
      lines.push(`[${r.id}] ${r.severity.toUpperCase()} ${r.message}`);
      lines.push(`      -> ${r.fix}`);
    }
    lines.push('');
    fs.appendFileSync(path.join(dir, `startup-${ymd}.log`), `${lines.join('\n')}\n`, 'utf-8');
  } catch {
    // 落盘失败不影响启动
  }
}

module.exports = {
  CONFLICT_RULES,
  REF_SCOPED_RULE_IDS,
  detectConflicts,
  detectRefConflicts,
  writeStartupLog,
  buildFixHint,
  applyPatch,
  pick,
  localVisionUsable,
  cloudVisionUsable,
  activeFlows,
  onPathNodes,
  contentSafetyRefs,
};
