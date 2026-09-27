#!/usr/bin/env node
/**
 * 插件跨层依赖 lint（scripts/lint-plugin-boundary.js）
 *
 * 设计依据：docs/architecture-2026-09-14.md §3.2（R1 单向依赖）、§3.5（模块可见性）、§3.6 阶段 C
 *
 * 两类边界：
 *   ① 插件层 → 核心内部：plugins/** 禁止 require 到工程 src/、config/ 等核心目录，
 *      禁止 require('cordis')（只允许桥接层持有 cordis），禁止使用 host.app。
 *   ② 核心 → 插件层：server.js / moderator.js / comparator.js / batch-scan.js 等核心模块
 *      禁止 require('./plugin-*' / './cordis-*' / './host-services')。
 *
 * 用法：
 *   node scripts/lint-plugin-boundary.js            # 人类可读报告
 *   node scripts/lint-plugin-boundary.js --json     # JSON 报告
 *   退出码：存在「非基线」违规时为 1，否则为 0。
 *
 * 本模块同时被 src/plugin-scanner.js 在装载期调用（checkPluginDir），是边界规则的单一来源。
 */
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const PROJECT_ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'plugins');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

/** 插件可声明的依赖白名单（严格零新增依赖； 收敛：移除 express，cordis 仅桥接层可用） */
const DEPENDENCY_WHITELIST = new Set([
  'sharp', 'busboy', '@alicloud/green20220302', 'pinyin-pro',
  ...builtinModules,
]);

/**
 * 可选依赖白名单（v2.2.0，架构 §8.2）。
 * 这些包**不进 package.json 任何依赖区**（除 @alicloud/green20220302 已降级为 optionalDependencies），
 * 插件如需使用必须在 manifest.optionalDependencies 声明，且**只能惰性 require**（不得在模块顶层）。
 */
const OPTIONAL_DEPENDENCY_WHITELIST = new Set([
  'nsfwjs', '@tensorflow/tfjs-node', '@tensorflow/tfjs', '@alicloud/green20220302',
]);

/** 核心模块（这些文件属于核心，禁止反向依赖插件层） */
const CORE_MODULES = Object.freeze([
  'server.js', 'moderator.js', 'comparator.js', 'batch-scan.js', 'precheck.js',
  'config.js', 'config-defaults.js', 'config-conflicts.js', 'scheduler.js',
  'audit-store.js', 'qwen_cloud.js', 'content_safety.js', 'ollama.js',
  'system-stats.js', 'model-manager.js', 'logger.js',
  // v2.3.0（Req5）：对比审核下沉的核心共享模块。它们被内置路径与对比插件同时消费，
  //   属于核心层，同样禁止反向依赖插件层（纳入本清单才能被 lint 覆盖）。
  'comparison-core.js', 'comparison-source.js', 'comparison-store.js',
  'comparison-probe.js', 'comparison-engine.js',
  // v0.1.0（决策 B）：审核器注册表是 flow/registry 的只读投影，属核心层。
  //   这里用「子目录相对路径」登记（lintCore 按工程根目录拼接），
  //   保证它同样被「核心不得反向依赖插件层」的规则覆盖。
  'flow/adjudicators.js',
  // v0.2.1（T03 拓扑唯一真相）：派生层只读模块，属核心层。登记在此即被
  //   「核心不得反向依赖插件层」规则覆盖（lintCore 按工程根目录拼接路径 ⇒ src/flow/path-props.js）。
  'flow/path-props.js',
  // v0.2.0（图片全链路 / 类目契约 / 审计双写）：新增核心层模块，纳入本清单
  //   才能被「核心不得反向依赖插件层」的规则覆盖（lintCore 按工程根目录拼接路径）。
  'image-ref.js', 'plugin-ui-contract.js', 'audit-db.js',
  // v0.1.2（URL-only 图片输入）：远程图片拉取 + 转码也属核心层，纳入本清单。
  'image-source.js',
]);

/** 核心允许依赖的「装配点/中介」：这两处是架构规定的唯一出入口 */
const CORE_ALLOWED_PLUGIN_LAYER = new Set(['./plugin-runtime', './capability-broker']);

/** 匹配「核心反向依赖插件层」的 require 目标 */
const PLUGIN_LAYER_RE = /^\.\/(plugin-[\w-]+|cordis-[\w-]+|host-services|plugin-system)$/;

