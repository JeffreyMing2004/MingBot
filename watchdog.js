const { execSync } = require('child_process');
const http = require('http');
function hiddenExec(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const parts = cmd.split(' ');
    const child = spawn(parts[0], parts.slice(1), {
      ...opts,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', d => stdout += d);
    child.on('close', code => resolve({ code, stdout }));
    child.on('error', reject);
  });
}

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'logs', 'watchdog.log');
const CLOUDFLARED = path.join(__dirname, 'cloudflared.exe');
const CLOUDFLARED_YML = path.join(__dirname, 'cloudflared.yml');
const BOT_PORT = 9000;
const CHECK_INTERVAL = 60_000; // 1 minute

function log(msg) {
  const line = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

function isProcessRunning(name) {
  try {
    const out = require('child_process').execSync('tasklist /FI "IMAGENAME eq ' + name + '" /FO CSV /NH', { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return out.includes(name);
  } catch(e) { return false; }
}

function checkBot() {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:' + BOT_PORT + '/api/heartbeat', { timeout: 5000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function startCloudflared() {
  try {
    const { spawn } = require('child_process');
    const child = spawn(CLOUDFLARED, ['tunnel', '--config', CLOUDFLARED_YML, 'run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    log('[WATCHDOG] cloudflared 已启动');
    return true;
  } catch(e) {
    log('[WATCHDOG] cloudflared 启动失败: ' + e.message);
    return false;
  }
}

function restartPM2() {
  try {
    require('child_process').execSync('pm2 restart mingbot', { timeout: 10000, windowsHide: true });
    log('[WATCHDOG] mingbot 已重启');
    return true;
  } catch(e) {
    log('[WATCHDOG] mingbot 重启失败: ' + e.message);
    return false;
  }
}

let lastHeartbeatFail = 0;
let restartCount = 0;

async function check() {
  // 1. Check bot heartbeat
  const hb = await checkBot();
  if (!hb || !hb.ok) {
    lastHeartbeatFail++;
    log('[WATCHDOG] Bot 心跳失败 (连续' + lastHeartbeatFail + '次)');
    if (lastHeartbeatFail >= 3) {
      log('[WATCHDOG] 连续3次心跳失败，重启 bot...');
      if (restartPM2()) {
        lastHeartbeatFail = 0;
        restartCount++;
      }
    }
  } else {
    if (lastHeartbeatFail > 0) {
      log('[WATCHDOG] Bot 心跳恢复正常 (uptime: ' + hb.uptimeStr + ', 内存: ' + hb.memory.rss + 'MB)');
    }
    lastHeartbeatFail = 0;
  }

  // 2. Check cloudflared
  if (!isProcessRunning('cloudflared.exe')) {
    log('[WATCHDOG] cloudflared 未运行，尝试启动...');
    startCloudflared();
  }

  // 3. Write status file for panel
  const status = {
    bot: hb ? { ok: true, uptime: hb.uptimeStr, memory: hb.memory.rss } : { ok: false },
    cloudflared: isProcessRunning('cloudflared.exe'),
    checkTime: Date.now(),
    restartCount,
  };
  try { fs.writeFileSync(path.join(__dirname, 'data', 'watchdog.json'), JSON.stringify(status, null, 2)); } catch(e) {}
}

log('[WATCHDOG] 心跳检测启动 (间隔 ' + (CHECK_INTERVAL / 1000) + '秒)');
check();
setInterval(check, CHECK_INTERVAL);
