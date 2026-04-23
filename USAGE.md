# Twitter AI 大佬监控系统 — 使用说明

## 系统概述

自动监控 9 位 AI 领域大佬的 Twitter/X 动态，重要推文实时推送飞书，每天生成 AI 洞见日报。

**当前调度：**
- 每 1 小时抓取一次推文（整点触发）
- 每天 18:30 生成并推送日报
- 每天 00:00 自动清理 7 天前的日志

## 前置依赖

| 依赖 | 说明 |
|------|------|
| Node.js 22+ | 运行脚本 |
| Chrome 浏览器 | 需已登录 x.com，开启远程调试（端口 9222） |
| CDP Proxy | 运行在端口 3456，桥接 Chrome DevTools Protocol |
| lark-cli（可选） | 飞书消息发送，Webhook 可作为替代 |

## 启动与停止

### 安装定时任务（启动）

```bash
./scripts/setup-cron.sh install
```

安装后系统通过 cron 自动运行，无需手动保持进程。

### 停止

```bash
./scripts/setup-cron.sh remove
```

### 查看状态

```bash
./scripts/setup-cron.sh status
```

输出包括：当前 cron 规则、数据文件列表、最近日志、Chrome/CDP Proxy/lark-cli 健康检查。

## 手动操作

```bash
# 立即运行一次监控（抓取推文 + 飞书通知）
node scripts/monitor.js

# 立即生成今日日报
node scripts/daily-summary.js

# 测试飞书通知是否正常
node scripts/notify.js

# 诊断 Twitter 登录状态
node scripts/diagnose.js

# 查看今日报告
cat reports/$(date +%Y-%m-%d).md
```

## 配置说明

所有配置在 `config.json` 中，修改后下次 cron 触发自动生效。

### 监控目标

`targets` 数组，每个条目：

```json
{
  "handle": "karpathy",
  "name": "Andrej Karpathy",
  "url": "https://x.com/karpathy",
  "keywords": ["AI", "LLM", "neural", "deep learning"]
}
```

- `handle`：Twitter 用户名（不含 @）
- `keywords`：用于重要性评分的关键词，每匹配一个 +10 分

### 飞书通知

```json
{
  "feishu": {
    "enabled": true,
    "chat_id": "oc_xxx",
    "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "use_lark_cli": true,
    "as": "bot"
  }
}
```

- `chat_id` + `use_lark_cli`：通过 lark-cli 发送（优先）
- `webhook_url`：通过 Webhook HTTP 发送（降级方案）
- 两者配一个即可，都配则 lark-cli 优先、Webhook 兜底

### 调度参数

| 参数 | 位置 | 说明 |
|------|------|------|
| `monitoring.interval_minutes` | config.json | 监控间隔（分钟），需与 cron 一致 |
| `monitoring.max_tweets_per_check` | config.json | 每次每人最多抓取推文数 |
| `daily_summary.hour` | config.json | 日报生成时间（小时） |
| `daily_summary.top_n_per_user` | config.json | 日报中每人展示的 Top 推文数 |
| `storage.tweet_history_days` | config.json | 推文数据保留天数 |

> 修改 cron 时间需编辑 `scripts/setup-cron.sh` 后重新 `./scripts/setup-cron.sh install`。

## 重要性评分与通知规则

| 因素 | 分值 |
|------|------|
| 每个关键词匹配 | +10 |
| 互动量 > 1000 | +15 |
| 互动量 > 500 | +10 |
| 互动量 > 100 | +5 |
| 内容 > 200 字符 | +2 |

**评分 ≥ 15 分**的推文触发飞书实时通知。低于阈值的推文仅记录数据，不推送。

## 文件结构

```
twitter-monitor/
├── config.json              # 配置文件
├── scripts/
│   ├── monitor.js           # 核心监控（CDP 抓取 + 评分 + 通知）
│   ├── daily-summary.js     # 日报生成（Markdown + 飞书摘要）
│   ├── notify.js            # 飞书通知（lark-cli / Webhook）
│   ├── diagnose.js          # Twitter 登录诊断
│   ├── setup-cron.sh        # cron 管理（install / remove / status）
│   ├── start-monitor.sh     # 手动启动脚本
│   └── view-report.sh       # 查看报告
├── data/                    # 推文历史（每人一个 JSON + notified.json）
├── reports/                 # 日报（YYYY-MM-DD.md）
└── logs/                    # 运行日志（monitor.log / summary.log）
```

## 常见问题

### 机器重启后需要做什么？

cron 会随系统自动恢复，但需确保：
1. Chrome 远程调试已启动（端口 9222）
2. CDP Proxy 已启动（端口 3456）

可用 `./scripts/setup-cron.sh status` 检查健康状态。

### 飞书收不到通知？

1. 运行 `node scripts/notify.js` 测试
2. 检查 `config.json` 中 `webhook_url` 是否正确
3. 确认飞书群机器人未被禁用

### 推文数据为空？

部分大佬发推频率低，超过 7 天的推文会被自动清理。可调大 `storage.tweet_history_days`。

### 如何添加新的监控目标？

编辑 `config.json` → `targets` 数组添加新条目，下次 cron 触发自动生效。

### 如何修改监控频率？

1. 编辑 `scripts/setup-cron.sh` 中的 cron 表达式
2. 同步修改 `config.json` 中的 `monitoring.interval_minutes`
3. 重新运行 `./scripts/setup-cron.sh install`
