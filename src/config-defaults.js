/**
 * 配置结构默认值与深度合并工具
 * 目的：
 * 1. 集中维护「完整配置结构」，避免各模块散落 `config.xxx || {}` 兜底逻辑。
 * 2. 用户配置缺失任意字段时（尤其是 clone 仓库后没有 config/default.json），
 * 与此处默认值深度合并，杜绝 `Cannot read properties of undefined`。
 * 3. 所有可选能力（本地模型 / 云端大模型 / 内容安全 / wd14）都在此声明默认开关，
 * 未配置时由能力检测层静默跳过，而不是抛异常。
 */

'use strict';

/** 判断是否为普通对象（用于深度合并时区分「对象下钻」与「直接覆盖」）。*/
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深拷贝，避免默认值对象被外部引用污染。*/
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

/**
 * 深度合并：以 base 为底座，用 override 覆盖。
 * - 双方都是普通对象 → 递归合并
 * - 其余情况（含数组、标量、null）→ 以 override 为准；override 未提供则保留 base
 * @template T
 * @param {T} base 默认结构
 * @param {object} override 用户配置
 * @returns {T} 合并后的新对象（不修改入参）
 */
function deepMerge(base, override) {
  if (!isPlainObject(base)) return deepClone(override === undefined ? base : override);
  if (!isPlainObject(override)) return deepClone(base);

  const out = deepClone(base);
  for (const key of Object.keys(override)) {
    const next = override[key];
    if (isPlainObject(next) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], next);
    } else if (next !== undefined) {
      out[key] = deepClone(next);
    }
  }
  return out;
}

/**
 * 占位符密钥形态：YOUR_XXX / CHANGE_ME / <xxx> / **** / none / null，视为「未配置」。
 * 放在本模块（无任何依赖）是为了让 config.js 与 config-conflicts.js 共用同一判定，
 * 避免两份实现漂移，也避免 config-conflicts -> config 的循环依赖。
 */
const PLACEHOLDER_PATTERN = /^(your[_-][a-z0-9_-]*|change[_-]me|<[^>]*>|\*+|none|null)$/i;

/**
 * 判断一个密钥/必填值是否真正被配置过。
 * @param {*} value 待检查值
 * @returns {boolean} 是否已配置
 */
function isValueSet(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  if (!text) return false;
  return !PLACEHOLDER_PATTERN.test(text);
}

/** 审核分类定义（风险等级说明，不含任何具体敏感词）。*/
const DEFAULT_CATEGORIES = [
  { id: 'political', name: '涉政内容', defaultRisk: 'critical', description: '违反宪法与法律、危害国家安全与社会稳定的内容' },
  { id: 'pornographic', name: '色情低俗', defaultRisk: 'high', description: '淫秽色情、低俗挑逗及色情引流内容' },
  { id: 'marketing', name: '营销广告', defaultRisk: 'medium', description: '过度营销、垃圾广告、虚假推广与引流' },
  { id: 'violence', name: '暴力恐怖', defaultRisk: 'critical', description: '暴力血腥、恐怖主义与伤害行为宣扬' },
  { id: 'gambling', name: '赌博诈骗', defaultRisk: 'high', description: '赌博竞猜、虚假活动与欺诈冒充' },
  { id: 'privacy', name: '隐私侵权', defaultRisk: 'medium', description: '未经授权收集传播个人信息、侵犯肖像名誉' },
  { id: 'illegal', name: '其他违法', defaultRisk: 'high', description: '侵权盗版、外挂工具及其他违法违规内容' },
  { id: 'abuse', name: '辱骂人身攻击', defaultRisk: 'medium', description: '辱骂、人身攻击、恶意挑衅与歧视言论' },
  { id: 'grotesque', name: '猎奇恶心', defaultRisk: 'medium', description: '以猎奇恶心为目的、违背公序良俗的描写' },
];

