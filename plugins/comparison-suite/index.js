/**
 * 对比审核套件（plugins/comparison-suite/index.js）
 *
 * ★ v2.3.0（Req5）：把原「模型对比审核」从核心（src/comparator.js）解耦为独立插件，
 *   并扩展为**文本 + 图像双模态**。
 *
 * 与 GRS 核心的耦合面：
 *   - 注入 5 个受控宿主服务（comparisonSource / comparisonStore / comparisonProbe /
 *     comparisonCore / comparisonEngine）
 *   - 除此之外**不 require 任何核心模块**、不读核心配置对象、不碰 API Key
 *   ⇒ 本插件整体禁用/卸载时，核心的对比审核接口回退到内置 src/comparator.js，行为不变。
 *
 * ★ 编排引擎（runComparison / statusOf）由宿主注入，与内置路径是**同一份实现** ——
 *   插件内不再自带 lib/engine.js，从结构上杜绝「两条路径口径漂移」。
 *
 * 纯 Schema 驱动：本插件只返回 JSON，不产出 JS/CSS；界面由前端统一渲染器渲染。
 */
/** 插件 id */
const PLUGIN_ID = 'comparison-suite';

// ─── 审核器注册表接入（T04-B）──
//
// ★ 参与者不再硬编码，而是**从审核器注册表快照枚举**（经已存在的 comparisonEngine 注入读取）。
//   这样「新装一个声明 image.verdict 的插件 → 自动出现在列表」（R4-14）由结构保证。
// ★ 不新增注入项 / 不新增权限 / 不升 hostApi（架构 §1.4）。

/**
 * 内容安全插件 ref 前缀。
 * ★ 仅用于「旧开关 → 默认勾选」的兼容推导与「注册表为空」时的回退选项，
 *   不参与运行时依赖（运行时参与者一律来自注册表快照）。
 */
const CONTENT_SAFETY_REF_PREFIX = 'plugin.aliyun-content-safety.';

/** 未就绪原因码 → 中文说明（与 flow/registry#computeReadiness 的原因码对齐）。 */
const REASON_LABELS = Object.freeze({
  'missing-deps': '依赖未安装',
  'not-configured': '未配置',
  'not-registered': '未注册',
  'service-unreachable': '服务不可达',
  disabled: '已禁用',
  'plugin-disabled': '插件未启用',
});

/** 注入的对比引擎引用（apply 时写入）。 */
let _engine = null;
/** 本插件的配置 Proxy（apply 时写入），供动态选项 / 默认勾选读取当前模态与旧开关。 */
let _cfg = null;

/**
 * 未就绪原因码 → 中文说明。
 * @param {string} reason 原因码
 * @returns {string} 说明
 */
function reasonLabel(reason) {
  return REASON_LABELS[reason] || (reason || '未就绪');
}

/**
 * 当前配置的对比模态（缺省按文本处理）。
 * @returns {'text'|'image'} 模态
 */
function currentModality() {
  return _cfg && _cfg.modality === 'image' ? 'image' : 'text';
}

/**
 * 注册表为空时的回退选项（PRD §6.2：注册表为空 → 回退硬编码三通道）。
 * ★ 仅在 `engine.adjudicators()` 完全不可用时使用；正常路径一律来自注册表快照。
 * @param {'text'|'image'} modality 模态
 * @returns {Array<object>} 选项
 */
function fallbackRefOptions(modality) {
  const m = modality === 'image' ? 'image' : 'text';
  return [
    // ★ 词表对齐主路径（src/flow/nodes/builtin-local.js）：本地为 local-compute，云端为 paid-api，
    //   否则回退路径的「N 次判定 / M 次付费」汇总会漏算/误算。
    { value: 'builtin.localModel', label: '🖥️ 本地模型（Ollama）', desc: '回退通道', disabled: false, costHint: 'local-compute' },
    { value: 'builtin.cloudModel', label: '☁️ 云端大模型', desc: '回退通道', disabled: false, costHint: 'paid-api' },
    { value: `${CONTENT_SAFETY_REF_PREFIX}${m}`, label: '🛡️ 内容安全', desc: '回退通道（需装载内容安全插件）', disabled: false, costHint: 'paid-api' },
  ];
}

