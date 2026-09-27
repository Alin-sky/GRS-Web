/**
 * Node.js 版本工具（纯 CommonJS，无第三方依赖）。
 *
 * 供 scripts/setup.js 等脚本复用，用于校验当前 Node 是否满足项目最低版本要求。
 */

'use strict';

/** 项目最低 Node 版本要求（sharp@0.35.3 的 engines 硬性约束）。 */
const DEFAULT_MIN_VERSION = '20.9.0';

/**
 * 解析版本字符串为数字对象。
 *
 * @param {string} raw 形如 "v22.22.2" 或 "22.22.2" 的版本字符串。
 * @returns {{ major: number, minor: number, patch: number, raw: string } | null}
 *   解析成功返回版本对象，失败返回 null。
 */
function parseVersion(raw) {
  const str = String(raw || '').trim().replace(/^v/i, '');
  const matched = str.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!matched) {
    return null;
  }
  return {
    major: parseInt(matched[1], 10),
    minor: parseInt(matched[2], 10),
    patch: parseInt(matched[3], 10),
    raw: str,
  };
}

/**
 * 比较两个版本对象。
 *
 * @param {{ major: number, minor: number, patch: number }} a 版本 A。
 * @param {{ major: number, minor: number, patch: number }} b 版本 B。
 * @returns {number} a > b 返回正数，a < b 返回负数，相等返回 0。
 */
function compareVersions(a, b) {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

/**
 * 获取当前运行 Node 的版本信息。
 *
 * @returns {{ major: number, minor: number, patch: number, raw: string } | null}
 *   解析成功返回版本对象，失败返回 null。
 */
function getNodeVersion() {
  return parseVersion(process.version);
}

/**
 * 判断当前 Node 是否满足最低版本要求（语义版本比较）。
 *
 * @param {string} minVersion 最低版本要求，形如 "20.9.0"，默认 DEFAULT_MIN_VERSION。
 * @returns {boolean} 当前版本 >= minVersion 返回 true，否则返回 false。
 */
function isNodeCompatible(minVersion = DEFAULT_MIN_VERSION) {
  const current = getNodeVersion();
  const minimum = parseVersion(minVersion);
  if (!current || !minimum) {
    return false;
  }
  return compareVersions(current, minimum) >= 0;
}

module.exports = {
  DEFAULT_MIN_VERSION,
  getNodeVersion,
  isNodeCompatible,
  parseVersion,
  compareVersions,
};
