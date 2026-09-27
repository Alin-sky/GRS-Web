#!/usr/bin/env node
/**
 * T06-C / T07 / T08 回归验证（scripts/qa-t06-t08.js）
 *
 * 覆盖三项「一致性 / 插件化」改造的**可执行断言**：
 *   T06-C  历史/对比渲染的通道清单必须来自记录自身（新插件审核器可见），旧三通道记录仍正常渲染
 *   T07    对比 Tab 的可见性 = 认证状态 ∧ 插件可用性，且只有单一来源（登录不会把它又显示出来）
 *   T08    图像拓扑终裁层的陈旧 ref 必须被回收，禁用 finalize 插件后不再产生 E004 / 不再降级
 *   F2     非法节点 id 不得让 validateFlow 抛异常（`POST /api/flow/:modality/validate` 不得 500）
 *
 * 实现手法：前端两处逻辑（T06-C / T07）通过 index.html 里的标记块抽取出来，
 * 在 Node 里配一个极简 DOM/全局桩执行 —— 标记缺失即视为失败，避免代码搬迁后
 * 验证被静默跳过。后端（T08）直接 require 真实模块断言。
 *
 * 用法：node scripts/qa-t06-t08.js
 * 退出码：全部通过为 0，否则为 1。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ─── 生产数据保护（与 qa-coldstart / qa-integration 同口径）───
// 本脚本会 require ../src/config 与 ../src/plugin-runtime，并 spawn 一个真实 server 子进程；
//   两者都可能写 config/default.json / data/plugins-state.json。这里先用 QA 守卫把
//   config 写入拦掉（preload 会 patch fs.writeFileSync/renameSync），再在 main() 里对
//   config/default.json 与 data/plugins-state.json 做「备份 → 跑完还原」双保险。
// RAW_WRITE 必须在 preload 打补丁**之前**抓住，否则还原动作会被自己的守卫吞掉。
const RAW_WRITE = fs.writeFileSync;
process.env.QA_GUARD_CONFIG_WRITE = '1';
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'qa-runtime-preload.js');
const CFG_PATH = path.join(ROOT, 'config', 'default.json');
const STATE_PATH = path.join(ROOT, 'data', 'plugins-state.json');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');

let passed = 0;
let failed = 0;

/**
 * 读取文件快照（不存在则记 exists=false）。
 * @param {string} file 路径
 * @returns {{file: string, exists: boolean, raw: (string|null)}} 快照
 */
function snapshotFile(file) {
  try {
    const exists = fs.existsSync(file);
    return { file, exists, raw: exists ? fs.readFileSync(file, 'utf-8') : null };
  } catch {
    return { file, exists: false, raw: null };
  }
}

/**
 * 还原文件快照（仅在内容确实被改动时写回；用 RAW_WRITE 绕过自身守卫）。
 * @param {Array<{file: string, exists: boolean, raw: (string|null)}>} snaps 快照列表
 * @returns {string[]} 实际被还原的文件名
 */
function restoreFiles(snaps) {
  const restored = [];
  for (const s of snaps) {
    try {
      const existsNow = fs.existsSync(s.file);
      const rawNow = existsNow ? fs.readFileSync(s.file, 'utf-8') : null;
      if (s.exists && s.raw !== rawNow) {
        RAW_WRITE.call(fs, s.file, s.raw, 'utf-8');
        restored.push(path.basename(s.file));
      } else if (!s.exists && existsNow) {
        fs.unlinkSync(s.file);
        restored.push(`${path.basename(s.file)}(removed)`);
      }
    } catch { /* best effort */ }
  }
  return restored;
}


/**
 * 断言并打印一行结果。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 详情
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name.padEnd(52)} ${detail}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name.padEnd(52)} ${detail}`);
  }
}

/**
 * 按标记抽取 index.html 里的代码块（标记缺失直接抛错，防止静默跳过）。
 * 起始标记本身是注释的一部分，故从 `begin` 起始处整段切片（含该注释），
 *   到 `end` 起始处为止 —— 保证抽出的源码里注释/括号都是完整的。
 * @param {string} begin 起始标记
 * @param {string} end 结束标记
 * @returns {string} 代码
 */
function sliceMarked(begin, end) {
  const a = HTML.indexOf(begin);
  if (a < 0) throw new Error(`index.html 缺少起始标记: ${begin}`);
  const b = HTML.indexOf(end, a);
  if (b < 0) throw new Error(`index.html 缺少结束标记: ${end}`);
  return HTML.slice(a, b);
}

