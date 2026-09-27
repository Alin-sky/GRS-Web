/**
 * 选项冲突矩阵自检（CFG-04 实测证据）—— scripts/test-config-conflicts.js
 *
 * 运行：node scripts/test-config-conflicts.js
 *
 * 覆盖：
 *   ① 干净配置 → 0 冲突（不误报）
 *   ② 人为制造多组冲突 → 每条都产出「带 ID + 实际生效值 + 消除方法」的报告
 *   ③ auto 类冲突确实施加了修正补丁
 *   ④ block 类冲突（端口非法）被标记为拒绝启动
 *   ⑤ 空配置 / 缺字段配置不得抛异常
 *   ⑥ X16 只在显式配置了 plugins 段落时才可能触发
 *
 * 输出纯 ASCII，避免 Windows 控制台代码页问题。
 */

'use strict';

const { detectConflicts, CONFLICT_RULES } = require('../src/config-conflicts');
const { DEFAULT_CONFIG, deepMerge } = require('../src/config-defaults');

let passed = 0;
let failed = 0;
const rows = [];

/**
 * 断言辅助。
 * @param {string} name 用例名
 * @param {boolean} ok 结果
 * @param {string} detail 说明
 */
function check(name, ok, detail) {
  if (ok) passed += 1; else failed += 1;
  rows.push({ name, ok, detail });
}

/** 静默日志收集器。 */
function makeLog() {
  const lines = [];
  return { lines, log: (level, message) => lines.push(`[${level}] ${message}`) };
}

/** 构造测试配置：以内置默认为基础，按需覆盖。 */
function makeConfig(overrides) {
  return deepMerge(DEFAULT_CONFIG, overrides || {});
}

// ── ① 干净配置不应误报 ──
{
  const cfg = makeConfig({
    adminPassword: 'set-by-test',
    wordDbPassword: 'set-by-test',
    moderation: { onAiFailure: 'block' },
  });
  const { log } = makeLog();
  const result = detectConflicts(cfg, { log });
  check('clean-config/no-false-positive', result.reports.length === 0,
    `reports=${result.reports.map((r) => r.id).join(',') || 'none'}`);
}

// ── ② 人为制造 7 组冲突 ──
const conflictCfg = makeConfig({
  moderationMode: 'cloud-only',
  adminPassword: '',
  wordDbPassword: '',
  qwenCloud: { enabled: true, apiKey: '', billingSource: 'token-plan' },
  tokenPlan: { apiKey: '' },
  contentSafety: { enabled: true, accessKeyId: 'YOUR_ALIBABA_CLOUD_ACCESS_KEY_ID', accessKeySecret: 'CHANGE_ME' },
  moderation: {
    dualMode: true,
    doubleCheck: true,
    strictness: 'relaxed',
    onAiFailure: 'yolo',
    reviewChannels: { local: true, cloud: false, contentSafety: false },
  },
  batch: { autoScanFolder: 'D:/images', autoScanStrictness: 'strict' },
});
const conflictLog = makeLog();
const conflictResult = detectConflicts(conflictCfg, { log: conflictLog.log });
const firedIds = conflictResult.reports.map((r) => r.id);

for (const expected of ['X01', 'X03', 'X04', 'X05', 'X07', 'X08', 'X09', 'X12', 'X15']) {
  check(`fires/${expected}`, firedIds.includes(expected), `fired=[${firedIds.join(',')}]`);
}

// ③ auto 补丁确实生效
check('patch/X01-moderationMode', conflictCfg.moderationMode === 'local',
  `moderationMode=${conflictCfg.moderationMode}`);
check('patch/X03-doubleCheck', conflictCfg.moderation.doubleCheck === false,
  `doubleCheck=${conflictCfg.moderation.doubleCheck}`);
check('patch/X05-billingSource', conflictCfg.qwenCloud.billingSource === 'dashscope',
  `billingSource=${conflictCfg.qwenCloud.billingSource}`);
check('patch/X07-contentSafetyOff', conflictCfg.contentSafety.enabled === false,
  `contentSafety.enabled=${conflictCfg.contentSafety.enabled}`);
check('patch/X12-onAiFailure', conflictCfg.moderation.onAiFailure === 'block',
  `onAiFailure=${conflictCfg.moderation.onAiFailure}`);

