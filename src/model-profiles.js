/**
 * 本地模型档案表（src/model-profiles.js）
 * v2.3.0 新增。背景（Req6 一致性修复）：
 * `/api/vram-info` 此前把 Qwen3-14B 的几何参数（8.2GB / 40 层 / 8 KV heads /
 * head_dim 128 / Q4_K_M）**硬编码**在 server.js 里，而实际配置的审核模型已是
 * `gpt-oss-safeguard:20b` —— 于是「显存占用估算 / 文本长度上限」整页数字都是错的
 * （按 14B 报 20B 的账）。本文件把「模型 → 几何参数」收敛为唯一数据源。
 * 设计原则：
 * · 纯数据 + 纯函数，**零依赖**，可被 server / 前端 / 测试直接引用。
 * · 查不到档案时**不瞎猜**：返回 `known:false`，由调用方显式标注「估算值（未收录）」
 * 而不是静默套用别的模型参数（这正是旧代码的病根）。
 * · gpuVramGB 等硬件参数由调用方传入，本文件不假设用户显卡。
 */

/**
 * 每个档案的字段：
 * weightGB 模型权重实测/官方体积（GB，GiB 口径）
 * layers Transformer 层数（用于 KV Cache 估算）
 * kvHeads KV 注意力头数（GQA/MQA 下远小于 attention heads）
 * headDim 单头维度
 * quant 量化方案（展示用）
 * params 参数量标注（展示用）
 * nativeCtx 模型原生上下文窗口（tokens，展示用）
 */
const MODEL_PROFILES = {
  // ─── OpenAI GPT-OSS 系列（MoE，MXFP4 原生量化）───
  'gpt-oss-safeguard:20b': {
    weightGB: 12.8, layers: 24, kvHeads: 8, headDim: 64,
    quant: 'MXFP4', params: '20B (MoE, ~3.6B 激活)', nativeCtx: 131072,
    note: 'OpenAI 安全分类专用模型（safeguard 变体）',
  },
  'gpt-oss:20b': {
    weightGB: 12.8, layers: 24, kvHeads: 8, headDim: 64,
    quant: 'MXFP4', params: '20B (MoE, ~3.6B 激活)', nativeCtx: 131072,
  },
  'gpt-oss:120b': {
    weightGB: 61.0, layers: 36, kvHeads: 8, headDim: 64,
    quant: 'MXFP4', params: '117B (MoE, ~5.1B 激活)', nativeCtx: 131072,
  },

  // ─── Qwen3 稠密系列 ───
  'qwen3:0.6b':  { weightGB: 0.5,  layers: 28, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '0.6B', nativeCtx: 32768 },
  'qwen3:1.7b':  { weightGB: 1.4,  layers: 28, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '1.7B', nativeCtx: 32768 },
  'qwen3:1.8b':  { weightGB: 1.4,  layers: 28, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '1.8B', nativeCtx: 32768 },
  'qwen3:4b':    { weightGB: 2.6,  layers: 36, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '4B', nativeCtx: 32768 },
  'qwen3:8b':    { weightGB: 4.9,  layers: 36, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '8B', nativeCtx: 40960 },
  'qwen3:14b':   { weightGB: 8.6,  layers: 40, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '14B', nativeCtx: 40960 },
  'qwen3:30b':   { weightGB: 18.0, layers: 48, kvHeads: 4, headDim: 128, quant: 'Q4_K_M', params: '30B (MoE, ~3.3B 激活)', nativeCtx: 32768 },
  'qwen3:32b':   { weightGB: 19.5, layers: 64, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '32B', nativeCtx: 40960 },

  // ── Qwen3 视觉系列 ───
  'qwen3-vl:4b-instruct':     { weightGB: 2.9, layers: 36, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '4B',  nativeCtx: 32768 },
  'qwen3-vl:8b-instruct':     { weightGB: 5.7, layers: 36, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '8B',  nativeCtx: 32768 },
  'qwen3-vl:30b-instruct':    { weightGB: 18.5, layers: 48, kvHeads: 4, headDim: 128, quant: 'Q4_K_M', params: '30B (MoE)', nativeCtx: 32768 },
  'qwen3-vl:32b-instruct':    { weightGB: 20.5, layers: 64, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '32B', nativeCtx: 32768 },

  // ─── 通用兜底档案（Llama 系架构，许多 GGUF 微调沿用）───
  'llama3.1:8b':  { weightGB: 4.9, layers: 32, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '8B', nativeCtx: 131072 },
  'llama3.2:3b':  { weightGB: 2.0, layers: 28, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '3B', nativeCtx: 131072 },
  'gemma3:12b':   { weightGB: 8.1, layers: 48, kvHeads: 8, headDim: 256, quant: 'Q4_K_M', params: '12B', nativeCtx: 131072 },
  'mistral:7b':   { weightGB: 4.4, layers: 32, kvHeads: 8, headDim: 128, quant: 'Q4_K_M', params: '7B', nativeCtx: 32768 },
};

/**
 * 按模型名查档案。
 * @param {string} modelId 形如 `qwen3:14b`；容忍大小写与空格
 * @returns {object|null} 命中返回档案对象，未收录返回 null
 */
function getProfile(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const key = modelId.trim().toLowerCase();
  if (MODEL_PROFILES[key]) return MODEL_PROFILES[key];
  // 容错：`qwen3:14b-q4_K_M` → 去掉量化后缀再试一次
  const stripped = key.replace(/[-_](q\d.*|f16|fp16|mx\w+|iq\d.*)$/i, '');
  if (stripped !== key && MODEL_PROFILES[stripped]) return MODEL_PROFILES[stripped];
  return null;
}

/**
 * 估算某模型在给定上下文窗口下的显存占用。
 * KV Cache 公式（每 token）：2(K&V) × kvHeads × headDim × bytesPerElement × layers
 * bytesPerElement 由 cache_type_k 决定：f16=2 / q8_0=1 / q4_0=0.5
 * @param {object} p 档案对象（getProfile 的返回）
 * @param {number} numCtx 上下文窗口 tokens
 * @param {string} [kvQuant] KV 量化类型，默认 'f16'
 * @returns {{modelWeightGB:number, kvCacheGB:number, totalGB:number, bytesPerElement:number}}
 */
function estimateVram(p, numCtx, kvQuant) {
  const quant = String(kvQuant || 'f16').toLowerCase();
  const bytesPerElement = quant.startsWith('q8') ? 1 : (quant.startsWith('q4') ? 0.5 : 2);
  const kvCacheBytes = numCtx * 2 * p.kvHeads * p.headDim * bytesPerElement * p.layers;
  const kvCacheGB = kvCacheBytes / (1024 ** 3);
  return {
    modelWeightGB: p.weightGB,
    kvCacheGB,
    totalGB: p.weightGB + kvCacheGB,
    bytesPerElement,
  };
}

module.exports = {
  MODEL_PROFILES,
  getProfile,
  estimateVram,
};