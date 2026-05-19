#!/usr/bin/env node

/**
 * 洞察提取与记忆生成 — A 方案的"大脑"
 *
 * 三个核心能力：
 *   1. extractTweetInsight     — 单条推文 → 结构化 JSON 洞察（highspeed 模型）
 *   2. aggregateDailyInsights  — 当日所有洞察 → 结构化日报 Markdown（quality 模型）
 *   3. distillWeekly           — 7 份日报 + 当前长期记忆 → 更新后的长期记忆（quality 模型）
 *
 * 设计原则：
 *   - 全中文输出（与用户语言一致）
 *   - 严格的字段约束 + JSON Schema
 *   - 失败降级：单条提取失败时返回 fallback insight，不让流程挂掉
 *   - 强调「新颖度」与「可证伪性」，避免回音室
 */

const llm = require('./llm');

// ==================== 1. 单条推文洞察提取 ====================

const TWEET_INSIGHT_SYSTEM = `你是一位资深的 AI 行业分析师，擅长从大佬的 X/Twitter 推文中快速提炼信号。
你的任务：把一条原始推文转成结构化洞察 JSON。

判断标准：
- one_liner：用一句话说清楚这条推文在说什么（≤40 字，中文，不要复述原文，要"提炼"核心论点）
- why_matters：为什么值得 AI 从业者关注？背景是什么？信号意味着什么？（≤80 字，中文）
  · 如果只是空话/感慨/吃瓜/转发广告/纯个人生活，写 "无明确行业信号"
- tags：1-4 个主题标签，#xxx 格式（中英文都可，例如 #GPT5 #开源 #AI对齐 #具身智能）
- type：单选
  · announcement = 发布/公告/新功能/新论文
  · insight      = 新观点/独到见解/深度分析
  · opinion      = 表态/评论/争论
  · research     = 研究进展/技术细节/实验结果
  · personal     = 个人动态/感谢/玩梗/无关内容
  · other
- novelty：0-10，相对于此人长期立场和行业共识，这条信息的"新"程度
  · 0-2  = 老生常谈、重复立场、转发别人
  · 3-5  = 略有变化或细节补充
  · 6-8  = 明显新观点/新发布/立场转变
  · 9-10 = 重大信号、可能改变行业判断
- skip：bool。true 表示这条不值得推送给用户飞书（纯个人/广告/吃瓜/纯转发无评论）
- skip_reason：skip=true 时简述原因（≤20 字）

输出严格 JSON，不要 markdown 代码块、不要解释、不要 think 标签外的内容。
格式示例：{"one_liner":"...","why_matters":"...","tags":["#x"],"type":"insight","novelty":7,"skip":false,"skip_reason":""}`;

function buildTweetUserPrompt(tweet, target) {
  const eng = tweet.engagement || {};
  const total = (eng.likes || 0) + (eng.retweets || 0) + (eng.replies || 0);
  return `作者：${target.name}（@${target.handle}），关注领域：${(target.keywords || []).join(', ')}
互动量：👍${eng.likes || 0} 🔄${eng.retweets || 0} 💬${eng.replies || 0}（合计 ${total}）
发布时间：${tweet.time || '未知'}

推文原文：
"""
${tweet.text}
"""

请按 system 要求输出 JSON。`;
}

function fallbackInsight(tweet, reason = 'llm_unavailable') {
  // LLM 不可用时的降级 — 用原来的截首句逻辑
  const cleaned = (tweet.text || '').replace(/https?:\/\/\S+/g, '').trim();
  const firstSentence = cleaned.split(/[.\n!?。！？]/)[0].trim();
  const oneLiner = firstSentence.length > 8 && firstSentence.length < 80
    ? firstSentence
    : cleaned.slice(0, 60);
  return {
    one_liner: oneLiner,
    why_matters: '无明确行业信号',
    tags: [],
    type: 'other',
    novelty: 3,
    skip: false,
    skip_reason: '',
    _fallback: reason,
  };
}

function mockTweetInsight(tweet, target) {
  return JSON.stringify({
    one_liner: `[mock] ${target.name} 的洞察占位`,
    why_matters: '[mock] dry-run 模式，无实际分析',
    tags: ['#mock', '#dryrun'],
    type: 'opinion',
    novelty: 5,
    skip: false,
    skip_reason: '',
  });
}

/**
 * 提取单条推文的洞察
 * @returns {Promise<Object>} insight JSON，永远不抛错（失败返回 fallback）
 */
