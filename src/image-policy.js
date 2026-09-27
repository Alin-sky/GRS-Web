/**
 * 图像审核策略（src/image-policy.js）
 * v0.2.0 增量功能（用户诉求：图像审核「开销大 / 泳装误判 / 想关 WD14 联动」）：
 * A. 发送前缩图 —— `moderation.imagePolicy.maxImagePx`（默认 768；0 = 不缩图）
 * B. 判定缓存 —— `moderation.imagePolicy.cacheVerdicts`（默认 true；实现在 audit-db）
 * C. 暴露/泳装档位 —— `moderation.imagePolicy.exposure.mode`（off/lenient/standard/strict）
 * D. WD14 联动开关 —— `moderation.imagePolicy.useWd14Linkage`（默认 true）
 * 设计约束：
 * ① **绝不失败**：sharp 缺失 / 图片无法解析 / 缩放异常 ⇒ 一律降级为「发送原图」，只标注原因。
 * 与 `imageCapture` 的降级原则一致（图片链路永不阻断审核）。
 * ② **绝不落盘**：缩图只作用于「发给模型」的那份内存字节；`data/image_blobs/` 保留原图
 * （取证 / 可复现要求）。
 * ③ 单一实现点：`moderateImageCloud()` 内部调用本模块 ⇒ 新引擎（builtin.cloudModel 视觉分支）
 * 与旧引擎（moderator.legacyModerateImage）**自动一致**，不存在两份漂移的实现。
 * ④ 缩略图逻辑复用 `image-ref` 的零依赖尺寸解析 + `sharp` 惰性加载模式。
 */

'use strict';

const crypto = require('crypto');
const { loadConfig } = require('./config');
const { logWarn } = require('./logger');
const imageRef = require('./image-ref');
const { EXPOSURE_SCENES, normalizeExposureScore, normalizeExposureScene } = require('./security/output-schema');

/** 暴露/泳装档位全集（C）。*/
const EXPOSURE_MODES = Object.freeze(['off', 'lenient', 'standard', 'strict']);

/** 缩图档位全集（A）。0 = 不缩图（发送原图）。*/
const ALLOWED_IMAGE_PX = Object.freeze([0, 384, 512, 768, 1024]);

/**
 * 肤色暴露度评分配置的代码默认值（与 `config-defaults.js` 同值）。
 * 用户实例缺字段时由本处兜底 ⇒ 不需要、也不允许改动用户的 `config/default.json`。
 */
const DEFAULT_EXPOSURE_SCORING = Object.freeze({
  enabled: false,
  blockScore: 90,
  pornographicMin: 50,
  exemptScenes: Object.freeze(['swimwear', 'sportswear', 'beach', 'pool']),
});

/** 肤色暴露度判定结果全集（R8 判定矩阵的四行）。*/
const EXPOSURE_VERDICTS = Object.freeze(['compliant', 'excessive', 'pornographic', 'normal']);

/** 取 [min,max] 内的整数；非法值回落到 fallback。*/
function intInRange(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  return rounded < min || rounded > max ? fallback : rounded;
}

/** sharp 缺失只告警一次，避免每张图刷屏。*/
let _sharpMissingWarned = false;

/**
 * 读取并规范化图像审核策略配置（字段缺失/非法时按默认值兜底，绝不抛异常）。
 * @param {object} [config] 配置对象（缺省时 loadConfig()）
 * @returns {{maxImagePx: number, cacheVerdicts: boolean, exposureMode: string, useWd14Linkage: boolean, exposureScoring: {enabled: boolean, blockScore: number, pornographicMin: number, exemptScenes: string[]}}}
 */
function getImagePolicyCfg(config) {
  let cfg = config;
  if (!cfg) {
    try { cfg = loadConfig(); } catch { cfg = null; }
  }
  const raw = (cfg && cfg.moderation && cfg.moderation.imagePolicy) || {};
  const rawMode = raw.exposure && typeof raw.exposure === 'object' ? raw.exposure.mode : undefined;
  const rawScoring = raw.exposureScoring && typeof raw.exposureScoring === 'object' ? raw.exposureScoring : {};
  let maxPx = Number(raw.maxImagePx);
  if (!Number.isFinite(maxPx)) maxPx = 768;
  maxPx = Math.max(0, Math.min(4096, Math.round(maxPx)));
  return {
    maxImagePx: maxPx,
    cacheVerdicts: raw.cacheVerdicts !== false,
    exposureMode: EXPOSURE_MODES.includes(rawMode) ? rawMode : 'standard',
    useWd14Linkage: raw.useWd14Linkage !== false,
    // R8：肤色暴露度评分（默认关闭）。与 exposureMode **叠加**（不替换）：
    // exposureMode 管提示词策略段；exposureScoring 管是否额外要求并记录分数。
    exposureScoring: {
      enabled: rawScoring.enabled === true,
      blockScore: intInRange(rawScoring.blockScore, DEFAULT_EXPOSURE_SCORING.blockScore, 0, 100),
      pornographicMin: intInRange(rawScoring.pornographicMin, DEFAULT_EXPOSURE_SCORING.pornographicMin, 0, 100),
      exemptScenes: Array.isArray(rawScoring.exemptScenes)
        ? rawScoring.exemptScenes.map(String).filter((s) => EXPOSURE_SCENES.includes(s))
        : DEFAULT_EXPOSURE_SCORING.exemptScenes.slice(),
    },
  };
}

