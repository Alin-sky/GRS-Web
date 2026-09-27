/**
 * 旧配置 → 默认拓扑迁移（src/flow/migrate.js）
 * 设计依据：GRS v2.2.0 架构 §10。
 * 关键约束：
 * - 权威来源：`config.moderation.reviewChannels`（顶层 `reviewChannels` 弃用，仅记迁移日志）
 * - 幂等：已存在合法 flows 则跳过；结果写入 `config.moderation.flows.*`
 * - **不删除任何旧字段**（dualMode / doubleCheck / reviewChannels / contentSafety.* 全保留），
 * 保证 `flows.enabled=false` 逃生时旧引擎仍能读
 * - 迁移只引用**内置 ref**（迁移发生在插件扫描之前，不能引用插件节点，
 * 否则会产生 E004）；插件节点/终裁层由 src/flow/index.js `reconcileFinalizers` 在插件装载后补齐
 * v0.1.0 例外：内容安全的内置实现已下线，它的继任者是插件节点，
 * 因此这一处会引用 `RETIRED_REFS` 里的继任 ref；未装载时由
 * `reconcileContentSafetyFloors` 在**内存**里改写/剔除，磁盘配置不动。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { emptyFlow } = require('./schema');
const adjudicators = require('./adjudicators');

/** 迁移日志码。*/
const MIGRATION_CODES = Object.freeze({
  M001: '已由 dualMode=true 生成默认并行拓扑',
  M002: '已由 cloud-only 生成纯云端拓扑',
  M003: '已生成单通道默认拓扑',
  M004: '已由 doubleCheck 生成双检拓扑（注意：category_scores 不再取均值，见 PRD Q3）',
  M005: '内容安全已启用，已接入插件节点（旧内置节点 builtin.contentSafety 已下线）',
  M010: '检测到顶层 reviewChannels 与 moderation.reviewChannels 不一致，已以 moderation.reviewChannels 为准',
  M020: 'disputeStrategy=contentSafety 暂按 highest 处理（内容安全以独立节点接入的能力由插件提供）',
  M030: '多重审核（reviewChannels）已退役：原值已复制到 moderation.legacy.reviewChannels，原位置字段保留',
});

/**
 * 解析内容安全在拓扑里应当引用的 ref。
 * 为什么通过 `RETIRED_REFS` 而不是直接写字面量：跨文件约定禁止核心硬编码插件 ref；
 * 这张迁移表存在的意义正是「历史上曾经有一个 builtin.contentSafety，它的继任者是谁」。
 * @param {'text'|'image'} modality 模态
 * @returns {string|null} 继任 ref；表里没有时返回 null
 */
function contentSafetyRefOf(modality) {
  return adjudicators.successorOf('builtin.contentSafety', modality);
}

/**
 * 读取权威通道配置，并在两份 reviewChannels 不一致时产出告警日志。
 * @param {object} config 配置
 * @param {Array<object>} log 迁移日志（原地追加）
 * @returns {object} 权威通道配置
 */
function authoritativeChannels(config, log) {
  const authoritative = (config.moderation && config.moderation.reviewChannels) || { local: true, cloud: true, contentSafety: false, disputeStrategy: 'highest' };
  const legacyTop = config.reviewChannels;
  if (legacyTop && typeof legacyTop === 'object') {
    const mismatch = Object.keys(legacyTop).some((k) => k in authoritative && legacyTop[k] !== authoritative[k]);
    if (mismatch) log.push({ level: 'warn', code: 'M010', msg: MIGRATION_CODES.M010 });
  }
  return authoritative;
}

/**
 * 把 disputeStrategy 映射为合并策略。
 * @param {string} strategy disputeStrategy
 * @param {string} [modality] 模态
 * @param {Array<object>} log 迁移日志
 * @returns {{strategy: string, localPriority: number, cloudPriority: number}} 映射结果
 */
function mapDisputeStrategy(strategy, modality, log) {
  switch (strategy) {
    case 'lowest': return { strategy: 'lowest', localPriority: 0, cloudPriority: 0 };
    case 'local': return { strategy: 'priority', localPriority: 100, cloudPriority: 0 };
    case 'cloud': return { strategy: 'priority', localPriority: 0, cloudPriority: 100 };
    case 'contentSafety':
      log.push({ level: 'info', code: 'M020', msg: MIGRATION_CODES.M020 });
      return { strategy: 'highest', localPriority: 0, cloudPriority: 0 };
    case 'majority':
    case 'highest':
    default:
      return { strategy: 'highest', localPriority: 0, cloudPriority: 0 };
  }
}

