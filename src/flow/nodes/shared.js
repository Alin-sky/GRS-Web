/**
 * 节点公共工具（src/flow/nodes/shared.js）
 * 把「模型输出 → 可信判定」这一条链路上的**纯逻辑**集中于此，供内置节点与
 * moderator 旧引擎共用，避免两份实现漂移：
 * - extractJSON ：从模型原始输出抽取 JSON（含 think 标签剥离）
 * - sanitizeRawSnippet ：日志用脱敏截断
 * - matchesResultSchema：是否含可识别 risk_level
 * - normalizeVerdict ：经 security/output-schema 的 validateVerdict 强校验
 * - buildTextPrompt / buildImagePrompt：统一构造（PromptFence 包裹的）提示词
 * 本模块不持有任何审批结论，只是「把不可信输入变成结构化对象」的纯函数集合。
 */

'use strict';

const { loadConfig, getPrompt } = require('../../config');
const fence = require('../../security/prompt-fence');
const { validateVerdict } = require('../../security/output-schema');
const imagePolicy = require('../../image-policy');

/** 失败类型（与 moderator 旧引擎一致）。*/
const FAILURE_TYPE = Object.freeze({
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  HTTP: 'http',
  EMPTY: 'empty',
  PARSE: 'parse',
  SCHEMA: 'schema',
  UNKNOWN: 'unknown',
});

/**
 * 从模型回复中提取 JSON（剥离 think 标签，容忍 ```json 包裹与干扰文本）。
 * @param {string} text 模型原始输出
 * @returns {object|null} 解析结果
 */
function extractJSON(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
  if (!cleaned) cleaned = String(text).trim();
  cleaned = cleaned.replace(/^<\/?(think|thinking)>/gi, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // 继续尝试
  }

  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch {
      // 继续
    }
  }

  let lastEnd = cleaned.lastIndexOf('}');
  while (lastEnd !== -1) {
    let depth = 0;
    let start = -1;
    for (let i = lastEnd; i >= 0; i--) {
      if (cleaned[i] === '}') depth++;
      else if (cleaned[i] === '{') {
        depth--;
        if (depth === 0) { start = i; break; }
      }
    }
    if (start !== -1) {
      try {
        return JSON.parse(cleaned.substring(start, lastEnd + 1));
      } catch {
        // 继续找前一个 }
      }
    }
    lastEnd = cleaned.lastIndexOf('}', lastEnd - 1);
  }
  return null;
}

/**
 * 对模型原始输出做脱敏截断（仅保留前 100 字符，压平换行与控制字符）。
 * @param {string} raw 原始输出
 * @returns {string} 脱敏片段
 */
function sanitizeRawSnippet(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .substring(0, 100);
}

/**
 * 判断解析结果是否符合审核 schema（含可识别 risk_level）。
 * @param {object|null} parsed 解析结果
 * @param {string[]} validLevels 合法等级
 * @returns {boolean}
 */
function matchesResultSchema(parsed, validLevels) {
  if (!parsed || typeof parsed !== 'object') return false;
  return validLevels.includes(parsed.risk_level);
}

/**
 * 交叉校验配置（字段缺失按安全侧兜底）。
 * @returns {{enabled: boolean, minLevel: string, requirePolicyCanary: boolean, maxTextLen: number, maxHintLen: number}}
 */
function crossCheckConfig() {
  const config = loadConfig();
  const raw = (config.moderation && config.moderation.crossCheck) || {};
  return {
    enabled: raw.enabled !== false,
    minLevel: typeof raw.minLevel === 'string' ? raw.minLevel : 'medium',
    requirePolicyCanary: raw.requirePolicyCanary !== false,
    maxTextLen: Number.isFinite(raw.maxTextLen) ? raw.maxTextLen : fence.DEFAULT_LIMITS.text,
    maxHintLen: Number.isFinite(raw.maxHintLen) ? raw.maxHintLen : fence.DEFAULT_LIMITS.hint,
  };
}

/**
 * 已启用的分类 id 列表。
 * @returns {string[]} 分类 id
 */
function validCategoryIds() {
  const config = loadConfig();
  return (config.moderation.categories || []).map((c) => c.id);
}

/**
 * 经 OutputValidator 校验并规范化一条判定（失败一律返回 {ok:false}）。
 * @param {unknown} parsed 原始对象/字符串
 * @param {{nonce?: string, source?: string}} [ctx] 上下文
 * @returns {{ok: true, value: object, notes: string[]}|{ok: false, code: string, detail: string, notes: string[]}}
 */
