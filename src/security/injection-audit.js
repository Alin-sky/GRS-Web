/**
 * InjectionAudit —— 注入信号审计与计数（架构 §2.5 交叉校验 C1–C4 / SEC-08）
 * 定位：
 * 只做「零成本一致性校验」与「信号记录」，不引入第二次模型调用。
 * 四类信号：
 * C1 预检与模型结论矛盾 —— 预检命中高风险，模型却判 safe/low
 * C2 双通道结论分歧 —— 本地与云端等级差 >= 2 级
 * C3 自洽性矛盾 —— risk_level 与 category_scores 互相打脸
 * C4 策略版本号哨兵缺失 —— policy_version 缺失（提示词可能被覆盖）
 * 另有 T2：输入中出现定界符逃逸尝试且已被中和（仅记录，不升级）。
 * 输出：
 * - 信号码数组写入 result.injection_signals（随审核记录一起落盘）
 * - 冲突类信号会把结论抬到 crossCheck.minLevel，并标记 needs_human_review
 * - /api/stats/summary 通过 getStats() 暴露 suspicious_injection 计数
 * 本模块不持有待审核原文，落盘/计数均不含敏感内容。
 */

'use strict';

/** 注入信号码。*/
const SIGNAL_CODES = {
  C1: 'C1_PRECHECK_MODEL_CONFLICT',
  C2: 'C2_DUAL_CHANNEL_DIVERGENCE',
  C3: 'C3_SELF_INCONSISTENCY',
  C4: 'C4_POLICY_CANARY_MISSING',
  T2: 'T2_DELIMITER_NEUTRALIZED',
};

/** 冲突类信号：命中即视为可疑注入，触发结论升级。*/
const CONFLICT_SIGNALS = new Set([
  SIGNAL_CODES.C1,
  SIGNAL_CODES.C2,
  SIGNAL_CODES.C3,
  SIGNAL_CODES.C4,
]);

// R0：风险序唯一来源（src/flow/risk.js）。本文件不再自行定义。
const { RISK_ORDER, riskOrder } = require('../flow/risk');

/** 进程内计数器（重启清零，仅用于运营观测，非安全边界）。*/
let counters = {
  total: 0,
  suspicious: 0,
  by_signal: {},
};

/**
 * 取预检命中的最高等级序值。
 * @param {{hasHit?: boolean, hits?: Array<{level?: string}>}} precheckResult 预检结果
 * @returns {number} 最高序值（无命中为 -1）
 */
function precheckMaxOrder(precheckResult) {
  if (!precheckResult || !precheckResult.hasHit || !Array.isArray(precheckResult.hits)) return -1;
  let max = -1;
  for (const hit of precheckResult.hits) {
    const order = riskOrder(hit && hit.level);
    if (order > max) max = order;
  }
  return max;
}

/**
 * 取 category_scores 中的最大分值。
 * @param {object} scores 分类分值
 * @returns {number} 最大分值（0-100）
 */
function maxScore(scores) {
  if (!scores || typeof scores !== 'object') return 0;
  let max = 0;
  for (const value of Object.values(scores)) {
    const num = Number(value);
    if (Number.isFinite(num) && num > max) max = num;
  }
  return max;
}

/**
 * 检测注入信号。
 * @param {object} ctx 上下文
 * @param {string} [ctx.riskLevel] 最终风险等级
 * @param {object} [ctx.categoryScores] 最终分类分值
 * @param {object} [ctx.precheckResult] 预检结果
 * @param {string} [ctx.localRisk] 本地通道等级
 * @param {string} [ctx.cloudRisk] 云端通道等级
 * @param {boolean} [ctx.canaryMissing] policy_version 是否缺失
 * @param {boolean} [ctx.fenceNeutralized] 输入是否出现定界符逃逸并被中和
 * @returns {Array<{code: string, detail: string}>} 信号列表
 */
