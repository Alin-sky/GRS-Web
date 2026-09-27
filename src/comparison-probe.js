/**
 * 单通道审核探针（src/comparison-probe.js）
 * v2.3.0（Req5）新增：把「用某一个通道、对单条内容出一次判定」这类最小原子能力
 * 收敛为一处，供**两个消费者**共用：
 * ① 核心内置对比引擎 src/comparator.js（插件不可用时的回退路径）
 * ② 对比审核插件 plugins/comparison-suite（经 ctx.inject('moderator').probe 拿到）
 * 设计要点：
 * 1. 提示词构造、PromptFence 隔离、密钥使用**全部留在核心**：插件只拿到「判定结果」，
 * 拿不到 prompt 文件内容，也拿不到任何 API Key —— 这是 A5 脱耦的安全前提。
 * 2. 文本/图像两种模态对等暴露：textLocal / textCloud / textSafety / imageLocal / imageCloud / imageSafety。
 * 3. 失败一律 throw，由调用方决定如何记 null 与计数，不在此处静默降级（避免把「没测」伪装成「测过了」）。
 * v0.1.0：内容安全不再由核心垫片 `content_safety` 直连，改经**审核器注册表**
 * （src/flow/adjudicators）分发 —— 与画布节点面板同源，插件未装载时该通道自动缺席。
 * 依赖方向：本模块属核心层，只可依赖核心内部模块（config / ollama / qwen_cloud /
 * flow/adjudicators / flow/nodes/shared），**不得反向依赖插件层**。
 */
const { loadConfig } = require('./config');
const { chat } = require('./ollama');
const { moderateTextCloud, moderateImageCloud } = require('./qwen_cloud');
const adjudicators = require('./flow/adjudicators');
const { precheck, buildPrecheckHint } = require('./precheck');
const { buildTextPrompt, buildImagePrompt, extractJSON } = require('./flow/nodes/shared');
// v2.3.0（Req6）：modelLabel 收敛到 comparison-core 唯一实现。
// 本文件原有一份逐字符相同的副本，两处独立演化
// 会让同一批通道在内置路径与插件路径下算出不同字段名。
const { modelLabel } = require('./comparison-core');

const config = loadConfig();

/**
 * 使用指定本地模型审核单条文本。
 * @param {string} model 模型名
 * @param {string} text 待审核文本
 * @param {string} [keepAlive] keep_alive 策略
 * @returns {Promise<object>} 判定 { risk_level, categories, confidence, reason }
 */
async function textLocal(model, text, keepAlive = '5m') {
  const precheckResult = precheck(text);
  const precheckHint = buildPrecheckHint(precheckResult);
  const prompt = buildTextPrompt({ text, precheckHint, model });

  const host = config.ollama.host;
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: String(model).includes('safeguard'),
      messages: [
        { role: 'system', content: prompt.systemPrompt },
        { role: 'user', content: prompt.userMessage },
      ],
      options: config.ollama.options,
      keep_alive: keepAlive,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const content = data && data.message && data.message.content;
  if (!content) throw new Error('Ollama 返回了空内容');

  const parsed = extractJSON(content);
  if (!parsed) throw new Error('本地模型返回内容无法解析为 JSON');
  return parsed;
}

/**
 * 使用云端大模型审核单条文本。
 * @param {string} text 待审核文本
 * @returns {Promise<object>} 判定
 */
async function textCloud(text) {
  const precheckResult = precheck(text);
  const precheckHint = buildPrecheckHint(precheckResult);
  const prompt = buildTextPrompt({ text, precheckHint });

  const cloudResult = await moderateTextCloud(prompt.systemPrompt, prompt.userMessage);
  if (cloudResult.skipped) {
    throw new Error(`云端审核通道未配置，已跳过 (${cloudResult.reason})`);
  }
  const parsed = extractJSON(cloudResult.content);
  if (!parsed) {
    throw new Error(`云端模型返回内容无法解析为 JSON: ${String(cloudResult.content).slice(0, 100)}`);
  }
  return parsed;
}

