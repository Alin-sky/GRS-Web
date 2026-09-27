/**
 * cordis 桥接层（src/cordis-bridge.js）
 * 本文件是**唯一**出现 cordis 调用的地方。cordis 4.0 仍是 RC 版本，API 可能变动，
 * 升级时只需改这一个文件，插件作者零感知（他们只见 BridgeContext）。
 * 职责：
 * 1. 动态加载 cordis（纯 ESM）：require 优先，失败回退 await import
 * 2. BridgeContext：对外暴露 13 个方法 + 4 个属性，语义与旧 src/plugin-system.js 保持一致
 * 3. 有序钩子注册表（带 order 优先级 + 错误隔离），实现 emitCollect / emitFirst
 * 4. FiberState → 对外状态映射
 * 5. cordis 不可用时整层降级到 src/plugin-system.js（R-A02）
 * 五处 cordis API 结论（实测，勿按旧文档写）：
 * ① 注册服务用 ctx.provide(name, value)，不是 intercept
 * ② new Context() 已自动创建 events/logger/reflect/registry，无需 isolate 注入
 * ③ 插件命名必须 Object.defineProperty(fn,'name',{value,configurable:true})
 * ④ ctx.on/once/emit/bail/serial 可直接在 ctx 上用（ReflectService 已 mixin）
 * ⑤ fiber 只有 then，没有 catch/finally —— 必须 try { await fiber }
 */
const path = require('path');
const { logInfo, logWarn, logError } = require('./logger');
const pluginConfig = require('./plugin-config');
const { createHostServices, loggerService } = require('./host-services');
const contract = require('./host-api/contract');
const eventRegistry = require('./host-api/event-registry');

/** 宿主版本号（唯一来源：契约层，供 manifest.host.minVersion 校验）*/
const HOST_VERSION = contract.HOST_VERSION;

// ─── 模块级状态 ───

/** @type {object|null} cordis 模块*/
let _cordis = null;
/** @type {object|null} cordis 根 Context*/
let _root = null;
/** @type {object|null} 宿主能力集合*/
let _host = null;
/** @type {'booting'|'ready'|'error'|'degraded'}*/
let _phase = 'booting';
/** @type {string|null} 初始化错误信息*/
let _initError = null;
/** @type {boolean} 是否处于降级模式（cordis 不可用）*/
let _degraded = false;
/** @type {object|null} 降级模式下的旧插件管理器*/
let _fallback = null;
/** @type {string|null} cordis 实际版本*/
let _cordisVersion = null;

/** 插件装载表：id → { id, name, def, fiber, ctx, status, error, permissions, manifest }*/
const _entries = new Map();

/** 有序主处理器表：event → Array<{fn, order, seq, owner}>*/
const _handlers = new Map();
/** 前置钩子表：event → Array<{fn, order, seq, owner}>*/
const _before = new Map();
/** 已镜像到 cordis 的事件集合*/
const _mirrored = new Set();
/** 注册序号（同 order 时按注册先后稳定排序）*/
let _seq = 0;

/** FiberState → 对外状态（架构文档 §9.4）*/
const FIBER_STATUS = {
  0: 'pending', 1: 'loading', 2: 'loaded', 3: 'error', 4: 'disabled', 5: 'unloading',
};

// ─── cordis 动态加载 ───

/**
 * 读取 cordis 版本号（失败返回 null）。
 * @returns {string|null}
 */
function readCordisVersion() {
  try {
    return require('cordis/package.json').version || null;
  } catch {
    return null;
  }
}

/**
 * 加载 cordis：Node ≥22.12 可直接 require(esm)，低版本回退 await import。
 * @returns {Promise<object|null>} cordis 模块，失败返回 null
 */
async function loadCordis() {
  const pick = (mod) => {
    if (!mod) return null;
    if (typeof mod.Context === 'function') return mod;
    if (mod.default && typeof mod.default.Context === 'function') return mod.default;
    return null;
  };
  try {
    const mod = pick(require('cordis'));
    if (mod) return mod;
  } catch (err) {
    logInfo('cordis-bridge', `require('cordis') 不可用（${err.code || err.message}），尝试动态 import`);
  }
  try {
    const mod = pick(await import('cordis'));
    if (mod) return mod;
  } catch (err) {
    logError('cordis-bridge', `cordis 加载失败，将降级到内置插件系统: ${err.message}`);
  }
  return null;
}

/**
 * 插件宿主桥（由 plugin-host 在模块加载时通过 setHostBridge 注入）。
 * 修 C09：桥接层不再 require('./plugin-host')，循环依赖彻底断开。
 * @type {object|null}
 */
let _hostBridge = null;

/**
 * 注入插件宿主实现（plugin-host 调用；其它模块不应调用）。
 * @param {object} impl { registerRpc, registerViews, allowAssetRoot, signAsset, unregisterPlugin }
 */
function setHostBridge(impl) {
  _hostBridge = impl || null;
}

