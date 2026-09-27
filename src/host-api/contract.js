/**
 * 宿主 API 契约（src/host-api/contract.js）
 * 本文件是**核心与插件层之间唯一的共享面**，不含任何运行时逻辑，只有常量与纯判定。
 * 核心（moderator / server / flow）与插件层（cordis-bridge / plugin-host / 插件）双向可见，
 * 但**谁都不允许通过它反向 require 对方内部模块**（由 scripts/lint-plugin-boundary.js 静态把关）。
 * 设计依据：docs/architecture-2026-09-14.md §3.3 / §3.4；GRS v2.2.0 架构 §8.3
 * - HOST_API_VERSION：manifest.hostApi 必须与之匹配，否则拒绝装载（v2.2.0 → 1.1）
 * - PERMISSIONS：插件可声明的权限枚举（v1.1 新增 precheck:use / moderation:provide）
 * - INJECT_PERMISSIONS：services.injects ↔ permissions 一致性校验表
 * - CONFIG_DENY_KEYS：注入插件的 config 投影必须剔除的密钥字段
 * - SECRET_GRANTS：v1.1 新增的「宿主 secrets 白名单下发」授权表（方案 C）
 * - CAPABILITIES / OUTPUT_SCHEMAS：新增 `text.verdict` / `image.verdict` 判定能力族
 * - NODE_ROLES / MODALITIES / NODE_STATUS：节点契约（能力声明）
 */

/** 宿主 API 契约版本（插件 manifest.hostApi 需与之相等）*/
const HOST_API_VERSION = '1.1';

/**
 * 宿主程序版本（用于 manifest.host.minVersion 校验）。
 * v2.3.0：改为从 package.json 动态读取，避免与 package.json 手动同步时漂移
 * （此前硬编码 '2.2.0'，是「版本号三处定义」不一致的根因之一）。
 * 读取失败时回退到 '0.0.0'，使任何 minVersion 校验都明确失败而不会误放行。
 */
