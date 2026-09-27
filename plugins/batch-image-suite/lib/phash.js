/**
 * 感知哈希（plugins/batch-image-suite/lib/phash.js）
 *
 * 自实现，零新增依赖：
 *   ① dHash：sharp.resize(9,8).grayscale().raw() → 逐行比较相邻像素 → 64 bit
 *   ② 汉明距离
 *   ③ LSH 分桶：8 张表 × 每张 16 bit 固定种子的随机投影，桶内再算汉明距离
 *      10 万张建索引 + 分组可控制在分钟级（避免 O(n²)）
 */
const crypto = require('crypto');

/** LSH 表数量 */
const LSH_TABLES = 8;
/** 每张表采样的 bit 数 */
const LSH_BITS = 16;
/** 默认汉明距离阈值（≤ 视为相似） */
const DEFAULT_THRESHOLD = 6;

/** 固定种子的伪随机 bit 排列（保证不同运行结果一致） */
function buildProjections() {
  const seed = 'batch-image-suite-lsh-v1';
  const tables = [];
  for (let t = 0; t < LSH_TABLES; t++) {
    const hash = crypto.createHash('sha256').update(`${seed}#${t}`).digest();
    const bits = [];
    for (let i = 0; i < LSH_BITS; i++) {
      // 每 2 字节取一个 0-63 的 bit 下标
      const a = hash[(i * 2) % hash.length];
      const b = hash[(i * 2 + 1) % hash.length];
      bits.push(((a << 8) | b) % 64);
    }
    tables.push(bits);
  }
  return tables;
}

const PROJECTIONS = buildProjections();

/**
 * 从灰度原始像素计算 dHash（64 位十六进制字符串）。
 * @param {Buffer} raw 灰度原始像素（宽 9 × 高 8）
 * @returns {string} 16 位十六进制
 */
function dHashFromRaw(raw) {
  // 9 列 × 8 行：逐行比较相邻列，得 8×8 = 64 bit
  let hi = '';
  let lo = '';
  let bitIndex = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = raw[y * 9 + x];
      const right = raw[y * 9 + x + 1];
      const bit = left < right ? 1 : 0;
      if (bitIndex < 32) hi += String(bit);
      else lo += String(bit);
      bitIndex++;
    }
  }
  const toHex = (bin) => parseInt(bin, 2).toString(16).padStart(8, '0');
  return toHex(hi) + toHex(lo);
}

/**
 * 计算图片的 dHash。
 * @param {string} filePath 图片路径
 * @param {object} sharp sharp 模块
 * @returns {Promise<string|null>} 十六进制 hash，失败返回 null
 */
async function dHashFile(filePath, sharp) {
  if (!sharp) return null;
  try {
    const raw = await sharp(filePath).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
    if (!raw || raw.length < 72) return null;
    return dHashFromRaw(raw);
  } catch {
    return null;
  }
}

/**
 * 汉明距离（两个 64bit 十六进制 hash）。
 * @param {string} a hash A
 * @param {string} b hash B
 * @returns {number} 距离（0-64），非法输入返回 64
 */
function hamming(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

/**
 * 生成某 hash 在 LSH 中的桶键。
 * @param {string} hash 十六进制 hash
 * @returns {string[]} 每张表一个桶键
 */
function bucketKeys(hash) {
  if (!hash || hash.length !== 16) return [];
  // 先展开为 64 个 0/1
  const bits = new Array(64);
  for (let i = 0; i < 16; i++) {
    const v = parseInt(hash[i], 16);
    for (let b = 0; b < 4; b++) bits[i * 4 + b] = (v >> (3 - b)) & 1;
  }
  return PROJECTIONS.map((table) => table.map((idx) => bits[idx]).join(''));
}

/**
 * 对一批 item 做相似分组。
 * @param {Array<{id: string, dhash: string}>} items 条目（会被写入 similarGroupId）
 * @param {number} [threshold=6] 汉明距离阈值
 * @returns {Map<string, string[]>} groupId → item id 列表
 */
function groupBySimilarity(items, threshold = DEFAULT_THRESHOLD) {
  const groups = new Map();
  const buckets = new Map(); // `${tableIdx}:${key}` → item 下标数组
  const withHash = [];
  items.forEach((it, idx) => {
    if (!it.dhash) return;
    withHash.push(idx);
    const keys = bucketKeys(it.dhash);
    keys.forEach((k, t) => {
      const bk = `${t}:${k}`;
      if (!buckets.has(bk)) buckets.set(bk, []);
      buckets.get(bk).push(idx);
    });
  });

  const parent = new Map(); // item idx → 代表 idx（并查集）
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const idx of withHash) parent.set(idx, idx);

  for (const idxs of buckets.values()) {
    // 桶内两两比较（桶通常很小）
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        const a = idxs[i];
        const b = idxs[j];
        if (hamming(items[a].dhash, items[b].dhash) <= threshold) union(a, b);
      }
    }
  }

  // 归并分组
  const byRoot = new Map();
  for (const idx of withHash) {
    const root = find(idx);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(idx);
  }
  let seq = 1;
  for (const [, idxs] of byRoot) {
    const gid = `g${String(seq++).padStart(4, '0')}`;
    const ids = [];
    for (const idx of idxs) {
      items[idx].similarGroupId = gid;
      ids.push(items[idx].id);
    }
    groups.set(gid, ids);
  }
  return groups;
}

module.exports = {
  dHashFromRaw,
  dHashFile,
  hamming,
  bucketKeys,
  groupBySimilarity,
  DEFAULT_THRESHOLD,
  LSH_TABLES,
  LSH_BITS,
};
