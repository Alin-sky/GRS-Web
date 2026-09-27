#!/usr/bin/env node
/**
 * 图校验单测（scripts/test-flow-validate.js）
 *
 * 覆盖：环、孤立节点（warn）、模态不匹配、重复 id、未知 ref、参数白名单、
 *       自环、度数、输出断开、规模上限、failurePolicy=skip 需二次确认。
 */

'use strict';

const registry = require('../src/flow/registry');
const { validateFlow } = require('../src/flow/validate');

let passed = 0;
let failed = 0;
const rows = [];

/**
 * 断言。
 * @param {string} name 用例
 * @param {boolean} ok 结果
 * @param {string} detail 说明
 */
function check(name, ok, detail) {
  if (ok) passed += 1; else failed += 1;
  rows.push({ name, ok, detail });
}

// 注册测试用节点（含一个纯图像节点，用于模态不匹配用例）
registry.reset();
registry.registerBuiltin({ ref: 'test.text', modality: ['text'], role: 'service', params: [{ key: 'threshold', type: 'slider', min: 0, max: 1, default: 0.5 }], defaultTimeoutMs: 1000 });
registry.registerBuiltin({ ref: 'test.image', modality: ['image'], role: 'service', params: [], defaultTimeoutMs: 1000 });
registry.registerBuiltin({ ref: 'test.contribute', modality: ['image'], role: 'contribute', params: [], defaultTimeoutMs: 1000 });

/**
 * 造一个合法文本流程骨架。
 * @returns {object} 流程
 */
function baseFlow() {
  return {
    schemaVersion: 1,
    modality: 'text',
    revision: 1,
    updatedAt: new Date().toISOString(),
    floors: [],
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 } },
      { id: 'a', type: 'service', ref: 'test.text', params: {}, position: { x: 0, y: 100 } },
      { id: 'out', type: 'output', position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: 'e1', from: 'in', to: 'a' },
      { id: 'e2', from: 'a', to: 'out' },
    ],
    finalizers: [],
    meta: { note: '', sourceOfTruth: true },
  };
}

/**
 * 取错误码集合。
 * @param {object} result 校验结果
 * @returns {string[]} 错误码
 */
function codes(result) {
  return result.errors.map((e) => e.code);
}

// ── 合法图 ──
{
  const r = validateFlow(baseFlow(), registry);
  check('valid/baseline', r.ok && r.errors.length === 0, `errors=${codes(r).join(',') || 'none'}`);
}

// ── E005 环 ──
{
  const f = baseFlow();
  f.nodes.push({ id: 'b', type: 'service', ref: 'test.text', params: {} });
  f.edges = [
    { id: 'e1', from: 'in', to: 'a' },
    { id: 'e2', from: 'a', to: 'b' },
    { id: 'e3', from: 'b', to: 'a' },
    { id: 'e4', from: 'b', to: 'out' },
  ];
  const r = validateFlow(f, registry);
  check('E005/cycle-detected', codes(r).includes('E005_CYCLE'), `codes=${codes(r).join(',')}`);
}

// ── E009 孤立节点（warn，不 ok=false）──
{
  const f = baseFlow();
  f.nodes.push({ id: 'ghost', type: 'service', ref: 'test.text', params: {} });
  const r = validateFlow(f, registry);
  check('E009/orphan-is-warn', r.ok && r.warnings.some((w) => w.code === 'E009_UNREACHABLE'),
    `ok=${r.ok} warnings=${r.warnings.map((w) => w.code).join(',')}`);
}

// ── E011 模态不匹配 ──
{
  const f = baseFlow();
  f.nodes[1].ref = 'test.image';
  const r = validateFlow(f, registry);
  check('E011/modality-mismatch', codes(r).includes('E011_MODALITY'), `codes=${codes(r).join(',')}`);
}

// ── E002 重复 id ──
{
  const f = baseFlow();
  f.nodes.push({ id: 'a', type: 'service', ref: 'test.text', params: {} });
  const r = validateFlow(f, registry);
  check('E002/dup-id', codes(r).includes('E002_DUP_ID'), `codes=${codes(r).join(',')}`);
}

// ── E004 未知 ref ──
{
  const f = baseFlow();
  f.nodes[1].ref = 'plugin.not-installed';
  const r = validateFlow(f, registry);
  check('E004/ref-unknown', codes(r).includes('E004_REF_UNKNOWN'), `codes=${codes(r).join(',')}`);
}

