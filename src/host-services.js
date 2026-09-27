/**
 * 宿主能力 Service 化（src/host-services.js）
 * 把主项目的既有能力（配置 / 日志 / 审核 / sharp / 文件系统枚举）封装为一组服务对象，
 * 由 cordis-bridge 在根 ctx 上一次性 provide，插件通过 ctx.inject(key) 取用。
 * 安全约定（R4 最小权限，修 C11/C12）：
 * - 插件拿到的 config 是**脱敏冻结只读投影**：递归剔除 adminPassword / wordDbPassword /
 * *.apiKey / accessKeySecret 等密钥字段（列表见 src/host-api/contract.js），并 Object.freeze。
 * - host.app（Express 实例）**不再注入**：契约 v1.0 已移除 'host:app'，需要挂接口请走 ctx.rpc。
 * - fs 能力只提供「只读枚举」：statDir / listDir / roots，不提供写删改。
 * 所有写操作由插件通过 RPC + 任务引擎在受控目录内完成。
 */
const fs = require('fs');
const path = require('path');
const { logInfo, logWarn, logError } = require('./logger');
const { isDeniedConfigKey, CONFIG_REDACTED, secretGrantsOf } = require('./host-api/contract');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif']);

/** 宿主日志适配器：保持与现有日志格式一致（不走 cordis 自带 logger）*/
const loggerService = {
  info: (...args) => logInfo('plugin', args.map(fmt).join(' ')),
  warn: (...args) => logWarn('plugin', args.map(fmt).join(' ')),
  error: (...args) => logError('plugin', args.map(fmt).join(' ')),
  debug: (...args) => logInfo('plugin', args.map(fmt).join(' ')),
};

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * 判定路径是否为图片（按扩展名）。
 * @param {string} p 文件路径
 * @returns {boolean}
 */
function isImagePath(p) {
  return IMAGE_EXTS.has(path.extname(String(p || '')).toLowerCase());
}

/**
 * 防穿越校验：把用户输入路径限制在允许的根目录之内。
 * @param {string} target 目标绝对路径
 * @param {string} root 允许的根目录
 * @returns {boolean} 是否安全
 */
function isInsideRoot(target, root) {
  const t = path.resolve(target);
  const r = path.resolve(root);
  if (t === r) return true;
  return t.startsWith(r + path.sep) || t.startsWith(r + '/');
}

/**
 * 枚举目录内容（懒加载一级，供前端目录树展开）。
 * @param {string} dir 目录绝对路径
 * @param {{dirsOnly?: boolean}} options 选项
 * @returns {{ok: boolean, error?: string, path?: string, entries?: Array<object>}}
 */
function listDir(dir, options = {}) {
  const result = { ok: false, path: dir || '', entries: [] };
  if (!dir || typeof dir !== 'string') {
    result.error = '路径为空';
    return result;
  }
  try {
    const abs = path.resolve(dir);
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) {
      result.error = '不是目录';
      return result;
    }
    const names = fs.readdirSync(abs);
    const entries = [];
    for (const name of names) {
      // 跳过系统/隐藏目录，避免 100GB 场景无意义遍历
      if (name === '$RECYCLE.BIN' || name === 'System Volume Information') continue;
      const full = path.join(abs, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          entries.push({ name, path: full, type: 'dir', hasChildren: true });
        } else if (!options.dirsOnly) {
          entries.push({ name, path: full, type: 'file', size: st.size, isImage: isImagePath(full) });
        }
      } catch { /* 无权限的条目跳过*/ }
    }
    // 目录在前，名称升序
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    result.ok = true;
    result.path = abs;
    result.entries = entries;
    return result;
  } catch (err) {
    result.error = err.code === 'ENOENT' ? '目录不存在' : (err.code === 'EACCES' ? '无访问权限' : err.message);
    return result;
  }
}

/**
 * 目录统计（供 folder-picker 校验）：是否存在 / 是否目录 / 图片数量 / 预估体积 / 样例文件名。
 * @param {string} dir 目录绝对路径
 * @param {{recursive?: boolean, maxScan?: number}} options 选项
 * @returns {object} 统计结果
 */
