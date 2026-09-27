/**
 * 内置节点：敏感词预检（src/flow/nodes/builtin-precheck.js）
 * 语义（1:1 复刻 v2.1.0）：不作为「参与合并的分支」，而是**只升不降的下限层**，
 * 且 critical 命中即短路。因此它默认登记在 `flow.floors`，而不是 `flow.nodes`。
 * 用户若把它拖进主管线，抽屉里 combine 切为 branch，它才成为一条普通分支。
 * 词库不出库：本节点只把 `hasHit / 命中等级 / 分类` 交给上层，绝不外泄词条。
 */

'use strict';

const { precheck } = require('../../precheck');
const { riskOrder } = require('../risk');
const { loadConfig } = require('../../config');

/** 节点描述符。*/
const descriptor = {
  ref: 'builtin.precheck',
  title: '敏感词预检',
  desc: '本地敏感词库预检，零依赖、零费用，作为最终判定的下限（只升不降）',
  icon: '🛡️',
  modality: ['text'],
  output: 'ModerationVerdict',
  role: 'service',
  defaultCombine: 'branch',
  combineEditable: true,
  canParallel: false,
  multiInstance: false,
  ready: true,
  params: [],
  defaultTimeoutMs: 3000,
  failurePolicyOptions: ['inherit', 'block', 'review'],
  costHint: 'free',
};

/**
 * 取预检命中的最高等级。
 * @param {Array<object>} hits 命中列表
 * @returns {string|null} 最高等级
 */
function maxLevel(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const hit of hits) {
    const score = riskOrder(hit && hit.level);
    if (score > bestScore) { bestScore = score; best = hit.level; }
  }
  return best;
}

/**
 * 执行预检节点。
 * @param {object} runtime 运行时（{ ctx }）
 * @returns {Promise<object>} NodeResult
 */
async function run(runtime) {
  const started = Date.now();
  const text = (runtime.ctx.payload && runtime.ctx.payload.text) || '';
  const result = precheck(String(text || ''));
  const level = maxLevel(result.hits) || 'safe';
  const categories = result.hasHit ? [...new Set(result.hits.map((h) => h.category))] : [];
  return {
    nodeId: runtime.nodeId,
    ref: descriptor.ref,
    title: descriptor.title,
    status: 'ok',
    elapsedMs: Date.now() - started,
    failureType: null,
    skipReason: null,
    verdict: {
      risk_level: level,
      action: null,
      categories,
      category_scores: {},
      confidence: result.hasHit ? 1 : 0,
      reason: result.hasHit ? '敏感词预检命中' : '敏感词预检未命中',
      suggestion: '',
    },
    // 原始结构供下限层叠加（contains hits —— 只在核心内部流转，不落盘、不出接口）
    precheckResult: result,
    costHint: 'free',
    message: '',
  };
}

/**
 * 就绪度探测（词库为空视为未就绪）。
 * @returns {{ready: boolean, reason: string}} 就绪度
 */
function readiness() {
  try {
    const config = loadConfig();
    void config;
    return { ready: true, reason: '' };
  } catch {
    return { ready: false, reason: 'worddb-empty' };
  }
}

module.exports = { descriptor, run, readiness, maxLevel };
