const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');
const { logInfo, logError, logWarn } = require('./logger');
const auditDb = require('./audit-db');

/**
 * 审核记录存储目录。
 * 默认 = `<projectRoot>/data/audit_records`（生产路径，**行为与历史完全一致**）。
 * 测试可用环境变量 `GRS_AUDIT_DIR` 重定向到临时目录 —— 回归脚本不再对生产审计文件
 * 做「读-改-写」（2026-09-16 审计文件损坏事故的根因之一就是这个作用域问题）。
 * v0.2.0：DB 投影的隔离变量是 `GRS_AUDIT_DB`（对齐本变量，定义在 `src/audit-db.js`），
 * 回归脚本必须同时设置两者，绝不触碰生产 `data/audit.db`。
 */
const STORE_DIR = process.env.GRS_AUDIT_DIR
  ? path.resolve(process.env.GRS_AUDIT_DIR)
  : path.join(getProjectRoot(), 'data', 'audit_records');

/** v0.2.0：删除等破坏性操作的**留痕文件**（append-only）。
 * 因为它在 STORE_DIR 内，`listAuditDates()` **必须**过滤 `/^_/` 前缀，否则会被当成「一天」。*/
const OPS_FILE = path.join(STORE_DIR, '_ops.jsonl');

// 确保存储目录存在
if (!fs.existsSync(STORE_DIR)) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

/**
 * 获取日期字符串 (YYYY-MM-DD)，基于本地时区
 */
function getDateStr(date) {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 获取指定日期的审核记录文件路径
 */
function getFilePath(dateStr) {
  return path.join(STORE_DIR, `${dateStr}.jsonl`);
}

// ─── v2.4.0：JSONL 权威落盘用「持久 fd + 每条 writeSync」───
// 动机：原实现每条记录都 fs.appendFileSync（open+write+close 三次系统调用），突发流量下逐条
//   open/close 拖慢热路径。改为：按日期缓存一个以 'a' 追加模式打开的 fd，每条只 writeSync
//   （一次 write 系统调用）⇒ 省去 open/close，且**仍同步落盘**（与原 appendFileSync 同等持久性：
//   零延迟、零丢失、写失败可同步感知）。fd 失效（文件被外部删除/清理）时自动回退 appendFileSync 重开。

/** 已打开的 JSONL 追加写 fd 缓存：dateStr → fd（通常只有当前日期一个；跨零点自然新开）。*/
const _jsonlFds = new Map();

/**
 * 取（或打开）指定日期的追加写 fd。打开失败返回 null（调用方回退 appendFileSync）。
 * @param {string} dateStr 日期
 * @param {string} filePath 文件路径
 * @returns {number|null} fd 或 null
 */
function getJsonlFd(dateStr, filePath) {
  const cached = _jsonlFds.get(dateStr);
  if (cached !== undefined) return cached;
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    const fd = fs.openSync(filePath, 'a');
    _jsonlFds.set(dateStr, fd);
    return fd;
  } catch {
    return null;
  }
}

/**
 * 关闭并失效某日期（或全部）的缓存 fd。**文件被删除/清理后必须调用**，
 * 否则后续 writeSync 会写进已删除的孤立 inode（数据看似成功实则丢失）。
 * @param {string} [dateStr] 缺省关闭全部
 * @returns {void}
 */
function invalidateJsonlFd(dateStr) {
  try {
    if (dateStr === undefined) {
      for (const fd of _jsonlFds.values()) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      _jsonlFds.clear();
      return;
    }
    const fd = _jsonlFds.get(dateStr);
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      _jsonlFds.delete(dateStr);
    }
  } catch { /* ignore */ }
}

// 进程退出：关闭所有缓存 fd（'exit' 只能做同步操作）。
process.on('exit', () => { try { invalidateJsonlFd(); } catch { /* ignore */ } });

/**
 * 保存一条审核记录（含原始文本）
 * @param {string} text - 原始审核文本
 * @param {object} result - 审核结果
 * @param {object} meta - 元数据 (userId, groupId, messageId)
 */
