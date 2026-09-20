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
 */
const http = require('http');
const https = require('https');
const nacl = require('tweetnacl');
const log = require('./logger');

let botConfig = null;
let callbackPath = '/callback';
let accessToken = null;
let tokenExpireAt = 0;

// ─── Ed25519 密钥派生 ─────────────────────────────────────────────────────────
// QQ 文档：seed = botSecret，若不足 32 字节则重复拼接，取前 32 字节
function deriveKeypair(secret) {
  let seed = Buffer.from(secret);
  while (seed.length < 32) {
    seed = Buffer.concat([seed, seed]);
  }
  seed = seed.slice(0, 32);
  return nacl.sign.keyPair.fromSeed(seed);
}

// 用 AppSecret 签名消息，返回 hex 字符串
function signMessage(secret, message) {
  const kp = deriveKeypair(secret);
  const sig = nacl.sign.detached(Buffer.from(message), kp.secretKey);
  return Buffer.from(sig).toString('hex');
}

// 用 AppSecret 派生的公钥验证签名
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

// ─── 签名校验中间件 ────────────────────────────────────────────────────────────
function buildVerifier(secret) {
  return function verify(req, res, next) {
    const sigHeader = req.headers['x-signature-ed25519'];
    const tsHeader = req.headers['x-signature-timestamp'];

    if (sigHeader && tsHeader) {
      // 有签名头：先读取 body，再校验
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
      // 无签名头（opcode 13 验证请求可能不带签名），直接读取 body
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
function createServer(handler, secret) {
  const verify = buildVerifier(secret);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signature-Ed25519, X-Signature-Timestamp, X-Bot-Appid');

    if (req.method === 'OPTIONS') {
      res.writeHead(200); res.end(); return;
    }

    if (req.url !== callbackPath || req.method !== 'POST') {
      res.writeHead(404); res.end('Not Found'); return;
    }

    verify(req, res, async () => {
      const body = req._body;
      try {
        const event = JSON.parse(body);

        // ── opcode 13: 回调地址验证 ──
        if (event.op === 13) {
          log.info('[回调验证] 收到开放平台验证请求');
          const plainToken = event.d?.plain_token || '';
          const eventTs = event.d?.event_ts || '';

          // 签名消息 = event_ts + plain_token
          const sig = signMessage(secret, eventTs + plainToken);
          log.info(`[回调验证] plain_token=${plainToken} signature=${sig.substring(0, 16)}...`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ plain_token: plainToken, signature: sig }));
          return;
        }

        // ── opcode 12: HTTP Callback ACK（平台确认收到）──
        if (event.op === 12) {
          log.info('[HTTP ACK] 平台已确认收到事件');
          res.writeHead(200); res.end('');
          return;
        }

        // ── opcode 0: Dispatch（普通事件）──
        log.event(`[HTTP回调] type=${event.t || event.type || 'unknown'} guild=${event.d?.guild_id} channel=${event.d?.channel_id}`);

        // READY 事件必须返回空字符串
        if (event.t === 'READY' || event.type === 'READY') {
          log.info(`[READY] appId=${event.d?.appid || botConfig?.appId} bot=${event.d?.user?.username || 'unknown'}`);
          res.writeHead(200); res.end('');
          return;
        }

        // MESSAGE_CREATE 事件
        if (event.t === 'MESSAGE_CREATE' || event.type === 'MESSAGE_CREATE') {
          const msg = transformEvent(event.d);
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
  // 使用 appSecret 进行签名校验（与 token 字段相同值）
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

module.exports = { init, start, getCallbackUrl, getAccessToken, signMessage, verifySignature, deriveKeypair };
