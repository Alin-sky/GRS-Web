#!/usr/bin/env node
/**
 * 图片内容寻址 + 插件面板归位 + 图片读取端点 回归（scripts/test-image-ref.js）
 *
 * 覆盖 v0.2.0 图片持久化的**可执行断言**（team-lead 完成标准 ② 的 7 项）：
 *   ① 同图同 hash（内容寻址确定性）与不同图不同 hash
 *   ② 双写失败语义（JSONL 失败 ⇒ saveAuditRecord 返回 null 不抛）
 *   ③ 回灌幂等（DB 重复回灌行数不翻倍）
 *   ④ 未知 / 非法类目**可见兜底**（视图落到「插件管理」槽 + 顶部告警条 + console.warn）
 *   ⑤ 配置面板刷新存活（R2-16 竞态：`.plugin-config-slot` 与业务视图槽物理隔离）
 *   ⑥ 图片读取端点 `GET /api/audit-image/:hash`（200 / 400 目录穿越 / 404 缺失）
 *   ⑦ `listAuditDates()` 过滤 `/^_/`（留痕文件不被当成一天）
 *
 * 测试隔离：`GRS_AUDIT_DIR` + `GRS_AUDIT_DB` + `GRS_BLOB_DIR` 全部指向临时目录；
 *   **绝不触碰生产** `data/audit_records/`、`data/audit.db`、`data/image_blobs/`（脚本内自证）。
 *
 * 用法：node scripts/test-image-ref.js
 * 退出码：全部通过为 0，否则为 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PROD_AUDIT_DIR = path.join(ROOT, 'data', 'audit_records');
const PROD_DB = path.join(ROOT, 'data', 'audit.db');

// ─── 生产状态快照（必须在 require 业务模块之前取）───
/**
 * 快照一个路径（文件或目录）用于「测试未污染生产」自证。
 * @param {string} p 路径
 * @returns {object} 快照
 */
function snapPath(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const names = fs.readdirSync(p).sort();
      return { exists: true, dir: true, names: names.join('|'), count: names.length, mtime: st.mtimeMs };
    }
    return { exists: true, dir: false, count: 1, size: st.size, mtime: st.mtimeMs };
  } catch {
    return { exists: false, dir: false, count: 0, mtime: 0 };
  }
}
const PROD_BEFORE = { auditDir: snapPath(PROD_AUDIT_DIR), db: snapPath(PROD_DB) };

// ─── 隔离（必须在 require 业务模块之前）───
const SANDBOX = path.join(os.tmpdir(), `grs-imageref-${Date.now()}`);
const AUDIT_DIR = path.join(SANDBOX, 'audit_records');
const DB_FILE = path.join(SANDBOX, 'audit.db');
const BLOB_DIR = path.join(SANDBOX, 'image_blobs');
fs.mkdirSync(AUDIT_DIR, { recursive: true });
process.env.GRS_AUDIT_DIR = AUDIT_DIR;
process.env.GRS_AUDIT_DB = DB_FILE;
process.env.GRS_BLOB_DIR = BLOB_DIR;
process.env.QA_GUARD_CONFIG_WRITE = '1';

const PRELOAD = path.join(ROOT, 'scripts', 'qa-runtime-preload.js');
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

const imageRef = require('../src/image-ref');
const auditStore = require('../src/audit-store');
const auditDb = require('../src/audit-db');
const uiContract = require('../src/plugin-ui-contract');

let passed = 0;
let failed = 0;

