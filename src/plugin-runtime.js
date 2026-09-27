/**
 * 插件运行时（src/plugin-runtime.js）—— 插件层的唯一装配点
 * server.js 只 require 本模块，不再认识 plugin-scanner / plugin-host / cordis-bridge / plugin-config。
 * 本模块把「插件层的全部对外能力」收敛为一个门面（facade），并负责：
 * ① 能力中介接线（broker.setTransport）—— 核心 ↔ 插件从此只经 broker
 * ② 桥接层初始化 + 插件扫描 + 拓扑装载 + 宿主阶段切换
 * ③ 插件系统整体开关（config.plugins.enabled / GRS_PLUGINS_ENABLED）
 * 设计依据：docs/architecture-2026-09-14.md §3.2（R1/R2）、附录 B
 */
const { logInfo, logError, logWarn } = require('./logger');
const bridge = require('./cordis-bridge');
const scanner = require('./plugin-scanner');
const pluginHost = require('./plugin-host');
const pluginConfig = require('./plugin-config');
const broker = require('./capability-broker');
const contract = require('./host-api/contract');
const eventRegistry = require('./host-api/event-registry');
const gate = require('./host-api/plugin-gate');

/** @type {boolean} 是否已完成初始化*/
let _initialized = false;
/** @type {boolean} 插件系统是否被配置禁用*/
let _disabled = false;

/**
 * 判定插件系统是否启用。
 * 关闭方式（任一即可）：config.plugins.enabled === false / 环境变量 GRS_PLUGINS_ENABLED=false|0|no
 * @param {object} config 站点配置
 * @returns {boolean} 是否启用
 */
function isEnabledByConfig(config = {}) {
  const env = String(process.env.GRS_PLUGINS_ENABLED || '').toLowerCase();
  if (env === 'false' || env === '0' || env === 'no') return false;
  if (config && config.plugins && config.plugins.enabled === false) return false;
  return true;
}

/**
 * 按 services.injects 做拓扑排序：被依赖的插件先装载。
 * @param {Array<object>} metas 插件元数据列表
 * @param {Array<string>} ids 待装载的插件 id
 * @returns {Array<string>} 排序后的 id
 */
function topoSort(metas, ids) {
  const byId = new Map(metas.map((m) => [m.id, m]));
  const provides = new Map(); // service → plugin id
  for (const m of metas) {
    for (const p of m.provides || []) provides.set(p, m.id);
  }
  const ready = new Set();
  const pending = [...ids];
  const out = [];
  let guard = 0;
  while (pending.length && guard++ < 100) {
    let progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i];
      const meta = byId.get(id);
      const deps = (meta && meta.injects) || [];
      const satisfied = deps.every((d) => !provides.has(d) || ready.has(provides.get(d)));
      if (satisfied) {
        out.push(id);
        ready.add(id);
        pending.splice(i, 1);
        i--;
        progressed = true;
      }
    }
    if (!progressed) {
      // 存在循环依赖：剩余的按原序追加，不阻断启动
      out.push(...pending);
      break;
    }
  }
  return out;
}

/**
 * 把「注册表当前状态」对齐到内存拓扑（**仅内存生效，绝不落盘**）。
 * 两件事：
 * ① 把插件终裁层显式化到图像拓扑（坑①：wd14 linkage 可见、可禁用、进 trace）
 * ② 按插件实际装载情况对齐内容安全下限层（决策 A 的收口）：
 * 已下线 ref → 内存改写为其后继 ref；后继也没注册 → 本次启动从内存剔除 + X25 warn
 * 关闭插件系统时**同样必须调用**：拓扑里只要残留一个未注册的 ref，
 * `validateFlow` 就会报 E004 → `getValidFlow` 返回 null → 整条链路静默退回旧引擎。
 * 缺一个插件不该把整套编排降级。
 * 不落盘：持久化交给显式写操作（PUT /api/flow/:modality）；每次启动按需重建，结果一致。
 * @param {object} config 站点配置（原地修改）
 */
