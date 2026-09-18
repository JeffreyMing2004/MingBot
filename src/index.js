/**
 * QQ Guild Bot 入口文件
 */
const { Client, Intents, Events } = require('qq-guild-bot');
const { config } = require('./config');
require('./builtins');
const { executeCommand, getAllCommands } = require('./commands');
const { startMonitor } = require('./bilibili');

const client = new Client({
  appId: config.appId,
  token: config.token,
  intents: [Intents.GUILD_MESSAGES, Intents.DIRECT_MESSAGES, Intents.GUILD_MEMBERS, Intents.GUILD_MESSAGE_REACTIONS],
  sandbox: config.sandbox,
});

let monitorTimer = null;

client.on(Events.READY, (readyData) => {
  console.log(`✅ 机器人已上线: ${readyData.user.username}#${readyData.user.id}`);
  console.log(`📡 连接模式: ${config.sandbox ? '沙箱环境' : '正式环境'}`);
  const cmds = new Map(); for(const [,c] of getAllCommands()) if(!cmds.has(c.name)) cmds.set(c.name,c);
  console.log(`📋 已加载 ${cmds.size} 个命令`);
  monitorTimer = startMonitor(client, 5);
});

client.on(Events.ERROR, error => console.error('❌ 机器人错误:', error));

client.on(Events.MESSAGE_CREATE, async (message) => {
  if (message.author.bot || message.type !== 0) return;
  const content = message.content.trim();
  if (content.startsWith('/')) {
    const parts = content.slice(1).split(/\s+/);
    const handled = await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
    if (handled) return;
  }
  if (content.startsWith('/')) await message.reply('❓ 未知命令，发送 /help 查看');
});

client.on(Events.DIRECT_MESSAGE_CREATE, async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().startsWith('/')) {
    const parts = message.content.trim().slice(1).split(/\s+/);
    await executeCommand(message, parts[0].toLowerCase(), parts.slice(1));
  } else {
    await message.reply('👋 收到私信！发送 /help 查看命令。');
  }
});

client.on(Events.GUILD_MEMBER_ADD, member => console.log(`👋 新成员: ${member.user.username}`));
client.on(Events.GUILD_MEMBER_REMOVE, member => console.log(`👋 成员退出: ${member.user.username}`));
client.on(Events.MESSAGE_REACTION_ADD, reaction => console.log(`✨ 表情反应: ${reaction.emoji.name}`));

async function start() {
  try { await client.start(); console.log('🚀 机器人启动成功！'); }
  catch(e) { console.error('❌ 启动失败:', e); process.exit(1); }
}

process.on('SIGINT', async () => { if(monitorTimer) clearInterval(monitorTimer); await client.stop(); process.exit(0); });
process.on('SIGTERM', async () => { if(monitorTimer) clearInterval(monitorTimer); await client.stop(); process.exit(0); });

start();