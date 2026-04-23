#!/usr/bin/env node

/**
 * Twitter AI 大佬监控脚本
 * 每12小时运行一次，抓取所有目标的新推文，汇总为一条飞书消息推送
 * 无新动态则不推送
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const notify = require('./notify');

const PROXY_HOST = 'localhost';
const PROXY_PORT = 3456;
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DATA_DIR = path.join(__dirname, '..', 'data');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function loadHistory(handle) {
  const file = path.join(DATA_DIR, `${handle}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return { tweets: [], lastChecked: null };
}

function saveHistory(handle, data) {
  const file = path.join(DATA_DIR, `${handle}.json`);
  const cutoff = Date.now() - config.storage.tweet_history_days * 86400000;
  data.tweets = data.tweets.filter(t => !t.time || new Date(t.time).getTime() > cutoff);
  data.lastChecked = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

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

function analyzeImportance(tweet, keywords) {
  const text = tweet.text.toLowerCase();
  let score = 0;
  keywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 10; });
  const total = tweet.engagement.likes + tweet.engagement.retweets + tweet.engagement.replies;
  if (total > 1000) score += 15;
  else if (total > 500) score += 10;
  else if (total > 100) score += 5;
  if (tweet.text.length > 200) score += 2;
  return { score, totalEngagement: total };
}

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
      for (const t of newTweets) t._analysis = analyzeImportance(t, target.keywords);
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

// --- 话题标签与摘要 ---

const TOPIC_MAP = [
  // [匹配词(小写), 显示标签]
  ['chatgpt', '#ChatGPT'], ['gpt-4', '#GPT4'], ['gpt-5', '#GPT5'], ['gpt', '#GPT'],
  ['openai', '#OpenAI'], ['claude', '#Claude'], ['gemini', '#Gemini'], ['llama', '#LLaMA'],
  ['deepseek', '#DeepSeek'], ['mistral', '#Mistral'], ['grok', '#Grok'],
  ['llm', '#LLM'], ['transformer', '#Transformer'], ['diffusion', '#Diffusion'],
  ['agi', '#AGI'], ['superintelligence', '#超级智能'], ['alignment', '#AI对齐'],
  ['safety', '#AI安全'], ['regulation', '#AI监管'],
  ['agent', '#AI智能体'], ['mcp', '#MCP'], ['rag', '#RAG'], ['fine-tun', '#微调'],
  ['multimodal', '#多模态'], ['vision', '#视觉'], ['image', '#图像生成'],
  ['robot', '#机器人'], ['embodied', '#具身智能'],
  ['open source', '#开源'], ['open-source', '#开源'], ['opensource', '#开源'],
  ['benchmark', '#评测'], ['scaling', '#Scaling'], ['reasoning', '#推理'],
  ['training', '#训练'], ['inference', '#推理优化'],
  ['deep research', '#DeepResearch'], ['alphafold', '#AlphaFold'],
  ['foundation model', '#基础模型'], ['neural', '#神经网络'],
  ['reinforcement', '#强化学习'], ['rlhf', '#RLHF'],
  ['launch', '#发布'], ['releasing', '#发布'], ['announcing', '#发布'], ['introducing', '#发布'],
  ['paper', '#论文'], ['research', '#研究'],
];

function extractTopicTags(text) {
  const lower = text.toLowerCase();
  const tags = [];
  const seen = new Set();
  for (const [kw, tag] of TOPIC_MAP) {
    if (lower.includes(kw) && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags.slice(0, 4);
}

function getHeatIcon(engagement) {
  const total = engagement.likes + engagement.retweets + engagement.replies;
  if (total > 10000) return '🔥🔥🔥';
  if (total > 5000) return '🔥🔥';
  if (total > 1000) return '🔥';
  if (total > 500) return '✨';
  return '';
}

function summarizeTweet(text) {
  // 取第一句作为核心摘要
  let summary = text.replace(/https?:\/\/\S+/g, '').trim();
  // 按句号、换行、感叹号分割取第一句
  const first = summary.split(/[.\n!?。！？]/)[0].trim();
  if (first.length > 10 && first.length < 200) summary = first;
  if (summary.length > 120) summary = summary.substring(0, 120) + '...';
  return summary;
}

function formatEngagement(eng) {
  function fmt(n) {
    if (n >= 10000) return (n / 1000).toFixed(0) + 'K';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  return '👍' + fmt(eng.likes) + ' 🔄' + fmt(eng.retweets) + ' 💬' + fmt(eng.replies);
}

function buildSummaryMessage(results) {
  var withUpdates = results.filter(function(r) { return r.newTweets.length > 0; });
  if (withUpdates.length === 0) return null;

  var totalNew = withUpdates.reduce(function(s, r) { return s + r.newTweets.length; }, 0);
  var msg = '📡 **AI 大佬动态速递** | ' + new Date().toLocaleString('zh-CN') + '\n';
  msg += '> ' + withUpdates.length + ' 人更新，共 ' + totalNew + ' 条新推文\n\n';

  for (var i = 0; i < withUpdates.length; i++) {
    var r = withUpdates[i];
    // 按重要性排序
    var sorted = r.newTweets.slice().sort(function(a, b) {
      var sa = (a._analysis && a._analysis.score) || 0;
      var sb = (b._analysis && b._analysis.score) || 0;
      return sb - sa;
    });

    // 收集所有推文的话题标签
    var allTags = [];
    var tagSeen = {};
    for (var j = 0; j < sorted.length; j++) {
      var tags = extractTopicTags(sorted[j].text);
      for (var k = 0; k < tags.length; k++) {
        if (!tagSeen[tags[k]]) { tagSeen[tags[k]] = true; allTags.push(tags[k]); }
      }
    }
    var tagStr = allTags.slice(0, 5).join(' ');

    var heat = getHeatIcon(sorted[0].engagement);
    msg += heat + (heat ? ' ' : '') + '**' + r.name + '** (@' + r.handle + ') — ' + r.newTweets.length + ' 条新推文\n';
    if (tagStr) msg += tagStr + '\n';

    // 展示 top 3 推文摘要
    var showCount = Math.min(3, sorted.length);
    for (var j = 0; j < showCount; j++) {
      var t = sorted[j];
      var summary = summarizeTweet(t.text);
      var heat2 = getHeatIcon(t.engagement);
      msg += '→ ' + summary + (heat2 ? ' ' + heat2 : '') + '\n';
      msg += '   ' + formatEngagement(t.engagement) + ' [原文](' + t.url + ')\n';
    }
    msg += '\n';
  }

  return msg;
}

async function main() {
  console.log(`🎯 Twitter AI 监控 | ${new Date().toLocaleString('zh-CN')}`);

  const results = [];
  for (const target of config.targets) {
    results.push(await monitorTarget(target));
    await sleep(2000);
  }

  const ok = results.filter(r => r.success).length;
  const totalNew = results.reduce((s, r) => s + r.newTweets.length, 0);
  console.log(`\n📋 完成: ${ok}/${results.length} 成功, ${totalNew} 条新推文`);

  const msg = buildSummaryMessage(results);
  if (msg) {
    await notify.send(msg, 'AI 大佬动态更新');
    console.log('✅ 飞书汇总通知已发送');
  } else {
    console.log('ℹ️ 无新动态，不推送');
  }
}

main().catch(console.error);
