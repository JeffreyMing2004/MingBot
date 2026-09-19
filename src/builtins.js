const { registerCommand } = require('./commands');

/**
 * 包装消息回复，适配新 SDK
 */
function replyMessage(message, text) {
  if (message.isPrivate) {
    return bot.send.private(message.guildId, text);
  }
  return bot.send.channel(message.channelId, text);
}

// 注册命令前需要 bot 实例，这里延迟绑定
let botInstance = null;
function setBot(b) { botInstance = b; }
function getBot() { return botInstance; }

const { addSub, removeSub, listSub, searchUp, saveBiliConfig, loadBiliConfig, getApiStatus } = require('./bilibili');

registerCommand('ping', {
  description: '测试响应',
  handler: async (m) => {
    const s = Date.now();
    await replyMessage(m, 'Pong!');
    const r = Date.now() - s;
    await replyMessage(m, `Pong! ${r}ms`);
  },
  aliases: ['p'],
});

registerCommand('help', {
  description: '显示帮助',
  handler: async (m) => {
    const { getAllCommands } = require('./commands');
    const cmds = new Map();
    for (const [, c] of getAllCommands()) {
      if (!cmds.has(c.name)) cmds.set(c.name, c);
    }
    let msg = '📋 命令列表:\n\n';
    for (const [n, c] of cmds) {
      msg += `/${n} - ${c.description}\n`;
    }
    await replyMessage(m, msg);
  },
  aliases: ['h', '?'],
});

registerCommand('about', {
  description: '关于',
  handler: async (m) => {
    await replyMessage(m, '🤖 MingBot - QQ频道机器人 + B站监控');
  },
  aliases: ['info'],
});

registerCommand('echo', {
  description: '复述',
  handler: async (m, a) => {
    if (!a.length) return await replyMessage(m, '用法: /echo <内容>');
    await replyMessage(m, a.join(' '));
  },
  aliases: ['say'],
});

registerCommand('time', {
  description: '时间',
  handler: async (m) => {
    const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    await replyMessage(m, `🕐 ${t}`);
  },
  aliases: ['date'],
});

registerCommand('random', {
  description: '随机数',
  handler: async (m, a) => {
    let min = 0, max = 100;
    if (a[0]) min = parseInt(a[0]);
    if (a[1]) max = parseInt(a[1]);
    if (min > max) [min, max] = [max, min];
    const r = Math.floor(Math.random() * (max - min + 1)) + min;
    await replyMessage(m, `🎲 ${min}-${max}: ${r}`);
  },
  aliases: ['rand'],
});

// B站相关命令
registerCommand('bili_sub', {
  description: '订阅B站UP主',
  handler: async (m, a) => {
    if (!m.guildId) return await replyMessage(m, '❌ 仅频道可用');
    if (!a.length) return await replyMessage(m, '用法: /bili_sub <UID或名称>');
    const g = m.guildId, ch = m.channelId, subs = [];
    for (const arg of a) {
      if (/^\d+$/.test(arg)) {
        subs.push({ uid: arg, name: `UID:${arg}` });
      } else {
        const r = await searchUp(arg);
        if (!r.length) continue;
        if (r.length === 1) {
          subs.push({ uid: r[0].uid, name: r[0].name });
        } else {
          let msg = '多个结果，请使用UID:\n';
          r.forEach((x, i) => { msg += `${i + 1}. ${x.name}(UID:${x.uid})\n`; });
          return await replyMessage(m, msg);
        }
      }
    }
    if (!subs.length) return;
    addSub(g, ch, subs[0].uid, subs[0].name);
    await replyMessage(m, `✅ 已订阅 ${subs[0].name}\n📺 <#${ch}>`);
  },
  aliases: ['bsub'],
});

registerCommand('bili_unsub', {
  description: '取消订阅',
  handler: async (m, a) => {
    if (!m.guildId) return await replyMessage(m, '❌ 仅频道可用');
    if (!a.length) return await replyMessage(m, '用法: /bili_unsub <UID>');
    removeSub(m.guildId, a[0]);
    await replyMessage(m, `✅ 已取消订阅 UID:${a[0]}`);
  },
  aliases: ['bunsub'],
});

registerCommand('bili_list', {
  description: '查看订阅',
  handler: async (m) => {
    if (!m.guildId) return await replyMessage(m, '❌ 仅频道可用');
    const subs = listSub(m.guildId);
    if (!subs.length) return await replyMessage(m, '📭 暂无订阅');
    let msg = `📋 订阅列表(${subs.length}个):\n\n`;
    subs.forEach((s, i) => { msg += `${i + 1}. ${s.name}(UID:${s.uid})\n`; });
    await replyMessage(m, msg);
  },
  aliases: ['blist'],
});

registerCommand('bili_search', {
  description: '搜索UP主',
  handler: async (m, a) => {
    if (!a.length) return await replyMessage(m, '用法: /bili_search <关键词>');
    const r = await searchUp(a.join(' '));
    if (!r.length) return await replyMessage(m, '未找到');
    let msg = '🔍 搜索结果:\n\n';
    r.forEach((x, i) => { msg += `${i + 1}. ${x.name}(UID:${x.uid})\n`; });
    msg += '\n/bili_sub <UID> 订阅';
    await replyMessage(m, msg);
  },
  aliases: ['bsearch'],
});

registerCommand('bili_cookie', {
  description: '设置B站Cookie',
  handler: async (m, a) => {
    if (!a.length) return await replyMessage(m, '用法: /bili_cookie <Cookie>\n获取方法:\n1. 浏览器登录bilibili.com\n2. F12 -> Network\n3. 复制任意请求的Cookie头');
    saveBiliConfig(a.join(' '));
    await replyMessage(m, '✅ Cookie已保存，重启机器人后生效');
  },
  aliases: ['bcookie'],
});

registerCommand('bili_config', {
  description: '查看B站配置',
  handler: async (m) => {
    const status = getApiStatus();
    const msg = `📊 B站配置状态:\nCookie: ${status.hasCookie ? '✅ 已配置' : '❌ 未配置'}\n状态: ${status.message}\n\n💡 使用 /bili_cookie 设置Cookie可提高成功率`;
    await replyMessage(m, msg);
  },
  aliases: ['bconfig'],
});

console.log('✅ 命令已加载');

module.exports = { setBot, getBot };
