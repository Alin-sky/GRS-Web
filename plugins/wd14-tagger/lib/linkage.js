/**
 * WD14 与视觉模型（VL）的联动策略（plugins/wd14-tagger/lib/linkage.js）
 *
 * 把原先硬编码在 src/moderator.js 里的「WD14 提级」逻辑抽离为**可配置策略**：
 *   6 种联动模式 × 4 种触发条件 × 4 种冲突策略 × 权重融合 × 动漫判定 × 熔断降级
 *
 * ★ 解耦：主流程（moderator.js）不再认识「wd14」，只认识 contribution.source
 *   与「谁注册了 moderation:image:linkage 这个事件」。
 */

const LEVELS = ['safe', 'low', 'medium', 'high', 'critical'];
const LEVEL_ORDER = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** critical 级标签（trigger=wd14_critical 时判定用） */
const CRITICAL_TAGS = new Set(['nude', 'completely_nude', 'sex', 'vaginal', 'penis', 'nipples', 'pussy']);
/** 二次元通用标签（animeDetect=wd14_general 时判定用） */
const ANIME_GENERAL_TAGS = new Set(['1girl', '1boy', 'anime', 'illustration', 'comic', 'monochrome', 'sketch']);

/** 默认值：与 v1.0.0 的硬编码行为等价（escalate + always + max） */
const LINKAGE_DEFAULTS = {
  'linkage.mode': 'escalate',
  'linkage.trigger': 'always',
  'linkage.uncertainBelow': 0.55,
  'linkage.scope': 'anime_only',
  'linkage.animeDetect': 'character_conf',
  'linkage.animeThreshold': 0.30,
  'linkage.onNonAnime': 'annotate',
  'linkage.conflict': 'max',
  'linkage.weightVl': 0.6,
  'linkage.weightWd14': 0.4,
  'linkage.scoreCap': 100,
  'linkage.onWd14Down': 'skip',
  'linkage.circuitFail': 3,
  'linkage.circuitCooldownSec': 300,
  'linkage.batchSkipVl': false,
  'linkage.batchResizePx': 512,
  'linkage.timeoutMs': 8000,
  'linkage.concurrency': 2,
  'linkage.probeOnStatus': true,
  'linkage.probeCacheMs': 5000,
};

/**
 * 数值钳制。
 * @param {number} v 值
 * @param {number} min 下界
 * @param {number} max 上界
 * @returns {number}
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * 把 WD14 贡献里的 `error` 归类为**规范原因码**（T08a）。
 *
 * ★ 为什么必需：此前不可用一律写 "标签服务不可用"，把「连不上 / 超时 / 熔断 / 真没配置」
 *   混成一句，用户据此查不出所以然。现在把真实原因透出到 `wd14_status` 与 `decision_source`。
 * @param {string} err 错误文本
 * @returns {'timeout'|'service-unreachable'|'service-error'} 规范原因码
 */
function wd14ReasonOf(err) {
  const s = String(err || '').toLowerCase();
  if (s.includes('超时') || s.includes('timeout') || s.includes('etimedout')) return 'timeout';
  if (s.includes('econnrefused') || s.includes('econnreset') || s.includes('enotfound')
    || s.includes('eai_again') || s.includes('ehostunreach') || s.includes('无法连接')
    || s.includes('不可达') || s.includes('connect')) return 'service-unreachable';
  return 'service-error';
}

/**
 * 读配置项（带默认值兜底）。
 * @param {object} cfg 配置对象（Proxy）
 * @param {string} key 键
 * @returns {any}
 */
function cfgOf(cfg, key) {
  const v = cfg ? cfg[key] : undefined;
  return v === undefined || v === null ? LINKAGE_DEFAULTS[key] : v;
}

/**
 * 取 VL（视觉模型）给出的色情分数。
 * @param {object} result 审核结果
 * @returns {number} 0-100
 */
function vlScoreOf(result) {
  const s = result && result.category_scores ? result.category_scores.pornographic : 0;
  return Number(s) || 0;
}

/**
 * 动漫图判定。
 * @param {object} contrib WD14 贡献
 * @param {object} cfg 配置
 * @returns {boolean}
 */
