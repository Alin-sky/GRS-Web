#!/usr/bin/env node
/**
 * QA 审核记录「分模态」验证（scripts/qa-history-modality.js）—— T07 / R6（记录分类切片）
 *
 * 覆盖（纯静态，不启动服务、不写盘）：
 *   1. `public/index.html` 存在「全部 / 文本 / 图片」筛选：
 *      状态 `setHistoryFilter` + 应用 `applyHistoryFilter` + 三个按钮（`data-filter=all|text|image`）
 * 2. 请求参数**未变**：审核记录相关 fetch 的查询串**仍然只有 `date`**，
 *      **没有新增** `?type=` / `?modality=`（这是「无参数 ⇒ 与现状逐字节一致」兼容红线的守门）
 *   3. 筛选是**纯前端**：`setHistoryFilter` 体内不得出现任何网络调用
 *   4. 旧记录（无 `image_ref`）渲染**优雅退化**不空白：
 *      `data-img` 用真值判定 ⇒ 旧记录归 `0`；`applyHistoryFilter` 把非图片记录并入「文本」桶；
 *      存在 `historyFilterEmpty` 空态；`image_ref` 渲染分支被 `if` 守卫、缺省为空串
 *
 * 输出格式与其它 `qa-*.js` 一致；全过 exit 0，任一失败 exit 1。
 * 本脚本只读，不修改任何产品代码。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');

/** 允许出现在审核记录请求上的**唯一**查询参数。 */
const ALLOWED_QUERY = ['date'];
/** 明令禁止新增的查询参数（分模态筛选「绝不能」下推到请求）。 */
const FORBIDDEN_QUERY = ['type', 'modality', 'img', 'kind', 'media', 'filter'];

let passed = 0;
let failed = 0;
const rows = [];

/**
 * 记录一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 证据串
 * @returns {void}
 */
function check(name, ok, detail) {
  if (ok) passed += 1; else failed += 1;
  rows.push({ name, ok, detail: detail || '' });
}

/** 输出报告。 */
function report() {
  const line = '-'.repeat(96);
  console.log(line);
  console.log('GRS QA audit-record modality filter (T07 / R6)');
  console.log(line);
  for (const r of rows) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(46)} ${r.detail}`);
  }
  console.log(line);
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

const html = fs.readFileSync(INDEX_PATH, 'utf-8');

// ──────────────────────────────────────────────────────────
// 1. 筛选 UI + 状态机
// ──────────────────────────────────────────────────────────
const setFnIdx = html.indexOf('function setHistoryFilter');
const applyFnIdx = html.indexOf('function applyHistoryFilter');
check('filter/setHistoryFilter-defined', setFnIdx >= 0, `index@${setFnIdx}`);
check('filter/applyHistoryFilter-defined', applyFnIdx >= 0, `index@${applyFnIdx}`);

for (const f of ['all', 'text', 'image']) {
  const btnRe = new RegExp(`data-filter="${f}"[^>]*onclick="setHistoryFilter\\('${f}'\\)"|onclick="setHistoryFilter\\('${f}'\\)"[^>]*data-filter="${f}"`);
  check(`filter/button-${f}`, btnRe.test(html), `data-filter="${f}" + onclick setHistoryFilter('${f}')`);
}
check('filter/state-var', /let\s+_historyFilter\s*=/.test(html), `_historyFilter state present`);

// ──────────────────────────────────────────────────────────
// 3. 纯前端：setHistoryFilter 内不得有网络调用
// ──────────────────────────────────────────────────────────
const setBody = (setFnIdx >= 0 && applyFnIdx > setFnIdx) ? html.slice(setFnIdx, applyFnIdx) : '';
check('filter/setHistoryFilter-is-pure-frontend',
  setBody.length > 0 && !/\bfetch\s*\(/.test(setBody) && !/XMLHttpRequest/.test(setBody),
  setBody.length > 0 ? `bodyLen=${setBody.length} fetch=${/\bfetch\s*\(/.test(setBody)}` : 'body not isolated');

// ──────────────────────────────────────────────────────────
// 2. 请求参数未变：审核记录 fetch 的查询串只有 date
//    取 URL 的方式：以 `/api/audit-records` 为锚，向左右扩到最近的引号/反引号/行尾
//    （不用宽松正则跨行反匹配 —— 那会把整段代码当成 URL，产生假命中/假漏判）。
// ──────────────────────────────────────────────────────────
/**
 * 抽取 HTML 中所有包含指定路径片段的 URL 字面量。
 * @param {string} src 源码
 * @param {string} needle 路径片段（如 `/api/audit-records`）
 * @returns {string[]} URL 字面量（不含外层引号）
 */
function extractUrlsAround(src, needle) {
  const out = [];
  let idx = src.indexOf(needle);
  while (idx >= 0) {
    let s = idx;
    while (s > 0 && !/[\n`'"]/.test(src[s - 1])) s -= 1;
    const delim = src[s - 1];
    let e = idx;
    while (e < src.length && src[e] !== delim && src[e] !== '\n') e += 1;
    out.push(src.slice(s, e));
    idx = src.indexOf(needle, idx + needle.length);
  }
  return out;
}

const auditUrls = extractUrlsAround(html, '/api/audit-records');
check('request/audit-records-fetch-exists', auditUrls.length >= 1, `found ${auditUrls.length} occurrence(s)`);

const queryNames = [];
for (const u of auditUrls) {
  const qs = u.split('?')[1] || '';
  for (const pair of qs.split('&')) {
    const name = pair.split('=')[0].trim();
    if (name) queryNames.push(name);
  }
}
const unexpected = queryNames.filter((n) => !ALLOWED_QUERY.includes(n));
const forbiddenHit = FORBIDDEN_QUERY.filter((p) => auditUrls.some((u) => new RegExp(`[?&]${p}=`).test(u)));
check('request/only-date-param', queryNames.length > 0 && unexpected.length === 0,
  `params=[${queryNames.join(',')}] unexpected=[${unexpected.join(',')}]`);
check('request/no-type-modality-param', forbiddenHit.length === 0,
  `forbidden present=[${forbiddenHit.join(',')}]`);
check('request/audit-url-literal', auditUrls.some((u) => u.includes('/api/audit-records?date=')),
  auditUrls.join(' | ').slice(0, 200));

// ──────────────────────────────────────────────────────────
// 4. 旧记录优雅退化（不空白）
// ──────────────────────────────────────────────────────────
check('legacy/data-img-truthy-guard',
  /data-img="\$\{\(log\.image_ref\s*&&\s*log\.image_ref\.hash\)\s*\?\s*1\s*:\s*0\}"/.test(html),
  'data-img = (image_ref && image_ref.hash) ? 1 : 0');
check('legacy/image-branch-guarded',
  /if\s*\(log\.image_ref\s*&&\s*log\.image_ref\.hash\)\s*\{/.test(html),
  'if (log.image_ref && log.image_ref.hash) { ... }');
check('legacy/empty-defaults-present',
  /let\s+imageCoverHtml\s*=\s*'';/.test(html) && /let\s+imageDetailHtml\s*=\s*'';/.test(html),
  'imageCoverHtml/imageDetailHtml default to empty string');
check('legacy/text-bucket-includes-nonimage',
  /_historyFilter\s*===\s*'text'\s*\?\s*!isImg/.test(html) || /!\s*isImg/.test(html),
  "applyHistoryFilter: 'text' bucket = !isImg");
check('legacy/empty-state-element',
  html.includes('id="historyFilterEmpty"') && /getElementById\('historyFilterEmpty'\)/.test(html),
  'historyFilterEmpty element + lookup present');

report();