/** 取已注入的插件宿主实现（未注入时返回 null，调用方静默跳过）*/
function hostModule() {
  return _hostBridge;
}

// ─── BridgeContext ───

/**
 * 插件唯一可见的上下文对象。
 * 包装 cordis Context，补全 required 语义、order 优先级、配置持久化、RPC 注册等能力。
 */
class BridgeContext {
  /**
   * @param {object} cordisCtx cordis Context
   * @param {{name?: string, permissions?: string[], manifest?: object}} options 选项
   */
  constructor(cordisCtx, options = {}) {
    this._ctx = cordisCtx;
    this._name = options.name || 'anonymous';
    this._permissions = Array.isArray(options.permissions) ? options.permissions : [];
    this._manifest = options.manifest || null;
    this._fiber = null;
    /** 宿主能力集合（脱敏冻结投影；契约 v1.0 起不含 app）*/
    this._host = null;
    /** 统一日志（保持与现有日志格式一致）*/
    this.logger = loggerService;
  }

  /** 插件 id*/
  get name() {
    return this._name;
  }

  /** 逃生舱：cordis 原生 Context（不稳定，cordis 升级可能失效）*/
  get raw() {
    return this._ctx;
  }

  /** 宿主能力集合（脱敏冻结只读投影，修 C10/C11/C12）*/
  get host() {
    if (!this._host) this._host = _host || createHostServices({});
    return this._host;
  }

  /**
   * 注册服务（可带生命周期）。
   * @param {string} key 服务键
   * @param {any} impl 服务实现
   * @param {{start?: Function, stop?: Function}} [lifecycle] 生命周期回调
   * @returns {any} 服务实现
   */
  provide(key, impl, lifecycle = null) {
    _checkProvideKey(this._manifest, this._name, key);
    this._ctx.provide(key, impl);
    if (lifecycle && (typeof lifecycle.start === 'function' || typeof lifecycle.stop === 'function')) {
      this._ctx.effect(() => {
        if (typeof lifecycle.start === 'function') lifecycle.start();
        if (typeof lifecycle.stop === 'function') return () => lifecycle.stop();
        return undefined;
      });
    }
    logInfo('cordis-bridge', `插件 ${this._name} 提供服务: ${key}`);
    return impl;
  }

  /**
   * 注入服务。cordis 对缺失 key 不抛异常，required 语义由桥接层补全。
   * @param {string} key 服务键
   * @param {boolean} [required=true] 缺失时是否抛错
   * @returns {any|undefined} 服务实现
   */
  inject(key, required = true) {
    // v1.1：受控服务按插件 id 绑定（secrets 白名单 / precheck 词库不出库）
    if (key === 'secrets') return this.secrets;
    if (key === 'precheck') {
      const svc = (this.host && this.host.precheck) || null;
      if (!svc && required) throw new Error(`插件 ${this._name} 依赖的服务未提供: precheck`);
      return svc || { match: () => ({ hit: false, category: '', level: '' }) };
    }
    const value = typeof this._ctx.get === 'function' ? this._ctx.get(key, false) : this._ctx[key];
    if (value === undefined && required) {
      throw new Error(`插件 ${this._name} 依赖的服务未提供: ${key}`);
    }
    return value;
  }

  /**
   * 受控密钥访问器（按插件 id 绑定白名单）。
   * @returns {{get: (configPath: string) => string|null, grantsOf: Function}}
   */
  get secrets() {
    const svc = (this.host && this.host.secrets) || null;
    if (!svc) return { get: () => null, grantsOf: () => [] };
    return {
      get: (configPath) => svc.get(this._name, configPath),
      grantsOf: () => svc.grantsOf(this._name),
    };
  }

  /**
   * 注册钩子（带 order 优先级，数值越小越先执行）。
   * @param {string} event 事件名
   * @param {Function} handler 处理器
   * @param {{order?: number}} [options] 选项
   * @returns {BridgeContext} this
   */
  on(event, handler, options = {}) {
    _checkEvent(event, this._name);
    _addHandler(_handlers, event, handler, options.order ?? 0, this._name);
    _ensureMirror(event);
    return this;
  }

  /**
   * 注册前置钩子（返回非空值即短路主处理器）。
   * @param {string} event 事件名
   * @param {Function} handler 处理器
   * @returns {BridgeContext} this
   */
  before(event, handler) {
    _checkEvent(event, this._name);
    _addHandler(_before, event, handler, 0, this._name);
    return this;
  }

  /**
   * 收集模式：并行跑全部主处理器，收集非空返回值（按 order 排序，异常隔离）。
   * @param {string} event 事件名
   * @param {...any} args 参数
   * @returns {Promise<Array<any>>}
   */
  async emitCollect(event, ...args) {
    return emitCollect(event, ...args);
  }

