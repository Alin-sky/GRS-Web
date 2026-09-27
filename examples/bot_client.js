/**
 * QQ 机器人审核客户端示例
 *
 * 这个文件展示了如何在 QQ 机器人 Node.js 后端中调用审核服务。
 * 你可以将 ModerationClient 类直接集成到你的机器人项目中。
 */

const MODERATION_HOST = process.env.MODERATION_HOST || 'http://127.0.0.1:11451';

class ModerationClient {
  constructor(host = MODERATION_HOST) {
    this.host = host;
  }

  /**
   * 审核文本消息
   * @param {string} text - 用户输入或机器人输出的文本
   * @param {object} meta - { userId, groupId, messageId }
   * @returns {Promise<object>} 审核结果
   *
   * 返回值示例:
   * {
   *   "passed": true,           // 是否通过审核（action=review 时也为 false，需人工复核）
   *   "action": "pass",         // 处理动作: pass / pass_log / review / block / block_alert
   *   "risk_level": "safe",     // 风险等级: safe / low / medium / review / high / critical
   *                             // 注: review = AI 通道异常未取得有效判定（失败-关闭策略），同样不放行
   *   "categories": [],         // 违规类别: political / pornographic / marketing / violence / gambling / privacy / illegal
   *   "confidence": 0.95,       // 置信度 0-1
   *   "reason": "内容安全",     // 判定理由
   *   "suggestion": "可放行"    // 处理建议
   * }
   */
  async moderateText(text, meta = {}) {
    const res = await fetch(`${this.host}/api/moderate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...meta }),
    });
    if (!res.ok) throw new Error(`审核服务返回 ${res.status}`);
    return res.json();
  }

  /**
   * 审核图片消息
   * @param {string} imageBase64 - base64 编码的图片（可含 data:image/xxx;base64, 前缀）
   * @param {string} text - 附带文字（可选）
   * @param {object} meta - { userId, groupId, messageId }
   * @returns {Promise<object>} 审核结果
   */
  async moderateImage(imageBase64, text = '', meta = {}) {
    const res = await fetch(`${this.host}/api/moderate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageBase64, text, ...meta }),
    });
    if (!res.ok) throw new Error(`审核服务返回 ${res.status}`);
    return res.json();
  }

  /**
   * 综合审核（文本+图片）
   * @param {string} text - 文本内容
   * @param {string[]} images - base64 图片数组
   * @param {object} meta - { userId, groupId, messageId }
   * @returns {Promise<object>} 审核结果
   */
  async moderate(text = '', images = [], meta = {}) {
    const res = await fetch(`${this.host}/api/moderate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, images, ...meta }),
    });
    if (!res.ok) throw new Error(`审核服务返回 ${res.status}`);
    return res.json();
  }

  /**
   * 检查审核服务是否可用
   */
  async health() {
    try {
      const res = await fetch(`${this.host}/health`, { signal: AbortSignal.timeout(3000) });
      return res.json();
    } catch {
      return { status: 'offline' };
    }
  }
}

// ─── 使用示例 ───

async function example() {
  const client = new ModerationClient();

  // 1. 健康检查
  const health = await client.health();
  console.log('审核服务状态:', health.status);

  // 2. 审核用户输入的文本
  const userText = '大家好，欢迎加入群聊！';
  const textResult = await client.moderateText(userText, {
    userId: '123456',
    groupId: '789012',
    messageId: 'msg_001',
  });
  console.log('文本审核结果:', textResult);

  if (!textResult.passed) {
    // 违规内容，拦截处理
    console.log(`[拦截] 用户消息被拦截，原因: ${textResult.reason}`);
    // TODO: 不输出该消息，或返回安全提示
  } else {
    // 安全内容，正常处理
    console.log('[放行] 用户消息安全');
  }

  // 3. 审核机器人输出的文本（入群欢迎语等）
  const welcomeText = `欢迎 @新成员 加入本群！请阅读群规。`;
  const outputResult = await client.moderateText(welcomeText, {
    messageId: 'msg_welcome_001',
  });
  if (!outputResult.passed) {
    console.log('[拦截] 机器人输出内容被拦截，请检查欢迎语配置');
  }

  // 4. 审核图片（示例，实际使用时传入真实 base64）
  // const fs = require('fs');
  // const imageBase64 = fs.readFileSync('test.jpg').toString('base64');
  // const imageResult = await client.moderateImage(imageBase64, '看看这张图', {
  //   userId: '123456',
  //   groupId: '789012',
  // });
  // console.log('图片审核结果:', imageResult);
}

// 运行示例
if (require.main === module) {
  example().catch(console.error);
}

module.exports = ModerationClient;
