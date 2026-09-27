/**
 * 看门狗进程守护（长时间运行稳定性）
 *
 * 以子进程方式拉起 server.js，崩溃后自动重启。
 * 用法：node scripts/watchdog.js
 *
 * 特性：
 * - 崩溃自动重启（指数退避：3s → 6s → 12s ... 上限 60s）
 * - 稳定运行 60 秒后重置退避计数（偶发崩溃不影响长期运行）
 * - 连续崩溃 100 次仍无法稳定运行则放弃（防无限循环）
 * - Ctrl+C / 关闭窗口时优雅退出子进程
 * - 服务启动后自动打开浏览器（仅首次）
 */
const { spawn, exec } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const NODE = process.execPath; // 用当前 node 可执行文件
const PORT = 11451;
const BASE_URL = `http://localhost:${PORT}`;

const RESTART_DELAYS = [3, 6, 12, 20, 30, 45, 60]; // 秒，指数退避
const STABLE_AFTER_MS = 60 * 1000; // 稳定运行 60 秒重置退避
const MAX_TOTAL_RESTARTS = 100;

let restartCount = 0;
let backoffIndex = 0;
let stableSince = Date.now();
let child = null;
let shuttingDown = false;
let browserOpened = false; // 只在首次启动时打开浏览器

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] [WATCHDOG] ${msg}`);
}

/**
 * 轮询服务是否就绪，就绪后打开浏览器
 */
function waitForServerAndOpenBrowser() {
  if (browserOpened) return; // 已经打开过，不再重复打开

  const http = require('http');
  let attempts = 0;
  const maxAttempts = 30; // 最多等待 15 秒

  const interval = setInterval(() => {
    attempts++;
    const req = http.get(`${BASE_URL}/health`, (res) => {
      if (res.statusCode === 200) {
        clearInterval(interval);
        browserOpened = true;
        log('服务已就绪，正在打开浏览器...');
        // 跨平台打开浏览器：Windows 用 start，macOS 用 open，Linux 用 xdg-open
        const cmd = process.platform === 'win32'
          ? `cmd /c start "" "${BASE_URL}"`
          : process.platform === 'darwin'
            ? `open "${BASE_URL}"`
            : `xdg-open "${BASE_URL}"`;
        exec(cmd, (openErr) => {
          if (openErr) log(`打开浏览器失败: ${openErr.message}`);
          else log(`浏览器已打开: ${BASE_URL}`);
        });
      }
    });
    req.on('error', () => {
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        log(`服务启动超时（${maxAttempts * 0.5}s），请手动打开浏览器`);
      }
    });
    req.setTimeout(2000, () => req.destroy());
  }, 500);
}

function spawnServer() {
  log(`启动服务进程: ${SERVER}`);
  child = spawn(NODE, [SERVER], { stdio: 'inherit', cwd: path.join(__dirname, '..') });

  // 首次启动时自动打开浏览器
  if (!browserOpened) {
    waitForServerAndOpenBrowser();
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      log(`服务已退出 (code=${code}, signal=${signal})，看门狗停止`);
      process.exit(code || 0);
      return;
    }
    log(`服务进程退出 (code=${code}, signal=${signal})`);

    const stableMs = Date.now() - stableSince;
    if (stableMs >= STABLE_AFTER_MS) {
      // 已稳定运行足够久，视为偶发崩溃，重置退避
      backoffIndex = 0;
      log(`已稳定运行 ${Math.round(stableMs / 1000)}s，退避计数重置`);
    }

    if (restartCount >= MAX_TOTAL_RESTARTS) {
      log(`连续重启 ${restartCount} 次仍无法稳定运行，放弃自动重启，请检查日志`);
      process.exit(1);
      return;
    }

    const delay = RESTART_DELAYS[Math.min(backoffIndex, RESTART_DELAYS.length - 1)];
    backoffIndex = Math.min(backoffIndex + 1, RESTART_DELAYS.length - 1);
    restartCount++;
    stableSince = Date.now();
    log(`将在 ${delay} 秒后重启（第 ${restartCount} 次重启）`);
    setTimeout(spawnServer, delay * 1000);
  });
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('收到退出信号，正在停止服务...');
  if (child) {
    child.kill('SIGTERM');
    // 3 秒后仍未退出则强杀
    setTimeout(() => {
      if (child) { try { child.kill('SIGKILL'); } catch {} }
      process.exit(0);
    }, 3000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('看门狗已启动，守护服务中...');
spawnServer();
