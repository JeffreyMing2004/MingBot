const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'subscriptions.json');
const COOKIE_FILE = path.join(__dirname, '..', 'cookie.json');
const LAST_FILE = path.join(DATA_DIR, 'last_dynamics.json');
let biliConfig = { cookie: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };
const log = require('./logger');
const server = require('./server');
const RSSHUB_INSTANCES = ['https://rsshub.app', 'https://rsshub.rssforever.com'];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
// 订阅目标统一为 {targetType: 'group'|'channel', targetId}；旧数据（只有guildId/channelId）按频道处理
function normalizeSub(s) {
  return {
    ...s,
    targetType: s.targetType || (s.channelId ? 'channel' : 'group'),
    targetId: s.targetId || s.channelId || s.groupOpenid || '',
  };
}
function sameTarget(a, b) {
  return a.targetType === b.targetType && a.targetId === b.targetId;
}
function targetLabel(t) {
  return t.targetType === 'group' ? `群聊 ${t.targetId}` : `频道 <#${t.targetId}>`;
}
function loadConfig() {
  ensureDataDir();
  if (fs.existsSync(CONFIG_FILE)) { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')).map(normalizeSub); } catch(e) { return []; } }
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
    } catch(e) { log.error('读取cookie.json失败: ' + e.message) }
  }
  return biliConfig.cookie;
}
function saveBiliConfig(cookie) {
  ensureDataDir();
  biliConfig.cookie = cookie;
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie }, null, 2), 'utf-8');
  log.info('Cookie已保存到cookie.json')
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
    images = major.draw.items.map(img => img.src || img.orig?.src || img.url).filter(Boolean);
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
/** 获取单条动态详情（补全 feed API 缺失的文字/图片） */
async function fetchDynamicDetail(dynamicId) {
  const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${dynamicId}`;
  const res = await fetch(url, { headers: getHeaders(`https://t.bilibili.com/${dynamicId}`), signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  if (data.code !== 0) return null;
  const item = data.data?.item;
  if (!item) return null;
  const desc = item.modules?.module_dynamic?.desc;
  const text = desc?.text || '';
  return { text };
}

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
  // 跳过置顶动态，取第一条正常动态（如果 feed API 返回空内容，用 detail API 补全）
  for (const item of data.data.items) {
    if (item.modules?.module_tag?.text === '置顶') continue;
    const parsed = parseDynamic(item);
    if (!parsed.text && !parsed.title && parsed.images.length === 0) {
      try {
        const detail = await fetchDynamicDetail(parsed.dynamicId);
        if (detail?.text) parsed.text = detail.text;
      } catch(e) { /* ignore */ }
    }
    return parsed;
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
  log.bili(`[${uidStr}] 检测动态...`);
  // 优先官方API
  if (biliConfig.cookie) {
    try { const r = await fetchOfficial(uid); if (r) return r; }
    catch(e) { log.warn(`[${uidStr}] 官方API失败: ${e.message}`); }
  } else {
    log.bili(`[${uidStr}] 未配置Cookie，跳过官方API`);
  }
  // 回退RSSHub
  try { return await fetchRSSHub(uid); }
  catch(e) { log.warn(`[${uidStr}] RSSHub失败: ${e.message}`); }
  log.bili(`[${uidStr}] 所有策略失败`);
  return null;
}