  /**
   * 短路模式：按 order 顺序，首个非空返回即返回（false 也会短路，沿用自研语义）。
   * @param {string} event 事件名
   * @param {...any} args 参数
   * @returns {Promise<any>}
   */
  async emitFirst(event, ...args) {
    return emitFirst(event, ...args);
  }

  /**
   * 点对点调用模式：只执行 owner 匹配的处理器（v1.1）。
   * @param {string} event 事件名
   * @param {string} owner 目标插件 id
   * @param {...any} args 参数
   * @returns {Promise<any>}
   */
  async emitCall(event, owner, ...args) {
    return emitCall(event, owner, ...args);
  }

  /**
   * 获取插件配置（Proxy：读走磁盘+默认值，写自动持久化）。
   * @param {object} schema { name, title, description, fields: [{key,type,label,default,min,max,step,unit}] }
   * @returns {Proxy<object>}
   */
  config(schema) {
    return pluginConfig.getConfig(schema);
  }

  /**
   * 创建子作用域。
   * @param {string} name 作用域名
   * @returns {BridgeContext}
   */
  scope(name) {
    const sub = typeof this._ctx.isolate === 'function' ? this._ctx.isolate(name) : this._ctx;
    const child = new BridgeContext(sub, {
      name: `${this._name}#${name}`,
      permissions: this._permissions,
      manifest: this._manifest,
    });
    child._host = this._host;
    return child;
  }

  /**
   * 加载子插件（随本插件一起卸载）。
   * @param {Function|object} subPlugin 子插件
   * @param {object} [config] 配置
   * @returns {Promise<object>} cordis Fiber
   */
  async plugin(subPlugin, config = undefined) {
    const resolved = resolveDef(subPlugin);
    const wrapped = _wrapPlugin(resolved.fn, resolved.name, resolved.schema, this._permissions, null);
    const fiber = this._ctx.plugin(wrapped, config);
    try {
      await fiber;
    } catch (err) {
      logError('cordis-bridge', `子插件 ${resolved.name} 加载失败: ${err.message}`);
      throw err;
    }
    return fiber;
  }

  /**
   * 注册清理函数（插件卸载时逆序执行）。
   * @param {Function} fn 清理函数
   * @returns {BridgeContext} this
   */
  onDispose(fn) {
    if (typeof fn === 'function') this._ctx.effect(() => fn);
    return this;
  }

  /** 卸载本插件*/
  async dispose() {
    await unloadPlugin(this._name);
  }

  /**
   * 本插件运行状态。
   * @returns {'pending'|'loading'|'active'|'failed'|'disposed'|'unloading'|'unknown'}
   */
  getStatus() {
    const fiber = this._fiber || (this._ctx && this._ctx.fiber) || (_entries.get(this._name) || {}).fiber;
    if (!fiber || fiber.state === undefined || !_cordis) return 'unknown';
    const name = _cordis.FiberState ? _cordis.FiberState[fiber.state] : null;
    return name ? String(name).toLowerCase() : 'unknown';
  }

  /**
   * 注册 RPC 方法（供前端 POST /api/p/:pid/rpc 调用）。
   * @param {string} method 方法名（域.动作）
   * @param {Function} handler 处理函数
   * @param {{write?: boolean}} [opts] write=true 强制密码校验
   * @returns {BridgeContext} this
   */
  rpc(method, handler, opts = {}) {
    const mod = hostModule();
    if (mod && typeof mod.registerRpc === 'function') {
      mod.registerRpc(this._name, method, handler, { write: opts.write === true });
    }
    return this;
  }

  /**
   * 注册 UI 视图（运行时声明，会与 manifest 中的 contributes.views 合并）。
   * @param {Array<object>} views 视图定义数组
   * @returns {BridgeContext} this
   */
  views(views) {
    const mod = hostModule();
    if (mod && typeof mod.registerViews === 'function') {
      mod.registerViews(this._name, views);
    }
    return this;
  }

  /**
   * 登记 asset 路径白名单（该目录下的文件才允许通过 asset 通道读取）。
   * @param {string} dir 目录绝对路径
   * @returns {BridgeContext} this
   */
  allowAssetRoot(dir) {
    const mod = hostModule();
    if (mod && typeof mod.allowAssetRoot === 'function') mod.allowAssetRoot(this._name, dir);
    return this;
  }

  /**
   * 签发一个带签名的临时资源引用（TTL 5 分钟）。
   * @param {string} absPath 绝对路径（必须落在已登记的白名单内）
   * @returns {{key: string, sig: string, exp: number, url: string}|null}
   */
  signAsset(absPath) {
    const mod = hostModule();
    if (mod && typeof mod.signAsset === 'function') return mod.signAsset(this._name, absPath);
    return null;
  }
}

// ─── 降级模式（cordis 不可用）用的上下文适配器 ───

/**
 * 降级上下文：包装 src/plugin-system.js 的 Context，补齐 BridgeContext 的方法集。
 * 保证 wd14-tagger 等插件在 cordis 缺失时仍能零改动运行。
 */
