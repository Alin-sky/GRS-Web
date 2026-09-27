/**
 * 插件宿主：路由代理 / RPC 分发 / Asset 通道 / 视图下发（src/plugin-host.js）
 * 核心设计：路由代理（Route Proxy）
 * `/api/p/:pid/*`、`/api/plugin-views`、`/api/plugins/host/status` 在 app.listen **之前**
 * 同步注册并永久存在，运行时按注册表分发。这样：
 * ① 绕开「异步插件初始化 vs listen 前注册路由」的时序死结（R-A03/R-A04）
 * ② 不操作 Express 私有结构 app._router.stack
 * ③ 禁用插件只需从注册表删除，天然无路由残留（满足启停 20 次 stack 长度稳定）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logInfo, logError } = require('./logger');
const uiSchema = require('./plugin-ui-schema');
const bridge = require('./cordis-bridge');
// v0.2.0：类目唯一真相（受控枚举）—— 后端唯一定义处，前端不得再自定义
const uiContract = require('./plugin-ui-contract');

/** asset 签名密钥（进程内随机，重启即失效，避免签名长期有效）*/
const ASSET_SECRET = crypto.randomBytes(32).toString('hex');
/** asset 链接有效期：5 分钟*/
const ASSET_TTL_MS = 5 * 60 * 1000;

/** pid → Map<method, {handler: Function, write: boolean}>*/
const _rpcTable = new Map();
/** pid → Set<绝对路径>（asset 路径白名单）*/
const _assetRoots = new Map();
/** 工程根目录*/
const PROJECT_ROOT = path.join(__dirname, '..');
/** 默认允许的 asset 根（插件产物统一落在 data/ 下）*/
const DEFAULT_ASSET_ROOTS = [path.join(PROJECT_ROOT, 'data')];
/** 绝对禁止通过 asset 读取的目录（即使被误登记）*/
const FORBIDDEN_ROOTS = [
  path.join(PROJECT_ROOT, 'config'),
  path.join(PROJECT_ROOT, 'src'),
  path.join(PROJECT_ROOT, 'node_modules'),
];

/** 阶段：'booting' → 'ready'*/
let _phase = 'booting';

/**
 * 设置宿主阶段（由 server.js 在插件初始化完成后调用）。
 * @param {'booting'|'ready'|'error'} phase 阶段
 */
function setPhase(phase) {
  _phase = phase;
  logInfo('plugin-host', `插件宿主阶段: ${phase}（/api/p/* 由 503 转为可服务）`);
}

/** 取当前阶段*/
function getPhase() {
  return _phase;
}

// ─── 路径安全 ───

/**
 * 判定目标路径是否落在允许根目录内。
 * @param {string} target 目标绝对路径
 * @param {string} root 根目录
 * @returns {boolean}
 */
