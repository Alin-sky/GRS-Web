#!/usr/bin/env node
/**
 * GRS 跨平台环境自举（scripts/bootstrap.js）
 *
 * 定位：**补齐缺口**，不另起一套。既有资产的分工（已读源码确认）：
 *   - `scripts/ensure-node.bat`（+ `ensure-node-download.ps1`）：**仅 Windows** —— 保证 Node ≥ 22.5.0
 *     （便携版 `runtime/node` → 系统 Node → 下载 v22.22.2 便携版），退出码 0/非 0。
 *   - `scripts/check-node.js`：纯版本工具（`parseVersion` / `compareVersions` / `isNodeCompatible`）。
 *   - `scripts/setup.js`：**旧 Ollama 向导** —— 检查 Node≥20.9.0、跑 `npm install`、强制要求 Ollama
 *     并拉模型（缺 Ollama 直接 exit 1）。它与本地 Ollama 时代绑定，且 `npm install` 会重排 lock 缩进。
 *   - `start.bat`：`call ensure-node.bat` → 探 Ollama → 杀端口 11451 → `node src/server.js` → 健康检查。
 *     **不装依赖、不种配置、不查提示词**。
 *   - `start.sh`：设 `MODERATION_MODE=cloud-only` 后直接 `node src/server.js`。**无任何环境准备**。
 *   - `start-cloud.bat` / `start-watchdog.bat` / `start-wd14.bat` / `set-env-admin.bat`：云模式 / 看门狗 /
 *     WD14 本地服务 / 管理员环境变量，各自专务。
 *
 *   ⇒ 跨平台缺口 = 「**依赖安装 + 目录/配置种子 + 提示词/可选依赖体检 + 就绪汇总**」这几步在
 *     Windows/Linux/macOS 上没有统一入口，且 Linux/macOS 连 Node 闸门都没有。
 *   本脚本补这些**且只补这些**：Windows 的 Node 获取仍**委托** `ensure-node.bat`（不重写下载逻辑）。
 *
 * 用法：
 *   node scripts/bootstrap.js                 # 自举当前仓库
 *   node scripts/bootstrap.js --dry-run       # 只检查/报告，不写盘、不装依赖
 *   node scripts/bootstrap.js --skip-deps     # 跳过依赖安装
 *   node scripts/bootstrap.js --no-network    # 跳过网络探测（WD14 健康检查）
 *   node scripts/bootstrap.js --target=<dir>  # 对指定目录自举（用于沙箱验证）
 *   node scripts/bootstrap.js --json          # 机器可读输出
 *
 * 设计约束（硬性）：
 *   - 幂等：连跑两次，第二次必须是「无需改动」的 no-op。
 *   - **绝不改写** `package-lock.json` / `config/default.json` / `prompts/**`（改前改后比对 sha256）。
 *   - **不用 `npm install`**（会把 lock 从 2 空格重排成 4 空格）⇒ 一律 `npm ci`，并**校验 lock 字节未变**。
 * - **依赖安装前必须先 `npm ci --dry-run` 探路**：`npm ci` 会先删掉整个 `node_modules` 再装，
 *     中途失败会把依赖树留在**半毁**状态（实测被正在运行的 GRS 服务占用的 sharp 原生库触发
 *     `EPERM unlink`）。dry-run 不通就**绝不触碰** node_modules。
 *   - 零新依赖（只用 node 内置模块）；**禁止交互**（CI / 无人值守可跑）。
 *   - 失败**清晰报错 + 修复建议**，绝不静默继续。
 *
 * 退出码：0 = 就绪（允许 ）；2 = 阻塞（Node 版本不足 / 依赖安装失败）；1 = 意外错误。
 *
 * 测试钩子（仅用于可证伪验证，生产不设）：`GRS_FAKE_NODE_VERSION=v1.2.3` 可注入假版本号。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPT_ROOT = path.join(__dirname, '..');
const { parseVersion, compareVersions } = require('./check-node');
// 复用单一真相：WD14 地址解析（T08a 新建）——不在此另写一份地址逻辑
const wd14Endpoint = require(path.join(SCRIPT_ROOT, 'src', 'wd14-endpoint.js'));

/** `node:sqlite` 需要的最低 Node 版本。 */
const MIN_NODE = '22.5.0';
/** 运行期目录（幂等创建）。 */
const RUNTIME_DIRS = ['data', 'data/audit_records', 'data/image_blobs', 'data/comparisons', 'data/batch_results', 'logs'];
/** 只提示不阻断的可选依赖 → 影响说明。 */
const OPTIONAL_DEPS = [
  { name: 'sharp', impact: '图片缩图（发送前缩放）不可用 ⇒ 大图直传云端，费用与时延上升；审核本身仍可用' },
  { name: '@alicloud/green20220302', impact: '阿里云内容安全通道不可用 ⇒ 该通道整体缺席（不产生付费调用）' },
];

