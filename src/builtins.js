const { registerCommand } = require('./commands');
const { addSub, removeSub, listSub, searchUp, setCookie, getConfig, loadBiliConfig } = require('./bilibili');

registerCommand('ping', { description: '测试响应', handler: async m => { const s = Date.now(); const r = await m.reply('Pong!'); await r.edit(`Pong! ${Date.now()-s}ms`); }, aliases: ['p'] });
registerCommand('help', { description: '显示帮助', handler: async m => { const { getAllCommands } = require('./commands'); const cmds = new Map(); for (const [,c] of getAllCommands()) if (!cmds.has(c.name)) cmds.set(c.name, c); let msg = '📋 命令列表:\n\n'; for (const [n,c] of cmds) msg += \`/\${n} - \${c.description}\n\`; await m.reply(msg); }, aliases: ['h', '?'] });
registerCommand('about', { description: '关于', handler: async m => await m.reply('🤖 MingBot - QQ频道机器人 + B站监控'), aliases: ['info'] });
registerCommand('echo', { description: '复述', handler: async (m,a) => a.length ? m.reply(a.join(' ')) : m.reply('用法: /echo <内容>'), aliases: ['say'] });
registerCommand('time', { description: '时间', handler: async m => m.reply(\`🕐 \${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}\`), aliases: ['date'] });
registerCommand('random', { description: '随机数', handler: async (m,a) => { let min=0,max=100; if(a[0])min=parseInt(a[0]); if(a[1])max=parseInt(a[1]); if(min>max)[min,max]=[max,min]; m.reply(\`🎲 \${min}-\${max}: \${Math.floor(Math.random()*(max-min+1))+min}\`); }, aliases: ['rand'] });

registerCommand('bili_sub', { description: '订阅B站UP主', handler: async (m,a) => { if(!m.guild_id) return m.reply('❌ 仅频道可用'); if(!a.length) return m.reply('用法: /bili_sub <UID或名称>'); const g=m.guild_id, ch=m.channel_id, subs=[]; for(const arg of a) { if(/^\d+$/.test(arg)) subs.push({uid:arg,name:\`UID:\${arg}\`}); else { const r=await searchUp(arg); if(!r.length) continue; if(r.length===1) subs.push({uid:r[0].uid,name:r[0].name}); else { let msg='多个结果，请使用UID:\n'; r.forEach((x,i)=>msg+=\`\${i+1}. \${x.name}(UID:\${x.uid})\n\`); return m.reply(msg); } } } if(!subs.length) return; addSub(g,ch,subs[0].uid,subs[0].name); m.reply(\`✅ 已订阅 \${subs[0].name}\n📺 <#\${ch}>\`); }, aliases: ['bsub'] });

registerCommand('bili_unsub', { description: '取消订阅', handler: async (m,a) => { if(!m.guild_id) return m.reply('❌ 仅频道可用'); if(!a.length) return m.reply('用法: /bili_unsub <UID>'); removeSub(m.guild_id,a[0]); m.reply(\`✅ 已取消订阅 UID:\${a[0]}\`); }, aliases: ['bunsub'] });

registerCommand('bili_list', { description: '查看订阅', handler: async m => { if(!m.guild_id) return m.reply('❌ 仅频道可用'); const subs=listSub(m.guild_id); if(!subs.length) return m.reply('📭 暂无订阅'); let msg=\`📋 订阅列表(\${subs.length}个):\n\n\`; subs.forEach((s,i)=>msg+=\`\${i+1}. \${s.name}(UID:\${s.uid})\n\`); m.reply(msg); }, aliases: ['blist'] });

registerCommand('bili_search', { description: '搜索UP主', handler: async (m,a) => { if(!a.length) return m.reply('用法: /bili_search <关键词>'); const r=await searchUp(a.join(' ')); if(!r.length) return m.reply('未找到'); let msg='🔍 搜索结果:\n\n'; r.forEach((x,i)=>msg+=\`\${i+1}. \${x.name}(UID:\${x.uid})\n\`); msg+='\\n/bili_sub <UID> 订阅'; m.reply(msg); }, aliases: ['bsearch'] });

registerCommand('bili_cookie', { description: '设置B站Cookie', handler: async (m,a) => { if(!a.length) return m.reply('用法: /bili_cookie <Cookie>\\n获取方法:\\n1. 浏览器登录bilibili.com\\n2. F12 -> Network\\n3. 复制任意请求的Cookie头'); setCookie(a.join(' ')); m.reply('✅ Cookie已保存，重启机器人后生效'); }, aliases: ['bcookie'] });

registerCommand('bili_config', { description: '查看B站配置', handler: async m => { const status = getApiStatus(); m.reply(\`📊 B站配置状态:\\nCookie: \${status.hasCookie ? '✅ 已配置' : '❌ 未配置'}\\n状态: \${status.message}\\n\\n💡 使用 /bili_cookie 设置Cookie可提高成功率\`); }, aliases: ['bconfig'] });

console.log('✅ 命令已加载');