#!/usr/bin/env node
/**
 * 插件 UI 类目契约 lint（scripts/lint-plugin-ui.js）
 *
 * 设计依据：docs/architecture-2026-09-17-image-persist.md §3.8 / §3.9（类目受控枚举 + ui.panel）。
 *
 * 校验对象（**左移**：把「视图在界面上凭空消失」这类缺陷拦在提交前）：
 *   ① `contributes.views[].category` 必须是 `src/plugin-ui-contract` 的 `VIEW_CATEGORIES` 之一
 *      （不含 `plugins`；`moderation` / `config` 是历史遗留、非 Tab ⇒ 直接失败并给出建议值）
 *   ② `contributes.ui.panel` 若非空，必须是合法面板类目（显式 `plugins` 视为「留在插件管理」，合法）
 *
 * 单一真相：本脚本 `require('../src/plugin-ui-contract')`，**不复制任何枚举**。
 *
 * 用法：
 *   node scripts/lint-plugin-ui.js            # 人类可读报告
 *   node scripts/lint-plugin-ui.js --json     # JSON 报告
 * 退出码：存在违规时为 1，否则为 0。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const contract = require('../src/plugin-ui-contract');

const PROJECT_ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'plugins');

/**
 * 校验单个 manifest 的 UI 贡献点。
 * @param {string} pluginDir 插件目录名
 * @returns {Array<{plugin: string, rule: string, detail: string}>} 违规列表
 */
function checkManifest(pluginDir) {
  const violations = [];
  const manifestPath = path.join(PLUGINS_DIR, pluginDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return [{ plugin: pluginDir, rule: 'missing-manifest', detail: '缺少 manifest.json' }];
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return [{ plugin: pluginDir, rule: 'invalid-json', detail: `manifest.json 无法解析: ${err.message}` }];
  }
  const contributes = (manifest && manifest.contributes) || {};
  const views = Array.isArray(contributes.views) ? contributes.views : [];

  views.forEach((v, i) => {
    if (!v || typeof v !== 'object') return;
    const raw = (v.category === undefined || v.category === null) ? '' : String(v.category).trim();
    if (!raw) {
      violations.push({
        plugin: pluginDir,
        rule: 'view-category-missing',
        detail: `views[${i}] (id=${v.id || '?'}) 未声明 category —— 会走「插件管理」兜底渲染；` +
          `请显式声明受控枚举之一：${contract.VIEW_CATEGORIES.join(', ')}`,
      });
      return;
    }
    if (!contract.isValidViewCategory(raw)) {
      const hint = contract.legacyCategoryHint(raw);
      violations.push({
        plugin: pluginDir,
        rule: 'view-category-invalid',
        detail: `views[${i}] (id=${v.id || '?'}) 的 category「${raw}」不是受控枚举` +
          `${hint ? `；建议改为「${hint}」` : ''}。合法值：${contract.VIEW_CATEGORIES.join(', ')}`,
      });
    }
  });

  const ui = contributes.ui;
  if (ui && typeof ui === 'object' && ui.panel !== undefined && ui.panel !== null && String(ui.panel).trim() !== '') {
    const panel = String(ui.panel).trim();
    if (panel !== contract.LIFECYCLE_CATEGORY && !contract.isValidPanel(panel)) {
      violations.push({
        plugin: pluginDir,
        rule: 'ui-panel-invalid',
        detail: `contributes.ui.panel「${panel}」不是受控枚举。合法值：${contract.VIEW_CATEGORIES.join(', ')}` +
          `（或显式写 "${contract.LIFECYCLE_CATEGORY}" 表示留在插件管理）`,
      });
    }
  }
  return violations;
}

/**
 * 扫描全部插件目录。
 * @returns {Array<object>} 违规列表
 */
function lint() {
  const findings = [];
  if (!fs.existsSync(PLUGINS_DIR)) return findings;
  for (const name of fs.readdirSync(PLUGINS_DIR)) {
    const dir = path.join(PLUGINS_DIR, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    findings.push(...checkManifest(name));
  }
  return findings;
}

/**
 * 人类可读报告。
 * @param {Array<object>} findings 违规列表
 * @param {number} total 插件数
 * @returns {string} 报告
 */
function render(findings, total) {
  const lines = [];
  lines.push('插件 UI 类目 lint（scripts/lint-plugin-ui.js）');
  lines.push(`  VIEW_CATEGORIES（${contract.VIEW_CATEGORIES.length} 个）：${contract.VIEW_CATEGORIES.join(', ')}`);
  lines.push(`  扫描插件目录：${total} 个`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('  ✓ 所有 manifest 的 views[].category 与 contributes.ui.panel 均合法');
  } else {
    for (const f of findings) lines.push(`  ✗ [${f.rule}] plugins/${f.plugin} — ${f.detail}`);
  }
  lines.push('');
  lines.push(findings.length === 0 ? '结果：通过' : `结果：失败（${findings.length} 处需修复）`);
  return lines.join('\n');
}

function main() {
  let total = 0;
  if (fs.existsSync(PLUGINS_DIR)) {
    total = fs.readdirSync(PLUGINS_DIR)
      .filter((n) => { try { return fs.statSync(path.join(PLUGINS_DIR, n)).isDirectory(); } catch { return false; } })
      .length;
  }
  const findings = lint();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ findings, total, ok: findings.length === 0 }, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(findings, total)}\n`);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

if (require.main === module) main();

module.exports = { lint, checkManifest, render };