/**
 * 「参与对比的审核器」多选项：完全来自审核器注册表快照。
 *
 * ★ 选项内联在配置项里（而非走异步 source.rpc）：因为配置 UI 由 plugin-config.describe()
 *   静态渲染，选项必须随 describe() 一起下发，才能保证「装完插件刷新即出现」。
 *
 * @param {'text'|'image'} modality 模态
 * @returns {Array<{value: string, label: string, desc: string, disabled: boolean, costHint: string}>} 选项
 */
function refOptions(modality) {
  const m = modality === 'image' ? 'image' : 'text';
  let entries = [];
  try {
    if (_engine && typeof _engine.adjudicators === 'function') {
      const snap = _engine.adjudicators(m);
      if (snap && Array.isArray(snap.adjudicators)) entries = snap.adjudicators;
    }
  } catch {
    entries = [];
  }
  const usable = entries.filter((e) => e && e.comparable === true);
  if (usable.length === 0) return fallbackRefOptions(m);
  return usable.map((e) => {
    const hint = e.ready
      ? ''
      : [reasonLabel(e.reason), e.installHint ? `修复：${e.installHint}` : ''].filter(Boolean).join(' · ');
    return {
      value: e.ref,
      label: `${e.icon ? `${e.icon} ` : ''}${e.title || e.ref}`,
      desc: hint || '就绪',
      disabled: e.ready !== true,
      costHint: e.costHint || 'free',
    };
  });
}

/**
 * 默认勾选（PRD §6.2：旧字段 `includeCloud` / `includeContentSafety` 作为默认勾选来源）。
 * 仅勾选「可比且就绪」的审核器；旧开关为 false 时对应通道不勾选。
 * @param {'text'|'image'} modality 模态
 * @returns {string[]} ref 列表
 */
function defaultRefs(modality) {
  const includeCloud = _cfg ? _cfg.includeCloud !== false : true;
  const includeContentSafety = _cfg ? _cfg.includeContentSafety !== false : true;
  return refOptions(modality)
    .filter((o) => !o.disabled)
    .filter((o) => {
      if (o.value === 'builtin.cloudModel') return includeCloud;
      if (String(o.value).startsWith(CONTENT_SAFETY_REF_PREFIX)) return includeContentSafety;
      return true;
    })
    .map((o) => o.value);
}

// ─── 配置 Schema（对应「插件配置」页） ──

