/**
 * Prompt JSON 服务（plugins/batch-image-suite/lib/prompt-service.js）
 *
 * 三层结构（PRD §9）：分类（categories[].id/name） → 种类键值（categories[].keys 的 key） → prompt
 * 关键设计：
 * - 单次调用：finalPrompt = system + 可选分类列表 + 可选种类键值 + 输出 JSON 字段 + 该键值的 prompt
 * - 变量占位符只允许 vars 中声明的 {xxx}，未知变量在校验时报错
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_DIR = path.join(__dirname, '..');
const PROMPT_FILE = path.join(PLUGIN_DIR, 'prompts', 'image-kinds.json');
const BACKUP_FILE = path.join(PLUGIN_DIR, 'prompts', 'image-kinds.bak.json');

/**
 * 读取 Prompt JSON（失败返回内置最小结构）。
 * @returns {object}
 */
function load() {
  try {
    return JSON.parse(fs.readFileSync(PROMPT_FILE, 'utf-8'));
  } catch (err) {
    return { version: 1, defaultCategory: 'general', defaultKey: 'auto', vars: {}, categories: [] };
  }
}

/**
 * 保存 Prompt JSON（保存前自动备份旧版本）。
 * @param {object} json 新的 JSON
 * @returns {{ok: boolean, errors?: Array<{path: string, message: string}>}}
 */
function save(json) {
  const check = validate(json);
  if (!check.ok) return check;
  try {
    if (fs.existsSync(PROMPT_FILE)) {
      fs.copyFileSync(PROMPT_FILE, BACKUP_FILE);
    }
    const tmp = `${PROMPT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf-8');
    fs.renameSync(tmp, PROMPT_FILE);
    return { ok: true };
  } catch (err) {
    return { ok: false, errors: [{ path: '$', message: `保存失败: ${err.message}` }] };
  }
}

/** 恢复内置默认（把当前版本另存为 .bak 后用默认覆盖） */
function reset() {
  try {
    if (fs.existsSync(PROMPT_FILE)) fs.copyFileSync(PROMPT_FILE, BACKUP_FILE);
    // 内置默认：从备份中取最早的原始版本；若不存在则直接返回 load 结果
    return { ok: true, json: load() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 校验 Prompt JSON：结构合法性 + 变量白名单。
 * @param {object} json 待校验对象
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
function validate(json) {
  const errors = [];
  if (!json || typeof json !== 'object') return { ok: false, errors: [{ path: '$', message: '必须是 JSON 对象' }] };
  if (!Array.isArray(json.categories)) errors.push({ path: '$.categories', message: 'categories 必须是数组' });
  const varNames = new Set(Object.keys(json.vars || {}));
  const cats = Array.isArray(json.categories) ? json.categories : [];
  cats.forEach((c, i) => {
    const p = `$.categories[${i}]`;
    if (!c.id) errors.push({ path: p, message: '分类缺少 id' });
    if (!c.name) errors.push({ path: p, message: '分类缺少 name' });
    if (!c.keys || typeof c.keys !== 'object') {
      errors.push({ path: `${p}.keys`, message: 'keys 必须是对象' });
      return;
    }
    for (const [key, val] of Object.entries(c.keys)) {
      if (!val || typeof val.prompt !== 'string') {
        errors.push({ path: `${p}.keys.${key}`, message: '缺少 prompt 字符串' });
        continue;
      }
      // 变量白名单校验
      const used = String(val.prompt).match(/\{([A-Za-z0-9_]+)\}/g) || [];
      for (const u of used) {
        const name = u.slice(1, -1);
        if (!varNames.has(name)) {
          errors.push({ path: `${p}.keys.${key}.prompt`, message: `未知占位符 {${name}}（未声明于 vars）` });
        }
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * 按分类 / 键值组装最终 prompt（单次调用）。
 * @param {{categoryId?: string, kindKey?: string}} sel 选择
 * @param {object} [json] Prompt JSON（默认读取文件）
 * @returns {{ok: boolean, prompt?: string, error?: string}}
 */
function buildPrompt(sel, json = null) {
  const data = json || load();
  const cats = data.categories || [];
  if (!cats.length) return { ok: false, error: 'Prompt JSON 中没有分类' };
  const cat = cats.find((c) => c.id === (sel && sel.categoryId)) || cats.find((c) => c.id === data.defaultCategory) || cats[0];
  const keys = cat.keys || {};
  const enabledKeys = Object.keys(keys).filter((k) => keys[k] && keys[k].enabled !== false);
  const key = (sel && sel.kindKey && keys[sel.kindKey]) ? sel.kindKey : (data.defaultKey && keys[data.defaultKey] ? data.defaultKey : enabledKeys[0]);
  if (!key) return { ok: false, error: `分类 ${cat.id} 下没有可用的种类键值` };

  const enabledCats = cats.filter((c) => c.enabled !== false);
  const parts = [
    cat.system || '你是图片内容分析助手。只输出 JSON，不要 Markdown。',
    `可选分类列表：${enabledCats.map((c) => c.name).join(' / ')}`,
    `可选种类键值：${enabledKeys.join(' / ')}`,
    `输出 JSON 字段：${JSON.stringify(cat.outputSchema || {})}`,
    keys[key].prompt || '',
  ];
  return { ok: true, prompt: parts.join('\n'), categoryId: cat.id, kindKey: key };
}

/**
 * 用样例值替换 prompt 中的变量（前端实时预览的后端等价实现）。
 * @param {string} prompt prompt 文本
 * @param {object} [json] Prompt JSON
 * @returns {string} 替换后的文本
 */
function preview(prompt, json = null) {
  const data = json || load();
  const vars = data.vars || {};
  let out = String(prompt || '');
  for (const [name, def] of Object.entries(vars)) {
    out = out.split(`{${name}}`).join(def && def.sample ? def.sample : '');
  }
  return out;
}

/**
 * 估算 token 数（中文按 1.5 token/字，英文按 4 字符/token 的粗略估计）。
 * @param {string} text 文本
 * @returns {number}
 */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = s.length - cjk;
  return Math.round(cjk * 1.5 + rest / 4);
}

module.exports = { PROMPT_FILE, load, save, reset, validate, buildPrompt, preview, estimateTokens };
