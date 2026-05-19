# 记忆系统说明

这套监控系统采用**三层记忆**：

| 层级 | 时效 | 存储位置 | 维护方式 |
|------|------|----------|----------|
| **短期** | 当次抓取 | `data/{handle}.json` | `monitor.js` 每次抓取自动管理（保留 7 天） |
| **中期** | 天级 | `reports/daily/YYYY-MM-DD.md` | `daily-summary.js` 每天生成 |
| **长期** | 持续 | `memory/long-term/core-insights.md` | `weekly-distill.js` 每周蒸馏 |

## 长期记忆生命周期

`core-insights.md` 是**活文档**：每周由 LLM 重写。重写时：

1. 输入：过去 7 天的中期日报 + 当前长期记忆
2. 输出：新版 `core-insights.md`（覆盖）
3. 旧版自动归档到 `archive/core-insights-YYYY-MM-DD.md`
4. 同时一份不可变快照写到 `reports/weekly/YYYY-Www.md`

蒸馏 prompt 强制 LLM 完成两件事：
- **正向**：保留有趋势/有共识的核心观点
- **反向**："本周哪些信号挑战了之前的判断？"——避免回音室

## 文件说明

```
memory/
├── README.md              # 本文件
├── long-term/
│   ├── core-insights.md   # 活文档：当前长期观点库（每周更新）
│   └── profiles/          # 预留：人物画像（后续扩展）
└── archive/
    └── core-insights-*.md # 历史版本归档（可追溯）
```

## 手工干预

`core-insights.md` 是 Markdown，可以手工编辑：
- 删除你认为已经无价值的章节
- 加入个人评论（用 `> ` 引用块标记）
- 下次蒸馏时 LLM 会保留你的评论作为输入

如果想完全重建长期记忆：删除 `long-term/core-insights.md`，下次 `weekly-distill.js` 会作为"首次生成"模式重写。
