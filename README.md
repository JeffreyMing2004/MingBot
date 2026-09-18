# QQ Guild Bot - B站动态监控模板

基于 [QQ Bot API v2](https://bot.q.qq.com/wiki/develop/api-v2/) 的 QQ 频道机器人 Node.js 模板，集成 **B站动态监控** 功能。

## 📋 功能特性

- ✅ 基于 `qq-guild-bot` 库开发
- ✅ 支持 WebSocket 长连接模式
- ✅ 模块化命令系统（内置基础命令 + B站监控命令）
- ✅ **B站动态监控**：每 5 分钟自动检测订阅 UP 主动态，有更新自动推送到订阅频道，无更新静默
- ✅ 支持 UID 直接订阅 / 名称搜索订阅
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

**方式 A：使用环境变量（推荐）**

```bash
# Windows PowerShell
$env:QQ_BOT_APP_ID="你的AppID"
$env:QQ_BOT_TOKEN="你的Token"
$env:QQ_BOT_SANDBOX="true"  # true=沙箱环境，false=正式环境

# Linux/macOS
export QQ_BOT_APP_ID="你的AppID"
export QQ_BOT_TOKEN="你的Token"
export QQ_BOT_SANDBOX="true"
```

**方式 B：使用本地配置文件**

```bash
cp src/config.js src/config.local.js
```

编辑 `src/config.local.js`：

```javascript
module.exports = {
  appId: '你的AppID',      // 在 QQ 开放平台获取
  token: '你的Token',      // 在 QQ 开放平台获取
  sandbox: true,           // true=沙箱环境，false=正式环境
};
```

### 3. 启动机器人

```bash
# 生产环境
npm start

# 开发环境（支持热重载）
npm run dev
```

## 📖 命令列表

### 基础命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/ping` | `/p` | 测试机器人响应速度 |
| `/help` | `/h`, `/?` | 显示所有可用命令 |
| `/about` | `/info` | 显示机器人信息 |
| `/echo <内容>` | `/say`, `/repeat` | 复述消息 |
| `/time` | `/date`, `/now` | 显示当前时间 (北京时间) |
| `/random [min] [max]` | `/rand`, `/roll` | 生成随机数 |

### B站动态监控命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/bili_sub <UID/名称> [...]` | `/bsub`, `/subscribe`, `/订阅` | 订阅UP主动态推送（支持多个） |
| `/bili_unsub <UID>` | `/bunsub`, `/unsubscribe`, `/取消订阅` | 取消订阅指定UP主 |
| `/bili_list` | `/blist`, `/sublist`, `/订阅列表` | 查看当前频道订阅列表 |
| `/bili_search <关键词>` | `/bsearch`, `/搜索UP` | 搜索B站UP主（按名称） |

## 🎯 使用示例

### 订阅UP主动态

```
/bili_sub 123456           # 直接使用UID订阅
/bili_sub 灵梦             # 使用名称搜索并订阅（唯一结果时自动订阅）
/bili_sub 123456 789012    # 批量订阅多个UP主
```

### 取消订阅

```
/bili_unsub 123456
```

### 查看订阅列表

```
/bili_list
```

### 搜索UP主

```
/bili_search 灵梦
```

## 📁 项目结构

```
MingBot/
├── package.json              # 项目配置
├── .gitignore                # Git忽略配置
├── LICENSE                   # ISC许可证
├── README.md                 # 说明文档
├── .vscode/
│   └── launch.json           # VS Code调试配置
├── src/
│   ├── index.js              # 入口文件（含监控启动逻辑）
│   ├── config.js             # 配置文件模板
│   ├── commands.js           # 命令注册系统
│   ├── builtins.js           # 内置命令实现（含B站命令）
│   └── bilibili.js           # B站动态监控核心模块
└── data/                     # 运行时数据目录（自动创建）
    ├── subscriptions.json    # 订阅配置持久化
    └── last_dynamics.json    # 最后动态ID记录
```

## 🔧 核心模块说明

### `src/bilibili.js` - B站动态监控核心

- **数据持久化**：订阅配置与动态ID记录保存在 `data/` 目录，重启不丢失
- **增量检测**：首次检测只记录不推送，后续仅推送新动态
- **多频道隔离**：不同频道可订阅不同UP主，互不干扰
- **富文本推送**：包含动态内容、图片数量、转发信息、跳转链接
- **原生 fetch**：使用 Node.js 18+ 内置 fetch，无额外依赖

### 监控逻辑

1. 启动时立即执行一次检测（仅记录最新动态ID，不推送）
2. 每 5 分钟定时检测所有订阅的 UP 主
3. 对比当前最新动态 ID 与记录的 ID
4. 有新动态 → 格式化消息 → 推送到对应频道 → 更新记录
5. 无更新 → 静默（无任何日志输出）

## 🔧 扩展开发

### 添加新命令

在 `src/builtins.js` 中使用 `registerCommand` 注册：

```javascript
const { registerCommand } = require('./commands');

registerCommand('mycommand', {
  description: '命令描述',
  handler: async (message, args) => {
    await message.reply('处理结果');
  },
  aliases: ['mc', 'my'],
});
```

### 修改监控间隔

在 `src/index.js` 中修改 `startDynamicMonitor` 的第二个参数：

```javascript
// 修改为 10 分钟检测一次
monitorTimer = startDynamicMonitor(client, 10);
```

### 自定义消息格式

修改 `src/bilibili.js` 中的 `formatDynamicMessage` 函数。

## 📚 参考文档

- [QQ Bot API v2 官方文档](https://bot.q.qq.com/wiki/develop/api-v2/)
- [qq-guild-bot GitHub](https://github.com/qq-guild-bot/qq-guild-bot)
- [QQ 频道机器人开放平台](https://bot.q.qq.com/)
- [B站 API 参考](https://github.com/SocialSisterYi/bilibili-API-collect)

## ⚠️ 注意事项

1. **不要将真实的 Token 提交到版本控制** - 使用环境变量或 `config.local.js`（已在 .gitignore 中）
2. **沙箱环境仅用于开发测试** - 正式上线前请在 QQ 开放平台申请正式环境权限
3. **Intents 权限** - 根据需要在开放平台勾选对应的事件权限
4. **消息频率限制** - 遵守 API 调用频率限制，避免被封禁
5. **B站 API 限制** - 请求过于频繁可能被限流，默认 5 分钟间隔较为安全
6. **数据目录** - `data/` 目录会自动创建，请勿手动删除其中的 JSON 文件

## 📄 许可证

ISC License
