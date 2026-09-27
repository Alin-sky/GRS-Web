/**
 * 节点装配与调用分发（src/flow/nodes/index.js）
 * - registerBuiltins()：把 3 个内置节点登记进 flow/registry（唯一数据源）。
 * - invokeNode()：执行器调用入口。内置节点本地执行；插件节点经 capability-broker 点对点调用。
 * 本模块是「核心 → 插件」的唯一合法通道（flow/executor → capability-broker）。
 */

'use strict';

const registry = require('../registry');
const broker = require('../../capability-broker');

const precheckNode = require('./builtin-precheck');
const localNode = require('./builtin-local');
const cloudNode = require('./builtin-cloud');

/**
 * 内置节点集合（ref → { descriptor, run, readiness }）。
 * v0.1.0（决策 A）：内容安全不再是内置节点——它的唯一实现是 plugins/aliyun-content-safety，
 * 由本模块所写入的注册表在插件装载后自动登记 `plugin.aliyun-content-safety.{text,image}`。
 * 原 `builtin.contentSafety` 垫片已随 `builtin-contentsafety.js` 一并下线（git 可回滚）。
 */
const BUILTINS = [precheckNode, localNode, cloudNode];

/** 是否已登记内置节点。*/
let _registered = false;

/**
 * 登记内置节点（幂等）。
 * @returns {string[]} 已登记的 ref 列表
 */
function registerBuiltins() {
  if (_registered) return BUILTINS.map((b) => b.descriptor.ref);
  for (const mod of BUILTINS) {
    registry.registerBuiltin({
      ...mod.descriptor,
      readyFn: mod.readiness,
      run: mod.run,
    });
  }
  _registered = true;
  return BUILTINS.map((b) => b.descriptor.ref);
}

/**
 * 取内置节点的 run 函数。
 * @param {string} ref 节点 ref
 * @returns {Function|null} run 函数
 */
function builtinRunner(ref) {
  for (const mod of BUILTINS) {
    if (mod.descriptor.ref === ref) return mod.run;
  }
  return null;
}

/**
 * 执行一个插件判定节点（service 角色，点对点调用）。
 * @param {object} runtime 运行时
 * @param {object} descriptor 注册表描述符
 * @returns {Promise<object>} NodeResult
 */
async function runPluginJudge(runtime, descriptor) {
  const started = Date.now();
  const capability = descriptor.capability
    || (runtime.modality === 'image' ? 'image.verdict' : 'text.verdict');
  const request = {
    ref: descriptor.ref,
    params: runtime.params || {},
    payload: runtime.ctx.payload,
    modality: runtime.modality,
    work: runtime.ctx.work,
    meta: { strictness: runtime.strictness },
  };
  let verdict;
  try {
    verdict = await broker.invokeCall(capability, descriptor.owner, request);
  } catch (err) {
    return {
      nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
      status: 'failed', elapsedMs: Date.now() - started,
      failureType: 'plugin_rejected', skipReason: null, verdict: null,
      costHint: descriptor.costHint || 'free',
      message: `插件调用异常: ${err && err.message}`,
    };
  }

  if (!verdict) {
    // 未就绪（依赖缺失 / 未配置）→ skipped；已就绪但无有效返回 → failed（plugin_rejected）
    const notReady = descriptor.ready !== true;
    return {
      nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
      status: notReady ? 'skipped' : 'failed',
      elapsedMs: Date.now() - started,
      failureType: notReady ? null : 'plugin_rejected',
      skipReason: notReady ? (descriptor.notReadyReason || 'missing-deps') : null,
      verdict: null,
      costHint: descriptor.costHint || 'free',
      message: notReady ? `插件未就绪：${descriptor.notReadyReason || 'missing-deps'}` : '插件返回值未通过 gate 校验',
    };
  }

  return {
    nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
    status: 'ok', elapsedMs: Date.now() - started,
    failureType: null, skipReason: null, verdict,
    costHint: descriptor.costHint || 'free', message: '',
  };
}

/**
 * 把插件贡献中的**真实错误**映射为规范 skip_reason。
 * 为什么必需：此前 contribute 节点无论什么原因没拿到判定都写 `not-configured`,
 * 把「服务连不上 / 超时 / 熔断 / 真没配置」混成一句，掩盖真因（用户据此查不出所以然）。
 * @param {string} err 贡献里的 error 文本
 * @returns {'circuit-open'|'timeout'|'service-unreachable'|'not-configured'|'service-error'} 规范原因码
 */
