/**
 * 轻量进程管理器 - 替代 pm2
 * 支持自动重启、日志轮转、优雅退出
 */
const { spawn, fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  script: path.join(__dirname, 'src', 'index.js'),
  name: 'mingbot',
  maxRestarts: 10,
  restartDelay: 3000,
  logsDir: path.join(__dirname, 'logs'),
  env: {
    NODE_ENV: process.env.NODE_ENV || 'production',
    QQ_BOT_SANDBOX: process.env.QQ_BOT_SANDBOX || 'true',
  },
};

// 确保目录存在
fs.mkdirSync(CONFIG.logsDir, { recursive: true });

let restartCount = 0;
let childProcess = null;
let isGracefulShutdown = false;

function log(msg, type = 'info') {
  const timestamp = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
  const logMsg = `[${timestamp}] [${type.toUpperCase()}] ${msg}`;
  console.log(logMsg);
  // 写入日志文件
  const logFile = path.join(CONFIG.logsDir, `${CONFIG.name}-${type}.log`);
  fs.appendFileSync(logFile, logMsg + '\n');
}

function start() {
  if (isGracefulShutdown) return;

  childProcess = spawn(process.execPath, [CONFIG.script], {
    cwd: __dirname,
    env: { ...process.env, ...CONFIG.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  childProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) log(text, 'out');
  });

  childProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) log(text, 'error');
  });

  childProcess.on('close', (code, signal) => {
    childProcess = null;
    if (isGracefulShutdown) {
      log(`进程已正常退出 (code=${code}, signal=${signal})`, 'info');
      return;
    }

    if (code === 0) {
      log('机器人已正常关闭', 'info');
      return;
    }

    restartCount++;
    if (restartCount >= CONFIG.maxRestarts) {
      log(`重启次数已达上限 (${CONFIG.maxRestarts})，停止自动重启`, 'error');
      process.exit(1);
    }

    log(`进程异常退出 (code=${code})，${CONFIG.restartDelay / 1000}秒后重启... (第${restartCount}次)`, 'warn');
    setTimeout(start, CONFIG.restartDelay);
  });

  childProcess.on('error', (err) => {
    log(`启动失败: ${err.message}`, 'error');
    setTimeout(start, CONFIG.restartDelay);
  });

  log(`[${CONFIG.name}] 已启动 (PID: ${childProcess.pid})`, 'info');
}

function stop() {
  isGracefulShutdown = true;
  if (childProcess) {
    log('正在停止进程...', 'info');
    childProcess.kill('SIGTERM');
    // 3秒后强制终止
    setTimeout(() => {
      if (childProcess && !childProcess.killed) {
        log('进程未响应，强制终止', 'warn');
        childProcess.kill('SIGKILL');
      }
    }, 3000);
  } else {
    log('没有运行中的进程', 'info');
  }
}

function status() {
  if (childProcess && !childProcess.killed) {
    console.log(`[✅] ${CONFIG.name} 运行中 (PID: ${childProcess.pid})`);
    console.log(`   重启次数: ${restartCount}`);
    console.log(`   日志目录: ${CONFIG.logsDir}`);
  } else {
    console.log(`[❌] ${CONFIG.name} 未运行`);
    console.log(`   最后重启次数: ${restartCount}`);
  }
}

// 处理信号
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

// CLI 参数
const args = process.argv.slice(2);
if (args[0] === 'stop') {
  stop();
} else if (args[0] === 'status') {
  status();
} else if (args[0] === 'logs') {
  // 实时查看日志
  const logFile = path.join(CONFIG.logsDir, `${CONFIG.name}-out.log`);
  if (fs.existsSync(logFile)) {
    const tail = fs.createReadStream(logFile, { start: Math.max(0, fs.statSync(logFile).size - 4096) });
    tail.pipe(process.stdout);
  } else {
    console.log('暂无日志');
  }
  process.on('SIGINT', () => process.exit(0));
} else {
  // 默认启动
  start();
}
