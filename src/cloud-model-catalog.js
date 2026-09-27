/**
 * 云端模型目录（src/cloud-model-catalog.js）
 * v2.3.0 新增。背景（Req6 一致性修复）：
 * 云端模型的「清单 + 价格」此前**两份手工维护**：
 * · src/server.js /api/dual-mode 的 availableModels / availableVisionModels（前端展示）
 * · src/moderator.js MODEL_PRICING（后端计费）
 * 两份表长期漂移：同模型 note 文案不一致、后端有而前端没有（qwen3.6-plus / qwq-plus）、
 * 前端有而后端没有（deepseek-v4-flash-vision-exp）……且**没有任何字段表达
 * 「该模型在当前额度来源下是否真的可调用」** —— 这正是云端视觉 404 的病根：
 * `qwenCloud.billingSource = 'token-plan'` 时端点下**不含名字带 `vl` 的传统视觉模型**
 * （如 `qwen3-vl-*`，实测 404 model_not_found），但**含原生多模态**的 `qwen3.8-flash` /
 * `qwen3.8-max` / `qwen3.7-plus` / `qwen3.6-flash` 等（同样能审图）；
 * 而配置里 `visionModel = qwen3-vl-plus`，于是每次图片审核必然 404 → fail-closed 全量拦截。
 * 设计原则：
 * · 纯数据 + 纯函数，**零依赖**，可被 server / moderator / 前端 / 测试直接引用。
 * · `tokenPlan: true/false` 是**实测事实**（对 /models 接口的探测结果），不是推测。
 * · 价格缺失时给 `null`，由调用方显式标注「以账单为准」，**不套用别的模型价格**
 * （与 model-profiles.js 的 `known:false` 同一原则）。
 * 最近核价日期：2026-09-19（调研依据见 docs/model-pricing-research-2026-09-19.md，逐条附官方一手 URL）
 */

'use strict';

/** 额度来源标识（与 config.qwenCloud.billingSource 取值一致）。*/
const BILLING_SOURCES = {
  TOKEN_PLAN: 'token-plan',
  DASHSCOPE: 'dashscope',
};

/**
 * Token Plan 端点（token-plan.cn-beijing.maas.aliyuncs.com）实测可用模型白名单。
 * 数据来源：2026-09-18 对 `${tokenPlan.endpoint}/models` 的实测响应，共 14 项。
 * 关键事实：**此端点不含名字带 `vl` 的传统视觉模型**（`qwen3-vl-*` 会 404），
 * 但**含原生多模态模型**（`qwen3.8-flash` / `qwen3.8-max` / `qwen3.7-plus` /
 * `qwen3.6-flash` / `deepseek-v4.1-flash`）—— 它们同样可做云端图片审核
 * （实测：喂图后 prompt_tokens 128 vs 无图 69，且回答随图内容改变）。
 */
const TOKEN_PLAN_MODELS = Object.freeze([
  'deepseek-v4-flash-0731',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
  'glm-5.2',
  'glm-5.3',
  'qwen-audio-3.0-realtime-plus',
  'qwen-audio-3.0-tts-plus',
  'qwen3.6-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.8-flash',
  'qwen3.8-max',
  'wan2.7-image',
  'wan2.7-image-pro',
]);

/**
 * 云端模型目录。
 * 字段：
 * id 调用时传给 API 的模型名
 * name 展示名
 * pricing { input, output, currency } 元/百万 tokens；null 表示未收录（以账单为准）。
 *         **取值口径**（2026-09-19 官方核价）：一律取「审核场景实际会落入的档位」——
 *         长度分档取**首档**（审核输入短），峰谷取**高峰价**（审核随时触发，取上限不低估成本）；
 *         限时优惠价**不进** pricing，只在 note 说明。完整阶梯写在 note，弥补单档结构的精度损失。
 * vision 是否具备视觉（图片）能力
 * provider 'qwen' | 'deepseek' | 'glm' | 'other'（决定图标）
 * badge 前端角标文案（可省略）
 * badgeTone 角标色调 'fast' | 'balanced' | 'powerful'（**有 badge 就必须有 tone**）；
 *           前端据此选 CSS 类，避免前端各自维护「文案→颜色」的映射表而产生第二份真相
 * note 备注
 * moderation 是否推荐用于内容审核（false 的多为生成类/语音类，不应出现在审核下拉里）
 */
