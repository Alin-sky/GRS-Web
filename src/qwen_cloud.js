/**
 * 阿里云 Qwen / DeepSeek API 客户端（OpenAI 兼容模式）
 * 用于双重审核机制中的云端审核通道
 * 支持的提供商:
 * - Qwen (DashScope): qwen-turbo, qwen-plus, qwen3.7-plus, qwen-max, qwen-vl-*
 * - DeepSeek: deepseek-chat, deepseek-v4-flash-0731
 */

const crypto = require('crypto');
const { loadConfig, getCapabilities, resolveCloudCredentials } = require('./config');
const { logError, logInfo, logWarn } = require('./logger');
// v2.3.0（Req6）：额度来源可用性判定（Token Plan 端点不含视觉模型 → 前置拦截 404）
const { checkBilling } = require('./cloud-model-catalog');

const config = loadConfig();

// 云端通道未配置时只提示一次，避免每请求刷屏
let cloudSkipWarned = false;

/**
 * 判断云端审核通道是否可用（开关 + 真实 API Key）。
 * @returns {boolean} 是否可用
 */
function isCloudAvailable() {
  return getCapabilities().cloud.available;
}

/**
 * 构造「通道已跳过」的结果对象（替代抛异常，调用方据此静默跳过）。
 * @param {string} reason 跳过原因
 * @returns {object} 跳过结果
 */
function skippedResult(reason) {
  if (!cloudSkipWarned) {
    cloudSkipWarned = true;
    logWarn('qwen_cloud', `云端审核未配置，已跳过该通道 (${reason})`);
  }
  return {
    ok: false,
    skipped: true,
    reason,
    content: null,
    model: '',
    elapsedMs: 0,
    usage: null,
    fallback: false,
    cached: false,
  };
}

/**
 * 取当前云端凭据（优先配置，其次环境变量）。
 * @returns {{apiKey: string, endpoint: string, provider: string}} 云端凭据
 */
function currentCredentials() {
  return resolveCloudCredentials(config);
}

// ─── 云端文本审核结果缓存（降本核心） ───
// 相同文本（含预检提示）在 24h 内会重复出现（QQ 复读/口令/广告刷屏、每日对比审核重放），
// 每次都会真打云端 API 计费。这里按 model+prompt+message 做 MD5 去重，
// 命中后直接复用上次判定，省掉一次计费调用。
// 词库/提示词变更会导致 userMessage 变化 → key 变化，天然不会复用过期结果。
const aiTextCache = new Map(); // md5 -> { result, ts }
const AI_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const AI_CACHE_MAX = 20000; // LRU 上限，避免内存无限膨胀

function aiCacheKey(model, systemPrompt, userMessage) {
  return crypto.createHash('md5').update(`${model}::${systemPrompt}::${userMessage}`).digest('hex');
}

function aiCacheGet(key) {
  const entry = aiTextCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > AI_CACHE_TTL_MS) {
    aiTextCache.delete(key);
    return null;
  }
  return entry.result;
}

function aiCacheSet(key, result) {
  if (aiTextCache.size >= AI_CACHE_MAX) {
    const oldestKey = aiTextCache.keys().next().value;
    if (oldestKey !== undefined) aiTextCache.delete(oldestKey);
  }
  aiTextCache.set(key, { result, ts: Date.now() });
}

/**
 * 根据模型名自动选择正确的 API 端点和 API Key
 * @param {string} model - 模型名
 * @returns {{ endpoint: string, apiKey: string }}
 */
function normalizeCloudModel(model) {
  // DeepSeek 文档中的 API 模型 ID 为 deepseek-v4-flash；0731 是当前官方版本号。
  if (model === 'deepseek-v4-flash-0731') return 'deepseek-v4-flash';
  return model;
}

