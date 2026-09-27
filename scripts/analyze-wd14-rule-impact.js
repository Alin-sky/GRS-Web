#!/usr/bin/env node
/**
 * 影响面量化：用历史审核记录**重放新旧 WD14 规则**，量化改动会改变多少判定。
 *
 * 为什么用历史记录重放：审核记录里持久化了 `result.wd14_tags`（原始 rating/general/character
 *   置信度）+ `result.wd14_hits` / `wd14_level` / `wd14_score`。拿它喂回 mapTagsToRisk，
 *   就能在不重新调用云端、不重新计费的前提下，逐条对比「本次改动前后」的判定差异。
 *
 * 为什么脚本里保留一份「旧规则」副本：新行为上线后旧实现已不在代码里，而**旧结果就是比对的
 *   基线**，必须能独立复现；副本同时被用作「重放正确性」自检（旧规则重放结果应与记录里已落盘的
 *   wd14_hits/wd14_level/wd14_score 逐条一致，否则说明重放口径有误）。
 *
 * 用法：node scripts/analyze-wd14-rule-impact.js [--json]
 * 注意：data/audit_records/*.jsonl 是**活日志**（持续新增），本报告数字必须连同年份时间戳一起引用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { mapTagsToRisk, RULE_DEFAULTS } = require('../plugins/wd14-tagger/rules');

const AUDIT_DIR = process.env.GRS_AUDIT_DIR || path.join(__dirname, '..', 'data', 'audit_records');

/**
 * 旧规则（本次改动前的 mapTagsToRisk）——仅供本分析脚本做基线重放，勿在别处引用。
 * @param {object} wd14Result 标签结果
 * @param {object} opts 选项
 * @returns {object} 映射结果
 */
const RATING_RULES = {
  explicit: { level: 'critical', score: 90, label: 'explicit 评级' },
  questionable: { level: 'high', score: 70, label: 'questionable 评级' },
  sensitive: { level: 'medium', score: 55, label: 'sensitive 评级' },
  general: { level: null, score: 0, label: 'general 评级' },
};
const TAG_RULES = require('../plugins/wd14-tagger/rules').TAG_RULES;
const LEVEL_ORDER = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

function legacyMapTagsToRisk(wd14Result, opts = {}) {
  const generalThreshold = opts.generalThreshold ?? 0.35;
  const scoreScale = opts.scoreScale ?? 1.0;
  if (!wd14Result || !wd14Result.available) {
    return { available: false, hits: [], suggestedLevel: null, suggestedScore: 0 };
  }
  const hits = [];
  let worstLevel = 'safe';
  let worstScore = 0;
  const scale = (s) => Math.min(100, Math.round(s * scoreScale));
  const rating = wd14Result.rating || {};
  const ratingScores = Object.entries(rating).sort((a, b) => b[1] - a[1]);
  if (ratingScores.length > 0) {
    const [topRating, topScore] = ratingScores[0];
    const rule = RATING_RULES[topRating];
    if (rule && rule.level && topScore > 0.5) {
      hits.push({ tag: 'rating:' + topRating, level: rule.level, score: scale(rule.score), label: rule.label });
      if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[worstLevel]) { worstLevel = rule.level; worstScore = scale(rule.score); }
    }
  }
  const general = wd14Result.general || {};
  for (const [tag, score] of Object.entries(general)) {
    const rule = TAG_RULES[tag];
    if (rule && score >= generalThreshold) {
      hits.push({ tag, level: rule.level, score: scale(rule.score), label: rule.label });
      if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[worstLevel]) { worstLevel = rule.level; worstScore = scale(rule.score); }
    }
  }
  return {
    available: true,
    rating: Object.keys(rating).reduce((acc, k) => { acc[k] = Math.round(rating[k] * 100); return acc; }, {}),
    hits,
    suggestedLevel: hits.length > 0 ? worstLevel : null,
    suggestedScore: worstScore,
  };
}

