#!/usr/bin/env node

/**
 * Twitter AI 大佬监控脚本（LLM-enriched 版本）
 *
 * 流程：
 *   1. 通过 CDP Proxy 抓取每个目标的最新推文
 *   2. 找到新推文（按 url 去重）
 *   3. 逐条调用 MiniMax LLM 抽取结构化洞察（one_liner / why_matters / tags / novelty / skip）
 *   4. 写入 data/{handle}.json 持久化（含 llm_insight 缓存）
 *   5. 构造飞书消息（按 novelty 排序，skip=true 的不展示）
 *
 * 环境变量：
 *   LLM_DRY_RUN=1  使用 mock LLM 输出，不消耗 token（用于测试）
 *   NO_NOTIFY=1    不推送飞书（用于本地调试）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const notify = require('./notify');
const insights = require('./insights');

const PROXY_HOST = 'localhost';
const PROXY_PORT = 3456;
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DATA_DIR = path.join(__dirname, '..', 'data');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const DRY_RUN = !!process.env.LLM_DRY_RUN;
const NO_NOTIFY = !!process.env.NO_NOTIFY;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- CDP Proxy ----------

function proxyRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request(`http://${PROXY_HOST}:${PROXY_PORT}${endpoint}`, {
      method,
      headers: bodyStr ? { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(bodyStr) } : {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------- 数据持久化 ----------

function loadHistory(handle) {
  const file = path.join(DATA_DIR, `${handle}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return { tweets: [], lastChecked: null };
}

function saveHistory(handle, data) {
  const file = path.join(DATA_DIR, `${handle}.json`);
  const cutoff7d = Date.now() - config.storage.tweet_history_days * 86400000;
  const cutoff14d = Date.now() - 14 * 86400000;
  data.tweets = data.tweets.filter(t => {
    if (!t.time) return true; // 无时间戳的保留
    const ts = new Date(t.time).getTime();
    // 有 llm_insight 的推文保留 14 天（给日报/周报消费）
    if (t.llm_insight) return ts > cutoff14d;
    // 无 insight 的保留 7 天
    return ts > cutoff7d;
  });
  data.lastChecked = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- 抓取 ----------

async function extractTweets(targetId, maxTweets) {
  const script = `
    (function() {
      const tweets = [];
      const els = document.querySelectorAll('[data-testid="tweet"]');
      for (let i = 0; i < Math.min(${maxTweets}, els.length); i++) {
        const el = els[i];
        const textEl = el.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText.trim() : '';
        const timeEl = el.querySelector('time');
        const time = timeEl ? timeEl.getAttribute('datetime') : '';
        const linkEl = el.querySelector('a[href*="/status/"]');
        const url = linkEl ? linkEl.href : '';
        const get = id => { const e = el.querySelector('[data-testid="'+id+'"]'); return e ? (e.textContent||'0') : '0'; };
        function parse(s) { const m=s.match(/([\\.\\d]+)([KMB]?)/); if(!m)return 0; const n=parseFloat(m[1]),x=m[2]; return Math.round(x==='K'?n*1e3:x==='M'?n*1e6:x==='B'?n*1e9:n); }
        if (text && url) tweets.push({ text: text.substring(0,500), time, url, engagement: { likes: parse(get('like')), retweets: parse(get('retweet')), replies: parse(get('reply')) }});
      }
      return JSON.stringify(tweets);
    })()
  `;
  const result = await proxyRequest(`/eval?target=${targetId}`, 'POST', script);
  return JSON.parse(result.value);
}

// ---------- LLM 富化 ----------

/**
 * 给一组新推文逐条调用 LLM 提洞察（串行，避免触发 rate limit）
 * 失败的推文会回退到 fallback insight，不会让流程挂掉
 */
