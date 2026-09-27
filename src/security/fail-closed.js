/**
 * FailClosed —— 兜底策略统一出口（架构 §2.4）
 * 只服务一种场景：**已配置 AI 通道但未取得可信判决**。
 * 「用户压根没配置任何 AI 通道」属于可选能力降级，由编排层走预检结论，
 * 不得走本模块（那会导致没配 Key 的机器全部被拦）。
 * 不变量（架构 note）：
 * passed 恒 !== true；confidence = 0；error = true；
 * needs_human_review = true；fail_closed = true；failure_code 记录。
 */

'use strict';

const { FAILURE_CODES, isFailingCode } = require('./output-schema');
// R0：风险序唯一来源（src/flow/risk.js）。
const { riskOrder } = require('../flow/risk');

/** 动作严重程度（含 review）。*/
const ACTION_ORDER = { pass: 0, pass_log: 1, review: 2, block: 3, block_alert: 4 };

/**
 * 根据 onAiFailure 策略与 strictness 计算兜底判定。
 * @param {'block'|'review'} [onAiFailure] 策略
 * @param {'relaxed'|'standard'|'strict'} [strictness] 严格程度
 * @returns {{action: string, risk_level: string}} 兜底判定
 */
function resolveVerdict(onAiFailure = 'block', strictness = 'standard') {
  const policy = onAiFailure === 'review' ? 'review' : 'block';
  // 严格模式下即便配置了 review 也直接拦截
  const effective = (policy === 'review' && strictness === 'strict') ? 'block' : policy;
  return effective === 'block'
    ? { action: 'block', risk_level: 'high' }
    : { action: 'review', risk_level: 'review' };
}

/**
 * 生成 fail-closed 结果对象。
 * @param {object} options 选项
 * @param {string} options.failureCode 失败码（empty/timeout/parse/schema/enum/range/length/unsafe/network）
 * @param {'block'|'review'} [options.onAiFailure] 策略，默认 block
 * @param {'relaxed'|'standard'|'strict'} [options.strictness] 严格程度
 * @param {string} [options.reason] 判定理由
 * @param {string} [options.requestId] 请求 id
 * @param {'text'|'image'|'combined'} [options.type] 内容类型
 * @param {object} [options.meta] 透传元数据
 * @returns {object} fail-closed 结果
 */
function buildFailClosedResult(options = {}) {
  const {
    failureCode = 'unknown',
    onAiFailure = 'block',
    strictness = 'standard',
    reason = 'AI 审核通道异常，未取得有效判定，已按失败-关闭策略拦截',
    requestId = '',
    type = 'text',
    meta = {},
  } = options;

  const verdict = resolveVerdict(onAiFailure, strictness);

  return {
    passed: false,
    action: verdict.action,
    risk_level: verdict.risk_level,
    categories: [],
    category_scores: {},
    confidence: 0,
    reason,
    suggestion: 'AI 审核通道未能返回可信判决，已按失败-关闭策略拦截，请人工复核',
    type,
    timestamp: new Date().toISOString(),
    error: true,
    fail_closed: true,
    needs_human_review: true,
    failure_code: failureCode,
    ...(requestId ? { request_id: requestId } : {}),
    ...meta,
  };
}

/**
 * 把 fail-closed 结论叠加到一个已有结果上（只升级、绝不降级）。
 * 必须在预检兜底与内容安全合并**之后**调用。
 * @param {object} result 已有结果（原地修改）
 * @param {object} options 同 buildFailClosedResult，另可传 keepReason
 * @returns {object} 结果
 */
function applyFailClosed(result, options = {}) {
  const { failureCode = 'unknown', onAiFailure = 'block', strictness = 'standard', reason = '', requestId = '' } = options;
  const verdict = resolveVerdict(onAiFailure, strictness);

  if ((ACTION_ORDER[result.action] || 0) < ACTION_ORDER[verdict.action]) {
    result.action = verdict.action;
  }
  if (riskOrder(result.risk_level) < riskOrder(verdict.risk_level)) {
    result.risk_level = verdict.risk_level;
  }

  result.passed = false;
  result.confidence = 0;
  result.error = true;
  result.fail_closed = true;
  result.needs_human_review = true;
  result.failure_code = failureCode;
  if (requestId) result.request_id = requestId;

  if (reason) {
    result.reason = result.reason && !result.reason.startsWith(reason)
      ? `${reason}；${result.reason}`
      : reason;
  }
  if (!result.suggestion) {
    result.suggestion = 'AI 审核通道未能返回可信判决，已按失败-关闭策略拦截，请人工复核';
  }
  return result;
}

/**
 * 判断某个失败码是否应进 fail-closed（skipped 不计）。
 * @param {string} code 失败码
 * @returns {boolean} 是否 fail-closed
 */
function shouldFailClosed(code) {
  return isFailingCode(code);
}

module.exports = {
  FAILURE_CODES,
  ACTION_ORDER,
  resolveVerdict,
  buildFailClosedResult,
  applyFailClosed,
  shouldFailClosed,
};