function reconcileFlows(config) {
  try {
    const flow = require('./flow');
    flow.ensureBuiltins();
    const rec = flow.reconcileFinalizers(config);
    if (rec.changed) {
      const parts = [];
      if (rec.added.length) parts.push(`补齐 ${rec.added.join(', ')}`);
      if (rec.dropped.length) parts.push(`剔除陈旧 ${rec.dropped.join(', ')}`);
      logInfo('plugin-runtime', `图像拓扑终裁层已按插件装载情况对齐：${parts.join('；') || '无变化'}`);
    }
    const recCs = flow.reconcileContentSafetyFloors(config);
    if (recCs.changed) {
      logWarn('plugin-runtime', `内容安全下限层已按插件装载情况对齐：改写 ${recCs.rewritten.length} 项，剔除 ${recCs.dropped.length} 项`);
    }
    // 注册表现状相关的治理提示（X25–X27）：只有等插件装载后 ref 集合才确定。
    // R3-12 要求「内容安全已配置但插件未装载」必须产生告警，不允许静默。
    try {
      const refs = flow.registry.list().map((n) => n && n.ref).filter(Boolean);
      require('./config-conflicts').detectRefConflicts(config, refs, {
        log: (level, message) => (level === 'error' ? logError('config', message) : logWarn('config', message)),
      });
    } catch (err) {
      logWarn('plugin-runtime', `注册表相关治理提示生成失败（不影响主链路）: ${err.message}`);
    }
  } catch (err) {
    logError('plugin-runtime', `拓扑对齐失败（不影响主链路）: ${err.message}`);
  }
}

/**
 * 初始化插件系统（异步）。失败不抛异常到主链路。
 * @param {{app?: object, config?: object, moderator?: object, sharp?: object, vision?: object, projectRoot?: string}} [options] 宿主依赖
 * @returns {Promise<object>} 宿主状态
 */
async function init(options = {}) {
  if (_initialized) return getHostStatus();
  const config = options.config || {};

  if (!isEnabledByConfig(config)) {
    _disabled = true;
    _initialized = true;
    pluginHost.setPhase('disabled');
    logInfo('plugin-runtime', '插件系统已按配置禁用（plugins.enabled=false / GRS_PLUGINS_ENABLED），核心以「无插件」模式运行');
    // 关闭插件系统同样要对齐拓扑，否则残留的插件 ref 会让整个 DAG 校验失败
    reconcileFlows(config);
    return getHostStatus();
  }

  // 能力中介接线：核心只经 broker 触达插件层；关闭插件系统时这里根本不会发生
  broker.setTransport({
    emitCollect: bridge.emitCollect,
    emitFirst: bridge.emitFirst,
    emitCall: bridge.emitCall,
    hasHandlers: bridge.hasHandlers,
  });
  // 插件返回值 gate 的拒绝事件落日志（后续可接 src/security 审计）
  gate.onReject(({ event, reason, detail }) => {
    logError('plugin-runtime', `插件返回值被拒绝 event=${event} reason=${reason} detail=${detail}`);
  });

  // ① 桥接 cordis（失败自动降级到内置 plugin-system.js，不阻断主链路）
  const status = await bridge.initBridge({
    app: options.app || null,
    config: options.config || {},
    moderator: options.moderator || {},
    sharp: options.sharp || null,
    vision: options.vision || null,
    projectRoot: options.projectRoot || null,
  });
  logInfo('plugin-runtime', `插件桥接层就绪（phase=${status.phase}，degraded=${status.degraded}，cordis=${status.cordisVersion || '无'}）`);

  // ② 扫描插件目录
  const scan = scanner.scanPlugins();
  if (scan.invalid && scan.invalid.length) {
    for (const bad of scan.invalid) logError('plugin-runtime', `插件 ${bad.id} 未通过校验: ${bad.error}`);
  }

  // ③ 按依赖拓扑序装载已启用的插件（能力在 scanner.enable() 内注册到 broker）
  const enabledIds = scan.plugins.filter((m) => m.enabled).map((m) => m.id);
  const ordered = topoSort(scan.plugins, enabledIds);
  let loaded = 0;
  for (const id of ordered) {
    try {
      const res = await scanner.enable(id);
      if (res.ok) loaded++;
    } catch (err) {
      logError('plugin-runtime', `插件 ${id} 装载异常: ${err.message}`);
    }
  }

  // ④ 宿主路由代理转 ready（/api/p/* 由 503 转为可服务）
  pluginHost.setPhase('ready');
  _initialized = true;

  // ⑤ 插件装载后把注册表状态对齐到内存拓扑（终裁层显式化 + 内容安全下限层对齐）
  reconcileFlows(config);

  const providerCount = broker.providers().length;
  logInfo('plugin-runtime', `插件系统就绪：扫描 ${scan.plugins.length} 个，启用 ${loaded} 个，注册能力 ${providerCount} 项${status.degraded ? '（降级模式）' : ''}`);
  logInfo('plugin-runtime', `宿主 API 契约 v${contract.HOST_API_VERSION}；已声明事件：${eventRegistry.EVENT_NAMES.join(', ')}`);
  return getHostStatus();
}

