/**
 * 配置文件
 * 读取优先级: 环境变量 > config.json > 默认值
 */
const fs = require('fs');
const path = require('path');

const CFG_PATH = path.join(__dirname, '..', 'config.json');
let fileCfg = {};
if (fs.existsSync(CFG_PATH)) {
  try { fileCfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch (e) { console.error('config.json 解析失败:', e.message); }
}

module.exports = {
  appId: process.env.QQ_BOT_APP_ID || fileCfg.appId || 'YOUR_APP_ID',
  token: process.env.QQ_BOT_TOKEN || fileCfg.appSecret || fileCfg.token || 'YOUR_BOT_TOKEN',
  appSecret: process.env.QQ_BOT_APP_SECRET || fileCfg.appSecret || fileCfg.token || '',
  // 沙箱开关：显式设置环境变量时以环境变量为准，否则读 config.json（默认正式环境）
  sandbox: process.env.QQ_BOT_SANDBOX
    ? process.env.QQ_BOT_SANDBOX === 'true'
    : fileCfg.sandbox === true,
  biliCookie: process.env.BILI_COOKIE || '',
  authType: fileCfg.authType || 'bot',
  callbackUrl: process.env.BOT_URL || fileCfg.callbackUrl || 'https://bot.mingpixel.net',
  mode: fileCfg.mode || 'websocket',
};
