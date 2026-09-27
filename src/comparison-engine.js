/**
 * 对比审核引擎（src/comparison-engine.js）
 * v2.3.0（Req5）核心：**文本与图像共用同一条对比管线**。
 * 二者只在两处不同——「怎么把源数据取成待测样本」与「用哪一组探针」，
 * 其余（去重、逐通道实跑、两两对比、汇总一致率、落盘）完全共用一份实现。
 * 这正是「同时支持图像和文本」的正确做法：不是写两套流程，
 * 而是把差异收敛成两个可替换的策略（planFor 的 samples 装配 + channels / runLocal）。
 * v0.1.0（T04-A / P0-6）：**通道不再硬编码**。
 * 非本地通道一律**从审核器注册表枚举**（src/flow/adjudicators#list）：
 * - 只有 `comparable === true`（有可用运行器）的审核器能进对比；
 * - 只有**被勾选**（插件配置 `comparisonRefs`，见 plugins/comparison-suite）且 `ready === true` 的才参与；
 * - `runner`（localModel / cloudModel / pluginVerdict）决定**分发**，真正的实跑仍收敛在
 * src/comparison-probe.js#adjudicatorVerdict —— 本文件只做「编排 + 装配」，不落地任何实现。
 * 这样「新装一个声明 image.verdict 的插件 → 对比列表自动出现」（R4-14）由结构保证，
 * 核心与对比插件都**零代码改动**。
 * 回退（PRD §6.2 回滚路径）：当注册表整体不可用（拿不到任何可比审核器）时，
 * 退回旧硬编码三通道（local / cloud / content_safety），行为与 v2.3.0 一致。
 * 为什么本文件必须存在于核心层：
 * 本引擎有两个消费者——内置路径（src/comparator.js，插件不可用时的兜底）
 * 与对比审核插件（plugins/comparison-suite，经注入的 comparisonEngine 取得）。
 * 若两边各写一份编排，任何一处口径微调（例如「review 算不算拦截」）都会让
 * 同一份数据在两条路径下算出不同一致率，而用户看到的是同一个界面 ——
 * 这是最难排查的一类不一致。故**全项目只有这一份 runComparison**。
 * 依赖方向：核心层模块，只依赖核心内部模块（ollama 仅用于显存卸载，flow/adjudicators 为只读投影），
 * **不得反向依赖插件层**（由 scripts/lint-plugin-boundary.js 静态把关）。
 */
const { unloadModel } = require('./ollama');
const adjudicators = require('./flow/adjudicators');
// v0.2.0：图片样本的内容寻址 hash（与审核记录 result.image_ref.hash 同一关联键）
const imageRefModule = require('./image-ref');

/**
 * 内置 ref → 历史通道短标签。
 * 核心认识自己的内置 ref 不算越界；**插件 ref 一律不写死**（见 RETIRED_REFS 的通用推导）。
 */
const BUILTIN_CHANNEL_LABELS = Object.freeze({
  'builtin.cloudModel': 'cloud',
  'builtin.localModel': 'local',
});

/** 缺省参与集合里的固定两项（核心内置 ref；内容安全继任者由迁移表推导，不写字面量）。*/
const BUILTIN_LOCAL_REF = 'builtin.localModel';
const BUILTIN_CLOUD_REF = 'builtin.cloudModel';

/**
 * 旧硬编码文本通道定义。
 * 仅在「注册表整体不可用」时作为回退使用（保持 v2.3.0 行为）；正常路径一律走注册表。
 */
const TEXT_CHANNELS = Object.freeze({
  cloud: {
    kind: 'cloud',
    ref: BUILTIN_CLOUD_REF,
    label: 'cloud',
    needConfig: 'cloud',
    run: (probe, sample) => probe.textCloud(sample.payload),
  },
  content_safety: {
    kind: 'safety',
    ref: null,
    label: 'content_safety',
    needConfig: 'content_safety',
    run: (probe, sample) => probe.textSafety(sample.payload),
  },
});

/**
 * 旧硬编码图像通道定义（回退用，语义同 v2.3.0）。
 * @param {string} [cloudVisionModel] 云端视觉模型名（空则跟随全局）
 * @returns {object} 通道定义表
 */