/**
 * 断言并打印一行。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 详情
 * @returns {void}
 */
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name.padEnd(58)} ${detail}`); } else { failed += 1; console.log(`  FAIL  ${name.padEnd(58)} ${detail}`); }
}

/** 最小 PNG（1×1 透明） */
const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** 另一个 1×1 PNG（不同字节 ⇒ 不同 hash） */
const PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

// ══════════════════════════════════════════════════════════
// 最小 DOM shim（仅用于「真跑」renderPluginViews，验证 R2-16 竞态已消除）
// ══════════════════════════════════════════════════════════

/** 所有被 createElement / 手工构造的元素（用于 id/class 检索） */
let REG = [];

/**
 * 造一个最小元素。
 * @param {string} tag 标签名
 * @returns {object} 元素
 */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    id: '',
    style: {},
    dataset: {},
    _children: [],
    _html: '',
    parentNode: null,
    textContent: '',
    scrollIntoView() { },
    appendChild(c) { el._children.push(c); c.parentNode = el; return c; },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); if (!el._html) el._children = []; },
    querySelector(sel) { return queryAll(sel, el)[0] || null; },
    querySelectorAll(sel) { return queryAll(sel, el); },
    addEventListener() { },
  };
  REG.push(el);
  return el;
}

/**
 * 极简选择器匹配：支持 `.cls` / `.cls[data-K="V"]` / `.tab[data-K="V"]`。
 * @param {object} el 元素
 * @param {string} sel 选择器
 * @returns {boolean} 是否匹配
 */
function matchesSel(el, sel) {
  const m = /^\.([\w-]+)(?:\[data-([\w-]+)="([^"]*)"\])?$/.exec(sel);
  if (!m) return false;
  const classes = String(el.className || '').split(/\s+/);
  if (classes.indexOf(m[1]) < 0) return false;
  if (m[2] !== undefined) return String(el.dataset[m[2]] || '') === m[3];
  return true;
}

/**
 * 在（可选）子树内按选择器查找。
 * @param {string} sel 选择器
 * @param {object} [scope] 子树根
 * @returns {Array<object>} 命中元素
 */
function queryAll(sel, scope) {
  if (sel === '.plugin-config-card') {
    return REG.filter((e) => String(e.className).split(/\s+/).indexOf('plugin-config-card') >= 0);
  }
  return REG.filter((e) => matchesSel(e, sel));
}

/**
 * 构造一个用于 renderPluginViews 的假 document。
 * @returns {{doc: object, tabs: Array<object>, warnBox: object, clicked: Array<string>}}
 */
function makeDoc() {
  REG = [];
  const doc = {
    createElement: (t) => makeEl(t),
    getElementById: (id) => REG.find((e) => e.id === id) || null,
    querySelector: (s) => queryAll(s)[0] || null,
    querySelectorAll: (s) => queryAll(s),
  };
  const cats = uiContract.TAB_CATEGORIES;
  for (const c of cats) {
    const v = makeEl('div'); v.className = 'plugin-view-slot'; v.dataset.category = c;
    const k = makeEl('div'); k.className = 'plugin-config-slot'; k.dataset.category = c;
    void v; void k;
  }
  const clicked = [];
  const tabs = cats.map((c) => {
    const t = makeEl('div');
    t.className = 'tab';
    t.dataset.tab = c;
    t.textContent = `标签-${c}`;
    t.click = () => { clicked.push(c); };
    return t;
  });
  const warnBox = makeEl('div');
  warnBox.id = 'pluginWarnings';
  REG.push(warnBox);
  return { doc, tabs, warnBox, clicked };
}

/**
 * 从源码里按名字抽取函数定义（跳过字符串/模板串/注释，做精确括号配对）。
 * @param {string} text 源码
 * @param {string} name 函数名
 * @returns {string} 函数源码
 */
function extractFn(text, name) {
  const re = new RegExp(`(?:^|\\n)(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(text);
  if (!m) throw new Error(`未在 index.html 中找到函数 ${name}`);
  let i = text.indexOf('{', m.index + m[0].length - 1);
  if (i < 0) throw new Error(`函数 ${name} 缺少函数体`);
  let depth = 0;
  let j = i;
  const n = text.length;
  while (j < n) {
    const ch = text[j];
    const next = text[j + 1];
    if (ch === '/' && next === '/') { j = text.indexOf('\n', j); if (j < 0) break; continue; }
    if (ch === '/' && next === '*') { j = text.indexOf('*/', j + 2); if (j < 0) break; j += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      j += 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === q) { j += 1; break; }
        j += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
    j += 1;
  }
  return text.slice(m.index, j).replace(/^\n/, '');
}

/**
 * 用「真源码 + 假 DOM」跑 renderPluginViews，验证 R2-16 竞态已消除。
 * @returns {void}
 */
