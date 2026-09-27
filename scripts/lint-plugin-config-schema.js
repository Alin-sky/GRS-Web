#!/usr/bin/env node
/**
 * 插件配置 schema 结构 lint（scripts/lint-plugin-config-schema.js）
 *
 * 为什么需要它：`CONFIG_SCHEMA`（各插件 index.js 里声明配置字段的对象）此前**没有任何**结构校验——
 *   `src/plugin-ui-schema.js#validateSchema` 校验的是**视图** schema（`sections[].fields[]`），
 *   直接喂 `CONFIG_SCHEMA` 会得到 `ok=false: sections 必须是数组`；配置侧只做「登记 + 强转/钳制」，
 *   喂 `type:'NOT_A_WIDGET'` 或不存在的 `group` 都会被照收，直到前端才回落成只读占位。
 *   ⇒ 把这类「配置项静默失效」拦在提交前，本脚本是**唯一**的静态结构检查。
 *
 * 单一真相：控件类型白名单**不手抄**——运行时从 `public/index.html` 的 `_PV_WIDGET_RENDERERS`
 *   解析（配置面板 `renderPluginConfig → renderField → renderWidget` 就走这张表），
 *   白名单与渲染器漂移即判错。
 *
 * 用法：
 *   node scripts/lint-plugin-config-schema.js            # 人类可读报告
 *   node scripts/lint-plugin-config-schema.js --json     # JSON 报告
 *   node scripts/lint-plugin-config-schema.js --selftest # 人造反例（证明检查有判别力）
 * 退出码：存在违规（或自检未如期变红）时为 1，否则为 0。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'plugins');
const INDEX_HTML = path.join(PROJECT_ROOT, 'public', 'index.html');

/**
 * 旧配置字段类型的兼容别名。
 * 依据：`renderWidget` 里 `field.type === 'boolean' ? 'switch' : ...`；
 *       `src/plugin-ui-schema.js` 的 `LEGACY_TYPE_ALIAS = { string: 'text', boolean: 'switch' }`。
 * 内置插件普遍写 `boolean`，故必须接受，否则会误报。
 */
const LEGACY_TYPE_ALIASES = ['boolean', 'string'];

/**
 * 从 `public/index.html` 解析 `_PV_WIDGET_RENDERERS` 的键集合（真实支持的控件类型）。
 * @returns {string[]} 控件类型清单（解析失败返回空数组）
 */
function readRendererTypes() {
  let html = '';
  try { html = fs.readFileSync(INDEX_HTML, 'utf-8'); } catch { return []; }
  const start = html.indexOf('_PV_WIDGET_RENDERERS = {');
  if (start < 0) return [];
  const end = html.indexOf('};', start);
  if (end < 0) return [];
  const body = html.slice(start, end);
  const keys = [];
  const re = /(?:'([^']+)'|([A-Za-z][\w-]*))\s*:/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const k = m[1] || m[2];
    if (k && k !== '_PV_WIDGET_RENDERERS') keys.push(k);
  }
  return [...new Set(keys)];
}

const RENDERER_TYPES = readRendererTypes();
const ALLOWED_TYPES = new Set([...RENDERER_TYPES, ...LEGACY_TYPE_ALIASES]);

/** 声明了取值集合的控件类型（default 必须命中其一）。 */
const OPTION_TYPES = new Set(['select', 'radio-group', 'checkbox-group']);
/** 必须携带数值区间的控件类型。 */
const RANGE_TYPES = new Set(['slider', 'number']);

/**
 * 校验单个插件的 CONFIG_SCHEMA 结构。
 * @param {object} schema 配置 schema（{ groups, fields }）
 * @param {string} pluginId 插件目录名（用于报告）
 * @returns {Array<{rule: string, detail: string}>} 违规列表
 */
