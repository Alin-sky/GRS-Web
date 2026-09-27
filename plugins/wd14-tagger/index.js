/**
 * WD14 标签器插件（独立插件）
 *
 * 通过 HTTP 调用独立的 Python 标签服务（wd14/wd14_service.py），把动漫图片的
 * 结构化标签映射为审核风险，作为图片审核的辅助预筛通道。
 *
 * 自包含：client.js（HTTP 客户端）+ rules.js（标签映射）+ lib/linkage.js（联动策略），
 * 本文件只做「插件装配」：注册配置、提供服务、挂载审核钩子。
 *
 * ★ v2.0.0 变化：
 *   - 新增 manifest.json（由 plugin-scanner 扫描装载）
 *   - 新增 linkage 服务与 moderation:image:linkage 事件，把原先硬编码在
 *     src/moderator.js 的「WD14 提级」逻辑搬到这里（主流程不再认识 wd14）
 *   - 原有 4 项配置（enabled/host/scoreScale/generalThreshold）保持不变
 *
 * ★ v1.3.0 变化：
 *   - 规则映射新增两道误报防线（见 rules.js）：critical 级标签独立高门槛
 *     `rules.criticalTagMinScore`，以及 rating 明确判 general 时的
 *     `rules.ratingConflictGuard` 冲突降级（保留命中并留痕，不静默丢弃）。
 *   - 「非动漫图处理 = ignore」的文案改为描述**真实行为**（不区分动漫、一律参与联动，
 *     且不省 HTTP 调用）——选项值不变，避免破坏已存配置。
 *   - 回退：把 `rules.criticalTagMinScore` 调到 ≤「标签置信度阈值」并关闭
 *     `rules.ratingConflictGuard`，即逐字节回到本版之前的映射行为。
 *
 * ★ v1.2.0 变化：
 *   - wd14.status 由「只报已知状态」改为**真实探测** Python 服务就绪度（带 TTL 缓存），
 *     使画布能在启动后立刻显示「服务不可达 / 模型预热中」，不再需要手动重载插件。
 *   - 识别服务端的 `warming_up` 答复：模型预热导致的暂时失败**不计入熔断**，
 *     避免正常启动被误判成服务故障而锁死 5 分钟。
 *   - 回退：把「联动策略 · 降级与熔断 → 启动时探测标签服务」关掉，即回到
 *     不探测的旧行为（只报 disabled / circuit-open）。
 */
const { tagImage, healthCheck } = require('./client');
const { mapTagsToRisk, RULE_DEFAULTS } = require('./rules');
const { createLinkage, LINKAGE_DEFAULTS } = require('./lib/linkage');

