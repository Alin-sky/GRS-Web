#!/usr/bin/env node
/**
 * 审核器注册表单测（scripts/test-adjudicators.js）
 *
 * 覆盖四条架构不变量：
 *   ① 同源性：注册表 = flow/registry 的只读投影（不是第二份名单）
 *   ② 零改动：新插件出现所需的核心改动为零（注册进 registry 即可被枚举）
 *   ③ ready 唯一来源：一律来自 registry.computeReadiness()
 *   ④ 缺插件是正常态：任何查询 / 调用都不许抛异常，也不许被当成 safe
 *
 * 用法：node scripts/test-adjudicators.js
 * 退出码：全部通过为 0，否则为 1。
 */

'use strict';

const registry = require('../src/flow/registry');
const adjudicators = require('../src/flow/adjudicators');
const broker = require('../src/capability-broker');
const flowNodes = require('../src/flow/nodes');

let passed = 0;
let failed = 0;

/**
 * 断言并打印一行结果。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 详情
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name.padEnd(46)} ${detail}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name.padEnd(46)} ${detail}`);
  }
}

/**
 * 干净起步：清空注册表与 broker 状态后重新登记内置节点。
 *
 * 为什么不用 `flowNodes.registerBuiltins()`：它用模块级 `_registered` 标志做幂等，
 *   registry.reset() 之后该标志仍为 true → 内置节点不会被重新登记。
 *   这里按同样的入参手工注册，保证每条用例的起始状态一致。
 */
function reset() {
  registry.reset();
  broker._reset();
  for (const mod of flowNodes.BUILTINS) {
    registry.registerBuiltin({ ...mod.descriptor, readyFn: mod.readiness, run: mod.run });
  }
}