async function extractTweetInsight(tweet, target, opts = {}) {
  // 已经有缓存就跳过
  if (tweet.llm_insight && !opts.force) return tweet.llm_insight;

  // 极短推文（< 15 字符，纯链接/纯 emoji）不值得调 LLM
  const cleanText = (tweet.text || '').replace(/https?:\/\/\S+/g, '').trim();
  if (cleanText.length < 15) {
    return { ...fallbackInsight(tweet, 'too_short'), skip: true, skip_reason: '内容过短' };
  }

  try {
    const { json } = await llm.completeJSON(
      TWEET_INSIGHT_SYSTEM,
      buildTweetUserPrompt(tweet, target),
      {
        model: opts.model,
        temperature: 0.2,
        max_tokens: 1024,
        dry_run: opts.dry_run,
        mock: opts.dry_run ? mockTweetInsight(tweet, target) : undefined,
      },
    );
    // 字段补齐 + 截断
    return {
      one_liner: String(json.one_liner || '').slice(0, 80),
      why_matters: String(json.why_matters || '').slice(0, 200),
      tags: Array.isArray(json.tags) ? json.tags.slice(0, 4).map(String) : [],
      type: json.type || 'other',
      novelty: typeof json.novelty === 'number' ? json.novelty : 3,
      skip: !!json.skip,
      skip_reason: String(json.skip_reason || '').slice(0, 40),
    };
  } catch (e) {
    if (e.code === 'INSUFFICIENT_BALANCE') {
      console.warn(`  ⚠️ LLM 余额不足，单条推文降级到模板模式`);
    } else if (e.code === 'RATE_LIMITED') {
      console.warn(`  ⚠️ LLM 配额受限（重置: ${e.resets_at || '未知'}），降级到模板模式`);
    } else if (/failed to parse JSON/.test(e.message)) {
      // 打印截断的 LLM 原始输出，便于诊断是截断还是格式问题
      const snippet = e.message.replace('failed to parse JSON from LLM response: ', '');
      console.warn(`  ⚠️ JSON 解析失败 [${snippet.length === 0 ? '空响应' : '内容截断'}]: ${snippet.slice(0, 150)}`);
    } else {
      console.warn(`  ⚠️ 单条洞察提取失败: ${e.message.slice(0, 120)}`);
    }
    return fallbackInsight(tweet, e.code || 'error');
  }
}

// ==================== 2. 日度聚合 ====================

const DAILY_AGGREGATE_SYSTEM = `你是一位资深 AI 行业分析师，正在为一位订阅者撰写「AI 大佬动态日报」。
输入是当天 9 位 AI 大佬发布的推文及每条已抽取的结构化洞察。
输出是一份高信息密度、可读性强的中文 Markdown 日报。

报告必须包含五个部分（用二级标题分隔），缺少数据则跳过对应章节：

## 🎯 今日核心信号
跨人物提炼出 3-5 条最值得关注的信号。每条 1-2 句话，并用 (来源: @handle) 标注。
重点：不是简单的"谁说了什么"，而是"这意味着什么"。如果两人观点形成互补/冲突/共振，必须点出来。

## 📈 主题热度
当天讨论度最高的 3-5 个主题，每个主题列举关键人物及其立场（一行内）。

## ⚖️ 立场分歧 / 共识
如果存在多人就同一议题表态（无论赞同还是分歧），单独列出。如无明显多人讨论，整段省略。

## 👁 持续追踪信号
那些当下还不确定但值得后续观察的信号、悬念、模糊表态。

## 👥 各人物动态
按人物分组，每人 1-3 条最重要的推文，格式：
- **<one_liner>** — <why_matters 摘要> [novelty:N] [→](原文链接)

要求：
- 全中文，不要原文长段引用
- 第三人称、客观、不卖弄
- 不要标题党，不要客套话
- 总长度 800-1500 字

只输出 Markdown，从一级或二级标题开始。`;

function buildDailyUserPrompt(date, insightsByAuthor) {
  let blob = `日期：${date}\n监控人数：${insightsByAuthor.length}\n\n`;
  for (const group of insightsByAuthor) {
    blob += `### ${group.target.name} (@${group.target.handle}) — ${group.tweets.length} 条\n`;
    for (const t of group.tweets) {
      const ins = t.llm_insight || {};
      const eng = t.engagement || {};
      const engStr = `👍${eng.likes || 0} 🔄${eng.retweets || 0} 💬${eng.replies || 0}`;
      blob += `- [${ins.type || '?'} | novelty:${ins.novelty ?? '?'} | ${engStr}] `;
      blob += `${ins.one_liner || (t.text || '').slice(0, 60)}`;
      if (ins.why_matters && ins.why_matters !== '无明确行业信号') {
        blob += ` — ${ins.why_matters}`;
      }
      if (ins.tags && ins.tags.length) blob += ` ${ins.tags.join(' ')}`;
      if (t.url) blob += ` [link:${t.url}]`;
      blob += '\n';
    }
    blob += '\n';
  }
  return blob + '\n请基于以上数据撰写日报。';
}

function fallbackDailyReport(date, groups) {
  let md = `# 🤖 AI 大佬日报 (LLM 失败降级) | ${date}\n\n`;
  for (const g of groups) {
    md += `## ${g.target.name} (@${g.target.handle})\n`;
    for (const t of g.tweets.slice(0, 3)) {
      const ins = t.llm_insight || {};
      md += `- ${ins.one_liner || (t.text || '').slice(0, 80)}`;
      if (t.url) md += ` [→](${t.url})`;
      md += '\n';
    }
    md += '\n';
  }
  return md;
}

