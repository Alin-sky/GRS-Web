/**
 * afdian-intent 意图分类规则引擎（plugins/afdian-intent/lib/intent.js）
 *
 * 纯逻辑、零依赖：对「爱发电用户输入」（昵称/留言，≤200 字）做意图分类。
 * 意图：praise（致意）/ request（求助办事）/ private（私聊联系方式）/ ad（广告交易）/ normal。
 * 处置：request/private/ad → 映射进客户端 hideCategories 使其隐藏留言；praise/normal → 不隐藏。
 *
 * 设计原则（对齐需求「宁可误隐不可漏放」）：
 * - 隐藏类意图（request/private/ad）优先级高于 praise/normal：只要有隐藏信号就判隐藏类。
 * - 词表/正则可由 opts 覆盖（插件配置表单驱动），无需改代码即可调规则。
 * - 置信度 ∈ [0,1]，随命中信号数上升。
 */

'use strict';

/** 客户端 hideCategories（与 afdian-rank 默认配置一致）：用于映射校验与 reason 泄漏防护。*/
const HIDE_CATEGORIES = Object.freeze([
  'request', 'inquiry', 'transaction', 'solicitation', 'marketing', 'ad', 'advertisement',
]);

/** intent → 客户端可隐藏的 category（praise/normal 不映射 ⇒ 不隐藏）。*/
const INTENT_TO_CATEGORY = Object.freeze({
  request: 'request',
  private: 'solicitation',
  ad: 'ad',
  praise: null,
  normal: null,
});

// ─── 默认词表 / 正则（可被 opts 覆盖）───
const DEFAULT_REQUEST_WORDS = [
  '查询', '查一下', '查下', '请问', '问下', '问一下', '帮我', '帮个忙', '帮帮忙', '麻烦', '能不能', '能否', '可否',
  '想要', '想要一个', '求助', '求个', '求一个', '日志', '好商量', '有人能', '有人会', '怎么办', '怎么做', '怎么充',
  '如何', '拜托', '能帮', '看下', '看看能不能', '麻烦帮',
];
const DEFAULT_PRIVATE_WORDS = [
  '私聊', '私信', '私下', '加好友', '加微信', '加个微信', '加我', '联系方式', '电话', '手机号', '微信', 'QQ', 'qq',
  'vx', 'VX', 'v信', 'V信', '扣扣', '详聊', '私我', '加个好友',
];
const DEFAULT_AD_WORDS = [
  '代购', '出售', '转让', '优惠', '折扣', '促销', '客服', '下单', '推广', '招代理', '代理', '兼职', '日赚', '月入',
  '低价', '甩卖', '特价', '广告', '批发', '加盟', '五折', '几折', '招商', '微商', '便宜出', '全新正品', '接单', '引流',
];
const DEFAULT_PRAISE_WORDS = [
  '加油', '坚持', '支持', '喜欢', '爱你', '爱您', '谢谢', '感谢', '很棒', '真棒', '点赞', '努力', '继续做', '做下去',
  '冲冲冲', '太好', '辛苦了', '口牙', '棒棒', '了不起', '敬佩', '暖心',
];
/** 联系方式正则（手机号 / 长数字串 QQ / 邮箱）。*/
const DEFAULT_PRIVATE_REGEXES = ['1[3-9]\\d{9}', '\\d{7,}', '[\\w.+-]+@[\\w-]+\\.[A-Za-z]{2,}'];
/** 广告链接正则。*/
const DEFAULT_AD_REGEXES = ['https?://', 'www\\.', '[\\w-]+\\.(com|cn|net|top|xyz|shop|cc)([/\\s]|$)'];

/**
 * 把词表/正则规整为数组（opts 提供则用 opts，否则用默认）。
 * @param {*} fromOpts opts 里的值
 * @param {string[]} defaults 默认值
 * @returns {string[]} 字符串数组
 */
function listOr(fromOpts, defaults) {
  return Array.isArray(fromOpts) ? fromOpts.map(String) : defaults;
}

/**
 * 收集文本命中的信号（词表子串 + 正则）。
 * @param {string} text 归一化后的文本
 * @param {string[]} words 词表
 * @param {string[]} regexSources 正则源串
 * @returns {string[]} 命中信号（去重）
 */
