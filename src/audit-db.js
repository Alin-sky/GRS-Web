/**
 * 审核记录 DB 投影（src/audit-db.js）
 * v0.2.0：JSONL 是**权威**，本模块提供 DB **投影/加速层**。设计约束：
 * ① **唯一直连 `node:sqlite` 的文件** —— 未来若 Node 的 sqlite API 变化，只改这一个文件。
 * ② **同步 API**（`DatabaseSync`）⇒ 写入必须在 `setImmediate` 回调里批量执行，**绝不进入
 * 审核关键路径的 `await` 链**（由 `src/audit-store.js` 负责排队）。
 * ③ **启动探测 + 自动降级**：`require('node:sqlite')` 失败或 Node < 22.5 ⇒ `probe().available=false`，
 * 上层自动切「纯 JSONL 模式」，**绝不崩、绝不阻断审核**。
 * ④ **`PRAGMA user_version` 做 schema 版本闸门**：未知版本 ⇒ 拒绝写入 + 告警（不猜、不迁移）。
 * 测试隔离：环境变量 `GRS_AUDIT_DB` 可把库重定向到临时路径（默认 `<projectRoot>/data/audit.db`，
 * 与生产行为完全一致）。`GRS_FORCE_NO_SQLITE=1` 可强制探测失败（用于验证降级路径，测试专用）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getProjectRoot, loadConfig } = require('./config');
const { logInfo, logWarn, logError } = require('./logger');

/** 当前 schema 版本（写入 `PRAGMA user_version`）*/
const SCHEMA_VERSION = 1;
/** `node:sqlite` 最低 Node 版本*/
const MIN_NODE_MINOR = 5;
const MIN_NODE_MAJOR = 22;

/** DB 文件路径（ 测试用 `GRS_AUDIT_DB` 重定向；默认与生产完全一致）*/
const DB_PATH = process.env.GRS_AUDIT_DB
  ? path.resolve(process.env.GRS_AUDIT_DB)
  : path.join(getProjectRoot(), 'data', 'audit.db');

