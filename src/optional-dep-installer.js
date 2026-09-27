/**
 * 可选依赖自动安装器（src/optional-dep-installer.js）
 * v2.3.0 新增（Req2）：让「可选依赖插件」（如 nsfwjs-image-guard）在依赖缺失时
 * 能由宿主**代为安装**依赖，而不是只给一条复制用的 installHint。
 * ══ 红线（必须同时满足，否则本模块一律拒绝执行）══
 * 1. **绝不修改主工程 package.json**：安装一律带 `--no-save --no-package-lock`，
 * 可选依赖永远不进 dependencies / optionalDependencies / devDependencies。
 * （这是「0 依赖、可解耦运行」红线的核心：删掉 node_modules 后主工程照常启动。）
 * 2. **白名单**：只允许安装 contract.OPTIONAL_DEPENDENCIES 里的包名。
 * manifest 里出现白名单外的包 → 整次安装直接拒绝（不做「部分安装」）。
 * 3. **来源限定**：只服务 plugins/ 目录下的内置插件（source.type === 'builtin'
 * 或目录位于 PROJECT_ROOT/plugins 下）；不接受任意路径。
 * 4. **串行化**：同一插件同时只允许一次安装（Map 锁），避免 node_modules 写冲突。
 * 5. **失败不影响核心**：任何异常都被捕获并转为 {ok:false}，安装失败只是插件继续
 * 保持 missing-deps，核心与其它插件完全不受影响。
 * ═ 为什么不禁用 install scripts ══
 * @tensorflow/tfjs-node 的 postinstall 需要下载预编译原生库，禁用后装上也用不了。
 * 因此**不加 --ignore-scripts**。代价是 npm 安装脚本可执行任意代码 —— 所以白名单
 * 校验（第 2 条）是这里唯一的安全边界，绝不能被绕过。
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const contract = require('./host-api/contract');
const { logInfo, logError, logWarn } = require('./logger');

/** 工程根目录（安装目标：往这里的 node_modules 装）*/
const PROJECT_ROOT = path.join(__dirname, '..');

/** 以工程根为基准的解析器（与 plugin-scanner.canResolve 同口径）*/
const projectRequire = createRequire(path.join(PROJECT_ROOT, 'package.json'));

/** 允许自动安装的包名集合（唯一安全边界）*/
const ALLOWED = contract.OPTIONAL_DEPENDENCY_SET;

/** nsfwjs 的特殊约束：需要至少一个 TF.js 后端（与 contract.OPTIONAL_DEPENDENCY_ANY_OF 同源）*/
const ANY_OF = contract.OPTIONAL_DEPENDENCY_ANY_OF || {};

/** 安装超时（tfjs-node 首次下载原生库可能很慢）*/
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** 单次返回给前端的日志上限（行）*/
const MAX_LOG_LINES = 120;

/** 同一插件的进行中安装（并发锁：pluginId → Promise）*/
const _running = new Map();

/** 最近一次安装结果（pluginId → result，供 UI 轮询/回显）*/
const _lastResult = new Map();

/**
 * 包是否可被 Node 解析到（不加载，只解析）。
 * @param {string} pkg 包名
 * @returns {boolean}
 */
