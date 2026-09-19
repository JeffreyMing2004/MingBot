const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'subscriptions.json');
const COOKIE_FILE = path.join(__dirname, '..', 'cookie.json');
const LAST_FILE = path.join(DATA_DIR, 'last_dynamics.json');
let biliConfig = { cookie: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };
const RSSHUB_INSTANCES = ['https://rsshub.app', 'https://rsshub.rssforever.com'];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadConfig() {
  ensureDataDir();
  if (fs.existsSync(CONFIG_FILE)) { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch(e) { return []; } }
  return [];
}
function saveConfig(data) { ensureDataDir(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2)); }
function loadBiliConfig() {
  ensureDataDir();
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const raw = fs.readFileSync(COOKIE_FILE, 'utf-8').replace(/^\uFEFF/, '');
      const c = JSON.parse(raw);
      biliConfig.cookie = c.cookie || '';
    } catch(e) { console.error('读取cookie.json失败:', e.message); }
  }
  return biliConfig.cookie;
}
function saveBiliConfig(cookie) {
  ensureDataDir();
  biliConfig.cookie = cookie;
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie }, null, 2), 'utf-8');
  console.log('Cookie已保存到cookie.json');
}
function getHeaders(referer) {
  return {
    'User-Agent': biliConfig.userAgent,
    'Referer': referer || 'https://space.bilibili.com/',
    'Accept': 'application/json',
    'Cookie': biliConfig.cookie,
  };
}

/** 解析单条动态内容 */
function parseDynamic(item) {
  const m = item.modules;
  const uid = Number(m.module_author?.mid);
  const name = m.module_author?.name || '未知UP主';
  const ts = m.module_author?.pub_ts || 0;
  const desc = m.module_dynamic?.desc;
  let text = (desc && desc.text) || '';
  let images = [];
  let title = '';
  let dynamicType = item.type;
  const major = m.module_dynamic?.major || {};

  if (major.draw && major.draw.items) {
    images = major.draw.items.map(img => img.orig?.src || img.src || img.url).filter(Boolean);
  }
  if (major.archive) {
    title = major.archive.title || '';
    if (!text) text = (major.archive.desc || '').slice(0, 200);
  }
  if (major.opus) {
    title = major.opus.title || title;
    if (major.opus.summary?.text) text = major.opus.summary.text;
  }
  if (major.none && major.none.content) {
    text = major.none.content;
  }
  // 转发动态：取转发来源
  let originInfo = null;
  if (item.repeat || major.repeat) {
    const rep = item.repeat || major.repeat;
    originInfo = { name: rep.upper?.name || '未知', uid: rep.upper?.mid, content: (rep.desc?.text || '') };
  }

  return {
    dynamicId: item.id_str,
    uid, name, timestamp: ts, type: dynamicType,
    text: text.trim(), images, title, originInfo,
    url: `https://t.bilibili.com/${item.id_str}`,
  };
}

/** 策略1: 官方polymer API（需Cookie） */
async function fetchOfficial(uid) {
  const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}`;
  const res = await fetch(url, { headers: getHeaders(`https://space.bilibili.com/${uid}/dynamic`), signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  if (!text.trim().startsWith('{')) throw new Error('非JSON响应');
  const data = JSON.parse(text);
  if (data.code === -412) throw new Error('API被拦截，Cookie可能过期');
  if (data.code === -799) throw new Error('请求过于频繁');
  if (data.code !== 0) throw new Error(`API错误: ${data.message}`);
  if (!data.data?.items?.length) return null;
  // 跳过置顶动态，取第一条正常动态
  for (const item of data.data.items) {
    if (!item.modules?.module_tag) return parseDynamic(item);
  }
  return data.data.items.length > 0 ? parseDynamic(data.data.items[0]) : null;
}

/** 策略2: RSSHub（无需Cookie，但可能不稳定） */
async function fetchRSSHub(uid) {
  for (const inst of RSSHUB_INSTANCES) {
    try {
      const url = `${inst}/bilibili/user/dynamic/${uid}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml' }, signal: AbortSignal.timeout(8000) });
      if (res.status !== 200) continue;
      const text = await res.text();
      const idMatch = text.match(/<guid[^>]*>([^<]+)/);
      const titleMatch = text.match(/<title>([^<]+)/);
      const linkMatch = text.match(/<link>([^<]+)/);
      const pubMatch = text.match(/<pubDate>([^<]+)/);
      if (!linkMatch) continue;
      const dynId = idMatch ? idMatch[1].split('/').pop().split('?')[0] : linkMatch[1].split('/').pop().split('?')[0];
      return {
        dynamicId: dynId, uid: Number(uid), timestamp: pubMatch ? new Date(pubMatch[1]).getTime() / 1000 : Date.now() / 1000,
        type: 'DYNAMIC_TYPE_UNKNOWN', text: (titleMatch?.[1] || '').trim(), images: [], title: titleMatch?.[1] || '',
        originInfo: null, url: linkMatch[1],
      };
    } catch(e) { continue; }
  }
  throw new Error('所有RSSHub实例不可用');
}

/** 获取UP主最新动态（多策略fallback） */
async function fetchLatestDynamic(uid) {
  const uidStr = String(uid);
  console.log(`[${uidStr}] 检测动态...`);
  // 优先官方API
  if (biliConfig.cookie) {
    try { const r = await fetchOfficial(uid); if (r) return r; }
    catch(e) { console.log(`[${uidStr}] 官方API失败: ${e.message}`); }
  } else {
    console.log(`[${uidStr}] 未配置Cookie，跳过官方API`);
  }
  // 回退RSSHub
  try { return await fetchRSSHub(uid); }
  catch(e) { console.log(`[${uidStr}] RSSHub失败: ${e.message}`); }
  console.log(`[${uidStr}] 所有策略失败`);
  return null;
}

function formatMsg(d, upName) {
  const t = new Date(d.timestamp * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  let msg = `🔔 **${upName} 发布新动态**\n📅 ${t}\n\n`;
  if (d.title) msg += `📺 ${d.title}\n`;
  if (d.text) msg += `${d.text.slice(0, 500)}${d.text.length > 500 ? '...' : ''}\n`;
  if (d.images.length > 0) msg += `🖼️ ${d.images.length}张图片\n`;
  if (d.originInfo) msg += `🔁 转发自 @${d.originInfo.name}\n`;
  msg += `\n🔗 [查看动态](${d.url})`;
  return msg;
}

function startMonitor(bot, intervalMinutes = 5) {
  console.log(`🕐 B站监控启动 (${intervalMinutes}分钟间隔)`);
  loadBiliConfig();
  if (!biliConfig.cookie) console.log('⚠️ 未配置Cookie，将尝试第三方API（成功率较低）');
  let lastDynamics = {};
  try {
    if (fs.existsSync(LAST_FILE)) lastDynamics = JSON.parse(fs.readFileSync(LAST_FILE, 'utf-8'));
  } catch(e) {}
  const check = async () => {
    const subs = loadConfig();
    for (const sub of subs) {
      if (!sub.uid || !sub.guildId || !sub.channelId) continue;
      const uidStr = String(sub.uid);
      try {
        const latest = await fetchLatestDynamic(sub.uid);
        if (!latest) { console.log(`[${sub.name || uidStr}] 暂无动态`); continue; }
        if (latest.dynamicId !== lastDynamics[uidStr]) {
          console.log(`[${sub.name || uidStr}] 新动态: ${latest.dynamicId}`);
          try { await bot.send.channel(sub.channelId, formatMsg(latest, sub.name || uidStr)); }
          catch(e) { console.error('发送失败:', e.message); }
          lastDynamics[uidStr] = latest.dynamicId;
        } else {
          console.log(`[${sub.name || uidStr}] 无更新`);
        }
      } catch(e) { console.error(`[${sub.name || uidStr}] 异常:`, e.message); }
    }
    try { fs.writeFileSync(LAST_FILE, JSON.stringify(lastDynamics, null, 2)); } catch(e) {}
  };
  check();
  return setInterval(check, intervalMinutes * 60 * 1000);
}

function addSub(guildId, channelId, uid, name) {
  const subs = loadConfig();
  const exists = subs.find(s => s.guildId === guildId && String(s.uid) === String(uid));
  if (exists) { Object.assign(exists, { guildId, channelId, uid: Number(uid), name }); }
  else subs.push({ guildId, channelId, uid: Number(uid), name });
  saveConfig(subs);
  return subs;
}
function removeSub(guildId, uid) {
  const subs = loadConfig();
  const idx = subs.findIndex(s => s.guildId === guildId && String(s.uid) === String(uid));
  if (idx !== -1) subs.splice(idx, 1);
  saveConfig(subs);
}
function listSub(guildId) { return loadConfig().filter(s => s.guildId === guildId); }
async function searchUp(keyword) {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(keyword)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.code !== 0 || !data.data?.result?.length) return [];
    return data.data.result.map(u => ({ uid: u.mid, name: u.uname })).slice(0, 10);
  } catch(e) { return []; }
}

function getApiStatus() { return { hasCookie: !!biliConfig.cookie, message: biliConfig.cookie ? "Cookie已配置" : "未配置Cookie，将使用第三方API" }; } function setCookie(cookie) { saveBiliConfig(cookie); } module.exports = { startMonitor, addSub, removeSub, listSub, searchUp, loadBiliConfig, saveBiliConfig, setCookie, getApiStatus, fetchLatestDynamic, formatMsg, CONFIG_FILE, COOKIE_FILE };