/** 各分类阈值（log = 记录，block = 拦截）。*/
const DEFAULT_THRESHOLDS = {
  political: { enabled: true, logThreshold: 32, blockThreshold: 65 },
  pornographic: { enabled: true, logThreshold: 30, blockThreshold: 60 },
  marketing: { enabled: true, logThreshold: 40, blockThreshold: 75 },
  violence: { enabled: true, logThreshold: 30, blockThreshold: 60 },
  gambling: { enabled: true, logThreshold: 30, blockThreshold: 60 },
  privacy: { enabled: true, logThreshold: 40, blockThreshold: 70 },
  illegal: { enabled: true, logThreshold: 30, blockThreshold: 60 },
  abuse: { enabled: true, logThreshold: 20, blockThreshold: 50 },
  grotesque: { enabled: true, logThreshold: 40, blockThreshold: 70 },
};

/**
 * 风险等级 → 动作/说明 映射。
 * 注意：这里的 `score` 与 `src/flow/risk.js` 的 `RISK_ORDER` 采用同一阶梯
 * （safe 0 < low 1 < medium 2 < review 3 < high 4 < critical 5）。
 * 序位比较的唯一来源是 `src/flow/risk.js`，本表仅承载界面文案与动作映射，请勿在其上做比较。
 */
const DEFAULT_RISK_LEVELS = {
  safe: { score: 0, action: 'pass', description: '内容安全，无违规风险' },
  low: { score: 1, action: 'pass_log', description: '存在轻微风险，放行但记录日志' },
  medium: { score: 2, action: 'pass_log', description: '存在中等风险，放行并记录日志供人工复查' },
  // review 不是「内容安全」的判定，而是「审核链路失效、未取得有效判定」的保守结论。
  // 出现在 fail-closed 场景：AI 通道已配置但调用失败 / 返回空 / 输出无法解析。
  review: { score: 3, action: 'review', description: 'AI 审核通道异常，未取得有效判定，需人工复核并默认拦截' },
  high: { score: 4, action: 'block', description: '高风险违规内容，拦截并记录' },
  critical: { score: 5, action: 'block_alert', description: '严重违规，拦截并告警' },
};

/**
 * 完整默认配置结构。
 * 说明：所有「可选能力」默认关闭或留空密钥，由能力检测层判定可用性。
 */
