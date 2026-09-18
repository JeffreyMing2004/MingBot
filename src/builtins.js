/**
 * 内置命令实现
 * 包含基础命令与B站动态订阅命令
 */

const { registerCommand } = require('./commands');
const {
  addSubscription,
  removeSubscription,
  getSubscriptions,
  searchUpByName,
  setBiliCookie,
  getBiliConfig,
} = require('./bilibili');

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
    const uniqueCommands = new Map();
    for (const [name, cmd] of commands) {
      if (!uniqueCommands.has(cmd.name)) {
        uniqueCommands.set(cmd.name, cmd);
      }
    }

    let helpText = '📋 **可用命令列表**\n\n';
    helpText += '**🔧 基础命令**\n';
    for (const name of ['ping', 'help', 'about', 'echo', 'time', 'random']) {
      const cmd = uniqueCommands.get(name);
      if (cmd) {
        helpText += `• \`/${name}\` - ${cmd.description}\n`;
        if (cmd.aliases.length > 0) helpText += `  别名: ${cmd.aliases.map(a => \`/\${a}\`).join(', ')}\n`;
      }
    }
    helpText += '\n**📺 B站动态监控**\n';
    for (const name of ['bili_sub', 'bili_unsub', 'bili_list', 'bili_search', 'bili_cookie', 'bili_config']) {
      const cmd = uniqueCommands.get(name);
      if (cmd) {
        helpText += `• \`/${name}\` - ${cmd.description}\n`;
        if (cmd.aliases.length > 0) helpText += `  别名: ${cmd.aliases.map(a => \`/\${a}\`).join(', ')}\n`;
      }
    }
    await message.reply(helpText.trim());
  },
  aliases: ['h', '?'],
});

/**
 * About 命令
 */
registerCommand('about', {
  description: '显示机器人信息',
  handler: async (message) => {
    await message.reply('🤖 **MingBot**\n基于 QQ Bot API v2 + B站动态监控\n📚 https://bot.q.qq.com/wiki/develop/api-v2/');
  },
  aliases: ['info'],
});

/**
 * Echo 命令
 */
registerCommand('echo', {
  description: '复述消息',
  handler: async (message, args) => {
    if (args.length === 0) return await message.reply('用法: `/echo <内容>`');
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
    const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    await message.reply(`🕐 ${timeStr}`);
  },
  aliases: ['date', 'now'],
});

/**
 * 随机数命令
 */
registerCommand('random', {
  description: '生成随机数',
  handler: async (message, args) => {
    let min = 0, max = 100;
    if (args.length >= 1) min = parseInt(args[0]) || 0;
    if (args.length >= 2) max = parseInt(args[1]) || 100;
    if (min > max) [min, max] = [max, min];
    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    await message.reply(`🎲 ${min}-${max}: ${result}`);
  },
  aliases: ['rand', 'roll'],
});

/**
 * B站订阅命令
 */
registerCommand('bili_sub', {
  description: '订阅B站UP主动态推送',
  handler: async (message, args) => {
    if (!message.guild_id) return await message.reply('❌ 仅支持在频道中使用');
    if (args.length === 0) return await message.reply('用法: `/bili_sub <UID或名称>`');
    
    const guildId = message.guild_id;
    const channelId = message.channel_id;
    const upList = [];
    const failed = [];
    
    for (const arg of args) {
      if (/^\d+$/.test(arg)) {
        upList.push({ uid: arg, name: `UID:${arg}` });
      } else {
        const results = await searchUpByName(arg);
        if (results.length === 0) failed.push(arg);
        else if (results.length === 1) upList.push({ uid: results[0].uid, name: results[0].name });
        else {
          let msg = `找到多个结果，请使用UID订阅:\n`;
          results.forEach((r, i) => msg += `${i+1}. ${r.name} (UID: ${r.uid})\n`);
          return await message.reply(msg);
        }
      }
    }
    
    if (failed.length > 0) return await message.reply(`❌ 未找到: ${failed.join(', ')}`);
    if (upList.length === 0) return;
    
    const result = addSubscription(guildId, channelId, upList);
    await message.reply(`✅ 订阅成功!\n📺 <#${channelId}>\n👤 ${result.upList.map(u => u.name).join(', ')}`);
  },
  aliases: ['bsub', 'subscribe'],
});

/**
 * B站取消订阅
 */
registerCommand('bili_unsub', {
  description: '取消订阅B站UP主',
  handler: async (message, args) => {
    if (!message.guild_id) return await message.reply('❌ 仅支持在频道中使用');
    if (args.length === 0) return await message.reply('用法: `/bili_unsub <UID>`');
    removeSubscription(message.guild_id, args[0]);
    await message.reply(`✅ 已取消订阅 UID: ${args[0]}`);
  },
  aliases: ['bunsub', 'unsubscribe'],
});

/**
 * B站订阅列表
 */
registerCommand('bili_list', {
  description: '查看订阅列表',
  handler: async (message) => {
    if (!message.guild_id) return await message.reply('❌ 仅支持在频道中使用');
    const upList = getSubscriptions(message.guild_id);
    if (upList.length === 0) return await message.reply('📭 暂无订阅');
    let msg = `📋 订阅列表 (${upList.length}个):\n\n`;
    upList.forEach((up, i) => msg += `${i+1}. ${up.name} (UID: ${up.uid})\n`);
    await message.reply(msg);
  },
  aliases: ['blist', 'sublist'],
});

/**
 * B站搜索UP主
 */
registerCommand('bili_search', {
  description: '搜索B站UP主',
  handler: async (message, args) => {
    if (args.length === 0) return await message.reply('用法: `/bili_search <关键词>`');
    const results = await searchUpByName(args.join(' '));
    if (results.length === 0) return await message.reply('🔍 未找到');
    let msg = `🔍 搜索结果:\n\n`;
    results.forEach((r, i) => msg += `${i+1}. ${r.name} (UID: ${r.uid})\n`);
    msg += '\n使用 `/bili_sub <UID>` 订阅';
    await message.reply(msg);
  },
  aliases: ['bsearch'],
});

/**
 * 设置B站Cookie
 */
registerCommand('bili_cookie', {
  description: '设置B站Cookie (解决412限制)',
  handler: async (message, args) => {
    if (args.length === 0) return await message.reply('用法: `/bili_cookie <Cookie>`\n获取方法: 浏览器F12 -> Network -> 复制任意请求的Cookie头');
    setBiliCookie(args.join(' '));
    await message.reply('✅ Cookie已保存，重启后生效');
  },
  aliases: ['bcookie', 'cookie'],
});

/**
 * 查看B站配置
 */
registerCommand('bili_config', {
  description: '查看当前配置状态',
  handler: async (message) => {
    const config = getBiliConfig();
    const hasCookie = config.cookie && config.cookie.length > 10;
    let msg = `📊 B站配置状态:\n\n`;
    msg += `Cookie: ${hasCookie ? '✅ 已配置' : '❌ 未配置'}\n`;
    msg += `UserAgent: 默认\n\n`;
    msg += '💡 使用 /bili_cookie 设置Cookie可提高成功率';
    await message.reply(msg);
  },
  aliases: ['bconfig'],
});

console.log('✅ 内置命令已加载');