/** 建表 + 索引（幂等）*/
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_records (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT,
  date        TEXT NOT NULL,
  text        TEXT,
  model       TEXT,
  result_json TEXT NOT NULL,
  meta_json   TEXT,
  risk_level  TEXT,
  passed      INTEGER,
  modality    TEXT,
  image_hash  TEXT,
  created_at  TEXT NOT NULL,
  origin      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_date      ON audit_records(date);
CREATE INDEX IF NOT EXISTS idx_audit_model     ON audit_records(model);
CREATE INDEX IF NOT EXISTS idx_audit_risk      ON audit_records(risk_level);
CREATE INDEX IF NOT EXISTS idx_audit_passed    ON audit_records(passed);
CREATE INDEX IF NOT EXISTS idx_audit_date_risk ON audit_records(date, risk_level);
CREATE INDEX IF NOT EXISTS idx_audit_image     ON audit_records(image_hash) WHERE image_hash IS NOT NULL;

-- v0.2.0（B·判定缓存）：同图+同模型+同暴露档位 复用上次视觉判定，跳过云端计费调用。
--   键 = (image_hash, model, exposure_mode)：
--     · image_hash   与 image_ref.hash 同算法（sha256 前 16 位，内容寻址）⇒ 同图天然命中
--     · model        不同模型的判定不可互借
--     · exposure_mode 暴露档位改写提示词 ⇒ 判定随档位变化，**必须**入键，
--                    否则「strict 档存下的 high」会被 lenient 档复用（错误放行）
--   故意**不**提升 SCHEMA_VERSION：本表用 IF NOT EXISTS 幂等建表，对既有库
--     （user_version=1）零迁移、零破坏；若把版本抬到 2，旧库会被版本闸门整体拒绝写入。
CREATE TABLE IF NOT EXISTS verdict_cache (
  image_hash    TEXT NOT NULL,
  model         TEXT NOT NULL,
  exposure_mode TEXT NOT NULL DEFAULT 'standard',
  verdict_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (image_hash, model, exposure_mode)
);

-- 通用插件 KV（带 TTL）：供插件做命名空间隔离的持久化缓存（如 request-dedupe 去重）。
--   键 = (namespace, key)；created_at / expires_at 为 epoch 毫秒整数；expires_at IS NULL = 永不过期。
--   与 verdict_cache 一样用 IF NOT EXISTS 幂等建表，不提升 SCHEMA_VERSION（对既有库零迁移）。
CREATE TABLE IF NOT EXISTS plugin_kv (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_plugin_kv_expires ON plugin_kv(expires_at) WHERE expires_at IS NOT NULL;
`;

/** 幂等 upsert：回灌可重复执行（`created_at`/`origin` 故意不被覆盖，保留首次落库身份）*/
const UPSERT_SQL = `
INSERT INTO audit_records (id,timestamp,date,text,model,result_json,meta_json,
                           risk_level,passed,modality,image_hash,created_at,origin)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  timestamp=excluded.timestamp, date=excluded.date, text=excluded.text, model=excluded.model,
  result_json=excluded.result_json, meta_json=excluded.meta_json, risk_level=excluded.risk_level,
  passed=excluded.passed, modality=excluded.modality, image_hash=excluded.image_hash
`;

/** 已打开的库句柄*/
let _db = null;
/** 上次错误信息（供系统信息页）*/
let _lastError = null;
/** schema 版本闸门失败原因（非 null ⇒ 拒绝写入）*/
let _schemaError = null;
/** 当前 schema 版本（0 = 未初始化）*/
let _schemaVersion = 0;
/** 探测结果缓存*/
let _probeCache = null;
/** 预编译语句缓存*/
let _stmt = null;

/**
 * 与 `audit-store.getDateStr()` 同口径（本地时区 YYYY-MM-DD）。
 * 刻意在本模块内联实现，避免 `audit-db ↔ audit-store` 循环依赖。
 * @param {string|number|Date} [date] 时间
 * @returns {string} YYYY-MM-DD
 */
function getDateStr(date) {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 能力探测：Node 版本 + `require('node:sqlite')`。
 * @returns {{available: boolean, reason: string}} 探测结果
 */
function probe() {
  if (_probeCache) return _probeCache;
  if (process.env.GRS_FORCE_NO_SQLITE === '1') {
    _probeCache = { available: false, reason: "已通过 GRS_FORCE_NO_SQLITE=1 强制禁用 node:sqlite（测试专用）" };
    return _probeCache;
  }
  const v = String(process.versions.node || '0.0.0');
  const parts = v.split('.').map((n) => parseInt(n, 10) || 0);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    _probeCache = {
      available: false,
      reason: `Node ${v} < ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}，node:sqlite 不可用（自动降级为纯 JSONL）`,
    };
    return _probeCache;
  }
  try {
    const sqlite = require('node:sqlite');
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
      _probeCache = { available: false, reason: 'node:sqlite 未导出 DatabaseSync' };
      return _probeCache;
    }
    _probeCache = { available: true, reason: `node:sqlite 可用（Node ${v}）` };
    return _probeCache;
  } catch (err) {
    _probeCache = { available: false, reason: `require('node:sqlite') 失败: ${err && err.message}` };
    return _probeCache;
  }
}

/**
 * 重置探测缓存（测试专用）。
 * @returns {void}
 */
function _resetProbe() {
  _probeCache = null;
}

/**
 * 建库 / 建表 / 建索引 / schema 版本闸门。**幂等**，重复调用无副作用。
 * @returns {void}
 */
function open() {
  if (_db) return;
  const p = probe();
  if (!p.available) {
    _lastError = p.reason;
    return;
  }
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');

    const verRow = db.prepare('PRAGMA user_version').get();
    const ver = Number(verRow && verRow.user_version) || 0;
    if (ver === 0) {
      db.exec(SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      _schemaVersion = SCHEMA_VERSION;
    } else if (ver === SCHEMA_VERSION) {
      db.exec(SCHEMA_SQL); // 幂等补齐索引（应对中途删过索引）
      _schemaVersion = ver;
    } else {
      _schemaError = `未知 schema 版本 ${ver}（期望 ${SCHEMA_VERSION}），已拒绝写入以免损坏数据`;
      logWarn('audit-db', _schemaError);
      db.close();
      return;
    }

    _db = db;
    _stmt = {
      upsert: db.prepare(UPSERT_SQL),
      has: db.prepare('SELECT 1 AS found FROM audit_records WHERE id = ? LIMIT 1'),
      countAll: db.prepare('SELECT COUNT(*) AS n FROM audit_records'),
      countDate: db.prepare('SELECT COUNT(*) AS n FROM audit_records WHERE date = ?'),
      idsByDate: db.prepare('SELECT id FROM audit_records WHERE date = ?'),
      deleteDate: db.prepare('DELETE FROM audit_records WHERE date = ?'),
      deleteAll: db.prepare('DELETE FROM audit_records'),
      // v0.2.0（B）：判定缓存
      vcGet: db.prepare('SELECT verdict_json, created_at FROM verdict_cache'
        + ' WHERE image_hash = ? AND model = ? AND exposure_mode = ? LIMIT 1'),
      vcSet: db.prepare('INSERT INTO verdict_cache (image_hash, model, exposure_mode, verdict_json, created_at)'
        + ' VALUES (?,?,?,?,?)'
        + ' ON CONFLICT(image_hash, model, exposure_mode) DO UPDATE SET'
        + ' verdict_json = excluded.verdict_json, created_at = excluded.created_at'),
      vcCount: db.prepare('SELECT COUNT(*) AS n FROM verdict_cache'),
      vcDeleteAll: db.prepare('DELETE FROM verdict_cache'),
      // 通用插件 KV（带 TTL）
      kvSet: db.prepare('INSERT INTO plugin_kv (namespace, key, value_json, created_at, expires_at)'
        + ' VALUES (?,?,?,?,?)'
        + ' ON CONFLICT(namespace, key) DO UPDATE SET'
        + ' value_json = excluded.value_json, created_at = excluded.created_at, expires_at = excluded.expires_at'),
      kvGet: db.prepare('SELECT value_json, created_at, expires_at FROM plugin_kv WHERE namespace = ? AND key = ? LIMIT 1'),
      kvDel: db.prepare('DELETE FROM plugin_kv WHERE namespace = ? AND key = ?'),
      kvDelNs: db.prepare('DELETE FROM plugin_kv WHERE namespace = ?'),
      kvDelAll: db.prepare('DELETE FROM plugin_kv'),
      kvCountNs: db.prepare('SELECT COUNT(*) AS n FROM plugin_kv WHERE namespace = ?'),
      kvCountAll: db.prepare('SELECT COUNT(*) AS n FROM plugin_kv'),
      kvPurgeExpired: db.prepare('DELETE FROM plugin_kv WHERE expires_at IS NOT NULL AND expires_at <= ?'),
    };
    _lastError = null;
    logInfo('audit-db', `审核记录 DB 已就绪: ${DB_PATH}（schema v${_schemaVersion}，WAL）`);
  } catch (err) {
    _lastError = err && err.message;
    logError('audit-db', `打开审核记录 DB 失败（自动降级为纯 JSONL）: ${_lastError}`);
    _db = null;
  }
}

/**
 * 是否已就绪。
 * @returns {boolean} 是否可用
 */
function isOpen() {
  return Boolean(_db) && !_schemaError;
}

/**
 * 把一条审核记录归一化为 DB 行。
 * @param {object} record 审核记录
 * @param {'live'|'backfill'|'compensate'} origin 来源
 * @returns {object} 行对象
 */
function toRow(record, origin) {
  const r = record && typeof record === 'object' ? record : {};
  const result = (r.result && typeof r.result === 'object') ? r.result : {};
  const ref = (result.image_ref && typeof result.image_ref === 'object') ? result.image_ref : null;
  const text = typeof r.text === 'string' ? r.text : '';
  const isImageText = text === '[图片审核]' || text === '[批量图片]';
  return {
    id: String(r.id !== undefined && r.id !== null ? r.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    timestamp: r.timestamp ? String(r.timestamp) : null,
    date: String(r.date || getDateStr(r.timestamp)),
    text,
    model: (r.model === undefined || r.model === null) ? null : String(r.model),
    result_json: JSON.stringify(result),
    meta_json: JSON.stringify((r.meta && typeof r.meta === 'object') ? r.meta : {}),
    risk_level: (result.risk_level === undefined || result.risk_level === null) ? null : String(result.risk_level),
    passed: (result.passed === undefined || result.passed === null) ? null : (result.passed ? 1 : 0),
    modality: (ref || isImageText) ? 'image' : 'text',
    image_hash: (ref && typeof ref.hash === 'string') ? ref.hash : null,
    created_at: new Date().toISOString(),
    origin: origin || 'live',
  };
}

/**
 * 幂等 upsert 一条记录。
 * @param {object} record 审核记录
 * @param {'live'|'backfill'|'compensate'} [origin] 来源
 * @returns {boolean} 是否成功（失败不抛，交由上层降级）
 */
function upsert(record, origin = 'live') {
  if (!isOpen()) return false;
  try {
    const row = toRow(record, origin);
    _stmt.upsert.run(row.id, row.timestamp, row.date, row.text, row.model, row.result_json,
      row.meta_json, row.risk_level, row.passed, row.modality, row.image_hash, row.created_at, row.origin);
    return true;
  } catch (err) {
    _lastError = err && err.message;
    logWarn('audit-db', `DB 写入失败（已交由补偿队列重试）: ${_lastError}`);
    return false;
  }
}

/**
 * 单事务批量幂等 upsert。
 * @param {Array<object>} records 记录数组
 * @param {'live'|'backfill'|'compensate'} [origin] 来源
 * @returns {{inserted: number, updated: number}} 统计
 */
function upsertMany(records, origin = 'live') {
  const stat = { inserted: 0, updated: 0 };
  if (!isOpen()) return stat;
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return stat;
  try {
    _db.exec('BEGIN');
    for (const rec of list) {
      const row = toRow(rec, origin);
      const found = _stmt.has.get(row.id);
      _stmt.upsert.run(row.id, row.timestamp, row.date, row.text, row.model, row.result_json,
        row.meta_json, row.risk_level, row.passed, row.modality, row.image_hash, row.created_at, row.origin);
      if (found) stat.updated += 1; else stat.inserted += 1;
    }
    _db.exec('COMMIT');
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* 回滚失败也不抛给调用方*/ }
    _lastError = err && err.message;
    logWarn('audit-db', `DB 批量写入失败: ${_lastError}`);
  }
  return stat;
}

/**
 * 查询记录（返回与 JSONL 同构的完整记录对象，供历史页直接消费）。
 * @param {object} [filter] 过滤条件 { date, model, risk_level, passed, image_hash, modality, from, to, limit }
 * @returns {Array<object>} 记录数组
 */
function query(filter = {}) {
  if (!isOpen()) return [];
  const where = [];
  const args = [];
  if (filter.date) { where.push('date = ?'); args.push(String(filter.date)); }
  if (filter.from) { where.push('date >= ?'); args.push(String(filter.from)); }
  if (filter.to) { where.push('date <= ?'); args.push(String(filter.to)); }
  if (filter.model) { where.push('model = ?'); args.push(String(filter.model)); }
  if (filter.risk_level) { where.push('risk_level = ?'); args.push(String(filter.risk_level)); }
  if (filter.passed !== undefined && filter.passed !== null) {
    where.push('passed = ?'); args.push(filter.passed ? 1 : 0);
  }
  if (filter.image_hash) { where.push('image_hash = ?'); args.push(String(filter.image_hash)); }
  if (filter.modality) { where.push('modality = ?'); args.push(String(filter.modality)); }
  const limit = Number(filter.limit) > 0 ? Math.min(Number(filter.limit), 100000) : 100000;
  const sql = 'SELECT id, timestamp, date, text, model, result_json, meta_json FROM audit_records'
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ` ORDER BY timestamp ASC LIMIT ${limit}`;
  try {
    const rows = _db.prepare(sql).all(...args);
    return rows.map((row) => {
      let result = {};
      let meta = {};
      try { result = JSON.parse(row.result_json); } catch { result = {}; }
      try { meta = JSON.parse(row.meta_json || '{}'); } catch { meta = {}; }
      // 与 JSONL 记录同构：{id,timestamp,date,text,model,result,meta}
      return {
        id: row.id,
        timestamp: row.timestamp,
        date: row.date,
        text: row.text,
        model: row.model,
        result,
        meta,
      };
    });
  } catch (err) {
    _lastError = err && err.message;
    logWarn('audit-db', `DB 查询失败: ${_lastError}`);
    return [];
  }
}

/**
 * 计数。
 * @param {string} [date] 日期（省略则全库）
 * @returns {number} 行数
 */
function count(date) {
  if (!isOpen()) return 0;
  try {
    const row = date ? _stmt.countDate.get(String(date)) : _stmt.countAll.get();
    return Number(row && row.n) || 0;
  } catch (err) {
    _lastError = err && err.message;
    return 0;
  }
}

/**
 * 取指定日期的全部 id。
 * @param {string} date 日期 YYYY-MM-DD
 * @returns {string[]} id 列表
 */
function idsOf(date) {
  if (!isOpen()) return [];
  try {
    return _stmt.idsByDate.all(String(date)).map((r) => String(r.id));
  } catch (err) {
    _lastError = err && err.message;
    return [];
  }
}

/**
 * 对账：比对 JSONL（权威）与 DB（投影）。**只报告，不改任何文件**。
 * @param {string} date 日期 YYYY-MM-DD
 * @returns {{date: string, jsonl: object, db: object, missingInDb: string[], extraInDb: string[]}} 报告
 */
function reconcile(date) {
  // 惰性 require：避免 audit-db ↔ audit-store 的循环依赖（调用时两侧均已加载完毕）
  const auditStore = require('./audit-store');
  const target = String(date || getDateStr());
  const records = auditStore.getAuditRecords(target) || [];
  const jsonlIds = records.map((r) => String(r.id));
  const dbIds = idsOf(target);
  const jsonlSet = new Set(jsonlIds);
  const dbSet = new Set(dbIds);
  return {
    date: target,
    jsonl: { count: jsonlIds.length, ids: jsonlIds },
    db: { count: dbIds.length, ids: dbIds },
    missingInDb: jsonlIds.filter((id) => !dbSet.has(id)),
    extraInDb: dbIds.filter((id) => !jsonlSet.has(id)),
  };
}

/**
 * 回灌（JSONL → DB）：幂等 upsert。
 * @param {Array<object>} records 记录数组
 * @returns {{inserted: number, updated: number}} 统计
 */
function backfill(records) {
  return upsertMany(records, 'backfill');
}

/**
 * 删除指定日期的全部 DB 行。
 * @param {string} date 日期 YYYY-MM-DD
 * @returns {number} 删除行数
 */
function deleteByDate(date) {
  if (!isOpen()) return 0;
  try {
    const res = _stmt.deleteDate.run(String(date));
    return Number(res && res.changes) || 0;
  } catch (err) {
    _lastError = err && err.message;
    logWarn('audit-db', `DB 按日删除失败: ${_lastError}`);
    return 0;
  }
}

/**
 * 清空 DB。
 * @returns {number} 删除行数
 */
function deleteAll() {
  if (!isOpen()) return 0;
  try {
    const before = count();
    _stmt.deleteAll.run();
    return before;
  } catch (err) {
    _lastError = err && err.message;
    logWarn('audit-db', `DB 清空失败: ${_lastError}`);
    return 0;
  }
}

// v0.2.0（B·判定缓存）：verdict_cache 读写
// 要点：命中 ⇒ 调用方跳过云端调用（省钱的全部意义）；未命中由调用方在成功后回写。
// · 存模型**原始输出字符串**，回放仍走 extractJSON → validateVerdict 强校验链，
//   不做「信任缓存就跳过校验」的捷径；policy_version 变更后旧缓存自然校验失败 ⇒ 回到真实调用。
// · DB 不可用（Node < 22.5 / schema 闸门拒绝）⇒ 返回 null/false ⇒ 缓存自动禁用，
//   审核退回「每次真打云端」，**绝不**因此失败。
// · 全同步 API（DatabaseSync），SELECT/UPSERT 走主键，代价可忽略。

/**
 * 查判定缓存。
 * @param {string} imageHash 图片内容 hash（sha256 前 16 位，与 image_ref.hash 同算法）
 * @param {string} model 视觉模型名
 * @param {string} exposureMode 暴露档位
 * @returns {{verdictJson: string, createdAt: string}|null} 命中结果；未命中 / DB 不可用 ⇒ null
 */
function verdictCacheGet(imageHash, model, exposureMode) {
  if (!isOpen()) return null;
  try {
    const row = _stmt.vcGet.get(String(imageHash || ''), String(model || ''), String(exposureMode || 'standard'));
    if (!row || !row.verdict_json) return null;
    return { verdictJson: String(row.verdict_json), createdAt: String(row.created_at || '') };
  } catch (err) {
    _lastError = err && err.message;
    return null; // 缓存读失败不影响审核
  }
}

/**
 * 写判定缓存（幂等 upsert；成功与否都不抛）。
 * @param {string} imageHash 图片内容 hash
 * @param {string} model 视觉模型名
 * @param {string} exposureMode 暴露档位
 * @param {string} verdictJson 模型原始输出（JSON 字符串）
 * @returns {boolean} 是否写入成功
 */
function verdictCacheSet(imageHash, model, exposureMode, verdictJson) {
  if (!isOpen()) return false;
  const json = String(verdictJson || '');
  if (!imageHash || !model || !json) return false;
  try {
    _stmt.vcSet.run(String(imageHash), String(model), String(exposureMode || 'standard'), json, new Date().toISOString());
    return true;
  } catch (err) {
    _lastError = err && err.message;
    logWarn('audit-db', `判定缓存写入失败（已忽略，不影响审核）: ${_lastError}`);
    return false;
  }
}

/** 缓存条目数（供系统信息页 / 状态接口）。*/
function verdictCacheCount() {
  if (!isOpen()) return 0;
  try {
    const row = _stmt.vcCount.get();
    return Number(row && row.n) || 0;
  } catch { return 0; }
}

/** 清空判定缓存（测试 / 用户主动刷新判定用）。@returns {number} 删除行数*/
function clearVerdictCache() {
  if (!isOpen()) return 0;
  const before = verdictCacheCount();
  try {
    _stmt.vcDeleteAll.run();
    return before;
  } catch { return 0; }
}

// ─── 通用插件 KV（带 TTL，命名空间隔离）───
// 设计：核心只提供一个「带过期时间的持久化 KV」原语，具体缓存语义（键怎么算、TTL 多长、
// 命中怎么用）全部交给插件（如 request-dedupe）。这样内核保持可扩展、不与任何单一插件耦合。

/**
 * 写入 KV（幂等 upsert）。DB 不可用 / 参数非法 ⇒ 返回 false，绝不抛异常。
 * @param {string} namespace 命名空间（插件 id 等）
 * @param {string} key 键
 * @param {string} valueJson 值（JSON 字符串，由调用方负责序列化）
 * @param {{ttlSeconds?: number}} [opts] ttlSeconds>0 ⇒ 该秒数后过期；<=0 或缺省 ⇒ 永不过期
 * @returns {boolean} 是否写入成功
 */
function kvSet(namespace, key, valueJson, opts = {}) {
  if (!isOpen()) return false;
  const ns = String(namespace || '');
  const k = String(key || '');
  if (!ns || !k) return false;
  const ttl = Number(opts && opts.ttlSeconds);
  const now = Date.now();
  const expires = Number.isFinite(ttl) && ttl > 0 ? now + Math.round(ttl * 1000) : null;
  try {
    _stmt.kvSet.run(ns, k, String(valueJson == null ? '' : valueJson), now, expires);
    return true;
  } catch (err) {
    _lastError = err && err.message;
    return false;
  }
}

/**
 * 读取 KV；过期条目惰性删除并返回 null。DB 不可用 ⇒ null。
 * @param {string} namespace 命名空间
 * @param {string} key 键
 * @param {number} [nowMs] 判定过期的「当前时间」（epoch ms，缺省 Date.now()；测试可注入）
 * @returns {{valueJson: string, createdAt: number, expiresAt: number|null}|null}
 */
function kvGet(namespace, key, nowMs) {
  if (!isOpen()) return null;
  const ns = String(namespace || '');
  const k = String(key || '');
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  try {
    const row = _stmt.kvGet.get(ns, k);
    if (!row) return null;
    const expiresAt = (row.expires_at === null || row.expires_at === undefined) ? null : Number(row.expires_at);
    if (expiresAt !== null && now > expiresAt) {
      try { _stmt.kvDel.run(ns, k); } catch { /* 惰性删除失败忽略 */ }
      return null;
    }
    return { valueJson: String(row.value_json), createdAt: Number(row.created_at), expiresAt };
  } catch (err) {
    _lastError = err && err.message;
    return null;
  }
}

/**
 * 清理 KV。给定 namespace ⇒ 只清该命名空间；缺省/空 ⇒ 清全部。
 * @param {string} [namespace] 命名空间
 * @returns {number} 删除行数
 */
function kvClear(namespace) {
  if (!isOpen()) return 0;
  try {
    if (namespace === undefined || namespace === null || namespace === '') {
      const row = _stmt.kvCountAll.get();
      const before = Number(row && row.n) || 0;
      _stmt.kvDelAll.run();
      return before;
    }
    const ns = String(namespace);
    const row = _stmt.kvCountNs.get(ns);
    const before = Number(row && row.n) || 0;
    _stmt.kvDelNs.run(ns);
    return before;
  } catch (err) {
    _lastError = err && err.message;
    return 0;
  }
}

/**
 * KV 条目数（供状态接口 / 测试）。
 * @param {string} [namespace] 命名空间；缺省统计全部
 * @returns {number} 条目数
 */
function kvCount(namespace) {
  if (!isOpen()) return 0;
  try {
    const row = (namespace === undefined || namespace === null || namespace === '')
      ? _stmt.kvCountAll.get()
      : _stmt.kvCountNs.get(String(namespace));
    return Number(row && row.n) || 0;
  } catch { return 0; }
}

/**
 * 清除所有已过期条目（周期性维护用）。
 * @param {number} [nowMs] 当前时间（epoch ms）
 * @returns {number} 删除行数
 */
function kvPurgeExpired(nowMs) {
  if (!isOpen()) return 0;
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  try {
    const info = _stmt.kvPurgeExpired.run(now);
    return Number(info && info.changes) || 0;
  } catch { return 0; }
}

/**
 * 关闭库。
 * @returns {void}
 */
function close() {
  if (!_db) return;
  try { _db.close(); } catch { /* 关闭失败忽略*/ }
  _db = null;
  _stmt = null;
}

/**
 * 状态快照（供系统信息页 / `/api/audit-store/status`）。
 * @returns {object} 状态
 */
function getStatus() {
  const p = probe();
  return {
    available: p.available,
    reason: p.reason,
    dbPath: DB_PATH,
    open: isOpen(),
    schemaVersion: _schemaVersion,
    schemaError: _schemaError,
    lastError: _lastError,
  };
}

/** DB 文件绝对路径*/
function getDbPath() {
  return DB_PATH;
}

/** 当前 schema 版本*/
function getSchemaVersion() {
  return _schemaVersion;
}

/**
 * 读取 `auditStore` 配置（含兜底）。
 * @returns {{dualWrite: {enabled: boolean}}} 配置
 */
function getAuditStoreCfg() {
  try {
    const cfg = loadConfig();
    const as = (cfg && cfg.auditStore) || {};
    const dw = (as.dualWrite && typeof as.dualWrite === 'object') ? as.dualWrite : {};
    return { dualWrite: { enabled: dw.enabled !== false } };
  } catch {
    return { dualWrite: { enabled: true } };
  }
}

module.exports = {
  SCHEMA_VERSION,
  probe,
  _resetProbe,
  open,
  isOpen,
  upsert,
  upsertMany,
  query,
  count,
  idsOf,
  reconcile,
  backfill,
  deleteByDate,
  deleteAll,
  verdictCacheGet,
  verdictCacheSet,
  verdictCacheCount,
  clearVerdictCache,
  kvSet,
  kvGet,
  kvClear,
  kvCount,
  kvPurgeExpired,
  close,
  getStatus,
  getDbPath,
  getSchemaVersion,
  getAuditStoreCfg,
  getDateStr,
  toRow,
};
