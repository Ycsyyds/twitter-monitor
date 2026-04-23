#!/bin/bash
# 在 Kiro 中打开最新的 Twitter AI 监控报告

REPORT_FILE="$HOME/twitter-monitor/reports/daily-ai-insights.md"

echo "📊 正在打开 Twitter AI 监控报告..."
echo "📁 文件: $REPORT_FILE"
echo ""

# 使用 Kiro 打开报告
kiro "$REPORT_FILE"

echo "✅ 报告已在 Kiro 中打开"
echo "💡 提示: 报告每 30 分钟自动更新一次"