// ──────────────────────────────────────────────
// 输出与状态
// ──────────────────────────────────────────────
const rows = [];
let changed = false;
const jsonOut = [];

/**
 * 记录一行就绪项。
 * @param {'ok'|'warn'|'fail'} level 级别
 * @param {string} item 项目
 * @param {string} detail 说明
 * @param {string} [action] 建议动作
 * @returns {void}
 */
function row(level, item, detail, action) {
  rows.push({ level, item, detail: detail || '', action: action || '' });
  jsonOut.push({ level, item, detail: detail || '', action: action || '' });
}
/** 普通信息行。 */
function info(msg) { console.log(msg); }

// ──────────────────────────────────────────────
// 参数
// ──────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { dryRun: false, skipDeps: false, noNetwork: false, json: false, target: SCRIPT_ROOT };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-deps') opts.skipDeps = true;
    else if (a === '--no-network') opts.noNetwork = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--target=')) opts.target = path.resolve(a.slice('--target='.length));
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

/** 文件 sha256（不存在返回 null）。 */
function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

// ──────────────────────────────────────────────
// 1. OS / Shell 探测
// ──────────────────────────────────────────────
function detectEnv() {
  const platform = process.platform;
  const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
  const shell = platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : (process.env.SHELL || '/bin/sh');
  const isWin = platform === 'win32';
  info(`▶ [1/9] 环境探测：${osName} / ${process.arch} / shell=${path.basename(shell)}`);
  row('ok', '操作系统 / 架构', `${osName} ${process.arch}`, '');
  row('ok', 'Shell', path.basename(shell), '');
  return { osName, isWin, arch: process.arch };
}

// ──────────────────────────────────────────────
// 2. Node 版本闸门（ 不静默降级）
// ──────────────────────────────────────────────
function checkNode(env) {
  info(`\n▶ [2/9] Node 版本闸门（要求 ≥ ${MIN_NODE}，原因：node:sqlite）`);
  const fake = process.env.GRS_FAKE_NODE_VERSION;
  const raw = fake || process.version;
  const cur = parseVersion(raw);
  const min = parseVersion(MIN_NODE);
  const ok = Boolean(cur && min && compareVersions(cur, min) >= 0);
  if (fake) info(`   （测试钩子 GRS_FAKE_NODE_VERSION=${fake}，实际 ${process.version}）`);
  if (ok) {
    info(`   ✓ Node ${raw} 满足要求`);
    row('ok', 'Node 版本', `${raw}（要求 ≥ ${MIN_NODE}）`, '');
    return true;
  }
  const guide = env.isWin
    ? 'Windows：运行 scripts\\ensure-node.bat（便携版 → 系统 Node → 自动下载 v22.22.2）'
    : 'Linux/macOS：访问 https://nodejs.org/dist/ 或 https://github.com/nvm-sh/nvm 安装 ≥ 22.5.0';
  info(`   ✗ Node ${raw} 低于 ${MIN_NODE}`);
  info(`   → ${guide}`);
  info('   本脚本**不会**静默降级：node:sqlite 缺失会让审核记录双写静默失效，必须先把 Node 升级到位。');
  row('fail', 'Node 版本', `${raw} < ${MIN_NODE}`, guide);
  return false;
}

