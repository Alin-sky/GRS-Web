/**
 * QA 运行时守卫（scripts/qa-runtime-preload.js）—— 仅测试用，随子进程 --require 加载
 *
 * 通过环境变量启用（全部为模拟/保护用途，不改变产品代码）：
 *   QA_BLOCK_OPTIONAL=@alicloud/green20220302   → 让节点/核心 require.resolve 该包失败（模拟未装可选依赖）
 *   QA_ONLY_PLUGIN=wd14-tagger                  → 让 scanner 读 plugins/ 时只看到 1 个插件目录
 *   QA_GUARD_CONFIG_WRITE=1                     → 拦截对 config/default.json 的写入（保护真实配置）
 *   （默认，无需显式设置）                      → 把 `GRS_AUDIT_DB` / `GRS_BLOB_DIR` /
 *     `GRS_PLUGIN_CONFIG` / `GRS_PLUGIN_STATE` 兜底重定向到 TEMP，
 *     避免任何测试（含它拉起的 server 子进程）在生产建出 `data/audit.db`、往 `data/image_blobs/` 落盘，
 *     或改写用户的 `data/plugin-config.json` / `data/plugins-state.json`（后者记录「哪些插件被启用」，
 *     测试改写会**静默改变用户的插件启用状态**）。
 *     已显式设置该变量的测试不受影响（`if (!process.env.X)` 守卫）。
 *
 * 绝不写盘、绝不修改 config/default.json。
 */

'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ⓿ QA 安全默认：v0.2.0 新增的写路径（审核记录 DB 投影 / 图片内容寻址落盘）
//    + v0.2.0 收尾新增的两个「插件状态」写路径（配置 / 启用状态）。
//    若测试未显式隔离，兜底指向 TEMP —— 「测试不触碰生产」由守卫统一兜底，而非逐个脚本自觉。
// 必须在任何 src 模块被 require 之前生效（本 preload 以 --require 或首个 require 载入）。
(function redirectNewWritePaths() {
  const base = path.join(os.tmpdir(), `grs-qa-${process.pid}`);
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* 忽略 */ }
  if (!process.env.GRS_AUDIT_DB) {
    process.env.GRS_AUDIT_DB = path.join(base, 'audit.db');
  }
  if (!process.env.GRS_BLOB_DIR) {
    process.env.GRS_BLOB_DIR = path.join(base, 'image_blobs');
  }
  // 插件配置（data/plugin-config.json）与插件启用状态（data/plugins-state.json）。
  //   后者尤其关键：测试里 toggle 插件会改写它，从而**静默改变用户真实的插件启用状态**。
  if (!process.env.GRS_PLUGIN_CONFIG) {
    process.env.GRS_PLUGIN_CONFIG = path.join(base, 'plugin-config.json');
  }
  if (!process.env.GRS_PLUGIN_STATE) {
    process.env.GRS_PLUGIN_STATE = path.join(base, 'plugins-state.json');
  }
  // 预建必要目录（blob 目录在 image-ref 侧还会自建；此处仅保证父目录存在）
  try { fs.mkdirSync(process.env.GRS_BLOB_DIR, { recursive: true }); } catch { /* 忽略 */ }
}());

// ① 屏蔽指定可选依赖（模拟「别人电脑没装」）
const blocked = String(process.env.QA_BLOCK_OPTIONAL || '').split(',').map((s) => s.trim()).filter(Boolean);
if (blocked.length > 0) {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function patched(request, ...rest) {
    if (blocked.includes(request)) {
      const err = new Error(`Cannot find module '${request}' (QA simulated missing)`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return orig.call(this, request, ...rest);
  };
}

// ② plugins/ 目录只暴露 1 个插件
const only = process.env.QA_ONLY_PLUGIN;
if (only) {
  const realReaddir = fs.readdirSync;
  fs.readdirSync = function patched(dir, ...rest) {
    const out = realReaddir.call(this, dir, ...rest);
    if (String(dir).replace(/\\/g, '/').endsWith('/plugins') && Array.isArray(out)) {
      return out.filter((n) => (typeof n === 'string' ? n : n.name) === only);
    }
    return out;
  };
}

// ③ 保护真实配置：拦截 config/default.json 写入
if (process.env.QA_GUARD_CONFIG_WRITE === '1') {
  const realWrite = fs.writeFileSync;
  const isCfg = (p) => String(p).replace(/\\/g, '/').endsWith('/config/default.json');
  fs.writeFileSync = function patched(file, ...rest) {
    if (isCfg(file)) return undefined; // 静默吞掉（内存配置已更新，GET 仍能读回）
    return realWrite.call(this, file, ...rest);
  };
  const realRename = fs.renameSync;
  fs.renameSync = function patched(a, b) {
    if (isCfg(b)) return undefined;
    return realRename.call(this, a, b);
  };
  void path;
}
