/**
 * 发布前闸门（REPO-05）—— scripts/pre-publish-check.js
 *
 * 用法：
 *   node scripts/pre-publish-check.js                     # 扫描仓库（默认只扫「会被发布」的文件）
 *   node scripts/pre-publish-check.js --path=<dir>        # 只扫指定目录（可重复，用于自测）
 *   node scripts/pre-publish-check.js --json              # 机器可读输出
 *   node scripts/pre-publish-check.js --no-git            # 忽略 git，纯文件系统遍历
 *   node scripts/pre-publish-check.js --max-fail=warn     # 只让 error 级失败（默认即此）
 *
 * 检查项：
 *   SECRET   密钥/凭据特征（GitHub PAT / OpenAI-ish / 阿里云 AK / 私钥块 …）      → FAIL
 *   LOCALPATH 本机绝对路径（项目绝对路径、用户主目录、非系统盘符等）   → FAIL
 *   SENSITIVE 敏感/本地专属文件误入发布集（敏感词库、真实配置、审计记录、.env）  → FAIL
 *   LARGE     非必要大文件（> 100KB）                                             → WARN
 *   PLACEHOLDER 占位符残留（YOUR_xxx / CHANGE_ME）                                 → WARN
 *   DEBUG     调试残留（console.log 等）                                           → WARN
 *   HYGIENE   裸控制/不可见字符（会让文件在 GBK 往返中损坏 → 数据事故）              → FAIL
 *
 * 安全约定（硬性）：**只输出文件名 + 行号 + 规则 ID，绝不回显匹配到的内容本身**，
 * 避免把真实凭据或敏感词写进 CI 日志。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

/** 默认不扫描的目录名（发布集之外的运行时产物）。 */
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'logs', 'temp', 'tmp', 'dist', 'build',
  '.vscode', '.idea', 'coverage', '.cache',
  '.workbuddy', // 本地工具链产物（记忆/会话日志），不属于发布集
]);

/** 默认不扫描的相对路径前缀（运行时数据 / 本机专属）。 */
const IGNORED_PREFIXES = [
  'data/audit_records/',
  'data/uploads/',
  'data/injection_signals/',
  'data/comparisons/',   // 模型对比运行时产物（体积大且含历史原文）
  'config/default.json',
  'config/default.corrupt-',
];

/** 设计上就应当存在占位符的文件（示例配置），不产生占位符告警。 */
const PLACEHOLDER_ALLOWLIST = new Set([
  'config/default.example.json',
]);

/** 同一 (规则, 文件) 最多输出的命中条数，超出聚合成一行，避免刷屏。 */
const MAX_HITS_PER_FILE = 5;

/** 视为二进制的扩展名（含内容，不做正则扫描）。 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
  '.zip', '.gz', '.7z', '.rar', '.pdf', '.mp4', '.mov', '.mp3', '.wav',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.exe', '.dll', '.so', '.dylib',
  '.onnx', '.bin', '.safetensors', '.pt', '.db', '.sqlite',
]);

/** 大文件阈值（字节）。 */
const LARGE_FILE_BYTES = 100 * 1024;

