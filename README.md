# Twitter AI 大佬监控系统 — 带 LLM 洞察 + 三层记忆

自动监控 18 个 AI 领域大佬与官方/团队账号的 Twitter/X 动态，**用 DeepSeek LLM 逐条提炼洞察**，飞书通知 + 每日 LLM 日报 + 每周知识蒸馏。目标：从"资讯搬运工"升级为"个人 AI 分析师 + 第二大脑"。

## 三层记忆架构

| 层级 | 时效 | 存储 | 谁维护 |
|------|------|------|--------|
| **短期** | 7 天滚动 | `data/{handle}.json` | `monitor.js` |
| **中期** | 永久 | `reports/daily/YYYY-MM-DD.md` | `daily-summary.js` |
| **长期** | 滚动重写 | `memory/long-term/core-insights.md` | `weekly-distill.js` |

**长期记忆有"反馈机制"**：周度蒸馏 prompt 会强制 LLM 输出"本周哪些信号挑战了之前的判断"，避免回音室效应。

## 功能流程

```
   每 12 小时               每天 18:30           每周一 09:00
       ↓                       ↓                    ↓
   monitor.js  →→→→→→  daily-summary.js  →→→  weekly-distill.js
       │                       │                    │
       │                       │                    │
   每条新推文                所有当日推文          7 份日报 + 旧 core
   调 LLM 提洞察            喂 LLM 写日报         喂 LLM 写新 core
       ↓                       ↓                    ↓
   data/*.json           reports/daily/        memory/long-term/
   (含 llm_insight)      *.md                  core-insights.md
       ↓                       ↓                    ↓
   飞书：高 novelty       飞书：Top 5 信号     飞书：本周新观点
   推文摘要               + 日报路径            + 蒸馏路径
```

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
| Peter Steinberger | @steipete | Agentic 工程、loop、OpenClaw、AI 编码 |

官方 / 团队 / 社区账号：

| 账号 | Handle | 关注领域 |
|------|--------|----------|
| Anthropic | @AnthropicAI | Claude 发布、AI 安全、研究 |
| Claude Developers | @ClaudeDevs | Claude Code、Agent、产品更新 |
| OpenAI | @OpenAI | GPT、AGI、产品发布 |
| OpenAI Developers | @OpenAIDevs | API、Codex、开发者更新 |
| Thariq Shihipar | @trq212 | Claude Code 团队、Agent 工程 |
| Boris Cherny | @bcherny | Claude Code 创造者/负责人、loop、Agent |
| Alexander Embiricos | @embirico | Codex 产品负责人 |
| 宝玉 | @dotey | AI 中文视角、Prompt、翻译 |

在 `config.json` 的 `targets` 添加新条目即可扩展。

## 快速开始

### 1. 前置条件

- Node.js 22+
- Chrome 远程调试已启用，已登录 x.com（端口 9222）
- CDP Proxy 运行中（端口 3456）
- lark-cli 已登录（`lark-cli auth login --recommend`）

### 2. 配置 DeepSeek API Key

```bash
mkdir -p ~/.config/twitter-monitor
chmod 700 ~/.config/twitter-monitor
cat > ~/.config/twitter-monitor/.env <<EOF
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EOF
chmod 600 ~/.config/twitter-monitor/.env
```

去 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 申请 key。`deepseek-chat` 同时用于单条推文提炼与日报/周报聚合。

⚠️ Key 永远不写进仓库。`.gitignore` 已禁止提交 `.env`。

### 3. 健康检查

```bash
./scripts/setup-cron.sh status   # 检查 Chrome / CDP Proxy / lark-cli / API key
./scripts/setup-cron.sh ping     # 真实调用一次 DeepSeek，确认配额可用
```

### 4. 配置飞书通知

编辑 `config.json` 的 `feishu` 段，填 `chat_id` 或 `webhook_url`，至少一个。

### 5. 安装定时任务

```bash
./scripts/setup-cron.sh install
```

调度：
- 每天 08:00 / 20:00：监控（含 LLM 洞察提取）
- 每天 18:30：日报（LLM 生成结构化中期记忆）
- 每周一 09:00：周度蒸馏（LLM 更新长期记忆）
- 每天 00:00：清理 7 天前的日志

### 6. 手动运行

```bash
# 立即抓取一次 + LLM 提炼洞察 + 推飞书
node scripts/monitor.js

# 立即生成今日日报
node scripts/daily-summary.js

# 立即蒸馏过去 7 天
node scripts/weekly-distill.js

# 蒸馏过去 14 天
node scripts/weekly-distill.js --days 14
```

