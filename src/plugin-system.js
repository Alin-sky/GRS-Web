/**
 * 插件系统核心（借鉴 cordis 架构）
 * 对齐 cordis 的核心范式，但保持轻量、无外部依赖，专为审核流程扩展设计：
 * 1. 服务注入（Service Injection）：
 * - ctx.provide(key, impl, { start, stop }) 提供服务（可带生命周期）
 * - ctx.inject(key, required?) 注入依赖（沿作用域链向上查找）
 * - 服务惰性启动：插件加载后统一 start，卸载时逆序 stop
 * 2. 依赖声明（Dependency）：
 * - 插件函数可声明 .using = ['dep-plugin']，管理器按依赖顺序加载
 * - 可声明 .inject = ['service'] 明确依赖的服务
 * 3. 作用域（Scope）：
 * - ctx.scope(name) 创建子作用域，服务/钩子/插件作用域隔离
 * - 子作用域 dispose 时只清理自己的资源，不影响父作用域
 * 4. 事件系统（Hook）：
 * - on(event, handler, { order }) 按优先级注册
 * - before(event, handler) 前置钩子，返回非空值可短路后续处理
 * - 两种触发模式：收集（多插件贡献）与短路（单一判定）
 * 5. 生命周期（Lifecycle）：
 * - 插件返回 dispose 函数或调用 ctx.onDispose 注册清理
 * - 卸载顺序与加载顺序相反
 */

const { logInfo, logError } = require('./logger');
const fs = require('fs');
const path = require('path');

/**
 * 异步钩子：一串带优先级的处理器。
 * 处理器形如 async (...args) => value；返回非空值视为「有结果」。
 */
class Hook {
  constructor(name) {
    this.name = name;
    this._before = [];   // 前置钩子（可短路）
    this._handlers = []; // 主处理器（{ order, fn }）
  }

  /** 注册前置钩子（返回非空值则短路，阻止主处理器）*/
  registerBefore(fn) {
    if (typeof fn !== 'function') throw new Error(`Hook ${this.name}: 前置处理器必须是函数`);
    this._before.push(fn);
    return () => {
      const i = this._before.indexOf(fn);
      if (i >= 0) this._before.splice(i, 1);
    };
  }

  /** 注册主处理器*/
  register(fn, order = 0) {
    if (typeof fn !== 'function') throw new Error(`Hook ${this.name}: 处理器必须是函数`);
    const entry = { order, fn };
    this._handlers.push(entry);
    this._handlers.sort((a, b) => a.order - b.order);
    return () => {
      const i = this._handlers.indexOf(entry);
      if (i >= 0) this._handlers.splice(i, 1);
    };
  }

  /** 前置钩子短路检测：返回第一个非空结果，无则 undefined*/
  async _runBefore(...args) {
    for (const fn of this._before) {
      try {
        const r = await fn(...args);
        if (r !== undefined && r !== null) return r;
      } catch (err) {
        logError('plugin', `钩子 ${this.name} 前置处理器异常: ${err.message}`);
      }
    }
    return undefined;
  }

  /** 收集模式：并行执行所有主处理器，收集非空返回值（用于多插件贡献，如标签）*/
  async runCollect(...args) {
    const short = await this._runBefore(...args);
    if (short !== undefined) return [short];

    const results = [];
    const settled = await Promise.allSettled(this._handlers.map((h) => h.fn(...args)));
    for (const s of settled) {
      if (s.status === 'rejected') {
        logError('plugin', `钩子 ${this.name} 处理器异常: ${s.reason?.message || s.reason}`);
        continue;
      }
      if (s.value !== undefined && s.value !== null) results.push(s.value);
    }
    return results;
  }

  /** 短路模式：按优先级顺序执行，第一个返回非空值即返回（用于单一判定）*/
  async runFirst(...args) {
    const short = await this._runBefore(...args);
    if (short !== undefined) return short;

    for (const { fn } of this._handlers) {
      try {
        const r = await fn(...args);
        if (r !== undefined && r !== null) return r;
      } catch (err) {
        logError('plugin', `钩子 ${this.name} 处理器异常: ${err.message}`);
      }
    }
    return undefined;
  }
}

/**
 * 插件上下文：插件通过它访问系统能力。
 * 每个上下文归属一个作用域，服务/钩子/插件按作用域组织。
 */
