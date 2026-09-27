/**
 * afdian-intent 意图分类回归 —— scripts/test-afdian-intent.js
 *
 * 运行：./runtime/node/node.exe scripts/test-afdian-intent.js
 *
 * 样本来源：al1s-agengt-work/koishi-app-new/data/afdian-rank/decisions_2026-09.json 的 7 条真实留言
 *   + 自造 private/ad 各 5 条（需求验收：request/private/ad 召回 100%，整体准确率 ≥90%，
 *   praise/normal 不得被隐藏；客户端 hideCategories=request/inquiry/transaction/solicitation/marketing/ad/advertisement）。
 *
 * 覆盖：
 *   C. classifyIntent 逐意图（真实样本 + 自造 + 边界）
 *   M. intent→category 映射（request→request / private→solicitation / ad→ad / praise|normal→null）
 *   H. 隐藏优先级（同时含 praise 与 request 信号 → 取 request，宁可误隐不漏放）
 *   R. mergeIntent：合并风险结果 + intent + 映射 category；praise/normal 的 reason 不含任何 hideCategory 子串
 *   O. 可配置词表（opts 覆盖默认）
 *   P. 插件本体（mock ctx + 假 moderator）：RPC 注册 / 风险+意图合并 / 关风险审核 / 关闭透传 / fail-open / 配置词表 / status
 *   B. 真实桥接：initBridge + scanner.enable + pluginHost.dispatchRpc('afdian-intent', ...) 端到端契约
 *      （隔离沙箱、假 moderator、不触网、不计费、不碰生产 11451）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// ── 测试隔离（必须在任何 src 模块被 require 之前；B 段会 require src/*）──
const SANDBOX = path.join(os.tmpdir(), `grs-afdian-intent-${process.pid}`);
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.GRS_AUDIT_DIR = path.join(SANDBOX, 'audit_records');
process.env.GRS_AUDIT_DB = path.join(SANDBOX, 'audit.db');
process.env.GRS_BLOB_DIR = path.join(SANDBOX, 'image_blobs');
process.env.GRS_PLUGIN_CONFIG = path.join(SANDBOX, 'plugin-config.json');
process.env.GRS_PLUGIN_STATE = path.join(SANDBOX, 'plugins-state.json');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`[PASS] ${name}${detail ? ' | ' + detail : ''}`); }
  else { failed++; console.log(`[FAIL] ${name}${detail ? ' | ' + detail : ''}`); }
}

const { classifyIntent, mergeIntent, INTENT_TO_CATEGORY, HIDE_CATEGORIES } =
  require(path.join(PROJECT_ROOT, 'plugins', 'afdian-intent', 'lib', 'intent'));
const afdianIntentPlugin = require(path.join(PROJECT_ROOT, 'plugins', 'afdian-intent'));

// ── 真实留言（decisions_2026-09.json）──
const REAL = [
  { text: '您好我想查询一下9.16号晚指定群聊的爱丽丝使用日志，请问能帮我一个忙吗，具体价格好商量', intent: 'request' },
  { text: '如果是为了王女大人的话', intent: 'normal' },
  { text: '我的运势好一点', intent: 'normal' },
  { text: '6块', intent: 'normal' },
  { text: '坚持做下去口牙', intent: 'praise' },
  { text: '爱你爱丽丝', intent: 'praise' },
  { text: '孩子们，我真不是萝莉控😡', intent: 'normal' },
];
// ── 自造 private（应隐藏 → solicitation）──
const PRIVATE = [
  '加我微信详聊 abc123', '可以私聊我吗', '我的QQ号是123456789', '留个联系方式呗', '私信我，手机号13800138000',
];
// ── 自造 ad（应隐藏 → ad）──
const AD = [
  '低价代购各种化妆品', '转让九成新手机，价格优惠', '招代理，日赚过千', '全场五折特价促销',
  '推广我的店铺 http://shop.example.com 欢迎下单',
];

// ══════════════════════════════════════════════════════════════
// C. classifyIntent 逐意图（纯函数）
// ══════════════════════════════════════════════════════════════
let realOk = 0;
for (const s of REAL) {
  const r = classifyIntent(s.text);
  if (r.intent === s.intent) realOk++;
  else console.log(`   [i] 真实样本误判: "${s.text}" 期望=${s.intent} 实际=${r.intent} matched=${JSON.stringify(r.matched)}`);
}
check('C/01 真实 7 条意图全对（召回/准确）', realOk === REAL.length, `${realOk}/${REAL.length}`);

const privOk = PRIVATE.filter((t) => classifyIntent(t).intent === 'private').length;
check('C/02 private 召回 100%', privOk === PRIVATE.length, `${privOk}/${PRIVATE.length}`);

const adOk = AD.filter((t) => classifyIntent(t).intent === 'ad').length;
check('C/03 ad 召回 100%', adOk === AD.length, `${adOk}/${AD.length}`);

check('C/04 request 召回', classifyIntent(REAL[0].text).intent === 'request');
check('C/05 空文本→normal', classifyIntent('').intent === 'normal');
check('C/06 中性短句→normal', classifyIntent('哈哈哈').intent === 'normal');

const rConf = classifyIntent(REAL[0].text);
check('C/07 置信度合法且隐藏意图>=0.6',
  Number.isFinite(rConf.confidence) && rConf.confidence >= 0 && rConf.confidence <= 1 && rConf.confidence >= 0.6,
  'conf=' + rConf.confidence);

// ══════════════════════════════════════════════════════════════
// M. intent→category 映射
// ══════════════════════════════════════════════════════════════
check('M/01 intent→category 映射',
  INTENT_TO_CATEGORY.request === 'request' && INTENT_TO_CATEGORY.private === 'solicitation'
  && INTENT_TO_CATEGORY.ad === 'ad' && INTENT_TO_CATEGORY.praise === null && INTENT_TO_CATEGORY.normal === null);
check('M/02 映射 category 均在客户端 hideCategories 内',
  ['request', 'private', 'ad'].every((k) => HIDE_CATEGORIES.includes(INTENT_TO_CATEGORY[k])),
  'hide=' + JSON.stringify(HIDE_CATEGORIES));
check('M/03 分类结果带正确 category',
  classifyIntent(REAL[0].text).category === 'request'
  && classifyIntent(PRIVATE[0]).category === 'solicitation'
  && classifyIntent(AD[0]).category === 'ad'
  && classifyIntent('坚持做下去口牙').category === null);

// ══════════════════════════════════════════════════════════════
// H. 隐藏优先级
// ══════════════════════════════════════════════════════════════
const mixed = classifyIntent('坚持做下去！顺便请问一下怎么充值');
check('H/01 praise+request 并存取 request', mixed.intent === 'request', 'intent=' + mixed.intent + ' matched=' + JSON.stringify(mixed.matched));

// ══════════════════════════════════════════════════════════════
// R. mergeIntent
// ══════════════════════════════════════════════════════════════
const risk = { passed: true, action: 'pass', risk_level: 'safe', categories: [], confidence: 1, reason: '无违规' };
const mergedHide = mergeIntent(risk, REAL[0].text);
check('R/01 合并后含 intent 且 categories 含 request',
  mergedHide.intent === 'request' && mergedHide.categories.includes('request')
  && mergedHide.passed === risk.passed && mergedHide.risk_level === risk.risk_level,
  JSON.stringify({ intent: mergedHide.intent, cats: mergedHide.categories }));
const mergedPraise = mergeIntent(risk, '坚持做下去口牙');
const praiseCatLeak = mergedPraise.categories.some((c) => HIDE_CATEGORIES.includes(c));
const praiseReasonLeak = HIDE_CATEGORIES.some((w) => String(mergedPraise.reason || '').includes(w));
check('R/02 praise 不泄漏隐藏信号（category/reason 均不含 hide 词）',
  !praiseCatLeak && !praiseReasonLeak, `cats=${JSON.stringify(mergedPraise.categories)} reason=${mergedPraise.reason}`);
const mergedNormal = mergeIntent(risk, '6块');
check('R/03 normal 不泄漏隐藏信号',
  !mergedNormal.categories.some((c) => HIDE_CATEGORIES.includes(c))
  && !HIDE_CATEGORIES.some((w) => String(mergedNormal.reason || '').includes(w)),
  `intent=${mergedNormal.intent} reason=${mergedNormal.reason}`);
check('R/04 合并结果带 intent_confidence', Number.isFinite(mergedHide.intent_confidence));

// ══════════════════════════════════════════════════════════════
// O. 可配置词表
// ══════════════════════════════════════════════════════════════
const custom = classifyIntent('今天有 internalzzz 活动', { adWords: ['internalzzz'] });
check('O/01 自定义词表生效', custom.intent === 'ad', 'intent=' + custom.intent);

// ══════════════════════════════════════════════════════════════
// P. 插件本体（mock ctx + 假 moderator；不触网、不计费）
// ══════════════════════════════════════════════════════════════
/** 造一个标准 GRS 风险结果（假 moderator 返回，离线）。*/
function cannedRisk(text) {
  return {
    passed: true, action: 'pass', risk_level: 'safe', categories: [], category_scores: {},
    confidence: 1, reason: '无违规', type: 'text', model: 'fake-offline',
  };
}
/** 假 moderator（记录调用；可设为抛错以测 fail-open）。*/
function fakeModerator(opts = {}) {
  const calls = [];
  return {
    calls,
    moderateText: async (text, meta, o) => {
      calls.push({ text, meta, o });
      if (opts.throw) throw new Error('模拟审核服务不可用');
      return cannedRisk(text);
    },
  };
}
/** 用 mock ctx 装载插件，捕获 rpc/provide/logs。*/
function bootPlugin({ config = {}, moderator = null } = {}) {
  const rpc = {};
  const provided = {};
  const logs = { info: [], warn: [], error: [] };
  const ctx = {
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m)),
    },
    config: (_schema) => Object.assign({}, config),
    inject: (name, _required) => (name === 'moderator' ? moderator : null),
    rpc: (method, handler, o) => { rpc[method] = { handler, opts: o || {} }; },
    provide: (name, impl) => { provided[name] = impl; },
    on: () => {},
  };
  afdianIntentPlugin(ctx);
  return { rpc, provided, logs };
}