/**
 * 计算图片内容寻址 hash（与 `image-ref.buildRef` **同一算法**：sha256 前 16 位），
 * 这样缓存键可以直接使用审核记录里已有的 `image_ref.hash`，两处永不漂移。
 * @param {Buffer} buffer 图片字节
 * @returns {string} 16 位 hex
 */
function imageHash(buffer) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0)).digest('hex').slice(0, 16);
}

/**
 * 剥离 base64 可能携带的 data URL 前缀（调用方通常传纯 base64，这里只做防御）。
 * @param {string} base64 base64（或 data URL）
 * @returns {string} 纯 base64
 */
function stripDataUrlPrefix(base64) {
  const s = String(base64 || '');
  const idx = s.indexOf('base64,');
  return idx >= 0 ? s.slice(idx + 'base64,'.length) : s;
}

/**
 * 【A】发送前缩图：把图片缩到「长边 ≤ maxImagePx」。
 * 任何失败都降级为「发送原图」并标注 reason，绝不抛异常、绝不阻断审核：
 * sharp 未安装（本机现状）→ `reason='sharp-unavailable'`
 * 尺寸解析失败 → `reason='unreadable-dimensions'`
 * 已小于目标 → `reason='already-within'`
 * 显式关闭（maxImagePx=0） → `reason='disabled'`
 * sharp 抛异常 → `reason='sharp-failed'`
 * @param {Buffer} buffer 原图字节
 * @param {number} maxPx 长边上限（0 = 不缩）
 * @returns {Promise<{buffer: Buffer, applied: boolean, reason: string, fromPx: number, toPx: number, fromBytes: number, toBytes: number}>}
 */
async function resizeForModel(buffer, maxPx) {
  const out = {
    buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0),
    applied: false,
    reason: '',
    fromPx: 0,
    toPx: 0,
    fromBytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
    toBytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
  };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) { out.reason = 'empty-buffer'; return out; }
  if (!Number.isFinite(maxPx) || maxPx <= 0) { out.reason = 'disabled'; return out; }

  const format = imageRef.detectFormat(buffer);
  const dims = imageRef.readDimensions(buffer, format);
  if (!dims || !dims.width || !dims.height) { out.reason = 'unreadable-dimensions'; return out; }
  const long = Math.max(dims.width, dims.height);
  out.fromPx = long;
  if (long <= maxPx) { out.reason = 'already-within'; return out; }

  let sharp;
  try {
    // 惰性 require：sharp 是 optional 依赖（本机当前未安装），缺失必须降级而不是崩
    sharp = require('sharp');
  } catch (err) {
    out.reason = 'sharp-unavailable';
    if (!_sharpMissingWarned) {
      _sharpMissingWarned = true;
      logWarn('image-policy', `sharp 未安装，发送前缩图已降级为「发送原图」`
        + `（建议在项目根目录执行 npm install 以启用缩图省钱，预计可省 90%+ 视觉 token）: ${err && err.message}`);
    }
    return out;
  }

  try {
    const resized = await sharp(buffer, { failOn: 'none' })
      .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    if (!Buffer.isBuffer(resized) || resized.length === 0) {
      out.reason = 'sharp-returned-empty';
      return out;
    }
    const newDims = imageRef.readDimensions(resized, 'jpeg');
    out.buffer = resized;
    out.toBytes = resized.length;
    out.toPx = newDims && newDims.width && newDims.height ? Math.max(newDims.width, newDims.height) : maxPx;
    out.applied = true;
    out.reason = 'ok';
    return out;
  } catch (err) {
    out.reason = `sharp-failed: ${err && err.message}`;
    return out;
  }
}

/**
 * 【C】暴露/泳装档位 → 追加到视觉 system prompt 的策略段。
 * 这些措辞是**产品契约**的一部分：改措辞必须用真实 API 逐档回归（scripts/test-image-policy.js），
 * 不能只看配置改了（历史教训：提示词契约不经验证 ⇒ 图片审核 100% 被拦）。
 * @param {string} mode 档位
 * @returns {string} 策略段（off / 未知档位 ⇒ 空串 = 不注入，维持历史行为）
 */