class Context {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.name = options.name || 'anonymous';
    this.parent = options.parent || null;      // 父作用域
    this._disposers = [];
    this._ownServices = new Map();             // 本作用域提供的服务
    this._started = false;
  }

  /** 提供服务（可带生命周期）。返回提供的实现。*/
  provide(key, impl, lifecycle = {}) {
    const entry = {
      key,
      impl,
      start: lifecycle.start,
      stop: lifecycle.stop,
      state: 'idle',
    };
    this._ownServices.set(key, entry);
    this.manager._registerService(this, key, entry);
    return impl;
  }

  /** 注入服务（沿作用域链向上查找）。required=false 时缺失返回 undefined。*/
  inject(key, required = true) {
    let scope = this;
    while (scope) {
      const entry = scope._ownServices.get(key);
      if (entry && entry.state !== 'error') return entry.impl;
      scope = scope.parent;
    }
    // 也查全局服务表（兼容旧用法）
    const globalEntry = this.manager.services.get(key);
    if (globalEntry && globalEntry.state !== 'error') return globalEntry.impl;
    if (required) throw new Error(`插件 ${this.name} 依赖的服务未提供: ${key}`);
    return undefined;
  }

  /** 注册钩子（可指定优先级 order，数值越小越先执行）*/
  on(event, handler, options = {}) {
    const order = options.order ?? 0;
    const unregister = this.manager.hook(event).register(handler, order);
    this._disposers.push(unregister);
    return this;
  }

  /** 注册前置钩子（返回非空值可短路该事件）*/
  before(event, handler) {
    const unregister = this.manager.hook(event).registerBefore(handler);
    this._disposers.push(unregister);
    return this;
  }

  /** 触发钩子（收集模式）*/
  async emitCollect(event, ...args) {
    return this.manager.hook(event).runCollect(...args);
  }

  /** 触发钩子（短路模式）*/
  async emitFirst(event, ...args) {
    return this.manager.hook(event).runFirst(...args);
  }

  /** 加载子插件（子插件运行在本作用域下，随本作用域一起卸载）*/
  plugin(plugin) {
    return this.manager.plugin(plugin, this);
  }

  /** 创建子作用域：独立管理服务/钩子/插件，dispose 时只清理自身*/
  scope(name) {
    const child = new Context(this.manager, { name, parent: this });
    this._disposers.push(() => child.dispose());
    return child;
  }

  /**
   * 注册插件配置：返回可读写配置对象（Proxy），修改属性自动持久化。
   * @param {object} schema - { name, fields: [{ key, type, label, default, min, max, step, unit }] }
   */
  config(schema) {
    return this.manager.getConfig(schema);
  }

  /** 注册清理函数（插件卸载时逆序执行）*/
  onDispose(fn) {
    if (typeof fn === 'function') this._disposers.push(fn);
  }

  /** 等待本作用域所有服务就绪*/
  async ready() {
    await Promise.all([...this._ownServices.values()].map((e) => e._readyPromise || Promise.resolve()));
  }

  /** 卸载本作用域所有资源（逆序清理 + 停止服务）*/
  dispose() {
    for (const d of this._disposers.reverse()) {
      try { d(); } catch (err) { logError('plugin', `插件 ${this.name} 清理异常: ${err.message}`); }
    }
    this._disposers = [];
    // 停止本作用域服务
    for (const [key, entry] of [...this._ownServices.entries()].reverse()) {
      if (entry.state === 'ready' && typeof entry.stop === 'function') {
        try { entry.stop(); } catch (err) { logError('plugin', `服务 ${key} 停止异常: ${err.message}`); }
        entry.state = 'stopped';
      }
      this.manager.services.delete(key);
    }
    this._ownServices.clear();
  }
}

/** 插件管理器：服务注册表 + 钩子 + 插件生命周期 + 依赖排序*/
class PluginManager {
  constructor() {
    this.services = new Map();   // 全局服务表（key -> { impl, state, ... }）
    this._hooks = new Map();     // 事件名 -> Hook
    this._plugins = new Map();   // 插件名 -> { ctx, meta }
    this._pluginDefs = new Map(); // 插件名 -> 插件函数（供卸载后重新加载）
    this._loading = new Set();   // 正在加载的插件（检测循环依赖）
    this._configSchemas = new Map(); // 插件名 -> 配置 schema
    this._configStore = new Map();   // 插件名 -> 当前配置值
  }

  /** 记录服务到全局表（供 inject 兜底查找）*/
  _registerService(scope, key, entry) {
    this.services.set(key, entry);
  }

