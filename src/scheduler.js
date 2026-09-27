const { loadConfig, getCapabilities } = require('./config');
const { runComparison } = require('./comparator');
const { logInfo, logError, logWarn } = require('./logger');

const config = loadConfig();

let scheduledTimeout = null;
let nextRunTime = null;
let lastRunResult = null;
let isRunning = false;
let comparisonEnabled = true; // 是否启用每日自动对比审核

/**
 * 解析调度时间 "03:00" → { hour: 3, minute: 0 }
 */
function parseScheduleTime(timeStr) {
  const [h, m] = (timeStr || '03:00').split(':').map((n) => parseInt(n, 10));
  return { hour: h || 3, minute: m || 0 };
}

/**
 * 计算到下次运行时间的毫秒数
 */
function getMsUntilNextRun() {
  const { hour, minute } = parseScheduleTime(config.ollama.comparisonSchedule);
  const now = new Date();
  const next = new Date(now);

  next.setHours(hour, minute, 0, 0);

  // 如果今天的调度时间已过，设为明天
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return {
    ms: next - now,
    nextRun: next,
  };
}

/**
 * 执行对比审核任务
 */
async function executeComparison() {
  if (isRunning) {
    logInfo('scheduler', '对比审核已在运行中，跳过本次调度');
    return;
  }

  isRunning = true;
  logInfo('scheduler', '定时对比审核任务启动');

  try {
    const result = await runComparison();
    lastRunResult = {
      date: result.date,
      run_at: result.run_at,
      total: result.total_records,
      agreement_rate: result.summary?.agreement_rate || 0,
      agreed: result.summary?.agreed || 0,
      disagreed: result.summary?.disagreed || 0,
      success: true,
    };
    logInfo('scheduler', `定时对比审核完成: 日期=${result.date}, 一致率=${lastRunResult.agreement_rate}%`);
  } catch (err) {
    logError('scheduler', `定时对比审核失败: ${err.message}`);
    lastRunResult = {
      run_at: new Date().toISOString(),
      success: false,
      error: err.message,
    };
  }

  isRunning = false;
  // 调度下一次
  scheduleNext();
}

/**
 * 调度下一次运行
 */
function scheduleNext() {
  if (!comparisonEnabled) {
    nextRunTime = null;
    return;
  }
  if (scheduledTimeout) {
    clearTimeout(scheduledTimeout);
  }

  const { ms, nextRun } = getMsUntilNextRun();
  nextRunTime = nextRun;

  logInfo('scheduler', `下次对比审核: ${nextRun.toLocaleString('zh-CN')} (${Math.round(ms / 1000 / 60)}分钟后)`);

  scheduledTimeout = setTimeout(() => {
    executeComparison();
  }, ms);

  // 确保 setTimeout 不会阻止进程退出
  if (scheduledTimeout.unref) {
    scheduledTimeout.unref();
  }
}

/**
 * 设置对比审核开关
 * @param {boolean} enabled
 */
function setComparisonEnabled(enabled) {
  comparisonEnabled = enabled === true;
  if (comparisonEnabled) {
    logInfo('scheduler', '对比审核已启用');
    scheduleNext();
  } else {
    logInfo('scheduler', '对比审核已禁用');
    if (scheduledTimeout) {
      clearTimeout(scheduledTimeout);
      scheduledTimeout = null;
    }
    nextRunTime = null;
  }
  return comparisonEnabled;
}

/**
 * 手动触发对比审核
 * @param {string} [dateStr] 目标日期 YYYY-MM-DD
 * @param {{modality?: 'text'|'image', maxItems?: number}} [options] 选项
 */
async function triggerManual(dateStr, options = {}) {
  if (isRunning) {
    throw new Error('对比审核正在运行中');
  }

  isRunning = true;
  try {
    const result = await runComparison(dateStr, options);
    lastRunResult = {
      date: result.date,
      run_at: result.run_at,
      total: result.total_records,
      agreement_rate: result.summary?.agreement_rate || 0,
      agreed: result.summary?.agreed || 0,
      disagreed: result.summary?.disagreed || 0,
      modality: (result.summary?.modalities && result.summary.modalities[0]) || 'text',
      success: true,
      manual: true,
    };
    return result;
  } finally {
    isRunning = false;
  }
}

/**
 * 获取调度器状态
 */
function getSchedulerStatus() {
  const { hour, minute } = parseScheduleTime(config.ollama.comparisonSchedule);
  return {
    enabled: comparisonEnabled,
    schedule: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    nextRun: nextRunTime ? nextRunTime.toISOString() : null,
    nextRunLocal: nextRunTime ? nextRunTime.toLocaleString('zh-CN') : null,
    isRunning,
    lastRun: lastRunResult,
  };
}

/**
 * 初始化调度器
 */
function initScheduler() {
  comparisonEnabled = config.ollama.comparisonEnabled !== false;

  // 对比审核依赖本地 + 云端两条通道；两条都没配时自动停用，
  // 否则每天凌晨会对全部历史记录逐条失败报错（"疯狂报错"的典型来源）。
  const caps = getCapabilities();
  if (comparisonEnabled && !caps.local.available && !caps.cloud.available) {
    comparisonEnabled = false;
    logWarn('scheduler', '本地与云端通道均未配置，每日对比审核已自动停用（配置任一通道后重启即恢复）');
    nextRunTime = null;
    return;
  }

  if (comparisonEnabled) {
    logInfo('scheduler', `对比审核调度器已初始化, 每日 ${config.ollama.comparisonSchedule || '03:00'} 自动运行`);
    scheduleNext();
  } else {
    logInfo('scheduler', '对比审核调度器已初始化, 但已禁用（comparisonEnabled=false），需手动开启');
    nextRunTime = null;
  }
}

module.exports = {
  initScheduler,
  triggerManual,
  getSchedulerStatus,
  setComparisonEnabled,
};
