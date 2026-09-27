/**
 * 关键词检测审图插件（plugins/keyword-image-guard/index.js）
 *
 * 定位：图像模态的**轻量判定型审核节点**（role=judge，能力 image.verdict，
 *       节点 ref `plugin.keyword-image-guard.image`），对图片的：
 *         文件名 / EXIF 元数据 / 附带文本 / 上游标签
 *       做敏感词与正则匹配，命中后映射为本系统风险等级。
 *
 * ★ 与 wd14-tagger 的关系是**互补而非重叠**：
 *   - wd14-tagger 负责「把图变成标签」（image.tag / collect）；
 *   - 本插件负责「把标签与元信息变成判定」（image.verdict），上游标签即来自 wd14 等 contribute 节点；
 *   - 本插件**不重新实现任何打标能力**，也不复制核心词库。
 *
 * ★ 词库不出库（F07）：引用宿主词库时只经 ctx.precheck 拿 {hit, category, level}，
 *   任何返回值与日志都不含命中词原文。
 *
 * ★ 失败语义：除「明确要求了宿主预检通道但它不可用」与「宿主预检调用抛异常」两种情况
 *   按失败抛出（fail-closed）外，其余异常均不冒泡；任何情况下都不会在出错时输出
 *   高置信度的 safe。
 *
 * ★ 依赖：纯 JS 零额外依赖。
 */
'use strict';

const rulesLib = require('./lib/rules');
const sources = require('./lib/sources');
const { buildViewSchema } = require('./lib/view-schema');

/** 节点 ref（与 manifest.contributes.nodes[].ref 一致） */
const NODE_REF = 'plugin.keyword-image-guard.image';

/** 插件 id */
const PLUGIN_ID = 'keyword-image-guard';

/** 规则来源枚举 */
const RULE_SOURCES = Object.freeze(['plugin', 'precheck', 'both']);

/** 插件配置表单 */
const CONFIG_SCHEMA = {
  name: PLUGIN_ID,
  title: '关键词检测审图',
  version: '1.0.0',
  description: '对文件名 / EXIF 元数据 / 附带文本 / 上游标签做敏感词或正则匹配的轻量判定通道（0 额外依赖）。与 WD1.4 标签器互补：WD1.4 负责打标，本插件负责判定。',
  groups: [
    { id: 'basic', title: '基础', desc: '开关、等级下限与规则来源。' },
    { id: 'rules', title: '规则表', desc: '每行一条规则：等级|模式|类型|分类|说明。' },
    { id: 'sources', title: '匹配来源默认值', desc: '节点参数未覆盖时使用的默认识别来源。' },
  ],
  fields: [
    { key: 'enabled', type: 'boolean', label: '启用关键词检测节点', default: true, group: 'basic',
      desc: '关闭后不再挂载审核钩子（等同于该节点不存在）；修改后需重载插件生效。' },
    { key: 'levelFloor', type: 'select', label: '命中后至少抬升到', default: 'medium', group: 'basic',
      options: [
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'critical', label: 'critical' },
      ],
      desc: '任一命中后最终等级不低于该值；未命中时恒为 safe。' },
    {
      key: 'ruleSource', type: 'select', label: '规则来源', default: 'both', group: 'basic',
      options: [
        { value: 'plugin', label: '仅插件内规则（单独配置）' },
        { value: 'precheck', label: '仅宿主预检 API（词库不出库）' },
        { value: 'both', label: '两者都用（取最严重）' },
      ],
      desc: '选择「仅宿主预检」时，若宿主未提供该 API，节点按失败处理（fail-closed），避免静默放行。' },
    { key: 'criticalShortCircuit', type: 'boolean', label: '命中最高级即短路', default: true, group: 'basic',
      desc: '命中最高级时立即停止后续匹配（仅省算力，等级一定原样输出）。' },
    { key: 'ignoreCase', type: 'boolean', label: '忽略大小写', default: true, group: 'basic',
      desc: '开启后纯文本与正则规则均忽略大小写（更宽松的命中面）。' },

    { key: 'rulesText', type: 'textarea', label: '规则表', default: '', group: 'rules', rows: 10,
      desc: '每行一条，格式：等级|模式|类型|分类|说明。等级取 low/medium/high/critical；类型取 plain（纯文本，默认）或 regex（正则）；分类留空用「默认分类」。以 # 开头的行是注释。示例（中性占位）：high|示例关键词A|plain|pornographic|示例规则\ncritical|示例关键词B|plain|political|示例规则' },
    { key: 'defaultCategoryId', type: 'text', label: '默认分类 id', default: 'illegal', group: 'rules',
      desc: '规则未指定分类时使用，需与系统分类表一致（如 illegal / pornographic / political）。' },
    { key: 'maxHits', type: 'number', label: '最多记录命中数', min: 1, max: 200, default: 50, group: 'rules',
      desc: '超过该数量后停止记录（等级已确定，仅影响统计细节）。' },

    { key: 'sources', type: 'checkbox-group', label: '默认识别来源', default: ['filename', 'caption', 'upstreamTags'], group: 'sources',
      options: [
        { value: 'filename', label: '文件名' },
        { value: 'exif', label: 'EXIF / 元数据' },
        { value: 'caption', label: '附带文本' },
        { value: 'upstreamTags', label: '上游标签' },
      ],
      desc: '节点参数 sources 可覆盖此默认值。' },
    { key: 'maxTagCount', type: 'number', label: '最多检查上游标签数', min: 1, max: 200, default: 50, group: 'sources',
      desc: '上游标签数量上限，超出部分不参与匹配（防止超长标签列表拖慢判定）。' },
  ],
};