/**
 * 已知待迁移基线：v2.2.0 已完成 moderator.js 的边界修复（移除 require('./plugin-registry')），
 * 故此处清空；若再出现核心 → 插件层反向依赖，lint 将直接失败。
 */
const KNOWN_PENDING = Object.freeze([]);

/** 规则说明（供报告输出） */
const RULES = Object.freeze({
  'plugin-require-core': '插件代码 require 到工程核心目录（src/ / config/ 等）',
  'plugin-dynamic-require-core': '插件代码以非字面量 require 到核心目录',
  'plugin-direct-cordis': "插件代码直接 require('cordis')（应只通过注入的 ctx）",
  'plugin-host-app': '插件代码使用 host.app（契约 v1.0 已移除 host:app）',
  'plugin-unwhitelisted-dep': '插件代码 require 了白名单外的 npm 包',
  'plugin-eager-optional-require': '可选依赖在模块顶层 eager require（必须惰性 require，否则依赖缺失会崩）',
  'core-reverse-dependency': '核心模块反向 require 插件层（核心只允许依赖 capability-broker / plugin-runtime）',
});

const PLUGIN_DIR_FORBIDDEN = /(^|[\\/])\.\.([\\/])(src|config|node_modules)([\\/]|$)/;

/** 递归列出目录下的源码文件 */
function listJsFiles(dir, rel = '') {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    const relPath = rel ? `${rel}/${name}` : name;
    if (st.isDirectory()) { out.push(...listJsFiles(full, relPath)); continue; }
    if (/\.(js|cjs|mjs)$/i.test(name) && st.size <= 1024 * 1024) out.push({ abs: full, rel: relPath });
  }
  return out;
}

/**
 * 扫描单个插件目录，返回边界违规（装载期硬拦截用）。
 * @param {string} dir 插件目录绝对路径
 * @returns {{ok: boolean, violations: Array<{rule: string, file: string, line: number, detail: string}>}}
 */
