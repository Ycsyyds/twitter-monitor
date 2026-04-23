#!/bin/bash
# Twitter 监控启动脚本

cd "$(dirname "$0")"
cd ..

echo "🚀 启动 Twitter AI 大佬监控系统"
echo "⏰ $(date '+%Y-%m-%d %H:%M:%S')"

# 确保数据目录存在
mkdir -p data logs

# 运行监控
node scripts/monitor.js

echo "✅ 监控完成"