function testRenderPluginViews() {
  console.log('\n── ④⑤ 插件面板归位 / 未知类目可见兜底 / 刷新存活（真跑 renderPluginViews）──');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  const pvCats = JSON.parse((/const _PV_CATEGORIES = (\[[^\]]*\]);/.exec(html)[1]).replace(/'/g, '"'));
  const body = `
const _PV_CATEGORIES = ${JSON.stringify(pvCats)};
let _pvRuntimes = [];
let _pvConfigs = {};
let _pvPlugins = {};
let _pvPanels = {};
${extractFn(html, 'renderPluginViews')}
${extractFn(html, 'renderPluginConfigSlots')}
${extractFn(html, 'renderPluginWarnings')}
${extractFn(html, 'assertSlotTabDrift')}
${extractFn(html, '_pvPanelOf')}
${extractFn(html, '_pvTabLabel')}
${extractFn(html, 'gotoPluginPanel')}
return { renderPluginViews, renderPluginConfigSlots, renderPluginWarnings, assertSlotTabDrift,
  _pvPanelOf, _pvTabLabel, gotoPluginPanel, getPanels: () => _pvPanels };
`;
  const viewsPayload = {
    status: 'ready',
    categories: uiContract.VIEW_CATEGORIES.slice(),
    warnings: [{ pluginId: 'x1', kind: 'panel-invalid', message: '插件 x1 的 ui.panel 非法' }],
    panels: { p1: 'image', p2: null, p3: 'image' },
    views: [
      { pluginId: 'p1', viewId: 'main', category: 'image', title: 'p1 视图', categoryInvalid: false, schema: {} },
      { pluginId: 'p3', viewId: 'main', category: 'moderation', title: 'p3 视图', categoryInvalid: true, schema: {} },
    ],
  };
  const pluginsPayload = {
    plugins: [{ id: 'p1', name: '插件一' }, { id: 'p2', name: '插件二' }, { id: 'p3', name: '插件三' }],
    configs: [
      { name: 'p1', fields: [{ key: 'a', value: 1 }], groups: [] },
      { name: 'p2', fields: [{ key: 'b', value: 2 }], groups: [] },
    ],
  };
  const fetched = [];
  const fakeFetch = (url) => {
    fetched.push(String(url));
    const payload = String(url).indexOf('plugin-views') >= 0 ? viewsPayload : pluginsPayload;
    return Promise.resolve({ json: () => Promise.resolve(payload) });
  };
  const warns = [];
  const { doc, warnBox, clicked } = makeDoc();
  const api = new Function(
    'document', 'fetch', 'API', 'makeViewCtx', 'renderViewCard', 'applyCompareTabAvailability',
    'startPolls', 'renderPluginConfig', 'escapeHtml', 'console', 'setTimeout', body
  )(
    doc, fakeFetch, '',
    (view) => ({ view, timers: [] }),
    () => { const c = doc.createElement('div'); c.className = 'view-card'; return c; },
    () => { },
    () => { },
    () => '<div class="rendered-config"></div>',
    (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''),
    { warn: (...a) => warns.push(a.join(' ')), log: () => { }, error: () => { } },
    (fn) => { fn(); return 0; }
  );

  check('P/1 从 index.html 抽出的 _PV_CATEGORIES == 服务端 TAB_CATEGORIES',
    JSON.stringify(pvCats) === JSON.stringify(uiContract.TAB_CATEGORIES), `cats=${pvCats.length}`);

  const run = () => api.renderPluginViews();
  return run().then(() => {
    const box = (cls, cat) => doc.querySelectorAll(`.${cls}[data-category="${cat}"]`)[0];
    check('P/2 p1 业务视图落到 .plugin-view-slot[image]', box('plugin-view-slot', 'image')._children.length === 1,
      `n=${box('plugin-view-slot', 'image')._children.length}`);
    check('P/3 p1 配置面板落到 .plugin-config-slot[image]', box('plugin-config-slot', 'image')._children.length === 1,
      `n=${box('plugin-config-slot', 'image')._children.length}`);
    check('P/4 未知类目 moderation 视图**可见**兜底到 plugins 槽（不静默丢弃）',
      box('plugin-view-slot', 'plugins')._children.length === 1,
      `n=${box('plugin-view-slot', 'plugins')._children.length}`);
    check('P/5 未声明归位的 p2 配置留在 plugins 槽（向后兼容）',
      box('plugin-config-slot', 'plugins')._children.length === 1,
      `n=${box('plugin-config-slot', 'plugins')._children.length}`);
    check('P/6 配置卡物理上不在任何业务视图槽内（R2-16 根因已消除）',
      doc.querySelectorAll('.plugin-view-slot').every((s) => s._children.every((c) => c.className.indexOf('plugin-config-card') < 0)),
      'views clean');
    check('P/7 告警条可见且透出兜底文案', warnBox.style.display === '' && warnBox.innerHTML.indexOf('不在受控枚举内') >= 0,
      `display="${warnBox.style.display}"`);
    check('P/8 console.warn 已对非法面板/类目发声', warns.some((w) => w.indexOf('plugin-ui') >= 0),
      `warns=${warns.length}`);

    // 刷新存活：再次 renderPluginViews ⇒ 配置卡必须**重建且仍在**（旧实现会被清空且不再生成）
    const firstCard = box('plugin-config-slot', 'image')._children[0];
    return run().then(() => {
      const n = box('plugin-config-slot', 'image')._children.length;
      const newCard = box('plugin-config-slot', 'image')._children[0];
      check('P/9 刷新后配置面板仍然存活（R2-16 回归点）', n === 1, `n=${n}`);
      check('P/10 刷新是「重建」而非复用陈旧节点', Boolean(newCard) && newCard.id === 'pluginConfig-p1' && newCard !== firstCard,
        `id=${newCard && newCard.id}`);
      check('P/11 刷新后兜底视图仍可见', box('plugin-view-slot', 'plugins')._children.length === 1,
        `n=${box('plugin-view-slot', 'plugins')._children.length}`);
      check('P/12 _pvPanelOf 语义：image / null→plugins / 未注册→plugins',
        api._pvPanelOf('p1') === 'image' && api._pvPanelOf('p2') === 'plugins' && api._pvPanelOf('zzz') === 'plugins',
        `${api._pvPanelOf('p1')}/${api._pvPanelOf('p2')}/${api._pvPanelOf('zzz')}`);
      check('P/13 _pvTabLabel 取到中文 Tab 名', api._pvTabLabel('image') === '标签-image', api._pvTabLabel('image'));

      // 漂移自检：正常无漂移；人为抽掉一个槽后必须被告警
      warns.length = 0;
      api.assertSlotTabDrift(uiContract.VIEW_CATEGORIES.slice());
      check('P/14 slot↔Tab 无漂移时不告警', !warns.some((w) => w.indexOf('漂移') >= 0), `warns=${warns.length}`);
      const victim = doc.querySelectorAll('.plugin-config-slot')[0];
      victim.className = 'plugin-config-slot-removed';
      warns.length = 0;
      api.assertSlotTabDrift(uiContract.VIEW_CATEGORIES.slice());
      check('P/15 缺槽时立刻告警（漂移可观测）', warns.some((w) => w.indexOf('漂移') >= 0), `warns=${JSON.stringify(warns)}`);
      victim.className = 'plugin-config-slot';

      // 跳转：切到目标 Tab
      clicked.length = 0;
      api.gotoPluginPanel('image', 'p1');
      check('P/16 gotoPluginPanel 切到目标 Tab', clicked[0] === 'image', `clicked=${clicked.join(',')}`);
    });
  });
}

// ══════════════════════════════════════════════════════════
// HTTP 工具
// ══════════════════════════════════════════════════════════

/**
 * 发一个 GET 请求，收集状态码 / 头 / 原始字节。
 * @param {string} url 完整 URL
 * @returns {Promise<{status: number, headers: object, body: Buffer}>} 响应
 */
function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }); });
  });
}

