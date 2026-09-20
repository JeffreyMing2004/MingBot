/**
 * 命令处理器（内置命令）
 * 使用 message.reply(text) 发送回复，兼容 WebSocket 和 HTTP 回调两种模式
 */
const { registerCommand } = require('./commands');
const { addSub, removeSub, listSub, searchUp, saveBiliConfig, getApiStatus } = require('./bilibili');

// 在命令注册前导出 setReplyFn 供 index.js 绑定发送函数
let replyFn = null;
function setReplyFn(fn) { replyFn = fn; }

// 包装 reply：如果消息对象自带 _sendReply 就用它，否则用全局 replyFn
function reply(message, text) {
  if (message._sendReply) return message._sendReply(text);
  if (replyFn) return replyFn(message, text);
  throw new Error('没有可用的消息发送函数');
}

registerCommand('ping', {
  description: '测试响应',
  handler: async (m) => {
    const s = Date.now();
    await reply(m, 'Pong!');
    await reply(m, `Pong! ${Date.now() - s}ms`);
  },
  aliases: ['p'],
});

registerCommand('help', {
  description: '显示帮助',
  handler: async (m) => {
    const cmds = new Map();
    for (const [, c] of require('./commands').getAllCommands()) {
      if (!cmds.has(c.name)) cmds.set(c.name, c);
    }
    let msg = '📋 可用命令：\n\n';
    for (const [n, c] of cmds) {
      msg += `/${n}  —  ${c.description}\n`;
    }
    await reply(m, msg);
  },
  aliases: ['h', '?'],
});

registerCommand('about', {
  description: '关于机器人',
  handler: async (m) => {
    await reply(m, '🤖 MingBot — QQ频道机器人 + B站动态监控');
  },
  aliases: ['info'],
});

registerCommand('echo', {
  description: '复述内容',
  handler: async (m, a) => {
    if (!a.length) return await reply(m, '用法: /echo <内容>');
    await reply(m, a.join(' '));
  },
  aliases: ['say'],
});

registerCommand('time', {
  description: '当前时间',
  handler: async (m) => {
    const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    await reply(m, `🕐 ${t}`);
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
    await reply(m, `🎲 ${min}-${max}: ${r}`);
  },
  aliases: ['rand'],
});

// ---------- B站订阅命令 ----------

registerCommand('bili_sub', {
  description: '订阅B站UP主动态',
  handler: async (m, a) => {
    if (!m.guildId) return await reply(m, '❌ 仅频道可用');
    if (!a.length) return await reply(m, '用法: /bili_sub <UID或名称>');
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
          let msg = '多个结果，请使用UID订阅：\n';
          r.forEach((x, i) => { msg += `${i + 1}. ${x.name} (UID:${x.uid})\n`; });
          return await reply(m, msg);
        }
      }
    }
    if (!subs.length) return await reply(m, '未找到匹配的UP主');
    addSub(g, ch, subs[0].uid, subs[0].name);
    await reply(m, `✅ 已订阅 ${subs[0].name}，有新动态将推送到 <#${ch}>`);
  },
  aliases: ['bsub'],
});

registerCommand('bili_unsub', {
  description: '取消订阅B站UP主',
  handler: async (m, a) => {
    if (!m.guildId) return await reply(m, '❌ 仅频道可用');
    if (!a.length) return await reply(m, '用法: /bili_unsub <UID>');
    removeSub(m.guildId, a[0]);
    await reply(m, `✅ 已取消订阅 UID:${a[0]}`);
  },
  aliases: ['bunsub'],
});

registerCommand('bili_list', {
  description: '查看本频道订阅列表',
  handler: async (m) => {
    if (!m.guildId) return await reply(m, '❌ 仅频道可用');
    const subs = listSub(m.guildId);
    if (!subs.length) return await reply(m, '📭 暂无订阅');
    let msg = `📋 订阅列表 (${subs.length}个)：\n\n`;
    subs.forEach((s, i) => { msg += `${i + 1}. ${s.name} (UID:${s.uid})\n`; });
    await reply(m, msg);
  },
  aliases: ['blist'],
});

registerCommand('bili_search', {
  description: '搜索B站UP主',
  handler: async (m, a) => {
    if (!a.length) return await reply(m, '用法: /bili_search <关键词>');
    const r = await searchUp(a.join(' '));
    if (!r.length) return await reply(m, '未找到相关UP主');
    let msg = '🔍 搜索结果：\n\n';
    r.forEach((x, i) => { msg += `${i + 1}. ${x.name} (UID:${x.uid})\n`; });
    msg += '\n使用 /bili_sub <UID> 订阅';
    await reply(m, msg);
  },
  aliases: ['bsearch'],
});

registerCommand('bili_cookie', {
  description: '设置B站Cookie',
  handler: async (m, a) => {
    if (!a.length) return await reply(m, '用法: /bili_cookie <Cookie>\n获取方法：浏览器登录 bilibili.com → F12 → Network → 复制任意请求的 Cookie 头');
    saveBiliConfig(a.join(' '));
    await reply(m, '✅ Cookie已保存，下次启动生效');
  },
  aliases: ['bcookie'],
});

registerCommand('bili_config', {
  description: '查看B站配置状态',
  handler: async (m) => {
    const status = getApiStatus();
    await reply(m, `📊 B站配置状态：\nCookie: ${status.hasCookie ? '✅ 已配置' : '❌ 未配置'}\n${status.message}\n\n💡 使用 /bili_cookie 设置Cookie可提高动态获取成功率`);
  },
  aliases: ['bconfig'],
});

console.log('✅ 内置命令已加载');

module.exports = { setReplyFn };
