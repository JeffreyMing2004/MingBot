/**
 * 配置文件
 */
module.exports = {
  appId: process.env.QQ_BOT_APP_ID || 'YOUR_APP_ID',
  token: process.env.QQ_BOT_TOKEN || 'YOUR_BOT_TOKEN',
  sandbox: process.env.QQ_BOT_SANDBOX !== 'false',
  biliCookie: process.env.BILI_COOKIE || '',
};