const HOST_VERSION = (() => {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * 插件可声明的权限枚举。
 * v1.0 起移除 'host:app'：插件不得再直接拿到 Express 实例，需要挂载接口请走 ctx.rpc。
 * v1.1 新增：
 * - 'precheck:use' —— 插件可通过宿主受控 API 使用敏感词库（只返回命中/分类/等级）
 * - 'moderation:provide' —— 插件可提供审核判定能力 / 领取宿主 secrets 授权
 */
const PERMISSIONS = Object.freeze([
  'fs:read',
  'fs:write',
  'net:local',
  'rpc',
  'assets',
  'spawn:git',
  'moderation:use',
  'vision:use',
  'sharp:use',
  'precheck:use',
  'moderation:provide',
  // v2.4.0：通用持久化 KV（带 TTL，命名空间隔离）。插件用它做去重缓存等，无需直连 sqlite。
  'storage:kv',
]);

/** 权限枚举集合（便于 O(1) 判定）*/
const PERMISSION_SET = new Set(PERMISSIONS);

/** 历史权限：仍被 manifest 声明时报「未知权限」并拒绝装载（含明确迁移提示）*/
const REMOVED_PERMISSIONS = Object.freeze({
  'host:app': '宿主已从契约移除 host:app（v1.0）；插件不得直接挂载 Express 路由，请改用 ctx.rpc 注册接口',
});

/**
 * services.injects 每一项所需权限。
 * - 未列出的注入项（config / logger / projectRoot）无需权限；
 * - 值为 null 表示无需权限。
 * v1.1 新增 secrets / precheck 两个受控注入项。
 */
const INJECT_PERMISSIONS = Object.freeze({
  config: null,
  logger: null,
  projectRoot: null,
  fs: 'fs:read',
  moderator: 'moderation:use',
  vision: 'vision:use',
  sharp: 'sharp:use',
  secrets: 'moderation:provide',
  precheck: 'precheck:use',
  // v2.3.0（Req5）：对比审核插件所需的五个受控宿主服务。
  // - comparisonSource：只读「审核源数据 + 图片字节」
  // - comparisonStore ：只写「对比结果文件」（与内置 comparator 共用同一存储格式，避免双轨漂移）
  // - comparisonProbe ：以单通道对单条内容出一次判定（prompt / 密钥全部留在核心，不出库）
  // - comparisonCore ：纯函数「怎么比」（零依赖，无权限要求）
  // - comparisonEngine：对比编排引擎本体（文本/图像共用一条管线）。只做编排，
  // 能力全部经 source/store/probe 取得，故无需额外权限。
  comparisonSource: 'fs:read',
  comparisonStore: 'fs:write',
  comparisonProbe: 'moderation:use',
  comparisonCore: null,
  comparisonEngine: null,
  // v2.4.0：通用持久化 KV 服务（带 TTL，命名空间隔离）。需 storage:kv 权限。
  kvStore: 'storage:kv',
});

/** 宿主注入的服务键全集（插件 inject 超出此集合视为契约外的自研服务，逐个放行）*/
const HOST_SERVICE_KEYS = Object.freeze(Object.keys(INJECT_PERMISSIONS));

/**
 * 注入插件前必须剔除的 config 字段名（大小写不敏感，递归匹配）。
 * 覆盖 adminPassword / wordDbPassword / *.apiKey / accessKeySecret 等。
 */
const CONFIG_DENY_KEYS = Object.freeze([
  'adminpassword',
  'worddbpassword',
  'password',
  'apikey',
  'apisecret',
  'accesskeyid',
  'accesskeysecret',
  'secretkey',
  'secret',
  'token',
]);

/** 脱敏后的占位值（保留字段形状，便于插件判断「未配置」）*/
const CONFIG_REDACTED = '***';

/**
 * secrets 白名单下发授权表（方案 C，架构 §8.1）。
 * 键为插件 id，值为该插件允许通过 `ctx.secrets.get(path)` 读取的**配置路径**（明文）。
 * 白名单外的字段一律返回 null 并记 warn 日志；`CONFIG_DENY_KEYS` 投影规则不变。
 * 采用「配置字段不搬 + 宿主按白名单下发明文」，避免搬迁 `config.contentSafety.*`
 * 带来的回归风险，也不削弱密钥保护面。
 */
const SECRET_GRANTS = Object.freeze({
  'aliyun-content-safety': Object.freeze([
    'contentSafety.accessKeyId',
    'contentSafety.accessKeySecret',
  ]),
});

/** 节点支持的模态*/
const MODALITIES = Object.freeze(['text', 'image']);

/**
 * 节点角色（能力声明）。
 * - service ：判定型，产出一条 ModerationVerdict，可进画布并参与合并（等价架构术语 judge）
 * - contribute ：贡献型，透传上游判定并把标签写入工作上下文（如 wd14 标签）
 * - finalize ：终裁型，在出口前替换/修正判定（如 wd14 linkage）
 * - task ：任务型，不参与审核流程，**注册表层直接排除**（如 batch-image-suite）
 */
const NODE_ROLES = Object.freeze({
  SERVICE: 'service',
  CONTRIBUTE: 'contribute',
  FINALIZE: 'finalize',
  TASK: 'task',
});

/** 角色集合*/
const NODE_ROLE_SET = new Set(Object.values(NODE_ROLES));

/** 兼容别名：架构文档中的 `judge` 等价于 `service`。*/
const ROLE_ALIASES = Object.freeze({ judge: NODE_ROLES.SERVICE, floor: NODE_ROLES.SERVICE });

/** 节点执行状态三分（外加 cancelled / orphan 两个非参与态）*/
const NODE_STATUS = Object.freeze({
  OK: 'ok',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
  ORPHAN: 'orphan',
});

/** 能力标识（manifest.contributes.capabilities[].id）*/
const CAPABILITIES = Object.freeze({
  /** 收集模式：图片标签贡献*/
  IMAGE_TAG: 'image.tag',
  /** 短路模式：图片审核联动判定*/
  IMAGE_LINKAGE: 'image.linkage',
  /** 点对点调用：文本判定*/
  TEXT_VERDICT: 'text.verdict',
  /** 点对点调用：图像判定*/
  IMAGE_VERDICT: 'image.verdict',
  /**
   * v2.4.0 请求生命周期钩子（非拓扑节点，由核心在审核管线前后直接派发）：
   * - REQUEST_INTERCEPT（first）：审核开始前，插件可返回一个「此前已产出的可信结果」短路整条管线（如去重缓存命中）。
   * - VERDICT_OBSERVE（collect）：拿到最终判定后，插件观察 (descriptor, result) 做副作用（如写缓存）。
   * 这两个钩子的返回值**不过 verdict 白名单 gate**（回放的是已被信任管线校验过的完整结果），
   * 故 outputSchema 仅作声明一致性用途；派发见 capability-broker.invokeIntercept / notifyObserve。
   */
  REQUEST_INTERCEPT: 'request.intercept',
  VERDICT_OBSERVE: 'verdict.observe',
});

/** 能力的输出 schema 名（对应 plugin-gate 中的校验器）*/
const OUTPUT_SCHEMAS = Object.freeze({
  MODERATION_TAG_CONTRIBUTION: 'ModerationTagContribution',
  MODERATION_VERDICT: 'ModerationVerdict',
});

/**
 * 可选依赖白名单（架构 §8.2）。
 * manifest.optionalDependencies 的包名必须在此集合内；未安装时插件进入 missing-deps，
 * **不得抛异常、不得注册能力、不得装载**，核心与其它插件不受影响。
 */
const OPTIONAL_DEPENDENCIES = Object.freeze([
  'nsfwjs',
  '@tensorflow/tfjs-node',
  '@tensorflow/tfjs',
  '@alicloud/green20220302',
]);

/** 可选依赖白名单集合*/
const OPTIONAL_DEPENDENCY_SET = new Set(OPTIONAL_DEPENDENCIES);

/**
 * 可选依赖的特殊约束：包名 → 至少其一满足的候选组。
 * nsfwjs 需要 TF.js 后端，`@tensorflow/tfjs-node`（原生）与 `@tensorflow/tfjs`（纯 JS）二选一。
 */
const OPTIONAL_DEPENDENCY_ANY_OF = Object.freeze({
  nsfwjs: Object.freeze(['@tensorflow/tfjs-node', '@tensorflow/tfjs']),
});

/** 插件未就绪原因码（UI 与执行器共用）*/
const NOT_READY_REASONS = Object.freeze({
  MISSING_DEPS: 'missing-deps',
  NOT_CONFIGURED: 'not-configured',
  SERVICE_UNREACHABLE: 'service-unreachable',
  WORDBD_EMPTY: 'worddb-empty',
  DISABLED: 'disabled',
});

/** 单次钩子返回值字节上限（manifest.integrity.maxOutputBytes 可覆盖）*/
const DEFAULT_MAX_OUTPUT_BYTES = 8192;

/**
 * 判定权限是否在契约内。
 * @param {string} permission 权限名
 * @returns {boolean}
 */
function isKnownPermission(permission) {
  return PERMISSION_SET.has(permission);
}

/**
 * 校验 services.injects 是否被 permissions 覆盖。
 * @param {string[]} injects manifest.services.injects
 * @param {string[]} permissions manifest.permissions
 * @returns {{ok: boolean, errors: string[]}} 校验结果
 */
function validateInjects(injects, permissions) {
  const errors = [];
  const list = Array.isArray(injects) ? injects : [];
  const granted = new Set(Array.isArray(permissions) ? permissions : []);
  for (const key of list) {
    if (!Object.prototype.hasOwnProperty.call(INJECT_PERMISSIONS, key)) continue; // 插件自定义服务，由 provide 侧保证
    const need = INJECT_PERMISSIONS[key];
    if (!need) continue;
    if (!granted.has(need)) {
      errors.push(`services.injects 含 '${key}'，但 permissions 未声明其所需权限 '${need}'`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验 manifest.hostApi 与当前契约版本是否兼容。
 * 缺省视为兼容（v1 插件无 hostApi 字段时按 1.0 处理，与 1.1 兼容）。
 * @param {string|undefined} hostApi manifest.hostApi
 * @returns {{ok: boolean, error?: string}}
 */
function validateHostApi(hostApi) {
  if (hostApi === undefined || hostApi === null || hostApi === '') return { ok: true };
  const value = String(hostApi);
  if (value === HOST_API_VERSION) return { ok: true };
  // 向后兼容：1.0 插件在 1.1 宿主上仍可装载（1.1 为向后兼容的新增）
  if (value === '1.0') return { ok: true };
  return {
    ok: false,
    error: `插件宿主 API 版本不匹配：要求 ${hostApi}，当前宿主提供 ${HOST_API_VERSION}`,
  };
}

/** 是否为密钥字段名*/
function isDeniedConfigKey(key) {
  return CONFIG_DENY_KEYS.includes(String(key).toLowerCase());
}

/**
 * 规范化节点角色（judge → service；未知 → service）。
 * @param {string} role 原始角色
 * @returns {string} 规范化角色
 */
function normalizeRole(role) {
  if (role === undefined || role === null || role === '') return NODE_ROLES.SERVICE;
  const value = String(role);
  if (ROLE_ALIASES[value]) return ROLE_ALIASES[value];
  return NODE_ROLE_SET.has(value) ? value : NODE_ROLES.SERVICE;
}

/**
 * 取某插件允许下发的 secrets 白名单。
 * @param {string} pluginId 插件 id
 * @returns {string[]} 允许的配置路径列表（无授权返回空数组）
 */
function secretGrantsOf(pluginId) {
  const grants = SECRET_GRANTS[pluginId];
  return Array.isArray(grants) ? grants.slice() : [];
}

module.exports = {
  HOST_API_VERSION,
  HOST_VERSION,
  PERMISSIONS,
  PERMISSION_SET,
  REMOVED_PERMISSIONS,
  INJECT_PERMISSIONS,
  HOST_SERVICE_KEYS,
  CONFIG_DENY_KEYS,
  CONFIG_REDACTED,
  SECRET_GRANTS,
  MODALITIES,
  NODE_ROLES,
  NODE_ROLE_SET,
  ROLE_ALIASES,
  NODE_STATUS,
  CAPABILITIES,
  OUTPUT_SCHEMAS,
  OPTIONAL_DEPENDENCIES,
  OPTIONAL_DEPENDENCY_SET,
  OPTIONAL_DEPENDENCY_ANY_OF,
  NOT_READY_REASONS,
  DEFAULT_MAX_OUTPUT_BYTES,
  isKnownPermission,
  validateInjects,
  validateHostApi,
  isDeniedConfigKey,
  normalizeRole,
  secretGrantsOf,
};