const CONFIG_SCHEMA = {
  name: PLUGIN_ID,
  title: '对比审核套件',
  description: '文本 + 图像双模态交叉对比：同一批内容用多个通道各判一次，给出两两一致率与分歧明细。',
  groups: [
    { id: 'scope', title: '对比范围', desc: '选择对比的模态与取样范围。' },
    { id: 'channels', title: '参与通道', desc: '勾选参与交叉对比的审核器（≥2 个）；未就绪项会自动置灰。' },
    { id: 'models', title: '本地模型', desc: '指定本地文本/视觉模型（留空则跟随全局默认）。' },
    { id: 'run', title: '运行方式', desc: '是否随每日调度自动运行，以及单次取样的上限。' },
    { id: 'legacy', title: '兼容开关（旧配置）', desc: '旧版开关，仅在未勾选任何审核器时作为默认勾选来源；新配置请直接勾选上方审核器。', defaultOpen: false },
  ],
  fields: [
    {
      key: 'modality', type: 'radio-group', label: '对比模态', default: 'text', group: 'scope',
      desc: '文本 = 对当日审核文本重跑多通道；图像 = 对当日带图记录重跑多通道（需记录携带原始图片路径）。',
      options: [
        { value: 'text', label: '文本对比', desc: '对当日审核文本逐条重跑各通道' },
        { value: 'image', label: '图像对比', desc: '对当日带图记录逐张重跑各通道视觉审核' },
      ],
    },
    { key: 'maxItems', type: 'number', label: '单次取样上限', min: 1, max: 2000, default: 200, group: 'scope',
      desc: '单次对比最多处理的样本数，避免大量记录时长时间占用模型。' },
    { key: 'imageFolder', type: 'folder-picker', label: '图像来源目录（可选）', default: '', group: 'scope',
      desc: '图像对比时，若审核记录未携带图片路径，可从此目录取图对比。', visibleWhen: { 'config.modality': ['image'] } },

    { key: 'textModel', type: 'text', label: '本地文本模型', default: '', group: 'models',
      desc: '作为对比基线的本地文本模型，留空则跟随全局 textModel。', visibleWhen: { 'config.modality': ['text'] } },
    { key: 'visionModel', type: 'text', label: '本地视觉模型', default: '', group: 'models',
      desc: '作为对比基线的本地视觉模型，留空则跟随全局 visionModel。', visibleWhen: { 'config.modality': ['image'] } },
    { key: 'cloudVisionModel', type: 'text', label: '云端视觉模型', default: '', group: 'models',
      desc: '云端视觉通道使用的模型名，留空则跟随全局 qwenCloud.visionModel。', visibleWhen: { 'config.modality': ['image'] } },

    // ★ T04-B：参与者来自审核器注册表（options 在 describe() 时动态求值）。
    //   未就绪项 o.disabled=true + o.desc 给出原因与修复提示（P1-2）。
    {
      key: 'comparisonRefs', type: 'checkbox-group', label: '参与对比的审核器', group: 'channels',
      default: [], showCostSummary: true,
      desc: '勾选参与交叉对比的审核器（至少 2 个）。列表来自审核器注册表，与拓扑画布节点面板同源；未就绪项已置灰并给出原因与修复提示。',
      get options() { return refOptions(currentModality()); },
    },

    // ── 兼容开关（旧配置，PRD §6.2 回退路径）──
    // 仅当上方「参与对比的审核器」为空时作为默认勾选来源；一旦勾选审核器即以其为准。
    // 字段保留 ⇒ 旧配置值可读、不丢数据。
    { key: 'includeCloud', type: 'switch', label: '（兼容）纳入云端通道', default: true, group: 'legacy',
      desc: '旧开关：仅在未勾选任何审核器时生效。' },
    { key: 'includeContentSafety', type: 'switch', label: '（兼容）纳入内容安全通道', default: true, group: 'legacy',
      desc: '旧开关：仅在未勾选任何审核器时生效（图像需 contentSafety.imageEnabled 为真）。' },

    { key: 'autoRun', type: 'switch', label: '随每日调度自动运行', default: false, group: 'run',
      desc: '开启后按核心调度时间（默认 04:00）自动跑一次对比；关闭则仅手动触发。' },
    { key: 'keepAlive', type: 'text', label: '模型 keep_alive', default: '5m', group: 'run',
      desc: '对比过程中本地模型的显存保留时长，留空使用全局默认。' },
  ],
};

// ─── 视图 Schema 由 RPC 动态返回（按当前配置与运行状态变化）───

/**
 * 组装视图 Schema。
 * @param {object} state 当前状态
 * @returns {object} 视图 Schema
 */