function exposurePolicyBlock(mode) {
  switch (mode) {
    case 'lenient':
      return [
        '【图像暴露策略：lenient（宽松）】',
        '泳装、比基尼、沙滩装、健身服，以及非色情语境下的身体暴露（海边、泳池、运动、更衣等日常场景）',
        '都属于正常内容，一律判 risk_level=safe。',
        '只有出现色情、性暗示、性器官/隐私部位裸露等淫秽内容时才允许升级 risk_level，并在 reason 里说明具体依据。',
        '不要仅因为「露出了皮肤 / 穿着泳装」就升级判定。',
      ].join('\n');
    case 'strict':
      return [
        '【图像暴露策略：strict（严格）】',
        '泳装、比基尼、内衣、明显身体暴露（含腹部/大腿大面积裸露），无论是否色情语境，一律判 risk_level=high 并建议拦截；',
        '出现色情、性暗示、性器官/隐私部位裸露时判 risk_level=critical。',
        '本档位面向「宁严勿漏」的场景，请在 reason 里给出具体依据以便人工复核。',
      ].join('\n');
    case 'standard':
      return [
        '【图像暴露策略：standard（默认）】',
        '泳装/比基尼、内衣、非色情语境的身体暴露：属低~中风险内容，判 risk_level=low 或 medium 并记录，不要拦截；',
        '仅当出现色情、性暗示、性器官/隐私部位裸露等淫秽内容时才判 risk_level=high 及以上并拦截。',
      ].join('\n');
    case 'off':
    default:
      return '';
  }
}

/**
 * 【D】判断某个 finalizer 是否属于「WD14 联动」。
 * 判据（精确匹配，避免误伤其它插件的终裁器）：
 * ① ref 以 `plugin.wd14-tagger.` 开头（该插件声明的 linkage 终裁器 ref 即 `plugin.wd14-tagger.linkage`）
 * ② 或注册表描述符的 owner 为 `wd14-tagger`
 * @param {string} ref finalizer ref
 * @param {object} [descriptor] 注册表描述符（可为空对象）
 * @returns {boolean}
 */
function isWd14LinkageRef(ref, descriptor) {
  const r = String(ref || '');
  if (r.startsWith('plugin.wd14-tagger.')) return true;
  const owner = descriptor && descriptor.owner ? String(descriptor.owner) : '';
  return owner === 'wd14-tagger';
}

/**
 * 【R8】肤色暴露度评分提示词段（默认关闭 ⇒ 空串，保证提示词逐字节等于现状）。
 * 与 `exposurePolicyBlock()` 同构：**产品契约、单一实现点、留在代码里**（不写进 `prompts/*.md`，
 * 否则 R11 排除该目录后打分契约会随文件一起消失），两条引擎（新/旧）自动一致。
 * @param {boolean} enabled 是否开启暴露度评分
 * @returns {string} 提示词段；未开启 ⇒ ''
 */
function exposureScoringBlock(enabled) {
  if (enabled !== true) return '';
  return [
    '【肤色暴露度（附加只读维度）】',
    '除上述字段外，请**额外**输出以下两个字段；它们只用于事后统计与人工复核，',
    '不得改变你对 risk_level / categories 的既有判定口径：',
    '- "exposure_score"：整数 0-100。分值越高表示画面中可见皮肤/身体的暴露程度越高：',
    '  0 = 完全无可见裸露皮肤；100 = 隐私部位/性器官裸露或性行为。请按整张图整体评估。',
    '- "exposure_scene"：画面场景，取值必须是以下之一：',
    '  none | daily | swimwear | sportswear | beach | pool | underwear | intimate | other',
    '  无法判断时填 "other"。',
    '示例：{"exposure_score": 62, "exposure_scene": "swimwear"}',
  ].join('\n');
}

/**
 * 【R8】判定矩阵（写死，P0 只记录、不参与拦截）。
 * 输入：`S = exposure_score`、`P = category_scores.pornographic`（**原始教师分**）、`C = exposure_scene`。
 * - `C ∈ exemptScenes ∧ P < pornographicMin` ⇒ `compliant`（泳装语义，零影响）
 * - `S ≥ blockScore ∧ C ∉ exemptScenes` ⇒ `excessive`（拦截目标，P0 仅记录）
 * - `C ∈ exemptScenes ∧ P ≥ pornographicMin`⇒ `pornographic`（交既有类目阈值策略）
 * - 其余 ⇒ `normal`
 * **正交红线**：本函数**不读也不写** `risk_level`，返回的对象也**不参与** `passed`/`action`
 * 的计算（调用点在 `buildResult` 里仅为结果附加字段）。
 * @param {object} normalized 已过 OutputValidator 的判决（`verdict.value`）
 * @param {object} policy `getImagePolicyCfg()` 的产物
 * @returns {{score: number, scene: string, verdict: string}|undefined} 关闭时返回 undefined
 */
