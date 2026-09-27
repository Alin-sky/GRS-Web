/**
 * 可选依赖探测（plugins/nsfwjs-image-guard/lib/deps.js）
 *
 * ★ 本插件是「可选依赖」插件，是本项目「0 依赖可解耦运行」红线的一部分：
 *   - nsfwjs / @tensorflow/tfjs-node 绝不进主工程 package.json 的任何依赖区；
 *   - 装载前探测依赖是否可用；不可用 → 插件不注册能力、不装载，宿主按
 *     missing-deps / disabled 处理，界面与日志给出安装命令；
 *   - 探测本身**不抛异常**，核心启动链路永远不会因为本插件而失败。
 *
 * ★ 为什么用 createRequire 而不是直接 require：
 *   1) 可选依赖必须是惰性、可失败解析的，不能在模块顶层硬 require（否则删包即崩）；
 *   2) 插件目录可能不在工程 node_modules 的解析起点上，用 createRequire 以插件自身
 *      目录为基准向上解析，行为与 require 一致但可精确控制。
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');

/** 以插件目录为基准的解析器（向上冒泡到工程 node_modules） */
const pluginRequire = createRequire(path.join(__dirname, '..', 'index.js'));

/** 必需包：缺一即不可用 */
const REQUIRED_PACKAGES = Object.freeze(['nsfwjs']);

/** 计算后端候选（按优先级）：tfjs-node 优先，纯 JS 后端为回退 */
const BACKENDS = Object.freeze([
  {
    id: 'tfjs-node',
    pkg: '@tensorflow/tfjs-node',
    label: 'tfjs-node（原生后端，性能好）',
    installHint: 'npm i nsfwjs @tensorflow/tfjs-node',
  },
  {
    id: 'tfjs',
    pkg: '@tensorflow/tfjs',
    label: 'tfjs（纯 JS 后端，体积小、较慢）',
    installHint: 'npm i nsfwjs @tensorflow/tfjs',
  },
]);

/** 默认推荐安装命令（未安装时的界面提示） */
const DEFAULT_INSTALL_HINT = 'npm i nsfwjs @tensorflow/tfjs-node';

/**
 * 判断某个包是否可解析（不实际加载，避免副作用与耗时）。
 * @param {string} pkg 包名
 * @returns {boolean} 是否可解析
 */
function canResolve(pkg) {
  try {
    pluginRequire.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

/**
 * 惰性加载某个包（失败返回 null，不抛异常）。
 * @param {string} pkg 包名
 * @returns {any|null} 模块导出或 null
 */
function tryLoad(pkg) {
  try {
    return pluginRequire(pkg);
  } catch {
    return null;
  }
}

/**
 * 取某个包在磁盘上的目录（用于定位随包分发的模型目录）。
 * @param {string} pkg 包名
 * @returns {string|null} 目录绝对路径
 */
function packageDir(pkg) {
  try {
    return path.dirname(pluginRequire.resolve(`${pkg}/package.json`));
  } catch {
    try {
      return path.dirname(pluginRequire.resolve(pkg));
    } catch {
      return null;
    }
  }
}

/**
 * 探测可选依赖与后端可用性。永不抛异常。
 * @returns {{
 *   ok: boolean, missing: string[], backends: Object<string, boolean>,
 *   availableBackends: string[], installHint: string, message: string
 * }}
 */
function probe() {
  const missing = [];
  for (const pkg of REQUIRED_PACKAGES) {
    if (!canResolve(pkg)) missing.push(pkg);
  }

  const backends = {};
  for (const b of BACKENDS) backends[b.id] = canResolve(b.pkg);
  const availableBackends = BACKENDS.filter((b) => backends[b.id]).map((b) => b.id);

  // nsfwjs 存在但没有任何 TF 后端 → 同样视为依赖缺失（架构 §8.2 决策 10）
  if (!missing.includes('nsfwjs') && availableBackends.length === 0) {
    missing.push('@tensorflow/tfjs-node（或 @tensorflow/tfjs）');
  }

  const installHint = availableBackends.length > 0 && !backends['tfjs-node']
    ? 'npm i nsfwjs @tensorflow/tfjs-node'
    : DEFAULT_INSTALL_HINT;

  const ok = missing.length === 0;
  return {
    ok,
    missing,
    backends,
    availableBackends,
    installHint,
    message: ok
      ? `可选依赖已就绪（后端：${availableBackends.join(' / ')}）`
      : `缺少可选依赖：${missing.join('、')}；安装命令：${installHint}`,
  };
}

/**
 * 为指定后端取安装命令。
 * @param {string} backendId 后端 id（tfjs-node / tfjs）
 * @returns {string} 安装命令
 */
function installHintFor(backendId) {
  const found = BACKENDS.find((b) => b.id === backendId);
  return found ? found.installHint : DEFAULT_INSTALL_HINT;
}

/**
 * 解析实际可用的后端：优先用户选择，不可用时按 tfjs-node → tfjs 顺序回退。
 * @param {string} preferred 用户选择的后端 id
 * @param {Object<string, boolean>} [available] 探测结果（缺省重新探测）
 * @returns {{id: string|null, requested: string, fellBack: boolean}}
 */
function resolveBackend(preferred, available) {
  const requested = String(preferred || 'tfjs-node');
  const avail = available || probe().backends;
  if (avail[requested]) return { id: requested, requested, fellBack: false };
  const fallback = BACKENDS.find((b) => avail[b.id]);
  return { id: fallback ? fallback.id : null, requested, fellBack: Boolean(fallback) };
}

module.exports = {
  REQUIRED_PACKAGES,
  BACKENDS,
  DEFAULT_INSTALL_HINT,
  canResolve,
  tryLoad,
  packageDir,
  probe,
  installHintFor,
  resolveBackend,
};
