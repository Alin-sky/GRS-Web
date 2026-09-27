/**
 * OutputValidator —— 输出侧强校验（架构 §2.3）
 *
 * 模型输出与插件返回值**共用同一实现**。任何不合规一律判为失败，
 * 绝不降级为 `low` / `pass`（那是 fail-open 的根因）。
 *
 * 本模块为纯函数，无 Express / 无插件依赖，可独立单元测试。
 */

'use strict';

const { POLICY_VERSION, delimiter } = require('./prompt-fence');

/** 失败码全集。`skipped` 表示通道未配置，不计失败。 */
const FAILURE_CODES = ['empty', 'timeout', 'parse', 'schema', 'enum', 'range', 'length', 'unsafe', 'network', 'skipped'];

/** 会导致失败（进 fail-closed）的失败码。 */
const FAILING_CODES = new Set(FAILURE_CODES.filter((c) => c !== 'skipped'));

/** 模型可输出的合法风险等级（不含 review —— 那是链路失效状态，不由模型给出）。 */
const RISK_LEVELS = ['safe', 'low', 'medium', 'high', 'critical'];

/**
 * 暴露场景枚举（R8）：与 risk_level / categories **正交**的展示维度。
 * 未知值一律归一为 `other`，且**不** fail-closed（异常值不得让整条审核失败）。
 */
const EXPOSURE_SCENES = Object.freeze([
  'none', 'daily', 'swimwear', 'sportswear', 'beach', 'pool', 'underwear', 'intimate', 'other',
]);

/** `exposure_scene` 缺失 / 未知时的归一值。 */
const EXPOSURE_SCENE_FALLBACK = 'other';

/** 顶层字段白名单，其余字段一律丢弃（含 __proto__ / constructor / prototype）。 */
const ALLOWED_TOP_LEVEL = new Set([
  'risk_level',
  'categories',
  'category_scores',
  'confidence',
  'reason',
  'suggestion',
  'image_description',
  'policy_version',
  'exposure_score',
  'exposure_scene',
]);

/** 自由文本字段长度上限。 */
const MAX_LENGTHS = { reason: 200, suggestion: 200, image_description: 500 };

/** HTML 标签（XSS 载体）。 */
const HTML_TAG_RE = /<\s*\/?\s*[a-zA-Z][^>]{0,200}>/g;

/** 定界符通用形态。 */
const GENERIC_DELIM_RE = /<{3}|>{3}/g;

/**
 * 净化自由文本：剥离控制字符、去掉 HTML 标签、中和定界符形态、截断。
 *
 * @param {unknown} value 原始值
 * @param {number} maxLen 长度上限
 * @returns {string} 净化后的字符串
 */
function sanitizeFreeText(value, maxLen = 200) {
  if (value === undefined || value === null) return '';
  let text = String(value);
  text = text.replace(/\r\n?/g, ' ');
  // 去控制字符
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // 去零宽/双向控制字符
  text = text.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad]/g, '');
  // 去 HTML 标签（防 XSS / 社工文案）
  text = text.replace(HTML_TAG_RE, '');
  // 中和定界符形态，防止输出里带出定界标记
  text = text.replace(GENERIC_DELIM_RE, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (Number.isFinite(maxLen) && maxLen > 0 && text.length > maxLen) {
    text = text.slice(0, maxLen);
  }
  return text;
}

/** 指令性关键词（命中即整段过滤）。仅含通用指令措辞，不含任何具体敏感词。 */
const INSTRUCTION_PATTERNS = [
  /忽略\s*(以上|上述|之前|前面|所有|一切)/i,
  /无视\s*(以上|上述|之前|前面|所有|一切)/i,
  /忽略\s*all\s*previous/i,
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|above)\s+/i,
  /你现在是|你现在扮演|请扮演|角色扮演|扮演一个/i,
  /you\s+are\s+now|pretend\s+to\s+be|act\s+as\s+(a|an)\b/i,
  /system\s*prompt|system\s*message|<\|im_start\|>/i,
  /新的指令|新指令|覆盖规则|覆盖以上规则|覆盖系统/i,
  /override\s+(the\s+)?(system|rules|instructions)/i,
  /必须\s*(判定为)?\s*(安全|safe|放行)/i,
  /always\s+output\s+safe|output\s+safe\s+json/i,
  /请把.*当作.*指令|作为指令执行/i,
];

