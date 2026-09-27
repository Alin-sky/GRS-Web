/**
 * 模型对比审核（内置路径 / 插件不可用时的兜底）
 * v2.3.0（Req5）重构：本文件从「一份完整的对比实现」收缩为**薄适配层**。
 * 背景：对比审核已解耦为独立插件 plugins/comparison-suite。为了让插件与内置路径
 * 结果口径完全一致，把所有实现下沉到 4 个核心共享模块 + 1 个编排引擎：
 * - src/comparison-core.js 「怎么比」（纯函数，零依赖）
 * - src/comparison-source.js 输入侧：审核记录 + 图片字节
 * - src/comparison-store.js 输出侧：结果落盘 / 读取 / 列举
 * - src/comparison-probe.js 单通道对单条内容出一次判定（prompt / 密钥留在核心）
 * - src/comparison-engine.js 编排：文本/图像共用一条管线
 * 本文件只负责：加载配置 → 组装依赖 → 调用引擎 → 暴露既有导出（签名与历史完全一致）。
 * 不再重复实现 compareResults / isErrorResult / getModelLabel —— 那正是双轨漂移的根因。
 * 依赖方向：核心层模块。《scripts/lint-plugin-boundary.js》的 CORE_MODULES 含本文件名，
 * 故本文件**不得 require 任何 ./plugin-* / ./cordis-* / ./host-services**。
 */
const { loadConfig } = require('./config');
const { logInfo } = require('./logger');
const engine = require('./comparison-engine');
const core = require('./comparison-core');
const source = require('./comparison-source');
const store = require('./comparison-store');
const probe = require('./comparison-probe');

/** 运行状态（内置路径自己的状态；插件路径的状态由插件运行维护）*/
let running = false;
let runProgress = null;

/**
 * 组装生效配置（内置路径的配置来源是全局 config）。
 * @returns {object} 引擎需要的配置投影
 */
function effectiveConfig() {
  const config = loadConfig();
  const ollama = config.ollama || {};
  const qwen = config.qwenCloud || {};
  return {
    modality: ollama.comparisonModality || 'text',
    textModel: ollama.textModel || '',
    visionModel: ollama.visionModel || '',
    cloudVisionModel: qwen.visionModel || '',
    comparisonModels: Array.isArray(ollama.comparisonModels) ? ollama.comparisonModels : [],
    comparisonSchedule: ollama.comparisonSchedule || '04:00',
    includeCloud: true,
    includeContentSafety: true,
    keepAlive: '5m',
  };
}

/**
 * 运行对比审核（文本 / 图像双模态）。
 * @param {string} [dateStr] 目标日期 YYYY-MM-DD（缺省昨天）
 * @param {{modality?: 'text'|'image', maxItems?: number, folder?: string}} [options] 选项
 * @returns {Promise<object>} 对比结果
 */
async function runComparison(dateStr, options = {}) {
  if (running) {
    throw new Error('对比审核正在运行中，请等待完成');
  }
  const cfg = effectiveConfig();
  const target = dateStr || store.yesterdayStr();
  const modality = options.modality === 'image' || options.modality === 'text'
    ? options.modality
    : cfg.modality;

  running = true;
  runProgress = { phase: '准备中', done: 0, total: 0 };
  try {
    return await engine.runComparison(
      {
        source,
        store,
        probe,
        core,
        config: cfg,
        logger: {
          info: (m) => logInfo('comparator', m),
          warn: (m) => logInfo('comparator', m),
          error: (m) => logInfo('comparator', m),
        },
        onProgress: (p) => { runProgress = p; },
      },
      { date: target, modality, maxItems: options.maxItems, folder: options.folder || cfg.imageFolder || '' },
    );
  } finally {
    running = false;
    runProgress = null;
  }
}

/**
 * 读取指定日期的对比结果。
 * @param {string} dateStr 日期 YYYY-MM-DD
 * @returns {object|null} 对比结果，或 null
 */
function getComparisonResult(dateStr) {
  return store.readResult(dateStr);
}

/**
 * 列出所有对比结果的日期与概要（按日期倒序）。
 * @returns {Array<object>} 列表
 */
function listComparisons() {
  return store.listResults();
}

/**
 * 获取对比运行状态（与插件同口径：都走 engine.statusOf）。
 * @returns {object} 状态
 */
function getStatus() {
  return {
    ...engine.statusOf({ config: effectiveConfig(), running, progress: runProgress, probe }),
    schedule: effectiveConfig().comparisonSchedule,
  };
}

module.exports = {
  runComparison,
  getComparisonResult,
  listComparisons,
  getStatus,
};