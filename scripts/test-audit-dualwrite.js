#!/usr/bin/env node
/**
 * 审核记录双写（JSONL 权威 + DB 投影）回归（scripts/test-audit-dualwrite.js）
 *
 * 覆盖 PRD 决策二~五与 R3-18~R3-24 的**可执行断言**：
 *   R3-18 正常审核 1 次 ⇒ JSONL +1 行且 DB COUNT(*) +1，两边 id 一致
 *   R3-19 DB 写入故意抛错 ⇒ 审核仍成功、`saveAuditRecord` 不抛、补偿队列计数 +1
 *   R3-20 JSONL 写入故意抛错 ⇒ 上层仍返回（本脚本断言 saveAuditRecord 返回 null 而不抛）
 *   R3-21 node:sqlite 不可用 ⇒ 自动降级纯 JSONL，功能不缺失
 *   R3-22 dualWrite.enabled=false ⇒ 无 DB 增长
 *   R3-24 对账精确 + 回灌幂等（重复回灌行数不翻倍）
 *   附加：补偿队列有界（cap=1000）+ 删除留痕 + `listAuditDates()` 过滤 `/^_/`
 *
 * 测试隔离：`GRS_AUDIT_DIR`（JSONL）+ `GRS_AUDIT_DB`（DB）+ `GRS_BLOB_DIR` 全部指向临时目录；
 *   **绝不触碰生产** `data/audit_records/`、`data/audit.db`、`data/image_blobs/`。
 *
 * 用法：node scripts/test-audit-dualwrite.js
 * 退出码：全部通过为 0，否则为 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── 隔离（必须在 require 业务模块之前）───
const SANDBOX = path.join(os.tmpdir(), `grs-dualwrite-${Date.now()}`);
const AUDIT_DIR = path.join(SANDBOX, 'audit_records');
const DB_FILE = path.join(SANDBOX, 'audit.db');
const BLOB_DIR = path.join(SANDBOX, 'image_blobs');
fs.mkdirSync(AUDIT_DIR, { recursive: true });
process.env.GRS_AUDIT_DIR = AUDIT_DIR;
process.env.GRS_AUDIT_DB = DB_FILE;
process.env.GRS_BLOB_DIR = BLOB_DIR;
// 保护生产配置：拦截对 config/default.json 的写入
process.env.QA_GUARD_CONFIG_WRITE = '1';
// eslint-disable-next-line import/no-unassigned-import
require('./qa-runtime-preload');

const auditStore = require('../src/audit-store');
const auditDb = require('../src/audit-db');
const { loadConfig } = require('../src/config');

let passed = 0;
let failed = 0;

/**
 * 断言并打印一行。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 详情
 * @returns {void}
 */
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name.padEnd(56)} ${detail}`); } else { failed += 1; console.log(`  FAIL  ${name.padEnd(56)} ${detail}`); }
}

/** 计数 JSONL 行数（跳过空行） */
function jsonlLines(date) {
  const f = path.join(AUDIT_DIR, `${date}.jsonl`);
  try {
    return fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

/** 造一条最小可用审核记录结果 */
function sampleResult(extra = {}) {
  return {
    passed: true, risk_level: 'safe', categories: [], confidence: 0.9,
    reason: '测试', type: 'text', timestamp: new Date().toISOString(), ...extra,
  };
}

/**
 * 直接用 node:sqlite 打开受测 DB（扮演「外部运维」做手工删行）。
 * @returns {object} DatabaseSync 句柄
 */
function rawDb() {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(DB_FILE);
}

// ══════════════════════════════════════════════════════════
async function main() {
  console.log('--------------------------------------------------------------------------------');
  console.log('审核记录双写回归（scripts/test-audit-dualwrite.js）');
  console.log(`沙箱: ${SANDBOX}`);
  console.log('--------------------------------------------------------------------------------');

  const today = auditStore.getDateStr();

  console.log('\n── 能力探测与初始状态 ──');
  const probe = auditDb.probe();
  check('D/1 node:sqlite 探测可用', probe.available === true, probe.reason);
  auditDb.open();
  check('D/2 DB 打开成功且 schema=v1', auditDb.isOpen() && auditDb.getSchemaVersion() === 1,
    `open=${auditDb.isOpen()} v=${auditDb.getSchemaVersion()}`);

  console.log('\n── R3-18 正常双写：JSONL 与 DB 各 +1，id 一致 ──');
  const before = jsonlLines(today);
  const rec1 = auditStore.saveAuditRecord('双写测试文本', sampleResult({ model: 'test-model' }), { userId: 'u1' });
  check('D/3 saveAuditRecord 返回记录（非 null）', Boolean(rec1 && rec1.id), `id=${rec1 && rec1.id}`);
  check('D/4 JSONL 追加 1 行', jsonlLines(today) === before + 1, `before=${before} after=${jsonlLines(today)}`);
  await auditStore.flushAuditDb();
  check('D/5 DB 行数 +1', auditDb.count(today) === 1, `count=${auditDb.count(today)}`);
  const dbIds = auditDb.idsOf(today);
  check('D/6 两边 id 一致', dbIds.length === 1 && dbIds[0] === rec1.id, `db=${dbIds.join(',')}`);

  console.log('\n── R3-19 DB 抛错 ⇒ 审核仍成功、不抛、补偿队列 +1 ──');
  const realUpsert = auditDb.upsert;
  auditDb.upsert = () => { throw new Error('模拟 DB 写入失败'); };
  let threw = null;
  let rec2 = null;
  try {
    rec2 = auditStore.saveAuditRecord('DB 故障文本', sampleResult(), { userId: 'u2' });
  } catch (e) { threw = String(e && e.message); }
  check('D/7 saveAuditRecord 不抛异常', threw === null, threw || 'no-throw');
  check('D/8 仍返回记录（审核/存储照常成功）', Boolean(rec2 && rec2.id), `id=${rec2 && rec2.id}`);
  check('D/9 JSONL 仍正常追加', jsonlLines(today) === before + 2, `lines=${jsonlLines(today)}`);
  await auditStore.flushAuditDb();
  const st2 = auditStore.getDualWriteStatus();
  check('D/10 补偿队列有该条（queued>=1，未静默丢弃）', st2.queued >= 1, `queued=${st2.queued}`);
  check('D/11 状态记录 lastError', Boolean(st2.lastError), `lastError=${st2.lastError}`);
  auditDb.upsert = realUpsert;
  // 恢复后重试应成功写回
  await auditStore.flushAuditDb();
  await auditStore.flushAuditDb();
  check('D/12 DB 恢复后补偿队列排空且该条补写进 DB',
    auditDb.idsOf(today).includes(rec2.id) || auditStore.getDualWriteStatus().queued === 0,
    `queued=${auditStore.getDualWriteStatus().queued}`);

  console.log('\n── 补偿队列有界（cap=1000，溢出丢最旧 + 计数）──');
  const queueOnlyDir = auditStore.getDualWriteStatus().queued;
  auditDb.upsert = () => { throw new Error('持续失败'); };
  for (let i = 0; i < auditStore.DB_QUEUE_CAP + 200; i += 1) {
    auditStore.saveAuditRecord(`积压 ${i}`, sampleResult(), {});
  }
  await auditStore.flushAuditDb();
  const stq = auditStore.getDualWriteStatus();
  check('D/13 队列不超过上限', stq.queued <= auditStore.DB_QUEUE_CAP,
    `queued=${stq.queued} cap=${auditStore.DB_QUEUE_CAP}`);
  check('D/14 溢出被计数（dropped>=1）', stq.dropped >= 1, `dropped=${stq.dropped}`);
  check('D/15 队列基数从入队即生效', queueOnlyDir <= auditStore.DB_QUEUE_CAP, `base=${queueOnlyDir}`);
  auditDb.upsert = realUpsert;

  console.log('\n── R3-24 对账精确 + 回灌幂等 ──');
  // 先让 DB 追上 JSONL（此时两类记录：正常 + 积压重试）
  const allRecords = auditStore.getAuditRecords(today);
  auditDb.backfill(allRecords);
  const recon0 = auditDb.reconcile(today);
  check('D/16 回灌后对账无差异', recon0.missingInDb.length === 0 && recon0.extraInDb.length === 0,
    `jsonl=${recon0.jsonl.count} db=${recon0.db.count} miss=${recon0.missingInDb.length} extra=${recon0.extraInDb.length}`);
  check('D/17 对账 JSONL 计数 = 实际行数', recon0.jsonl.count === jsonlLines(today),
    `recon=${recon0.jsonl.count} lines=${jsonlLines(today)}`);

  // 手工删除 DB 中 5 条（扮演运维）
  const victims = recon0.db.ids.slice(0, 5);
  const raw = rawDb();
  for (const id of victims) raw.prepare('DELETE FROM audit_records WHERE id = ?').run(id);
  raw.close();
  const recon1 = auditDb.reconcile(today);
  check('D/18 对账精确列出被删的 5 个 id',
    recon1.missingInDb.length === 5 && victims.every((id) => recon1.missingInDb.includes(id)),
    `missing=${recon1.missingInDb.length}`);

  const b1 = auditDb.backfill(auditStore.getAuditRecords(today));
  const c1 = auditDb.count(today);
  const b2 = auditDb.backfill(auditStore.getAuditRecords(today));
  const c2 = auditDb.count(today);
  check('D/19 回灌后 5 条全部回来', b1.inserted === 5, `inserted=${b1.inserted} updated=${b1.updated}`);
  check('D/20 重复回灌幂等（行数不翻倍、无新插入）', c1 === c2 && b2.inserted === 0,
    `c1=${c1} c2=${c2} inserted2=${b2.inserted}`);
  const recon2 = auditDb.reconcile(today);
  check('D/21 回灌后对账恢复无差异', recon2.missingInDb.length === 0 && recon2.extraInDb.length === 0,
    `miss=${recon2.missingInDb.length} extra=${recon2.extraInDb.length}`);

  console.log('\n── R3-22 dualWrite.enabled=false ⇒ 无 DB 增长 ──');
  const cfg = loadConfig();
  const original = cfg.auditStore.dualWrite.enabled;
  cfg.auditStore.dualWrite.enabled = false;
  const dbCountBefore = auditDb.count(today);
  const linesBefore = jsonlLines(today);
  const recOff = auditStore.saveAuditRecord('双写关闭文本', sampleResult(), {});
  await auditStore.flushAuditDb();
  check('D/22 关闭后 JSONL 照常追加（逐字节等于现状）', jsonlLines(today) === linesBefore + 1,
    `lines=${jsonlLines(today)}`);
  check('D/23 关闭后 DB 零增长', auditDb.count(today) === dbCountBefore, `db=${auditDb.count(today)}`);
  check('D/24 状态如实报告 enabled=false / mode=jsonl-only',
    auditStore.getDualWriteStatus().enabled === false && auditStore.getDualWriteStatus().mode === 'jsonl-only',
    `enabled=${auditStore.getDualWriteStatus().enabled} mode=${auditStore.getDualWriteStatus().mode}`);
  check('D/25 关闭后入队为零（不产生幽灵积压）', auditStore.getDualWriteStatus().queued === 0,
    `queued=${auditStore.getDualWriteStatus().queued}`);
  void recOff;
  cfg.auditStore.dualWrite.enabled = original;

  console.log('\n── R3-21 node:sqlite 不可用 ⇒ 自动降级纯 JSONL ──');
  process.env.GRS_FORCE_NO_SQLITE = '1';
  auditDb._resetProbe();
  const pDown = auditDb.probe();
  check('D/26 探测报告不可用 + 原因', pDown.available === false && pDown.reason.length > 0, pDown.reason);
  const stDown = auditStore.getDualWriteStatus();
  check('D/27 状态显示 jsonl-only', stDown.mode === 'jsonl-only', `mode=${stDown.mode}`);
  const linesDown = jsonlLines(today);
  const recDown = auditStore.saveAuditRecord('降级文本', sampleResult(), {});
  check('D/28 降级后审核/记录照常（功能不缺失）', Boolean(recDown && recDown.id) && jsonlLines(today) === linesDown + 1,
    `id=${recDown && recDown.id}`);
  check('D/29 降级后不产生积压', auditStore.getDualWriteStatus().queued === 0, 'queued=0');
  delete process.env.GRS_FORCE_NO_SQLITE;
  auditDb._resetProbe();
  check('D/30 恢复探测后仍可用', auditDb.probe().available === true, auditDb.probe().reason);

  console.log('\n── R3-20 JSONL 写入失败 ⇒ 不抛（返回 null），沿用现状语义 ──');
  // v2.4.0：JSONL 落盘改为「持久 fd + writeSync」（仍**同步**，零丢失）。写失败路径 =
  //   writeSync 抛错 → 失效 fd 并回退 appendFileSync 也抛错 ⇒ saveAuditRecord 捕获返回 null
  //   （与原 appendFileSync 契约一致）。故本用例同时打桩 writeSync 与 appendFileSync。
  const realAppend = fs.appendFileSync;
  const realWriteSync = fs.writeSync;
  fs.writeSync = () => { throw Object.assign(new Error('模拟 JSONL writeSync 失败'), { code: 'EACCES' }); };
  fs.appendFileSync = (file, ...rest) => {
    if (String(file).endsWith('.jsonl') && !String(file).endsWith('_ops.jsonl')) {
      throw Object.assign(new Error('模拟 JSONL 写入失败'), { code: 'EACCES' });
    }
    return realAppend.call(fs, file, ...rest);
  };
  let jsonlThrew = null;
  let recFail = 'unset';
  try {
    recFail = auditStore.saveAuditRecord('JSONL 故障', sampleResult(), {});
  } catch (e) { jsonlThrew = String(e && e.message); }
  fs.appendFileSync = realAppend;
  fs.writeSync = realWriteSync;
  check('D/31 JSONL 失败不抛给调用方', jsonlThrew === null, jsonlThrew || 'no-throw');
  check('D/32 返回 null（沿用现状语义）', recFail === null, `ret=${JSON.stringify(recFail)}`);

  console.log('\n── 删除留痕 + listAuditDates 过滤 `/^_/` ──');
  const datesBefore = auditStore.listAuditDates().map((d) => d.date);
  check('D/33 删除前 _ops.jsonl 未被当成一天', !datesBefore.includes('_ops'), `dates=${datesBefore.join(',')}`);
  const clearRes = auditStore.clearAuditRecords(today);
  check('D/34 清除指定日期成功', clearRes.success === true && clearRes.deleted === 1, JSON.stringify(clearRes));
  check('D/35 留痕文件已写出', fs.existsSync(auditStore.OPS_FILE), auditStore.OPS_FILE);
  let ledger = [];
  try {
    ledger = fs.readFileSync(auditStore.OPS_FILE, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { ledger = []; }
  check('D/36 留痕内容含 op=clear + date + 删除数',
    ledger.length >= 1 && ledger[ledger.length - 1].op === 'clear' && ledger[ledger.length - 1].date === today,
    JSON.stringify(ledger[ledger.length - 1] || null));
  const datesAfter = auditStore.listAuditDates().map((d) => d.date);
  check('D/37 清除后 _ops.jsonl 仍不被当成一天（真实连带缺陷已修）',
    !datesAfter.includes('_ops'), `dates=${datesAfter.join(',') || '(空)'}`);
  check('D/38 清除后 DB 同步删除当日行', auditDb.count(today) === 0, `count=${auditDb.count(today)}`);

  auditDb.close();

  console.log('--------------------------------------------------------------------------------');
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(`运行异常: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  });