function buildViewSchema(state) {
  const s = state || {};
  const rate = Number(s.agreementRate) || 0;
  const tone = rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'danger';
  const selectedCount = Number(s.selectedCount) || 0;
  // ★ T04-C：勾选 <2 个时给出文字说明（PRD §5.2「勾选数 < 2 时禁用并给出文字说明」）
  const countHint = selectedCount < 2
    ? [{ type: 'alert', tone: 'warn', text: `已选 ${selectedCount} 个审核器，至少需选择 2 个已就绪审核器才能进行交叉对比。` }]
    : [];
  return {
    version: 1,
    state: {
      running: Boolean(s.running),
      modality: s.modality || 'text',
      progressText: s.progressText || '',
      latestDate: s.latestDate || '',
      agreementRate: rate,
      totalRecords: Number(s.totalRecords) || 0,
      validRecords: Number(s.validRecords) || 0,
      skippedErrors: Number(s.skippedErrors) || 0,
      channelsText: s.channelsText || '—',
      selectedCount,
      pairs: Array.isArray(s.pairs) ? s.pairs : [],
      rows: Array.isArray(s.rows) ? s.rows : [],
    },
    sections: [
      {
        title: '运行控制',
        fields: [
          { type: 'radio-group', bind: 'state.modality', label: '对比模态', options: [
            { value: 'text', label: '文本', desc: '重跑当日文本' },
            { value: 'image', label: '图像', desc: '重跑当日带图记录' },
          ] },
          { type: 'text', bind: 'state.latestDate', label: '目标日期', placeholder: 'YYYY-MM-DD（留空=昨天）' },
          { type: 'button-group', buttons: [
            { id: 'run', label: '立即运行对比', tone: 'primary', rpc: 'comparison.run',
              params: { date: '$state.latestDate', modality: '$state.modality' },
              onSuccess: [{ set: { 'state.progressText': '对比中…' } }] },
            { id: 'refresh', label: '刷新状态', tone: 'ghost', rpc: 'comparison.status',
              onSuccess: [
                { set: { 'state.running': '$result.running' } },
                { set: { 'state.progressText': '$result.progressText' } },
              ] },
          ] },
          { type: 'alert', tone: tone === 'ok' ? 'info' : 'warn', visibleWhen: { 'state.running': [true] },
            text: '对比正在运行中，本地模型已临时卸载，审核服务暂不可用；完成后自动恢复。' },
          { type: 'progress', bind: 'state.progressText', visibleWhen: { 'state.running': [true] } },
          ...countHint,
        ],
      },
      {
        title: '本次对比摘要',
        fields: [
          { type: 'stat-cards', cards: [
            { label: '总记录数', value: '$state.totalRecords' },
            { label: '去重后可对比', value: '$state.validRecords' },
            { label: '通道失败数', value: '$state.skippedErrors' },
            { label: `${s.latestDate || ''} 平均一致率`, value: `${rate}%`, tone },
          ] },
          { type: 'markdown', text: `参与通道：${s.channelsText || '—'}` },
          { type: 'datatable', title: '各通道对一致率', columns: [
            { key: 'pair', label: '通道对' },
            { key: 'rate', label: '一致率' },
            { key: 'agreed', label: '一致' },
            { key: 'disagreed', label: '分歧' },
            { key: 'confA', label: 'A 平均置信度' },
            { key: 'confB', label: 'B 平均置信度' },
          ], rows: '$state.pairs', emptyText: '暂无对比结果' },
        ],
      },
      {
        title: '分歧明细',
        fields: [
          { type: 'datatable', title: '仅显示存在分歧的记录', columns: [
            { key: 'when', label: '时间' },
            { key: 'content', label: '内容' },
            { key: 'summary', label: '分歧点' },
          ], rows: '$state.rows', emptyText: '本次无分歧记录' },
        ],
      },
    ],
  };
}

// ─── 插件主体 ───

/**
 * 对比审核套件插件。
 * @param {object} ctx BridgeContext
 */
