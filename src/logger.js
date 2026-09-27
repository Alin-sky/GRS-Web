const fs = require('fs');
const path = require('path');
const { loadConfig, getProjectRoot } = require('./config');

const config = loadConfig();
const logConfig = config.logging;
const logDir = path.join(getProjectRoot(), logConfig.dir);

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const moderationLogPath = path.join(logDir, logConfig.moderationLog);
const errorLogPath = path.join(logDir, logConfig.errorLog);

// 从 package.json 动态读取版本号（避免启动横幅硬编码）
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(getProjectRoot(), 'package.json'), 'utf-8')).version;
  } catch {
    return '1.0.0';
  }
})();

// ─── 颜色 / 色块（Win10 控制台 VT 序列，非 TTY 时自动退化为 [TAG] 方括号）───
const TTY = !!process.stdout.isTTY;
const ESC = '\x1b[';
const paint = (s, codes) => (TTY ? `${ESC}${codes}m${s}${ESC}0m` : s);
// 实心色块：前景 + 背景，形如 [ SRV ]，非 TTY 退化为 [SRV]
const tag = (text, fg, bg) => (TTY ? `${ESC}${fg};${bg}m ${text} ${ESC}0m` : `[${text.trim()}]`);

const C = {
  black: '30', red: '31', green: '32', yellow: '33', blue: '34',
  magenta: '35', cyan: '36', white: '37', gray: '90',
  bgBlack: '40', bgRed: '41', bgGreen: '42', bgYellow: '43',
  bgBlue: '44', bgMagenta: '45', bgCyan: '46', bgWhite: '47', bgGray: '100',
};

const MODULE_TAGS = {
  server:         () => tag('SRV',  C.white, C.bgBlue),
  moderator:      () => tag('MOD',  C.white, C.bgMagenta),
  qwen_cloud:     () => tag('CLD',  C.black, C.bgCyan),
  content_safety: () => tag('SAFE', C.black, C.bgGreen),
  ollama:         () => tag('OLL',  C.black, C.bgYellow),
  precheck:       () => tag('PRE',  C.white, C.bgGray),
  audit:          () => tag('AUD',  C.black, C.bgWhite),
  scheduler:      () => tag('SCH',  C.white, C.bgGray),
  config:         () => tag('CFG',  C.white, C.bgBlue),
};
const moduleTag = (m) => (MODULE_TAGS[m] ? MODULE_TAGS[m]() : tag('INFO', C.white, C.bgGray));

function riskTag(level) {
  switch (level) {
    case 'critical': return tag('CRIT', C.white, C.bgRed);
    case 'high':     return tag('HIGH', C.black, C.bgYellow);
    case 'medium':   return tag('MED',  C.black, C.bgYellow);
    default:         return tag('SAFE', C.black, C.bgGreen);
  }
}

const okTag    = () => tag('OK',   C.black, C.bgGreen);
const blockTag = () => tag('BLCK', C.white, C.bgRed);
const errTag   = () => tag('ERR',  C.white, C.bgRed);
const warnTag  = () => tag('WARN', C.black, C.bgYellow);

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

// ─── 日志轮转（长时间运行防磁盘写满） ───
// 解析 "10m" / "512k" / "1g" 等大小字符串为字节数
function parseSize(str) {
  const m = String(str || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|m|g|kb|mb|gb)?$/);
  if (!m) return 10 * 1024 * 1024; // 默认 10MB
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'm').replace('b', '');
  const mult = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[unit] || 1024 * 1024;
  return Math.floor(n * mult);
}
const MAX_FILE_SIZE = parseSize(logConfig.maxFileSize);
const MAX_FILES = parseInt(logConfig.maxFiles, 10) || 30;

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_FILE_SIZE) return;
    // 轮转：moderation.log → moderation.log.1 → .2 → ...，删除最旧的
    const oldest = path.join(path.dirname(filePath), `${path.basename(filePath)}.${MAX_FILES}`);
    try { fs.unlinkSync(oldest); } catch { /* 忽略*/ }
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch { /* 忽略*/ }
    }
    try { fs.renameSync(filePath, `${filePath}.1`); } catch { /* 忽略*/ }
  } catch { /* 轮转失败不阻断写日志*/ }
}

function appendToFile(filePath, line) {
  try {
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line + '\n', 'utf-8');
  } catch (e) {
    console.error('[LOGGER ERROR]', e.message);
  }
}

function logModeration(entry) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  appendToFile(moderationLogPath, line);

  if (logConfig.console) {
    const isBlocked = entry.action === 'block' || entry.action === 'block_alert';
    const status = isBlocked ? blockTag() : okTag();
    const cats = (entry.categories || []).join(', ') || '无';
    console.log(`[${ts()}] ${status} ${entry.type || 'text'} | ${riskTag(entry.risk_level)} ${entry.risk_level || 'safe'} | 分类: ${cats} | ${entry.reason || '无原因'}`);
  }
}

function logError(module, message, detail) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    module,
    message,
    detail: detail || undefined,
  });
  appendToFile(errorLogPath, line);

  if (logConfig.console) {
    console.error(`[${ts()}] ${errTag()} [${module}] ${paint(message, C.red)}`);
    if (detail) {
      const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
      console.error(`   └─ ${detailStr.substring(0, 300)}`);
    }
  }
}

function logInfo(module, message) {
  if (!logConfig.console) return;
  console.log(`[${ts()}] ${moduleTag(module)} ${message}`);
}

function logWarn(module, message) {
  if (!logConfig.console) return;
  console.warn(`[${ts()}] ${warnTag()} [${module}] ${message}`);
}

function logStartup(serverInfo) {
  if (!logConfig.console) return;
  const sep = paint('='.repeat(60), C.cyan);
  const title = tag(` BOT 审核系统 v${APP_VERSION} `, C.white, C.bgMagenta);
  console.log('');
  console.log(sep);
  console.log(`  ${title}`);
  console.log(`  服务地址 : ${serverInfo.url}`);
  console.log(`  运行模式 : ${serverInfo.mode}`);
  if (serverInfo.localModel) console.log(`  本地模型 : ${serverInfo.localModel}`);
  if (serverInfo.cloudModel) console.log(`  云端模型 : ${serverInfo.cloudModel}`);
  if (serverInfo.contentSafety) console.log(`  内容安全 : 已启用`);
  console.log(`  双审模式 : ${serverInfo.dualMode ? '启用' : '禁用'}`);
  console.log(sep);
  console.log('');
}

/**
 * 读取最近的审核日志
 */
function getRecentLogs(count = 50) {
  try {
    const content = fs.readFileSync(moderationLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-count).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return recent;
  } catch {
    return [];
  }
}

module.exports = { logModeration, logError, logInfo, logWarn, logStartup, getRecentLogs };
