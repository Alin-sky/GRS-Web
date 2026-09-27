/**
 * WD14 标签 → 审核风险映射规则
 * 标签名 → { level, score, label }
 * level: safe/low/medium/high/critical；score 为对应 pornographic 维度分数
 */
const TAG_RULES = {
  // 明确色情 → critical
  'nude':               { level: 'critical', score: 90, label: '裸露' },
  'completely_nude':    { level: 'critical', score: 95, label: '完全裸露' },
  'sex':                { level: 'critical', score: 95, label: '性行为' },
  'vaginal':            { level: 'critical', score: 95, label: '性行为' },
  'penis':              { level: 'critical', score: 95, label: '性器官' },
  'nipples':            { level: 'critical', score: 90, label: '乳头裸露' },
  'pussy':              { level: 'critical', score: 95, label: '性器官' },
  // 明显性暗示 / 挑逗 → high
  'spread_legs':        { level: 'high', score: 80, label: '张腿挑逗' },
  'no_panties':         { level: 'high', score: 80, label: '真空/未穿内裤' },
  'underwear_only':     { level: 'high', score: 75, label: '只穿内衣' },
  'ahegao':             { level: 'high', score: 78, label: '高潮脸(性暗示)' },
  // 敏感部位 / 特写 → medium
  'barefoot':           { level: 'medium', score: 62, label: '裸足' },
  'feet':               { level: 'medium', score: 60, label: '脚部' },
  'foot_focus':         { level: 'medium', score: 62, label: '脚部特写' },
  'armpit':             { level: 'medium', score: 60, label: '腋下' },
  'cleavage':           { level: 'medium', score: 60, label: '乳沟' },
  'large_breasts':      { level: 'medium', score: 58, label: '大胸' },
  'panties':            { level: 'medium', score: 58, label: '内裤露出' },
  'underwear':          { level: 'medium', score: 55, label: '内衣' },
  'thighs':             { level: 'medium', score: 55, label: '大腿特写' },
  // 暴露服饰 → low
  'swimsuit':           { level: 'low', score: 45, label: '泳装' },
  'bikini':             { level: 'low', score: 45, label: '比基尼' },
  'bunny_suit':         { level: 'low', score: 45, label: '兔女郎' },
  'lingerie':           { level: 'low', score: 45, label: '情趣内衣' },
  'micro_bikini':       { level: 'medium', score: 58, label: '超暴露泳装' },
};

// rating 评级 → 等级映射（get_wd14_tags 返回的 rating 字段）
const RATING_RULES = {
  explicit:     { level: 'critical', score: 90, label: 'explicit 评级' },
  questionable: { level: 'high', score: 70, label: 'questionable 评级' },
  sensitive:    { level: 'medium', score: 55, label: 'sensitive 评级' },
  general:      { level: null, score: 0, label: 'general 评级' },
};

const LEVEL_ORDER = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * 规则默认值（单一真相：插件配置默认值与测试都引用这里，避免两处漂移）。
 */
const RULE_DEFAULTS = Object.freeze({
  generalThreshold: 0.35,
  scoreScale: 1.0,
  criticalTagMinScore: 0.60,
  ratingConflictGuard: true,
  ratingConflictMinConfidence: 0.70,
});

/** 冲突守卫触发降级时，命中落到 low 档（保留命中，只降不丢）。 */
const DOWNGRADE_LEVEL = 'low';
const DOWNGRADE_SCORE = 45;
const CONFLICT_GUARD_MARK = 'rating-conflict-guard';

/**
 * 把 WD14 标签结果映射为审核风险。
 *
 * 为什么是两道防线（而不是一道）：
 *   ① `criticalTagMinScore` —— critical 级标签此前只看 `generalThreshold`（那是**所有**标签共用的
 *      底线），于是刚过门槛的 `nude:0.39` 与高置信的 `nude:0.99` 产出**完全相同**的 critical/90；
 *      全白空图被判 critical 的真实误报即源于此。
 *   ② `ratingConflictGuard` —— rating 头与 general 头互相矛盾时此前无任何交叉校验：rating 已明确
 *      判「general（安全）」，一个刚过门槛的标签仍能把记录升到 critical。
 *
 * 可逆性：`criticalTagMinScore` 调到 ≤ `generalThreshold` **且** `ratingConflictGuard=false` 时，
 *   本函数的行为与新增这两道防线之前**逐字节等价**（见 scripts/test-wd14-rules.js 的对照用例）。
 *
 * @param {object} wd14Result - { available, rating, general, character }
 * @param {object} opts - { generalThreshold, scoreScale, criticalTagMinScore,
 *                          ratingConflictGuard, ratingConflictMinConfidence }
 * @returns { { available, rating, hits, suggestedLevel, suggestedScore } }
 */