### 7. 调试模式

```bash
# 不调用真实 LLM（mock 输出，省 token）
LLM_DRY_RUN=1 node scripts/monitor.js

# 不推送飞书（在终端预览消息）
NO_NOTIFY=1 node scripts/daily-summary.js

# 两者结合：完整离线测试
LLM_DRY_RUN=1 NO_NOTIFY=1 node scripts/weekly-distill.js
```

## 项目结构

```
twitter-monitor/
├── config.json
├── .env.example                # API key 模板（仓库内）
├── scripts/
│   ├── monitor.js              # 抓推文 + LLM 单条洞察
│   ├── daily-summary.js        # LLM 日报聚合
│   ├── weekly-distill.js       # LLM 周度蒸馏
│   ├── llm.js                  # DeepSeek 客户端（重试/降级/<think> 剥离）
│   ├── insights.js             # 三个核心 prompt
│   ├── notify.js               # 飞书通知（lark-cli + Webhook 双通道）
│   ├── setup-cron.sh           # cron 管理 + 健康检查 + ping
│   └── diagnose.js             # 排查 Twitter 登录
├── data/                       # 短期：原始推文 + llm_insight 缓存（7 天滚动）
├── reports/
│   ├── daily/                  # 中期：每日报告
│   └── weekly/                 # 周度：蒸馏快照（不可变）
├── memory/
│   ├── README.md               # 记忆系统说明
│   ├── long-term/
│   │   └── core-insights.md    # 长期：活文档（每周重写）
│   └── archive/                # 长期记忆历史版本归档
└── logs/
    ├── monitor.log
    ├── summary.log
    ├── weekly.log
    └── llm.log                 # 每次 LLM 调用的耗时/用量
```

## 单条推文洞察 Schema

每条推文经 LLM 处理后得到：

```json
{
  "one_liner":   "≤40 字 核心论点（不复述原文）",
  "why_matters": "≤80 字 为什么值得关注",
  "tags":        ["#GPT5", "#开源"],
  "type":        "announcement | insight | opinion | research | personal | other",
  "novelty":     0-10,
  "skip":        false,
  "skip_reason": ""
}
```

- `skip=true` 的不会推送飞书，源头降噪
- `novelty` 是飞书消息的主要排序维度（不只是看互动量）
- 极短推文（清理 URL 后 <15 字符）自动 skip，不浪费 token
- **置顶推文过滤**：发布时间超出保留窗口（默认 7 天）的置顶推文会被丢弃，避免长期挂顶的旧推文被反复判为"新动态"重复推送
- **跨账号去重**：同一轮抓取中，同一条推文（转推同 URL）或同内容（多个官方号发布同一消息，文本签名相同）只展示一次，由名单中靠前的账号"认领"

## 成本估算（按 DeepSeek 官方价格，仅供参考）

假设 9 个人 × 每天 12 条新推文（平均）= 100 条/天：

- 单条提炼（M2.7-highspeed）：100 × ~500 token = 5 万 token/天
- 日报聚合（M2.7）：约 2 万 token/天
- 周报蒸馏（M2.7）：约 5 万 token/周

按 highspeed 输入 0.4 元/百万 token、quality 1 元/百万 token 估算：**约 0.05 - 0.2 元/天**。订阅式 Token Plan Plus 套餐基本不会触底。

## 故障与降级

每个 LLM 调用都有 fallback：

| 场景 | 行为 |
|------|------|
| 余额不足（错误码 1008） | 单条提取降级到截首句模板，监控继续 |
| 套餐限流（错误码 2056） | 单条提取降级；日报降级模板；周报抛错让 cron 看到 |
| 网络/超时 | 3 次指数退避；最终失败按上面降级 |
| LLM 输出非 JSON | 让 LLM 重试一次；再失败用 fallback |
| `monitor.js` 抓不到 | 记日志，不影响其他人 |

## 注意事项

- 监控间隔不要 < 30 分钟（X 平台限制）
- Chrome 必须保持运行 + 登录 x.com
- lark-cli token 过期会自动降级到 Webhook
- `core-insights.md` 可以**手工编辑**（加批注用 `> ` 引用块），下次蒸馏 LLM 会保留你的批注作为输入
- 若想完全重建长期记忆：删 `memory/long-term/core-insights.md`，下次 weekly-distill 当作首次生成
