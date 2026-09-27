/**
 * 分类结果 → 本系统风险等级（plugins/nsfwjs-image-guard/lib/mapping.js）
 *
 * nsfwjs 输出 5 类固定分数：Drawing / Hentai / Neutral / Porn / Sexy。
 * 本模块负责「阈值判定 → 类别映射 → ModerationVerdict 合成」，是纯函数，便于单测。
 *
 * ★ 风险阶梯：safe(0) < low(1) < medium(2) < review(3，保留位) < high(4) < critical(5)
 *   与 src/flow/risk.js 的 RISK_ORDER 保持同一阶梯。插件不能 require 核心模块，
 *   故此处在插件内自带一份只读副本（仅用于本插件内部的「取最严重」比较）。
 */
'use strict';

/** 风险序位（仅插件内部使用；序位定义与核心保持一致） */
const RISK_ORDER = Object.freeze({ safe: 0, low: 1, medium: 2, review: 3, high: 4, critical: 5 });

/** 输出 verdict 允许的风险等级（review 是链路失效态，不由内容判定产出） */
const OUTPUT_LEVELS = Object.freeze(['safe', 'low', 'medium', 'high', 'critical']);

/** nsfwjs 五个类别 */
const NSFW_CLASSES = Object.freeze(['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy']);

/** 默认「类别 → 风险等级」映射（可在插件配置 / 节点参数中覆盖） */
const DEFAULT_LEVEL_MAPPING = Object.freeze({
  Porn: 'high',
  Hentai: 'high',
  Sexy: 'medium',
  Drawing: 'safe',
  Neutral: 'safe',
});

/** 默认落库分类 id（对齐系统分类表中 pornographic 一项） */
const DEFAULT_CATEGORY_ID = 'pornographic';

/** 默认阈值 */
const DEFAULT_THRESHOLD = 0.6;

/** 默认取前 K 个预测写入 reason */
const DEFAULT_TOP_K = 3;

/**
 * 归一化「类别 → 风险等级」映射：补齐缺失类别、把非法/保留等级收敛为安全值。
 * @param {object} raw 用户配置的映射
 * @returns {Object<string, string>} 归一化后的映射
 */
function normalizeLevelMapping(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const cls of NSFW_CLASSES) {
    const value = String(src[cls] === undefined ? DEFAULT_LEVEL_MAPPING[cls] : src[cls]).toLowerCase();
    // review 不是内容判定结果，非法值一律回落到该类别默认值，避免出现「无意义的中间态」
    out[cls] = OUTPUT_LEVELS.includes(value) ? value : DEFAULT_LEVEL_MAPPING[cls];
  }
  return out;
}

/**
 * 取两个风险等级中更严重者。
 * @param {string} a 等级 A
 * @param {string} b 等级 B
 * @returns {string} 更严重的等级
 */
function maxLevel(a, b) {
  return (RISK_ORDER[a] || 0) >= (RISK_ORDER[b] || 0) ? a : b;
}

/**
 * 由 nsfwjs 预测结果合成 ModerationVerdict。
 * @param {Array<{className: string, probability: number}>} predictions 预测（任意顺序）
 * @param {{threshold?: number, topK?: number, levelMapping?: object, categoryId?: string, backend?: string}} [options] 选项
 * @returns {{
 *   verdict: {risk_level: string, categories: string[], category_scores: object, confidence: number, reason: string, suggestion: string},
 *   hits: Array<{className: string, probability: number, level: string}>
 * }}
 */
function buildVerdict(predictions, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold))
    ? Math.min(1, Math.max(0, Number(options.threshold)))
    : DEFAULT_THRESHOLD;
  const topK = Number.isFinite(Number(options.topK))
    ? Math.min(5, Math.max(1, Math.round(Number(options.topK))))
    : DEFAULT_TOP_K;
  const mapping = normalizeLevelMapping(options.levelMapping);
  const categoryId = typeof options.categoryId === 'string' && options.categoryId ? options.categoryId : DEFAULT_CATEGORY_ID;

  const list = (Array.isArray(predictions) ? predictions : [])
    .filter((p) => p && typeof p.className === 'string')
    .map((p) => ({ className: p.className, probability: Math.min(1, Math.max(0, Number(p.probability) || 0)) }))
    .sort((a, b) => b.probability - a.probability);

  // 命中 = 分数过阈值且映射到非 safe 的类别；多个命中取最严重者
  const hits = [];
  let riskLevel = 'safe';
  let winner = null;
  for (const p of list) {
    const level = mapping[p.className] || 'safe';
    if (p.probability < threshold || level === 'safe') continue;
    hits.push({ className: p.className, probability: p.probability, level });
    const isMoreSevere = !winner
      || RISK_ORDER[level] > RISK_ORDER[winner.level]
      || (RISK_ORDER[level] === RISK_ORDER[winner.level] && p.probability > winner.probability);
    if (isMoreSevere) {
      winner = { className: p.className, probability: p.probability, level };
      riskLevel = maxLevel(riskLevel, level);
    }
  }

  // confidence：命中取命中者的分数；未命中取模型判为 safe 的最高分（即「有多确信是安全内容」）
  let confidence = 0;
  if (winner) {
    confidence = winner.probability;
  } else {
    const safeTop = list.find((p) => (mapping[p.className] || 'safe') === 'safe');
    confidence = safeTop ? safeTop.probability : 0;
  }

  const breakdown = list.slice(0, topK)
    .map((p) => `${p.className}=${p.probability.toFixed(2)}`)
    .join(' ');
  const backendTag = options.backend ? `[${options.backend}]` : '';
  const reason = winner
    ? `nsfwjs${backendTag} ${breakdown} → 命中 ${winner.className}（阈值 ${threshold}）→ ${riskLevel}`
    : `nsfwjs${backendTag} ${breakdown} → 全部低于阈值 ${threshold} → safe`;

  const verdict = {
    risk_level: riskLevel,
    categories: winner ? [categoryId] : [],
    category_scores: winner ? { [categoryId]: Math.round(winner.probability * 100) } : {},
    confidence: Math.round(confidence * 1000) / 1000,
    reason: reason.slice(0, 200),
    suggestion: winner
      ? `按 nsfwjs 本地分类判定为「${winner.className}」，建议按 ${riskLevel} 等级处置`
      : 'nsfwjs 未发现达到阈值的 NSFW 类别',
  };

  return { verdict, hits };
}

module.exports = {
  RISK_ORDER,
  OUTPUT_LEVELS,
  NSFW_CLASSES,
  DEFAULT_LEVEL_MAPPING,
  DEFAULT_CATEGORY_ID,
  DEFAULT_THRESHOLD,
  DEFAULT_TOP_K,
  normalizeLevelMapping,
  maxLevel,
  buildVerdict,
};