const OLD_OPTS = { generalThreshold: 0.35, scoreScale: 1.0 };
const NEW_OPTS = {
  generalThreshold: 0.35,
  scoreScale: 1.0,
  criticalTagMinScore: RULE_DEFAULTS.criticalTagMinScore,
  ratingConflictGuard: RULE_DEFAULTS.ratingConflictGuard,
  ratingConflictMinConfidence: RULE_DEFAULTS.ratingConflictMinConfidence,
};

/** 读全部含 wd14_tags 的记录。 */
function loadRecords() {
  const files = fs.readdirSync(AUDIT_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(AUDIT_DIR, f), 'utf-8').split(/\r?\n/);
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let rec;
      try { rec = JSON.parse(ln); } catch { continue; }
      const r = rec.result || rec;
      if (!r || !r.wd14_tags) continue;
      const ref = r.image_ref || {};
      out.push({
        file: f,
        id: rec.id,
        timestamp: rec.timestamp,
        hash: ref.hash || null,
        bytes: ref.bytes || null,
        tags: r.wd14_tags,
        storedHits: r.wd14_hits || [],
        storedLevel: r.wd14_level,
        storedScore: r.wd14_score,
        risk: r.risk_level,
        isAnime: r.wd14_is_anime,
      });
    }
  }
  return out;
}

/** 命中数组的规范化签名（忽略字段顺序，只比 tag/level/score）。 */
function hitSig(hits) {
  return (hits || []).map((h) => `${h.tag}|${h.level}|${h.score}`).sort().join(',');
}

