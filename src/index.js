/**
 * QQ Guild Bot 入口文件
 */
const { Bot } = require('qq-guild-sdk');
const config = require('./config');
require('./builtins');
const { executeCommand, getAllCommands } = require('./commands');
const { startMonitor } = require('./bilibili');
const log = require('./logger');

const bot = new Bot({
  app: {
    id: config.appId,
    key: config.appKey || '',
    token: config.token,
  },
  sandbox: config.sandbox,
});

let monitorTimer = null;

// 上线事件
bot.on('ready', async () => {
  log.info(`机器人已上线 appId=${bot.options.app.id}`);
  log.info(`连接模式: ${config.sandbox ? '沙箱' : '正式'}`);
  const cmds = new Map();
  for (const [, c] of getAllCommands()) {
    if (!cmds.has(c.name)) cmds.set(c.name, c);
  }
  log.info(`已加载 ${cmds.size} 个命令`);
  monitorTimer = startMonitor(bot, 5);
});

bot.on('error', error => log.error(`机器人错误: ${error.message}`));

// 群消息事件
bot.on('message', async (message) => {
  if (message.author.bot) return;

  // 私聊消息
  if (message.isPrivate) {
    const content = message.content?.trim() || '';
    log.event(`[获取到私信] from=${message.guildId} content="${content}"`);
    if (content.startsWith('/')) {
      const parts = content.slice(1).split(/\s+/);
      await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
    } else {
      await bot.send.private(message.guildId, '👋 收到私信！发送 /help 查看命令。');
    }
    return;
  }

  // 群消息
  const content = message.content?.trim() || '';
  log.event(`[获取到群消息] guildId=${message.guildId} channelId=${message.channelId} author=${message.member?.nick || message.author.username} content="${content}"`);

  if (content.startsWith('/')) {
    const parts = content.slice(1).split(/\s+/);
    const handled = await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
    if (handled) return;
  }
  if (content.startsWith('/')) {
    await bot.send.channel(message.channelId, '❓ 未知命令，发送 /help 查看');
  }
});

// 成员变动
bot.on('guild-member:add', member => log.event(`[新成员加入] guildId=${member.guildId} user=${member.user.username}`));
bot.on('guild-member:del', member => log.event(`[成员退出] guildId=${member.guildId} user=${member.user.username}`));

async function start() {
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
  if (monitorTimer) clearInterval(monitorTimer);
  bot.stopClient();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  log.info('收到终止信号，正在关闭...');
  if (monitorTimer) clearInterval(monitorTimer);
  bot.stopClient();
  process.exit(0);
});

start();