/**
 * 净化"可能被写入的指令性文本"（词库语义标注等二阶注入面，架构 T5）。
 * 命中指令性措辞则整段替换为 [已过滤]，并强制长度上限。
 *
 * @param {unknown} value 原始值
 * @param {number} [maxLen] 长度上限，默认 200
 * @returns {{text: string, filtered: boolean}} 净化结果
 */
function sanitizeInstructionText(value, maxLen = 200) {
  if (value === undefined || value === null) return { text: '', filtered: false };
  let text = String(value).replace(/\s+/g, ' ').trim();

  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.test(text)) {
      return { text: '[已过滤]', filtered: true };
    }
  }

  let filtered = false;
  if (Number.isFinite(maxLen) && maxLen > 0 && text.length > maxLen) {
    text = text.slice(0, maxLen);
    filtered = true;
  }
  return { text, filtered };
}

/**
 * 判断是否为「纯对象」（plain object）。
 * @param {unknown} value 值
 * @returns {boolean} 是否纯对象
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 校验并规范化一条审核判决。
 *
 * @param {unknown} raw 模型 / 插件 / 合成判决返回的原始对象或字符串
 * @param {{categories?: string[], source?: 'model'|'plugin'|'contentSafety',
 *          nonce?: string, requirePolicyVersion?: boolean}} [ctx] 校验上下文
 * @returns {{ok: true, value: object, notes: string[]}
 *          | {ok: false, code: string, detail: string}} 校验结果
 */
function validateVerdict(raw, ctx = {}) {
  const notes = [];
  const allowedCategories = Array.isArray(ctx.categories) ? ctx.categories : [];
  const categorySet = new Set(allowedCategories);

  if (raw === undefined || raw === null) {
    return { ok: false, code: 'empty', detail: '判决为空' };
  }

  let candidate = raw;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed) return { ok: false, code: 'empty', detail: '判决为空字符串' };
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return { ok: false, code: 'parse', detail: '无法解析为 JSON' };
    }
  }

  if (!isPlainObject(candidate)) {
    return { ok: false, code: 'schema', detail: `顶层类型应为 JSON 对象，实际为 ${Array.isArray(candidate) ? 'array' : typeof candidate}` };
  }

  // ① 定界符泄漏检测（在取字段之前先看整串）
  if (ctx.nonce) {
    for (const kind of ['DATA', 'PRECHECK', 'CAPTION', 'TAGS']) {
      const open = delimiter(kind, ctx.nonce, false);
      const close = delimiter(kind, ctx.nonce, true);
      const serialized = JSON.stringify(candidate);
      if (serialized.includes(open) || serialized.includes(close)) {
        return { ok: false, code: 'unsafe', detail: '输出中泄漏了定界符标记' };
      }
    }
  }

  // ② 顶层字段白名单：其余一律丢弃（含 __proto__ / constructor / prototype）
  const clean = {};
  for (const key of Object.keys(candidate)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      notes.push(`dropped_field:${key}`);
      continue;
    }
    clean[key] = candidate[key];
  }

  // ③ risk_level：缺失或非法一律失败，不再默认 low
  const riskLevel = clean.risk_level;
  if (typeof riskLevel !== 'string' || !RISK_LEVELS.includes(riskLevel)) {
    return {
      ok: false,
      code: 'enum',
      detail: `risk_level 缺失或非法（应为 ${RISK_LEVELS.join('|')} 之一，实际为 ${JSON.stringify(riskLevel)}）`,
    };
  }

  // ④ categories：非数组按空处理；非法元素丢弃而非整条失败
  let categories = [];
  if (Array.isArray(clean.categories)) {
    categories = clean.categories.filter((c) => {
      if (typeof c !== 'string') return false;
      if (categorySet.size > 0 && !categorySet.has(c)) {
        notes.push(`dropped_category:${c}`);
        return false;
      }
      return true;
    });
    categories = [...new Set(categories)];
  } else if (clean.categories !== undefined) {
    notes.push('categories_not_array');
  }

  // ⑤ category_scores：键必须在类目白名单内，值 ∈ [0,100]，非数字按 0
  const categoryScores = {};
  if (isPlainObject(clean.category_scores)) {
    for (const [key, value] of Object.entries(clean.category_scores)) {
      if (categorySet.size > 0 && !categorySet.has(key)) {
        notes.push(`dropped_score_key:${key}`);
        continue;
      }
      const num = Number(value);
      categoryScores[key] = Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : 0;
    }
  }
  // 缺失的类目补 0，保证阈值评估拿到完整向量
  for (const catId of allowedCategories) {
    if (categoryScores[catId] === undefined) categoryScores[catId] = 0;
  }

  // ⑥ confidence：非数字 → 0（不取 0.5，避免虚高）
  const confidenceNum = Number(clean.confidence);
  const confidence = Number.isFinite(confidenceNum) ? Math.max(0, Math.min(1, confidenceNum)) : 0;

  // ⑦ 自由文本字段：过 sanitizeFreeText + 长度上限
  const reason = sanitizeFreeText(clean.reason, MAX_LENGTHS.reason);
  const suggestion = sanitizeFreeText(clean.suggestion, MAX_LENGTHS.suggestion);
  const value = {
    risk_level: riskLevel,
    categories,
    category_scores: categoryScores,
    confidence,
    reason,
    suggestion,
  };

  if (clean.image_description !== undefined) {
    value.image_description = sanitizeFreeText(clean.image_description, MAX_LENGTHS.image_description);
  }

  // ⑧ 哨兵字段：存在但被篡改 → 判 unsafe；缺失时按 requirePolicyVersion 决定
  if (clean.policy_version !== undefined) {
    if (clean.policy_version !== POLICY_VERSION) {
      return { ok: false, code: 'unsafe', detail: `policy_version 被篡改（期望 ${POLICY_VERSION}）` };
    }
    value.policy_version = clean.policy_version;
  } else if (ctx.requirePolicyVersion === true) {
    return { ok: false, code: 'unsafe', detail: '缺少哨兵字段 policy_version' };
  } else {
    notes.push('policy_version_missing');
  }

  // R8：暴露度正交维度（结果字段，不读写 risk_level；异常值归一而不 fail-closed）
  // 关闭态模型不输出该字段，此处整段不生效，保证逐字节等于历史行为（B1）。
  if (clean.exposure_score !== undefined) {
    value.exposure_score = normalizeExposureScore(clean.exposure_score);
  }
  if (clean.exposure_scene !== undefined) {
    value.exposure_scene = normalizeExposureScene(clean.exposure_scene);
  }

  return { ok: true, value: Object.freeze(value), notes };
}

