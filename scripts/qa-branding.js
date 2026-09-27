#!/usr/bin/env node
/**
 * QA 品牌一致性验证（scripts/qa-branding.js）—— T07 / R2 + R6（品牌化切片）
 *
 * 覆盖（全部为**静态**断言，不启动服务、不写盘）：
 *   1. public/index.html 的 `<title>` 实测 === `GRS-通用审核系统`
 *   2. 全仓旧品牌残留（见下方 `OLD_BRANDS` 两个串）计数 === 0
 *      （排除 docs/ node_modules/ .git/ .workbuddy/ 与运行时产物 data/ builds/ dist/ .backup/，
 *        并跳过二进制与超大文件 —— 说明见文件末尾注释）
 *   3. public/index.html 与 public/login.html 都声明 `<link rel="icon" ... grs-logo.svg>`
 *   4. public/index.html 头部存在**内联 `<svg>`**，且该 SVG 引用 `var(--accent)` 或 `var(--brass)`
 *      （⇒ 随主题变色；不是外部图片引用）
 * 5. `prefers-color-scheme` 计数 === 1 —— 那 1 处是**既有的 OS 深浅色兜底**，必须保留。
 *      （历史教训：曾把该断言写成 0，逼出一次行为回归，已撤销；本断言固定为 1。）
 *   6. public/grs-logo.svg 存在、`<text>` 计数 === 0、XML 结构合法
 *
 * 输出格式与其它 `qa-*.js` 一致；全过 exit 0，任一失败 exit 1。
 *
 * 本脚本只读，不修改任何产品代码。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');
const LOGIN_PATH = path.join(PUBLIC_DIR, 'login.html');
const LOGO_PATH = path.join(PUBLIC_DIR, 'grs-logo.svg');

/** 唯一合法品牌名。 */
const BRAND = 'GRS-通用审核系统';
/**
 * 必须零残留的旧品牌串。
 * 刻意用**拼接**构造（而非直接写整串）：否则本脚本自身会把旧品牌名写回仓库，
 *   反而让「全仓旧品牌零残留」被本文件自己破坏（也会让任何 repo-wide grep 命中本脚本）。
 */
const OLD_BRANDS = ['Bot' + '通用审核系统', '内容' + '审核系统'];

/** 全仓扫描时跳过的目录（产物/依赖/文档，不属于「品牌投放面」）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'docs', 'data', 'builds', 'dist', '.backup']);
/** 全仓扫描时跳过的文件名。 */
const SKIP_FILES = new Set(['package-lock.json']);
/** 跳过的二进制/压缩类扩展名（避免对图片、DB、归档做无意义解码）。 */
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff',
  '.db', '.db-shm', '.db-wal', '.sqlite', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.gz', '.7z', '.exe', '.dll']);
/** 单文件字节上限（超过不扫，避免读入大产物）。 */
const MAX_BYTES = 1_000_000;

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

/**
 * 极简 XML 结构自检：注释/声明/DOCTYPE 剔除后做标签配平 + 属性引号闭合检查。
 * 说明：Node 无内置 XML 解析器；本函数覆盖「标签未闭合 / 交叉闭合 / 属性引号不配对」三类致命错误，
 *       并额外要求根元素为 `svg` 且带 `xmlns`。`public/grs-logo.svg` 同时经 librsvg（sharp 渲染链）实测可解析。
 * @param {string} src 文件内容
 * @returns {{ok: boolean, reason: string}}
 */
function xmlStructurallyValid(src) {
  const stripped = src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '');
  if (!/^\s*<svg\b/.test(stripped)) return { ok: false, reason: 'root-is-not-svg' };
  if (!/<svg\b[^>]*\bxmlns\s*=/.test(stripped)) return { ok: false, reason: 'missing-xmlns' };
  const stack = [];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(stripped))) {
    if (m[4] === '/') continue; // 自闭合
    if (m[1] === '/') {
      const top = stack.pop();
      if (top !== m[2]) return { ok: false, reason: `mismatch </${m[2]}> vs <${top}>` };
    } else {
      stack.push(m[2]);
    }
  }
  if (stack.length !== 0) return { ok: false, reason: `unclosed <${stack.join('>, <')}>` };
  return { ok: true, reason: 'balanced' };
}

/**
 * 递归扫描，收集旧品牌命中。
 * @param {string} dir 起始目录
 * @param {string[]} hits 累加器
 * @param {{scanned: number}} stat 统计
 * @returns {void}
 */