function resolveEndpoint(model) {
  const cloudConfig = config.qwenCloud || {};
  const tokenPlan = config.tokenPlan || {};
  const isDeepSeek = model && model.toLowerCase().includes('deepseek');

  // 额度来源：token-plan 使用 sk-sp- 专属 Key + token-plan 独立 endpoint（Credits 抵扣）；
  // 否则使用普通百炼（DashScope）Key（通用按量 / 节省计划额度）。
  // 注意：普通 sk- Key 配 token-plan endpoint 会按量计费，不走 Credits 抵扣。
  const billingSource = cloudConfig.billingSource || 'dashscope';

  if (billingSource === 'token-plan' && tokenPlan.apiKey) {
    return {
      endpoint: (tokenPlan.endpoint || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
      apiKey: tokenPlan.apiKey,
      provider: 'token-plan',
    };
  }

  const apiKey = process.env.DASHSCOPE_API_KEY || cloudConfig.apiKey || '';
  const endpoint = cloudConfig.endpoint || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    apiKey,
    provider: 'dashscope',
  };
}

/**
 * 调用阿里云 Qwen API 进行文本审核
 * @param {string} systemPrompt - system prompt
 * @param {string} userMessage - 用户消息（已包含预检提示）
 * @param {object} options - 可选参数 { model, timeout }
 * @returns {Promise<{content: string, elapsedMs: number, model: string}>}
 */
/**
 * 单次调用云端 API（不包含回退逻辑）
 */
async function _callCloudAPI(model, systemPrompt, userMessage, timeout, endpoint, apiKey, startTime) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    temperature: 0,
    top_p: 0.8,
    max_tokens: 256,
    // 关闭思考模式（qwen3.x 混合思考模型默认开启，思考过程白烧 completion token）。
    // 审核是确定性判断任务，直接输出 JSON 即可，无需推理链。
    enable_thinking: false
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();

      // 阿里云输入/输出安检拒收（data_inspection_failed）：内容被平台判定违规、拒绝处理。
      // 对审核系统而言这是"云端确认违规"的强信号 → 合成拦截判决直接返回，不再报错、不再无意义地回退。
      if (errText.includes('data_inspection_failed')) {
        const elapsedMs = Date.now() - startTime;
        return {
          ok: true,
          providerRejected: true,
          model,
          elapsedMs,
          usage: null,
          content: JSON.stringify({
            risk_level: 'critical',
            confidence: 1,
            categories: [],
            category_scores: {},
            reason: '云端内容安检拒收(data_inspection_failed)：阿里云判定该内容违规并拒绝处理，已直接拦截',
            suggestion: '云端平台级拦截，建议按最高风险处理',
          }),
        };
      }

      throw new Error(`云端 API 错误 (HTTP ${response.status}): ${errText.substring(0, 300)}`);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(`云端 API 返回空内容`);
    }

    // 去除 think/thinking 标签内容（qwen3 等模型的思考过程）
    content = content.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
    if (!content) content = data.choices[0].message.content.replace(/^<\/?(think|thinking)>/gi, '').trim();

    const elapsedMs = Date.now() - startTime;
    const usage = data.usage ? {
      prompt_tokens: data.usage.prompt_tokens || 0,
      completion_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    } : null;

    return { content, elapsedMs, model, usage, ok: true };
  } catch (err) {
    clearTimeout(timeoutId);
    // failureType 供上层区分「网络/超时」与「语义失败」，决定是否重试 / 如何 fail-closed
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'timeout' : err.message,
      failureType: err.name === 'AbortError' ? 'timeout' : 'network',
      model,
    };
  }
}

/**
 * 调用阿里云 Qwen API 进行文本审核（含自动回退）
 * 回退策略：
 * - 主模型失败（空内容/超时/错误）→ 自动回退到 qwen-plus
 * - 返回实际使用的模型名 + 回退标记
 * @param {string} systemPrompt - system prompt
 * @param {string} userMessage - 用户消息（已包含预检提示）
 * @param {object} options - 可选参数 { model, timeout }
 * @returns {Promise<{content: string, elapsedMs: number, model: string, usage?: object, fallback: boolean}>}
 */
