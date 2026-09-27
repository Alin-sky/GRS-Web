const { loadConfig, getCapabilities } = require('./config');
const { logError, logInfo, logWarn } = require('./logger');

const config = loadConfig();

// 本地通道不可用时只提示一次，避免每条审核请求都重复刷屏
let localSkipWarned = false;

/**
 * 判断本地 Ollama 通道是否可用（配置层面）。
 * 未配置 / 已关闭时返回 false，调用方应直接跳过，而不是发请求再重试。
 * @returns {boolean} 是否可用
 */
function isLocalAvailable() {
  return getCapabilities().local.available;
}

/**
 * 打印一次「本地通道跳过」提示。
 * @param {string} reason 跳过原因
 */
function warnLocalSkippedOnce(reason) {
  if (localSkipWarned) return;
  localSkipWarned = true;
  logWarn('ollama', `本地模型通道未配置，已跳过该通道 (${reason})`);
}

/**
 * 判断错误是否为「服务不可达」（Ollama 未启动 / 端口不通 / DNS 失败）。
 * 这类错误重试没有意义，应立即放弃。
 * @param {Error} err 捕获到的错误
 * @returns {boolean} 是否不可达
 */
function isServiceUnreachable(err) {
  const code = String(err?.cause?.code || err?.code || '').toUpperCase();
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code)) return true;
  return /fetch failed|ECONNREFUSED|connect ECONNREFUSED/i.test(String(err?.message || ''));
}

/**
 * 从错误中提取简短可读的原因。
 * @param {Error} err 错误对象
 * @returns {string} 原因描述
 */
function describeError(err) {
  const code = String(err?.cause?.code || err?.code || '').toUpperCase();
  if (code) return code;
  return String(err?.message || 'unknown').substring(0, 120);
}

/**
 * 调用 Ollama API 进行文本对话
 * @param {string} model - 模型名称
 * @param {string} systemPrompt - system prompt
 * @param {string} userContent - 用户消息文本
 * @param {string[]} images - base64 编码的图片数组（可选）
 * @param {string} customHost - 自定义 Ollama 主机地址（可选，用于双显卡模式）
 * @returns {Promise<{content: string, elapsedMs: number}>} 模型回复文本及耗时
 */
async function chat(model, systemPrompt, userContent, images = [], customHost = null, extraOptions = {}) {
  const startTime = Date.now();
  const host = customHost || config.ollama.host;

  // 可选能力未配置：直接快速失败，绝不重试、绝不刷屏
  if (!isLocalAvailable()) {
    const reason = getCapabilities().local.reason || '本地通道未配置';
    warnLocalSkippedOnce(reason);
    const err = new Error(`本地模型通道未配置，已跳过 (${reason})`);
    err.code = 'LOCAL_NOT_CONFIGURED';
    err.skipped = true;
    throw err;
  }

  // qwen3 系列默认开启 thinking 模式，输出 bitmask...bitmask 包裹的思考过程
  // 审核只需要 JSON 结果，默认禁用思考可加速响应并避免 JSON 解析失败
  // safeguard 模型使用 harmony 格式（analysis/final 通道），需要启用 thinking
  const useThink = extraOptions.think || false;

  // think 模式下，thinking 内容也计入 num_predict，需要增大配额避免输出被截断
  const options = { ...config.ollama.options };
  if (useThink) {
    options.num_predict = Math.max(options.num_predict || 512, 4096);
  }

  const body = {
    model,
    stream: false,
    think: useThink,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent, ...(images.length > 0 ? { images } : {}) },
    ],
    options,
  };

  // 审核调用：keep_alive=2m → 审核后保留2分钟，覆盖突发流量，空闲后自动卸载
  // 突发消息（群里连续发）：只第一次有加载延迟，后续秒回
  // 切换模型类型（文本→图片）：Ollama 自动卸载旧模型加载新模型，不会同时占用
  // 对比：对话调用使用 chatKeepAlive（默认5m），短时保留加速连续对话
  const modKeepAlive = config.ollama.moderationKeepAlive;
  body.keep_alive = (modKeepAlive === undefined || modKeepAlive === null)
    ? 0
    : modKeepAlive;

  // 重试策略：只对网络类错误（超时 / 5xx / 连接重置）做有限重试，且最多 2 次；
  // 「返回了内容但为空 / 无法解析」属于语义失败，重试没有意义，
  // 还会被攻击者用畸形输出放大请求成本，因此一律不重试，直接交由上层 fail-closed。
  const maxRetries = Math.min(Math.max(parseInt(config.ollama.maxRetries, 10) || 0, 0), 2);
  const maxAttempts = maxRetries + 1;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 每次尝试使用独立的 AbortController：复用已 abort 的 signal 会让重试瞬间失败
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ollama.timeout);
    try {
      const res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        const httpErr = new Error(`Ollama HTTP ${res.status}: ${errText}`);
        httpErr.status = res.status;
        httpErr.failureType = res.status >= 500 ? 'http' : 'network';
        throw httpErr;
      }

      const data = await res.json();
      const content = data?.message?.content;
      if (!content) {
        // 语义失败：不重试
        const emptyErr = new Error('Ollama 返回了空内容');
        emptyErr.failureType = 'empty';
        throw emptyErr;
      }
      if (data?.eval_duration !== undefined) {
        const elapsedMs = data.total_duration ? data.total_duration / 1_000_000 : Date.now() - startTime;
        return { content, elapsedMs };
      }
      return { content, elapsedMs: Date.now() - startTime };
    } catch (err) {
      lastError = err;

      // 服务不可达（Ollama 未启动/端口不通）：非瞬时故障，重试无意义，立刻放弃并只提示一次，
      // 避免「Ollama 没装」的机器上每条消息都刷 maxRetries 条错误。
      if (isServiceUnreachable(err)) {
        warnLocalSkippedOnce(`无法连接 ${host} (${describeError(err)})`);
        err.failureType = err.failureType || 'network';
        break;
      }
      // 语义失败（拿到响应但内容为空 / 不可用）：不重试
      if (err.failureType === 'empty') break;
      // 4xx 属于请求本身有问题，重试也无用
      if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) break;

      if (err.name === 'AbortError') {
        err.failureType = 'timeout';
        logError('ollama', `请求超时 (${config.ollama.timeout}ms)`, { model, attempt });
      } else {
        err.failureType = err.failureType || 'network';
        logError('ollama', `第 ${attempt} 次请求失败: ${err.message}`, { model, attempt });
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError) throw lastError;
  throw new Error('Ollama 请求失败');
}

