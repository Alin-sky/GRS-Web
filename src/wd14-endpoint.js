/**
 * WD14 标签服务地址解析（T08a「单一真相」）。
 * 病根：同一地址曾有两个口径 —— `/api/plugins` 读站点配置 `config.wd14.host`（自带默认值，显得
 * "已配置"），而 `plugins/wd14-tagger` 的 `tag:`/`health:` 读插件自身 `config.host`；两者不一致时
 * UI 显示与实际调用会打到不同地址。本模块是**唯一**解析点，顺序与插件侧取值方向一致：
 * ① `nodeParams.host` → ② 插件配置 `wd14-tagger.host` → ③ 站点 `config.wd14.host` → ④ 内置默认。
 * 边界：`plugins/**` 禁止 `require('../src/...')`，故插件不引用本模块 —— 插件侧 `config.host`
 * 本身即第 ② 级来源，核心按同一顺序取值即可与之一致。
 */

'use strict';

/** 内置默认地址（与 `plugins/wd14-tagger` CONFIG_SCHEMA 的 host 默认值一致）。*/
const DEFAULT_WD14_HOST = 'http://127.0.0.1:9898';

/** 解析地址，返回 `{host, source}`（source 标出命中哪一级，便于排查）。*/
function resolveWd14Endpoint(sources = {}) {
  const order = [
    ['node-params', sources.nodeParams && sources.nodeParams.host],
    ['plugin-config', sources.pluginHost],
    ['site-config', sources.siteHost],
  ];
  for (const [source, raw] of order) {
    if (typeof raw === 'string' && raw.trim()) return { host: raw.trim(), source };
  }
  return { host: DEFAULT_WD14_HOST, source: 'default' };
}

/** 便捷入口：从站点配置 `config.wd14` + 插件配置对象解析。*/
function resolveWd14From(siteWd14Cfg, pluginCfg, nodeParams) {
  const siteHost = siteWd14Cfg && typeof siteWd14Cfg === 'object' ? siteWd14Cfg.host : undefined;
  const pluginHost = pluginCfg && typeof pluginCfg === 'object' ? pluginCfg.host : undefined;
  return resolveWd14Endpoint({ nodeParams, pluginHost, siteHost });
}

module.exports = { DEFAULT_WD14_HOST, resolveWd14Endpoint, resolveWd14From };