async function moderateTextCloud(systemPrompt, userMessage, options = {}) {
  const startTime = Date.now();

  const cloudConfig = config.qwenCloud || {};

  // 模型/回退模型统一取 qwenCloud 配置；额度来源（token-plan vs 通用按量）由 billingSource 决定
  const primaryModel = options.model || cloudConfig.model || 'qwen-plus';
  const fallbackModel = cloudConfig.fallbackModel || 'qwen-plus';
  const timeout = options.timeout || cloudConfig.timeout || 30000;
  const silent = options.silent || false; // 健康检查等探针调用时静默，避免刷屏

  const { endpoint, apiKey, provider } = resolveEndpoint(primaryModel);

  // 可选能力未配置：静默跳过，不抛异常、不重试
  if (!isCloudAvailable() || !apiKey) {
    return skippedResult(getCapabilities().cloud.reason || `API Key 未配置 (模型: ${primaryModel})`);
  }

  // ─── 结果缓存命中：相同 prompt+message+model 直接复用，省一次计费调用 ───
  const primary = normalizeCloudModel(primaryModel);
  const cacheKey = aiCacheKey(primary, systemPrompt, userMessage);
  const cached = aiCacheGet(cacheKey);
  if (cached) {
    if (!silent) logInfo('qwen_cloud', `云端审核缓存命中 (model=${cached.model}), 省一次调用`);
    return { ...cached, cached: true, elapsedMs: 0 };
  }

  // v2.3.0（Req6）：主模型额度来源前置判定。
  // 若主模型在当前额度来源下已知不可调用（如 token-plan 端点不含 qwen3.7-flash），
  // 直接走回退，省掉那次**必然 404** 的往返 —— 旧实现每次审核都白跑一个失败请求。
  let effectivePrimary = primary;
  let primaryPreBlocked = false;
  const primaryCheck = checkBilling(primary, cloudConfig.billingSource);
  if (!primaryCheck.ok) {
    primaryPreBlocked = true;
    effectivePrimary = normalizeCloudModel(fallbackModel);
    logWarn('qwen_cloud', `主模型 ${primary} 在当前额度来源下不可调用（${primaryCheck.reason}），直接使用 ${effectivePrimary}`);
  }

  // ─── 第一步：尝试主模型 ───
  const hasFallback = primaryModel !== fallbackModel && !primaryPreBlocked;

  if (!silent) logInfo('qwen_cloud', `调用云端 API (model=${effectivePrimary}, fallback=${hasFallback ? fallbackModel : 'none'})`);

  const result = await _callCloudAPI(effectivePrimary, systemPrompt, userMessage, timeout, endpoint, apiKey, startTime);

  if (result.ok) {
    if (result.providerRejected) {
      logInfo('qwen_cloud', `云端安检拒收: 平台判定输入违规, 直接拦截 (model=${result.model}, 耗时${result.elapsedMs}ms)`);
    } else if (!silent) {
      logInfo('qwen_cloud', `云端审核完成: model=${result.model}, 响应${result.content.length}字符, 耗时${result.elapsedMs}ms`);
    }
    // 主模型成功 → 写入缓存（含 content/usage/model 等完整结果，下次同输入直接复用）
    aiCacheSet(cacheKey, { ...result, fallback: false });
    return { ...result, fallback: false };
  }

  // ─── 第二步：主模型失败，尝试回退 ───
  if (!hasFallback) {
    // 主模型就是 qwen-plus，没有再回退的了
    const errMsg = result.error === 'timeout'
      ? `云端 API 请求超时 (${timeout}ms)`
      : result.error;
    logError('qwen_cloud', `调用失败（无回退）: ${errMsg}`, { model: primary });
    throw Object.assign(new Error(errMsg), { failureType: result.failureType || 'network' });
  }

  logInfo('qwen_cloud', `主模型 ${effectivePrimary} 失败(${result.error}), 回退到 ${fallbackModel}`);

  const fallback = normalizeCloudModel(fallbackModel);
  const fallbackResult = await _callCloudAPI(fallback, systemPrompt, userMessage, timeout, endpoint, apiKey, startTime);

  if (fallbackResult.ok) {
    logInfo('qwen_cloud', `回退成功: model=${fallbackResult.model}, 响应${fallbackResult.content.length}字符, 耗时${fallbackResult.elapsedMs}ms`);
    // 回退结果同样缓存：主模型不可用时，相同输入应直接复用回退判定，避免每次都「主模型失败 + 回退」双重调用
    aiCacheSet(cacheKey, { ...fallbackResult, fallback: true });
    return { ...fallbackResult, fallback: true };
  }

  // ─── 第三步：回退也失败，彻底放弃 ───
  const errMsg = fallbackResult.error === 'timeout'
    ? `云端 API 请求超时 (${timeout}ms)`
    : fallbackResult.error;
  logError('qwen_cloud', `回退也失败: ${errMsg}`, { primary, fallback });
  throw Object.assign(
    new Error(`云端审核全部失败 (${primary}→${fallback}): ${errMsg}`),
    { failureType: fallbackResult.failureType || 'network' }
  );
}