function mapTagsToRisk(wd14Result, opts = {}) {
  const generalThreshold = opts.generalThreshold ?? RULE_DEFAULTS.generalThreshold;
  const scoreScale = opts.scoreScale ?? RULE_DEFAULTS.scoreScale;
  const criticalTagMinScore = opts.criticalTagMinScore ?? RULE_DEFAULTS.criticalTagMinScore;
  const ratingConflictGuard = opts.ratingConflictGuard ?? RULE_DEFAULTS.ratingConflictGuard;
  const ratingConflictMinConfidence = opts.ratingConflictMinConfidence
    ?? RULE_DEFAULTS.ratingConflictMinConfidence;
  if (!wd14Result || !wd14Result.available) {
    return { available: false, hits: [], suggestedLevel: null, suggestedScore: 0 };
  }
  const hits = [];
  let worstLevel = 'safe';
  let worstScore = 0;
  const scale = (s) => Math.min(100, Math.round(s * scoreScale));
  // 命中登记：严格取「等级更高者」作为建议等级（等级相同的先到先得，保持与旧行为一致）
  const consider = (hit) => {
    hits.push(hit);
    if (LEVEL_ORDER[hit.level] > LEVEL_ORDER[worstLevel]) {
      worstLevel = hit.level;
      worstScore = hit.score;
    }
  };

  // 1. rating 评级优先（取置信度最高的评级）
  const rating = wd14Result.rating || {};
  const ratingScores = Object.entries(rating).sort((a, b) => b[1] - a[1]);
  // 「rating 头明确判安全」：最高项是 general（level 为 null）且置信度够高。
  // 只有 general 才置位 —— explicit / questionable / sensitive 是 rating 自己认为有问题，不得触发守卫。
  let ratingSaysSafe = false;
  if (ratingScores.length > 0) {
    const [topRating, topScore] = ratingScores[0];
    const rule = RATING_RULES[topRating];
    if (rule && rule.level && topScore > 0.5) {
      consider({ tag: 'rating:' + topRating, level: rule.level, score: scale(rule.score), label: rule.label });
    }
    ratingSaysSafe = topRating === 'general' && topScore >= ratingConflictMinConfidence;
  }

  // 2. 具体标签映射
  const general = wd14Result.general || {};
  for (const [tag, score] of Object.entries(general)) {
    const rule = TAG_RULES[tag];
    if (!rule || score < generalThreshold) continue;
    // ① critical 级标签走独立高门槛：低置信度的它不该与高置信度等价
    if (rule.level === 'critical' && score < criticalTagMinScore) continue;
    // ② rating 明确判安全时，与之冲突的 critical/high 命中降级为 low ——
    //    保留命中并留痕（downgradedBy / originalLevel / originalScore），不静默丢弃。
    if (ratingConflictGuard && ratingSaysSafe
      && (rule.level === 'critical' || rule.level === 'high')) {
      consider({
        tag,
        level: DOWNGRADE_LEVEL,
        score: scale(DOWNGRADE_SCORE),
        label: rule.label,
        downgradedBy: CONFLICT_GUARD_MARK,
        originalLevel: rule.level,
        originalScore: scale(rule.score),
      });
      continue;
    }
    consider({ tag, level: rule.level, score: scale(rule.score), label: rule.label });
  }

  return {
    available: true,
    rating: Object.keys(rating).reduce((acc, k) => { acc[k] = Math.round(rating[k] * 100); return acc; }, {}),
    hits,
    suggestedLevel: hits.length > 0 ? worstLevel : null,
    suggestedScore: worstScore,
  };
}

module.exports = {
  TAG_RULES,
  RATING_RULES,
  LEVEL_ORDER,
  RULE_DEFAULTS,
  DOWNGRADE_LEVEL,
  DOWNGRADE_SCORE,
  CONFLICT_GUARD_MARK,
  mapTagsToRisk,
};