/** 单文件内容扫描上限（超过则跳过正则扫描，仅做体积检查）。 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

// ── 规则 1：密钥/凭据特征 ──
// 注意：模式内的 'ghp_' 等字面量不会被自身命中（后面紧跟的是字符类而非 36 位字母数字）。
const SECRET_PATTERNS = [
  { id: 'SECRET/github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'SECRET/openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'SECRET/openai-svc', re: /\bsk-sp-[A-Za-z0-9]{20,}\b/ },
  { id: 'SECRET/aliyun-ak', re: /\bLTAI[A-Za-z0-9]{12,}\b/ },
  { id: 'SECRET/aws-akid', re: /\bAKIA[A-Z0-9]{12,}\b/ },
  { id: 'SECRET/private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'SECRET/slack-token', re: /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'SECRET/google-api', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
];

// ── 规则 2：本机绝对路径 ──
// 注意：源码里的 Windows 路径常被转义成双反斜杠（'C:\\foo\\bar'），
// 因此分隔符统一用 [\\/]{1,4} 匹配，否则会出现「文件里明明写了本机路径却检不出」的漏报。
const SEP = '[\\\\/]{1,4}';
const LOCAL_PATH_PATTERNS = [
  { id: 'LOCALPATH/win-botdir', re: new RegExp(`[A-Za-z]:${SEP}bot-moderation-cloud[^\\s"']*`) },
  { id: 'LOCALPATH/win-users', re: new RegExp(`[A-Za-z]:${SEP}Users${SEP}[A-Za-z0-9._-]+`) },
  { id: 'LOCALPATH/win-other-drive', re: new RegExp(`\\b[D-Zd-z]:${SEP}(?:llm|Users|users)${SEP}[A-Za-z0-9._-]+`) },
  { id: 'LOCALPATH/unix-home', re: /\/(?:home|Users)\/[a-z][a-z0-9._-]{2,}\/(?:projects|workspace|dev|src|llm|bot)/ },
];

// ── 规则 3：敏感/本地专属文件 ──
const SENSITIVE_FILE_PATTERNS = [
  { id: 'SENSITIVE/sensitive-words', re: /(^|\/)data\/sensitive_words\.json(\.bak)?$/i },
  { id: 'SENSITIVE/real-config', re: /(^|\/)config\/default\.json$/i },
  { id: 'SENSITIVE/env-file', re: /(^|\/)\.env(\.|$)/i },
  { id: 'SENSITIVE/audit-records', re: /(^|\/)data\/audit_records\//i },
  { id: 'SENSITIVE/logs', re: /(^|\/)logs\//i },
  { id: 'SENSITIVE/private-note', re: /待后续筛选|_私有|private[-_]notes/i },
  { id: 'SENSITIVE/github-upload-doc', re: /(^|\/)GITHUB_UPLOAD\.md$/i },
];

// ── 规则 3.5（T09）：未跟踪文件的「敏感文件名」纵深防御 ──
// 上位防线是 .gitignore；本规则盯住**仍然漏网**的名字形态（例如新出现的备份命名约定）。
// 只按**文件名**判定，绝不读取内容，因此不会把凭据写进日志。
const UNTRACKED_SECRET_NAME_PATTERNS = [
  { id: 'REPO/untracked-secret-file', re: /(^|\/)config\/.*\.(?:bak|backup|old|orig)[^/]*$/i, note: 'config 备份副本（实测含真实 API Key / 密码）' },
  { id: 'REPO/untracked-secret-file', re: /(^|\/)config\/default\.json$/i, note: 'config 真实配置（含凭据）' },
  { id: 'REPO/untracked-secret-file', re: /(^|\/)\.env(?:\.[^/]*)?$/i, note: '环境变量文件' },
  { id: 'REPO/untracked-secret-file', re: /(^|\/)data\/sensitive_words\.json(?:\.bak)?$/i, note: '真实敏感词库' },
  { id: 'REPO/untracked-secret-file', re: /\.(?:pem|p12|pfx|key|keystore)$/i, note: '密钥/证书文件' },
  { id: 'REPO/untracked-secret-file', re: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i, note: 'SSH 私钥' },
  { id: 'REPO/untracked-secret-file', re: /(^|\/)\.(?:npmrc|pypirc|netrc)$/i, note: '包管理器凭据文件' },
];

/** 未跟踪**单文件**体积阈值（字节）。超过即 error。 */
const UNTRACKED_BLOB_BYTES = 1024 * 1024;

// ── 规则 3.6（T10）：文本源码不得含 raw 控制字节 / 不可见格式字符 ──
// 背景（真实事故，P0）：`src/security/output-schema.js` 曾在正则字符类里内嵌**裸**不可见字符
//   （U+200B / U+202A 作为区间端点）。这类文件**无法用 GBK 编码**：任何以 GBK 往返的工具都会
//   把 U+200B 变成 `U+FFFD` 加 `?`，而该 `?` 紧挨 `-` 就构成新区间 `U+003F-U+200F`，
//   **吞掉全部 ASCII 字母**（实测 `sanitizeFreeText('Hello World 123')` 只返回 `'123'`）。
// 规则：不可见/控制字符一律写成 ASCII 转义（`\u200b` / `\x00`），源码本身保持纯 ASCII 可编码。
const ENCODING_RULE_ID = 'HYGIENE/raw-control-char';

/**
 * 不该以「裸字符」出现在文本源码里的码点区间（写成转义即可，运行时完全相同）。
 * 有意排除 `\t`(U+0009) / `\n`(U+000A) / `\r`(U+000D) —— 它们是合法的文本空白。
 */
const RAW_FORBIDDEN_RANGES = Object.freeze([
  { lo: 0x0000, hi: 0x0008, label: 'C0 控制' },
  { lo: 0x000b, hi: 0x000c, label: 'C0 控制' },
  { lo: 0x000e, hi: 0x001f, label: 'C0 控制' },
  { lo: 0x007f, hi: 0x009f, label: 'DEL/C1 控制' },
  { lo: 0x200b, hi: 0x200f, label: '零宽' },
  { lo: 0x202a, hi: 0x202e, label: '双向控制' },
  { lo: 0x2060, hi: 0x2069, label: '不可见格式' },
  { lo: 0xfeff, hi: 0xfeff, label: '零宽/BOM' },
  { lo: 0x00ad, hi: 0x00ad, label: '软连字符' },
]);

// ── 规则 4：占位符残留（WARN） ──
const PLACEHOLDER_PATTERNS = [
  { id: 'PLACEHOLDER/your-key', re: /\bYOUR_[A-Z0-9_]{3,}\b/ },
  { id: 'PLACEHOLDER/change-me', re: /\bCHANGE_ME\b/ },
];

