#!/usr/bin/env node

/**
 * 周度知识蒸馏 — 长期记忆维护
 *
 * 流程：
 *   1. 读取过去 N 天（默认 7 天）的日报 reports/daily/YYYY-MM-DD.md
 *   2. 读取当前长期记忆 memory/long-term/core-insights.md（若存在）
 *   3. 调用 insights.distillWeekly() → 让 LLM 生成新版 core-insights.md
 *   4. 把旧版归档到 memory/archive/core-insights-YYYY-MM-DD.md
 *   5. 把本周快照存到 reports/weekly/YYYY-Www.md（不可变历史）
 *   6. 推送飞书周报摘要
 *
 * 用法：
 *   node weekly-distill.js                # 蒸馏过去 7 天
 *   node weekly-distill.js --days 14      # 蒸馏过去 14 天
 *   LLM_DRY_RUN=1 node weekly-distill.js  # mock 模式
 *   NO_NOTIFY=1 node weekly-distill.js    # 不推飞书
 */

const fs = require('fs');
const path = require('path');
const notify = require('./notify');
const insights = require('./insights');

const ROOT = path.join(__dirname, '..');
const REPORT_BASE = path.join(ROOT, 'reports');
const DAILY_DIR = path.join(REPORT_BASE, 'daily');
const WEEKLY_DIR = path.join(REPORT_BASE, 'weekly');
const MEM_LONG = path.join(ROOT, 'memory', 'long-term');
const MEM_ARCHIVE = path.join(ROOT, 'memory', 'archive');
const CORE_PATH = path.join(MEM_LONG, 'core-insights.md');

const DRY_RUN = !!process.env.LLM_DRY_RUN;
const NO_NOTIFY = !!process.env.NO_NOTIFY;

[WEEKLY_DIR, MEM_LONG, MEM_ARCHIVE].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ---------- 日期工具 ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { days: 7 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) out.days = parseInt(args[++i], 10);
  }
  return out;
}

function isoWeekLabel(d = new Date()) {
  // ISO 周编号：YYYY-Www
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

// ---------- 加载日报 ----------

function loadRecentDailyReports(days) {
  const reports = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const ds = dateStr(d);
    const file = path.join(DAILY_DIR, `${ds}.md`);
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8').trim();
      // 跳过空报告或仅 "今日无新推文"
      if (content.length > 80 && !/今日无新推文/.test(content.slice(0, 200))) {
        reports.push({ date: ds, content });
      }
    }
  }
  return reports;
}

function loadCurrentLongTerm() {
  if (fs.existsSync(CORE_PATH)) return fs.readFileSync(CORE_PATH, 'utf8');
  return '';
}

// ---------- 归档 ----------

function archivePrevLongTerm() {
  if (!fs.existsSync(CORE_PATH)) return null;
  const ts = dateStr(new Date());
  const archivePath = path.join(MEM_ARCHIVE, `core-insights-${ts}.md`);
  fs.copyFileSync(CORE_PATH, archivePath);
  return archivePath;
}

// ---------- 飞书周报摘要 ----------

function buildFeishuSummary(weekLabel, dailyReportsCount, distilled) {
  let msg = `🧪 **AI 行业周度蒸馏** | ${weekLabel}\n`;
  msg += `本周共纳入 ${dailyReportsCount} 份日报\n\n`;

  // 从蒸馏内容中抽取「本周新出现的观点」一段，作为飞书摘要
  const newSection = distilled.match(/##\s*⭐?\s*本周新出现的观点[\s\S]*?(?=\n##\s|\n*$)/);
  if (newSection) {
    let snippet = newSection[0].slice(0, 600);
    if (newSection[0].length > 600) snippet += '...';
    msg += snippet + '\n\n';
  }

  msg += '📂 详细蒸馏已写入 memory/long-term/core-insights.md\n';
  msg += '📚 历史快照: reports/weekly/' + weekLabel + '.md';
  return msg;
}

// ---------- 主流程 ----------

async function main() {
  const args = parseArgs();
  const banner = DRY_RUN ? '🧪 周度蒸馏 (DRY-RUN)' : '🧪 周度蒸馏';
  console.log(`${banner} | ${new Date().toLocaleString('zh-CN')}`);

  // 1. 加载日报
  const reports = loadRecentDailyReports(args.days);
  console.log(`找到过去 ${args.days} 天的 ${reports.length} 份有效日报`);
  if (reports.length === 0) {
    console.log('⚠️ 没有可蒸馏的日报，退出');
    if (!NO_NOTIFY) {
      await notify.send('🧪 AI 周报：本周无日报数据，跳过蒸馏', 'AI 周报');
    }
    return;
  }

  // 2. 加载当前长期记忆
  const prevLongTerm = loadCurrentLongTerm();
  console.log(`当前 core-insights.md：${prevLongTerm ? prevLongTerm.length + ' 字符' : '空（首次生成）'}`);

  // 3. 蒸馏
  const weekLabel = isoWeekLabel();
  console.log(`🤖 调用 LLM 生成 ${weekLabel} 蒸馏...`);
  let distilled;
  try {
    distilled = await insights.distillWeekly(weekLabel, reports, prevLongTerm, { dry_run: DRY_RUN });
  } catch (e) {
    console.error('❌ 蒸馏失败：', e.message);
    if (e.code === 'RATE_LIMITED' && e.resets_at) {
      console.error(`   配额重置时间: ${e.resets_at}`);
    }
    process.exit(1);
  }

  // 4. 归档旧版本（仅当不是 dry-run 才覆盖）
  if (!DRY_RUN) {
    const archived = archivePrevLongTerm();
    if (archived) console.log(`📦 旧版归档: ${archived}`);
    fs.writeFileSync(CORE_PATH, distilled);
    console.log(`✅ 长期记忆已更新: ${CORE_PATH}`);

    // 5. 周报快照（不可变历史）
    const weeklyPath = path.join(WEEKLY_DIR, `${weekLabel}.md`);
    fs.writeFileSync(weeklyPath, distilled);
    console.log(`📚 周报快照: ${weeklyPath}`);
  } else {
    console.log('--- DRY-RUN 模式，不写文件 ---');
  }

  // 6. 飞书摘要
  const summary = buildFeishuSummary(weekLabel, reports.length, distilled);
  if (!NO_NOTIFY) {
    await notify.send(summary, 'AI 周度蒸馏');
    console.log('✅ 飞书通知已发送');
  } else {
    console.log('\n--- 飞书摘要预览（NO_NOTIFY=1）---\n' + summary);
    console.log('\n--- 蒸馏全文预览（前 800 字符）---\n' + distilled.slice(0, 800) + '...');
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
} else {
  module.exports = { loadRecentDailyReports, isoWeekLabel, buildFeishuSummary };
}
