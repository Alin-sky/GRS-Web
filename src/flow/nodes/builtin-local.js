/**
 * 内置节点：本地 Ollama 模型（src/flow/nodes/builtin-local.js）
 * 支持文本与视觉两种模态（`params.vision=true` 走视觉模型 + 图片 prompt）。
 * 失败语义严格对齐 v2.1.0：
 * - 未配置（err.skipped）→ skipped（合法降级）
 * - 已配置但调用/解析/校验失败 → failed（触发 fail-closed）
 */

'use strict';

const { chat } = require('../../ollama');
const { loadConfig, getCapabilities } = require('../../config');
const { RISK_ORDER } = require('../risk');
const {
  FAILURE_TYPE, extractJSON, sanitizeRawSnippet, matchesResultSchema,
  normalizeVerdict, buildTextPrompt, buildImagePrompt, crossCheckConfig,
} = require('./shared');

/** 合法的内容风险等级（模型可输出，不含 review）。*/
const CONTENT_RISK_LEVELS = Object.keys(RISK_ORDER).filter((k) => k !== 'review');

/** 节点描述符（文本形态；视觉为 params.vision=true）。*/
const descriptor = {
  ref: 'builtin.localModel',
  title: '本地模型（Ollama）',
  desc: '本地 Ollama 模型审核，零 API 费用；文本与视觉共用同一节点',
  icon: '🖥️',
  modality: ['text', 'image'],
  output: 'ModerationVerdict',
  role: 'service',
  defaultCombine: 'branch',
  combineEditable: true,
  canParallel: true,
  multiInstance: true,
  params: [
    { key: 'model', type: 'text', label: '模型', default: '', desc: '留空使用全局默认模型' },
    { key: 'useSafeguardPrompt', type: 'switch', label: '使用 Safeguard 提示词', default: false, desc: '需模型名包含 safeguard' },
    { key: 'vision', type: 'switch', label: '视觉模态', default: false, desc: '图像流程下应开启' },
  ],
  defaultTimeoutMs: 60000,
  failurePolicyOptions: ['inherit', 'block', 'review'],
  costHint: 'local-compute',
};

/**
 * 就绪度：本地通道是否可用。
 * @returns {{ready: boolean, reason: string}} 就绪度
 */
function readiness() {
  try {
    const caps = getCapabilities();
    return { ready: caps.local.available === true, reason: caps.local.available ? '' : 'not-configured' };
  } catch {
    return { ready: false, reason: 'not-configured' };
  }
}

/**
 * 构造失败结果。
 * @param {object} runtime 运行时
 * @param {string} failureType 失败类型
 * @param {number} elapsedMs 耗时
 * @param {boolean} skipped 是否属于「未配置」跳过
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
    costHint: 'local-compute',
    message: message || '',
  };
}

/**
 * 执行本地模型节点。
 * @param {object} runtime 运行时 { ctx, params, nodeId, modality }
 * @returns {Promise<object>} NodeResult
 */
async function run(runtime) {
  const config = loadConfig();
  const params = runtime.params || {};
  const isVision = params.vision === true || runtime.modality === 'image';
  const started = Date.now();

  let model;
  let systemPrompt;
  let userContent;
  let nonce = '';
  let neutralized = false;

  if (isVision) {
    model = config.ollama.visionModel;
    const prompt = buildImagePrompt({ text: (runtime.ctx.payload && runtime.ctx.payload.caption) || '' });
    systemPrompt = prompt.systemPrompt;
    userContent = prompt.userContent;
    nonce = prompt.nonce;
    neutralized = prompt.neutralized;
  } else {
    model = params.model || config.ollama.textModel;
    const precheckHint = runtime.precheckHint || '';
    const prompt = buildTextPrompt({ text: (runtime.ctx.payload && runtime.ctx.payload.text) || '', precheckHint, model });
    systemPrompt = prompt.systemPrompt;
    userContent = prompt.userMessage;
    nonce = prompt.nonce;
    neutralized = prompt.neutralized;
  }

  let rawResponse;
  let elapsedMs = 0;
  try {
    const images = isVision ? [(runtime.ctx.payload && runtime.ctx.payload.imageBase64) || ''] : [];
    const host = isVision ? (config.ollama.visionHost || config.ollama.host) : null;
    const chatResult = await chat(model, systemPrompt, userContent, images, host, isVision ? undefined : { think: String(model).includes('safeguard') });
    rawResponse = chatResult.content;
    elapsedMs = chatResult.elapsedMs || 0;
  } catch (err) {
    const skipped = Boolean(err && err.skipped);
    const failureType = err && err.failureType
      ? err.failureType
      : (err && err.name === 'AbortError' ? FAILURE_TYPE.TIMEOUT : FAILURE_TYPE.NETWORK);
    return failureResult(runtime, failureType, Date.now() - started, skipped, skipped ? '本地模型未配置' : `本地模型调用失败: ${err && err.message}`);
  }

  if (!rawResponse || !String(rawResponse).trim()) {
    return failureResult(runtime, FAILURE_TYPE.EMPTY, elapsedMs, false, '模型返回空内容');
  }

  const parsed = extractJSON(rawResponse);
  if (!parsed) return failureResult(runtime, FAILURE_TYPE.PARSE, elapsedMs, false, '模型输出无法解析为 JSON');
  if (!matchesResultSchema(parsed, CONTENT_RISK_LEVELS)) {
    return failureResult(runtime, FAILURE_TYPE.SCHEMA, elapsedMs, false, '模型输出缺少可识别 risk_level');
  }

  const verdict = normalizeVerdict(parsed, { nonce, source: 'model' });
  if (!verdict.ok) {
    void sanitizeRawSnippet(rawResponse);
    void crossCheckConfig();
    return failureResult(runtime, verdict.code, elapsedMs, false, `模型输出未通过校验: ${verdict.detail}`);
  }

  return {
    nodeId: runtime.nodeId,
    ref: descriptor.ref,
    title: descriptor.title,
    status: 'ok',
    elapsedMs,
    failureType: null,
    skipReason: null,
    verdict: verdict.value,
    costHint: 'local-compute',
    message: '',
    needsHumanReview: neutralized, // 输入出现定界符逃逸（仅记录，不影响判定）
  };
}

module.exports = { descriptor, run, readiness, CONTENT_RISK_LEVELS };
