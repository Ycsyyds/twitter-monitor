# 电脑重启后的恢复速查

电脑重启后，cron 定时任务、Chrome、API key 都会自动恢复，**唯一需要手动拉起的是 CDP Proxy**（端口 3456）。
若 CDP Proxy 没起来，cron 会按时跑，但每次抓推文都会 `ECONNREFUSED 127.0.0.1:3456`，0 条新内容。

---

## 1. 一句话健康检查（先看哪儿坏了）

```bash
cd ~/twitter-monitor && ./scripts/setup-cron.sh status
```

关注最底部的 **🏥 健康检查**，5 项全 ✅ 才算正常：

```
✅ Chrome 运行中
✅ CDP Proxy 正常 (端口 3456)
✅ lark-cli 已安装
✅ Node.js v22.22.2
✅ MiniMax API key 已配置
```

最容易掉链子的是 **CDP Proxy 未运行**。

---

## 2. 启动 CDP Proxy（重启后通常只需要做这一步）

```bash
cd ~/twitter-monitor && ./scripts/start-cdp-proxy.sh start
```

脚本会：
- 检查 Chrome 远程调试端口（9222）是否在监听
- `nohup` 后台拉起 `~/.kiro/skills/web-access/scripts/cdp-proxy.mjs`
- 等最多 5 秒确认端口 3456 真正响应
- 把日志写到 `~/.cache/cdp-proxy/cdp-proxy.log`

如果已经在运行，会直接告诉你 PID，不会重复启动。

---

## 3. 停止 / 重启 / 状态

```bash
./scripts/start-cdp-proxy.sh status    # 查进程 + 端口 + Chrome
./scripts/start-cdp-proxy.sh stop      # 停止
./scripts/start-cdp-proxy.sh restart   # 重启
```

---

## 4. 测试抓取链路（可选）

不烧 LLM token、不发飞书，只验证 Chrome → CDP Proxy → Twitter 链路是否畅通：

```bash
cd ~/twitter-monitor
LLM_DRY_RUN=1 NO_NOTIFY=1 node scripts/monitor.js
```

输出里 9 个目标都不再出现 `ECONNREFUSED` 即可。

---

## 5. 顺序很重要：先 Chrome，再 CDP Proxy

CDP Proxy 依赖 Chrome 远程调试端口（9222）。如果连 Chrome 都没起来，CDP Proxy 启动后 `connected` 字段会是 `false`。

判断 Chrome 调试端口：

```bash
ss -ltn | grep ":9222"   # 有输出就 OK
```

没有输出说明 Chrome 没用远程调试模式启动，需要按你之前的方式重新打开 Chrome（带 `--remote-debugging-port=9222`），并登录 x.com。

恢复顺序：

```
Chrome (9222)  →  CDP Proxy (3456)  →  cron 自动跑
```

---

## 故障排查表

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| `setup-cron.sh status` 显示 ❌ CDP Proxy 未运行 | 重启后没拉起 | 见 §2 |
| `/health` 返回 `connected: false` | Chrome 没起或 9222 没监听 | 见 §5 |
| monitor.log 全是 `ECONNREFUSED 127.0.0.1:3456` | CDP Proxy 挂了 | 见 §3 重启 |
| monitor.log 出现登录页/未登录提示 | Chrome 里 x.com session 失效 | 在 Chrome 里重新登录 |
| 飞书没消息但日志正常 | lark-cli token 过期 | `lark-cli auth login --recommend` |
