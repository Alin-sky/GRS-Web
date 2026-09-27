#!/usr/bin/env node
/**
 * 云端模型目录单测（scripts/test-model-catalog.js）
 *
 * 设计依据：v2.3.0 Req6 —— 「审核配置里面的模型参数信息更新下，再完整检查下整个项目的一致性」
 *
 * 本脚本守护四条红线：
 *   ① 单一数据源：cloud-model-catalog.js 是「模型清单 + 价格 + 额度可用性」的唯一来源，
 *      moderator / server / 前端 / 测试都必须从它取数，不得各自内联副本。
 *   ② 额度前置判定：billingSource='token-plan' 的额度端点实测**不含名字带 `vl` 的传统
 *      视觉模型**（qwen3-vl-* 调用必 404 model_not_found），但它**含原生多模态模型**
 *      （qwen3.8-flash / qwen3.7-plus / qwen3.6-flash / deepseek-v4.1-flash）—— 后者同样
 *      可做图片审核。判据据此区分「传统 VL（不可用）」与「原生多模态（可用）」。
 *   ③ 双能力可见性（T13）：原生多模态模型既能审文也能审图，故 `listTextModels()` 不得
 *      再用 `!m.vision` 过滤 —— 否则它们出现在 0 个文本下拉里，用户根本选不到。
 *      守护方式：视觉清单必须是文本清单的真子集，且 qwen3.8-flash 同时出现在两个清单。
 *   ④ 角标单一真相：badge 文案与 badgeTone 色调同在目录里，前端只做「色调 → CSS 类」映射。
 *      守护方式：断言目录 tone 合法、badge/tone 成对、投影已透出 badgeTone，
 *      且 public/index.html 既无前端角标表标识符、又确实消费 badgeTone（一正一反成对）。
 *   ⑤ 定价数据卫生：pricing 数值必须为正有限数、币种统一 CNY、单档结构下 note 承载完整阶梯；
 *      并以 2026-09-19 官方实抓价设锚点（qwen3.6-flash=1.2 / qwen3.8-flash=0.8），
 *      同时守护「已下线 DeepSeek 两条保留 + 标记」的可逆方案不被误删。
 *   ⑥ 边界不猜（T16）：取不到价格时前端**不得**回退到硬编码兜底价 —— 显式报「价格未收录」，
 *      与后端 buildCloudCost 的 pricing_known:false 同一口径；note 只在模型层、不在 pricing 层；
 *      前端视觉兜底默认值必须与后端 config-defaults 一致（单一真相，防漂移）。
 *
 * 用法：
 *   node scripts/test-model-catalog.js
 *   退出码：全部通过为 0，否则为 1。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const rows = [];

/**
 * 断言并记录。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} detail 说明
 */
function check(name, ok, detail = '') {
  if (ok) passed += 1; else failed += 1;
  rows.push({ name, ok, detail });
}

const cat = require(path.join(ROOT, 'src/cloud-model-catalog.js'));

// ── 0. 模块可加载 ─
check('cloud-model-catalog 可加载', typeof cat.checkBilling === 'function');
check('model-profiles 可加载',
  typeof require(path.join(ROOT, 'src/model-profiles.js')).getProfile === 'function');

// ─ 1. 核心判据：token-plan 下的**传统 vl 视觉模型**必须判为不可用（404 根因）；原生多模态必须可用 ─
{
  const r = cat.checkBilling('qwen3-vl-plus', 'token-plan');
  check('token-plan + qwen3-vl-plus => 不可用（404 根因）', r.ok === false,
    r.ok === false ? r.reason : '应为不可用，实际 ok=true');
  const reasonOk = /视觉/.test(String(r.reason));
  check('不可用理由点明「传统视觉模型」', reasonOk, String(r.reason));
  const suggOk = /qwen3\.8-flash|dashscope|qwen3-vl:8b/.test(String(r.suggestion));
  check('不可用建议可执行（改选原生多模态 / 换额度 / 换本地视觉）', suggOk, String(r.suggestion));
}

check('dashscope + qwen3-vl-plus => 可用',
  cat.checkBilling('qwen3-vl-plus', 'dashscope').ok === true);
check('token-plan + qwen3.8-flash => 可用（原生多模态）',
  cat.checkBilling('qwen3.8-flash', 'token-plan').ok === true);
check('token-plan + qwen3.7-plus => 可用（原生多模态）',
  cat.checkBilling('qwen3.7-plus', 'token-plan').ok === true);
