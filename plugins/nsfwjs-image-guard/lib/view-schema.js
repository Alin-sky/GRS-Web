/**
 * 参数界面 schema（plugins/nsfwjs-image-guard/lib/view-schema.js）
 *
 * 由 manifest.contributes.views[].schemaResolver = 'viewSchema' 指向，
 * 宿主经 RPC 取回后交给 src/plugin-ui-schema.js 校验并渲染。
 *
 * ★ 单独成模块的原因：视图 schema 需要可单独校验（不装载插件也能跑），
 *   也便于在依赖缺失时被宿主/测试直接引用，避免「装载失败 → 界面完全空白」。
 * ★ 只用宿主既有控件类型，不新增控件；文案中不含任何图片内容。
 */
'use strict';

/**
 * 构造视图 schema。
 * @param {{ready: boolean, notReadyMessage?: string, installHint?: string, availableBackends?: string[]}} status 插件状态
 * @param {string} nodeRef 节点 ref
 * @returns {object} 视图 schema（version 1）
 */
function buildViewSchema(status = {}, nodeRef = 'plugin.nsfwjs-image-guard.image') {
  const st = status && typeof status === 'object' ? status : {};
  const levelOptions = [
    { value: 'safe', label: 'safe' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
    { value: 'critical', label: 'critical' },
  ];
  return {
    version: 1,
    state: {},
    sections: [
      {
        id: 'readiness',
        title: '① 运行状态',
        icon: '🧪',
        collapsible: false,
        fields: [
          {
            type: 'alert',
            tone: st.ready ? 'info' : 'warn',
            content: st.ready
              ? `依赖已就绪（后端：${(st.availableBackends || []).join(' / ') || '未知'}）。节点 ref：\`${nodeRef}\``
              : `插件未就绪：${st.notReadyMessage || '未知原因'}。安装命令：\`${st.installHint || 'npm i nsfwjs @tensorflow/tfjs-node'}\``,
          },
          { type: 'badge', bind: 'config.enabled', label: '启用状态' },
          { type: 'code-view', bind: 'state.selfTest', label: '自检结果', language: 'json' },
        ],
      },
      {
        id: 'params',
        title: '② 判定参数',
        icon: '🎚️',
        collapsible: false,
        fields: [
          { type: 'switch', bind: 'config.enabled', label: '启用 nsfwjs 审图节点', default: true },
          { type: 'slider', bind: 'config.threshold', label: '判定阈值', min: 0, max: 1, step: 0.05, default: 0.6 },
          { type: 'number', bind: 'config.topK', label: '取前 K 个预测', min: 1, max: 5, default: 3 },
          {
            type: 'select',
            bind: 'config.backend',
            label: '计算后端',
            default: 'tfjs-node',
            options: [
              { value: 'tfjs-node', label: 'tfjs-node（原生，推荐）' },
              { value: 'tfjs', label: 'tfjs（纯 JS 回退）' },
            ],
          },
          { type: 'text', bind: 'config.modelPath', label: '自定义模型路径/URL', placeholder: 'file:///… 或 https://…' },
        ],
      },
      {
        id: 'mapping',
        title: '③ 类别 → 风险等级映射',
        icon: '🗺️',
        collapsible: true,
        fields: [
          { type: 'select', bind: 'config.level.Porn', label: 'Porn', default: 'high', options: levelOptions },
          { type: 'select', bind: 'config.level.Hentai', label: 'Hentai', default: 'high', options: levelOptions },
          { type: 'select', bind: 'config.level.Sexy', label: 'Sexy', default: 'medium', options: levelOptions },
          { type: 'select', bind: 'config.level.Drawing', label: 'Drawing', default: 'safe', options: levelOptions },
          { type: 'select', bind: 'config.level.Neutral', label: 'Neutral', default: 'safe', options: levelOptions },
          {
            type: 'alert',
            tone: 'info',
            content: '多个类别同时过阈值时取**最严重**者；`review` 不是内容判定结果，配置中不会出现该选项。',
          },
        ],
      },
    ],
    actions: [
      {
        id: 'selftest',
        type: 'button',
        label: '▶ 运行自检（合成图，不读磁盘）',
        style: 'primary',
        rpc: 'nsfwjs.selfTest',
        onSuccess: [{ set: { 'state.selfTest': '$result' } }],
      },
    ],
  };
}

module.exports = { buildViewSchema };
