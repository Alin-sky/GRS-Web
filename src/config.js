const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG, deepMerge, isValueSet } = require('./config-defaults');
const { detectConflicts, writeStartupLog } = require('./config-conflicts');
// T08a：WD14 服务地址单一真相（默认值与插件/健康检查同源）
const wd14Endpoint = require('./wd14-endpoint');

let cachedConfig = null;
let cachedCapabilities = null;
let cachedConflicts = [];
let cachedStartupBlocked = false;
let capabilitySummaryLogged = false;

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'default.json');
const EXAMPLE_PATH = path.join(CONFIG_DIR, 'default.example.json');

/**
 * 配置模块专用日志输出。
 * 说明：config.js 不能 require('./logger')，因为 logger.js 在模块加载期就会调用 loadConfig()，
 * 顶层互相 require 会形成循环依赖导致拿到未初始化的导出。这里直接写控制台。
 * @param {'info'|'warn'|'error'} level 级别
 * @param {string} message 内容
 */
function cfgLog(level, message) {
  const prefix = level === 'error' ? '[config] ERROR' : level === 'warn' ? '[config] WARN' : '[config]';
  const line = `${prefix} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * 确保配置文件存在。不存在时按以下顺序自愈：
 * ① 从 config/default.example.json 复制
 * ② 使用内置最小可用默认结构生成
 * 全过程打日志，绝不因配置缺失而中断启动。
 * @returns {'existing'|'created-from-example'|'created-from-builtin'|'unavailable'} 配置来源
 */
function ensureConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      cfgLog('warn', `配置目录不存在，已自动创建: ${path.relative(PROJECT_ROOT, CONFIG_DIR)}`);
    }
  } catch (err) {
    cfgLog('error', `创建配置目录失败: ${err.message}`);
  }

  if (fs.existsSync(CONFIG_PATH)) return 'existing';

  if (fs.existsSync(EXAMPLE_PATH)) {
    try {
      fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
      cfgLog('warn', 'config/default.json 不存在，已自动从 config/default.example.json 生成');
      cfgLog('warn', '请在 config/default.json 中填写真实密钥（或设置环境变量）后重启服务');
      return 'created-from-example';
    } catch (err) {
      cfgLog('error', `从示例配置生成 default.json 失败: ${err.message}`);
    }
  }

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    cfgLog('warn', 'config/default.json 与 default.example.json 均不存在，已生成内置默认配置');
    return 'created-from-builtin';
  } catch (err) {
    cfgLog('error', `生成默认配置失败: ${err.message}（将以内置默认结构继续启动）`);
    return 'unavailable';
  }
}

/**
 * 读取并解析配置文件。
 * 文件缺失 / JSON 损坏时不会抛异常：损坏文件会被备份为 default.corrupt-<时间戳>.json，
 * 然后回退到示例配置或内置默认结构。
 * @returns {object} 解析后的原始配置（可能为 {}）
 */
function readRawConfig() {
  let raw = null;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  } catch {
    return {};
  }

  if (raw === null) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    cfgLog('error', `config/default.json 解析失败: ${err.message}`);
    try {
      const backupPath = path.join(CONFIG_DIR, `default.corrupt-${Date.now()}.json`);
      fs.copyFileSync(CONFIG_PATH, backupPath);
      cfgLog('warn', `已备份损坏配置到 ${path.relative(PROJECT_ROOT, backupPath)}`);
    } catch {
      // 备份失败不影响后续回退
    }
    if (fs.existsSync(EXAMPLE_PATH)) {
      try {
        const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf-8'));
        cfgLog('warn', '已回退使用 config/default.example.json');
        return example && typeof example === 'object' ? example : {};
      } catch {
        // 示例文件同样损坏则继续回退
      }
    }
    cfgLog('warn', '已回退使用内置默认配置结构');
    return {};
  }
}

/**
 * 应用环境变量覆盖（仅覆盖有值的环境变量，保持原有优先级）。
 * @param {object} cfg 已合并的配置对象（原地修改）
 */
function applyEnvOverrides(cfg) {
  if (process.env.MOD_PORT) {
    const port = parseInt(process.env.MOD_PORT, 10);
    if (Number.isFinite(port)) cfg.server.port = port;
  }
  if (process.env.MOD_HOST) cfg.server.host = process.env.MOD_HOST;
  if (process.env.OLLAMA_HOST) cfg.ollama.host = process.env.OLLAMA_HOST;
  if (process.env.OLLAMA_TEXT_MODEL) cfg.ollama.textModel = process.env.OLLAMA_TEXT_MODEL;
  if (process.env.OLLAMA_VISION_MODEL) cfg.ollama.visionModel = process.env.OLLAMA_VISION_MODEL;

  // 云端大模型 API Key（DashScope 与 Token Plan 共用同一套环境变量入口）
  if (process.env.DASHSCOPE_API_KEY) cfg.qwenCloud.apiKey = process.env.DASHSCOPE_API_KEY;

  // 阿里云内容安全 AccessKey（优先使用环境变量，避免写入配置文件）
  if (process.env.ALIBABA_CLOUD_ACCESS_KEY_ID) cfg.contentSafety.accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  if (process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) cfg.contentSafety.accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  if (process.env.CONTENT_SAFETY_ENDPOINT) cfg.contentSafety.endpoint = process.env.CONTENT_SAFETY_ENDPOINT;

  if (process.env.ADMIN_PASSWORD) cfg.adminPassword = process.env.ADMIN_PASSWORD;

  // 轻量版模式：仅使用云端审核
  if (process.env.MODERATION_MODE === 'cloud-only') cfg.moderationMode = 'cloud-only';
}

/**
 * 加载配置。
 * 保证返回值一定是「完整结构」：与 DEFAULT_CONFIG 深度合并，任一字段缺失都会补上默认值。
 * @returns {object} 配置对象（模块内缓存，多处 require 共享同一引用）
 */
function loadConfig() {
  if (cachedConfig) return cachedConfig;

  const origin = ensureConfigFile();
  const raw = readRawConfig();
  cachedConfig = deepMerge(DEFAULT_CONFIG, raw);
  applyEnvOverrides(cachedConfig);

  // v2.2.0：旧配置 → 默认拓扑（幂等；不删除任何旧字段，保证 flows.enabled=false 逃生可用）
  try {
    const flowMigrate = require('./flow/migrate');
    const migration = flowMigrate.ensureFlows(cachedConfig);
    for (const entry of migration.log) {
      cfgLog(entry.level === 'warn' ? 'warn' : 'info', `[${entry.code}] ${entry.msg}`);
    }
    if (migration.migrated) {
      cfgLog('info', '已从旧开关生成默认审核拓扑（moderation.flows.text / .image）');
    }
  } catch (err) {
    cfgLog('error', `审核流程迁移失败（将回退旧引擎）: ${err.message}`);
  }

  // v0.1.0：旧「多重审核」配置退役（一次性数据迁移，幂等）。
  // 数据保全硬要求：**不删除任何字段** —— 原值整份复制到 moderation.legacy.reviewChannels，
  // moderation.reviewChannels 与顶层 reviewChannels 原位保留（外部脚本读旧字段不会读空）。
  // 迁移前先备份 config/default.json（保留最近 3 份），留痕写入 config._migration.v010。
  // 只在「确实需要迁移」时才动盘，避免每次启动都产生一个备份文件。
  try {
    const flowMigrate = require('./flow/migrate');
    const mod = cachedConfig.moderation || {};
    const alreadyRetired = Boolean(mod.legacy && mod.legacy.reviewChannels);
    const hasLegacySource = Boolean(mod.reviewChannels || cachedConfig.reviewChannels);
    if (!alreadyRetired && hasLegacySource) {
      const backup = flowMigrate.backupConfigFile({ keep: 3, projectRoot: PROJECT_ROOT });
      if (backup) cfgLog('info', `已在迁移前备份配置: ${path.basename(backup)}`);
      const retired = flowMigrate.retireReviewChannels(cachedConfig);
      for (const entry of retired.log) {
        cfgLog(entry.level === 'warn' ? 'warn' : 'info', `[${entry.code}] ${entry.msg}`);
      }
      if (retired.changed) {
        cfgLog('info', '旧 reviewChannels 已复制到 moderation.legacy.reviewChannels（原字段全部保留）');
        saveConfig(); // 唯一允许的一次性落盘：让迁移结果与留痕进入磁盘
      }
    }
  } catch (err) {
    cfgLog('error', `旧配置退役失败（不影响启动）: ${err.message}`);
  }

  void origin;

  // 选项冲突治理（架构 §4）：检测 → 打日志 → 施加自动修正 → 缓存报告供 /health 暴露
  const conflictResult = detectConflicts(cachedConfig, { isValueSet, log: cfgLog });
  cachedConflicts = conflictResult.reports;
  cachedStartupBlocked = conflictResult.blocking.length > 0;
  writeStartupLog(cachedConflicts, PROJECT_ROOT);

  cachedCapabilities = null;
  logCapabilitySummary();
  return cachedConfig;
}

/**
 * 获取上次配置加载时检测到的选项冲突报告（供 GET /health 首屏展示）。
 * @returns {Array<object>} 冲突报告
 */
function getConflicts() {
  if (!cachedConfig) loadConfig();
  return cachedConflicts;
}

/**
 * 是否存在致命冲突（resolution='block'，如端口非法），调用方应据此拒绝启动。
 * @returns {boolean} 是否需要拒绝启动
 */
function isStartupBlocked() {
  if (!cachedConfig) loadConfig();
  return cachedStartupBlocked;
}

/** 构建单个能力项描述。*/
function buildCapability(enabled, configured, enabledReason, configuredReason) {
  return {
    enabled: enabled === true,
    configured: configured === true,
    available: enabled === true && configured === true,
    reason: !enabled ? enabledReason : !configured ? configuredReason : '',
  };
}

/**
 * 解析云端实际生效的凭据（考虑 billingSource 切换 token-plan / dashscope）。
 * @param {object} cfg 配置对象
 * @returns {{apiKey: string, endpoint: string, provider: string}} 云端凭据
 */
function resolveCloudCredentials(cfg) {
  const cloud = cfg.qwenCloud || {};
  const tokenPlan = cfg.tokenPlan || {};
  const billingSource = cloud.billingSource || 'dashscope';

  if (billingSource === 'token-plan' && isValueSet(tokenPlan.apiKey)) {
    return {
      apiKey: String(tokenPlan.apiKey).trim(),
      endpoint: tokenPlan.endpoint || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      provider: 'token-plan',
    };
  }
  return {
    apiKey: isValueSet(cloud.apiKey) ? String(cloud.apiKey).trim() : '',
    endpoint: cloud.endpoint || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    provider: 'dashscope',
  };
}

/**
 * 能力检测：判断各「可选能力」当前是否可用。
 * 未配置的能力一律返回 available=false，调用方据此静默跳过，而不是抛异常或重试。
 * @returns {object} 能力映射表
 */
function getCapabilities() {
  if (cachedCapabilities) return cachedCapabilities;

  const cfg = loadConfig();
  const cloudCred = resolveCloudCredentials(cfg);
  const isCloudOnly = cfg.moderationMode === 'cloud-only';
  const wd14 = cfg.wd14 || {};

  const localEnabled = !isCloudOnly
    && cfg.ollama.enabled !== false
    && cfg.moderation.reviewChannels.local !== false;
  const localConfigured = isValueSet(cfg.ollama.host) && isValueSet(cfg.ollama.textModel);

  cachedCapabilities = {
    // 预检层（敏感词库）：始终可用，是「什么都没配置」时的最后兜底
    precheck: buildCapability(true, true, '', ''),

    // 本地 Ollama 模型（文本/视觉）
    local: buildCapability(
      localEnabled,
      localConfigured,
      isCloudOnly ? 'cloud-only 模式未启用本地通道' : '本地通道已在配置中关闭',
      !isValueSet(cfg.ollama.host) ? 'ollama.host 未配置' : 'ollama.textModel 未配置'
    ),

    // 云端大模型（Qwen / DeepSeek，含 Token Plan 额度）
    cloud: buildCapability(
      cfg.qwenCloud.enabled === true || isCloudOnly,
      isValueSet(cloudCred.apiKey),
      '云端通道已在配置中关闭',
      '云端 API Key 未配置（qwenCloud.apiKey / tokenPlan.apiKey / DASHSCOPE_API_KEY）'
    ),

    // Token Plan 额度通道
    tokenPlan: buildCapability(
      (cfg.qwenCloud.billingSource || 'dashscope') === 'token-plan',
      isValueSet(cfg.tokenPlan.apiKey),
      'billingSource 未设置为 token-plan',
      'tokenPlan.apiKey 未配置'
    ),

    // 阿里云绿网内容安全
    contentSafety: buildCapability(
      cfg.contentSafety.enabled === true,
      isValueSet(cfg.contentSafety.accessKeyId) && isValueSet(cfg.contentSafety.accessKeySecret),
      '内容安全已在配置中关闭',
      '内容安全 AccessKey 未配置'
    ),

    // WD1.4 标签器服务（可选，未显式禁用时按需要探活）
    // T08a：默认地址取自单一真相模块，避免与插件/健康检查的默认值漂移。
    wd14: buildCapability(
      wd14.enabled !== false,
      isValueSet(wd14.host || wd14Endpoint.DEFAULT_WD14_HOST),
      'wd14 已在配置中禁用',
      ''
    ),
  };

  return cachedCapabilities;
}

/**
 * 启动期打印一次能力摘要：明确告知哪些可选通道未配置、将被跳过。
 * 只打印一次，绝不随审核请求重复输出。
 */
function logCapabilitySummary() {
  if (capabilitySummaryLogged) return;
  capabilitySummaryLogged = true;

  // R11/T06：提示词文件就绪检查 —— 缺失时明确告警（不阻断启动），
  // 相关审核请求届时会返回 PROMPT_MISSING(400) 而不是 500。
  try {
    const p = checkPromptFiles();
    if (!p.ok) {
      cfgLog('warn', `提示词文件缺失：${p.missing.join(', ')} —— 对应审核请求将返回 PROMPT_MISSING(400)。`
        + '请在 prompts/ 目录补齐（可参考 *.example.md 模板，正文不进公开仓库）。');
    }
  } catch (err) {
    cfgLog('warn', `提示词就绪检查失败（不影响启动）: ${err.message}`);
  }

  const caps = getCapabilities();
  const lines = [];
  if (!caps.local.available) lines.push(`本地模型通道未配置，已跳过 (${caps.local.reason})`);
  if (!caps.cloud.available) lines.push(`云端审核通道未配置，已跳过 (${caps.cloud.reason})`);
  if (!caps.contentSafety.available) lines.push(`内容安全通道未配置，已跳过 (${caps.contentSafety.reason})`);

  if (lines.length === 0) {
    cfgLog('info', '全部审核通道均已配置');
    return;
  }
  for (const line of lines) cfgLog('warn', line);
  cfgLog('warn', '以上为可选能力，未配置不会影响服务启动；当前仅启用已配置的通道（预检层始终可用）');
}

/**
 * 快捷判断某个能力是否可用。
 * @param {'precheck'|'local'|'cloud'|'tokenPlan'|'contentSafety'|'wd14'} name 能力名
 * @returns {boolean} 是否可用
 */
function isCapabilityAvailable(name) {
  const caps = getCapabilities();
  const cap = caps[name];
  return Boolean(cap && cap.available);
}

/** R11/T06：提示词缺失错误码（前端按此字符串给出可读提示）。*/
const PROMPT_MISSING = 'PROMPT_MISSING';

/**
 * 读取提示词文件（**fail-closed**）。
 * 绝不返回任何默认兜底提示词：宁可明确报错，也不要静默用错提示词去审核。
 * 缺文件时抛**结构化错误**（`code=PROMPT_MISSING` / `status=400`），由 HTTP 层转成
 * `400 + PROMPT_MISSING`；不得抛裸 `ENOENT` 变成 500。
 * @param {string} filename `prompts/` 下的文件名
 * @returns {string} 提示词正文
 * @throws {Error & {code: string, status: number, promptId: string, promptPath: string}} 缺失/不可读时
 */
function getPrompt(filename) {
  const promptPath = path.join(PROJECT_ROOT, 'prompts', filename);
  try {
    return fs.readFileSync(promptPath, 'utf-8');
  } catch (err) {
    const e = new Error(
      `提示词文件缺失：prompts/${filename}（未找到或不可读）。` +
      '请在服务端 prompts/ 目录补齐后重试（可参考 *.example.md 模板）。',
    );
    e.code = PROMPT_MISSING;
    e.status = 400;
    e.promptId = filename;
    e.promptPath = promptPath;
    e.cause = err;
    throw e;
  }
}

/**
 * 提示词文件就绪检查（fail-closed 的**启动期告警**，不阻断启动）。
 * @returns {{ok: boolean, missing: string[], required: string[]}} 检查结果
 */
function checkPromptFiles() {
  const mod = (cachedConfig && cachedConfig.moderation) || {};
  const required = [];
  const add = (f) => { if (f && required.indexOf(f) === -1) required.push(f); };
  add(mod.textPromptFile || 'text_moderation.md');
  add(mod.imagePromptFile || 'image_moderation.md');
  add(mod.safeguardPromptFile || 'safeguard_moderation.md');
  const missing = required.filter((f) => {
    try { return !fs.existsSync(path.join(PROJECT_ROOT, 'prompts', f)); } catch { return true; }
  });
  return { ok: missing.length === 0, missing, required };
}

function saveConfig() {
  if (!cachedConfig) throw new Error('配置尚未加载');
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  } catch (err) {
    cfgLog('error', `创建配置目录失败: ${err.message}`);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2), 'utf-8');
  cachedCapabilities = null;
}

/**
 * 动态更新内存中的模型配置（切换模型后立即生效，无需重启）。
 * loadConfig 返回的是 cachedConfig 引用，各模块持有的 config 对象会同步看到变化。
 * @param {string} modelType - 'text' | 'vision'
 * @param {string} modelName
 */
function setModelConfig(modelType, modelName) {
  if (!cachedConfig) loadConfig();
  if (modelType === 'vision') {
    cachedConfig.ollama.visionModel = modelName;
  } else {
    cachedConfig.ollama.textModel = modelName;
  }
  cachedCapabilities = null;
}

function getProjectRoot() {
  return PROJECT_ROOT;
}

module.exports = {
  loadConfig,
  saveConfig,
  setModelConfig,
  getPrompt,
  PROMPT_MISSING,
  checkPromptFiles,
  getProjectRoot,
  getCapabilities,
  isCapabilityAvailable,
  resolveCloudCredentials,
  isValueSet,
  getConflicts,
  isStartupBlocked,
};