// ─── 云端健康检查缓存（避免频繁 API 调用）───
let _cloudHealthCache = { result: null, time: 0 };
const CLOUD_HEALTH_CACHE_TTL = 60000; // 60 秒

/**
 * 检查阿里云 API 是否可用
 * @returns {Promise<{ok: boolean, model?: string, error?: string}>}
 */
async function healthCheckCloud(options = {}) {
  const useCacheOnly = options.useCacheOnly || false;
  if (_cloudHealthCache.result) {
    // 命中缓存：未过期直接返回；useCacheOnly 模式（用于 /health 高频存活探测）下即使过期也直接返回，
    // 避免每 30 秒轮询都真打云端 API 浪费额度。真正刷新缓存的只有手动“检查云端”按钮。
    if ((Date.now() - _cloudHealthCache.time) < CLOUD_HEALTH_CACHE_TTL || useCacheOnly) {
      return _cloudHealthCache.result;
    }
  }

  const cloudConfig = config.qwenCloud || {};
  const model = cloudConfig.model || 'qwen-plus';

  // 可选能力未配置：直接返回 skipped，不真打 API
  if (!isCloudAvailable()) {
    const r = {
      ok: false,
      model,
      skipped: true,
      error: getCapabilities().cloud.reason || '云端 API Key 未配置',
    };
    _cloudHealthCache = { result: r, time: Date.now() };
    return r;
  }

  const { apiKey } = resolveEndpoint(model);

  if (!apiKey) {
    const r = { ok: false, model, skipped: true, error: '当前模型的 API Key 未配置' };
    _cloudHealthCache = { result: r, time: Date.now() };
    return r;
  }
  
  try {
    // R11/T06：中性连通性探针串（不暗示审核角色、不与任何提示词正文语义耦合）
    const result = await moderateTextCloud(
      '你是一个通用助手。',
      '测试消息，请回复"OK"',
      { model, timeout: 10000 }
    );
    const r = { ok: true, model: result.model, latency: result.elapsedMs };
    _cloudHealthCache = { result: r, time: Date.now() };
    logInfo('qwen_cloud', '云端健康检查通过');
    return r;
  } catch (err) {
    const r = { ok: false, model, error: err.message };
    _cloudHealthCache = { result: r, time: Date.now() };
    return r;
  }
}

/**
 * 调用云端 API 进行图片审核（当前仅支持具备视觉能力的 Qwen / DashScope 模型）
 * @param {string} systemPrompt - system prompt
 * @param {string} userMessage - 用户消息
 * @param {string} imageBase64 - base64 图片数据（不含 data:image/...;base64, 前缀）
 * @param {object} options - 可选参数 { model, timeout }
 * @returns {Promise<{content: string, elapsedMs: number, model: string}>}
 */