// ── 规则 5：调试残留（WARN） ──
const DEBUG_PATTERNS = [
  { id: 'DEBUG/console-log', re: /^\s*console\.log\(/ },
  { id: 'DEBUG/todo-fixme', re: /\b(?:TODO|FIXME|XXX)\b/ },
];

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数列表
 * @returns {{paths: string[], json: boolean, useGit: boolean, maxFail: string}} 选项
 */
function parseArgs(argv) {
  const options = { paths: [], json: false, useGit: true, maxFail: 'error' };
  for (const arg of argv) {
    if (arg.startsWith('--path=')) options.paths.push(arg.slice('--path='.length));
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-git') options.useGit = false;
    else if (arg.startsWith('--max-fail=')) options.maxFail = arg.slice('--max-fail='.length);
  }
  return options;
}

/**
 * 是否应跳过该相对路径。
 * @param {string} relPath 相对路径（posix 风格）
 * @returns {boolean} 是否跳过
 */
function shouldSkip(relPath) {
  const parts = relPath.split('/');
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  return IGNORED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * 列出待扫描文件（相对路径，posix 风格）。
 * 优先使用 git ls-files：语义即「会被发布的文件」，天然排除 gitignore 项。
 * @param {object} options 选项
 * @returns {{files: string[], source: string}} 文件列表与来源
 */
function listFiles(options) {
  if (options.paths.length > 0) {
    return { files: listByWalk(options.paths.map((p) => path.resolve(PROJECT_ROOT, p))), source: 'path-args' };
  }

  if (options.useGit) {
    try {
      const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const files = out.split('\0').filter(Boolean).map((f) => f.split(path.sep).join('/'));
      if (files.length > 0) return { files, source: 'git-ls-files' };
    } catch {
      // git 不可用 / 非仓库 → 回退文件系统遍历
    }
  }
  return { files: listByWalk([PROJECT_ROOT]), source: 'fs-walk' };
}

/**
 * 文件系统遍历（回退路径）。
 * @param {string[]} roots 根目录（绝对路径）
 * @param {string} [base] 计算相对路径的基准目录（默认仓库根；测试沙盒可注入）
 * @returns {string[]} 相对路径列表
 */
function listByWalk(roots, base) {
  const baseDir = base || PROJECT_ROOT;
  const out = [];
  const visit = (absDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(baseDir, abs).split(path.sep).join('/');
      if (shouldSkip(rel)) continue;
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(rel);
    }
  };
  for (const root of roots) visit(root);
  return out;
}

/**
 * 列出**未跟踪且未被忽略**的文件（`git ls-files --others --exclude-standard`）。
 *
 * 为什么需要它：`listFiles()` 走 `git ls-files`（只列**已跟踪**文件），而
 * `git-upload.bat` 用的是 `git add -A` —— 它会把手写忽略规则之外的一切都收进下一次提交。
 * 于是出现**盲区**：真实凭据备份、600MB 的 `wd14/.venv` 在「已跟踪清单」里看不见，
 * 却会真的被推上去。本函数把这块盲区补回门禁视野。
 * @param {string} [root] 仓库根目录
 * @returns {{files: string[], source: string}} 未跟踪文件列表与来源
 */
function listUntrackedFiles(root) {
  const cwd = root || PROJECT_ROOT;
  try {
    const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 末尾带 `/` 的是「整个未跟踪目录」的聚合项，展开它才能逐个算体积
    const entries = out.split('\0').filter(Boolean).map((f) => f.split(path.sep).join('/'));
    const files = [];
    for (const rel of entries) {
      if (rel.endsWith('/')) files.push(...listByWalk([path.join(cwd, rel.replace(/\/$/, ''))]));
      else files.push(rel);
    }
    return { files, source: 'git-ls-files-others' };
  } catch {
    return { files: [], source: 'unavailable' };
  }
}

/**
 * T09：未跟踪文件的仓库卫生检查（**可注入**，便于独立造反例验证）。
 *
 * 背景（真实事故，P0）：本仓库 `git-upload.bat` 用 `git add -A` 上传，而此前门禁只看
 * `git ls-files`（已跟踪），于是两个会阻断上传的问题长期不可见：
 *   ① `config/default.json.bak-2026-09-16T04-52-28-472Z` —— **真实凭据**（阿里云 AK/Secret、
 *      两个约 116 字符的 apiKey、库/后台密码）的备份副本，随时会被 `add -A` 推上公开仓库；
 *   ② `wd14/.venv` —— 约 1.5 万个文件 / 600MB 的 Python 虚拟环境，会把仓库撑爆。
 * 对应修复是 `.gitignore` 加 `config/*.bak*` 与 `.venv/`；本规则是**纵深防御**：
 * 若今后有人换了一种备份命名、或把 venv 挪到别的路径，这里仍会拦下。
 * @param {{root?: string, files?: string[]}} [opts] 可注入根目录/文件清单（供独立验证）
 * @returns {{checked: number, files: string[], findings: Array<{rule: string, file: string, note: string}>}} 结果
 */
function checkUntrackedHygiene(opts = {}) {
  const root = opts.root || PROJECT_ROOT;
  const files = opts.files !== undefined ? opts.files : listUntrackedFiles(root).files;
  const findings = [];
  for (const rel of files) {
    for (const pattern of UNTRACKED_SECRET_NAME_PATTERNS) {
      if (pattern.re.test(rel)) {
        findings.push({ rule: pattern.id, file: rel, note: `${pattern.note}；请加进 .gitignore（勿删除本地文件）` });
      }
    }
    let size = 0;
    try { size = fs.statSync(path.join(root, rel)).size; } catch { size = 0; }
    if (size > UNTRACKED_BLOB_BYTES) {
      findings.push({ rule: 'REPO/untracked-large-blob', file: rel, note: `${(size / 1048576).toFixed(2)}MB 大文件会被 git add -A 收进提交；请加进 .gitignore 或移出仓库` });
    }
  }
  return { checked: files.length, files, findings };
}

/**
 * T10：扫描文本源码里的**裸**控制 / 不可见格式字符（规则 3.6）。
 *
 * 只报「码点位置」不回显内容（与其它规则同一安全约定）。CR/LF/TAB 合法，不在区间内。
 * 文件读不到 / 超扫描上限一律跳过。**刻意不做「含 NUL 视为二进制」跳过**：GBK 往返正是
 *   同时产生 NUL 与裸不可见字符（事故文件本体含 1 个 NUL），若见 NUL 就返回，会让「同一份
 *   文件只多一个 NUL 字节 ⇒ 命中从 14 个塌成 0 个」——这是子集违反，门禁对它存在的理由失效。
 *   真正的二进制改由 `BINARY_EXT`（`main()`）+ `MAX_SCAN_BYTES` + `git ls-files` 三重兜住。
 * @param {string} relPath 相对路径
 * @param {string} [baseDir] 基准目录（默认仓库根；测试沙盒可注入）
 * @returns {Array<{rule: string, file: string, line: number, cps: string[]}>} 命中
 */
function scanRawControlChars(relPath, baseDir) {
  const abs = path.join(baseDir || PROJECT_ROOT, relPath);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return [];
  }
  if (buf.length > MAX_SCAN_BYTES) return [];
  // U+0000 由 RAW_FORBIDDEN_RANGES 首条 {lo:0,hi:8} 自然报出，无需（也不得）在此处提前返回
  const text = buf.toString('utf-8');

  const hits = [];
  const cpsByLine = new Map();
  let line = 1;
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i);
    if (cp === 0x0a) line += 1;
    if (cp > 0xffff) i += 1; // 代理对
    let bad = false;
    for (const range of RAW_FORBIDDEN_RANGES) {
      if (cp >= range.lo && cp <= range.hi) { bad = true; break; }
    }
    if (bad) {
      if (!cpsByLine.has(line)) cpsByLine.set(line, new Set());
      cpsByLine.get(line).add('U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
    }
  }
  for (const [ln, set] of cpsByLine) {
    hits.push({ rule: ENCODING_RULE_ID, file: relPath, line: ln, cps: [...set] });
  }
  return hits;
}