// ─── 前端沙箱所需的桩 ───

/** 与 index.html 同口径的转义桩（被测性质与转义无关）。 */
function escapeHtmlStub(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CAT_NAMES = { political: '涉政', pornographic: '色情', marketing: '营销', violence: '暴力', gambling: '赌博', privacy: '隐私', illegal: '违法', abuse: '辱骂', grotesque: '猎奇' };
const RISK_COLORS = { safe: 'var(--safe)', low: 'var(--low)', medium: 'var(--medium)', high: 'var(--high)', critical: 'var(--critical)' };

/**
 * 极简 DOM 桩：只满足 applyTabVisibility / updateUIForAuthState / applyCompareTabAvailability。
 * @returns {object} { document, tabs, contents, notice }
 */
function makeDom() {
  const names = ['text', 'image', 'batch', 'history', 'chat', 'compare', 'flow', 'docs', 'worddb', 'stats', 'models', 'plugins', 'system'];
  const tabs = names.map((n) => {
    const cls = new Set(n === 'text' ? ['tab', 'active'] : ['tab']);
    return {
      dataset: { tab: n },
      style: { display: n === 'text' ? '' : 'none' },
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
      },
    };
  });
  const contents = names.map((n) => ({ id: `tab-${n}`, style: { display: n === 'text' ? '' : 'none' } }));
  const byId = {};
  for (const c of contents) byId[c.id] = c;
  const notice = { style: { display: 'none' }, innerHTML: '' };
  byId.comparePluginNotice = notice;
  const document = {
    querySelectorAll: (sel) => (sel === '.tab' ? tabs : sel === '.tab-content' ? contents : []),
    querySelector: (sel) => (sel === '.tab.active' ? (tabs.find((t) => t.classList.contains('active')) || null) : null),
    getElementById: (id) => byId[id] || null,
  };
  return { document, tabs, contents, notice };
}

/**
 * 取某个 tab 按钮当前 display。
 * @param {Array<object>} tabs tab 列表
 * @param {string} name tab 名
 * @returns {string} display 值
 */
function tabDisplay(tabs, name) {
  const t = tabs.find((x) => x.dataset.tab === name);
  return t ? t.style.display : '(missing)';
}

// ══════════════════════════════════════════════════════════
// T06-C：历史/对比渲染的通道清单
// ══════════════════════════════════════════════════════════

