/**
 * QQ Guild Bot 入口文件
 */
const { Bot } = require('qq-guild-sdk');
const config = require('./config');
require('./builtins');
const { executeCommand, getAllCommands } = require('./commands');
const { startMonitor } = require('./bilibili');

const bot = new Bot({
  app: {
    id: config.appId,
    key: config.appKey || '',
    token: config.token,
  },
  sandbox: config.sandbox,
});

let monitorTimer = null;

bot.on('ready', async () => {
  console.log(`✅ 机器人已上线: ${bot.options.app.id}`);
  console.log(`📡 连接模式: ${config.sandbox ? '沙箱环境' : '正式环境'}`);
  const cmds = new Map();
  for (const [, c] of getAllCommands()) {
    if (!cmds.has(c.name)) cmds.set(c.name, c);
  }
  console.log(`📋 已加载 ${cmds.size} 个命令`);
  monitorTimer = startMonitor(bot, 5);
});

bot.on('error', error => console.error('❌ 机器人错误:', error));

bot.on('message', async (message) => {
  if (message.author.bot) return;
  const content = message.content?.trim() || '';
  if (content.startsWith('/')) {
    const parts = content.slice(1).split(/\s+/);
    const handled = await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
    if (handled) return;
  }
  if (content.startsWith('/')) {
    await bot.send.channel(message.channelId, '❓ 未知命令，发送 /help 查看');
  }
});

bot.on('guild-member:add', member => console.log(`👋 新成员: ${member.user.username}`));
bot.on('guild-member:del', member => console.log(`👋 成员退出: ${member.user.username}`));

// 私信消息处理
bot.on('message', async (message) => {
  if (message.isPrivate) {
    const content = message.content?.trim() || '';
    if (content.startsWith('/')) {
      const parts = content.slice(1).split(/\s+/);
      await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
    } else {
      await bot.send.private(message.guildId, '👋 收到私信！发送 /help 查看命令。');
    }
  }
});

async function start() {
  try {
    await bot.startClient([
      Bot.Intents.Guilds,
      Bot.Intents.GuildMembers,
      Bot.Intents.GuildMessages,
      Bot.Intents.DirectMessages,
      Bot.Intents.GuildMessageReactions,
    ]);
    console.log('🚀 机器人启动成功！');
  } catch (e) {
    console.error('❌ 启动失败:', e);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  if (monitorTimer) clearInterval(monitorTimer);
  bot.stopClient();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (monitorTimer) clearInterval(monitorTimer);
  bot.stopClient();
  process.exit(0);
});

start();
