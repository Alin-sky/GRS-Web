#!/usr/bin/env node
/**
 * 额度前置拦截实测（scripts/test-billing-guard-live.js）
 *
 * 设计依据：v2.3.0 Req6 —— Token Plan 额度端点不含名字带 vl 的传统视觉模型（qwen3-vl-* 会 404），
 * 导致图片审核每次 404 并触发 fail-closed 全量拦截。修复的关键是**把拦截提到网络请求之前**。
 *
 * 本脚本在**真实调用路径**（src/qwen_cloud.js moderateImageCloud）上验证：
 *   ① token-plan + 视觉模型 → 抛可执行错误，且**不发起任何网络请求**；
 *   ② dashscope + 视觉模型 → 不误拦，放行到网络层（由桩 fetch 证明）。
 *
 * 全程不发起真实 API 请求：global.fetch 被替换为计数桩，
 *   「拦截是否在网络之前」由桩调用次数直接证明。
 *
 * 用法：
 *   node scripts/test-billing-guard-live.js
 *   退出码：全部通过为 0，否则为 1。
 */

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const results = [];

/**
 * 断言并记录（支持 async 用例）。
 * @param {string} name 用例名
 * @param {Function} fn 用例体
 * @returns {Promise<void>} 完成
 */
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    (d) => { results.push({ name, ok: true, detail: typeof d === 'string' ? d : '' }); },
    (e) => { results.push({ name, ok: false, detail: e.message }); }
  );
}

/** 断言辅助。 */
function assert(c, m) { if (!c) throw new Error(m); }

async function main() {
  // 替换 fetch 为计数桩：任何真实网络请求都会被立即计数并抛错
  let fetchCalled = 0;
  const origFetch = global.fetch;
  global.fetch = () => { fetchCalled += 1; throw new Error('不应发起网络请求'); };

  const cfgPath = require.resolve(path.join(ROOT, 'src/config.js'));
  const qcPath = require.resolve(path.join(ROOT, 'src/qwen_cloud.js'));

  /** 重载 qwen_cloud，使新 config 生效。 */
  function reloadQwenCloud(patch) {
    const base = require(cfgPath).loadConfig();
    Object.assign(base, patch);
    base.qwenCloud = Object.assign({}, base.qwenCloud, patch.qwenCloud || {});
    delete require.cache[cfgPath];
    delete require.cache[qcPath];
    const cfg2 = require(cfgPath);
    Object.assign(cfg2.loadConfig(), base);
    return require(qcPath);
  }

  await check('token-plan + 视觉模型 → 调用前即抛可执行错误（不发请求）', async () => {
    const qc = reloadQwenCloud({
      moderationMode: 'local',            // 绕开 cloud-only 分支，直测额度校验
      qwenCloud: {
        enabled: true,
        billingSource: 'token-plan',
        visionModel: 'qwen3-vl-plus',
        apiKey: 'sk-test-fake-key',
        visionEnabled: true,
      },
    });

    const before = fetchCalled;
    let err = null;
    try {
      await qc.moderateImageCloud('sys', 'user', 'AAAA');
    } catch (e) { err = e; }

    assert(err, '应抛错但未抛');
    assert(/Token Plan/i.test(err.message), '错误未点明 Token Plan: ' + err.message);
    assert(/dashscope|qwen3-vl:8b/.test(err.message), '错误未给出可执行建议: ' + err.message);
    assert(fetchCalled === before,
      `前置拦截失效：仍发起了 ${fetchCalled - before} 次网络请求`);
    return err.message.slice(0, 120);
  });

  await check('dashscope + 视觉模型 → 不触发额度拦截（放行到网络层）', async () => {
    const qc = reloadQwenCloud({
      moderationMode: 'local',
      qwenCloud: {
        enabled: true,
        billingSource: 'dashscope',
        visionModel: 'qwen3-vl-plus',
        apiKey: 'sk-test-fake-key',
        visionEnabled: true,
      },
    });

    const before = fetchCalled;
    let err = null;
    try {
      await qc.moderateImageCloud('sys', 'user', 'AAAA');
    } catch (e) { err = e; }

    // 放行后应到达 fetch（被桩拦截）→ 说明额度校验未误拦
    assert(fetchCalled > before, 'dashscope 下未放行到网络层，可能被误拦');
    assert(err && /不应发起网络请求/.test(err.message),
      '意外的错误: ' + (err && err.message));
    return '已放行至网络层（额度校验未误拦）';
  });

  global.fetch = origFetch;

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;

  const line = '-'.repeat(88);
  console.log(line);
  console.log('GRS billing guard live self-test (no real API request)');
  console.log(line);
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name}`);
    if (r.detail) console.log(`        :: ${r.detail}`);
  }
  console.log(line);
  console.log(`passed=${pass} failed=${fail}`);
  console.log(fail === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });