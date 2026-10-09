/**
 * 动态推送历史：所有发过的动态落盘 data/pushed_history.json，
 * 定时自动 commit + push 到 GitHub 仓库（有变化才推，避免空提交）。
 *
 * 只 git add 这一个文件 —— 订阅/cookie/配置等敏感数据在 .gitignore，
 * 永远不碰 git add -A。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const log = require('./logger');

const ROOT = path.join(__dirname, '..');
const HISTORY_FILE = path.join(ROOT, 'data', 'pushed_history.json');
const MAX_RECORDS = 500;      // 仓库里最多保留这么多条（新的在前）

function loadHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

/**
 * 记录一条已推送的动态（新的在前，超上限裁掉最旧的）。
 * target 只存类型 + openid 前 8 位（历史要进公开仓库，别存完整群标识）。
 */
function recordDynamic(uid, name, d, target) {
  try {
    const arr = loadHistory();
    arr.unshift({
      uid: Number(uid) || uid,
      name: String(name || uid || '').slice(0, 50),
      dynamicId: String(d.dynamicId || ''),
      pubTs: d.timestamp || 0,
      pushedAt: Math.floor(Date.now() / 1000),
      title: String(d.title || '').slice(0, 100),
      text: String(d.text || '').replace(/\s+/g, ' ').slice(0, 200),
      images: (d.images || []).length,
      url: d.url || '',
      target: String(target || '').slice(0, 24),
    });
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr.slice(0, MAX_RECORDS), null, 2));
  } catch (e) {
    log.warn('[history] 动态记录写入失败: ' + e.message);
  }
}

// ─── 定时同步到仓库 ───────────────────────────────────────────────────────────
let lastPushedHash = null;   // null = 启动后还没成功推过，首个周期会尝试一次
let pushing = false;

function hashFile() {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(HISTORY_FILE)).digest('hex');
  } catch (e) { return null; }   // 文件还没生成
}

function git(args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd: ROOT, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

/** 把历史文件提交并推送到仓库。没变化/没文件/正在推时直接跳过，失败留给下轮重试 */
async function pushNow() {
  if (pushing) return false;
  const h = hashFile();
  if (!h || h === lastPushedHash) return false;
  pushing = true;
  try {
    await git(['add', 'data/pushed_history.json']);
    // exit code 1 = 暂存区有变化才需要提交；0 = 内容和 HEAD 一致，跳过
    const diff = await git(['diff', '--cached', '--quiet']);
    if (!diff.err) { lastPushedHash = h; return false; }
    const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const cm = await git(['commit', '-m', 'chore(history): 动态推送记录同步 ' + stamp]);
    if (cm.err) {
      log.warn('[history] commit 失败（下轮重试）: ' + (cm.stderr || cm.err.message).slice(0, 120));
      return false;
    }
    let pu = await git(['push', 'origin', 'HEAD']);
    if (pu.err) {
      // 本机代理可能挂了，绕过代理直连重试一次（服务器上无副作用）
      pu = await git(['-c', 'http.proxy=', '-c', 'https.proxy=', 'push', 'origin', 'HEAD']);
    }
    if (pu.err) {
      log.warn('[history] push 失败（下轮重试）: ' + (pu.stderr || pu.err.message).slice(0, 120));
      return false;
    }
    lastPushedHash = h;
    log.info('[history] 动态推送记录已同步到仓库');
    return true;
  } finally {
    pushing = false;
  }
}

/** 启动定时同步。默认每 60 分钟，可用环境变量 HISTORY_PUSH_MINUTES 调整 */
function startAutoPush(minutes) {
  const m = parseInt(minutes || process.env.HISTORY_PUSH_MINUTES, 10) || 60;
  setInterval(() => { pushNow().catch(() => {}); }, m * 60 * 1000);
  // 启动 1 分钟后先试一次：重启期间攒下的记录别等一个整周期
  setTimeout(() => { pushNow().catch(() => {}); }, 60_000);
  log.info(`[history] 动态记录定时同步已启动（每 ${m} 分钟，有变化才推）`);
}

module.exports = { recordDynamic, pushNow, startAutoPush, HISTORY_FILE };
