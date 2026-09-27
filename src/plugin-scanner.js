/**
 * 插件扫描、校验、导入与生命周期（src/plugin-scanner.js）
 * 职责：
 * 1. 扫描 plugins 目录下的各插件 manifest.json（缺 manifest 的目录视为普通目录，跳过不报错）
 * 2. manifest 7 类校验：id 正则 / main 存在 / host 版本 / 依赖白名单 / permissions 枚举 / 体积 / 静态风险（软警告）
 * 3. 生命周期状态机：Discovered → Validating → Installed / Invalid → Loading → Active / Error → Uninstalling
 * 4. 四种来源：builtin / local / zip / git；更新、卸载（回收目录）、重载（清 require 缓存）
 * 5. data/plugins-state.json 持久化启用状态与来源信息
 * 零新增依赖：ZIP 用 Node 内置 zlib + 手工 central directory 解析；git 用 child_process.execFile
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { logInfo, logError } = require('./logger');
const bridge = require('./cordis-bridge');
const broker = require('./capability-broker');
const contract = require('./host-api/contract');
const eventRegistry = require('./host-api/event-registry');
const boundary = require('../scripts/lint-plugin-boundary');
const flowRegistry = require('./flow/registry');

const PROJECT_ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'plugins');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
// v0.2.0：测试隔离开关。`GRS_PLUGIN_STATE` 未设置时 = `path.join(DATA_DIR, 'plugins-state.json')`
// （与旧版逐字节等价）；测试用它把「哪些插件被启用」的状态文件重定向到 TEMP，
// 避免测试改写**静默改变用户的插件启用状态**。
const STATE_FILE = process.env.GRS_PLUGIN_STATE || path.join(DATA_DIR, 'plugins-state.json');
const TRASH_DIR = path.join(DATA_DIR, 'plugins-trash');
const TMP_DIR = path.join(DATA_DIR, 'plugins-tmp');

/** 插件 id 规则：^[a-z0-9][a-z0-9-]{2,39}$*/
const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

/**
 * 依赖白名单（ 严格零新增依赖：只允许主项目已有的包）。
 * 单一来源改为 scripts/lint-plugin-boundary.js（收敛：移除 express，cordis 仅桥接层可用）。
 */
const DEPENDENCY_WHITELIST = boundary.DEPENDENCY_WHITELIST;

/** 已知权限枚举（ 单一来源：src/host-api/contract.js；v1.0 起移除 host:app）*/
const PERMISSION_ENUM = new Set(contract.PERMISSIONS);

/** 插件包体积上限：50MB*/
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
/** 回收目录保留天数*/
const TRASH_KEEP_DAYS = 7;

/** 可选依赖白名单（ 单一来源：契约层）*/
const OPTIONAL_WHITELIST = contract.OPTIONAL_DEPENDENCY_SET;
/** 可选依赖「至少其一」约束（nsfwjs → TF.js 后端二选一）*/
const OPTIONAL_ANY_OF = contract.OPTIONAL_DEPENDENCY_ANY_OF;

/**
 * 判定一个 npm 包是否可被 require 解析（不抛异常）。
 * @param {string} pkg 包名
 * @returns {boolean} 是否可解析
 */
