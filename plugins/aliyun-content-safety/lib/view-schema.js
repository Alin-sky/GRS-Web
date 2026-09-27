/**
 * 参数界面 schema（plugins/aliyun-content-safety/lib/view-schema.js）
 *
 * 由 manifest.contributes.views[].schemaResolver = 'viewSchema' 指向。
 * ★ 本插件**不复制**核心的 `contentSafety.*` 开关与密钥（单一真相源原则），
 *   因此这里以「只读状态 + 可执行指引」为主，仅暴露两个插件范围内的性能项。
 */
'use strict';

/**
 * 构造视图 schema。
 * @param {object} status 插件状态
 * @param {{text: string, image: string}} refs 节点 ref
 * @returns {object} 视图 schema（version 1）
 */
function buildViewSchema(status = {}, refs = {}) {
  const st = status && typeof status === 'object' ? status : {};
  const textRef = (refs && refs.text) || 'plugin.aliyun-content-safety.text';
  const imageRef = (refs && refs.image) || 'plugin.aliyun-content-safety.image';
  const fix = st.notReadyReason === 'missing-deps'
    ? `安装依赖：\`${st.installHint || 'npm i @alicloud/green20220302'}\``
    : st.notReadyReason === 'not-configured'
      ? '到「审核配置 → 阿里云内容安全配置」填写 AccessKey（accessKeyId / accessKeySecret）'
      : st.notReadyReason === 'disabled'
        ? '到「审核配置 → 阿里云内容安全配置」开启内容安全'
        : '无需处理';

  return {
    version: 1,
    state: {},
    sections: [
      {
        id: 'readiness',
        title: '① 运行状态',
        icon: '☁️',
        collapsible: false,
        fields: [
          {
            type: 'alert',
            tone: st.ready ? 'info' : 'warn',
            content: st.ready
              ? `已就绪：SDK 已安装、AccessKey 已配置。文本节点 ${st.textEnabled ? '可用' : '已关闭'}，图片节点 ${st.imageEnabled ? '可用' : '已关闭'}。`
              : `未就绪：${st.notReadyMessage || '未知原因'}。修复方式：${fix}`,
          },
          { type: 'badge', bind: 'config.cacheEnabled', label: '文本缓存' },
          { type: 'stat-cards', bind: 'state.selfTest' },
          { type: 'code-view', bind: 'state.config', label: '当前生效配置（不含密钥）', language: 'json' },
          {
            type: 'alert',
            tone: 'info',
            content: `节点 ref：\`${textRef}\`（文本）、\`${imageRef}\`（图片）。本插件不提供内容安全的开关与密钥项——它们以 \`config.contentSafety.*\` 为唯一真相源，请到「审核配置 → 阿里云内容安全配置」维护，避免出现两份互相抵消的配置。`,
          },
        ],
      },
      {
        id: 'perf',
        title: '② 插件范围配置',
        icon: '🎚️',
        collapsible: false,
        fields: [
          { type: 'switch', bind: 'config.cacheEnabled', label: '启用文本结果缓存（24h 内相同文本复用）', default: true },
          { type: 'switch', bind: 'config.logLabels', label: '判定理由中列出命中的绿网标签 id', default: false },
          {
            type: 'alert',
            tone: 'info',
            content: '节点级参数（超时、最长送审字符数、服务建议 → 风险等级映射、图片是否同时提交附带文本）在**画布的节点参数抽屉**里调整，不在此处重复。',
          },
        ],
      },
      {
        id: 'cost',
        title: '③ 成本提示',
        icon: '💰',
        collapsible: true,
        fields: [
          {
            type: 'alert',
            tone: 'warn',
            content: '绿网按次计费：文本服务数 × 调用次数 即为计费次数。缓存能显著降低成本；并行扇出会成倍增加调用次数，请在拓扑上按需连线。',
          },
        ],
      },
    ],
    actions: [
      {
        id: 'selftest',
        type: 'button',
        label: '▶ 连通性自检（中性样本，不走缓存）',
        style: 'primary',
        rpc: 'aliyunContentSafety.selfTest',
        onSuccess: [{ set: { 'state.selfTest': '$result' } }],
      },
      {
        id: 'refresh',
        type: 'button',
        label: '⟳ 刷新状态',
        rpc: 'aliyunContentSafety.config',
        onSuccess: [{ set: { 'state.config': '$result' } }],
      },
      {
        id: 'clearCache',
        type: 'button',
        label: '清空文本缓存',
        rpc: 'aliyunContentSafety.clearCache',
        onSuccess: [{ set: { 'state.selfTest': '$result' } }],
      },
    ],
  };
}

module.exports = { buildViewSchema };