  /** 获取或创建钩子*/
  hook(name) {
    if (!this._hooks.has(name)) this._hooks.set(name, new Hook(name));
    return this._hooks.get(name);
  }

  /** 读取插件元数据（name/description/version/using/inject）*/
  static _meta(plugin) {
    return {
      name: plugin.name && plugin.name !== 'plugin' ? plugin.name : null,
      description: plugin.description || '',
      version: plugin.version || '',
      using: Array.isArray(plugin.using) ? plugin.using : [],
      inject: Array.isArray(plugin.inject) ? plugin.inject : [],
    };
  }

  /**
   * 注册插件。插件形如 (ctx) => void | disposeFn。
   * @param {Function} plugin
   * @param {Context} parent 父作用域（省略则挂到根作用域）
   */
  plugin(plugin, parent = null) {
    if (typeof plugin !== 'function') throw new Error('插件必须是一个函数 (ctx) => {...}');
    const meta = PluginManager._meta(plugin);
    const name = meta.name || `plugin-${this._plugins.size + 1}`;

    if (this._plugins.has(name)) {
      logInfo('plugin', `插件 ${name} 已注册，跳过`);
      return this;
    }
    if (this._loading.has(name)) {
      logError('plugin', `检测到插件循环依赖: ${name}`);
      return this;
    }

    this._pluginDefs.set(name, plugin); // 记录定义，供卸载后重新加载

    this._loading.add(name);
    // 1. 先加载依赖插件（using）
    for (const dep of meta.using) {
      if (!this._plugins.has(dep)) {
        logInfo('plugin', `插件 ${name} 依赖 ${dep}，但 ${dep} 未注册（跳过）`);
      }
    }
    // 2. 创建上下文并执行插件
    const ctx = new Context(this, { name, parent });
    try {
      const dispose = plugin(ctx);
      if (typeof dispose === 'function') ctx.onDispose(dispose);
      this._plugins.set(name, { ctx, meta });
      // 3. 启动本插件提供的服务
      this._startServices(ctx);
      logInfo('plugin', `插件已加载: ${name}${meta.description ? ' - ' + meta.description : ''}`);
    } catch (err) {
      logError('plugin', `插件 ${name} 加载失败: ${err.message}`);
      ctx.dispose();
    } finally {
      this._loading.delete(name);
    }
    return this;
  }

  /** 启动作用域内提供的服务（调用 start 生命周期）*/
  async _startServices(ctx) {
    for (const [key, entry] of ctx._ownServices.entries()) {
      if (typeof entry.start === 'function') {
        entry._readyPromise = (async () => {
          try {
            await entry.start();
            entry.state = 'ready';
          } catch (err) {
            entry.state = 'error';
            logError('plugin', `服务 ${key} 启动异常: ${err.message}`);
          }
        })();
      } else {
        entry.state = 'ready';
      }
    }
  }

  /** 卸载插件（保留定义，可重新加载）*/
  disposePlugin(name) {
    const p = this._plugins.get(name);
    if (p) {
      p.ctx.dispose();
      this._plugins.delete(name);
      logInfo('plugin', `插件已卸载: ${name}`);
    }
    return this;
  }

  /** 重新加载已卸载的插件*/
  loadPlugin(name) {
    const def = this._pluginDefs.get(name);
    if (!def) {
      logError('plugin', `插件 ${name} 无定义，无法重新加载`);
      return false;
    }
    if (this._plugins.has(name)) return true; // 已加载
    const meta = PluginManager._meta(def);
    const ctx = new Context(this, { name });
    try {
      const dispose = def(ctx);
      if (typeof dispose === 'function') ctx.onDispose(dispose);
      this._plugins.set(name, { ctx, meta });
      this._startServices(ctx);
      logInfo('plugin', `插件已重新加载: ${name}`);
      return true;
    } catch (err) {
      logError('plugin', `插件 ${name} 重新加载失败: ${err.message}`);
      ctx.dispose();
      return false;
    }
  }

  /** 开关插件：true 启用（加载），false 禁用（卸载保留定义）*/
  setPluginEnabled(name, enabled) {
    if (enabled) return this.loadPlugin(name);
    this.disposePlugin(name);
    return true;
  }

  /** 插件状态：loaded（已加载）| disabled（已禁用，可启用）| unknown（未注册）*/
  getPluginStatus(name) {
    if (this._plugins.has(name)) return 'loaded';
    if (this._pluginDefs.has(name)) return 'disabled';
    return 'unknown';
  }

