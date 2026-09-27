/**
 * 内置节点：云端大模型（OpenAI 兼容 REST，src/flow/nodes/builtin-cloud.js）
 * 文本走 `moderateTextCloud`，图像走 `moderateImageCloud`（`params.vision=true`）。
 * 失败语义对齐 v2.1.0：未配置（skipped）→ skipped；已配置但失败 → failed。
 */

'use strict';

const { moderateTextCloud, moderateImageCloud } = require('../../qwen_cloud');
const { loadConfig, getCapabilities } = require('../../config');
const { RISK_ORDER } = require('../risk');
const {
  FAILURE_TYPE, extractJSON, matchesResultSchema, normalizeVerdict,
  buildTextPrompt, buildImagePrompt,
} = require('./shared');

/** 合法的内容风险等级（模型可输出，不含 review）。*/
const CONTENT_RISK_LEVELS = Object.keys(RISK_ORDER).filter((k) => k !== 'review');

/** 节点描述符。*/
const descriptor = {
  ref: 'builtin.cloudModel',
  title: '云端大模型',
  desc: 'OpenAI 兼容 REST（Qwen / DeepSeek 等），需要 API Key；文本与图像共用同一节点',
  icon: '☁️',
  modality: ['text', 'image'],
  output: 'ModerationVerdict',
  role: 'service',
  defaultCombine: 'branch',
  combineEditable: true,
  canParallel: true,
  multiInstance: true,
  params: [
    { key: 'vision', type: 'switch', label: '视觉模态', default: false, desc: '图像流程下应开启（需 qwenCloud.visionEnabled）' },
  ],
  defaultTimeoutMs: 30000,
  failurePolicyOptions: ['inherit', 'block', 'review'],
  costHint: 'paid-api',
};

/**
 * 就绪度：云端通道是否可用（未配 Key 视为未就绪）。
 * @returns {{ready: boolean, reason: string}} 就绪度
 */
function readiness() {
  try {
    const caps = getCapabilities();
    return { ready: caps.cloud.available === true, reason: caps.cloud.available ? '' : 'not-configured' };
  } catch {
    return { ready: false, reason: 'not-configured' };
  }
}

/**
 * 构造失败结果。
 * @param {object} runtime 运行时
 * @param {string} failureType 失败类型
 * @param {number} elapsedMs 耗时
 * @param {boolean} skipped 是否跳过
 * @param {string} message 说明
 * @returns {object} NodeResult
 */
function failureResult(runtime, failureType, elapsedMs, skipped, message) {
  return {
    nodeId: runtime.nodeId,
    ref: descriptor.ref,
    title: descriptor.title,
    status: skipped ? 'skipped' : 'failed',
    elapsedMs,
    failureType: skipped ? null : failureType,
    skipReason: skipped ? 'not-configured' : null,
    verdict: null,
    costHint: 'paid-api',
    message: message || '',
  };
}

/**
 * 执行云端模型节点。
 * @param {object} runtime 运行时 { ctx, params, nodeId, modality, precheckHint }
 * @returns {Promise<object>} NodeResult
 */