/** 主分析。 */
function analyze() {
  const records = loadRecords();
  const levelChanges = {};
  const scoreChanges = {};
  const changed = [];
  let oldCriticalRecs = 0;
  let newCriticalRecs = 0;
  let replayMismatch = 0;
  let oldCriticalHits = 0;
  let newCriticalHits = 0;
  let oldHighHits = 0;
  let newHighHits = 0;
  const removedHits = [];
  const downgradedHits = [];
  const criticalTagPresence = [];
  let criticalTagRecs = 0;

  const CRITICAL_TAGS = Object.keys(TAG_RULES).filter((t) => TAG_RULES[t].level === 'critical');

  for (const rec of records) {
    const input = { available: true, rating: rec.tags.rating || {}, general: rec.tags.general || {}, character: rec.tags.character || {} };
    const oldR = legacyMapTagsToRisk(input, OLD_OPTS);
    const newR = mapTagsToRisk(input, NEW_OPTS);

    // 重放正确性自检：旧规则重放须与记录里已落盘的判定一致
    if (hitSig(oldR.hits) !== hitSig(rec.storedHits)
      || (oldR.suggestedLevel || null) !== (rec.storedLevel || null)
      || (oldR.suggestedScore || 0) !== (rec.storedScore || 0)) {
      replayMismatch++;
    }

    // 语料里 critical 级标签的置信度分布（用于判断门槛会切掉什么）
    const g = rec.tags.general || {};
    const present = CRITICAL_TAGS.filter((t) => g[t] !== undefined && g[t] >= 0.35);
    if (present.length > 0) {
      criticalTagRecs++;
      const top = present.map((t) => ({ tag: t, conf: Number(g[t]) })).sort((a, b) => b.conf - a.conf)[0];
      criticalTagPresence.push({ hash: rec.hash, id: rec.id, timestamp: rec.timestamp, topTag: top.tag, conf: top.conf });
    }

    const oldLv = oldR.suggestedLevel || 'none';
    const newLv = newR.suggestedLevel || 'none';
    if (oldLv !== newLv) {
      const key = `${oldLv}->${newLv}`;
      levelChanges[key] = (levelChanges[key] || 0) + 1;
      changed.push({ hash: rec.hash, id: rec.id, timestamp: rec.timestamp, from: oldLv, to: newLv, oldScore: oldR.suggestedScore, newScore: newR.suggestedScore });
    }
    if ((oldR.suggestedScore || 0) !== (newR.suggestedScore || 0)) {
      const key = `${oldR.suggestedScore}->${newR.suggestedScore}`;
      scoreChanges[key] = (scoreChanges[key] || 0) + 1;
    }

    const oldCrit = oldR.hits.filter((h) => h.level === 'critical');
    const newCrit = newR.hits.filter((h) => h.level === 'critical');
    if (oldCrit.length > 0) oldCriticalRecs++;
    if (newCrit.length > 0) newCriticalRecs++;
    oldCriticalHits += oldCrit.length;
    newCriticalHits += newCrit.length;
    oldHighHits += oldR.hits.filter((h) => h.level === 'high').length;
    newHighHits += newR.hits.filter((h) => h.level === 'high').length;

    // 逐命中对比
    const oldByTag = new Map(oldR.hits.map((h) => [h.tag, h]));
    const newByTag = new Map(newR.hits.map((h) => [h.tag, h]));
    for (const [tag, oh] of oldByTag) {
      const nh = newByTag.get(tag);
      if (!nh) {
        const conf = tag.startsWith('rating:') ? (rec.tags.rating || {})[tag.slice(7)] : (rec.tags.general || {})[tag];
        removedHits.push({ hash: rec.hash, id: rec.id, timestamp: rec.timestamp, tag, level: oh.level, score: oh.score, conf: conf === undefined ? null : Number(conf) });
        continue;
      }
      if (nh.level !== oh.level) {
        const conf = tag.startsWith('rating:') ? (rec.tags.rating || {})[tag.slice(7)] : (rec.tags.general || {})[tag];
        downgradedHits.push({ hash: rec.hash, id: rec.id, timestamp: rec.timestamp, tag, fromLevel: oh.level, toLevel: nh.level, mark: nh.downgradedBy || null, conf: conf === undefined ? null : Number(conf) });
      }
    }
  }

  // 门槛敏感度：不同 criticalTagMinScore 下会改变多少判定（供「调回/调紧」决策）
  const sensitivity = [];
  for (const t of [0.35, 0.45, 0.50, 0.60, 0.70, 0.80, 0.90]) {
    let levelChangedCount = 0;
    let critRecs = 0;
    let removedCritHits = 0;
    let downgradedCritHits = 0;
    for (const rec of records) {
      const input = { available: true, rating: rec.tags.rating || {}, general: rec.tags.general || {}, character: rec.tags.character || {} };
      const base = legacyMapTagsToRisk(input, OLD_OPTS);
      const alt = mapTagsToRisk(input, { ...NEW_OPTS, criticalTagMinScore: t });
      if ((base.suggestedLevel || 'none') !== (alt.suggestedLevel || 'none')) levelChangedCount++;
      if (alt.hits.some((h) => h.level === 'critical')) critRecs++;
      for (const h of base.hits.filter((x) => x.level === 'critical')) {
        const nh = alt.hits.find((x) => x.tag === h.tag);
        if (!nh) removedCritHits++;
        else if (nh.level !== 'critical') downgradedCritHits++;
      }
    }
    sensitivity.push({ criticalTagMinScore: t, levelChanged: levelChangedCount, criticalRecords: critRecs, removedCritHits, downgradedCritHits });
  }

  return {
    snapshotAt: new Date().toISOString(),
    auditDir: AUDIT_DIR,
    totalWithTags: records.length,
    replayMismatch,
    levelChanged: changed.length,
    levelChangeDirections: levelChanges,
    scoreChanged: Object.values(scoreChanges).reduce((a, b) => a + b, 0),
    scoreChangeDirections: scoreChanges,
    criticalRecordsBefore: oldCriticalRecs,
    criticalRecordsAfter: newCriticalRecs,
    criticalHitsBefore: oldCriticalHits,
    criticalHitsAfter: newCriticalHits,
    highHitsBefore: oldHighHits,
    highHitsAfter: newHighHits,
    criticalTagRecs,
    criticalTagPresence: criticalTagPresence.slice(0, 30),
    removedHitCount: removedHits.length,
    downgradedHitCount: downgradedHits.length,
    removedHits: removedHits.slice(0, 30),
    downgradedHits: downgradedHits.slice(0, 30),
    thresholdSensitivity: sensitivity,
    changedSamples: changed.slice(0, 30),
  };
}

