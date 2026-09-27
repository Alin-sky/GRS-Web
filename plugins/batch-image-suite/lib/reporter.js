/**
 * 报告与产物生成（plugins/batch-image-suite/lib/reporter.js）
 *
 * 产出三类：
 *   ① report.txt —— 统计 + 重复清单 + ★溯源映射表（新路径 ↔ 原始路径 + 原始文件名）
 *   ② manifest.csv —— 清单（UTF-8 BOM，可被 Excel 直接打开）
 *   ③ sidecar —— 每张图同名 .json 元数据（sharp 不支持写任意 EXIF，sidecar 是零依赖唯一可行方案）
 */
const fs = require('fs');
const path = require('path');

/**
 * 统计任务结果分布。
 * @param {object} task 任务
 * @returns {object} 统计对象
 */
function buildStats(task) {
  const items = task.items || [];
  const byTimeSource = {};
  const byCategory = {};
  const byPendingReason = {};
  const byLevel = {};
  let pendingCount = 0;
  let dupCount = 0;
  let keepCount = 0;
  for (const it of items) {
    if (it.status !== 'done') continue;
    byTimeSource[it.timeSource || 'unknown'] = (byTimeSource[it.timeSource || 'unknown'] || 0) + 1;
    byCategory[it.category || '未分类'] = (byCategory[it.category || '未分类'] || 0) + 1;
    if (it.pending) {
      pendingCount++;
      byPendingReason[it.pendingReason || '其他'] = (byPendingReason[it.pendingReason || '其他'] || 0) + 1;
    }
    if (it.similarGroupId) dupCount++;
    if (it.isGroupKeep) keepCount++;
    const lvl = (it.nsfw && it.nsfw.level) || 'none';
    byLevel[lvl] = (byLevel[lvl] || 0) + 1;
  }
  return {
    total: items.length,
    done: items.filter((i) => i.status === 'done').length,
    failed: items.filter((i) => i.status === 'failed').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    pendingCount,
    duplicateItems: dupCount,
    groupKeeps: keepCount,
    byTimeSource,
    byCategory,
    byPendingReason,
    byLevel,
  };
}

/**
 * 生成 report.txt 内容（含完整溯源映射表）。
 * @param {object} task 任务
 * @returns {string} 报告文本
 */
function buildReport(task) {
  const stats = buildStats(task);
  const lines = [];
  lines.push('══════════════════════════════════════════════════');
  lines.push('  批量图片处理报告');
  lines.push('══════════════════════════════════════════════════');
  lines.push(`任务 ID      : ${task.id}`);
  lines.push(`模式         : ${task.mode === 'nsfw' ? '动漫图 NSFW 审查' : '本地图片整理'}`);
  lines.push(`源目录       : ${task.sourceDir}（全程只读，未做任何修改）`);
  lines.push(`输出目录     : ${task.outputDir || '（未实体化，仅索引）'}`);
  lines.push(`开始时间     : ${task.startedAt}`);
  lines.push(`结束时间     : ${task.finishedAt || '（未完成）'}`);
  lines.push('');
  lines.push('── 一、处理统计 ──');
  lines.push(`扫描总数     : ${stats.total}`);
  lines.push(`成功处理     : ${stats.done}`);
  lines.push(`失败         : ${stats.failed}`);
  lines.push(`跳过         : ${stats.skipped}`);
  lines.push(`待后续筛选   : ${stats.pendingCount}`);
  lines.push(`相似组内条目 : ${stats.duplicateItems}（保留 ${stats.groupKeeps} 张）`);
  lines.push('');
  lines.push('── 二、时间来源分布 ──');
  const timeLabel = { exif: 'EXIF', filename: '文件名日期', fs: '文件系统时间', ai_era: 'AI 推断年代', unknown: '时间未知' };
  for (const [k, v] of Object.entries(stats.byTimeSource)) {
    lines.push(`  ${timeLabel[k] || k}：${v}`);
  }
  lines.push('');
  lines.push('── 三、分类分布 ──');
  for (const [k, v] of Object.entries(stats.byCategory)) lines.push(`  ${k}：${v}`);
  lines.push('');
  if (Object.keys(stats.byPendingReason).length) {
    lines.push('── 四、待筛原因分布 ──');
    for (const [k, v] of Object.entries(stats.byPendingReason)) lines.push(`  ${k}：${v}`);
    lines.push('');
  }
  if (task.mode === 'nsfw') {
    lines.push('── 五、风险等级分布 ──');
    for (const [k, v] of Object.entries(stats.byLevel)) lines.push(`  ${k}：${v}`);
    lines.push('');
  }

  // 重复清单
  const groups = new Map();
  for (const it of task.items || []) {
    if (!it.similarGroupId) continue;
    if (!groups.has(it.similarGroupId)) groups.set(it.similarGroupId, []);
    groups.get(it.similarGroupId).push(it);
  }
  if (groups.size) {
    lines.push('── 相似分组清单（★ 标记为组内保留）──');
    for (const [gid, list] of groups.entries()) {
      const keep = list.find((i) => i.isGroupKeep);
      lines.push(`  ${gid}（${list.length} 张，保留：${keep ? keep.srcName : '未定'}）`);
      for (const it of list) {
        lines.push(`    ${it.isGroupKeep ? '★' : ' '} ${it.srcName}  ← ${it.srcPath}`);
      }
    }
    lines.push('');
  }

  // ★ 溯源映射表
  lines.push('── 溯源映射表（新路径 ↔ 原始路径 + 原始文件名）──');
  lines.push('格式：新文件名 | 新相对路径 | 原始文件名 | 原始完整路径 | 时间来源 | 场景 | 相似组 | 是否待筛');
  for (const it of task.items || []) {
    if (it.status !== 'done') continue;
    lines.push([
      it.outName || '-',
      it.outRelPath || '-',
      it.srcName || '-',
      it.srcPath || '-',
      it.timeSource || 'unknown',
      it.category || '未分类',
      it.similarGroupId || '-',
      it.pending ? `待筛(${it.pendingReason || '其他'})` : '否',
    ].join(' | '));
  }
  lines.push('');
  lines.push('══════════════════════════════════════════════════');
  lines.push('说明：源目录全程只读，未移动/重命名/修改/删除任何原始文件。');
  lines.push('      待筛图片位于输出目录内的 _待后续筛选_无用候选/ ，删除或移走它不会触及源盘。');
  lines.push('══════════════════════════════════════════════════');
  return lines.join('\n');
}