async function sectionP() {
  // P/01 装载即注册 moderate/classify/status，并 provide afdianIntent
  {
    const mod = fakeModerator();
    const { rpc, provided } = bootPlugin({ config: {}, moderator: mod });
    check('P/01 注册 moderate/classify/status + provide afdianIntent',
      typeof rpc.moderate?.handler === 'function' && typeof rpc.classify?.handler === 'function'
      && typeof rpc.status?.handler === 'function' && Boolean(provided.afdianIntent)
      && typeof provided.afdianIntent.moderate === 'function' && Boolean(provided.afdianIntent.schema),
      'rpc=' + Object.keys(rpc).join(','));
    check('P/01b moderate/classify/status 均为公开读方法（write!=true，客户端免密调用）',
      rpc.moderate.opts.write !== true && rpc.classify.opts.write !== true && rpc.status.opts.write !== true);
  }

  // P/02 风险+意图合并：request 样本 → intent=request、categories 含 request、风险字段透传、strictness 下传
  {
    const mod = fakeModerator();
    const { rpc } = bootPlugin({ config: { strictness: 'strict' }, moderator: mod });
    const r = await rpc.moderate.handler({ text: REAL[0].text, userId: 'u1', scene: 'afdian-rank-remark' });
    check('P/02 moderate 合并风险+意图（request）',
      r.intent === 'request' && r.categories.includes('request') && r.passed === true && r.risk_level === 'safe'
      && r.reason === '无违规' && Number.isFinite(r.intent_confidence),
      JSON.stringify({ intent: r.intent, cats: r.categories, reason: r.reason }));
    check('P/02b 调用了 moderator 且下传 strictness/scene',
      mod.calls.length === 1 && mod.calls[0].o?.strictness === 'strict' && mod.calls[0].meta?.scene === 'afdian-rank-remark',
      JSON.stringify(mod.calls[0]?.o));
  }

  // P/03 runRiskModeration=false → 不调 moderator，仅意图分类
  {
    const mod = fakeModerator();
    const { rpc } = bootPlugin({ config: { runRiskModeration: false }, moderator: mod });
    const r = await rpc.moderate.handler({ text: REAL[0].text });
    check('P/03 关风险审核：不调 moderator 仍返回 intent',
      mod.calls.length === 0 && r.intent === 'request' && r.categories.includes('request'),
      'calls=' + mod.calls.length + ' intent=' + r.intent);
  }

  // P/04 enabled=false → 透传（intent=normal、categories 空、不隐藏、不调 moderator）
  {
    const mod = fakeModerator();
    const { rpc } = bootPlugin({ config: { enabled: false }, moderator: mod });
    const r = await rpc.moderate.handler({ text: AD[0] });
    check('P/04 关闭时透传（不误隐、不调 moderator）',
      r.intent === 'normal' && Array.isArray(r.categories) && r.categories.length === 0
      && r.passed === true && mod.calls.length === 0
      && !HIDE_CATEGORIES.some((w) => String(r.reason || '').includes(w)),
      JSON.stringify({ intent: r.intent, cats: r.categories, reason: r.reason }));
  }

  // P/05 moderator 抛错 → fail-open（不抛、降级仅意图、warn 留痕）
  {
    const mod = fakeModerator({ throw: true });
    const { rpc, logs } = bootPlugin({ config: {}, moderator: mod });
    let threw = null;
    let r = null;
    try { r = await rpc.moderate.handler({ text: REAL[0].text }); } catch (e) { threw = String(e && e.message); }
    check('P/05 moderator 抛错时 fail-open（不抛、仍判意图）',
      threw === null && r && r.intent === 'request' && r.categories.includes('request'),
      threw ? ('threw=' + threw) : ('intent=' + (r && r.intent) + ' reason=' + (r && r.reason)));
    check('P/05b 降级留痕（warn 记录一条）', logs.warn.length >= 1, 'warn=' + JSON.stringify(logs.warn[0]));
  }

  // P/06 无 moderator 注入（解耦/核心不可用）→ 仅意图分类，不抛
  {
    const { rpc } = bootPlugin({ config: {}, moderator: null });
    let threw = null; let r = null;
    try { r = await rpc.moderate.handler({ text: PRIVATE[0] }); } catch (e) { threw = String(e && e.message); }
    check('P/06 无 moderator 时仅意图分类（private）',
      threw === null && r && r.intent === 'private' && r.categories.includes('solicitation'),
      threw ? ('threw=' + threw) : ('intent=' + (r && r.intent)));
  }

  // P/07 配置词表（textarea 字符串）经 parseWordList 生效
  {
    const { rpc } = bootPlugin({ config: { runRiskModeration: false, adWords: 'internalzzz,推广zz' }, moderator: null });
    const r = await rpc.classify.handler({ text: '今天有 internalzzz 活动' });
    check('P/07 配置词表生效（classify）', r.intent === 'ad', 'intent=' + r.intent);
  }

  // P/08 classify 不触发 moderator（纯意图、不计费）
  {
    const mod = fakeModerator();
    const { rpc } = bootPlugin({ config: {}, moderator: mod });
    const r = await rpc.classify.handler({ text: '坚持做下去口牙' });
    check('P/08 classify 纯意图、不调 moderator', r.intent === 'praise' && mod.calls.length === 0, 'intent=' + r.intent);
  }

  // P/09 status 自报端点/映射/moderator 可用性
  {
    const mod = fakeModerator();
    const { rpc } = bootPlugin({ config: {}, moderator: mod });
    const s = await rpc.status.handler();
    check('P/09 status 自报端点与映射',
      String(s.endpoint || '').includes('/api/p/afdian-intent/rpc') && s.intentToCategory.request === 'request'
      && Array.isArray(s.hideCategories) && s.moderatorAvailable === true,
      JSON.stringify({ endpoint: s.endpoint, moderatorAvailable: s.moderatorAvailable }));
  }
}

