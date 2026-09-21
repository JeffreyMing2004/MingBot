/**
 * QQ Bot 入口
 * 同时运行两种连接：
 *   群聊 — HTTP 回调模式（接收平台 POST 事件）
 *   频道 — WebSocket 模式（qq-guild-sdk 直连网关）
 */
const { Bot } = require('qq-guild-sdk');
const config = require('./config');
const { setReplyFn } = require('./builtins');
const { executeCommand, getAllCommands } = require('./commands');
const { startMonitor } = require('./bilibili');
const log = require('./logger');
const callbackServer = require('./server');

// ─── WebSocket Bot（频道） ─────────────────────────────────────────────────────
const bot = new Bot({
  app: { id: config.appId, key: config.appKey || '', token: config.token },
  sandbox: config.sandbox,
  authType: config.authType || 'bot',
});

let wsReady = false;

bot.on('ready', async () => {
  wsReady = true;
  log.info(`[WS] 频道机器人已上线  appId=${bot.options.app.id}`);
  const cmds = new Map();
  for (const [, c] of getAllCommands()) {
    if (!cmds.has(c.name)) cmds.set(c.name, c);
  }
  log.info(`[WS] 已加载 ${cmds.size} 个命令`);
});

bot.on('error', err => log.error(`[WS] 机器人错误: ${err.message || err}`));

bot.on('message', async (message) => {
  if (message.author?.bot) return;
  const content = (message.content || '').replace(/^\s*<@!?\d+>\s*/, '').trim();
  log.event(`[WS] 频道消息 guild=${message.guildId} channel=${message.channelId} user=${message.member?.nick || message.author?.username} content="${content}"`);
  if (!content.startsWith('/')) return;
  const parts = content.slice(1).split(/\s+/);
  await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
});

bot.on('guild-member:add', m => log.event(`[WS] 新成员 guild=${m.guildId} user=${m.user.username}`));
bot.on('guild-member:del',  m => log.event(`[WS] 成员退出 guild=${m.guildId} user=${m.user.username}`));

// ─── HTTP 回调（群聊） ─────────────────────────────────────────────────────────
async function handleMessage(message) {
  const content = (message.content || '').trim();
  log.event(`[HTTP] 群聊消息 source=${message.sourceType} openid=${message.groupOpenid || message.c2cOpenid || message.channelId} content="${content}"`);
  if (!content.startsWith('/')) return;
  const parts = content.slice(1).split(/\s+/);
  await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
}

// ─── 统一发送入口 ──────────────────────────────────────────────────────────────
function makeSendToTarget() {
  return async (target, text) => {
    if (target.targetType === 'group') {
      return callbackServer.sendToGroup(target.targetId, text);
    }
    // 频道消息优先用 WebSocket 发送（更稳定），fallback 到 HTTP
    if (wsReady) {
      try {
        await bot.send.channelMessage(target.targetId, text);
        return;
      } catch(e) {
        log.warn(`[WS] 频道发送失败，回退HTTP: ${e.message}`);
      }
    }
    return callbackServer.sendToChannel(target.targetId, text);
  };
}

// ─── 启动 ──────────────────────────────────────────────────────────────────────
async function start() {
  callbackServer.init(config, config.token);

  // 1. 启动 HTTP 回调服务器（处理群聊消息）
  setReplyFn((msg, text) => msg.reply(text));
  callbackServer.start(handleMessage, process.env.BOT_PORT);
  log.info('[HTTP] 群聊回调服务器已启动');

  // 2. 启动 WebSocket 连接（处理频道消息）
  try {
    await bot.startClient([
      Bot.Intents.Guilds,
      Bot.Intents.GuildMembers,
      Bot.Intents.GuildMessages,
      Bot.Intents.DirectMessages,
      Bot.Intents.GuildMessageReactions,
    ]);
    log.info('[WS] 频道 WebSocket 连接成功');
  } catch (e) {
    log.warn(`[WS] 频道 WebSocket 连接失败: ${e.message}（群聊功能不受影响）`);
  }

  // 3. 启动 B站监控（群聊和频道都能推送）
  startMonitor(null, 1, makeSendToTarget());
  log.info('[MONITOR] B站动态监控已启动');
}

process.on('SIGINT', async () => {
  log.info('收到停止信号，正在关闭...');
  process.exit(0);
});
process.on('SIGTERM', async () => {
  log.info('收到终止信号，正在关闭...');
  process.exit(0);
});

start();