check('token-plan + qwen3.6-flash => 可用（原生多模态）',
  cat.checkBilling('qwen3.6-flash', 'token-plan').ok === true);
check('token-plan + qwen3.7-flash => 不可用（不在白名单，会导致 404）',
  cat.checkBilling('qwen3.7-flash', 'token-plan').ok === false);

// ── 2. TOKEN_PLAN_MODELS 与实测一致 ──
check('TOKEN_PLAN_MODELS 共 14 项', cat.TOKEN_PLAN_MODELS.length === 14,
  `实际 ${cat.TOKEN_PLAN_MODELS.length}`);
{
  // 白名单里**不得**出现名字带 `vl` 的传统视觉模型 —— 它们确实 404，
  // 这条断言真正防止「又把一个 404 模型写进白名单」。
  const vl = cat.TOKEN_PLAN_MODELS.filter((m) => /(^|-)vl(-|$)/i.test(m));
  check('TOKEN_PLAN_MODELS 不含传统 vl 视觉模型（它们会 404）', vl.length === 0, vl.join(','));
  // 但**必须**含实测可调用的原生多模态模型（vision===true）——否则又退化成「token-plan 无视觉可用」
  const nativeVision = cat.TOKEN_PLAN_MODELS.filter((m) => cat.isVisionModel(m));
  check('TOKEN_PLAN_MODELS 含实测可用的原生多模态模型',
    nativeVision.includes('qwen3.8-flash'), nativeVision.join(','));
}

// ── 3. 价格单一数据源 ──
{
  const p = cat.getPricing('qwen3.8-flash');
  // 锚点值 = 2026-09-19 官方页实抓（华北2 单一价，无阶梯）；旧值 1/3 已作废
  check('getPricing(qwen3.8-flash) = 0.8/2.7', !!p && p.input === 0.8 && p.output === 2.7,
    JSON.stringify(p));
  const a = cat.getPricing('deepseek-v4-flash-0731');
  const b = cat.getPricing('deepseek-v4-flash');
  check('别名折叠：deepseek-v4-flash-0731 → deepseek-v4-flash',
    !!a && JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
  check('未收录模型返回 null（不套用他模型价格）',
    cat.getPricing('some-unknown-model-xyz') === null);
}
{
  const src = fs.readFileSync(path.join(ROOT, 'src/moderator.js'), 'utf8');
  check('moderator 已删除内联价格表', !src.includes('MODEL_PRICING = {'));
  check('moderator 引用单一数据源', src.includes("require('./cloud-model-catalog')"));
}

// ── 4. 前后端清单同源 + 双能力模型可见性 ─
{
  const t = cat.listTextModels();
  const v = cat.listVisionModels();
  check('listTextModels / listVisionModels 非空', t.length > 0 && v.length > 0,
    `文本 ${t.length} / 视觉 ${v.length}`);
  // T13 核心守护：原生多模态模型既能审文也能审图 → 视觉清单必须是文本清单的**真子集**。
  // 若谁把 `!m.vision` 过滤又加回 listTextModels()，下面这条会立刻 FAIL。
  const tIds = new Set(t.map((m) => m.id));
  const vNotInT = v.filter((m) => !tIds.has(m.id));
  check('视觉清单 ⊆ 文本清单（双能力模型的图像能力项必须也能在文本下拉选到）',
    vNotInT.length === 0, vNotInT.map((m) => m.id).join(','));
  // 反过来：文本清单必须**严格大于**视觉清单（否则说明文本清单被 vision 过滤过）
  check('文本清单严格大于视觉清单', t.length > v.length, `文本 ${t.length} / 视觉 ${v.length}`);
  // 逐项带布尔 vision 标记（前端据此渲染「亦可审图」角标）
  const missV = [...t, ...v].filter((m) => typeof m.vision !== 'boolean');
  check('每个清单项都带布尔 vision 标记', missV.length === 0, missV.map((m) => m.id).join(','));
  // 正向判别：qwen3.8-flash 同时出现在两个清单里
  check('qwen3.8-flash 同时出现在文本与视觉清单里',
    tIds.has('qwen3.8-flash') && v.some((m) => m.id === 'qwen3.8-flash'));
  // 反向判别（阳性对照 + 阴性对照）：纯文本模型 qwen-plus 必须在文本清单、且不在视觉清单。
  // 若谁把视觉清单也放宽成「全部模型」，这条会 FAIL。
  check('qwen-plus 在文本清单、不在视觉清单',
    tIds.has('qwen-plus') && !v.some((m) => m.id === 'qwen-plus'),
    `inText=${tIds.has('qwen-plus')} inVision=${v.some((m) => m.id === 'qwen-plus')}`);
  const miss = [...t, ...v].filter((m) => typeof m.tokenPlan !== 'boolean');
  check('每个模型都带 tokenPlan 实测标记', miss.length === 0, miss.map((m) => m.id).join(','));
}
{
  // 文本清单不再剔除视觉模型：合并两清单会重复计入双能力模型，故必须去重。
  const all = [...cat.listTextModels(), ...cat.listVisionModels()];
  const uniq = new Map();
  for (const m of all) uniq.set(m.id, m);
  const tp = [...uniq.values()].filter((m) => m.tokenPlan).map((m) => m.id).sort();
  const expected = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash', 'glm-5.2', 'glm-5.3',
    'qwen3.6-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max'].sort();
  check('tokenPlan 命中数与目录内可用子集一致（去重后）',
    JSON.stringify(tp) === JSON.stringify(expected),
    `期望 ${expected.join(',')} / 实际 ${tp.join(',')}`);
}
check('别名折叠参与白名单判定（deepseek-v4-flash-0731）',
  cat.isTokenPlanAvailable('deepseek-v4-flash-0731') === true &&
  cat.isTokenPlanAvailable('deepseek-v4-flash') === true &&
  cat.checkBilling('deepseek-v4-flash-0731', 'token-plan').ok === true);
{
  // token-plan 下标记为可用的视觉模型**必须是实测可调用的原生多模态**（非 404 的 qwen3-vl-*）
  const visionTp = cat.listVisionModels().filter((m) => m.tokenPlan);
  const allNative = visionTp.length > 0
    && visionTp.every((m) => !/(^|-)vl(-|$)/i.test(m.id));
  check('token-plan 的视觉模型均为实测可调用的原生多模态（非传统 vl）',
    allNative, visionTp.map((m) => m.id).join(',') || '(空)');
  // dashscope 专属的 qwen3-vl-* 的 tokenPlan 必须仍为 false（它们确实不在该端点）
  const vlStillFalse = cat.listVisionModels()
    .filter((m) => /(^|-)vl(-|$)/i.test(m.id))
    .every((m) => m.tokenPlan === false);
  check('qwen3-vl-* 的 tokenPlan 仍为 false（dashscope 专属）', vlStillFalse);
}

