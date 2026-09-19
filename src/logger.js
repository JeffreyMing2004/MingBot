/**
 * 统一日志模块
 * 同时输出到控制台和日志文件
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * 格式化时间戳
 */
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 写入日志文件
 */
function writeLog(level, msg) {
  const line = `[${ts()}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) { /* ignore */ }
}

/**
 * 日志级别
 * info  - 一般信息
 * warn  - 警告
 * error - 错误
 * cmd   - 命令执行
 * bili  - B站监控
 * event - 事件触发
 */
function info(msg)  { console.log(`[INFO] ${msg}`);   writeLog('INFO', msg); }
function warn(msg)  { console.warn(`[WARN] ${msg}`);  writeLog('WARN', msg); }
function error(msg) { console.error(`[ERROR] ${msg}`); writeLog('ERROR', msg); }

function cmd(msg)    { console.log(`[CMD ] ${msg}`);    writeLog('CMD ', msg); }
function bili(msg)   { console.log(`[BILI] ${msg}`);   writeLog('BILI', msg); }
function event(msg)  { console.log(`[EVENT] ${msg}`);  writeLog('EVENT', msg); }

module.exports = { info, warn, error, cmd, bili, event };
