/**
 * 审核 JSONL「持久 fd + writeSync」落盘回归 —— scripts/test-audit-jsonl-fd.js
 *
 * 运行：node scripts/test-audit-jsonl-fd.js
 *
 * 背景：saveAuditRecord 由「每条 fs.appendFileSync（open+write+close）」改为
 *   「按日期缓存一个追加 fd + 每条 fs.writeSync」：仍**同步落盘、零丢失**，仅省去每条的 open/close。
 *   最易出错的点：文件被 clearAuditRecords 删除后，若 fd 未失效，后续 writeSync 会写进
 *   已删除的孤立 inode（看似成功实则丢数据）。本套用例重点覆盖该路径。
 *
 * 覆盖：
 *   F. 同步落盘（存后立即可读，无需 flush）/ fd 复用（多条不重不漏、顺序）
 *   G. clearAuditRecords 后 fd 失效 → 再存能落进新文件（不写孤立 inode）
 *   H. 写失败（writeSync + appendFileSync 兜底均抛）→ 返回 null（沿用原契约）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SANDBOX = path.join(os.tmpdir(), `grs-jsonlfd-${process.pid}`);
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'audit_records'), { recursive: true });
process.env.GRS_AUDIT_DIR = path.join(SANDBOX, 'audit_records');
process.env.GRS_AUDIT_DB = path.join(SANDBOX, 'audit.db');
process.env.GRS_BLOB_DIR = path.join(SANDBOX, 'image_blobs');
process.env.GRS_FORCE_NO_SQLITE = '1';   // 只测 JSONL 落盘，隔离 DB

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`[PASS] ${name}${detail ? ' | ' + detail : ''}`); }
  else { failed++; console.log(`[FAIL] ${name}${detail ? ' | ' + detail : ''}`); }
}

const auditStore = require(path.join(PROJECT_ROOT, 'src', 'audit-store'));
const today = auditStore.getDateStr();
const fileOf = (d) => path.join(process.env.GRS_AUDIT_DIR, `${d}.jsonl`);
function fileLines(d) {
  try { return fs.readFileSync(fileOf(d), 'utf-8').trim().split('\n').filter(Boolean); } catch { return []; }
}
function sampleResult(tag) {
  return { passed: true, action: 'pass', risk_level: 'safe', categories: [], category_scores: {}, confidence: 1, reason: 'r-' + tag, type: 'text', model: 'test-model' };
}

// F/01 同步落盘：存后**立即**能在裸文件读到（无需任何 flush）
const r1 = auditStore.saveAuditRecord('持久fd-同步落盘', sampleResult(1), { userId: 'u1' });
check('F/01 同步返回记录含 id', Boolean(r1 && r1.id), 'id=' + (r1 && r1.id));
check('F/02 存后立即可读（同步落盘，无延迟）', fileLines(today).some((l) => l.includes(r1.id)));

// F/03 fd 复用：连续 30 条全部落盘、不重不漏
const ids = [];
for (let i = 0; i < 30; i++) { const r = auditStore.saveAuditRecord('复用-' + i, sampleResult('f' + i), {}); ids.push(r.id); }
const lines = fileLines(today);
const idSet = new Set(ids);
const inFile = lines.filter((l) => { try { return idSet.has(JSON.parse(l).id); } catch { return false; } });
check('F/03 fd 复用 30 条全部落盘不重', inFile.length === 30, 'inFile=' + inFile.length);

// F/04 顺序保持
const order = inFile.map((l) => { try { return JSON.parse(l).id; } catch { return null; } });
const idxs = ids.map((id) => order.indexOf(id));
check('F/04 落盘顺序与保存顺序一致', idxs.every((v, i) => i === 0 || v > idxs[i - 1]));

// F/05 getAuditRecords 读回全部（含 r1）
const all = auditStore.getAuditRecords(today);
check('F/05 getAuditRecords 读回 >=31 且无重复', all.length >= 31 && new Set(all.map((r) => r.id)).size === all.length, 'total=' + all.length);

// G/01 clearAuditRecords 删除文件后 fd 必须失效；再存要能落进**新文件**（不写孤立 inode）
const beforeClear = fileLines(today).length;
const cleared = auditStore.clearAuditRecords(today);
check('G/01 clear 成功且文件已删', cleared.success === true && !fs.existsSync(fileOf(today)), 'deleted=' + cleared.deleted + ' beforeClear=' + beforeClear);
const rAfter = auditStore.saveAuditRecord('clear后重新落盘', sampleResult('g'), {});
const linesAfter = fileLines(today);
check('G/02 clear 后再存能落进新文件（fd 已失效重开，未写孤立 inode）',
  Boolean(rAfter && rAfter.id) && linesAfter.length === 1 && linesAfter[0].includes(rAfter.id),
  'linesAfter=' + linesAfter.length);
// G/03 getAuditRecords 只看到 clear 后的新记录（旧记录确已随文件删除，未被写进孤立 fd）
const allAfter = auditStore.getAuditRecords(today);
check('G/03 clear 后读回仅新记录（无孤立 inode 残留）', allAfter.length === 1 && allAfter[0].id === rAfter.id, 'total=' + allAfter.length);

// H/01 写失败（writeSync + appendFileSync 兜底均抛）→ 返回 null（沿用原契约）
const realAppend = fs.appendFileSync;
const realWriteSync = fs.writeSync;
fs.writeSync = () => { throw Object.assign(new Error('模拟 writeSync 失败'), { code: 'EACCES' }); };
fs.appendFileSync = (file, ...rest) => {
  if (String(file).endsWith('.jsonl') && !String(file).endsWith('_ops.jsonl')) {
    throw Object.assign(new Error('模拟 appendFileSync 失败'), { code: 'EACCES' });
  }
  return realAppend.call(fs, file, ...rest);
};
let threw = null; let rFail = 'unset';
try { rFail = auditStore.saveAuditRecord('写失败', sampleResult('h'), {}); } catch (e) { threw = String(e && e.message); }
fs.appendFileSync = realAppend;
fs.writeSync = realWriteSync;
check('H/01 写失败不抛给调用方', threw === null, threw || 'no-throw');
check('H/02 写失败返回 null（沿用原契约）', rFail === null, 'ret=' + JSON.stringify(rFail));

// H/03 故障恢复后仍可正常落盘（fd 缓存未被污染）
const rOk = auditStore.saveAuditRecord('故障后恢复', sampleResult('i'), {});
check('H/03 故障后恢复仍可落盘', Boolean(rOk && rOk.id) && fileLines(today).some((l) => l.includes(rOk.id)));

console.log('---');
console.log(`passed=${passed} failed=${failed}`);
console.log(`OVERALL: ${failed === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failed === 0 ? 0 : 1);
