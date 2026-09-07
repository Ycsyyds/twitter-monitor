#!/usr/bin/env node

/**
 * 每日 AI 洞见日报 — LLM 生成结构化版本
 *
 * 流程：
 *   1. 从 data/ 读取当天的所有推文（按本地时区切割）
 *   2. 对没有 llm_insight 的推文补 enrich（一般不会发生，因 monitor.js 已 enrich 并持久化）
 *   3. 调用 insights.aggregateDailyInsights → LLM 生成结构化 markdown 日报
 *   4. 写到 reports/daily/YYYY-MM-DD.md（中期记忆）
 *   5. 推送飞书简短摘要
 *
 * 环境变量：
 *   LLM_DRY_RUN=1  使用 mock LLM 输出，不消耗 token
 *   NO_NOTIFY=1    不推送飞书
 */

const fs = require('fs');
const path = require('path');
const notify = require('./notify');
const insights = require('./insights');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DATA_DIR = path.join(__dirname, '..', 'data');
const HEALTH_PATH = path.join(DATA_DIR, '.health.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const REPORT_BASE = path.join(__dirname, '..', config.daily_summary.report_dir || 'reports');
const DAILY_DIR = path.join(REPORT_BASE, 'daily');

const DRY_RUN = !!process.env.LLM_DRY_RUN;
const NO_NOTIFY = !!process.env.NO_NOTIFY;

fs.mkdirSync(DAILY_DIR, { recursive: true });

// ---------- 读取今日推文 ----------

function todayCutoff() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function loadTodayTweets() {
  const cutoff = todayCutoff();
  const groups = [];
  for (const target of config.targets) {
    const file = path.join(DATA_DIR, `${target.handle}.json`);
    if (!fs.existsSync(file)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { continue; }
    const todayTweets = (data.tweets || []).filter(t =>
      t.time && new Date(t.time).getTime() >= cutoff,
    );
    if (todayTweets.length > 0) groups.push({ target, tweets: todayTweets });
  }
  return groups;
}

// ---------- 补 enrich（兜底）----------

async function backfillEnrich(groups) {
  for (const g of groups) {
    for (const t of g.tweets) {
      if (t.llm_insight) continue;
      console.log(`  💭 补 enrich [${g.target.handle}] ${t.url}`);
      t.llm_insight = await insights.extractTweetInsight(t, g.target, { dry_run: DRY_RUN });
      // 写回 data/{handle}.json，下次不再调
      writeBackInsight(g.target.handle, t);
    }
  }
}

function writeBackInsight(handle, tweet) {
  const file = path.join(DATA_DIR, `${handle}.json`);
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = (data.tweets || []).find(x => x.url === tweet.url);
  if (t) {
    t.llm_insight = tweet.llm_insight;
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
}

// ---------- 飞书摘要（短版） ----------

function buildFeishuSummary(date, groups) {
  const allInsights = [];
  for (const g of groups) {
    for (const t of g.tweets) {
      if (t.llm_insight?.skip) continue;
      allInsights.push({ name: g.target.name, handle: g.target.handle, tweet: t });
    }
  }
  // 按 novelty 排
  allInsights.sort((a, b) =>
    (b.tweet.llm_insight?.novelty ?? 0) - (a.tweet.llm_insight?.novelty ?? 0),
  );

  let msg = `📊 **AI 大佬日报** | ${date}\n`;
  msg += `监控 ${config.targets.length} 人 | 今日 ${groups.reduce((s, g) => s + g.tweets.length, 0)} 条推文\n\n`;

  if (allInsights.length === 0) {
    msg += '今日无高信号推文（或全部被判定为低价值）。';
    return msg;
  }

  msg += '🔥 **今日核心信号 Top 5**:\n';
  for (const item of allInsights.slice(0, 5)) {
    const ins = item.tweet.llm_insight;
    msg += `• [${item.name}] ${ins.one_liner} `;
    msg += `(novelty:${ins.novelty}) [→](${item.tweet.url})\n`;
  }
  msg += '\n📄 详细日报已写入 reports/daily/';
  return msg;
}

// ---------- 抓取链路健康检查 ----------

// ponytail: 只看 monitor.js 最近一次运行是否发生在今天且全员失败（未登录/CDP 未连接）。
// 不追溯更早的失败历史，也不区分"部分失败"——那种情况仍按"今日无新推文"处理。
function pipelineDownToday() {
  try {
    const h = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8'));
    const sameDay = new Date(h.time).toDateString() === new Date().toDateString();
    return sameDay && h.total > 0 && h.success === 0;
  } catch { return false; }
}

// ---------- 主流程 ----------

async function main() {
  const banner = DRY_RUN ? '📊 生成每日汇总 (DRY-RUN)' : '📊 生成每日汇总';
  console.log(`${banner} | ${new Date().toLocaleString('zh-CN')}`);

  const groups = loadTodayTweets();
  if (groups.length === 0) {
    console.log('今日无推文数据');
    if (!NO_NOTIFY) {
      const msg = pipelineDownToday()
        ? '⚠️ AI 大佬日报：今日抓取链路异常（Chrome 未登录 / CDP 未连接），并非真的无新推文。请检查 `./scripts/start-cdp-proxy.sh status` 和 Chrome 登录状态。'
        : '📊 AI 大佬日报：今日暂无新推文数据';
      await notify.send(msg, 'AI 日报');
    }
    return;
  }

  console.log(`找到 ${groups.length} 位大佬的推文数据`);
  await backfillEnrich(groups);

  const date = new Date().toISOString().split('T')[0];
  const totalTweets = groups.reduce((s, g) => s + g.tweets.length, 0);
  console.log(`🤖 调用 LLM 生成结构化日报（共 ${totalTweets} 条推文）...`);

  let report;
  try {
    report = await insights.aggregateDailyInsights(groups, date, { dry_run: DRY_RUN });
  } catch (e) {
    console.error('日报生成失败：', e.message);
    process.exit(1);
  }

  const reportPath = path.join(DAILY_DIR, `${date}.md`);
  fs.writeFileSync(reportPath, report);
  console.log(`✅ 日报已保存: ${reportPath}`);

  // 飞书简短摘要
  const summary = buildFeishuSummary(date, groups);
  if (!NO_NOTIFY) {
    await notify.send(summary, 'AI 大佬日报');
    console.log('✅ 飞书通知已发送');
  } else {
    console.log('\n--- 飞书摘要预览（NO_NOTIFY=1）---\n' + summary);
    console.log('\n--- 日报全文预览 ---\n' + report.slice(0, 800) + '...');
  }
}

if (require.main === module) {
  main().catch(console.error);
} else {
  module.exports = { loadTodayTweets, buildFeishuSummary, pipelineDownToday };
}