class FallbackBridgeContext {
  /**
   * @param {object} legacyCtx plugin-system 的 Context
   * @param {{name?: string, permissions?: string[]}} options 选项
   */
  constructor(legacyCtx, options = {}) {
    this._legacy = legacyCtx;
    this._name = options.name || (legacyCtx && legacyCtx.name) || 'anonymous';
    this._permissions = Array.isArray(options.permissions) ? options.permissions : [];
    this.logger = loggerService;
    this.raw = legacyCtx;
  }

  get name() { return this._name; }

  get host() {
    return _host || createHostServices({});
  }

  provide(key, impl, lifecycle = null) { return this._legacy.provide(key, impl, lifecycle || {}); }

  inject(key, required = true) {
    if (key === 'secrets') return this.secrets;
    if (key === 'precheck') return (_host && _host.precheck) || { match: () => ({ hit: false, category: '', level: '' }) };
    // v2.4.0：通用 KV 服务。降级模式下同样直接从 _host 取，与 cordis 路径一致。
    if (key === 'kvStore') {
      const svc = _host && _host.kvStore;
      if (!svc && required) throw new Error(`插件 ${this._name} 依赖的服务未提供: kvStore`);
      return svc;
    }
    // v2.3.0（Req5）：对比审核四件套 + 编排引擎。降级模式下 legacy ctx 并未 provide
    // 这些服务，若走默认分支会拿到 undefined → 插件报「依赖的服务未提供」。
    // 它们全部来自宿主能力集合，直接从 _host 取即可，与 cordis 路径行为一致。
    if (key === 'comparisonSource' || key === 'comparisonStore' || key === 'comparisonProbe'
      || key === 'comparisonCore' || key === 'comparisonEngine') {
      const svc = _host && _host[key];
      if (!svc && required) throw new Error(`插件 ${this._name} 依赖的服务未提供: ${key}`);
      return svc;
    }
    return this._legacy.inject(key, required);
  }

  /** 受控密钥访问器（降级路径同样按插件 id 绑定白名单）。*/
  get secrets() {
    const svc = (_host && _host.secrets) || null;
    if (!svc) return { get: () => null, grantsOf: () => [] };
    return {
      get: (configPath) => svc.get(this._name, configPath),
      grantsOf: () => svc.grantsOf(this._name),
    };
  }

  /**
   * 注册钩子（ 降级模式同样登记到桥接层**带 owner** 的有序表，
   * 否则 emitCall 无法按 owner 点对点定位 —— 会把结论挂到错误的 ref 上）。
   * @param {string} event 事件名
   * @param {Function} handler 处理器
   * @param {{order?: number}} [options] 选项
   * @returns {FallbackBridgeContext} this
   */
  on(event, handler, options = {}) {
    _addHandler(_handlers, event, handler, options.order ?? 0, this._name);
    this._legacy.on(event, handler, options || {});
    return this;
  }

  /**
   * 注册前置钩子（同样带 owner 登记）。
   * @param {string} event 事件名
   * @param {Function} handler 处理器
   * @returns {FallbackBridgeContext} this
   */
  before(event, handler) {
    _addHandler(_before, event, handler, 0, this._name);
    this._legacy.before(event, handler);
    return this;
  }

  async emitCollect(event, ...args) { return emitCollect(event, ...args); }

  async emitFirst(event, ...args) { return emitFirst(event, ...args); }

  async emitCall(event, owner, ...args) { return emitCall(event, owner, ...args); }

  config(schema) { return this._legacy.config(schema); }

  scope(name) {
    const child = new FallbackBridgeContext(this._legacy.scope(name), { permissions: this._permissions });
    child._name = `${this._name}#${name}`;
    return child;
  }

  async plugin(subPlugin) { this._legacy.plugin(subPlugin); return null; }

  onDispose(fn) { this._legacy.onDispose(fn); return this; }

  async dispose() { this._legacy.dispose(); }

  getStatus() { return 'loaded'; }

  rpc(method, handler, opts = {}) {
    const mod = hostModule();
    if (mod && typeof mod.registerRpc === 'function') {
      mod.registerRpc(this._name, method, handler, { write: opts.write === true });
    }
    return this;
  }

  views(views) {
    const mod = hostModule();
    if (mod && typeof mod.registerViews === 'function') mod.registerViews(this._name, views);
    return this;
  }

  allowAssetRoot(dir) {
    const mod = hostModule();
    if (mod && typeof mod.allowAssetRoot === 'function') mod.allowAssetRoot(this._name, dir);
    return this;
  }

  signAsset(absPath) {
    const mod = hostModule();
    if (mod && typeof mod.signAsset === 'function') return mod.signAsset(this._name, absPath);
    return null;
  }
}

// ─── 契约校验（软告警，阶段 C 转硬拦截） ───

/** 已告警过的契约问题（避免重复刷屏）*/
const _warned = new Set();