async function moderateImageCloud(systemPrompt, userMessage, imageBase64, options = {}) {
  const startTime = Date.now();
  
  const cloudConfig = config.qwenCloud || {};
  // v2.3.0（Req6）：兜底值须在两种额度来源下都可调用。
  // 旧兜底 'qwen3-vl-flash' 只在 dashscope 存在，token-plan 下会 404；
  // 改为原生多模态的 qwen3.8-flash（实测两个端点均有且能审图）。
  const visionModel = cloudConfig.visionModel || 'qwen3.8-flash';
  const model = normalizeCloudModel(options.model || visionModel);
  const timeout = options.timeout || cloudConfig.timeout || 30000;
  
  const { endpoint, apiKey, provider } = resolveEndpoint(model);

  // 可选能力未配置：静默跳过，不抛异常、不重试
  if (!isCloudAvailable() || !apiKey) {
    return skippedResult(getCapabilities().cloud.reason || `API Key 未配置 (模型: ${model})`);
  }

  // v2.3.0（Req6）：额度来源前置校验 —— 在发请求前拦住必然 404 的组合。
  // 病根：billingSource='token-plan' 时端点是 token-plan.cn-beijing.maas.aliyuncs.com，
  // 该端点实测不含名字带 `vl` 的传统视觉模型（qwen3-vl-*），配置里却写着它。
  // 结果：每次图片审核必然 HTTP 404 model_not_found → fail-closed 全量拦截，
  // 而日志只显示「资源不存在」，运维极易误判为网络问题。
  // 现在改为：不发无意义的请求，直接抛出指明「改选原生多模态模型 / 改额度来源」的可执行错误。
  const billingCheck = checkBilling(model, cloudConfig.billingSource);
  if (!billingCheck.ok) {
    throw new Error(`${billingCheck.reason}。${billingCheck.suggestion}`);
  }

  const isDeepSeek = model.toLowerCase().includes('deepseek');
  if (isDeepSeek) {
    throw new Error('DeepSeek V4 Flash 当前仅作为文本审核模型；请为图片审核选择具备视觉能力的 Qwen 模型');
  }

  // v0.2.0（A+B · 图像审核策略）：发送前缩图 + 判定缓存。
  // 单点实现：新引擎（builtin.cloudModel 视觉分支）与旧引擎（moderator.legacyModerateImage）
  // **都经由本函数**，因此两条路径自动一致，不存在两份漂移的实现。
  // 只缩「发给模型」的内存字节；data/image_blobs/ 的原图落盘走 image-ref.capture，
  // 不经过这里 ⇒ 取证/可复现能力不受影响。
  // sharp 未安装（本机现状）⇒ resizeForModel 降级为发送原图并标注 reason，绝不因此失败。
  const imagePolicy = require('./image-policy');
  const auditDb = require('./audit-db');
  const policy = imagePolicy.getImagePolicyCfg(config);
  const rawBuf = Buffer.from(imagePolicy.stripDataUrlPrefix(imageBase64), 'base64');
  const imgHash = imagePolicy.imageHash(rawBuf);
  const resized = await imagePolicy.resizeForModel(rawBuf, policy.maxImagePx);
  const sendBase64 = resized.buffer.toString('base64');
  if (resized.applied) {
    logInfo('qwen_cloud', `发送前缩图: ${resized.fromPx}px(${(resized.fromBytes / 1024).toFixed(0)}KB)`
      + ` → ${resized.toPx}px(${(resized.toBytes / 1024).toFixed(0)}KB)，长边上限 ${policy.maxImagePx}px`);
  }

  // 给返回值统一附加策略元数据（供审计记录 / 前端展示 / 回归断言）
  const withPolicyMeta = (extra) => Object.assign({}, extra, {
    imageHash: imgHash,
    exposureMode: policy.exposureMode,
    cached: false,
    resized: {
      applied: resized.applied,
      reason: resized.reason,
      fromPx: resized.fromPx,
      toPx: resized.toPx,
      fromBytes: resized.fromBytes,
      toBytes: resized.toBytes,
    },
  });
  const cachePut = (contentStr) => (policy.cacheVerdicts && contentStr
    ? auditDb.verdictCacheSet(imgHash, model, imagePolicy.cacheExposureKey(policy), contentStr)
    : false);

  // ─── B：判定缓存命中 ⇒ 直接复用上次判定，**跳过这次云端计费调用**（省钱的全部意义）───
  if (policy.cacheVerdicts) {
    const hit = auditDb.verdictCacheGet(imgHash, model, imagePolicy.cacheExposureKey(policy));
    if (hit && hit.verdictJson) {
      logInfo('qwen_cloud', `图像判定缓存命中 (hash=${imgHash}, model=${model}, mode=${policy.exposureMode})，已跳过一次云端调用`);
      return {
        content: hit.verdictJson,
        elapsedMs: 0,
        model,
        usage: null,
        cached: true,
        cachedAt: hit.createdAt || '',
        imageHash: imgHash,
        exposureMode: policy.exposureMode,
        resized: { applied: false, reason: 'cache-hit', fromPx: resized.fromPx, toPx: resized.toPx, fromBytes: rawBuf.length, toBytes: 0 },
      };
    }
  }

  // 构造多模态消息（OpenAI 兼容格式）
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${sendBase64}`
            }
          },
          { type: 'text', text: userMessage }
        ]
      }
    ],
    temperature: 0,
    top_p: 0.8,
    max_tokens: 384,
    // 图片审核同样关闭思考，直接输出 JSON（含 image_description 需稍留余量）
    enable_thinking: false
  };
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    logInfo('qwen_cloud', `调用云端视觉 API (model=${model})`);

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();

      // 阿里云图片安检拒收：同文本通道，视为"云端确认违规"并合成拦截判决
      if (errText.includes('data_inspection_failed')) {
        const rejectedContent = JSON.stringify({
          risk_level: 'critical',
          confidence: 1,
          categories: [],
          category_scores: {},
          reason: '云端图片安检拒收(data_inspection_failed)：阿里云判定该图片违规并拒绝处理，已直接拦截',
          suggestion: '云端平台级拦截，建议按最高风险处理',
        });
        // 平台判定与「图片内容 + 档位」绑定且可复现 ⇒ 同样入缓存，下次同图不再花这次往返
        cachePut(rejectedContent);
        return withPolicyMeta({
          content: rejectedContent,
          elapsedMs: Date.now() - startTime,
          model,
          usage: null,
        });
      }

      throw new Error(`阿里云视觉 API 错误 (HTTP ${response.status}): ${errText}`);
    }
    
    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error('阿里云视觉 API 返回空内容');
    }

    // 去除 think/thinking 标签内容
    content = content.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
    if (!content) content = data.choices[0].message.content.replace(/^<\/?(think|thinking)>/gi, '').trim();
    
    const elapsedMs = Date.now() - startTime;
    const usage = data.usage ? {
      prompt_tokens: data.usage.prompt_tokens || 0,
      completion_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    } : null;
    
    logInfo('qwen_cloud', `阿里云图片审核完成: 响应${content.length}字符, 耗时${elapsedMs}ms, tokens=${usage?.total_tokens || 'N/A'}`
      + `${resized.applied ? `, 缩图 ${resized.fromPx}px→${resized.toPx}px` : ''}`);

    // ─── B：真实调用成功 ⇒ 写判定缓存（下次同图+同模型+同档位直接复用，跳过计费调用）───
    cachePut(content);

    return withPolicyMeta({
      content,
      elapsedMs,
      model,
      usage
    });
    
  } catch (err) {
    clearTimeout(timeoutId);
    
    if (err.name === 'AbortError') {
      logError('qwen_cloud', `图片审核请求超时 (${timeout}ms)`, { model });
      throw Object.assign(new Error(`阿里云图片审核请求超时 (${timeout}ms)`), { failureType: 'timeout' });
    }
    
    logError('qwen_cloud', `图片审核调用失败: ${err.message}`, { model });
    throw Object.assign(err, { failureType: err.failureType || 'network' });
  }
}

module.exports = {
  moderateTextCloud,
  moderateImageCloud,
  healthCheckCloud,
  isCloudAvailable,
  currentCredentials,
};