function validateSchemaShape(schema, pluginId) {
  const v = [];
  const push = (rule, detail) => v.push({ plugin: pluginId, rule, detail });
  if (!schema || typeof schema !== 'object') { push('SCHEMA/missing', '导出对象上找不到 schema / configSchema'); return v; }
  if (!Array.isArray(schema.fields) || schema.fields.length === 0) { push('SCHEMA/no-fields', 'fields 必须是非空数组'); return v; }
  const groups = Array.isArray(schema.groups) ? schema.groups : [];
  const groupIds = new Set(groups.map((g) => g && g.id).filter(Boolean));
  const groupCounts = new Map([...groupIds].map((id) => [id, 0]));
  const seenKeys = new Set();

  schema.fields.forEach((f, i) => {
    const at = `fields[${i}]`;
    if (!f || typeof f !== 'object') { push('FIELD/not-object', `${at} 不是对象`); return; }
    const key = typeof f.key === 'string' ? f.key.trim() : '';
    if (!key) push('FIELD/missing-key', `${at} 缺少 key`);
    else if (seenKeys.has(key)) push('FIELD/duplicate-key', `key「${key}」在插件内重复`);
    else seenKeys.add(key);

    const type = typeof f.type === 'string' ? f.type.trim() : '';
    if (!type) push('FIELD/missing-type', `key=${key || at} 缺少 type`);
    else if (!ALLOWED_TYPES.has(type)) {
      push('FIELD/unknown-type', `key=${key} type「${type}」不在渲染器支持集合内（${RENDERER_TYPES.join(', ')}）`);
    }

    if (!Object.prototype.hasOwnProperty.call(f, 'default')) push('FIELD/missing-default', `key=${key} 缺少 default`);

    // 分组归位：字段声明的 group 必须已在同文件 groups 里声明
    const g = f.group;
    if (g !== undefined && g !== null && String(g).trim() !== '') {
      const gid = String(g).trim();
      if (!groupIds.has(gid)) push('GROUP/undeclared', `key=${key} 的 group「${gid}」未在同文件 groups 中声明`);
      else groupCounts.set(gid, groupCounts.get(gid) + 1);
    }

    // 类型 ↔ default 一致性
    const hasDefault = Object.prototype.hasOwnProperty.call(f, 'default');
    const d = f.default;
    if (hasDefault) {
      if (type === 'boolean' || type === 'switch') {
        if (typeof d !== 'boolean') push('FIELD/default-type-mismatch', `key=${key} type=${type} 的 default 应为布尔，实为 ${typeof d}`);
      } else if (type === 'number' || type === 'slider') {
        if (typeof d !== 'number' || !Number.isFinite(d)) push('FIELD/default-type-mismatch', `key=${key} type=${type} 的 default 应为有限数字，实为 ${JSON.stringify(d)}`);
      } else if (type === 'checkbox-group') {
        if (!Array.isArray(d)) push('FIELD/default-type-mismatch', `key=${key} type=checkbox-group 的 default 应为数组，实为 ${typeof d}`);
      } else if (['text', 'textarea', 'folder-picker', 'path-template', 'select', 'radio-group'].includes(type)) {
        if (typeof d !== 'string') push('FIELD/default-type-mismatch', `key=${key} type=${type} 的 default 应为字符串，实为 ${typeof d}`);
      }
    }

    // 区间控件：min < max 且 default 落在区间内
    if (RANGE_TYPES.has(type)) {
      const hasMin = typeof f.min === 'number';
      const hasMax = typeof f.max === 'number';
      if (!hasMin || !hasMax) {
        push(type === 'slider' ? 'SLIDER/min-max-invalid' : 'NUMBER/min-max-invalid', `key=${key} type=${type} 需同时声明数值 min/max`);
      } else if (!(f.min < f.max)) {
        push(type === 'slider' ? 'SLIDER/min-max-invalid' : 'NUMBER/min-max-invalid', `key=${key} min=${f.min} 不小于 max=${f.max}`);
      } else if (hasDefault && (typeof d !== 'number' || d < f.min || d > f.max)) {
        push(type === 'slider' ? 'SLIDER/default-out-of-range' : 'NUMBER/default-out-of-range', `key=${key} default=${JSON.stringify(d)} 不在 [${f.min}, ${f.max}] 内`);
      }
    }

    // 取值型控件：options 非空且 default 命中其一
    if (OPTION_TYPES.has(type)) {
      const options = Array.isArray(f.options) ? f.options.filter((o) => o && o.value !== undefined) : [];
      const dynamic = f.source && typeof f.source === 'object' && f.source.rpc;
      if (options.length === 0 && !dynamic) {
        push('SELECT/no-options', `key=${key} type=${type} 既无静态 options 也无 source.rpc 动态数据源`);
      } else if (options.length > 0 && hasDefault) {
        const values = options.map((o) => o.value);
        if (type === 'checkbox-group') {
          if (Array.isArray(d) && d.some((x) => !values.includes(x))) {
            push('CHOICE/default-not-in-options', `key=${key} default ${JSON.stringify(d)} 含不在 options 内的取值 ${JSON.stringify(values)}`);
          }
        } else if (!values.includes(d)) {
          push('SELECT/default-not-in-options', `key=${key} default=${JSON.stringify(d)} 不在 options 取值 ${JSON.stringify(values)} 内`);
        }
      }
    }
  });

  // 反向：声明了 group 但没有任何字段 ⇒ 空分组（界面上永不渲染）
  for (const [id, n] of groupCounts) {
    if (n === 0) push('GROUP/empty', `group「${id}」已声明但没有任何字段归属于它（该分组在界面上永不渲染）`);
  }

  return v;
}