function detectSignals(ctx = {}) {
  const signals = [];

  // C1 —— 预检与模型结论矛盾：预检已命中高风险，模型却给出安全结论
  const precheckMax = precheckMaxOrder(ctx.precheckResult);
  const finalOrder = riskOrder(ctx.riskLevel);
  if (precheckMax >= 0 && precheckMax - finalOrder >= 2) {
    signals.push({
      code: SIGNAL_CODES.C1,
      detail: `预检命中等级(${precheckMax}) 比模型结论(${finalOrder}) 高 2 级以上`,
    });
  }

  // C2 —— 双通道结论分歧
  if (ctx.localRisk && ctx.cloudRisk) {
    const diff = Math.abs(riskOrder(ctx.localRisk) - riskOrder(ctx.cloudRisk));
    if (diff >= 2) {
      signals.push({
        code: SIGNAL_CODES.C2,
        detail: `本地(${ctx.localRisk}) 与云端(${ctx.cloudRisk}) 等级差 ${diff} 级`,
      });
    }
  }

  // C3 —— 自洽性：等级与分值互相矛盾
  // 仅在「确实拿到了模型分值向量」时才有意义：fail-closed / 空分值向量时跳过，
  // 否则每条兜底结果都会被误记成可疑注入（污染 suspicious_injection 计数）。
  const hasScores = ctx.categoryScores
    && typeof ctx.categoryScores === 'object'
    && Object.keys(ctx.categoryScores).length > 0;
  if (ctx.riskLevel && hasScores) {
    const top = maxScore(ctx.categoryScores);
    if (finalOrder <= 1 && top >= 60) {
      signals.push({
        code: SIGNAL_CODES.C3,
        detail: `结论为 ${ctx.riskLevel} 但存在 ${top} 分的分类评分`,
      });
    } else if (finalOrder >= 3 && top <= 10) {
      signals.push({
        code: SIGNAL_CODES.C3,
        detail: `结论为 ${ctx.riskLevel} 但全部分类评分均 <= 10`,
      });
    }
  }

  // C4 —— 策略版本号哨兵缺失（提示词可能被覆盖 / 模型未遵守输出契约）
  if (ctx.canaryMissing === true) {
    signals.push({
      code: SIGNAL_CODES.C4,
      detail: '模型输出缺少策略版本号哨兵 policy_version',
    });
  }

  // T2 —— 输入中出现定界符逃逸尝试（已由 PromptFence 中和，仅记录）
  if (ctx.fenceNeutralized === true) {
    signals.push({
      code: SIGNAL_CODES.T2,
      detail: '待审核内容中出现定界符形式的逃逸尝试，已中和',
    });
  }

  return signals;
}

/**
 * 是否有冲突类信号（会触发结论升级）。
 * @param {Array<{code: string}>} signals 信号列表
 * @returns {boolean} 是否存在冲突类信号
 */
function hasConflict(signals) {
  return signals.some((s) => CONFLICT_SIGNALS.has(s.code));
}

/**
 * 把交叉校验结果写入审核结果，并按配置升级结论。
 * @param {object} result 审核结果（原地修改）
 * @param {Array<{code: string, detail: string}>} signals 信号列表
 * @param {object} options 选项
 * @param {boolean} [options.enabled] 是否启用升级
 * @param {string} [options.minLevel] 升级下限等级
 * @param {(riskLevel: string) => string} [options.actionOf] 等级 -> 动作
 * @param {(action: string) => boolean} [options.isPassing] 动作是否放行
 * @returns {object} 结果
 */
function applySignals(result, signals, options = {}) {
  if (!result || !Array.isArray(signals) || signals.length === 0) return result;

  result.injection_signals = signals.map((s) => s.code);
  result.injection_signal_details = signals.map((s) => `${s.code}: ${s.detail}`);

  // 计数：出现任何信号都计入可疑（T2 只记录不升级，但也算可疑迹象）
  counters.suspicious += 1;
  for (const signal of signals) {
    counters.by_signal[signal.code] = (counters.by_signal[signal.code] || 0) + 1;
  }

  if (!hasConflict(signals) || options.enabled === false) {
    result.suspicious_injection = hasConflict(signals);
    return result;
  }

  const minLevel = options.minLevel || 'medium';
  if (riskOrder(result.risk_level) < riskOrder(minLevel)) {
    result.risk_level = minLevel;
    if (typeof options.actionOf === 'function') {
      const action = options.actionOf(minLevel);
      if (action) result.action = action;
    }
    if (typeof options.isPassing === 'function') {
      result.passed = options.isPassing(result.action);
    }
    result.cross_check_escalated = true;
  }

  result.suspicious_injection = true;
  result.needs_human_review = true;
  if (result.reason) {
    result.reason = `${result.reason}（交叉校验发现注入迹象：${signals.map((s) => s.code).join(',')}）`;
  } else {
    result.reason = `交叉校验发现注入迹象：${signals.map((s) => s.code).join(',')}`;
  }
  return result;
}

/**
 * 记录一次审核（仅计数，不含原文）。
 * @param {object} result 审核结果
 */
function record(result) {
  counters.total += 1;
  if (result && Array.isArray(result.injection_signals) && result.injection_signals.length > 0) {
    // 信号已在 applySignals 中计数，这里避免重复
    return;
  }
  return undefined;
}

/**
 * 获取注入信号统计（供 /api/stats/summary 使用）。
 * @returns {{total: number, suspicious_injection: number, by_signal: object}} 统计
 */
function getStats() {
  return {
    total: counters.total,
    suspicious_injection: counters.suspicious,
    by_signal: { ...counters.by_signal },
  };
}

/** 重置计数器（仅供测试使用）。*/
function resetCounters() {
  counters = { total: 0, suspicious: 0, by_signal: {} };
}

module.exports = {
  SIGNAL_CODES,
  CONFLICT_SIGNALS,
  RISK_ORDER,
  detectSignals,
  hasConflict,
  applySignals,
  record,
  getStats,
  resetCounters,
  riskOrder,
  precheckMaxOrder,
};
