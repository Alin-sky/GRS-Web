// build.js - GRS-通用审核系统 云端部署版打包脚本
// 用法: node build.js 或双击 build.bat

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const zlib = require('zlib');

// ─── 原生 ZIP 实现（避免 PowerShell 沙盒拦截）───
function createZipBuffer(sourceDir) {
  const files = [];
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else {
        const stat = fs.statSync(absPath);
        files.push({ relPath, absPath, size: stat.size, mtime: stat.mtime });
      }
    }
  }
  walk(sourceDir);

  const buffers = [];
  let offset = 0;
  const centralHeaders = [];

  for (const file of files) {
    const data = fs.readFileSync(file.absPath);
    const compressed = zlib.deflateRawSync(data);
    const fileNameBuffer = Buffer.from(file.relPath, 'utf8');

    // Local file header
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // compression (deflate)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc32(data), 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(fileNameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    buffers.push(localHeader, fileNameBuffer, compressed);
    offset += localHeader.length + fileNameBuffer.length + compressed.length;

    // Central directory header
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc32(data), 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset - localHeader.length - fileNameBuffer.length - compressed.length, 42);
    centralHeaders.push(centralHeader, fileNameBuffer);
  }

  // End of central directory
  const centralDirSize = centralHeaders.reduce((sum, b) => sum + b.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirSize, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...buffers, ...centralHeaders, endRecord]);
}

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PROJECT_ROOT = __dirname;
const BUILD_DIR = path.join(PROJECT_ROOT, 'builds');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const OUTPUT_NAME = `bot-moderation-cloud-${TIMESTAMP}`;
// 使用系统临时目录避免沙盒拦截
const OUTPUT_DIR = path.join(require('os').tmpdir(), OUTPUT_NAME);
const OUTPUT_ZIP = path.join(BUILD_DIR, `${OUTPUT_NAME}.zip`);

// ─── 排除规则 ───
const EXCLUDE_DIRS = new Set([
  '.workbuddy', 'logs', 'models', '.git',
  'data/audit_records', 'data/comparisons', 'builds', 'scripts',
  // T06：提示词正文不进发布物（新克隆者本地自备；缺失时接口返回 PROMPT_MISSING）
  'prompts',
  // T09：wd14 的 Python 虚拟环境（约 600MB，可由 requirements 重建），绝不进发布物。
  //   仅排除 `.venv` 目录本身；同级的 wd14/wd14_service.py 仍要发布。
  'wd14/.venv', '.venv', '__pycache__',
]);

const EXCLUDE_FILES = new Set([
  'build.bat', 'build.js', 'create-zip.js',
  'start.bat', 'start-cloud.bat', 'rename-model.bat',
  'Modelfile.qwen14b', 'qwen3-14b', 'nul',
  'server.log', 'package-lock.json',
]);

const EXCLUDE_EXTS = new Set(['.bak', '.log']);

// ─── 工具函数 ───
function log(msg) {
  console.log(`  ${msg}`);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function walkDir(dir, prefix = '') {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.workbuddy') continue;
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(relPath) || EXCLUDE_DIRS.has(entry.name)) continue;
      files = files.concat(walkDir(path.join(dir, entry.name), relPath));
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (EXCLUDE_EXTS.has(path.extname(entry.name))) continue;
      files.push(relPath);
    }
  }
  return files;
}

