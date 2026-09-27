// 模型管理模块 - 支持上传/导入本地 GGUF 模型
// 全部走 Ollama HTTP API（不再依赖 ollama CLI，避免 PATH 缺失问题）
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, setModelConfig, getCapabilities } = require('./config');
const { logInfo, logError, logWarn } = require('./logger');

const config = loadConfig();
const MODELS_DIR = path.join(__dirname, '..', 'models');
const OLLAMA_HOST = () => config.ollama?.host || 'http://127.0.0.1:11434';

// 本地通道未配置 / 不可达时，前端会轮询本地模型列表。
// 这里做节流，避免每次轮询都打一条错误日志（表现为"疯狂报错"）。
const LOCAL_WARN_INTERVAL_MS = 5 * 60 * 1000;
let lastLocalWarnAt = 0;
let localWarnCount = 0;

/**
 * 节流式告警：同一原因在 LOCAL_WARN_INTERVAL_MS 内最多提示一次。
 * @param {string} message 告警内容
 */
function warnLocalThrottled(message) {
  const now = Date.now();
  localWarnCount += 1;
  if (now - lastLocalWarnAt < LOCAL_WARN_INTERVAL_MS) return;
  lastLocalWarnAt = now;
  logWarn('model-manager', `${message}（已静默 ${localWarnCount} 次同类提示）`);
  localWarnCount = 0;
}

// 确保 models 目录存在
if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

/**
 * 获取所有可用的本地模型（GET /api/tags）
 */
async function getLocalModels() {
  // 可选能力未配置：直接返回空列表，不请求、不报错
  if (!getCapabilities().local.available) {
    warnLocalThrottled(`本地模型通道未配置，已跳过模型列表查询 (${getCapabilities().local.reason})`);
    return [];
  }

  try {
    const res = await fetch(`${OLLAMA_HOST()}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = data.models || [];
    return models.map((m) => {
      const name = m.name;
      let type = 'text';
      if (name.includes('vl') || name.includes('vision')) type = 'vision';
      return {
        name,
        size: formatBytes(m.size),
        sizeRaw: m.size || 0,
        type,
        installed: true,
        modifiedAt: m.modified_at || null,
      };
    });
  } catch (err) {
    // 服务不可达属于「可选能力未启用」，节流提示即可，不按错误刷屏
    warnLocalThrottled(`获取本地模型列表失败: ${err.message}`);
    return [];
  }
}

/**
 * 上传模型文件（GGUF）到 models 目录
 */
function uploadModelFile(file) {
  const filename = file.name || 'model.gguf';
  const destPath = path.join(MODELS_DIR, filename);

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);

    file.pipe(writeStream);

    writeStream.on('finish', () => {
      logInfo('model-manager', `模型文件已上传: ${filename} (${formatBytes(writeStream.bytesWritten)})`);
      resolve({ filename, path: destPath, size: writeStream.bytesWritten });
    });

    writeStream.on('error', (err) => {
      logError('model-manager', `上传模型文件失败: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * 从 GGUF 文件导入模型到 Ollama（POST /api/create）
 * Ollama 的 Modelfile `FROM` 支持本地 GGUF 绝对路径。
 */
async function importModel(ggufPath, modelName, modelType = 'text') {
  try {
    // Windows 下 GGUF 绝对路径需要转成 Ollama 可识别的格式（正斜杠）
    const fromPath = ggufPath.replace(/\\/g, '/');
    const modelfile = modelType === 'vision'
      ? `FROM ${fromPath}\nTEMPLATE """{{ .System }}\n{{ .Prompt }}"""`
      : `FROM ${fromPath}`;

    logInfo('model-manager', `开始导入模型: ${modelName} (${fromPath})`);

    const res = await fetch(`${OLLAMA_HOST()}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, modelfile, stream: false }),
      signal: AbortSignal.timeout(600000), // 10 分钟超时，GGUF 导入可能较慢
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.substring(0, 300)}`);
    }

    // stream:false 时返回单个 JSON { status: "success" }；兼容流式返回
    const raw = await res.text();
    let status = 'success';
    try {
      const parsed = JSON.parse(raw);
      if (parsed.status) status = parsed.status;
    } catch {
      // 可能是 NDJSON 流式返回，取最后一行 status
      const lines = raw.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.status) { status = obj.status; break; }
        } catch { /* 跳过*/ }
      }
    }

    if (status !== 'success') {
      throw new Error(`导入状态异常: ${status}`);
    }

    logInfo('model-manager', `模型导入成功: ${modelName}`);
    return { success: true, modelName };
  } catch (err) {
    logError('model-manager', `导入模型失败: ${modelName}: ${err.message}`);
    throw err;
  }
}

/**
 * 从 Ollama 仓库拉取官方模型（POST /api/pull）
 * 等价于 `ollama pull <name>`
 */
async function pullModel(modelName) {
  try {
    logInfo('model-manager', `开始拉取模型: ${modelName}`);

    const res = await fetch(`${OLLAMA_HOST()}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: false }),
      signal: AbortSignal.timeout(1800000), // 30 分钟，大模型拉取较慢
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.substring(0, 300)}`);
    }

    const raw = await res.text();
    let status = 'success';
    try {
      const parsed = JSON.parse(raw);
      if (parsed.status) status = parsed.status;
    } catch {
      const lines = raw.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.status) { status = obj.status; break; }
        } catch { /* 跳过*/ }
      }
    }

    if (status !== 'success') {
      throw new Error(`拉取状态异常: ${status}`);
    }

    logInfo('model-manager', `模型拉取成功: ${modelName}`);
    return { success: true, modelName };
  } catch (err) {
    logError('model-manager', `拉取模型失败: ${modelName}: ${err.message}`);
    throw err;
  }
}

/**
 * 删除本地模型（DELETE /api/delete）
 */
async function deleteModel(modelName) {
  try {
    logInfo('model-manager', `删除模型: ${modelName}`);
    const res = await fetch(`${OLLAMA_HOST()}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.substring(0, 300)}`);
    }
    logInfo('model-manager', `模型已删除: ${modelName}`);
    return { success: true };
  } catch (err) {
    logError('model-manager', `删除模型失败: ${modelName}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * 设置默认模型（写入配置文件 + 更新内存缓存，立即生效无需重启）
 */
function setDefaultModel(modelName, modelType = 'text') {
  // 复用 config 模块的缓存与自愈逻辑：配置文件缺失时会自动生成，不会因读取失败而抛异常
  const cfg = loadConfig();

  if (modelType === 'vision') {
    cfg.ollama.visionModel = modelName;
  } else {
    cfg.ollama.textModel = modelName;
  }

  // 同步更新内存缓存，使各模块持有的 config 引用立即生效
  setModelConfig(modelType, modelName);
  try {
    saveConfig();
  } catch (err) {
    logError('model-manager', `模型已切换但配置持久化失败: ${err.message}`);
  }
  logInfo('model-manager', `${modelType === 'vision' ? '视觉' : '文本'}模型已切换为: ${modelName}（已生效）`);

  return { success: true };
}

module.exports = {
  getLocalModels,
  uploadModelFile,
  importModel,
  pullModel,
  deleteModel,
  setDefaultModel,
};