function comparisonSuite(ctx) {
  // ★ 先建立引擎与配置引用：配置项 comparisonRefs 的 options / 默认勾选需要读取注册表与当前模态
  _engine = ctx.inject('comparisonEngine');
  const config = ctx.config(CONFIG_SCHEMA);
  _cfg = config;
  // 兼容（PRD §6.2）：从未勾选过时，用旧开关 includeCloud / includeContentSafety 推导默认勾选
  if (!Array.isArray(config.comparisonRefs) || config.comparisonRefs.length === 0) {
    const seeded = defaultRefs(currentModality());
    if (seeded.length) config.comparisonRefs = seeded;
  }

  const source = ctx.inject('comparisonSource');
  const store = ctx.inject('comparisonStore');
  const probe = ctx.inject('comparisonProbe');
  const core = ctx.inject('comparisonCore');
  const engine = ctx.inject('comparisonEngine');
  const logger = ctx.inject('logger', false) || { info() {}, warn() {}, error() {} };

  /** 运行状态（单实例串行，避免显存竞争） */
  const runtime = { running: false, progress: null, lastError: null, lastDate: '' };

  /**
   * 取生效配置：插件配置优先，留空则回落到宿主全局配置投影。
   * @returns {object} 生效配置
   */
  function effectiveConfig() {
    const hostConfig = (ctx.host && ctx.host.config) || {};
    const ollama = hostConfig.ollama || {};
    const qwen = hostConfig.qwenCloud || {};
    return {
      modality: config.modality || 'text',
      maxItems: Number(config.maxItems) > 0 ? Number(config.maxItems) : 200,
      imageFolder: config.imageFolder || '',
      textModel: config.textModel || ollama.textModel || '',
      visionModel: config.visionModel || ollama.visionModel || '',
      cloudVisionModel: config.cloudVisionModel || qwen.visionModel || '',
      // ★ T04-B：注册表勾选集合（引擎据此决定谁参与）；缺省时引擎回退旧开关语义
      comparisonRefs: Array.isArray(config.comparisonRefs) ? config.comparisonRefs.slice() : null,
      includeCloud: config.includeCloud !== false,
      includeContentSafety: config.includeContentSafety !== false,
      keepAlive: config.keepAlive || '5m',
      autoRun: config.autoRun === true,
      comparisonModels: Array.isArray(ollama.comparisonModels) ? ollama.comparisonModels : [],
      comparisonSchedule: ollama.comparisonSchedule || '04:00',
    };
  }

  /**
   * 执行一次对比（串行保护 + 状态维护）。
   * @param {{date?: string, modality?: string}} params 参数
   * @returns {Promise<object>} 对比结果
   */
  async function runOnce(params = {}) {
    if (runtime.running) throw new Error('对比审核正在运行中，请等待完成');
    const cfg = effectiveConfig();
    const modality = params.modality === 'image' || params.modality === 'text'
      ? params.modality
      : cfg.modality;
    const date = (params.date && String(params.date).trim()) || store.yesterdayStr();

    runtime.running = true;
    runtime.progress = { phase: '准备中', done: 0, total: 0 };
    runtime.lastError = null;
    try {
      const result = await engine.runComparison(
        {
          source, store, probe, core, logger, config: cfg,
          onProgress: (p) => { runtime.progress = p; },
        },
        { date, modality, maxItems: cfg.maxItems, folder: cfg.imageFolder },
      );
      runtime.lastDate = date;
      return result;
    } catch (err) {
      runtime.lastError = err.message;
      logger.error(`[comparison] 对比失败: ${err.message}`);
      throw err;
    } finally {
      runtime.running = false;
      runtime.progress = null;
    }
  }

  // ─── RPC：主入口 ───

  /** 运行对比（写操作，公网需密码） */
  ctx.rpc('comparison.run', async (p = {}) => {
    const result = await runOnce({ date: p.date, modality: p.modality });
    return {
      success: true,
      date: result.date,
      modality: (result.summary && result.summary.modalities && result.summary.modalities[0]) || 'text',
      total_records: result.total_records,
      summary: result.summary,
    };
  }, { write: true });

  /** 运行状态（含调度信息） */
  ctx.rpc('comparison.status', async () => {
    const cfg = effectiveConfig();
    const st = engine.statusOf({ config: cfg, running: runtime.running, progress: runtime.progress, probe });
    st.lastError = runtime.lastError;
    st.modality = cfg.modality;
    st.autoRun = cfg.autoRun;
    return st;
  });

  /** 列出全部对比结果日期 */
  ctx.rpc('comparison.list', async () => {
    const list = store.listResults();
    return { total: list.length, comparisons: list };
  });

  /** 读取指定日期（或最新）的对比结果 */
  ctx.rpc('comparison.get', async (p = {}) => {
    let date = p.date;
    if (!date || date === 'latest') {
      const list = store.listResults();
      if (list.length === 0) return null;
      date = list[0].date;
    }
    const data = store.readResult(date);
    if (!data) return null;
    return { ...data, requestedDate: date };
  });

  /** 插件当前生效配置（供前端展示，不含任何密钥） */
  ctx.rpc('plugin.config', async () => {
    const cfg = effectiveConfig();
    return {
      modality: cfg.modality,
      maxItems: cfg.maxItems,
      imageFolder: cfg.imageFolder,
      textModel: cfg.textModel,
      visionModel: cfg.visionModel,
      cloudVisionModel: cfg.cloudVisionModel,
      comparisonRefs: Array.isArray(cfg.comparisonRefs) ? cfg.comparisonRefs : [],
      includeCloud: cfg.includeCloud,
      includeContentSafety: cfg.includeContentSafety,
      autoRun: cfg.autoRun,
    };
  });

  /** 配置 Schema 解析器（manifest.contributes.config.schemaResolver） */
  ctx.rpc('configSchema', async () => CONFIG_SCHEMA);

  /** 视图 Schema 解析器：按当前配置与最新结果动态生成 */
  ctx.rpc('viewSchema', async (p = {}) => {
    if (p.viewId && p.viewId !== 'main') return null;
    const cfg = effectiveConfig();
    const list = store.listResults();
    const latest = list[0] || null;
    const data = latest ? store.readResult(latest.date) : null;

    const pairs = [];
    if (data && data.summary && data.summary.comparisons) {
      for (const [key, comp] of Object.entries(data.summary.comparisons)) {
        pairs.push({
          pair: key,
          rate: `${comp.agreement_rate}%`,
          agreed: comp.agreed,
          disagreed: comp.disagreed,
          confA: `${Math.round((comp.avg_confidence_a || 0) * 100)}%`,
          confB: `${Math.round((comp.avg_confidence_b || 0) * 100)}%`,
        });
      }
    }
    const avgRate = pairs.length
      ? Math.round((pairs.reduce((n, p2) => n + parseFloat(p2.rate), 0) / pairs.length) * 10) / 10
      : 0;

    // 分歧明细：只挑「至少一对不一致」的记录，最多 50 条
    const rows = [];
    for (const r of (data && data.results) || []) {
      const comps = Object.entries(r.comparisons || {});
      const diffs = comps.filter(([, c]) => !c.agreed);
      if (diffs.length === 0) continue;
      const parts = [];
      for (const [pair, c] of diffs) {
        const [la, lb] = pair.split('_vs_');
        if (c.risk_level_changed) parts.push(`${la}→${lb} 风险 ${c[`risk_${la}`]}→${c[`risk_${lb}`]}`);
        if (!c.action_agreed) parts.push(`${la}/${lb} 拦截不一致`);
        if (c.categories_added && c.categories_added.length) parts.push(`${lb} 多标 ${c.categories_added.join('/')}`);
        if (c.categories_removed && c.categories_removed.length) parts.push(`${lb} 漏标 ${c.categories_removed.join('/')}`);
      }
      rows.push({
        when: r.timestamp ? new Date(r.timestamp).toLocaleString('zh-CN') : '',
        content: String(r.text || '').slice(0, 120),
        summary: parts.slice(0, 3).join('；') || '存在分歧',
      });
      if (rows.length >= 50) break;
    }

    const channelsText = (data && data.summary && data.summary.channels)
      ? data.summary.channels.join(' · ')
      : '尚无结果';

    return buildViewSchema({
      running: runtime.running,
      modality: cfg.modality,
      progressText: runtime.progress
        ? `${runtime.progress.phase}（${runtime.progress.done}/${runtime.progress.total}）`
        : '',
      latestDate: latest ? latest.date : '',
      agreementRate: avgRate,
      totalRecords: data ? data.total_records : 0,
      validRecords: data && data.summary ? data.summary.valid : 0,
      skippedErrors: data && data.summary
        ? Object.values(data.summary.skipped_errors || {}).reduce((n, v) => n + (Number(v) || 0), 0)
        : 0,
      channelsText,
      selectedCount: Array.isArray(cfg.comparisonRefs) ? cfg.comparisonRefs.length : 0,
      pairs,
      rows,
    });
  });

  // 提供服务，供其他插件/核心复用同一对比引擎
  ctx.provide('comparison', {
    run: (params) => runOnce(params),
    status: () => engine.statusOf({ config: effectiveConfig(), running: runtime.running, progress: runtime.progress, probe }),
    list: () => store.listResults(),
    get: (date) => store.readResult(date),
  });

  ctx.onDispose(() => {
    runtime.running = false;
    runtime.progress = null;
  });

  logger.info('[comparison] 对比审核套件已就绪（文本 + 图像双模态）');
}

Object.defineProperty(comparisonSuite, 'name', { value: PLUGIN_ID, configurable: true });
comparisonSuite.description = '文本 + 图像双模态交叉对比审核（与核心解耦的独立插件）';
comparisonSuite.version = '1.0.0';

module.exports = comparisonSuite;
module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;