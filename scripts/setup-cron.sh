#!/bin/bash
# 一键配置 cron 定时任务
# 用法: ./scripts/setup-cron.sh [install|remove|status]

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CRON_TAG="# twitter-ai-monitor"

NODE="/home/ycs/.nvm/versions/node/v24.14.1/bin/node"

install_cron() {
  # 移除旧的
  crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -

  # 添加新的
  (crontab -l 2>/dev/null; cat <<EOF
0 8,20 * * * cd $PROJECT_DIR && $NODE scripts/monitor.js >> logs/monitor.log 2>&1 $CRON_TAG
30 18 * * * cd $PROJECT_DIR && $NODE scripts/daily-summary.js >> logs/summary.log 2>&1 $CRON_TAG
0 0 * * * find $PROJECT_DIR/logs -name "*.log" -mtime +7 -delete $CRON_TAG
EOF
  ) | crontab -

  echo "✅ Cron 任务已安装:"
  echo "  - 每天 08:00 和 20:00: 监控推文"
  echo "  - 每天 18:30: 每日汇总"
  echo "  - 每天 00:00: 日志清理"
  crontab -l | grep "$CRON_TAG"
}

remove_cron() {
  crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -
  echo "✅ 已移除所有 twitter-ai-monitor cron 任务"
}

show_status() {
  echo "📋 当前 cron 任务:"
  crontab -l 2>/dev/null | grep "$CRON_TAG" || echo "  (无)"

  echo ""
  echo "📂 项目目录: $PROJECT_DIR"
  echo "📊 数据文件:"
  ls -la "$PROJECT_DIR/data/"*.json 2>/dev/null || echo "  (无)"
  echo "📝 最近日志:"
  tail -3 "$PROJECT_DIR/logs/monitor.log" 2>/dev/null || echo "  (无)"

  # 健康检查
  echo ""
  echo "🏥 健康检查:"

  # Chrome 进程
  if pgrep -x "chrome" > /dev/null || pgrep -x "google-chrome" > /dev/null; then
    echo "  ✅ Chrome 运行中"
  else
    echo "  ❌ Chrome 未运行"
  fi

  # CDP Proxy
  if curl -s http://localhost:3456/targets > /dev/null 2>&1; then
    echo "  ✅ CDP Proxy 正常 (端口 3456)"
  else
    echo "  ❌ CDP Proxy 未运行"
  fi

  # lark-cli
  if command -v lark-cli > /dev/null 2>&1; then
    echo "  ✅ lark-cli 已安装"
  else
    echo "  ⚠️  lark-cli 未安装"
  fi

  # Node.js
  echo "  ✅ Node.js $(node -v)"
}

case "${1:-status}" in
  install) install_cron ;;
  remove)  remove_cron ;;
  status)  show_status ;;
  *)       echo "用法: $0 [install|remove|status]" ;;
esac
