/**
 * NSFW 模式流水线（plugins/batch-image-suite/lib/nsfw.js）
 *
 * WD14 标签器（HTTP，可并发）+ 视觉模型（串行）同时运行，按 wd14-tagger 插件的
 * linkage 配置决定最终等级（R-B31 ~ R-B36）。
 *
 * 降级：
 * - WD14 不可用 → 按 linkage.onWd14Down（skip / fail_closed / fallback_vl）
 * - VL 不可用且 batchSkipVl=true → 只跑 WD14，结果明确标注
 * - 任一环节异常 → 计入 failed，任务继续（不阻断）
 */

/**
 * 简单并发控制器。
 * @param {number} limit 并发上限
 * @returns {(fn: Function) => Promise<any>}
 */
function semaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

/**
 * 读取图片并按配置预缩放，返回 base64。
 * @param {string} filePath 图片路径
 * @param {object} sharp sharp 模块
 * @param {number} [resizePx=0] 预缩放边长（0=不缩放）
 * @returns {Promise<string|null>} base64
 */
async function toBase64(filePath, sharp, resizePx = 0) {
  const fs = require('fs');
  try {
    let buf = fs.readFileSync(filePath);
    if (sharp && resizePx > 0) {
      buf = await sharp(buf).resize(resizePx, resizePx, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    }
    return buf.toString('base64');
  } catch {
    return null;
  }
}

/**
 * 对一个条目执行 NSFW 判定。
 * @param {object} item 条目
 * @param {object} ctx BridgeContext
 * @param {{config: object, wd14Cfg: object, sem?: Function}} opts 选项
 * @returns {Promise<object>} 更新后的条目
 */
async function analyzeItem(item, ctx, opts) {
  const { config = {}, wd14Cfg = {} } = opts;
  const wd14 = ctx.inject('wd14', false);
  const moderator = ctx.inject('moderator', false);
  const sharp = ctx.inject('sharp', false);

  const result = { level: 'safe', score: 0, tags: null, hits: [], wd14: null, vl: null, decisionSource: '', degraded: false };

  // ① WD14（可并发）
  let wd14Out = null;
  if (wd14 && config.useWd14 !== false) {
    const b64 = await toBase64(item.srcPath, sharp, 0);
    if (b64) {
      try {
        const raw = await wd14.tag(b64);
        if (raw && raw.available) {
          const mapped = wd14.mapToRisk(raw);
          wd14Out = {
            available: true,
            tags: { rating: raw.rating, general: raw.general, character: raw.character },
            level: mapped.suggestedLevel || 'safe',
            score: mapped.suggestedScore || 0,
            hits: mapped.hits || [],
          };
        } else {
          wd14Out = { available: false, error: (raw && raw.error) || '标签服务不可用' };
        }
      } catch (err) {
        wd14Out = { available: false, error: err.message };
      }
    }
  }
  result.wd14 = wd14Out;
  result.tags = wd14Out && wd14Out.tags ? wd14Out.tags : null;
  result.hits = (wd14Out && wd14Out.hits) || [];

  // ② 视觉模型（串行）；batchSkipVl 时跳过
  const skipVl = wd14Cfg.batchSkipVl === true || config.batchSkipVl === true;
  let vlOut = null;
  if (!skipVl && moderator && typeof moderator.moderateImageLocal === 'function') {
    const resizePx = Number(wd14Cfg.batchResizePx) || 0;
    const b64 = await toBase64(item.srcPath, sharp, resizePx);
    if (b64) {
      try {
        const r = await moderator.moderateImageLocal(b64, '', { fileName: item.srcName }, { skipAudit: true });
        vlOut = {
          level: r.risk_level,
          score: (r.category_scores && r.category_scores.pornographic) || 0,
          reason: r.reason,
          confidence: r.confidence,
          error: r.error || null,
        };
      } catch (err) {
        vlOut = { level: null, score: 0, reason: '', error: err.message };
      }
    }
  }
  result.vl = vlOut;

  // ③ 融合
  const wd14Level = wd14Out && wd14Out.available ? wd14Out.level : null;
  const vlLevel = vlOut && vlOut.level ? vlOut.level : null;
  const order = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

  if (!wd14Level && !vlLevel) {
    // 两条通道都不可用
    result.level = 'safe';
    result.degraded = true;
    result.decisionSource = wd14Cfg.batchSkipVl ? '双通道均不可用（已批量跳过视觉模型）' : '双通道均不可用（已跳过）';
    item.nsfw = result;
    item.error = (wd14Out && wd14Out.error) || (vlOut && vlOut.error) || '双通道不可用';
    return item;
  }
  if (skipVl && wd14Level) {
    result.level = wd14Level;
    result.score = wd14Out.score || 0;
    result.decisionSource = '仅标签器判定（已按配置跳过视觉模型）';
    item.nsfw = result;
    return item;
  }
  if (wd14Level && !vlLevel) {
    result.level = wd14Level;
    result.score = wd14Out.score || 0;
    result.degraded = true;
    result.decisionSource = '仅标签器判定（视觉模型不可用，已降级）';
    item.nsfw = result;
    return item;
  }
  if (vlLevel && !wd14Level) {
    result.level = vlLevel;
    result.score = vlOut.score || 0;
    result.decisionSource = '视觉模型判定（标签器未贡献，按 onWd14Down=skip 处理）';
    item.nsfw = result;
    return item;
  }

  // 两者都有：按 max 定级（与 wd14-tagger 的 linkage.conflict='max' 默认一致）
  const finalLevel = (order[wd14Level] || 0) >= (order[vlLevel] || 0) ? wd14Level : vlLevel;
  result.level = finalLevel;
  result.score = Math.max(wd14Out.score || 0, vlOut.score || 0);
  result.decisionSource = `标签器=${wd14Level}，视觉模型=${vlLevel}，最终=${finalLevel}（取较高者）`;
  if (wd14Level !== vlLevel) result.conflict = true;
  item.nsfw = result;
  return item;
}

module.exports = { analyzeItem, semaphore, toBase64 };