async function main() {
  // ── ① 同源性 ──
  reset();
  const textRefs = adjudicators.list('text').map((e) => e.ref).sort();
  const panelRefs = registry.snapshot('text').nodes.map((n) => n.ref).sort();
  const expectedRefs = panelRefs.filter((r) => !adjudicators.NON_ADJUDICATOR_REFS.includes(r));
  check('A01 与画布快照同源', JSON.stringify(textRefs) === JSON.stringify(expectedRefs),
    `registry=[${textRefs.join(',')}]`);
  check('A02 排除非审核器（预检）', !textRefs.includes('builtin.precheck'), `refs=[${textRefs.join(',')}]`);
  check('A03 内置 runner 可辨识',
    adjudicators.get('builtin.localModel').runner === 'localModel'
    && adjudicators.get('builtin.cloudModel').runner === 'cloudModel',
    `local=${adjudicators.get('builtin.localModel').runner} cloud=${adjudicators.get('builtin.cloudModel').runner}`);
  check('A04 快照带版本与契约号', adjudicators.snapshot('text').version === 1
    && typeof adjudicators.snapshot('text').hostApiVersion === 'string'
    && adjudicators.snapshot('text').hostApiVersion.length > 0,
    `v=${adjudicators.snapshot('text').version} hostApi=${adjudicators.snapshot('text').hostApiVersion}`);

  // ── ② 零改动：新插件自动出现 ──
  reset();
  registry.registerPluginNodes('demo-guard', [{
    ref: 'plugin.demo-guard.image',
    title: '演示守卫 · 图片',
    icon: '🧪',
    modality: ['image'],
    role: 'service',
    capability: 'image.verdict',
    costHint: 'local-gpu',
    ready: true,
  }]);
  const demo = adjudicators.get('plugin.demo-guard.image');
  check('B01 新插件零核心改动即出现在注册表', Boolean(demo), demo ? `ref=${demo.ref}` : 'not-found');
  check('B02 插件 runner 自动为 pluginVerdict', Boolean(demo && demo.runner === 'pluginVerdict'),
    demo ? `runner=${demo.runner}` : 'n/a');
  check('B03 owner / kind / costHint 透传',
    Boolean(demo && demo.owner === 'demo-guard' && demo.kind === 'plugin' && demo.costHint === 'local-gpu'),
    demo ? `owner=${demo.owner} kind=${demo.kind} cost=${demo.costHint}` : 'n/a');
  check('B04 文本模态不串到图片模态', adjudicators.list('text').every((e) => e.ref !== 'plugin.demo-guard.image'),
    `imageCount=${adjudicators.list('image').length}`);
  registry.unregisterOwner('demo-guard');
  check('B05 卸载后自动消失', adjudicators.get('plugin.demo-guard.image') === null, 'unregistered');

  // ── ③ ready 唯一来源 ──
  reset();
  registry.registerBuiltin({
    ref: 'builtin.probe',
    title: '就绪度探针',
    modality: ['text'],
    role: 'service',
    readyFn: () => ({ ready: false, reason: 'not-configured', installHint: 'npm i demo-dep' }),
  });
  const probe = adjudicators.get('builtin.probe');
  check('C01 未就绪态透传 ready=false', Boolean(probe && probe.ready === false), probe ? `ready=${probe.ready}` : 'n/a');
  check('C02 reason / installHint 透传',
    Boolean(probe && probe.reason === 'not-configured' && probe.installHint === 'npm i demo-dep'),
    probe ? `reason=${probe.reason} hint=${probe.installHint}` : 'n/a');
  const snapshotProbe = registry.snapshot('text').nodes.find((n) => n.ref === 'builtin.probe');
  check('C03 与 registry 快照判定一致', Boolean(snapshotProbe && snapshotProbe.ready === false && probe.ready === false),
    `registry=${snapshotProbe && snapshotProbe.ready} adjudicators=${probe && probe.ready}`);

  // ── ④ 缺插件是正常态 ──
  reset();
  const missing = await adjudicators.invoke('plugin.not-installed.text', { text: 'abc' }, 'text');
  check('D01 未注册 ref 调用不抛异常且 skipped', missing.available === false && missing.skipped === true,
    `reason=${missing.reason}`);
  check('D02 skipped 结果不带 risk_level（绝不缺省放行）', missing.risk_level === undefined,
    `risk=${String(missing.risk_level)}`);
  const builtinInvoke = await adjudicators.invoke('builtin.localModel', { text: 'abc' }, 'text');
  check('D03 内置 ref 不可一次性调用', builtinInvoke.available === false && builtinInvoke.reason === 'builtin-not-invocable',
    `reason=${builtinInvoke.reason}`);
  let crashed = false;
  try {
    await adjudicators.invoke('', { text: 'abc' }, 'text');
    await adjudicators.invoke(null, { text: 'abc' }, 'text');
    await adjudicators.invoke('builtin.precheck', { text: 'abc' }, 'text');
  } catch {
    crashed = true;
  }
  check('D04 非法入参一律不崩', crashed === false, 'empty/null/non-adjudicator');

  // ── ⑤ 经 SkyBroker 的真正一次调用（信誉依赖收紧：账面被拒 → skipped）──
  reset();
  registry.registerPluginNodes('aliyun-content-safety', [{
    ref: 'plugin.aliyun-content-safety.text',
    title: '阿里云内容安全 · 文本',
    modality: ['text'],
    role: 'service',
    capability: 'text.verdict',
    costHint: 'paid-api',
    ready: true,
  }]);
  let nextVerdict = null;
  broker.setTransport({
    emitCollect: async () => [],
    emitFirst: async () => undefined,
    emitCall: async () => nextVerdict,
    hasHandlers: () => true,
  });
  broker.registerAll('aliyun-content-safety', [
    { id: 'text.verdict', event: 'moderation:verdict:text', mode: 'call', outputSchema: 'ModerationVerdict' },
  ]);
  const csRef = 'plugin.aliyun-content-safety.text';
  nextVerdict = { risk_level: 'high', categories: ['abuse'], category_scores: { abuse: 80 }, confidence: 0.9, reason: 'r', suggestion: '' };
  const okRes = await adjudicators.invoke(csRef, { text: 'abc' }, 'text');
  check('E01 插件判定可用时 available=true', okRes.available === true && okRes.skipped === false,
    `available=${okRes.available} provider=${okRes.provider}`);
  check('E02 risk_level → suggestion 映射正确', okRes.suggestion === 'block' && okRes.risk_level === 'high',
    `suggestion=${okRes.suggestion}`);
  check('E03 provider 为插件 owner', okRes.provider === 'aliyun-content-safety', `provider=${okRes.provider}`);
  const shapeKeys = ['available', 'provider', 'skipped', 'reason', 'suggestion', 'risk_level', 'categories', 'category_scores', 'confidence', 'matched_labels', 'elapsed_ms'];
  check('E04 返回形状齐备', shapeKeys.every((k) => k in okRes), `missing=${shapeKeys.filter((k) => !(k in okRes)).join(',') || 'none'}`);

  nextVerdict = { risk_level: 'totally_safe', categories: [], confidence: 0.9, reason: 'r', suggestion: '' };
  const forged = await adjudicators.invoke(csRef, { text: 'abc' }, 'text');
  check('E05 伪造 risk_level 被 output-gate 拒绝 → skipped', forged.available === false && forged.skipped === true,
    `reason=${forged.reason}`);

  nextVerdict = null;
  const noVerdict = await adjudicators.invoke(csRef, { text: 'abc' }, 'text');
  check('E06 插件无返回 → skipped', noVerdict.available === false && noVerdict.skipped === true, `reason=${noVerdict.reason}`);

  broker.unregisterPlugin('aliyun-content-safety');
  const goneRes = await adjudicators.invoke(csRef, { text: 'abc' }, 'text');
  check('E07 插件卸载 → skipped（不 fail-open）', goneRes.available === false && goneRes.skipped === true,
    `reason=${goneRes.reason}`);

  // ── ⑥ 已下线 ref 的迁移表 ──
  check('F01 已下线 ref 可被识别', adjudicators.isRetiredRef('builtin.contentSafety') === true, 'retired');
  check('F02 后继 ref 解析正确',
    adjudicators.successorOf('builtin.contentSafety', 'text') === 'plugin.aliyun-content-safety.text'
    && adjudicators.successorOf('builtin.contentSafety', 'image') === 'plugin.aliyun-content-safety.image',
    'text/image');
  check('F03 已下线 ref 永不注册', adjudicators.get('builtin.contentSafety') === null, 'not in registry');
  check('F04 非下线 ref 不误判', adjudicators.isRetiredRef('builtin.localModel') === false, 'builtin.localModel');
  check('F05 后继清单去重非空', adjudicators.retiredTargets().length === 2, adjudicators.retiredTargets().join(','));

  const line = '-'.repeat(96);
  console.log(line);
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`审核器注册表单测异常终止: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
