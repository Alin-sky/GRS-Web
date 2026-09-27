/**
 * 插件配置持久化（src/plugin-config.js）
 * 职责：
 * 1. 沿用现有 data/plugin-config.json 格式：{ [插件名]: { key: value } }
 * 2. 为插件提供可读写的配置 Proxy：读 = 磁盘值 → schema 默认值；写 = 类型强转 + 范围钳制 + 防抖落盘
 * 3. 生成 standard-schema 校验器（cordis 只认 `~standard`，不提供实现），供插件装载时做一次启动校验
 * 落盘策略：防抖 300ms（滑块拖动时不高频写盘）+ 先写 .tmp 再 rename 原子替换（防并发写坏 JSON）。
 */
const fs = require('fs');
const path = require('path');
const { logError } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
// v0.2.0：测试隔离开关。`GRS_PLUGIN_CONFIG` 未设置时 = `path.join(DATA_DIR, 'plugin-config.json')`
// （与旧版逐字节等价，产品行为零变化）；测试可用它把配置读写重定向到 TEMP，避免改写用户真实配置。
const CONFIG_FILE = process.env.GRS_PLUGIN_CONFIG || path.join(DATA_DIR, 'plugin-config.json');
const PERSIST_DEBOUNCE_MS = 300;

/** 配置校验失败（TypeError 子类，便于 API 层识别并转 400）*/
class ValidationError extends TypeError {
  /**
   * @param {Array<{message: string, path: Array<string>}>} issues 校验问题列表
   */
  constructor(issues) {
    super((issues || []).map((i) => i.message).join('；') || '配置校验失败');
    this.name = 'ValidationError';
    this.issues = issues || [];
  }
}

// ─── 磁盘读写 ───

/** 插件名 → 配置值对象（磁盘数据的内存副本）*/
let _diskCache = null;
/** 防抖定时器*/
let _persistTimer = null;
/** 插件名 → 已注册的 schema*/
const _schemas = new Map();
/** 插件名 → 当前生效的配置值对象（Proxy 的 target）*/
const _stores = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 读取磁盘配置文件（失败返回 {}）*/
function readFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    logError('plugin-config', `读取 ${CONFIG_FILE} 失败，按空配置处理: ${err.message}`);
    return {};
  }
}

function getDiskCache() {
  if (_diskCache === null) _diskCache = readFile();
  return _diskCache;
}

/** 立即落盘（原子替换：先写 .tmp 再 rename）*/
function persistNow() {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  try {
    ensureDataDir();
    const data = {};
    for (const [name, values] of _stores.entries()) {
      data[name] = JSON.parse(JSON.stringify(values === undefined ? {} : values));
    }
    // 合并磁盘上「本次未注册」的插件配置，避免被覆盖丢失
    const disk = getDiskCache();
    for (const [name, values] of Object.entries(disk)) {
      if (!(name in data)) data[name] = values;
    }
    _diskCache = data;
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    logError('plugin-config', `插件配置持久化失败: ${err.message}`);
  }
}

/** 防抖落盘（300ms）*/
function schedulePersist() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof _persistTimer.unref === 'function') _persistTimer.unref();
}

// ─── 类型强转与钳制 ───

/**
 * 按字段类型强转并钳制取值范围。
 * @param {{key: string, type: string, min?: number, max?: number}} field 字段定义
 * @param {any} value 输入值
 * @returns {any} 强转后的值
 */
function coerceField(field, value) {
  const type = field.type || 'string';
  if (type === 'boolean' || type === 'switch') return !!value;
  if (type === 'number' || type === 'slider') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new ValidationError([{ message: `${field.key} 必须是数字`, path: [field.key] }]);
    let v = n;
    if (typeof field.min === 'number') v = Math.max(field.min, v);
    if (typeof field.max === 'number') v = Math.min(field.max, v);
    return v;
  }
  if (type === 'array' || type === 'checkbox-group' || type === 'tags-input') {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
    throw new ValidationError([{ message: `${field.key} 必须是数组`, path: [field.key] }]);
  }
  if (type === 'object' || type === 'keyvalue-list') {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    throw new ValidationError([{ message: `${field.key} 必须是对象`, path: [field.key] }]);
  }
  return String(value);
}

/**
 * 把现有 schema 格式转换为 cordis 可识别的 standard-schema。
 * @param {Array<object>} fields 字段定义数组
 * @returns {{'~standard': object}} standard-schema 对象
 */