function saveAuditRecord(text, result, meta = {}) {
  try {
    const dateStr = getDateStr();
    const filePath = getFilePath(dateStr);

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      date: dateStr,
      text,
      // v2.3.0（Req6）：旧兜底值 'qwen3-14b' 是一个从未被配置过的模型名，
      // 会让审核记录后端直接渲染出一个不存在的模型，并混入对比基线。
      // 查不到就不献槽：置 null，展示层自行显示 '-'（与 model-profiles 的 known:false 同原则）。
      model: result.model || null,
      result: { ...result },
      meta,
    };
    const line = JSON.stringify(record) + '\n';

    // v2.4.0：持久 fd + writeSync —— 同步落盘（零丢失），仅省去每条的 open/close 系统调用。
    let written = false;
    const fd = getJsonlFd(dateStr, filePath);
    if (fd !== null) {
      try {
        fs.writeSync(fd, line);
        written = true;
      } catch {
        // fd 可能已失效（文件被外部删除/清理）：关闭+清缓存，下面用 appendFileSync 兜底重开一次
        invalidateJsonlFd(dateStr);
      }
    }
    if (!written) {
      // 兜底：appendFileSync 自行 open+write+close；失败则抛 → 外层 catch 返回 null（沿用原契约）
      fs.appendFileSync(filePath, line, 'utf-8');
    }

    // v2.4.0：把本次落库的记录 id 回填到 result 对象（additive，不改变已写入的 record）。
    // 供 request-dedupe 观察钩子记录「首次结果对应哪条审核记录」，使重复记录的 dedup.of 可回溯/跳转。
    if (result && typeof result === 'object' && !result.id) {
      try { result.id = record.id; } catch { /* 冻结对象等异常忽略 */ }
    }
    // v0.2.0 写入顺序铁律：先 JSONL（权威）后 DB（投影）。
    // DB 只做同步 `queue.push` + `setImmediate`，**绝不在本函数内 await** ⇒ 不拖挂审核主链路。
    enqueueForDb(record, 'live');
    return record;
  } catch (err) {
    logError('audit-store', `保存审核记录失败: ${err.message}`);
    return null;
  }
}

// ─── 双写（JSONL 权威 → DB 投影）：有界补偿队列 + fail-open ───

/** 补偿队列上限（ 有界；溢出丢最旧并计数）*/
const DB_QUEUE_CAP = 1000;
/** 单条记录最多重试次数（超过则丢弃 + 计数；JSONL 是权威 ⇒ 可用对账+回灌无损补齐）*/
const DB_MAX_ATTEMPTS = 3;
/** 后台重试间隔（30s；timer.unref ⇒ 不阻塞进程退出）*/
const DB_RETRY_MS = 30 * 1000;

/** 待写 DB 的队列项*/
let _dbQueue = [];
/** 溢出 / 重试耗尽导致丢弃的条数*/
let _dbDropped = 0;
/** 最近一次 DB 错误*/
let _dbLastError = null;
/** setImmediate 是否已排程（避免重复排程）*/
let _flushScheduled = false;

/**
 * 双写是否生效（配置开关 + 能力探测，缺一不可）。
 * @returns {boolean} 是否启用双写
 */
function dualWriteActive() {
  try {
    return auditDb.getAuditStoreCfg().dualWrite.enabled && auditDb.probe().available;
  } catch {
    return false;
  }
}

/** 确保 DB 已打开（仅在双写生效时）。*/
function ensureDbOpen() {
  if (!dualWriteActive()) return;
  if (!auditDb.isOpen()) auditDb.open();
}

/**
 * 入队一条记录（同步 O(1)，**绝不抛**）。
 * @param {object} record 审核记录
 * @param {'live'|'backfill'|'compensate'} origin 来源
 * @returns {void}
 */
function enqueueForDb(record, origin) {
  try {
    if (!dualWriteActive()) return;
    if (_dbQueue.length >= DB_QUEUE_CAP) {
      _dbQueue.shift();
      _dbDropped += 1;
    }
    _dbQueue.push({ record, origin: origin || 'live', attempts: 0 });
    scheduleFlush();
  } catch (err) {
    _dbLastError = err && err.message;
  }
}

/** 排程一次异步 flush（`setImmediate` ⇒ 出请求路径）。*/
function scheduleFlush() {
  if (_flushScheduled) return;
  _flushScheduled = true;
  setImmediate(() => {
    _flushScheduled = false;
    flushQueue();
  });
}

