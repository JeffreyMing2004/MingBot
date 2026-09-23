/**
 * HTTP 回调服务器
 * QQ Guild Bot 事件推送接收端，替代 WebSocket 模式
 *
 * 签名校验算法（来自官方文档）：
 *   1. 用 AppSecret 作为 Ed25519 seed 生成密钥对
 *   2. 消息 = timestamp + body（字符串拼接）
 *   3. X-Signature-Ed25519 为 hex 编码的签名
 *   4. 用公钥验证签名
 *
 * 回调地址验证（opcode 13）：
 *   1. 消息 = event_ts + plain_token
 *   2. 用私钥签名，返回 {plain_token, signature(hex)}
 *
 * 消息回复接口（按事件场景区分）：
 *   群聊 GROUP_AT_MESSAGE_CREATE → POST /v2/groups/{group_openid}/messages
 *   单聊 C2C_MESSAGE_CREATE      → POST /v2/users/{user_openid}/messages
 *   频道 AT/MESSAGE_CREATE       → POST /channels/{channel_id}/messages
 *   主动推送自 2025-04-21 起停用，群聊/单聊只能带 msg_id 被动回复
 *   （群聊 5 分钟内有效、每条消息最多回复 5 次，msg_id+msg_seq 重复会失败）
 */
const http = require('http');
const https = require('https');
const nacl = require('tweetnacl');
const fs = require('fs');
const path = require('path');
const media = require('./media');
const log = require('./logger');

let botConfig = null;
let callbackPath = '/callback';
let accessToken = null;
let tokenExpireAt = 0;

// 需要转成命令消息处理的事件类型
const MESSAGE_EVENTS = new Set([
  'GROUP_AT_MESSAGE_CREATE',   // 群聊@机器人
  'C2C_MESSAGE_CREATE',        // 单聊
  'AT_MESSAGE_CREATE',         // 频道@机器人
  'MESSAGE_CREATE',            // 频道全量消息（私域）
  'DIRECT_MESSAGE_CREATE',     // 频道私信
]);

// ─── Ed25519 密钥派生 ─────────────────────────────────────────────────────────
function deriveKeypair(secret) {
  let seed = Buffer.from(secret);
  while (seed.length < 32) {
    seed = Buffer.concat([seed, seed]);
  }
  seed = seed.slice(0, 32);
  return nacl.sign.keyPair.fromSeed(seed);
}

function signMessage(secret, message) {
  const kp = deriveKeypair(secret);
  const sig = nacl.sign.detached(Buffer.from(message), kp.secretKey);
  return Buffer.from(sig).toString('hex');
}

function verifySignature(secret, message, hexSig) {
  try {
    const kp = deriveKeypair(secret);
    const sig = Buffer.from(hexSig, 'hex');
    return nacl.sign.detached.verify(Buffer.from(message), sig, kp.publicKey);
  } catch (e) {
    return false;
  }
}