function mockDailyReport(date, groups) {
  return `# 🤖 AI 大佬日报 (mock) | ${date}\n\n## 🎯 今日核心信号\n- [mock] dry-run 占位\n\n## 👥 各人物动态\n` +
    groups.map(g => `### ${g.target.name}\n- ${g.tweets.length} 条推文（mock）`).join('\n');
}

async function aggregateDailyInsights(insightsByAuthor, date, opts = {}) {
  const totalTweets = insightsByAuthor.reduce((s, g) => s + g.tweets.length, 0);
  if (totalTweets === 0) {
    return `# 🤖 AI 大佬日报 | ${date}\n\n*今日无新推文*\n`;
  }

  try {
    const { text } = await llm.completeText(
      DAILY_AGGREGATE_SYSTEM,
      buildDailyUserPrompt(date, insightsByAuthor),
      {
        model: llm.getConfig().model_quality,
        temperature: 0.4,
        max_completion_tokens: 2048,
        dry_run: opts.dry_run,
        mock: opts.dry_run ? mockDailyReport(date, insightsByAuthor) : undefined,
      },
    );
    return text;
  } catch (e) {
    console.warn(`⚠️ 日报 LLM 生成失败 (${e.code || 'error'})：${e.message.slice(0, 100)}，降级到模板`);
    return fallbackDailyReport(date, insightsByAuthor);
  }
}

// ==================== 3. 周度蒸馏 ====================

const WEEKLY_DISTILL_SYSTEM = `你是一位资深 AI 行业分析师，正在维护一份「AI 行业核心观点库」(core-insights.md)。
这份文档是用户的"长期记忆 + 第二大脑"，记录他长期跟踪的 AI 大佬们的核心观点演变与行业趋势。

输入：
  1. 过去 7 天的日报（中期记忆）
  2. 上一版的 core-insights.md（已有的长期记忆，可能为空）

输出：
  完整重写后的 core-insights.md，结构如下，缺少数据则跳过对应章节：

# AI 行业核心观点库
*最后更新：YYYY-MM-DD*

## ⭐ 本周新出现的观点
本周首次出现、且具备一定深度的观点。每条标注 (谁, 何时) 来源。

## 🔼 被强化的观点
本周有新证据/新支持的旧观点。说明"如何被强化"。

## 🔽 被削弱 / 被反驳的观点
本周出现了挑战之前判断的信号。说明"如何被挑战"。⚠️ 这一节非常重要，避免回音室。

## 📊 长期趋势线
跨周/跨月的累积趋势（基于上一版 core-insights 的延续）。

## 👀 持续追踪信号
还无定论的信号、悬念。

## 👥 关键人物画像
每个有显著动态的大佬一段简短画像（最近关注什么、近期立场）。

写作要求：
- 全中文，第三人称客观
- 信息密度高，不要客套
- 引用观点必须可追溯（标 @handle）
- 长度 1500-3000 字
- 不要保留过期或已被反驳的旧观点（这是"蒸馏"，不是"累加"）
- 重点保留有持续讨论价值、真实形成趋势的内容

只输出 Markdown，从一级标题开始。`;

function buildWeeklyUserPrompt(weekLabel, dailyReports, prevLongTerm) {
  let blob = `本周标签：${weekLabel}\n\n## 输入 1：过去 7 天的日报\n\n`;
  for (const r of dailyReports) {
    blob += `### ${r.date}\n\n${r.content}\n\n---\n\n`;
  }
  blob += `## 输入 2：上一版 core-insights.md\n\n`;
  blob += prevLongTerm
    ? '```markdown\n' + prevLongTerm + '\n```\n'
    : '_（首次生成，无历史长期记忆）_\n';
  blob += '\n请基于以上输入，重写 core-insights.md。';
  return blob;
}

async function distillWeekly(weekLabel, dailyReports, prevLongTerm, opts = {}) {
  if (dailyReports.length === 0) {
    return `# AI 行业核心观点库\n\n*${weekLabel} 本周无日报数据，跳过更新*\n`;
  }
  try {
    const { text } = await llm.completeText(
      WEEKLY_DISTILL_SYSTEM,
      buildWeeklyUserPrompt(weekLabel, dailyReports, prevLongTerm),
      {
        model: llm.getConfig().model_quality,
        temperature: 0.4,
        max_completion_tokens: 4096,
        dry_run: opts.dry_run,
        mock: opts.dry_run
          ? `# AI 行业核心观点库 (mock)\n\n*最后更新: ${weekLabel}*\n\n## ⭐ 本周新出现的观点\n- [mock] dry-run 模式占位\n`
          : undefined,
      },
    );
    return text;
  } catch (e) {
    console.warn(`⚠️ 周度蒸馏失败 (${e.code || 'error'})：${e.message.slice(0, 100)}`);
    throw e; // 周度任务失败时不降级，让 cron 看到错误
  }
}

module.exports = {
  extractTweetInsight,
  aggregateDailyInsights,
  distillWeekly,
  fallbackInsight,
};