/**
 * 扫描全部插件目录。
 * @returns {{violations: Array<object>, plugins: Array<{id: string, fields: number, groups: number, error?: string}>}}
 */
function lint() {
  const violations = [];
  const plugins = [];
  if (!fs.existsSync(PLUGINS_DIR)) return { violations, plugins };
  const dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of dirs) {
    const entry = path.join(PLUGINS_DIR, name, 'index.js');
    if (!fs.existsSync(entry)) { violations.push({ plugin: name, rule: 'SCHEMA/no-entry', detail: '缺少 index.js' }); continue; }
    let mod = null;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      mod = require(entry);
    } catch (err) {
      // 不静默跳过：加载失败本身即为违规（配置结构无法静态确认）
      violations.push({ plugin: name, rule: 'SCHEMA/load-failed', detail: `require 失败，无法静态校验：${err && err.message}` });
      plugins.push({ id: name, fields: 0, groups: 0, error: String(err && err.message) });
      continue;
    }
    const schema = (mod && mod.schema) || (mod && mod.configSchema);
    violations.push(...validateSchemaShape(schema, name));
    plugins.push({
      id: name,
      fields: schema && Array.isArray(schema.fields) ? schema.fields.length : 0,
      groups: schema && Array.isArray(schema.groups) ? schema.groups.length : 0,
    });
  }
  return { violations, plugins };
}

/**
 * 人造反例自检：对每条规则构造一个**必然违规**的最小 schema，断言检查确实报出对应规则；
 *   另配一个**合法** schema 作为阳性对照（必须 0 违规）。任一条未如期 ⇒ 自检失败。
 * @returns {{cases: Array<{rule: string, ok: boolean}>, ok: boolean}}
 */