// ─── Token 缓存 ────────────────────────────────────────────────────────────────
async function getAccessToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpireAt - 60_000) {
    return accessToken;
  }
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      appId: botConfig.appId,
      clientSecret: botConfig.token,
    });
    const req = https.request('https://api.bot.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.access_token) {
            accessToken = json.access_token;
            tokenExpireAt = now + json.expires_in * 1000 - 60_000;
            resolve(accessToken);
          } else {
            reject(new Error(`获取 access_token 失败: ${d}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── 发送消息 ──────────────────────────────────────────────────────────────────
// 沙箱与正式环境域名不同
function apiBase() {
  return botConfig?.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
}

// 被动回复序号：同一 msg_id 最多回复 5 次，相同 msg_id+msg_seq 会失败，需递增
const msgSeqMap = new Map();
function nextMsgSeq(msgId) {
  if (!msgId) return 1;
  const seq = (msgSeqMap.get(msgId) || 0) + 1;
  msgSeqMap.set(msgId, seq);
  if (msgSeqMap.size > 500) msgSeqMap.delete(msgSeqMap.keys().next().value);
  return seq;
}

async function sendToChannel(channelId, text, msgId) {
  log.info(`[sendToChannel] 发送到 channel=${channelId}${msgId ? ` (被动回复 msg_id=${msgId})` : ' (主动消息)'}`);
  const token = await getAccessToken();
  const body = { content: text };
  if (msgId) body.msg_id = msgId;
  const res = await postJson(`${apiBase()}/channels/${channelId}/messages`, body, token);
  log.info(`[sendToChannel] 发送成功 id=${res.id || '-'}`);
  return res;
}

// 群聊发送：POST /v2/groups/{group_openid}/messages
// 带 msgId 为被动回复（5分钟内），不带为主动消息（需群开启「机器人主动在群聊内发言」）
async function sendToGroup(groupOpenid, text, msgId) {
  const token = await getAccessToken();
  const body = { content: text, msg_type: 0 };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = nextMsgSeq(msgId);
  }
  const res = await postJson(`${apiBase()}/v2/groups/${groupOpenid}/messages`, body, token);
  log.info(`[sendToGroup] 群消息${msgId ? '被动回复' : '主动推送'}成功 id=${res.id || '-'}`);
  return res;
}

// 单聊回复：POST /v2/users/{user_openid}/messages（被动回复60分钟内有效）
async function sendToC2C(userOpenid, text, msgId) {
  const token = await getAccessToken();
  const body = { content: text, msg_type: 0 };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = nextMsgSeq(msgId);
  }
  const res = await postJson(`${apiBase()}/v2/users/${userOpenid}/messages`, body, token);
  log.info(`[sendToC2C] 单聊消息发送成功 id=${res.id || '-'}`);
  return res;
}

// 群聊 Markdown 消息：msg_type=2 + markdown.content。
// 自定义 Markdown 已对全部群聊机器人开放（无需申请模板，对齐 bili-notify 实测）。
// 图片用 ![说明](url) 内嵌在 Markdown 里，开放平台会下载转存 —— 图文同一条消息。
// 注意：内嵌格式（<@!id> 等）只在纯文本 content 生效，markdown 里不生效。
async function sendGroupMarkdown(groupOpenid, markdown, msgId) {
  const token = await getAccessToken();
  const body = { msg_type: 2, markdown: { content: markdown } };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = nextMsgSeq(msgId);
  }
  const res = await postJson(`${apiBase()}/v2/groups/${groupOpenid}/messages`, body, token);
  log.info(`[sendGroupMarkdown] Markdown消息发送成功 id=${res.id || '-'}`);
  return res;
}

async function sendToDms(guildId, text) {
  const token = await getAccessToken();
  const dms = await postJson(`${apiBase()}/users/@me/guilds`, {
    guild_id: guildId,
    accept_invite: false,
  }, token);
  const channelId = dms.channel_id || dms.id;
  return sendToChannel(channelId, text);
}


// ─── 群聊富媒体（移植自 bili-notify/media.py + qqapi.py）──────────────────────
// 官方 /files 接口只收 JSON：file_data=base64 本地直传，或 url=平台自己下载转存。
// （此前用的 multipart/form-data 表单格式是其他机器人平台的写法，官方不认。）
// 上传 srv_send_msg=false 只换 file_info 不发消息，再走 msg_type=7 发送。
// 两种传法都不经过客户端渲染，不受「消息URL配置」报备限制。

// POST /v2/groups/{group_openid}/files，返回 {file_info, file_uuid, ttl}
async function uploadGroupFile(groupOpenid, body) {
  const token = await getAccessToken();
  // base64 直传时请求体可达 2.7MB+，10 秒默认超时不够用
  const res = await postJson(apiBase() + '/v2/groups/' + groupOpenid + '/files', {
    file_type: 1,
    srv_send_msg: false,
    ...body,
  }, token, 30000);
  log.info(`[uploadGroupFile] 上传成功 file_info=${String(res.file_info || '').slice(0, 16)}... ttl=${res.ttl || 0}`);
  return res;
}

// 上传群聊图片：优先本地下载 + base64 直传；本地取不到（防盗链/超限/网络）
// 就退一步让平台服务器按 url 代拉，别轻易放弃
async function uploadGroupImage(groupOpenid, imageUrl) {
  const imgBuf = await media.getImageData(imageUrl);
  if (imgBuf) {
    return uploadGroupFile(groupOpenid, { file_data: imgBuf.toString('base64') });
  }
  log.warn(`[uploadGroupImage] 本地下载失败，改用平台代拉: ${imageUrl}`);
  return uploadGroupFile(groupOpenid, { url: media.jpegVariant(imageUrl, 720) || imageUrl });
}

// 发送群聊富媒体消息。msg_type 必须是 7（2 是 markdown），file_info 原样透传
async function sendGroupImage(groupOpenid, fileInfo, msgId) {
  const token = await getAccessToken();
  const body = { msg_type: 7, media: { file_info: fileInfo } };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = nextMsgSeq(msgId);
  }
  const res = await postJson(apiBase() + '/v2/groups/' + groupOpenid + '/messages', body, token);
  log.info('[sendGroupImage] 图片消息发送成功 id=' + (res.id || '-'));
  return res;
}

// 发送一张图片到群的完整流程：file_info 缓存 → base64 上传 → 平台代拉 → 发送。
// 失败返回 null（原因已写日志），不抛异常，方便推送主流程并发发多张图。
async function sendGroupImageByUrl(groupOpenid, imageUrl, msgId) {
  if (!groupOpenid || !imageUrl) return null;
  const host = (() => { try { return new URL(imageUrl).hostname; } catch (e) { return imageUrl.slice(0, 40); } })();

  // 命中 file_info 缓存就直接发，同一张封面在有效期内不重复上传
  const hit = media.cachedFileInfo(imageUrl);
  if (hit) {
    try {
      return await sendGroupImage(groupOpenid, hit, msgId);
    } catch (e) {
      log.warn(`[sendGroupImage] 缓存的 file_info 已失效，重新上传: ${e.message}`);
      media.forgetFileInfo(imageUrl);
    }
  }

  let up = null;
  try {
    up = await uploadGroupImage(groupOpenid, imageUrl);
  } catch (e) {
    log.warn(`[sendGroupImageByUrl] base64 上传失败 (${host}): ${e.message}`);
  }
  if (!up || !(up.file_info || up.file_uuid)) {
    try {
      up = await uploadGroupFile(groupOpenid, { url: media.jpegVariant(imageUrl, 720) || imageUrl });
    } catch (e) {
      log.warn(`[sendGroupImageByUrl] 平台代拉也失败 (${host}): ${e.message}`);
    }
  }
  const fileInfo = up && (up.file_info || up.file_uuid);
  if (!fileInfo) {
    log.warn(`[sendGroupImageByUrl] 图片发送失败（两路上传都没拿到 file_info）: ${host}`);
    return null;
  }
  media.rememberFileInfo(imageUrl, fileInfo, up.ttl);
  try {
    return await sendGroupImage(groupOpenid, fileInfo, msgId);
  } catch (e) {
    log.warn(`[sendGroupImageByUrl] 图片消息发送失败 (${host}): ${e.message}`);
    return null;
  }
}

function postJson(url, body, token, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `QQBot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let json = null;
        try { json = d ? JSON.parse(d) : null; } catch (e) { /* 响应非JSON */ }
        const apiCode = json?.code;
        const apiErr = apiCode != null && apiCode !== 0 && apiCode !== '0';
        if (res.statusCode < 400 && !apiErr) return resolve(json || {});
        // 平台错误体形如 {code, message}，必须打出来否则排查不到原因
        const detail = json?.message || json?.msg || d || res.statusMessage || 'unknown';
        reject(new Error(`HTTP ${res.statusCode} code=${apiCode ?? '-'} message=${detail}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── 事件转换 ──────────────────────────────────────────────────────────────────
// 群聊/频道消息 content 可能带 @机器人 前缀（<@!appId 或 <@appId>），命令解析前先剥离
function stripMentionTag(content) {
  return (content || '').replace(/^\s*<@!?\d+>\s*/, '');
}

// 事件时间可能是 RFC3339 字符串，也可能是秒级数字
function parseTimestamp(ts) {
  if (!ts) return 0;
  if (/^\d+$/.test(String(ts))) return parseInt(ts, 10) * 1000;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function transformEvent(event) {
  const base = {
    id: event.id,
    author: event.author,
    member: event.member || {},
    mentions: (event.mentions || []).map(m => m.id),
    botId: botConfig?.appId || null,
    _raw: event,
  };

  // 群聊@机器人：d 里只有 group_openid，没有 guild_id/channel_id/mentions
  if (event.group_openid) {
    const replyFn = text => sendToGroup(event.group_openid, text, event.id);
    return {
      ...base,
      sourceType: 'group',
      content: stripMentionTag(event.content).trim(),
      guildId: '',
      channelId: '',
      groupOpenid: event.group_openid,
      isPrivate: true,
      timestamp: parseTimestamp(event.timestamp),
      reply: replyFn,
      _sendReply: replyFn,
    };
  }

  // 单聊：d.author.user_openid
  if (event.author?.user_openid) {
    const openid = event.author.user_openid;
    const replyFn = text => sendToC2C(openid, text, event.id);
    return {
      ...base,
      sourceType: 'c2c',
      content: (event.content || '').trim(),
      guildId: '',
      channelId: '',
      c2cOpenid: openid,
      isPrivate: true,
      timestamp: parseTimestamp(event.timestamp),
      reply: replyFn,
      _sendReply: replyFn,
    };
  }

  // 频道消息 / 频道私信：有 guild_id + channel_id
  const guildId = event.guild_id || '';
  const channelId = event.channel_id || '';
  const replyFn = text => (guildId && !channelId
    ? sendToDms(guildId, text)
    : sendToChannel(channelId, text, event.id));
  return {
    ...base,
    sourceType: 'guild',
    content: stripMentionTag(event.content).trim(),
    guildId,
    channelId,
    isPrivate: false,
    timestamp: parseTimestamp(event.timestamp),
    reply: replyFn,
    _sendReply: replyFn,
  };
}

// ─── 签名校验中间件 ────────────────────────────────────────────────────────────
function buildVerifier(secret) {
  return function verify(req, res, next) {
    const sigHeader = req.headers['x-signature-ed25519'];
    const tsHeader = req.headers['x-signature-timestamp'];

    if (sigHeader && tsHeader) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const message = tsHeader + body;
        const ok = verifySignature(secret, message, sigHeader);
        if (!ok) {
          log.error(`[签名校验失败] timestamp=${tsHeader} sig=${sigHeader.substring(0, 16)}...`);
          res.writeHead(401); res.end('Unauthorized');
          return;
        }
        req._body = body;
        next();
      });
      req.on('error', err => {
        log.error(`[读取body失败] ${err.message}`);
        res.writeHead(500); res.end('Error');
      });
    } else {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        req._body = body;
        next();
      });
    }
  };
}

// ─── HTTP 服务器 ───────────────────────────────────────────────────────────────
function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d > 0) return d + '天' + h + '时' + m + '分';
  if (h > 0) return h + '时' + m + '分' + sec + '秒';
  return m + '分' + sec + '秒';
}

function createServer(handler, secret) {
  const verify = buildVerifier(secret);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signature-Ed25519, X-Signature-Timestamp, X-Bot-Appid');

    if (req.method === 'OPTIONS') {
      res.writeHead(200); res.end(); return;
    }




    // ─── 面板 API ──────────────────────────────────────────────────────────────
        if (req.url === '/api/status' && req.method === 'GET') {
          const { loadConfig } = require('./bilibili');
          const { getAllCommands } = require('./commands');
          const { getApiStatus } = require('./bilibili');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            mode: botConfig?.mode || 'websocket',
            sandbox: botConfig?.sandbox || false,
            subscriptions: loadConfig().length,
            commands: [...new Set(getAllCommands().keys())].length,
            biliConfig: getApiStatus(),
          }));
          return;
        }
    
        if (req.url === '/api/subscriptions' && req.method === 'GET') {
          const { loadConfig } = require('./bilibili');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(loadConfig()));
          return;
        }

        // Cookie 失效倒计时：SESSDATA 解析失效时间戳 + nav 查登录昵称
        if (req.url === '/api/cookie-status' && req.method === 'GET') {
          const { getCookieStatus } = require('./bilibili');
          getCookieStatus().then(status => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...status }));
          }).catch(e => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          });
          return;
        }

        if (req.url === '/api/commands' && req.method === 'GET') {
          const { getAllCommands } = require('./commands');
          const seen = new Set();
          const cmds = [];
          for (const [, c] of getAllCommands()) {
            if (seen.has(c.name)) continue;
            seen.add(c.name);
            cmds.push({ name: c.name, description: c.description, aliases: c.aliases || [] });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cmds));
          return;
        }
    
        
        
        if (req.url === '/api/watchdog' && req.method === 'GET') {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'watchdog.json'), 'utf-8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
          } catch(e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ bot: { ok: false }, cloudflared: false, checkTime: 0, restartCount: 0 }));
          }
          return;
        }

        if (req.url === '/api/heartbeat' && req.method === 'GET') {
          const uptime = process.uptime();
          const mem = process.memoryUsage();
          const hb = {
            ok: true,
            uptime: Math.floor(uptime),
            uptimeStr: formatUptime(uptime),
            memory: {
              rss: Math.round(mem.rss / 1024 / 1024),
              heap: Math.round(mem.heapUsed / 1024 / 1024),
              total: Math.round(mem.heapTotal / 1024 / 1024),
            },
            pid: process.pid,
            node: process.version,
            timestamp: Date.now(),
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(hb));
          return;
        }

        if (req.url === '/api/logs' && req.method === 'GET') {
          const botLogFile = path.join(__dirname, '..', 'logs', 'bot.log');
          const pm2OutFile = path.join(__dirname, '..', 'logs', 'pm2-out.log');
          const pm2ErrFile = path.join(__dirname, '..', 'logs', 'pm2-error.log');
          const readTail = (file, n, regex) => {
            try {
              let lastTs = '';
              return fs.readFileSync(file, 'utf-8').trim().split('\n').slice(-n).map(l => {
                const m = l.match(regex);
                if (m) lastTs = m[1] || m[0];
                return { line: l, ts: lastTs };
              });
            } catch (e) { return []; }
          };
          const botLog = readTail(botLogFile, 80, /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
          const pm2Out = readTail(pm2OutFile, 80, /^(\d{2}:\d{2}:\d{2}):/);
          const pm2Err = readTail(pm2ErrFile, 20, /^(\d{2}:\d{2}:\d{2}):/);
          const lines = botLog.concat(pm2Out).concat(pm2Err)
            .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
            .map(k => k.line);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(lines.slice(-100)));
          return;
        }
    
        // Root redirect to panel
    if (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/index')) {
      try {
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch(e) { res.writeHead(404); res.end('Panel not found: ' + e.message); }
      return;
    }

    // 静态文件：面板 fallback
    if (false && (req.url === '/' || req.url === '/index.html')) {
          const htmlFile = path.join(__dirname, '..', 'public', 'index.html');
          try {
            const html = fs.readFileSync(htmlFile, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch(e) {
            res.writeHead(404); res.end('Panel not found');
          }
          return;
        }
    
        

    // Only callback POST past this point
    if (req.url !== callbackPath || req.method !== 'POST') {
      res.writeHead(404); res.end('Not Found'); return;
    }

    verify(req, res, async () => {
      const body = req._body;
      try {
        const event = JSON.parse(body);

        if (event.op === 13) {
          log.info('[回调验证] 收到开放平台验证请求');
          const plainToken = event.d?.plain_token || '';
          const eventTs = event.d?.event_ts || '';
          const sig = signMessage(secret, eventTs + plainToken);
          log.info(`[回调验证] plain_token=${plainToken} signature=${sig.substring(0, 16)}...`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ plain_token: plainToken, signature: sig }));
          return;
        }

        if (event.op === 12) {
          log.info('[HTTP ACK] 平台已确认收到事件');
          res.writeHead(200); res.end('');
          return;
        }

        const t = event.t || event.type || '';
        log.event(`[HTTP回调] type=${t} guild=${event.d?.guild_id} channel=${event.d?.channel_id} group=${event.d?.group_openid}`);

        if (t === 'READY') {
          setBotUser(event.d?.user?.id);
          log.info(`[READY] appId=${event.d?.appid || botConfig?.appId} bot=${event.d?.user?.username || 'unknown'}`);
          res.writeHead(200); res.end('');
          return;
        }

        if (!MESSAGE_EVENTS.has(t)) {
          res.writeHead(200); res.end('');
          return;
        }

        const msg = transformEvent(event.d);
        if (msg.author?.bot || msg.author?.system) {
          res.writeHead(200); res.end('');
          return;
        }

        // 私域频道全量消息才需要过滤@；群聊@/频道@/单聊事件平台只在命中机器人时才推送
        if (t === 'MESSAGE_CREATE' && botConfig?._botUserId) {
          const mentioned = (msg.mentions || []).includes(botConfig._botUserId);
          if (!mentioned) {
            log.event(`[频道消息] 未@机器人，忽略 user=${msg.author?.username}`);
            res.writeHead(200); res.end('');
            return;
          }
        }

        // 先 ACK 再异步处理，避免命令耗时导致平台超时重推（被动回复窗口5分钟，足够）
        res.writeHead(200); res.end('');
        handler(msg).catch(e => log.error(`[回调处理失败] ${e.message}`));
      } catch (e) {
        log.error(`HTTP回调处理失败: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(500); res.end('Error');
        }
      }
    });
  });
  return server;
}

