/**
 * 配置文件
 * 请复制此文件为 config.local.js 并填入真实配置
 * 正式环境请勿将 token 等敏感信息提交到版本控制
 */

module.exports = {
  // 机器人 AppID (在 QQ 开放平台获取)
  appId: process.env.QQ_BOT_APP_ID || 'YOUR_APP_ID',

  // 机器人 Token (在 QQ 开放平台获取)
  token: process.env.QQ_BOT_TOKEN || 'YOUR_BOT_TOKEN',

  // 是否使用沙箱环境
  // true = 沙箱环境 (开发测试用)
  // false = 正式环境
  sandbox: process.env.QQ_BOT_SANDBOX !== 'false',

  // 可选：Webhook 模式配置 (不使用 WebSocket 时)
  // webhook: {
  //   host: '0.0.0.0',
  //   port: 8080,
  //   path: '/webhook',
  //   secret: 'YOUR_WEBHOOK_SECRET',
  // },

  // 可选：日志级别
  // logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error'
};
