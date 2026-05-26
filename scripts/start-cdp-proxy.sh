#!/bin/bash
# 启动 / 停止 / 重启 CDP Proxy（端口 3456）
# 用法: ./scripts/start-cdp-proxy.sh [start|stop|restart|status]
#
# CDP Proxy 是 web-access skill 自带的脚本，桥接 Chrome DevTools Protocol。
# Twitter 抓取链路：cron → monitor.js → CDP Proxy(3456) → Chrome(9222) → x.com

set -u

PROXY_SCRIPT="$HOME/.kiro/skills/web-access/scripts/cdp-proxy.mjs"
PROXY_PORT=3456
CHROME_PORT=9222
LOG_DIR="$HOME/.cache/cdp-proxy"
LOG_FILE="$LOG_DIR/cdp-proxy.log"

# 自动探测 node 路径（兼容 nvm / 系统装）
NODE="$(command -v node || echo /usr/bin/node)"
if [ -x "/home/ycs/.nvm/versions/node/v24.14.1/bin/node" ]; then
  NODE="/home/ycs/.nvm/versions/node/v24.14.1/bin/node"
fi

is_running() {
  pgrep -f "cdp-proxy.mjs" > /dev/null 2>&1
}

is_listening() {
  curl -s --max-time 2 "http://localhost:$PROXY_PORT/health" > /dev/null 2>&1
}

check_chrome() {
  if ss -ltn 2>/dev/null | grep -q ":$CHROME_PORT "; then
    return 0
  fi
  return 1
}

start_proxy() {
  if [ ! -f "$PROXY_SCRIPT" ]; then
    echo "❌ 找不到 CDP Proxy 脚本: $PROXY_SCRIPT"
    echo "   web-access skill 是否已安装？"
    exit 1
  fi

  if is_running; then
    echo "ℹ️  CDP Proxy 已在运行 (PID: $(pgrep -f cdp-proxy.mjs | head -1))"
    if is_listening; then
      echo "✅ 端口 $PROXY_PORT 响应正常"
      return 0
    else
      echo "⚠️  进程在但端口 $PROXY_PORT 不响应，建议 restart"
      return 1
    fi
  fi

  if ! check_chrome; then
    echo "⚠️  Chrome 远程调试端口 $CHROME_PORT 未监听"
    echo "   CDP Proxy 仍会启动，但 connected 会是 false"
    echo "   请先确保 Chrome 用 --remote-debugging-port=$CHROME_PORT 启动并登录 x.com"
  fi

  mkdir -p "$LOG_DIR"
  nohup "$NODE" "$PROXY_SCRIPT" > "$LOG_FILE" 2>&1 &
  disown
  local pid=$!

  # 等最多 5 秒让端口起来
  for i in 1 2 3 4 5; do
    sleep 1
    if is_listening; then
      echo "✅ CDP Proxy 已启动 (PID: $pid, 端口: $PROXY_PORT)"
      echo "   日志: $LOG_FILE"
      curl -s "http://localhost:$PROXY_PORT/health"
      echo ""
      return 0
    fi
  done

  echo "❌ CDP Proxy 启动后端口未响应，查看日志:"
  echo "   tail -n 30 $LOG_FILE"
  return 1
}

stop_proxy() {
  if ! is_running; then
    echo "ℹ️  CDP Proxy 未在运行"
    return 0
  fi
  pkill -f "cdp-proxy.mjs"
  sleep 1
  if is_running; then
    echo "⚠️  正常 kill 失败，强制 kill -9"
    pkill -9 -f "cdp-proxy.mjs"
    sleep 1
  fi
  if is_running; then
    echo "❌ 仍有 cdp-proxy.mjs 残留，请手动检查"
    pgrep -af cdp-proxy.mjs
    return 1
  fi
  echo "✅ CDP Proxy 已停止"
}

show_status() {
  echo "📂 脚本: $PROXY_SCRIPT"
  echo "📝 日志: $LOG_FILE"
  echo ""

  if is_running; then
    echo "✅ 进程在: $(pgrep -af cdp-proxy.mjs)"
  else
    echo "❌ 进程未运行"
  fi

  if is_listening; then
    echo "✅ 端口 $PROXY_PORT 响应正常"
    echo -n "   /health: "
    curl -s "http://localhost:$PROXY_PORT/health"
    echo ""
  else
    echo "❌ 端口 $PROXY_PORT 未响应"
  fi

  if check_chrome; then
    echo "✅ Chrome 远程调试端口 $CHROME_PORT 在监听"
  else
    echo "❌ Chrome 远程调试端口 $CHROME_PORT 未监听"
  fi
}

case "${1:-start}" in
  start)   start_proxy ;;
  stop)    stop_proxy ;;
  restart) stop_proxy; start_proxy ;;
  status)  show_status ;;
  *)       echo "用法: $0 [start|stop|restart|status]"; exit 1 ;;
esac