function testT06C() {
  console.log('\n── T06-C 历史/对比渲染通道动态化 ──');
  const modelLabelSrc = sliceMarked('/* ==== shared: model label (testable) ==== */', '/* ==== end shared: model label ==== */');
  const t06cSrc = sliceMarked('/* ==== T06-C:', '/* ==== end T06-C ==== */');

  const body = `${modelLabelSrc}\n${t06cSrc}
  return { historyChannelLabel, deriveCompareChannels, deriveExtraTraceChannels, renderExtraChannelBlocks, renderCompareChannelCards };`;
  const api = new Function('escapeHtml', 'catNames', 'riskColors', body)(escapeHtmlStub, CAT_NAMES, RISK_COLORS);

  // ① 含「非三通道之一」的通道名：必须出现在推导结果与输出 HTML 里
  const summaryNew = { channels: ['qwen3:8b', 'cloud', 'content_safety', 'plugin.demo-guard.text'], models: ['qwen3:8b'] };
  const resultsNew = [{
    text: 'probe',
    models: {
      'qwen3:8b': { risk_level: 'safe', categories: [], confidence: 0.9 },
      cloud: { risk_level: 'low', categories: [], confidence: 0.7 },
      content_safety: { risk_level: 'safe', categories: [], confidence: 1 },
      'plugin.demo-guard.text': { risk_level: 'medium', categories: ['abuse'], confidence: 0.6 },
    },
    comparisons: {},
  }];
  const namesNew = api.deriveCompareChannels(summaryNew, resultsNew);
  check('T06C/1 新通道进入推导清单', namesNew.includes('plugin.demo-guard.text'), `channels=[${namesNew.join(',')}]`);

  const htmlNew = api.renderCompareChannelCards(resultsNew[0], namesNew, ['var(--accent)']);
  check('T06C/2 新通道出现在输出 HTML', htmlNew.includes('demo-guard.text'),
    htmlNew.includes('demo-guard.text') ? 'found' : 'NOT-FOUND');
  check('T06C/3 新通道的判定被渲染（非“无结果”）',
    htmlNew.includes('medium') && (htmlNew.includes('辱骂') || htmlNew.includes('abuse')),
    htmlNew.includes('medium') ? 'risk=medium cat=abuse' : 'missing');
  check('T06C/4 无映射时回退显示 ref 本身（不空白）',
    api.historyChannelLabel('plugin.unknown-owner.svc').includes('unknown-owner.svc'),
    api.historyChannelLabel('plugin.unknown-owner.svc'));

  // ② 只有三通道的旧记录：必须仍正常渲染
  const summaryLegacy = { channels: ['qwen3:8b', 'cloud', 'content_safety'], models: ['qwen3:8b'] };
  const resultsLegacy = [{
    text: 'legacy',
    models: {
      'qwen3:8b': { risk_level: 'safe', categories: [], confidence: 0.8 },
      cloud: { risk_level: 'safe', categories: [], confidence: 0.9 },
      content_safety: { risk_level: 'safe', categories: [], confidence: 1 },
    },
    comparisons: {},
  }];
  const namesLegacy = api.deriveCompareChannels(summaryLegacy, resultsLegacy);
  const htmlLegacy = api.renderCompareChannelCards(resultsLegacy[0], namesLegacy, ['var(--accent)']);
  check('T06C/5 旧三通道记录推导完整',
    namesLegacy.length === 3 && namesLegacy.includes('cloud') && namesLegacy.includes('content_safety'),
    `channels=[${namesLegacy.join(',')}]`);
  check('T06C/6 旧三通道记录仍渲染出三个标签',
    htmlLegacy.includes('☁️ 云端大模型') && htmlLegacy.includes('🛡️ 内容安全') && htmlLegacy.includes('Qwen3 8B'),
    'labels ok');

  // ③ 新通道只出现在个别记录的 models（summary.channels 缺失该名）
  const summaryPartial = { channels: ['cloud'], models: [] };
  const resultsPartial = [{ models: { cloud: {}, 'plugin.x.y': { risk_level: 'safe' } } }];
  const namesPartial = api.deriveCompareChannels(summaryPartial, resultsPartial);
  check('T06C/7 逐条 models 的键参与推导', namesPartial.includes('plugin.x.y'), `channels=[${namesPartial.join(',')}]`);

  // ④ summary 完全缺失通道清单 → 空（不伪造列），与旧行为一致
  check('T06C/8 无任何通道信息时返回空数组',
    api.deriveCompareChannels({}, []).length === 0, `len=${api.deriveCompareChannels({}, []).length}`);

  // ⑤ 审核记录 node_traces 里的「非三通道」审核器补充显示
  const tracesExtra = api.deriveExtraTraceChannels([
    { ref: 'builtin.precheck', status: 'ok' },
    { ref: 'builtin.localModel', status: 'ok' },
    { ref: 'builtin.cloudModel', status: 'skipped' },
    { ref: 'plugin.aliyun-content-safety.text', status: 'ok' },
    { ref: 'plugin.other-guard.text', title: '其他守卫', status: 'ok', risk_level: 'medium' },
  ]);
  check('T06C/9 node_traces 中的新审核器被补显示',
    tracesExtra.length === 1 && tracesExtra[0].name === 'plugin.other-guard.text',
    `extras=[${tracesExtra.map((e) => e.name).join(',')}]`);
  const extraHtml = api.renderExtraChannelBlocks([{ ref: 'plugin.other-guard.text', title: '其他守卫', status: 'ok', risk_level: 'medium' }]);
  check('T06C/10 补充块 HTML 含该 ref', extraHtml.includes('other-guard.text'), 'found');
  check('T06C/11 仅三通道 + 预检时补充块为空（旧记录不受影响）',
    api.renderExtraChannelBlocks([
      { ref: 'builtin.precheck', status: 'ok' },
      { ref: 'builtin.localModel', status: 'ok' },
      { ref: 'plugin.aliyun-content-safety.image', status: 'ok' },
    ]) === '', 'empty');
}

// ══════════════════════════════════════════════════════════
// T07：对比 Tab 可见性（单一来源）
// ══════════════════════════════════════════════════════════

