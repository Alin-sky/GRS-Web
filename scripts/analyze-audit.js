// 分析审核记录：token 消耗趋势 + 内容安全失败原因
const fs = require('fs');
const path = require('path');

const recordDir = path.join(__dirname, '..', 'data', 'audit_records');
const files = fs.readdirSync(recordDir).filter(f => f.endsWith('.jsonl')).sort();

console.log('=== 每日审核量和 Token 消耗 ===\n');

let prevAvgIn = 0, prevAvgOut = 0;

for (const file of files) {
  const lines = fs.readFileSync(path.join(recordDir, file), 'utf-8').trim().split('\n').filter(Boolean);
  let totalIn = 0, totalOut = 0, hasToken = 0;
  let csAvailable = 0, csUnavailable = 0;
  let csErrors = {};
  let textLen = 0, textCount = 0;
  let imgCount = 0;

  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const r = rec.result || {};
      
      // Token 统计
      if (r.tokens_in) { totalIn += r.tokens_in; hasToken++; }
      if (r.tokens_out) totalOut += r.tokens_out;
      
      // 文本长度
      if (rec.text && rec.result?.type === 'text') {
        textLen += rec.text.length;
        textCount++;
      }
      if (r.type === 'image') imgCount++;

      // 内容安全统计
      const cs = r.content_safety_result;
      if (cs) {
        if (cs.available) {
          csAvailable++;
        } else {
          csUnavailable++;
          if (cs.error) {
            // 按错误类型归类
            const errMsg = String(cs.error);
            const match = errMsg.match(/message=([^;]+)/);
            const key = match ? match[1].trim() : errMsg.substring(0, 80);
            csErrors[key] = (csErrors[key] || 0) + 1;
          } else if (cs.channel === 'text' && !cs.error) {
            csErrors['(no error field, unavailable)'] = (csErrors['(no error field, unavailable)'] || 0) + 1;
          }
        }
      }
    } catch(e) {}
  }

  const avgIn = hasToken ? Math.round(totalIn / hasToken) : 0;
  const avgOut = hasToken ? Math.round(totalOut / hasToken) : 0;
  const avgTextLen = textCount ? Math.round(textLen / textCount) : 0;
  
  console.log(`📅 ${file.replace('.jsonl', '')} | 审核数: ${lines.length} | 文本: ${textCount} 图: ${imgCount}`);
  console.log(`   Token: in=${totalIn.toLocaleString()} out=${totalOut.toLocaleString()} (avg in: ${avgIn}, out: ${avgOut})`);
  console.log(`   文本平均长度: ${avgTextLen} 字符`);
  console.log(`   内容安全: ✅可用=${csAvailable} ❌不可用=${csUnavailable}`);
  if (Object.keys(csErrors).length > 0) {
    console.log(`   失败原因:`);
    for (const [err, count] of Object.entries(csErrors).sort((a,b) => b[1]-a[1])) {
      console.log(`     ${err}: ${count} 次`);
    }
  }
  
  // 对比趋势
  if (prevAvgIn > 0 && avgIn > 0) {
    const inChange = ((avgIn - prevAvgIn) / prevAvgIn * 100).toFixed(1);
    const outChange = ((avgOut - prevAvgOut) / prevAvgOut * 100).toFixed(1);
    console.log(`   趋势: tokens_in ${inChange}% | tokens_out ${outChange}%`);
  }
  prevAvgIn = avgIn;
  prevAvgOut = avgOut;
  console.log('');
}

// 深入分析今天内容安全失败的具体原因
console.log('\n=== 今日内容安全失败详情 ===\n');
const today = files[files.length - 1];
if (today) {
  const lines = fs.readFileSync(path.join(recordDir, today), 'utf-8').trim().split('\n').filter(Boolean);
  let csFailCount = 0;
  
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const cs = rec.result?.content_safety_result;
      if (cs && !cs.available) {
        csFailCount++;
        if (csFailCount <= 5) {
          console.log(`[${rec.result?.type}] text_len=${rec.text?.length || 0}`);
          console.log(`  text_preview: "${(rec.text || '').substring(0, 100).replace(/[\n\r]/g, ' ')}"`);
          console.log(`  error: ${cs.error || '(none)'}`);
          console.log(`  services: ${JSON.stringify(cs.services || [])}`);
          console.log('');
        }
      }
    } catch(e) {}
  }
  console.log(`总失败次数: ${csFailCount}`);
  
  // 额外统计：per_service 中是否有个别服务失败
  let perServiceFail = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const cs = rec.result?.content_safety_result;
      if (cs && cs.available && cs.per_service) {
        for (const s of cs.per_service) {
          if (s.suggestion === 'error' || s.risk_level === 'error') {
            perServiceFail++;
            if (perServiceFail <= 3) {
              console.log(`[per_service fail] service=${s.service} error=${s.error || ''}`);
            }
          }
        }
      }
    } catch(e) {}
  }
  if (perServiceFail > 0) console.log(`per_service 级别失败: ${perServiceFail}`);
}