function _warnOnce(tag, message) {
  if (_warned.has(tag)) return;
  _warned.add(tag);
  logWarn('cordis-bridge', message);
}

/**
 * 校验 ctx.provide 的服务键：必须属宿主服务白名单，或已在 manifest.services.provides 声明。
 * @param {object|null} manifest 插件 manifest
 * @param {string} owner 插件 id
 * @param {string} key 服务键
 */
function _checkProvideKey(manifest, owner, key) {
  if (contract.HOST_SERVICE_KEYS.includes(key)) {
    _warnOnce(`provide:${owner}:${key}`, `插件 ${owner} 覆盖了宿主服务键 '${key}'（建议改用插件自有命名空间）`);
    return;
  }
  const declared = (manifest && manifest.services && manifest.services.provides) || [];
  if (!declared.includes(key)) {
    _warnOnce(`provide-undeclared:${owner}:${key}`, `插件 ${owner} 提供了未在 manifest.services.provides 声明的服务 '${key}'`);
  }
}

/**
 * 校验 ctx.on / ctx.before 的事件名是否已在 event-registry 声明。
 * @param {string} event 事件名
 * @param {string} owner 插件 id
 */
function _checkEvent(event, owner) {
  if (typeof event !== 'string' || !event) {
    throw new Error('事件名必须是非空字符串');
  }
  if (!eventRegistry.isKnownEvent(event)) {
    _warnOnce(`event:${event}`, `插件 ${owner} 监听未在 host-api/event-registry 声明的事件 '${event}'（契约外事件，建议补充注册表）`);
  }
}

// ─── 有序钩子注册表 ───

function _addHandler(table, event, handler, order, owner) {
  if (typeof handler !== 'function') throw new Error(`事件 ${event} 的处理器必须是函数`);
  const list = table.get(event) || [];
  list.push({ fn: handler, order, seq: _seq++, owner });
  list.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
  table.set(event, list);
}

/** 插件卸载时摘除其全部钩子*/
function _removeOwnerHandlers(owner) {
  for (const table of [_handlers, _before]) {
    for (const [event, list] of table.entries()) {
      const next = list.filter((h) => h.owner !== owner);
      if (next.length !== list.length) table.set(event, next);
    }
  }
}

/** 镜像一个 cordis 监听器，让原生 emit/bail/serial 也走有序链（短路语义）*/
function _ensureMirror(event) {
  if (_mirrored.has(event) || !_root) return;
  _mirrored.add(event);
  try {
    _root.on(event, (...args) => {
      for (const h of [...(_handlers.get(event) || [])]) {
        const r = h.fn(...args);
        if (r !== undefined && r !== null) return r;
      }
      return undefined;
    });
  } catch (err) {
    logError('cordis-bridge', `事件 ${event} 镜像到 cordis 失败: ${err.message}`);
  }
}

/** 执行前置钩子，返回 {has, value}*/
async function _runBefore(event, args) {
  for (const h of [...(_before.get(event) || [])]) {
    try {
      const r = await h.fn(...args);
      if (r !== undefined && r !== null) return { has: true, value: r };
    } catch (err) {
      logError('cordis-bridge', `事件 ${event} 前置钩子异常: ${err.message}`);
    }
  }
  return { has: false, value: undefined };
}

/**
 * 收集模式：并行跑全部主处理器，收集非空返回值（保持 order 顺序，异常逐条隔离）。
 * @param {string} event 事件名
 * @param {...any} args 参数
 * @returns {Promise<Array<any>>}
 */
async function emitCollect(event, ...args) {
  const short = await _runBefore(event, args);
  if (short.has) return [short.value];

  const list = [...(_handlers.get(event) || [])];
  if (list.length === 0) {
    // 安全网：降级模式下若插件经非 ctx 路径登记（未进桥接表），回落到旧引擎
    if (_degraded && _fallback) {
      try {
        return await _fallback.hook(event).runCollect(...args);
      } catch (err) {
        logError('cordis-bridge', `降级模式事件 ${event} 触发异常: ${err.message}`);
      }
    }
    return [];
  }
  const results = new Array(list.length);
  await Promise.all(list.map(async (h, i) => {
    try {
      results[i] = await h.fn(...args);
    } catch (err) {
      results[i] = undefined;
      logError('cordis-bridge', `事件 ${event} 处理器异常（${h.owner}）: ${err.message}`);
    }
  }));
  return results.filter((r) => r !== undefined && r !== null);
}

/**
 * 短路模式：按 order 顺序执行，首个非空返回即返回（沿用自研语义：false 也短路）。
 * @param {string} event 事件名
 * @param {...any} args 参数
 * @returns {Promise<any>}
 */
