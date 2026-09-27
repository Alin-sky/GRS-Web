/**
 * 对比判定核心（src/comparison-core.js）
 * v2.3.0（Req5）新增：把「两条判定之间怎么比」这件纯逻辑收敛为一份，
 * 供内置引擎（src/comparator.js）与对比审核插件（plugins/comparison-suite）共用。
 * 为什么必须共用：插件与内置路径各写一份 compareResults，任何一处的口径调整
 * （例如「review 算不算拦截」）都会让同一份数据在两条路径下算出不同一致率，
 * 而用户看到的却是同一个界面 —— 这是最难排查的一类不一致。
 * 本模块零依赖（除风险序唯一来源），可被核心、插件、测试独立引用。
 */
const { RISK_ORDER } = require('./flow/risk');

/** 视为「拦截」的风险等级（与核心 moderator 的口径一致）*/
const BLOCK_LEVELS = Object.freeze(['high', 'critical']);

/**
 * 检测存储的审核结果是否为异常结果（异常结果不参与对比，避免污染一致率）。
 * @param {object} result 审核结果
 * @returns {boolean} 是否异常
 */
function isErrorResult(result) {
  if (!result) return true;
  const conf = result.confidence;
  const reason = result.reason || '';
  if (conf === 0) return true;
  if (typeof reason === 'string' && (
    reason.includes('异常') ||
    reason.toLowerCase().includes('failed') ||
    reason.toLowerCase().includes('error')
  )) return true;
  return false;
}

/**
 * 对比两条审核结果。
 * @param {object} resultA 通道 A 的判定
 * @param {object} resultB 通道 B 的判定
 * @param {string} labelA 通道 A 的短标签（如 safeguard / cloud）
 * @param {string} labelB 通道 B 的短标签
 * @returns {object} 对比结果（字段名沿用历史格式，前端零改动）
 */
function compareResults(resultA, resultB, labelA, labelB) {
  const riskOrder = RISK_ORDER;

  const riskChanged = resultA.risk_level !== resultB.risk_level;
  const catsA = new Set(resultA.categories || []);
  const catsB = new Set(resultB.categories || []);
  const catsAdded = [...catsB].filter((c) => !catsA.has(c));
  const catsRemoved = [...catsA].filter((c) => !catsB.has(c));
  const confDiff = (resultB.confidence || 0) - (resultA.confidence || 0);

  const aBlocked = BLOCK_LEVELS.includes(resultA.risk_level);
  const bBlocked = BLOCK_LEVELS.includes(resultB.risk_level);
  const actionAgreed = aBlocked === bBlocked;

  const agreed = !riskChanged && catsAdded.length === 0 && catsRemoved.length === 0 && actionAgreed;

  return {
    agreed,
    risk_level_changed: riskChanged,
    [`risk_${labelA}`]: resultA.risk_level,
    [`risk_${labelB}`]: resultB.risk_level,
    risk_diff: (riskOrder[resultB.risk_level] ?? 0) - (riskOrder[resultA.risk_level] ?? 0),
    categories_added: catsAdded,
    categories_removed: catsRemoved,
    confidence_diff: Math.round(confDiff * 100) / 100,
    [`confidence_${labelA}`]: resultA.confidence,
    [`confidence_${labelB}`]: resultB.confidence,
    action_agreed: actionAgreed,
    [`reason_${labelA}`]: resultA.reason,
    [`reason_${labelB}`]: resultB.reason,
  };
}

/**
 * 把模型名压缩为结果字段用的短标签（保持与历史结果兼容）。
 * @param {string} model 模型名或通道名
 * @returns {string} 标签
 */
function modelLabel(model) {
  if (model === 'cloud') return 'cloud';
  if (model === 'content_safety') return 'content_safety';
  const s = String(model);
  if (s.includes('safeguard')) return 'safeguard';
  // v2.3.0（Req6）：视觉系模型单独一档标签。
  // 旧实现下 'qwen3-vl:8b-instruct'（图像流程的本地视觉模型）
  // 与 'qwen3:8b'（文本流程的对照模型）都压成 '8b'，
  // 使 risk_8b / confidence_8b 产生歧义，两条模态的结果互相污染。
  // 注意：下方 14b / 8b 两档**不能动**，它们是既有文本对比数据
  // 的字段名（config.ollama.comparisonModels），改了会丢失可比性。
  if (s.includes('vl')) {
    const size = (s.match(/(\d+(?:\.\d+)?)b/i) || [])[1];
    return size ? `vl_${size}b` : 'vl';
  }
  if (s.includes('14b')) return '14b';
  if (s.includes('8b')) return '8b';
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * 生成「所有通道两两组合」的键列表（顺序稳定，保证多次运行结果可比）。
 * @param {string[]} channels 通道名列表
 * @returns {Array<{a: string, b: string, key: string, labelA: string, labelB: string}>} 组合
 */
function pairKeys(channels) {
  const out = [];
  for (let i = 0; i < channels.length; i++) {
    for (let j = i + 1; j < channels.length; j++) {
      const a = channels[i];
      const b = channels[j];
      const labelA = modelLabel(a);
      const labelB = modelLabel(b);
      out.push({ a, b, key: `${labelA}_vs_${labelB}`, labelA, labelB });
    }
  }
  return out;
}

/**
 * 由「逐条对比结果」汇总出每对通道的一致率统计。
 * @param {Array<object>} results 逐条对比结果
 * @param {string[]} channels 通道列表
 * @returns {object} summary.comparisons
 */
function summarizePairs(results, channels) {
  const out = {};
  for (const pair of pairKeys(channels)) {
    let agreed = 0;
    let disagreed = 0;
    let confSumA = 0;
    let confSumB = 0;
    let validCount = 0;

    for (const r of results) {
      const comp = (r.comparisons || {})[pair.key];
      if (!comp) continue;
      if (comp.agreed) agreed++;
      else disagreed++;
      confSumA += (r.models && r.models[pair.a] && r.models[pair.a].confidence) || 0;
      confSumB += (r.models && r.models[pair.b] && r.models[pair.b].confidence) || 0;
      validCount++;
    }

    out[pair.key] = {
      agreed,
      disagreed,
      agreement_rate: validCount > 0 ? Math.round((agreed / validCount) * 1000) / 10 : 0,
      avg_confidence_a: validCount > 0 ? Math.round((confSumA / validCount) * 100) / 100 : 0,
      avg_confidence_b: validCount > 0 ? Math.round((confSumB / validCount) * 100) / 100 : 0,
      channel_a: pair.a,
      channel_b: pair.b,
    };
  }
  return out;
}

module.exports = {
  BLOCK_LEVELS,
  isErrorResult,
  compareResults,
  modelLabel,
  pairKeys,
  summarizePairs,
};