function canResolve(pkg) {
  try {
    projectRequire.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

/**
 * 计算某插件「需要安装哪些包」。
 * 规则：
 * · manifest.optionalDependencies 中**不在白名单**的包 → 记录到 rejected，并整体拒绝。
 * · 缺失的必需包（当前解析不到）→ 加入 targets。
 * · nsfwjs 已存在但没有任何 TF 后端 → 补装 manifest 声明的那个后端（缺省 tfjs-node）。
 * @param {object} manifest 插件清单
 * @returns {{
 * ok: boolean, reason?: string,
 * declared: string[], rejected: string[], targets: string[],
 * alreadyOk: string[], command: string, cwd: string
 * }}
 */
function planInstall(manifest) {
  const declaredMap = (manifest && manifest.optionalDependencies) || {};
  const declared = Object.keys(declaredMap);

  const rejected = declared.filter((p) => !ALLOWED.has(p));
  const command0 = 'npm install --no-save --no-package-lock';

  if (declared.length === 0) {
    return {
      ok: false,
      reason: '该插件未声明任何 optionalDependencies，无需安装',
      declared, rejected: [], targets: [], alreadyOk: [],
      command: command0, cwd: PROJECT_ROOT,
    };
  }

  if (rejected.length > 0) {
    return {
      ok: false,
      reason: `插件声明了白名单外的可选依赖，已拒绝安装：${rejected.join('、')}（白名单见 src/host-api/contract.js）`,
      declared, rejected, targets: [], alreadyOk: [],
      command: command0, cwd: PROJECT_ROOT,
    };
  }

  const targets = [];
  const alreadyOk = [];
  for (const pkg of declared) {
    if (canResolve(pkg)) alreadyOk.push(pkg);
    else targets.push(pkg);
  }

  // nsfwjs 的「二选一后端」约束：nsfwjs 在、后端全无 → 补一个后端
  for (const [pkg, candidates] of Object.entries(ANY_OF)) {
    if (!Object.prototype.hasOwnProperty.call(declaredMap, pkg)) continue;
    if (!canResolve(pkg)) continue; // nsfwjs 本身缺失时 targets 里已含它
    const hasAny = candidates.some((c) => canResolve(c));
    if (!hasAny) {
      // 优先 manifest 里显式声明过的后端，否则取候选第一位
      const preferred = candidates.find((c) => Object.prototype.hasOwnProperty.call(declaredMap, c)) || candidates[0];
      if (ALLOWED.has(preferred) && !targets.includes(preferred)) targets.push(preferred);
    }
  }

  if (targets.length === 0) {
    return {
      ok: false,
      reason: '可选依赖已齐备，无需安装',
      declared, rejected: [], targets: [], alreadyOk,
      command: command0, cwd: PROJECT_ROOT,
    };
  }

  return {
    ok: true,
    declared, rejected: [], targets, alreadyOk,
    command: `${command0} ${targets.join(' ')}`,
    cwd: PROJECT_ROOT,
  };
}

/**
 * 解析 npm 可执行文件与参数（Windows 需要 shell 才能跑 .cmd）。
 * @returns {{file: string, args: string[], useShell: boolean}}
 */
function resolveNpm(targets) {
  const args = ['install', '--no-save', '--no-package-lock', '--loglevel=info', ...targets];
  if (process.platform === 'win32') {
    // Windows 上 npm 是 npm.cmd，Node 无法在 shell:false 下直接执行 .cmd。
    // 包名已被白名单校验，不存在注入面；这里用 shell 只为找到 npm.cmd。
    return { file: 'npm.cmd', args, useShell: true };
  }
  return { file: 'npm', args, useShell: false };
}

/**
 * 执行安装（内部函数，调用方需已加锁）。
 * @param {string} pluginId 插件 id（仅用于日志与锁）
 * @param {string[]} targets 要安装的包名（已被白名单校验）
 * @param {(line: string) => void} [onLine] 逐行日志回调
 * @returns {Promise<object>} 安装结果
 */
function runInstall(pluginId, targets, onLine) {
  const { file, args, useShell } = resolveNpm(targets);
  const startedAt = Date.now();
  const lines = [];

  logInfo('dep-installer', `开始为插件 ${pluginId} 安装可选依赖：${targets.join(' ')}（--no-save，不写 package.json）`);

  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(file, args, {
        cwd: PROJECT_ROOT,
        shell: useShell,
        windowsHide: true,
        env: { ...process.env, npm_config_yes: 'true' },
      });
    } catch (err) {
      const result = {
        ok: false, pluginId, targets,
        error: `无法启动 npm：${err.message}`,
        elapsedMs: Date.now() - startedAt, lines,
      };
      logError('dep-installer', result.error);
      return resolve(result);
    }

    const push = (raw) => {
      const text = String(raw || '').replace(/\r/g, '');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (lines.length < MAX_LOG_LINES) lines.push(t);
        if (typeof onLine === 'function') { try { onLine(t); } catch { /* 回调异常不影响安装*/ } }
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 忽略*/ }
      const result = {
        ok: false, pluginId, targets,
        error: `安装超时（>${Math.round(INSTALL_TIMEOUT_MS / 1000)}s），已终止 npm 进程`,
        elapsedMs: Date.now() - startedAt, lines,
      };
      logError('dep-installer', result.error);
      resolve(result);
    }, INSTALL_TIMEOUT_MS);

    if (child.stdout) child.stdout.on('data', push);
    if (child.stderr) child.stderr.on('data', push);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        ok: false, pluginId, targets,
        error: `npm 进程错误：${err.message}`,
        elapsedMs: Date.now() - startedAt, lines,
      };
      logError('dep-installer', result.error);
      resolve(result);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // 装完再复核一次解析结果，避免「npm 退出码 0 但其实没装上」的假成功
      const stillMissing = targets.filter((p) => !canResolve(p));
      const ok = code === 0 && stillMissing.length === 0;
      const result = {
        ok, pluginId, targets,
        exitCode: code,
        stillMissing,
        error: ok ? undefined
          : (code !== 0
            ? `npm 退出码 ${code}（详见日志）`
            : `npm 报告成功但以下包仍无法解析：${stillMissing.join('、')}`),
        elapsedMs: Date.now() - startedAt,
        lines,
      };
      if (ok) logInfo('dep-installer', `插件 ${pluginId} 可选依赖安装成功（${Date.now() - startedAt}ms）：${targets.join(' ')}`);
      else logError('dep-installer', `插件 ${pluginId} 可选依赖安装失败：${result.error}`);
      resolve(result);
    });
  });
}