function statDir(dir, options = {}) {
  const out = {
    exists: false,
    isDir: false,
    path: dir || '',
    imageCount: 0,
    fileCount: 0,
    estBytes: 0,
    dirCount: 0,
    sampleNames: [],
    truncated: false,
  };
  if (!dir || typeof dir !== 'string') return out;
  const abs = path.resolve(dir);
  out.path = abs;
  try {
    const st = fs.statSync(abs);
    out.exists = true;
    if (!st.isDirectory()) return out;
    out.isDir = true;
  } catch {
    return out;
  }

  const recursive = options.recursive !== false;
  const maxScan = Number(options.maxScan) > 0 ? Number(options.maxScan) : 20000;
  let scanned = 0;

  const walk = (current, depth) => {
    if (scanned >= maxScan) { out.truncated = true; return; }
    let names = [];
    try { names = fs.readdirSync(current); } catch { return; }
    for (const name of names) {
      if (scanned >= maxScan) { out.truncated = true; return; }
      const full = path.join(current, name);
      let st2 = null;
      try { st2 = fs.statSync(full); } catch { continue; }
      scanned++;
      if (st2.isDirectory()) {
        out.dirCount++;
        if (recursive && depth < 32) walk(full, depth + 1);
      } else {
        out.fileCount++;
        out.estBytes += st2.size;
        if (isImagePath(full)) {
          out.imageCount++;
          if (out.sampleNames.length < 12) out.sampleNames.push(name);
        }
      }
    }
  };
  walk(abs, 0);
  return out;
}

/**
 * 列出可用盘符/根目录（Windows 取存在的盘符，其他系统取 /）。
 * @returns {Array<{name: string, path: string}>}
 */
function roots() {
  const out = [];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;
      try {
        if (fs.existsSync(root)) out.push({ name: `${letter}:`, path: root });
      } catch { /* 忽略不可读盘符*/ }
    }
  } else {
    out.push({ name: '/', path: '/' });
  }
  return out;
}

// ─── config 脱敏冻结投影（R4） ───

/**
 * 递归冻结对象（含数组元素），保证插件无法篡改注入的投影。
 * @param {any} value 待冻结值
 * @returns {any} 同一对象（已冻结）
 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * 生成注入插件的 config 投影：递归剔除密钥字段 + 深冻结。
 * 保留字段形状（密钥位置填 '***'），插件可据此判断「未配置」。
 * @param {object} config 原始配置
 * @returns {object} 脱敏冻结投影
 */
function sanitizeConfig(config) {
  const redacted = [];
  const walk = (value, depth) => {
    if (depth > 32 || !value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) {
      if (isDeniedConfigKey(key)) {
        redacted.push(key);
        out[key] = CONFIG_REDACTED;
        continue;
      }
      out[key] = walk(value[key], depth + 1);
    }
    return out;
  };
  const projection = walk(config || {}, 0);
  if (redacted.length) {
    logInfo('host-services', `插件配置投影已脱敏 ${redacted.length} 个密钥字段（${[...new Set(redacted)].join(', ')}）`);
  }
  return deepFreeze(projection);
}

/**
 * 按 'a.b.c' 路径读取原始配置值。
 * @param {object} config 原始配置
 * @param {string} configPath 路径
 * @returns {*} 值或 undefined
 */