function testT07() {
  console.log('\n── T07 对比 Tab 插件化隐藏（单一可见性来源）──');
  const coreSrc = sliceMarked('/* ==== T07: tab visibility core (testable) ==== */', '/* ==== end T07 core ==== */');
  const availSrc = sliceMarked('/* ==== T07: compare tab availability (testable) ==== */', '/* ==== end T07 availability ==== */');

  const body = `let _isAuthenticated = false;
${coreSrc}
${availSrc}
return {
  setAuth(v) { _isAuthenticated = v; updateUIForAuthState(); },
  setPlugins(list) { applyCompareTabAvailability(list); },
};`;

  // 顺序 A：先「插件未装载」，再「登录」
  const domA = makeDom();
  const apiA = new Function('document', body)(domA.document);
  apiA.setPlugins([]); // 模拟首屏：plugins 列表里没有 comparison-suite
  check('T07/1 插件未装载 → compare Tab 隐藏', tabDisplay(domA.tabs, 'compare') === 'none',
    `display=${tabDisplay(domA.tabs, 'compare')}`);
  check('T07/2 插件未装载 → 空白提示卡可见', domA.notice.style.display === '', `display=${domA.notice.style.display}`);
  apiA.setAuth(true); // 关键回归点：登录会走 updateUIForAuthState
  check('T07/3 登录后 compare Tab 仍隐藏（防回归）', tabDisplay(domA.tabs, 'compare') === 'none',
    `display=${tabDisplay(domA.tabs, 'compare')}`);

  // 顺序 B：先「登录」，再「插件未装载」
  const domB = makeDom();
  const apiB = new Function('document', body)(domB.document);
  apiB.setAuth(true);
  apiB.setPlugins([]);
  check('T07/4 先登录后装载判定 → compare 仍隐藏', tabDisplay(domB.tabs, 'compare') === 'none',
    `display=${tabDisplay(domB.tabs, 'compare')}`);
  check('T07/5 两种顺序结果一致',
    tabDisplay(domA.tabs, 'compare') === tabDisplay(domB.tabs, 'compare'),
    `A=${tabDisplay(domA.tabs, 'compare')} B=${tabDisplay(domB.tabs, 'compare')}`);

  // 插件已装载 → 显示
  const domC = makeDom();
  const apiC = new Function('document', body)(domC.document);
  apiC.setPlugins([{ id: 'comparison-suite', status: 'loaded' }]);
  apiC.setAuth(true);
  check('T07/6 插件已装载 + 已认证 → compare Tab 显示', tabDisplay(domC.tabs, 'compare') === '',
    `display=${tabDisplay(domC.tabs, 'compare')}`);
  check('T07/7 插件已装载 → 提示卡隐藏', domC.notice.style.display === 'none', `display=${domC.notice.style.display}`);

  // 未认证：非白名单 Tab 一律隐藏（含 compare，即便插件已装载）
  const domD = makeDom();
  const apiD = new Function('document', body)(domD.document);
  apiD.setPlugins([{ id: 'comparison-suite', status: 'loaded' }]);
  apiD.setAuth(false);
  check('T07/8 未认证 → compare 隐藏', tabDisplay(domD.tabs, 'compare') === 'none');
  check('T07/9 未认证 → text 保持可见', tabDisplay(domD.tabs, 'text') === '', `display=${tabDisplay(domD.tabs, 'text')}`);

  // 激活的 compare 变为隐藏 → 自动回退到可见 Tab（不停在空白页）
  const domE = makeDom();
  const apiE = new Function('document', body)(domE.document);
  apiE.setPlugins([{ id: 'comparison-suite', status: 'loaded' }]);
  apiE.setAuth(true);
  domE.tabs.forEach((t) => t.classList.remove('active'));
  domE.tabs.find((t) => t.dataset.tab === 'compare').classList.add('active');
  apiE.setPlugins([]); // 插件被禁用
  const activeNow = domE.tabs.find((t) => t.classList.contains('active'));
  check('T07/10 激活 Tab 被隐藏时自动回退', Boolean(activeNow) && activeNow.dataset.tab !== 'compare',
    `active=${activeNow ? activeNow.dataset.tab : '(none)'}`);

  // 命名统一：Tab 标签与插件名对齐
  check('T07/11 Tab 标签统一为「对比审核」',
    /data-tab="compare"[^>]*>对比审核</.test(HTML), 'label=对比审核');

  // ── G1（P0）：Tab **内容区**的激活态 ──
  // 上一轮这里只测了「Tab 按钮是否隐藏正确」，**没测内容区**，于是
  // 「applyTabVisibility 把 13 个内容区全部显示」（整页功能堆叠）从全套测试里溜过去了。
  // 口径必须分清：按钮可见性 = isTabVisible(name)；内容区显隐 = 「是否当前激活」⇒ 恰好 1 个。
  const visibleContents = (dom) => dom.contents.filter((c) => c.style.display !== 'none');
  const activeTabName = (dom) => {
    const a = dom.tabs.find((t) => t.classList.contains('active'));
    return a ? a.dataset.tab : null;
  };
  /**
   * 内容区「恰好 1 个可见且等于激活 Tab」判据。
   * @param {object} dom 假 DOM
   * @returns {{count: number, ids: string, active: (string|null), ok: boolean}} 见证
   */
  const contentWitness = (dom) => {
    const vis = visibleContents(dom);
    const a = activeTabName(dom);
    return { count: vis.length, ids: vis.map((c) => c.id).join(','), active: a, ok: vis.length === 1 && Boolean(a) && vis[0].id === `tab-${a}` };
  };

  // 触发路径 ①：loadPlugins() → applyCompareTabAvailability() → applyTabVisibility()
  const domF = makeDom();
  const apiF = new Function('document', body)(domF.document);
  apiF.setPlugins([{ id: 'comparison-suite', status: 'loaded' }]);
  apiF.setAuth(true);
  // 复刻真实 Tab 切换处理器：激活态挪到「插件管理」（loadPlugins 恰好在这一刻被调用）
  domF.tabs.forEach((t) => t.classList.remove('active'));
  domF.contents.forEach((c) => { c.style.display = 'none'; });
  domF.tabs.find((t) => t.dataset.tab === 'plugins').classList.add('active');
  domF.contents.find((c) => c.id === 'tab-plugins').style.display = '';
  apiF.setPlugins([{ id: 'comparison-suite', status: 'loaded' }]); // ← loadPlugins 里的那一句
  let w = contentWitness(domF);
  check('T07/12 触发路径① loadPlugins/applyCompareTabAvailability：内容区恰好 1 个可见（=激活Tab）',
    w.ok, `visible=${w.count} ids=[${w.ids}] active=${w.active}`);

  // 触发路径 ②：updateUIForAuthState()（已认证 / 未认证各一次）
  const domG = makeDom();
  const apiG = new Function('document', body)(domG.document);
  apiG.setAuth(true);
  w = contentWitness(domG);
  check('T07/13 触发路径② 已认证 updateUIForAuthState：内容区恰好 1 个可见（=激活Tab）',
    w.ok, `visible=${w.count} ids=[${w.ids}] active=${w.active}`);
  apiG.setAuth(false);
  w = contentWitness(domG);
  check('T07/14 触发路径② 未认证 updateUIForAuthState：内容区恰好 1 个可见（且停在白名单 Tab）',
    w.ok && ['text', 'image', 'chat'].includes(w.active), `visible=${w.count} ids=[${w.ids}] active=${w.active}`);

  // 内容区口径回归：13 个 Tab 全可见（compare 已装载 + 已认证）时也绝不能「全显示」
  const domH = makeDom();
  const apiH = new Function('document', body)(domH.document);
  apiH.setPlugins([{ id: 'comparison-suite', status: 'loaded' }]);
  apiH.setAuth(true);
  w = contentWitness(domH);
  check('T07/15 全部 Tab 可见时内容区仍只有 1 个（防「整页堆叠全部功能」回归）',
    w.count === 1 && w.ok, `visible=${w.count} ids=[${w.ids}] active=${w.active}`);
}