/**
 * 逐行匹配规则，返回「只含文件与行号」的命中列表（不回显内容）。
 * @param {string} relPath 相对路径
 * @param {Array<{id: string, re: RegExp}>} patterns 规则
 * @returns {Array<{rule: string, file: string, line: number}>} 命中
 */
function scanLines(relPath, patterns) {
  const abs = path.join(PROJECT_ROOT, relPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return [];
  }
  if (stat.size > MAX_SCAN_BYTES) return [];

  let text;
  try {
    text = fs.readFileSync(abs, 'utf-8');
  } catch {
    return [];
  }
  // T10：**不再**「含 NUL 即视作二进制跳过」——那会让 SECRET/LOCALPATH/PLACEHOLDER/DEBUG
  //   四条规则对「GBK 往返损坏过的文件」同时失明（事故文件恰含 NUL）。二进制由 BINARY_EXT 拦截。

  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      if (pattern.re.test(line)) hits.push({ rule: pattern.id, file: relPath, line: i + 1 });
    }
  }
  return hits;
}

/**
 * 主流程。
 */
/**
 * 极简语义化版本比较（只比较数字段；与 src/plugin-scanner.js#compareVersion 同口径）。
 * @param {string} a 版本 A
 * @param {string} b 版本 B
 * @returns {number} a>b → 1，a<b → -1，相等 → 0
 */