// ── E012 参数白名单 ──
{
  const f = baseFlow();
  f.nodes[1].params = { nope: 1 };
  const r = validateFlow(f, registry);
  check('E012/param-unknown', codes(r).includes('E012_PARAM_UNKNOWN'), `codes=${codes(r).join(',')}`);
}

// ── E013 参数越界 ──
{
  const f = baseFlow();
  f.nodes[1].params = { threshold: 3 };
  const r = validateFlow(f, registry);
  check('E013/param-type', codes(r).includes('E013_PARAM_TYPE'), `codes=${codes(r).join(',')}`);
}

// ── E006 自环 ──
{
  const f = baseFlow();
  f.edges.push({ id: 'e3', from: 'a', to: 'a' });
  const r = validateFlow(f, registry);
  check('E006/self-loop', codes(r).includes('E006_SELF_LOOP'), `codes=${codes(r).join(',')}`);
}

// ── E007 input 有入边 ──
{
  const f = baseFlow();
  f.edges.push({ id: 'e3', from: 'a', to: 'in' });
  const r = validateFlow(f, registry);
  check('E007/input-has-inbound', codes(r).includes('E007_INOUT_CARDINALITY'), `codes=${codes(r).join(',')}`);
}

// ── E008 service 入度 > 1 ──
{
  const f = baseFlow();
  f.nodes.push({ id: 'b', type: 'service', ref: 'test.text', params: {} });
  f.edges = [
    { id: 'e1', from: 'in', to: 'a' },
    { id: 'e2', from: 'in', to: 'b' },
    { id: 'e3', from: 'a', to: 'b' },
    { id: 'e4', from: 'b', to: 'out' },
  ];
  const r = validateFlow(f, registry);
  check('E008/degree', codes(r).includes('E008_DEGREE'), `codes=${codes(r).join(',')}`);
}

// ── E010 输出断开 ──
{
  const f = baseFlow();
  f.edges = [{ id: 'e1', from: 'in', to: 'a' }];
  const r = validateFlow(f, registry);
  check('E010/output-unconnected', codes(r).includes('E010_OUTPUT_UNCONNECTED'), `codes=${codes(r).join(',')}`);
}

// ── E014 规模上限 ──
{
  const f = baseFlow();
  for (let i = 0; i < 40; i++) f.nodes.push({ id: `n${i}`, type: 'service', ref: 'test.text', params: {} });
  const r = validateFlow(f, registry);
  check('E014/scale', codes(r).includes('E014_SCALE'), `codes=${codes(r).join(',')}`);
}

// ── E016 failurePolicy=skip 需二次确认 ──
{
  const f = baseFlow();
  f.nodes[1].failurePolicy = 'skip';
  const r = validateFlow(f, registry);
  check('E016/skip-needs-ack', codes(r).includes('E016_POLICY'), `codes=${codes(r).join(',')}`);
  const f2 = baseFlow();
  f2.nodes[1].failurePolicy = 'skip';
  f2.nodes[1].params = { __ackSkipRisk: true };
  const r2 = validateFlow(f2, registry);
  check('E016/skip-with-ack-ok', !codes(r2).includes('E016_POLICY'), `codes=${codes(r2).join(',')}`);
}

// ── E017 merge strategy 非法 ──
{
  const f = baseFlow();
  f.nodes.push({ id: 'b', type: 'service', ref: 'test.text', params: {} });
  f.nodes.push({ id: 'mg', type: 'merge', strategy: 'bogus' });
  f.edges = [
    { id: 'e1', from: 'in', to: 'a' },
    { id: 'e2', from: 'in', to: 'b' },
    { id: 'e3', from: 'a', to: 'mg' },
    { id: 'e4', from: 'b', to: 'mg' },
    { id: 'e5', from: 'mg', to: 'out' },
  ];
  const r = validateFlow(f, registry);
  check('E017/strategy', codes(r).includes('E017_STRATEGY'), `codes=${codes(r).join(',')}`);
}

// ── E015 重复边 ──
{
  const f = baseFlow();
  f.edges.push({ id: 'e3', from: 'in', to: 'a' });
  const r = validateFlow(f, registry);
  check('E015/dup-edge', codes(r).includes('E015_DUP_EDGE'), `codes=${codes(r).join(',')}`);
}

// ── 报告 ──
const line = '-'.repeat(88);
console.log(line);
console.log('GRS flow validator self-test');
console.log(line);
for (const r of rows) console.log(`${r.ok ? '  ok  ' : ' FAIL '}  ${r.name.padEnd(34)} ${r.detail}`);
console.log(line);
console.log(`passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
process.exitCode = failed === 0 ? 0 : 1;
