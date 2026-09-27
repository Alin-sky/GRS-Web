/**
 * 内核事件注册表（src/host-api/event-registry.js）
 * 事件名与 payload 形状属于契约，不允许插件层或核心层硬编码字面量。
 * 核心发事件、插件订事件，双方都从这里取名字。
 * 设计依据：docs/architecture-2026-09-14.md §3.4；GRS v2.2.0 架构 §8.3
 * | 事件 | 模式 | payload | 返回值 schema |
 * |-----------------------------|---------|--------------------------------------|------------------------------|
 * | moderation:image:tag | collect | (imageBase64) | ModerationTagContribution |
 * | moderation:image:linkage | first | (result: Verdict, contributions[]) | ModerationVerdict |
 * | moderation:verdict:text | call | (request) | ModerationVerdict |
 * | moderation:verdict:image | call | (request) | ModerationVerdict |
 * 关于「事件名按 ref 派生」的偏离说明：事件表必须**静态**才能被
 * scripts/lint-plugin-boundary.js 静态校验，而 `ref` 是插件自定义的动态值。
 * 故采用「静态事件（按模态）+ 载荷携带 ref」：插件在同一事件处理器内按 request.ref 分发。
 */
const { CAPABILITIES, OUTPUT_SCHEMAS } = require('./contract');

/** 收集模式：并行执行全部处理器，收集非空返回值*/
const MODE_COLLECT = 'collect';
/** 短路模式：按 order 顺序执行，首个非空返回值即为结果*/
const MODE_FIRST = 'first';
/** 点对点调用模式：只调用 owner 指定的处理器（按 owner 定位唯一提供者）*/
const MODE_CALL = 'call';

/** 事件名常量（唯一来源）*/
const EVENTS = Object.freeze({
  /** 图片标签收集（wd14 → 标签贡献）*/
  IMAGE_TAG: 'moderation:image:tag',
  /** 图片审核联动判定（首个非空返回即最终判定）*/
  IMAGE_LINKAGE: 'moderation:image:linkage',
  /** 文本判定（点对点调用）*/
  VERDICT_TEXT: 'moderation:verdict:text',
  /** 图像判定（点对点调用）*/
  VERDICT_IMAGE: 'moderation:verdict:image',
  /** v2.4.0：审核前请求拦截（短路模式，首个非空返回即可信缓存结果，跳过整条 AI 管线）*/
  REQUEST_INTERCEPT: 'moderation:request:intercept',
  /** v2.4.0：最终判定观察（收集模式，插件做写缓存等副作用，返回值被忽略）*/
  VERDICT_OBSERVE: 'moderation:verdict:observe',
});

/**
 * 事件定义表：event → { mode, payload, outputSchema, capability, maxOutputBytes? }
 * payload 为参数名列表（仅作文档与校验提示，不做运行时强校验以免影响既有插件）。
 */
const REGISTRY = Object.freeze({
  [EVENTS.IMAGE_TAG]: {
    mode: MODE_COLLECT,
    payload: ['imageBase64'],
    outputSchema: OUTPUT_SCHEMAS.MODERATION_TAG_CONTRIBUTION,
    capability: CAPABILITIES.IMAGE_TAG,
  },
  [EVENTS.IMAGE_LINKAGE]: {
    mode: MODE_FIRST,
    payload: ['result', 'contributions'],
    outputSchema: OUTPUT_SCHEMAS.MODERATION_VERDICT,
    capability: CAPABILITIES.IMAGE_LINKAGE,
  },
  [EVENTS.VERDICT_TEXT]: {
    mode: MODE_CALL,
    payload: ['request'],
    outputSchema: OUTPUT_SCHEMAS.MODERATION_VERDICT,
    capability: CAPABILITIES.TEXT_VERDICT,
  },
  [EVENTS.VERDICT_IMAGE]: {
    mode: MODE_CALL,
    payload: ['request'],
    outputSchema: OUTPUT_SCHEMAS.MODERATION_VERDICT,
    capability: CAPABILITIES.IMAGE_VERDICT,
  },
  // v2.4.0：请求生命周期钩子（非拓扑节点）。outputSchema 仅用于声明一致性；
  // 实际派发走 capability-broker.invokeIntercept / notifyObserve，**不过 verdict gate**
  // （intercept 回放的是此前已被信任管线校验过的完整结果，含 gate 会丢弃的请求级字段）。
  [EVENTS.REQUEST_INTERCEPT]: {
    mode: MODE_FIRST,
    payload: ['descriptor'],
    outputSchema: OUTPUT_SCHEMAS.MODERATION_VERDICT,
    capability: CAPABILITIES.REQUEST_INTERCEPT,
  },
  [EVENTS.VERDICT_OBSERVE]: {
    mode: MODE_COLLECT,
    payload: ['descriptor', 'result'],
    outputSchema: OUTPUT_SCHEMAS.MODERATION_VERDICT,
    capability: CAPABILITIES.VERDICT_OBSERVE,
  },
});