async function run(runtime) {
  const config = loadConfig();
  const params = runtime.params || {};
  const isVision = params.vision === true || runtime.modality === 'image';

  if (isVision) {
    const prompt = buildImagePrompt({ text: (runtime.ctx.payload && runtime.ctx.payload.caption) || '' });
    let res;
    try {
      res = await moderateImageCloud(prompt.systemPrompt, prompt.userContent, (runtime.ctx.payload && runtime.ctx.payload.imageBase64) || '');
    } catch (err) {
      return failureResult(runtime, err && err.failureType ? err.failureType : FAILURE_TYPE.NETWORK, 0, false, `云端图像审核失败: ${err && err.message}`);
    }
    if (res && res.skipped) return failureResult(runtime, FAILURE_TYPE.UNKNOWN, 0, true, '云端视觉通道未配置');
    const elapsed = res.elapsedMs || 0;
    const raw = res && res.content;
    if (!raw || !String(raw).trim()) return failureResult(runtime, FAILURE_TYPE.EMPTY, elapsed, false, '云端返回空内容');
    const parsed = extractJSON(raw);
    if (!parsed) return failureResult(runtime, FAILURE_TYPE.PARSE, elapsed, false, '云端输出无法解析为 JSON');
    if (!matchesResultSchema(parsed, CONTENT_RISK_LEVELS)) return failureResult(runtime, FAILURE_TYPE.SCHEMA, elapsed, false, '云端输出缺少可识别 risk_level');
    const verdict = normalizeVerdict(parsed, { nonce: prompt.nonce, source: 'model' });
    if (!verdict.ok) return failureResult(runtime, verdict.code, elapsed, false, `云端输出未通过校验: ${verdict.detail}`);
    // v0.2.0（A+B·图像审核策略）：把「缓存命中 / 缩图」写进 message ⇒ 随 node_traces
    // 进入审计记录，用户在历史里能直接区分「真调用计费」还是「缓存复用（0 计费）」。
    const policyNotes = [];
    if (res.cached) policyNotes.push('判定缓存命中，未调用云端（本次 0 计费）');
    if (res.resized && res.resized.applied) {
      policyNotes.push(`发送前缩图 ${res.resized.fromPx}px→${res.resized.toPx}px`);
    } else if (res.resized && res.resized.reason && res.resized.reason !== 'ok' && res.resized.reason !== 'cache-hit') {
      policyNotes.push(`未缩图(${res.resized.reason})`);
    }
    return {
      nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title, status: 'ok',
      elapsedMs: elapsed, failureType: null, skipReason: null, verdict: verdict.value,
      costHint: 'paid-api', message: policyNotes.join('；'),
      cloud: {
        model: res.model,
        usage: res.usage || null,
        fallback: res.fallback || false,
        cached: res.cached || false,
        // v0.2.0（A+B·图像审核策略）：把缩图/缓存元数据带进 trace 与审计记录
        imageHash: res.imageHash || null,
        exposureMode: res.exposureMode || null,
        resized: res.resized || null,
      },
    };
  }

  const model = (config.qwenCloud && config.qwenCloud.model) || 'qwen-plus';
  const prompt = buildTextPrompt({ text: (runtime.ctx.payload && runtime.ctx.payload.text) || '', precheckHint: runtime.precheckHint || '', model });
  let res;
  try {
    res = await moderateTextCloud(prompt.systemPrompt, prompt.userMessage);
  } catch (err) {
    return failureResult(runtime, err && err.failureType ? err.failureType : FAILURE_TYPE.NETWORK, 0, false, `云端审核失败: ${err && err.message}`);
  }
  if (res && res.skipped) return failureResult(runtime, FAILURE_TYPE.UNKNOWN, 0, true, '云端通道未配置');
  const elapsed = res.elapsedMs || 0;
  const raw = res && res.content;
  if (!raw || !String(raw).trim()) return failureResult(runtime, FAILURE_TYPE.EMPTY, elapsed, false, '云端返回空内容');
  const parsed = extractJSON(raw);
  if (!parsed) return failureResult(runtime, FAILURE_TYPE.PARSE, elapsed, false, '云端输出无法解析为 JSON');
  if (!matchesResultSchema(parsed, CONTENT_RISK_LEVELS)) return failureResult(runtime, FAILURE_TYPE.SCHEMA, elapsed, false, '云端输出缺少可识别 risk_level');
  const verdict = normalizeVerdict(parsed, { nonce: prompt.nonce, source: 'cloud' });
  if (!verdict.ok) return failureResult(runtime, verdict.code, elapsed, false, `云端输出未通过校验: ${verdict.detail}`);
  return {
    nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title, status: 'ok',
    elapsedMs: elapsed, failureType: null, skipReason: null, verdict: verdict.value,
    costHint: 'paid-api', message: '',
    cloud: { model: res.model, usage: res.usage || null, fallback: res.fallback || false, cached: res.cached || false },
  };
}

module.exports = { descriptor, run, readiness, CONTENT_RISK_LEVELS };