// ── 5. 默认配置的视觉模型必须是真视觉模型 ──
{
  const defaultsMod = require(path.join(ROOT, 'src/config-defaults.js'));
  const vm = defaultsMod.DEFAULT_CONFIG.qwenCloud.visionModel;
  check('config-defaults.visionModel 是目录内的视觉模型',
    !!vm && cat.isVisionModel(vm), String(vm));
}
{
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/default.example.json'), 'utf8'));
  const vm = example.qwenCloud && example.qwenCloud.visionModel;
  check('default.example.json 的 visionModel 是目录内的视觉模型',
    !!vm && cat.isVisionModel(vm), String(vm));
}

// ── 6. server / qwen_cloud 已接入 ──
{
  const srv = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  check('server.js 引用单一数据源', srv.includes("require('./cloud-model-catalog')"));
  const qc = fs.readFileSync(path.join(ROOT, 'src/qwen_cloud.js'), 'utf8');
  check('qwen_cloud.js 已加额度前置判定',
    qc.includes('checkBilling') && qc.includes('effectivePrimary'));
}

// ── 7. 角标单一真相（前端不得再维护 id→角标 表）──
{
  const TONES = new Set(['fast', 'balanced', 'powerful']);
  // 7.1 目录里出现的 badgeTone 必须落在合法枚举内（前端 CSS 只认这三档）
  const badTone = cat.CLOUD_MODELS.filter((m) => m.badgeTone !== undefined && !TONES.has(m.badgeTone));
  check('CLOUD_MODELS 的 badgeTone 取值均为 fast/balanced/powerful',
    badTone.length === 0, badTone.map((m) => `${m.id}=${m.badgeTone}`).join(','));
  // 7.2 有 badge 必有 badgeTone，无 badge 不得有 badgeTone（防「改了文案忘了色调」→ 静默降级成 badge-fast）
  const toneMismatch = cat.CLOUD_MODELS.filter((m) => Boolean(m.badge) !== Boolean(m.badgeTone));
  check('badge 与 badgeTone 必须成对出现',
    toneMismatch.length === 0,
    toneMismatch.map((m) => `${m.id}:badge=${m.badge}|tone=${m.badgeTone}`).join(','));
  // 7.3 投影函数是**字段白名单**，漏加 badgeTone 会让色调在传输层静默丢失（文案对、颜色错，最难发现）
  const projected = [...cat.listTextModels(), ...cat.listVisionModels()];
  const lost = projected.filter((m) => Boolean(m.badge) !== Boolean(m.badgeTone));
  check('listTextModels/listVisionModels 已透出 badgeTone 字段',
    lost.length === 0, lost.map((m) => m.id).join(','));
  // 7.4 反反弹：前端不得再出现第二份角标表标识符。
  //     标识符此处用拼接构造 —— 否则本测试文件自身就含该标识符，反而污染全仓 grep。
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const legacyTables = ['TEXT' + '_MODEL_BADGES', 'VISION' + '_MODEL_BADGES']
    .filter((name) => indexHtml.includes(name));
  check('public/index.html 不含前端角标表标识符（角标已收敛为单一真相）',
    legacyTables.length === 0, legacyTables.join(','));
  // 7.5 反反弹（与 7.4 配对的阳性对照）：前端渲染确实消费后端 badgeTone 字符串。
  //     若有人 7.4 满足了却把渲染改回硬编码 badge-fast，本断言立刻 FAIL。
  const toneRefs = (indexHtml.match(/badgeTone/g) || []).length;
  check('public/index.html 渲染消费后端 badgeTone 字段', toneRefs > 0, `badgeTone 出现 ${toneRefs} 次`);
}