/** 事件名集合*/
const EVENT_NAMES = Object.freeze(Object.keys(REGISTRY));

/**
 * 取事件定义。
 * @param {string} event 事件名
 * @returns {object|null} 事件定义或 null
 */
function getEvent(event) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, event) ? REGISTRY[event] : null;
}

/**
 * 事件是否已在注册表声明。
 * @param {string} event 事件名
 * @returns {boolean}
 */
function isKnownEvent(event) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, event);
}

/**
 * 取事件声明的模式（未知事件返回 null）。
 * @param {string} event 事件名
 * @returns {'collect'|'first'|'call'|null}
 */
function modeOf(event) {
  const def = getEvent(event);
  return def ? def.mode : null;
}

/**
 * 校验某事件的返回值所用输出 schema 名。
 * @param {string} event 事件名
 * @returns {string|null}
 */
function outputSchemaOf(event) {
  const def = getEvent(event);
  return def ? def.outputSchema : null;
}

/**
 * 由能力 id 反查其绑定的事件名。
 * @param {string} capabilityId 能力 id
 * @returns {string|null}
 */
function eventOfCapability(capabilityId) {
  for (const [event, def] of Object.entries(REGISTRY)) {
    if (def.capability === capabilityId) return event;
  }
  return null;
}

/**
 * 校验插件声明的能力项是否与注册表一致（能力 id / 事件名 / 模式 / 输出 schema）。
 * @param {object} capability manifest.contributes.capabilities[i]
 * @returns {{ok: boolean, errors: string[], event?: string}}
 */
function validateCapability(capability) {
  const errors = [];
  if (!capability || typeof capability !== 'object') {
    return { ok: false, errors: ['能力声明必须是对象'] };
  }
  const expectedEvent = eventOfCapability(capability.id);
  if (!expectedEvent) {
    return { ok: false, errors: [`未知能力 id：${capability.id}`] };
  }
  const def = getEvent(expectedEvent);
  if (capability.event !== undefined && capability.event !== expectedEvent) {
    errors.push(`能力 ${capability.id} 的事件名应为 ${expectedEvent}，实际为 ${capability.event}`);
  }
  if (capability.mode !== undefined && capability.mode !== def.mode) {
    errors.push(`能力 ${capability.id} 的模式应为 ${def.mode}，实际为 ${capability.mode}`);
  }
  if (capability.outputSchema !== undefined && capability.outputSchema !== def.outputSchema) {
    errors.push(`能力 ${capability.id} 的输出 schema 应为 ${def.outputSchema}，实际为 ${capability.outputSchema}`);
  }
  return { ok: errors.length === 0, errors, event: expectedEvent };
}

module.exports = {
  MODE_COLLECT,
  MODE_FIRST,
  MODE_CALL,
  EVENTS,
  REGISTRY,
  EVENT_NAMES,
  getEvent,
  isKnownEvent,
  modeOf,
  outputSchemaOf,
  eventOfCapability,
  validateCapability,
};
