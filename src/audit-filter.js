/**
 * 审核记录筛查纯函数（src/audit-filter.js）
 *
 * 为什么单独成模块（而不是散在路由里）：
 *  ① JSONL 与 DB 两条读取路径的记录形状由 `audit-db.query()` 归一为
 *     `{id,timestamp,date,text,model,result,meta}`，但**判定口径必须两条路径完全一致**，
 *     否则会出现只在某一条路径复现的筛选差异。
 *  ② 前端「统计下钻 → 跳到审核记录并展开」用的分类判定，与服务端 `?category=` 必须同义，
 *     否则目标记录会被过滤器判成「不匹配」而被 display:none 藏掉（本轮修复的实际缺陷）。
 *  集中成零依赖纯函数 ⇒ 可离线单测，不需要起服务、不触网、不碰生产数据。
 */

'use strict';

/** 取记录的 result 子对象；缺失/非对象 ⇒ 空对象。 */
function resultOf(record) {
  return record && record.result && typeof record.result === 'object' ? record.result : {};
}

/** 类目数组（剔除空值）。 */
function categoriesOf(record) {
  const cats = resultOf(record).categories;
  return Array.isArray(cats) ? cats.filter(Boolean) : [];
}

/**
 * 分类命中判定。
 * `unclassified` = **违规且无类目**（只读布尔 `passed === false`，不用 action/risk_level 反推）；
 * 其余类目按 `result.categories` 是否包含判定。空 category ⇒ 不过滤。
 * @param {object} record 审核记录
 * @param {string|null} category 类目 ID 或 'unclassified'
 * @returns {boolean} 是否命中
 */
function matchesCategory(record, category) {
  if (!category) return true;
  const cats = categoriesOf(record);
  if (category === 'unclassified') return resultOf(record).passed === false && cats.length === 0;
  return cats.includes(category);
}

/** 关键词匹配用的候选文本（待审内容 / 判定理由 / 记录 id / 调用方标识），整体小写。 */
function keywordHaystack(record) {
  const r = resultOf(record);
  const meta = record && record.meta && typeof record.meta === 'object' ? record.meta : {};
  const parts = [
    record && record.text,
    r.reason,
    record && record.id,
    meta.userId,
    meta.groupId,
    meta.scene,
  ];
  return parts
    .map((p) => (p === undefined || p === null ? '' : String(p)))
    .join('\n')
    .toLowerCase();
}

/**
 * 关键词筛查：按空白分词，**每个词都要命中**（AND），大小写不敏感的子串匹配。
 * `q` 为空或全空白 ⇒ 视为不过滤。
 * @param {object} record 审核记录
 * @param {string} q 关键词
 * @returns {boolean} 是否命中
 */
function matchesKeyword(record, q) {
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  if (!needle) return true;
  const hay = keywordHaystack(record);
  return needle.split(/\s+/).filter(Boolean).every((token) => hay.includes(token));
}

/**
 * 精确 id 命中（字符串比较，容忍数字 id 与字符串 id）。`id` 为空 ⇒ 不过滤。
 * @param {object} record 审核记录
 * @param {string|number} id 目标记录 id
 * @returns {boolean} 是否命中
 */
function matchesId(record, id) {
  if (id === undefined || id === null || id === '') return true;
  return String(record && record.id) === String(id);
}

/**
 * 组合过滤：id 精确 / 分类 / 关键词三者叠加（AND）。返回新数组，不改写入参。
 * @param {Array<object>} records 记录列表
 * @param {{id?:string|number, category?:string, q?:string}} [criteria] 筛选条件
 * @returns {Array<object>} 命中的记录
 */
function filterRecords(records, criteria = {}) {
  const list = Array.isArray(records) ? records : [];
  const c = criteria && typeof criteria === 'object' ? criteria : {};
  return list.filter((r) => matchesId(r, c.id) && matchesCategory(r, c.category) && matchesKeyword(r, c.q));
}

module.exports = {
  resultOf,
  categoriesOf,
  matchesCategory,
  matchesKeyword,
  matchesId,
  filterRecords,
  keywordHaystack,
};