function selftest() {
  const g = [{ id: 'g', title: 'G' }];
  const cases = [
    { rule: 'FIELD/unknown-type', schema: { groups: g, fields: [{ key: 'a', type: 'NOT_A_WIDGET', default: 1, group: 'g' }] } },
    { rule: 'SLIDER/default-out-of-range', schema: { groups: g, fields: [{ key: 'a', type: 'slider', min: 0, max: 1, default: 5, group: 'g' }] } },
    { rule: 'SLIDER/min-max-invalid', schema: { groups: g, fields: [{ key: 'a', type: 'slider', min: 1, max: 1, default: 1, group: 'g' }] } },
    { rule: 'GROUP/undeclared', schema: { groups: g, fields: [{ key: 'a', type: 'text', default: '', group: 'nope' }] } },
    { rule: 'GROUP/empty', schema: { groups: [{ id: 'g' }, { id: 'unused' }], fields: [{ key: 'a', type: 'text', default: '', group: 'g' }] } },
    { rule: 'FIELD/duplicate-key', schema: { groups: g, fields: [{ key: 'a', type: 'text', default: '', group: 'g' }, { key: 'a', type: 'text', default: '', group: 'g' }] } },
    { rule: 'FIELD/missing-default', schema: { groups: g, fields: [{ key: 'a', type: 'text', group: 'g' }] } },
    { rule: 'FIELD/missing-type', schema: { groups: g, fields: [{ key: 'a', default: '', group: 'g' }] } },
    { rule: 'FIELD/missing-key', schema: { groups: g, fields: [{ type: 'text', default: '', group: 'g' }] } },
    { rule: 'FIELD/default-type-mismatch', schema: { groups: g, fields: [{ key: 'a', type: 'boolean', default: 'yes', group: 'g' }] } },
    { rule: 'SELECT/no-options', schema: { groups: g, fields: [{ key: 'a', type: 'select', default: 'x', group: 'g' }] } },
    { rule: 'SELECT/default-not-in-options', schema: { groups: g, fields: [{ key: 'a', type: 'select', default: 'z', group: 'g', options: [{ value: 'x' }, { value: 'y' }] }] } },
    { rule: 'CHOICE/default-not-in-options', schema: { groups: g, fields: [{ key: 'a', type: 'checkbox-group', default: ['z'], group: 'g', options: [{ value: 'x' }] }] } },
    { rule: 'NUMBER/default-out-of-range', schema: { groups: g, fields: [{ key: 'a', type: 'number', min: 1, max: 10, default: 99, group: 'g' }] } },
    { rule: 'SCHEMA/no-fields', schema: { groups: g, fields: [] } },
  ];
  const results = cases.map((c) => ({
    rule: c.rule,
    ok: validateSchemaShape(c.schema, 'selftest').some((x) => x.rule === c.rule),
  }));
  // 阳性对照：合法 schema 必须 0 违规
  const positive = validateSchemaShape({
    groups: [{ id: 'g' }],
    fields: [
      { key: 'a', type: 'boolean', default: true, group: 'g' },
      { key: 'b', type: 'slider', min: 0, max: 1, default: 0.5, group: 'g' },
      { key: 'c', type: 'select', default: 'x', group: 'g', options: [{ value: 'x' }, { value: 'y' }] },
    ],
  }, 'selftest');
  results.push({ rule: '(positive-control) 合法 schema 应 0 违规', ok: positive.length === 0 });
  return { cases: results, ok: results.every((r) => r.ok) };
}

function render(result) {
  const L = [];
  L.push('插件配置 schema 结构 lint（scripts/lint-plugin-config-schema.js）');
  L.push(`  渲染器控件类型（读自 public/index.html _PV_WIDGET_RENDERERS，${RENDERER_TYPES.length} 个）：${RENDERER_TYPES.join(', ')}`);
  L.push(`  兼容别名：${LEGACY_TYPE_ALIASES.join(', ')}`);
  L.push(`  扫描插件：${result.plugins.length} 个`);
  for (const p of result.plugins) L.push(`    - ${p.id}：fields=${p.fields} groups=${p.groups}${p.error ? ` （加载失败：${p.error}）` : ''}`);
  L.push('');
  if (result.violations.length === 0) L.push('  ✓ 所有插件的 CONFIG_SCHEMA 结构合法');
  else for (const x of result.violations) L.push(`  ✗ [${x.rule}] plugins/${x.plugin}/index.js — ${x.detail}`);
  L.push('');
  L.push(result.violations.length === 0 ? '结果：通过' : `结果：失败（${result.violations.length} 处需修复）`);
  return L.join('\n');
}

function main() {
  if (process.argv.includes('--selftest')) {
    const st = selftest();
    for (const c of st.cases) process.stdout.write(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.rule}\n`);
    process.stdout.write(st.ok ? '\n自检：通过（每条规则均能如期变红，阳性对照 0 违规）\n' : '\n自检：失败（有规则未如期变红 ⇒ 检查可能恒真）\n');
    process.exitCode = st.ok ? 0 : 1;
    return;
  }
  const result = lint();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${render(result)}\n`);
  process.exitCode = result.violations.length === 0 ? 0 : 1;
}

if (require.main === module) main();

module.exports = { lint, validateSchemaShape, selftest, readRendererTypes, RENDERER_TYPES, ALLOWED_TYPES };