async function enrichTweetsWithLLM(tweets, target) {
  for (let i = 0; i < tweets.length; i++) {
    const t = tweets[i];
    if (t.llm_insight) continue;  // 已有缓存（理论上不会，但保险）
    process.stdout.write(`  💭 LLM ${i + 1}/${tweets.length}... `);
    const t0 = Date.now();
    t.llm_insight = await insights.extractTweetInsight(t, target, { dry_run: DRY_RUN });
    const ms = Date.now() - t0;
    const flag = t.llm_insight._fallback ? '降级' : (t.llm_insight.skip ? 'skip' : 'ok');
    console.log(`${flag} (${ms}ms) novelty=${t.llm_insight.novelty}`);
    // 串行 + 小延迟，对 rate limit 友好
    if (!DRY_RUN && i < tweets.length - 1) await sleep(300);
  }
}

// ---------- 监控单个目标 ----------

async function monitorTarget(target) {
  console.log(`\n🔍 ${target.name} (@${target.handle})`);
  let targetId = null;
  try {
    targetId = (await proxyRequest(`/new?url=${encodeURIComponent(target.url)}`)).targetId;
    await sleep(3000);

    const loginCheck = await proxyRequest(`/eval?target=${targetId}`, 'POST',
      'document.querySelector("[data-testid=\\"SideNav_AccountSwitcher_Button\\"]") !== null ? "ok" : "no"');
    if (loginCheck.value !== 'ok' && loginCheck.value !== true) {
      console.log('  ❌ 未登录');
      await proxyRequest(`/close?target=${targetId}`);
      return { success: false, newTweets: [] };
    }

    for (let i = 0; i < 3; i++) {
      await proxyRequest(`/scroll?target=${targetId}&direction=bottom`);
      await sleep(1500);
    }

    const tweets = await extractTweets(targetId, config.monitoring.max_tweets_per_check);
    console.log(`  📊 ${tweets.length} 条推文`);

    const history = loadHistory(target.handle);
    const historyUrls = new Set(history.tweets.map(t => t.url));
    const newTweets = tweets.filter(t => !historyUrls.has(t.url));

    if (newTweets.length > 0) {
      console.log(`  ✨ ${newTweets.length} 条新推文`);
      // LLM enrich：逐条提洞察
      await enrichTweetsWithLLM(newTweets, target);
      // 持久化（含 llm_insight 缓存，下次不再重复调）
      history.tweets = [...newTweets, ...history.tweets];
      saveHistory(target.handle, history);
    } else {
      console.log('  ✅ 无新推文');
    }

    await proxyRequest(`/close?target=${targetId}`);
    return { success: true, name: target.name, handle: target.handle, newTweets };
  } catch (error) {
    console.error(`  ❌ ${error.message}`);
    if (targetId) try { await proxyRequest(`/close?target=${targetId}`); } catch {}
    return { success: false, newTweets: [] };
  }
}

// ---------- 飞书消息构造（基于 LLM 洞察） ----------

function getHeatIcon(engagement) {
  const total = (engagement.likes || 0) + (engagement.retweets || 0) + (engagement.replies || 0);
  if (total > 10000) return '🔥🔥🔥';
  if (total > 5000) return '🔥🔥';
  if (total > 1000) return '🔥';
  if (total > 500) return '✨';
  return '';
}