// ══════════════════════════════════════════════════════════
// T08：终裁层陈旧 ref 回收
// ══════════════════════════════════════════════════════════

function testT08() {
  console.log('\n── T08 图像终裁层陈旧 ref 回收 ──');
  const flow = require('../src/flow');
  const registry = require('../src/flow/registry');
  const pluginRuntime = require('../src/plugin-runtime');
  const config = require('../src/config').loadConfig();
  flow.ensureBuiltins();

  const image = config.moderation.flows.image;
  const originalFinalizers = JSON.parse(JSON.stringify(image.finalizers || []));

  // 复刻 QA 的触发链：终裁器 owner 已从注册表摘除，但（内存）finalizers[] 仍引用它
  registry.registerPluginNodes('qa-fin-demo', [], [{ ref: 'plugin.qa-fin-demo.linkage', title: 'demo 终裁', modality: ['image'] }]);
  image.finalizers = [{ ref: 'plugin.qa-fin-demo.linkage', enabled: true, title: 'demo 终裁', source: 'qa-fin-demo', params: {} }];
  registry.unregisterOwner('qa-fin-demo');

  const before = flow.validateFlow(image, registry);
  check('T08/1 陈旧终裁器导致 E004', before.errors.some((e) => e.code === 'E004_REF_UNKNOWN'),
    `codes=${before.errors.map((e) => e.code).join(',') || 'none'}`);
  check('T08/2 修复前 getValidFlow(image) 为 null（静默降级旧引擎）',
    flow.getValidFlow(config, 'image').flow === null, 'null-before');

  // 运行期 toggle 的等价路径：server 的 reconcileFlowsAfterPluginChange 就是这一句
  pluginRuntime.reconcileFlows(config);

  const after = flow.validateFlow(image, registry);
  check('T08/3 回收后终裁层不再有 E004（只判 finalizers.*，不判 nodes/floors）',
    !after.errors.some((e) => e.code === 'E004_REF_UNKNOWN' && String(e.path || '').startsWith('finalizers.')),
    `finalizerErrors=${after.errors.filter((e) => String(e.path || '').startsWith('finalizers.')).map((e) => e.code).join(',') || 'none'}`
    + ` allCodes=${after.errors.map((e) => e.code).join(',') || 'none'}`);

  // T08/3b：回收的**有效性**正断言 —— 去掉「注册表里不存在的插件节点」后，运行期口径下
  // 图像拓扑必须可用（这才是 T08 要保证的用户可见效果：缺插件不该让整条图像链路静默降级）。
  // 注：仅按 type 过滤会留下悬空边与入度不足的 merge，所以连边一起清、并把入度不足的
  //     merge 用「前驱直连后继」短路掉，得到一张自洽拓扑。全程内存、不花云端费用。
  const cleanCfg = JSON.parse(JSON.stringify(config));
  const ci = cleanCfg.moderation.flows.image || JSON.parse(JSON.stringify(image));
  const missing = new Set((ci.nodes || [])
    .filter((n) => (n.type === 'service' || n.type === 'contribute') && n.ref && !registry.has(n.ref))
    .map((n) => n.id));
  if (missing.size > 0) {
    ci.nodes = ci.nodes.filter((n) => !missing.has(n.id));
    ci.edges = (ci.edges || []).filter((e) => !missing.has(e.from) && !missing.has(e.to));
    for (const m of ci.nodes.filter((n) => n.type === 'merge').slice()) {
      const ins = ci.edges.filter((e) => e.to === m.id);
      const outs = ci.edges.filter((e) => e.from === m.id);
      if (ins.length < 2 && outs.length === 1) {
        ci.edges = ci.edges.filter((e) => e.to !== m.id && e.from !== m.id);
        if (ins.length === 1) ci.edges.push({ id: 'e_qa_short', from: ins[0].from, to: outs[0].to });
        ci.nodes = ci.nodes.filter((n) => n.id !== m.id);
      }
    }
  }
  check('T08/3b 清掉缺失插件节点后，运行期口径下图像拓扑可用（getValidFlow 非 null）',
    flow.getValidFlow(cleanCfg, 'image').flow !== null,
    `removedMissingNodes=[${[...missing].join(',')}]`);
  check('T08/4 陈旧项已从内存 finalizers 移除',
    !(image.finalizers || []).some((f) => f.ref === 'plugin.qa-fin-demo.linkage'),
    `finalizers=[${(image.finalizers || []).map((f) => f.ref).join(',')}]`);
  check('T08/5 getValidFlow(image) 非 null', flow.getValidFlow(config, 'image').flow !== null, 'not-null-after');

  // 幂等：重复对齐不再变化
  const again = flow.reconcileFinalizers(config);
  check('T08/6 幂等（重复对齐 changed=false）', again.changed === false, `changed=${again.changed}`);

  // 插件重新启用 → 补齐路径恢复
  registry.registerPluginNodes('qa-fin-demo', [], [{ ref: 'plugin.qa-fin-demo.linkage', title: 'demo 终裁', modality: ['image'] }]);
  const restored = flow.reconcileFinalizers(config);
  check('T08/7 插件重新启用后自动补齐恢复',
    (image.finalizers || []).some((f) => f.ref === 'plugin.qa-fin-demo.linkage'), `changed=${restored.changed}`);

  // 还原（内存；本脚本独立进程，不落盘）
  registry.unregisterOwner('qa-fin-demo');
  image.finalizers = originalFinalizers;

  // ── 自包含（ 不依赖运行期可变的生产配置内容）──
  // `config/default.json` 会被运行中的服务整体改写（画布保存），其 `finalizers` 会随时间漂移
  // （真实发生过：2026-09-17 13:46 被保存成 []）。所以**不能**把「真实配置里恰好存在一条
  // 待回收的陈旧 ref」当作通过前置条件 —— 那既不稳定，也是在用环境迁就断言。
  // 正确做法：取**真实配置的深拷贝**，注入一条**真实插件 ref**（wd14-tagger 的终裁联动；
  // 本进程未装载它 ⇒ 必然构成「陈旧 ref」），从而稳定复现「有陈旧引用」这一前提。
  const probeCfg = JSON.parse(JSON.stringify(config));
  if (!probeCfg.moderation.flows.image) probeCfg.moderation.flows.image = JSON.parse(JSON.stringify(image));
  probeCfg.moderation.flows.image.finalizers = [
    { ref: 'plugin.wd14-tagger.linkage', enabled: true, title: 'WD14 动漫标签预筛 · 终裁联动', source: 'wd14-tagger', params: {} },
  ];
  const injBefore = flow.validateFlow(probeCfg.moderation.flows.image, registry);
  const injHasE004 = injBefore.errors.some((e) => e.code === 'E004_REF_UNKNOWN');
  pluginRuntime.reconcileFlows(probeCfg);
  const injAfter = flow.validateFlow(probeCfg.moderation.flows.image, registry);
  check('T08/8 注入真实插件 ref ⇒ 陈旧终裁层必被回收（只判 finalizers.*）',
    injHasE004 && !injAfter.errors.some((e) => e.code === 'E004_REF_UNKNOWN' && String(e.path || '').startsWith('finalizers.')),
    `injected=E004:${injHasE004} afterFinalizer=${injAfter.errors.filter((e) => String(e.path || '').startsWith('finalizers.')).map((e) => e.code).join(',') || 'none'}`);

  // 真实配置**本身**（未注入）在 reconcile 后终裁层必须合法 —— 按现状断言，不假设它含陈旧 ref
  pluginRuntime.reconcileFlows(config);
  const realAfter = flow.validateFlow(image, registry);
  check('T08/9 真实配置本身：回收后终裁层合法（nodes 层未注册 ref 属运行期可跳过，不在此断言范围）',
    !realAfter.errors.some((e) => e.code === 'E004_REF_UNKNOWN' && String(e.path || '').startsWith('finalizers.')),
    `afterFinalizer=${realAfter.errors.filter((e) => String(e.path || '').startsWith('finalizers.')).map((e) => e.code).join(',') || 'none'}`);

  image.finalizers = originalFinalizers;
}

