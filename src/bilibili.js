const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'subscriptions.json');
const COOKIE_FILE = path.join(__dirname, '..', 'cookie.json');
let biliConfig = { cookie: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };
const RSSHUB_INSTANCES = ['https://rsshub.app', 'https://rsshub.rssforever.com'];

function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function loadConfig() { ensureDataDir(); if (fs.existsSync(CONFIG_FILE)) { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch(e) { return []; } } return []; }
function saveConfig(data) { ensureDataDir(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2)); }
function loadCookie() { if (fs.existsSync(COOKIE_FILE)) { try { const c = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8')); biliConfig.cookie = c.cookie || ''; } catch(e) {} } return biliConfig.cookie; }
function saveCookie(cookie) { const c = { cookie, description: 'B站Cookie' }; fs.writeFileSync(COOKIE_FILE, JSON.stringify(c, null, 2)); biliConfig.cookie = cookie; console.log('✅ Cookie已保存到cookie.json'); }
function getHeaders(referer) { return { 'User-Agent': biliConfig.userAgent, 'Referer': referer || 'https://space.bilibili.com/', 'Accept': 'application/json' }; }

async function fetchLatestDynamic(uid) {
  const uidStr = String(uid);
  console.log(`[${uidStr}] 检测中...`);
  loadCookie();
  
  if (biliConfig.cookie) {
    try {
      console.log(`[${uidStr}] 使用官方API...`);
      const res = await fetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uidStr}`, { headers: getHeaders(`https://space.bilibili.com/${uidStr}/dynamic`) });
      const text = await res.text();
      if (!text.trim().startsWith('{')) throw new Error('非JSON响应');
      const data = JSON.parse(text);
      if (data.code === -412) throw new Error('API被拦截，请检查Cookie是否过期');
      if (data.code === -799) throw new Error('请求频繁，请稍后再试');
      if (data.code !== 0) throw new Error(`API错误: ${data.message}`);
      if (!data.data?.items?.length) return null;
      const item = data.data.items[0];
      const m = item.modules;
      if (!m?.module_author || !m?.module_dynamic) return null;
      const desc = m.module_dynamic.desc;
      let content = desc?.text || '';
      if (m.module_dynamic.major?.opus?.summary?.text) content = m.module_dynamic.major.opus.summary.text;
      const images = m.module_dynamic.major?.opus?.pics?.map(p => p.url) || [];
      console.log(`[${uidStr}] 成功 - ${item.id_str}`);
      return { dynamicId: item.id_str, uid: Number(m.module_author.mid), timestamp: m.module_author.pub_ts, content: content.trim(), images, url: `https://t.bilibili.com/${item.id_str}`, name: m.module_author.name };
    } catch(e) { console.log(`[${uidStr}] 官方API失败: ${e.message}`); }
  } else {
    console.log(`[${uidStr}] 未配置Cookie，尝试RSSHub...`);
  }
  
  for (const inst of RSSHUB_INSTANCES) {
    try {
      const res = await fetch(`${inst}/bilibili/user/dynamic/${uidStr}`, { headers: { 'User-Agent': 'RssHub/2.0', 'Accept': 'application/rss+xml' }, signal: AbortSignal.timeout(8000) });
      if (res.status !== 200) continue;
      const text = await res.text();
      const linkMatch = text.match(/<link>([^<]+)<\/link>/);
      const titleMatch = text.match(/<title>([^<]+)<\/title>/);
      if (!linkMatch) continue;
      console.log(`[${uidStr}] RSSHub成功`);
      return { dynamicId: linkMatch[1]?.split('/').pop(), uid: Number(uidStr), timestamp: Date.now()/1000, content: titleMatch?.[1] || '', images: [], url: linkMatch[1] };
    } catch(e) { continue; }
  }
  
  console.log(`[${uidStr}] 所有API失败`);
  return null;
}

function formatMsg(d, name) {
  const t = new Date(d.timestamp * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  let msg = `🔔 **${name} 发布新动态**\n📅 ${t}\n\n`;
  if (d.content) msg += `${d.content.slice(0, 500)}${d.content.length > 500 ? '...' : ''}\n\n`;
  if (d.images.length > 0) msg += `🖼️ ${d.images.length}张图片\n\n`;
  msg += `🔗 [查看动态](${d.url})`;
  return msg;
}

function startMonitor(client, intervalMinutes = 5) {
  console.log(`🕐 B站监控启动 (${intervalMinutes}分钟)`);
  loadCookie();
  if (!biliConfig.cookie) console.log('⚠️ 未配置Cookie，在cookie.json中设置');
  let lastDynamics = {};
  try { const f = path.join(DATA_DIR, 'last_dynamics.json'); if (fs.existsSync(f)) lastDynamics = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch(e) {}
  
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
          try { await client.postMessage(sub.channelId, formatMsg(latest, sub.name || uidStr)); } catch(e) { console.error('发送失败:', e.message); }
          lastDynamics[uidStr] = latest.dynamicId;
        } else { console.log(`[${sub.name || uidStr}] 无更新`); }
      } catch(e) { console.error(`[${sub.name || uidStr}] 异常:`, e.message); }
    }
    try { fs.writeFileSync(path.join(DATA_DIR, 'last_dynamics.json'), JSON.stringify(lastDynamics, null, 2)); } catch(e) {}
  };
  check();
  return setInterval(check, intervalMinutes * 60 * 1000);
}

function addSub(guildId, channelId, uid, name) {
  const subs = loadConfig();
  const exists = subs.find(s => s.guildId === guildId && String(s.uid) === String(uid));
  if (exists) Object.assign(exists, { guildId, channelId, uid: Number(uid), name });
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
    const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(keyword)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.code !== 0 || !data.data?.result?.length) return [];
    return data.data.result.map(u => ({ uid: u.mid, name: u.uname })).slice(0, 10);
  } catch(e) { return []; }
}

function getConfig() { return { hasCookie: !!biliConfig.cookie, cookieLength: biliConfig.cookie?.length || 0 }; }

module.exports = { startMonitor, addSub, removeSub, listSub, searchUp, loadConfig, saveConfig, fetchLatestDynamic, formatMsg, saveCookie: saveCookie, getConfig, loadCookie: loadCookie, COOKIE_FILE };