function compareVersions(a, b) {
  const pa = String(a || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * T08b ③：宿主版本 ↔ 插件清单 `host.minVersion` 耦合检查。
 *
 * 背景（真实事故）：`HOST_VERSION` 直接读 `package.json.version`
 *   （`src/host-api/contract.js`），而装载期会用 `host.minVersion` 把插件判为
 *   `invalid` 并**拒载**（`src/plugin-scanner.js`）。把版本号**下调**会**静默**让插件失效
 *   —— 曾把 version 重置为 0.1.0，导致 `aliyun-content-safety` 与 `batch-image-suite`
 *   两个插件被拒载且没有明显报错。
 *
 * 规则：`package.json.version` 必须 **≥** 每个 `plugins/<id>/manifest.json` 的 `host.minVersion`。
 * @param {{root?: string, pluginsDir?: string, version?: string}} [opts] 可注入根目录/版本（供独立验证）
 * @returns {{version: string, incompatible: Array<{id: string, minVersion: string}>}} 检查结果
 */
function checkHostVersionCoupling(opts = {}) {
  const root = opts.root || PROJECT_ROOT;
  const pluginsDir = opts.pluginsDir || path.join(root, 'plugins');
  let version;
  if (opts.version !== undefined) {
    version = String(opts.version);
  } else {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    version = String((pkg && pkg.version) || '0.0.0');
  }
  const incompatible = [];
  let ids = [];
  try {
    ids = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    ids = [];
  }
  for (const dirName of ids) {
    const manifestPath = path.join(pluginsDir, dirName, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue; // 清单损坏由其它规则覆盖，此处不重复报
    }
    const minVersion = manifest && manifest.host && manifest.host.minVersion;
    if (minVersion && compareVersions(version, String(minVersion)) < 0) {
      incompatible.push({ id: (manifest && manifest.id) || dirName, minVersion: String(minVersion) });
    }
  }
  return { version, incompatible };
}

// ─── T07b：文案风格门禁（注释）────────────────────────────────────────────
//
// 背景：用户要求「别在代码上写太多 AI 注释」。清理按轮推进（T07b=`src/**`，
// T07c=`scripts/**`+`public/index.html`），因此用 **ratchet（只降不升）**：
//   高于基线 ⇒ error（反弹）；未清零但仍 ≤ 基线 ⇒ warn（待清）；基线为 0 时任何出现 ⇒ error。
// 清完某域后请把 `STYLE_BASELINE` 对应数字**下调**（只许下调）。
// T08e：`STYLE/star-decoration` **只扫注释内的星号装饰** —— 字符串里的 `` 是页面要渲染的
//   功能字符（如默认模型徽标），不算装饰、不参与计数（见 `countCommentStars`）。

/**
 * 被测试按注释切片抽取的**受保护**标记块（ 统计豁免）。
 * 来源：`scripts/qa-t06-t08.js` 的 `sliceMarked()` 调用点 + `public/index.html` 内全部 `====` 标记。
 * 新增/改名标记时**必须**同步加到这里，否则会把测试用的标记当成装饰性星级而误报。
 */
const PROTECTED_MARKERS = Object.freeze([
  ['/* ==== T06-C:', '/* ==== end T06-C ==== */'],
  ['/* ==== shared: model label (testable) ==== */', '/* ==== end shared: model label ==== */'],
  ['/* ==== T07: tab visibility core (testable) ==== */', '/* ==== end T07 core ==== */'],
  ['/* ==== T07: compare tab availability (testable) ==== */', '/* ==== end T07 availability ==== */'],
  ['/* ==== T08b: topology-derived copy (testable) ==== */', '/* ==== end T08b topology-derived copy ==== */'],
  ['/* ==== R7: panel channels (testable) ==== */', '/* ==== end R7 ==== */'],
]);

/** 门禁作用域：只统计这三处（其余目录不参与，避免误伤文档/示例）。 */
const STYLE_SCOPES = Object.freeze(['src/', 'scripts/', 'public/index.html']);
/** 注释行占比告警阈值。 */
const MAX_COMMENT_RATIO = 0.4;
/** 连续注释行数告警阈值（JSDoc 块豁免）。 */
const MAX_COMMENT_BLOCK = 10;
/** 星号装饰字符（装饰性前缀，非受保护标记）。 */
const STAR_CHAR = '\u2605';

/**
 * 风格 ratchet 基线（只降不升）。
 * T07c 后三个域**均已清零**：`src` / `scripts` / `public/index.html` 全为 0
 * （`index.html` 内受保护标记块中的装饰由 `maskProtectedBlocks` 豁免，不计入）。
 * 此后任何一处新增星号装饰都会直接判 error。
 */
const STYLE_BASELINE = Object.freeze({
  star: { src: 0, scripts: 0, 'public/index.html': 0 },
  ratio: {},
  emoji: 0,
});

/** 注释以 emoji 开头（U+1F000-1FAFF 段 + 少量常用装饰符号）。
 *  注意：不能把 U+2600-27BF 整段算作 emoji —— 星号装饰 U+2605 属于该段，会与 star 规则重叠。 */
const EMOJI_PREFIX = /^\s*(\/\/|\/\*+|\*)\s*[\u{1F000}-\u{1FAFF}\u2705\u274C\u26A0\u2714\u2716\u2757\u2B55]/u;

/**
 * 相对路径是否落在风格门禁作用域内。
 * @param {string} rel 相对路径（POSIX 分隔符）
 * @returns {boolean} 是否在作用域
 */
function inStyleScope(rel) {
  return STYLE_SCOPES.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

/**
 * 作用域归属（用于 star 的按域 ratchet）。
 * @param {string} rel 相对路径
 * @returns {'src'|'scripts'|'public/index.html'|''} 域键
 */
function styleScopeKey(rel) {
  if (rel === 'public/index.html') return 'public/index.html';
  if (rel.startsWith('src/')) return 'src';
  if (rel.startsWith('scripts/')) return 'scripts';
  return '';
}

/**
 * 把受保护标记块的内容替换为同长空白（保持行号），使其中的装饰字符不计入。
 * @param {string} text 原文
 * @returns {string} 掩码后的文本
 */
function maskProtectedBlocks(text) {
  let out = String(text || '');
  for (const [begin, end] of PROTECTED_MARKERS) {
    let idx = out.indexOf(begin);
    while (idx >= 0) {
      const stop = out.indexOf(end, idx);
      if (stop < 0) break;
      const to = stop + end.length;
      out = out.slice(0, idx) + out.slice(idx, to).replace(/[^\n]/g, ' ') + out.slice(to);
      idx = out.indexOf(begin, to);
    }
  }
  return out;
}

/** 是否注释行。 */
function isCommentLine(line) {
  return /^\s*(\/\/|\/\*|\*|\*\/)/.test(line);
}

/**
 * 统计**注释内**的星号装饰数量。
 *
 * 规则名是「星号装饰」——约束的是**注释里的 AI 味装饰**，不是「`` 出现在任何位置」。
 * 字符串/模板串/正则里的 `` 是页面要渲染的**功能字符**（例如默认模型徽标），不算装饰。
 * 覆盖：HTML 注释 `<!-- -->`、`<style>` 内 CSS 块注释、`<script>` 内 JS 行/块注释。
 * 起始模式必须按文件类型区分：`.js` 直接进 `js` 模式（否则纯 JS 文件里的块注释
 *   永远识别不到 —— 实测反例曾因此**漏报**，等于规则失效）；只有 `.html` 才从 `markup` 起步。
 * @param {string} text 源码（调用方已对受保护块做掩码）
 * @param {boolean} [isHtml] 是否为 HTML 文件（默认 false → 按 JS 扫描）
 * @returns {number} 注释内 `` 的个数
 */
function countCommentStars(text, isHtml) {
  const src = String(text || '');
  let n = 0;
  let i = 0;
  let mode = isHtml ? 'markup' : 'js';
  let comment = false;
  let lineComment = false;
  let quote = '';
  let lastCode = '';
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    const rest = src.slice(i, i + 9);
    if (c === STAR_CHAR && comment && !quote) n += 1;

    if (mode === 'markup') {
      if (!comment && rest.startsWith('<!--')) { comment = true; i += 4; continue; }
      if (comment && rest.startsWith('-->')) { comment = false; i += 3; continue; }
      if (!comment && /^<script\b/i.test(rest)) { i = src.indexOf('>', i) + 1; mode = 'js'; lastCode = ''; continue; }
      if (!comment && /^<style\b/i.test(rest)) { i = src.indexOf('>', i) + 1; mode = 'css'; lastCode = ''; continue; }
      i += 1; continue;
    }
    if (/^<\/(script|style)/i.test(rest)) { mode = 'markup'; comment = false; i += 1; continue; }
    if (!comment && !quote) {
      if (c === '/' && c2 === '*') { comment = true; i += 2; continue; }
      if (mode === 'js' && c === '/' && c2 === '/') { comment = true; lineComment = true; i += 2; continue; }
    }
    if (comment) {
      if (c === '*' && c2 === '/') { comment = false; lineComment = false; i += 2; continue; }
      if (lineComment && c === '\n') { comment = false; lineComment = false; i += 1; continue; }
      i += 1; continue;
    }
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = '';
      i += 1; continue;
    }
    if (c === "'" || c === '"' || (mode === 'js' && c === '`')) { quote = c; i += 1; continue; }
    if (mode === 'js' && c === '/' && /[=(,:;[!&|?{}+*%^~<>]/.test(lastCode)) {
      let cls = false;
      i += 1;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) { i += 1; break; }
        else if (d === '\n') break;
        i += 1;
      }
      lastCode = '/';
      continue;
    }
    if (!/\s/.test(c)) lastCode = c;
    i += 1;
  }
  return n;
}

/**
 * 求非 JSDoc 的连续注释块（> MAX_COMMENT_BLOCK 才返回。
 * JSDoc 块（以双星注释开头）按规范豁免。
 * @param {string} text 掩码后的文本
 * @returns {Array<{start: number, length: number}>} 超长块
 */
function longCommentBlocks(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let cur = null;
  let inJsdoc = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\s*\/\*\*/.test(l)) inJsdoc = true;
    if (isCommentLine(l)) {
      if (!cur) cur = { start: i + 1, end: i + 1, jsdoc: inJsdoc };
      else { cur.end = i + 1; cur.jsdoc = cur.jsdoc || inJsdoc; }
    } else if (cur) { out.push(cur); cur = null; }
    if (!isCommentLine(l)) inJsdoc = false;
    else if (inJsdoc && /\*\/\s*$/.test(l)) inJsdoc = false;
  }
  if (cur) out.push(cur);
  return out
    .filter((r) => !r.jsdoc && (r.end - r.start + 1) > MAX_COMMENT_BLOCK)
    .map((r) => ({ start: r.start, length: r.end - r.start + 1 }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { files, source } = listFiles(options);

  const findings = [];
  const add = (severity, rule, file, line, note) => {
    findings.push({ severity, rule, file, line: line || 0, note: note || '' });
  };

  // T08b ③：宿主版本 ↔ 插件清单 `host.minVersion` 耦合（防「降版本号静默拒载插件」反弹）。
  //   两个数据源**直接比较**：package.json.version VS plugins/*/manifest.json host.minVersion。
  try {
    const coupling = checkHostVersionCoupling();
    for (const p of coupling.incompatible) {
      add('error', 'VERSION/host-minVersion', `plugins/${p.id}/manifest.json`, 0,
        `宿主版本 ${coupling.version} < 插件要求 ${p.minVersion} ⇒ 该插件会被装载期拒载（应把宿主版本提到 ≥ ${p.minVersion}，或按发布线下调该 manifest 的 host.minVersion）`);
    }
  } catch (err) {
    add('error', 'VERSION/coupling-check-failed', 'package.json', 0, `版本耦合检查无法执行：${err && err.message}`);
  }

  // T09：未跟踪文件卫生（补上 `git add -A` 的盲区 —— 只见「已跟踪」会漏掉真实凭据备份与
  //   600MB 虚拟环境）。仅在扫全仓库时执行；`--path=` 自测模式下不跑（避免对测试沙盒误报）。
  let untracked = { checked: 0, files: [], findings: [] };
  if (options.paths.length === 0) {
    try {
      untracked = checkUntrackedHygiene();
      for (const f of untracked.findings) add('error', f.rule, f.file, 0, f.note);
    } catch (err) {
      add('error', 'REPO/untracked-check-failed', '', 0, `未跟踪文件检查无法执行：${err && err.message}`);
    }
  }

  // T07b：注释风格统计（聚合；域级规则在循环后统一判定）
  const styleAgg = { star: {}, emoji: 0 };

  for (const rel of files) {
    if (shouldSkip(rel)) continue;
    const ext = path.extname(rel).toLowerCase();

    // 体积
    let size = 0;
    try { size = fs.statSync(path.join(PROJECT_ROOT, rel)).size; } catch { /* ignore */ }
    if (size > LARGE_FILE_BYTES) {
      add('warn', 'LARGE/oversize', rel, 0, `${Math.round(size / 1024)}KB`);
    }

    // 敏感文件是否进入发布集
    if (options.paths.length === 0) {
      for (const pattern of SENSITIVE_FILE_PATTERNS) {
        if (pattern.re.test(rel)) add('error', pattern.id, rel, 0, 'must-not-be-published');
      }
    }

    if (BINARY_EXT.has(ext)) continue;

    for (const hit of scanLines(rel, SECRET_PATTERNS)) add('error', hit.rule, hit.file, hit.line, 'redacted');
    for (const hit of scanLines(rel, LOCAL_PATH_PATTERNS)) add('error', hit.rule, hit.file, hit.line, 'redacted');
    if (!PLACEHOLDER_ALLOWLIST.has(rel)) {
      for (const hit of scanLines(rel, PLACEHOLDER_PATTERNS)) add('warn', hit.rule, hit.file, hit.line, '');
    }
    for (const hit of scanLines(rel, DEBUG_PATTERNS)) add('warn', hit.rule, hit.file, hit.line, '');

    // T10：裸控制 / 不可见字符（error —— 会让文件在 GBK 往返中被破坏，详见规则 3.6 背景）
    for (const hit of scanRawControlChars(rel)) {
      add('error', hit.rule, hit.file, hit.line, `含裸控制/不可见字符 ${hit.cps.join(',')}；请改写为 ASCII 转义（\\uXXXX / \\xXX）`);
    }

    // T07b：注释风格（仅作用域内的 js / html；受保护标记块内豁免）
    // 必须容错：发布集来自 `git ls-files`，**可能含已删除但仍在索引中的文件**（实测撞到
    //   `src/flow/nodes/builtin-contentsafety.js`），读不到就跳过，不能让整条门禁崩掉。
    if (inStyleScope(rel) && (ext === '.js' || ext === '.html')) {
      let text = null;
      try { text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf-8'); } catch { /* 已被删除 / 不可读 → 跳过 */ }
      if (text !== null) {
      const masked = maskProtectedBlocks(text);
      const textLines = masked.split('\n');
      const commentLines = textLines.filter(isCommentLine).length;
      const ratio = textLines.length ? commentLines / textLines.length : 0;
      const scope = styleScopeKey(rel);
      // T08e：只统计**注释内**的星号装饰（字符串里的 `` 是功能字符，如默认模型徽标）
      styleAgg.star[scope] = (styleAgg.star[scope] || 0) + countCommentStars(masked, ext === '.html');
      for (let i = 0; i < textLines.length; i += 1) {
        if (isCommentLine(textLines[i]) && EMOJI_PREFIX.test(textLines[i])) {
          styleAgg.emoji += 1;
          if (styleAgg.emoji > STYLE_BASELINE.emoji) add('warn', 'STYLE/emoji-prefix', rel, i + 1, '');
        }
      }
      const ratioBase = STYLE_BASELINE.ratio[rel];
      if (ratio > MAX_COMMENT_RATIO && (ratioBase === undefined || ratio > ratioBase)) {
        add('warn', 'STYLE/comment-ratio', rel, 0,
          `注释行占比 ${(ratio * 100).toFixed(1)}% > ${MAX_COMMENT_RATIO * 100}%${ratioBase !== undefined ? `（基线 ${(ratioBase * 100).toFixed(1)}%）` : ''}`);
      }
      for (const blk of longCommentBlocks(masked)) {
        add('warn', 'STYLE/comment-block', rel, blk.start, `${blk.length} 行连续注释`);
      }
      }
    }
  }

  // T07b：星号装饰（按域 ratchet —— 高于基线为 error，未清零为 warn）
  for (const [scope, count] of Object.entries(styleAgg.star)) {
    const base = STYLE_BASELINE.star[scope];
    const limit = base === undefined ? 0 : base;
    const file = scope === 'public/index.html' ? 'public/index.html' : `${scope}/`;
    if (count > limit) {
      add('error', 'STYLE/star-decoration', file, 0,
        `星号装饰 ${count} 处 > 基线 ${limit}（受保护标记块已豁免；请改为普通中文说明，勿新增星级装饰）`);
    } else if (count > 0) {
      add('warn', 'STYLE/star-decoration', file, 0,
        `星号装饰仍余 ${count} 处（基线 ${limit}；清零后请把 STYLE_BASELINE 下调为 0）`);
    }
  }

  // 真实计数与规则汇总必须在「去噪截断」之前统计，否则失败判定会被截断影响
  const allFindings = findings.slice();
  const rawErrorCount = findings.filter((f) => f.severity === 'error').length;
  const rawWarnCount = findings.filter((f) => f.severity === 'warn').length;

  // 同 (规则, 文件) 去噪：保留前 MAX_HITS_PER_FILE 条，其余聚合成一行
  const capped = [];
  const seen = new Map();
  for (const f of findings) {
    const key = `${f.rule}|${f.file}`;
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count < MAX_HITS_PER_FILE) capped.push(f);
    else if (count === MAX_HITS_PER_FILE) capped.push({ ...f, line: 0, note: '(+more hits in this file suppressed)' });
  }
  findings.length = 0;
  findings.push(...capped);

  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  const failed = options.maxFail === 'error' ? rawErrorCount > 0 : (rawErrorCount + rawWarnCount) > 0;

  if (options.json) {
    console.log(JSON.stringify({
      source,
      scanned: files.length,
      failed,
      errors: rawErrorCount,
      warnings: rawWarnCount,
      shown: findings.length,
      untrackedChecked: untracked.checked,
      findings,
    }, null, 2));
    process.exitCode = failed ? 1 : 0;
    return;
  }

  const line = '-'.repeat(96);
  console.log(line);
  console.log('GRS pre-publish check (REPO-05)');
  console.log(line);
  console.log(`source=${source}  scanned=${files.length}  untracked=${untracked.checked}  errors=${rawErrorCount}  warnings=${rawWarnCount}`
    + (findings.length !== rawErrorCount + rawWarnCount ? `  shown=${findings.length}` : ''));
  console.log(line);

  if (findings.length === 0) {
    console.log('no findings');
  } else {
    console.log('SEV    RULE                          FILE:LINE');
    console.log(line);
    for (const f of findings) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      console.log(
        f.severity.padEnd(7)
        + f.rule.padEnd(30)
        + loc.slice(0, 56).padEnd(57)
        + (f.note || ''),
      );
    }
  }

  // 规则级汇总（按真实计数，不受去噪截断影响）
  const byRule = new Map();
  for (const f of allFindings) {
    const key = `${f.severity}|${f.rule}`;
    const entry = byRule.get(key) || { severity: f.severity, rule: f.rule, hits: 0, files: new Set() };
    entry.hits += 1;
    entry.files.add(f.file);
    byRule.set(key, entry);
  }
  if (byRule.size > 0) {
    console.log('');
    console.log('SUMMARY BY RULE');
    console.log(line);
    console.log('SEV    RULE                                HITS   FILES');
    console.log(line);
    const sorted = [...byRule.values()].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1)
      || b.hits - a.hits || a.rule.localeCompare(b.rule));
    for (const entry of sorted) {
      console.log(entry.severity.padEnd(7) + entry.rule.padEnd(36)
        + String(entry.hits).padEnd(7) + entry.files.size);
    }
    console.log(line);
  }

  console.log('');
  console.log('NOTE: matched content is intentionally NOT printed (secrets / sensitive-word safety).');
  console.log(failed ? 'RESULT: FAIL (exit 1)' : 'RESULT: PASS (exit 0)');
  process.exitCode = failed ? 1 : 0;
}

// 供独立验证脚本 `require()` 使用（可注入 opts 造正反例）。
// 仅当作为 CLI 直接运行时才执行 main()，被 require 时不产生副作用。
module.exports = {
  checkHostVersionCoupling,
  checkUntrackedHygiene,
  listUntrackedFiles,
  countCommentStars,
  maskProtectedBlocks,
  scanRawControlChars,
  UNTRACKED_SECRET_NAME_PATTERNS,
  RAW_FORBIDDEN_RANGES,
  ENCODING_RULE_ID,
  UNTRACKED_BLOB_BYTES,
};

if (require.main === module) main();
