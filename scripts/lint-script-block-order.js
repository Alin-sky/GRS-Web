#!/usr/bin/env node
/**
 * 前端 script 块顺序 lint —— scripts/lint-script-block-order.js
 *
 * 要防的缺陷（本轮真实出现过）：public/index.html 里有多个经典 `<script>` 块，
 * 块内 `function foo(){}` 的提升**不跨块**，块按文档顺序执行。
 * 于是「在靠前的块里顶层调用一个只在靠后的块中定义的函数」= 运行期
 * `Uncaught ReferenceError: foo is not defined`，并且**该块后续语句全部中断**。
 * 上次表现为：统计面板下钻的红色故障条与拓扑说明在页面加载时都不渲染，控制台报错。
 *
 * 判定：扫描每个 script 块**顶层**（缩进 0）的裸调用 `name(...)`，
 * 若 name 仅在**更靠后**的块里定义 ⇒ 记为危险。浏览器全局（未在任一块定义）不报。
 *
 * 用法：node scripts/lint-script-block-order.js [--json]
 * 退出码：0 = 无危险；1 = 发现跨块调用危险。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
// GRS_LINT_HTML_TARGET：仅供本 lint 的自测（负向对照）指向临时副本，默认仍是前端主文件。
const TARGET = process.env.GRS_LINT_HTML_TARGET
  ? path.resolve(process.env.GRS_LINT_HTML_TARGET)
  : path.join(PROJECT_ROOT, 'public', 'index.html');

/** 不是函数调用的行首关键字（避免把控制流当调用）。 */
const NOT_A_CALL = new Set([
  'function', 'return', 'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'typeof',
  'const', 'let', 'var', 'new', 'await', 'yield', 'throw', 'delete', 'in', 'of', 'void',
]);

/**
 * 按出现顺序切出所有经典 `<script>` 块（不含带 src 的外链与 JSON 模板）。
 * @param {string} html 文件内容
 * @returns {Array<{startLine:number, body:string}>} 块列表
 */
function extractBlocks(html) {
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;                       // 外链脚本不参与本文件的顺序分析
    if (/type\s*=\s*["']?(application|text)\/(json|template)/.test(attrs)) continue;
    out.push({ startLine: html.slice(0, m.index).split('\n').length, body: m[2] });
  }
  return out;
}

/**
 * 找出 name 的定义块序号（1 起）；未在任何块定义 ⇒ 0。
 * 同时认函数声明、函数表达式赋值、class、以及 `name = function/async function` 形式。
 */
function definedInBlock(blocks, name) {
  const esc = name.replace(/[$]/g, '\\$');
  const pats = [
    new RegExp('function\\s+' + esc + '\\s*\\('),
    new RegExp('(?:const|let|var)\\s+' + esc + '\\s*=\\s*(?:async\\s*)?(?:function\\b|\\()'),
    new RegExp('(?:const|let|var)\\s+' + esc + '\\s*=\\s*(?:async\\s*)?[A-Za-z_$]'),
    new RegExp('class\\s+' + esc + '\\b'),
  ];
  for (let i = 0; i < blocks.length; i += 1) {
    if (pats.some((p) => p.test(blocks[i].body))) return i + 1;
  }
  return 0;
}

/** 收集各块顶层裸调用，并与定义块比对。 */
function findHazards(blocks) {
  const hazards = [];
  blocks.forEach((b, bi) => {
    b.body.split('\n').forEach((raw, li) => {
      if (/^\s/.test(raw)) return;                 // 只看顶层（缩进 0）
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
      const mTop = line.match(/^([A-Za-z_$][\w$]*)\s*\(/);
      if (!mTop) return;
      const name = mTop[1];
      if (NOT_A_CALL.has(name)) return;
      const defBlock = definedInBlock(blocks, name);
      if (defBlock > bi + 1) {
        hazards.push({
          callBlock: bi + 1,
          callLine: b.startLine + li,
          name,
          definedBlock: defBlock,
          detail: `块 #${bi + 1}（行 ${b.startLine + li}）顶层调用 ${name}()，但它只在更靠后的块 #${defBlock} 定义`,
        });
      }
    });
  });
  return hazards;
}

function main() {
  const asJson = process.argv.includes('--json');
  if (!fs.existsSync(TARGET)) {
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, error: 'public/index.html 不存在' })}\n`);
    else console.log('跳过：public/index.html 不存在');
    process.exitCode = 0;                          // 文件不存在不视为失败（本 lint 只服务现有前端）
    return;
  }
  const html = fs.readFileSync(TARGET, 'utf-8');
  const blocks = extractBlocks(html);
  const hazards = findHazards(blocks);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: hazards.length === 0, blocks: blocks.length, hazards }, null, 2)}\n`);
    process.exitCode = hazards.length === 0 ? 0 : 1;
    return;
  }

  console.log('前端 script 块顺序 lint（scripts/lint-script-block-order.js）');
  console.log(`  目标：${TARGET}`);
  console.log(`  script 块数：${blocks.length}（起始行 ${blocks.map((b) => b.startLine).join(', ')}）`);
  if (hazards.length === 0) {
    console.log('\n  ✓ 未发现「靠前块调用靠后块才定义的函数」');
    console.log('\n结果：通过');
    process.exitCode = 0;
    return;
  }
  console.log(`\n  ✗ 发现 ${hazards.length} 处跨块调用危险（运行期会抛 ReferenceError 并中断该块）：`);
  hazards.forEach((h) => console.log(`    ✗ ${h.detail}`));
  console.log('\n修复方式：把该调用移到**它所在定义块的末尾**，或把函数定义提前到调用所在块。');
  process.exitCode = 1;
}

main();