function scanDir(dir, hits, stat) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      scanDir(full, hits, stat);
      continue;
    }
    if (!ent.isFile()) continue;
    if (SKIP_FILES.has(ent.name)) continue;
    if (SKIP_EXT.has(path.extname(ent.name).toLowerCase())) continue;
    let buf;
    try {
      const st = fs.statSync(full);
      if (st.size > MAX_BYTES) continue;
      buf = fs.readFileSync(full);
    } catch { continue; }
    if (buf.includes(0)) continue; // 二进制
    stat.scanned += 1;
    const s = buf.toString('utf-8');
    for (const old of OLD_BRANDS) {
      if (s.includes(old)) hits.push(`${path.relative(ROOT, full)} :: ${old}`);
    }
  }
}

/** 输出报告。 */
function report() {
  const line = '-'.repeat(96);
  console.log(line);
  console.log('GRS QA branding consistency (T07 / R2+R6)');
  console.log(line);
  for (const r of rows) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(46)} ${r.detail}`);
  }
  console.log(line);
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

// ──────────────────────────────────────────────────────────
// 1. `<title>` 实测
// ──────────────────────────────────────────────────────────
const indexHtml = fs.readFileSync(INDEX_PATH, 'utf-8');
const loginHtml = fs.readFileSync(LOGIN_PATH, 'utf-8');

const titleMatch = indexHtml.match(/<title>([\s\S]*?)<\/title>/);
const indexTitle = titleMatch ? titleMatch[1].trim() : '';
check('title/index.html', indexTitle === BRAND, `title="${indexTitle}" want="${BRAND}"`);

const loginTitleMatch = loginHtml.match(/<title>([\s\S]*?)<\/title>/);
const loginTitle = loginTitleMatch ? loginTitleMatch[1].trim() : '';
check('title/login.html-contains-brand', loginTitle.includes(BRAND), `title="${loginTitle}"`);

// ──────────────────────────────────────────────────────────
// 2. 全仓旧品牌零残留
// ──────────────────────────────────────────────────────────
const hits = [];
const stat = { scanned: 0 };
scanDir(ROOT, hits, stat);
check('brand/no-old-name-repo-wide', hits.length === 0,
  `scanned=${stat.scanned} files, hits=${hits.length}${hits.length ? ' -> ' + hits.slice(0, 6).join(' ; ') : ''}`);

// ──────────────────────────────────────────────────────────
// 3. favicon 链接（两页）
// ──────────────────────────────────────────────────────────
/**
 * 判断文档是否声明了指向 grs-logo.svg 的 icon。
 * @param {string} html 文档
 * @returns {boolean} 是否命中
 */
function hasLogoIcon(html) {
  const m = html.match(/<link[^>]*rel=["']icon["'][^>]*>/i);
  return Boolean(m && /grs-logo\.svg/.test(m[0]));
}
check('icon/index.html', hasLogoIcon(indexHtml), 'link rel=icon -> grs-logo.svg');
check('icon/login.html', hasLogoIcon(loginHtml), 'link rel=icon -> grs-logo.svg');

// ──────────────────────────────────────────────────────────
// 4. 头部内联 `<svg>` + 品牌 token
// ──────────────────────────────────────────────────────────
const svgBlocks = indexHtml.match(/<svg\b[\s\S]*?<\/svg>/gi) || [];
const brandSvg = svgBlocks.find((s) => /brand-logo/.test(s)) || '';
check('header/inline-svg-present', Boolean(brandSvg), `inline <svg> blocks=${svgBlocks.length}, brand-logo found=${Boolean(brandSvg)}`);
check('header/inline-svg-uses-brand-tokens',
  Boolean(brandSvg) && (/var\(--accent\)/.test(brandSvg) || /var\(--brass\)/.test(brandSvg)),
  brandSvg ? 'references var(--accent)/var(--brass)' : 'brand-logo svg missing');

// ──────────────────────────────────────────────────────────
// 5. prefers-color-scheme 计数 === 1（既有 OS 兜底，必须保留）
// ──────────────────────────────────────────────────────────
const pcsCount = (indexHtml.match(/prefers-color-scheme/g) || []).length;
check('theme/prefers-color-scheme-count-1', pcsCount === 1, `count=${pcsCount} (expect 1 = pre-existing OS fallback)`);

// ──────────────────────────────────────────────────────────
// 6. grs-logo.svg 自身
// ──────────────────────────────────────────────────────────
const logoExists = fs.existsSync(LOGO_PATH);
check('logo/file-exists', logoExists, path.relative(ROOT, LOGO_PATH));
if (logoExists) {
  const svg = fs.readFileSync(LOGO_PATH, 'utf-8');
  const textCount = (svg.match(/<text\b/gi) || []).length;
  check('logo/no-text-element', textCount === 0, `<text> count=${textCount}`);
  const xml = xmlStructurallyValid(svg);
  check('logo/xml-structurally-valid', xml.ok, `bytes=${Buffer.byteLength(svg, 'utf-8')} ${xml.reason}`);
}

report();