// ──────────────────────────────────────────────
// 3. 依赖安装（ 只用 npm ci，且校验 lock 字节未变）
// ──────────────────────────────────────────────
function depsStatus(target) {
  const pkgPath = path.join(target, 'package.json');
  if (!fs.existsSync(pkgPath)) return { applicable: false };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { return { applicable: false }; }
  const nm = path.join(target, 'node_modules');
  const lock = path.join(target, 'package-lock.json');
  const deps = Object.keys(pkg.dependencies || {});
  const missing = [];
  for (const d of deps) {
    try { require.resolve(d, { paths: [target] }); } catch { missing.push(d); }
  }
  // 不用 mtime 比较判断「是否已装」——mtime 会被任意一次保存扰动（实测误触发过一次 npm ci）。
  //   改用两个稳定信号：node_modules 存在 + npm 自己写的安装标记 `.package-lock.json` 存在。
  const markerExists = fs.existsSync(path.join(nm, '.package-lock.json'));
  return { applicable: true, deps, missing, nmExists: fs.existsSync(nm), markerExists, lockExists: fs.existsSync(lock) };
}

/** npm 可执行入口（Windows 下 `npm.cmd` 可能被安全策略拦，退回用 node 直跑 npm-cli.js）。 */
function npmInvocation() {
  if (process.platform !== 'win32') return { bin: 'npm', args: [], shell: false };
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(candidate)) return { bin: process.execPath, args: [candidate], shell: false };
  return { bin: 'npm.cmd', args: [], shell: true };
}

/**
 * 安装依赖： 只用 `npm ci`（`npm install` 会把 lock 从 2 空格重排成 4 空格），
 * 且**先 dry-run 探路再真装**。
 *
 * 真实事故（本脚本初版踩过，必须靠预检挡住）：`npm ci` 会**先删掉整个 node_modules 再装**。
 *   若中途失败（实测：`EPERM unlink` —— 正在运行的 GRS 服务占用着 sharp 的原生库
 *   `@img/sharp-win32-x64/lib/*.node|libvips-42.dll`），依赖树会停在**半毁**状态
 *   （node_modules 只剩 1 个残留目录），而 lock 不变 —— 服务随后会因缺包而启动失败。
 *   ⇒ 因此：dry-run 不通就**绝不触碰** node_modules，只报错给修复建议。
 * @param {string} target 目标目录
 * @returns {boolean} 是否已就绪
 */
