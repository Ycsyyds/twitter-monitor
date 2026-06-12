#!/bin/bash
# 一键配置 cron 定时任务
# 用法: ./scripts/setup-cron.sh [install|remove|status]

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CRON_TAG="# twitter-ai-monitor"

# 自动探测 node 路径（兼容 nvm / 系统装）
NODE="$(command -v node || echo /usr/bin/node)"
if [ -x "/home/ycs/.nvm/versions/node/v24.14.1/bin/node" ]; then
  NODE="/home/ycs/.nvm/versions/node/v24.14.1/bin/node"
fi

install_cron() {
  # 移除旧的
  crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -

  # 添加新的
  (crontab -l 2>/dev/null; cat <<EOF
0 8,20 * * * cd $PROJECT_DIR && ./scripts/start-cdp-proxy.sh start >> logs/proxy.log 2>&1 && $NODE scripts/monitor.js >> logs/monitor.log 2>&1 $CRON_TAG
30 18 * * * cd $PROJECT_DIR && $NODE scripts/daily-summary.js >> logs/summary.log 2>&1 $CRON_TAG
0 9 * * 1  cd $PROJECT_DIR && $NODE scripts/weekly-distill.js >> logs/weekly.log 2>&1 $CRON_TAG
0 0 * * *  find $PROJECT_DIR/logs -name "*.log" -mtime +7 -delete $CRON_TAG
EOF
  ) | crontab -

  echo "✅ Cron 任务已安装:"
  echo "  - 每天 08:00 和 20:00: 监控推文 (LLM 提炼洞察)"
  echo "  - 每天 18:30: 每日汇总 (LLM 生成结构化日报)"
  echo "  - 每周一 09:00: 周度蒸馏 (LLM 更新长期记忆)"
  echo "  - 每天 00:00: 日志清理"
  echo ""
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
  ls -la "$PROJECT_DIR/data/"*.json 2>/dev/null | head -5 || echo "  (无)"
  echo "📝 最近日志:"
  tail -3 "$PROJECT_DIR/logs/monitor.log" 2>/dev/null || echo "  (无)"

  # 健康检查
  echo ""
  echo "🏥 健康检查:"

  # Chrome
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
  echo "  ✅ Node.js $(node -v 2>/dev/null || echo 未安装)"

  # MiniMax key
  if [ -f "$HOME/.config/twitter-monitor/.env" ]; then
    if grep -q "^MINIMAX_API_KEY=sk-" "$HOME/.config/twitter-monitor/.env" 2>/dev/null; then
      echo "  ✅ MiniMax API key 已配置"
    else
      echo "  ⚠️  ~/.config/twitter-monitor/.env 缺少 MINIMAX_API_KEY"
    fi
  else
    echo "  ❌ ~/.config/twitter-monitor/.env 不存在 (无 LLM 能力)"
  fi
}

case "${1:-status}" in
  install) install_cron ;;
  remove)  remove_cron ;;
  status)  show_status ;;
  ping)
    echo "🩺 LLM 健康检查 (调用 MiniMax API)..."
    cd "$PROJECT_DIR" && $NODE scripts/llm.js
    ;;
  *)       echo "用法: $0 [install|remove|status|ping]" ;;
esac