/**
 * 迁移文本拓扑。
 * @param {object} config 配置
 * @param {Array<object>} log 迁移日志
 * @returns {object} 文本流程
 */
function migrateTextFlow(config, log) {
  const ch = authoritativeChannels(config, log);
  const cs = config.contentSafety || {};
  const isCloudOnly = config.moderationMode === 'cloud-only';
  const dual = !isCloudOnly
    && ch.local !== false
    && ch.cloud !== false
    && config.moderation.dualMode === true
    && config.qwenCloud && config.qwenCloud.enabled === true;
  const doubleCheck = !isCloudOnly && !dual && config.moderation.doubleCheck === true;

  const flow = emptyFlow('text');
  flow.revision = 1;
  flow.floors = [{
    id: 'pc', ref: 'builtin.precheck', params: {}, timeoutMs: 3000, enabled: true, deletable: true,
    deleteWarning: '删除后敏感词库不再参与判定，且零配置场景下将失去唯一兜底',
  }];
  // v0.1.0：内容安全不再迁移为内置下限层节点，而是迁移到插件节点 ref。
  // 下限层是「声明」而非执行入口（见 flow/executor#floorRefs）；插件未装载时由
  // flow/index.js#reconcileContentSafetyFloors 在内存里改写/剔除，磁盘配置始终保留。
  const csRef = contentSafetyRefOf('text');
  if (ch.contentSafety === true && cs.enabled === true && cs.textEnabled !== false && csRef) {
    flow.floors.push({ id: 'cs', ref: csRef, params: {}, timeoutMs: 10000, enabled: true, deletable: true });
    log.push({ level: 'info', code: 'M005', msg: MIGRATION_CODES.M005 });
  }

  const nodes = [{ id: 'in', type: 'input', position: { x: 320, y: 40 } }];
  const edges = [];
  const loc = { id: 'loc', type: 'service', ref: 'builtin.localModel', params: { model: '', useSafeguardPrompt: false }, failurePolicy: 'inherit', timeoutMs: 60000, position: { x: 160, y: 220 } };
  const cld = { id: 'cld', type: 'service', ref: 'builtin.cloudModel', params: { vision: false }, failurePolicy: 'inherit', timeoutMs: 30000, position: { x: 480, y: 220 } };
  nodes.push(loc, cld);

  let edgeSeq = 0;
  const addEdge = (from, to, priority) => {
    edgeSeq += 1;
    const e = { id: `e${edgeSeq}`, from, to };
    if (Number.isFinite(priority)) e.priority = priority;
    edges.push(e);
  };

  if (doubleCheck) {
    // 双检：本地 #1 / 本地 #2 并行汇聚（ 不再对 category_scores 取均值）
    loc.id = 'loc1';
    loc.position = { x: 160, y: 220 };
    const loc2 = { id: 'loc2', type: 'service', ref: 'builtin.localModel', params: { model: '', useSafeguardPrompt: false }, failurePolicy: 'inherit', timeoutMs: 60000, position: { x: 480, y: 220 } };
    nodes.length = 1;
    nodes.push(loc, loc2);
    const mg = { id: 'mg', type: 'merge', strategy: 'highest', categoriesMerge: 'winner', branchOrder: ['loc1', 'loc2'], timeoutMs: 1000, position: { x: 320, y: 360 } };
    nodes.push(mg, { id: 'out', type: 'output', position: { x: 320, y: 480 } });
    addEdge('in', 'loc1');
    addEdge('in', 'loc2');
    addEdge('loc1', 'mg', 0);
    addEdge('loc2', 'mg', 0);
    addEdge('mg', 'out');
    log.push({ level: 'warn', code: 'M004', msg: MIGRATION_CODES.M004 });
    // 未使用的云端节点保留为孤立节点（warn）；插在 loc1 之后便于画布观感
    cld.id = 'cld_cloud';
    nodes.splice(2, 0, cld);
    flow.nodes = nodes;
    flow.edges = edges;
    return flow;
  }

  const map = mapDisputeStrategy(ch.disputeStrategy || 'highest', 'text', log);

  let connected;
  if (dual) {
    connected = 'dual';
    log.push({ level: 'info', code: 'M001', msg: MIGRATION_CODES.M001 });
  } else if (isCloudOnly) {
    connected = 'cloud';
    log.push({ level: 'info', code: 'M002', msg: MIGRATION_CODES.M002 });
  } else if (ch.local === false) {
    connected = 'cloud';
    log.push({ level: 'info', code: 'M003', msg: MIGRATION_CODES.M003 });
  } else {
    connected = 'local';
    log.push({ level: 'info', code: 'M003', msg: MIGRATION_CODES.M003 });
  }

  if (connected === 'dual') {
    const mg = {
      id: 'mg', type: 'merge', strategy: map.strategy, categoriesMerge: 'winner',
      branchOrder: ['loc', 'cld'], timeoutMs: 1000, position: { x: 320, y: 360 },
    };
    nodes.push(mg, { id: 'out', type: 'output', position: { x: 320, y: 480 } });
    addEdge('in', 'loc');
    addEdge('in', 'cld');
    addEdge('loc', 'mg', map.localPriority);
    addEdge('cld', 'mg', map.cloudPriority);
    addEdge('mg', 'out');
  } else if (connected === 'cloud') {
    // 云端单通道：loc 保留但孤立
    nodes.push({ id: 'out', type: 'output', position: { x: 320, y: 480 } });
    addEdge('in', 'cld');
    addEdge('cld', 'out');
  } else {
    nodes.push({ id: 'out', type: 'output', position: { x: 320, y: 480 } });
    addEdge('in', 'loc');
    addEdge('loc', 'out');
  }

  flow.nodes = nodes;
  flow.edges = edges;
  return flow;
}