async function emitFirst(event, ...args) {
  const short = await _runBefore(event, args);
  if (short.has) return short.value;

  const list = [...(_handlers.get(event) || [])];
  if (list.length === 0 && _degraded && _fallback) {
    try {
      return await _fallback.hook(event).runFirst(...args);
    } catch (err) {
      logError('cordis-bridge', `降级模式事件 ${event} 触发异常: ${err.message}`);
      return undefined;
    }
  }
  for (const h of list) {
    try {
      const r = await h.fn(...args);
      if (r !== undefined && r !== null) return r;
    } catch (err) {
      logError('cordis-bridge', `事件 ${event} 处理器异常（${h.owner}）: ${err.message}`);
    }
  }
  return undefined;
}

/** 某事件是否有主处理器*/
function hasHandlers(event) {
  return (_handlers.get(event) || []).length > 0;
}

/**
 * 点对点调用模式（v1.1）：只执行 owner 匹配的处理器，首个非空返回即结果。
 * owner 省略时退化为按 order 顺序的 emitFirst 语义。
 * @param {string} event 事件名
 * @param {string} owner 目标插件 id（点对点定位）
 * @param {...any} args 参数
 * @returns {Promise<any>} 首个非空返回值，或 undefined
 */
async function emitCall(event, owner, ...args) {
  const short = await _runBefore(event, args);
  if (short.has) return short.value;

  const list = [...(_handlers.get(event) || [])];
  // 点对点语义：只执行 owner 匹配的处理器；**绝不回落 runFirst**（那会把结论挂到错误的 ref 上）。
  // 无匹配 → 返回 undefined，交由 capability-broker/执行器记为 plugin_rejected / skipped。
  for (const h of list) {
    if (!owner || h.owner !== owner) continue;
    try {
      const r = await h.fn(...args);
      if (r !== undefined && r !== null) return r;
    } catch (err) {
      logError('cordis-bridge', `事件 ${event} 点对点处理器异常（${h.owner}）: ${err.message}`);
    }
  }
  return undefined;
}

// ─── 插件定义解析与包装 ───

/**
 * 解析插件定义，统一为 { fn, name, schema }。
 * @param {Function|object} def 插件定义（函数或 {name, apply, schema, configSchema}）
 * @param {string} [fallbackId] 兜底 id
 * @returns {{fn: Function, name: string, schema: object|null}}
 */
function resolveDef(def, fallbackId = '') {
  if (typeof def === 'function') {
    const name = (def.name && def.name !== 'plugin') ? def.name : (fallbackId || def.name || 'anonymous');
    return { fn: def, name, schema: def.schema || def.configSchema || null };
  }
  if (def && typeof def.apply === 'function') {
    const name = def.name || fallbackId || 'anonymous';
    return { fn: def.apply, name, schema: def.schema || def.configSchema || null };
  }
  throw new Error('插件必须是函数 (ctx, config) => {} 或 { name, apply } 对象');
}

/**
 * 读取插件的配置 schema（支持对象或 (values) => schema 函数形式）。
 * @param {object|Function|null} raw schema 定义
 * @param {object} savedValues 已保存的配置值
 * @returns {object|null}
 */
function resolveSchema(raw, savedValues = {}) {
  if (!raw) return null;
  if (typeof raw === 'function') {
    try {
      return raw(savedValues) || null;
    } catch (err) {
      logError('cordis-bridge', `解析插件配置 schema 失败: ${err.message}`);
      return null;
    }
  }
  return raw;
}

/** 包装插件函数，使其在 cordis 中运行时拿到 BridgeContext*/
function _wrapPlugin(fn, name, schema, permissions, manifest) {
  const wrapped = function cordisWrappedPlugin(cordisCtx, config) {
    const bctx = new BridgeContext(cordisCtx, { name, permissions, manifest });
    const entry = _entries.get(name);
    if (entry) {
      entry.ctx = bctx;
      bctx._fiber = entry.fiber || null;
    }
    return fn(bctx, config);
  };
  // 严格模式下 fn.name 只读，必须用 defineProperty
  Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
  if (schema && Array.isArray(schema.fields)) {
    wrapped.Config = pluginConfig.toStandardSchema(schema.fields);
    wrapped.description = schema.description || '';
    wrapped.version = schema.version || (manifest && manifest.version) || '';
  }
  return wrapped;
}

// ─── 初始化 ───

/**
 * 初始化桥接层。失败不抛异常，转入降级模式。
 * @param {{app?: object, config?: object, moderator?: object, sharp?: object, projectRoot?: string}} options 宿主依赖
 * @returns {Promise<{phase: string, degraded: boolean, cordisVersion: string|null, pluginCount: number, error: string|null}>}
 */
