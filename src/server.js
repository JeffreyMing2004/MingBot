/**
 * HTTP 回调服务器
 * QQ Guild Bot 事件推送接收端，替代 WebSocket 模式
 *
 * 开发流程：
 *   1. 运行 .\start.ps1 callback
 *   2. 执行 ngrok http 9000
 *   3. 将 https://xxxx.ngrok.io/callback 填入 QQ 开放平台「事件回调」
 *
 * 生产流程：
 *   bot.mingpixel.net/callback 反向代理到本地 9000 端口
 */
const http = require('http');
const https = require('https');
const log = require('./logger');

let botConfig = null;
let callbackPath = '/callback';
let accessToken = null;
let tokenExpireAt = 0;

// ─── Token 缓存 ────────────────────────────────────────────────────────────────
async function getAccessToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpireAt - 60_000) {
    return accessToken;
  }
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      appid: botConfig.appId,
      client_secret: botConfig.token,
    });
    const req = https.request('https://api.sgroup.qq.com/oauth/access_token', {
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
            // access_token 有效期约 2h，提前 1min 刷新
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
async function sendToChannel(channelId, text) {
  const token = await getAccessToken();
  await postJson(`https://api.sgroup.qq.com/v2/channels/${channelId}/messages`, {
    content: text,
    msg_type: 0,  // 0=文本
    msg_format: 0, // 0=普通文本
  }, token);
}

async function sendToDms(guildId, text) {
  const token = await getAccessToken();
  // 先获取 DMS channel_id
  const dms = await postJson('https://api.sgroup.qq.com/v2/users/@me/guilds', {
    guild_id: guildId,
    accept_invite: false,
  }, token);
  const channelId = dms.channel_id || dms.id;
  await sendToChannel(channelId, text);
}

function postJson(url, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `QQBot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── 事件转换 ──────────────────────────────────────────────────────────────────
function isPrivateChannel(channelId) {
  // QQ Guild 私信频道 ID 格式：c2c|{guild_id} 或 group|{guild_id}
  return channelId && (channelId.startsWith('c2c|') || channelId.startsWith('group|'));
}

function transformEvent(event) {
  const isPrivate = !event.guild_id || isPrivateChannel(event.channel_id);
  const guildId = event.guild_id || '';
  const channelId = event.channel_id || '';
  return {
    id: event.id,
    author: event.author,
    content: (event.content || '').trim(),
    guildId,
    channelId,
    isPrivate,
    member: event.member || {},
    timestamp: parseInt(event.timestamp || event.create_time || 0) * 1000,
    // 发送回复的统一接口
    _sendReply: async text => {
      if (isPrivate) {
        await sendToDms(guildId, text);
      } else {
        await sendToChannel(channelId, text);
      }
    },
    // 兼容 SDK 风格的消息对象（WebSocket 模式下的命令也能复用）
    reply: async text => {
      if (isPrivate) {
        await sendToDms(guildId, text);
      } else {
        await sendToChannel(channelId, text);
      }
    },
    // 原始数据供需要时访问
    _raw: event,
  };
}

// ─── HTTP 服务器 ───────────────────────────────────────────────────────────────
function createServer(handler) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signature');

    if (req.method === 'OPTIONS') {
      res.writeHead(200); res.end(); return;
    }

    if (req.url !== callbackPath || req.method !== 'POST') {
      res.writeHead(404); res.end('Not Found'); return;
    }

    // 验证签名（可选，正式部署时启用）
    const sig = req.headers['x-signature'];
    // TODO: 验签逻辑，需根据平台和密钥实现

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);
        log.event(`[HTTP回调] type=${event.type || event.t || 'unknown'} guild=${event.guild_id} channel=${event.channel_id}`);

        // READY 事件必须返回空字符串
        if (event.type === 'READY' || event.t === 'READY') {
          log.info(`[READY] appId=${event.appid} bot=${event.user?.username || 'unknown'}`);
          res.writeHead(200); res.end('');
          return;
        }

        // MESSAGE_CREATE 事件
        if (event.type === 'MESSAGE_CREATE' || event.t === 'MESSAGE_CREATE') {
          const msg = transformEvent(event);
          if (msg.author?.bot || msg.author?.system) {
            res.writeHead(200); res.end('');
            return;
          }
          await handler(msg);
        }

        res.writeHead(200); res.end('');
      } catch (e) {
        log.error(`HTTP回调处理失败: ${e.message}`);
        res.writeHead(500); res.end('Error');
      }
    });
  });
  return server;
}

// ─── 启动 ──────────────────────────────────────────────────────────────────────
function init(config, token) {
  botConfig = config;
  callbackPath = process.env.QQ_BOT_CALLBACK_PATH || '/callback';
}

function getCallbackUrl() {
  return process.env.BOT_URL || botConfig?.callbackUrl || 'https://bot.mingpixel.net';
}

function start(handler, port) {
  const p = port || parseInt(process.env.BOT_PORT) || 9000;
  const server = createServer(handler);

  server.listen(p, '0.0.0.0', () => {
    const publicUrl = getCallbackUrl();
    const isNgrok = publicUrl.includes('ngrok') || publicUrl.includes('localhost');
    log.info(`HTTP回调服务器已启动  port=${p}  path=${callbackPath}`);
    log.info(`回调地址: ${publicUrl}${callbackPath}`);
    if (isNgrok) {
      log.info('请在 QQ 开放平台 → 事件订阅 → 回调地址 填入上方 URL');
    } else {
      log.info('生产模式：确保 bot.mingpixel.net/callback 反向代理到此端口');
    }
  });

  server.on('error', err => log.error(`HTTP服务器错误: ${err.message}`));
  return server;
}

module.exports = { init, start, getCallbackUrl };
