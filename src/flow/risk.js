/**
 * 风险序（R0 前置项）—— 全项目**唯一**风险等级序位定义源。
 *
 * 病根：v2.1.0 里有三份互不一致的 RISK_ORDER 拷贝（moderator.js / injection-audit.js /
 * fail-closed.js 内联均 review=2.5，而 config-defaults.js 的 DEFAULT_RISK_LEVELS.score 为 review=3）。
 * 并行合并依赖「序位比较」，多份定义会让「取最严重」在不同路径下漂移。此处收敛为一份，禁止再自行定义。
 *
 * 阶梯：safe(0) < low(1) < medium(2) < review(3) < high(4) < critical(5)。
 * 把旧 `review:2.5/high:3/critical:4` 归一为 `review:3/high:4/critical:5` 后**相对次序不变**，
 * 故既有判定行为逐字段不变（绝对数值不外泄）。零依赖，核心/插件契约层/测试均可独立引用。
 */

'use strict';

/** 含 review 的完整风险序（内部比较专用）。*/
const RISK_ORDER = Object.freeze({
  safe: 0,
  low: 1,
  medium: 2,
  review: 3,
  high: 4,
  critical: 5,
});

/** 完整风险等级列表（含 review）。*/
const RISK_LEVELS = Object.freeze(['safe', 'low', 'medium', 'review', 'high', 'critical']);

/** 内容风险等级（模型/插件可输出，不含 review —— review 表示「链路失效」）。*/
const CONTENT_RISK_LEVELS = Object.freeze(['safe', 'low', 'medium', 'high', 'critical']);

/** 取风险等级序位，未知等级按 0（safe）处理。 */
function riskOrder(level) {
  return RISK_ORDER[level] ?? 0;
}

/** 比较序位：a-b（>0 表示 a 更严重）。 */
function compareRisk(a, b) {
  return riskOrder(a) - riskOrder(b);
}

/** 取两者中更严重者。 */
function maxRisk(a, b) {
  return compareRisk(a, b) >= 0 ? a : b;
}

/** 取两者中更轻者。 */
function minRisk(a, b) {
  return compareRisk(a, b) <= 0 ? a : b;
}

module.exports = {
  RISK_ORDER,
  RISK_LEVELS,
  CONTENT_RISK_LEVELS,
  riskOrder,
  compareRisk,
  maxRisk,
  minRisk,
};