// ─── 工具 ───

/**
 * 归一化调用入参：兼容 (request) 与 (owner, request) 两种 emitCall 约定。
 * @param {...any} args 原始入参
 * @returns {object|null} 请求对象
 */
function normalizeRequest(...args) {
  let best = null;
  for (const arg of args) {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
    if ('payload' in arg || 'params' in arg || 'ref' in arg || 'meta' in arg) best = arg;
  }
  if (!best) return null;
  return {
    ref: best.ref || NODE_REF,
    params: best.params && typeof best.params === 'object' ? best.params : {},
    payload: best.payload && typeof best.payload === 'object' ? best.payload : {},
    meta: best.meta && typeof best.meta === 'object' ? best.meta : {},
    work: best.work && typeof best.work === 'object' ? best.work : {},
  };
}

/** 整数参数收敛 */
function intParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 构造带错误码的异常 */
function taggedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ─── 插件主体 ───

/**
 * 插件入口。
 * @param {object} ctx 宿主桥接上下文（BridgeContext）
 */
function keywordImageGuard(ctx) {
  const logger = (ctx && ctx.logger) || console;
  const config = ctx.config(CONFIG_SCHEMA);

  /** 宿主预检 API（受控：只回是否命中 + 分类 + 等级，不回词表；不可用时为 null） */
  let precheck = null;
  let precheckWarned = false;
  function hostPrecheck() {
    if (precheck) return precheck;
    try {
      const svc = typeof ctx.inject === 'function' ? ctx.inject('precheck', false) : null;
      if (svc && typeof svc.match === 'function') precheck = svc;
    } catch {
      precheck = null;
    }
    if (!precheck && !precheckWarned) {
      precheckWarned = true;
      logger.warn(`[${PLUGIN_ID}] 宿主未提供 precheck 受控 API，仅可进行插件内规则判定`);
    }
    return precheck;
  }

  /** 编译规则表（配置变更后可调用 reloadRules 重编） */
  let compiled = rulesLib.compileRules({
    rulesText: config.rulesText,
    ignoreCase: config.ignoreCase !== false,
  });

  /**
   * 重新编译规则（配置更新 / RPC 调用）。
   * @returns {{count: number, errors: string[]}}
   */
  function reloadRules() {
    compiled = rulesLib.compileRules({
      rulesText: config.rulesText,
      ignoreCase: config.ignoreCase !== false,
    });
    if (compiled.errors.length) logger.warn(`[${PLUGIN_ID}] 规则表存在问题：${compiled.errors.join('；')}`);
    logger.info(`[${PLUGIN_ID}] 规则表已编译：生效 ${compiled.rules.length} 条`);
    return { count: compiled.rules.length, errors: compiled.errors };
  }

  if (compiled.errors.length) logger.warn(`[${PLUGIN_ID}] 规则表存在问题：${compiled.errors.join('；')}`);
  logger.info(`[${PLUGIN_ID}] 规则表就绪：${compiled.rules.length} 条；宿主预检 API：${hostPrecheck() ? '可用' : '不可用'}`);

  /** 当前生效参数（节点参数 > 插件配置） */
  function resolveOptions(params = {}) {
    const p = params && typeof params === 'object' ? params : {};
    const ruleSource = RULE_SOURCES.includes(String(p.ruleSource)) ? String(p.ruleSource)
      : (RULE_SOURCES.includes(String(config.ruleSource)) ? String(config.ruleSource) : 'both');
    return {
      sources: sources.normalizeSources(p.sources !== undefined ? p.sources : config.sources),
      ruleSource,
      criticalShortCircuit: (p.criticalShortCircuit !== undefined ? p.criticalShortCircuit : config.criticalShortCircuit) !== false,
      levelFloor: rulesLib.OUTPUT_LEVELS.includes(String(p.levelFloor || config.levelFloor))
        ? String(p.levelFloor || config.levelFloor)
        : 'medium',
      maxTagCount: intParam(p.maxTagCount !== undefined ? p.maxTagCount : config.maxTagCount, 50, 1, 200),
      maxHits: intParam(p.maxHits !== undefined ? p.maxHits : config.maxHits, rulesLib.MAX_HITS, 1, 200),
      defaultCategoryId: typeof config.defaultCategoryId === 'string' && config.defaultCategoryId
        ? config.defaultCategoryId
        : 'illegal',
    };
  }

  /**
   * 对单个载荷做判定。
   * @param {object} request 请求
   * @param {object} options 选项
   * @returns {{verdict: object, hits: Array<object>, stats: object, empty: boolean}}
   */
  function judge(request, options) {
    const usePluginRules = options.ruleSource !== 'precheck';
    const usePrecheck = options.ruleSource !== 'plugin';
    const pre = usePrecheck ? hostPrecheck() : null;
    if (usePrecheck && !pre) {
      // 明确要求了宿主预检通道但它不可用 → 按失败处理，绝不静默放行
      throw taggedError('PRECHECK_UNAVAILABLE', '规则来源包含宿主预检 API，但宿主未提供该服务');
    }

    const { items, stats } = sources.collectTexts(request, options);
    const hits = [];
    let shortCircuited = false;

    for (const item of items) {
      if (usePluginRules) {
        const matched = rulesLib.matchText(compiled.rules, item.text, { source: item.source, maxHits: options.maxHits });
        for (const h of matched) {
          if (hits.length >= options.maxHits) break;
          hits.push({ ...h, field: item.name });
          if (options.criticalShortCircuit && h.level === 'critical') { shortCircuited = true; break; }
        }
      }
      if (shortCircuited) break;

      if (pre && hits.length < options.maxHits) {
        let result = null;
        try {
          result = pre.match(item.text);
        } catch (err) {
          // 宿主预检调用异常 → 视为该通道真实故障，向上抛出走 fail-closed
          throw taggedError('PRECHECK_FAILED', `宿主预检 API 调用失败：${err && err.message ? err.message : String(err)}`);
        }
        if (result && result.hit === true) {
          const level = rulesLib.OUTPUT_LEVELS.includes(String(result.level)) && String(result.level) !== 'safe'
            ? String(result.level)
            : options.levelFloor;
          hits.push({
            level,
            category: typeof result.category === 'string' ? result.category : '',
            label: '',
            source: item.source,
            kind: 'host-precheck',
            field: item.name,
          });
          if (options.criticalShortCircuit && level === 'critical') { shortCircuited = true; break; }
        }
      }
    }

    const stats2 = {
      ...stats,
      hits: hits.length,
      precheckUsed: Boolean(pre),
      shortCircuited,
    };

    if (hits.length === 0) {
      const nothingConfigured = compiled.rules.length === 0 && !pre;
      return {
        empty: nothingConfigured,
        hits,
        stats: stats2,
        verdict: {
          risk_level: 'safe',
          categories: [],
          category_scores: {},
          confidence: 0,
          reason: nothingConfigured
            ? '关键词规则未配置且宿主预检 API 不可用，本节点未执行有效判定'
            : `已检查 ${items.length} 项文本来源，未命中任何关键词规则`,
          suggestion: nothingConfigured ? '请在插件配置中维护规则表，或改用宿主预检规则来源' : '无需处置',
        },
      };
    }

    const hitLevel = rulesLib.maxLevel(hits);
    const level = rulesLib.atLeast(hitLevel, options.levelFloor);
    const top = hits.find((h) => h.level === hitLevel) || hits[0];
    const category = (top && top.category) || options.defaultCategoryId;
    const confidence = rulesLib.confidenceOf(level, hits.length);
    const bySource = hits.reduce((acc, h) => {
      acc[h.source] = (acc[h.source] || 0) + 1;
      return acc;
    }, {});
    const sourceDesc = Object.entries(bySource).map(([k, v]) => `${k}×${v}`).join('、');

    return {
      empty: false,
      hits,
      stats: stats2,
      verdict: {
        risk_level: level,
        categories: [category],
        category_scores: { [category]: Math.round(confidence * 100) },
        confidence,
        reason: `命中 ${hits.length} 条规则（来源：${sourceDesc}）→ ${hitLevel}${level !== hitLevel ? `，按命中下限抬升至 ${level}` : ''}${shortCircuited ? '，已短路' : ''}`.slice(0, 200),
        suggestion: `元信息/标签命中敏感规则，建议按 ${level} 等级处置`,
      },
    };
  }

  /**
   * 统一入口：支持批量（payload.images[]，每项可带自己的 filename/caption/tags）。
   * @param {...any} args 原始入参
   * @returns {object} ModerationVerdict
   */
  function handleVerdictImage(...args) {
    const request = normalizeRequest(...args);
    if (!request) throw taggedError('BAD_REQUEST', '无法识别的调用入参（期望 { ref, params, payload }）');
    if (config.enabled === false) {
      // fail-closed：配置里关掉了本通道就不判定，绝不放行（宿主应先按 readinessRpc 把节点判为 skipped）
      throw taggedError('CHANNEL_DISABLED', '关键词检测节点已在插件配置中关闭（enabled=false）：请在插件设置中开启，或从拓扑中删除该节点');
    }
    const options = resolveOptions(request.params);

    const payload = request.payload;
    const batch = Array.isArray(payload.images) ? payload.images : null;
    const jobs = batch && batch.length
      ? batch.map((item) => ({
        payload: item && typeof item === 'object' ? { ...payload, ...item, images: undefined } : { ...payload, filename: String(item || '') },
        meta: request.meta,
        work: request.work,
        params: request.params,
        ref: request.ref,
      }))
      : [request];

    const results = jobs.map((job) => judge(job, options));
    const failedEmpty = results.length > 0 && results.every((r) => r.empty);
    let worst = results[0];
    for (const r of results) {
      if ((rulesLib.RISK_ORDER[r.verdict.risk_level] || 0) > (rulesLib.RISK_ORDER[worst.verdict.risk_level] || 0)) worst = r;
    }

    const verdict = worst.verdict;
    logger.info(`[${PLUGIN_ID}] 判定完成：${verdict.risk_level}（来源项 ${worst.stats.itemCount}，命中 ${worst.stats.hits}，批次 ${jobs.length}）`);
    if (failedEmpty) {
      logger.warn(`[${PLUGIN_ID}] 未配置任何规则且宿主预检 API 不可用，本节点本次未执行有效判定`);
    }
    return jobs.length > 1
      ? { ...verdict, reason: `批量 ${jobs.length} 项，最严重：${verdict.reason}`.slice(0, 200) }
      : verdict;
  }

  /** 就绪度自报 */
  function status() {
    const pre = hostPrecheck();
    const hasRules = compiled.rules.length > 0;
    const src = RULE_SOURCES.includes(String(config.ruleSource)) ? String(config.ruleSource) : 'both';
    const ready = config.enabled !== false && (hasRules || Boolean(pre)) && !(src === 'precheck' && !pre);
    let notReadyReason = '';
    let notReadyMessage = '';
    if (config.enabled === false) {
      notReadyReason = 'disabled';
      notReadyMessage = '插件配置中已关闭';
    } else if (src === 'precheck' && !pre) {
      notReadyReason = 'not-configured';
      notReadyMessage = '规则来源为宿主预检 API，但宿主未提供该服务';
    } else if (!hasRules && !pre) {
      notReadyReason = 'not-configured';
      notReadyMessage = '既未配置插件内规则，宿主预检 API 也不可用';
    }
    return {
      ready,
      notReadyReason,
      notReadyMessage,
      installHint: '',
      configHint: '在「图片审核 → keyword-image-guard」维护规则表与识别来源',
      ruleCount: compiled.rules.length,
      ruleErrors: compiled.errors,
      precheckAvailable: Boolean(pre),
      sources: sources.normalizeSources(config.sources),
      ref: NODE_REF,
      // 逐节点就绪度（宿主按 ref 精确置灰；单节点插件与顶层值一致）
      nodes: [
        {
          ref: NODE_REF,
          modality: 'image',
          ready,
          notReadyReason,
          notReadyMessage,
          installHint: '',
        },
      ],
    };
  }

  // ① 提供服务
  ctx.provide('keywordImageGuard', {
    name: PLUGIN_ID,
    ref: NODE_REF,
    status,
    reloadRules,
    judgeText: (text, params) => rulesLib.matchText(compiled.rules, text, { source: 'caption', maxHits: intParam(params && params.maxHits, 50, 1, 200) })
      .map((h) => ({ level: h.level, ruleIndex: h.ruleIndex, label: h.label })),
    schema: CONFIG_SCHEMA,
    config,
  });

  // ② 挂载判定钩子
  // ★ 始终挂载：配置里的 `enabled` 只决定「节点是否就绪」，由 status().ready=false +
  //   manifest 的 readinessRpc 让宿主把节点判为 skipped；避免「节点已注册但无处理器」的
  //   半状态（那种情况下调用会落成 failed/plugin_rejected，把可选节点变成整段拦截）。
  ctx.on('moderation:verdict:image', handleVerdictImage);
  logger.info(`[${PLUGIN_ID}] 已挂载 image.verdict 钩子（节点 ref=${NODE_REF}）`);
  if (config.enabled === false) {
    logger.warn(`[${PLUGIN_ID}] 配置中已关闭（enabled=false）：keywordImageGuard.status 报 ready=false，宿主据此把该节点判为 skipped`);
  }

  // ③ RPC
  ctx.rpc('keywordImageGuard.status', () => status());
  ctx.rpc('keywordImageGuard.reloadRules', () => reloadRules());
  ctx.rpc('keywordImageGuard.sources', () => sources.ALL_SOURCES);
  ctx.rpc('keywordImageGuard.selfTest', (params = {}) => {
    const options = resolveOptions(params || {});
    const sample = {
      payload: {
        filename: (params && params.filename) || '示例文件名.txt',
        caption: (params && params.caption) || '',
        upstreamTags: (params && params.upstreamTags) || [],
      },
      meta: {},
      params: params || {},
      ref: NODE_REF,
    };
    try {
      const res = judge(sample, options);
      return { ok: true, verdict: res.verdict, hits: res.hits.length, reason: res.verdict.reason };
    } catch (err) {
      logger.error(`[${PLUGIN_ID}] 自检失败：${err.message}`);
      return { ok: false, error: err.message, code: err.code || 'SELFTEST_FAILED' };
    }
  });

  // ④ 参数界面 schema（manifest.contributes.views[].schemaResolver = 'viewSchema'）
  // 视图 schema 单独在 lib/view-schema.js，便于单测复用
  ctx.rpc('viewSchema', () => buildViewSchema(status(), NODE_REF));

  logger.info(`[${PLUGIN_ID}] 插件已装载（规则 ${compiled.rules.length} 条，等级下限 ${config.levelFloor || 'medium'}）`);
}

Object.defineProperty(keywordImageGuard, 'name', { value: PLUGIN_ID, configurable: true });
keywordImageGuard.description = '关键词检测审图（文件名 / EXIF / 附带文本 / 上游标签）';
keywordImageGuard.version = '1.0.0';

module.exports = keywordImageGuard;
module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;
module.exports.NODE_REF = NODE_REF;