/**
 * 判断失败码是否应进入 fail-closed。
 * @param {string} code 失败码
 * @returns {boolean} 是否应 fail-closed
 */
function isFailingCode(code) {
  return FAILING_CODES.has(code);
}

/**
 * 归一 `exposure_score`：只接受 0-100 的有限数，越界（`-5` / `130` / `"abc"` / `NaN`）归 `0`。
 * **不** fail-closed —— 这是只读展示维度，异常值不得让整条审核失败。
 * @param {unknown} value 原始值
 * @returns {number} 0-100 的整数；非法输入为 0
 */
function normalizeExposureScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) return 0;
  return Math.round(num);
}

/**
 * 归一 `exposure_scene`：只接受 `EXPOSURE_SCENES` 之一，未知 / 缺失归 `other`。
 * @param {unknown} value 原始值
 * @returns {string} 枚举值
 */
function normalizeExposureScene(value) {
  if (value === undefined || value === null) return EXPOSURE_SCENE_FALLBACK;
  const scene = String(value);
  return EXPOSURE_SCENES.includes(scene) ? scene : EXPOSURE_SCENE_FALLBACK;
}

module.exports = {
  FAILURE_CODES,
  FAILING_CODES,
  RISK_LEVELS,
  ALLOWED_TOP_LEVEL,
  EXPOSURE_SCENES,
  EXPOSURE_SCENE_FALLBACK,
  normalizeExposureScore,
  normalizeExposureScene,
  MAX_LENGTHS,
  POLICY_VERSION,
  validateVerdict,
  sanitizeFreeText,
  sanitizeInstructionText,
  isPlainObject,
  isFailingCode,
};