function checkPluginDir(dir) {
  const violations = [];
  for (const file of listJsFiles(dir)) {
    let text = '';
    try { text = fs.readFileSync(file.abs, 'utf-8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // ① 字面量 require
      const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      let m = null;
      while ((m = re.exec(line)) !== null) {
        const spec = m[1];
        if (spec.startsWith('.')) {
          if (PLUGIN_DIR_FORBIDDEN.test(spec) || /(^|[\\/])src([\\/])/.test(spec)) {
            violations.push({ rule: 'plugin-require-core', file: file.rel, line: i + 1, detail: `require('${spec}')` });
          }
          continue;
        }
        if (path.isAbsolute(spec)) {
          violations.push({ rule: 'plugin-require-core', file: file.rel, line: i + 1, detail: `require('${spec}')` });
          continue;
        }
        const top = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (top === 'cordis' || top.startsWith('cordis/')) {
          violations.push({ rule: 'plugin-direct-cordis', file: file.rel, line: i + 1, detail: `require('${spec}')` });
          continue;
        }
        if (!DEPENDENCY_WHITELIST.has(top) && !OPTIONAL_DEPENDENCY_WHITELIST.has(top) && !top.startsWith('node:')) {
          violations.push({ rule: 'plugin-unwhitelisted-dep', file: file.rel, line: i + 1, detail: `require('${spec}')` });
          continue;
        }
        // v2.2.0：可选依赖不得在模块顶层 eager require（必须惰性 + try/catch）
        if (OPTIONAL_DEPENDENCY_WHITELIST.has(top) && /^(?:const|let|var)?\s*[\w{[\],\s}]*=\s*require\s*\(/.test(line)) {
          violations.push({
            rule: 'plugin-eager-optional-require',
            file: file.rel,
            line: i + 1,
            detail: `顶层 require('${spec}')（应改为惰性 require，并用 try/catch 兜底）`,
          });
        }
      }
      // ② 非字面量 require 且文本里出现核心目录
      if (/require\s*\(\s*[^'"`)]/.test(line) && PLUGIN_DIR_FORBIDDEN.test(line)) {
        violations.push({ rule: 'plugin-dynamic-require-core', file: file.rel, line: i + 1, detail: line.trim().slice(0, 160) });
      }
      // ③ host.app / inject('app')
      if (/\bhost\s*\.\s*app\b/.test(line) || /inject\s*\(\s*['"]app['"]/.test(line)) {
        violations.push({ rule: 'plugin-host-app', file: file.rel, line: i + 1, detail: line.trim().slice(0, 160) });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 扫描全部插件目录。
 * @returns {Array<{plugin: string, rule: string, file: string, line: number, detail: string}>}
 */
function lintPlugins() {
  const findings = [];
  if (!fs.existsSync(PLUGINS_DIR)) return findings;
  for (const name of fs.readdirSync(PLUGINS_DIR)) {
    const dir = path.join(PLUGINS_DIR, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const res = checkPluginDir(dir);
    for (const v of res.violations) findings.push({ plugin: name, ...v });
  }
  return findings;
}

/**
 * 扫描核心模块的反向依赖。
 * @returns {Array<{file: string, line: number, rule: string, detail: string, pending: boolean}>}
 */
function lintCore() {
  const findings = [];
  for (const name of CORE_MODULES) {
    const abs = path.join(SRC_DIR, name);
    if (!fs.existsSync(abs)) continue;
    const rel = `src/${name}`;
    let text = '';
    try { text = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const pending = KNOWN_PENDING.includes(rel);
    for (let i = 0; i < lines.length; i++) {
      const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      let m = null;
      while ((m = re.exec(lines[i])) !== null) {
        const spec = m[1];
        if (CORE_ALLOWED_PLUGIN_LAYER.has(spec)) continue;
        if (PLUGIN_LAYER_RE.test(spec) || spec === 'cordis' || spec.startsWith('cordis/')) {
          findings.push({
            file: rel,
            line: i + 1,
            rule: 'core-reverse-dependency',
            detail: `require('${spec}')`,
            pending,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * 统一入口。
 * @returns {{pluginFindings: Array<object>, coreFindings: Array<object>, errors: number, pending: number, ok: boolean}}
 */
function lint() {
  const pluginFindings = lintPlugins();
  const coreFindings = lintCore();
  const pending = coreFindings.filter((f) => f.pending).length;
  const errors = pluginFindings.length + (coreFindings.length - pending);
  return { pluginFindings, coreFindings, errors, pending, ok: errors === 0 };
}

/** 人类可读报告 */
function render(result) {
  const lines = [];
  lines.push('插件边界 lint（scripts/lint-plugin-boundary.js）');
  lines.push(`  工程根目录：${PROJECT_ROOT}`);
  lines.push('');
  lines.push(`【插件层 → 核心】${result.pluginFindings.length} 处违规`);
  if (result.pluginFindings.length === 0) {
    lines.push('  ✓ 未发现插件穿越到核心内部');
  } else {
    for (const f of result.pluginFindings) {
      lines.push(`  ✗ [${f.rule}] plugins/${f.plugin}/${f.file}:${f.line} ${f.detail}`);
    }
  }
  lines.push('');
  const hard = result.coreFindings.filter((f) => !f.pending);
  const pendingList = result.coreFindings.filter((f) => f.pending);
  lines.push(`【核心 → 插件层】${result.coreFindings.length} 处（其中已知待迁移 ${pendingList.length} 处）`);
  for (const f of hard) {
    lines.push(`  ✗ [${f.rule}] ${f.file}:${f.line} ${f.detail}`);
  }
  for (const f of pendingList) {
    lines.push(`  ⚠ [${f.rule}·已知待迁移] ${f.file}:${f.line} ${f.detail}（moderator.js 由后续任务改造，本次不阻塞）`);
  }
  if (hard.length === 0 && pendingList.length === 0) {
    lines.push('  ✓ 核心未反向依赖插件层');
  }
  lines.push('');
  lines.push(result.ok
    ? `结果：通过（${result.pending} 处已知待迁移已登记，不阻塞）`
    : `结果：失败（${result.errors} 处需修复）`);
  return lines.join('\n');
}

function main() {
  const result = lint();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(result)}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  PROJECT_ROOT,
  PLUGINS_DIR,
  DEPENDENCY_WHITELIST,
  OPTIONAL_DEPENDENCY_WHITELIST,
  CORE_MODULES,
  CORE_ALLOWED_PLUGIN_LAYER,
  KNOWN_PENDING,
  RULES,
  checkPluginDir,
  lintPlugins,
  lintCore,
  lint,
  render,
};