/**
 * 立即排空队列（同步写 DB；失败项按上限重试，超限丢弃并计数）。
 * 任何异常都被吞掉 —— DB 故障绝不允许冒泡到审核调用方。
 * @returns {void}
 */
function flushQueue() {
  if (_dbQueue.length === 0) return;
  ensureDbOpen();
  if (!auditDb.isOpen()) {
    // 能力不可用 / schema 闸门拒绝 ⇒ 清空队列，降级为纯 JSONL（无数据损失：JSONL 是权威）
    _dbDropped += _dbQueue.length;
    _dbQueue = [];
    return;
  }
  const batch = _dbQueue;
  _dbQueue = [];
  for (const item of batch) {
    let ok = false;
    try {
      ok = auditDb.upsert(item.record, item.origin);
    } catch (err) {
      _dbLastError = err && err.message;
      ok = false;
    }
    if (ok) continue;
    if (!_dbLastError) _dbLastError = 'DB 写入返回失败';
    const attempts = item.attempts + 1;
    if (attempts >= DB_MAX_ATTEMPTS) { _dbDropped += 1; continue; }
    if (_dbQueue.length >= DB_QUEUE_CAP) { _dbDropped += 1; continue; }
    _dbQueue.push({ record: item.record, origin: item.origin, attempts });
  }
}

/** 后台重试（30s 一次；仅在有积压时动作）*/
const _dbRetryTimer = setInterval(() => {
  if (_dbQueue.length > 0) flushQueue();
}, DB_RETRY_MS);
if (_dbRetryTimer && typeof _dbRetryTimer.unref === 'function') _dbRetryTimer.unref();

/**
 * 双写状态（供系统信息页 / `GET /api/audit-store/status`）。
 * @returns {object} 状态
 */
function getDualWriteStatus() {
  const enabled = auditDb.getAuditStoreCfg().dualWrite.enabled;
  const capability = auditDb.probe().available;
  if (enabled && capability && !auditDb.isOpen()) auditDb.open();
  const st = auditDb.getStatus();
  return {
    enabled,
    capability,
    dbAvailable: Boolean(capability) && st.open && !st.schemaError,
    dbPath: st.dbPath,
    mode: (enabled && capability && st.open) ? 'dual' : 'jsonl-only',
    queued: _dbQueue.length,
    dropped: _dbDropped,
    lastError: _dbLastError || st.lastError || null,
    schemaVersion: st.schemaVersion,
    reason: st.reason,
  };
}

/**
 * 优雅关闭 / 测试用：排空队列并等待一轮 `setImmediate`。
 * @returns {Promise<void>} 完成
 */
function flushAuditDb() {
  return new Promise((resolve) => {
    setImmediate(() => {
      flushQueue();
      resolve();
    });
  });
}

/**
 * 追加一行「操作留痕」。
 * @param {object} entry 留痕条目
 * @returns {void}
 */
function appendOpsLedger(entry) {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.appendFileSync(OPS_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    logError('audit-store', `写操作留痕失败: ${err.message}`);
  }
}

/**
 * 已告警过的审计文件 → 上次告警时的坏行数。
 * 只在「首次出现坏行」或「坏行数变多」时告警一次，避免高频读取把日志刷爆，
 * 又能在情况恶化时再次提醒（2026-09-16 就是「整天记录被静默跳过」而无人察觉）。
 * @type {Map<string, number>}
 */
const _parseWarnState = new Map();

/**
 * 解析 JSONL 内容：跳过坏行，并在坏行出现/增加时告警一次。
 * @param {string} content 文件内容
 * @param {string} filePath 文件路径（仅用于告警文案）
 * @returns {Array<object>} 成功解析的记录
 */
function parseAuditLines(content, filePath) {
  const lines = content.trim().split('\n').filter(Boolean);
  const out = [];
  let bad = 0;
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) {
    const lastWarned = _parseWarnState.get(filePath);
    if (lastWarned !== bad) {
      _parseWarnState.set(filePath, bad);
      logWarn('audit-store', `审计文件存在无法解析的行（已跳过）：${filePath}`
        + ` — 坏行 ${bad} / 共 ${lines.length} 行，本日可用 ${out.length} 条。`
        + '常见原因：文件被非 UTF-8 方式改写（如 PowerShell 默认 ANSI 编码读写）。'
        + '该文件不会被自动修改，请人工确认后处理。');
    }
  }
  return out;
}