/**
 * 迁移图像拓扑。
 * @param {object} config 配置
 * @param {Array<object>} log 迁移日志
 * @returns {object} 图像流程
 */
function migrateImageFlow(config, log) {
  const ch = authoritativeChannels(config, log);
  const cs = config.contentSafety || {};
  const isCloudOnly = config.moderationMode === 'cloud-only';
  const qc = config.qwenCloud || {};
  const useCloudVision = isCloudOnly || (config.moderation.dualMode === true && qc.enabled === true && qc.visionEnabled === true);

  const flow = emptyFlow('image');
  flow.revision = 1;
  flow.floors = [];
  const csImageRef = contentSafetyRefOf('image');
  if (ch.contentSafety === true && cs.enabled === true && cs.imageEnabled !== false && csImageRef) {
    flow.floors.push({ id: 'cs', ref: csImageRef, params: {}, timeoutMs: 10000, enabled: true, deletable: true });
  }

  const nodes = [{ id: 'in', type: 'input', position: { x: 320, y: 40 } }];
  const edges = [];
  const loc = { id: 'vl', type: 'service', ref: 'builtin.localModel', params: { vision: true }, failurePolicy: 'inherit', timeoutMs: 60000, position: { x: 160, y: 260 } };
  const cld = { id: 'cld', type: 'service', ref: 'builtin.cloudModel', params: { vision: true }, failurePolicy: 'inherit', timeoutMs: 30000, position: { x: 480, y: 260 } };
  nodes.push(loc, cld);

  let edgeSeq = 0;
  const addEdge = (from, to, priority) => {
    edgeSeq += 1;
    const e = { id: `e${edgeSeq}`, from, to };
    if (Number.isFinite(priority)) e.priority = priority;
    edges.push(e);
  };

  if (useCloudVision && ch.local !== false) {
    nodes.push(
      { id: 'mg', type: 'merge', strategy: 'highest', categoriesMerge: 'winner', branchOrder: ['vl', 'cld'], timeoutMs: 1000, position: { x: 320, y: 400 } },
      { id: 'out', type: 'output', position: { x: 320, y: 500 } },
    );
    addEdge('in', 'vl');
    addEdge('in', 'cld');
    addEdge('vl', 'mg', 10);
    addEdge('cld', 'mg', 20);
    addEdge('mg', 'out');
  } else if (useCloudVision) {
    nodes.push({ id: 'out', type: 'output', position: { x: 320, y: 500 } });
    addEdge('in', 'cld');
    addEdge('cld', 'out');
  } else {
    nodes.push({ id: 'out', type: 'output', position: { x: 320, y: 500 } });
    addEdge('in', 'vl');
    addEdge('vl', 'out');
  }

  flow.nodes = nodes;
  flow.edges = edges;
  // finalizers 留空，由 src/flow/index.js#reconcileFinalizers 在插件装载后补齐（坑①显式化）
  flow.finalizers = [];
  return flow;
}

/**
 * 计算「旧开关签名」：拓扑是由这些开关迁移生成的，签名变化 ⇒ 拓扑已陈旧。
 * @param {object} config 配置
 * @returns {object} 签名
 */