const CLOUD_MODELS = Object.freeze([
  // ── Qwen 通用模型（vision=true 者既在文本下拉也在视觉下拉）───
  { id: 'qwen-flash', name: 'Qwen Flash', pricing: { input: 0.15, output: 1.5, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '最低价', badgeTone: 'fast', note: '≤128K:0.15/1.5 · 128K-256K:0.6/6 · 256K-1M:1.2/12 · 缓存命中0.03' },
  { id: 'qwen-turbo', name: 'Qwen Turbo', pricing: { input: 0.3, output: 0.6, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '极速低价', badgeTone: 'fast', note: '非思考:0.3/0.6 · 思考:0.3/3 · 无长度阶梯 · 缓存命中0.06' },
  { id: 'qwen3.5-flash', name: 'Qwen 3.5 Flash', pricing: { input: 0.2, output: 2, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '低价', badgeTone: 'fast', note: '≤128K:0.2/2 · 128K-256K:0.8/8 · 256K-1M:1.2/12' },
  { id: 'qwen3.6-flash', name: 'Qwen 3.6 Flash', pricing: { input: 1.2, output: 7.2, currency: 'CNY' }, vision: true, provider: 'qwen', badge: '低价', badgeTone: 'fast', note: '原生多模态 · Token Plan 可用 · ≤256K:1.2/7.2 · 256K-1M:4.8/28.8' },
  { id: 'qwen3.7-flash', name: 'Qwen 3.7 Flash', pricing: { input: 0.2, output: 0.8, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '超低价', badgeTone: 'fast', note: '支持思考模式 · ≤32K:0.2/0.8 · 32K-256K:0.6/2.4 · 256K-1M:1.2/4.8' },
  { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash', pricing: { input: 0.8, output: 2.7, currency: 'CNY' }, vision: true, provider: 'qwen', badge: '新品低价', badgeTone: 'fast', note: '原生多模态 · Token Plan 可用 · 无长度阶梯 · 缓存命中0.1' },
  { id: 'qwen-plus', name: 'Qwen Plus', pricing: { input: 0.8, output: 2, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '均衡', badgeTone: 'balanced', note: '非思考 ≤128K:0.8/2 · 128K-256K:2.4/20 · 256K-1M:4.8/48' },
  { id: 'qwen3.5-plus', name: 'Qwen 3.5 Plus', pricing: { input: 0.8, output: 4.8, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '性价比', badgeTone: 'fast', note: '≤128K:0.8/4.8 · 128K-256K:2/12 · 256K-1M:4/24' },
  { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus', pricing: { input: 2, output: 12, currency: 'CNY' }, vision: false, provider: 'qwen', note: '≤256K:2/12 · 256K-1M:8/48' },
  { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', pricing: { input: 2, output: 8, currency: 'CNY' }, vision: true, provider: 'qwen', badge: '推荐', badgeTone: 'balanced', note: '原生多模态 · 非思考模式 · Token Plan 可用 · ≤256K:2/8 · 256K-1M:6/24' },
  { id: 'qwen-long', name: 'Qwen Long', pricing: { input: 0.5, output: 2, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '长文本', badgeTone: 'fast', note: '10M 上下文 · 无长度阶梯' },
  { id: 'qwen-max', name: 'Qwen Max', pricing: { input: 2.4, output: 9.6, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '精准', badgeTone: 'powerful', note: '无长度阶梯 · 仅非思考模式' },
  { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', pricing: { input: 12, output: 36, currency: 'CNY' }, vision: false, provider: 'qwen', badge: '旗舰', badgeTone: 'powerful', note: '无长度阶梯 · 促销 ¥6/¥18 为限时5折活动价，非原价' },
  { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', pricing: { input: 12, output: 36, currency: 'CNY' }, vision: true, provider: 'qwen', badge: '旗舰', badgeTone: 'powerful', note: '原生多模态 · 1M 上下文 · Token Plan 可用 · 无长度阶梯' },
  { id: 'qwen3.8-max-preview', name: 'Qwen 3.8 Max Preview', pricing: { input: 12, output: 36, currency: 'CNY' }, vision: true, provider: 'qwen', badge: '预览', badgeTone: 'balanced', note: '原生多模态 · 首发预览 · 原价；折扣以百炼控制台活动为准' },
  { id: 'qwq-plus', name: 'QwQ Plus', pricing: { input: 1.6, output: 4, currency: 'CNY' }, vision: false, provider: 'qwen', note: '仅思考模式 · 无阶梯计价' },

  // ─── 名字带 `vl` 的传统视觉模型（tokenPlan 全为 false：Token Plan 端点不含这类模型）───
  { id: 'qwen3-vl-flash', name: 'Qwen 3 VL Flash', pricing: { input: 0.15, output: 1.5, currency: 'CNY' }, vision: true, provider: 'qwen', badge: '低价视觉', badgeTone: 'fast', note: '≤32K:0.15/1.5 · 32K-128K:0.3/3 · 128K-256K:0.6/6 · 需 DashScope 额度' },
  { id: 'qwen-vl-plus', name: 'Qwen VL Plus', pricing: { input: 0.8, output: 2, currency: 'CNY' }, vision: true, provider: 'qwen', note: '无长度阶梯 · 需 DashScope 额度' },
  { id: 'qwen3-vl-plus', name: 'Qwen 3 VL Plus', pricing: { input: 1, output: 10, currency: 'CNY' }, vision: true, provider: 'qwen', note: '≤32K:1/10 · 32K-128K:1.5/15 · 128K-256K:3/30 · 需 DashScope 额度' },
  { id: 'qwen-vl-max', name: 'Qwen VL Max', pricing: { input: 1.6, output: 4, currency: 'CNY' }, vision: true, provider: 'qwen', badge: '精准', badgeTone: 'powerful', note: '无长度阶梯 · 需 DashScope 额度' },

  // ─── DeepSeek 系列（峰谷定价：高峰 = 周一至周五 9:00–12:00、14:00–18:00，空闲为高峰 5 折）───
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', pricing: { input: 2, output: 8, currency: 'CNY' }, vision: false, provider: 'deepseek', badge: '低价', badgeTone: 'fast', note: '模型已下线，现由 V4.1-Flash 承接 · 峰谷：高峰2/8 · 空闲1/4' },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision', pricing: { input: 2, output: 8, currency: 'CNY' }, vision: true, provider: 'deepseek', badge: '视觉实验', badgeTone: 'fast', note: '模型已下线，现由 V4.1-Flash 承接 · 峰谷：高峰2/8 · 空闲1/4' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', pricing: { input: 9, output: 27, currency: 'CNY' }, vision: false, provider: 'deepseek', badge: '旗舰', badgeTone: 'powerful', note: '峰谷：高峰9/27 · 空闲4.5/13.5 · 2026-09-14 后继续提供、计费不变' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', pricing: { input: 2, output: 8, currency: 'CNY' }, vision: true, provider: 'deepseek', badge: '新一代', badgeTone: 'fast', note: '原生多模态 · Token Plan 可用 · 峰谷：高峰2/8 · 空闲1/4' },

  // ─── 第三方 ───
  { id: 'glm-4.7', name: 'GLM 4.7', pricing: { input: 2, output: 8, currency: 'CNY' }, vision: false, provider: 'glm', badge: '智谱', badgeTone: 'balanced', note: '双重分档 · 输入[0,32K)+输出[0,0.2K):2/8 · 输入[0,32K)+输出[0.2K+):3/14 · 输入[32K,200K):4/16' },
  { id: 'glm-5', name: 'GLM 5', pricing: { input: 4, output: 18, currency: 'CNY' }, vision: false, provider: 'glm', badge: '智谱', badgeTone: 'balanced', note: '输入[0,32K):4/18 · 输入[32K+):6/22' },
  { id: 'glm-5.2', name: 'GLM 5.2', pricing: { input: 8, output: 28, currency: 'CNY' }, vision: false, provider: 'glm', badge: 'Token Plan', badgeTone: 'balanced', note: '1M 上下文 · 无分档 · 已入 Token Plan' },
  { id: 'glm-5.3', name: 'GLM 5.3', pricing: { input: 8, output: 28, currency: 'CNY' }, vision: false, provider: 'glm', badge: 'Token Plan', badgeTone: 'balanced', note: '1M 上下文 · 无分档 · 已入 Token Plan' },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', pricing: { input: 0.8, output: 2.8, currency: 'CNY' }, vision: false, provider: 'glm', badge: '超低价', badgeTone: 'fast', note: '≈GLM-5.3 的 1/10 · 标准价，限时五折 0.4/1.4' },
  { id: 'mimo-v2.5', name: 'MiMo v2.5', pricing: { input: 1, output: 2, currency: 'CNY' }, vision: false, provider: 'other', badge: '低价', badgeTone: 'fast', note: '小米·轻量低价 · 无上下文窗口分档' },
]);

/** 按 id 建索引（含小写容错）。*/
const _byId = new Map();
for (const m of CLOUD_MODELS) _byId.set(m.id, m);

/** 模型名归一化：把带日期后缀的别名折叠回目录主名。*/
const MODEL_ALIASES = Object.freeze({
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
});

/**
 * 归一化模型名。
 * @param {string} modelId 原始模型名
 * @returns {string} 归一化后的模型名（未收录别名时原样返回）
 */
function normalizeModelId(modelId) {
  const key = String(modelId || '').trim();
  if (!key) return '';
  if (MODEL_ALIASES[key]) return MODEL_ALIASES[key];
  if (_byId.has(key)) return key;
  const lower = key.toLowerCase();
  if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];
  for (const m of CLOUD_MODELS) {
    if (m.id.toLowerCase() === lower) return m.id;
  }
  return key;
}

/**
 * 查模型档案。
 * @param {string} modelId 模型名
 * @returns {object|null} 命中返回档案，未收录返回 null（不瞎猜）
 */
function getModel(modelId) {
  const norm = normalizeModelId(modelId);
  return _byId.get(norm) || null;
}

/**
 * 取模型价格。
 * @param {string} modelId 模型名
 * @returns {{input:number,output:number}|null} 价格；未收录返回 null
 */
function getPricing(modelId) {
  const m = getModel(modelId);
  return (m && m.pricing) ? m.pricing : null;
}

/**
 * 是否视觉（图片）模型。
 * @param {string} modelId 模型名
 * @returns {boolean} 未收录时按 false 处理
 */
function isVisionModel(modelId) {
  const m = getModel(modelId);
  return !!(m && m.vision);
}

/**
 * 某模型是否属于 Token Plan 端点可服务范围。
 * 必须做**别名归一化后**的比较，不能直接 `TOKEN_PLAN_MODELS.includes(id)`。
 * 例：端点白名单里是 `deepseek-v4-flash-0731`，而目录主名是 `deepseek-v4-flash`；
 * 直接比对会漏判 → 前端把实际可用的模型标成「不可用」，反向误导用户。
 * @param {string} modelId 模型名
 * @returns {boolean} 是否在 Token Plan 可服务范围内
 */
function isTokenPlanAvailable(modelId) {
  const norm = normalizeModelId(modelId);
  if (!norm) return false;
  if (TOKEN_PLAN_MODELS.includes(norm)) return true;
  // 把白名单项也归一化后比对，消除「目录主名 vs 端点别名」的差异
  return TOKEN_PLAN_MODELS.some((m) => normalizeModelId(m) === norm);
}

/**
 * 某模型在指定额度来源下是否可调用。
 * 这是修复云端视觉 404 的核心判据：
 * billingSource='token-plan' 时，端点只认 TOKEN_PLAN_MODELS 白名单；
 * 名字带 `vl` 的传统视觉模型（qwen3-vl-*）不在白名单内 → 返回不可用并给出可执行的修复建议。
 * @param {string} modelId 模型名
 * @param {string} billingSource 'token-plan' | 'dashscope'
 * @returns {{ok:boolean, reason:string, suggestion:string}} 判定结果
 */
function checkBilling(modelId, billingSource) {
  const norm = normalizeModelId(modelId);
  if (!norm) {
    return { ok: false, reason: '模型名为空', suggestion: '请先在「审核配置 → 云端审核配置」中选择模型' };
  }
  if (billingSource !== BILLING_SOURCES.TOKEN_PLAN) {
    return { ok: true, reason: '', suggestion: '' };
  }
  if (isTokenPlanAvailable(norm)) return { ok: true, reason: '', suggestion: '' };

  const m = getModel(norm);
  const isVision = !!(m && m.vision);
  return {
    ok: false,
    reason: isVision
      ? `Token Plan 端点不含传统视觉模型，「${norm}」无法调用`
      : `Token Plan 端点不含「${norm}」`,
    suggestion: isVision
      ? 'Token Plan 额度下请改选原生多模态模型（如 qwen3.8-flash / qwen3.7-plus）；或把「额度来源」切到 dashscope 以使用 qwen3-vl-*；或改用本地视觉模型 qwen3-vl:8b-instruct'
      : '请切换到 DashScope 额度，或在 Token Plan 中改选白名单内的模型',
  };
}

/**
 * 列出可用于审核的文本模型（供前端下拉）。
 * 不过滤 `vision`：原生多模态模型（qwen3.8-flash / qwen3.7-plus / qwen3.6-flash 等）
 * 既能审文也能审图，必须出现在文本下拉里才选得到；它们同时落在视觉下拉。
 * 返回项带 `vision` 布尔标记，供前端渲染「亦可审图」角标。
 * @returns {object[]} 精简单列表
 */
function listTextModels() {
  return CLOUD_MODELS.map((m) => ({
    id: m.id, name: m.name, pricing: m.pricing, icon: m.provider,
    badge: m.badge, badgeTone: m.badgeTone, provider: m.provider, note: m.note,
    vision: !!m.vision,
    tokenPlan: isTokenPlanAvailable(m.id),
  }));
}

/**
 * 列出可用于审核的视觉模型（供前端下拉）。
 * 视觉清单是文本清单的**真子集**（每个视觉模型也能审文），故其必然 ⊆ 文本清单。
 * @returns {object[]} 精简单列表
 */
function listVisionModels() {
  return CLOUD_MODELS.filter((m) => m.vision).map((m) => ({
    id: m.id, name: m.name, pricing: m.pricing, icon: m.provider,
    badge: m.badge, badgeTone: m.badgeTone, provider: m.provider, note: m.note,
    vision: !!m.vision,
    tokenPlan: isTokenPlanAvailable(m.id),
  }));
}

module.exports = {
  BILLING_SOURCES,
  TOKEN_PLAN_MODELS,
  CLOUD_MODELS,
  getModel,
  getPricing,
  isVisionModel,
  normalizeModelId,
  isTokenPlanAvailable,
  checkBilling,
  listTextModels,
  listVisionModels,
};