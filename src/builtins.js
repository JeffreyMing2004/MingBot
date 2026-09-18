/**
 * 示例：内置命令实现
 */

const { registerCommand } = require('./commands');

/**
 * Ping 命令 - 测试机器人响应
 */
registerCommand('ping', {
  description: '测试机器人响应速度',
  handler: async (message) => {
    const start = Date.now();
    const reply = await message.reply('🏓 Pong!');
    const latency = Date.now() - start;
    await reply.edit(`🏓 Pong! 延迟: ${latency}ms`);
  },
  aliases: ['p'],
});

/**
 * Help 命令 - 显示帮助信息
 */
registerCommand('help', {
  description: '显示所有可用命令',
  handler: async (message) => {
    const { getAllCommands } = require('./commands');
    const commands = getAllCommands();
    
    // 去重（因为别名会重复）
    const uniqueCommands = new Map();
    for (const [name, cmd] of commands) {
      if (!uniqueCommands.has(cmd.name)) {
        uniqueCommands.set(cmd.name, cmd);
      }
    }

    let helpText = '📋 **可用命令列表**\n\n';
    for (const [name, cmd] of uniqueCommands) {
      helpText += `• \`/${name}\` - ${cmd.description}\n`;
      if (cmd.aliases.length > 0) {
        helpText += `  别名: ${cmd.aliases.map(a => `\`/${a}\``).join(', ')}\n`;
      }
    }
    
    await message.reply(helpText.trim());
  },
  aliases: ['h', '?'],
});

/**
 * About 命令 - 关于机器人
 */
registerCommand('about', {
  description: '显示机器人信息',
  handler: async (message) => {
    const info = `
🤖 **QQ Guild Bot 模板**
基于 QQ Bot API v2 开发

📚 **文档**: https://bot.q.qq.com/wiki/develop/api-v2/
💡 **功能**: 频道消息、私信、成员事件、表情反应等
    `.trim();
    await message.reply(info);
  },
  aliases: ['info'],
});

/**
 * Echo 命令 - 复述消息
 */
registerCommand('echo', {
  description: '复述你的消息',
  handler: async (message, args) => {
    if (args.length === 0) {
      await message.reply('用法: `/echo <要复述的内容>`');
      return;
    }
    await message.reply(args.join(' '));
  },
  aliases: ['say', 'repeat'],
});

/**
 * 时间命令
 */
registerCommand('time', {
  description: '显示当前时间',
  handler: async (message) => {
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    await message.reply(`🕐 当前时间: ${timeStr}`);
  },
  aliases: ['date', 'now'],
});

/**
 * 随机数命令
 */
registerCommand('random', {
  description: '生成随机数',
  handler: async (message, args) => {
    let min = 0;
    let max = 100;

    if (args.length >= 1) {
      min = parseInt(args[0]) || 0;
    }
    if (args.length >= 2) {
      max = parseInt(args[1]) || 100;
    }

    if (min > max) {
      [min, max] = [max, min];
    }

    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    await message.reply(`🎲 随机数 (${min}-${max}): **${result}**`);
  },
  aliases: ['rand', 'roll'],
});

console.log('✅ 内置命令已加载');
