/**
 * B站动态监控模块
 * 支持多种 API 策略和第三方备用方案
 */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'subscriptions.json');
const CONFIG_BILI_FILE = path.join(DATA_DIR, 'bilibili_config.json');
let biliConfig = { cookie: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };
const RSSHUB_INSTANCES = [
  'https://rsshub.app',
  'https://rsshub.rssforever.com',
  'https://rss.shab.fun',
];

function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function loadConfig() { ensureDataDir(); if (fs.existsSync(CONFIG_FILE)) { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch(e) { return []; } } return []; }
function saveConfig(data) { ensureDataDir(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2)); }
function loadBiliConfig() { ensureDataDir(); if (fs.existsSync(CONFIG_BILI_FILE)) { try { const c = JSON.parse(fs.readFileSync(CONFIG_BILI_FILE, 'utf-8')); biliConfig = { ...biliConfig, ...c }; } catch(e) {} } return biliConfig; }
function saveBiliConfig(cfg) { ensureDataDir(); biliConfig = { ...biliConfig, ...cfg }; fs.writeFileSync(CONFIG_BILI_FILE, JSON.stringify(biliConfig, null, 2)); }

function getHeaders(referer) {
  const c = loadBiliConfig();
  return { 'User-Agent': c.userAgent, 'Referer': referer || 'https://space.bilibili.com/', 'Accept': 'application/json' };
}

/**
 * 获取用户最新动态 - 多策略
 */
async function fetchLatestDynamic(uid) {
  const uidStr = String(uid);
  console.log(`[${uidStr}] 开始检测...`);
  
  // 策略1: 官方 polymer API (需Cookie)
  if (biliConfig.cookie) {
    try {
      console.log(`[${uidStr}] 策略1: 官方API...`);
      const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uidStr}`;
      const res = await fetch(url, { headers: getHeaders(`https://space.bilibili.com/${uidStr}/dynamic`) });
      const text = await res.text();
      if (!text.trim().startsWith('{')) throw new Error('非JSON响应');
      const data = JSON.parse(text);
      if (data.code === -412) throw new Error('API被拦截(412)');
      if (data.code === -799) throw new Error('请求频繁(799)');
      if (data.code !== 0) throw new Error(`API错误: ${data.message}`);
      if (!data.data?.items?.length) return null;
      const item = data.data.items[0];
      const m = item.modules;
      if (!m?.module_author || !m?.module_dynamic) return null;
      const desc = m.module_dynamic.desc;
      let content = desc?.text || '';
      if (m.module_dynamic.major?.opus?.summary?.text) content = m.module_dynamic.major.opus.summary.text;
      const images = m.module_dynamic.major?.opus?.pics?.map(p => p.url) || [];
      console.log(`[${uidStr}] 官方API成功`);
      return { dynamicId: item.id_str, uid: Number(m.module_author.mid), timestamp: m.module_author.pub_ts, content: content.trim(), images, url: `https://t.bilibili.com/${item.id_str}`, name: m.module_author.name };
    } catch(e) { console.log(`[${uidStr}] 官方API失败: ${e.message}`); }
  }
  
  // 策略2: RSSHub (公共实例)
  for (const instance of RSSHUB_INSTANCES) {
    try {
      console.log(`[${uidStr}] 策略2: ${instance}...`);
      const url = `${instance}/bilibili/user/dynamic/${uidStr}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'RssHub/2.0', 'Accept': 'application/rss+xml' }, signal: AbortSignal.timeout(10000) });
      if (res.status !== 200) continue;
      const text = await res.text();
      const linkMatch = text.match(/<link>([^<]+)<\/link>/);
      const titleMatch = text.match(/<title>([^<]+)<\/title>/);
      if (!linkMatch) continue;
      console.log(`[${uidStr}] RSSHub成功`);
      return { dynamicId: linkMatch[1]?.split('/').pop(), uid: Number(uidStr), timestamp: Date.now()/1000, content: titleMatch?.[1] || '', images: [], url: linkMatch[1] };
    } catch(e) { console.log(`[${uidStr}] RSSHub失败: ${e.message.slice(0,20)}`); }
  }
  
  // 策略3: 旧版API
  try {
    console.log(`[${uidStr}] 策略3: 旧版API...`);
    const url = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${uidStr}&offset_dynamic_id=0&need_top=1&platform=web`;
    const res = await fetch(url, { headers: getHeaders(`https://space.bilibili.com/${uidStr}`) });
    const text = await res.text();
    if (!text.trim().startsWith('{')) throw new Error('非JSON');
    const data = JSON.parse(text);
    if (data.code === -412) throw new Error('API被拦截');
    if (!data.data?.cards?.length) return null;
    const card = JSON.parse(data.data.cards[0].card);
    console.log(`[${uidStr}] 旧版API成功`);
    return {
      dynamicId: data.data.cards[0].desc.dynamic_id_str,
      uid: Number(uidStr),
      timestamp: data.data.cards[0].desc.timestamp,
      content: (card.item?.description || card.content || '').trim(),
      images: card.item?.pictures?.map(p => p.img_src) || [],
      url: `https://t.bilibili.com/${data.data.cards[0].desc.dynamic_id_str}`,
    };
  } catch(e) { console.log(`[${uidStr}] 旧版API失败: ${e.message}`); }
  
  console.log(`[${uidStr}] 所有策略失败，请配置Cookie或检查网络`);
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
  loadBiliConfig();
  if (!biliConfig.cookie) console.log('⚠️ 未配置Cookie，将尝试第三方API（成功率较低）');
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
    const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(keyword)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://search.bilibili.com/' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.code !== 0 || !data.data?.result?.length) return [];
    return data.data.result.map(u => ({ uid: u.mid, name: u.uname })).slice(0, 10);
  } catch(e) { return []; }
}

function setCookie(cookie) { saveBiliConfig({ cookie }); console.log('✅ Cookie已更新'); }
function getConfig() { return loadBiliConfig(); }
function getApiStatus() {
  return {
    hasCookie: biliConfig.cookie && biliConfig.cookie.length > 10,
    cookieLength: biliConfig.cookie?.length || 0,
    message: biliConfig.cookie ? '已配置Cookie，可使用官方API' : '未配置Cookie，将尝试第三方API（成功率较低）',
  };
}

module.exports = { startMonitor, addSub, removeSub, listSub, searchUp, loadConfig, saveConfig, fetchLatestDynamic, formatMsg, setCookie, getConfig, getApiStatus };