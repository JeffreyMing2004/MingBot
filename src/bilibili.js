const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'subscriptions.json');
const COOKIE_FILE = path.join(__dirname, '..', 'cookie.json');
const LAST_FILE = path.join(DATA_DIR, 'last_dynamics.json');
const LAST_LIVE_FILE = path.join(DATA_DIR, 'last_live.json');
let biliConfig = { cookie: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };
const log = require('./logger');
const server = require('./server');
const media = require('./media');
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

// ─── 已推送动态去重 ───────────────────────────────────────────────────────────
// 为什么需要：/bili_fetch 之前不查重，每跑一次就把最新动态重发一遍；
// 官方API失败回退RSSHub时，RSS缓存/置顶还可能给出**更旧**的条目 ——
// id不等于基线就被当新动态推送，表现就是"直播结束后把之前的版本再发一遍"。
const PUSHED_FILE = path.join(DATA_DIR, 'pushed_dynamics.json');
const PUSHED_KEEP = 50;   // 每个UP最多记这么多条已推送id

let pushedMap = (() => {
  try { return JSON.parse(fs.readFileSync(PUSHED_FILE, 'utf-8')); } catch(e) { return {}; }
})();

function savePushedMap() {
  ensureDataDir();
  try { fs.writeFileSync(PUSHED_FILE, JSON.stringify(pushedMap)); } catch(e) {}
}

function isDynamicPushed(uid, dynamicId) {
  const u = pushedMap[String(uid)];
  return !!u && !!u[String(dynamicId)];
}

function markDynamicPushed(uid, dynamicId) {
  const u = String(uid);
  const d = String(dynamicId || '');
  if (!u || !d || d === 'undefined') return;
  const m = pushedMap[u] = (pushedMap[u] || {});
  m[d] = Date.now();
  const entries = Object.entries(m).sort((a, b) => b[1] - a[1]);
  if (entries.length > PUSHED_KEEP) pushedMap[u] = Object.fromEntries(entries.slice(0, PUSHED_KEEP));
  savePushedMap();
}

// 基线升级为 {id, ts}（ts=已推送动态的发布时间，秒）。旧格式纯字符串自动迁移。
// ts 用来识别"比已推送的还旧"的回退数据：直接跳过，且不把基线降级到旧的。
let lastDynamics = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(LAST_FILE, 'utf-8'));
    for (const k of Object.keys(raw)) if (typeof raw[k] === 'string') raw[k] = { id: raw[k], ts: 0 };
    return raw;
  } catch(e) { return {}; }
})();

function saveLastDynamics() {
  ensureDataDir();
  try { fs.writeFileSync(LAST_FILE, JSON.stringify(lastDynamics, null, 2)); } catch(e) {}
}

/** 推送完成后记录：入已推送历史 + 前移监控基线（fetch 和监控共用，防止对方再发） */
function recordPushedDynamic(uid, d) {
  const u = String(uid);
  markDynamicPushed(u, d.dynamicId);
  const ts = d.timestamp || Math.floor(Date.now() / 1000);
  const cur = lastDynamics[u];
  if (!cur || ts >= (cur.ts || 0)) lastDynamics[u] = { id: String(d.dynamicId), ts };
  saveLastDynamics();
}

/**
 * 判断该动态是否该推送（监控与 fetch 共用的去重判据）：
 *   已推送过的 id → false；发布时间早于已推送基线（回退源旧数据）→ false
 */
function shouldPushDynamic(uid, d) {
  const u = String(uid);
  if (isDynamicPushed(u, d.dynamicId)) return false;
  const baseline = lastDynamics[u];
  if (baseline?.ts > 0 && d.timestamp > 0 && d.timestamp < baseline.ts) return false;
  return true;
}