/**
 * 轮询 /health 直到就绪。
 * @param {string} base 基地址
 * @param {number} timeoutMs 超时
 * @returns {Promise<boolean>} 是否就绪
 */
async function waitForHealth(base, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await httpGet(`${base}/health`);
    if (r.status === 200) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

/**
 * 静态解析 index.html：返回某 id 所在元素**当前已展开的 <div> 祖先链**（从外到内）。
 *
 * 实现：先剥掉注释 / `<script>` / `<style>`（否则其中的 `<div`、`<body>` 等字面量会污染标签栈），
 * 再对目标 id 之前的前缀做 div 标签栈扫描（引号感知，避免属性值里的 `>` 提前截断）。
 * 只跟踪 div —— 能造成「隐藏祖先」的容器（`.tab-content` / `display:none`）都是 div。
 *
 * @param {string} html index.html 全文
 * @param {string} targetId 目标元素 id（不含引号）
 * @returns {Array<{class: string, style: string}>|null} div 祖先链；目标不存在时返回 null
 */
function divAncestorsOf(html, targetId) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const idx = stripped.indexOf(`id="${targetId}"`);
  if (idx < 0) return null;
  const prefix = stripped.slice(0, idx);
  const re = /<(\/?)div(?![\w-])((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = [];
  let m;
  while ((m = re.exec(prefix)) !== null) {
    if (m[1] === '/') { stack.pop(); continue; }
    const attrs = m[2] || '';
    if (/\/\s*$/.test(attrs)) continue; // 自闭合 <div ... />
    const classM = /\bclass\s*=\s*"([^"]*)"/.exec(attrs);
    const styleM = /\bstyle\s*=\s*"([^"]*)"/.exec(attrs);
    stack.push({ class: classM ? classM[1] : '', style: styleM ? styleM[1] : '' });
  }
  return stack;
}

/**
 * 找出所有**静态全屏浮层**：同时带 `id` 与 `position:fixed` 的 `<div>`。
 * 只看静态 HTML（模板串里动态创建的浮层不在此列，它们不在 Tab 容器内）。
 * @param {string} html 页面源码
 * @returns {Array<{id: string, tag: string}>} 浮层清单
 */
function fixedOverlaysOf(html) {
  const out = [];
  const seen = new Set();
  const re = /<div\b[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!/position\s*:\s*fixed/i.test(tag)) continue;
    const idm = /\bid="([^"]+)"/.exec(tag);
    if (!idm) continue;
    if (seen.has(idm[1])) continue;
    seen.add(idm[1]);
    out.push({ id: idm[1], tag });
  }
  return out;
}

/**
 * 浮层的**已知例外**表：浮层确实位于隐藏祖先内，但当前**没有可达路径**——
 * 其唯一触发点与浮层处于**同一** `.tab-content` 内，触发时该祖先必然可见。
 * 每条必须带一行理由；且本表受「失效条目」断言保护（浮层消失即报错，避免永久豁免）。
 * @type {Array<{id: string, reason: string}>}
 */
const HIDDEN_ANCESTOR_EXCEPTIONS = [
  {
    id: 'exportCategoryModal',
    reason: '唯一触发点 #scanResultCard 内的「分类导出到文件夹」按钮位于同一 #tab-image 内，触发时祖先必然可见（#exportCategoryModal 约 index.html:2572）',
  },
];