function canResolve(pkg) {
  try {
    require.resolve(pkg, { paths: [PROJECT_ROOT] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测 manifest 声明的可选依赖是否齐备（架构 §8.2）。
 * 缺失时**不抛异常、不注册能力、不装载**，仅置 status='missing-deps'。
 * @param {object} manifest 插件清单
 * @returns {{ok: boolean, error?: string, missing: string[], installHint: string}}
 */
function probeOptionalDeps(manifest) {
  const declared = (manifest && manifest.optionalDependencies) || {};
  const missing = [];
  for (const pkg of Object.keys(declared)) {
    if (!OPTIONAL_WHITELIST.has(pkg)) {
      return {
        ok: false,
        error: `未允许的可选依赖：${pkg}（可选依赖白名单见 src/host-api/contract.js）`,
        missing: [pkg],
        installHint: '',
      };
    }
    if (!canResolve(pkg)) missing.push(pkg);
  }

  // 特殊约束：声明 nsfwjs 时必须至少有一个 TF.js 后端
  if (Object.prototype.hasOwnProperty.call(declared, 'nsfwjs') && !missing.includes('nsfwjs')) {
    const candidates = OPTIONAL_ANY_OF.nsfwjs || [];
    const hasBackend = candidates.some((pkg) => canResolve(pkg));
    if (!hasBackend) missing.push(candidates.map((p) => p).join('（或）'));
  }

  if (missing.length > 0) {
    const installHint = buildInstallHint(declared, missing);
    return { ok: false, missing, installHint };
  }
  return { ok: true, missing: [], installHint: '' };
}

/**
 * 生成可选依赖缺失时的安装指引。
 * @param {object} declared manifest.optionalDependencies
 * @param {string[]} missing 缺失项
 * @returns {string} 安装命令
 */
function buildInstallHint(declared, missing) {
  const pkgs = Object.keys(declared || {});
  const needed = pkgs.filter((p) => !missing.some((m) => m === p || m.startsWith(p)));
  const list = needed.length > 0 ? needed : pkgs;
  if (list.length === 0) return '';
  return `npm i ${list.join(' ')}`;
}

/**
 * 节点角色分类器（架构 §4.5，解决坑 ②）。
 * @param {object} manifest 插件清单
 * @returns {'service'|'contribute'|'finalize'|'task'} 分类
 */
function classifyPlugin(manifest) {
  const explicit = manifest && manifest.contributes && manifest.contributes.flowRole;
  if (explicit === 'task') return 'task';
  const caps = (manifest && manifest.contributes && manifest.contributes.capabilities) || [];
  if (caps.some((c) => /\.verdict$/.test(c.id))) return 'service';
  if (caps.some((c) => c.id === 'image.tag')) return 'contribute';
  if (caps.some((c) => c.id === 'image.linkage')) return 'finalize';
  return 'task';
}

/**
 * 由插件 manifest 生成拓扑节点描述符（供 flow/registry 注册）。
 * 优先使用 manifest.contributes.nodes 显式声明；缺失时按能力合成。
 * task 型插件**直接返回空**（注册表层排除，杜绝幽灵节点）。
 * @param {object} meta 插件元数据
 * @returns {{nodes: Array<object>, finalizers: Array<object>, role: string}}
 */
function buildPluginNodes(meta) {
  const manifest = meta.manifest || {};
  const contributes = manifest.contributes || {};
  const role = classifyPlugin(manifest);
  if (role === 'task') return { nodes: [], finalizers: [], role };

  const caps = Array.isArray(contributes.capabilities) ? contributes.capabilities : [];
  const capIds = new Set(caps.map((c) => c.id));
  const declaredNodes = Array.isArray(contributes.nodes) ? contributes.nodes : [];
  const out = [];

  // 显式声明优先
  for (const node of declaredNodes) {
    const normalized = {
      ...node,
      ref: node.ref || `plugin.${meta.id}.${node.modality ? node.modality[0] : 'node'}`,
      kind: 'plugin',
      owner: meta.id,
      role: contract.normalizeRole(node.role || (capIds.has('image.tag') ? 'contribute' : 'service')),
      ready: true,
      notReadyReason: '',
      capability: node.capability || (capIds.has('text.verdict') ? 'text.verdict' : capIds.has('image.verdict') ? 'image.verdict' : 'image.tag'),
      mode: node.mode || 'call',
      modality: Array.isArray(node.modality) ? node.modality : ['image'],
    };
    out.push(normalized);
  }

  // 按能力合成（无显式声明时）
  if (out.length === 0) {
    if (capIds.has('text.verdict')) {
      out.push({
        ref: `plugin.${meta.id}.text`, kind: 'plugin', owner: meta.id, title: meta.name || meta.id,
        modality: ['text'], role: 'service', defaultCombine: 'branch', combineEditable: false,
        canParallel: true, multiInstance: true, capability: 'text.verdict', mode: 'call',
        params: [], failurePolicyOptions: ['inherit', 'block', 'review'], defaultTimeoutMs: 15000,
        costHint: 'paid-api',
      });
    }
    if (capIds.has('image.verdict')) {
      out.push({
        ref: `plugin.${meta.id}.image`, kind: 'plugin', owner: meta.id, title: meta.name || meta.id,
        modality: ['image'], role: 'service', defaultCombine: 'branch', combineEditable: false,
        canParallel: true, multiInstance: true, capability: 'image.verdict', mode: 'call',
        params: [], failurePolicyOptions: ['inherit', 'block', 'review'], defaultTimeoutMs: 15000,
        costHint: 'paid-api',
      });
    }
    if (capIds.has('image.tag')) {
      out.push({
        ref: `plugin.${meta.id}.tag`, kind: 'plugin', owner: meta.id, title: meta.name || meta.id,
        modality: ['image'], role: 'contribute', defaultCombine: 'branch', combineEditable: false,
        canParallel: false, multiInstance: false, capability: 'image.tag', mode: 'collect',
        params: [], failurePolicyOptions: ['inherit', 'block', 'review'], defaultTimeoutMs: 15000,
        costHint: 'free',
      });
    }
  }

  const finalizers = [];
  if (capIds.has('image.linkage')) {
    finalizers.push({
      ref: `plugin.${meta.id}.linkage`, kind: 'plugin', owner: meta.id, role: 'finalize',
      title: `${meta.name || meta.id} · 终裁联动`, modality: ['image'],
      capability: 'image.linkage', mode: 'first', enabled: true,
    });
  }

  return { nodes: out, finalizers, role };
}

/** id → PluginMeta（内存中的插件清单）*/
const _metas = new Map();
/** 校验失败的插件：id → { id, error }*/
const _invalid = new Map();

// ─── 持久化状态 ───

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 读取 data/plugins-state.json*/
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    logError('plugin-scanner', `读取 ${STATE_FILE} 失败，按空状态处理: ${err.message}`);
    return {};
  }
}

/** 写入 data/plugins-state.json（原子替换）*/
function saveState(state) {
  try {
    ensureDir(DATA_DIR);
    // v0.2.0：STATE_FILE 可被 GRS_PLUGIN_STATE 重定向；确保其所在目录存在
    // （默认时 path.dirname(STATE_FILE) === DATA_DIR，与旧行为一致）。
    ensureDir(path.dirname(STATE_FILE));
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    logError('plugin-scanner', `插件状态持久化失败: ${err.message}`);
  }
}

/**
 * 更新单个插件的状态字段。
 * @param {string} id 插件 id
 * @param {object} patch 补丁
 */
function patchState(id, patch) {
  const state = loadState();
  state[id] = { ...(state[id] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveState(state);
  return state[id];
}

/** 取单个插件的持久状态*/
function getState(id) {
  return loadState()[id] || null;
}

// ─── 工具 ───

/**
 * 极简语义化版本比较（只处理数字段）。
 * @param {string} a 版本 A
 * @param {string} b 版本 B
 * @returns {number} a>b → 1，a<b → -1，相等 → 0
 */
function compareVersion(a, b) {
  const pa = String(a || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 递归统计目录体积（字节）。
 * @param {string} dir 目录
 * @returns {number} 字节数
 */
function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const full = path.join(d, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else total += st.size;
      } catch { /* 忽略*/ }
    }
  };
  walk(dir);
  return total;
}

/**
 * 递归复制目录。
 * @param {string} src 源目录
 * @param {string} dest 目标目录
 */
function copyDir(src, dest) {
  ensureDir(dest);
  const names = fs.readdirSync(src);
  for (const name of names) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 递归删除目录。
 * @param {string} dir 目录
 */
function rmDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) rmDir(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

// ─── 静态风险扫描（软警告，R-A24） ───

/**
 * 扫描插件目录中的高风险调用（软警告，不阻断安装）。
 * @param {string} dir 插件目录
 * @returns {Array<{file: string, kind: string, detail: string}>} 风险项
 */
function staticScan(dir) {
  const risks = [];
  const patterns = [
    { kind: 'eval', re: /\beval\s*\(/ },
    { kind: 'new Function', re: /\bnew\s+Function\s*\(/ },
    { kind: 'child_process.exec', re: /\bexec\s*\(/ },
    { kind: '动态 require', re: /\brequire\s*\(\s*[^'"`)]/ },
  ];
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      if (name === 'node_modules') continue;
      const full = path.join(d, name);
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      const relPath = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) { walk(full, relPath); continue; }
      if (!/\.(js|cjs|mjs)$/i.test(name)) continue;
      if (st.size > 512 * 1024) continue;
      let text = '';
      try { text = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      for (const p of patterns) {
        if (p.re.test(text)) risks.push({ file: relPath, kind: p.kind, detail: `命中 ${p.kind}` });
      }
      // 白名单外 require
      const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
      let m = null;
      while ((m = re.exec(text)) !== null) {
        const pkg = m[1];
        if (pkg.startsWith('.') || pkg.startsWith('/') || path.isAbsolute(pkg)) continue;
        const top = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
        if (!DEPENDENCY_WHITELIST.has(top) && !OPTIONAL_WHITELIST.has(top) && !top.startsWith('node:')) {
          risks.push({ file: relPath, kind: '未授权依赖', detail: `require('${pkg}')` });
        }
      }
    }
  };
  walk(dir, '');
  return risks;
}

// ─── manifest 校验（7 类，R-A06） ───

/**
 * 取 manifest 声明的能力清单，并把 integrity.maxOutputBytes 下发给每项能力。
 * @param {object} manifest 插件清单
 * @returns {Array<object>} 能力声明（副本）
 */
function capabilitiesOf(manifest) {
  const caps = (manifest.contributes && manifest.contributes.capabilities) || [];
  const max = manifest.integrity && Number(manifest.integrity.maxOutputBytes) > 0
    ? Number(manifest.integrity.maxOutputBytes)
    : contract.DEFAULT_MAX_OUTPUT_BYTES;
  return (Array.isArray(caps) ? caps : []).map((c) => ({ ...c, maxOutputBytes: max }));
}

/**
 * 校验 manifest，返回中文错误列表。
 * @param {object} manifest manifest 对象
 * @param {string} dir 插件目录
 * @param {Set<string>} existingIds 已存在的插件 id 集合
 * @returns {{ok: boolean, errors: Array<string>, risks: Array<object>}}
 */
function validateManifest(manifest, dir, existingIds = new Set()) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['插件清单格式非法：manifest.json 必须是 JSON 对象'], risks: [] };
  }

  // ① id 合法性与冲突
  const id = manifest.id;
  if (!id || typeof id !== 'string' || !ID_RE.test(id)) {
    errors.push(`插件 ID 非法：${id || '(缺失)'}（需匹配 ^[a-z0-9][a-z0-9-]{2,39}$，小写字母/数字/连字符，3-40 字符）`);
  } else if (existingIds.has(id)) {
    errors.push(`插件 ID 已存在：${id}`);
  }

  // ② 入口文件存在
  const main = manifest.main || 'index.js';
  const mainPath = path.join(dir, main);
  if (!fs.existsSync(mainPath) || !fs.statSync(mainPath).isFile()) {
    errors.push(`入口文件缺失：${main}`);
  }

  // ③ 宿主最低版本
  const minVersion = manifest.host && manifest.host.minVersion;
  if (minVersion && compareVersion(bridge.HOST_VERSION, minVersion) < 0) {
    errors.push(`插件需要更新版本的主程序：要求 ≥ ${minVersion}，当前 ${bridge.HOST_VERSION}`);
  }

  // ④ 依赖白名单
  const deps = manifest.dependencies || {};
  for (const dep of Object.keys(deps)) {
    if (!DEPENDENCY_WHITELIST.has(dep)) {
      errors.push(`插件声明了未允许的依赖：${dep}（本项目禁止新增 npm 包）`);
    }
  }

  // ④-1 可选依赖白名单（v1.1）
  const optionalDeps = manifest.optionalDependencies || {};
  if (optionalDeps && typeof optionalDeps === 'object') {
    for (const dep of Object.keys(optionalDeps)) {
      if (!OPTIONAL_WHITELIST.has(dep)) {
        errors.push(`插件声明了未允许的可选依赖：${dep}（可选依赖白名单见 src/host-api/contract.js）`);
      }
    }
  }

  // ⑤ permissions 枚举（含已移除权限的明确提示）
  const perms = manifest.permissions || [];
  if (!Array.isArray(perms)) {
    errors.push('permissions 必须是数组');
  } else {
    for (const p of perms) {
      if (Object.prototype.hasOwnProperty.call(contract.REMOVED_PERMISSIONS, p)) {
        errors.push(`声明了已移除的权限：${p}（${contract.REMOVED_PERMISSIONS[p]}）`);
      } else if (!PERMISSION_ENUM.has(p)) {
        errors.push(`声明了未知权限：${p}`);
      }
    }
  }

  // ⑤-1 宿主 API 契约版本（§3.3）
  const apiCheck = contract.validateHostApi(manifest.hostApi);
  if (!apiCheck.ok) errors.push(apiCheck.error);

  // ⑤-2 services.injects ↔ permissions 一致性（修 C18）
  if (Array.isArray(perms)) {
    const injectCheck = contract.validateInjects(
      (manifest.services && manifest.services.injects) || [],
      perms,
    );
    if (!injectCheck.ok) errors.push(...injectCheck.errors);
  }

  // ⑤-3 contributes.capabilities ↔ event-registry 一致性（§3.4）
  const caps = (manifest.contributes && manifest.contributes.capabilities) || [];
  if (caps.length && !Array.isArray(caps)) {
    errors.push('contributes.capabilities 必须是数组');
  } else {
    for (const cap of caps) {
      const capCheck = eventRegistry.validateCapability(cap);
      if (!capCheck.ok) errors.push(...capCheck.errors);
    }
  }

  // ⑤-4 装载期边界检查（§3.5：插件不得 require 到核心内部 / 不得直接用 cordis / host.app）
  const boundaryCheck = boundary.checkPluginDir(dir);
  if (!boundaryCheck.ok) {
    for (const v of boundaryCheck.violations.slice(0, 5)) {
      errors.push(`越界依赖（${v.rule}）：${v.file}:${v.line} ${v.detail}`);
    }
    if (boundaryCheck.violations.length > 5) {
      errors.push(`另有 ${boundaryCheck.violations.length - 5} 处越界依赖未列出`);
    }
  }

  // ⑥ 体积 ≤ 50MB
  const size = dirSize(dir);
  if (size > MAX_PACKAGE_BYTES) {
    errors.push(`插件包过大：${(size / 1024 / 1024).toFixed(1)}MB（上限 50MB）`);
  }

  // ⑦ 静态风险扫描（软警告，不进 errors）
  const risks = staticScan(dir);

  return { ok: errors.length === 0, errors, risks, size };
}

// ─── 扫描 ───

/**
 * 扫描 plugins/ 目录，建立插件清单。
 * @returns {{plugins: Array<object>, invalid: Array<object>}}
 */
function scanPlugins() {
  _metas.clear();
  _invalid.clear();
  const state = loadState();
  if (!fs.existsSync(PLUGINS_DIR)) {
    ensureDir(PLUGINS_DIR);
    return { plugins: [], invalid: [] };
  }
  const dirs = fs.readdirSync(PLUGINS_DIR).filter((name) => {
    try { return fs.statSync(path.join(PLUGINS_DIR, name)).isDirectory(); } catch { return false; }
  });

  // 先收集含 manifest 的目录
  const candidates = [];
  for (const name of dirs) {
    const dir = path.join(PLUGINS_DIR, name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue; // 无 manifest → 普通目录，跳过不报错
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      _invalid.set(name, { id: name, dir, error: `manifest.json 解析失败：${err.message}` });
      logError('plugin-scanner', `插件 ${name} 的 manifest.json 解析失败: ${err.message}`);
      continue;
    }
    candidates.push({ dir, manifest });
  }

  const ids = new Set(candidates.map((c) => c.manifest.id).filter(Boolean));
  for (const { dir, manifest } of candidates) {
    // 冲突检测要排除自己，否则会把自身的 id 误判为「已存在」
    const others = new Set(ids);
    others.delete(manifest.id);
    const result = validateManifest(manifest, dir, others);
    if (!result.ok) {
      _invalid.set(manifest.id || path.basename(dir), {
        id: manifest.id || path.basename(dir),
        dir,
        name: manifest.name || manifest.id,
        error: result.errors.join('；'),
        errors: result.errors,
      });
      logError('plugin-scanner', `插件 ${manifest.id || path.basename(dir)} 校验失败: ${result.errors.join('；')}`);
      continue;
    }
    const id = manifest.id;
    const saved = state[id] || {};
    // 可选依赖探测：缺失只标记，不阻断扫描（装载时再决定 missing-deps）
    const probe = probeOptionalDeps(manifest);
    const flowRole = classifyPlugin(manifest);
    // 内置插件默认启用（保持与 v1.0.0「启动即加载 wd14」的行为一致）；
    //   但声明 defaultEnabled:false 的内置插件（如 batch-image-suite）保持关闭，
    //   避免未经用户确认就接管现有 /api/batch/* 行为（平滑迁移原则）。
    const defaultEnabled = ((manifest.source && manifest.source.type === 'builtin') || !manifest.source)
      && manifest.defaultEnabled !== false;
    _metas.set(id, {
      id,
      dir,
      name: manifest.name || id,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      author: manifest.author || '',
      main: manifest.main || 'index.js',
      manifest,
      provides: (manifest.services && manifest.services.provides) || [],
      injects: (manifest.services && manifest.services.injects) || [],
      permissions: manifest.permissions || [],
      hostApi: manifest.hostApi || contract.HOST_API_VERSION,
      capabilities: capabilitiesOf(manifest),
      optionalDependencies: manifest.optionalDependencies || {},
      missingDeps: probe.ok ? [] : probe.missing,
      installHint: probe.installHint || '',
      flowRole,
      source: saved.source || manifest.source || { type: 'builtin' },
      enabled: saved.enabled === undefined ? defaultEnabled : saved.enabled === true,
      status: 'installed',
      error: null,
      risks: result.risks || [],
      size: result.size || 0,
      installedAt: saved.installedAt || new Date().toISOString(),
      updatedAt: saved.updatedAt || null,
    });
  }
  // 记录内置插件的默认状态
  const state2 = loadState();
  let dirty = false;
  for (const meta of _metas.values()) {
    if (!state2[meta.id]) {
      state2[meta.id] = {
        source: meta.source,
        enabled: meta.enabled,
        installedAt: meta.installedAt,
        updatedAt: meta.updatedAt,
        version: meta.version,
      };
      dirty = true;
    }
  }
  if (dirty) saveState(state2);

  logInfo('plugin-scanner', `插件扫描完成：${_metas.size} 个有效，${_invalid.size} 个非法`);
  return { plugins: [..._metas.values()], invalid: [..._invalid.values()] };
}

/** 取插件元数据 */
function getMeta(id) {
  return _metas.get(id) || null;
}

/** 列出全部插件元数据 */
function listMetas() {
  return [..._metas.values()];
}

/** 列出非法插件 */
function listInvalid() {
  return [..._invalid.values()];
}

// ─── 插件定义加载（支持清 require 缓存以热重载） ───

/**
 * 加载插件入口模块（可清缓存）。
 * @param {string} id 插件 id
 * @param {boolean} [clearCache=false] 是否先清 require 缓存
 * @returns {Function|object} 插件定义
 */
function loadDef(id, clearCache = false) {
  const meta = _metas.get(id);
  if (!meta) throw new Error(`插件 ${id} 不存在`);
  const entry = path.join(meta.dir, meta.main);
  if (clearCache) {
    // 清该插件目录下所有已缓存模块，保证代码改动生效
    const prefix = path.resolve(meta.dir);
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(prefix + path.sep) || key === prefix) delete require.cache[key];
    }
  }
  let def = require(entry);
  // ESM interop：{ default: fn }
  if (def && typeof def === 'object' && typeof def.default === 'function') def = def.default;
  return def;
}

// ─── 生命周期 ───

/**
 * 把插件节点/终裁器注册进 flow/registry（注册表维护 owner → ref 映射，便于禁用时摘除）。
 * @param {object} meta 插件元数据
 * @returns {{nodes: Array<object>, finalizers: Array<object>, role: string}} 注册内容
 */
function registerPluginNodes(meta) {
  flowRegistry.unregisterOwner(meta.id);
  const built = buildPluginNodes(meta);
  if (built.nodes.length > 0) flowRegistry.registerPluginNodes(meta.id, built.nodes, built.finalizers);
  else if (built.finalizers.length > 0) flowRegistry.registerPluginNodes(meta.id, [], built.finalizers);
  return built;
}

/**
 * 依据 manifest 节点声明的 `readinessRpc` 异步探测插件就绪度，并写入 flow/registry。
 *
 * 目的（架构 §8.2）：把「已装载但未配置」的插件节点从 `failed`（fail-closed，整段拦截）
 * 纠正为 `skipped`（合法降级），避免未配 AccessKey 就把整条链路拦死。
 * 探测失败时**保持默认就绪**，不影响装载与主链路。
 *
 * @param {object} meta 插件元数据
 * @param {{nodes: Array<object>, finalizers: Array<object>}} [built] 已注册内容
 * @returns {Promise<boolean>} 是否成功写入探测值
 */
async function refreshPluginReadiness(meta, built) {
  const declared = (meta.manifest && meta.manifest.contributes && meta.manifest.contributes.nodes) || [];
  const rpc = declared.map((n) => n && n.readinessRpc).find(Boolean);
  if (!rpc) return false;

  const refs = [];
  if (built) {
    for (const n of built.nodes || []) if (n && n.ref) refs.push(n.ref);
    for (const f of built.finalizers || []) if (f && f.ref) refs.push(f.ref);
  }
  if (refs.length === 0) return false;

  try {
    const host = require('./plugin-host');
    const res = await host.dispatchRpc(meta.id, rpc, {});
    if (!res || res.ok !== true || !res.result || typeof res.result !== 'object') return false;
    const payload = res.result;
    const topLevel = {
      ready: payload.ready === true,
      reason: payload.notReadyReason || '',
      installHint: payload.installHint || '',
    };
    // 逐节点优先：插件可返回 nodes:[{ref, modality, ready, notReadyReason?, installHint?}]，
    //   用于「同一插件不同模态就绪度不同」（如 aliyun 文本开/图片关）——按 ref 查一次，
    //   查不到再回落到顶层值。这样「模态被关闭」的节点才能正确走 skipped 而非 failed。
    const perNode = new Map();
    for (const entry of Array.isArray(payload.nodes) ? payload.nodes : []) {
      if (entry && entry.ref) {
        const notReady = entry.ready !== true;
        perNode.set(entry.ref, {
          ready: entry.ready === true,
          reason: entry.notReadyReason !== undefined
            ? entry.notReadyReason
            : (notReady ? (topLevel.reason || 'not-ready') : ''),
          installHint: entry.installHint !== undefined ? entry.installHint : topLevel.installHint,
        });
      }
    }
    for (const ref of refs) flowRegistry.setReadiness(ref, perNode.get(ref) || topLevel);
    return true;
  } catch (err) {
    logInfo('plugin-scanner', `插件 ${meta.id} 就绪度探测跳过（${err && err.message}）`);
    return false;
  }
}

/**
 * 刷新全部已启用插件的就绪度（供 /api/flow/capabilities 拉取前调用）。
 * @returns {Promise<number>} 成功刷新的插件数
 */
async function refreshAllReadiness() {
  let count = 0;
  for (const meta of _metas.values()) {
    if (meta.status !== 'active') continue;
    const built = {
      nodes: (meta.nodeRefs || []).filter((r) => !r.includes('.linkage')).map((r) => ({ ref: r })),
      finalizers: (meta.nodeRefs || []).filter((r) => r.includes('.linkage')).map((r) => ({ ref: r })),
    };
    // eslint-disable-next-line no-await-in-loop
    if (await refreshPluginReadiness(meta, built)) count += 1;
  }
  return count;
}

/**
 * 启用插件：探测可选依赖 → 清缓存 → 装载 → 注册能力与拓扑节点。
 * 可选依赖缺失时进入 `missing-deps`，不抛异常、不注册能力、不装载（架构 §8.2）。
 * @param {string} id 插件 id
 * @returns {Promise<{ok: boolean, status: string, error?: string, missing?: string[], installHint?: string}>}
 */
async function enable(id) {
  const meta = _metas.get(id);
  if (!meta) return { ok: false, status: 'error', error: `插件 ${id} 不存在` };

  // v1.1：可选依赖探测（缺失 → missing-deps，核心与其它插件完全不受影响）
  const probe = probeOptionalDeps(meta.manifest || {});
  if (!probe.ok) {
    meta.status = 'missing-deps';
    meta.missingDeps = probe.missing;
    meta.installHint = probe.installHint || meta.installHint || '';
    meta.error = `缺少可选依赖：${probe.missing.join('、')}`;
    logInfo('plugin-scanner', `插件 ${id} 可选依赖缺失，已跳过装载（${meta.error}；安装：${meta.installHint || 'n/a'}）`);
    return { ok: false, status: 'missing-deps', missing: probe.missing, installHint: meta.installHint };
  }

  try {
    meta.status = 'loading';
    const def = loadDef(id, true);
    const res = await bridge.loadPlugin(id, def, {
      permissions: meta.permissions,
      manifest: meta.manifest,
    });
    if (!res.ok) {
      meta.status = 'error';
      meta.error = res.error || '装载失败';
      patchState(id, { enabled: false });
      return res;
    }
    meta.status = 'active';
    meta.error = null;
    // 注册 manifest 声明的 UI 贡献点
    const contributes = (meta.manifest && meta.manifest.contributes) || {};
    const views = contributes.views || [];
    // v0.2.0：把 contributes.ui（配置面板归位声明）一并交给 UI 注册表。
    //   即使没有业务视图也要登记，否则 ui.panel 会被静默忽略（wd14-tagger 就是 views: []）。
    const host = require('./plugin-host');
    host.registerViews(id, views, contributes.ui || null);
    // 注册 manifest 声明的能力（核心只能通过 capability-broker 查询「有无提供者」）
    const capRes = broker.registerAll(id, meta.capabilities || capabilitiesOf(meta.manifest));
    if (!capRes.ok) {
      meta.status = 'error';
      meta.error = `能力注册失败：${capRes.errors.join('；')}`;
      logError('plugin-scanner', `插件 ${id} 能力注册失败: ${capRes.errors.join('；')}`);
    }
    // v1.1：注册拓扑节点/终裁器描述符（task 型插件在此被排除，杜绝幽灵节点）
    const nodeReg = registerPluginNodes(meta);
    meta.nodeRefs = nodeReg.nodes.map((n) => n.ref).concat(nodeReg.finalizers.map((f) => f.ref));
    // v2.2.0：按 manifest.readinessRpc 探测就绪度 → 未就绪节点走 skipped 而非 failed
    await refreshPluginReadiness(meta, nodeReg);
    if (nodeReg.role === 'task') {
      logInfo('plugin-scanner', `插件 ${id} 判定为 task 型，已从画布节点面板排除`);
    }
    patchState(id, { enabled: true, version: meta.version });
    logInfo('plugin-scanner', `插件已启用: ${id}`);
    return { ok: true, status: 'loaded' };
  } catch (err) {
    meta.status = 'error';
    meta.error = err.message;
    logError('plugin-scanner', `插件 ${id} 启用失败: ${err.message}`);
    return { ok: false, status: 'error', error: err.message };
  }
}

/**
 * 禁用插件：卸载 cordis fiber + 摘除 RPC/视图。
 * @param {string} id 插件 id
 * @returns {Promise<{ok: boolean, status: string}>}
 */
async function disable(id) {
  const meta = _metas.get(id);
  const res = await bridge.unloadPlugin(id);
  // 摘除能力提供者：核心从此查不到该能力，等同于「无插件」
  broker.unregisterPlugin(id);
  // v1.1：摘除拓扑节点/终裁器描述符
  flowRegistry.unregisterOwner(id);
  if (meta) {
    meta.status = 'installed';
    meta.error = null;
    meta.nodeRefs = [];
  }
  patchState(id, { enabled: false });
  logInfo('plugin-scanner', `插件已禁用: ${id}`);
  return res;
}

/**
 * 重载插件（清 require 缓存后重新装载）。
 * @param {string} id 插件 id
 * @returns {Promise<{ok: boolean, status: string, error?: string}>}
 */
async function reload(id) {
  await disable(id);
  return enable(id);
}

/**
 * 卸载插件：dispose → 移入 data/plugins-trash/<id>-<ts>/（不直接删）。
 * @param {string} id 插件 id
 * @returns {Promise<{ok: boolean, trash?: string, error?: string}>}
 */
async function uninstall(id) {
  const meta = _metas.get(id);
  if (!meta) return { ok: false, error: `插件 ${id} 不存在` };
  if (meta.source && meta.source.type === 'builtin') {
    return { ok: false, error: '内置插件不可卸载（可禁用）' };
  }
  await disable(id);
  try {
    ensureDir(TRASH_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(TRASH_DIR, `${id}-${ts}`);
    fs.renameSync(meta.dir, target);
    broker.unregisterPlugin(id);
    flowRegistry.unregisterOwner(id);
    _metas.delete(id);
    const state = loadState();
    delete state[id];
    saveState(state);
    logInfo('plugin-scanner', `插件 ${id} 已卸载，回收目录: ${target}`);
    return { ok: true, trash: target };
  } catch (err) {
    logError('plugin-scanner', `插件 ${id} 卸载失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** 清理超过 7 天的回收目录 */
function cleanTrash() {
  if (!fs.existsSync(TRASH_DIR)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const name of fs.readdirSync(TRASH_DIR)) {
    const full = path.join(TRASH_DIR, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > TRASH_KEEP_DAYS * 24 * 3600 * 1000) {
        rmDir(full);
        removed++;
      }
    } catch { /* 忽略 */ }
  }
  return removed;
}

// ─── 导入 ───

/**
 * 本地文件夹导入（复制，源目录不变）。
 * @param {string} srcPath 源目录
 * @returns {{ok: boolean, id?: string, error?: string, risks?: Array<object>}}
 */
function importLocal(srcPath) {
  if (!srcPath || typeof srcPath !== 'string') return { ok: false, error: '缺少路径' };
  const abs = path.resolve(srcPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { ok: false, error: '目录不存在' };
  const manifestPath = path.join(abs, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, error: '该目录下没有 manifest.json' };

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { ok: false, error: `manifest.json 解析失败：${err.message}` };
  }

  const check = validateManifest(manifest, abs, new Set(_metas.keys()));
  if (!check.ok) return { ok: false, error: check.errors.join('；') };

  const id = manifest.id;
  const dest = path.join(PLUGINS_DIR, id);
  if (fs.existsSync(dest)) return { ok: false, error: `插件 ${id} 已存在` };
  try {
    ensureDir(PLUGINS_DIR);
    copyDir(abs, dest); // 复制而非移动，源目录保持不变
  } catch (err) {
    return { ok: false, error: `复制失败：${err.message}` };
  }
  _metas.set(id, buildMeta(id, dest, manifest, { type: 'local', path: abs }, staticScan(dest)));
  patchState(id, { source: { type: 'local', path: abs }, enabled: false, version: manifest.version, installedAt: new Date().toISOString() });
  logInfo('plugin-scanner', `本地导入插件成功: ${id}（源目录保持不变: ${abs}）`);
  return { ok: true, id, risks: staticScan(dest) };
}

/** 构造 PluginMeta */
function buildMeta(id, dir, manifest, source, risks = []) {
  return {
    id,
    dir,
    name: manifest.name || id,
    version: manifest.version || '0.0.0',
    description: manifest.description || '',
    author: manifest.author || '',
    main: manifest.main || 'index.js',
    manifest,
    provides: (manifest.services && manifest.services.provides) || [],
    injects: (manifest.services && manifest.services.injects) || [],
    permissions: manifest.permissions || [],
    hostApi: manifest.hostApi || contract.HOST_API_VERSION,
    capabilities: capabilitiesOf(manifest),
    source,
    enabled: false,
    status: 'installed',
    error: null,
    risks,
    size: dirSize(dir),
    installedAt: new Date().toISOString(),
    updatedAt: null,
  };
}

// ─── ZIP 解析（Node 内置 zlib + 手工 central directory，零新增依赖） ───

/**
 * 解析 ZIP 的 central directory，返回条目列表。
 * @param {Buffer} buf 文件缓冲
 * @returns {Array<{name: string, method: number, compressedSize: number, uncompressedSize: number, offset: number}>}
 */
function parseZipCentralDirectory(buf) {
  // 从尾部向前找 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD）');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf-8');
    entries.push({ name, method, compressedSize, uncompressedSize, offset: localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 解压 ZIP 到目标目录（自动剥离单层根目录）。
 * @param {string} zipPath ZIP 文件路径
 * @param {string} destDir 解压目标目录
 * @returns {{files: number, bytes: number}}
 */
function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const entries = parseZipCentralDirectory(buf);
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    const name = e.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    // 定位 local file header
    if (buf.readUInt32LE(e.offset) !== 0x04034b50) continue;
    const localNameLen = buf.readUInt16LE(e.offset + 26);
    const localExtraLen = buf.readUInt16LE(e.offset + 28);
    const dataStart = e.offset + 30 + localNameLen + localExtraLen;
    const raw = buf.slice(dataStart, dataStart + e.compressedSize);
    let content = null;
    if (e.method === 0) content = raw;
    else if (e.method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式: ${e.method}`);
    if (bytes + content.length > MAX_PACKAGE_BYTES) throw new Error('插件包过大（解压后超过 50MB）');
    bytes += content.length;
    const target = path.join(destDir, name);
    if (!path.resolve(target).startsWith(path.resolve(destDir) + path.sep)) {
      throw new Error(`ZIP 内包含越权路径: ${name}`);
    }
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, content);
    files++;
  }
  return { files, bytes };
}

/**
 * ZIP 导入（multipart 上传后的临时文件）。
 * @param {string} zipPath ZIP 临时路径
 * @returns {{ok: boolean, id?: string, error?: string, risks?: Array<object>}}
 */
function importZip(zipPath) {
  if (!fs.existsSync(zipPath)) return { ok: false, error: 'ZIP 文件不存在' };
  if (fs.statSync(zipPath).size > MAX_PACKAGE_BYTES) return { ok: false, error: '插件包过大（上限 50MB）' };
  ensureDir(TMP_DIR);
  const tmpDir = path.join(TMP_DIR, `zip-${Date.now()}`);
  let extracted = tmpDir;
  try {
    extractZip(zipPath, tmpDir);
    // 单层根目录自动剥壳
    const inner = fs.readdirSync(tmpDir);
    if (inner.length === 1) {
      const only = path.join(tmpDir, inner[0]);
      if (fs.statSync(only).isDirectory() && fs.existsSync(path.join(only, 'manifest.json'))) {
        extracted = only;
      }
    }
    return importLocal(extracted);
  } catch (err) {
    return { ok: false, error: `ZIP 导入失败：${err.message}` };
  } finally {
    try { rmDir(tmpDir); } catch { /* 忽略清理失败 */ }
  }
}

// ─── Git 导入（child_process.execFile，零新增依赖） ───

/** promisify 版 execFile */
function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, ...options }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr ? String(stderr).trim() : err.message);
        e.code = err.code;
        reject(e);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

/**
 * 检测 git 是否可用。
 * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
 */
async function checkGit() {
  try {
    const out = await execFileAsync('git', ['--version']);
    return { ok: true, version: out };
  } catch (err) {
    return { ok: false, error: '未检测到 git，请安装后重试' };
  }
}

/**
 * Git 导入：git clone --depth 1。
 * @param {string} url 仓库地址
 * @param {string} [ref] 分支/标签
 * @param {string} [subdir] 子目录
 * @returns {Promise<{ok: boolean, id?: string, error?: string, commitHash?: string}>}
 */
async function importGit(url, ref = '', subdir = '') {
  const git = await checkGit();
  if (!git.ok) return { ok: false, error: git.error };
  if (!url || typeof url !== 'string') return { ok: false, error: '缺少仓库地址' };
  ensureDir(TMP_DIR);
  const tmpDir = path.join(TMP_DIR, `git-${Date.now()}`);
  try {
    const args = ['clone', '--depth', '1'];
    if (ref) args.push('--branch', ref);
    args.push(url, tmpDir);
    await execFileAsync('git', args);
    let commitHash = '';
    try { commitHash = await execFileAsync('git', ['-C', tmpDir, 'rev-parse', 'HEAD']); } catch { /* 忽略 */ }
    const srcDir = subdir ? path.join(tmpDir, subdir) : tmpDir;
    const res = importLocal(srcDir);
    if (!res.ok) return res;
    patchState(res.id, { source: { type: 'git', url, ref: ref || '', subdir: subdir || '', commitHash } });
    const meta = _metas.get(res.id);
    if (meta) meta.source = { type: 'git', url, ref: ref || '', subdir: subdir || '', commitHash };
    return { ok: true, id: res.id, commitHash };
  } catch (err) {
    return { ok: false, error: `Git 导入失败：${err.message}` };
  } finally {
    try { rmDir(tmpDir); } catch { /* 忽略 */ }
  }
}

/**
 * Git 更新：git pull --ff-only。
 * @param {string} id 插件 id
 * @returns {Promise<{ok: boolean, message?: string, error?: string}>}
 */
async function update(id) {
  const meta = _metas.get(id);
  if (!meta) return { ok: false, error: `插件 ${id} 不存在` };
  if (!meta.source || meta.source.type !== 'git') return { ok: false, error: '仅 git 来源的插件支持更新' };
  const git = await checkGit();
  if (!git.ok) return { ok: false, error: git.error };
  try {
    const before = await execFileAsync('git', ['-C', meta.dir, 'rev-parse', 'HEAD']);
    await execFileAsync('git', ['-C', meta.dir, 'pull', '--ff-only']);
    const after = await execFileAsync('git', ['-C', meta.dir, 'rev-parse', 'HEAD']);
    let changed = 0;
    try {
      const log = await execFileAsync('git', ['-C', meta.dir, 'rev-list', `${before}..${after}`, '--count']);
      changed = parseInt(log, 10) || 0;
    } catch { /* 忽略 */ }
    patchState(id, { updatedAt: new Date().toISOString(), source: { ...meta.source, commitHash: after } });
    meta.source = { ...meta.source, commitHash: after };
    // 正在运行则热重载
    if (meta.status === 'active') await reload(id);
    return { ok: true, message: changed > 0 ? `已更新 ${changed} 个提交` : '已是最新', commitHash: after };
  } catch (err) {
    return { ok: false, error: `更新失败（可能不是快进更新，请手动处理）：${err.message}` };
  }
}

// ─── 汇总列表（供 /api/plugins） ───

/**
 * 汇总插件列表（元数据 + 运行状态 + 配置 schema）。
 * @returns {Array<object>}
 */
function describe() {
  const config = require('./plugin-config');
  const out = [];
  for (const meta of _metas.values()) {
    const entry = bridge.getPlugin(meta.id);
    let status = 'disabled';
    if (meta.status === 'missing-deps') status = 'missing-deps';
    else if (meta.status === 'error') status = 'error';
    else if (entry && (entry.status === 'loaded' || entry.status === 'loading')) status = 'loaded';
    out.push({
      id: meta.id,
      name: meta.name,
      version: meta.version,
      description: meta.description,
      author: meta.author,
      status,
      error: meta.error || (entry && entry.error) || null,
      source: meta.source,
      permissions: meta.permissions,
      provides: meta.provides,
      injects: meta.injects,
      // v1.1：可选依赖就绪度（UI 置灰 + 安装指引）
      optionalDependencies: meta.optionalDependencies || {},
      missingDeps: meta.missingDeps || [],
      installHint: meta.installHint || '',
      flowRole: meta.flowRole || classifyPlugin(meta.manifest || {}),
      nodeRefs: meta.nodeRefs || [],
      risks: meta.risks || [],
      installedAt: meta.installedAt,
      updatedAt: meta.updatedAt,
      configSchema: config.getSchema(meta.id),
    });
  }
  for (const bad of _invalid.values()) {
    out.push({
      id: bad.id,
      name: bad.name || bad.id,
      version: '0.0.0',
      description: '',
      status: 'invalid',
      error: bad.error,
      source: { type: 'local' },
      permissions: [],
      provides: [],
      injects: [],
      risks: [],
      installedAt: null,
      updatedAt: null,
      configSchema: null,
    });
  }
  return out;
}

module.exports = {
  PLUGINS_DIR,
  STATE_FILE,
  TRASH_DIR,
  ID_RE,
  DEPENDENCY_WHITELIST,
  PERMISSION_ENUM,
  scanPlugins,
  getMeta,
  listMetas,
  listInvalid,
  validateManifest,
  staticScan,
  loadDef,
  enable,
  disable,
  reload,
  uninstall,
  cleanTrash,
  importLocal,
  importZip,
  extractZip,
  importGit,
  checkGit,
  update,
  describe,
  loadState,
  saveState,
  patchState,
  getState,
  compareVersion,
  canResolve,
  probeOptionalDeps,
  buildInstallHint,
  classifyPlugin,
  buildPluginNodes,
  registerPluginNodes,
  refreshPluginReadiness,
  refreshAllReadiness,
};