// ─── 开播回声静默（移植 bili-notify _silence_after_push）─────────────────────
// 根因链（bili-notify bilibili.py 注释原话："开播卡片动态（B站开播时自动发，下播后删掉）"）：
//   开播 → B站自动发开播动态，若它被当新动态推送并占据基线
//   → 下播 → B站把这条动态删掉 → feed 第一条变回之前的真实动态
//   → 和基线对不上 → 之前的动态被当"新动态"推出去（用户报的"直播结束后发之前的动态"）
// pickLatestItem 已按类型跳过开播动态；这层时间窗兜底防类型识别不住的变体：
// 刚推过开播通知，时间窗内新出现的动态多半就是 B站自动发的那条 → 静默。
// ⚠️ 副作用：UP 开播后几分钟内手发的动态也会被吞 —— bili-notify 同款取舍。
const LIVE_ECHO_WINDOW_MS = 15 * 60 * 1000;
let liveNotifyAt = {};   // {uid: 开播通知时间ms}，内存即可（重启后顶多多推一条，无害）

function markLiveNotified(uid) {
  liveNotifyAt[String(uid)] = Date.now();
}

function silenceLiveEcho(uid, d) {
  const t = liveNotifyAt[String(uid)];
  if (!t || Date.now() - t > LIVE_ECHO_WINDOW_MS) return false;
  const pub = (d.timestamp || 0) * 1000;
  // 取不到发布时间就不敢静默 —— 宁可重复也不能吞真动态（bili-notify 同原则）
  if (!pub) return false;
  // 发布明显早于开播通知 → 是更早的旧动态，交给基线时间戳守卫处理，这里不吞
  if (pub < t - 60_000) return false;
  return true;
}
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

/** 从动态流里挑「最新可推送」的条目：置顶和开播自动动态都不算新动态。
 * 开播动态（DYNAMIC_TYPE_LIVE_RCMD）必须跳过：开播时直播检测已单独推过通知，
 * 不跳的话动态监控过一会儿又推一遍 —— 就是"直播同步两条消息"的来源。 */
function pickLatestItem(items) {
  for (const item of items || []) {
    if (item.modules?.module_tag?.text === '置顶') continue;
    if (item.type === 'DYNAMIC_TYPE_LIVE_RCMD') continue;
    return item;
  }
  return null;   // 全是置顶/开播动态 → 没有可推的
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
  // 取第一条非置顶、非开播动态（文字/图片缺失时用 detail API 补全）
  const item = pickLatestItem(data.data.items);
  if (!item) return null;
  const parsed = parseDynamic(item);
  if (!parsed.text && !parsed.title && parsed.images.length === 0) {
    try {
      const detail = await fetchDynamicDetail(parsed.dynamicId);
      if (detail?.text) parsed.text = detail.text;
    } catch(e) { /* ignore */ }
  }
  return parsed;
}