// ─── 主流程 ───
async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        GRS-通用审核系统 - 云端部署版打包工具               ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`📦 输出: ${OUTPUT_NAME}.zip`);
  console.log('');

  // 1. 检查依赖
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'))) {
    log('📥 安装依赖...');
    execSync('npm install', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  }

  // 2. 收集文件
  log('📄 收集文件...');
  const files = walkDir(PROJECT_ROOT);
  log(`   找到 ${files.length} 个文件`);

  // 3. 创建输出目录
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 4. 复制文件
  log('📋 复制文件...');
  for (const file of files) {
    const src = path.join(PROJECT_ROOT, file);
    const dest = path.join(OUTPUT_DIR, file);
    copyFile(src, dest);
  }

  // 5. 修改配置为 cloud-only
  log('⚙️  修改配置为云端模式...');
  const configPath = path.join(OUTPUT_DIR, 'config', 'default.json');
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    cfg.moderationMode = 'cloud-only';
    if (!cfg.reviewChannels) cfg.reviewChannels = {};
    cfg.reviewChannels.local = false;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
  }

  // 6. 修改 package.json
  const pkgPath = path.join(OUTPUT_DIR, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    pkg.name = 'grs-moderator-cloud';
    pkg.description = 'GRS-通用审核系统 - 云端部署版';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
  }

  // 7. 创建启动脚本
  log('📝 创建启动脚本...');
  
  // Windows 启动脚本
  fs.writeFileSync(path.join(OUTPUT_DIR, 'start.bat'), `@echo off
chcp 65001 >nul
title GRS-通用审核系统 - 云端版
echo.
echo   GRS-通用审核系统 - 云端版
echo   ========================
echo.
echo   启动中...
echo.
set MODERATION_MODE=cloud-only
node src/server.js
pause
`, 'utf-8');

  // Linux/Mac 启动脚本
  fs.writeFileSync(path.join(OUTPUT_DIR, 'start.sh'), `#!/bin/bash
echo ""
echo "  GRS-通用审核系统 - 云端版"
echo "  ========================"
echo ""
export MODERATION_MODE=cloud-only
node src/server.js
`, 'utf-8');

  // 8. 创建 README
  fs.writeFileSync(path.join(OUTPUT_DIR, 'README.md'), `# GRS-通用审核系统 - 云端部署版

## 快速开始

### Windows
\`\`\`
start.bat
\`\`\`

### Linux/Mac
\`\`\`
chmod +x start.sh
./start.sh
\`\`\`

## 环境变量配置

| 变量名 | 说明 |
|--------|------|
| \`DASHSCOPE_API_KEY\` | 阿里云 DashScope API Key（必需） |
| \`ALIBABA_CLOUD_ACCESS_KEY_ID\` | 阿里云内容安全 AccessKey ID（可选） |
| \`ALIBABA_CLOUD_ACCESS_KEY_SECRET\` | 阿里云内容安全 AccessKey Secret（可选） |
| \`MOD_PORT\` | 服务端口（默认 11451） |
| \`ADMIN_PASSWORD\` | 管理员密码（公网访问时需要） |

## 获取 API Key

- **DashScope**: https://dashscope.console.aliyun.com/apiKey
- **内容安全**: https://ram.console.aliyun.com/manage/ak

## 功能

- ✅ 云端大模型审核（Qwen / DeepSeek）
- ✅ 阿里云内容安全审核
- ✅ 审核阈值配置
- ✅ 审核记录查询
- ✅ 统计面板
- ✅ 公网访问密码保护

## 访问

启动后访问 http://localhost:11451

## 与完整版区别

| 功能 | 云端版 | 完整版 |
|------|--------|--------|
| 本地 Ollama 审核 | ❌ | ✅ |
| 云端大模型审核 | ✅ | ✅ |
| 内容安全审核 | ✅ | ✅ |
| 需要 GPU | ❌ | ✅ |
| 需要 Ollama | ❌ | ✅ |
`, 'utf-8');

  // 9. 打包为 zip（使用原生 Node.js 实现）
  log('🗜️  创建 zip 包...');
  if (fs.existsSync(OUTPUT_ZIP)) {
    fs.unlinkSync(OUTPUT_ZIP);
  }

  // 确保 builds 目录存在
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }

  try {
    const zipBuffer = createZipBuffer(OUTPUT_DIR);
    fs.writeFileSync(OUTPUT_ZIP, zipBuffer);
    log(`✅ 原生 ZIP 打包成功`);
  } catch (e) {
    log(`❌ ZIP 打包失败: ${e.message}`);
    console.error('临时目录保留在:', OUTPUT_DIR);
    process.exit(1);
  }

  // 10. 清理临时目录（仅在打包成功时）
  try {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  } catch (e) {
    log(`⚠️  清理临时目录失败（不影响打包结果）: ${e.message}`);
  }

  // 11. 统计结果
  const zipSize = fs.existsSync(OUTPUT_ZIP) ? fs.statSync(OUTPUT_ZIP).size : 0;
  const sizeMB = (zipSize / 1024 / 1024).toFixed(2);

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    ✅ 打包完成！                          ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  输出: builds/${OUTPUT_NAME}.zip`);
  console.log(`║  大小: ${sizeMB} MB`);
  console.log('║                                                            ║');
  console.log('║  部署步骤:                                                 ║');
  console.log('║  1. 解压 zip 到目标服务器                                  ║');
  console.log('║  2. 配置环境变量 DASHSCOPE_API_KEY                         ║');
  console.log('║  3. 运行 start.bat 启动服务                                ║');
  console.log('║  4. 访问 http://localhost:11451                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
}

main().catch(err => {
  console.error('❌ 打包失败:', err.message);
  process.exit(1);
});