function matchSignals(text, words, regexSources) {
  const hits = [];
  for (const w of words) {
    if (w && text.includes(w)) hits.push(w);
  }
  for (const src of regexSources) {
    try {
      const re = new RegExp(src, 'i');
      const m = text.match(re);
      if (m) hits.push(`re:${m[0].slice(0, 24)}`);
    } catch { /* 非法正则忽略 */ }
  }
  return [...new Set(hits)];
}

/**
 * 由命中数计算置信度（∈[0.55,0.99]，命中越多越高）。
 * @param {number} n 命中信号数
 * @returns {number} 置信度
 */
function confidenceOf(n) {
  if (n <= 0) return 0;
  return Math.min(0.99, 0.55 + 0.12 * n);
}

/**
 * 对文本做意图分类。
 * @param {string} text 待分类文本
 * @param {object} [opts] 可覆盖词表/正则：{requestWords,privateWords,adWords,praiseWords,privateRegexes,adRegexes}
 * @returns {{intent:string, confidence:number, matched:string[], category:string|null}}
 */
function classifyIntent(text, opts = {}) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { intent: 'normal', confidence: 0.4, matched: [], category: null };

  const o = opts && typeof opts === 'object' ? opts : {};
  const reqWords = listOr(o.requestWords, DEFAULT_REQUEST_WORDS);
  const priWords = listOr(o.privateWords, DEFAULT_PRIVATE_WORDS);
  const adWords = listOr(o.adWords, DEFAULT_AD_WORDS);
  const praiseWords = listOr(o.praiseWords, DEFAULT_PRAISE_WORDS);
  const priRegex = listOr(o.privateRegexes, DEFAULT_PRIVATE_REGEXES);
  const adRegex = listOr(o.adRegexes, DEFAULT_AD_REGEXES);

  const reqHits = matchSignals(raw, reqWords, []);
  const priHits = matchSignals(raw, priWords, priRegex);
  const adHits = matchSignals(raw, adWords, adRegex);
  const praiseHits = matchSignals(raw, praiseWords, []);

  // 隐藏类意图优先（宁可误隐不漏放）：只要有任一隐藏信号就在隐藏类里取命中最多者
  const hide = [
    { intent: 'request', hits: reqHits },
    { intent: 'private', hits: priHits },
    { intent: 'ad', hits: adHits },
  ].filter((x) => x.hits.length > 0);

  if (hide.length > 0) {
    hide.sort((a, b) => b.hits.length - a.hits.length);   // 命中多者优先；稳定排序保留 request>private>ad 的并列优先级
    const top = hide[0];
    return { intent: top.intent, confidence: confidenceOf(top.hits.length), matched: top.hits, category: INTENT_TO_CATEGORY[top.intent] };
  }

  if (praiseHits.length > 0) {
    return { intent: 'praise', confidence: confidenceOf(praiseHits.length), matched: praiseHits, category: null };
  }

  return { intent: 'normal', confidence: 0.4, matched: [], category: null };
}

/**
 * 把意图分类结果并入 GRS 风险审核结果（保留原契约字段，新增 intent/categories）。
 * 关键：praise/normal 时**不**向 categories/reason 注入任何 hideCategories 词，
 * 避免客户端 `reason.includes(hideWord)` / `categories∩hideCategories` 误隐正常留言。
 * @param {object} riskResult GRS 风险审核结果（passed/action/risk_level/categories/confidence/reason）
 * @param {string} text 原始文本
 * @param {object} [opts] 分类器 opts
 * @returns {object} 合并后的结果（含 intent / intent_confidence / intent_matched）
 */
function mergeIntent(riskResult, text, opts) {
  const base = riskResult && typeof riskResult === 'object' ? riskResult : {};
  const ir = classifyIntent(text, opts);
  const categories = Array.isArray(base.categories) ? base.categories.slice() : [];
  if (ir.category && !categories.includes(ir.category)) categories.push(ir.category);
  return Object.assign({}, base, {
    categories,
    intent: ir.intent,
    intent_confidence: ir.confidence,
    intent_matched: ir.matched,
    // reason 原样保留（不拼接英文意图词，规避 'ad' 等子串泄漏触发客户端 reason.includes 误隐）
  });
}

module.exports = {
  classifyIntent,
  mergeIntent,
  INTENT_TO_CATEGORY,
  HIDE_CATEGORIES,
  DEFAULT_REQUEST_WORDS,
  DEFAULT_PRIVATE_WORDS,
  DEFAULT_AD_WORDS,
  DEFAULT_PRAISE_WORDS,
};