/** 解析 RSS XML 的 <item> 列表（逐条，不再用全文首匹配） */
function parseRssItems(text) {
  return [...String(text || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

/** 从 RSS 条目里挑第一条「真动态」。
 * 直播动态的链接是 live.bilibili.com/{房间号} 而非 t.bilibili.com/{动态id}
 * （RSSHub 源码确认），开播通知已推过，跳过。
 * 置顶动态 RSSHub 不做标记（源码确认原样放第一位），识别不了；
 * 靠已推送基线的时间戳守卫兜底 —— 置顶必然比最新已推送的旧，会被拦截。 */
function firstDynamicFromRss(text) {
  for (const raw of parseRssItems(text)) {
    const link = ((raw.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim();
    if (!link || /live\.bilibili\.com/i.test(link)) continue;
    const title = (((raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1]) || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const pubMatch = raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const dynId = link.split('/').pop().split('?')[0];
    return {
      dynamicId: dynId, uid: 0,
      timestamp: pubMatch ? new Date(pubMatch[1]).getTime() / 1000 : Date.now() / 1000,
      type: 'DYNAMIC_TYPE_UNKNOWN', text: title, images: [], title: '',
      originInfo: null, url: link,
    };
  }
  return null;   // 没有条目，或全是直播动态
}

/** 策略2: RSSHub（无需Cookie，但可能不稳定） */
async function fetchRSSHub(uid) {
  for (const inst of RSSHUB_INSTANCES) {
    try {
      const url = `${inst}/bilibili/user/dynamic/${uid}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml' }, signal: AbortSignal.timeout(8000) });
      if (res.status !== 200) continue;
      const d = firstDynamicFromRss(await res.text());
      if (d) { d.uid = Number(uid); return d; }
      // 条目全是直播动态 → 没有可推的动态，换实例也是同样数据
      return null;
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

// ─── Markdown 卡片（图文合一，对齐 bili-notify 的排版规则）────────────────────
// Markdown 转义：正文里这些符号会破坏卡片排版（标题/加粗/链接语法），直接去掉
function mdEscape(s) {
  return String(s || '').replace(/\r/g, '').replace(/[`*_#\[\]<>]/g, '').trim();
}

/** 动态推送的 Markdown 卡片：图片内嵌（QQ 私有尺寸提示语法），图文一条消息。
 * 动态配图竖图/方图比例不定，需要联网探测真实尺寸，故为 async。 */
async function formatDynamicMd(d, upName) {
  const t = new Date(d.timestamp * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  let md = `**🔔 ${mdEscape(upName)} 发布新动态**\n📅 ${t}\n`;
  if (d.title) md += `📺 **${mdEscape(d.title)}**\n`;
  if (d.text) {
    const esc = mdEscape(d.text.slice(0, 500));
    md += `${esc}${d.text.length > 500 ? '...' : ''}\n`;
  }
  if (d.originInfo) md += `🔁 转发自 @${mdEscape(d.originInfo.name)}\n`;
  // 白名单内的图才内嵌（最多3张，与富媒体路径同上限）
  const lines = [];
  for (const u of (d.images || [])) {
    if (lines.length >= 3) break;
    const line = await media.mdImageLine(u, { probe: true });
    if (line) lines.push(line);
  }
  if (lines.length) md += '\n' + lines.join('\n') + '\n';
  md += `\n🔗 [查看动态](${d.url})`;
  return md;
}

/** 直播开播的 Markdown 卡片：封面内嵌。封面本就 16:9，不探测尺寸省一次网络。 */
async function formatLiveMd(live, upName) {
  let md = `**🔴 ${mdEscape(upName)} 开播了！**\n`;
  if (live.liveStartTime) md += `🕐 开播时间：${fmtTimeCN(live.liveStartTime)}\n`;
  if (live.area) md += `📺 直播分区：${mdEscape(live.area)}\n`;
  if (live.title) md += `📝 直播标题：${mdEscape(live.title)}\n`;
  const cover = await media.mdImageLine(live.cover, { probe: false });
  if (cover) md += `\n${cover}\n`;
  md += `\n🔗 [进入直播间](${live.url})`;
  return md;
}

/**
 * 群聊图文合一发送（bili-notify 同款回落链）：
 *   1. Markdown 卡片（图片内嵌，文字+图一条消息）
 *   2. 失败（如未获 Markdown 权限）→ 纯文本 + 富媒体图片逐张发
 * 返回 true 表示文字至少发出去了。
 */
async function sendGroupCard(target, markdown, plainText, imageUrls) {
  const gid = target.targetId;
  try {
    await server.sendGroupMarkdown(gid, markdown);
    return true;
  } catch (e) {
    log.warn(`[图文合一] Markdown 发送失败，退回纯文本+图片分开发: ${e.message}`);
  }
  let ok = false;
  try {
    await server.sendToGroup(gid, plainText);
    ok = true;
  } catch (e) {
    log.error(`[图文合一] 纯文本也发送失败: ${e.message}`);
  }
  for (const url of (imageUrls || []).filter(Boolean).slice(0, 3)) {
    try { await server.sendGroupImageByUrl(gid, url); } catch (e) { /* 内部已记日志 */ }
  }
  return ok;
}


/** 检测直播状态 */
async function checkLive(uid) {
  try {
    const url = 'https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=' + uid;
    const res = await fetch(url, { headers: getHeaders('https://live.bilibili.com/'), signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.code !== 0 || !data.data) return null;
    const d = data.data;
    // liveStatus: 0=未开播 1=正在直播 2=轮播中
    if (d.liveStatus !== 1) return null;
    // 获取直播间详细信息（分区、开播时间）
    let area = '';
    let liveStartTime = 0;
    try {
      const infoUrl = 'https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + d.roomid;
      const infoRes = await fetch(infoUrl, { headers: getHeaders('https://live.bilibili.com/'), signal: AbortSignal.timeout(5000) });
      const infoData = await infoRes.json();
      area = infoData.data?.area_name || '';
      liveStartTime = infoData.data?.live_start_time || 0;   // 开播时间（Unix秒，下播后归零）
    } catch(e) {}
    return {
      roomId: d.roomid,
      title: d.title || '直播中',
      area: area,
      liveStartTime,
      cover: d.cover || '',
      url: d.url || ('https://live.bilibili.com/' + d.roomid),
    };
  } catch(e) {
    log.warn('[checkLive] UID=' + uid + ' ' + e.message);
    return null;
  }
}

function fmtTimeCN(ts) {
  return new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + ' 小时 ' + m + ' 分钟';
  if (m > 0) return m + ' 分钟';
  return s + ' 秒';
}

/** 格式化直播开播消息 */
function formatLiveMsg(live, upName) {
  let msg = '🔴 ' + upName + ' 开播了！\n';
  if (live.liveStartTime) msg += '🕐 开播时间：' + fmtTimeCN(live.liveStartTime) + '\n';
  if (live.area) msg += '📺 直播分区：' + live.area + '\n';
  if (live.title) msg += '📝 直播标题：' + live.title + '\n';
  msg += '\n🔗 ' + live.url;
  return msg;
}

/** 下播通知：开始/结束时间 + 播了多久。
 * startTs 缺失（中途重启没记录到开播时间）时只报结束时间，不猜时长。 */
function formatLiveEndMsg(startTs, upName, title) {
  const endTs = Math.floor(Date.now() / 1000);
  let msg = '⚪️ ' + upName + ' 下播了\n';
  if (startTs > 0) {
    msg += '🕐 开始：' + fmtTimeCN(startTs) + '\n';
    msg += '🔚 结束：' + fmtTimeCN(endTs) + '\n';
    msg += '⏱ 时长：' + fmtDuration(endTs - startTs) + '\n';
  } else {
    msg += '🔚 结束：' + fmtTimeCN(endTs) + '\n';
  }
  if (title) msg += '📝 本场直播：' + title + '\n';
  return msg;
}

function startMonitor(bot, intervalMinutes = 5, sendFn = null) {
  log.bili(`B站监控启动 (${intervalMinutes}分钟间隔)`);
  loadBiliConfig();
  if (!biliConfig.cookie) log.warn('未配置Cookie，将尝试第三方API（成功率较低）');
  let lastLive = {};
  try {
    if (fs.existsSync(LAST_LIVE_FILE)) lastLive = JSON.parse(fs.readFileSync(LAST_LIVE_FILE, 'utf-8'));
  } catch(e) {}
  // 旧格式只存房间号（数字）；升级为 {roomId, startTime, title} 以支持下播时长统计
  for (const k of Object.keys(lastLive)) {
    if (typeof lastLive[k] !== 'object' || lastLive[k] === null) {
      lastLive[k] = { roomId: lastLive[k], startTime: 0, title: '' };
    }
  }
  const check = async () => {
    const subs = loadConfig();
    for (const sub of subs) {
      if (!sub.uid || !sub.targetId) continue;
      const uidStr = String(sub.uid);
      try {
        const latest = await fetchLatestDynamic(sub.uid);
        if (!latest) { log.bili(`[${sub.name || uidStr}] 暂无动态`); continue; }
        const baseline = lastDynamics[uidStr] || {};
        if (latest.dynamicId !== baseline.id) {
          if (!shouldPushDynamic(uidStr, latest)) {
            // 已推送过的 id，或回退源（RSSHub/置顶）给的比已推送基线还旧的条目
            log.bili(`[${sub.name || uidStr}] 跳过已推送/过期动态 ${latest.dynamicId}`);
            // 基线只前移不后移，防止旧数据把基线拖回去导致反复横跳
            const ts = latest.timestamp || 0;
            if (ts >= (baseline.ts || 0)) lastDynamics[uidStr] = { id: String(latest.dynamicId), ts: ts || baseline.ts || Math.floor(Date.now() / 1000) };
          } else if (silenceLiveEcho(uidStr, latest)) {
            // 刚推过开播通知，时间窗内冒出来的动态 = B站自动发的开播动态（变体），静默
            log.bili(`[${sub.name || uidStr}] 静默开播回声动态 ${latest.dynamicId}`);
            const ts = latest.timestamp || Math.floor(Date.now() / 1000);
            if (ts >= (baseline.ts || 0)) lastDynamics[uidStr] = { id: String(latest.dynamicId), ts };
          } else {
            log.bili(`[${sub.name || uidStr}] 新动态: ${latest.dynamicId} title="${latest.title || (latest.text && latest.text.slice(0,30))}"`);
            const _send = sendFn || (bot && bot.send && bot.send.channel ? (t, text) => bot.send.channel(t.targetId, text) : null);
            if (!_send) { log.error(`[B站监控] 无可用的消息发送函数，跳过发送`); continue; }
            try {
              let sent = true;
              if (sub.targetType === 'group') {
                // 群聊：图文合一 Markdown 卡片（失败自动退纯文本+分开发图）
                sent = await sendGroupCard(sub,
                  await formatDynamicMd(latest, sub.name || uidStr),
                  formatMsg(latest, sub.name || uidStr),
                  latest.images);
              } else {
                await _send(sub, formatMsg(latest, sub.name || uidStr));
              }
              // 只有真发出去才记录/前移基线；失败的下一轮重试，避免动态丢失
              if (sent) recordPushedDynamic(uidStr, latest);
              else log.warn(`[${sub.name || uidStr}] 动态 ${latest.dynamicId} 发送失败，下轮重试`);
            }
            catch(e) { log.error(`发送动态到 ${targetLabel(sub)} 失败: ${e.message}`); }
          }
        } else {
          log.bili(`[${sub.name || uidStr}] 无更新`);
        }
      } catch(e) { log.error(`[${sub.name || uidStr}] 异常: ${e.message}`); }
    }
    // 直播检测
    for (const sub of subs) {
      if (!sub.uid || !sub.targetId) continue;
      const uidStr = String(sub.uid);
      try {
        const live = await checkLive(sub.uid);
        if (live && !lastLive[uidStr]) {
          // 新开播
          log.bili('[' + (sub.name || uidStr) + '] 开播: ' + live.title);
          const _send = sendFn || (bot && bot.send && bot.send.channel ? (t, text) => bot.send.channel(t.targetId, text) : null);
          let notified = false;
          if (_send) {
            try {
              if (sub.targetType === 'group') {
                // 群聊：封面内嵌的 Markdown 卡片（失败退纯文本+封面单独发）
                notified = !!await sendGroupCard(sub,
                  await formatLiveMd(live, sub.name || uidStr),
                  formatLiveMsg(live, sub.name || uidStr),
                  [live.cover]);
              } else {
                await _send(sub, formatLiveMsg(live, sub.name || uidStr));
                notified = true;
              }
            } catch(e) { log.error('发送直播通知失败: ' + e.message); }
          }
          // 开播通知真发出去了才开时间窗，用于静默 B站自动发的开播动态
          if (notified) markLiveNotified(uidStr);
        } else if (!live && lastLive[uidStr]) {
          // 下播：补一条开始/结束时间、播了多久（开播时间取开播时记录的）
          const prev = lastLive[uidStr];
          log.bili('[' + (sub.name || uidStr) + '] 下播: ' + (prev.title || ''));
          const _send = sendFn || (bot && bot.send && bot.send.channel ? (t, text) => bot.send.channel(t.targetId, text) : null);
          if (_send) {
            try {
              await _send(sub, formatLiveEndMsg(prev.startTime || 0, sub.name || uidStr, prev.title || ''));
            } catch(e) { log.error('发送下播通知失败: ' + e.message); }
          }
        }
        if (live) {
          const prev = lastLive[uidStr] || {};
          lastLive[uidStr] = {
            roomId: live.roomId,
            // API 没给开播时间时退而用检测时刻近似（误差≤一个轮询周期）
            startTime: live.liveStartTime || prev.startTime || Math.floor(Date.now() / 1000),
            title: live.title || prev.title || '',
          };
        }
        else delete lastLive[uidStr];
      } catch(e) { log.error('[' + (sub.name || uidStr) + '] 直播检测异常: ' + e.message); }
    }
    saveLastDynamics();
    try { fs.writeFileSync(LAST_LIVE_FILE, JSON.stringify(lastLive, null, 2)); } catch(e) {}
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

// ─── Cookie 失效倒计时 ────────────────────────────────────────────────────────
// SESSDATA 本身形如 <token>,<expire_ts>,<校验段>，第二段就是失效时间戳（Unix秒），
// 解析即可得，不用调接口。昵称/登录态再调 nav 接口确认（失败不影响倒计时）。
function parseSessdataExpiry(cookie) {
  const m = String(cookie || '').match(/SESSDATA=([^;]+)/);
  if (!m) return 0;
  let val = m[1].trim();
  try { val = decodeURIComponent(val); } catch (e) { /* 保持原样继续解析 */ }
  const ts = parseInt(String(val).split(',')[1], 10);
  // 合理性：10 位 Unix 秒（2001~2096），不是就当解析失败
  return (ts > 1e9 && ts < 4e9) ? ts : 0;
}

// 面板刷新很勤，nav 接口结果缓存 5 分钟，别把 B站接口打爆
let _cookieStatusCache = { at: 0, data: null };

async function getCookieStatus() {
  if (_cookieStatusCache.data && Date.now() - _cookieStatusCache.at < 300_000) {
    return _cookieStatusCache.data;
  }
  if (!biliConfig.cookie) loadBiliConfig();
  const out = {
    hasCookie: !!biliConfig.cookie,
    expireTs: parseSessdataExpiry(biliConfig.cookie),
    login: null,     // null = 未知（接口没查到）
    uname: '',
  };
  if (out.hasCookie) {
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'User-Agent': biliConfig.userAgent, 'Referer': 'https://www.bilibili.com/', 'Cookie': biliConfig.cookie },
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      out.login = data?.data?.isLogin === true;
      out.uname = data?.data?.uname || '';
    } catch (e) { /* 网络失败不算失效，只少个昵称 */ }
  }
  _cookieStatusCache = { at: Date.now(), data: out };
  return out;
}

function getApiStatus() { return { hasCookie: !!biliConfig.cookie, message: biliConfig.cookie ? "Cookie已配置" : "未配置Cookie，将使用第三方API" }; } function setCookie(cookie) { saveBiliConfig(cookie); } module.exports = { startMonitor, addSub, removeSub, listSub, loadConfig, searchUp, getUpName, loadBiliConfig, saveBiliConfig, setCookie, getApiStatus, getCookieStatus, parseSessdataExpiry, isDynamicPushed, markDynamicPushed, recordPushedDynamic, shouldPushDynamic, silenceLiveEcho, markLiveNotified, pickLatestItem, parseRssItems, firstDynamicFromRss, fmtDuration, fetchLatestDynamic, formatMsg, formatDynamicMd, formatLiveMsg, formatLiveMd, formatLiveEndMsg, sendGroupCard, checkLive, CONFIG_FILE, COOKIE_FILE };
