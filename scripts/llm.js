#!/usr/bin/env node

/**
 * MiniMax LLM 客户端（Anthropic 兼容接口 — Token Plan Key）
 *
 * Token Plan Key (sk-cp-*) 必须走 Anthropic 兼容端点：
 *   POST https://api.minimaxi.com/anthropic/v1/messages
 *   Header: x-api-key / anthropic-version
 *
 * 设计要点：
 *  - 密钥按 env > ~/.config/twitter-monitor/.env > <project>/.env 顺序加载
 *  - 自动从 content[] 中提取 thinking 块和 text 块
 *  - JSON 模式带容错：先正则提取 ```json``` 代码块，失败再尝试整段 JSON.parse
 *  - 3 次指数退避重试；429/余额/认证不重试
 *  - 用量写到 logs/llm.log
 *  - dry_run 模式：不真的调 API
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ---------- 密钥与配置加载 ----------

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function loadEnv() {
  if (process.env.MINIMAX_API_KEY) return { ...process.env };
  const candidates = [
    path.join(process.env.HOME || '/root', '.config', 'twitter-monitor', '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const p of candidates) {
    const env = parseDotEnv(p);
    if (env.MINIMAX_API_KEY) return { ...process.env, ...env };
  }
  return { ...process.env };
}

const ENV = loadEnv();

const DEFAULTS = {
  base_url: ENV.MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic/v1',
  model_quality: 'MiniMax-M2.7',
  model_fast: 'MiniMax-M2.7',  // highspeed 在高峰期受限，默认用 M2.7
  timeout_ms: 60000,
  max_retries: 3,
  temperature: 0.3,
  max_tokens: 1024,
};

function getConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    return { ...DEFAULTS, ...(cfg.llm || {}) };
  } catch { return DEFAULTS; }
}

// ---------- 用量日志 ----------

const LOG_PATH = path.join(__dirname, '..', 'logs', 'llm.log');
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

function logUsage(record) {
  fs.appendFileSync(LOG_PATH, JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
}

// ---------- HTTP ----------

function postJSON(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- 输出清洗 ----------

/**
 * 从 Anthropic 格式的 content[] 中提取 text 块（跳过 thinking 块）
 */
function extractTextFromContent(content) {
  if (!Array.isArray(content)) return String(content || '');
  const textBlocks = content.filter(b => b.type === 'text').map(b => b.text);
  return textBlocks.join('\n').trim();
}

/**
 * 剥离 <think>...</think>（兼容旧格式 / 非 Anthropic 端点）
 */
function stripThink(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

/**
 * 容错 JSON 提取
 */
function extractJSON(text) {
  const cleaned = stripThink(text);
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());
  const brace = cleaned.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  candidates.push(cleaned);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch {}
  }
  throw new Error('failed to parse JSON from LLM response: ' + cleaned.slice(0, 200));
}

// ---------- 主调用 ----------

/**
 * @param {Array} messages [{role, content}]
 * @param {Object} opts {model, temperature, max_tokens, system, dry_run, mock}
 */
