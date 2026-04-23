#!/usr/bin/env node

/**
 * 诊断脚本 - 检查 Twitter 登录状态
 */

const http = require('http');
const { execSync } = require('child_process');

const PROXY_HOST = 'localhost';
const PROXY_PORT = 3456;

function proxyRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = `http://${PROXY_HOST}:${PROXY_PORT}${endpoint}`;
    const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const options = {
      method,
      headers: bodyStr ? { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(bodyStr) } : {}
    };

    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function diagnose() {
  console.log('🔍 开始诊断 Twitter 登录状态\n');

  // 1. 检查 CDP Proxy
  console.log('1️⃣ 检查 CDP Proxy...');
  try {
    const targets = await proxyRequest('/targets');
    console.log(`✅ CDP Proxy 正常运行，当前 tabs: ${JSON.stringify(targets, null, 2)}`);
  } catch (error) {
    console.log('❌ CDP Proxy 连接失败:', error.message);
    return;
  }

  // 2. 打开 Twitter
  console.log('\n2️⃣ 打开 Twitter/X...');
  let targetId;
  try {
    const result = await proxyRequest(`/new?url=https://x.com`);
    targetId = result.targetId;
    console.log(`✅ 成功打开，tab ID: ${targetId}`);

    // 等待加载
    await new Promise(resolve => setTimeout(resolve, 5000));
  } catch (error) {
    console.log('❌ 打开失败:', error.message);
    return;
  }

  // 3. 获取页面信息
  console.log('\n3️⃣ 获取页面信息...');
  try {
    const info = await proxyRequest(`/info?target=${targetId}`);
    console.log(`页面标题: ${info.title || '(empty)'}`);
    console.log(`页面 URL: ${info.url}`);
    console.log(`就绪状态: ${info.ready}`);
  } catch (error) {
    console.log('❌ 获取信息失败:', error.message);
  }

  // 4. 检查页面元素
  console.log('\n4️⃣ 检查页面元素...');

  const checks = [
    {
      name: '登录按钮',
      selector: '[data-testid="SideNav_AccountSwitcher_Button"]'
    },
    {
      name: '推文',
      selector: '[data-testid="tweet"]'
    },
    {
      name: '导航栏',
      selector: 'nav[role="navigation"]'
    },
    {
      name: '登录表单',
      selector: '[data-testid="loginButton"]'
    }
  ];

  for (const check of checks) {
    try {
      const script = `document.querySelector('${check.selector}') !== null`;
      const result = await proxyRequest(`/eval?target=${targetId}`, 'POST', script);
      const status = (result.value === true || result.value === 'true') ? '✅' : '❌';
      console.log(`${status} ${check.name}: ${result.value}`);
    } catch (error) {
      console.log(`❌ ${check.name}: 检查失败 - ${error.message}`);
    }
  }

  // 5. 尝试获取页面内容
  console.log('\n5️⃣ 获取页面文本内容...');
  try {
    const script = `document.body ? document.body.innerText.substring(0, 200) : 'no body'`;
    const result = await proxyRequest(`/eval?target=${targetId}`, 'POST', script);
    console.log(`页面内容: ${result.value}`);
  } catch (error) {
    console.log('❌ 获取内容失败:', error.message);
  }

  // 6. 截图
  console.log('\n6️⃣ 生成截图...');
  try {
    const screenshotPath = '/tmp/twitter-diagnose.png';
    await proxyRequest(`/screenshot?target=${targetId}&file=${screenshotPath}`);
    console.log(`✅ 截图已保存: ${screenshotPath}`);
    console.log('   可以使用: eog ~/twitter-diagnose.png 或其他图片查看器打开');
  } catch (error) {
    console.log('❌ 截图失败:', error.message);
  }

  // 7. 清理
  console.log('\n7️⃣ 清理...');
  try {
    await proxyRequest(`/close?target=${targetId}`);
    console.log('✅ 已关闭 tab');
  } catch (error) {
    console.log('❌ 关闭失败:', error.message);
  }

  console.log('\n✨ 诊断完成');
  console.log('\n💡 建议:');
  console.log('1. 如果显示未登录，请在 Chrome 中访问 https://x.com 并登录');
  console.log('2. 确保远程调试已启用: chrome://inspect/#remote-debugging');
  console.log('3. 如果页面元素都找不到，可能是网络问题或 X 平台限制');
}

diagnose().catch(console.error);
