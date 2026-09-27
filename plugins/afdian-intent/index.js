/**
 * 爱发电输入意图分类插件（plugins/afdian-intent/index.js）
 *
 * 定位：为 afdian-rank（爱发电充电榜）的昵称/留言提供**意图分类**（praise/request/private/ad/normal），
 *   与 GRS 风险审核本体**解耦**——不改任何核心文件，通过既有「插件 RPC → HTTP」桥暴露独立端点：
 *     POST /api/p/afdian-intent/rpc   body: { method:'moderate', params:{ text, userId?, groupId?, scene? } }
 *     → { result: { passed, action, risk_level, categories, confidence, reason,   // 标准契约（风险审核）
 *                   intent, intent_confidence, intent_matched } }                  // 新增：意图
 *
 * 流程：① 可选地经注入的 moderator 服务跑 GRS 风险审核（复用核心，不变）；
 *       ② lib/intent 规则引擎判意图；③ 合并：把意图映射进 categories
 *          （request→request / private→solicitation / ad→ad，均在客户端 hideCategories 内 ⇒ 零改动即隐藏）。
 *
 * ★ 解耦与边界：不 require 任何核心模块（只用 ctx.inject 的 moderator/logger/config）；纯 JS 零额外依赖。
 * ★ fail-open：风险审核不可用/异常 ⇒ 降级为「仅意图分类」，绝不抛错（dispatchRpc 会转 500，故本插件内部兜底）。
 * ★ 防误隐：praise/normal 不向 categories/reason 注入任何 hideCategories 词（reason 保持 GRS 原文，
 *   规避客户端 `reason.includes('ad')` 之类子串误隐）。
 */

'use strict';

const {
  classifyIntent, mergeIntent, INTENT_TO_CATEGORY, HIDE_CATEGORIES,
  DEFAULT_REQUEST_WORDS, DEFAULT_PRIVATE_WORDS, DEFAULT_AD_WORDS, DEFAULT_PRAISE_WORDS,
} = require('./lib/intent');

/** 插件 id（与 manifest.id 一致）*/
const PLUGIN_ID = 'afdian-intent';

/**
 * 解析词表配置（textarea：换行/逗号/顿号/分号分隔）。留空 ⇒ 用内置默认词表。
 * @param {*} s 配置值
 * @param {string[]} fallback 内置默认
 * @returns {string[]} 词表
 */
function parseWordList(s, fallback) {
  if (typeof s !== 'string' || !s.trim()) return fallback.slice();
  const arr = s.split(/[\n,，、;；]+/).map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : fallback.slice();
}

/** 插件配置表单（结构受 scripts/lint-plugin-config-schema.js 校验）*/
const CONFIG_SCHEMA = {
  name: PLUGIN_ID,
  title: '爱发电输入意图分类',
  version: '1.0.0',
  description: '对爱发电昵称/留言做意图分类（致意/求助/私聊/广告/正常），把求助·私聊·广告映射进客户端 hideCategories 以隐藏留言。独立 RPC 端点，与审核本体解耦。',
  groups: [
    { id: 'basic', title: '基础', desc: '开关、是否附带风险审核、严格程度。' },
    { id: 'words', title: '意图词表', desc: '每行一个词/短语；留空则用内置默认词表。改动即时生效。' },
  ],
  fields: [
    { key: 'enabled', type: 'switch', label: '启用意图分类', default: true, group: 'basic', desc: '关闭后端点只返回透传结果（intent=normal，不隐藏任何留言）。' },
    { key: 'runRiskModeration', type: 'switch', label: '附带 GRS 风险审核', default: true, group: 'basic', desc: '开启则端点返回「风险审核 + 意图」合一结果；关闭则只做意图分类（更快、不计费）。' },
    { key: 'strictness', type: 'select', label: '风险审核严格程度', default: 'standard', group: 'basic', options: [
      { value: 'relaxed', label: '宽松' }, { value: 'standard', label: '标准' }, { value: 'strict', label: '严格' },
    ], desc: '仅在「附带风险审核」开启时生效。' },
    { key: 'requestWords', type: 'textarea', label: '求助(request)词表', default: '', group: 'words', desc: '命中即判 request → 映射 category「request」。留空用内置默认。' },
    { key: 'privateWords', type: 'textarea', label: '私聊(private)词表', default: '', group: 'words', desc: '命中即判 private → 映射 category「solicitation」。留空用内置默认（含联系方式正则）。' },
    { key: 'adWords', type: 'textarea', label: '广告(ad)词表', default: '', group: 'words', desc: '命中即判 ad → 映射 category「ad」。留空用内置默认（含链接正则）。' },
    { key: 'praiseWords', type: 'textarea', label: '致意(praise)词表', default: '', group: 'words', desc: '命中判 praise（不隐藏）。留空用内置默认。' },
  ],
};