// ─── 启动 ──────────────────────────────────────────────────────────────────────
function init(config, token) {
  botConfig = config;
  callbackPath = process.env.QQ_BOT_CALLBACK_PATH || '/callback';
  if (!botConfig._botUserId) botConfig._botUserId = null;
}

function setBotUser(user) {
  if (botConfig) botConfig._botUserId = user?.id || null;
}

function getCallbackUrl() {
  return process.env.BOT_URL || botConfig?.callbackUrl || 'https://bot.mingpixel.net';
}

function start(handler, port) {
  const p = port || parseInt(process.env.BOT_PORT) || 9000;
  const secret = botConfig?.appSecret || botConfig?.token || '';
  const server = createServer(handler, secret);

  server.listen(p, '0.0.0.0', () => {
    const publicUrl = getCallbackUrl();
    const isNgrok = publicUrl.includes('ngrok') || publicUrl.includes('localhost');
    log.info(`HTTP回调服务器已启动  port=${p}  path=${callbackPath}`);
    log.info(`回调地址: ${publicUrl}${callbackPath}`);
    log.info(`签名校验: ${secret ? '已启用 (Ed25519)' : '未配置 appSecret'}`);
    if (isNgrok) {
      log.info('请在 QQ 开放平台 → 事件订阅 → 回调地址 填入上方 URL');
    } else {
      log.info('生产模式：确保 bot.mingpixel.net/callback 反向代理到此端口');
    }
  });

  server.on('error', err => log.error(`HTTP服务器错误: ${err.message}`));
  return server;
}

module.exports = { init, start, getCallbackUrl, getAccessToken, signMessage, verifySignature, deriveKeypair, setBotUser, getBotUserId: () => botConfig?._botUserId || null, sendToChannel, sendToGroup, sendToC2C, sendGroupMarkdown, uploadGroupFile, uploadGroupImage, sendGroupImage, sendGroupImageByUrl };
