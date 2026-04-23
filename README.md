# Twitter AI 大佬监控系统

自动监控 AI 领域大佬的 Twitter/X 动态，实时飞书通知 + 每日汇总报告。

## 功能

- 🔍 每 30 分钟自动抓取 9 位 AI 大佬最新推文
- 🚨 重要推文实时推送飞书通知（lark-cli + Webhook 双通道）
- 📊 每天早 8 点生成 AI 洞见日报（热门话题、Top 推文、按人物分组）
- 🎯 智能重要性评分（关键词匹配 + 互动量分析）
- 📝 历史数据持久化，自动清理过期数据

## 监控目标

| 人物 | Handle | 关注领域 |
|------|--------|----------|
| Andrej Karpathy | @karpathy | AI 教育、LLM、神经网络 |
| Yann LeCun | @ylecun | Meta AI、深度学习 |
| Andrew Ng | @AndrewYNg | AI 教育、机器学习 |
| Ian Goodfellow | @goodfellow_ian | GAN、生成式 AI |
| David Ha | @hardmaru | 生成式艺术、创造性 AI |
| Jim Fan | @DrJimFan | NVIDIA、机器人、具身智能 |
| Demis Hassabis | @demishassabis | DeepMind、AGI、AlphaFold |
| Sam Altman | @sama | OpenAI、GPT、AGI |
| Ilya Sutskever | @ilyasut | 超级智能、AI 安全 |

在 `config.json` 的 `targets` 数组中添加新条目即可扩展。

## 快速开始

### 前置条件

- Node.js 22+
- Chrome 浏览器已登录 x.com，远程调试已启用（端口 9222）
- CDP Proxy 运行中（端口 3456）
- lark-cli 已安装并登录（`npm i -g @larksuite/cli && lark-cli auth login --recommend`）

### 1. 配置飞书通知

编辑 `config.json`，填入飞书群 chat_id：

```json
{
  "feishu": {
    "enabled": true,
    "chat_id": "oc_你的群聊ID",
    "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/你的webhook",
    "use_lark_cli": true,
    "as": "bot"
  }
}
```

chat_id 和 webhook_url 至少配一个。lark-cli 优先，Webhook 作为降级。

### 2. 安装定时任务

```bash
./scripts/setup-cron.sh install
```

这会配置：
- 每 30 分钟运行监控
- 每天 08:00 生成日报
- 每天 00:00 清理旧日志

### 3. 手动运行

```bash
# 立即运行一次监控
node scripts/monitor.js

# 立即生成日报
node scripts/daily-summary.js

# 测试飞书通知
node scripts/notify.js

# 查看系统状态
./scripts/setup-cron.sh status

# 诊断 Twitter 登录
node scripts/diagnose.js
```

## 项目结构

```
twitter-monitor/
├── config.json              # 配置文件（监控目标、飞书、调度）
├── scripts/
│   ├── monitor.js           # 核心监控脚本（CDP 抓取 + 飞书通知）
│   ├── daily-summary.js     # 每日汇总报告生成
│   ├── notify.js            # 飞书通知模块
│   ├── setup-cron.sh        # cron 定时任务管理
│   ├── diagnose.js          # Twitter 登录诊断
│   ├── start-monitor.sh     # 手动启动脚本
│   └── view-report.sh       # 查看报告
├── data/                    # 推文历史数据（自动管理）
├── reports/                 # 每日报告（YYYY-MM-DD.md）
└── logs/                    # 运行日志
```

## 添加新的监控目标

编辑 `config.json`，在 `targets` 数组中添加：

```json
{
  "handle": "用户名",
  "name": "显示名称",
  "url": "https://x.com/用户名",
  "keywords": ["关键词1", "关键词2"]
}
```

## 重要性评分规则

| 因素 | 分值 |
|------|------|
| 每个关键词匹配 | +10 |
| 互动量 > 1000 | +15 |
| 互动量 > 500 | +10 |
| 互动量 > 100 | +5 |
| 内容 > 200 字符 | +2 |

评分 ≥ 15 分触发飞书实时通知。

## 注意事项

- 建议监控间隔 ≥ 30 分钟，避免触发平台限制
- Chrome 需保持运行并已登录 x.com
- lark-cli token 过期时会自动降级到 Webhook
