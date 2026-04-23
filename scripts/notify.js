#!/usr/bin/env node

/**
 * 飞书通知模块
 * 优先使用 lark-cli，降级到 Webhook HTTP POST
 */

const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function sendViaLarkCli(chatId, text, identity) {
  const escaped = text.replace(/'/g, "'\\''");
  const cmd = `lark-cli im +messages-send --chat-id ${chatId} --as ${identity} --markdown $'${escaped.replace(/\n/g, '\\n')}'`;
  execSync(cmd, { timeout: 30000, stdio: 'pipe' });
}

function sendViaWebhook(webhookUrl, title, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      msg_type: 'post',
      content: {
        post: {
          zh_cn: {
            title,
            content: [[{ tag: 'text', text }]]
          }
        }
      }
    });

    const url = new URL(webhookUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 发送飞书通知
 * @param {string} text - 消息内容（支持 Markdown）
 * @param {string} [title] - 标题（仅 Webhook 模式使用）
 * @returns {boolean} 是否发送成功
 */
async function send(text, title = 'Twitter AI 监控') {
  const config = loadConfig();
  const feishu = config.feishu;

  if (!feishu || !feishu.enabled) {
    console.log('[notify] 飞书通知未启用');
    return false;
  }

  // 优先 lark-cli
  if (feishu.use_lark_cli && feishu.chat_id) {
    try {
      sendViaLarkCli(feishu.chat_id, text, feishu.as || 'bot');
      console.log('[notify] lark-cli 发送成功');
      return true;
    } catch (e) {
      console.error('[notify] lark-cli 失败:', e.message);
    }
  }

  // 降级到 Webhook
  if (feishu.webhook_url) {
    try {
      await sendViaWebhook(feishu.webhook_url, title, text);
      console.log('[notify] Webhook 发送成功');
      return true;
    } catch (e) {
      console.error('[notify] Webhook 失败:', e.message);
    }
  }

  console.log('[notify] 所有通知渠道均失败，输出到 console');
  console.log(`--- ${title} ---\n${text}`);
  return false;
}

/**
 * 检查飞书通知配置是否就绪
 */
function checkReady() {
  const config = loadConfig();
  const feishu = config.feishu;
  const issues = [];

  if (!feishu || !feishu.enabled) {
    issues.push('feishu.enabled 未开启');
    return { ready: false, issues };
  }

  let larkCliOk = false;
  if (feishu.use_lark_cli && feishu.chat_id) {
    try {
      execSync('lark-cli auth status', { timeout: 10000, stdio: 'pipe' });
      larkCliOk = true;
    } catch {
      issues.push('lark-cli 未安装或未登录（运行 lark-cli auth login --recommend）');
    }
  }

  const webhookOk = !!feishu.webhook_url;
  if (!larkCliOk && !webhookOk) {
    issues.push('需要配置 chat_id（用于 lark-cli）或 webhook_url 至少一个');
  }

  return { ready: larkCliOk || webhookOk, issues };
}

module.exports = { send, checkReady };

// 直接运行时发送测试消息
if (require.main === module) {
  const status = checkReady();
  console.log('飞书通知状态:', status.ready ? '✅ 就绪' : '❌ 未就绪');
  if (status.issues.length) console.log('问题:', status.issues.join('; '));

  if (status.ready) {
    send('🤖 Twitter AI 监控系统测试消息\n\n发送时间: ' + new Date().toLocaleString('zh-CN'))
      .then(ok => process.exit(ok ? 0 : 1));
  }
}