function evaluateExposure(normalized, policy) {
  const scoring = policy && policy.exposureScoring;
  if (!scoring || scoring.enabled !== true) return undefined;
  if (!normalized || typeof normalized !== 'object') return undefined;

  const score = normalizeExposureScore(normalized.exposure_score);
  const scene = normalizeExposureScene(normalized.exposure_scene);
  const rawP = Number(normalized.category_scores && normalized.category_scores.pornographic);
  const pornographic = Number.isFinite(rawP) ? rawP : 0;
  const min = Number.isFinite(Number(scoring.pornographicMin))
    ? Number(scoring.pornographicMin) : DEFAULT_EXPOSURE_SCORING.pornographicMin;
  const blockScore = Number.isFinite(Number(scoring.blockScore))
    ? Number(scoring.blockScore) : DEFAULT_EXPOSURE_SCORING.blockScore;
  const exempt = Array.isArray(scoring.exemptScenes) ? scoring.exemptScenes : [];

  let verdict = 'normal';
  if (exempt.includes(scene)) {
    verdict = pornographic < min ? 'compliant' : 'pornographic';
  } else if (score >= blockScore) {
    verdict = 'excessive';
  }
  return { score, scene, verdict };
}

/**
 * 校验并归一 `exposureScoring` 配置片段（供 `PUT /api/image-policy` 使用）。
 * 先校验后应用：返回 `null` 表示**非法**，调用方必须 400 且**零写入**。
 * 逐键部分合并：未提供的键沿用 `current`（前端只发改动字段）。
 * @param {object} raw 请求体里的片段
 * @param {object} [current] 当前生效值
 * @returns {{enabled: boolean, blockScore: number, pornographicMin: number, exemptScenes: string[]}|null}
 */
function normalizeExposureScoring(raw, current) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const base = current && typeof current === 'object' ? current : DEFAULT_EXPOSURE_SCORING;
  const out = {
    enabled: base.enabled === true,
    blockScore: intInRange(base.blockScore, DEFAULT_EXPOSURE_SCORING.blockScore, 0, 100),
    pornographicMin: intInRange(base.pornographicMin, DEFAULT_EXPOSURE_SCORING.pornographicMin, 0, 100),
    exemptScenes: Array.isArray(base.exemptScenes) ? base.exemptScenes.map(String) : [],
  };
  // enabled 必须显式布尔：字符串 'false' 被 Boolean() 转成 true 会让「可逆开关」失灵
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return null;
    out.enabled = raw.enabled;
  }
  for (const key of ['blockScore', 'pornographicMin']) {
    if (raw[key] === undefined) continue;
    const num = Number(raw[key]);
    if (!Number.isInteger(num) || num < 0 || num > 100) return null;
    out[key] = num;
  }
  if (raw.exemptScenes !== undefined) {
    if (!Array.isArray(raw.exemptScenes)) return null;
    const scenes = raw.exemptScenes.map(String);
    if (scenes.some((s) => !EXPOSURE_SCENES.includes(s))) return null;
    out.exemptScenes = [...new Set(scenes)];
  }
  return out;
}

/**
 * 【R8】判定缓存的**判别键**（不改 `verdictCacheGet/Set` 签名，只改调用点传入的字符串）。
 * - 关闭（默认）⇒ 原样返回 `policy.exposureMode` ⇒ 缓存命中语义**逐字节不变**（B1）
 * - 开启 ⇒ 追加 `|exp` 后缀，避免命中「另一开关态写入的缓存」导致字段缺失/串味
 * @param {object} policy `getImagePolicyCfg()` 的产物
 * @returns {string} 缓存判别键
 */
function cacheExposureKey(policy) {
  const mode = policy && policy.exposureMode;
  const scoring = policy && policy.exposureScoring;
  if (scoring && scoring.enabled === true) return `${mode}|exp`;
  return mode;
}

module.exports = {
  EXPOSURE_MODES,
  EXPOSURE_SCENES,
  EXPOSURE_VERDICTS,
  DEFAULT_EXPOSURE_SCORING,
  ALLOWED_IMAGE_PX,
  getImagePolicyCfg,
  imageHash,
  stripDataUrlPrefix,
  resizeForModel,
  exposurePolicyBlock,
  exposureScoringBlock,
  evaluateExposure,
  normalizeExposureScoring,
  cacheExposureKey,
  isWd14LinkageRef,
};