function pickConfigPath(config, configPath) {
  const keys = String(configPath || '').split('.');
  let cursor = config;
  for (const key of keys) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * 宿主 secrets 服务（方案 C，架构 §8.1）。
 * 密钥**不下发**给插件的 config 投影（CONFIG_DENY_KEYS 规则不变）；
 * 只有 manifest 声明 `services.injects: ['secrets']` + `permissions: ['moderation:provide']`
 * 且 id 命中 SECRET_GRANTS 白名单的插件，才能按白名单路径取到明文。
 * @param {object} config 原始配置
 * @returns {{get: Function, grantsOf: Function}} secrets 服务
 */
function createSecretsService(config = {}) {
  const warned = new Set();
  return {
    /**
     * 取某插件白名单内的密钥明文。
     * @param {string} pluginId 插件 id
     * @param {string} configPath 配置路径（如 contentSafety.accessKeyId）
     * @returns {string|null} 明文或 null（未授权 / 未配置）
     */
    get(pluginId, configPath) {
      const grants = secretGrantsOf(pluginId);
      if (!grants.includes(configPath)) {
        const tag = `${pluginId}:${configPath}`;
        if (!warned.has(tag)) {
          warned.add(tag);
          logWarn('host-services', `插件 ${pluginId} 请求了白名单外的密钥字段 '${configPath}'，已拒绝`);
        }
        return null;
      }
      const value = pickConfigPath(config, configPath);
      return value === undefined || value === null ? null : String(value);
    },
    /** 取某插件允许读取的密钥路径列表*/
    grantsOf: secretGrantsOf,
  };
}

/**
 * 宿主 precheck 服务（F07 词库不出库）。
 * 只返回 { hit, category, level }，**绝不返回命中词原文，也不返回词表本身**。
 * @returns {{match: Function}} precheck 服务
 */
function createPrecheckService() {
  return {
    /**
     * 匹配文本是否命中敏感词（受控判定 API）。
     * @param {string} text 待检测文本
     * @returns {{hit: boolean, category: string, level: string}} 判定（不含原文）
     */
    match(text) {
      try {
        const { precheck } = require('./precheck');
        const result = precheck(String(text || ''));
        if (!result || !result.hasHit || !Array.isArray(result.hits) || result.hits.length === 0) {
          return { hit: false, category: '', level: '' };
        }
        // 只取最高等级命中的分类与等级，绝不带出词条原文
        const order = { safe: 0, low: 1, medium: 2, review: 3, high: 4, critical: 5 };
        let best = result.hits[0];
        for (const hit of result.hits) {
          if ((order[hit.level] ?? 0) > (order[best.level] ?? 0)) best = hit;
        }
        return { hit: true, category: String(best.category || ''), level: String(best.level || 'medium') };
      } catch {
        return { hit: false, category: '', level: '' };
      }
    },
  };
}

/**
 * 构建宿主能力集合。
 * @param {{config?: object, moderator?: object, sharp?: object, vision?: object, projectRoot?: string}} deps 依赖
 * @returns {object} 宿主服务对象
 */
function createHostServices(deps = {}) {
  const {
    config = {},
    moderator = {},
    sharp = null,
    vision = null,
    projectRoot = path.join(__dirname, '..'),
  } = deps;
  return {
    // 不再暴露 app（契约 v1.0 移除 host:app）
    config: sanitizeConfig(config),
    moderator,
    sharp,
    vision,
    projectRoot,
    logger: loggerService,
    fs: { statDir, listDir, roots, isImagePath, isInsideRoot },
    /** 受控密钥下发（白名单）*/
    secrets: createSecretsService(config),
    /** 受控词库判定（不出库）*/
    precheck: createPrecheckService(),
    /**
     * v2.4.0：通用持久化 KV 服务（带 TTL，命名空间隔离）。
     * 内核只提供原语，缓存语义（键怎么算 / TTL 多长 / 命中怎么用）全交给插件。
     * 惰性 require audit-db，保持「核心模块仅依赖 capability-broker / plugin-runtime」的边界，
     * 且维持「只有 audit-db 直连 node:sqlite」的约定。
     */
    kvStore: {
      get(namespace, key, nowMs) { return require('./audit-db').kvGet(namespace, key, nowMs); },
      set(namespace, key, valueJson, opts) { return require('./audit-db').kvSet(namespace, key, valueJson, opts); },
      clear(namespace) { return require('./audit-db').kvClear(namespace); },
      count(namespace) { return require('./audit-db').kvCount(namespace); },
      purgeExpired(nowMs) { return require('./audit-db').kvPurgeExpired(nowMs); },
    },
    // v2.3.0（Req5）：对比审核三件套。均为**惰性 require**，避免
    // host-services 在模块加载期就拖入 audit-store / ollama / qwen_cloud，
    // 从而绕开「核心模块仅允许依赖 capability-broker / plugin-runtime」的边界约束。
    /** 对比输入侧：审核记录 + 图片字节（只读）*/
    get comparisonSource() {
      return require('./comparison-source');
    },
    /** 对比输出侧：结果落盘与读取（与内置 comparator 共用同一存储实现）*/
    get comparisonStore() {
      return require('./comparison-store');
    },
    /** 单通道审核探针（prompt / 密钥全部留在核心，不出库）*/
    get comparisonProbe() {
      return require('./comparison-probe');
    },
    /** 纯函数「怎么比」：零依赖，插件与内置引擎共用同一口径*/
    get comparisonCore() {
      return require('./comparison-core');
    },
    /** 对比编排引擎：插件的 runComparison 与内置 comparator 的 runComparison 是同一份实现*/
    get comparisonEngine() {
      return require('./comparison-engine');
    },
    /** 便捷方法：判断路径是否在工程目录内（asset 白名单用）*/
    isInsideProject(target) {
      return isInsideRoot(target, projectRoot);
    },
  };
}

module.exports = {
  createHostServices,
  createSecretsService,
  createPrecheckService,
  sanitizeConfig,
  deepFreeze,
  loggerService,
  statDir,
  listDir,
  roots,
  isImagePath,
  isInsideRoot,
  pickConfigPath,
  IMAGE_EXTS,
};