function flowSignature(config) {
  const ch = (config && config.moderation && config.moderation.reviewChannels) || {};
  const cs = (config && config.contentSafety) || {};
  const qc = (config && config.qwenCloud) || {};
  return {
    moderationMode: (config && config.moderationMode) || 'local',
    dualMode: (config && config.moderation && config.moderation.dualMode) === true,
    doubleCheck: (config && config.moderation && config.moderation.doubleCheck) === true,
    local: ch.local !== false,
    cloud: ch.cloud !== false,
    contentSafety: ch.contentSafety === true,
    disputeStrategy: ch.disputeStrategy || 'highest',
    csEnabled: cs.enabled === true,
    csTextEnabled: cs.textEnabled !== false,
    csImageEnabled: cs.imageEnabled !== false,
    cloudEnabled: qc.enabled === true,
    cloudVisionEnabled: qc.visionEnabled === true,
  };
}

/**
 * 稳定序列化（键排序）。
 * @param {object} value 值
 * @returns {string} 序列化结果
 */
function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

/**
 * 若拓扑相对当前旧开关已陈旧（例如运行期直接改了 moderationMode / reviewChannels），
 * 则以当前开关重新生成拓扑（仅内存，不落盘）。幂等：签名一致时不做任何事。
 * @param {object} config 配置（原地修改）
 * @returns {{regenerated: boolean, reason: string}} 结果
 */
function syncIfStale(config) {
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows) return { regenerated: false, reason: 'no-flows' };
  const recorded = config._migration && config._migration.v22 && config._migration.v22.from;
  const current = flowSignature(config);
  if (recorded && stableStringify(recorded) === stableStringify(current)) {
    return { regenerated: false, reason: 'in-sync' };
  }

  // 迁移后自检（PRD §6.1-4 / 架构 §5 T03）：先在**候选副本**上重建 + 对齐内容安全下限层 + 校验，
  // 只有两个模态都通过才提交；否则**保留上一份合法拓扑**，绝不静默换成一张不合法的图，
  // 也绝不让用户手工编排的画布被无声清掉。
  const enabled = flows.enabled !== false;
  const probe = Object.assign({}, config, {
    moderation: Object.assign({}, config.moderation, { flows: { enabled } }),
  });

  let ok = false;
  try {
    ensureFlows(probe);
    require('./index').reconcileContentSafetyFloors(probe);
    const idx = require('./index');
    idx.ensureBuiltins();
    const text = probe.moderation.flows.text;
    const image = probe.moderation.flows.image;
    ok = Boolean(text && image)
      && idx.validateFlow(text, idx.registry).ok
      && idx.validateFlow(image, idx.registry).ok;
  } catch {
    ok = false;
  }

  const hasPrevious = Boolean(flows.text && flows.image);
  if (!ok && hasPrevious) {
    // 上一份仍在内存里且未被改动（我们全程只动 probe）→ 直接保留
    try {
      require('../logger').logWarn('flow', '旧开关触发的拓扑重建结果未通过校验，已保留上一份合法拓扑（不静默覆盖画布）');
    } catch {
      // 日志失败不影响保留策略
    }
    return { regenerated: false, reason: 'candidate-invalid-kept-previous' };
  }

  // 提交候选（ok=true 时即陈旧重建的预期结果；ok=false 且无上一份时至少给出可校验的图，让 validateFlow 报明确错误）
  flows.text = probe.moderation.flows.text;
  flows.image = probe.moderation.flows.image;
  config.moderation.flows.enabled = enabled;
  if (probe._migration) config._migration = probe._migration;
  return { regenerated: true, reason: ok ? 'stale-signature' : 'candidate-invalid-no-previous' };
}

/**
 * 确保 config.moderation.flows 存在且合法（幂等）。
 * @param {object} config 配置（原地修改）
 * @returns {{migrated: boolean, log: Array<object>}} 迁移结果
 */
function ensureFlows(config) {
  const log = [];
  if (!config || typeof config !== 'object') return { migrated: false, log };
  if (!config.moderation) config.moderation = {};
  const existing = config.moderation.flows && typeof config.moderation.flows === 'object' ? config.moderation.flows : {};

  const textOk = existing.text && existing.text.schemaVersion === 1 && Array.isArray(existing.text.nodes) && existing.text.nodes.length > 0;
  const imageOk = existing.image && existing.image.schemaVersion === 1 && Array.isArray(existing.image.nodes) && existing.image.nodes.length > 0;
  if (textOk && imageOk) return { migrated: false, log };

  const text = textOk ? existing.text : migrateTextFlow(config, log);
  const image = imageOk ? existing.image : migrateImageFlow(config, log);

  config.moderation.flows = {
    enabled: existing.enabled !== false,
    text,
    image,
  };
  config._migration = config._migration || {};
  config._migration.v22 = {
    at: new Date().toISOString(),
    from: flowSignature(config),
    log,
  };
  return { migrated: true, log };
}