  /** 卸载所有插件*/
  disposeAll() {
    for (const name of [...this._plugins.keys()].reverse()) this.disposePlugin(name);
    this.services.clear();
    this._hooks.clear();
    return this;
  }

  /** 列出已加载的插件名*/
  listPlugins() {
    return [...this._plugins.keys()];
  }

  /** 列出全部插件（含已禁用），带状态*/
  listAllPlugins() {
    const names = new Set([...this._pluginDefs.keys(), ...this._plugins.keys()]);
    return [...names].map((name) => ({ name, status: this.getPluginStatus(name) }));
  }

  /**
   * 列出插件详情（含元数据 + 状态）。
   * 修 C19：旧版此方法被定义两次，后定义（无 status 字段）覆盖前者，
   * 导致降级模式下插件状态不可见。现只保留带 status 的实现。
   */
  describePlugins() {
    return this.listAllPlugins().map(({ name, status }) => {
      const p = this._plugins.get(name);
      const meta = p ? p.meta : PluginManager._meta(this._pluginDefs.get(name) || (() => {}));
      return {
        name,
        status,
        description: meta.description,
        version: meta.version,
        using: meta.using,
      };
    });
  }

  // ─── 插件配置 ───

  _configFile() {
    // v0.2.0：与 src/plugin-config.js 共用同一环境变量开关（两处读写同一文件，必须一致）。
    // 未设置时 = path.join(__dirname, '..', 'data', 'plugin-config.json')，与旧版逐字节等价。
    return process.env.GRS_PLUGIN_CONFIG || path.join(__dirname, '..', 'data', 'plugin-config.json');
  }

  _loadConfigFile() {
    try {
      return JSON.parse(fs.readFileSync(this._configFile(), 'utf-8'));
    } catch {
      return {};
    }
  }

  _persistConfig() {
    const data = {};
    for (const [name, values] of this._configStore) data[name] = values;
    try {
      const dir = path.dirname(this._configFile());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._configFile(), JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logError('plugin', `插件配置持久化失败: ${err.message}`);
    }
  }

  /**
   * 获取插件配置对象（Proxy：读走 schema 默认值 + 持久化覆盖，写自动持久化）。
   */
  getConfig(schema) {
    const name = schema.name;
    this._configSchemas.set(name, schema);
    if (!this._configStore.has(name)) {
      const saved = this._loadConfigFile()[name] || {};
      const values = {};
      for (const f of schema.fields) {
        values[f.key] = saved[f.key] !== undefined ? saved[f.key] : f.default;
      }
      this._configStore.set(name, values);
    }
    const store = this._configStore.get(name);
    const manager = this;
    return new Proxy(store, {
      set(target, key, value) {
        target[key] = value;
        manager._persistConfig();
        return true;
      },
    });
  }

  /** 更新插件配置（后端 API 调用）：校验 key 存在后写入并持久化*/
  updateConfig(name, key, value) {
    const schema = this._configSchemas.get(name);
    if (!schema) throw new Error(`插件 ${name} 未注册配置`);
    const field = schema.fields.find((f) => f.key === key);
    if (!field) throw new Error(`插件 ${name} 无配置项 ${key}`);
    // 类型校验 + 范围钳制
    let v = value;
    if (field.type === 'boolean') v = !!value;
    else if (field.type === 'number' || field.type === 'slider') {
      v = Number(value);
      if (Number.isNaN(v)) throw new Error(`${key} 必须是数字`);
      if (field.min !== undefined) v = Math.max(field.min, v);
      if (field.max !== undefined) v = Math.min(field.max, v);
    } else {
      v = String(value);
    }
    if (!this._configStore.has(name)) this.getConfig(schema);
    this._configStore.get(name)[key] = v;
    this._persistConfig();
    return v;
  }

  /** 返回所有插件的配置 schema + 当前值（供前端渲染控件）*/
  describeConfigs() {
    return [...this._configSchemas.entries()].map(([name, schema]) => {
      const values = this._configStore.get(name) || {};
      return {
        name: schema.name,
        title: schema.title || schema.name,
        description: schema.description || '',
        groups: Array.isArray(schema.groups) ? schema.groups : [],
        fields: schema.fields.map((f) => ({ ...f, value: values[f.key] !== undefined ? values[f.key] : f.default })),
      };
    });
  }
}

module.exports = { PluginManager, Context, Hook };