function detectAnime(contrib, cfg) {
  if (cfgOf(cfg, 'linkage.scope') === 'all') return true;
  const how = cfgOf(cfg, 'linkage.animeDetect');
  const threshold = Number(cfgOf(cfg, 'linkage.animeThreshold')) || 0.3;
  const tags = (contrib && contrib.tags) || {};
  if (how === 'rating_present') {
    return !!(tags.rating && Object.keys(tags.rating).length > 0);
  }
  if (how === 'wd14_general') {
    const general = tags.general || {};
    return Object.keys(general).some((k) => ANIME_GENERAL_TAGS.has(k));
  }
  // 默认：character_conf —— WD14 对真人照的 character 置信度通常 < 0.15
  const character = tags.character || {};
  let maxConf = 0;
  for (const v of Object.values(character)) {
    const n = Number(v) || 0;
    if (n > maxConf) maxConf = n;
  }
  return maxConf >= threshold;
}

/**
 * 触发条件判定。
 * @param {object} result 审核结果（VL）
 * @param {object} contrib WD14 贡献
 * @param {object} cfg 配置
 * @returns {boolean}
 */
function triggerMatched(result, contrib, cfg) {
  const trigger = cfgOf(cfg, 'linkage.trigger');
  if (trigger === 'always') return true;
  if (trigger === 'vl_uncertain') {
    const conf = Number(result && result.confidence) || 0;
    return conf < (Number(cfgOf(cfg, 'linkage.uncertainBelow')) || 0.55);
  }
  const hits = (contrib && contrib.risk && contrib.risk.hits) || [];
  if (trigger === 'wd14_critical') {
    return hits.some((h) => h && (h.level === 'critical' || CRITICAL_TAGS.has(h.tag)));
  }
  if (trigger === 'wd14_hit') return hits.length > 0;
  return true;
}

/**
 * 冲突策略：给定 VL 与 WD14 的等级，产出最终等级。
 * @param {string} vlLevel VL 等级
 * @param {string} wd14Level WD14 等级
 * @param {string} policy 策略：max / vl_wins / wd14_wins / review
 * @returns {{level: string, needsReview: boolean}}
 */
function applyConflict(vlLevel, wd14Level, policy) {
  const a = LEVEL_ORDER[vlLevel] || 0;
  const b = LEVEL_ORDER[wd14Level] || 0;
  let idx;
  if (policy === 'vl_wins') idx = a;
  else if (policy === 'wd14_wins') idx = b;
  else idx = Math.max(a, b); // max 与 review 都按 max 定级
  return { level: LEVELS[clamp(idx, 0, 4)], needsReview: policy === 'review' && a !== b };
}

/**
 * 加权融合打分（PRD §8.5）。
 * @param {number} vlScore VL 分数
 * @param {number} wd14Score WD14 分数
 * @param {object} cfg 配置
 * @returns {number} 融合分（0-scoreCap）
 */
function weightedScore(vlScore, wd14Score, cfg) {
  const wVl = Number(cfgOf(cfg, 'linkage.weightVl')) || 0.6;
  const wWd = Number(cfgOf(cfg, 'linkage.weightWd14')) || 0.4;
  const cap = Number(cfgOf(cfg, 'linkage.scoreCap')) || 100;
  const sum = wVl + wWd || 1;
  const raw = (wVl * vlScore + wWd * wd14Score) / sum;
  // 分歧惩罚：冲突越大越贴近两者中的较高者，避免被平均成 medium
  const divergence = Math.abs(vlScore - wd14Score) / 100;
  return clamp(Math.round(Math.max(raw, Math.max(vlScore, wd14Score) - divergence * 20)), 0, cap);
}

/**
 * 分数 → 等级（复用 moderation.thresholds.pornographic 的 log/block 阈值）。
 * @param {number} score 分数
 * @param {{logThreshold?: number, blockThreshold?: number}} thresholds 阈值
 * @returns {string} 等级
 */
function scoreToLevel(score, thresholds = {}) {
  const log = Number(thresholds.logThreshold) || 40;
  const block = Number(thresholds.blockThreshold) || 75;
  if (score >= block) return 'critical';
  if (score >= log + (block - log) * 0.5) return 'high';
  if (score >= log) return 'medium';
  if (score >= log * 0.6) return 'low';
  return 'safe';
}

