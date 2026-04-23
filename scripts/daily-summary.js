#!/usr/bin/env node

/**
 * 每日 AI 洞见汇总报告
 * 从 data/ 读取当天推文，生成模板化 Markdown 报告并推送飞书
 */

const fs = require('fs');
const path = require('path');
const notify = require('./notify');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DATA_DIR = path.join(__dirname, '..', 'data');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const REPORT_DIR = path.join(__dirname, '..', config.daily_summary.report_dir || 'reports');

fs.mkdirSync(REPORT_DIR, { recursive: true });

function loadTodayTweets() {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const results = [];

  for (const target of config.targets) {
    const file = path.join(DATA_DIR, `${target.handle}.json`);
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const todayTweets = (data.tweets || []).filter(t => {
      if (!t.time) return false;
      return new Date(t.time).getTime() >= cutoff;
    });
    if (todayTweets.length > 0) {
      results.push({ target, tweets: todayTweets, lastChecked: data.lastChecked });
    }
  }
  return results;
}

function scoreTweet(tweet, keywords) {
  const text = tweet.text.toLowerCase();
  let score = 0;
  keywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 10; });
  const total = ((tweet.engagement && tweet.engagement.likes) || 0) + ((tweet.engagement && tweet.engagement.retweets) || 0) + ((tweet.engagement && tweet.engagement.replies) || 0);
  if (total > 1000) score += 15;
  else if (total > 500) score += 10;
  else if (total > 100) score += 5;
  if (tweet.text.length > 200) score += 2;
  return { score, totalEngagement: total };
}

function extractTopics(allTweets) {
  const freq = {};
  const topicKeywords = ['AI', 'LLM', 'GPT', 'AGI', 'transformer', 'robotics', 'agent', 'safety',
    'open source', 'reasoning', 'multimodal', 'diffusion', 'RL', 'RLHF', 'scaling',
    'foundation model', 'fine-tuning', 'RAG', 'inference', 'training', 'benchmark'];
  for (const tweet of allTweets) {
    const text = tweet.text.toLowerCase();
    for (const kw of topicKeywords) {
      if (text.includes(kw.toLowerCase())) freq[kw] = (freq[kw] || 0) + 1;
    }
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function generateReport(data) {
  const date = new Date().toISOString().split('T')[0];
  const topN = config.daily_summary.top_n_per_user || 3;

  // 收集所有推文用于话题分析
  const allTweets = data.flatMap(d => d.tweets);
  const topics = extractTopics(allTweets);

  // 收集所有推文并排序，取全局 Top 5
  const allScored = [];
  for (const { target, tweets } of data) {
    for (const t of tweets) {
      const { score, totalEngagement } = scoreTweet(t, target.keywords);
      allScored.push({ ...t, _name: target.name, _handle: target.handle, _score: score, _eng: totalEngagement });
    }
  }
  allScored.sort((a, b) => b._score - a._score || b._eng - a._eng);
  const globalTop = allScored.slice(0, 5);

  let md = `# 🤖 AI 大佬每日洞见 | ${date}\n\n`;
  md += `> 监控 ${config.targets.length} 位 AI 大佬 | 今日捕获 ${allTweets.length} 条推文\n\n`;

  // 热门话题
  if (topics.length > 0) {
    md += `## 📈 今日热门话题\n\n`;
    md += topics.map(([kw, cnt]) => `- **${kw}** (${cnt} 次提及)`).join('\n');
    md += '\n\n';
  }

  // 全局 Top 推文
  if (globalTop.length > 0) {
    md += `## 🔥 今日最重要推文\n\n`;
    for (const t of globalTop) {
      const hot = t._eng > 1000 ? ' 🔥' : '';
      md += `### ${t._name}${hot}\n`;
      md += `> ${t.text.substring(0, 300)}${t.text.length > 300 ? '...' : ''}\n\n`;
      md += `👍${t.engagement.likes} 🔄${t.engagement.retweets} 💬${t.engagement.replies} | ⭐${t._score}分 | [原文](${t.url})\n\n`;
    }
  }

  // 按人物分组
  md += `## 👥 各大佬动态\n\n`;
  for (const { target, tweets } of data) {
    const scored = tweets.map(t => {
      const { score, totalEngagement } = scoreTweet(t, target.keywords);
      return { ...t, _score: score, _eng: totalEngagement };
    }).sort((a, b) => b._score - a._score);

    const top = scored.slice(0, topN);
    md += `### ${target.name} (@${target.handle}) — ${tweets.length} 条\n\n`;
    for (const t of top) {
      const time = t.time ? new Date(t.time).toLocaleString('zh-CN') : '';
      md += `- **[${time}]** ${t.text.substring(0, 150)}${t.text.length > 150 ? '...' : ''} 👍${t.engagement.likes} [→](${t.url})\n`;
    }
    md += '\n';
  }

  // 无数据的大佬
  const activeHandles = new Set(data.map(d => d.target.handle));
  const inactive = config.targets.filter(t => !activeHandles.has(t.handle));
  if (inactive.length > 0) {
    md += `### 今日无更新\n\n`;
    md += inactive.map(t => `- ${t.name} (@${t.handle})`).join('\n');
    md += '\n\n';
  }

  md += `---\n*生成时间: ${new Date().toLocaleString('zh-CN')}*\n`;
  return md;
}

function generateFeishuSummary(data) {
  const allTweets = data.flatMap(d => d.tweets);
  const allScored = [];
  for (const { target, tweets } of data) {
    for (const t of tweets) {
      const { score, totalEngagement } = scoreTweet(t, target.keywords);
      allScored.push({ ...t, _name: target.name, _score: score, _eng: totalEngagement });
    }
  }
  allScored.sort((a, b) => b._score - a._score);
  const top3 = allScored.slice(0, 3);

  let msg = `📊 **AI 大佬日报** | ${new Date().toISOString().split('T')[0]}\n`;
  msg += `监控 ${config.targets.length} 人 | 今日 ${allTweets.length} 条推文\n\n`;

  if (top3.length > 0) {
    msg += `🔥 **Top 推文:**\n`;
    for (const t of top3) {
      msg += `• ${t._name}: ${t.text.substring(0, 100)}... 👍${t.engagement.likes}\n`;
    }
  } else {
    msg += '今日暂无新推文';
  }
  return msg;
}

async function main() {
  console.log(`📊 生成每日汇总 | ${new Date().toLocaleString('zh-CN')}`);

  const data = loadTodayTweets();
  if (data.length === 0) {
    console.log('今日无推文数据');
    await notify.send('📊 AI 大佬日报：今日暂无新推文数据', 'AI 日报');
    return;
  }

  console.log(`找到 ${data.length} 位大佬的推文数据`);

  // 生成 Markdown 报告
  const report = generateReport(data);
  const date = new Date().toISOString().split('T')[0];
  const reportPath = path.join(REPORT_DIR, `${date}.md`);
  fs.writeFileSync(reportPath, report);
  console.log(`✅ 报告已保存: ${reportPath}`);

  // 推送飞书摘要
  const summary = generateFeishuSummary(data);
  await notify.send(summary, 'AI 大佬日报');

  console.log('✅ 飞书通知已发送');
}

main().catch(console.error);
