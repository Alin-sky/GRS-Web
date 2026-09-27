/**
 * 一键安装脚本
 *
 * 检查环境依赖，安装 Node.js 依赖包，引导拉取 Ollama 模型。
 * 用法: node scripts/setup.js
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../src/config');
const { isNodeCompatible } = require('./check-node');

const config = loadConfig();

function run(cmd, label) {
  console.log(`\n▶ ${label}...`);
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    console.log(output.trim());
    return true;
  } catch {
    return false;
  }
}

function checkCommand(cmd) {
  try {
    execSync(`${cmd} --version`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  QQ 机器人内容审核服务 - 安装向导');
  console.log('═══════════════════════════════════════════\n');

  // 1. 检查 Node.js
  console.log('【1/4】检查 Node.js...');
  if (!checkCommand('node')) {
    console.error('  ✗ 未检测到 Node.js，请先安装 Node.js 20.9.0+');
    console.log('  也可运行 scripts\\ensure-node.bat 自动下载便携版 Node.js');
    process.exit(1);
  }
  const nodeVersion = execSync('node --version', { encoding: 'utf-8' }).trim();
  if (!isNodeCompatible('20.9.0')) {
    console.error(`  ✗ Node.js 版本过低：当前 ${nodeVersion}，要求 >= 20.9.0`);
    console.log('  请升级 Node.js，或运行 scripts\\ensure-node.bat 自动下载便携版');
    process.exit(1);
  }
  console.log(`  ✓ Node.js ${nodeVersion}`);

  // 2. 安装 npm 依赖
  console.log('\n【2/4】安装 npm 依赖...');
  const projectRoot = path.join(__dirname, '..');
  run(`npm install --prefix "${projectRoot}"`, '安装 express 依赖');

  // 3. 检查 Ollama
  console.log('\n【3/4】检查 Ollama...');
  if (!checkCommand('ollama')) {
    console.error('  ✗ 未检测到 Ollama！');
    console.log('\n  请先安装 Ollama:');
    console.log('  Windows:  https://ollama.com/download 下载安装包');
    console.log('  或运行:   winget install Ollama.Ollama');
    console.log('\n  安装完成后重新运行此脚本: npm run setup');
    process.exit(1);
  }
  const ollamaVersion = execSync('ollama --version', { encoding: 'utf-8' }).trim();
  console.log(`  ✓ Ollama ${ollamaVersion}`);

  // 检查 Ollama 服务是否运行
  console.log('  检查 Ollama 服务状态...');
  let ollamaRunning = false;
  try {
    const res = await fetch(`${config.ollama.host}/api/tags`);
    ollamaRunning = res.ok;
  } catch {
    ollamaRunning = false;
  }

  if (!ollamaRunning) {
    console.log('  ⚠ Ollama 服务未运行，正在启动...');
    spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
    console.log('  等待服务启动...');
    await new Promise((r) => setTimeout(r, 5000));

    try {
      const res = await fetch(`${config.ollama.host}/api/tags`);
      ollamaRunning = res.ok;
    } catch {
      ollamaRunning = false;
    }
  }

  if (!ollamaRunning) {
    console.error('  ✗ Ollama 服务启动失败，请手动运行: ollama serve');
    process.exit(1);
  }
  console.log('  ✓ Ollama 服务运行中');

  // 4. 拉取模型
  console.log('\n【4/4】拉取审核模型...');
  const models = [config.ollama.textModel, config.ollama.visionModel];

  // 获取已安装的模型列表
  let installedModels = [];
  try {
    const res = await fetch(`${config.ollama.host}/api/tags`);
    const data = await res.json();
    installedModels = (data.models || []).map((m) => m.name);
  } catch {
    // ignore
  }

  for (const model of models) {
    // Ollama 返回的模型名可能带 :latest 后缀
    const isInstalled = installedModels.some(
      (m) => m === model || m === `${model}:latest` || m.startsWith(`${model}:`)
    );

    if (isInstalled) {
      console.log(`  ✓ ${model} 已安装`);
    } else {
      console.log(`  拉取 ${model}（可能需要几分钟，请耐心等待）...`);
      try {
        execSync(`ollama pull ${model}`, { stdio: 'inherit' });
        console.log(`  ✓ ${model} 安装完成`);
      } catch {
        console.error(`  ✗ ${model} 拉取失败`);
        console.log(`  请手动运行: ollama pull ${model}`);
      }
    }
  }

  // 完成
  console.log('\n═══════════════════════════════════════════');
  console.log('  ✓ 安装完成！');
  console.log('═══════════════════════════════════════════\n');
  console.log('下一步:');
  console.log('  1. 启动审核服务:  npm start');
  console.log('  2. 运行测试:      npm test');
  console.log('  3. 查看示例:      node examples/bot_client.js');
  console.log(`\n  审核服务默认地址: http://127.0.0.1:${config.server.port}`);
  console.log('  配置文件:         config/default.json\n');
}

main().catch((err) => {
  console.error('安装失败:', err.message);
  process.exit(1);
});