function reasonFromContributionError(err) {
  const s = String(err || '').toLowerCase();
  if (!s) return 'service-error';
  if (s.includes('circuit_open') || s.includes('circuit-open')) return 'circuit-open';
  if (s.includes('超时') || s.includes('timeout') || s.includes('etimedout') || s.includes('aborted')) return 'timeout';
  if (s.includes('econnrefused') || s.includes('econnreset') || s.includes('enotfound')
    || s.includes('eai_again') || s.includes('ehostunreach') || s.includes('不可达')
    || s.includes('无法连接') || s.includes('connect')) return 'service-unreachable';
  if (s.includes('地址无效') || s.includes('invalid url')) return 'not-configured';
  return 'service-error';
}

/** 对象型 tags 展开后的**上限**（防止插件灌爆 work 上下文 / 污染 verdictCache）。*/
const MAX_EXPANDED_TAGS = 200;

/**
 * 把插件贡献里的**对象型 tags** 展开为字符串标签（ 确定性）。
 * T08d：WD14 的贡献形如 `{ tags: { rating:{...}, general:{ sky:0.39, ... }, character:{} } }`
 * —— 而本节点此前只合并**数组**型 tags，导致这些标签**从未**写进 `work.tags`
 * （manifest 却声明「写入工作上下文，供下游判定节点复用」）。
 * 确定性（**必须**，否则会给 `verdictCache` 带来不稳定输入）：
 * ① 分组顺序固定 `rating → general → character`；
 * ② 组内键按**字典序**排序（与对象内部键顺序无关）；
 * ③ 未归类的自定义键同样按字典序；
 * ④ 去重 + 上限 `MAX_EXPANDED_TAGS`。
 * ⇒ 同一输入连跑两次结果**逐元素相同**。
 * 不改既有行为：数组型 tags 走原路径（`Array.isArray` 分支），合并结果逐字节不变。
 * @param {any} tags 贡献里的 `tags` 字段
 * @returns {string[]} 稳定顺序的标签名
 */
function expandObjectTags(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return [];
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v && !out.includes(v) && out.length < MAX_EXPANDED_TAGS) out.push(v);
  };
  /** 已知分组：固定顺序 + 组内字典序*/
  const KNOWN = ['rating', 'general', 'character'];
  for (const group of KNOWN) {
    const bucket = tags[group];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const k of Object.keys(bucket).sort()) push(k);
  }
  /** 未归类的自定义键：同样字典序（保持确定性）*/
  for (const group of Object.keys(tags).sort()) {
    if (KNOWN.includes(group)) continue;
    const v = tags[group];
    if (typeof v === 'string') push(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v).sort()) push(k);
    }
  }
  return out;
}

/**
 * 执行一个插件贡献节点（contribute 角色，collect 调用）。
 * 透传上游判定，并把标签写入工作上下文。
 * T08a 修复（用户报「图像审核不调用 wd1.4 同步审核」）：
 * ① **原始贡献上报终裁层**：此前贡献只写进 `work`，终裁层拿不到 ⇒ WD14 联动以为
 * 「标签服务不可用」，`wd14_status` 永远是 `down`。
 * ② **status / skip_reason 反映真实结果**：此前 `status` 取决于**上游判定是否存在**
 * （contribute 挂在 input 后面时上游恒无判定 ⇒ 永远 skipped/not-configured），
 * 与本次调用成功与否无关。现在以「是否取到可用贡献」为准。
 * @param {object} runtime 运行时
 * @param {object} descriptor 注册表描述符
 * @returns {Promise<object>} NodeResult
 */
