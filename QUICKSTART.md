# 快速上手 🚀

## 3 步启动

```bash
# 1. 配置飞书（编辑 config.json 填入 chat_id 或 webhook_url）
vim config.json

# 2. 检查系统状态
./scripts/setup-cron.sh status

# 3. 安装定时任务
./scripts/setup-cron.sh install
```

## 常用命令

```bash
# 手动监控
node scripts/monitor.js

# 生成日报
node scripts/daily-summary.js

# 测试飞书通知
node scripts/notify.js

# 查看状态 / 移除定时任务
./scripts/setup-cron.sh status
./scripts/setup-cron.sh remove
```

## 查看报告

```bash
# 今日报告
cat reports/$(date +%Y-%m-%d).md

# 或用 Kiro
kiro ~/twitter-monitor/reports/
```

## 添加监控目标

编辑 `config.json` → `targets` 数组，添加新条目即可。