async function initBridge(options = {}) {
  if (_phase === 'ready' || _phase === 'degraded') return getHostStatus();

  _host = createHostServices({
    app: options.app || null,
    config: options.config || {},
    moderator: options.moderator || {},
    sharp: options.sharp || null,
    vision: options.vision || null,
    projectRoot: options.projectRoot || path.join(__dirname, '..'),
  });

  _cordis = await loadCordis();
  if (!_cordis) {
    _degraded = true;
    _phase = 'degraded';
    _initError = 'cordis 不可用';
    const { PluginManager } = require('./plugin-system');
    _fallback = new PluginManager();
    logError('cordis-bridge', 'cordis 加载失败，已降级到内置插件系统（src/plugin-system.js）。插件仍可用，但不支持 cordis 高级特性。');
    return getHostStatus();
  }

  _cordisVersion = readCordisVersion();
  try {
    _root = new _cordis.Context();
    // 宿主能力一次性 provide 到根 ctx（new Context() 已自带 events/logger/reflect/registry）
    _root.provide('config', _host.config);
    _root.provide('moderator', _host.moderator);
    _root.provide('sharp', _host.sharp);
    _root.provide('vision', _host.vision);
    _root.provide('fs', _host.fs);
    _root.provide('hostServices', _host);
    // v1.1：受控注入项（密钥白名单下发 + 词库不出库判定）
    _root.provide('secrets', _host.secrets);
    _root.provide('precheck', _host.precheck);
    // v2.4.0：通用持久化 KV 服务（带 TTL，命名空间隔离）
    _root.provide('kvStore', _host.kvStore);
    // v2.3.0（Req5）：对比审核四件套（输入侧 / 输出侧 / 探针 / 纯逻辑）
    _root.provide('comparisonSource', _host.comparisonSource);
    _root.provide('comparisonStore', _host.comparisonStore);
    _root.provide('comparisonProbe', _host.comparisonProbe);
    _root.provide('comparisonCore', _host.comparisonCore);
    _root.provide('comparisonEngine', _host.comparisonEngine);
    _phase = 'ready';
    logInfo('cordis-bridge', `cordis ${_cordisVersion || '未知版本'} 加载成功，宿主 v${HOST_VERSION} 服务已注入`);
  } catch (err) {
    _degraded = true;
    _phase = 'degraded';
    _initError = err.message;
    const { PluginManager } = require('./plugin-system');
    _fallback = new PluginManager();
    logError('cordis-bridge', `cordis 上下文创建失败，已降级: ${err.message}`);
  }
  return getHostStatus();
}

/**
 * 装载插件。
 * @param {string} id 插件 id
 * @param {Function|object} def 插件定义
 * @param {{config?: object, permissions?: string[], manifest?: object}} [options] 选项
 * @returns {Promise<{ok: boolean, status: string, error?: string}>}
 */
async function loadPlugin(id, def, options = {}) {
  const { permissions = [], manifest = null } = options;
  try {
    const resolved = resolveDef(def, id);
    const savedValues = pluginConfig.values(id);
    const schema = resolveSchema(resolved.schema, savedValues);
    if (schema) {
      pluginConfig.registerSchema(schema);
      // 若为函数式 schema，用已保存值再取一次确保字段完整
      if (typeof resolved.schema === 'function') pluginConfig.getConfig(schema);
    }

    if (_degraded || !_root) {
      const entry = { id, name: id, def, fiber: null, ctx: null, status: 'loading', error: null, permissions, manifest };
      _entries.set(id, entry);
      // 先卸载旧的（重载场景），再重新登记并装载
      if (_fallback.getPluginStatus(id) === 'loaded') _fallback.disposePlugin(id);
      const wrappedLegacy = function legacyWrappedPlugin(legacyCtx, config) {
        const bctx = new FallbackBridgeContext(legacyCtx, { name: id, permissions });
        entry.ctx = bctx;
        if (schema) pluginConfig.registerSchema(schema);
        return resolved.fn(bctx, config);
      };
      Object.defineProperty(wrappedLegacy, 'name', { value: id, configurable: true });
      wrappedLegacy.description = (manifest && manifest.description) || '';
      wrappedLegacy.version = (manifest && manifest.version) || '';
      _fallback.plugin(wrappedLegacy);
      const loaded = _fallback.getPluginStatus(id) === 'loaded';
      entry.status = loaded ? 'loaded' : 'error';
      logInfo('cordis-bridge', `[降级] 插件已装载: ${id}（${entry.status}）`);
      return { ok: loaded, status: entry.status };
    }

    const configValues = schema ? pluginConfig.values(id) : undefined;
    const wrapped = _wrapPlugin(resolved.fn, id, schema, permissions, manifest);
    const entry = { id, name: id, def, fiber: null, ctx: null, status: 'loading', error: null, permissions, manifest };
    _entries.set(id, entry);

    const fiber = _root.plugin(wrapped, configValues && Object.keys(configValues).length ? configValues : undefined);
    entry.fiber = fiber;
    try {
      // fiber 没有 catch，必须 try/catch；配置校验失败时也走这里（fiber 停留 PENDING）
      await fiber;
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
      logError('cordis-bridge', `插件 ${id} 加载失败: ${err.message}`);
      return { ok: false, status: 'error', error: err.message };
    }
    if (entry.ctx) entry.ctx._fiber = fiber;
    entry.status = FIBER_STATUS[fiber.state] || 'loaded';
    logInfo('cordis-bridge', `插件已装载: ${id}（${entry.status}）`);
    return { ok: true, status: entry.status };
  } catch (err) {
    logError('cordis-bridge', `插件 ${id} 装载异常: ${err.message}`);
    return { ok: false, status: 'error', error: err.message };
  }
}