/**
 * 插件入口（cordis apply）。
 * @param {object} ctx cordis 上下文
 * @returns {void}
 */
function afdianIntent(ctx) {
  const logger = (ctx && ctx.logger) || console;
  const moderator = typeof ctx.inject === 'function' ? ctx.inject('moderator', false) : null;

  /** 读当前配置（每次取最新，支持运行期改配置即时生效）。*/
  function cfg() {
    try { return (typeof ctx.config === 'function' ? ctx.config(CONFIG_SCHEMA) : {}) || {}; } catch { return {}; }
  }
  /** 由配置构建分类器 opts（词表留空回落内置默认）。*/
  function intentOpts() {
    const c = cfg();
    return {
      requestWords: parseWordList(c.requestWords, DEFAULT_REQUEST_WORDS),
      privateWords: parseWordList(c.privateWords, DEFAULT_PRIVATE_WORDS),
      adWords: parseWordList(c.adWords, DEFAULT_AD_WORDS),
      praiseWords: parseWordList(c.praiseWords, DEFAULT_PRAISE_WORDS),
    };
  }

  /**
   * 主方法：风险审核（可选）+ 意图分类，合并返回标准契约 + intent。
   * @param {object} params { text, userId?, groupId?, scene? }
   * @returns {Promise<object>} 合并结果
   */
  async function moderate(params = {}) {
    const text = String(params && (params.text != null ? params.text : params.content) || '');
    const c = cfg();
    // 关闭：透传（intent=normal，不注入任何隐藏信号），保证客户端不会因本插件误隐
    if (c.enabled === false) {
      return {
        passed: true, action: 'pass', risk_level: 'safe', categories: [], confidence: 0,
        reason: '意图插件已关闭', type: 'text', intent: 'normal', intent_confidence: 0, intent_matched: [],
      };
    }
    let risk = null;
    if (c.runRiskModeration !== false && moderator && typeof moderator.moderateText === 'function' && text.trim()) {
      try {
        risk = await moderator.moderateText(text, {
          userId: params.userId, groupId: params.groupId, scene: params.scene || 'afdian-rank',
        }, { strictness: c.strictness });
      } catch (e) {
        logger.warn(`[${PLUGIN_ID}] 风险审核调用失败，降级为仅意图分类: ${e && e.message}`);
        risk = null;
      }
    }
    const base = risk || {
      passed: true, action: 'pass', risk_level: 'safe', categories: [], confidence: 0,
      reason: text.trim() ? '风险审核不可用，仅意图分类' : '空内容', type: 'text',
    };
    return mergeIntent(base, text, intentOpts());
  }

  // 公开读方法（无需密码）：POST /api/p/afdian-intent/rpc { method, params }
  ctx.rpc('moderate', moderate);
  // 仅意图分类（调试 / 验收用，不触发风险审核、不计费）
  ctx.rpc('classify', (params = {}) => classifyIntent(String((params && params.text) || ''), intentOpts()));
  // 状态自报
  ctx.rpc('status', () => ({
    ready: cfg().enabled !== false,
    enabled: cfg().enabled !== false,
    runRiskModeration: cfg().runRiskModeration !== false,
    moderatorAvailable: Boolean(moderator && typeof moderator.moderateText === 'function'),
    intentToCategory: INTENT_TO_CATEGORY,
    hideCategories: HIDE_CATEGORIES,
    endpoint: `POST /api/p/${PLUGIN_ID}/rpc  {method:'moderate',params:{text}}`,
  }));

  ctx.provide('afdianIntent', {
    name: PLUGIN_ID,
    moderate,
    classify: (t) => classifyIntent(String(t || ''), intentOpts()),
    INTENT_TO_CATEGORY,
    HIDE_CATEGORIES,
    schema: CONFIG_SCHEMA,
  });

  logger.info(`[${PLUGIN_ID}] 已装载（端点 POST /api/p/${PLUGIN_ID}/rpc {method:'moderate'}；风险审核=${moderator ? '可用' : '不可用→仅意图'}）`);
}

Object.defineProperty(afdianIntent, 'name', { value: PLUGIN_ID, configurable: true });
afdianIntent.description = '爱发电输入意图分类（praise/request/private/ad/normal），独立 RPC 端点，与审核本体解耦';
afdianIntent.version = '1.0.0';

module.exports = afdianIntent;
module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;
module.exports.CONFIG_SCHEMA = CONFIG_SCHEMA;
module.exports.parseWordList = parseWordList;