function normalizeVerdict(parsed, ctx = {}) {
  const res = validateVerdict(parsed, {
    categories: validCategoryIds(),
    nonce: ctx.nonce || '',
    requirePolicyVersion: crossCheckConfig().requirePolicyCanary,
    source: ctx.source || 'model',
  });
  if (!res.ok) {
    return { ok: false, code: res.code, detail: res.detail, notes: res.notes || [] };
  }
  return { ok: true, value: { ...res.value }, notes: res.notes || [] };
}

/**
 * 构造文本审核提示词（system + 被 PromptFence 包裹的 userMessage）。
 * @param {{text: string, precheckHint?: string, model?: string}} input 输入
 * @returns {{systemPrompt: string, userMessage: string, nonce: string, neutralized: boolean, isSafeguard: boolean}}
 */
function buildTextPrompt(input) {
  const config = loadConfig();
  const model = input.model || (config.ollama && config.ollama.textModel) || '';
  const isSafeguard = String(model).includes('safeguard');
  const filePrompt = isSafeguard
    ? getPrompt(config.moderation.safeguardPromptFile || 'safeguard_moderation.md')
    : getPrompt(config.moderation.textPromptFile);
  const systemPrompt = fence.buildSystemPrompt(filePrompt);
  const cc = crossCheckConfig();
  const fenced = fence.wrap(
    { text: input.text, precheckHint: input.precheckHint || '' },
    { maxTextLen: cc.maxTextLen, maxHintLen: cc.maxHintLen },
  );
  return {
    systemPrompt,
    userMessage: fenced.userMessage,
    nonce: fenced.nonce,
    neutralized: fenced.neutralized,
    isSafeguard,
  };
}

/**
 * 构造图片审核的 system prompt（提示词文件 + 不变量规则 + 暴露/泳装策略段）。
 * v0.2.0（C·暴露档位）：策略段按 `moderation.imagePolicy.exposure.mode` 动态拼接，
 * `off` ⇒ 不注入（逐字节等于历史行为）。
 * **单一实现点**：新引擎（shared.buildImagePrompt）与旧引擎（moderator.legacyModerateImage）
 * 都经由本函数 ⇒ 两条路径的提示词永远一致，不存在漂移。
 * 这段是**产品契约**：改措辞必须用真实代码构造的提示词打真实 API 逐档回归
 * （scripts/test-image-policy.js），不能只看配置改了。
 * @returns {string} system prompt
 */
function buildImageSystemPrompt() {
  const config = loadConfig();
  const base = fence.buildSystemPrompt(getPrompt(config.moderation.imagePromptFile));
  const policy = imagePolicy.getImagePolicyCfg(config);
  const block = imagePolicy.exposurePolicyBlock(policy.exposureMode);
  // R8：肤色暴露度评分段（默认关闭 ⇒ '' ⇒ 提示词逐字节不变）
  const scoringBlock = imagePolicy.exposureScoringBlock(policy.exposureScoring && policy.exposureScoring.enabled);
  const tail = [block, scoringBlock].filter(Boolean).join('\n');
  return tail ? `${base}\n${tail}` : base;
}

/**
 * 构造图片审核提示词（system + 被 PromptFence 包裹的附带文字）。
 * @param {{text?: string}} input 输入（caption）
 * @returns {{systemPrompt: string, userContent: string, nonce: string, neutralized: boolean, captionPresent: boolean, exposureMode: string}}
 */
function buildImagePrompt(input = {}) {
  const config = loadConfig();
  const policy = imagePolicy.getImagePolicyCfg(config);
  const systemPrompt = buildImageSystemPrompt();
  const wrapped = fence.wrap({ caption: input.text || '' }, { maxCaptionLen: 1000 });
  const userContent = wrapped.blocks.caption
    ? `请审核图片本身，以及 GRS_CAPTION 定界块内的附带文字。\n${wrapped.userMessage}`
    : '请审核图片本身。';
  return {
    systemPrompt,
    userContent,
    nonce: wrapped.nonce,
    neutralized: wrapped.neutralized,
    captionPresent: Boolean(wrapped.blocks.caption),
    exposureMode: policy.exposureMode,
  };
}

module.exports = {
  FAILURE_TYPE,
  extractJSON,
  sanitizeRawSnippet,
  matchesResultSchema,
  crossCheckConfig,
  validCategoryIds,
  normalizeVerdict,
  buildTextPrompt,
  buildImageSystemPrompt,
  buildImagePrompt,
};