async function chat(messages, opts = {}) {
  const cfg = getConfig();
  const model = opts.model || cfg.model_fast;
  const apiKey = ENV.MINIMAX_API_KEY;

  if (opts.dry_run) {
    const mock = typeof opts.mock === 'function' ? opts.mock(messages) : (opts.mock || '{"mock": true}');
    return { text: mock, usage: { dry_run: true }, raw: null };
  }

  if (!apiKey) throw new Error('MINIMAX_API_KEY 未配置');

  // 构造 Anthropic Messages API body
  // 提取 system message（如果有）
  let systemPrompt = '';
  const apiMessages = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + m.content;
    } else {
      apiMessages.push({ role: m.role, content: m.content });
    }
  }

  const body = {
    model,
    max_tokens: opts.max_tokens ?? opts.max_completion_tokens ?? cfg.max_tokens,
    messages: apiMessages,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(opts.temperature != null ? { temperature: opts.temperature } : { temperature: cfg.temperature }),
  };

  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  let lastErr = null;
  const maxRetries = opts.max_retries ?? cfg.max_retries;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const t0 = Date.now();
    const timeoutForAttempt = attempt === 0
      ? (opts.timeout_ms ?? cfg.timeout_ms)
      : Math.floor((opts.timeout_ms ?? cfg.timeout_ms) / 2); // 重试时超时减半
    try {
      const url = cfg.base_url.replace(/\/$/, '') + '/messages';
      const resp = await postJSON(url, headers, body, timeoutForAttempt);

      // 认证错误
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`auth error ${resp.status}: ${resp.raw?.slice(0, 200)}`);
      }

      // 限流 / 余额
      if (resp.status === 429 || resp.body?.error?.type === 'rate_limit_error') {
        const msg = resp.body?.error?.message || resp.raw?.slice(0, 300) || '';
        const resetMatch = msg.match(/resets at ([\dT:+\-.]+)/);
        const err = new Error(`MiniMax 配额受限：${msg.slice(0, 200)}`);
        err.code = 'RATE_LIMITED';
        err.resets_at = resetMatch ? resetMatch[1] : null;
        throw err;
      }
      if (resp.body?.base_resp?.status_code === 1008) {
        const err = new Error('MiniMax 余额不足 (1008)');
        err.code = 'INSUFFICIENT_BALANCE';
        throw err;
      }

      // 其它错误
      if (resp.body?.type === 'error') {
        throw new Error(`API error: ${resp.body?.error?.message || resp.raw?.slice(0, 200)}`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`HTTP ${resp.status}: ${resp.raw?.slice(0, 200)}`);
      }

      // 成功：从 content[] 提取 text
      const text = extractTextFromContent(resp.body?.content);
      const usage = resp.body?.usage || {};
      logUsage({
        model, attempt, ms: Date.now() - t0,
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
      });
      return { text, usage, raw: resp.body };
    } catch (e) {
      lastErr = e;
      if (e.code === 'INSUFFICIENT_BALANCE' || e.code === 'RATE_LIMITED' || /auth error/.test(e.message)) {
        logUsage({ model, attempt, error: e.message, code: e.code, fatal: true });
        throw e;
      }
      // 超时错误最多重试 1 次（避免 60s × 3 = 180s 浪费）
      const isTimeout = /timeout/i.test(e.message);
      const maxForThis = isTimeout ? Math.min(maxRetries, 2) : maxRetries;
      logUsage({ model, attempt, error: e.message, ms: Date.now() - t0 });
      if (attempt < maxForThis - 1) await sleep(1000 * Math.pow(2, attempt));
      else break;
    }
  }
  throw lastErr || new Error('LLM 调用失败');
}

/**
 * 调用 LLM 并解析 JSON 输出
 */
async function completeJSON(systemPrompt, userPrompt, opts = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const result = await chat(messages, { ...opts, max_tokens: opts.max_tokens ?? opts.max_completion_tokens ?? 800 });
  try {
    return { json: extractJSON(result.text), usage: result.usage, text: result.text };
  } catch (e) {
    if (!opts._retried) {
      const fixMessages = [
        ...messages,
        { role: 'assistant', content: result.text },
        { role: 'user', content: '上一条回复无法解析为 JSON。请只输出符合要求的 JSON，不要任何额外文字。' },
      ];
      const fixed = await chat(fixMessages, { ...opts, _retried: true });
      return { json: extractJSON(fixed.text), usage: fixed.usage, text: fixed.text };
    }
    throw e;
  }
}

/**
 * 调用 LLM 返回纯文本
 */
async function completeText(systemPrompt, userPrompt, opts = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const result = await chat(messages, { max_tokens: 2048, ...opts });
  return { text: result.text, usage: result.usage };
}

// ---------- 健康检查 ----------

async function ping() {
  if (!ENV.MINIMAX_API_KEY) return { ok: false, reason: 'no_api_key' };
  try {
    const result = await chat(
      [{ role: 'user', content: '回复一个字：好' }],
      { max_tokens: 256, max_retries: 1, timeout_ms: 30000 },
    );
    return { ok: true, model: 'default', text: result.text.slice(0, 40), usage: result.usage };
  } catch (e) {
    return { ok: false, reason: e.message, code: e.code, resets_at: e.resets_at || null };
  }
}

module.exports = { chat, completeJSON, completeText, extractJSON, stripThink, ping, getConfig };

if (require.main === module) {
  ping().then(r => {
    console.log('LLM 健康检查:', JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}
