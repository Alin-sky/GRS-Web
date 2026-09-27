/**
 * 内容安全能力探测（src/content_safety.js）
 * v0.1.0（决策 A）：本文件已降级为**只读能力探测薄层**。
 * - **没有任何阿里云调用点**：不构造客户端、不发请求、不持有缓存；
 * 唯一的判定实现是 `plugins/aliyun-content-safety`，经 capability-broker 触达。
 * - 保留的导出只回答一个问题：**内容安全现在能不能用**（供状态面板 / 画布置灰 / 冲突提示）。
 * - 需要「真的判一次」的场景一律走 `src/flow/adjudicators.js#invoke()`；
 * 需要常态化生效的场景请在画布拓扑里接入对应节点。
 * 为什么不整个删掉：`GET /api/content-safety/status` 与系统信息页要显示
 * 「插件是否装载 / SDK 是否安装 / AccessKey 是否配置」，这套判定只有核心知道配置结构。
 * 保留它，但让它彻底失去 side effect。
 * 回滚：本文件的改造是纯功能性的，git 还原即可恢复旧实现，不涉及任何数据迁移。
 */

'use strict';

const { loadConfig, isValueSet } = require('./config');
const capabilityBroker = require('./capability-broker');

/** 内容安全配置（字段**未搬迁**，仍读 config.contentSafety.*）。*/
function getSafetyConfig() {
  return loadConfig().contentSafety || {};
}

/** 是否已启用且配好 AccessKey（占位符视为未配置）。*/
function isConfigured() {
  const safety = getSafetyConfig();
  return Boolean(safety.enabled && isValueSet(safety.accessKeyId) && isValueSet(safety.accessKeySecret));
}

/**
 * 插件是否提供了内容安全判定的能力（未启用 / 未装载 → false）。
 * 只是「有没有人声明了这个能力」，不会触发任何远程请求。
 */
function hasProvider() {
  return capabilityBroker.has('text.verdict') || capabilityBroker.has('image.verdict');
}

/**
 * SDK 是否已安装（仅用于状态展示；实际装载归属插件，核心不再 require）。
 * @returns {boolean} 是否已安装
 */
function isSdkInstalled() {
  try {
    require.resolve('@alicloud/green20220302', { paths: [__dirname] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 内容安全状态（供 GET /api/content-safety/status 使用）。
 * @returns {object} 状态
 */
function getStatus() {
  const safety = getSafetyConfig();
  const configured = Boolean(isValueSet(safety.accessKeyId) && isValueSet(safety.accessKeySecret));
  const installed = isSdkInstalled();
  const pluginAvailable = hasProvider();

  let textServices = [];
  if (Array.isArray(safety.textServices) && safety.textServices.length > 0) {
    textServices = safety.textServices.filter(Boolean);
  } else if (safety.textService) {
    textServices = [safety.textService];
  }

  // 状态优先级：plugin_disabled > missing-deps > not-configured > disabled > ready
  let reason = '';
  if (!pluginAvailable) reason = 'plugin_disabled';
  else if (!installed) reason = 'missing-deps';
  else if (!configured) reason = 'not-configured';
  else if (safety.enabled !== true) reason = 'disabled';

  return {
    enabled: safety.enabled === true,
    configured,
    installed,
    pluginAvailable,
    ready: safety.enabled === true && configured && pluginAvailable,
    reason,
    installHint: installed ? '' : 'npm i @alicloud/green20220302',
    textEnabled: safety.textEnabled !== false,
    imageEnabled: safety.imageEnabled !== false,
    region: safety.region || 'cn-shanghai',
    endpoint: safety.endpoint || 'cn-shanghai',
    textServices,
    imageService: safety.imageService || 'query_security_check',
  };
}

/**
 * 兼容保留：文本缓存已迁至插件内部，此处为无操作。
 * @returns {number} 固定返回 0
 */
function clearTextCache() {
  return 0;
}

module.exports = {
  getContentSafetyStatus: getStatus,
  isSdkInstalled,
  isConfigured,
  hasProvider,
  clearTextCache,
};
