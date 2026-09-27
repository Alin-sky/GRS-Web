const path = require('path');
const express = require('express');
const { loadConfig, getCapabilities, getConflicts, isStartupBlocked } = require('./config');
const { moderateText, moderateImage, moderateImageLocal, moderate, healthCheck } = require('./moderator');
const { getRecentLogs } = require('./logger');
const { logInfo, logError, logWarn } = require('./logger');
const { chatRaw, chatStream, unloadModel } = require('./ollama');
const { reloadWordDb, loadWordDb, saveWordDb } = require('./precheck');
const { getSystemStats } = require('./system-stats');
const { listComparisons, getComparisonResult, getStatus: getComparisonStatus } = require('./comparator');
const { getAuditRecords, getAuditStats, getDetailedStats, listAuditDates, getDateStr, getDualWriteStatus, flushAuditDb } = require('./audit-store');
// v0.2.0：图片内容寻址读取/容量 与 审核记录 DB 投影（对账/回灌）
const imageRefModule = require('./image-ref');
// v0.1.2：URL-only 图片输入 —— 服务端自行下载并按策略转码（仅做「字节来源」归一化，先于审核）
const imageSource = require('./image-source');
const auditDb = require('./audit-db');
const { initScheduler, triggerManual, getSchedulerStatus, setComparisonEnabled } = require('./scheduler');
// 插件层唯一入口（架构 §3.2 R1）：核心不再直接 require plugin-registry / plugin-host / plugin-config。
// 插件装配、路由代理、RPC 分发、插件配置全部由 src/plugin-runtime.js 一个门面提供；
// 审核链路的插件能力调用只经 src/capability-broker.js。
const pluginRuntime = require('./plugin-runtime');
const pluginHost = pluginRuntime.getHost();
const pluginConfig = pluginRuntime.getConfig();
const getScanner = () => pluginRuntime.getScanner();
const { startBatchScan, getTaskStatus, getTaskResults, getTaskImage, getTaskThumb, stopTask, listTasks, exportCsv, deleteTask, clearAllTasks, resumeOrphanedTasks, startExportByCategory, getExportStatus } = require('./batch-scan');
const { healthCheckCloud } = require('./qwen_cloud');
const { getContentSafetyStatus } = require('./content_safety');
// v2.3.0（Req6）：本地模型几何档案（显存估算 / 参数量展示的唯一数据源）
const { getProfile, estimateVram } = require('./model-profiles');
// v2.3.0（Req6）：云端模型目录（模型清单 / 价格 / 额度来源可用性判定的唯一数据源）
const {
  TOKEN_PLAN_MODELS, checkBilling, listTextModels, listVisionModels,
} = require('./cloud-model-catalog');
// v2.3.0（Req6）：宿主版本常量（动态读 package.json，供 /health 单一来源上报）
const contract = require('./host-api/contract');
// T08a：WD14 服务地址单一真相（健康检查与插件实际调用同源）
const wd14Endpoint = require('./wd14-endpoint');
// v2.3.0（Req2）：可选依赖自动安装器（白名单 + --no-save，绝不写主 package.json）
const depsInstaller = require('./optional-dep-installer');
const injectionAudit = require('./security/injection-audit');
// v2.2.0 编排层（画布 UI 与插件对接的唯一后端接口）
const flowModule = require('./flow');
const flowMigrate = require('./flow/migrate');
// v0.1.0：审核器注册表（只读投影）—— 用于「后继 ref」识别与 GET /api/flow/adjudicators
const adjudicators = require('./flow/adjudicators');

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const busboy = require('busboy');
const config = loadConfig();
const app = express();

// ─── 全局异常兜底（长时间运行稳定性关键） ───
// 未捕获异常：记录日志后继续运行（审核请求无状态，单个异常不应拖垮整个服务）。
// 若短时间内连续大量异常，说明进程状态可能已损坏，主动退出交给看门狗重启。
let _fatalErrCount = 0;
let _fatalErrWindowAt = Date.now();
function recordFatalError(tag, err) {
  const now = Date.now();
  if (now - _fatalErrWindowAt > 60 * 1000) { _fatalErrCount = 0; _fatalErrWindowAt = now; }
  _fatalErrCount++;
  try {
    logError('server', `${tag}: ${err?.message || err}`, err?.stack);
  } catch { /* 日志自身异常也不能中断*/ }
  // 60 秒内连续 10 次未捕获异常 → 主动退出，交给看门狗自动重启
  if (_fatalErrCount >= 10) {
    try { logError('server', '连续异常过多，主动退出以触发自动重启'); } catch {}
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => recordFatalError('未捕获异常', err));
process.on('unhandledRejection', (reason) => recordFatalError('未处理的 Promise 拒绝', reason));

// ─── 公网访问密码保护 ───

// 会话 Token 存储（内存，服务重启后失效）
// Map<token, { createdAt: number, expiresAt: number, ip: string }>
const sessionTokens = new Map();
const SESSION_TOKEN_TTL = 4 * 60 * 60 * 1000; // 4 小时过期

// 清理过期 Token（每小时一次）
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessionTokens.entries()) {
    if (session.expiresAt < now) {
      sessionTokens.delete(token);
    }
  }
}, 60 * 60 * 1000);

function normalizeIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/, '');
}

function getClientIp(req) {
  const peerIp = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  const trustedProxyIps = (config.server?.trustedProxyIps || []).map(normalizeIp);
  const forwardedFor = req.headers['x-forwarded-for'];

  // 仅当 TCP 对端在可信反向代理白名单时才接受 X-Forwarded-For，防止公网客户端伪造该头绕过认证。
  if (forwardedFor && trustedProxyIps.includes(peerIp)) {
    return normalizeIp(String(forwardedFor).split(',')[0]);
  }
  return peerIp;
}

function isLocalIp(ip) {
  // 本地回环地址
  if (['127.0.0.1', '::1', 'localhost'].includes(ip)) return true;
  // 局域网地址
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.') ||
      ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
      ip.startsWith('172.20.') || ip.startsWith('172.21.') || ip.startsWith('172.22.') ||
      ip.startsWith('172.23.') || ip.startsWith('172.24.') || ip.startsWith('172.25.') ||
      ip.startsWith('172.26.') || ip.startsWith('172.27.') || ip.startsWith('172.28.') ||
      ip.startsWith('172.29.') || ip.startsWith('172.30.') || ip.startsWith('172.31.')) return true;
  return false;
}

function isLocalRequest(req) {
  return isLocalIp(getClientIp(req));
}

/**
 * 生成会话 Token
 * @param {string} ip - 客户端 IP
 * @returns {string} token
 */
function generateSessionToken(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessionTokens.set(token, {
    createdAt: now,
    expiresAt: now + SESSION_TOKEN_TTL,
    ip,
  });
  logInfo('server', `生成会话 Token: IP=${ip}, 有效期 ${SESSION_TOKEN_TTL / 3600000} 小时`);
  return token;
}

/**
 * 验证会话 Token
 * @param {string} token
 * @param {string} ip
 * @returns {boolean}
 */
function isValidSessionToken(token, ip) {
  if (!token) return false;
  const session = sessionTokens.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    sessionTokens.delete(token);
    return false;
  }
  // Token 绑定 IP，不同 IP 不能复用
  if (session.ip !== ip) return false;
  return true;
}

function requireAdminPassword(req, res, next) {
  // 本地访问免密码
  if (isLocalRequest(req)) return next();
  
  const clientIp = getClientIp(req);
  
  // 1. 检查会话 Token（优先）
  const token = req.headers['x-session-token'] || req.query.token || req.body?.token || '';
  if (isValidSessionToken(token, clientIp)) {
    return next();
  }
  
  // 2. 检查密码
  const adminPwd = config.adminPassword || config.wordDbPassword || '';
  if (!adminPwd) {
    logError('server', '公网访问需要密码,但未配置 adminPassword');
    return res.status(403).json({ error: '未配置管理员密码' });
  }
  
  const pwd = req.headers['x-admin-password'] || req.query.password || req.body?.password || '';
  if (pwd !== adminPwd) {
    logError('server', `公网访问密码验证失败: IP=${clientIp}`);
    return res.status(403).json({ error: '密码错误,无权修改配置' });
  }
  
  next();
}

app.use(express.json({ limit: config.server.maxRequestSize }));

// ─── 公网访问认证网关 ───
// 免认证白名单：审核 API、聊天 API、健康检查、密码验证、login.html 静态资源
const AUTH_WHITELIST = [
  '/health',
  '/api/moderate',
  '/api/moderate/text',
  '/api/moderate/image',
  '/api/chat-local',
  '/api/admin/verify-password',
  '/api/worddb/verify-password',
  '/api/models',
  '/login.html',
  '/favicon.ico',
];

function authGate(req, res, next) {
  // 本地访问免密码
  if (isLocalRequest(req)) return next();

  const clientIp = getClientIp(req);

  // 主页：允许访问（前端根据认证状态动态显示/隐藏功能）
  if (req.method === 'GET' && req.path === '/') {
    return next();
  }

  // 白名单路由直接放行
  for (const prefix of AUTH_WHITELIST) {
    if (req.path === prefix || req.path.startsWith(prefix + '?') || req.path.startsWith(prefix + '/')) {
      return next();
    }
  }

  // 静态文件（.js/.css/.png/.jpg 等）— 未认证时不暴露，防止爬虫获取前端代码
  if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
    const token = req.headers['x-session-token'] || req.query.token || '';
    if (!isValidSessionToken(token, clientIp)) {
      return res.status(401).json({ error: '未认证' });
    }
    return next();
  }

  // 其他所有请求需要验证
  const token = req.headers['x-session-token'] || req.query.token || '';
  if (isValidSessionToken(token, clientIp)) return next();

  // JSON API 返回 401
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('json')) {
    return res.status(401).json({ error: '未认证，请先验证管理员密码' });
  }

  // HTML 页面请求返回登录页
  return res.status(401).sendFile(path.join(__dirname, '..', 'public', 'login.html'));
}

app.use(authGate);
// HTML 页面禁止缓存：前端更新频繁，避免浏览器用旧版导致功能异常
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
if (config.server.cors) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password, X-Worddb-Password, X-Session-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// ─── 健康检查 ───
app.get('/health', async (req, res) => {
  const caps = getCapabilities();
  const ollamaStatus = caps.local.available ? await healthCheck() : { ok: false, skipped: true, reason: caps.local.reason || '本地通道未配置', models: [] };
  const isCloudOnly = config.moderationMode === 'cloud-only';
  const isCloudEnabled = isCloudOnly || (config.moderation.dualMode && config.qwenCloud?.enabled);

  let cloudStatus = { ok: false, skipped: !caps.cloud.available, disabled: !isCloudEnabled };
  if (isCloudEnabled) {
    try {
      // /health 是高频存活探测：只返回缓存状态，不触发新的云端 API 调用（避免浪费额度）
      cloudStatus = await healthCheckCloud({ useCacheOnly: true });
    } catch (err) {
      cloudStatus = { ok: false, error: err.message };
    }
  }

  // 服务进程存活即视为健康；「可选能力未配置」用 channels / degraded 字段表达，
  // 不能让看门狗或前端把「没配 Key」误判成服务崩溃而触发重启风暴。
  const anyChannelOk = ollamaStatus.ok || cloudStatus.ok;
  const overallOk = true;
  const contentSafetyStatus = getContentSafetyStatus();

  res.json({
    status: overallOk ? 'ok' : 'degraded',
    server: 'ok',
    // v2.3.0（Req6）：版本号单一来源。此前 /health 完全不报版本，
    // 运维只能靠 package.json 猜。现统一从 contract.HOST_VERSION（动态读 package.json）取。
    version: contract.HOST_VERSION,
    hostApiVersion: contract.HOST_API_VERSION,
    mode: isCloudOnly ? 'cloud-only' : 'local',
    localAccess: isLocalRequest(req),
    dualMode: config.moderation.dualMode || false,
    ollama: isCloudOnly ? { ok: false, skipped: true, reason: 'cloud-only 模式未启用本地通道' } : ollamaStatus,
    cloud: cloudStatus,
    contentSafety: contentSafetyStatus,
    // 明确告知哪些可选通道未配置（供前端/运维判断，而不是靠猜）
    channels: {
      precheck: { available: true },
      local: { available: caps.local.available, reason: caps.local.reason },
      cloud: { available: caps.cloud.available, reason: caps.cloud.reason },
      contentSafety: { available: caps.contentSafety.available, reason: caps.contentSafety.reason },
    },
    degraded: !anyChannelOk,
    // 启动期选项冲突报告（架构 §4.2：缓存后在 /health 暴露，前端首屏展示）
    conflicts: getConflicts(),
    models: {
      text: config.ollama.textModel,
      vision: config.ollama.visionModel,
      cloud: isCloudEnabled ? (config.qwenCloud?.model || 'qwen-plus') : null,
    },
  });
});

// ─── 插件系统状态（迁移到 plugin-scanner + cordis 桥接层） ───
app.get('/api/plugins', async (req, res) => {
  const plugins = getScanner().describe();
  // 标签服务健康检查（wd14 为可选能力：未显式禁用才探活，禁用时直接标记跳过）
  // T08a：地址走单一真相解析（插件配置 → 站点配置 → 内置默认），
  // 与 `plugins/wd14-tagger` 实际调用所用的地址同源，避免「UI 说正常、实际打不通」。
  let wd14 = { status: 'down', skipped: true };
  const wd14Cfg = config.wd14 || {};
  if (wd14Cfg.enabled !== false) {
    const resolved = wd14Endpoint.resolveWd14From(wd14Cfg, pluginConfig.values('wd14-tagger'));
    try {
      const resp = await fetch(`${resolved.host}/health`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) wd14 = { status: 'ok', skipped: false, host: resolved.host, hostSource: resolved.source, ...(await resp.json()) };
    } catch (err) {
      wd14 = { status: 'down', skipped: false, host: resolved.host, hostSource: resolved.source, error: err && err.message };
    }
  }
  res.json({
    plugins,
    wd14,
    configs: pluginConfig.describe(),
    host: pluginRuntime.getPhase() === 'ready' ? pluginRuntime.getHostStatus() : { phase: 'booting' },
  });
});

/**
 * 插件集变化（启用/禁用/重载/卸载）后，**就地**对齐内存拓扑（T08）。
 * 为什么必需：禁用任一 finalize 类插件后，磁盘 `finalizers[]` 会残留未注册的 ref →
 * `validateFlow` 报 E004_REF_UNKNOWN → `getValidFlow(config,'image')` 返回 null →
 * 整条图像审核链路静默降级旧引擎。
 * 绝不使用 `regenerateFlows()`：它会 `delete` 两个模态的 topology 再按旧开关重建，
 * 会**抹掉用户在画布上的编辑**。这里只做「陈旧 ref 回收 + 内容安全下限层对齐」。
 */