/**
 * 读取指定日期的所有审核记录
 * @param {string} dateStr - 日期字符串 YYYY-MM-DD（默认今天）
 * @returns {Array} 审核记录数组
 */
function getAuditRecords(dateStr) {
  const target = dateStr || getDateStr();
  const filePath = getFilePath(target);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseAuditLines(content, filePath);
  } catch {
    return [];
  }
}

/**
 * 列出所有有审核记录的日期
 * @returns {Array<{date: string, count: number}>}
 */
function listAuditDates() {
  try {
    // v0.2.0：跳过 `/^_/` 前缀文件 —— `_ops.jsonl` 是「删除留痕」，不是「一天」。
    // 漏掉这个过滤会让它出现在「可用日期」列表里，并显示一个虚假的 count。
    const files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.jsonl') && !/^_/.test(f));
    return files.map((f) => {
      const date = f.replace('.jsonl', '');
      const filePath = path.join(STORE_DIR, f);
      let count = 0;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        count = content.trim().split('\n').filter(Boolean).length;
      } catch { /* ignore*/ }
      return { date, count };
    }).sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

/**
 * 获取指定日期审核记录的统计信息
 */
function getAuditStats(dateStr) {
  const records = getAuditRecords(dateStr);
  if (records.length === 0) return { total: 0 };

  const stats = {
    total: records.length,
    by_risk: {},
    by_category: {},
    blocked: 0,
    passed: 0,
  };

  for (const r of records) {
    const level = r.result?.risk_level || 'safe';
    stats.by_risk[level] = (stats.by_risk[level] || 0) + 1;

    if (r.result?.passed) {
      stats.passed++;
    } else {
      stats.blocked++;
    }

    for (const cat of (r.result?.categories || [])) {
      stats.by_category[cat] = (stats.by_category[cat] || 0) + 1;
    }
  }

  return stats;
}

/**
 * 记录是否属于图片模态（与 `audit-db.toRow` 的 modality 判定同口径，下钻筛选与 DB 投影必须一致）。
 * @param {object} r 审核记录
 * @returns {'text'|'image'} 模态
 */
function recordModality(r) {
  const result = (r && r.result) || {};
  const ref = (result.image_ref && typeof result.image_ref === 'object') ? result.image_ref : null;
  const text = typeof r.text === 'string' ? r.text : '';
  return (ref || text === '[图片审核]' || text === '[批量图片]') ? 'image' : 'text';
}

/**
 * 获取最近 N 天的详细统计数据（含 token 消耗、耗时）。
 *
 * 口径说明（为什么）：
 * · token 只认 `result.cloud_cost` 的真实用量 —— 旧实现按 `text/reason` 字数估算，
 *   但 `result.tokens_in/tokens_out` 在生产记录里根本不存在，等于给本地/预检/缓存命中
 *   这类**没有云调用**的记录凭空编造 token，面板数字全部失真。
 * · 费用同理只认真实 `cloud_cost.total_cost`；`pricing_known=false`（价格未收录）单独计数，
 *   绝不借用别的模型价格。
 * · 币种必须分开累加 —— 不同币种相加得到的数没有意义。
 * · `by_category` 只统计违规记录（`passed===false`），因为它是「今日违规分类分布」的数据源；
 *   判定通过与否只读布尔 `result.passed`，不用 action / risk_level 反推。
 *
 * @param {number} days - 最近几天（默认7）
 * @returns {object} 含 daily、7day 汇总
 */
function getDetailedStats(days = 7) {
  const today = getDateStr();
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(getDateStr(d));
  }
  // dates[0] = today, dates[1] = yesterday, ...

  const dailyStats = [];
  let totalTokens = 0, totalTokensIn = 0, totalTokensOut = 0, totalLatency = 0, latencyCount = 0;
  let totalAudits = 0, totalPassed = 0, totalBlocked = 0;
  let sumCloudCalls = 0, sumNoCloud = 0, sumUnpriced = 0;
  const sumCostByCurrency = {};
  const sumByModel = {};

  for (const dateStr of dates) {
    const records = getAuditRecords(dateStr);
    const day = {
      date: dateStr,
      total: records.length,
      passed: 0,
      blocked: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_total: 0,
      avg_latency_ms: 0,
      cloud_calls: 0,
      no_cloud: 0,
      unpriced_calls: 0,
      cost_by_currency: {},
      by_model: {},
      by_category: {},
      by_category_scored: {},
      by_type: { text: 0, image: 0 },
      by_hour: {},
    };

    let dayLatency = 0, dayLatCount = 0;

    for (const r of records) {
      const result = r.result || {};

      if (result.passed) day.passed++;
      else day.blocked++;

      // Token / 费用：唯一来源是 result.cloud_cost 的真实用量
      const cc = (result.cloud_cost && typeof result.cloud_cost === 'object') ? result.cloud_cost : null;
      const cloudCalled = Boolean(cc && cc.available === true);
      const priced = Boolean(cc && cc.pricing_known === true);

      if (cloudCalled) {
        day.cloud_calls += 1;
        const pin = Number(cc.prompt_tokens);
        const pout = Number(cc.completion_tokens);
        if (Number.isFinite(pin)) day.tokens_in += pin;
        if (Number.isFinite(pout)) day.tokens_out += pout;

        const model = String(cc.model || result.cloud_model || r.model || 'unknown');
        const entry = day.by_model[model] || { calls: 0, tokens_in: 0, tokens_out: 0, cost: 0, currency: null };
        entry.calls += 1;
        if (Number.isFinite(pin)) entry.tokens_in += pin;
        if (Number.isFinite(pout)) entry.tokens_out += pout;
        const cur = cc.currency ? String(cc.currency) : 'CNY';
        if (!entry.currency) entry.currency = cur;
        const cost = Number(cc.total_cost);
        // 同一模型下若出现第二个币种，宁可丢弃也不做跨币种相加
        if (priced && Number.isFinite(cost) && entry.currency === cur) entry.cost += cost;
        day.by_model[model] = entry;
      } else {
        day.no_cloud += 1;
      }
      if (cloudCalled && !priced) day.unpriced_calls += 1;

      if (priced) {
        const cost = Number(cc.total_cost);
        if (Number.isFinite(cost)) {
          const cur = cc.currency ? String(cc.currency) : 'CNY';
          day.cost_by_currency[cur] = (day.cost_by_currency[cur] || 0) + cost;
        }
      }

      // 耗时
      if (result.latency_ms && result.latency_ms > 0) {
        dayLatency += result.latency_ms;
        dayLatCount++;
      }

      // 违规分类分布：只认 passed 布尔字段，且只统计违规记录
      if (result.passed === false) {
        const cats = Array.isArray(result.categories) ? result.categories.filter(Boolean) : [];
        if (cats.length === 0) {
          day.by_category.unclassified = (day.by_category.unclassified || 0) + 1;
        } else {
          for (const cat of cats) {
            day.by_category[cat] = (day.by_category[cat] || 0) + 1;
          }
        }
      }

      // 标签口径：用原始教师分（0~100），达阈值才计一个标签
      const scores = (result.category_scores && typeof result.category_scores === 'object') ? result.category_scores : null;
      if (scores) {
        for (const [cat, raw] of Object.entries(scores)) {
          const score = Number(raw);
          if (Number.isFinite(score) && score >= 50) {
            day.by_category_scored[cat] = (day.by_category_scored[cat] || 0) + 1;
          }
        }
      }

      // 模态分布：result.type 是审核入口写入的权威值；历史/异常记录可能缺失它，
      // 此时按 image_ref 与占位文本兜底（实测近三日 10947 条两者 100% 一致）。
      const declaredType = (result.type === 'text' || result.type === 'image') ? result.type : null;
      const modality = declaredType || recordModality(r);
      day.by_type[modality] = (day.by_type[modality] || 0) + 1;

      // 按小时
      try {
        const h = r.timestamp ? new Date(r.timestamp).getHours() : 0;
        day.by_hour[h] = (day.by_hour[h] || 0) + 1;
      } catch { /* skip*/ }
    }

    day.tokens_total = day.tokens_in + day.tokens_out;
    day.avg_latency_ms = dayLatCount > 0 ? Math.round(dayLatency / dayLatCount) : 0;

    dailyStats.push(day);

    totalAudits += day.total;
    totalPassed += day.passed;
    totalBlocked += day.blocked;
    totalTokens += day.tokens_total;
    totalTokensIn += day.tokens_in;
    totalTokensOut += day.tokens_out;
    totalLatency += dayLatency;
    latencyCount += dayLatCount;
    sumCloudCalls += day.cloud_calls;
    sumNoCloud += day.no_cloud;
    sumUnpriced += day.unpriced_calls;
    for (const [cur, v] of Object.entries(day.cost_by_currency)) {
      sumCostByCurrency[cur] = (sumCostByCurrency[cur] || 0) + v;
    }
    for (const [m, e] of Object.entries(day.by_model)) {
      const acc = sumByModel[m] || { calls: 0, tokens_in: 0, tokens_out: 0, cost: 0, currency: e.currency };
      acc.calls += e.calls;
      acc.tokens_in += e.tokens_in;
      acc.tokens_out += e.tokens_out;
      if (!acc.currency) acc.currency = e.currency;
      if (acc.currency === e.currency) acc.cost += e.cost;
      sumByModel[m] = acc;
    }
  }

  return {
    today: dailyStats[0] || null,
    daily: dailyStats.reverse(), // 从旧到新
    summary: {
      days,
      total_audits: totalAudits,
      total_passed: totalPassed,
      total_blocked: totalBlocked,
      pass_rate: totalAudits > 0 ? Math.round((totalPassed / totalAudits) * 100) : 0,
      total_tokens: totalTokens,
      total_tokens_in: totalTokensIn,
      total_tokens_out: totalTokensOut,
      avg_latency_ms: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
      cloud_calls: sumCloudCalls,
      no_cloud: sumNoCloud,
      unpriced_calls: sumUnpriced,
      cost_by_currency: sumCostByCurrency,
      by_model: sumByModel,
    },
  };
}