// ══════════════════════════════════════════════════════════════
// B. 真实桥接端到端：initBridge + scanner.enable + dispatchRpc
//    （证明客户端将命中的 POST /api/p/afdian-intent/rpc 契约；隔离沙箱、假 moderator、不触网）
// ══════════════════════════════════════════════════════════════
async function sectionB() {
  const bridge = require(path.join(PROJECT_ROOT, 'src', 'cordis-bridge'));
  const scanner = require(path.join(PROJECT_ROOT, 'src', 'plugin-scanner'));
  const pluginHost = require(path.join(PROJECT_ROOT, 'src', 'plugin-host')); // 加载即 setHostBridge，rpc↔dispatch 同表

  const mod = fakeModerator();
  const status = await bridge.initBridge({
    app: null,
    config: { plugins: { enabled: true } },
    moderator: mod,
    sharp: null,
    vision: null,
    projectRoot: PROJECT_ROOT,
  });
  check('B/01 桥接层就绪', Boolean(status), 'phase=' + (status && status.phase) + ' degraded=' + (status && status.degraded));

  scanner.scanPlugins();
  const en = await scanner.enable('afdian-intent');
  check('B/02 scanner.enable(afdian-intent) 成功', en && en.ok === true, JSON.stringify(en && en.error ? en.error : en && en.ok));

  // B/03 主契约：dispatchRpc('moderate') → {ok, result:{标准契约 + intent}}
  const out = await pluginHost.dispatchRpc('afdian-intent', 'moderate', { text: REAL[0].text, scene: 'afdian-rank-remark' });
  check('B/03 dispatchRpc(moderate) ok', out && out.ok === true, JSON.stringify(out && out.error ? out.error : out && out.ok));
  const res = out && out.result;
  check('B/04 result 含标准契约键 + intent（客户端只增读 intent，不破坏旧键）',
    res && ['passed', 'action', 'risk_level', 'categories', 'confidence', 'reason'].every((k) => k in res)
    && res.intent === 'request' && Array.isArray(res.categories) && res.categories.includes('request'),
    JSON.stringify(res && { intent: res.intent, cats: res.categories, passed: res.passed, risk: res.risk_level }));

  // B/05 classify 端点（private）
  const out2 = await pluginHost.dispatchRpc('afdian-intent', 'classify', { text: PRIVATE[0] });
  check('B/05 dispatchRpc(classify) private→solicitation',
    out2 && out2.ok === true && out2.result && out2.result.intent === 'private' && out2.result.category === 'solicitation',
    JSON.stringify(out2 && out2.result));

  // B/06 status 端点
  const out3 = await pluginHost.dispatchRpc('afdian-intent', 'status', {});
  check('B/06 dispatchRpc(status) 自报端点',
    out3 && out3.ok === true && String(out3.result?.endpoint || '').includes('/api/p/afdian-intent/rpc'),
    JSON.stringify(out3 && out3.result && out3.result.endpoint));

  // B/07 未知方法 → ok=false / code=400（契约稳定，不 500）
  const out4 = await pluginHost.dispatchRpc('afdian-intent', 'nope-not-exist', {});
  check('B/07 未知方法→400 而非 500', out4 && out4.ok === false && out4.code === 400, JSON.stringify(out4));

  // B/08 全量真实样本经端点判定意图正确（端到端召回）
  let e2eOk = 0;
  for (const s of REAL) {
    const o = await pluginHost.dispatchRpc('afdian-intent', 'classify', { text: s.text });
    if (o && o.ok && o.result && o.result.intent === s.intent) e2eOk++;
    else console.log(`   [i] 端到端误判: "${s.text}" 期望=${s.intent} 实际=${o?.result?.intent}`);
  }
  check('B/08 真实 7 条经端点意图全对', e2eOk === REAL.length, `${e2eOk}/${REAL.length}`);
}

(async function main() {
  await sectionP();
  try {
    await sectionB();
  } catch (err) {
    check('B/00 真实桥接段未抛异常', false, String(err && err.stack || err));
  }
  console.log('---');
  console.log(`passed=${passed} failed=${failed}`);
  console.log(`OVERALL: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  // 清理沙箱
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(failed === 0 ? 0 : 1);
})();