/** 插件系统是否就绪*/
function isReady() {
  return _initialized && !_disabled;
}

/** 插件系统是否被配置禁用*/
function isDisabled() {
  return _disabled;
}

/** 取桥接层模块*/
function getBridgeModule() {
  return bridge;
}

/** 取根 BridgeContext（可能为 null）*/
function getBridge() {
  return bridge.getBridge();
}

/** 取扫描器模块*/
function getScanner() {
  return scanner;
}

/** 取插件宿主模块（路由代理 / RPC / asset）*/
function getHost() {
  return pluginHost;
}

/** 取插件配置模块*/
function getConfig() {
  return pluginConfig;
}

/** 取宿主阶段（booting / ready / disabled）*/
function getPhase() {
  return pluginHost.getPhase();
}

/** 某插件是否在线*/
function isPluginOnline(pid) {
  return pluginHost.isPluginOnline(pid);
}

/**
 * 分发一次插件 RPC（核心内部使用；HTTP 入口在 registerRoutes 注册）。
 * @param {string} pid 插件 id
 * @param {string} method 方法名
 * @param {any} params 参数
 * @returns {Promise<object>} 分发结果
 */
async function dispatchRpc(pid, method, params) {
  if (_disabled) return { ok: false, code: 404, error: `插件 ${pid} 未启用` };
  return pluginHost.dispatchRpc(pid, method, params);
}

/**
 * 在 Express app 上注册常驻的插件代理路由（必须在 404 兜底之前调用）。
 * @param {object} app Express 实例
 * @param {{requireAdmin?: Function}} [options] 选项
 */
function registerRoutes(app, options = {}) {
  pluginHost.registerPluginProxy(app, options);
}

/**
 * 插件宿主状态（/api/plugins 与 /api/plugins/host/status 共用）。
 * @returns {object} 状态对象
 */
function getHostStatus() {
  if (_disabled) {
    return {
      phase: 'disabled',
      degraded: false,
      cordisVersion: null,
      hostVersion: contract.HOST_VERSION,
      hostApiVersion: contract.HOST_API_VERSION,
      pluginCount: 0,
      error: null,
    };
  }
  return bridge.getHostStatus();
}

/**
 * 收集图片标签贡献（核心侧唯一入口；无插件 / 被禁用 → 空数组，行为与无插件逐字节一致）。
 * @param {string} imageBase64 base64 图片
 * @returns {Promise<Array<object>>} 贡献列表
 */
async function collectImageTags(imageBase64) {
  if (_disabled) return [];
  return broker.collectImageTags(imageBase64);
}

/**
 * 解析图片审核联动判定（返回值过 plugin-gate，gate 失败回落 undefined）。
 * @param {object} result 当前判定
 * @param {Array<object>} contributions 标签贡献
 * @returns {Promise<object|undefined>} 融合判定
 */
async function resolveImageLinkage(result, contributions) {
  if (_disabled) return undefined;
  return broker.resolveImageLinkage(result, contributions);
}

/** 能力提供者快照（诊断用，不进 /api/plugins 响应体，避免影响既有前端契约）*/
function listCapabilityProviders() {
  return broker.providers();
}

/** 供测试使用的状态重置*/
function _reset() {
  _initialized = false;
  _disabled = false;
}

module.exports = {
  init,
  isEnabledByConfig,
  isReady,
  isDisabled,
  getPhase,
  isPluginOnline,
  dispatchRpc,
  registerRoutes,
  getBridgeModule,
  getBridge,
  getScanner,
  getHost,
  getConfig,
  getHostStatus,
  collectImageTags,
  resolveImageLinkage,
  listCapabilityProviders,
  reconcileFlows,
  topoSort,
  _reset,
};
