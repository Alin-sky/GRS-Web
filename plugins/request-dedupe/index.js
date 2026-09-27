/**
 * 重复审核去重插件（plugins/request-dedupe/index.js）
 *
 * 定位：**请求生命周期钩子**型插件（非拓扑节点，flowRole=task）。
 *   完全相同（字节级）的文本/图片输入在 TTL 窗口内重复审核时：
 *     · 审核前（moderation:request:intercept）命中缓存 ⇒ 返回首次结果副本，核心据此**跳过整条 AI 管线**；
 *     · 判定后（moderation:verdict:observe）把最终结果写入缓存（带 TTL）。
 *   命中的记录会带 `dedup` 标识，前端审核记录显示「♻️ 重复审核」徽章。
 *
 * ★ 去重键 = sha256(模态 ‖ 文本字节 ‖ 各图片字节 ‖ 关键配置{model,strictness,exposureMode})。
 *   **字节级**：输入或关键配置改一个字节即换键，绝不误复用（见 lib/dedupe.js）。
 *
 * ★ 边界（F07 / 架构 §8）：不 require 任何核心模块、不 require cordis；
 *   持久化只用注入的宿主 `kvStore` 服务（命名空间隔离 + TTL，底层是 audit-db 的 plugin_kv 表）。
 *
 * ★ 失败语义：kvStore 不可用 / 配置关闭 / 任何异常 ⇒ 一律 fail-open（不去重、走完整审核），
 *   去重永不阻断审核。
 *
 * ★ 依赖：纯 JS，仅用 node:crypto（在 lib/dedupe.js 内）。
 */

'use strict';

const { createDedupe } = require('./lib/dedupe');

/** 插件 id（与 manifest.id 一致，也用作 kvStore 命名空间）*/
const PLUGIN_ID = 'request-dedupe';

/** 默认去重窗口（秒）*/
const DEFAULT_TTL_SECONDS = 600;

/** 插件配置表单（结构受 scripts/lint-plugin-config-schema.js 静态校验）*/
const CONFIG_SCHEMA = {
  name: PLUGIN_ID,
  title: '重复审核去重',
  version: '1.0.0',
  description: '完全相同（字节级）的文本/图片输入在时间窗口内重复审核时，直接复用首次判定、跳过 AI 调用，并在审核记录中标记为「重复审核」。',
  groups: [
    { id: 'basic', title: '基础', desc: '开关与去重时间窗口。' },
  ],
  fields: [
    {
      key: 'enabled', type: 'switch', label: '启用去重', default: true, group: 'basic',
      desc: '关闭后所有请求都走完整审核（不去重）。',
    },
    {
      key: 'ttlSeconds', type: 'number', label: '去重时间窗口（秒）', min: 0, max: 604800, default: DEFAULT_TTL_SECONDS, group: 'basic',
      desc: '首次判定在该窗口内被「完全相同的输入」复用；0 = 永不过期（不推荐）。改模型/严格度/暴露档位会自动使旧缓存失效（已入去重键）。',
    },
  ],
};

/**
 * 插件入口（cordis apply）。
 * @param {object} ctx cordis 上下文
 * @returns {void}
 */
function requestDedupe(ctx) {
  const logger = (ctx && ctx.logger) || console;
  const kvStore = typeof ctx.inject === 'function' ? ctx.inject('kvStore', false) : null;

  /** 读取本插件当前配置（每次调用取最新，支持运行期改配置即时生效）。*/
  function currentConfig() {
    try {
      return (typeof ctx.config === 'function' ? ctx.config(CONFIG_SCHEMA) : {}) || {};
    } catch {
      return {};
    }
  }

  /** 按当前配置构建去重器（轻量对象，逐请求构建以吸收配置变更）。*/
  function dedupe() {
    const cfg = currentConfig();
    const ttl = Number(cfg.ttlSeconds);
    return createDedupe({
      kvStore,
      namespace: PLUGIN_ID,
      ttlSeconds: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_TTL_SECONDS,
      enabled: cfg.enabled !== false && Boolean(kvStore),
    });
  }

  if (!kvStore) {
    logger.warn(`[${PLUGIN_ID}] 宿主未提供 kvStore（node:sqlite 不可用？）——去重自动禁用，审核不受影响`);
  }

  // ① 审核前拦截：命中 ⇒ 返回首次结果副本（含 dedup 标识），核心据此跳过 AI 管线
  ctx.on('moderation:request:intercept', (descriptor) => {
    try {
      return dedupe().lookup(descriptor);
    } catch {
      return null; // fail-open
    }
  });

  // ② 判定后观察：把最终结果写入去重缓存（带 TTL）
  // 低频顺带清理过期条目（每 256 次写一次）：过期项平时只在 get 时惰性删除，
  // 高频场景下从未被再次请求的过期行会累积，这里周期性回收，防止 plugin_kv 无界增长。
  let _storeCount = 0;
  ctx.on('moderation:verdict:observe', (descriptor, result) => {
    try {
      dedupe().store(descriptor, result);
      if ((++_storeCount & 0xFF) === 0 && kvStore && typeof kvStore.purgeExpired === 'function') {
        kvStore.purgeExpired();
      }
    } catch {
      /* fail-open：写缓存失败绝不影响审核 */
    }
  });

  /** 就绪度 / 状态自报（供宿主置灰与 RPC 查询）。*/
  function status() {
    const cfg = currentConfig();
    let entries = 0;
    try { entries = (kvStore && typeof kvStore.count === 'function') ? (kvStore.count(PLUGIN_ID) || 0) : 0; } catch { entries = 0; }
    const enabled = cfg.enabled !== false && Boolean(kvStore);
    return {
      ready: enabled,
      enabled,
      kvAvailable: Boolean(kvStore),
      ttlSeconds: Number(cfg.ttlSeconds) >= 0 ? Number(cfg.ttlSeconds) : DEFAULT_TTL_SECONDS,
      entries,
    };
  }

  // ③ 服务 + RPC
  ctx.provide('requestDedupe', {
    name: PLUGIN_ID,
    status,
    schema: CONFIG_SCHEMA,
    clear() { try { return kvStore ? (kvStore.clear(PLUGIN_ID) || 0) : 0; } catch { return 0; } },
  });
  ctx.rpc('requestDedupe.status', () => status());
  ctx.rpc('requestDedupe.clear', () => {
    let n = 0;
    try { n = kvStore ? (kvStore.clear(PLUGIN_ID) || 0) : 0; } catch { n = 0; }
    logger.info(`[${PLUGIN_ID}] 已清空去重缓存（${n} 条）`);
    return { cleared: n };
  });

  const st = status();
  logger.info(`[${PLUGIN_ID}] 已挂载请求去重闸门（启用=${st.enabled}，TTL=${st.ttlSeconds}s，kvStore=${st.kvAvailable ? '可用' : '不可用'}）`);
}

Object.defineProperty(requestDedupe, 'name', { value: PLUGIN_ID, configurable: true });
requestDedupe.description = '重复审核去重（字节级输入 + TTL 窗口，命中跳过 AI 并标记重复）';
requestDedupe.version = '1.0.0';

module.exports = requestDedupe;
module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;
module.exports.CONFIG_SCHEMA = CONFIG_SCHEMA;