function installDeps(target) {
  const lock = path.join(target, 'package-lock.json');
  const lockBytesBefore = fs.existsSync(lock) ? fs.readFileSync(lock) : null;
  const lockBefore = lockBytesBefore ? sha256(lock) : null;
  const { bin, args: binArgs, shell } = npmInvocation();
  const spawnOpts = {
    cwd: target, encoding: 'utf-8', timeout: 900000, maxBuffer: 64 * 1024 * 1024, shell,
  };

  info('   ▸ 预检：npm ci --dry-run（不改盘；用来挡住「先删 node_modules 再失败」的半毁风险）');
  const pre = spawnSync(bin, [...binArgs, 'ci', '--dry-run'], spawnOpts);
  const preOut = `${pre.stdout || ''}\n${pre.stderr || ''}`;
  if (pre.status !== 0) {
    const locked = /EPERM[\s\S]{0,300}unlink/.test(preOut);
    const tail = preOut.trim().split(/\r?\n/).slice(-5).join(' | ');
    info(`   ✗ 预检未通过（exit=${pre.status}），**未触碰 node_modules**`);
    info(`     ${tail}`);
    if (locked) {
      info('   → 判断为「依赖文件被占用」：正在运行的 GRS 服务（监听 11451）会加载 sharp 原生库，');
      info('     导致 npm ci 无法删除旧文件。请先停止该服务再重试；或先手动安装。');
    }
    row('fail', '依赖安装', `npm ci 预检失败（exit=${pre.status}）—— 未改动 node_modules`,
      locked ? '先停止正在运行的 GRS 服务（占用 sharp 原生库），再重跑本脚本' : '检查网络/私服配置后重试');
    return false;
  }
  info('   ▸ 预检通过，执行 npm ci ...');
  const r = spawnSync(bin, [...binArgs, 'ci'], spawnOpts);
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const tail = out.trim().split(/\r?\n/).slice(-6).join(' | ');
  const lockAfter = sha256(lock);
  if (lockBefore && lockAfter && lockBefore !== lockAfter) {
    // npm ci 的契约是不改 lock；真改了立刻按跑前字节还原（受保护文件硬约束）
    try {
      fs.writeFileSync(lock, lockBytesBefore);
      info(`   ✗ package-lock.json 被改写（前 ${lockBefore.slice(0, 12)} → 后 ${lockAfter.slice(0, 12)}），已按跑前字节还原`);
    } catch (e) {
      info(`   ✗ package-lock.json 被改写且还原失败：${e.message}`);
    }
    row('fail', '依赖安装', 'npm ci 改写了 package-lock.json（已尝试还原）', '检查 npm 版本；lock 必须保持 2 空格缩进不变');
    return false;
  }
  if (r.status !== 0) {
    info(`   ✗ npm ci 失败（exit=${r.status}）：${tail}`);
    row('fail', '依赖安装', `npm ci exit=${r.status}`, '检查网络/私服配置；或先手动 npm ci 后加 --skip-deps');
    return false;
  }
  info(`   ✓ 依赖安装完成（lock sha 未变：${lockBefore ? lockBefore.slice(0, 12) : '(无 lock)'}）`);
  return true;
}

function ensureDeps(target, opts) {
  info('\n▶ [3/9] 依赖检查');
  const st = depsStatus(target);
  if (!st.applicable) {
    info('   ⚠ 目标目录无 package.json，跳过依赖检查');
    row('warn', '依赖', '无 package.json，已跳过', '');
    return true;
  }
  if (st.nmExists && st.missing.length === 0 && st.markerExists) {
    info(`   ✓ node_modules 完整（${st.deps.length} 个直接依赖均可解析），无需改动`);
    row('ok', '依赖', `${st.deps.length} 个直接依赖齐备`, '');
    return true;
  }
  const why = !st.nmExists ? 'node_modules 不存在'
    : (st.missing.length ? `缺 ${st.missing.length} 个：${st.missing.slice(0, 5).join(',')}` : '缺少 npm 安装标记（node_modules/.package-lock.json）');
  info(`   → 需要安装（${why}）`);
  if (opts.dryRun) {
    row('warn', '依赖', `需要安装（${why}）—— --dry-run 未执行`, '去掉 --dry-run 或手动 npm ci');
    return true;
  }
  if (opts.skipDeps) {
    row('warn', '依赖', `缺少（${why}）—— 已按 --skip-deps 跳过`, '手动 npm ci');
    return true;
  }
  const ok = installDeps(target, opts);
  row(ok ? 'ok' : 'fail', '依赖', ok ? '已用 npm ci 安装（lock 未变）' : `安装失败（${why}）`, ok ? '' : '检查网络后重试');
  if (ok) changed = true;
  return ok;
}

// ──────────────────────────────────────────────
// 4. 运行期目录（幂等）
// ──────────────────────────────────────────────
function ensureDirs(target, opts) {
  info('\n▶ [4/9] 运行期目录');
  const made = [];
  for (const d of RUNTIME_DIRS) {
    const abs = path.join(target, d);
    if (fs.existsSync(abs)) continue;
    if (opts.dryRun) { made.push(d + '(dry-run)'); continue; }
    try { fs.mkdirSync(abs, { recursive: true }); made.push(d); } catch (e) { info(`   ✗ 创建 ${d} 失败：${e.message}`); }
  }
  if (made.length === 0) {
    info(`   ✓ 全部就绪（${RUNTIME_DIRS.join(', ')}）`);
    row('ok', '运行期目录', `齐备（${RUNTIME_DIRS.length} 个）`, '');
  } else {
    info(`   → 新建：${made.join(', ')}`);
    row('ok', '运行期目录', `新建 ${made.join(', ')}`, '');
    changed = true;
  }
  return true;
}

