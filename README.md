# QQ Guild Bot 模板

基于 [QQ Bot API v2](https://bot.q.qq.com/wiki/develop/api-v2/) 的 QQ 频道机器人 Node.js 模板。

## 📋 功能特性

- ✅ 基于 `qq-guild-bot` 库开发
- ✅ 支持 WebSocket 长连接模式
- ✅ 命令系统（内置 ping、help、echo、time、random 等）
- ✅ 事件处理（消息、私信、成员加入/退出、表情反应）
- ✅ 环境变量配置（安全管理敏感信息）
- ✅ 沙箱/正式环境切换
- ✅ 优雅关闭处理

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置机器人

复制配置文件并填入真实信息：

```bash
cp src/config.js src/config.local.js
```

编辑 `src/config.local.js` 填入你的 AppID 和 Token：

```javascript
module.exports = {
  appId: 'YOUR_APP_ID',      // 在 QQ 开放平台获取
  token: 'YOUR_BOT_TOKEN',   // 在 QQ 开放平台获取
  sandbox: true,             // true=沙箱环境，false=正式环境
};
```

**或者使用环境变量（推荐）：**

```bash
# Windows PowerShell
$env:QQ_BOT_APP_ID="your_app_id"
$env:QQ_BOT_TOKEN="your_bot_token"
$env:QQ_BOT_SANDBOX="true"

# Linux/macOS
export QQ_BOT_APP_ID="your_app_id"
export QQ_BOT_TOKEN="your_bot_token"
export QQ_BOT_SANDBOX="true"
```

### 3. 启动机器人

```bash
# 生产环境
npm start

# 开发环境（支持热重载）
npm run dev
```

## 📖 命令列表

| 命令 | 别名 | 说明 |
|------|------|------|
| `/ping` | `/p` | 测试机器人响应速度 |
| `/help` | `/h`, `/?` | 显示所有可用命令 |
| `/about` | `/info` | 显示机器人信息 |
| `/echo <内容>` | `/say`, `/repeat` | 复述消息 |
| `/time` | `/date`, `/now` | 显示当前时间 |
| `/random [min] [max]` | `/rand`, `/roll` | 生成随机数 |

## 📁 项目结构

```
MingBot/
├── package.json          # 项目配置
├── src/
│   ├── index.js          # 入口文件
│   ├── config.js         # 配置文件（模板）
│   ├── commands.js       # 命令注册系统
│   └── builtins.js       # 内置命令实现
└── README.md             # 说明文档
```

## 🔧 扩展开发

### 添加新命令

在 `src/builtins.js` 中使用 `registerCommand` 注册新命令：

```javascript
const { registerCommand } = require('./commands');

registerCommand('mycommand', {
  description: '命令描述',
  handler: async (message, args) => {
    // args 是参数数组，如 /mycommand arg1 arg2 -> ['arg1', 'arg2']
    await message.reply('处理结果');
  },
  aliases: ['mc', 'my'], // 可选别名
});
```

### 监听更多事件

在 `src/index.js` 中添加事件监听器：

```javascript
const { Events } = require('qq-guild-bot');

// 频道创建
client.on(Events.GUILD_CREATE, (guild) => {
  console.log(`加入新频道: ${guild.name}`);
});

// 消息删除
client.on(Events.MESSAGE_DELETE, (message) => {
  console.log(`消息被删除: ${message.id}`);
});

// 更多事件请参考 qq-guild-bot 文档
```

## 📚 参考文档

- [QQ Bot API v2 官方文档](https://bot.q.qq.com/wiki/develop/api-v2/)
- [qq-guild-bot GitHub](https://github.com/qq-guild-bot/qq-guild-bot)
- [QQ 频道机器人开放平台](https://bot.q.qq.com/)

## ⚠️ 注意事项

1. **不要将真实的 Token 提交到版本控制** - 使用环境变量或 `config.local.js`（已在 .gitignore 中）
2. **沙箱环境仅用于开发测试** - 正式上线前请在 QQ 开放平台申请正式环境权限
3. **Intents 权限** - 根据需要在开放平台勾选对应的事件权限
4. **消息频率限制** - 遵守 API 调用频率限制，避免被封禁

## 📄 许可证

ISC License