function reconcileFlowsAfterPluginChange() {
  try {
    pluginRuntime.reconcileFlows(config);
  } catch (err) {
    logWarn('server', `插件集变化后拓扑对齐失败（不影响主链路）: ${err.message}`);
  }
}

// 插件开关：启用/禁用（公网需密码）
app.post('/api/plugins/:id/toggle', requireAdminPassword, async (req, res) => {
  const id = req.params.id;
  const enabled = req.body?.enabled !== false;
  try {
    const out = enabled ? await getScanner().enable(id) : await getScanner().disable(id);
    if (!out.ok) return res.status(400).json({ error: out.error || '操作失败' });
    logInfo('server', `插件 ${id} 已${enabled ? '启用' : '禁用'}`);
    reconcileFlowsAfterPluginChange();
    res.json({ success: true, id, enabled, status: out.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── 可选依赖自动安装（Req2）───
// 契约：POST /api/plugins/:id/install-deps → 为缺失可选依赖的插件安装依赖
// 安全边界全部在 src/optional-dep-installer.js 内（白名单 + --no-save + plugins/ 来源限定 + 并发锁）。
// 关键红线：安装一律 --no-save，绝不写入主工程 package.json；装完插件仍需重载才生效。
app.post('/api/plugins/:id/install-deps', requireAdminPassword, async (req, res) => {
  const id = req.params.id;
  try {
    const meta = getScanner().getMeta ? getScanner().getMeta(id) : null;
    if (!meta) return res.status(404).json({ error: `插件 ${id} 不存在` });

    const out = await depsInstaller.installFor(id, meta.manifest || {}, {
      dir: meta.dir,
      force: req.body?.force === true,
    });
    if (!out.ok) {
      logWarn('server', `插件 ${id} 依赖安装未执行：${out.error || '未知原因'}`);
      return res.status(400).json({ error: out.error || '依赖安装未执行', plan: out.plan || null });
    }
    logInfo('server', `插件 ${id} 可选依赖安装成功：${(out.targets || []).join(' ')}（--no-save，未改 package.json）`);
    res.json({
      success: true,
      id,
      targets: out.targets,
      elapsedMs: out.elapsedMs,
      lines: out.lines || [],
      hint: '依赖已装入 node_modules（未写入 package.json）。请点击「重载」使插件生效；若插件此前为 missing-deps，重载后会自动启用。',
    });
  } catch (err) {
    logError('server', `插件 ${id} 依赖安装异常：${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 依赖安装计划预览（不执行安装；admin 保护以隐藏装了什么包这类信息面）
app.get('/api/plugins/:id/deps-plan', requireAdminPassword, (req, res) => {
  const id = req.params.id;
  const meta = getScanner().getMeta ? getScanner().getMeta(id) : null;
  if (!meta) return res.status(404).json({ error: `插件 ${id} 不存在` });
  const plan = depsInstaller.planInstall(meta.manifest || {});
  res.json({
    id,
    plan,
    installing: depsInstaller.isInstalling(id),
    lastResult: depsInstaller.lastResult(id),
    resolved: (meta.optionalDependencies ? Object.keys(meta.optionalDependencies) : [])
      .map((pkg) => ({ pkg, present: depsInstaller.canResolve(pkg) })),
  });
});

// 插件重载（清 require 缓存后重新装载）（公网需密码）
app.post('/api/plugins/:id/reload', requireAdminPassword, async (req, res) => {
  const id = req.params.id;
  try {
    const out = await getScanner().reload(id);
    if (!out.ok) return res.status(400).json({ error: out.error || `插件 ${id} 重载失败` });
    reconcileFlowsAfterPluginChange();
    res.json({ success: true, id, status: out.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 插件配置：获取全部插件的配置 schema + 当前值
app.get('/api/plugins/config', (req, res) => {
  res.json({ configs: pluginConfig.describe() });
});

// 插件配置：更新某插件单个配置项（公网需密码）
app.put('/api/plugins/config/:name', requireAdminPassword, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: '缺少 key' });
  try {
    const applied = pluginConfig.update(req.params.name, key, value);
    logInfo('server', `插件配置已更新: ${req.params.name}.${key} = ${applied}`);
    res.json({ success: true, key, value: applied });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 插件配置：批量更新（Schema 渲染器用，公网需密码）
app.put('/api/plugins/config', requireAdminPassword, (req, res) => {
  const { name, patch } = req.body || {};
  if (!name || !patch) return res.status(400).json({ error: '缺少 name 或 patch' });
  try {
    const applied = pluginConfig.updateMany(name, patch);
    res.json({ success: true, applied });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 卸载插件（移入 data/plugins-trash/<id>-<ts>/，公网需密码）
app.delete('/api/plugins/:id', requireAdminPassword, async (req, res) => {
  const id = req.params.id;
  try {
    const out = await getScanner().uninstall(id);
    if (!out.ok) return res.status(400).json({ error: out.error });
    reconcileFlowsAfterPluginChange();
    res.json({ success: true, id, trash: out.trash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 本地文件夹导入（复制，源目录不变；公网需密码）
app.post('/api/plugins/import-local', requireAdminPassword, (req, res) => {
  const { path: srcPath } = req.body || {};
  if (!srcPath) return res.status(400).json({ error: '缺少 path' });
  const out = getScanner().importLocal(srcPath);
  if (!out.ok) return res.status(400).json({ error: out.error });
  logInfo('server', `本地导入插件成功: ${out.id}`);
  res.json({ success: true, id: out.id, risks: out.risks || [] });
});

// ZIP 导入（multipart，复用已有 busboy；公网需密码）
app.post('/api/plugins/import-zip', requireAdminPassword, (req, res) => {
  const bb = busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
  let tmpPath = null;
  let done = false;
  const finish = (code, payload) => {
    if (done) return;
    done = true;
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* 忽略*/ }
    res.status(code).json(payload);
  };
  bb.on('file', (name, stream, info) => {
    const safeId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tmpPath = path.join(os.tmpdir(), `${safeId}.zip`);
    const ws = fs.createWriteStream(tmpPath);
    stream.pipe(ws);
    ws.on('close', async () => {
      const out = getScanner().importZip(tmpPath);
      if (!out.ok) return finish(400, { error: out.error });
      logInfo('server', `ZIP 导入插件成功: ${out.id}`);
      finish(200, { success: true, id: out.id, risks: out.risks || [] });
    });
    ws.on('error', (err) => finish(400, { error: `上传失败: ${err.message}` }));
    void info;
  });
  bb.on('error', (err) => finish(400, { error: `解析上传失败: ${err.message}` }));
  bb.on('close', () => { if (!tmpPath) finish(400, { error: '未收到文件' }); });
  req.pipe(bb);
});

// Git 导入（child_process.execFile，公网需密码）
app.post('/api/plugins/import-git', requireAdminPassword, async (req, res) => {
  const { url, ref, subdir } = req.body || {};
  if (!url) return res.status(400).json({ error: '缺少仓库地址' });
  try {
    const out = await getScanner().importGit(url, ref, subdir);
    if (!out.ok) return res.status(400).json({ error: out.error });
    logInfo('server', `Git 导入插件成功: ${out.id}`);
    res.json({ success: true, id: out.id, commitHash: out.commitHash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Git 更新（pull --ff-only，公网需密码）
app.post('/api/plugins/:id/update', requireAdminPassword, async (req, res) => {
  try {
    const out = await getScanner().update(req.params.id);
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ success: true, message: out.message, commitHash: out.commitHash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// git 可用性检测（前端据此置灰 git 导入入口）
app.get('/api/plugins/git-status', async (req, res) => {
  res.json(await getScanner().checkGit());
});

// ─── 可用模型列表 ───
app.get('/api/models', async (req, res) => {
  try {
    const ollamaStatus = await healthCheck();
    const installed = ollamaStatus.models || [];
    const available = config.ollama.availableModels || [];
    // 将配置的模型与 Ollama 已安装模型做交集，标记哪些已就绪
    const models = available.map((m) => ({
      ...m,
      installed: installed.some((i) => i === m.id || i.startsWith(m.id + ':')),
      isDefault: m.id === config.ollama.textModel,
    }));
    res.json({ defaultModel: config.ollama.textModel, models });
  } catch (err) {
    res.json({ defaultModel: config.ollama.textModel, models: [] });
  }
});

// ─── 本地模型管理 ───
const { getLocalModels, uploadModelFile, importModel, pullModel, deleteModel, setDefaultModel } = require('./model-manager');

// 获取本地模型列表
app.get('/api/local-models', async (req, res) => {
  try {
    const ollamaStatus = await healthCheck();
    const models = await getLocalModels();
    res.json({
      ollamaAvailable: ollamaStatus.ok,
      models,
      currentTextModel: config.ollama.textModel,
      currentVisionModel: config.ollama.visionModel,
    });
  } catch (err) {
    res.json({
      ollamaAvailable: false,
      models: [],
      error: err.message,
    });
  }
});

// 上传模型文件（原生流式处理，无需额外依赖）
app.post('/api/local-models/upload', requireAdminPassword, async (req, res) => {
  const filename = req.headers['x-filename'] || 'model.gguf';
  if (!filename.endsWith('.gguf')) {
    return res.status(400).json({ error: '只支持 GGUF 格式的模型文件' });
  }
  
  const destPath = path.join(__dirname, '..', 'models', filename);
  const modelsDir = path.join(__dirname, '..', 'models');
  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
  
  const writeStream = fs.createWriteStream(destPath);
  let bytesWritten = 0;
  
  req.on('data', (chunk) => {
    bytesWritten += chunk.length;
  });
  
  req.pipe(writeStream);
  
  writeStream.on('finish', () => {
    logInfo('server', `模型文件已上传: ${filename} (${(bytesWritten / 1024 / 1024).toFixed(1)} MB)`);
    res.json({ success: true, file: { filename, path: destPath, size: bytesWritten } });
  });
  
  writeStream.on('error', (err) => {
    logError('server', '上传模型文件失败', err.message);
    res.status(500).json({ error: '上传失败', message: err.message });
  });
});

// 导入模型到 Ollama
app.post('/api/local-models/import', requireAdminPassword, async (req, res) => {
  try {
    const { filename, modelName, modelType } = req.body;
    if (!filename || !modelName) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    
    const ggufPath = path.join(__dirname, '..', 'models', filename);
    if (!fs.existsSync(ggufPath)) {
      return res.status(404).json({ error: '模型文件不存在' });
    }
    
    await importModel(ggufPath, modelName, modelType || 'text');
    res.json({ success: true, modelName });
  } catch (err) {
    logError('server', '导入模型失败', err.message);
    res.status(500).json({ error: '导入失败', message: err.message });
  }
});

// 从 Ollama 仓库拉取官方模型
app.post('/api/local-models/pull', requireAdminPassword, async (req, res) => {
  try {
    const { modelName } = req.body;
    if (!modelName) {
      return res.status(400).json({ error: '缺少模型名称' });
    }
    await pullModel(modelName);
    res.json({ success: true, modelName });
  } catch (err) {
    logError('server', '拉取模型失败', err.message);
    res.status(500).json({ error: '拉取失败', message: err.message });
  }
});

// 删除本地模型
app.delete('/api/local-models/:name', requireAdminPassword, async (req, res) => {
  try {
    const modelName = req.params.name;
    const result = await deleteModel(modelName);
    res.json(result);
  } catch (err) {
    logError('server', '删除模型失败', err.message);
    res.status(500).json({ error: '删除失败', message: err.message });
  }
});

// 设置默认模型
app.put('/api/local-models/default', requireAdminPassword, async (req, res) => {
  try {
    const { modelName, modelType } = req.body;
    if (!modelName) {
      return res.status(400).json({ error: '缺少模型名称' });
    }
    
    setDefaultModel(modelName, modelType || 'text');
    res.json({ success: true });
  } catch (err) {
    logError('server', '设置默认模型失败', err.message);
    res.status(500).json({ error: '设置失败', message: err.message });
  }
});

/**
 * 审核路由统一错误出口（ R11/T06 fail-closed）。
 * 提示词缺失（`getPrompt` 抛出 `code='PROMPT_MISSING'`）→ **结构化 400**（前端按错误码给可读提示）；
 * 其余异常 → 500（保持原行为）。
 * @param {object} res Express 响应
 * @param {Error} err 捕获的错误
 * @param {string} scope 日志前缀
 * @returns {void}
 */
function sendModerateError(res, err, scope) {
  if (err && err.code === 'PROMPT_MISSING') {
    logError('server', `${scope}：提示词缺失 (${err.promptId || '?'})`);
    return res.status(400).json({
      ok: false,
      code: 'PROMPT_MISSING',
      error: '提示词文件缺失',
      promptId: err.promptId || '',
      promptPath: err.promptPath || '',
      message: err.message,
      hint: '请在服务端 prompts/ 目录补齐对应提示词文件（可参考 *.example.md 模板）后重试。',
    });
  }
  logError('server', `${scope}错误: ${err && err.message}`);
  return res.status(500).json({ error: '审核服务内部错误', message: err && err.message });
}

// ─── 文本审核 ───
app.post('/api/moderate/text', async (req, res) => {
  try {
    const { text, userId, groupId, messageId, strictness, model } = req.body;

    if (!text) {
      return res.status(400).json({ error: '缺少 text 参数' });
    }

    const result = await moderateText(text, { userId, groupId, messageId }, { strictness, model });
    res.json(result);
  } catch (err) {
    sendModerateError(res, err, '文本审核接口');
  }
});

// ─── 图片审核 ───
app.post('/api/moderate/image', async (req, res) => {
  try {
    // v0.1.2：image 与 imageUrl 至少给一个。只给 imageUrl ⇒ 服务端下载 + 转码后转 base64；
    // 两者都给 ⇒ 以 image 为准（调用方已付传输成本），imageUrl 仅作来源标注（逐字节等于历史行为）。
    const body = req.body || {};
    const { image, text, userId, groupId, messageId, strictness, imageUrl } = body;

    if (!image && !imageUrl) {
      return res.status(400).json({
        ok: false,
        code: 'IMAGE_REQUIRED',
        error: '缺少图片参数',
        message: '必须提供 image（base64）或 imageUrl（远程图片地址）之一',
        hint: '传 image（base64，可含 data: 前缀）或 imageUrl（http/https URL，服务端会自动下载并转码）。',
      });
    }

    let base64Data;
    let transcodeTag = null;
    if (image) {
      // 老路径：逐字节保持不变（含 image_ref.hash），不追加任何新字段
      base64Data = image.includes(',') ? image.split(',')[1] : image;
    } else {
      const fetched = await imageSource.fetchAndTranscodeToBase64(imageUrl, {});
      if (!fetched.ok) {
        return res.status(400).json({
          ok: false,
          code: fetched.code,
          error: fetched.message,
          message: fetched.message,
          hint: fetched.hint,
          imageUrl: String(imageUrl),
        });
      }
      base64Data = fetched.base64;
      transcodeTag = fetched.transcodeTag;
    }

    const meta = { userId, groupId, messageId, strictness, imageUrl: imageUrl || null };
    // 归一化发生在端点层（不改 moderateImage 签名）：转码标注随 meta 透传，由入口写进 image_ref.source。
    if (transcodeTag) meta.transcode = transcodeTag;
    const result = await moderateImage(base64Data, text || '', meta);
    res.json(result);
  } catch (err) {
    sendModerateError(res, err, '图片审核接口');
  }
});

// ─── 综合审核（文本+图片） ───
app.post('/api/moderate', async (req, res) => {
  try {
    const body = req.body || {};
    const { text, images, userId, groupId, messageId } = body;

    if (!text && (!images || images.length === 0)) {
      return res.status(400).json({ error: '至少提供 text 或 images 参数' });
    }

    // v0.1.2：images[] 每一项可以是 base64，也可以是 http(s) URL（混传支持）。
    // URL 项由服务端下载 + 转码后转 base64，再交回既有审核链路。
    const rawImages = Array.isArray(images) ? images : [];
    const cleanImages = [];
    for (const img of rawImages) {
      if (typeof img === 'string' && /^https?:\/\//i.test(img.trim())) {
        // eslint-disable-next-line no-await-in-loop
        const fetched = await imageSource.fetchAndTranscodeToBase64(img.trim(), {});
        if (!fetched.ok) {
          return res.status(400).json({
            ok: false,
            code: fetched.code,
            error: fetched.message,
            message: fetched.message,
            hint: fetched.hint,
            imageUrl: img.trim(),
          });
        }
        cleanImages.push(fetched.base64);
      } else {
        cleanImages.push(typeof img === 'string' && img.includes(',') ? img.split(',')[1] : img);
      }
    }

    const result = await moderate(text || '', cleanImages, { userId, groupId, messageId });
    res.json(result);
  } catch (err) {
    sendModerateError(res, err, '综合审核接口');
  }
});

// ─── 查看最近审核日志 ───
app.get('/api/logs', (req, res) => {
  const count = parseInt(req.query.count, 10) || 50;
  const logs = getRecentLogs(Math.min(count, 500));
  res.json({ total: logs.length, logs });
});

// ─── 审核记录（含原始文本，来自 audit-store）───
app.get('/api/audit-records', (req, res) => {
  const dateStr = req.query.date || getDateStr();
  // v0.2.0：新增可选筛选（model / risk / passed / image_hash / type / category / limit）。
  // 仅当**带筛选且 DB 可用**时才走 DB；无参数 ⇒ 行为与现状逐字节一致（读 JSONL，响应结构不变）。
  const fModel = req.query.model ? String(req.query.model) : null;
  const fRisk = req.query.risk ? String(req.query.risk) : (req.query.risk_level ? String(req.query.risk_level) : null);
  const fHash = req.query.image_hash ? String(req.query.image_hash) : null;
  const fPassed = (req.query.passed === undefined || req.query.passed === '')
    ? null
    : (String(req.query.passed) === 'true' || String(req.query.passed) === '1');
  // type 只接受 text|image（其余值视为未传，避免把非法值当成筛选条件改变响应）
  const fType = (req.query.type === 'text' || req.query.type === 'image') ? String(req.query.type) : null;
  const fCategory = req.query.category ? String(req.query.category) : null;
  const rawLimit = parseInt(req.query.limit, 10);
  const fLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100000) : null;
  // 分页偏移（默认 0）。与 limit 一样只做结果集截断，不参与「是否走 DB」的判断。
  const rawOffset = parseInt(req.query.offset, 10);
  const fOffset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  // 排序：desc = 最新在前（前端审核记录页用）；缺省 asc = 与历史行为逐字节一致。
  const fOrder = String(req.query.order || '').toLowerCase() === 'desc' ? 'desc' : 'asc';
  // find_id：把分页窗口对齐到某条记录附近，供「分类下钻 → 跳到审核记录并展开」精确落位。
  const fFindId = req.query.find_id ? String(req.query.find_id) : null;
  // limit 只做结果集截断，不参与「是否走 DB」的判断 —— 否则仅传 limit 也会被拖进 DB 投影，
  // 一旦 DB 未回灌就会比 JSONL 少记录。
  const hasFilter = Boolean(fModel || fRisk || fHash || fPassed !== null || fType || fCategory);
  let records = null;
  let usedDb = false;
  if (hasFilter && auditDb.probe().available) {
    if (!auditDb.isOpen()) auditDb.open();
    if (auditDb.isOpen()) {
      records = auditDb.query({
        date: dateStr,
        model: fModel || undefined,
        risk_level: fRisk || undefined,
        image_hash: fHash || undefined,
        passed: fPassed === null ? undefined : fPassed,
        modality: fType || undefined,
      });
      usedDb = true;
    }
  }
  if (!records) records = getAuditRecords(dateStr);
  // category 无对应 DB 列，统一在结果集上过滤（DB 路径与 JSONL 路径同一份判定逻辑）。
  // `unclassified` = 违规但没有 categories —— 判定只读布尔 passed，不用 action/risk_level 反推。
  if (fCategory) {
    records = records.filter((r) => {
      const result = r.result || {};
      const cats = Array.isArray(result.categories) ? result.categories.filter(Boolean) : [];
      if (fCategory === 'unclassified') return result.passed === false && cats.length === 0;
      return cats.includes(fCategory);
    });
  }
  // type 已由 DB 的 modality 列过滤；仅当未走 DB 时才需要兜底（判定与 audit-db.toRow 同口径）
  if (fType && !usedDb) {
    records = records.filter((r) => auditDb.toRow(r).modality === fType);
  }
  // passed 同理兜底：DB 的 passed 列由 result.passed 投影而来，JSONL 模式下若不补这一步，
  // 「分类下钻」在 DB 降级时会拿到未过滤的全量记录（旧实现即如此）。
  if (fPassed !== null && !usedDb) {
    records = records.filter((r) => {
      const pv = (r.result || {}).passed;
      if (pv === undefined || pv === null) return false;
      return Boolean(pv) === fPassed;
    });
  }
  // 排序 + 分页（在过滤之后、展平之前）。totalAll = 过滤后的全量条数，供前端显示「共 N 条」。
  let ordered = records;
  if (fOrder === 'desc') ordered = ordered.slice().reverse();
  const totalAll = ordered.length;
  // find_id：定位目标记录下标，把窗口居中对齐到它（供下钻跳转精确落位，仅在带 limit 时有意义）。
  let start = fOffset;
  if (fFindId) {
    const idx = ordered.findIndex((r) => String(r && r.id) === fFindId);
    if (idx >= 0) start = Math.max(0, idx - Math.floor((fLimit || 100) / 2));
  }
  let page = start > 0 ? ordered.slice(start) : ordered;
  if (fLimit !== null) page = page.slice(0, fLimit);
  // 展平结构：把 result 和 meta 的字段提到顶层，方便前端消费
  const flat = page.map((r) => {
    const { result = {}, meta = {}, ...rest } = r;
    return { ...rest, ...result, ...meta };
  });
  res.json({ total: flat.length, totalAll, offset: start, order: fOrder, date: dateStr, logs: flat });
});

// ─── v0.2.0：对账 / 回灌（仅报告不改文件；写操作需密码） ───
app.post('/api/audit-db/reconcile', requireAdminPassword, async (req, res) => {
  try {
    if (!auditDb.probe().available) {
      return res.json({ available: false, reason: auditDb.probe().reason });
    }
    // 对账前先排空补偿队列 —— 否则「仍在队列里」的记录会被误报为 missingInDb
    await flushAuditDb();
    if (!auditDb.isOpen()) auditDb.open();
    const date = (req.body && req.body.date) || getDateStr();
    const rep = auditDb.reconcile(date);
    res.json({ available: true, ...rep });
  } catch (err) {
    logError('server', `对账失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/audit-db/backfill', requireAdminPassword, (req, res) => {
  try {
    if (!auditDb.probe().available) {
      return res.json({ available: false, reason: auditDb.probe().reason });
    }
    if (!auditDb.isOpen()) auditDb.open();
    if (!auditDb.isOpen()) {
      return res.status(500).json({ error: 'DB 不可用（schema 闸门或打开失败）' });
    }
    const body = req.body || {};
    // 全量：遍历所有有记录的日期（幂等 upsert，可重复执行）
    if (body.all === true || body.date === 'all') {
      const dates = listAuditDates().map((d) => d.date);
      let inserted = 0;
      let updated = 0;
      let records = 0;
      for (const d of dates) {
        const list = getAuditRecords(d);
        const stat = auditDb.backfill(list);
        inserted += stat.inserted;
        updated += stat.updated;
        records += list.length;
      }
      return res.json({ available: true, scope: 'all', dates: dates.length, records, inserted, updated });
    }
    const date = body.date || getDateStr();
    const list = getAuditRecords(date);
    const stat = auditDb.backfill(list);
    res.json({ available: true, scope: date, records: list.length, inserted: stat.inserted, updated: stat.updated });
  } catch (err) {
    logError('server', `回灌失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── v0.2.0：图片内容寻址读取（公开） + 双写状态 ───
// 权限口径与 /api/audit-records、/api/audit-dates、/api/audit-stats、/api/plugin-views 一致（均无密码）。
// 安全边界：hash 必须匹配 ^[0-9a-f]{16}$，且只从 blob 根解析（闸门在 image-ref 内）⇒ 防目录穿越。
app.get('/api/audit-image/:hash', (req, res) => {
  const hash = String(req.params.hash || '');
  if (!imageRefModule.isHashSafe(hash)) {
    return res.status(400).json({ error: 'hash 非法（应为 16 位小写十六进制）' });
  }
  const full = req.query.full === '1' || req.query.full === 'true';
  const thumbPath = imageRefModule.thumbAbsPath(hash);
  const blobPath = imageRefModule.blobAbsPath(hash);
  const primary = full ? blobPath : (thumbPath || blobPath);
  const secondary = full ? null : blobPath;
  const pick = (p) => (p && fs.existsSync(p) ? p : null);
  const file = pick(primary) || pick(secondary);
  // 缺失 ⇒ 404（前端退化为占位符，不报错、不空白）
  if (!file) return res.status(404).json({ error: '图片不存在或已被清理', hash });
  // D4：`?full=1` 直出原图，必须有**硬上限**，否则一旦 blob 目录里出现
  // 「非本系统写入」的超大文件（手工放入 / 历史遗留 / 上限调小后残留），
  // 这个公开端点就会把它整包读进内存并吐给调用方。
  // 上限取「捕获配置的 maxBytes」（与 comparison-source.MAX_IMAGE_BYTES 同为 20MB 默认值口径一致）。
  // 超限不截断、不流式降级，直接 413 —— 前端把非 2xx 当作「无图」，退化成占位符。
  const maxBytes = Number(imageRefModule.getImageCaptureCfg().maxBytes) || imageRefModule.DEFAULT_MAX_BYTES;
  let fileBytes = 0;
  try { fileBytes = fs.statSync(file).size; } catch { fileBytes = 0; }
  if (fileBytes > maxBytes) {
    return res.status(413).json({
      error: `图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 单图上限`, hash, bytes: fileBytes, limitBytes: maxBytes,
    });
  }
  // 内容寻址 ⇒ 同一 hash 的字节永不改变，可长缓存
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: '图片读取失败' });
  });
});

// ─── 双写状态 + 图片容量（公开，供系统信息页） ───
app.get('/api/audit-store/status', (req, res) => {
  try {
    const capture = imageRefModule.getImageCaptureCfg();
    const capacity = imageRefModule.capacityStatus();
    res.json({
      dualWrite: getDualWriteStatus(),
      imageCapture: { enabled: capture.enabled, blobDir: imageRefModule.getBlobRoot() },
      imageBlobs: capacity,
    });
  } catch (err) {
    logError('server', `读取双写状态失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── 审核记录可用日期列表 ───
app.get('/api/audit-dates', (req, res) => {
  res.json({ dates: listAuditDates() });
});

// ─── 审核统计信息 ───
app.get('/api/audit-stats', (req, res) => {
  try {
    const today = getDateStr();
    const stats = getAuditStats(today);
    
    // 计算风险等级分布
    const riskDistribution = {
      safe: stats.by_risk?.safe || 0,
      low: stats.by_risk?.low || 0,
      medium: stats.by_risk?.medium || 0,
      high: stats.by_risk?.high || 0,
      critical: stats.by_risk?.critical || 0,
    };
    
    // 计算拦截率
    const blocked = stats.blocked || 0;
    const passed = stats.passed || 0;
    const total = stats.total || 0;
    const blockRate = total > 0 ? Math.round((blocked / total) * 100) : 0;
    
    res.json({
      date: today,
      total,
      passed,
      blocked,
      blockRate,
      riskDistribution,
      topCategories: Object.entries(stats.by_category || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, count]) => ({ category: cat, count })),
    });
  } catch (err) {
    res.status(500).json({ error: '获取审核统计失败', message: err.message });
  }
});

// ─── 详细统计面板（Token、耗时、7日趋势）───
app.get('/api/stats/summary', (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 7;
    const stats = getDetailedStats(Math.min(days, 30));
    // SEC-08：暴露提示词注入可疑计数（进程内累计，重启清零）
    stats.injection = injectionAudit.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: '获取统计失败', message: err.message });
  }
});

// ─── 审核分类说明 ───
app.get('/api/categories', (req, res) => {
  res.json(config.moderation.categories);
});

// ─── 阈值配置（获取/更新）───
app.get('/api/thresholds', (req, res) => {
  res.json({
    thresholds: config.moderation.thresholds || {},
    doubleCheck: config.moderation.doubleCheck || false,
    dualMode: config.moderation.dualMode || false,
    // 全局严格程度（顶栏「严格程度」选择器的真实来源；此前无处持久化 ⇒ 界面调档对机器人无效）
    strictness: config.moderation.strictness || 'standard',
    qwenCloud: {
      enabled: config.qwenCloud?.enabled || false,
      model: config.qwenCloud?.model || 'qwen-plus',
    },
  });
});

app.put('/api/thresholds', requireAdminPassword, (req, res) => {
  try {
    const { thresholds, doubleCheck, dualMode, strictness } = req.body;
    if (thresholds && typeof thresholds === 'object') {
      config.moderation.thresholds = thresholds;
    }
    if (typeof doubleCheck === 'boolean') {
      config.moderation.doubleCheck = doubleCheck;
    }
    if (typeof dualMode === 'boolean') {
      config.moderation.dualMode = dualMode;
      logInfo('server', `双审模式已${dualMode ? '启用' : '禁用'}`);
    }
    // 全局严格程度持久化（relaxed|standard|strict）。此前无任何端点可写 ⇒ 顶栏调档对真实管线无效。
    if (strictness !== undefined) {
      const s = String(strictness);
      if (!['relaxed', 'standard', 'strict'].includes(s)) {
        return res.status(400).json({ error: 'strictness 必须为 relaxed|standard|strict 之一' });
      }
      if (config.moderation.strictness !== s) logInfo('server', `全局严格程度已更新: ${config.moderation.strictness}→${s}`);
      config.moderation.strictness = s;
    }
    logInfo('server', `阈值配置已更新: doubleCheck=${config.moderation.doubleCheck}, dualMode=${config.moderation.dualMode}, strictness=${config.moderation.strictness}`);
    
    // 持久化到磁盘
    const { saveConfig } = require('./config');
    saveConfig();
    
    res.json({ 
      success: true, 
      thresholds: config.moderation.thresholds, 
      doubleCheck: config.moderation.doubleCheck,
      dualMode: config.moderation.dualMode,
      strictness: config.moderation.strictness
    });
  } catch (err) {
    res.status(500).json({ error: '更新阈值失败', message: err.message });
  }
});

// ─── 图像审核策略（v0.2.0：发送前缩图 / 判定缓存 / 泳装暴露档位 / WD14 联动开关）───
// 实现见 src/image-policy.js；缓存表在 data/audit.db 的 verdict_cache。
app.get('/api/image-policy', (req, res) => {
  const imagePolicy = require('./image-policy');
  const auditDb = require('./audit-db');
  const policy = imagePolicy.getImagePolicyCfg(config);
  let sharpAvailable = false;
  try { require('sharp'); sharpAvailable = true; } catch { sharpAvailable = false; }
  res.json({
    ...policy,
    exposureModes: imagePolicy.EXPOSURE_MODES,
    exposureScenes: imagePolicy.EXPOSURE_SCENES,
    exposureVerdicts: imagePolicy.EXPOSURE_VERDICTS,
    allowedImagePx: imagePolicy.ALLOWED_IMAGE_PX,
    sharpAvailable,
    sharpHint: sharpAvailable ? '' : 'sharp 未安装：发送前缩图已自动降级为「发送原图」。在项目根目录执行 npm install 后重启即可启用（预计可省 90%+ 视觉 token）。',
    cache: { enabled: policy.cacheVerdicts, entries: auditDb.verdictCacheCount(), dbOpen: auditDb.isOpen() },
  });
});

app.put('/api/image-policy', requireAdminPassword, (req, res) => {
  try {
    const imagePolicy = require('./image-policy');
    const auditDb = require('./audit-db');
    const body = req.body || {};
    if (!config.moderation.imagePolicy || typeof config.moderation.imagePolicy !== 'object') {
      config.moderation.imagePolicy = { maxImagePx: 768, cacheVerdicts: true, exposure: { mode: 'standard' }, useWd14Linkage: true };
    }
    const p = config.moderation.imagePolicy;
    if (!p.exposure || typeof p.exposure !== 'object') p.exposure = {};
    const changed = [];

    // R8：exposureScoring **先校验后应用** —— 非法立即 400，且**本次零写入**。
    // 校验必须发生在任何 `p.* =` 赋值之前，否则前面的字段已被静默改掉（「零写入」就破了）。
    let scoringPatch = null;
    if (body.exposureScoring !== undefined) {
      const parsed = imagePolicy.normalizeExposureScoring(
        body.exposureScoring, imagePolicy.getImagePolicyCfg(config).exposureScoring,
      );
      if (!parsed) {
        return res.status(400).json({
          error: 'exposureScoring 非法：enabled 必须为布尔；blockScore/pornographicMin 必须为 0~100 的整数；exemptScenes 必须为合法场景数组',
          allowed: imagePolicy.EXPOSURE_SCENES,
        });
      }
      scoringPatch = parsed;
    }

    if (body.maxImagePx !== undefined) {
      const n = Math.round(Number(body.maxImagePx));
      if (!Number.isFinite(n) || !(n === 0 || (n >= 128 && n <= 4096))) {
        return res.status(400).json({ error: 'maxImagePx 必须为 0（发送原图）或 128~4096 的整数', allowed: imagePolicy.ALLOWED_IMAGE_PX });
      }
      if (p.maxImagePx !== n) changed.push(`maxImagePx ${p.maxImagePx}→${n}`);
      p.maxImagePx = n;
    }
    if (body.cacheVerdicts !== undefined) {
      const v = Boolean(body.cacheVerdicts);
      if (p.cacheVerdicts !== v) changed.push(`cacheVerdicts ${p.cacheVerdicts}→${v}`);
      p.cacheVerdicts = v;
    }
    // exposure.mode 支持嵌套与扁平两种写法（前端用嵌套，脚本/调试用扁平）
    const modeInput = (body.exposure && typeof body.exposure === 'object') ? body.exposure.mode : body.exposureMode;
    if (modeInput !== undefined) {
      const m = String(modeInput);
      if (!imagePolicy.EXPOSURE_MODES.includes(m)) {
        return res.status(400).json({ error: `exposure.mode 必须为 ${imagePolicy.EXPOSURE_MODES.join('|')} 之一`, allowed: imagePolicy.EXPOSURE_MODES });
      }
      if (p.exposure.mode !== m) changed.push(`exposure.mode ${p.exposure.mode}→${m}`);
      p.exposure.mode = m;
    }
    if (body.useWd14Linkage !== undefined) {
      const v = Boolean(body.useWd14Linkage);
      if (p.useWd14Linkage !== v) changed.push(`useWd14Linkage ${p.useWd14Linkage}→${v}`);
      p.useWd14Linkage = v;
    }
    // R8：应用 exposureScoring（已在前面校验通过）
    if (scoringPatch) {
      const cur = imagePolicy.getImagePolicyCfg(config).exposureScoring;
      if (cur.enabled !== scoringPatch.enabled) changed.push(`exposureScoring.enabled ${cur.enabled}→${scoringPatch.enabled}`);
      if (cur.blockScore !== scoringPatch.blockScore) changed.push(`exposureScoring.blockScore ${cur.blockScore}→${scoringPatch.blockScore}`);
      if (cur.pornographicMin !== scoringPatch.pornographicMin) changed.push(`exposureScoring.pornographicMin ${cur.pornographicMin}→${scoringPatch.pornographicMin}`);
      if (cur.exemptScenes.join(',') !== scoringPatch.exemptScenes.join(',')) {
        changed.push(`exposureScoring.exemptScenes ${cur.exemptScenes.join('|')}→${scoringPatch.exemptScenes.join('|')}`);
      }
      p.exposureScoring = scoringPatch;
    }
    if (body.clearCache === true) {
      const removed = auditDb.clearVerdictCache();
      changed.push(`clearCache(-${removed})`);
    }

    const { saveConfig } = require('./config');
    saveConfig();
    const policy = imagePolicy.getImagePolicyCfg(config);
    logInfo('server', `图像审核策略已更新: ${changed.length ? changed.join(', ') : '(无字段变化)'}`
      + `；exposure.mode=${policy.exposureMode}（提示词档位，对下一次审核即时生效）`);
    res.json({
      success: true,
      changed,
      policy,
      cache: { entries: auditDb.verdictCacheCount(), dbOpen: auditDb.isOpen() },
    });
  } catch (err) {
    res.status(500).json({ error: '更新图像审核策略失败', message: err.message });
  }
});

// ─── 本地对话代理（仅前端对话 Tab 测试用，不暴露通用 Chat API）───
app.post('/api/chat-local', async (req, res) => {
  if (config.moderationMode === 'cloud-only') {
    return res.status(400).json({ error: 'cloud-only 模式不支持本地模型对话' });
  }
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '缺少 messages 参数' });
    }
    if (messages.length > 20) {
      return res.status(400).json({ error: '消息数量超出限制（最多20条）' });
    }
    const model = config.ollama.textModel;
    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      try {
        const full = await chatStream(model, messages, (piece) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`);
        });
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
      } catch (err) {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
      res.end();
      return;
    }
    const reply = await chatRaw(model, messages);
    res.json({ reply, model });
  } catch (err) {
    logError('server', `本地对话错误: ${err.message}`);
    res.status(500).json({ error: '对话服务内部错误', message: err.message });
  }
});

// ─── 手动卸载模型释放显存 ───
app.post('/api/unload', requireAdminPassword, async (req, res) => {
  if (config.moderationMode === 'cloud-only') {
    return res.status(400).json({ error: 'cloud-only 模式不支持本地模型管理' });
  }
  try {
    const { model } = req.body;
    const targetModel = model || config.ollama.textModel;
    await unloadModel(targetModel);
    res.json({ success: true, message: `模型 ${targetModel} 已卸载，显存已释放` });
  } catch (err) {
    logError('server', `卸载模型失败: ${err.message}`);
    res.status(500).json({ error: '卸载模型失败', message: err.message });
  }
});

// ─── 敏感词库管理 ───
app.get('/api/worddb/status', (req, res) => {
  const { wordDb } = loadWordDb();
  const categories = wordDb.categories || {};
  const stats = {};
  let total = 0;
  for (const [catId, cat] of Object.entries(categories)) {
    const count = (cat.words || []).length;
    stats[catId] = { count, level: cat.level };
    total += count;
  }
  res.json({ total, categories: stats });
});

app.post('/api/worddb/reload', (req, res) => {
  try {
    const { wordDb } = reloadWordDb();
    const categories = wordDb.categories || {};
    const stats = {};
    let total = 0;
    for (const [catId, cat] of Object.entries(categories)) {
      const count = (cat.words || []).length;
      stats[catId] = { count, level: cat.level };
      total += count;
    }
    res.json({ success: true, total, categories: stats });
  } catch (err) {
    res.status(500).json({ error: '词库重载失败', message: err.message });
  }
});

// ─── 敏感词库编辑（需要密码）───
const WORDDB_PASSWORD = config.wordDbPassword || '';

// 密码验证中间件（本地访问免密码，公网需密码或会话 Token）
function requireWordDbPassword(req, res, next) {
  // 本地访问免密码
  if (isLocalRequest(req)) return next();

  const clientIp = getClientIp(req);

  // 1. 检查会话 Token（优先）
  const token = req.headers['x-session-token'] || req.query.token || req.body?.token || '';
  if (isValidSessionToken(token, clientIp)) {
    return next();
  }

  // 2. 检查密码
  const pwd = req.headers['x-worddb-password'] || req.headers['x-admin-password'] || req.body?.password || '';
  const adminPwd = config.adminPassword || WORDDB_PASSWORD || '';
  if (!adminPwd) return next(); // 未设置密码则放行
  if (pwd !== adminPwd && pwd !== WORDDB_PASSWORD) {
    return res.status(403).json({ error: '密码错误，无权修改词库' });
  }
  next();
}

// 验证密码（公网密码验证接口，验证成功后返回会话 Token）
app.post('/api/worddb/verify-password', (req, res) => {
  // 本地访问直接成功
  if (isLocalRequest(req)) {
    return res.json({ success: true, localAccess: true });
  }
  const pwd = req.body?.password || '';
  const adminPwd = config.adminPassword || WORDDB_PASSWORD || '';
  if (!adminPwd) {
    return res.json({ success: true, noPassword: true });
  }
  if (pwd !== adminPwd && pwd !== WORDDB_PASSWORD) {
    return res.status(403).json({ success: false, error: '密码错误' });
  }
  // 验证成功，返回会话 Token
  const clientIp = getClientIp(req);
  const sessionToken = generateSessionToken(clientIp);
  res.json({ success: true, sessionToken, expiresIn: SESSION_TOKEN_TTL });
});

// ─── 管理员密码验证（通用，验证成功后返回会话 Token）───
app.post('/api/admin/verify-password', (req, res) => {
  if (isLocalRequest(req)) {
    return res.json({ success: true, localAccess: true });
  }
  const pwd = req.body?.password || '';
  const adminPwd = config.adminPassword || config.wordDbPassword || '';
  if (!adminPwd) {
    return res.json({ success: true, noPassword: true });
  }
  if (pwd !== adminPwd) {
    return res.status(403).json({ success: false, error: '密码错误' });
  }
  // 验证成功，返回会话 Token
  const clientIp = getClientIp(req);
  const sessionToken = generateSessionToken(clientIp);
  res.json({ success: true, sessionToken, expiresIn: SESSION_TOKEN_TTL });
});

// ─── 检查当前认证状态（用于前端判断是否需要跳转登录页）───
app.post('/api/admin/check-auth', (req, res) => {
  if (isLocalRequest(req)) {
    return res.json({ authenticated: true, localAccess: true });
  }
  const clientIp = getClientIp(req);
  const token = req.headers['x-session-token'] || '';
  if (isValidSessionToken(token, clientIp)) {
    return res.json({ authenticated: true });
  }
  return res.status(401).json({ authenticated: false, error: '未认证或会话已过期' });
});

// ─── 双审模式管理 ───
app.get('/api/dual-mode', (req, res) => {
  // API Key 脱敏：只显示前4位和后4位
  const apiKey = config.qwenCloud?.apiKey || process.env.DASHSCOPE_API_KEY || '';
  const tokenPlanApiKey = config.tokenPlan?.apiKey || '';
  const maskKey = (value) => value.length > 8
    ? value.substring(0, 4) + '****' + value.substring(value.length - 4)
    : value ? '****' : '';

  res.json({
    enabled: config.moderation.dualMode || false,
    qwenCloud: {
      enabled: config.qwenCloud?.enabled || false,
      billingSource: config.qwenCloud?.billingSource || 'dashscope',
      model: config.qwenCloud?.model || 'qwen-plus',
      visionModel: config.qwenCloud?.visionModel || 'qwen3.8-flash',
      visionEnabled: config.qwenCloud?.visionEnabled || false,
      endpoint: config.qwenCloud?.endpoint || '',
      hasApiKey: !!apiKey,
      maskedApiKey: maskKey(apiKey),
      timeout: config.qwenCloud?.timeout || 30000,
    },
    tokenPlan: {
      endpoint: config.tokenPlan?.endpoint || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      hasApiKey: !!tokenPlanApiKey,
      maskedApiKey: maskKey(tokenPlanApiKey),
      timeout: config.tokenPlan?.timeout || 60000,
    },
    // v2.3.0（Req6）：模型清单 + 价格收敛到 src/cloud-model-catalog.js 唯一数据源。
    // 旧实现把整张表手工抄在这里，与 moderator.js 的 MODEL_PRICING 长期漂移
    // （qwen3.6-plus / qwq-plus 后端有而前端无、deepseek-v4-flash-vision-exp 反之）。
    // `tokenPlan` 字段是**实测**结论：该模型在当前 Token Plan 端点下是否真的可调用。
    availableModels: listTextModels(),
    availableVisionModels: listVisionModels(),
    // 当前额度来源下的可用性诊断：前端据此标红「不可调用」项，避免重演云端视觉 404
    billing: {
      source: config.qwenCloud?.billingSource || 'dashscope',
      tokenPlanModelCount: TOKEN_PLAN_MODELS.length,
      currentTextModel: checkBilling(config.qwenCloud?.model || '', config.qwenCloud?.billingSource),
      currentVisionModel: checkBilling(config.qwenCloud?.visionModel || '', config.qwenCloud?.billingSource),
    },
  });
});

app.put('/api/dual-mode', requireAdminPassword, async (req, res) => {
  try {
    const {
      enabled, model, apiKey, endpoint, timeout, cloudEnabled, visionEnabled, visionModel,
      billingSource, tokenPlanApiKey, tokenPlanEndpoint, tokenPlanTimeout,
    } = req.body;

    if (typeof enabled === 'boolean') {
      config.moderation.dualMode = enabled;
      logInfo('server', `双审模式已${enabled ? '启用' : '禁用'}`);
    }
    if (!config.qwenCloud) config.qwenCloud = {};
    if (typeof cloudEnabled === 'boolean') {
      config.qwenCloud.enabled = cloudEnabled;
    }
    if (typeof visionEnabled === 'boolean') {
      config.qwenCloud.visionEnabled = visionEnabled;
    }
    if (model) {
      config.qwenCloud.model = model;
    }
    if (visionModel) {
      config.qwenCloud.visionModel = visionModel;
    }
    if (apiKey) {
      config.qwenCloud.apiKey = apiKey;
    }
    if (endpoint) {
      config.qwenCloud.endpoint = endpoint;
    }
    if (typeof timeout === 'number') {
      config.qwenCloud.timeout = timeout;
    }
    // 额度来源切换：token-plan（Credits 抵扣） vs dashscope（通用按量/节省计划）
    if (billingSource === 'token-plan' || billingSource === 'dashscope') {
      config.qwenCloud.billingSource = billingSource;
    }

    // ─── Token Plan 凭证 ───
    if (tokenPlanApiKey || tokenPlanEndpoint || typeof tokenPlanTimeout === 'number') {
      if (!config.tokenPlan) config.tokenPlan = {};
      if (tokenPlanApiKey) config.tokenPlan.apiKey = tokenPlanApiKey;
      if (tokenPlanEndpoint) config.tokenPlan.endpoint = tokenPlanEndpoint;
      if (typeof tokenPlanTimeout === 'number') config.tokenPlan.timeout = tokenPlanTimeout;
    }

    // v0.2.0（H1 修复）：此处**严禁**调用 regenerateFlows()。
    // 旧实现（v2.2.0 F17）在这里写 `regenerateFlows()`，本意是「dualMode 是派生视图，
    // 把开关写回拓扑」；但 regenerateFlows() 会先 `delete` 两个模态的 topology，再按旧开关
    // 用 migrate 重建 ⇒ **一次「保存云端配置」就把用户在画布上的全部编辑静默抹掉**：
    // 终裁层 finalizers、内容安全下限层、节点位置、用户增删的节点与连线、revision（重置为 1）。
    // 这是典型的「用户配置静默丢失」，与 /api/review-channels 下线的初衷完全一致。
    // 正确边界：本路由**只**持久化 dualMode 与 qwenCloud（含 tokenPlan）字段，
    // **完全不碰 `moderation.flows`**；审核通道由「审核配置 → 拓扑画布」唯一决定。
    // 若确需重置拓扑，只能走用户显式确认的 `POST /api/flow/:modality/reset`。
    const { saveConfig } = require('./config');
    saveConfig();

    // v2.3.0（Req6）：保存后回算「当前额度来源下是否真的可调用」并回报。
    // 刻意做成**警告而非拒绝**：用户可能需要先把 billingSource 改到 dashscope
    // 才能用视觉模型，若此处直接 400 会把人卡死（改不动任何一项）。
    const billingWarnings = [];
    if (config.qwenCloud?.visionEnabled) {
      const vc = checkBilling(config.qwenCloud?.visionModel || '', config.qwenCloud?.billingSource);
      if (!vc.ok) billingWarnings.push(`云端图片审核：${vc.reason}。${vc.suggestion}`);
    }
    if (config.qwenCloud?.enabled) {
      const tc = checkBilling(config.qwenCloud?.model || '', config.qwenCloud?.billingSource);
      if (!tc.ok) billingWarnings.push(`云端文本审核：${tc.reason}。${tc.suggestion}`);
    }
    if (billingWarnings.length) {
      logWarn('server', `云端模型额度来源告警: ${billingWarnings.join(' | ')}`);
    }

    // H1：日志文案同时声明「拓扑未改动」，避免日后又被误判为流保存（旧文案「双审配置已更新」
    // 曾让排查者 grep 不到「审核流程(...)已保存 revision=」，从而漏掉这条真正的写盘路径）。
    logInfo('server', `双审配置已更新（拓扑未改动）: dualMode=${config.moderation.dualMode}, cloud=${config.qwenCloud?.enabled}, billingSource=${config.qwenCloud?.billingSource}, model=${config.qwenCloud?.model}`);

    res.json({
      success: true,
      dualMode: config.moderation.dualMode,
      qwenCloud: {
        enabled: config.qwenCloud?.enabled || false,
        billingSource: config.qwenCloud?.billingSource || 'dashscope',
        visionEnabled: config.qwenCloud?.visionEnabled || false,
        model: config.qwenCloud?.model || 'qwen-plus',
        visionModel: config.qwenCloud?.visionModel || 'qwen3.8-flash',
        hasApiKey: !!(config.qwenCloud?.apiKey || process.env.DASHSCOPE_API_KEY),
      },
      // 不可调用则在保存响应的同一口气里回报，前端弹提示，不再「保存成功但线上 404」
      billingWarnings,
      // H1：明确回报「本接口不改拓扑」。dualMode / cloud 开关是**派生视图**，
      // 真正的通道开关在审核流程（拓扑图）里；本接口只保存云端模型/额度配置。
      channelsManagedByTopology: true,
      channelNotice: '审核通道由拓扑画布唯一决定：本接口仅保存云端模型与额度配置，**不会**修改审核流程。'
        + '如需增删/调整审核通道，请到「审核配置 → 拓扑画布」修改并保存。',
      tokenPlan: {
        endpoint: config.tokenPlan?.endpoint || '',
        hasApiKey: !!(config.tokenPlan?.apiKey),
      },
    });
  } catch (err) {
    res.status(500).json({ error: '更新双审配置失败', message: err.message });
  }
});

// ─── 阿里云内容安全状态（不返回 AccessKey）───
app.get('/api/content-safety/status', (req, res) => {
  res.json(getContentSafetyStatus());
});

// ─── 三审通道配置（v0.1.0：纯派生视图——读从拓扑反算，写入口已下线 → 410）───
app.get('/api/review-channels', (req, res) => {
  const flows = describeFlows();
  const text = flows.text || {};
  const image = flows.image || {};
  // 派生视图：旧的三个开关 + 分歧策略一律从**当前内存拓扑**反算（不再回读 moderation.reviewChannels）。
  // 两个模态任一接入即视为该通道启用，与画布所见一致（R2-8）。
  const derived = {
    local: Boolean(text.local || image.local),
    cloud: Boolean(text.cloud || image.cloud),
    contentSafety: Boolean(text.contentSafety || image.contentSafety),
    disputeStrategy: deriveDisputeStrategy(text, image),
  };
  // 历史配置回执（只读）：旧值未删除，原样回给前端，避免用户误以为数据丢了（PRD §5.1）
  const legacy = (config.moderation && config.moderation.legacy && config.moderation.legacy.reviewChannels) || null;
  res.json({
    ...derived,
    derived: true,
    writeEndpoint: 'PUT /api/flow/:modality',
    legacy,
    contentSafetyStatus: getContentSafetyStatus(),
    // 拓扑派生摘要（供画布与旧面板同步显示）
    flows,
  });
});

/**
 * 从合并节点反算旧「分歧策略」文案（派生视图用）。
 * 单独通道（strategy=single）按 highest 处理；priority 依分支优先级还原为 local/cloud。
 * @param {object} text 文本模态派生结果
 * @param {object} image 图像模态派生结果
 * @returns {string} 策略文案
 */
function deriveDisputeStrategy(text, image) {
  const src = (text && text.strategy && text.strategy !== 'single') ? text : image;
  const strategy = src && src.strategy ? src.strategy : 'single';
  if (strategy === 'priority') {
    const localP = Number.isFinite(src.localPriority) ? src.localPriority : 0;
    const cloudP = Number.isFinite(src.cloudPriority) ? src.cloudPriority : 0;
    if (cloudP > localP) return 'cloud';
    if (localP > cloudP) return 'local';
    return 'highest';
  }
  if (strategy === 'single') return 'highest';
  return strategy;
}

/**
 * 内容安全在本系统里可能出现的 ref 集合：已下线 ref + 它的后继 ref（插件节点）。
 * reconcileContentSafetyFloors 已把内存拓扑里的 `builtin.contentSafety` 改写成后继 ref，
 * 因此只比对字面量会在插件正常装载时永远返回 false（反算结果错误）。
 * @returns {Set<string>} ref 集合
 */
function contentSafetyRefSet() {
  const set = new Set(['builtin.contentSafety']);
  try {
    for (const ref of adjudicators.retiredTargets()) set.add(ref);
  } catch {
    // 注册表不可用时退回只认已下线 ref，不影响其余反算
  }
  return set;
}

/**
 * 从拓扑反算旧的通道开关（派生视图，供 GET /api/review-channels 展示）。
 * 派生自**当前内存拓扑**：插件装载后 `reconcileContentSafetyFloors` 已把下限层
 * 改写成后继 ref，这里必须同时识别后继 ref，否则反算结果恒为 false。
 * @returns {object} 反算结果
 */
function describeFlows() {
  const out = {};
  const csRefs = contentSafetyRefSet();
  for (const modality of ['text', 'image']) {
    const flow = flowModule.getFlow(config, modality);
    if (!flow) { out[modality] = { present: false }; continue; }
    const path = new Set();
    const nodes = flow.nodes || [];
    const edges = flow.edges || [];
    const inputId = (nodes.find((n) => n && n.type === 'input') || {}).id;
    const outputId = (nodes.find((n) => n && n.type === 'output') || {}).id;
    const adj = new Map(); const radj = new Map();
    for (const n of nodes) if (n && n.id) { adj.set(n.id, []); radj.set(n.id, []); }
    for (const e of edges) if (adj.has(e.from) && adj.has(e.to)) { adj.get(e.from).push(e.to); radj.get(e.to).push(e.from); }
    const walk = (start, g) => { const s = new Set(); const st = start ? [start] : []; while (st.length) { const id = st.pop(); if (s.has(id)) continue; s.add(id); for (const x of g.get(id) || []) st.push(x); } return s; };
    const fwd = walk(inputId, adj); const back = walk(outputId, radj);
    for (const id of fwd) if (back.has(id)) path.add(id);
    const connected = nodes.filter((n) => n && path.has(n.id)).map((n) => n.ref);
    const merge = nodes.find((n) => n && path.has(n.id) && n.type === 'merge');
    // 合并节点的分支优先级：用于还原 local/cloud 优先策略（priority 型）
    let localPriority = 0; let cloudPriority = 0;
    if (merge) {
      for (const e of edges) {
        if (!e || e.to !== merge.id || !Number.isFinite(e.priority)) continue;
        const fromRef = (nodes.find((n) => n && n.id === e.from) || {}).ref;
        if (fromRef === 'builtin.localModel') localPriority = e.priority;
        if (fromRef === 'builtin.cloudModel') cloudPriority = e.priority;
      }
    }
    out[modality] = {
      present: true,
      revision: flow.revision,
      local: connected.includes('builtin.localModel'),
      cloud: connected.includes('builtin.cloudModel'),
      // 同时识别已下线 ref 与其后继（插件）ref；floor 只是声明，enabled=false 视为未启用
      contentSafety: (flow.floors || []).some((f) => f && csRefs.has(f.ref) && f.enabled !== false),
      strategy: merge ? merge.strategy : 'single',
      localPriority,
      cloudPriority,
      finalizers: (flow.finalizers || []).map((f) => f.ref),
    };
  }
  return out;
}

/**
 * 旧写入口已下线（v0.1.0 / 需求 2）。返回 410 Gone 并引导改用拓扑保存接口。
 * 保留路由本身（而非删除）是为了让存量前端/脚本拿到明确的迁移指引，而不是 404。
 */
app.put('/api/review-channels', requireAdminPassword, (req, res) => {
  res.status(410).json({
    error: '接口已下线',
    code: 'GONE_REVIEW_CHANNELS',
    message: '「多重审核」配置已退役：审核通道现在由审核流程（拓扑图）唯一决定，'
      + '不再通过 reviewChannels 开关配置。',
    writeEndpoint: 'PUT /api/flow/:modality',
    readEndpoint: 'GET /api/review-channels',
    hint: '请在「审核流程」画布上增删服务节点并保存（PUT /api/flow/text 或 PUT /api/flow/image）。'
      + '历史配置未被删除，可在 GET /api/review-channels 的 legacy 字段查看。',
  });
});

// ─── 阿里云内容安全配置（读写，需要管理员密码）───
app.get('/api/content-safety/config', (req, res) => {
  const s = (req, res) => {
    const cs = config.contentSafety || {};
    const maskKey = (v) => v && v.length > 8 ? v.substring(0, 4) + '****' + v.substring(v.length - 4) : v ? '****' : '';
    // 兼容旧配置：textService (单值) → textServices (数组)
    let textServices = [];
    if (Array.isArray(cs.textServices) && cs.textServices.length > 0) {
      textServices = cs.textServices.filter(Boolean);
    } else if (cs.textService) {
      textServices = [cs.textService];
    }
    res.json({
      enabled: cs.enabled || false,
      textEnabled: cs.textEnabled !== false,
      imageEnabled: cs.imageEnabled !== false,
      region: cs.region || 'cn-shanghai',
      endpoint: cs.endpoint || 'green-cip.cn-shanghai.aliyuncs.com',
      textServices,
      imageService: cs.imageService || 'query_security_check',
      timeout: cs.timeout && !isNaN(Number(cs.timeout)) ? Number(cs.timeout) : 10000,
      hasAccessKeyId: !!(cs.accessKeyId),
      maskedAccessKeyId: maskKey(cs.accessKeyId),
      hasAccessKeySecret: !!(cs.accessKeySecret),
      maskedAccessKeySecret: maskKey(cs.accessKeySecret),
      status: getContentSafetyStatus(),
    });
  };
  if (isLocalRequest(req)) { s(req, res); } else {
    const clientIp = getClientIp(req);
    const token = req.headers['x-session-token'] || req.query.token || '';
    if (isValidSessionToken(token, clientIp)) return s(req, res);
    return res.status(403).json({ error: '公网查看内容安全配置需要先验证管理员密码' });
  }
});

app.put('/api/content-safety/config', requireAdminPassword, (req, res) => {
  try {
    if (!config.contentSafety) config.contentSafety = {};
    const cs = config.contentSafety;
    const { enabled, textEnabled, imageEnabled, accessKeyId, accessKeySecret, region, endpoint, textServices, textService, imageService, timeout } = req.body;
    if (typeof enabled === 'boolean') cs.enabled = enabled;
    if (typeof textEnabled === 'boolean') cs.textEnabled = textEnabled;
    if (typeof imageEnabled === 'boolean') cs.imageEnabled = imageEnabled;
    if (accessKeyId) cs.accessKeyId = accessKeyId;
    if (accessKeySecret) cs.accessKeySecret = accessKeySecret;
    if (region) cs.region = region;
    if (endpoint) cs.endpoint = endpoint;
    if (Array.isArray(textServices) && textServices.length > 0) {
      cs.textServices = textServices.filter(s => typeof s === 'string' && s.trim());
    } else if (textService) {
      cs.textServices = [textService];
    }
    if (imageService) cs.imageService = imageService;
    if (typeof timeout === 'number' && !isNaN(timeout)) cs.timeout = timeout;
    const { saveConfig } = require('./config');
    saveConfig();
    logInfo('server', '阿里云内容安全配置已更新');
    res.json({ success: true, status: getContentSafetyStatus() });
  } catch (err) {
    res.status(500).json({ error: '更新内容安全配置失败', message: err.message });
  }
});

// 云端审核状态检查
app.get('/api/cloud/status', async (req, res) => {
  const cloudConfig = config.qwenCloud || {};
  const model = cloudConfig.model || 'qwen-plus';
  const isDeepSeek = model.toLowerCase().includes('deepseek');
  const hasApiKey = !!(cloudConfig.apiKey || process.env.DASHSCOPE_API_KEY);

  if (!hasApiKey) {
    return res.json({ ok: false, model, error: '当前模型的 API Key 未配置', enabled: cloudConfig.enabled || false });
  }

  try {
    const status = await healthCheckCloud();
    res.json({
      ...status,
      enabled: cloudConfig.enabled || false,
      model: cloudConfig.model || 'qwen-plus',
    });
  } catch (err) {
    res.json({ ok: false, error: err.message, enabled: cloudConfig.enabled || false });
  }
});

app.get('/api/worddb/full', (req, res) => {
  try {
    const { wordDb } = loadWordDb();
    res.json(wordDb);
  } catch (err) {
    res.status(500).json({ error: '读取词库失败', message: err.message });
  }
});

app.post('/api/worddb/save', requireWordDbPassword, (req, res) => {
  try {
    const newDb = req.body;
    if (!newDb || !newDb.categories) {
      return res.status(400).json({ error: '无效的词库格式' });
    }
    const { wordDb } = saveWordDb(newDb);
    const categories = wordDb.categories || {};
    const stats = {};
    let total = 0;
    for (const [catId, cat] of Object.entries(categories)) {
      const count = (cat.words || []).length;
      stats[catId] = { count, level: cat.level };
      total += count;
    }
    logInfo('server', `词库已保存: ${total} 个词, 热重载完成`);
    res.json({ success: true, total, categories: stats });
  } catch (err) {
    logError('server', `词库保存失败: ${err.message}`);
    res.status(500).json({ error: '词库保存失败', message: err.message });
  }
});

app.post('/api/worddb/add-word', requireWordDbPassword, (req, res) => {
  try {
    const { category, word } = req.body;
    if (!category || !word) {
      return res.status(400).json({ error: '缺少 category 或 word 参数' });
    }
    const { wordDb } = loadWordDb();
    if (!wordDb.categories[category]) {
      return res.status(404).json({ error: `分类 ${category} 不存在` });
    }
    if (!wordDb.categories[category].words) {
      wordDb.categories[category].words = [];
    }
    const trimmed = word.trim();
    if (wordDb.categories[category].words.includes(trimmed)) {
      return res.json({ success: true, message: '词条已存在', duplicate: true });
    }
    wordDb.categories[category].words.push(trimmed);
    const result = saveWordDb(wordDb);
    logInfo('server', `词库添加: [${category}] "${trimmed}"`);
    res.json({ success: true, total: result.wordDb.categories[category].words.length });
  } catch (err) {
    res.status(500).json({ error: '添加词条失败', message: err.message });
  }
});

app.post('/api/worddb/remove-word', requireWordDbPassword, (req, res) => {
  try {
    const { category, word } = req.body;
    if (!category || !word) {
      return res.status(400).json({ error: '缺少 category 或 word 参数' });
    }
    const { wordDb } = loadWordDb();
    if (!wordDb.categories[category]) {
      return res.status(404).json({ error: `分类 ${category} 不存在` });
    }
    wordDb.categories[category].words = (wordDb.categories[category].words || [])
      .filter(w => w !== word.trim());
    const result = saveWordDb(wordDb);
    logInfo('server', `词库删除: [${category}] "${word.trim()}"`);
    res.json({ success: true, total: result.wordDb.categories[category].words.length });
  } catch (err) {
    res.status(500).json({ error: '删除词条失败', message: err.message });
  }
});

app.post('/api/worddb/update-mappings', requireWordDbPassword, (req, res) => {
  try {
    const { type, mappings } = req.body;
    // type: 'fuzzy_chars' | 'split_chars' | 'number_map'
    if (!type || !mappings) {
      return res.status(400).json({ error: '缺少 type 或 mappings 参数' });
    }
    const { wordDb } = loadWordDb();
    if (!wordDb[type]) {
      return res.status(404).json({ error: `映射类型 ${type} 不存在` });
    }
    wordDb[type].mappings = mappings;
    saveWordDb(wordDb);
    logInfo('server', `映射表已更新: ${type}, ${Object.keys(mappings).length} 条`);
    res.json({ success: true, count: Object.keys(mappings).length });
  } catch (err) {
    res.status(500).json({ error: '更新映射失败', message: err.message });
  }
});

// ─── 显存占用和文本长度上限信息 ───
// v2.3.0（Req6）：模型几何参数改由 src/model-profiles.js 唯一提供。
// 旧实现把 Qwen3-14B 的常量（8.2GB / 40 层 / Q4_K_M）写死在此函数里，
// 与实际配置模型（如 gpt-oss-safeguard:20b）不符 → 整页数字失真。
app.get('/api/vram-info', (req, res) => {
  if (config.moderationMode === 'cloud-only') {
    return res.status(400).json({ error: 'cloud-only 模式不支持本地显存管理' });
  }
  const numCtx = config.ollama.options.num_ctx || 4096;
  const numPredict = config.ollama.options.num_predict || 512;
  const modelId = config.ollama.textModel || '';

  // 审核 keep_alive 标签（0 表示立即释放，字符串如 "2m" 表示空闲保留时长）
  const modKeep = config.ollama.moderationKeepAlive;
  const moderationKeepAliveLabel = (modKeep === 0 || modKeep === '0')
    ? '0 (审核完立即释放)'
    : `${modKeep} (空闲后自动卸载，覆盖突发流量)`;

  const kvQuant = config.ollama.options.cache_type_k || 'f16';

  // ── 档案驱动估算（未收录模型显式标注，不套用他模型参数）──
  const profile = getProfile(modelId);
  let modelWeightGB, kvCacheGB, totalEstimateGB, bytesPerElement, shapeNote;
  if (profile) {
    const est = estimateVram(profile, numCtx, kvQuant);
    modelWeightGB = est.modelWeightGB;
    kvCacheGB = est.kvCacheGB;
    totalEstimateGB = est.totalGB;
    bytesPerElement = est.bytesPerElement;
    shapeNote = `${profile.layers} 层 · ${profile.kvHeads} KV heads · head_dim ${profile.headDim} · ${profile.quant}`;
  } else {
    // 未收录：退回保守基线（Qwen3-14B 几何），但**必须显示为未收录**
    const fallback = { weightGB: 8.2, layers: 40, kvHeads: 8, headDim: 128 };
    const est = estimateVram(fallback, numCtx, kvQuant);
    modelWeightGB = est.modelWeightGB;
    kvCacheGB = est.kvCacheGB;
    totalEstimateGB = est.totalGB;
    bytesPerElement = est.bytesPerElement;
    shapeNote = '模型未收录于档案表，按 14B 级基线粗略估算（仅供参考）';
  }

  const GPU_VRAM_GB = 16;
  const gpuLabel = 'RTX 4070 Ti Super (16GB VRAM)';

  // 文本长度上限估算
  // 中文约 1.5 token/字，英文约 0.25 token/词
  // 可用 token = num_ctx - system_prompt_tokens - num_predict
  // system prompt 约 800 tokens
  const systemPromptTokens = 800;
  const availableTokens = numCtx - systemPromptTokens - numPredict;
  const maxChineseChars = Math.floor(availableTokens / 1.5);
  const maxEnglishWords = Math.floor(availableTokens / 0.25);

  res.json({
    model: modelId,
    quantization: profile ? profile.quant : '未知',
    params: profile ? profile.params : '未知',
    nativeCtx: profile ? profile.nativeCtx : null,
    profileKnown: !!profile,
    gpu: gpuLabel,
    config: {
      num_ctx: numCtx,
      num_predict: numPredict,
      moderation_keep_alive: moderationKeepAliveLabel,
    },
    vram_estimate: {
      model_weight_gb: modelWeightGB.toFixed(2),
      kv_cache_gb: kvCacheGB.toFixed(2),
      total_estimate_gb: totalEstimateGB.toFixed(2),
      gpu_vram_gb: GPU_VRAM_GB,
      headroom_gb: (GPU_VRAM_GB - totalEstimateGB).toFixed(2),
      kv_bytes_per_element: bytesPerElement,
      shape: shapeNote,
      note: profile
        ? `估算值，实际占用取决于 Ollama 实现。KV Cache 为 ${kvQuant} 计算（每元素 ${bytesPerElement}B）。`
        : `估算值，实际占用取决于 Ollama 实现。KV Cache 为 ${kvQuant} 计算。⚠️ 该模型未收录于档案表，权重体积按 14B 级基线代入，数字偏差可能较大。`,
    },
    text_limits: {
      available_tokens: availableTokens,
      max_chinese_chars: maxChineseChars,
      max_english_words: maxEnglishWords,
      note: '中文约1.5 token/字，英文约0.25 token/词。已扣除 system prompt 和生成回复的 token。',
      formula: `可用token = num_ctx(${numCtx}) - system_prompt(${systemPromptTokens}) - num_predict(${numPredict}) = ${availableTokens}`,
    },
    keep_alive_strategy: {
      '审核调用': `keep_alive=${modKeep === 0 ? '0 (用完即卸)' : modKeep} — 审核后保留${modKeep === 0 ? '0' : modKeep}，覆盖突发流量，空闲后自动卸载`,
      '说明': `审核 keep_alive=${modKeep}：审核后短时保留避免频繁装卸，空闲后自动释放。切换审核模型时 Ollama 自动卸载旧模型。`,
    },
  });
});

// ─── 系统实时监控（CPU/GPU/内存/显存）───
app.get('/api/system-stats', async (req, res) => {
  if (config.moderationMode === 'cloud-only') {
    // cloud-only 模式无本地硬件监控，返回 200 + 标志，前端静默跳过（避免控制台 400 刷屏）
    return res.json({ available: false, cloudOnly: true, message: 'cloud-only 模式不支持本地硬件监控' });
  }
  try {
    const stats = await getSystemStats(config.ollama.host, config.ollama.textModel);
    res.json(stats);
  } catch (err) {
    logError('server', `系统监控接口错误: ${err.message}`);
    res.status(500).json({ error: '获取系统状态失败', message: err.message });
  }
});

// ─── 模型对比审核 ───

// 双轨兼容（6 个月）：comparison-suite 插件就绪时优先转发到插件，
// 插件未启用/未就绪时回退内置 src/comparator.js，响应结构不变。
// 两条路径共用同一套核心模块（comparison-engine / core / source / store / probe），
// 故一致率口径与结果文件格式完全一致，不存在「换个入口数字就变」的问题。
const COMPARE_PLUGIN_ID = 'comparison-suite';

/**
 * 尝试通过对比插件执行 RPC 方法。
 * @param {string} method RPC 方法名
 * @param {object} params 参数
 * @returns {Promise<any|null>} 插件返回的结果，插件不可用返回 null
 */
async function comparisonViaPlugin(method, params) {
  try {
    if (pluginHost.getPhase() !== 'ready') return null;
    if (!pluginHost.isPluginOnline(COMPARE_PLUGIN_ID)) return null;
    const out = await pluginHost.dispatchRpc(COMPARE_PLUGIN_ID, method, params);
    return out.ok ? out.result : null;
  } catch {
    return null;
  }
}

// 列出所有对比结果
app.get('/api/comparisons', async (req, res) => {
  const viaPlugin = await comparisonViaPlugin('comparison.list', {});
  if (viaPlugin && Array.isArray(viaPlugin.comparisons)) {
    return res.json({ total: viaPlugin.total, comparisons: viaPlugin.comparisons, via: 'plugin' });
  }
  const list = listComparisons();
  res.json({ total: list.length, comparisons: list, via: 'builtin' });
});

// 获取调度器状态
app.get('/api/comparisons/status', async (req, res) => {
  const viaPlugin = await comparisonViaPlugin('comparison.status', {});
  if (viaPlugin) {
    return res.json({
      scheduler: getSchedulerStatus(),
      comparison: viaPlugin,
      via: 'plugin',
    });
  }
  res.json({
    scheduler: getSchedulerStatus(),
    comparison: getComparisonStatus(),
    via: 'builtin',
  });
});

// 设置对比审核开关（自定义是否每日自动运行）
app.put('/api/comparisons/toggle', requireAdminPassword, (req, res) => {
  const enabled = req.body.enabled === true;
  try {
    const result = setComparisonEnabled(enabled);
    res.json({ success: true, enabled: result });
  } catch (err) {
    logError('server', `切换对比审核开关失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 获取最新对比结果
app.get('/api/comparisons/latest', async (req, res) => {
  const viaPlugin = await comparisonViaPlugin('comparison.get', { date: 'latest' });
  if (viaPlugin) return res.json({ ...viaPlugin, via: 'plugin' });
  const list = listComparisons();
  if (list.length === 0) {
    return res.status(404).json({ error: '暂无对比结果' });
  }
  const latest = list[0];
  const result = getComparisonResult(latest.date);
  res.json({ ...result, via: 'builtin' });
});

// 获取指定日期的对比结果
app.get('/api/comparisons/:date', async (req, res) => {
  const { date } = req.params;
  const viaPlugin = await comparisonViaPlugin('comparison.get', { date });
  if (viaPlugin) return res.json({ ...viaPlugin, via: 'plugin' });
  const result = getComparisonResult(date);
  if (!result) {
    return res.status(404).json({ error: `未找到 ${date} 的对比结果` });
  }
  res.json({ ...result, via: 'builtin' });
});

// 手动触发对比审核（支持模态：text / image）
app.post('/api/comparisons/run', async (req, res) => {
  const { date, modality } = req.body || {};
  const viaPlugin = await comparisonViaPlugin('comparison.run', { date, modality });
  if (viaPlugin && viaPlugin.success) {
    logInfo('server', `手动对比审核完成（插件）: ${viaPlugin.date} [${viaPlugin.modality || 'text'}]`);
    return res.json({
      success: true,
      summary: viaPlugin.summary,
      date: viaPlugin.date,
      modality: viaPlugin.modality || 'text',
      via: 'plugin',
    });
  }
  try {
    logInfo('server', `手动触发对比审核${date ? ` (日期: ${date})` : ''}${modality ? ` [${modality}]` : ''}`);
    const result = await triggerManual(date, { modality });
    res.json({
      success: true,
      summary: result.summary,
      date: result.date,
      modality: (result.summary && result.summary.modalities && result.summary.modalities[0]) || 'text',
      via: 'builtin',
    });
  } catch (err) {
    logError('server', `手动对比审核失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── 批量图片扫描 ───
// 双轨兼容（6 个月）：batch-image-suite 插件就绪时优先转发到插件，
// 插件未启用/未就绪时回退内置 src/batch-scan.js，旧接口响应结构不变（R-A07 / R-A22）。
const BATCH_PLUGIN_ID = 'batch-image-suite';

/**
 * 尝试通过插件执行批量操作。
 * @param {string} method RPC 方法名
 * @param {object} params 参数
 * @returns {Promise<any|null>} 插件返回的结果，插件不可用返回 null
 */
async function batchViaPlugin(method, params) {
  try {
    if (pluginHost.getPhase() !== 'ready') return null;
    if (!pluginHost.isPluginOnline(BATCH_PLUGIN_ID)) return null;
    const out = await pluginHost.dispatchRpc(BATCH_PLUGIN_ID, method, params);
    return out.ok ? out.result : null;
  } catch {
    return null;
  }
}

// 启动批量扫描（公网需密码）
app.post('/api/batch/scan', requireAdminPassword, async (req, res) => {
  const { folderPath, recursive, strictness } = req.body;
  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ error: '缺少文件夹路径' });
  }
  const viaPlugin = await batchViaPlugin('batch.scan', { folderPath, recursive: recursive !== false, strictness });
  if (viaPlugin && viaPlugin.task) {
    logInfo('server', `批量扫描任务已启动（插件）: ${viaPlugin.task.id}`);
    return res.json({ success: true, task: viaPlugin.task, via: 'plugin' });
  }
  try {
    const task = startBatchScan({ folderPath, recursive: recursive !== false, strictness });
    logInfo('server', `批量扫描任务已启动: ${task.id} (${task.folderPath}, strictness=${task.strictness})`);
    res.json({ success: true, task, via: 'builtin' });
  } catch (err) {
    logError('server', `启动批量扫描失败: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// 任务进度（含最近 5 条结果，供前端轮询）
app.get('/api/batch/status/:taskId', async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.status', { taskId: req.params.taskId });
  if (viaPlugin) return res.json(viaPlugin);
  const status = getTaskStatus(req.params.taskId);
  if (!status) return res.status(404).json({ error: '任务不存在' });
  res.json(status);
});

// 任务完整结果
app.get('/api/batch/results/:taskId', async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.results', { taskId: req.params.taskId });
  if (viaPlugin) return res.json(viaPlugin);
  const result = getTaskResults(req.params.taskId);
  if (!result) return res.status(404).json({ error: '任务不存在' });
  res.json(result);
});

// 停止任务（公网需密码）
app.post('/api/batch/stop/:taskId', requireAdminPassword, async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.stop', { taskId: req.params.taskId });
  if (viaPlugin) return res.json(viaPlugin);
  const ok = stopTask(req.params.taskId);
  res.json({ success: ok });
});

// 任务列表（活跃 + 历史）
app.get('/api/batch/tasks', async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.tasks', {});
  if (viaPlugin) return res.json(viaPlugin);
  res.json({ tasks: listTasks() });
});

// 删除单个扫描任务（公网需密码）
app.delete('/api/batch/task/:taskId', requireAdminPassword, async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.deleteTask', { taskId: req.params.taskId });
  if (viaPlugin) return res.json(viaPlugin);
  const ok = deleteTask(req.params.taskId);
  res.json({ success: ok, deleted: ok ? 1 : 0 });
});

// 清空全部扫描任务（公网需密码）
app.delete('/api/batch/tasks', requireAdminPassword, async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.clearTasks', {});
  if (viaPlugin) return res.json(viaPlugin);
  const count = clearAllTasks();
  res.json({ success: true, deleted: count });
});

// 导出 CSV
app.get('/api/batch/export/:taskId', (req, res) => {
  const csv = exportCsv(req.params.taskId);
  if (!csv) return res.status(404).json({ error: '任务不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="batch-scan-${req.params.taskId}.csv"`);
  res.send(csv);
});

// 按审核结果分类导出（写操作，公网需密码）
// body: { targetDir: string, levels?: string[], mode?: 'copy'|'move', keepFolders?: boolean }
app.post('/api/batch/export-category/:taskId', requireAdminPassword, async (req, res) => {
  try {
    const { targetDir, levels, mode, keepFolders } = req.body || {};
    if (!targetDir || typeof targetDir !== 'string') {
      return res.status(400).json({ error: '缺少 targetDir 参数' });
    }
    const viaPlugin = await batchViaPlugin('batch.exportCategory', {
      taskId: req.params.taskId, targetDir, levels, mode, keepFolders: !!keepFolders,
    });
    if (viaPlugin) return res.json(viaPlugin);
    const { jobId, total } = startExportByCategory(req.params.taskId, targetDir, { levels, mode, keepFolders: !!keepFolders });
    logInfo('server', `分类导出任务已启动: ${jobId}（源任务 ${req.params.taskId}，${total} 张，${mode || 'copy'}${keepFolders ? '，保留子文件夹' : ''}）`);
    res.json({ success: true, jobId, total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 分类导出进度查询
app.get('/api/batch/export-status/:jobId', async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.exportStatus', { jobId: req.params.jobId });
  if (viaPlugin) return res.json(viaPlugin);
  const job = getExportStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: '导出任务不存在' });
  res.json(job);
});

// 查看扫描结果中的原图（仅限任务结果里记录过的文件，防任意路径读取）
app.get('/api/batch/image/:taskId/:index', (req, res) => {
  const img = getTaskImage(req.params.taskId, req.params.index);
  if (!img) return res.status(404).json({ error: '图片不存在或已被移动/删除' });
  res.setHeader('Content-Type', img.contentType);
  res.sendFile(img.filePath);
});

// 查看扫描结果的缩略图（画廊用，避免加载 4K 原图导致卡顿）
// 带 LRU 内存缓存：同一任务+索引只解码一次
const thumbCache = new Map();
const THUMB_CACHE_MAX = 800;
app.get('/api/batch/thumb/:taskId/:index', async (req, res) => {
  const cacheKey = `${req.params.taskId}:${req.params.index}`;
  const hit = thumbCache.get(cacheKey);
  if (hit) {
    res.setHeader('Content-Type', hit.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(hit.buffer);
  }
  const thumb = await getTaskThumb(req.params.taskId, req.params.index);
  if (!thumb) return res.status(404).json({ error: '缩略图不可用' });
  // 简单 LRU：超出上限清最旧一半
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    const keys = [...thumbCache.keys()].slice(0, Math.floor(THUMB_CACHE_MAX / 2));
    for (const k of keys) thumbCache.delete(k);
  }
  thumbCache.set(cacheKey, thumb);
  res.setHeader('Content-Type', thumb.contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(thumb.buffer);
});

// ═══════════════════════════════════════════
// v2.2.0 审核流程（DAG 编排）API
// ═══════════════════════════════════════════

/** 能力/节点注册表快照（画布面板的唯一数据源）。*/
app.get('/api/flow/capabilities', async (req, res) => {
  const modality = req.query.modality && ['text', 'image'].includes(req.query.modality) ? req.query.modality : undefined;
  // 拉取前刷新一次插件就绪度（依据 manifest.readinessRpc），保证 ready/notReadyReason 实时
  try {
    const scanner = getScanner();
    if (scanner && typeof scanner.refreshAllReadiness === 'function') await scanner.refreshAllReadiness();
  } catch { /* 探测失败不影响快照返回*/ }
  res.json(flowModule.snapshot(modality));
});

/**
 * 审核器注册表快照（只读投影，供对比界面与外部脚本消费）。
 * 与 GET /api/flow/capabilities 同源（同一个注册表）且同样**不需要密码**（架构 §8 B5）。
 */
app.get('/api/flow/adjudicators', async (req, res) => {
  const modality = req.query.modality && ['text', 'image'].includes(req.query.modality) ? req.query.modality : undefined;
  // 与 capabilities 一致：返回前刷新一次插件就绪度，保证 ready/notReadyReason 实时
  try {
    const scanner = getScanner();
    if (scanner && typeof scanner.refreshAllReadiness === 'function') await scanner.refreshAllReadiness();
  } catch { /* 探测失败不影响快照返回*/ }
  res.json(adjudicators.snapshot(modality));
});

/**
 * 拓扑故障告警（D4 / R4 的安全阀）：列出**已接入通路却不可用**的节点。
 * 公开、无密码，与 GET /api/flow/capabilities 同源口径；且**必须先于** `/api/flow/:modality` 注册，
 * 否则 `faults` 会被当成 modality 参数匹配掉（Express 按注册顺序匹配）。
 * 只读：`collectFaults` 走 `getFlow` → 派生层，不写 config、不落盘。
 * 返回空数组是**正常态**：未接入通路的节点不构成故障（两轴正交，见架构 §3.2）。
 */
app.get('/api/flow/faults', async (req, res) => {
  // 与 capabilities 一致：返回前刷新一次插件就绪度，保证 ready/notReadyReason 实时
  try {
    const scanner = getScanner();
    if (scanner && typeof scanner.refreshAllReadiness === 'function') await scanner.refreshAllReadiness();
  } catch { /* 探测失败不影响故障扫描返回*/ }
  const faults = flowModule.collectFaults(config);
  res.json({ ok: true, faults, scannedAt: new Date().toISOString() });
});

/**
 * 从旧开关**重建**两个模态的拓扑（删除后按旧开关重新 migrate 生成）。
 * 危险函数：它会 `delete config.moderation.flows.text / .image` 再重建，因此会**抹掉**
 * 用户在画布上的全部自定义 —— 终裁层 `finalizers`、内容安全下限层 `floors`、全部节点位置、
 * 用户增删的节点与连线、汇聚策略，以及 `revision`（重建后从 1 重新计数）。
 * 合法调用点（白名单）**仅此一处**：
 * `POST /api/flow/:modality/reset`（「重置为默认拓扑」——用户显式操作，UI 有二次确认）。
 * 明确禁止在「保存 / 更新配置」类路由里调用。真实事故（H1）：
 * `PUT /api/dual-mode`（v2.2.0 F17）曾在此处调用本函数，导致用户在「云端审核配置」卡片
 * 点一次「保存配置」就静默销毁整个自定义拓扑。日志文案还是「双审配置已更新」，
 * 排查时 grep「审核流程(...)已保存 revision=」根本找不到，极难定位。
 * 若目标是「就地、非破坏性」对齐内存拓扑（例：插件集变化后回收未注册的陈旧 ref），
 * 请改用 `reconcileFlowsAfterPluginChange()`（→ `pluginRuntime.reconcileFlows`）或
 * `flowModule.reconcileContentSafetyFloors()` —— 它们只做字段级对齐，不删除节点/位置。
 * @returns {{text: object, image: object}} 重建后的 flow 映射（flowMigrate.ensureFlows 的结果）
 */
function regenerateFlows() {
  if (!config.moderation.flows) config.moderation.flows = { enabled: true };
  delete config.moderation.flows.text;
  delete config.moderation.flows.image;
  const res = flowMigrate.ensureFlows(config);
  // 重建后立刻按注册表现状对齐内容安全下限层：迁移器写出的 ref 是已下线内置节点的继任者，
  // 插件未装载时必须从内存剔除，否则 validateFlow 报 E004 → getValidFlow 返回 null → 退回旧引擎。
  // reconcile 失败不阻断，交给 validateFlow 给出明确告警。
  try {
    flowModule.reconcileContentSafetyFloors(config);
  } catch (err) {
    logWarn('server', `拓扑重建后内容安全下限层对齐失败（不影响主链路）: ${err.message}`);
  }
  return res;
}

/**
 * 合并「画布产出的字段」与「服务端管理的字段」（缺失即保留）。
 * 为什么不能盲信请求体：`PUT /api/flow/:modality` 的请求体只代表**画布当前能渲染出来的内容**。
 * `finalizers` / `floors` 是**服务端管理**字段——它们由插件注册表 +
 * `reconcileFinalizers()` / `reconcileContentSafetyFloors()` 依据「当前装载了哪些插件」共同维护，
 * 画布既不产出、也不理解它们。旧实现把请求体当全部真相（`{ ...flow }`），于是这两个字段
 * 在每次画布保存时被静默抹掉。真实数据事故：`config/default.json` 的 text / image 两个 flow
 * 都被保存成了 `"finalizers": []`，用户的图像终裁层 `plugin.wd14-tagger.linkage` 被无声删除。
 * 只对「缺失」宽容，不对「显式值」宽容：
 * - 请求体 `undefined` ⇒ **不是**「用户想删」，而是「画布不产出」⇒ 沿用现有的值
 * - 请求体显式传数组（含 `[]`）⇒ 以传入值为准 —— 用户真的想清空就必须能清空
 * @param {object} bodyFlow 请求体里的 flow（或整个请求体）
 * @param {object|undefined} existing 现有已保存的同模态 flow（可能不存在）
 * @returns {object} 合并后的 flow（新对象，不改动入参）
 */
function mergeServerManagedFlowFields(bodyFlow, existing) {
  const src = bodyFlow && typeof bodyFlow === 'object' ? bodyFlow : {};
  const prev = existing && typeof existing === 'object' ? existing : {};
  const merged = { ...src };
  for (const field of ['finalizers', 'floors']) {
    if (src[field] === undefined) {
      merged[field] = Array.isArray(prev[field]) ? prev[field] : [];
    }
  }
  return merged;
}

/** 校验并保存某模态流程。*/
app.put('/api/flow/:modality', requireAdminPassword, (req, res) => {
  const modality = req.params.modality;
  if (!['text', 'image'].includes(modality)) {
    return res.status(400).json({ ok: false, errors: [{ code: 'E001_SCHEMA', message: 'modality 必须为 text|image' }] });
  }
  const bodyFlow = req.body && req.body.flow ? req.body.flow : req.body;
  // 保持**授权期严格口径**（T08 修复 2026-09-17 的裁定）：保存是用户的显式写操作，
  // 含未注册 ref 的画布应当被拒、要求用户改对。若这里也放宽，「错别字 ref」会被静默存进配置，
  // 该节点随后在运行期被跳过（skipReason='missing-deps'）⇒ **漏审**，比直接报错更危险。
  // （GET /api/flow/:modality 放宽，是为让「引擎明明能跑」的拓扑不在画布上显示为非法；
  // 两者口径不同是有意的：一个答「能否执行」，一个答「是否规范」。）
  const validation = flowModule.validateFlow(bodyFlow, flowModule.registry);
  if (!validation.ok) {
    // 服务端是最终权威：有 error 则一行都不写
    return res.status(400).json({ ok: false, errors: validation.errors, warnings: validation.warnings });
  }
  if (!config.moderation.flows) config.moderation.flows = { enabled: true };
  const baseRevision = Number(req.body && req.body.baseRevision);
  const current = config.moderation.flows[modality];
  if (Number.isFinite(baseRevision) && current && Number.isFinite(current.revision) && baseRevision !== current.revision) {
    return res.status(409).json({ ok: false, error: '配置已被其他地方修改', currentRevision: current.revision });
  }
  // 字段保留：请求体缺失的服务端管理字段（finalizers / floors）沿用现有值，避免被画布保存抹掉
  // 派生字段剥离（T03）：画布可能把带 `onPath` 的草稿回传，存盘前必须摘掉 ⇒ 磁盘永不含派生位。
  const flow = flowModule.stripDerived(mergeServerManagedFlowFields(bodyFlow, current));
  const saved = { ...flow, modality, revision: (current && Number.isFinite(current.revision) ? current.revision : 0) + 1, updatedAt: new Date().toISOString(), meta: { note: '', sourceOfTruth: true } };
  config.moderation.flows[modality] = saved;
  const { saveConfig } = require('./config');
  saveConfig();
  logInfo('server', `审核流程(${modality})已保存 revision=${saved.revision}`);
  res.json({ ok: true, revision: saved.revision, warnings: validation.warnings });
});

/** 只校验不保存（前端即时提示，防抖调用）。
 * 保持**授权期严格口径**：这是用户显式发起的「检查我的画布」操作，
 * 未注册 ref 应当以 error 呈现（与 PUT 一致；GET 的运行期口径见该端点注释）。*/
app.post('/api/flow/:modality/validate', (req, res) => {
  const flow = req.body && req.body.flow ? req.body.flow : req.body;
  const validation = flowModule.validateFlow(flow, flowModule.registry);
  // 附派生只读位（T03）：校验结果同样给出通路/孤岛划分，供画布即时灰显，避免前端自造口径。
  const annotated = flowModule.annotateFlow(flow);
  const onPathNodes = (annotated && Array.isArray(annotated.nodes) ? annotated.nodes : [])
    .filter((n) => n && n.onPath).map((n) => n.id);
  res.json({
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    onPathNodes,
    orphanNodes: flowModule.orphanIds(flow),
  });
});

/** 读取某模态流程 + 校验结果。*/
app.get('/api/flow/:modality', (req, res) => {
  const modality = req.params.modality;
  if (!['text', 'image'].includes(modality)) return res.status(400).json({ error: 'modality 必须为 text|image' });
  const flow = flowModule.getFlow(config, modality);
  if (!flow) return res.status(404).json({ error: `尚未生成 ${modality} 流程` });
  // 用**运行期口径**校验（T08 缺陷修复 2026-09-17）：本端点服务于**画布加载**，必须与
  // `getValidFlow` 同口径 —— 否则「插件被禁用后引擎明明还能跑」的拓扑会在画布上显示为非法。
  // 未注册的 `plugin.*` 节点/下限层引用会出现在 `warnings[]`（code 仍是 E004_REF_UNKNOWN），
  // 不静默消失。**授权期严格校验请用 `POST /api/flow/:modality/validate`**（用户显式发起）。
  // 校验跑在**原始 flow** 上（E009/`flowSignature` 口径零改动）；响应体 `flow` 换用
  // `annotateFlow()` 的**浅克隆副本** —— 这是唯一附加 `onPath` 的地方，内存 config 不受影响。
  const validation = flowModule.validateFlow(flow, flowModule.registry, { runtime: true });
  const annotated = flowModule.annotateFlow(flow);
  const orphanNodes = flowModule.orphanIds(flow);
  res.json({
    ok: validation.errors.length === 0,
    flow: annotated,
    errors: validation.errors,
    warnings: validation.warnings,
    enabled: flowModule.isEnabled(config),
    onPathCount: (Array.isArray(annotated.nodes) ? annotated.nodes : []).filter((n) => n && n.onPath).length,
    orphanCount: orphanNodes.length,
  });
});

/** 试运行（dry-run）：用样例内容实跑，返回逐节点 trace（不落审计）。*/
app.post('/api/flow/:modality/dry-run', requireAdminPassword, async (req, res) => {
  const modality = req.params.modality;
  if (!['text', 'image'].includes(modality)) return res.status(400).json({ error: 'modality 必须为 text|image' });
  const selected = flowModule.getValidFlow(config, modality);
  if (!selected.flow) {
    return res.status(400).json({ ok: false, error: '流程不合法，无法试运行', errors: selected.validation.errors });
  }
  const sample = (req.body && req.body.sample) || {};
  try {
    const result = modality === 'text'
      ? await moderateText(String(sample.text || ''), { skipAudit: true, dryRun: true }, {})
      : await moderateImage(String(sample.imageBase64 || ''), String(sample.caption || ''), { skipAudit: true, dryRun: true });
    res.json({ ok: true, verdict: result, node_traces: result.node_traces || [] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * 重置为默认拓扑（由旧开关重新迁移生成）。
 * 这是 `regenerateFlows()` 的**唯一合法调用点**（用户显式「重置」+ UI 二次确认）。
 * 它会丢弃画布上的全部自定义，这正是「重置」的本意 —— 请**不要**把它改成非破坏性语义，
 * 否则「重置」将无法真正恢复到默认拓扑。若要非破坏性地对齐，请用 reconcile 系列函数。
 */
app.post('/api/flow/:modality/reset', requireAdminPassword, (req, res) => {
  const modality = req.params.modality;
  if (!['text', 'image'].includes(modality)) return res.status(400).json({ error: 'modality 必须为 text|image' });
  try {
    regenerateFlows();
    const flow = flowModule.getFlow(config, modality);
    if (flow && !flowModule.isEnabled(config)) config.moderation.flows.enabled = true;
    const { saveConfig } = require('./config');
    saveConfig();
    res.json({ ok: true, flow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 复制拓扑（文本 → 图像，自动剔除模态不匹配节点）。*/
app.post('/api/flow/copy', requireAdminPassword, (req, res) => {
  const from = req.body && req.body.from;
  const to = req.body && req.body.to;
  if (!['text', 'image'].includes(from) || !['text', 'image'].includes(to)) {
    return res.status(400).json({ error: 'from/to 必须为 text|image' });
  }
  const src = flowModule.getFlow(config, from);
  if (!src) return res.status(404).json({ error: `源流程 ${from} 不存在` });
  const flowModuleRef = flowModule.registry;
  const nodes = (src.nodes || []).filter((n) => {
    if (!['service', 'contribute'].includes(n.type)) return true;
    const d = flowModuleRef.get(n.ref);
    return d ? d.modality.includes(to) : false;
  });
  const kept = new Set(nodes.map((n) => n.id));
  const edges = (src.edges || []).filter((e) => kept.has(e.from) && kept.has(e.to));
  const floors = (src.floors || []).filter((f) => {
    const d = flowModuleRef.get(f.ref);
    return !d || d.modality.includes(to);
  });
  res.json({ ok: true, flow: { ...src, modality: to, nodes, edges, floors, finalizers: to === 'image' ? (src.finalizers || []) : [] } });
});

// ─── Express 全局错误处理中间件（兜底：任何路由内抛出的异常都走这里，不崩服务） ───
app.use((err, req, res, next) => {
  // body 解析失败（如 JSON 格式错误）返回 400 而非崩溃
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: `请求体无效: ${err.message}` });
  }
  logError('server', `请求处理异常 ${req.method} ${req.path}: ${err.message}`, err.stack);
  res.status(500).json({ error: '服务器内部错误', message: err.message });
});

// ─── 插件路由代理（ 必须注册在 404 兜底之前） ───
// /api/p/:pid/*、/api/plugin-views、/api/plugins/host/status 常驻注册，listen 前即存在，
// 未就绪时返回 503 / {status:'booting'}，就绪后按注册表运行时分发（R-A03 / R-A04）。
pluginRuntime.registerRoutes(app, { requireAdmin: requireAdminPassword });

// 404 兜底（未匹配路由）
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: '接口不存在' });
  } else {
    res.status(404).send('Not Found');
  }
});

// ─── 启动服务 ───
const PORT = config.server.port;
const HOST = config.server.host;

// ─── 配置致命冲突闸门（架构 §4.1，resolution='block' 的组合拒绝启动）───
if (isStartupBlocked()) {
  for (const conflict of getConflicts().filter((c) => c.resolution === 'block')) {
    logError('server', `[config-block] [${conflict.id}] ${conflict.message} → ${conflict.fix}`);
  }
  logError('server', '存在致命配置冲突，已拒绝启动；修正 config/default.json 后重试');
  process.exit(1);
}

app.listen(PORT, HOST, async () => {
  const { logStartup } = require('./logger');

  // v0.2.0：启动时做一次轻量探测并建库（node:sqlite 不可用 ⇒ 自动降级为纯 JSONL，绝不阻断启动）
  try {
    const probe = auditDb.probe();
    if (probe.available) {
      auditDb.open();
      logInfo('server', auditDb.isOpen()
        ? `审核记录 DB 已就绪（${auditDb.getDbPath()}）`
        : `审核记录 DB 打开失败，已降级为纯 JSONL：${auditDb.getStatus().lastError || ''}`);
    } else {
      logWarn('server', `审核记录 DB 已降级为纯 JSONL 模式：${probe.reason}`);
    }
  } catch (err) {
    logWarn('server', `审核记录 DB 初始化异常（已忽略）: ${err.message}`);
  }
  
  const caps = getCapabilities();
  logStartup({
    url: `http://${HOST}:${PORT}`,
    mode: config.moderationMode === 'cloud-only' ? '云端轻量' : '本地完整',
    localModel: caps.local.available ? config.ollama.textModel : null,
    cloudModel: caps.cloud.available ? config.qwenCloud.model : null,
    contentSafety: caps.contentSafety.available,
    dualMode: config.moderation.dualMode,
  });

  // 可选能力未配置时给出一次性明确提示（而不是运行时反复报错）
  for (const [name, label] of [['local', '本地模型'], ['cloud', '云端大模型'], ['contentSafety', '内容安全']]) {
    if (!caps[name].available) {
      logWarn('server', `${label}通道未配置，已跳过 (${caps[name].reason})`);
    }
  }
  if (!caps.local.available && !caps.cloud.available && !caps.contentSafety.available) {
    logWarn('server', '当前无任何 AI 审核通道可用，服务以「敏感词预检」模式运行；配置任一通道后自动生效');
  }
  
  logInfo('server', 'API 文档:');
  logInfo('server', '  POST /api/moderate/text   - 文本审核');
  logInfo('server', '  POST /api/moderate/image  - 图片审核');
  logInfo('server', '  POST /api/moderate        - 综合审核（文本+图片）');
  logInfo('server', '  GET  /health              - 健康检查');
  logInfo('server', '  GET  /api/logs            - 查看审核日志');
  logInfo('server', '  GET  /api/categories      - 审核分类说明');
  logInfo('server', '  GET  /api/comparisons     - 模型对比结果');
  logInfo('server', '  GET  /api/dual-mode       - 双审模式状态');
  logInfo('server', '  GET  /api/content-safety/status - 阿里云内容安全状态');
  logInfo('server', '  PUT  /api/dual-mode       - 更新双审配置（公网需密码）');
  logInfo('server', '  POST /api/admin/verify-password - 验证管理员密码（返回会话 Token）');

  // 初始化定时对比审核调度器（每日凌晨3点）
  initScheduler();

  // 初始化插件系统（cordis 桥接 + 扫描 manifest + 装载已启用插件）
  // 改为 await：插件抛异常不阻断主链路（内部已 try/catch），但必须等它 ready
  // 才能执行依赖插件的孤儿任务续扫与自动扫描（R-A04）。
  try {
    let sharp = null;
    try { sharp = require('sharp'); } catch { sharp = null; }
    await pluginRuntime.init({
      app,
      config,
      sharp,
      moderator: { moderateText, moderateImage, moderateImageLocal, moderate, healthCheck },
      vision: {
        chat: (model, systemPrompt, userContent, images = [], host = null) =>
          chatRaw(model, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent, images },
          ], host),
      },
    });
  } catch (err) {
    logError('server', `插件系统初始化失败（主审核链路不受影响）: ${err.message}`);
  }

  // 兜底：无论插件初始化是否正常结束，都按「注册表现状」再对齐一次内存拓扑（幂等）。
  // 若插件 ⑤ 区因异常未跑到，磁盘上残留的 `builtin.contentSafety` 这类已下线 ref 会让
  // 每个请求都静默退回旧引擎（B2 明令禁止）。此处对齐后，首屏请求即可走新引擎。
  try {
    pluginRuntime.reconcileFlows(config);
  } catch (err) {
    logWarn('server', `启动期拓扑对齐失败（不影响主链路）: ${err.message}`);
  }

  // ─── 崩溃恢复：续扫孤儿任务 + 自动扫描目录（必须在插件就绪之后） ───
  const batchCfg = config.batch || {};
  if (batchCfg.autoResume !== false) {
    const resumed = resumeOrphanedTasks();
    if (resumed > 0) {
      logInfo('server', `已恢复 ${resumed} 个未完成的扫描任务，自动续扫`);
    }
    // 若配置了自动扫描目录，且该目录没有进行中的任务，则自动启动扫描（含续扫）
    if (batchCfg.autoScanFolder) {
      const folder = batchCfg.autoScanFolder;
      const alreadyScanning = listTasks().some((t) =>
        t.folderPath === folder && (t.status === 'running' || t.status === 'scanning')
      );
      if (!alreadyScanning) {
        try {
          const task = startBatchScan({ folderPath: folder, recursive: true, strictness: batchCfg.autoScanStrictness || 'standard' });
          logInfo('server', `已自动启动扫描任务 ${task.id}: ${folder}（已完成部分将自动跳过）`);
        } catch (err) {
          logError('server', `自动扫描目录启动失败: ${err.message}`);
        }
      } else {
        logInfo('server', `目录已在扫描中，跳过自动启动: ${folder}`);
      }
    }
  }
});