function render(res) {
  const L = [];
  const w = (s) => L.push(s);
  w('WD14 规则改动 · 影响面量化（历史记录重放）');
  w(`  快照时间戳：${res.snapshotAt}`);
  w(`  审计目录：${res.auditDir}`);
  w(`  含 wd14_tags 的样本数：${res.totalWithTags}`);
  w(`  重放自检不一致数（应为 0）：${res.replayMismatch}`);
  w('');
  w(`等级发生变化的记录数：${res.levelChanged}`);
  const dirs = Object.entries(res.levelChangeDirections).sort((a, b) => b[1] - a[1]);
  if (dirs.length === 0) w('  （无）');
  for (const [k, v] of dirs) w(`  ${k}：${v}`);
  w('');
  w(`建议分数发生变化的记录数：${res.scoreChanged}`);
  const sdirs = Object.entries(res.scoreChangeDirections).sort((a, b) => b[1] - a[1]);
  if (sdirs.length === 0) w('  （无）');
  for (const [k, v] of sdirs) w(`  ${k}：${v}`);
  w('');
  w(`含 critical 命中的记录：改前 ${res.criticalRecordsBefore} 条 → 改后 ${res.criticalRecordsAfter} 条`);
  w(`critical 命中条数：改前 ${res.criticalHitsBefore} → 改后 ${res.criticalHitsAfter}`);
  w(`high 命中条数：改前 ${res.highHitsBefore} → 改后 ${res.highHitsAfter}`);
  w('');
  w(`被门槛剔除的命中（低置信 critical）：${res.removedHitCount} 条`);
  for (const h of res.removedHits) w(`  [${h.hash || h.id}] ${h.tag} (${h.level}, ${h.score}, conf=${h.conf}) @ ${h.timestamp}`);
  w(`被冲突守卫降级的命中：${res.downgradedHitCount} 条`);
  for (const h of res.downgradedHits) w(`  [${h.hash || h.id}] ${h.tag} ${h.fromLevel}->${h.toLevel} mark=${h.mark} conf=${h.conf} @ ${h.timestamp}`);
  w('');
  w(`语料里含 critical 级标签（conf>=0.35）的记录：${res.criticalTagRecs} 条`);
  for (const h of res.criticalTagPresence) w(`  [${h.hash || h.id}] ${h.topTag}=${h.conf.toFixed(3)} @ ${h.timestamp}`);
  w('');
  w('门槛敏感度（改 criticalTagMinScore 对语料的影响；守卫保持默认开）：');
  for (const s of res.thresholdSensitivity) {
    w(`  minScore=${s.criticalTagMinScore} ⇒ 等级变化 ${s.levelChanged} 条，改后 critical 记录 ${s.criticalRecords} 条，`
      + `critical 命中 被剔除 ${s.removedCritHits} / 被守卫降级 ${s.downgradedCritHits}`);
  }
  w('');
  w('等级变化明细（最多 30 条）：');
  if (res.changedSamples.length === 0) w('  （无）');
  for (const c of res.changedSamples) w(`  [${c.hash || c.id}] ${c.from}(${c.oldScore}) -> ${c.to}(${c.newScore}) @ ${c.timestamp}`);
  return L.join('\n');
}

function main() {
  const res = analyze();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  else process.stdout.write(`${render(res)}\n`);
}

if (require.main === module) main();

module.exports = { analyze, render, legacyMapTagsToRisk, OLD_OPTS, NEW_OPTS };