/** 已下线的内容安全 ref（迁移表里的历史名，仅用于把旧通道解析到它的继任者）。*/
const LEGACY_CONTENT_SAFETY_REF = 'builtin.contentSafety';

/**
 * 解析「遗留内容安全通道」当前应该对应哪个审核器 ref。
 * 为什么要走迁移表而不是直接写插件 ref：核心不得硬编码插件 ref；而这张表
 * （src/flow/adjudicators#RETIRED_REFS）恰好就是为「历史上存在过这个 ref」准备的。
 * @param {'text'|'image'} modality 模态
 * @returns {object|null} 审核器条目；未装载时返回 null
 */
function contentSafetyEntry(modality) {
  const ref = adjudicators.successorOf(LEGACY_CONTENT_SAFETY_REF, modality);
  if (!ref) return null;
  return adjudicators.get(ref);
}

/**
 * 经注册表调用某个插件审核器，出一次判定。
 * @param {object} entry 审核器条目（AdjudicatorEntry）
 * @param {object} sample 待测样本 { payload, imageBase64, caption }
 * @param {'text'|'image'} modality 模态
 * @returns {Promise<object>} 判定（已归一化为与本地/云端同构）
 */
async function pluginVerdict(entry, sample, modality) {
  const payload = modality === 'image'
    ? { imageBase64: sample.imageBase64 || '', caption: sample.caption || '' }
    : { text: sample.payload };
  const csResult = await adjudicators.invoke(entry.ref, payload, modality);
  if (!csResult || !csResult.available) {
    throw new Error(`${entry.title || entry.ref} 不可用: ${(csResult && csResult.reason) || 'unknown'}`);
  }
  return {
    risk_level: csResult.risk_level || 'safe',
    categories: csResult.categories || [],
    confidence: csResult.confidence || 0.5,
    reason: csResult.suggestion || '内容安全审核结果',
    content_safety_raw: {
      suggestion: csResult.suggestion,
      matched_labels: csResult.matched_labels || [],
      services: csResult.services || [],
    },
  };
}

/**
 * 按审核器条目分发到对应运行器，出一次判定。
 * T04-A：`options.imageModelOverride` 由对比引擎传入（云端视觉模型的模型名覆盖），
 * 使「跨模型对比」能力不因注册表化而丢失；分发逻辑仍完整收敛在本文件内。
 * @param {object} entry 审核器条目（AdjudicatorEntry）
 * @param {object} sample 待测样本 { payload, imageBase64, caption }
 * @param {'text'|'image'} modality 模态
 * @param {{imageModelOverride?: string}} [options] 可选分发参数
 * @returns {Promise<object>} 判定
 */
async function adjudicatorVerdict(entry, sample, modality, options = {}) {
  if (!entry || typeof entry !== 'object') throw new Error('审核器条目缺失，无法出判定');
  const m = modality === 'image' ? 'image' : 'text';
  const modelOverride = (options && options.imageModelOverride) || '';
  if (entry.runner === 'pluginVerdict') return pluginVerdict(entry, sample, m);
  if (entry.runner === 'localModel') {
    if (m === 'image') return imageLocal(sample.imageBase64, sample.caption, modelOverride);
    return textLocal(config.ollama.textModel, sample.payload);
  }
  if (entry.runner === 'cloudModel') {
    if (m === 'image') return imageCloud(sample.imageBase64, sample.caption, modelOverride);
    return textCloud(sample.payload);
  }
  throw new Error(`审核器 ${entry.ref} 没有可用运行器（runner=${entry.runner || 'null'}）`);
}

/**
 * 使用阿里云内容安全审核单条文本。
 * @param {string} text 待审核文本
 * @returns {Promise<object>} 判定（已归一化为与本地/云端同构）
 */
async function textSafety(text) {
  const entry = contentSafetyEntry('text');
  if (!entry) throw new Error('内容安全通道不可用: 阿里云内容安全插件未装载');
  return adjudicatorVerdict(entry, { payload: text }, 'text');
}

