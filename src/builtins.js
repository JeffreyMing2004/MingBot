/**
 * 命令处理器（内置命令）
 * 使用 message.reply(text) 发送回复，兼容 WebSocket 和 HTTP 回调两种模式
 */
const axios = require('axios');
const { registerCommand } = require('./commands');
const { addSub, removeSub, listSub, searchUp, saveBiliConfig, getApiStatus } = require('./bilibili');
const config = require('./config');
const log = require('./logger');

// 在命令注册前导出 setReplyFn 供 index.js 绑定发送函数
let replyFn = null;
function setReplyFn(fn) { replyFn = fn; }

// 包装 reply：如果消息对象自带 _sendReply 就用它，否则用全局 replyFn
async function reply(message, text) {  try {
  if (message._sendReply) return await message._sendReply(text);
  if (replyFn) return await replyFn(message, text);
  throw new Error('没有可用的消息发送函数');
  } catch (e) {
    console.error('[reply] Error:', e.message);
    throw e;
  }
}

/** 获取 access_token */
async function getAccessToken() {
  const data = JSON.stringify({
    appId: config.appId,
    clientSecret: config.token,
  });
  const res = await axios.post('https://api.bot.qq.com/app/getAppAccessToken', data, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return res.data.access_token;
}

/** 发送消息到频道 */
async function sendToChannel(channelId, text) {
  const token = await getAccessToken();
  await axios.post(
    `https://api.sgroup.qq.com/channels/${channelId}/messages`,
    { content: text, msg_type: 0 },
    { headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
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

// ---------- 群信息命令 ----------

registerCommand('group', {
  description: '查看群信息',
  handler: async (m) => {
    if (!m.guildId) return await reply(m, '❌ 仅频道可用');
    try {
      const token = await getAccessToken();
      const res = await axios.get(`https://api.sgroup.qq.com/guilds/${m.guildId}`, {
        headers: { Authorization: `QQBot ${token}` },
        timeout: 10000,
      });
      const g = res.data;
      await reply(m,
        `🏠 群信息\n` +
        `名称: ${g.name}\n` +
        `群ID: ${g.id}\n` +
        ` owner: ${g.owner_id || '未知'}`
      );
    } catch (e) {
      log.error(`[group] 获取群信息失败: ${e.message}`);
      await reply(m, `❌ 获取群信息失败: ${e.response?.data?.message || e.message}`);
    }
  },
  aliases: ['ginfo', 'guild'],
});

registerCommand('members', {
  description: '查看群成员列表',
  handler: async (m, a) => {
    if (!m.guildId) return await reply(m, '❌ 仅频道可用');
    const limit = Math.min(Math.max(parseInt(a[0]) || 20, 1), 100);
    try {
      const token = await getAccessToken();
      const res = await axios.get(`https://api.sgroup.qq.com/guilds/${m.guildId}/members`, {
        params: { limit },
        headers: { Authorization: `QQBot ${token}` },
        timeout: 10000,
      });
      const members = res.data.items || [];
      const total = res.data.total || members.length;
      let msg = `👥 群成员 (${total}人，显示前${members.length}个)：\n\n`;
      members.forEach((mem, i) => {
        const nick = mem.member?.nick || mem.user?.username || '未知';
        const uid = mem.user?.id || mem.member?.user?.id || mem.id;
        const role = mem.roles?.join(',') || '';
        msg += `${i + 1}. ${nick} (UID:${uid})${role ? ` [${role}]` : ''}\n`;
      });
      await reply(m, msg);
    } catch (e) {
      log.error(`[members] 获取群成员失败: ${e.message}`);
      await reply(m, `❌ 获取群成员失败: ${e.response?.data?.message || e.message}`);
    }
  },
  aliases: ['member', '群成员'],
});

registerCommand('messages', {
  description: '获取群内最近消息',
  handler: async (m, a) => {
    if (!m.channelId) return await reply(m, '❌ 请在有消息的频道中使用');
    const limit = Math.min(Math.max(parseInt(a[0]) || 10, 1), 50);
    try {
      const token = await getAccessToken();
      const res = await axios.get(
        `https://api.sgroup.qq.com/channels/${m.channelId}/messages`,
        {
          params: { limit },
          headers: { Authorization: `QQBot ${token}` },
          timeout: 10000,
        }
      );
      const items = res.data.items || [];
      if (!items.length) return await reply(m, '📭 暂无消息');
      let msg = `💬 最近 ${items.length} 条消息：\n\n`;
      items.forEach((item, i) => {
        const author = item.author?.username || '未知';
        const content = (item.content || '').replace(/\n/g, ' ').trim().slice(0, 100);
        const ts = item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
        msg += `${i + 1}. [${ts}] ${author}: ${content}\n`;
      });
      await reply(m, msg);
    } catch (e) {
      log.error(`[messages] 获取消息失败: ${e.message}`);
      await reply(m, `❌ 获取消息失败: ${e.response?.data?.message || e.message}`);
    }
  },
  aliases: ['msg', 'history'],
});

// 从消息推导订阅目标：群聊用 group_openid，频道用 channel_id
function getTarget(m) {
  if (m.groupOpenid) return { targetType: 'group', targetId: m.groupOpenid, label: '本群' };
  if (m.channelId) return { targetType: 'channel', targetId: m.channelId, label: `<#${m.channelId}>` };
  return null;
}

registerCommand('push_status', {
  description: '查看推送状态',
  handler: async (m) => {
    const t = getTarget(m);
    if (!t) return await reply(m, '❌ 仅群聊或频道可用');
    const subs = listSub(t);
    if (!subs.length) return await reply(m, '📭 暂无订阅，使用 /bili_sub 订阅UP主');
    let msg = `📊 推送状态 (${subs.length}个订阅)：\n\n`;
    subs.forEach((s, i) => {
      const dest = s.targetType === 'group' ? '本群' : `<#${s.targetId}>`;
      msg += `${i + 1}. ${s.name} (UID:${s.uid}) → ${dest}\n`;
    });
    await reply(m, msg);
  },
  aliases: ['push'],
});

// ---------- B站订阅命令 ----------

registerCommand('bili_sub', {
  description: '订阅B站UP主动态',
  handler: async (m, a) => {
    const t = getTarget(m);
    if (!t) return await reply(m, '❌ 仅群聊或频道可用');
    if (!a.length) return await reply(m, '用法: /bili_sub <UID或名称>');
    const subs = [];
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
    addSub(t, subs[0].uid, subs[0].name);
    const hint = t.targetType === 'group'
      ? '\n💡 若收不到推送，请群主/管理员在 手机QQ群设置→机器人 中开启「机器人主动在群聊内发言」'
      : '';
    await reply(m, `✅ 已订阅 ${subs[0].name}，有新动态将推送到${t.label}${hint}`);
  },
  aliases: ['bsub'],
});

registerCommand('bili_unsub', {
  description: '取消订阅B站UP主',
  handler: async (m, a) => {
    const t = getTarget(m);
    if (!t) return await reply(m, '❌ 仅群聊或频道可用');
    if (!a.length) return await reply(m, '用法: /bili_unsub <UID>');
    removeSub(t, a[0]);
    await reply(m, `✅ 已取消订阅 UID:${a[0]}`);
  },
  aliases: ['bunsub'],
});

registerCommand('bili_list', {
  description: '查看本群/本频道订阅列表',
  handler: async (m) => {
    const t = getTarget(m);
    if (!t) return await reply(m, '❌ 仅群聊或频道可用');
    const subs = listSub(t);
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
