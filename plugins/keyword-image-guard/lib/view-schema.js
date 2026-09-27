/**
 * 参数界面 schema（plugins/keyword-image-guard/lib/view-schema.js）
 *
 * 由 manifest.contributes.views[].schemaResolver = 'viewSchema' 指向，
 * 宿主经 RPC 取回后交给 src/plugin-ui-schema.js 校验并渲染。
 * 单独成模块便于单测；只使用宿主既有控件类型，不新增控件。
 */
'use strict';

/**
 * 构造视图 schema。
 * @param {{ready: boolean, notReadyMessage?: string, ruleCount?: number, precheckAvailable?: boolean}} status 插件状态
 * @param {string} nodeRef 节点 ref
 * @returns {object} 视图 schema（version 1）
 */
function buildViewSchema(status = {}, nodeRef = 'plugin.keyword-image-guard.image') {
  const st = status && typeof status === 'object' ? status : {};
  return {
    version: 1,
    state: {},
    sections: [
      {
        id: 'readiness',
        title: '① 运行状态',
        icon: '🔑',
        collapsible: false,
        fields: [
          {
            type: 'alert',
            tone: st.ready ? 'info' : 'warn',
            content: st.ready
              ? `规则 ${st.ruleCount || 0} 条；宿主预检 API：${st.precheckAvailable ? '可用' : '不可用'}。节点 ref：\`${nodeRef}\``
              : `插件未就绪：${st.notReadyMessage || '未知原因'}。`,
          },
          { type: 'badge', bind: 'config.enabled', label: '启用状态' },
          { type: 'stat-cards', bind: 'state.stats' },
        ],
      },
      {
        id: 'rules',
        title: '② 规则表',
        icon: '📝',
        collapsible: false,
        fields: [
          {
            type: 'alert',
            tone: 'info',
            content: '每行一条：`等级|模式|类型|分类|说明`。等级取 `low/medium/high/critical`；类型取 `plain`（默认，纯文本）或 `regex`；`#` 开头为注释。**规则表内请勿填写真实敏感词条**，此处仅用于业务自定义词表。',
          },
          { type: 'textarea', bind: 'config.rulesText', label: '规则表', rows: 12, placeholder: 'high|示例关键词A|plain|pornographic|示例规则' },
          { type: 'text', bind: 'config.defaultCategoryId', label: '默认分类 id', placeholder: 'illegal' },
          { type: 'number', bind: 'config.maxHits', label: '最多记录命中数', min: 1, max: 200, default: 50 },
        ],
      },
      {
        id: 'behavior',
        title: '③ 判定行为',
        icon: '⚙️',
        collapsible: true,
        fields: [
          {
            type: 'select',
            bind: 'config.ruleSource',
            label: '规则来源',
            default: 'both',
            options: [
              { value: 'plugin', label: '仅插件内规则' },
              { value: 'precheck', label: '仅宿主预检 API（词库不出库）' },
              { value: 'both', label: '两者都用（取最严重）' },
            ],
          },
          { type: 'switch', bind: 'config.criticalShortCircuit', label: '命中最高级即短路', default: true },
          { type: 'switch', bind: 'config.ignoreCase', label: '忽略大小写', default: true },
          {
            type: 'select',
            bind: 'config.levelFloor',
            label: '命中后至少抬升到',
            default: 'medium',
            options: [
              { value: 'low', label: 'low' },
              { value: 'medium', label: 'medium' },
              { value: 'high', label: 'high' },
              { value: 'critical', label: 'critical' },
            ],
          },
        ],
      },
      {
        id: 'sources',
        title: '④ 匹配来源默认值',
        icon: '🧭',
        collapsible: true,
        fields: [
          {
            type: 'checkbox-group',
            bind: 'config.sources',
            label: '默认识别来源',
            selectAll: true,
            options: [
              { value: 'filename', label: '文件名' },
              { value: 'exif', label: 'EXIF / 元数据' },
              { value: 'caption', label: '附带文本' },
              { value: 'upstreamTags', label: '上游标签' },
            ],
          },
          { type: 'number', bind: 'config.maxTagCount', label: '最多检查上游标签数', min: 1, max: 200, default: 50 },
        ],
      },
    ],
    actions: [
      {
        id: 'reloadRules',
        type: 'button',
        label: '⟳ 重新编译规则表',
        style: 'primary',
        rpc: 'keywordImageGuard.reloadRules',
        onSuccess: [{ set: { 'state.stats': '$result' } }],
      },
    ],
  };
}

module.exports = { buildViewSchema };