function legacyImageChannels(cloudVisionModel) {
  return {
    cloud: {
      kind: 'cloud',
      ref: BUILTIN_CLOUD_REF,
      label: 'cloud',
      needConfig: 'cloudVision',
      run: (probe, sample) => probe.imageCloud(sample.imageBase64, sample.caption, cloudVisionModel || ''),
    },
    content_safety: {
      kind: 'safety',
      ref: null,
      label: 'content_safety',
      needConfig: 'content_safety',
      run: (probe, sample) => probe.imageSafety(sample.imageBase64, sample.caption),
    },
  };
}

/**
 * 归一化模态取值。
 * @param {string} [modality] 模态
 * @returns {'text'|'image'} 模态
 */
function normModality(modality) {
  return modality === 'image' ? 'image' : 'text';
}

/**
 * 已下线 ref → 历史通道短标签（不写字面量：从 RETIRED_REFS 的键推导）。
 * 目的：让「内容安全继任 ref」在结果里仍显示为历史通道名 `content_safety`，
 * 使前端与历史对比记录零改动；同时避免核心出现任何历史/插件 ref 硬编码（R3-10）。
 * @param {string} retiredRef 已下线的 ref，如 'builtin.contentSafety'
 * @returns {string} 历史短标签，如 'content_safety'
 */