/**
 * 创建联动解析器。
 * @param {Function} getConfig 取配置对象的函数（返回插件配置 Proxy）
 * @param {{getThresholds?: Function}} [options] 选项
 * @returns {object} { resolve, isCircuitOpen, recordFailure, recordSuccess, stats }
 */
function createLinkage(getConfig, options = {}) {
  let failCount = 0;
  let openUntil = 0;

  const stats = { calls: 0, degraded: 0, escalated: 0, circuitOpen: 0 };

  return {
    stats,

    /** 熔断器是否打开 */
    isCircuitOpen() {
      return Date.now() < openUntil;
    },

    /**
     * 记录一次失败，达到阈值则打开熔断器。
     * @returns {boolean} 是否刚触发熔断
     */
    recordFailure() {
      const cfg = getConfig();
      failCount++;
      if (failCount >= (Number(cfgOf(cfg, 'linkage.circuitFail')) || 3)) {
        openUntil = Date.now() + (Number(cfgOf(cfg, 'linkage.circuitCooldownSec')) || 300) * 1000;
        failCount = 0;
        stats.circuitOpen++;
        return true;
      }
      return false;
    },

    /** 记录一次成功，重置熔断计数 */
    recordSuccess() {
      failCount = 0;
      openUntil = 0;
    },

    /**
     * 解析最终审核结果：把 WD14 贡献按策略融合进 VL 结果。
     * @param {object} result 主流程审核结果（会被就地修改并返回）
     * @param {Array<object>} contributions 各插件的贡献
     * @returns {object} 最终审核结果
     */
    resolve(result, contributions) {
      const cfg = getConfig();
      const out = result || {};
      stats.calls++;

      const mode = cfgOf(cfg, 'linkage.mode');
      // 记录 VL 原始判定（供 UI 展示判定来源）
      if (out.vl_level === undefined) out.vl_level = out.risk_level;
      if (out.vl_reason === undefined) out.vl_reason = out.reason;

      const contrib = (contributions || []).find((c) => c && c.source === 'wd14');
      const thresholds = options.getThresholds ? (options.getThresholds() || {}) : {};

      // ─── WD14 真正不可用：没贡献 / 明确报错 / 插件禁用 / 熔断 ───
      // ★ T08a 关键区分：「服务调用成功但**无命中**（level=null）」**不算不可用**。
      //   此前把 `!contrib.risk.level` 也判为不可用 ⇒ 干净图片被报成「标签服务不可用」。
      const unavailable = !contrib || contrib.disabled || contrib.error;
      if (unavailable) {
        // ★ T08a：状态与文案必须反映**真实原因**（不再一律「标签服务不可用」）
        const realReason = this.isCircuitOpen() ? 'circuit_open'
          : (contrib && contrib.error ? wd14ReasonOf(contrib.error)
            : (contrib && contrib.disabled ? 'disabled' : 'no-configuration'));
        out.wd14_status = realReason;
        if (contrib && contrib.error) out.wd14_error = contrib.error;
        stats.degraded++;
        const detail = (contrib && contrib.error) ? `：${contrib.error}` : '';
        if (mode !== 'off' && mode !== 'annotate' && cfgOf(cfg, 'linkage.onWd14Down') === 'fail_closed') {
          // 失败关闭：提级到 high 并标记需人工复核，避免"模型挂了就放行"
          if ((LEVEL_ORDER[out.risk_level] || 0) < LEVEL_ORDER.high) {
            out.risk_level = 'high';
            out.action = 'block';
            out.passed = false;
          }
          out.needs_review = true;
          out.decision_source = `标签服务不可用（${realReason}${detail}），按失败关闭策略提级（需人工复核）`;
        } else {
          out.decision_source = `VL 模型判定（WD14 不可用：${realReason}${detail}；已跳过联动）`;
        }
        return out;
      }

      this.recordSuccess();

      // ─── 可用：记录标签（**即使无命中**也照记，level 可为 null）───
      out.wd14_status = 'ok';
      out.wd14_tags = contrib.tags;
      out.wd14_hits = (contrib.risk && contrib.risk.hits) || [];
      out.wd14_level = (contrib.risk && contrib.risk.level) || null;
      out.wd14_score = (contrib.risk && contrib.risk.score) || 0;

      if (mode === 'off') {
        out.decision_source = 'VL 模型判定（联动已关闭）';
        return out;
      }

      const isAnime = detectAnime(contrib, cfg);
      out.wd14_is_anime = isAnime;

      // 非动漫图：仅记录标签，不干预判定（默认 annotate）
      // 为什么只有 annotate 才早退：onNonAnime=ignore 的语义是「不区分动漫图」（约等于 scope=all），
      //   而不是「不干预」——选它就该继续走完整联动（对非动漫图也会提级/拦截）；且打标节点本身
      //   无条件调用标签服务，"ignore" 并不省 HTTP。
      if (!isAnime && cfgOf(cfg, 'linkage.onNonAnime') === 'annotate') {
        out.decision_source = 'VL 模型判定（非动漫图，标签器仅记录）';
        return out;
      }

      if (mode === 'annotate') {
        out.decision_source = 'VL 模型判定（观察期：仅记录标签，不干预判定）';
        return out;
      }

      if (!triggerMatched(out, contrib, cfg)) {
        out.decision_source = 'VL 模型判定（未满足联动触发条件）';
        return out;
      }

      const vlLevel = out.risk_level || 'safe';
      const wd14Level = (contrib.risk && contrib.risk.level) || 'safe';
      const vlScore = vlScoreOf(out);
      const wd14Score = Number(contrib.risk && contrib.risk.score) || 0;
      const conflict = cfgOf(cfg, 'linkage.conflict');

      let finalLevel;
      let finalScore;

      if (mode === 'weighted') {
        finalScore = weightedScore(vlScore, wd14Score, cfg);
        finalLevel = scoreToLevel(finalScore, thresholds);
      } else if (mode === 'escalate_deescalate') {
        const c = applyConflict(vlLevel, wd14Level, conflict === 'max' || conflict === 'review' ? 'wd14_wins' : conflict);
        finalLevel = c.level;
        finalScore = Math.max(vlScore, wd14Score);
        if (c.needsReview) out.needs_review = true;
      } else {
        // escalate（默认，等价 v1.0.0 行为）与 parallel_max 均取 max
        const c = applyConflict(vlLevel, wd14Level, conflict);
        finalLevel = c.level;
        finalScore = Math.max(vlScore, wd14Score);
        if (c.needsReview) out.needs_review = true;
      }

      out.linkage_mode = mode;
      out.wd14_final_level = finalLevel;

      const before = LEVEL_ORDER[vlLevel] || 0;
      const after = LEVEL_ORDER[finalLevel] || 0;
      if (after > before) {
        out.risk_level = finalLevel;
        out.action = finalLevel === 'critical' ? 'block_alert' : 'block';
        out.passed = false;
        if (!out.category_scores) out.category_scores = {};
        if (finalScore > (out.category_scores.pornographic || 0)) out.category_scores.pornographic = finalScore;
        if (!Array.isArray(out.categories)) out.categories = [];
        if (!out.categories.includes('pornographic')) out.categories.push('pornographic');
        out.plugin_override = true;
        out.plugin_source = 'wd14';
        stats.escalated++;
        out.decision_source = `标签器提级（VL 原判 ${vlLevel} → 标签器判 ${wd14Level}，模式=${mode}，动漫图=${isAnime ? '是' : '否'}）`;
        const hitTags = ((contrib.risk && contrib.risk.hits) || []).slice(0, 5).map((h) => `${h.label || h.tag}(${h.level})`).join('、');
        if (hitTags) out.reason = `${out.reason || ''}${out.reason ? '｜' : ''}标签器命中：${hitTags}`;
      } else if (after < before && mode === 'escalate_deescalate') {
        out.risk_level = finalLevel;
        out.plugin_override = true;
        out.plugin_source = 'wd14';
        out.decision_source = `标签器降级（VL 原判 ${vlLevel} → 标签器判 ${wd14Level}，模式=${mode}）`;
      } else {
        out.decision_source = `VL 模型判定（标签器一致，未改判；模式=${mode}）`;
      }
      return out;
    },
  };
}

module.exports = {
  createLinkage,
  LINKAGE_DEFAULTS,
  LEVELS,
  LEVEL_ORDER,
  CRITICAL_TAGS,
  ANIME_GENERAL_TAGS,
  clamp,
  detectAnime,
  triggerMatched,
  applyConflict,
  weightedScore,
  scoreToLevel,
};