const DEFAULT_CONFIG = {
  server: {
    port: 11451,
    host: '0.0.0.0',
    cors: true,
    maxRequestSize: '10mb',
    trustedProxyIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
  },

  // 本地 Ollama（可选能力）：未安装 Ollama / 未配置时自动跳过
  ollama: {
    enabled: true,
    host: 'http://127.0.0.1:11434',
    visionHost: 'http://127.0.0.1:11434',
    textModel: '',
    visionModel: '',
    options: {
      temperature: 0.1,
      top_p: 0.8,
      num_predict: 512,
      num_ctx: 16384,
    },
    keepAlive: '5m',
    moderationKeepAlive: '2m',
    chatKeepAlive: '5m',
    comparisonModels: [],
    comparisonSchedule: '04:00',
    comparisonEnabled: false,
    timeout: 60000,
    maxRetries: 0,
    dualGpu: false,
    availableModels: [],
  },

  // 云端大模型（可选能力）：未配置 API Key 时自动跳过
  qwenCloud: {
    enabled: false,
    billingSource: 'dashscope',
    apiKey: '',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    fallbackModel: 'qwen-plus',
    // v2.3.0（Req6）：默认视觉模型须在**两种额度来源下都可调用**。
    // qwen3.8-flash 是原生多模态，实测 token-plan 与 dashscope 端点均有且能审图；
    // 旧的 qwen3-vl-plus 只在 dashscope 存在，token-plan 下调用必然 404。
    visionModel: 'qwen3.8-flash',
    visionEnabled: false,
    timeout: 30000,
  },

  // Token Plan 额度（可选能力）
  tokenPlan: {
    apiKey: '',
    endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    timeout: 60000,
  },

  // 阿里云绿网内容安全（可选能力）：未配置 AccessKey 时自动跳过
  contentSafety: {
    enabled: false,
    textEnabled: true,
    imageEnabled: false,
    accessKeyId: '',
    accessKeySecret: '',
    region: 'cn-shanghai',
    endpoint: 'green-cip.cn-shanghai.aliyuncs.com',
    textServices: ['comment_detection'],
    imageService: 'query_security_check',
    timeout: 10000,
  },

  moderation: {
    strictness: 'standard',
    textPromptFile: 'text_moderation.md',
    imagePromptFile: 'image_moderation.md',
    safeguardPromptFile: 'safeguard_moderation.md',
    doubleCheck: false,
    dualMode: false,
    // AI 通道「已配置但调用/解析失败」时的兜底策略（fail-closed）。
    // block （默认，安全）：未取得有效判定即拦截，绝不放行
    // review ：标记为需人工复核并拦截，交由人工放行
    // 注意：仅对「已配置 AI 通道但失败」生效；
    // 用户压根没配置任何 AI 通道时属于可选能力降级，仍按预检层结论放行。
    onAiFailure: 'block',
    // T02 提示词注入防御：零成本交叉校验（架构 §2.5 的 C1–C4）
    crossCheck: {
      // 是否启用交叉校验升级（发现冲突信号时抬升结论等级）
      enabled: true,
      // 发现冲突信号时，结论至少抬升到的等级（默认 medium）
      minLevel: 'medium',
      // 是否要求模型输出策略版本号哨兵 policy_version：
      // 开启（默认）—— 缺失即判 unsafe → fail-closed。这是识别「提示词被覆盖」
      // 成本最低且最有效的信号；模型只要遵守输出契约就不会误伤。
      // 关闭 —— 哨兵缺失只记录信号、不判失败（仅用于兼容确实不会回传该字段的模型）
      requirePolicyCanary: true,
      // 不可信区块长度上限（字符数）：注意力稀释型注入（INJ-04）的主要节流手段
      maxTextLen: 4000,
      maxHintLen: 1500,
    },
    reviewChannels: {
      local: true,
      cloud: true,
      contentSafety: false,
      disputeStrategy: 'highest',
    },
    // v2.2.0 审核流程（DAG 拓扑）。
    // enabled=true → 使用 src/flow/* 执行器（默认；行为等价 v2.1.0）
    // enabled=false → 回退 v2.1.0 旧硬编码分支（@deprecated，保留至 v2.3.0）
    // flows.text / flows.image 由 src/flow/migrate.js 在首次加载时从旧开关迁移生成，
    // 此处只声明总开关，避免把体积较大的拓扑写进默认模板。
    flows: {
      enabled: true,
    },
    // v0.2.0：图像审核策略（实现见 src/image-policy.js）
    // A. maxImagePx：发给云端前缩到「长边 ≤ N」px（省 90%+ 视觉 token；0=原图；档位 0/384/512/768/1024）。
    //    只缩发给模型的内存字节，data/image_blobs/ 始终留原图；sharp 缺失 ⇒ 降级为发原图。
    // B. cacheVerdicts：同图+同模型+同档位复用上次判定（data/audit.db 的 verdict_cache 表；DB 不可用自动禁用）。
    //    v2.4.0 起**默认关闭**：请求级去重已由 request-dedupe 插件统一承担（带 TTL、覆盖文本+图片、命中跳过整条管线），
    //    避免「两套缓存」并存矛盾。保留本开关与 verdict_cache 代码以便回退（需要时手动置 true）。
    // C. exposure.mode：泳装/暴露档位（off/lenient/standard/strict），动态拼进视觉提示词。
    // D. useWd14Linkage：关闭时图像终裁层的 WD14 联动按 skipped 处理（可逆，不删磁盘配置）。
    // E. exposureScoring（R8，**默认关闭**）：enabled=false ⇒ 不打分、不产生 result.exposure、提示词逐字节不变；
    //    true ⇒ 额外要求并记录分数（**P0 只记录、不参与拦截**）；blockScore/pornographicMin 为 0–100；
    //    exemptScenes 为场景枚举子集；与 exposure.mode **叠加**（mode 管提示词策略段，本项管是否打分）。
    imagePolicy: {
      maxImagePx: 768,
      cacheVerdicts: false,
      exposure: { mode: 'standard' },
      useWd14Linkage: true,
      exposureScoring: {
        enabled: false,
        blockScore: 90,
        pornographicMin: 50,
        exemptScenes: ['swimwear', 'sportswear', 'beach', 'pool'],
      },
    },
    // v0.1.2：URL-only 图片输入（实现见 src/image-source.js）。
    // 允许 /api/moderate/image 只传 imageUrl、/api/moderate 的 images[] 传 URL —— 服务端下载 + 转码。
    // enabled=false ⇒ 端点收到 URL 输入直接结构化拒绝（这就是回退开关；老 base64 路径不受影响）。
    // allowPrivateHosts 默认必须 false（SSRF 防护）；hostAllowlist 非空时只允许名单内主机。
    // transcode：auto（jpeg 不重编 / 带 alpha 保持 png / 其余转 transcodeFormat）| off | force。
    imageSource: {
      enabled: true,
      fetchTimeoutMs: 10000,
      maxRedirects: 3,
      allowPrivateHosts: false,
      hostAllowlist: [],
      transcode: 'auto',
      transcodeFormat: 'jpeg',
      transcodeQuality: 88,
      maxBytes: 0, // 0 ⇒ 沿用 imageCapture.maxBytes（单一真相）
    },
    thresholds: DEFAULT_THRESHOLDS,
    riskLevels: DEFAULT_RISK_LEVELS,
    categories: DEFAULT_CATEGORIES,
  },

  logging: {
    dir: 'logs',
    moderationLog: 'moderation.log',
    errorLog: 'error.log',
    maxFileSize: '10m',
    maxFiles: 30,
    console: true,
  },

  // 批量扫描（可选能力）
  batch: {
    autoResume: true,
    autoScanFolder: '',
    autoScanStrictness: 'standard',
    concurrency: 2,
  },

  // 插件系统（可选能力）：整体开关。
  // 关闭后核心仍可正常启动并完成审核 —— 审核通道、审核记录、统计面板均不受影响，
  // 仅插件提供的扩展功能不可用。也可用环境变量 GRS_PLUGINS_ENABLED=false 临时关闭。
  plugins: {
    enabled: true,
  },

  // v0.2.0：图片全链路（内容寻址落盘 + 缩略图）。
  // 关闭 `enabled` ⇒ 图片链路**逐字节等于**历史行为（只保留 hash/尺寸，不落任何字节）。
  // 容量超限行为 = 停捕获 + 告警（新图 stored=false 但仍保留 hash），**不拒绝审核、不删旧图**。
  imageCapture: {
    enabled: true,
    maxBytes: 20 * 1024 * 1024,          // 对齐既有 MAX_IMAGE_BYTES
    thumbMaxDim: 320,
    thumbQuality: 72,
    capacity: {
      limitBytes: 5 * 1024 * 1024 * 1024, // 默认 5GB（唯一磁盘保护）
      warnPct: 80,
      onExceed: 'stop-capture',
    },
  },

  // v0.2.0：审核记录多重保存（JSONL 权威 + DB 投影）。
  // 关闭 `dualWrite.enabled` ⇒ 行为**逐字节等于**现状（无 DB 增长、无新增文件）。
  auditStore: {
    dualWrite: { enabled: true },
  },

  wordDbPassword: '',
  adminPassword: '',
  moderationMode: 'local',
  reviewChannels: {
    local: true,
  },
};

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_CATEGORIES,
  DEFAULT_THRESHOLDS,
  DEFAULT_RISK_LEVELS,
  PLACEHOLDER_PATTERN,
  isValueSet,
  deepMerge,
  deepClone,
  isPlainObject,
};
