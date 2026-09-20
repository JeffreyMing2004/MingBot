# MingBot — QQ 频道机器人 + B站动态监控

基于 [QQ Bot API v2](https://bot.q.qq.com/wiki/develop/api-v2/) 的 Node.js 机器人，支持 **WebSocket 直连** 和 **HTTP 回调** 两种模式，内置 B站 UP 主动态实时推送。

## 功能特性

- 双模式运行：WebSocket 长连接 / HTTP 回调（配合 Cloudflare Tunnel）
- B站动态监控：定时检测订阅 UP 主，有更新自动推送到指定频道
- 模块化命令系统：内置工具命令 + B站订阅管理
- 多策略数据获取：官方 B站 API（Cookie）优先，失败自动降级 RSSHub
- 数据持久化：订阅配置与动态记录保存在本地 JSON 文件，重启不丢失
- 多频道隔离：不同频道可独立订阅不同 UP 主
- 自动重启：进程崩溃后最多重试 10 次，间隔 3 秒
- 环境变量 / 本地配置双模式支持

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置机器人

#### 方式 A：环境变量（推荐）

```powershell
# Windows PowerShell
$env:QQ_BOT_APP_ID        = "你的 AppID"
$env:QQ_BOT_TOKEN         = "你的 Token（AppSecret）"
$env:QQ_BOT_SANDBOX       = "true"          # true=沙箱  false=正式
$env:QQ_BOT_USE_CALLBACK  = "false"        # false=WebSocket  true=HTTP回调
```

```bash
# Linux/macOS
export QQ_BOT_APP_ID="你的AppID"
export QQ_BOT_TOKEN="你的Token"
export QQ_BOT_SANDBOX="true"
export QQ_BOT_USE_CALLBACK="false"
```

#### 方式 B：本地配置文件

```bash
cp config.example.json config.json
cp cookie.example.json cookie.json
```

编辑 `config.json`：

```json
{
  "appId": "YOUR_APP_ID",
  "token": "YOUR_BOT_SECRET",
  "sandbox": true
}
```

编辑 `cookie.json` 填写 B站 Cookie（可选，不填则使用 RSSHub 降级）：

```json
{
  "cookie": "",
  "description": "B站 Cookie，用于访问用户动态API"
}
```

### 3. 启动机器人

```powershell
# PowerShell 脚本（推荐）
.\start.ps1 start        # WebSocket 模式启动
.\start.ps1 callback     # HTTP 回调模式启动
.\start.ps1 tunnel       # 启动 Cloudflare Tunnel（回调模式需要）
.\start.ps1 status       # 查看运行状态
.\start.ps1 logs         # 实时查看日志
.\start.ps1 stop         # 停止机器人
```

```bash
# 直接运行
npm start          # 生产模式
npm run dev        # 开发模式（支持热重载）
```

## 命令列表

### 内置工具命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/ping` | `/p` | 测试机器人响应 |
| `/help` | `/h`, `/?` | 显示所有可用命令 |
| `/about` | `/info` | 显示机器人信息 |
| `/echo <内容>` | `/say` | 复述消息 |
| `/time` | `/date`, `/now` | 显示当前时间（北京时间） |
| `/random [min] [max]` | `/rand` | 生成随机数 |

### B站动态监控命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/bili_sub <UID/名称> [...]` | `/bsub`, `/subscribe` | 订阅 UP 主动态推送（支持多个） |
| `/bili_unsub <UID>` | `/bunsub`, `/unsubscribe` | 取消订阅指定 UP 主 |
| `/bili_list` | `/blist`, `/sublist` | 查看本频道订阅列表 |
| `/bili_search <关键词>` | `/bsearch` | 搜索 B站 UP 主 |
| `/bili_cookie <Cookie>` | `/bcookie` | 设置 B站 Cookie（提高成功率） |
| `/bili_config` | `/bconfig` | 查看 B站配置状态 |

## 使用示例

```
/bili_sub 123456              # 通过 UID 直接订阅
/bili_sub 灵梦                # 通过名称搜索订阅（唯一结果时自动订阅）
/bili_sub 123456 789012       # 批量订阅多个 UP 主
/bili_search 灵梦             # 搜索 UP 主
/bili_list                    # 查看当前订阅
/bili_cookie "SESSDATA=xxx"   # 设置 Cookie 提高检测成功率
/bili_config                  # 查看配置状态
```

## 项目结构

```
MingBot/
├── package.json              # 项目配置（依赖：axios, qq-guild-sdk, tweetnacl, @noble/*）
├── config.example.json       # 机器人配置模板
├── config.json               # 本地配置（不被提交到 Git）
├── cookie.example.json       # B站 Cookie 模板
├── cookie.json               # B站 Cookie（不被提交到 Git）
├── ecosystem.config.js       # PM2 部署配置
├── cloudflared.yml           # Cloudflare Tunnel 配置
├── runner.js                 # 轻量进程管理器（自动重启）
├── start.ps1                 # PowerShell 启动脚本
├── .env.example              # 环境变量模板
├── .gitignore
├── LICENSE
├── src/
│   ├── index.js              # 入口文件（WebSocket / 回调双模式）
│   ├── server.js             # HTTP 回调服务器（Ed25519 签名校验）
│   ├── config.js             # 配置加载（环境变量 > 本地文件）
│   ├── commands.js           # 命令注册表
│   ├── builtins.js           # 内置命令实现
│   ├── bilibili.js           # B站动态监控核心模块
│   └── logger.js             # 统一日志模块
├── data/                     # 运行时数据（自动创建）
│   ├── subscriptions.json    # 订阅配置持久化
│   └── last_dynamics.json    # 各 UP 主最新动态 ID 记录
├── logs/                     # 日志目录
│   ├── bot.log               # 主日志
│   └── pm2-*.log             # PM2 日志
└── cloudflared.exe           # Cloudflare Tunnel 客户端
```

## 核心模块说明

### B站动态监控（`src/bilibili.js`）

**数据获取策略（自动降级）：**

1. 官方 Polymer API（`api.bilibili.com`）— 需有效 Cookie，成功率最高
2. RSSHub 实例（`rsshub.app` / `rsshub.rssforever.com`）— 无需 Cookie，作为备用

**监控逻辑：**

1. 启动时立即执行一次检测（仅记录最新动态 ID，不推送）
2. 每 5 分钟定时检测所有订阅的 UP 主
3. 对比当前最新动态 ID 与本地记录
4. 有新动态 → 格式化富文本消息 → 推送到对应频道
5. 无更新 → 静默，不输出日志

**持久化：**

- `data/subscriptions.json`：每个频道的订阅列表（UID、名称）
- `data/last_dynamics.json`：各 UP 主最后已推送的动态 ID

### HTTP 回调模式（`src/server.js`）

适用于无法直接建立 WebSocket 的环境（如云服务器防火墙限制）。

**关键特性：**

- Ed25519 签名校验（基于 AppSecret）
- 回调地址验证（opcode 13）
- 支持私信（c2c）和群消息
- 自动刷新 access_token（有效期约 2 小时）

**部署流程：**

```powershell
# 1. 启动回调模式机器人
.\start.ps1 callback

# 2. 启动 Cloudflare Tunnel（另一终端）
.\start.ps1 tunnel

# 3. 将 bot.mingpixel.net/callback 填入 QQ 开放平台事件订阅地址
```

### 进程管理（`runner.js`）

轻量级进程管理器，替代 PM2：

- 崩溃后自动重启（最多 10 次）
- 每次重启间隔 3 秒
- 优雅退出（SIGINT / SIGTERM）
- 日志文件按级别分文件存储

## 扩展开发

### 添加新命令

在 `src/builtins.js` 中使用 `registerCommand` 注册：

```javascript
const { registerCommand } = require('./commands');

registerCommand('mycommand', {
  description: '命令描述',
  handler: async (message, args) => {
    await reply(message, '处理结果');
  },
  aliases: ['mc'],
});
```

### 修改监控间隔

在 `src/index.js` 中修改 `startMonitor` 的第二个参数：

```javascript
// 修改为 10 分钟检测一次
monitorTimer = startMonitor(client, 10);
```

### 自定义消息格式

修改 `src/bilibili.js` 中的 `formatMsg` 函数。

## 环境变量参考

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `QQ_BOT_APP_ID` | QQ 机器人 AppID | — |
| `QQ_BOT_TOKEN` | QQ 机器人 Token（AppSecret） | — |
| `QQ_BOT_SANDBOX` | 是否使用沙箱环境 | `true` |
| `QQ_BOT_USE_CALLBACK` | 是否使用 HTTP 回调模式 | `false` |
| `BOT_PORT` | 回调服务器端口 | `9000` |
| `BOT_URL` | 回调公开地址 | `https://bot.mingpixel.net` |
| `BILI_COOKIE` | B站 Cookie（也可通过 `/bili_cookie` 命令设置） | — |

## 注意事项

1. **不要提交敏感信息** — `config.json`、`cookie.json` 已在 `.gitignore` 中
2. **沙箱环境仅用于测试** — 正式上线前需在 QQ 开放平台申请正式环境权限
3. **B站 Cookie 有效期** — Cookie 过期后官方 API 会返回 -412 错误，使用 `/bili_cookie` 重新设置
4. **API 频率限制** — 默认 5 分钟检测间隔较为安全，不建议缩短至 1 分钟以内
5. **数据目录** — `data/` 目录会自动创建，请勿手动删除其中的 JSON 文件

## 参考文档

- [QQ Bot API v2 官方文档](https://bot.q.qq.com/wiki/develop/api-v2/)
- [QQ 频道机器人开放平台](https://bot.q.qq.com/)
- [B站 API 参考](https://github.com/SocialSisterYi/bilibili-API-collect)
- [RSSHub 文档](https://docs.rsshub.app/)

## 许可证

ISC License
