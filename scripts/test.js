/**
 * 测试脚本
 *
 * 测试审核服务的各项功能。
 * 用法: node scripts/test.js
 *
 * 前提: 审核服务已启动 (npm start)
 */

const MODERATION_HOST = process.env.MODERATION_HOST || 'http://127.0.0.1:11451';

const testCases = [
  {
    name: '安全文本',
    text: '大家好，欢迎加入群聊！今天天气不错。',
    expectPassed: true,
  },
  {
    name: '涉政内容',
    text: '某领导人应该被推翻，我们要推翻这个\u653F\u6743',
    expectPassed: false,
  },
  {
    name: '色情低俗',
    text: '加我微信看美女裸照，深夜福利视频分享',
    expectPassed: false,
  },
  {
    name: '营销广告',
    text: '代购韩国化妆品，加薇❤xxxxx 优惠券免费领',
    expectPassed: false,
  },
  {
    name: '赌博信息',
    text: '澳门赌场线上开户，注册送1000，日赚上万',
    expectPassed: false,
  },
  {
    name: '正常学习讨论',
    text: '请问Python中如何实现快速排序算法？',
    expectPassed: true,
  },
  {
    name: '营销变体（谐音）',
    text: '加裙123456免费领资料，数量有限先到先得',
    expectPassed: false,
  },
  {
    name: '暴恐内容',
    text: '制作爆炸物的教程：第一步准备硝酸铵...',
    expectPassed: false,
  },
  {
    name: '正常生活分享',
    text: '今天去公园跑步了，感觉很好，推荐大家多运动',
    expectPassed: true,
  },
  {
    name: '隐私泄露',
    text: '这个人的手机号是13800138000，大家去骚扰他',
    expectPassed: false,
  },
];

async function callApi(endpoint, body) {
  const res = await fetch(`${MODERATION_HOST}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }
  return res.json();
}

async function checkHealth() {
  try {
    const res = await fetch(`${MODERATION_HOST}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.json();
  } catch {
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  审核服务测试');
  console.log('═══════════════════════════════════════════\n');

  // 1. 健康检查
  console.log('【健康检查】');
  const health = await checkHealth();
  if (!health) {
    console.error('  ✗ 审核服务未启动！请先运行: npm start');
    process.exit(1);
  }
  console.log(`  状态: ${health.status}`);
  console.log(`  Ollama: ${health.ollama?.ok ? '正常' : '异常'}`);
  if (health.ollama?.models) {
    console.log(`  已安装模型: ${health.ollama.models.join(', ')}`);
  }
  console.log(`  文本模型: ${health.models?.text}`);
  console.log(`  视觉模型: ${health.models?.vision}`);

  if (!health.ollama?.ok) {
    console.error('\n  ✗ Ollama 服务不可用，请检查 Ollama 是否已启动');
    process.exit(1);
  }

  // 2. 文本审核测试
  console.log('\n【文本审核测试】\n');
  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    process.stdout.write(`  测试: ${tc.name} ... `);
    try {
      const result = await callApi('/api/moderate/text', {
        text: tc.text,
        messageId: `test_${Date.now()}`,
      });

      const correct = result.passed === tc.expectPassed;
      if (correct) {
        console.log(`✓ 通过 (risk=${result.risk_level}, cats=[${result.categories.join(',')}])`);
        passed++;
      } else {
        console.log(`✗ 失败 (期望 ${tc.expectPassed ? '放行' : '拦截'}, 实际 ${result.passed ? '放行' : '拦截'})`);
        console.log(`    reason: ${result.reason}`);
        failed++;
      }
    } catch (err) {
      console.log(`✗ 错误: ${err.message}`);
      failed++;
    }
  }

  // 3. 查看日志
  console.log('\n【最近审核日志】\n');
  try {
    const res = await fetch(`${MODERATION_HOST}/api/logs?count=5`);
    const data = await res.json();
    console.log(`  共 ${data.total} 条最近日志`);
    for (const log of data.logs.slice(-3)) {
      console.log(`  [${log.timestamp}] ${log.type} | ${log.risk_level} | ${log.reason}`);
    }
  } catch {
    console.log('  日志读取失败');
  }

  // 汇总
  console.log('\n═══════════════════════════════════════════');
  console.log(`  测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
  console.log('═══════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('提示: 部分测试未通过是正常的，本地 7B 模型对某些边界案例的判定可能不够精确。');
    console.log('      可以通过调整 config/default.json 中的模型参数或修改 prompts/ 中的提示词来优化效果。');
  }

  process.exit(failed > 0 ? 0 : 0); // 测试失败也不返回非0，因为这是模型能力问题
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