/**
 * 使用本地视觉模型审核单张图片（可选附带文字）。
 * @param {string} imageBase64 base64 图片（不含 data: 前缀）
 * @param {string} [caption] 附带文字
 * @param {string} [modelOverride] 指定视觉模型（对比场景需跨模型，缺省用全局配置）
 * @returns {Promise<object>} 判定
 */
async function imageLocal(imageBase64, caption = '', modelOverride = '') {
  const model = modelOverride || config.ollama.visionModel;
  if (!model) throw new Error('本地视觉模型未配置（ollama.visionModel 为空）');
  const prompt = buildImagePrompt({ text: caption });
  const host = config.ollama.visionHost || config.ollama.host;
  const chatResult = await chat(model, prompt.systemPrompt, prompt.userContent, [imageBase64], host);
  const parsed = extractJSON(chatResult.content);
  if (!parsed) throw new Error('本地视觉模型返回内容无法解析为 JSON');
  return parsed;
}

/**
 * 使用云端视觉模型审核单张图片（可选附带文字）。
 * @param {string} imageBase64 base64 图片
 * @param {string} [caption] 附带文字
 * @param {string} [modelOverride] 指定云端视觉模型（缺省用全局配置）
 * @returns {Promise<object>} 判定
 */
async function imageCloud(imageBase64, caption = '', modelOverride = '') {
  const prompt = buildImagePrompt({ text: caption });
  const cloudResult = await moderateImageCloud(
    prompt.systemPrompt,
    prompt.userContent,
    imageBase64,
    modelOverride ? { model: modelOverride } : {},
  );
  if (cloudResult.skipped) {
    throw new Error(`云端视觉通道未配置，已跳过 (${cloudResult.reason})`);
  }
  const parsed = extractJSON(cloudResult.content);
  if (!parsed) {
    throw new Error(`云端视觉模型返回内容无法解析为 JSON: ${String(cloudResult.content).slice(0, 100)}`);
  }
  return parsed;
}

/**
 * 使用阿里云内容安全审核单张图片（可选附带文字）。
 * @param {string} imageBase64 base64 图片
 * @param {string} [caption] 附带文字
 * @returns {Promise<object>} 判定
 */
async function imageSafety(imageBase64, caption = '') {
  const entry = contentSafetyEntry('image');
  if (!entry) throw new Error('图片内容安全通道不可用: 阿里云内容安全插件未装载');
  return adjudicatorVerdict(entry, { imageBase64, caption }, 'image');
}

/**
 * 探测各通道当前是否「可按配置启用」（仅看配置开关与凭据是否就位，不发起真实调用）。
 * `content_safety` 保持按**配置**判定（与历史口径一致，供内置对比引擎做通道筛选）；
 * 新增的 `adjudicators` 是**注册表视角**的实际可用性（含插件是否真的装载），
 * 供注册表化的对比选择快地判断谁能勾选。两者语义不同，不可互相替换。
 * @returns {{cloud: boolean, content_safety: boolean, cloudVision: boolean, localVision: boolean, adjudicators: object}} 可用性
 */
function channelAvailability() {
  const map = {};
  try {
    for (const entry of adjudicators.list('text')) map[entry.ref] = entry.ready === true;
    for (const entry of adjudicators.list('image')) map[entry.ref] = entry.ready === true;
  } catch {
    // 注册表不可用时退化为「全部未知」，不影响其它通道的既有判定
  }
  return {
    cloud: Boolean(config.qwenCloud && config.qwenCloud.enabled && config.qwenCloud.apiKey),
    content_safety: Boolean(config.contentSafety && config.contentSafety.enabled && config.contentSafety.accessKeyId),
    cloudVision: Boolean(
      config.qwenCloud && config.qwenCloud.enabled && config.qwenCloud.apiKey && config.qwenCloud.visionEnabled
    ),
    localVision: Boolean(config.ollama && config.ollama.visionModel),
    adjudicators: map,
  };
}

module.exports = {
  textLocal,
  textCloud,
  textSafety,
  imageLocal,
  imageCloud,
  imageSafety,
  pluginVerdict,
  adjudicatorVerdict,
  modelLabel,
  channelAvailability,
};