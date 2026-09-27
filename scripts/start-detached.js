/**
 * 后台启动审核服务（完全脱离当前 shell/会话）
 * 用 detached spawn 启动 server.js，日志写入 logs/server.log，
 * 即使启动它的终端/会话结束，服务进程也独立存活。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'server.log');
const node = process.execPath; // 使用当前运行的 node 可执行文件

// 确保日志目录存在
fs.mkdirSync(path.dirname(LOG), { recursive: true });

// 打开日志文件（追加模式），作为子进程的 stdout/stderr
const out = fs.openSync(LOG, 'a');

const child = spawn(node, [path.join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  detached: true,          // 新进程组，脱离父进程
  stdio: ['ignore', out, out], // 输入忽略，输出写日志
  windowsHide: true,
});

child.unref(); // 父进程不等待子进程

fs.closeSync(out);
console.log(`审核服务已后台启动 (PID: ${child.pid})，日志: ${LOG}`);