function retiredChannelLabel(retiredRef) {
  const name = String(retiredRef).split('.')[1] || '';
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * 审核器条目 → 对比通道名。
 * @param {object} entry 审核器条目（AdjudicatorEntry）
 * @param {'text'|'image'} modality 模态
 * @returns {string} 通道名（内置与已下线继任者保持历史名，其余用 ref）
 */
function channelNameOf(entry, modality) {
  if (!entry || !entry.ref) return '';
  const m = normModality(modality);
  if (BUILTIN_CHANNEL_LABELS[entry.ref]) return BUILTIN_CHANNEL_LABELS[entry.ref];
  for (const retiredRef of Object.keys(adjudicators.RETIRED_REFS)) {
    if (adjudicators.successorOf(retiredRef, m) === entry.ref) return retiredChannelLabel(retiredRef);
  }
  return entry.ref;
}

/**
 * 本次参与对比的 ref 集合。
 * 优先使用插件配置的勾选（`comparisonRefs`，注册表驱动）；
 * 缺省时回退旧布尔开关的语义（PRD §6.2：`includeCloud` / `includeContentSafety` 作为默认勾选来源）。
 * @param {object} cfg 生效配置
 * @param {'text'|'image'} modality 模态
 * @returns {string[]} ref 列表
 */
function selectedRefs(cfg, modality) {
  const c = cfg || {};
  const m = normModality(modality);
  if (Array.isArray(c.comparisonRefs)) {
    return c.comparisonRefs.filter((r) => typeof r === 'string' && r);
  }
  const refs = [BUILTIN_LOCAL_REF];
  if (c.includeCloud !== false) refs.push(BUILTIN_CLOUD_REF);
  if (c.includeContentSafety !== false) {
    for (const retiredRef of Object.keys(adjudicators.RETIRED_REFS)) {
      const succ = adjudicators.successorOf(retiredRef, m);
      if (succ && !refs.includes(succ)) refs.push(succ);
    }
  }
  return refs;
}

/**
 * 注册表中「可比」的审核器条目（异常一律降级为空数组：注册表坏了不能拖垮对比）。
 * @param {'text'|'image'} modality 模态
 * @returns {Array<object>} AdjudicatorEntry 列表
 */
function comparableEntries(modality) {
  try {
    return adjudicators.list(modality).filter((e) => e && e.comparable === true);
  } catch {
    return [];
  }
}

/**
 * 取单个审核器条目（异常降级为 null）。
 * @param {string} ref 节点 ref
 * @returns {object|null} AdjudicatorEntry 或 null
 */
function safeAdjudicator(ref) {
  try {
    return adjudicators.get(ref);
  } catch {
    return null;
  }
}

/**
 * 本地模型是否参与本次对比。
 * 判定顺序：是否被勾选 → 若注册表能给出条目则要求就绪 → 否则保守放行
 * （注册表不可用时保持既有「本地模型恒参与基线」的行为，宁可多跑不可少算）。
 * @param {object} cfg 生效配置
 * @param {'text'|'image'} modality 模态
 * @returns {boolean} 是否参与
 */
function localParticipates(cfg, modality) {
  const selected = selectedRefs(cfg, modality);
  if (!selected.includes(BUILTIN_LOCAL_REF)) return false;
  const entry = safeAdjudicator(BUILTIN_LOCAL_REF);
  if (entry && entry.comparable === true && entry.ready !== true) return false;
  return true;
}

/**
 * 装配「非本地」对比通道（注册表驱动）。
 * 过滤：`comparable === true` && 被勾选 && `ready === true`；本地通道在此排除
 * （由 planFor 的 localModels 专门展开，以保留「主模型 + 对照模型」多列行为）。
 * @param {object} cfg 生效配置
 * @param {'text'|'image'} modality 模态
 * @returns {Array<{name: string, ref: (string|null), entry: (object|null), legacy: (boolean|undefined), run: Function}>} 通道列表
 */
function planChannels(cfg, modality) {
  const c = cfg || {};
  const m = normModality(modality);
  const entries = comparableEntries(m);
  if (entries.length === 0) return legacyPlanChannels(c, m);

  const selected = new Set(selectedRefs(c, m));
  const out = [];
  for (const entry of entries) {
    if (entry.runner === 'localModel') continue;        // 本地由 localModels 展开
    if (!selected.has(entry.ref)) continue;             // 未勾选不参与
    if (entry.ready !== true) continue;                 // 未就绪不参与（就绪判定唯一入口）
    const override = entry.runner === 'cloudModel' ? (c.cloudVisionModel || '') : '';
    out.push({
      name: channelNameOf(entry, m),
      ref: entry.ref,
      entry,
      run: (probe, sample) => probe.adjudicatorVerdict(entry, sample, m, { imageModelOverride: override }),
    });
  }
  return out;
}

/**
 * 回退通道装配（注册表整体不可用时）。
 * @param {object} cfg 生效配置
 * @param {'text'|'image'} modality 模态
 * @returns {Array<{name: string, ref: (string|null), entry: (object|null), legacy: boolean, run: Function}>} 通道列表
 */
function legacyPlanChannels(cfg, modality) {
  const c = cfg || {};
  const defs = modality === 'image' ? legacyImageChannels(c.cloudVisionModel) : TEXT_CHANNELS;
  const out = [];
  for (const [name, def] of Object.entries(defs)) {
    if (name === 'cloud' && c.includeCloud === false) continue;
    if (name === 'content_safety' && c.includeContentSafety === false) continue;
    out.push({
      name,
      ref: def.ref || null,
      entry: null,
      legacy: true,
      run: (probe, sample) => def.run(probe, sample),
    });
  }
  return out;
}

/**
 * 取某模态的装配方案（模态差异点全部收敛在此）。
 * @param {object} cfg 生效配置 { textModel, visionModel, cloudVisionModel, comparisonModels, keepAlive }
 * @param {'text'|'image'} modality 模态
 * @returns {{channels: Array<object>, localModels: string[], runLocal: Function, localKind: ('text'|'image')}} 方案
 */
function planFor(cfg, modality) {
  const c = cfg || {};
  const m = normModality(modality);

  let localModels;
  let runLocal;
  if (m === 'image') {
    // 图像模态只跑视觉模型：comparisonModels 是文本模型，拿去判图无意义（「根据实际调整」）
    localModels = c.visionModel ? [c.visionModel] : [];
    runLocal = (model, probe, sample) => probe.imageLocal(sample.imageBase64, sample.caption, model);
  } else {
    const main = c.textModel || '';
    const extras = (Array.isArray(c.comparisonModels) ? c.comparisonModels : []).filter((x) => x && x !== main);
    localModels = main ? [main, ...extras] : extras;
    runLocal = (model, probe, sample) => probe.textLocal(model, sample.payload, c.keepAlive || '5m');
  }

  // 本地模型参与与否由「是否勾选 builtin.localModel」决定（注册表不可用时保守放行）
  if (!localParticipates(c, m)) localModels = [];

  return { channels: planChannels(c, m), localModels, runLocal, localKind: m };
}

/**
 * 判断某通道在当前配置下是否可用（只看开关与凭据，不发起真实调用）。
 * 保留历史签名（被内置路径与历史调用方使用）；注册表化后主链路改用就绪度判定。
 * @param {object} probe 探针服务
 * @param {string} need 需要的配置开关
 * @returns {boolean} 是否可用
 */
function channelAvailable(probe, need) {
  const avail = probe.channelAvailability();
  return Boolean(avail[need]);
}

/**
 * 兼容槽：历史字段 `channels_enabled` 的取值（保持 `{cloud, content_safety}` 形状不变）。
 * @param {object} probe 探针服务
 * @returns {{cloud: boolean, content_safety: boolean}} 可用性
 */
function channelsEnabled(probe) {
  const avail = (probe && typeof probe.channelAvailability === 'function') ? probe.channelAvailability() : {};
  return { cloud: Boolean(avail.cloud), content_safety: Boolean(avail.content_safety) };
}

/**
 * 新增字段 `channels_by_ref`：按 ref 的实际可用性（注册表视角），供新 UI/排障使用。
 * @param {object} probe 探针服务
 * @returns {object} ref → boolean
 */
function channelsByRef(probe) {
  const avail = (probe && typeof probe.channelAvailability === 'function') ? probe.channelAvailability() : {};
  const out = {};
  for (const [ref, ok] of Object.entries(avail.adjudicators || {})) out[ref] = Boolean(ok);
  return out;
}

/**
 * 把审核记录里的一条文本记录转成待测样本。
 * @param {object} record 审核记录
 * @returns {object|null} 样本（无文本内容返回 null）
 */
function textSampleOf(record) {
  const text = record && typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return null;
  return {
    key: text,
    id: record.id,
    timestamp: record.timestamp,
    preview: text.length > 200 ? `${text.slice(0, 200)}...` : text,
    fullLength: text.length,
    payload: text,
  };
}

/**
 * 把「图片记录（可为 null，表示来自目录来源）+ 已读到的 base64」转成待测样本。
 * @param {object|null} record 审核记录（目录来源时为 null）
 * @param {string} imageBase64 base64 图片
 * @param {string} imagePath 源路径
 * @returns {object} 样本
 */
function imageSampleOf(record, imageBase64, imagePath) {
  const caption = record && typeof record.text === 'string' ? record.text.trim() : '';
  return {
    key: imagePath,
    id: record ? record.id : null,
    timestamp: record ? record.timestamp : null,
    preview: caption || imagePath,
    fullLength: caption.length,
    imageBase64,
    caption,
    payload: caption,
  };
}

/**
 * 按 key 去重（保留最新一条），并剔除「基线结果异常」的样本。
 * 无基线的样本（如目录来源）**保留** —— 它们将由主本地模型实跑，而不是被丢弃。
 * @param {Array<object>} samples 样本数组
 * @param {object} core comparisonCore 服务
 * @param {Map<string, object>} baselineMap key → 主通道历史结果
 * @returns {{kept: Array<object>, dedupCount: number, skippedError: number}} 结果
 */
function dedupe(samples, core, baselineMap) {
  const map = new Map();
  let skippedError = 0;
  for (const s of samples) {
    if (!s) continue;
    const hasBaseline = baselineMap.has(s.key);
    const baseline = baselineMap.get(s.key);
    if (hasBaseline && core.isErrorResult(baseline)) { skippedError++; continue; }
    map.set(s.key, s); // 后面的覆盖前面的 → 保留最新
  }
  const kept = Array.from(map.values());
  return { kept, dedupCount: samples.length - kept.length, skippedError };
}

/**
 * 执行一次对比（文本或图像）。
 * @param {object} deps 依赖 { source, store, probe, core, logger, config, onProgress }
 * @param {{date: string, modality?: 'text'|'image', maxItems?: number, folder?: string}} options 选项
 * @returns {Promise<object>} 对比结果（与历史格式同构，前端零改动）
 */
async function runComparison(deps, options) {
  const { source, probe, core, logger } = deps;
  const store = deps.store;
  const cfg = deps.config || {};
  const opts = options || {};
  const date = opts.date;
  const modality = normModality(opts.modality);
  const maxItems = Number(opts.maxItems) > 0 ? Number(opts.maxItems) : 0;
  const onProgress = typeof deps.onProgress === 'function' ? deps.onProgress : () => {};
  const say = (level, msg) => {
    if (logger && typeof logger[level] === 'function') logger[level](msg);
  };

  // ── ① 取源数据 ──
  onProgress({ phase: '读取审核记录', done: 0, total: 0 });
  const records = source.readAuditRecords(date) || [];
  if (records.length === 0) {
    say('info', `[comparison] 日期 ${date} 无审核记录，跳过对比`);
    const empty = store.emptyResult(date, modality);
    store.writeResult(date, empty);
    return empty;
  }

  const byId = new Map();
  for (const r of records) {
    if (r && r.id !== undefined && r.id !== null) byId.set(r.id, r);
  }

  // ── ② 组装样本（模态差异点 1/2）──
  const samples = [];
  let skippedNoImage = 0;
  if (modality === 'image') {
    const gathered = source.collectAuditImages(records);
    skippedNoImage = gathered.skipped;
    for (const item of gathered.items) {
      const read = source.readImageBase64(item.imagePath);
      if (!read.ok) { skippedNoImage++; continue; }
      samples.push(imageSampleOf(item.record, read.imageBase64, item.imagePath));
    }
    // 目录兜底：仅当审核记录里一张图都拿不到时启用（记录优先，避免混入无关图片）
    if (samples.length === 0 && opts.folder) {
      const files = source.listFolderImages({ dir: opts.folder, maxItems: maxItems || 200 });
      say('info', `[comparison] 记录未携带可用图片，回退目录来源: ${opts.folder}（${files.length} 张）`);
      for (const f of files) {
        const read = source.readImageBase64(f.path);
        if (!read.ok) { skippedNoImage++; continue; }
        samples.push(imageSampleOf(null, read.imageBase64, f.path));
      }
    }
    say('info', `[comparison] 图像样本 ${samples.length} 张（另有 ${skippedNoImage} 条记录缺图，已跳过）`);
  } else {
    for (const r of records) {
      const s = textSampleOf(r);
      if (s) samples.push(s);
    }
    say('info', `[comparison] 文本样本 ${samples.length} 条`);
  }

  if (samples.length === 0) {
    say('info', `[comparison] ${date} 无可用${modality === 'image' ? '图片' : '文本'}样本，跳过对比`);
    const empty = store.emptyResult(date, modality);
    empty.summary.skipped_no_image = skippedNoImage;
    empty.message = modality === 'image'
      ? '无带图审核记录（图像对比需记录携带原始图片路径）'
      : '无审核记录';
    store.writeResult(date, empty);
    return empty;
  }

  // ─ 装配通道（模态差异点 2/2，注册表驱动）──
  const plan = planFor(cfg, modality);
  const baselineMap = new Map();
  for (const s of samples) {
    const rec = s.id !== null && s.id !== undefined ? byId.get(s.id) : null;
    if (rec && rec.result) baselineMap.set(s.key, rec.result);
  }

  const deduped = dedupe(samples, core, baselineMap);
  let work = deduped.kept;
  if (maxItems > 0 && work.length > maxItems) work = work.slice(0, maxItems);
  if (work.length === 0) {
    say('info', '[comparison] 去重后无可对比样本，跳过对比');
    const empty = store.emptyResult(date, modality);
    empty.summary.skipped_no_image = skippedNoImage;
    store.writeResult(date, empty);
    return empty;
  }

  const localModels = plan.localModels.slice();
  const mainLocal = localModels[0] || '';
  const otherChannels = Array.isArray(plan.channels) ? plan.channels : [];
  const allChannels = [...localModels, ...otherChannels.map((ch) => ch.name)];

  say('info', `[comparison] ${modality} 对比: ${records.length} → ${work.length} 条（去重 ${deduped.dedupCount}，基线异常跳过 ${deduped.skippedError}）`);
  say('info', `[comparison] 通道: ${allChannels.join(', ') || '（无可用通道）'}`);

  const modelResults = {};
  for (const ch of allChannels) modelResults[ch] = {};

  // 主本地模型的基线：审核记录里已有的结果直接复用，不重复调用（省显存）
  if (mainLocal) {
    for (const s of work) {
      const v = baselineMap.get(s.key);
      if (v) modelResults[mainLocal][s.key] = v;
    }
  }

  // 需要实跑的本地模型任务数（主模型仅对「无基线样本」实跑）
  let localTasks = 0;
  for (const model of localModels) {
    for (const s of work) {
      if (model === mainLocal && modelResults[model][s.key]) continue;
      localTasks++;
    }
  }
  const totalTasks = localTasks + otherChannels.length * work.length;
  let currentTask = 0;

  // 兼容槽：保留 {local, cloud, content_safety} 三个历史键；插件通道按通道名动态累加
  const skippedErrors = { local: 0, cloud: 0, content_safety: 0 };

  // ── ③ 逐通道实跑 ──
  for (const model of localModels) {
    const pending = work.filter((s) => !(model === mainLocal && modelResults[model][s.key]));
    if (pending.length === 0) continue;

    // 与历史行为一致：实跑前先卸载，避免显存里堆着上一个模型
    try { await unloadModel(model); } catch { /* 卸载失败不影响对比*/ }

    for (let i = 0; i < pending.length; i++) {
      const sample = pending[i];
      currentTask++;
      const phase = `本地模型 ${model}`;
      onProgress({ phase, done: currentTask, total: totalTasks, current: i + 1 });
      try {
        const verdict = await plan.runLocal(model, probe, sample);
        modelResults[model][sample.key] = verdict;
        say('info', `[comparison] [${model}] ${i + 1}/${pending.length} | ${verdict.risk_level}`);
      } catch (err) {
        modelResults[model][sample.key] = null;
        skippedErrors.local++;
        say('warn', `[comparison] [${model}] ${i + 1}/${pending.length} 失败: ${err.message}`);
      }
    }

    try {
      await unloadModel(model);
      say('info', `[comparison] 已卸载 ${model} 释放显存`);
    } catch { /* 忽略*/ }
  }

  for (const ch of otherChannels) {
    const phase = ch.name === 'cloud'
      ? '云端大模型审核'
      : ch.name === 'content_safety'
        ? '内容安全审核'
        : `审核器 ${ch.entry && ch.entry.title ? ch.entry.title : ch.name}`;
    say('info', `[comparison] 开始通道: ${ch.name}${ch.legacy ? '（回退通道）' : ''}`);
    for (let i = 0; i < work.length; i++) {
      const sample = work[i];
      currentTask++;
      onProgress({ phase, done: currentTask, total: totalTasks, current: i + 1 });
      try {
        const verdict = await ch.run(probe, sample);
        modelResults[ch.name][sample.key] = verdict;
        say('info', `[comparison] [${ch.name}] ${i + 1}/${work.length} | ${verdict.risk_level}`);
      } catch (err) {
        modelResults[ch.name][sample.key] = null;
        skippedErrors[ch.name] = (skippedErrors[ch.name] || 0) + 1;
        say('warn', `[comparison] [${ch.name}] ${i + 1}/${work.length} 失败: ${err.message}`);
      }
    }
  }

  // ── ④ 逐条两两对比 ──
  onProgress({ phase: '生成对比报告', done: totalTasks, total: totalTasks });
  const results = [];
  for (const sample of work) {
    const entry = {
      id: sample.id,
      timestamp: sample.timestamp,
      text: sample.preview,
      text_full_length: sample.fullLength,
      models: {},
      comparisons: {},
    };
    if (modality === 'image') {
      entry.image_path = sample.key;
      // v0.2.0：对比 entry 带上内容寻址 hash（**只读，不回写审计** —— 对比是 dry-run）。
      // 两侧用同一个 hash 就能对上（G1：同一张图在审核记录与对比结果里可关联）。
      entry.image_hash = sample.imageHash || null;
    }

    for (const ch of allChannels) {
      const out = modelResults[ch][sample.key];
      entry.models[ch] = out
        ? {
          risk_level: out.risk_level,
          categories: out.categories || [],
          confidence: out.confidence,
          reason: out.reason || '',
          ...(out.content_safety_raw ? { content_safety_raw: out.content_safety_raw } : {}),
        }
        : null;
    }

    for (const pair of core.pairKeys(allChannels)) {
      const ra = modelResults[pair.a][sample.key];
      const rb = modelResults[pair.b][sample.key];
      if (ra && rb) {
        entry.comparisons[pair.key] = core.compareResults(ra, rb, pair.labelA, pair.labelB);
      }
    }
    results.push(entry);
  }

  // ─ ⑤ 汇总 ─
  const mainLabel = core.modelLabel(mainLocal || 'local');
  const summary = {
    total: records.length,
    valid: work.length,
    deduplicated: deduped.dedupCount,
    channels: allChannels,
    models: localModels,
    comparisons: core.summarizePairs(results, allChannels),
    skipped_errors: skippedErrors,
    // 去重阶段因「基线结果异常（confidence=0 或 reason 含异常/error）」被排除的条数。
    // 它与 skipped_errors（实跑失败）是两回事，必须分开呈现，否则用户无法判断
    // 「样本变少」究竟是重复多还是历史结果脏。
    skipped_baseline_error: deduped.skippedError,
    // 兼容槽：字段名与形状保持历史不变（前端与历史记录依赖）
    channels_enabled: channelsEnabled(probe),
    // 新增（附加字段，非破坏性）：按 ref 的实际可用性，供注册表化 UI 与排障
    channels_by_ref: channelsByRef(probe),
    modalities: [modality],
    main_channel_label: mainLabel,
    skipped_no_image: skippedNoImage,
  };

  const output = {
    date,
    run_at: new Date().toISOString(),
    total_records: records.length,
    results,
    summary,
  };

  const written = store.writeResult(date, output);
  say('info', `[comparison] 对比完成: ${date}（${modality}），结果已保存到 ${written || '（写入失败）'}`);
  return output;
}

/**
 * 选定后的通道名清单（本次选择 ∩ 就绪）。
 * @param {object} cfg 生效配置
 * @param {'text'|'image'} modality 模态
 * @returns {string[]} 通道名
 */
function selectedChannelNames(cfg, modality) {
  try {
    const plan = planFor(cfg, modality);
    return [...plan.localModels, ...plan.channels.map((ch) => ch.name)];
  } catch {
    return [];
  }
}

/**
 * 生成对比运行状态（插件与内置共用同一状态口径）。
 * @param {object} deps 依赖 { config, running, progress, probe }
 * @returns {object} 状态
 */
function statusOf(deps) {
  const cfg = (deps && deps.config) || {};
  const probe = deps && deps.probe;
  const avail = probe ? probe.channelAvailability() : {};
  const modality = normModality(cfg.modality);
  return {
    running: Boolean(deps && deps.running),
    progress: (deps && deps.progress) || null,
    comparisonModels: Array.isArray(cfg.comparisonModels) ? cfg.comparisonModels : [],
    mainModel: cfg.textModel || '',
    visionModel: cfg.visionModel || '',
    schedule: cfg.comparisonSchedule || '04:00',
    modality: cfg.modality || 'text',
    // 兼容槽：形状与历史一致
    channels: {
      cloud: Boolean(avail.cloud),
      cloudVision: Boolean(avail.cloudVision),
      content_safety: Boolean(avail.content_safety),
    },
    // T04-C：本次将实际参与的通道清单；前端据此在 <2 时禁用「手动触发对比」
    selectedChannels: selectedChannelNames(cfg, modality),
  };
}

/**
 * 只读审核器快照（AdjudicatorSnapshot）。
 * 供对比插件经**已存在的** `comparisonEngine` 注入读取——不新增注入项、不新增权限、
 * 不升 `hostApi`（架构 §1.4）。插件据此把「参与对比的审核器」多选项内联到配置 UI。
 * @param {'text'|'image'} [modality] 模态
 * @returns {object} AdjudicatorSnapshot
 */
function adjudicatorSnapshot(modality) {
  return adjudicators.snapshot(modality);
}

module.exports = {
  TEXT_CHANNELS,
  planFor,
  channelAvailable,
  textSampleOf,
  imageSampleOf,
  dedupe,
  runComparison,
  statusOf,
  adjudicators: adjudicatorSnapshot,
};