/**
 * 卸载模型，释放显存
 * 通过向 Ollama 发送 keep_alive=0 的空请求来卸载模型
 * @param {string} model - 模型名称
 * @param {string} customHost - 自定义主机地址（可选）
 */
async function unloadModel(model, customHost = null) {
  const host = customHost || config.ollama.host;
  if (!isLocalAvailable()) return;
  try {
    await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(10000),
    });
    logInfo('ollama', `模型 ${model} 已卸载，显存已释放`);
  } catch (err) {
    logError('ollama', `卸载模型 ${model} 失败: ${err.message}`);
  }
}

/**
 * 调用 Ollama 进行对话（通用版本，不限于审核用途）
 * 用于前端对话界面
 * @param {string} model - 模型名称
 * @param {Array} messages - 消息数组 [{role, content}]
 * @param {string} customHost - 自定义主机地址（可选）
 * @returns {Promise<string>} 模型回复文本
 */
async function chatRaw(model, messages, customHost = null) {
  const host = customHost || config.ollama.host;

  const body = {
    model,
    stream: false,
    messages,
    options: {
      temperature: 0.7,
      top_p: 0.9,
      num_predict: 1024,
      num_ctx: 4096,
    },
    // 对话调用：短时保留（默认 5 分钟），KV Cache 可复用加速连续对话
    // 审核调用使用 keep_alive=0（用完即卸），避免模型长期占用显存
    keep_alive: config.ollama.chatKeepAlive || '5m',
  };

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data?.message?.content || '';
}

/**
 * 检查 Ollama 服务是否可用
 * @param {string} customHost - 自定义主机地址（可选）
 */
async function healthCheck(customHost = null) {
  const host = customHost || config.ollama.host;

  // 可选能力未配置：直接返回 skipped，不发请求、不打错误
  if (!isLocalAvailable()) {
    return { ok: false, skipped: true, reason: getCapabilities().local.reason || '本地通道未配置', models: [] };
  }

  try {
    const res = await fetch(`${host}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 检查所有 Ollama 实例（双显卡模式下分别检查）
 */
async function healthCheckAll() {
  const textCheck = await healthCheck(config.ollama.host);
  const visionHost = config.ollama.visionHost || config.ollama.host;
  const visionCheck = visionHost === config.ollama.host
    ? textCheck
    : await healthCheck(visionHost);
  return {
    text: textCheck,
    vision: visionCheck,
  };
}

/**
 * 流式调用 Ollama 进行对话（用于前端流式传输）
 * 逐 token 回调 onToken(piece, full)，返回完整文本
 * @param {string} model - 模型名称
 * @param {Array} messages - 消息数组 [{role, content}]
 * @param {Function} onToken - 每收到一个 token 片段时的回调
 * @param {string} customHost - 自定义主机地址（可选）
 * @param {AbortSignal} signal - 用于客户端断开时中止（可选）
 * @returns {Promise<string>} 完整回复文本
 */
async function chatStream(model, messages, onToken, customHost = null, signal = null) {
  const host = customHost || config.ollama.host;

  const body = {
    model,
    stream: true,
    messages,
    options: {
      temperature: 0.7,
      top_p: 0.9,
      num_predict: 1024,
      num_ctx: 4096,
    },
    keep_alive: config.ollama.chatKeepAlive || '5m',
  };

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) {
          try {
            const json = JSON.parse(payload);
            const piece = json.message?.content || '';
            if (piece) {
              full += piece;
              if (onToken) onToken(piece, full);
            }
          } catch {
            // 跳过无法解析的片段
          }
        }
      } else {
        // Ollama 流式为纯 JSON 行（无 "data:" 前缀），兼容解析
        try {
          const json = JSON.parse(line);
          const piece = json.message?.content || '';
          if (piece) {
            full += piece;
            if (onToken) onToken(piece, full);
          }
        } catch {
          // 忽略
        }
      }
    }
  }

  return full;
}

module.exports = { chat, chatRaw, chatStream, healthCheck, healthCheckAll, unloadModel, isLocalAvailable };