// ── 8. 定价数据卫生 + 官方核价锚点（2026-09-19 调研）──
{
  // 8.1 数值卫生：pricing 的 input/output 必须是**正的有限数**。
  //     防 NaN / 负数 / 字符串（'-1'）等静默污染成本计算 —— 那种错会让账单算成负数却无人报错。
  const badNumeric = cat.CLOUD_MODELS.filter((m) => m.pricing
    && !(Number.isFinite(m.pricing.input) && m.pricing.input > 0
      && Number.isFinite(m.pricing.output) && m.pricing.output > 0));
  check('所有 pricing 的 input/output 均为正的有限数',
    badNumeric.length === 0,
    badNumeric.map((m) => `${m.id}=${JSON.stringify(m.pricing)}`).join(','));

  // 8.2 币种一致：凡有价格的项必须标 CNY（前端据 currency 选 ¥/$ 符号）
  const badCurrency = cat.CLOUD_MODELS.filter((m) => m.pricing && m.pricing.currency !== 'CNY');
  check('所有 pricing 非空的项 currency 均为 CNY',
    badCurrency.length === 0, badCurrency.map((m) => `${m.id}=${m.pricing.currency}`).join(','));

  // 8.3 官方核价锚点（结构化断言，非字符串匹配）。
  //     qwen3.6-flash 1.2 / qwen3.8-flash 0.8 是 team-lead 独立抓官方页确认过的两条，
  //     且各自修掉了一个方向相反的真实偏差（前者低报 3.3 倍、后者高报）——
  //     任何回退到旧错值（0.36 / 1）都会让本断言 FAIL。
  const a36 = cat.getPricing('qwen3.6-flash');
  check('核价锚点 qwen3.6-flash 输入 = 1.2（旧值 0.36 为低报）',
    !!a36 && a36.input === 1.2, JSON.stringify(a36));
  const a38 = cat.getPricing('qwen3.8-flash');
  check('核价锚点 qwen3.8-flash 输入 = 0.8（旧值 1 为高报）',
    !!a38 && a38.input === 0.8, JSON.stringify(a38));

  // 8.4 两个 null 已全部转为收录 —— 并守护「不得再退回未收录」
  const nulls = cat.CLOUD_MODELS.filter((m) => !m.pricing).map((m) => m.id);
  check('pricing 为 null 的项已全部收录（glm-5.3 / deepseek-v4.1-flash）',
    nulls.length === 0, nulls.join(','));

  // 8.5 已下线标记留存：这两条是「保留 + 标记」方案（可逆）的承载物。
  //     若有人把它们直接删掉（或删掉「已下线」字样），用户旧配置会静默失效 —— 本断言守住。
  const offline = cat.CLOUD_MODELS.filter((m) => /已下线/.test(m.note || '')).map((m) => m.id).sort();
  const wantOffline = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'];
  check('已下线 DeepSeek 两条记录仍存在且 note 含「已下线」',
    JSON.stringify(offline) === JSON.stringify(wantOffline), `实际 [${offline.join(',')}]`);

  // 8.6 旧名不得被折叠掉（方案 A 保留旧名，用户旧配置照旧可用）。
  //     用行为断言而非读别名表：MODEL_ALIASES 未导出，直接断言归一化结果更贴近真实影响面。
  const keepOld = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'];
  const folded = keepOld.filter((id) => cat.normalizeModelId(id) !== id || !cat.getModel(id));
  check('已下线旧模型名未被折叠（归一化后仍是自己、且目录内可查）',
    folded.length === 0, folded.join(','));

  // 8.7 阶梯信息不得因单档结构而丢失：每个模型都应有 note 承载完整阶梯/口径
  const noNote = cat.CLOUD_MODELS.filter((m) => !m.note || !String(m.note).trim()).map((m) => m.id);
  check('每个模型都有 note（承载完整阶梯，弥补 pricing 单档结构）',
    noNote.length === 0, noNote.join(','));
}

