/**
 * 插件注册中心（src/plugin-registry.js）—— 已收敛为薄适配层
 * 演进说明（架构 §3.6 阶段 B）：
 * 插件装配逻辑已全部迁到 src/plugin-runtime.js（插件层唯一装配点）。
 * 本文件仅保留**向后兼容的转发门面**，供尚未迁移的调用方（当前仅 src/moderator.js）使用；
 * 它自身不再 require cordis-bridge / plugin-scanner / plugin-host，也不再是反向依赖的抓手。
 * 迁移目标：调用方改为 `require('./capability-broker')`（核心侧）或 `require('./plugin-runtime')`（装配侧），
 * 本文件随后即可删除。
 */
const runtime = require('./plugin-runtime');

/**
 * 初始化插件系统（转发到插件运行时）。
 * @param {object} [options] 宿主依赖
 * @returns {Promise<object>} 宿主状态
 */
async function initPlugins(options = {}) {
  return runtime.init(options);
}

/** 取桥接层模块*/
function getBridgeModule() {
  return runtime.getBridgeModule();
}

/** 取根 BridgeContext（可能为 null）*/
function getBridge() {
  return runtime.getBridge();
}

/** 取扫描器模块*/
function getScanner() {
  return runtime.getScanner();
}

/** 取插件宿主模块*/
function getHost() {
  return runtime.getHost();
}

/** 取配置模块*/
function getConfig() {
  return runtime.getConfig();
}

/** 插件系统是否就绪*/
function isReady() {
  return runtime.isReady();
}

/**
 * 触发一次图片审核标签收集（供 moderator.js 调用）。
 * 已改为经能力中介（capability-broker）→ 插件不注册能力时返回空数组，主流程不受影响。
 * @param {string} imageBase64 base64 图片
 * @returns {Promise<Array<object>>} 各插件的贡献
 */
async function collectImageTags(imageBase64) {
  return runtime.collectImageTags(imageBase64);
}

module.exports = {
  initPlugins,
  getBridge,
  getBridgeModule,
  getScanner,
  getHost,
  getConfig,
  isReady,
  collectImageTags,
};
