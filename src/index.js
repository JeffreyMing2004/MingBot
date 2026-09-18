/**
 * QQ Guild Bot 入口文件
 * 基于 QQ Bot API v2 (https://bot.q.qq.com/wiki/develop/api-v2/)
 * 集成 B站动态监控功能
 */

const { Client, Intents, Events } = require('qq-guild-bot');
const { config } = require('./config');
require('./builtins'); // 加载内置命令
const { executeCommand, getAllCommands } = require('./commands');
const { startDynamicMonitor } = require('./bilibili');

/**
 * 创建机器人客户端实例
 * Intents.GUILD_MESSAGES - 接收频道消息
 * Intents.DIRECT_MESSAGES - 接收私信消息
 * Intents.GUILD_MEMBERS - 接收成员事件
 * Intents.GUILD_MESSAGE_REACTIONS - 接收消息表情反应
 */
const client = new Client({
  appId: config.appId,
  token: config.token,
  intents: [
    Intents.GUILD_MESSAGES,
    Intents.DIRECT_MESSAGES,
    Intents.GUILD_MEMBERS,
    Intents.GUILD_MESSAGE_REACTIONS,
  ],
  // 沙箱环境设置为 true，正式环境设置为 false
  sandbox: config.sandbox,
});

let monitorTimer = null;

/**
 * 机器人就绪事件
 */
client.on(Events.READY, (readyData) => {
  console.log(`✅ 机器人已上线: ${readyData.user.username}#${readyData.user.id}`);
  console.log(`📡 连接模式: ${config.sandbox ? '沙箱环境' : '正式环境'}`);
  
  // 显示已注册的命令
  const commands = getAllCommands();
  const uniqueCommands = new Map();
  for (const [name, cmd] of commands) {
    if (!uniqueCommands.has(cmd.name)) {
      uniqueCommands.set(cmd.name, cmd);
    }
  }
  console.log(`📋 已加载 ${uniqueCommands.size} 个命令: ${Array.from(uniqueCommands.keys()).join(', ')}`);
  
  // 启动 B站动态监控 (每5分钟检测一次)
  monitorTimer = startDynamicMonitor(client, 5);
});

/**
 * 错误处理
 */
client.on(Events.ERROR, (error) => {
  console.error('❌ 机器人错误:', error);
});

/**
 * 频道消息事件
 */
client.on(Events.MESSAGE_CREATE, async (message) => {
  // 忽略机器人自己发送的消息
  if (message.author.bot) return;

  // 忽略系统消息
  if (message.type !== 0) return;

  const content = message.content.trim();

  // 解析命令：/command arg1 arg2 ...
  if (content.startsWith('/')) {
    const parts = content.slice(1).split(/\s+/);
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    const handled = await executeCommand(message, commandName, args);
    if (handled) return;
  }

  // 未识别的命令
  if (content.startsWith('/')) {
    await message.reply(`❓ 未知命令: ${content}\n发送 /help 查看可用命令。`);
  }
});

/**
 * 私信消息事件
 */
client.on(Events.DIRECT_MESSAGE_CREATE, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  
  if (content.startsWith('/')) {
    const parts = content.slice(1).split(/\s+/);
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    const handled = await executeCommand(message, commandName, args);
    if (handled) return;
  }

  await message.reply('👋 收到你的私信啦！发送 /help 查看可用命令。');
});

/**
 * 成员加入事件
 */
client.on(Events.GUILD_MEMBER_ADD, async (member) => {
  console.log(`👋 新成员加入: ${member.user.username} (${member.guild_id})`);
  // 可以在这里发送欢迎消息
  // await client.postMessage(member.guild_id, welcomeChannelId, { content: `欢迎 ${member.user.username}！` });
});

/**
 * 成员退出事件
 */
client.on(Events.GUILD_MEMBER_REMOVE, async (member) => {
  console.log(`👋 成员退出: ${member.user.username} (${member.guild_id})`);
});

/**
 * 消息表情反应事件
 */
client.on(Events.MESSAGE_REACTION_ADD, async (reaction) => {
  console.log(`✨ 收到表情反应: ${reaction.emoji.name} 来自用户 ${reaction.user_id}`);
});

/**
 * 启动机器人
 */
async function start() {
  try {
    await client.start();
    console.log('🚀 机器人启动成功！');
  } catch (error) {
    console.error('❌ 机器人启动失败:', error);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\n🛑 正在关闭机器人...');
  if (monitorTimer) {
    clearInterval(monitorTimer);
    console.log('🕐 B站动态监控已停止');
  }
  await client.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 正在关闭机器人...');
  if (monitorTimer) {
    clearInterval(monitorTimer);
    console.log('🕐 B站动态监控已停止');
  }
  await client.stop();
  process.exit(0);
});

start();