// 插件配置项声明（前端「插件系统」卡片据此渲染阈值滑块等控件）
const CONFIG_SCHEMA = {
  name: 'wd14-tagger',
  title: 'WD14 动漫标签预筛',
  description: '通过 WD14 标签器识别动漫图片的裸足/大胸/泳装/色情等特征，作为审核辅助判据。联动策略决定它如何影响最终判定。',
  groups: [
    { id: 'basic', title: '基础配置', desc: '标签预筛的开关、服务地址与风险分数缩放。' },
    { id: 'rules', title: '规则阈值 · 误报防护', desc: '标签映射的独立门槛，以及 rating 与 general 结论冲突时的降级保护。' },
    { id: 'linkage', title: '联动策略 · 模式与触发', desc: '决定何时触发与视觉模型的联动，以及动漫图判定方式。' },
    { id: 'fusion', title: '联动策略 · 冲突与融合', desc: 'WD14 与视觉模型结论冲突时的取舍，以及加权融合参数。' },
    { id: 'fallback', title: '联动策略 · 降级与熔断', desc: '标签服务不可用时的兜底行为、熔断阈值与批量预筛参数。' },
  ],
  fields: [
    // ─── 原有 4 项（v1.0.0 迁移，行为完全一致）───
    { key: 'enabled', type: 'boolean', label: '启用标签预筛', default: true, group: 'basic',
      desc: '关闭后完全不调用 WD14 标签服务，图片审核仍走视觉模型。' },
    { key: 'host', type: 'text', label: 'Python 服务地址', default: 'http://127.0.0.1:9898', group: 'basic',
      desc: 'WD14 独立 Python 标签服务的 HTTP 地址，默认本机 9898 端口。' },
    { key: 'scoreScale', type: 'slider', label: '风险分数缩放（整体松紧）', min: 0.5, max: 1.5, step: 0.1, default: 1.0, unit: '×', group: 'basic',
      desc: '整体缩放 WD14 输出的风险分数：小于 1 更宽松，大于 1 更严格。' },
    { key: 'generalThreshold', type: 'slider', label: '标签置信度阈值', min: 0.10, max: 0.70, step: 0.05, default: RULE_DEFAULTS.generalThreshold, unit: '', group: 'basic',
      desc: '低于该置信度的标签会被丢弃，用于过滤噪声标签。这是所有标签的底线。' },

    // ─── 规则阈值 · 误报防护（v1.3.0）───
    { key: 'rules.criticalTagMinScore', type: 'slider', label: 'critical 标签独立门槛', min: 0.10, max: 0.95, step: 0.05, default: RULE_DEFAULTS.criticalTagMinScore, unit: '', group: 'rules',
      desc: 'critical 级标签（nude / completely_nude / sex / vaginal / penis / nipples / pussy）必须达到该置信度才计入命中，避免「刚过普通门槛」的弱标签被当成明确色情。本项与「冲突守卫」是两道独立防线：命中即使过了本门槛，仍可能被下一项按 rating 冲突降级为 low。要把判定完全调回改动前，需把本项调到 ≤「标签置信度阈值」且同时关闭「冲突守卫」。' },
    { key: 'rules.ratingConflictGuard', type: 'boolean', label: 'rating / general 冲突守卫', default: RULE_DEFAULTS.ratingConflictGuard, group: 'rules',
      desc: '当 rating 头明确判「general（安全）」时，与之矛盾的 critical / high 级标签命中降级为 low（保留命中并标记降级来源，不静默丢弃）。注意本项只影响「已过门槛」的命中：已被上一项门槛滤掉的弱标签，单独关闭本项并不会让它们回来。要把判定完全调回改动前，需把本项与「critical 标签独立门槛」一起调回旧值。' },
    { key: 'rules.ratingConflictMinConfidence', type: 'slider', label: '冲突守卫触发置信度', min: 0.50, max: 0.99, step: 0.01, default: RULE_DEFAULTS.ratingConflictMinConfidence, unit: '', group: 'rules',
      desc: 'rating 头判 general 的置信度达到该值才触发冲突守卫；阈值越高越保守（越少降级）。' },

    // ─── 联动策略：模式与触发 ───
    {
      key: 'linkage.mode', type: 'select', label: '联动模式', default: LINKAGE_DEFAULTS['linkage.mode'], group: 'linkage',
      desc: '联动模式：off 关闭 / annotate 只记标签不干预 / escalate 只提级 / escalate_deescalate 可提可降 / weighted 加权融合 / parallel_max 并行取高。',
      options: [
        { value: 'off', label: 'off 关闭（完全不调用）' },
        { value: 'annotate', label: 'annotate 观察期（只记标签不干预）' },
        { value: 'escalate', label: 'escalate 只提级（默认，等价旧行为）' },
        { value: 'escalate_deescalate', label: 'escalate_deescalate 可提可降' },
        { value: 'weighted', label: 'weighted 加权融合打分' },
        { value: 'parallel_max', label: 'parallel_max 并行取高' },
      ],
    },
    {
      key: 'linkage.trigger', type: 'select', label: '触发条件', default: LINKAGE_DEFAULTS['linkage.trigger'], group: 'linkage',
      desc: '何时触发联动：always 每次 / vl_uncertain 仅当视觉模型没把握 / wd14_critical 仅 critical 级命中 / wd14_hit 有任意命中。',
      options: [
        { value: 'always', label: 'always 每次都联动' },
        { value: 'vl_uncertain', label: 'vl_uncertain 仅当 VL 没把握' },
        { value: 'wd14_critical', label: 'wd14_critical 仅 critical 级命中' },
        { value: 'wd14_hit', label: 'wd14_hit 有任意命中' },
      ],
    },
    { key: 'linkage.uncertainBelow', type: 'slider', label: 'VL 不确定阈值', min: 0, max: 1, step: 0.05, default: LINKAGE_DEFAULTS['linkage.uncertainBelow'], group: 'linkage',
      desc: '视觉模型置信度低于该值时视为"没把握"，配合 vl_uncertain 触发条件使用。' },
    {
      key: 'linkage.scope', type: 'select', label: '适用范围', default: LINKAGE_DEFAULTS['linkage.scope'], group: 'linkage',
      desc: '联动适用范围：仅动漫图或全部图片。',
      options: [
        { value: 'anime_only', label: 'anime_only 仅动漫图' },
        { value: 'all', label: 'all 全部图片' },
      ],
    },
    {
      key: 'linkage.animeDetect', type: 'select', label: '动漫判定方式', default: LINKAGE_DEFAULTS['linkage.animeDetect'], group: 'linkage',
      desc: '如何判定图片是否为动漫图：角色置信度 / 有评级 / 通用二次元标签。',
      options: [
        { value: 'character_conf', label: 'character_conf 角色置信度' },
        { value: 'rating_present', label: 'rating_present 有评级' },
        { value: 'wd14_general', label: 'wd14_general 通用二次元标签' },
      ],
    },
    { key: 'linkage.animeThreshold', type: 'slider', label: '动漫判定阈值', min: 0.05, max: 0.9, step: 0.05, default: LINKAGE_DEFAULTS['linkage.animeThreshold'], group: 'linkage',
      desc: '动漫判定分数高于该值才视为动漫图。' },
    {
      key: 'linkage.onNonAnime', type: 'select', label: '非动漫图处理', default: LINKAGE_DEFAULTS['linkage.onNonAnime'], group: 'linkage',
      desc: '非动漫图处理：annotate 只记标签、不干预判定 / ignore 不区分动漫与非动漫，一律参与联动（约等于「适用范围=all」，非动漫图也会被提级或拦截）；注意两者都会调用标签服务，ignore 并不省 HTTP 调用。',
      options: [
        { value: 'annotate', label: 'annotate 只记标签（不干预判定）' },
        { value: 'ignore', label: 'ignore 一律参与联动（不区分动漫，不省 HTTP）' },
      ],
    },

    // ─── 联动策略：冲突与融合 ───
    {
      key: 'linkage.conflict', type: 'select', label: '冲突策略', default: LINKAGE_DEFAULTS['linkage.conflict'], group: 'fusion',
      desc: 'WD14 与视觉模型结论冲突时：max 取高 / vl_wins 视觉优先 / wd14_wins 标签器优先 / review 取高并转人工复核。',
      options: [
        { value: 'max', label: 'max 取较高者（默认）' },
        { value: 'vl_wins', label: 'vl_wins 视觉模型优先' },
        { value: 'wd14_wins', label: 'wd14_wins 标签器优先' },
        { value: 'review', label: 'review 取高并标记人工复核' },
      ],
    },
    { key: 'linkage.weightVl', type: 'slider', label: '融合权重 · 视觉模型', min: 0, max: 1, step: 0.05, default: LINKAGE_DEFAULTS['linkage.weightVl'], group: 'fusion',
      desc: '加权融合模式下视觉模型的权重（0~1），与标签器权重共同决定最终分数。' },
    { key: 'linkage.weightWd14', type: 'slider', label: '融合权重 · 标签器', min: 0, max: 1, step: 0.05, default: LINKAGE_DEFAULTS['linkage.weightWd14'], group: 'fusion',
      desc: '加权融合模式下 WD14 标签器的权重（0~1）。' },
    { key: 'linkage.scoreCap', type: 'number', label: '融合分数上限', min: 1, max: 100, default: LINKAGE_DEFAULTS['linkage.scoreCap'], group: 'fusion',
      desc: '融合后分数的上限，防止单通道把分数拉得过高。' },

    // ─── 联动策略：降级与熔断 ───
    {
      key: 'linkage.onWd14Down', type: 'select', label: '标签服务不可用时', default: LINKAGE_DEFAULTS['linkage.onWd14Down'], group: 'fallback',
      desc: '标签服务不可用时：skip 跳过联动 / fail_closed 提级并转人工 / fallback_vl 维持视觉模型判定。',
      options: [
        { value: 'skip', label: 'skip 跳过联动' },
        { value: 'fail_closed', label: 'fail_closed 提级并转人工' },
        { value: 'fallback_vl', label: 'fallback_vl 维持视觉模型判定' },
      ],
    },
    { key: 'linkage.circuitFail', type: 'number', label: '熔断阈值（连续失败次数）', min: 1, max: 20, default: LINKAGE_DEFAULTS['linkage.circuitFail'], group: 'fallback',
      desc: '连续失败达到该次数后打开熔断，暂时停止调用标签服务。' },
    { key: 'linkage.circuitCooldownSec', type: 'number', label: '熔断冷却（秒）', min: 10, max: 3600, default: LINKAGE_DEFAULTS['linkage.circuitCooldownSec'], group: 'fallback',
      desc: '熔断打开后的冷却时间，冷却结束后重新尝试调用标签服务。' },
    { key: 'linkage.batchSkipVl', type: 'boolean', label: '批量跳过视觉模型（只跑标签器）', default: LINKAGE_DEFAULTS['linkage.batchSkipVl'], group: 'fallback',
      desc: '批量任务中只跑 WD14 标签器、跳过视觉模型，用于快速预筛。' },
    { key: 'linkage.batchResizePx', type: 'number', label: '批量预筛分辨率（0=不缩放）', min: 0, max: 2048, default: LINKAGE_DEFAULTS['linkage.batchResizePx'], group: 'fallback',
      desc: '批量预筛时把图片缩放到该分辨率（0=不缩放）以提速。' },
    { key: 'linkage.timeoutMs', type: 'number', label: '请求超时（毫秒）', min: 1000, max: 60000, default: LINKAGE_DEFAULTS['linkage.timeoutMs'], group: 'fallback',
      desc: '单次调用标签服务的超时时间，超时按失败计。' },
    { key: 'linkage.concurrency', type: 'number', label: '标签器并发', min: 1, max: 8, default: LINKAGE_DEFAULTS['linkage.concurrency'], group: 'fallback',
      desc: '同时发往标签服务的最大并发请求数。' },
    { key: 'linkage.probeOnStatus', type: 'boolean', label: '启动时探测标签服务', default: LINKAGE_DEFAULTS['linkage.probeOnStatus'], group: 'fallback',
      desc: '开启后，插件就绪度会真实探测 Python 服务的可达性与模型加载状态（带缓存），画布无需手动重载即可显示「服务不可达 / 模型预热中」。关闭则只报本地已知状态。' },
    { key: 'linkage.probeCacheMs', type: 'number', label: '探测结果缓存（毫秒）', min: 0, max: 60000, default: LINKAGE_DEFAULTS['linkage.probeCacheMs'], group: 'fallback',
      desc: '就绪度探测结果的缓存时长，避免画布/接口高频刷新时反复打服务。0=不缓存。' },
  ],
};

