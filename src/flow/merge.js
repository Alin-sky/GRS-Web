/**
 * 合并引擎（src/flow/merge.js）—— 三种并行合并策略的精确语义
 * 设计依据：GRS v2.2.0 架构 §6.4。
 * 三步：
 * ① 分类（BranchSets）：ok / failed / skipped
 * ② 短路（优先级最高）：任一 failed（非 skip 策略）→ 直接 failed 不比较；
 * 全 skipped → 返回 skipped（**绝不出 safe**）
 * ③ 比较（仅对 ok 分支）：只比 risk_level 序位（不比 category_scores）；
 * 并列依次用 priority → branchOrder → nodeId
 * 本模块为纯函数，零 IO，可独立单测。
 */

'use strict';

const { RISK_ORDER, riskOrder } = require('./risk');

/** 合并策略标签（用于 reason 文案）。*/
const STRATEGY_LABEL = Object.freeze({
  highest: '取最严重',
  lowest: '取最轻',
  priority: '以某结果为准',
});

/**
 * 分支分类。
 * @param {Array<object>} branches 分支列表
 * @returns {{ok: Array<object>, failed: Array<object>, skipped: Array<object>}} 分类结果
 */
function classify(branches) {
  const ok = [];
  const failed = [];
  const skipped = [];
  for (const b of branches) {
    if (!b) continue;
    if (b.status === 'ok' && b.verdict && b.verdict.risk_level) ok.push(b);
    else if (b.status === 'failed') failed.push(b);
    else skipped.push(b);
  }
  return { ok, failed, skipped };
}

/**
 * 并列兜底次序：priority 降序 → branchOrder 升序 → nodeId 字典序。
 * @param {object} a 分支 A
 * @param {object} b 分支 B
 * @returns {number} 排序值（<0 表示 a 优先）
 */
function tieBreak(a, b) {
  if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
  if ((a.branchOrder || 0) !== (b.branchOrder || 0)) return (a.branchOrder || 0) - (b.branchOrder || 0);
  return String(a.nodeId).localeCompare(String(b.nodeId));
}

/**
 * 从 ok 分支中挑出胜出者。
 * @param {Array<object>} ok ok 分支
 * @param {string} strategy 合并策略
 * @returns {object|null} 胜出分支
 */
function pickWinner(ok, strategy) {
  if (ok.length === 0) return null;
  const sorted = [...ok].sort((a, b) => {
    if (strategy === 'priority') {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      return tieBreak(a, b);
    }
    const ra = riskOrder(a.verdict.risk_level);
    const rb = riskOrder(b.verdict.risk_level);
    if (ra !== rb) return strategy === 'lowest' ? ra - rb : rb - ra;
    return tieBreak(a, b);
  });
  return sorted[0];
}

/**
 * 合成胜出结论的其余字段（三策略共用）。
 * @param {object} winner 胜出分支
 * @param {Array<object>} ok 全部 ok 分支
 * @param {string} strategy 策略
 * @param {'winner'|'union'} categoriesMerge categories 合并方式
 * @returns {object} 合成后的 verdict
 */
function compose(winner, ok, strategy, categoriesMerge = 'winner') {
  const verdict = winner.verdict;
  const confidence = ok.reduce((min, b) => {
    const c = Number(b.verdict.confidence);
    const value = Number.isFinite(c) ? c : 0;
    return Math.min(min, value);
  }, 1);

  let categories = Array.isArray(verdict.categories) ? verdict.categories.slice() : [];
  if (categoriesMerge === 'union') {
    const set = new Set();
    for (const b of ok) for (const c of b.verdict.categories || []) set.add(c);
    categories = [...set];
  }

  const label = STRATEGY_LABEL[strategy] || strategy;
  const summary = ok
    .map((b) => `${b.title || b.nodeId}(${b.verdict.risk_level})`)
    .join(' / ');
  const winnerReason = verdict.reason || '';
  const reason = `[策略:${label}] ${summary} → 采用 ${winner.title || winner.nodeId}：${winnerReason}`;

  return {
    risk_level: verdict.risk_level,
    action: verdict.action,
    categories,
    category_scores: verdict.category_scores || {},
    confidence,
    reason,
    suggestion: verdict.suggestion || '',
    merge_strategy: strategy,
    won_by: winner.nodeId,
    branch_count: ok.length,
  };
}

/**
 * 执行合并。
 * @param {Array<object>} branches 分支列表 [{nodeId, title, status, verdict, priority, branchOrder, failurePolicy}]
 * @param {string} [strategy='highest'] 合并策略
 * @param {{categoriesMerge?: 'winner'|'union'}} [options] 选项
 * @returns {{status: 'ok'|'failed'|'skipped', verdict: object|null, won_by: string|null,
 * merge_strategy: string, branch_count: number, ok_count: number,
 * failed_count: number, skipped_count: number, failure: object|null, reason: string}}
 */
function merge(branches, strategy = 'highest', options = {}) {
  const list = Array.isArray(branches) ? branches : [];
  const { ok, failed, skipped } = classify(list);
  const base = {
    merge_strategy: strategy,
    branch_count: list.length,
    ok_count: ok.length,
    failed_count: failed.length,
    skipped_count: skipped.length,
    won_by: null,
    verdict: null,
    failure: null,
    reason: '',
  };

  // ② 短路：任一真实 failed（非 skip 策略）→ 不做任何比较，整体 failed
  const realFailures = failed.filter((f) => f.failurePolicy !== 'skip');
  if (realFailures.length > 0) {
    return {
      ...base,
      status: 'failed',
      failure: realFailures[0],
      reason: `分支失败（${realFailures[0].title || realFailures[0].nodeId}：${realFailures[0].failureType || 'unknown'}），按失败-关闭处理`,
    };
  }

  // 全 skipped（含仅由 skip 策略失败降级而来的分支）→ skipped，绝不出 safe
  if (ok.length === 0) {
    return {
      ...base,
      status: 'skipped',
      reason: failed.length > 0
        ? `全部判定分支未取得有效结论（${failed.length} 个失败分支被 skip 策略降级）`
        : '全部判定分支未执行（未配置 / 未启用）',
    };
  }

  // ③ + ④ 比较与合成
  const winner = pickWinner(ok, strategy);
  const verdict = compose(winner, ok, strategy, options.categoriesMerge || 'winner');
  return {
    ...base,
    status: 'ok',
    verdict,
    won_by: winner.nodeId,
    reason: verdict.reason,
  };
}

module.exports = {
  STRATEGY_LABEL,
  RISK_ORDER,
  classify,
  tieBreak,
  pickWinner,
  compose,
  merge,
};