async function runPluginContribute(runtime, descriptor) {
  const started = Date.now();
  const capability = descriptor.capability || 'image.tag';
  const imageBase64 = (runtime.ctx.payload && runtime.ctx.payload.imageBase64) || '';
  let contributions = [];
  let invokeThrew = false;
  try {
    contributions = await broker.invokeCollect(capability, imageBase64);
  } catch {
    contributions = [];
    invokeThrew = true;
  }
  const list = Array.isArray(contributions) ? contributions : [];
  if (runtime.ctx && typeof runtime.ctx.addPluginContributions === 'function') {
    runtime.ctx.addPluginContributions(list);
  }

  const merged = { tags: [], labels: [] };
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    // 数组型 tags：原路径不变； T08d：对象型 tags（WD14）展开为标签名，确定性
    if (Array.isArray(c.tags)) merged.tags.push(...c.tags);
    else merged.tags.push(...expandObjectTags(c.tags));
    if (Array.isArray(c.labels)) merged.labels.push(...c.labels);
  }
  const added = runtime.ctx.mergeWork(merged);

  // ── 用「贡献的真实结果」决定 status / skip_reason ──
  // 关键区分：**「服务调用成功但无命中」≠「服务不可用」**。
  // WD14 对干净图片会返回 level=null（无命中），此前被当成「不可用」⇒ 状态与文案全错。
  const delivered = list.find((c) => c && !c.disabled && !c.error);
  const errored = list.find((c) => c && c.error);
  const disabled = list.find((c) => c && c.disabled);

  const upstream = runtime.upstream;
  const verdict = upstream && upstream.verdict ? { ...upstream.verdict } : null;

  let status;
  let skipReason = null;
  let message;
  if (delivered) {
    const risk = delivered.risk || {};
    const hits = Array.isArray(risk.hits) ? risk.hits.length : 0;
    const tagCount = (delivered.tags && typeof delivered.tags === 'object')
      ? Object.keys(delivered.tags.general || {}).length : 0;
    status = 'ok';
    message = `WD14 判定 ${risk.level || '无命中'}（score=${Math.round(Number(risk.score) || 0)}，命中 ${hits} 项，标签 ${tagCount} 个）`
      + (added > 0 ? `；写入 ${added} 个标签` : '');
  } else if (errored) {
    status = 'skipped';
    skipReason = reasonFromContributionError(errored.error);
    message = `WD14 标签服务不可用（${skipReason}）：${errored.error}`;
  } else if (disabled) {
    status = 'skipped';
    skipReason = String(disabled.error || '') === 'circuit_open' ? 'circuit-open' : 'disabled';
    message = skipReason === 'circuit-open' ? 'WD14 联动熔断已打开，暂缓调用' : 'WD14 标签预筛已在插件配置中关闭';
  } else {
    status = 'skipped';
    skipReason = invokeThrew ? 'service-error' : 'not-configured';
    message = invokeThrew
      ? 'WD14 贡献收集异常（插件调用抛错）'
      : '未取得标签服务配置，或插件未提供标签能力（请检查插件是否启用与服务地址）';
  }

  return {
    nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
    status,
    elapsedMs: Date.now() - started,
    failureType: null,
    skipReason,
    verdict,
    costHint: descriptor.costHint || 'free',
    message,
    tags: merged.tags,
    plugin_contributions: list.length,
  };
}

/**
 * 执行一个节点（执行器唯一入口）。
 * @param {object} runtime 运行时
 * @returns {Promise<object>} NodeResult
 */
async function invokeNode(runtime) {
  const node = runtime.node;
  if (!node) throw new Error('invokeNode 缺少 node');
  const descriptor = registry.get(node.ref);

  if (node.type === 'contribute') {
    // 内置贡献节点（如单测桩）直接执行 run；插件贡献节点走 collect 调用
    if (descriptor && typeof descriptor._run === 'function') {
      return descriptor._run({ ...runtime, nodeId: node.id });
    }
    if (!descriptor) {
      return {
        nodeId: node.id, ref: node.ref, title: node.ref, status: 'skipped',
        elapsedMs: 0, failureType: null, skipReason: 'missing-deps', verdict: runtime.upstream ? runtime.upstream.verdict : null,
        costHint: 'free', message: '节点服务未注册（依赖缺失或插件已卸载）',
      };
    }
    return runPluginContribute(runtime, descriptor);
  }

  // service 节点：内置或插件
  if (descriptor && descriptor.kind === 'plugin') {
    return runPluginJudge(runtime, descriptor);
  }
  const runner = (descriptor && typeof descriptor._run === 'function')
    ? descriptor._run
    : builtinRunner(node.ref);
  if (!runner) {
    const notReady = descriptor ? descriptor.ready !== true : true;
    return {
      nodeId: node.id, ref: node.ref, title: node.ref,
      status: notReady ? 'skipped' : 'failed',
      elapsedMs: 0,
      failureType: notReady ? null : 'unknown',
      skipReason: notReady ? 'not-registered' : null,
      verdict: null, costHint: 'free',
      message: descriptor ? '节点服务未就绪' : '节点 ref 未在注册表',
    };
  }
  return runner({ ...runtime, nodeId: node.id });
}

module.exports = {
  BUILTINS,
  registerBuiltins,
  builtinRunner,
  invokeNode,
  runPluginJudge,
  runPluginContribute,
  expandObjectTags,
  MAX_EXPANDED_TAGS,
};
