/**
 * QQ Guild Bot 入口
 * 支持两种模式：
 *   WebSocket（默认）— 通过 qq-guild-sdk 直连网关
 *   HTTP回调         — 接收 POST 事件，配合 ngrok / bot.mingpixel.net
 */
const { Bot } = require('qq-guild-sdk');
const config = require('./config');
const { setReplyFn } = require('./builtins');
const { executeCommand, getAllCommands } = require('./commands');
const { startMonitor } = require('./bilibili');
const log = require('./logger');
const callbackServer = require('./server');

const bot = new Bot({
  app: { id: config.appId, key: config.appKey || '', token: config.token },
  sandbox: config.sandbox,
  authType: config.authType || 'bot',
});

const useCallback = process.env.QQ_BOT_USE_CALLBACK === 'true' || config.mode === 'callback';

// ─── WebSocket 模式 ───────────────────────────────────────────────────────────
bot.on('ready', async () => {
  log.info(`机器人已上线  appId=${bot.options.app.id}`);
  log.info(`连接模式: ${config.sandbox ? '沙箱' : '正式'}`);
  const cmds = new Map();
  for (const [, c] of getAllCommands()) {
    if (!cmds.has(c.name)) cmds.set(c.name, c);
  }
  log.info(`已加载 ${cmds.size} 个命令`);
  startMonitor(bot, 5);
});

bot.on('error', err => log.error(`机器人错误: ${err.message || err}`));

bot.on('message', async (message) => {
  if (message.author?.bot) return;
  // 频道@消息 content 带 <@!机器人ID> 前缀，先剥离再解析命令
  const content = (message.content || '').replace(/^\s*<@!?\d+>\s*/, '').trim();
  log.event(`[群消息] guild=${message.guildId} channel=${message.channelId} user=${message.member?.nick || message.author?.username} content="${content}"`);
  if (!content.startsWith('/')) return;
  const parts = content.slice(1).split(/\s+/);
  await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
});

bot.on('guild-member:add', m => log.event(`[新成员] guild=${m.guildId} user=${m.user.username}`));
bot.on('guild-member:del',  m => log.event(`[成员退出] guild=${m.guildId} user=${m.user.username}`));

// ─── HTTP 回调模式 ────────────────────────────────────────────────────────────
async function handleMessage(message) {
  // @机器人过滤已在 server.js 按事件类型处理：
  // 群聊@/频道@/单聊事件平台只在命中机器人时才推送，只有私域全量消息需要过滤
  const content = (message.content || '').trim();
  log.event(`[回调消息] source=${message.sourceType} openid=${message.groupOpenid || message.c2cOpenid || message.channelId} content="${content}"`);
  if (!content.startsWith('/')) return;
  const parts = content.slice(1).split(/\s+/);
  await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
}
async function start() {
  if (useCallback) {
    callbackServer.init(config, config.token);
    setReplyFn((msg, text) => msg.reply(text));
    callbackServer.start(handleMessage, process.env.BOT_PORT);
    // B站监控推送：频道发消息接口没有 /v2 前缀（/v2 是群聊/单聊专用）
    const apiBase = config.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
    const axios = require('axios');
    const { getAccessToken } = callbackServer;
    const sendToChannel = async (channelId, text) => {
      try {
        const token = await getAccessToken();
        await axios.post(
          `${apiBase}/channels/${channelId}/messages`,
          { content: text },
          { headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
      } catch(e) { log.error(`[BILI] 发送失败: ${e.message}`); }
    };
    startMonitor(null, 5, sendToChannel);
    return;
  }

  try {
    await bot.startClient([
      Bot.Intents.Guilds,
      Bot.Intents.GuildMembers,
      Bot.Intents.GuildMessages,
      Bot.Intents.DirectMessages,
      Bot.Intents.GuildMessageReactions,
    ]);
    log.info('WebSocket 连接成功');
  } catch (e) {
    log.error(`启动失败: ${e.message}`);
    process.exit(1);
  }
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