/**
 * 生成 manifest.csv（带 UTF-8 BOM，Excel 可直接打开）。
 * @param {object} task 任务
 * @returns {string} CSV 文本
 */
function buildManifestCsv(task) {
  const header = ['新文件名', '新相对路径', '原始文件名', '原始完整路径', '拍摄时间', '时间来源', '场景分类', '种类', '描述', '相似组', '组内保留', '是否待筛', '待筛原因', '风险等级', '风险分'];
  const rows = [header.map(csvCell).join(',')];
  for (const it of task.items || []) {
    if (it.status !== 'done') continue;
    rows.push([
      it.outName || '', it.outRelPath || '', it.srcName || '', it.srcPath || '',
      it.shotAt || '', it.timeSource || '', it.category || '', it.kind || '', it.description || '',
      it.similarGroupId || '', it.isGroupKeep ? '1' : '', it.pending ? '1' : '',
      it.pendingReason || '', (it.nsfw && it.nsfw.level) || '', (it.nsfw && it.nsfw.score) || '',
    ].map(csvCell).join(','));
  }
  return '\uFEFF' + rows.join('\r\n');
}

/**
 * CSV 单元格转义。
 * @param {any} v 值
 * @returns {string}
 */
function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 生成单张图的 sidecar 元数据对象。
 * @param {object} item 条目
 * @returns {object}
 */
function sidecarOf(item) {
  return {
    version: 1,
    shotAt: item.shotAt || null,
    timeSource: item.timeSource || 'unknown',
    scene: item.category || '未分类',
    kind: item.kind || '',
    description: item.description || '',
    similarGroupId: item.similarGroupId || null,
    isGroupKeep: !!item.isGroupKeep,
    pending: !!item.pending,
    pendingReason: item.pendingReason || null,
    sourcePath: item.srcPath || '',
    sourceName: item.srcName || '',
    tags: (item.nsfw && item.nsfw.tags) || null,
    nsfw: item.nsfw ? { level: item.nsfw.level, score: item.nsfw.score } : null,
    phash: item.dhash || null,
    width: item.width || null,
    height: item.height || null,
  };
}

/**
 * 写 sidecar 文件（与目标图片同名，扩展名 .json）。
 * @param {string} targetImagePath 目标图片绝对路径
 * @param {object} item 条目
 */
function writeSidecar(targetImagePath, item) {
  if (!targetImagePath) return;
  const json = `${targetImagePath}.json`;
  try {
    fs.writeFileSync(json, JSON.stringify(sidecarOf(item), null, 2), 'utf-8');
  } catch { /* sidecar 失败不影响主流程 */ }
}

/**
 * 在输出目录写 report.txt 与 manifest.csv。
 * @param {object} task 任务
 * @param {string} outputDir 输出目录
 * @returns {{report: string, manifest: string}} 写出的文件路径
 */
function writeReports(task, outputDir) {
  const reportPath = path.join(outputDir, 'report.txt');
  const manifestPath = path.join(outputDir, 'manifest.csv');
  try {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(reportPath, buildReport(task), 'utf-8');
    fs.writeFileSync(manifestPath, buildManifestCsv(task), 'utf-8');
  } catch { /* 报告写失败不影响主流程 */ }
  return { report: reportPath, manifest: manifestPath };
}

module.exports = {
  buildStats,
  buildReport,
  buildManifestCsv,
  csvCell,
  sidecarOf,
  writeSidecar,
  writeReports,
};