/**
 * 对外入口：为插件安装可选依赖。
 * 并发语义：同一 pluginId 已在安装中 → 直接复用同一 Promise（不重复起 npm）。
 * @param {string} pluginId 插件 id
 * @param {object} manifest 插件清单（用于取 optionalDependencies）
 * @param {{onLine?: Function, force?: boolean, dir?: string}} [opts]
 * dir = 插件目录（来自 scanner 的 meta.dir），用于「只服务 plugins/ 下插件」的来源限定
 * @returns {Promise<object>} 安装结果（含 plan）
 */
async function installFor(pluginId, manifest, opts = {}) {
  const pluginDir = opts.dir || (manifest && manifest.__dir) || '';
  // 来源限定：只服务 plugins/ 下的内置插件
  if (pluginDir) {
    const rel = path.relative(path.join(PROJECT_ROOT, 'plugins'), pluginDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const msg = `拒绝安装：插件目录不在 plugins/ 下（${pluginDir}）`;
      logWarn('dep-installer', msg);
      return { ok: false, pluginId, error: msg };
    }
  }

  const plan = planInstall(manifest);
  if (!plan.ok && !opts.force) {
    // 「已齐备」「无需安装」「白名单拒绝」都在这里统一返回
    const isReject = plan.rejected && plan.rejected.length > 0;
    const result = { ok: false, pluginId, plan, error: plan.reason, rejected: plan.rejected };
    if (isReject) logWarn('dep-installer', plan.reason);
    _lastResult.set(pluginId, result);
    return result;
  }
  if (!plan.targets || plan.targets.length === 0) {
    const result = { ok: false, pluginId, plan, error: plan.reason || '没有需要安装的包' };
    _lastResult.set(pluginId, result);
    return result;
  }

  if (_running.has(pluginId)) {
    logInfo('dep-installer', `插件 ${pluginId} 已有安装在进行中，复用该任务`);
    return _running.get(pluginId);
  }

  const task = runInstall(pluginId, plan.targets, opts.onLine)
    .then((res) => {
      const merged = { ...res, plan };
      _lastResult.set(pluginId, merged);
      return merged;
    })
    .catch((err) => {
      const merged = { ok: false, pluginId, plan, error: `安装异常：${err.message}`, targets: plan.targets };
      logError('dep-installer', merged.error);
      _lastResult.set(pluginId, merged);
      return merged;
    })
    .finally(() => { _running.delete(pluginId); });

  _running.set(pluginId, task);
  return task;
}

/**
 * 某插件是否正在安装中。
 * @param {string} pluginId
 * @returns {boolean}
 */
function isInstalling(pluginId) {
  return _running.has(pluginId);
}

/**
 * 取最近一次安装结果（无则 null）。
 * @param {string} pluginId
 * @returns {object|null}
 */
function lastResult(pluginId) {
  return _lastResult.get(pluginId) || null;
}

module.exports = {
  PROJECT_ROOT,
  ALLOWED,
  INSTALL_TIMEOUT_MS,
  canResolve,
  planInstall,
  installFor,
  isInstalling,
  lastResult,
};