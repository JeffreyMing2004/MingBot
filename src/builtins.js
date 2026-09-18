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
  loadSubscriptions,
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
    
    // 去重（因为别名会重复）
    const uniqueCommands = new Map();
    for (const [name, cmd] of commands) {
      if (!uniqueCommands.has(cmd.name)) {
        uniqueCommands.set(cmd.name, cmd);
      }
    }

    let helpText = '📋 **可用命令列表**\n\n';
    
    // 基础命令
    helpText += '**🔧 基础命令**\n';
    const basicCmds = ['ping', 'help', 'about', 'echo', 'time', 'random'];
    for (const name of basicCmds) {
      const cmd = uniqueCommands.get(name);
      if (cmd) {
        helpText += `• \`/${name}\` - ${cmd.description}\n`;
        if (cmd.aliases.length > 0) {
          helpText += `  别名: ${cmd.aliases.map(a => `\`/${a}\``).join(', ')}\n`;
        }
      }
    }
    
    // B站监控命令
    helpText += '\n**📺 B站动态监控**\n';
    const biliCmds = ['bili_sub', 'bili_unsub', 'bili_list', 'bili_search'];
    for (const name of biliCmds) {
      const cmd = uniqueCommands.get(name);
      if (cmd) {
        helpText += `• \`/${name}\` - ${cmd.description}\n`;
        if (cmd.aliases.length > 0) {
          helpText += `  别名: ${cmd.aliases.map(a => `\`/${a}\``).join(', ')}\n`;
        }
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
🤖 **MingBot - QQ Guild Bot**
基于 QQ Bot API v2 开发

📚 **文档**: https://bot.q.qq.com/wiki/develop/api-v2/
💡 **功能**: 频道消息、私信、成员事件、B站动态监控
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

/**
 * B站订阅命令 - 订阅UP主动态
 * 用法: /bili_sub <UP主UID或名称> [UP主UID或名称...]
 */
registerCommand('bili_sub', {
  description: '订阅B站UP主动态推送 (支持UID或名称搜索)',
  handler: async (message, args) => {
    // 只有频道消息才能订阅
    if (!message.guild_id) {
      await message.reply('❌ 此命令仅支持在频道中使用');
      return;
    }
    
    if (args.length === 0) {
      await message.reply('用法: `/bili_sub <UP主UID或名称> [更多...]`\n示例: `/bili_sub 123456` 或 `/bili_sub 灵梦`');
      return;
    }
    
    const guildId = message.guild_id;
    const channelId = message.channel_id;
    const upList = [];
    const failed = [];
    
    for (const arg of args) {
      // 如果是纯数字，当作UID处理
      if (/^\d+$/.test(arg)) {
        upList.push({ uid: arg, name: `UID:${arg}` });
      } else {
        // 否则搜索UP主
        const results = await searchUpByName(arg);
        if (results.length === 0) {
          failed.push(arg);
        } else if (results.length === 1) {
          upList.push({ uid: results[0].uid, name: results[0].name });
        } else {
          // 多个结果，让用户选择
          let msg = `🔍 搜索 "${arg}" 找到多个结果:\n\n`;
          results.forEach((r, i) => {
            msg += `${i + 1}. **${r.name}** (UID: ${r.uid})\n   简介: ${r.sign || '无'}\n\n`;
          });
          msg += '请使用完整UID订阅，如: `/bili_sub 123456`';
          await message.reply(msg);
        }
      }
    }
    
    if (failed.length > 0) {
      await message.reply(`❌ 未找到以下UP主: ${failed.join(', ')}`);
    }
    
    if (upList.length > 0) {
      const result = addSubscription(guildId, channelId, upList);
      const names = upList.map(u => u.name).join(', ');
      await message.reply(`✅ 订阅成功！\n📺 频道: <#${channelId}>\n👤 UP主: ${names}\n⏰ 每5分钟检测一次更新`);
    }
  },
  aliases: ['bsub', 'subscribe', '订阅'],
});

/**
 * B站取消订阅命令
 * 用法: /bili_unsub <UP主UID>
 */
registerCommand('bili_unsub', {
  description: '取消订阅B站UP主动态',
  handler: async (message, args) => {
    if (!message.guild_id) {
      await message.reply('❌ 此命令仅支持在频道中使用');
      return;
    }
    
    if (args.length === 0) {
      await message.reply('用法: `/bili_unsub <UP主UID>`\n示例: `/bili_unsub 123456`');
      return;
    }
    
    const guildId = message.guild_id;
    const uid = args[0];
    
    removeSubscription(guildId, uid);
    await message.reply(`✅ 已取消订阅 UID: ${uid}`);
  },
  aliases: ['bunsub', 'unsubscribe', '取消订阅'],
});

/**
 * B站订阅列表命令
 */
registerCommand('bili_list', {
  description: '查看当前频道的B站动态订阅列表',
  handler: async (message) => {
    if (!message.guild_id) {
      await message.reply('❌ 此命令仅支持在频道中使用');
      return;
    }
    
    const guildId = message.guild_id;
    const upList = getSubscriptions(guildId);
    
    if (upList.length === 0) {
      await message.reply('📭 当前频道暂无B站动态订阅\n使用 `/bili_sub <UID>` 添加订阅');
      return;
    }
    
    let msg = `📋 **当前频道订阅列表** (共 ${upList.length} 个)\n\n`;
    upList.forEach((up, i) => {
      msg += `${i + 1}. **${up.name}** (UID: ${up.uid})\n`;
    });
    msg += '\n使用 `/bili_unsub <UID>` 取消订阅';
    
    await message.reply(msg);
  },
  aliases: ['blist', 'sublist', '订阅列表'],
});

/**
 * B站搜索UP主命令
 */
registerCommand('bili_search', {
  description: '搜索B站UP主 (按名称)',
  handler: async (message, args) => {
    if (args.length === 0) {
      await message.reply('用法: `/bili_search <关键词>`\n示例: `/bili_search 灵梦`');
      return;
    }
    
    const keyword = args.join(' ');
    const results = await searchUpByName(keyword);
    
    if (results.length === 0) {
      await message.reply(`🔍 未找到 "${keyword}" 相关的UP主`);
      return;
    }
    
    let msg = `🔍 搜索 "${keyword}" 结果:\n\n`;
    results.forEach((r, i) => {
      msg += `${i + 1}. **${r.name}**\n`;
      msg += `   UID: ${r.uid}\n`;
      if (r.sign) msg += `   简介: ${r.sign.slice(0, 50)}${r.sign.length > 50 ? '...' : ''}\n`;
      msg += '\n';
    });
    msg += '使用 `/bili_sub <UID>` 订阅';
    
    await message.reply(msg);
  },
  aliases: ['bsearch', '搜索UP'],
});

console.log('✅ 内置命令已加载 (含B站监控命令)');
