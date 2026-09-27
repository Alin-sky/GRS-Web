/**
 * 关键词 / 正则规则编译与匹配（plugins/keyword-image-guard/lib/rules.js）
 *
 * ★ 安全约定：
 *   - 规则一律由插件配置提供，**不引用核心词库**；引用宿主词库时只经 ctx.precheck 拿
 *     「是否命中 + 分类 + 等级」，拿不到也绝不写出命中词原文；
 *   - 匹配结果中**不含命中词的原文**，只有「第几条规则 / 等级 / 分类 / 来源」这类元信息，
 *     因此插件的任何返回值、日志都不可能泄漏词表内容；
 *   - 规则条数、模式长度、单条文本长度均有上限，并做一次性 ReDoS 形态启发式拦截，
 *     避免用户写出灾难性回溯的正则把主流程拖死。
 */
'use strict';

/** 输出 verdict 允许的风险等级（review 是链路失效态，不由内容判定产出） */
const OUTPUT_LEVELS = Object.freeze(['safe', 'low', 'medium', 'high', 'critical']);

/** 命中等级序位（仅插件内部使用，与核心 RISK_ORDER 同一阶梯） */
const RISK_ORDER = Object.freeze({ safe: 0, low: 1, medium: 2, review: 3, high: 4, critical: 5 });

/** 上限（防止恶意/误配配置拖慢判定） */
const MAX_RULES = 500;
const MAX_PATTERN_LEN = 200;
const MAX_TEXT_LEN = 4096;
const MAX_HITS = 50;

/** 规则文本行格式：等级 | 模式 | 类型(plain/regex) | 分类(可选) | 说明(可选) */
const RULE_LINE_RE = /^\s*([a-z]+)\s*\|\s*(.*?)\s*(?:\|\s*([a-z]*)\s*(?:\|\s*([A-Za-z0-9_-]*)\s*(?:\|\s*(.*))?)?)?$/;

/** ReDoS 形态：括号内已有量词、括号外再叠量词（如 (a+)+ / (a|b*)*） */
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*][^()]*\)\s*[+*{]/;

/**
 * 版本化的「等级 → 置信度」基线（命中越严重越确定，属启发式，非模型分数）。
 */
const LEVEL_CONFIDENCE = Object.freeze({
  low: 0.5,
  medium: 0.7,
  high: 0.85,
  critical: 0.95,
});

/**
 * 转义正则元字符（plain 类型规则用）。
 * @param {string} text 原文
 * @returns {string} 转义后文本
 */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断模式是否具备典型灾难性回溯形态。
 * @param {string} pattern 正则源码
 * @returns {boolean} 是否高风险
 */
function isRiskyPattern(pattern) {
  return NESTED_QUANTIFIER_RE.test(pattern);
}

/**
 * 解析「行文本」形式的规则表。
 * @param {string} text 多行文本，每行 `等级|模式|类型|分类|说明`；`#` 开头为注释
 * @returns {{rules: Array<object>, errors: string[]}}
 */
function parseRulesText(text) {
  const rules = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = String(line).match(RULE_LINE_RE);
    if (!m) {
      errors.push(`第 ${index + 1} 行格式非法（应为「等级|模式|类型|分类|说明」）`);
      return;
    }
    const level = String(m[1] || '').toLowerCase();
    if (!OUTPUT_LEVELS.includes(level) || level === 'safe') {
      errors.push(`第 ${index + 1} 行等级非法：${m[1]}`);
      return;
    }
    rules.push({
      level,
      pattern: m[2] || '',
      type: (m[3] || 'plain').toLowerCase() === 'regex' ? 'regex' : 'plain',
      category: m[4] || '',
      label: m[5] || '',
    });
  });
  return { rules, errors };
}

/**
 * 编译规则集：归一化 + 合法性校验 + 正则预编译。
 * @param {{rules?: Array<object>, rulesText?: string, ignoreCase?: boolean}} input 规则输入
 * @returns {{rules: Array<object>, errors: string[], skipped: number}}
 */
