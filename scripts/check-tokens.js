// 查看 8/1 和 8/3 的 token 详情
const fs = require('fs');
const path = require('path');

const recordDir = path.join(__dirname, '..', 'data', 'audit_records');

for (const day of ['2026-08-01', '2026-08-03', '2026-08-05']) {
  const file = path.join(recordDir, `${day}.jsonl`);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
  
  console.log(`\n=== ${day} (前3条) ===`);
  for (let i = 0; i < 3 && i < lines.length; i++) {
    try {
      const rec = JSON.parse(lines[i]);
      const r = rec.result || {};
      console.log(`  text_len=${rec.text?.length || 0} tokens_in=${r.tokens_in || 0} tokens_out=${r.tokens_out || 0} cloud_model=${r.cloud_model || r.model || '-'}  text="${(rec.text||'').substring(0, 60)}"`);
    } catch(e) {}
  }
}

// 额外：8/5 内容安全失败时，文本长度分布
console.log('\n=== 8/5 全部文本长度分布 ===');
const today = path.join(recordDir, '2026-08-05.jsonl');
if (fs.existsSync(today)) {
  const lines = fs.readFileSync(today, 'utf-8').trim().split('\n').filter(Boolean);
  const buckets = { '<50': 0, '50-100': 0, '100-300': 0, '300-600': 0, '600-1000': 0, '>1000': 0 };
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const len = rec.text?.length || 0;
      if (len < 50) buckets['<50']++;
      else if (len < 100) buckets['50-100']++;
      else if (len < 300) buckets['100-300']++;
      else if (len < 600) buckets['300-600']++;
      else if (len < 1000) buckets['600-1000']++;
      else buckets['>1000']++;
    } catch(e) {}
  }
  for (const [k, v] of Object.entries(buckets)) {
    const bar = '█'.repeat(Math.min(v, 40));
    console.log(`  ${k.padStart(10)}: ${String(v).padStart(4)} ${bar}`);
  }
  
  // 超过 600 字符的消息有多少
  let over600 = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if ((rec.text?.length || 0) > 600) over600++;
    } catch(e) {}
  }
  console.log(`\n  超过 600 字符的消息: ${over600} 条 (内容安全 API 限制 600 字符)`);
}