// ── 9. 边界口径守护：不与目录分家的「不猜价格」+ 单一默认视觉模型 ──
{
  // 9.1 note 挂在**模型对象**上，不在 pricing 子对象上 —— 这是 T16 修掉的真实缺陷：
  //     buildCloudCost 原先写 `pricing?.note`（pricing 只含 {input,output,currency}）⇒ 该字段恒 null。
  //     下面一正一反两条把「note 在哪一层」钉死，防止有人改回 pricing?.note。
  check('getModel(deepseek-v4-flash).note 存在且标记已下线（note 在模型层）',
    /已下线/.test(String((cat.getModel('deepseek-v4-flash') || {}).note || '')));
  check('getPricing(deepseek-v4-flash).note 必须为 undefined（pricing 层不含 note）',
    cat.getPricing('deepseek-v4-flash').note === undefined);

  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const moderatorSrc = fs.readFileSync(path.join(ROOT, 'src/moderator.js'), 'utf8');

  // 9.2 moderator 必须走 getModel 取 note（若改回 pricing?.note 本断言 FAIL）
  check('moderator.pricing_note 走 getModel 取 note（非 pricing?.note）',
    moderatorSrc.includes('getModel') && !/pricing\?\.note/.test(moderatorSrc));

  // 9.3 反反弹：前端不得再硬编码兜底价。
  //     必须**先剥掉整行注释**再查 —— 否则记录历史错值的注释本身会把断言打成假阳性。
  //     标识符用拼接构造，避免本测试文件自身污染全仓 grep。
  const codeOnly = indexHtml.split('\n')
    .filter((ln) => {
      const s = ln.trim();
      return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
    }).join('\n');
  const legacyPrice = '0.' + '14';
  const legacyPrice2 = '0.' + '28';
  const banned = [legacyPrice, legacyPrice2]
    .filter((v) => codeOnly.includes(`input: ${v}`) || codeOnly.includes(`output: ${v}`));
  check('public/index.html 不含硬编码兜底价（不猜价格，取不到即报未收录）',
    banned.length === 0, banned.join(','));
  check('public/index.html formatCost 对未收录价格显式return「价格未收录」',
    indexHtml.includes('价格未收录'));

  // 9.4 反反弹：前端视觉兜底不得指向 token-plan 下必 404 的传统 vl 模型。
  const legacyVision = 'qwen3-vl-' + 'plus';
  const visionFallbackBad = new RegExp(`\\|\\|\\s*'${legacyVision.replace(/\./g, '\\.')}'`).test(indexHtml);
  check('public/index.html 视觉兜底不指向 qwen3-vl-plus（token-plan 下必 404）',
    visionFallbackBad === false);

  // 9.5 单一真相：前端视觉兜底默认值必须与后端 config-defaults 一致（防再次漂移）
  const defaultsMod2 = require(path.join(ROOT, 'src/config-defaults.js'));
  const backendVm = defaultsMod2.DEFAULT_CONFIG.qwenCloud.visionModel;
  const feMatch = indexHtml.match(/DEFAULT_VISION_MODEL\s*=\s*'([^']+)'/);
  const frontVm = feMatch ? feMatch[1] : null;
  check('前端 DEFAULT_VISION_MODEL 与后端 config-defaults.visionModel 一致',
    !!frontVm && frontVm === backendVm, `前端 ${frontVm} / 后端 ${backendVm}`);

  // 9.5b 堵住 9.5 的规避路径：9.5 只查「两边一致」，若把前后端**同时**改成一个
  //       token-plan 下不可用的视觉模型，9.5 会因一致而放行。下面两条从
  //       「该模型在两种额度来源下都真的可调用」独立判定，与一致性无关。
  const tpOk = cat.isTokenPlanAvailable(backendVm);
  const dsOk = cat.checkBilling(backendVm, 'dashscope').ok === true;
  check('默认视觉模型在 token-plan 与 dashscope 下均可调用（绕不过的独立判据）',
    !!backendVm && tpOk && dsOk,
    `token-plan=${tpOk} dashscope=${dsOk} (${backendVm})`);

  // 9.6 币种符号显式映射（未知币种不静默套用 ¥）
  check('public/index.html 使用显式币种映射 CURRENCY_SYMBOL',
    indexHtml.includes('CURRENCY_SYMBOL') && indexHtml.includes('currencyPrefix'));
}