function isInsideRoot(target, root) {
  const t = path.resolve(target);
  const r = path.resolve(root);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

/**
 * 判定某插件是否有权读取该绝对路径。
 * @param {string} pid 插件 id
 * @param {string} abs 绝对路径
 * @returns {boolean}
 */
function isAssetAllowed(pid, abs) {
  const resolved = path.resolve(abs);
  for (const bad of FORBIDDEN_ROOTS) {
    if (isInsideRoot(resolved, bad)) return false;
  }
  const roots = [...DEFAULT_ASSET_ROOTS, ...(_assetRoots.get(pid) || [])];
  return roots.some((root) => isInsideRoot(resolved, root));
}

/**
 * 登记插件的 asset 路径白名单。
 * @param {string} pid 插件 id
 * @param {string} dir 目录绝对路径
 */
function allowAssetRoot(pid, dir) {
  if (!dir) return;
  if (!_assetRoots.has(pid)) _assetRoots.set(pid, new Set());
  _assetRoots.get(pid).add(path.resolve(dir));
}

/**
 * 计算 HMAC 签名。
 * @param {string} payload 待签名内容
 * @returns {string} hex 签名
 */
function hmac(payload) {
  return crypto.createHmac('sha256', ASSET_SECRET).update(payload).digest('hex');
}

/**
 * 取插件的 asset epoch（未登记为 0）。
 * @param {string} pid 插件 id
 * @returns {number}
 */
function getEpoch(pid) {
  return _epochs.get(pid) || 0;
}

/**
 * 计算 asset 签名载荷。
 * 修 C14：payload 纳入 pid + epoch，插件卸载/重载后 epoch 递增，旧签名立即失效。
 * @param {string} pid 插件 id
 * @param {string} key base64url 路径键
 * @param {number} exp 过期时间戳
 * @returns {string} 待签名载荷
 */
function assetPayload(pid, key, exp) {
  return `${pid}.${getEpoch(pid)}.${key}.${exp}`;
}

/**
 * 签发一个临时资源引用（仅允许白名单内路径）。
 * @param {string} pid 插件 id
 * @param {string} absPath 绝对路径
 * @returns {{key: string, sig: string, exp: number, url: string}|null}
 */
function signAsset(pid, absPath) {
  const abs = path.resolve(absPath);
  if (!isAssetAllowed(pid, abs)) {
    logError('plugin-host', `插件 ${pid} 尝试签发越权资源路径: ${abs}`);
    return null;
  }
  const exp = Date.now() + ASSET_TTL_MS;
  const key = Buffer.from(abs, 'utf-8').toString('base64url');
  const sig = hmac(assetPayload(pid, key, exp));
  return {
    key,
    sig,
    exp,
    url: `/api/p/${encodeURIComponent(pid)}/asset?key=${encodeURIComponent(key)}&sig=${sig}&exp=${exp}`,
  };
}

// ─── RPC 注册表 ───

/**
 * 注册 RPC 方法。
 * @param {string} pid 插件 id
 * @param {string} method 方法名
 * @param {Function} handler 处理函数
 * @param {{write?: boolean}} [opts] write=true 表示写操作（强制密码）
 */
function registerRpc(pid, method, handler, opts = {}) {
  if (typeof handler !== 'function') return;
  if (!_rpcTable.has(pid)) _rpcTable.set(pid, new Map());
  _rpcTable.get(pid).set(method, { handler, write: opts.write === true });
}

/** 取某插件的 RPC 方法定义*/
function getRpc(pid, method) {
  const table = _rpcTable.get(pid);
  return table ? table.get(method) || null : null;
}

/** 列出某插件的全部 RPC 方法名*/
function listRpc(pid) {
  const table = _rpcTable.get(pid);
  return table ? [...table.keys()] : [];
}

/** 判断某插件当前是否已装载（有 RPC 或视图登记即视为在线）*/
function isPluginOnline(pid) {
  const entry = bridge.getPlugin(pid);
  if (!entry) return false;
  return entry.status === 'loaded' || entry.status === 'loading';
}

/** pid → epoch（卸载后递增，用于使旧签名失效）*/
const _epochs = new Map();

/**
 * 插件卸载清理：摘除 RPC / 视图 / asset 白名单，并使已签发链接失效。
 * @param {string} pid 插件 id
 */
function unregisterPlugin(pid) {
  _rpcTable.delete(pid);
  _assetRoots.delete(pid);
  uiSchema.removePluginViews(pid);
  // 递增 epoch 使该插件已签发的 assetKey 全部失效
  _epochs.set(pid, (_epochs.get(pid) || 0) + 1);
}

/**
 * 分发 RPC 调用。
 * @param {string} pid 插件 id
 * @param {string} method 方法名
 * @param {any} params 参数
 * @returns {Promise<{ok: boolean, result?: any, error?: string, code?: number}>}
 */
async function dispatchRpc(pid, method, params) {
  if (!isPluginOnline(pid)) {
    return { ok: false, code: 404, error: `插件 ${pid} 未启用` };
  }
  const entry = getRpc(pid, method);
  if (!entry) {
    return { ok: false, code: 400, error: `未知方法: ${method}` };
  }
  try {
    const result = await entry.handler(params);
    return { ok: true, result: result === undefined ? null : result };
  } catch (err) {
    logError('plugin-host', `RPC ${pid}.${method} 执行异常: ${err.message}`);
    return { ok: false, code: 500, error: err.message || '插件方法执行失败' };
  }
}

// ─── 视图 Schema 解析 ───

/**
 * 解析视图的 Schema（静态 schema → schemaFile → schemaResolver RPC）。
 * @param {object} view 视图定义
 * @returns {Promise<object|null>}
 */
async function resolveViewSchema(view) {
  if (view.schema) return view.schema;
  if (view.schemaFile) {
    try {
      const file = path.resolve(PROJECT_ROOT, 'plugins', view.pluginId, view.schemaFile);
      // 防穿越：必须在插件目录内
      const pluginDir = path.resolve(PROJECT_ROOT, 'plugins', view.pluginId);
      if (!isInsideRoot(file, pluginDir)) {
        logError('plugin-host', `视图 ${view.viewId} 的 schemaFile 越权: ${view.schemaFile}`);
        return null;
      }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const check = uiSchema.validateSchema(parsed);
      if (!check.ok) {
        logError('plugin-host', `视图 ${view.viewId} 的 schema 非法: ${check.errors.map((e) => e.message).join('；')}`);
        return null;
      }
      return parsed;
    } catch (err) {
      logError('plugin-host', `读取视图 schema 失败（${view.schemaFile}）: ${err.message}`);
      return null;
    }
  }
  if (view.schemaResolver) {
    const res = await dispatchRpc(view.pluginId, view.schemaResolver, { viewId: view.viewId });
    if (!res.ok) return null;
    const parsed = res.result;
    const check = uiSchema.validateSchema(parsed);
    if (!check.ok) {
      logError('plugin-host', `视图 ${view.viewId} 动态 schema 非法: ${check.errors.map((e) => e.message).join('；')}`);
      return null;
    }
    return parsed;
  }
  return null;
}

/**
 * 构建下发给前端的视图列表（含已解析的 schema）。
 * @returns {Promise<{status: string, views: Array<object>}>}
 */
async function buildViewsPayload() {
  const categories = [...uiContract.VIEW_CATEGORIES];
  if (_phase !== 'ready') {
    return { status: 'booting', views: [], categories, warnings: [], panels: {} };
  }
  const views = uiSchema.getViews().filter((v) => isPluginOnline(v.pluginId));
  const out = [];
  for (const v of views) {
    const schema = await resolveViewSchema(v);
    if (!schema) continue;
    out.push({
      pluginId: v.pluginId,
      viewId: v.viewId,
      category: v.category,
      // v0.2.0：非法类目由前端兜底渲染到「插件管理」，此标记让前端可显式提示
      categoryInvalid: v.categoryInvalid === true,
      title: v.title,
      icon: v.icon,
      order: v.order,
      refreshOn: v.refreshOn,
      schema,
    });
  }
  return {
    status: 'ready',
    views: out,
    // v0.2.0：唯一真相下发（前端不再自定义类目枚举）+ 非法类目/面板告警 + 配置面板归位
    categories,
    warnings: uiSchema.getWarnings(),
    panels: uiSchema.getPanels(),
  };
}

// ─── 路由代理注册（listen 前调用） ───

/**
 * 在 Express app 上注册常驻的插件代理路由。
 * 必须插在 404 兜底中间件之前。
 * @param {object} app Express 实例
 * @param {{requireAdmin?: Function}} [options] requireAdmin 为密码校验中间件
 */
function registerPluginProxy(app, options = {}) {
  const requireAdmin = options.requireAdmin || ((req, res, next) => next());

  // 宿主状态（公开）
  app.get('/api/plugins/host/status', (req, res) => {
    res.json({ ...bridge.getHostStatus(), phase: _phase === 'ready' ? 'ready' : _phase });
  });

  // 视图列表（公开）
  app.get('/api/plugin-views', async (req, res) => {
    try {
      res.json(await buildViewsPayload());
    } catch (err) {
      logError('plugin-host', `/api/plugin-views 异常: ${err.message}`);
      res.json({ status: 'error', views: [], categories: [...uiContract.VIEW_CATEGORIES], warnings: [], panels: {}, error: err.message });
    }
  });

  // 单个视图 Schema（动态刷新用，公开）
  app.get('/api/plugin-views/:pid/:vid/schema', async (req, res) => {
    const view = uiSchema.getView(req.params.pid, req.params.vid);
    if (!view) return res.status(404).json({ error: '视图不存在' });
    if (!isPluginOnline(req.params.pid)) return res.status(404).json({ error: '插件未启用' });
    const schema = await resolveViewSchema(view);
    if (!schema) return res.status(500).json({ error: '视图 Schema 解析失败' });
    res.json({ pluginId: view.pluginId, viewId: view.viewId, schema });
  });

  // RPC 分发：读方法公开，写方法需密码
  app.post('/api/p/:pid/rpc', async (req, res) => {
    if (_phase !== 'ready') {
      return res.status(503).json({ error: '插件系统初始化中，请稍后重试' });
    }
    const pid = req.params.pid;
    const { method, params } = req.body || {};
    if (!method || typeof method !== 'string') {
      return res.status(400).json({ error: '缺少 method' });
    }
    const entry = getRpc(pid, method);
    if (!entry) {
      // 插件不存在 → 404（禁用后必须 404，不能 500）
      if (!_rpcTable.has(pid)) return res.status(404).json({ error: `插件 ${pid} 未启用` });
      return res.status(400).json({ error: `未知方法: ${method}` });
    }
    if (entry.write) {
      return requireAdmin(req, res, async () => {
        const out = await dispatchRpc(pid, method, params);
        res.status(out.ok ? 200 : (out.code || 500)).json(out.ok ? { result: out.result } : { error: out.error });
      });
    }
    const out = await dispatchRpc(pid, method, params);
    res.status(out.ok ? 200 : (out.code || 500)).json(out.ok ? { result: out.result } : { error: out.error });
  });

  // Asset 通道：HMAC 签名 + 二次路径白名单校验
  app.get('/api/p/:pid/asset', (req, res) => {
    if (_phase !== 'ready') return res.status(503).json({ error: '插件系统初始化中' });
    const pid = req.params.pid;
    const { key, sig, exp } = req.query || {};
    if (!key || !sig || !exp) return res.status(403).json({ error: '资源引用缺少签名' });
    if (!isPluginOnline(pid)) return res.status(404).json({ error: '插件未启用' });
    // ① 签名有效（ 含 epoch：插件重载后 epoch 递增，旧链接自动失效，修 C14）
    const expected = hmac(assetPayload(pid, key, exp));
    const a = Buffer.from(String(sig), 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      logError('plugin-host', `插件 ${pid} 的资源签名校验失败`);
      return res.status(403).json({ error: '签名无效' });
    }
    // ② 未过期
    if (Number(exp) < Date.now()) return res.status(403).json({ error: '链接已过期' });
    // ③ 路径白名单二次校验（防越权读取 config/default.json 等）
    let abs = '';
    try {
      abs = Buffer.from(String(key), 'base64url').toString('utf-8');
    } catch {
      return res.status(403).json({ error: '资源引用非法' });
    }
    if (!abs || !path.isAbsolute(abs) || !isAssetAllowed(pid, abs)) {
      logError('plugin-host', `插件 ${pid} 的资源路径越权: ${abs}`);
      return res.status(403).json({ error: '资源路径不在白名单内' });
    }
    if (!fs.existsSync(abs)) return res.status(404).json({ error: '资源不存在' });
    res.sendFile(abs);
  });

  // 其它 /api/p/:pid/* 一律 404（不暴露 500，禁用后立即可见）
  app.all('/api/p/:pid/*', (req, res) => {
    res.status(404).json({ error: `插件接口不存在: ${req.params.pid}` });
  });

  logInfo('plugin-host', '插件路由代理已注册（/api/p/:pid/*、/api/plugin-views、/api/plugins/host/status）');
}

// ─── 反向注册到桥接层（ 修 C09：断开 cordis-bridge → plugin-host 的循环依赖） ───
// 桥接层不再 require 本模块，改由本模块主动注入实现；宿主生命周期内保持有效。
bridge.setHostBridge({
  registerRpc,
  registerViews: uiSchema.registerViews,
  allowAssetRoot,
  signAsset,
  unregisterPlugin,
  isPluginOnline,
  getViews: uiSchema.getViews,
});

module.exports = {
  registerPluginProxy,
  registerRpc,
  getRpc,
  listRpc,
  dispatchRpc,
  unregisterPlugin,
  isPluginOnline,
  registerViews: uiSchema.registerViews,
  getViews: uiSchema.getViews,
  getView: uiSchema.getView,
  buildViewsPayload,
  resolveViewSchema,
  allowAssetRoot,
  signAsset,
  isAssetAllowed,
  assetPayload,
  getEpoch,
  setPhase,
  getPhase,
  ASSET_TTL_MS,
};