// 报告必须三要素齐全：ID / 实际生效 / 消除方法
const sample = conflictResult.reports.find((r) => r.id === 'X03');
check('report/shape', Boolean(sample && sample.id && sample.effective && sample.fix && sample.message),
  sample ? `effective="${sample.effective}" fix="${sample.fix.slice(0, 28)}"` : 'missing X03');

// 统一文案：日志行必须带 [ID] 与 "→"
const hasIdLine = conflictLog.lines.some((l) => l.includes('[X01]'));
const hasFixLine = conflictLog.lines.some((l) => l.includes('\u2192 修改 config/default.json'));
check('log/unified-wording', hasIdLine && hasFixLine,
  `lines=${conflictLog.lines.length}`);

// ── ④ 三通道全关 → X02 + notConfigured 标记 ──
{
  const cfg = makeConfig({
    adminPassword: 'x',
    wordDbPassword: 'x',
    moderationMode: 'local',
    moderation: { reviewChannels: { local: false, cloud: false, contentSafety: false } },
  });
  const { log } = makeLog();
  const result = detectConflicts(cfg, { log });
  check('fires/X02', result.reports.some((r) => r.id === 'X02'),
    `fired=[${result.reports.map((r) => r.id).join(',')}]`);
  check('patch/X02-notConfigured', cfg.moderation.notConfigured === true,
    `notConfigured=${cfg.moderation.notConfigured}`);
}

// ── ⑤ 端口非法 → block（拒绝启动）──
{
  const cfg = makeConfig({
    adminPassword: 'x',
    wordDbPassword: 'x',
    server: { port: 99999 },
  });
  const { log } = makeLog();
  const result = detectConflicts(cfg, { log });
  check('fires/X13', result.reports.some((r) => r.id === 'X13'),
    `fired=[${result.reports.map((r) => r.id).join(',')}]`);
  check('blocking/X13', result.blocking.length === 1 && result.blocking[0].id === 'X13',
    `blocking=${result.blocking.map((r) => r.id).join(',') || 'none'}`);
}

// ── ⑥ 空配置 / 缺字段配置不得抛异常 ──
{
  let threw = false;
  let reportCount = -1;
  try {
    const { log } = makeLog();
    const result = detectConflicts({}, { log });
    reportCount = result.reports.length;
  } catch {
    threw = true;
  }
  check('robust/empty-config', !threw, `threw=${threw} reports=${reportCount}`);

  let threwNull = false;
  try {
    const { log } = makeLog();
    detectConflicts(null, { log });
  } catch {
    threwNull = true;
  }
  check('robust/null-config', !threwNull, `threw=${threwNull}`);
}

// ── ⑦ X16 仅在显式配置 plugins 时触发 ──
{
  const withoutPlugins = makeConfig({ adminPassword: 'x', wordDbPassword: 'x' });
  const r1 = detectConflicts(withoutPlugins, { log: makeLog().log });
  check('X16/absent-plugins-silent', !r1.reports.some((r) => r.id === 'X16'),
    `fired=[${r1.reports.map((r) => r.id).join(',')}]`);

  const withPlugins = makeConfig({
    adminPassword: 'x',
    wordDbPassword: 'x',
    plugins: { enabled: true, permissions: [] },
    wd14: { enabled: true },
  });
  const r2 = detectConflicts(withPlugins, { log: makeLog().log });
  check('X16/fires-on-permission-gap', r2.reports.some((r) => r.id === 'X16'),
    `fired=[${r2.reports.map((r) => r.id).join(',')}]`);
}

// ── ⑧ 规则表自检：ID 唯一、字段齐全 ──
{
  const ids = CONFLICT_RULES.map((r) => r.id);
  const unique = new Set(ids).size === ids.length;
  const shaped = CONFLICT_RULES.every((r) => r.id && r.severity && r.resolution
    && typeof r.when === 'function' && typeof r.message === 'function' && r.fix);
  check('rules/unique-ids', unique, `count=${ids.length}`);
  check('rules/well-formed', shaped, `count=${ids.length}`);
}

// ── 报告 ──
const line = '-'.repeat(92);
console.log(line);
console.log('GRS config conflict matrix self-test (CFG-04)');
console.log(line);
console.log('RESULT  CASE');
console.log(line);
for (const r of rows) {
  console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(38)} ${r.detail}`);
}
console.log(line);
console.log(`rules registered: ${CONFLICT_RULES.length}  (${CONFLICT_RULES.map((r) => r.id).join(',')})`);
console.log(`passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
process.exitCode = failed === 0 ? 0 : 1;
