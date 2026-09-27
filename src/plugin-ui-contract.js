/**
 * 插件 UI 类目契约（单一真相）。
 *
 * v0.2.0：把「插件视图/配置面板能落到哪些 Tab」收敛为受控枚举，唯一定义处即本文件。
 * 必须是受控枚举：Tab 是固定的一等公民（`public/index.html` 里 13 个硬编码 `#tab-*`），
 * 类目本质是「路由目标」；允许自由字符串 = 插件可往不存在的路由写数据，会重演 2026-09-17 的
 * B1 缺陷（`moderation` 无 slot ⇒ 视图被 `if (!slot) continue;` 静默丢弃）。
 * 消费者：`plugin-ui-schema.js#registerViews`（校验 `views[].category`）、`plugin-host.js#buildViewsPayload`
 * （下发枚举与告警）、`public/index.html`（用下发值校验并比对 DOM slot）、`scripts/lint-plugin-ui.js`。
 * 注意：`moderation` / `config` **不在**枚举内（历史遗留、非 Tab）；`moderation` 正确归位是 `flow`。
 */

'use strict';

/** 12 个「业务类目」= 承载业务视图的 Tab（与 `public/index.html` 的 `#tab-*` 一一对应）。*/
const VIEW_CATEGORIES = Object.freeze([
  'text',    // 文本审核
  'image',   // 图片审核
  'batch',   // 批量测试
  'history', // 审核记录
  'chat',    // 对话
  'compare', // 对比审核
  'flow',    // 审核配置
  'docs',    // API 文档
  'worddb',  // 词库管理
  'stats',   // 统计面板
  'models',  // 本地模型
  'system',  // 系统信息
]);

/**
 * 生命周期类目：不承载业务视图。
 * 插件的**视图**不得声明 `plugins`（它只用于「未知类目兜底渲染」与「插件生命周期总览」）；
 * 插件的**配置面板**（`contributes.ui.panel`）显式写 `plugins` 视为「留在插件管理」⇒ 归一化为 null。
 */
const LIFECYCLE_CATEGORY = 'plugins';

/** 13 个 Tab 类目 = 12 业务类目 + 生命周期类目（= DOM 里应存在的 `.plugin-view-slot` 集合大小）。*/
const TAB_CATEGORIES = Object.freeze([...VIEW_CATEGORIES, LIFECYCLE_CATEGORY]);

/**
 * 历史遗留类目 → 推荐归位的提示表。
 * 仅供 lint 输出「你是不是想写 X」的提示，**不作为运行时兜底**（运行时兜底一律走可见告警）。
 */
const LEGACY_CATEGORY_HINTS = Object.freeze({
  moderation: 'flow',
  config: 'flow',
});

/**
 * 判定一个「业务视图类目」是否合法。
 * 明确排除 `plugins`（生命周期 Tab 不该承载业务视图）。
 * @param {*} c 类目值
 * @returns {boolean} 是否合法
 */
function isValidViewCategory(c) {
  if (c === undefined || c === null) return false;
  return VIEW_CATEGORIES.includes(String(c).trim());
}

/**
 * 判定一个 `contributes.ui.panel` 值是否合法（受控枚举 = VIEW_CATEGORIES，不含 `plugins`）。
 * @param {*} c 面板值
 * @returns {boolean} 是否合法
 */
function isValidPanel(c) {
  if (c === undefined || c === null) return false;
  const v = String(c).trim();
  if (v === LIFECYCLE_CATEGORY) return false;
  return VIEW_CATEGORIES.includes(v);
}

/**
 * 判定一个值是否是合法的 Tab 类目（含生命周期类目）。
 * @param {*} c 类目值
 * @returns {boolean} 是否合法
 */
function isValidTabCategory(c) {
  if (c === undefined || c === null) return false;
  return TAB_CATEGORIES.includes(String(c).trim());
}

/**
 * 解析插件「配置面板」的归位 Tab。
 * 优先级：`contributes.ui.panel`（合法）→ 首个 `views[].category`（合法）→ `null`（留在插件管理）。
 * @param {object} ui `contributes.ui`
 * @param {Array<object>} views `contributes.views`
 * @returns {string|null} 归位 Tab 类目，或 null（留在插件管理）
 */
function resolvePluginPanel(ui, views) {
  const panel = ui && typeof ui === 'object' ? ui.panel : null;
  if (panel !== undefined && panel !== null) {
    const p = String(panel).trim();
    // 显式写 plugins ⇒ 视为「留在插件管理」（返回 null），不报错
    if (p === LIFECYCLE_CATEGORY) return null;
    if (isValidPanel(p)) return p;
  }
  if (Array.isArray(views)) {
    for (const v of views) {
      if (!v || v.category === undefined || v.category === null) continue;
      const c = String(v.category).trim();
      if (isValidViewCategory(c)) return c;
    }
  }
  return null;
}

/**
 * 取历史遗留类目的归位提示（无则 null）。
 * @param {*} c 类目值
 * @returns {string|null} 推荐的合法类目
 */
function legacyCategoryHint(c) {
  if (c === undefined || c === null) return null;
  return LEGACY_CATEGORY_HINTS[String(c).trim()] || null;
}

module.exports = {
  VIEW_CATEGORIES,
  TAB_CATEGORIES,
  LIFECYCLE_CATEGORY,
  LEGACY_CATEGORY_HINTS,
  isValidViewCategory,
  isValidPanel,
  isValidTabCategory,
  resolvePluginPanel,
  legacyCategoryHint,
};