function wd14Tagger(ctx) {
  // 注册配置（返回可读写配置对象，修改自动持久化）
  const config = ctx.config(CONFIG_SCHEMA);
  const linkage = createLinkage(() => config);

  // 规则映射选项的唯一装配点：两处 mapTagsToRisk 调用共用，避免漏配新阈值
  const riskOpts = () => ({
    generalThreshold: config.generalThreshold,
    scoreScale: config.scoreScale,
    criticalTagMinScore: config['rules.criticalTagMinScore'],
    ratingConflictGuard: config['rules.ratingConflictGuard'],
    ratingConflictMinConfidence: config['rules.ratingConflictMinConfidence'],
  });

  // 提供服务，供其他插件/主流程注入
  ctx.provide('wd14', {
    tag: (img) => tagImage(img, config.host, config['linkage.timeoutMs']),
    health: () => healthCheck(config.host),
    mapToRisk: (r) => mapTagsToRisk(r, riskOpts()),
    schema: CONFIG_SCHEMA,
    config,
  });

  // 提供联动服务：主流程只认识「谁提供 linkage」，不认识 wd14（R-B37）
  ctx.provide('linkage', {
    name: 'wd14',
    resolve: (result, contributions) => linkage.resolve(result, contributions),
    isCircuitOpen: () => linkage.isCircuitOpen(),
    recordFailure: () => linkage.recordFailure(),
    stats: linkage.stats,
  });

  // 挂载图片审核标签钩子（收集模式）
  ctx.on('moderation:image:tag', async (imageBase64) => {
    if (!config.enabled) return { source: 'wd14', disabled: true };
    if (linkage.isCircuitOpen()) return { source: 'wd14', disabled: true, error: 'circuit_open' };
    const result = await tagImage(imageBase64, config.host, config['linkage.timeoutMs']);
    if (!result.available) {
      // ★ 模型预热中的失败不计入熔断：那是「服务刚起来、还没热」，
      //   不是服务故障。计进去会让正常启动三次请求就锁死 5 分钟。
      if (!result.warmingUp) linkage.recordFailure();
      return { source: 'wd14', error: result.error, warmingUp: result.warmingUp === true };
    }
    const mapped = mapTagsToRisk(result, riskOpts());
    return {
      source: 'wd14',
      tags: { rating: result.rating, general: result.general, character: result.character },
      risk: { level: mapped.suggestedLevel, score: mapped.suggestedScore, hits: mapped.hits },
    };
  });

  // 挂载图片审核联动解析（短路模式：首个非空结果即最终判定）
  ctx.on('moderation:image:linkage', async (result, contributions) => linkage.resolve(result, contributions));

  // 供批量插件复用的配置读取入口（读方法，无需密码）
  ctx.rpc('wd14.config', () => ({
    enabled: config.enabled,
    host: config.host,
    batchSkipVl: config['linkage.batchSkipVl'],
    batchResizePx: config['linkage.batchResizePx'],
    concurrency: config['linkage.concurrency'],
    timeoutMs: config['linkage.timeoutMs'],
    scoreScale: config.scoreScale,
    generalThreshold: config.generalThreshold,
    criticalTagMinScore: config['rules.criticalTagMinScore'],
    ratingConflictGuard: config['rules.ratingConflictGuard'],
    ratingConflictMinConfidence: config['rules.ratingConflictMinConfidence'],
  }));

  // ★ 就绪度自报 + 真实探测（供宿主按 manifest 节点声明的 readinessRpc 取用）
  //   本地已知状态（无需网络）：
  //     - disabled      ：插件配置中关闭了标签预筛
  //     - circuit-open  ：联动熔断已打开（连续失败达阈值，等待冷却）
  //   服务侧真实状态（linkage.probeOnStatus 开启时，带 TTL 缓存）：
  //     - service-unreachable ：Python 服务进程不可达（没启动 / 端口不通）
  //     - model-loading       ：服务在跑但模型还在预热（预热策略让这段时间可观测）
  //   探测失败不会阻断主链路：探测本身异常时回落到本地已知状态。
  let probeCache = { at: 0, value: null };

  /**
   * 探测服务就绪度。
   * @returns {Promise<{probed: boolean, value: {reason: string, model?: string}|null}>}
   *   probed=false 表示本次结论来自本地已知状态（未探测）；
   *   value=null 且 probed=true 表示「探测过、服务与模型都正常」。
   */
  async function probeService() {
    if (!config.enabled) return { probed: false, value: null };
    if (config['linkage.probeOnStatus'] === false) return { probed: false, value: null };
    const ttl = Number(config['linkage.probeCacheMs']);
    const now = Date.now();
    // 注意：探测结果为「一切正常」时 value 是 null，不能拿 value 做缓存有效判据，
    //   否则正常态永不命中缓存、每次刷新都白打一次服务。用 at>0 判定「探过」。
    if (Number.isFinite(ttl) && ttl > 0 && probeCache.at > 0 && now - probeCache.at < ttl) {
      return { probed: true, value: probeCache.value };
    }
    let value = null;
    try {
      const h = await healthCheck(config.host, 3000);
      if (!h.available) value = { reason: 'service-unreachable' };
      else if (h.ready === false) value = { reason: 'model-loading', model: h.model || '' };
    } catch { /* 探测异常不影响自报 */ }
    probeCache = { at: now, value };
    return { probed: true, value };
  }

  ctx.rpc('wd14.status', async () => {
    const circuitOpen = linkage.isCircuitOpen();
    const enabled = config.enabled !== false;
    const probe = await probeService();
    const probed = probe.value;

    // 未就绪原因优先级：关闭 > 熔断 > 服务不可达 > 模型预热中
    let reason = '';
    if (!enabled) reason = 'disabled';
    else if (circuitOpen) reason = 'circuit-open';
    else if (probed && probed.reason) reason = probed.reason;

    const ready = reason === '';
    const notReadyMessage = reason === 'disabled'
      ? '插件配置中已关闭标签预筛'
      : reason === 'circuit-open'
        ? '联动熔断已打开，等待冷却后自动恢复'
        : reason === 'service-unreachable'
          ? `WD14 标签服务不可达（${config.host}），请确认已运行 start-wd14.bat`
          : reason === 'model-loading'
            ? `标签模型正在预热（${probed && probed.model ? probed.model : 'WD14'}），预热完成后自动就绪`
            : '';

    return {
      ready,
      notReadyReason: reason,
      notReadyMessage,
      installHint: '',
      configHint: '需要本机 WD14 标签服务可达；服务地址与联动策略在「插件管理 → wd14-tagger」配置',
      serviceHost: config.host,
      serviceProbed: probe.probed,
      linkageMode: config['linkage.mode'],
      stats: linkage.stats,
      refs: {
        tag: 'plugin.wd14-tagger.tag',
        linkage: 'plugin.wd14-tagger.linkage',
      },
      // 逐节点就绪度（宿主按 ref 精确置灰；打标节点与终裁器同源状态）
      nodes: [
        {
          ref: 'plugin.wd14-tagger.tag',
          modality: 'image',
          ready,
          notReadyReason: reason,
          notReadyMessage,
          installHint: '',
        },
      ],
    };
  });
}

Object.defineProperty(wd14Tagger, 'name', { value: 'wd14-tagger', configurable: true });
wd14Tagger.description = 'WD14 动漫标签预筛（裸足/大胸/泳装/色情分级）+ 可配置联动策略';
wd14Tagger.version = '1.3.0';

module.exports = wd14Tagger;

module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;