/**
 * 卸载插件（逆序清理，摘除钩子与 RPC/视图）。
 * @param {string} id 插件 id
 * @returns {Promise<{ok: boolean, status: string}>}
 */
async function unloadPlugin(id) {
  const entry = _entries.get(id);
  if (_degraded || !_root) {
    if (_fallback) {
      _fallback.disposePlugin(id);
      _removeOwnerHandlers(id);
      const mod = hostModule();
      if (mod && typeof mod.unregisterPlugin === 'function') mod.unregisterPlugin(id);
      _entries.delete(id);
      logInfo('cordis-bridge', `[降级] 插件已卸载: ${id}`);
      return { ok: true, status: 'disabled' };
    }
    return { ok: false, status: 'unknown' };
  }
  if (!entry) {
    _removeOwnerHandlers(id);
    return { ok: true, status: 'disabled' };
  }
  try {
    if (entry.fiber && typeof entry.fiber.dispose === 'function') {
      await entry.fiber.dispose();
    }
  } catch (err) {
    logError('cordis-bridge', `插件 ${id} 卸载异常: ${err.message}`);
  }
  _removeOwnerHandlers(id);
  const mod = hostModule();
  if (mod && typeof mod.unregisterPlugin === 'function') mod.unregisterPlugin(id);
  entry.status = 'disabled';
  entry.ctx = null;
  logInfo('cordis-bridge', `插件已卸载: ${id}`);
  return { ok: true, status: 'disabled' };
}

/** 取插件装载条目*/
function getPlugin(id) {
  return _entries.get(id) || null;
}

/** 列出全部已装载插件的简要信息*/
function listPlugins() {
  const out = [];
  for (const [id, e] of _entries.entries()) {
    out.push({
      id,
      name: id,
      status: _degraded ? (e.status || 'loaded') : (_statusOf(e) || e.status),
      error: e.error || null,
    });
  }
  return out;
}

function _statusOf(entry) {
  if (!entry) return 'unknown';
  if (entry.ctx && typeof entry.ctx.getStatus === 'function') {
    const raw = entry.ctx.getStatus();
    const map = { pending: 'pending', loading: 'loading', active: 'loaded', failed: 'error', disposed: 'disabled', unloading: 'unloading' };
    if (raw && map[raw]) return map[raw];
  }
  if (entry.fiber && entry.fiber.state !== undefined && _cordis && _cordis.FiberState) {
    return FIBER_STATUS[entry.fiber.state] || 'unknown';
  }
  return entry.status || 'unknown';
}

// ─── 状态查询 ───

/** 桥接层是否就绪*/
function isReady() {
  return _phase === 'ready' || _phase === 'degraded';
}

/** 是否处于降级模式*/
function isDegraded() {
  return _degraded === true;
}

/** @type {BridgeContext|null} 根桥接上下文单例*/
let _bridgeSingleton = null;

/**
 * 根 BridgeContext（供宿主内部使用）。
 * 修 C10：不再用 ['host:app'] 造 root —— 契约 v1.0 起宿主不向任何上下文暴露 Express 实例。
 */
function getBridge() {
  if (!_root) return null;
  if (!_bridgeSingleton) {
    _bridgeSingleton = new BridgeContext(_root, { name: 'root', permissions: [] });
  }
  return _bridgeSingleton;
}

/**
 * 插件宿主状态（GET /api/plugins/host/status）。
 * @returns {{phase: string, degraded: boolean, cordisVersion: string|null, pluginCount: number, error: string|null}}
 */
function getHostStatus() {
  return {
    phase: _phase === 'degraded' ? 'ready' : _phase,
    degraded: _degraded,
    cordisVersion: _cordisVersion,
    hostVersion: HOST_VERSION,
    pluginCount: _entries.size,
    error: _initError,
  };
}

/** 取根 cordis Context（高级用途，通常不需要）*/
function getRootContext() {
  return _root;
}

/** 取宿主能力集合*/
function getHost() {
  return _host;
}

/** 置为 error 阶段（插件系统初始化严重失败时使用）*/
function markError(message) {
  _phase = 'error';
  _initError = message || '插件系统初始化失败';
}

module.exports = {
  HOST_VERSION,
  setHostBridge,
  BridgeContext,
  FallbackBridgeContext,
  initBridge,
  loadPlugin,
  unloadPlugin,
  getPlugin,
  listPlugins,
  getBridge,
  getRootContext,
  getHost,
  getHostStatus,
  isReady,
  isDegraded,
  markError,
  emitCollect,
  emitFirst,
  emitCall,
  hasHandlers,
  resolveDef,
  resolveSchema,
  FIBER_STATUS,
};