function toStandardSchema(fields) {
  const list = Array.isArray(fields) ? fields : [];
  return {
    '~standard': {
      version: 1,
      vendor: 'qq-bot-moderator',
      validate(value) {
        const issues = [];
        const out = {};
        const input = value && typeof value === 'object' ? value : {};
        for (const f of list) {
          const raw = input[f.key];
          if (raw === undefined) {
            out[f.key] = f.default;
            continue;
          }
          try {
            out[f.key] = coerceField(f, raw);
          } catch (err) {
            issues.push({ message: err.message, path: [f.key] });
          }
        }
        if (issues.length) return { issues };
        return { value: out };
      },
    },
  };
}

// ─── 对外 API ───

/**
 * 注册插件配置 schema 并取得可读写配置对象（Proxy）。
 * @param {{name: string, title?: string, description?: string, fields: Array<object>}} schema 插件配置声明
 * @returns {Proxy<object>} 配置对象
 */
function getConfig(schema) {
  if (!schema || !schema.name) throw new Error('配置 schema 缺少 name');
  const name = schema.name;
  _schemas.set(name, schema);
  if (!_stores.has(name)) {
    const saved = getDiskCache()[name] || {};
    const values = {};
    for (const f of schema.fields || []) {
      values[f.key] = saved[f.key] !== undefined ? saved[f.key] : f.default;
    }
    _stores.set(name, values);
  }
  const store = _stores.get(name);
  const fieldMap = new Map((schema.fields || []).map((f) => [f.key, f]));
  return new Proxy(store, {
    set(target, key, value) {
      const field = fieldMap.get(key);
      // 未知 key 直接赋值不报错（保持与现状一致；校验只在 updateConfig API 侧做）
      target[key] = field ? coerceField(field, value) : value;
      schedulePersist();
      return true;
    },
    deleteProperty(target, key) {
      delete target[key];
      schedulePersist();
      return true;
    },
  });
}

/** 注册 schema 但不返回 Proxy（用于只登记不取值的场景）*/
function registerSchema(schema) {
  if (schema && schema.name) _schemas.set(schema.name, schema);
  return schema;
}

/** 获取已注册的 schema*/
function getSchema(name) {
  return _schemas.get(name) || null;
}

/** 列出全部已注册 schema*/
function listSchemas() {
  return [..._schemas.values()];
}

/**
 * 更新插件配置的单个键（后端 API 调用，带校验与钳制）。
 * @param {string} name 插件名
 * @param {string} key 配置键
 * @param {any} value 新值
 * @returns {any} 实际写入的值
 */
function update(name, key, value) {
  const schema = _schemas.get(name);
  if (!schema) throw new Error(`插件 ${name} 未注册配置`);
  const field = (schema.fields || []).find((f) => f.key === key);
  if (!field) throw new Error(`插件 ${name} 无配置项 ${key}`);
  const v = coerceField(field, value);
  if (!_stores.has(name)) getConfig(schema);
  _stores.get(name)[key] = v;
  schedulePersist();
  return v;
}

/**
 * 批量更新插件配置。
 * @param {string} name 插件名
 * @param {object} patch 键值补丁
 * @returns {object} 实际写入的键值
 */
function updateMany(name, patch) {
  const applied = {};
  for (const [k, v] of Object.entries(patch || {})) applied[k] = update(name, k, v);
  return applied;
}

/** 返回全部插件的配置 schema + 当前值（供前端渲染控件）*/
function describe() {
  const result = [];
  for (const [name, schema] of _schemas.entries()) {
    const values = _stores.get(name) || {};
    result.push({
      name,
      title: schema.title || name,
      description: schema.description || '',
      groups: Array.isArray(schema.groups) ? schema.groups : [],
      fields: (schema.fields || []).map((f) => ({
        ...f,
        value: values[f.key] !== undefined ? values[f.key] : f.default,
      })),
    });
  }
  return result;
}

/** 取某插件的当前配置值（普通对象副本）*/
function values(name) {
  const store = _stores.get(name);
  return store ? { ...store } : {};
}

/** 移除某插件在内存中的配置（插件卸载时可选调用，不删磁盘数据）*/
function drop(name) {
  _schemas.delete(name);
  _stores.delete(name);
}

/** 立即落盘（进程退出前调用）*/
function flush() {
  persistNow();
}

module.exports = {
  ValidationError,
  toStandardSchema,
  coerceField,
  getConfig,
  registerSchema,
  getSchema,
  listSchemas,
  update,
  updateMany,
  describe,
  values,
  drop,
  flush,
  CONFIG_FILE,
};
