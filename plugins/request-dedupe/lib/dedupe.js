/**
 * request-dedupe 去重核心逻辑（plugins/request-dedupe/lib/dedupe.js）
 *
 * 纯逻辑、零核心依赖（只用 node:crypto）：去重键计算 + lookup/store 策略。
 * 与 cordis  wiring 解耦，便于单测（scripts/test-request-dedupe.js 的 Y/P 段）。
 *
 * 设计契约：
 * - 去重键 = sha256(模态 ‖ len(text):text ‖ 图片数 ‖ 每张 len(b64):b64 ‖ 规范化配置)。
 *   长度前缀防拼接歧义；**字节级**：输入或关键配置改一个字节即换键，绝不误复用。
 * - 命中返回「首次结果的副本 + dedup 标识」，绝不修改原对象。
 * - 任何异常一律 fail-open（lookup→null，store→false），去重永不阻断审核。
 */

'use strict';

const crypto = require('crypto');

/**
 * 计算字节级去重键。
 * @param {{modality?:string, text?:string, images?:string[], cfg?:{model?:string,strictness?:string,exposureMode?:string}}} descriptor
 * @returns {string} 64 位小写 hex（sha256）
 */
function buildDedupeKey(descriptor) {
  const d = descriptor && typeof descriptor === 'object' ? descriptor : {};
  const modality = String(d.modality || 'text');
  const text = typeof d.text === 'string' ? d.text : '';
  const images = Array.isArray(d.images) ? d.images : [];
  const cfg = d.cfg && typeof d.cfg === 'object' ? d.cfg : {};
  // 关键配置按**固定键序**规范化，避免对象键序差异导致同配置不同键
  const cfgCanon = JSON.stringify({
    model: String(cfg.model || ''),
    strictness: String(cfg.strictness || ''),
    exposureMode: String(cfg.exposureMode || ''),
  });

  const h = crypto.createHash('sha256');
  const put = (s) => { const str = String(s); h.update(str, 'utf8'); };
  put(modality); put('\x00');
  put(Buffer.byteLength(text, 'utf8')); put(':'); put(text); put('\x00');
  put(images.length); put('\x00');
  for (const img of images) {
    const s = typeof img === 'string' ? img : '';
    put(Buffer.byteLength(s, 'utf8')); put(':'); put(s); put('\x00');
  }
  put(cfgCanon);
  return h.digest('hex');
}

/**
 * 构建去重器（依赖注入 kvStore，便于单测与替换存储）。
 * @param {{kvStore:{get:Function,set:Function}, namespace?:string, ttlSeconds?:number, enabled?:boolean}} opts
 * @returns {{lookup:Function, store:Function, buildKey:Function, namespace:string, ttlSeconds:number, enabled:boolean}}
 */
function createDedupe(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const kvStore = o.kvStore || null;
  const namespace = String(o.namespace || 'request-dedupe');
  const ttlSeconds = Number(o.ttlSeconds) > 0 ? Number(o.ttlSeconds) : 0;
  const enabled = o.enabled !== false;

  /**
   * 查缓存：命中且未过期 → 返回首次结果副本 + dedup 标识；否则 null。
   * TTL 过期由 kvStore 负责（过期条目 get 返回 null）。
   * @param {object} descriptor 请求描述符
   * @returns {object|null}
   */
  function lookup(descriptor) {
    if (!enabled || !kvStore) return null;
    try {
      const key = buildDedupeKey(descriptor);
      const row = kvStore.get(namespace, key);
      if (!row || !row.valueJson) return null;
      const parsed = JSON.parse(row.valueJson);
      const result = parsed && parsed.result;
      if (!result || typeof result !== 'object') return null;
      const recordId = String(parsed.recordId || result.id || '');
      const createdAt = Number(parsed.createdAt) || Number(row.createdAt) || Date.now();
      const ageMs = Math.max(0, Date.now() - createdAt);
      return Object.assign({}, result, { dedup: { hit: true, of: recordId, ageMs, key } });
    } catch {
      return null; // fail-open
    }
  }

  /**
   * 写缓存：把本次最终结果按去重键存下（带 TTL）。
   * @param {object} descriptor 请求描述符
   * @param {object} result 最终审核结果
   * @returns {boolean} 是否写入成功
   */
  function store(descriptor, result) {
    if (!enabled || !kvStore) return false;
    if (!result || typeof result !== 'object') return false;
    try {
      const key = buildDedupeKey(descriptor);
      const payload = JSON.stringify({ result, recordId: String(result.id || ''), createdAt: Date.now() });
      return kvStore.set(namespace, key, payload, { ttlSeconds }) === true;
    } catch {
      return false; // fail-open
    }
  }

  return { lookup, store, buildKey: buildDedupeKey, namespace, ttlSeconds, enabled };
}

module.exports = { buildDedupeKey, createDedupe };