function compileRules(input = {}) {
  const errors = [];
  let raw = Array.isArray(input.rules) ? input.rules.slice(0) : [];
  if (raw.length === 0 && typeof input.rulesText === 'string' && input.rulesText.trim()) {
    const parsed = parseRulesText(input.rulesText);
    raw = parsed.rules;
    errors.push(...parsed.errors);
  }

  const ignoreCase = input.ignoreCase !== false;
  const flags = ignoreCase ? 'i' : '';
  const compiled = [];
  let skipped = 0;

  for (const item of raw) {
    if (compiled.length >= MAX_RULES) { skipped++; continue; }
    if (!item || typeof item !== 'object') { skipped++; continue; }
    const level = String(item.level || '').toLowerCase();
    if (!OUTPUT_LEVELS.includes(level) || level === 'safe') { skipped++; continue; }
    const pattern = String(item.pattern === undefined ? '' : item.pattern);
    if (!pattern) { skipped++; continue; }
    if (pattern.length > MAX_PATTERN_LEN) { skipped++; continue; }

    const isRegex = String(item.type || 'plain').toLowerCase() === 'regex';
    if (isRegex && isRiskyPattern(pattern)) { skipped++; continue; }

    let re = null;
    try {
      re = new RegExp(isRegex ? pattern : escapeRegex(pattern), flags);
    } catch {
      skipped++;
      continue;
    }
    compiled.push({
      index: compiled.length,
      level,
      category: typeof item.category === 'string' ? item.category : '',
      label: typeof item.label === 'string' ? item.label : '',
      type: isRegex ? 'regex' : 'plain',
      regex: re,
    });
  }

  if (skipped > 0) errors.push(`${skipped} 条规则被跳过（格式非法 / 超长 / 高风险正则 / 超出 ${MAX_RULES} 条上限）`);
  return { rules: Object.freeze(compiled), errors, skipped };
}

/**
 * 对单条文本执行规则匹配。
 * @param {Array<object>} rules 已编译规则
 * @param {string} text 待匹配文本
 * @param {{source: string, maxHits?: number}} options 选项
 * @returns {Array<object>} 命中（不含命中词原文）
 */
function matchText(rules, text, options = {}) {
  const hits = [];
  const source = options.source || 'unknown';
  const maxHits = Number(options.maxHits) > 0 ? Number(options.maxHits) : MAX_HITS;
  const value = String(text || '').slice(0, MAX_TEXT_LEN);
  if (!value) return hits;

  for (const rule of rules) {
    if (hits.length >= maxHits) break;
    let hit = false;
    try {
      rule.regex.lastIndex = 0;
      hit = rule.regex.test(value);
    } catch {
      hit = false; // 正则运行时异常按「不命中」处理，绝不冒泡影响主流程
    }
    if (!hit) continue;
    hits.push({
      ruleIndex: rule.index,
      level: rule.level,
      category: rule.category,
      label: rule.label,
      source,
      kind: 'plugin-rule',
    });
  }
  return hits;
}

/**
 * 判断一批命中中的最高等级。
 * @param {Array<object>} hits 命中列表
 * @returns {string} 最高等级（无命中返回 safe）
 */
function maxLevel(hits) {
  let level = 'safe';
  for (const h of hits) {
    if ((RISK_ORDER[h.level] || 0) > (RISK_ORDER[level] || 0)) level = h.level;
  }
  return level;
}

/**
 * 取两个等级中更严重者。
 * @param {string} a 等级 A
 * @param {string} b 等级 B
 * @returns {string} 更严重者
 */
function atLeast(a, b) {
  return (RISK_ORDER[a] || 0) >= (RISK_ORDER[b] || 0) ? a : b;
}

/**
 * 由等级与命中数估算置信度（启发式，非模型分数）。
 * @param {string} level 等级
 * @param {number} hitCount 命中数
 * @returns {number} 0~1
 */
function confidenceOf(level, hitCount) {
  const base = LEVEL_CONFIDENCE[level] || 0.5;
  const bonus = Math.min(0.04, Math.max(0, hitCount - 1) * 0.01);
  return Math.round(Math.min(0.99, base + bonus) * 1000) / 1000;
}

module.exports = {
  OUTPUT_LEVELS,
  RISK_ORDER,
  MAX_RULES,
  MAX_PATTERN_LEN,
  MAX_TEXT_LEN,
  MAX_HITS,
  LEVEL_CONFIDENCE,
  escapeRegex,
  isRiskyPattern,
  parseRulesText,
  compileRules,
  matchText,
  maxLevel,
  atLeast,
  confidenceOf,
};