function formatMsg(d, upName) {
  const t = new Date(d.timestamp * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  let msg = `🔔 ${upName} 发布新动态\n📅 ${t}\n`;
  if (d.title) msg += `📺 ${d.title}\n`;
  if (d.text) msg += `${d.text.slice(0, 500)}${d.text.length > 500 ? '...' : ''}\n`;
  if (d.images.length > 0) msg += `🖼️ ${d.images.length}张图片\n`;
  if (d.originInfo) msg += `🔁 转发自 @${d.originInfo.name}\n`;
  msg += `🔗 ${d.url}`;
  return msg;
}

function startMonitor(bot, intervalMinutes = 5, sendFn = null) {
  log.bili(`B站监控启动 (${intervalMinutes}分钟间隔)`);
  loadBiliConfig();
  if (!biliConfig.cookie) log.warn('未配置Cookie，将尝试第三方API（成功率较低）');
  let lastDynamics = {};
  try {
    if (fs.existsSync(LAST_FILE)) lastDynamics = JSON.parse(fs.readFileSync(LAST_FILE, 'utf-8'));
  } catch(e) {}
  const check = async () => {
    const subs = loadConfig();
    for (const sub of subs) {
      if (!sub.uid || !sub.targetId) continue;
      const uidStr = String(sub.uid);
      try {
        const latest = await fetchLatestDynamic(sub.uid);
        if (!latest) { log.bili(`[${sub.name || uidStr}] 暂无动态`); continue; }
        if (latest.dynamicId !== lastDynamics[uidStr]) {
          log.bili(`[${sub.name || uidStr}] 新动态: ${latest.dynamicId} title="${latest.title || (latest.text && latest.text.slice(0,30))}"`);
          const _send = sendFn || (bot && bot.send && bot.send.channel ? (t, text) => bot.send.channel(t.targetId, text) : null);
          if (!_send) { log.error(`[B站监控] 无可用的消息发送函数，跳过发送`); continue; }
          try {
            await _send(sub, formatMsg(latest, sub.name || uidStr));
            // 发送图片（如果有）
            if (latest.images && latest.images.length > 0 && sub.targetType === 'group') {
              const maxImg = Math.min(latest.images.length, 3); // 最多发3张
              for (let i = 0; i < maxImg; i++) {
                try {
                  const fileInfo = await server.uploadGroupImage(sub.targetId, latest.images[i]);
                  if (fileInfo?.file_uuid) {
                    await server.sendGroupImage(sub.targetId, fileInfo.file_uuid);
                  }
                } catch (imgErr) {
                  log.warn('[' + (sub.name || uidStr) + '] 图片发送失败: ' + imgErr.message);
                }
              }
            }
          }
          catch(e) { log.error(`发送动态到 ${targetLabel(sub)} 失败: ${e.message}`); }
          lastDynamics[uidStr] = latest.dynamicId;
        } else {
          log.bili(`[${sub.name || uidStr}] 无更新`);
        }
      } catch(e) { log.error(`[${sub.name || uidStr}] 异常: ${e.message}`); }
    }
    try { fs.writeFileSync(LAST_FILE, JSON.stringify(lastDynamics, null, 2)); } catch(e) {}
  };
  check();
  return setInterval(check, intervalMinutes * 60 * 1000);
}

// target 形如 {targetType: 'group'|'channel', targetId}
function addSub(target, uid, name) {
  const subs = loadConfig();
  const exists = subs.find(s => sameTarget(s, target) && String(s.uid) === String(uid));
  if (exists) { Object.assign(exists, { ...target, uid: Number(uid), name }); }
  else subs.push({ ...target, uid: Number(uid), name });
  saveConfig(subs);
  return subs;
}
function removeSub(target, uid) {
  const subs = loadConfig();
  const idx = subs.findIndex(s => sameTarget(s, target) && String(s.uid) === String(uid));
  if (idx !== -1) subs.splice(idx, 1);
  saveConfig(subs);
}
function listSub(target) { return loadConfig().filter(s => sameTarget(s, target)); }
/** 搜索UP主（接口有瞬时风控抖动，带Cookie+重试） */
async function searchUp(keyword) {
  if (!biliConfig.cookie) loadBiliConfig();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(keyword)}`, {
        headers: getHeaders('https://search.bilibili.com/'),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.code !== 0) throw new Error(`code=${data.code}`);
      const list = (data.data?.result || []).map(u => ({ uid: u.mid, name: u.uname, fans: u.fans || 0, sign: u.usign || '' })).slice(0, 10);
      if (list.length) return list;
      log.warn(`[searchUp] 「${keyword}」第${attempt}次为空结果${attempt < 3 ? '，重试' : ''}`);
    } catch (e) {
      log.warn(`[searchUp] 「${keyword}」第${attempt}次失败: ${e.message}${attempt < 3 ? '，重试' : ''}`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 400));
  }
  return [];
}

/** 通过UID反查UP主名称（用户名片接口，需Cookie过-352风控；失败返回null，显示回退为UID:x） */
async function getUpName(uid) {
  if (!biliConfig.cookie) loadBiliConfig();
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${uid}`, {
      headers: getHeaders(`https://space.bilibili.com/${uid}`),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 0) return null;
    return data.data?.card?.name || null;
  } catch (e) { return null; }
}

function getApiStatus() { return { hasCookie: !!biliConfig.cookie, message: biliConfig.cookie ? "Cookie已配置" : "未配置Cookie，将使用第三方API" }; } function setCookie(cookie) { saveBiliConfig(cookie); } module.exports = { startMonitor, addSub, removeSub, listSub, loadConfig, searchUp, getUpName, loadBiliConfig, saveBiliConfig, setCookie, getApiStatus, fetchLatestDynamic, formatMsg, CONFIG_FILE, COOKIE_FILE };