/**
 * 清除审核记录（ v0.2.0：**先留痕**，再删 JSONL，最后同步删 DB —— 三者同一策略）。
 * @param {string} dateStr - 日期字符串 (YYYY-MM-DD)，为空则清除全部
 * @returns {object} 清除结果 { success: true, deleted: number }
 */
function clearAuditRecords(dateStr = null) {
  try {
    if (!fs.existsSync(STORE_DIR)) {
      return { success: true, deleted: 0 };
    }
    ensureDbOpen();

    if (dateStr) {
      // 清除指定日期
      const filePath = getFilePath(dateStr);
      const existed = fs.existsSync(filePath);
      // 留痕必须在删除之前（留痕失败只告警，不阻断删除）
      appendOpsLedger({
        at: new Date().toISOString(),
        op: 'clear',
        date: dateStr,
        deleted: existed ? 1 : 0,
        files: existed ? [`${dateStr}.jsonl`] : [],
      });
      if (existed) fs.unlinkSync(filePath);
      // v2.4.0：文件已删，必须失效该日期的持久 fd，否则后续 writeSync 会写进孤立 inode（数据丢失）
      invalidateJsonlFd(dateStr);
      const dbDeleted = auditDb.deleteByDate(dateStr);
      if (existed) {
        logInfo('audit-store', `已清除审核记录: ${dateStr}（DB 同步删除 ${dbDeleted} 行）`);
      }
      return { success: true, deleted: existed ? 1 : 0 };
    }
    // 清除全部： 保留 `_` 前缀文件（操作留痕是删除行为的证据，不能被自己删掉）
    const files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.jsonl') && !/^_/.test(f));
    appendOpsLedger({
      at: new Date().toISOString(),
      op: 'clear',
      date: null,
      deleted: files.length,
      files,
    });
    for (const file of files) {
      fs.unlinkSync(path.join(STORE_DIR, file));
    }
    // v2.4.0：全部日期文件已删，失效所有持久 fd
    invalidateJsonlFd();
    const dbDeleted = auditDb.deleteAll();
    logInfo('audit-store', `已清除全部审核记录: ${files.length} 个文件（DB 同步删除 ${dbDeleted} 行）`);
    return { success: true, deleted: files.length };
  } catch (err) {
    logError('audit-store', `清除审核记录失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  saveAuditRecord,
  getAuditRecords,
  listAuditDates,
  getAuditStats,
  getDetailedStats,
  getDateStr,
  clearAuditRecords,
  // v0.2.0：双写状态与优雅排空
  getDualWriteStatus,
  flushAuditDb,
  DB_QUEUE_CAP,
  OPS_FILE,
};