// ──────────────────────────────────────────────
// 5. 配置种子（ 已存在绝不覆盖）
// ──────────────────────────────────────────────
function seedConfig(target, opts) {
  info('\n▶ [5/9] 配置种子');
  const target_ = path.join(target, 'config', 'default.json');
  const example = path.join(target, 'config', 'default.example.json');
  if (fs.existsSync(target_)) {
    info(`   ✓ config/default.json 已存在 —— **跳过，绝不覆盖**（用户配置神圣）`);
    row('ok', '配置', 'default.json 已存在（未触碰）', '');
    return true;
  }
  if (!fs.existsSync(example)) {
    info('   ✗ 既无 config/default.json 也无 default.example.json');
    row('fail', '配置', '缺少 config/default.json 且无 example 可种子', '确认仓库完整（config/default.example.json 应随仓库发布）');
    return false;
  }
  if (opts.dryRun) {
    info('   → 需要从 example 种子（--dry-run 未执行）');
    row('warn', '配置', '需要种子（dry-run 未执行）', '去掉 --dry-run');
    return true;
  }
  try {
    fs.mkdirSync(path.dirname(target_), { recursive: true });
    fs.copyFileSync(example, target_);
    info('   ✓ 已从 config/default.example.json 种子出 config/default.json');
    row('ok', '配置', '已从 example 种子', '');
    changed = true;
  } catch (e) {
    info(`   ✗ 种子失败：${e.message}`);
    row('fail', '配置', `种子失败：${e.message}`, '检查目录权限');
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────
// 6. 提示词检查（只提示，给可执行指引）
// ──────────────────────────────────────────────
function checkPrompts(target) {
  info('\n▶ [6/9] 提示词（prompts/）');
  const dir = path.join(target, 'prompts');
  if (!fs.existsSync(dir)) {
    info('   ⚠ prompts/ 目录不存在');
    info('   → 提示词**不进公开仓库**（含安全策略，属私有资产）。');
    info('   → 修复：从私有仓库/团队共享获取 prompts/ 放到项目根；参见 prompts/README.md 与 prompts/download_guide.md。');
    info('   → 影响：缺失的提示词会让对应调用报 PROMPT_MISSING（审核无法完成，不是静默降级）。');
    row('warn', '提示词', 'prompts/ 目录不存在', '先补齐 prompts/（README.md / download_guide.md 有指引），否则报 PROMPT_MISSING');
    return true;
  }
  const files = fs.readdirSync(dir);
  const examples = files.filter((f) => f.endsWith('.example.md'));
  const required = examples.map((f) => f.replace(/\.example\.md$/, '.md'));
  const missing = required.filter((f) => !files.includes(f));
  const noReadme = !files.includes('README.md');
  if (missing.length === 0 && !noReadme) {
    info(`   ✓ 齐备（${required.length} 个正式提示词 + README.md）`);
    row('ok', '提示词', `${required.length} 个正式文件 + README.md 齐备`, '');
    return true;
  }
  // 只要不齐备就把「影响 + 怎么修」讲全（新克隆者必然撞上这一步，不能只说一句「缺文件」）
  if (noReadme) info('   ⚠ 缺 prompts/README.md（说明与获取方式）');
  if (missing.length) info(`   ⚠ 缺 ${missing.length} 个正式提示词：${missing.join(', ')}`);
  if (examples.length === 0) info('   ⚠ 连 *.example.md 模板都没有（无法就地补齐）');
  info('   → 提示词**不进公开仓库**（含安全策略，属私有资产）。');
  info('   → 修复：从私有仓库/团队共享取得 prompts/ 放到项目根；说明见 prompts/README.md 与 prompts/download_guide.md。');
  info('   → 补齐方式：每个 *.example.md 对应一个同名正式文件（去掉 .example）——以 example 为模板即可。');
  info('   → **影响**：缺失的提示词会让对应审核调用报 PROMPT_MISSING 并中断，**不会**拿示例内容顶替、也不会静默降级。');
  row('warn', '提示词', `${missing.length ? '缺 ' + missing.join(', ') : ''}${noReadme ? ' 缺 README.md' : ''}`.trim() || '提示词不齐备',
    '按 prompts/*.example.md 补齐同名正式文件；否则对应调用报 PROMPT_MISSING');
  return true;
}

// ──────────────────────────────────────────────
// 7. 可选依赖体检（只提示）
// ──────────────────────────────────────────────
function checkOptionalDeps(target) {
  info('\n▶ [7/9] 可选依赖体检（只提示，不阻断）');
  const absent = [];
  for (const d of OPTIONAL_DEPS) {
    let ok = false;
    try { require.resolve(d.name, { paths: [target] }); ok = true; } catch { ok = false; }
    if (ok) info(`   ✓ ${d.name} 已安装`);
    else { info(`   ⚠ ${d.name} 未安装 —— ${d.impact}`); absent.push(d.name); }
  }
  if (absent.length === 0) row('ok', '可选依赖', `sharp / 内容安全 SDK 均已安装`, '');
  else row('warn', '可选依赖', `缺 ${absent.join(', ')}（不影响启动）`, '按需安装；缺 sharp 会放大云端费用与时延');
  return true;
}

// ──────────────────────────────────────────────
// 8. 可选能力体检：WD14 服务（复用 wd14-endpoint 单一真相）
// ──────────────────────────────────────────────
async function checkWd14(target, opts) {
  info('\n▶ [8/9] 可选能力体检：WD14 标签服务（只提示）');
  // 单一真相：站点配置 → 插件配置 → 内置默认，全部经 src/wd14-endpoint.js
  let siteCfg = {};
  try { siteCfg = JSON.parse(fs.readFileSync(path.join(target, 'config', 'default.json'), 'utf-8')).wd14 || {}; } catch { siteCfg = {}; }
  let pluginCfg = {};
  try { pluginCfg = JSON.parse(fs.readFileSync(path.join(target, 'data', 'plugin-config.json'), 'utf-8'))['wd14-tagger'] || {}; } catch { pluginCfg = {}; }
  const resolved = wd14Endpoint.resolveWd14From(siteCfg, pluginCfg);
  if (opts.noNetwork) {
    info(`   ⚠ 已按 --no-network 跳过探测（解析地址=${resolved.host}，来源=${resolved.source}）`);
    row('warn', 'WD14 服务', `未探测（--no-network）；地址=${resolved.host}`, '');
    return true;
  }
  let ok = false;
  try {
    const res = await fetch(`${resolved.host}/health`, { signal: AbortSignal.timeout(3000) });
    ok = res.ok;
  } catch { ok = false; }
  if (ok) {
    info(`   ✓ WD14 可达：${resolved.host}（地址来源=${resolved.source}）`);
    row('ok', 'WD14 服务', `可达 ${resolved.host}`, '');
  } else {
    info(`   ⚠ WD14 不可达：${resolved.host}（地址来源=${resolved.source}）`);
    info('   → 影响：图像同步标签通道会被跳过（真实原因记为 service-unreachable，不再误报 not-configured）。');
    info('   → 需要时运行 start-wd14.bat 启动本地标签服务；不需要可忽略。');
    row('warn', 'WD14 服务', `不可达 ${resolved.host}`, '需要则启动 start-wd14.bat；否则忽略');
  }
  return true;
}

// ──────────────────────────────────────────────
// 9. 汇总
// ──────────────────────────────────────────────
function summarize(opts) {
  const icon = (l) => (l === 'ok' ? '✅' : l === 'warn' ? '⚠️ ' : '❌');
  const failCount = rows.filter((r) => r.level === 'fail').length;
  const warnCount = rows.filter((r) => r.level === 'warn').length;
  info('\n▶ [9/9] 环境就绪表');
  for (const r of rows) {
    info(`${icon(r.level)} ${r.item.padEnd(18)} ${r.detail}`);
    if (r.action) info(`     ↳ 建议：${r.action}`);
  }
  info(`\n本次改动：${changed ? '有（见上）' : '无'}`);
  info(`结论：${failCount === 0
    ? (warnCount === 0 ? '环境已就绪（全部通过，无改动）' : `环境已就绪（${warnCount} 项为可选/提示，不阻断启动）`)
    : `阻塞：${failCount} 项必须修复后才能启动`}`);
  if (opts.json) console.log('\n' + JSON.stringify({ changed, rows: jsonOut }, null, 2));
  return failCount === 0 ? 0 : 2;
}

// ──────────────────────────────────────────────
// main
// ──────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    info('用法: node scripts/bootstrap.js [--dry-run] [--skip-deps] [--no-network] [--target=<dir>] [--json]');
    return 0;
  }
  const env = detectEnv();
  info(`   目标目录：${opts.target}${opts.dryRun ? '（--dry-run：不写盘）' : ''}`);

  // 完整性基线：受保护文件的 sha256（跑前）
  const protectedFiles = [
    path.join(opts.target, 'package-lock.json'),
    path.join(opts.target, 'config', 'default.json'),
  ];
  const before = new Map(protectedFiles.map((f) => [f, sha256(f)]));

  const nodeOk = checkNode(env);
  let ok = true;
  if (!nodeOk) {
    // Node 不满足 ⇒ 后续步骤无意义（但仍在汇总里给出完整表）
    info('\n⚠ Node 版本不足，已跳过依赖/目录/配置步骤（先修 Node）。');
    const code = summarize(opts);
    info(`\n（Node 闸门失败：退出码 ${code}）`);
    return code;
  }

  ok = ensureDeps(opts.target, opts) && ok;
  ensureDirs(opts.target, opts);
  ok = seedConfig(opts.target, opts) && ok;
  checkPrompts(opts.target);
  checkOptionalDeps(opts.target);
  await checkWd14(opts.target, opts);

  // 受保护文件必须逐字节未变
  // 注意「跑前不存在、跑后存在」= **本脚本按设计种子出来的新文件**（新克隆的首次运行），
  //     不是「被改写」——只有「跑前存在且字节变了」才算违规（否则新克隆会被误报失败）。
  info('\n▶ 受保护文件校验（package-lock.json / config/default.json）');
  for (const f of protectedFiles) {
    const a = before.get(f);
    const b = sha256(f);
    const rel = path.relative(opts.target, f) || f;
    if (a === b) info(`   ✓ ${rel} 未变（${a ? a.slice(0, 12) : '不存在'}）`);
    else if (a === null && b !== null) info(`   ✓ ${rel} 由种子创建（跑前不存在 → 跑后新增，符合预期；不覆盖任何已有内容）`);
    else { info(`   ✗ ${rel} 被改写（${a ? a.slice(0, 12) : '无'} → ${b ? b.slice(0, 12) : '无'}）`); row('fail', '受保护文件', `${path.basename(f)} 被改写`, '回退该文件'); ok = false; }
  }
  // prompts/** 逐文件比对
  const promptsDir = path.join(opts.target, 'prompts');
  if (fs.existsSync(promptsDir)) {
    const hashes = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else hashes.push(`${path.relative(promptsDir, p)}:${sha256(p)}`);
      }
    }(promptsDir));
    info(`   ✓ prompts/** 共 ${hashes.length} 个文件（本脚本只读，未写入）`);
  }

  const code = summarize(opts);
  return ok ? code : 2;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`bootstrap 意外失败：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