function formatEngagement(eng) {
  function fmt(n) {
    n = n || 0;
    if (n >= 10000) return (n / 1000).toFixed(0) + 'K';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  return '👍' + fmt(eng.likes) + ' 🔄' + fmt(eng.retweets) + ' 💬' + fmt(eng.replies);
}

/**
 * 综合排序分：novelty 是核心，互动量作补充
 * novelty 0-10 ⇒ 100 分；互动量 log 缩放后做加成
 */
function scoreInsight(t) {
  const eng = t.engagement || {};
  const total = (eng.likes || 0) + (eng.retweets || 0) + (eng.replies || 0);
  const noveltyScore = (t.llm_insight?.novelty ?? 3) * 10;
  const engScore = total > 0 ? Math.min(30, Math.log10(total + 1) * 8) : 0;
  return noveltyScore + engScore;
}

function buildSummaryMessage(results) {
  const withUpdates = results.filter(r => (r.newTweets || []).length > 0);
  if (withUpdates.length === 0) return null;

  // 全局过滤：丢掉 skip=true 的
  let totalNew = 0;
  let totalShown = 0;
  for (const r of withUpdates) {
    totalNew += r.newTweets.length;
    r._displayTweets = r.newTweets.filter(t => !t.llm_insight?.skip);
    totalShown += r._displayTweets.length;
  }

  // 如果所有推文都被 skip 了，仍然推一条简短通知（让用户知道系统在跑）
  if (totalShown === 0) {
    return `📡 **AI 大佬动态速递** | ${new Date().toLocaleString('zh-CN')}\n\n` +
           `> ${withUpdates.length} 人共更新 ${totalNew} 条，但均被判断为低信号（个人/吃瓜/广告等），不展开。`;
  }

  // 按"最高 novelty"对人物排序，让信号强的人排在前面
  withUpdates.sort((a, b) => {
    const ma = Math.max(...a._displayTweets.map(t => t.llm_insight?.novelty ?? 0), 0);
    const mb = Math.max(...b._displayTweets.map(t => t.llm_insight?.novelty ?? 0), 0);
    return mb - ma;
  });

  let msg = `📡 **AI 大佬动态速递** | ${new Date().toLocaleString('zh-CN')}\n`;
  msg += `> ${withUpdates.length} 人更新 / 共 ${totalNew} 条 / 展示 ${totalShown} 条高信号\n\n`;

  for (const r of withUpdates) {
    if (r._displayTweets.length === 0) continue;

    // 该人物推文按综合分降序
    const sorted = r._displayTweets.slice().sort((a, b) => scoreInsight(b) - scoreInsight(a));

    // 该人物的 tags（去重，取 LLM 输出）
    const tagSet = new Set();
    for (const t of sorted) {
      for (const tag of (t.llm_insight?.tags || [])) tagSet.add(tag);
    }
    const tagStr = [...tagSet].slice(0, 5).join(' ');

    const heat = getHeatIcon(sorted[0].engagement);
    msg += `${heat}${heat ? ' ' : ''}**${r.name}** (@${r.handle}) — ${sorted.length} 条新推文\n`;
    if (tagStr) msg += tagStr + '\n';

    // 展示 top 3
    const showCount = Math.min(3, sorted.length);
    for (let j = 0; j < showCount; j++) {
      const t = sorted[j];
      const ins = t.llm_insight || {};
      const heat2 = getHeatIcon(t.engagement);
      const novelty = ins.novelty ?? '?';

      msg += `→ **${ins.one_liner || '(无摘要)'}** ${heat2 ? heat2 + ' ' : ''}[novelty:${novelty}]\n`;
      if (ins.why_matters && ins.why_matters !== '无明确行业信号') {
        msg += `  💡 ${ins.why_matters}\n`;
      }
      msg += `  ${formatEngagement(t.engagement)} [原文](${t.url})\n`;
    }

    if (sorted.length > showCount) {
      msg += `  ...另有 ${sorted.length - showCount} 条\n`;
    }
    msg += '\n';
  }

  return msg;
}

// ---------- 主流程 ----------

async function main() {
  const banner = DRY_RUN ? '🎯 Twitter AI 监控 (DRY-RUN 模式)' : '🎯 Twitter AI 监控';
  console.log(`${banner} | ${new Date().toLocaleString('zh-CN')}`);

  const results = [];
  for (const target of config.targets) {
    results.push(await monitorTarget(target));
    await sleep(2000);
  }

  const ok = results.filter(r => r.success).length;
  const totalNew = results.reduce((s, r) => s + (r.newTweets || []).length, 0);
  console.log(`\n📋 完成: ${ok}/${results.length} 成功, ${totalNew} 条新推文`);

  const msg = buildSummaryMessage(results);
  if (msg && !NO_NOTIFY) {
    await notify.send(msg, 'AI 大佬动态更新');
    console.log('✅ 飞书汇总通知已发送');
  } else if (msg && NO_NOTIFY) {
    console.log('\n--- 飞书消息预览（NO_NOTIFY=1，未发送）---\n' + msg);
  } else {
    console.log('ℹ️ 无新动态，不推送');
  }
}

// 仅在直接运行时启动 main；被 require 时仅暴露内部函数便于测试
if (require.main === module) {
  main().catch(console.error);
} else {
  module.exports = { buildSummaryMessage, scoreInsight, getHeatIcon, formatEngagement, enrichTweetsWithLLM };
}