// ══════════════════════════════════════════════════════════
// T08（HTTP 层）：插件禁用启用后，GET /api/flow/image 不再报 E004
// ══════════════════════════════════════════════════════════

/**
 * GET 并把响应体当 JSON 解析（失败返回 null）。
 * @param {string} url 地址
 * @returns {Promise<object|null>} JSON 或 null
 */
async function getJson(url) {
  try {
    const r = await fetch(url);
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * POST JSON 并返回 {status, json}。
 * @param {string} url 地址
 * @param {object} body 请求体
 * @returns {Promise<{status: number, json: object|null}>} 结果
 */
async function postJson(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

// ══════════════════════════════════════════════════════════
// F2：非法节点 id 不得让 validateFlow 抛异常（HTTP 500）
// ══════════════════════════════════════════════════════════

/**
 * 构造「含非法 id 节点 + 有边指向它」的图（F2 最小复现）。
 * @returns {object} flow
 */
function buildBadIdFlow() {
  return {
    schemaVersion: 1,
    modality: 'text',
    version: 1,
    revision: 1,
    nodes: [
      { id: 'in', type: 'input', params: {} },
      { id: 'BAD', type: 'service', ref: 'builtin.cloudModel', params: {} },
      { id: 'out', type: 'output', params: {} },
    ],
    edges: [
      { id: 'e1', from: 'in', to: 'BAD' },
      { id: 'e2', from: 'BAD', to: 'out' },
    ],
    floors: [],
    finalizers: [],
  };
}

/**
 * 构造一个合法图（对照组，确认修复没误伤正常路径）。
 * @returns {object} flow
 */
function buildGoodFlow() {
  return {
    schemaVersion: 1,
    modality: 'text',
    version: 1,
    revision: 1,
    nodes: [
      { id: 'in', type: 'input', params: {} },
      { id: 'svc', type: 'service', ref: 'builtin.cloudModel', params: {} },
      { id: 'out', type: 'output', params: {} },
    ],
    edges: [{ id: 'e1', from: 'in', to: 'svc' }, { id: 'e2', from: 'svc', to: 'out' }],
    floors: [],
    finalizers: [],
  };
}

function testF2() {
  console.log('\n── F2 非法节点 id 的校验健壮性 ──');
  const flow = require('../src/flow');
  flow.ensureBuiltins();

  let threw = null;
  let res = null;
  try {
    res = flow.validateFlow(buildBadIdFlow(), flow.registry);
  } catch (e) {
    threw = `${e && e.name}: ${e && e.message}`;
  }
  check('F2/1 validateFlow 不抛异常（非法 id）', threw === null, threw || 'no-throw');
  check('F2/2 非法 id 仍以 E001_SCHEMA 报出',
    Boolean(res && res.errors.some((e) => e.code === 'E001_SCHEMA')),
    `codes=${res ? res.errors.map((e) => e.code).join(',') : 'n/a'}`);
  check('F2/3 非法图整体 ok=false', Boolean(res && res.ok === false), `ok=${res && res.ok}`);

  let good = null;
  try {
    good = flow.validateFlow(buildGoodFlow(), flow.registry);
  } catch (e) {
    good = { ok: false, errors: [{ code: 'THREW', message: String(e && e.message) }] };
  }
  check('F2/4 合法图仍通过（未误伤）', Boolean(good && good.ok === true),
    `ok=${good && good.ok} codes=${good ? good.errors.map((e) => e.code).join(',') : 'n/a'}`);
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
    const h = await getJson(`${base}/health`);
    if (h) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function testT08Http() {
  console.log('\n── T08（HTTP 层）插件禁用后的图像拓扑 ──');
  const { spawn } = require('child_process');
  const port = 12000 + Math.floor(Math.random() * 6000);
  const base = `http://127.0.0.1:${port}`;
  // 沙箱子进程带 QA 守卫 preload：拦截 config/default.json 写入（不污染生产配置）
  const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MOD_PORT: String(port),
      GRS_PLUGINS_ENABLED: 'false',
      QA_GUARD_CONFIG_WRITE: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  try {
    const up = await waitForHealth(base, 20000);
    check('T08H/1 沙箱服务就绪（插件禁用 + wd14 未装载）', up, `port=${port}`);
    if (!up) return;
    const img = await getJson(`${base}/api/flow/image`);
    const imgErrors = (img && img.errors) || [];
    check('T08H/2 GET /api/flow/image 不再有 E004',
      !imgErrors.some((e) => e.code === 'E004_REF_UNKNOWN'),
      `codes=${imgErrors.map((e) => e.code).join(',') || 'none'}`);
    check('T08H/3 GET /api/flow/image ok 反映校验结果（无错即 true）',
      Boolean(img && img.ok === true), `ok=${img && img.ok}`);
    const txt = await getJson(`${base}/api/flow/text`);
    check('T08H/4 GET /api/flow/text 亦无 E004',
      !(((txt && txt.errors) || []).some((e) => e.code === 'E004_REF_UNKNOWN')),
      `ok=${txt && txt.ok}`);
    // F2：无 admin 保护的 validate 端点不得被非法节点 id 打成 500
    const bad = await postJson(`${base}/api/flow/text/validate`, { flow: buildBadIdFlow() });
    check('F2H/1 POST /validate 非法 id 不返回 500', bad.status !== 500,
      `http=${bad.status} codes=${bad.json ? (bad.json.errors || []).map((e) => e.code).join(',') : 'n/a'}`);
    check('F2H/2 仍以 200 + errors 返回', bad.status === 200 && Array.isArray(bad.json && bad.json.errors)
      && bad.json.errors.some((e) => e.code === 'E001_SCHEMA'),
      `http=${bad.status} ok=${bad.json && bad.json.ok}`);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ══════════════════════════════════════════════════════════

async function main() {
  console.log('--------------------------------------------------------------------------------');
  console.log('T06-C / T07 / T08 / F2 一致性回归（scripts/qa-t06-t08.js）');
  console.log('--------------------------------------------------------------------------------');
  // 备份生产状态：T08 会改内存 topology，子进程会启真实 server —— 跑完必须还原
  const snaps = [snapshotFile(CFG_PATH), snapshotFile(STATE_PATH)];
  try {
    testT06C();
    testT07();
    testT08();
    testF2();
    await testT08Http();
  } finally {
    const restored = restoreFiles(snaps);
    console.log(restored.length
      ? `  info  生产状态已还原: ${restored.join(', ')}`
      : '  info  生产状态未被改动（无需还原）');
  }
  console.log('--------------------------------------------------------------------------------');
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`运行异常: ${err && err.message}`);
  process.exitCode = 1;
});
