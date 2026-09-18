/**
 * 配置文件
 * 包含 QQ Bot 凭证及 B站 Cookie 配置
 */

module.exports = {
  // 机器人 AppID (在 QQ 开放平台获取)
  appId: process.env.QQ_BOT_APP_ID || 'YOUR_APP_ID',

  // 机器人 Token (在 QQ 开放平台获取)
  token: process.env.QQ_BOT_TOKEN || 'YOUR_BOT_TOKEN',

  // 是否使用沙箱环境
  sandbox: process.env.QQ_BOT_SANDBOX !== 'false',

  // B站 Cookie (用于绕过API反爬限制 / 获取会员动态)
  biliCookie: process.env.BILI_COOKIE || '',
};