// ══════════════════════════════════════════════════════════
async function main() {
  console.log('--------------------------------------------------------------------------------');
  console.log('图片内容寻址 + 插件面板归位 + 图片端点回归（scripts/test-image-ref.js）');
  console.log(`沙箱: ${SANDBOX}`);
  console.log('--------------------------------------------------------------------------------');

  // ── A. 内容寻址确定性 ──
  console.log('\n── ① 同图同 hash（内容寻址确定性）──');
  const a1 = imageRef.fromBase64(PNG_A, { capture: true });
  const a2 = imageRef.fromBase64(PNG_A, { capture: true });
  const b1 = imageRef.fromBase64(PNG_B, { capture: true });
  check('A/1 hash 为 16 位小写 hex', /^[0-9a-f]{16}$/.test(a1.ref.hash), `hash=${a1.ref.hash}`);
  check('A/2 同图两次 ⇒ hash 完全相同', a1.ref.hash === a2.ref.hash, `${a1.ref.hash} == ${a2.ref.hash}`);
  check('A/3 不同图 ⇒ hash 不同', a1.ref.hash !== b1.ref.hash, `${a1.ref.hash} != ${b1.ref.hash}`);
  check('A/4 格式/尺寸解析正确（png 1×1）', a1.ref.format === 'png' && a1.ref.width === 1 && a1.ref.height === 1,
    `${a1.ref.format} ${a1.ref.width}x${a1.ref.height}`);
  check('A/5 同图两次 ⇒ blob/thumb 路径相同（去重前提）',
    a1.ref.blob === a2.ref.blob && a1.ref.thumb === a2.ref.thumb, a1.ref.blob);
  check('A/6 字节数已记录', a1.ref.bytes > 0 && a1.ref.bytes === (a1.buffer ? a1.buffer.length : -1), `bytes=${a1.ref.bytes}`);

  // ── B. 路径安全 / 目录穿越闸门 ──
  console.log('\n── ⑥-a 路径安全（防目录穿越闸门）──');
  const bad = ['../../package.json', '..%2F..%2Fpackage.json', 'AAAAAAAAAAAAAAAA', '123', '', null, undefined, 'a'.repeat(15), 'a'.repeat(17), '00/../00/x'];
  check('B/1 所有非法 hash 被 isHashSafe 拒绝', bad.every((h) => imageRef.isHashSafe(h) === false),
    `n=${bad.length}`);
  check('B/2 非法 hash ⇒ blobAbsPath 为 null（不可穿越出 blob 根）',
    imageRef.blobAbsPath('../../package.json', 'png') === null && imageRef.blobAbsPath('AAAAAAAAAAAAAAAA', 'png') === null,
    'null');
  check('B/3 非法 hash ⇒ thumbAbsPath 为 null', imageRef.thumbAbsPath('../x') === null, 'null');
  check('B/4 relToBlobAbs 拒绝越界相对路径',
    imageRef.relToBlobAbs('data/image_blobs/../../package.json') === null
    && imageRef.relToBlobAbs('data/image_blobs/../../etc/passwd') === null
    && imageRef.relToBlobAbs('/etc/passwd') === null,
    'null');
  check('B/5 relToBlobAbs 只接受 data/image_blobs/ 前缀（正常值通过）',
    imageRef.relToBlobAbs(a1.ref.blob) === path.join(BLOB_DIR, a1.ref.hash.slice(0, 2), `${a1.ref.hash}.png`),
    imageRef.relToBlobAbs(a1.ref.blob));
  check('B/6 解析结果恒在 blob 根内', String(imageRef.relToBlobAbs(a1.ref.blob)).startsWith(path.resolve(BLOB_DIR) + path.sep),
    'inside');

  // ── C. source.kind 判定与 stored 语义 ──
  console.log('\n── source.kind 判定 / stored 语义（stored = 捕获决定，非存活保证）──');
  const localRef = imageRef.fromBase64(PNG_A, { sourcePath: 'C:/tmp/x.png' });
  check('C/1 sourcePath 存在 ⇒ kind=local-file 且 stored=false（只引用不拷贝）',
    localRef.ref.source.kind === 'local-file' && localRef.ref.stored === false && Boolean(localRef.ref.storedReason),
    `kind=${localRef.ref.source.kind} stored=${localRef.ref.stored}`);
  const urlRef = imageRef.fromBase64(PNG_A, { imageUrl: 'https://x/y.png', capture: false });
  check('C/2 imageUrl 存在 ⇒ kind=remote-url', urlRef.ref.source.kind === 'remote-url', urlRef.ref.source.kind);
  check('C/3 无 sourcePath/imageUrl ⇒ kind=bot-base64', a1.ref.source.kind === 'bot-base64', a1.ref.source.kind);
  const bigRef = imageRef.fromBase64(PNG_A, { maxBytes: 10 });
  check('C/4 超单图上限 ⇒ stored=false + storedReason 含「上限」',
    bigRef.ref.stored === false && /上限/.test(bigRef.ref.storedReason), bigRef.ref.storedReason);
  check('C/5 capture:false ⇒ stored=false（只引用）',
    imageRef.fromBase64(PNG_A, { capture: false }).ref.stored === false, 'stored=false');
  check('C/6 空 base64 ⇒ hash 仍可计算但 stored=false + 原因',
    imageRef.fromBase64('').ref.stored === false, imageRef.fromBase64('').ref.storedReason);

  // ── D. 落盘 + resolveImageRef 存在性裁决 ──
  console.log('\n── 落盘 + 读取端存在性裁决（resolveImageRef）──');
  await imageRef.capture(a1.ref, a1.buffer);
  const blobAbs = imageRef.relToBlobAbs(a1.ref.blob);
  check('D/1 blob 已落盘（字节与源一致）', fs.existsSync(blobAbs) && fs.readFileSync(blobAbs).equals(a1.buffer),
    `size=${fs.statSync(blobAbs).size}`);
  const resolved = imageRef.resolveImageRef({ image_ref: a1.ref });
  check('D/2 resolveImageRef 解析出可用绝对路径', Boolean(resolved && resolved.blobAbs === blobAbs),
    resolved && resolved.blobAbs);
  check('D/3 resolveImageRef 亦能从 result.image_ref 取值（展平前）',
    Boolean(imageRef.resolveImageRef({ result: { image_ref: a1.ref } })), 'ok');
  check('D/4 blob 不存在 ⇒ resolveImageRef 返回 null（优雅退化，stored 不作准）',
    imageRef.resolveImageRef({
      image_ref: { ...a1.ref, hash: '0000000000000000', blob: 'data/image_blobs/00/0000000000000000.png' },
    }) === null,
    'null');
  check('D/5 blob 目录被删后退化为 source.ref 引用',
    Boolean(imageRef.resolveImageRef({
      image_ref: { ...a1.ref, blob: 'data/image_blobs/00/0000000000000000.png', source: { kind: 'local-file', ref: blobAbs } },
    })),
    'fallback-source');
  check('D/6 capacityStatus 形状完整',
    ['usedBytes', 'limitBytes', 'pct', 'overWarn', 'overLimit'].every((k) => k in imageRef.capacityStatus()),
    JSON.stringify(imageRef.capacityStatus()));
  imageRef._setUsedBytes(imageRef.getImageCaptureCfg().capacity.limitBytes + 1);
  const overRef = imageRef.fromBase64(PNG_B, { capture: true });
  check('D/7 容量超限（D2 裁定）⇒ 停止新捕获：stored=false + 原因含「容量」',
    overRef.ref.stored === false && /容量/.test(overRef.ref.storedReason), overRef.ref.storedReason);
  check('D/8 超限仍保留 hash / 大小 / 来源（不拒绝审核、不丢元数据）',
    /^[0-9a-f]{16}$/.test(overRef.ref.hash) && overRef.ref.bytes > 0 && overRef.ref.source.kind === 'bot-base64',
    `${overRef.ref.hash} bytes=${overRef.ref.bytes}`);
  imageRef._setUsedBytes(0);

  // ── E. ②③⑦ 双写失败语义 / 回灌幂等 / listAuditDates 过滤（与 test-audit-dualwrite 互补）──
  console.log('\n── ②③⑦ 双写失败语义 / 回灌幂等 / listAuditDates 过滤 `_` 前缀 ──');
  const today = auditStore.getDateStr();
  auditDb.open();
  const rec = auditStore.saveAuditRecord('图片引用记录', {
    passed: true, risk_level: 'safe', categories: [], confidence: 0.9, reason: '图片', type: 'image',
    image_ref: a1.ref,
  }, { userId: 'u-img' });
  await auditStore.flushAuditDb();
  check('E/1 含 image_ref 的记录双写成功（DB 行数 +1）', auditDb.count(today) === 1 && Boolean(rec && rec.id),
    `db=${auditDb.count(today)}`);
  check('E/2 JSONL 内**不含图片字节**（只存元数据/相对路径）',
    !fs.readFileSync(path.join(AUDIT_DIR, `${today}.jsonl`), 'utf-8').includes(PNG_A.slice(30, 60)),
    'meta-only');
  const recon = auditDb.reconcile(today);
  check('E/3 对账无差异（投影与 JSONL 一致）',
    recon.missingInDb.length === 0 && recon.extraInDb.length === 0, `miss=${recon.missingInDb.length}`);

  const realUpsert = auditDb.upsert;
  auditDb.upsert = () => { throw new Error('模拟 DB 故障'); };
  let threw = null;
  let recFail = 'unset';
  try { recFail = auditStore.saveAuditRecord('DB 故障', { passed: true, risk_level: 'safe', type: 'text' }, {}); }
  catch (e) { threw = String(e && e.message); }
  auditDb.upsert = realUpsert;
  check('E/4 DB 抛错时 saveAuditRecord 不抛且仍返回记录（双写失败语义）',
    threw === null && Boolean(recFail && recFail.id), `threw=${threw}`);
  await auditStore.flushAuditDb();
  const bf1 = auditDb.backfill(auditStore.getAuditRecords(today));
  const c1 = auditDb.count(today);
  const bf2 = auditDb.backfill(auditStore.getAuditRecords(today));
  const c2 = auditDb.count(today);
  check('E/5 回灌幂等（重复回灌行数不翻倍、二次零插入）', c1 === c2 && bf2.inserted === 0 && bf2.updated === c1,
    `c1=${c1} c2=${c2} ins2=${bf2.inserted} upd2=${bf2.updated}`);
  void bf1;

  fs.appendFileSync(path.join(AUDIT_DIR, '_ops.jsonl'), `${JSON.stringify({ op: 'clear', date: today })}\n`, 'utf-8');
  const dates = auditStore.listAuditDates().map((d) => d.date);
  check('E/6 listAuditDates() 过滤 /^_/（_ops.jsonl 不被当成一天）',
    dates.includes(today) && !dates.some((d) => d.startsWith('_')), `dates=${dates.join(',') || '(空)'}`);
  check('E/7 留痕文件确实存在于目录（过滤的是「上报」不是「文件」）',
    fs.existsSync(path.join(AUDIT_DIR, '_ops.jsonl')), '_ops.jsonl');

  // ── F. index.html 结构契约（静态，防漂移）──
  console.log('\n── ⑥-b public/index.html 结构契约 ──');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  const countOf = (re) => (html.match(re) || []).length;
  check('F/1 <style>/</style> 配对', countOf(/<style[ >]/g) === countOf(/<\/style>/g), `n=${countOf(/<style[ >]/g)}`);
  check('F/2 <script>/</script> 配对', countOf(/<script[ >]/g) === countOf(/<\/script>/g), `n=${countOf(/<script[ >]/g)}`);
  check('F/3 业务视图槽数量 == 13（TAB_CATEGORIES）',
    countOf(/class="plugin-view-slot"/g) === uiContract.TAB_CATEGORIES.length, `n=${countOf(/class="plugin-view-slot"/g)}`);
  check('F/4 配置槽数量 == 13（每个 Tab 一份，物理隔离）',
    countOf(/class="plugin-config-slot"/g) === uiContract.TAB_CATEGORIES.length, `n=${countOf(/class="plugin-config-slot"/g)}`);
  check('F/5 历史遗留 config 槽已删除（无 data-category="config"）', countOf(/data-category="config"/g) === 0,
    `n=${countOf(/data-category="config"/g)}`);
  const slotCats = (html.match(/plugin-config-slot" data-category="([a-z-]+)"/g) || [])
    .map((s) => /data-category="([a-z-]+)"/.exec(s)[1]);
  check('F/6 配置槽类目集合 == TAB_CATEGORIES（一一对应，无遗漏无多余）',
    JSON.stringify(slotCats.slice().sort()) === JSON.stringify(uiContract.TAB_CATEGORIES.slice().sort()),
    `cats=${slotCats.join(',')}`);
  check('F/7 #pluginWarnings 告警条容器存在', html.includes('id="pluginWarnings"'), 'present');
  check('F/8 renderPluginViews 分别清空 view / config 槽（不共用容器）',
    html.includes("querySelectorAll('.plugin-view-slot').forEach((s) => { s.innerHTML = ''; })")
    && html.includes("querySelectorAll('.plugin-config-slot').forEach((s) => { s.innerHTML = ''; })"),
    'ok');
  check('F/9 插件卡不再内联渲染配置（无 ${cfgHtml} 注入 pluginList）', !html.includes('${cfgHtml}'), 'removed');
  check('F/10 配置卡注入到 .plugin-config-slot（而非 view 槽）',
    html.includes("querySelector(`.plugin-config-slot[data-category=\"${panel}\"]`)"), 'ok');
  check('F/11 历史页图片封面懒加载 + 失败兜底占位符',
    html.includes('class="history-cover-img"') && html.includes('history-cover-ph') && html.includes('loading="lazy"'),
    'ok');
  check('F/12 历史页短 hash/尺寸/来源展示齐全',
    html.includes('内容寻址') && html.includes('srcLabel') && html.includes('shortHash'), 'ok');
  // F/13：全屏浮层不得处于任何隐藏祖先内 —— 一旦被放进 .tab-content（未激活时 display:none），
  // 用户在其它的 Tab 里触发它时会因隐藏祖先而完全看不到（position:fixed 也救不了）。
  // 原为单一 #scanImageModal；现泛化为**扫描全部 position:fixed 浮层**：凡有真实触发路径者
  // 必须挂 body 级；确有隐藏祖先但当前无可达路径者，须显式登记进例外表并写明理由。
  // 判别力自证：同一扫描器对 #historyList 必须能检出 .tab-content 祖先（否则这条就是恒真断言）。
  const isHiddenAncestor = (d) => /\btab-content\b/.test(d.class) || /display\s*:\s*none/i.test(d.style);
  const overlays = fixedOverlaysOf(html);
  const exceptionIds = new Set(HIDDEN_ANCESTOR_EXCEPTIONS.map((e) => e.id));
  const offenders = [];
  const exceptionHits = [];
  for (const ov of overlays) {
    const anc = divAncestorsOf(html, ov.id);
    if (anc === null) continue; // 理论上不会发生（id 已存在）
    const hidden = anc.filter(isHiddenAncestor);
    if (hidden.length === 0) continue;
    if (exceptionIds.has(ov.id)) exceptionHits.push(ov.id);
    else offenders.push(`${ov.id}(${hidden.map((d) => d.class || '?').join(',')})`);
  }
  const histAnc = divAncestorsOf(html, 'historyList');
  const ctrlDetects = (histAnc || []).some((d) => /\btab-content\b/.test(d.class));
  check('F/13 全屏浮层无隐藏祖先（例外表内浮层除外；自证：#historyList 可检出 .tab-content）',
    overlays.length > 0 && offenders.length === 0 && ctrlDetects,
    `overlays=${overlays.length} offenders=${offenders.length}${offenders.length ? ` [${offenders.join(' ')}]` : ''} ctrlDetect=${ctrlDetects}`);
  // 例外表必须**逐条命中**：表里列出的浮层确实仍处于隐藏祖先内（防止例外表"写宽"到无意义）
  check('F/14 例外表逐条命中（所列浮层确实处于隐藏祖先内，未变成空豁免）',
    exceptionHits.length === HIDDEN_ANCESTOR_EXCEPTIONS.length,
    `hit=${exceptionHits.join(',') || '(空)'} expected=${HIDDEN_ANCESTOR_EXCEPTIONS.length}`);
  // 例外表不得腐烂：所列浮层必须确实仍存在于文件中（浮层被删/改名 ⇒ 报错并移除该条）
  const missingExceptions = HIDDEN_ANCESTOR_EXCEPTIONS.filter((e) => !overlays.some((o) => o.id === e.id));
  check('F/15 例外表无失效条目（所列浮层必须仍存在于文件；浮层消失须同步删表项）',
    missingExceptions.length === 0,
    `stale=${missingExceptions.map((e) => e.id).join(',') || '(无)'}`);
  // #scanImageModal 必须仍挂 body 级（原 F/13 语义不得因泛化而放宽）
  const imgModalAnc = divAncestorsOf(html, 'scanImageModal');
  check('F/16 #scanImageModal 仍无隐藏祖先（原 F/13 语义保持）',
    Array.isArray(imgModalAnc) && imgModalAnc.filter(isHiddenAncestor).length === 0,
    `anc=${imgModalAnc ? imgModalAnc.length : 'missing'}`);

  // ── G. ⑥-c HTTP 端点 + 目录穿越（真启服务） ──
  console.log('\n── ⑥-c GET /api/audit-image/:hash（真启沙箱服务）──');
  const thumbAbs = imageRef.thumbAbsPath(a1.ref.hash);
  fs.mkdirSync(path.dirname(thumbAbs), { recursive: true });
  const fakeThumb = Buffer.from('RIFF0000WEBPVP8 ', 'ascii');
  fs.writeFileSync(thumbAbs, fakeThumb);

  const { spawn } = require('child_process');
  const port = 13000 + Math.floor(Math.random() * 5000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MOD_PORT: String(port),
      GRS_PLUGINS_ENABLED: 'false',
      QA_GUARD_CONFIG_WRITE: '1',
      GRS_AUDIT_DIR: AUDIT_DIR,
      GRS_AUDIT_DB: DB_FILE,
      GRS_BLOB_DIR: BLOB_DIR,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => { });
  child.stderr.on('data', () => { });
  try {
    const up = await waitForHealth(base, 25000);
    check('G/1 沙箱服务就绪', up, `port=${port}`);
    if (!up) return;

    const thumbRes = await httpGet(`${base}/api/audit-image/${a1.ref.hash}`);
    check('G/2 默认取缩略图 ⇒ 200 + 字节等于缩略图',
      thumbRes.status === 200 && thumbRes.body.equals(fakeThumb), `http=${thumbRes.status} n=${thumbRes.body.length}`);
    check('G/3 内容寻址 ⇒ 长缓存 immutable + nosniff',
      /immutable/.test(String(thumbRes.headers['cache-control'] || ''))
      && String(thumbRes.headers['x-content-type-options'] || '') === 'nosniff',
      `cc=${thumbRes.headers['cache-control']}`);

    const fullRes = await httpGet(`${base}/api/audit-image/${a1.ref.hash}?full=1`);
    check('G/4 ?full=1 取原图 ⇒ 200 + 字节与源完全一致',
      fullRes.status === 200 && fullRes.body.equals(a1.buffer), `http=${fullRes.status} n=${fullRes.body.length}`);

    const trav = await httpGet(`${base}/api/audit-image/..%2F..%2Fpackage.json`);
    check('G/5 目录穿越（..%2F..%2Fpackage.json）被拒 ⇒ 400 且不泄漏文件内容',
      trav.status === 400 && !trav.body.toString('utf-8').includes('"name"'), `http=${trav.status}`);
    const trav2 = await httpGet(`${base}/api/audit-image/%2e%2e%2f%2e%2e%2fpackage.json`);
    check('G/6 编码穿越（%2e%2e%2f）同样被拒 ⇒ 400',
      trav2.status === 400 && !trav2.body.toString('utf-8').includes('"name"'), `http=${trav2.status}`);
    const upper = await httpGet(`${base}/api/audit-image/AAAAAAAAAAAAAAAA`);
    check('G/7 大写 hex 非法 ⇒ 400', upper.status === 400, `http=${upper.status}`);
    const short = await httpGet(`${base}/api/audit-image/123`);
    check('G/8 长度不足 ⇒ 400', short.status === 400, `http=${short.status}`);
    const missing = await httpGet(`${base}/api/audit-image/deadbeefdeadbeef`);
    check('G/9 合法形但不存在 ⇒ 404（前端退化为占位符）', missing.status === 404, `http=${missing.status}`);

    const st = await httpGet(`${base}/api/audit-store/status`);
    let stJson = null;
    try { stJson = JSON.parse(st.body.toString('utf-8')); } catch { stJson = null; }
    check('G/10 /api/audit-store/status 公开可读且结构完整',
      st.status === 200 && stJson && stJson.dualWrite && stJson.imageCapture && stJson.imageBlobs,
      `http=${st.status} mode=${stJson && stJson.dualWrite && stJson.dualWrite.mode}`);
    check('G/11 status 报告的 blobDir 指向沙箱（隔离生效）',
      stJson && String(stJson.imageCapture.blobDir).toLowerCase() === BLOB_DIR.toLowerCase(),
      stJson && stJson.imageCapture.blobDir);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 400));
  }

  // ── H. ④⑤ 面板归位（真跑前端逻辑） ──
  await testRenderPluginViews();

  // ── I. 测试隔离自证 ──
  console.log('\n── 隔离自证：生产 data/audit_records 与 data/audit.db 未被触碰 ──');
  const prodAfter = { auditDir: snapPath(PROD_AUDIT_DIR), db: snapPath(PROD_DB) };
  check('I/1 生产 data/audit_records 文件数未变',
    prodAfter.auditDir.count === PROD_BEFORE.auditDir.count,
    `before=${PROD_BEFORE.auditDir.count} after=${prodAfter.auditDir.count}`);
  check('I/2 生产 data/audit_records 文件名集合未变',
    prodAfter.auditDir.names === PROD_BEFORE.auditDir.names,
    prodAfter.auditDir.names === PROD_BEFORE.auditDir.names ? 'same' : 'CHANGED');
  check('I/3 生产 data/audit_records mtime 未变',
    prodAfter.auditDir.mtime === PROD_BEFORE.auditDir.mtime, `mtime=${prodAfter.auditDir.mtime}`);
  check('I/4 生产 data/audit.db 状态未变（存在性/size/mtime）',
    prodAfter.db.exists === PROD_BEFORE.db.exists
    && prodAfter.db.size === PROD_BEFORE.db.size
    && prodAfter.db.mtime === PROD_BEFORE.db.mtime,
    `exists=${prodAfter.db.exists} size=${prodAfter.db.size}`);
  check('I/5 本次测试的 blob 只落在沙箱，生产 data/image_blobs 未新增该 hash',
    fs.existsSync(path.join(BLOB_DIR, a1.ref.hash.slice(0, 2), `${a1.ref.hash}.png`))
    && !fs.existsSync(path.join(ROOT, 'data', 'image_blobs', a1.ref.hash.slice(0, 2), `${a1.ref.hash}.png`)),
    `sandbox=${BLOB_DIR}`);

  auditDb.close();

  console.log('--------------------------------------------------------------------------------');
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(`运行异常: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  });