/**
 * 备份站点配置为 `config/default.json.bak-<ISO时间戳>`，并只保留最近 N 份。
 * 任何破坏性迁移之前的硬要求（PRD §6.1 / 架构 §6.2-4）。
 * 全程 try/catch：备份失败不应该阻断启动，但要返回 null 让调用方知道「这次没有兜底」。
 * @param {{keep?: number, projectRoot?: string}} [options] 选项
 * @returns {string|null} 备份文件的绝对路径；未备份返回 null
 */
function backupConfigFile(options = {}) {
  const keep = Number.isFinite(options.keep) ? Math.max(1, Number(options.keep)) : 3;
  try {
    let projectRoot = options.projectRoot;
    if (!projectRoot) {
      const cfgMod = require('../config');
      projectRoot = typeof cfgMod.getProjectRoot === 'function'
        ? cfgMod.getProjectRoot()
        : path.join(__dirname, '..', '..');
    }
    const configDir = path.join(projectRoot, 'config');
    const source = path.join(configDir, 'default.json');
    if (!fs.existsSync(source)) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(configDir, `default.json.bak-${stamp}`);
    fs.copyFileSync(source, target);

    // 只保留最近 keep 份：文件名内嵌 ISO 时间戳，字典序即时间序
    const olds = fs.readdirSync(configDir)
      .filter((n) => /^default\.json\.bak-/.test(n))
      .sort()
      .reverse()
      .slice(keep);
    for (const old of olds) {
      try {
        fs.unlinkSync(path.join(configDir, old));
      } catch {
        // 清理旧备份失败不影响本次迁移
      }
    }
    return target;
  } catch {
    return null;
  }
}

/**
 * 退役旧「多重审核」配置（一次性数据迁移，幂等）。
 * 数据保全硬要求（用户明确强调「迁移的时候注意保留数据」）：
 * - **不删除任何字段**：`moderation.reviewChannels` 与顶层 `reviewChannels` 原位保留，
 * 原值整份复制到 `moderation.legacy.reviewChannels`（外部脚本读旧字段不会读空）
 * - 迁移留痕写 `config._migration.v010 = { at, from, log[] }`（沿用既有 `_migration` 结构）
 * - 幂等：`legacy.reviewChannels` 已存在时直接返回，不会覆盖用户后来的手工修改
 * 本函数只改内存；**是否落盘由调用方决定**（唯一允许落盘的一次性迁移）。
 * @param {object} config 配置（原地修改）
 * @returns {{changed: boolean, log: Array<object>, from: object, skipped?: string}} 结果
 */
function retireReviewChannels(config) {
  const log = [];
  if (!config || typeof config !== 'object') return { changed: false, log, from: {} };
  const mod = config.moderation && typeof config.moderation === 'object' ? config.moderation : null;
  if (!mod) return { changed: false, log, from: {} };

  const authoritative = mod.reviewChannels && typeof mod.reviewChannels === 'object' ? mod.reviewChannels : null;
  const legacyTop = config.reviewChannels && typeof config.reviewChannels === 'object' ? config.reviewChannels : null;
  const from = JSON.parse(JSON.stringify(authoritative || legacyTop || {}));

  if (mod.legacy && mod.legacy.reviewChannels && typeof mod.legacy.reviewChannels === 'object') {
    return { changed: false, log, from, skipped: 'already-migrated' };
  }
  if (!authoritative && !legacyTop) {
    return { changed: false, log, from, skipped: 'nothing-to-retire' };
  }

  mod.legacy = mod.legacy && typeof mod.legacy === 'object' ? mod.legacy : {};
  // 权威值优先；仅当权威值缺失时才用顶层值兜底（与 authoritativeChannels 的口径一致）
  mod.legacy.reviewChannels = JSON.parse(JSON.stringify(authoritative || legacyTop));
  if (authoritative && legacyTop) {
    log.push({ level: 'warn', code: 'M010', msg: MIGRATION_CODES.M010 });
  }
  log.push({ level: 'info', code: 'M030', msg: MIGRATION_CODES.M030 });

  config._migration = config._migration && typeof config._migration === 'object' ? config._migration : {};
  config._migration.v010 = { at: new Date().toISOString(), from, log };
  return { changed: true, log, from };
}

module.exports = {
  MIGRATION_CODES,
  authoritativeChannels,
  mapDisputeStrategy,
  migrateTextFlow,
  migrateImageFlow,
  flowSignature,
  stableStringify,
  syncIfStale,
  ensureFlows,
  retireReviewChannels,
  backupConfigFile,
  contentSafetyRefOf,
};