// ── 10. 发布闸门自身：四个检查必须都在，且卫生检查不得被 --no-git 带偏 ──
// 背景：main 分支实测带着 src/security/output-schema.js:56/58 的 18 个裸控制字节
// （T10 已在工作区修掉，但闸门原先只查「未跟踪 / 计数 / 泄漏」，没有任何检查
//  能发现坏字节，于是这类树可以照推不误）。10.1–10.4 锁住闸门的四条腿。
{
  const fsMod = require('fs');
  const pathMod = require('path');
  const uploadBat = fsMod.readFileSync(pathMod.join(ROOT, 'git-upload.bat'), 'utf8');
  const pushBat = fsMod.readFileSync(pathMod.join(ROOT, 'push.bat'), 'utf8');

  check('git-upload.bat 含检查1：未跟踪 src 文件（git ls-files --others）',
    uploadBat.includes('ls-files --others --exclude-standard -- src/'));
  check('git-upload.bat 含检查2：src/ 计数地板（纯批处理计数，不依赖 find）',
    uploadBat.includes('set /a SRCN+=1') && uploadBat.includes('if %SRCN% LSS 60'));
  check('git-upload.bat 含检查3：敏感文件不得进 HEAD 树',
    uploadBat.includes('sensitive_words.json') && uploadBat.includes('.bak-'));

  // 10.4 检查4 必须用 pre-publish-check 的默认模式（git ls-files = 发布集）。
  //      若改成 --no-git，walk 会钻进 wd14/.venv，把真 error 埋在几万条 .pyc 噪声下。
  check('git-upload.bat 的卫生检查走 pre-publish-check 默认模式（不得带 --no-git）',
    uploadBat.includes('pre-publish-check.js') && !/pre-publish-check\.js"?\s+--no-git/.test(uploadBat));
  check('git-upload.bat 的卫生检查以 --max-fail=error 为准（只拦 error 级）',
    uploadBat.includes('--max-fail=error'));
  check('git-upload.bat 卫生失败时回显全部 error 行（不得只过滤 HYGIENE 单一规则）',
    /^ *error /.test(uploadBat.replace(/\\r/g, '')) || uploadBat.includes('findstr /i /r /c:"^ *error "'));

  // 10.7 push.bat 不得自行 push（否则绕开闸门）。必须委托给 git-upload.bat。
  check('push.bat 不再自行 git push（必须委托 git-upload.bat，否则绕开闸门）',
    !/^git push/m.test(pushBat.replace(/\r/g, '')) && pushBat.includes('git-upload.bat'));

  // 10.8 闸门必须在 commit 之后、push 之前 —— 推的是 commit 后的 HEAD
  const iCommit = uploadBat.indexOf('git commit -m');
  const iGate = uploadBat.indexOf('[4/5] Integrity gate');
  const iPush = uploadBat.indexOf('git push origin main');
  check('闸门位于 commit 之后、push 之前（检查的是真正要推的 HEAD）',
    iCommit > 0 && iCommit < iGate && iGate < iPush,
    `commit@${iCommit} gate@${iGate} push@${iPush}`);
}

// ── 报告 ──
const line = '-'.repeat(88);
console.log(line);
console.log('GRS cloud model catalog / billing source self-test');
console.log(line);
for (const r of rows) console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(52)} ${r.detail}`);
console.log(line);
console.log(`passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
process.exitCode = failed === 0 ? 0 : 1;