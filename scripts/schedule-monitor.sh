#!/bin/bash
# 定期监控脚本 - 可配合 cron 使用

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/../logs/cron.log"

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
  cd "$SCRIPT_DIR/.."
  node scripts/monitor.js
  echo ""
} >> "$LOG_FILE" 2>&1
