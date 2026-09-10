#!/usr/bin/env node
/**
 * 生成并发送简报摘要通知（供 publish_and_notify.sh 调用）。
 *
 * 链接一律取自 config/site.json / 环境变量 SITE_URL，绝不硬编码。
 * 若内容缺失（如当天没有该类型数据），则跳过发送，不打扰用户。
 *
 * 用法：node tools/notify_digest.js morning|evening|screener "标题"
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const type = process.argv[2];
const title = process.argv[3] || '看板已更新';

function loadJsVar(file, varName) {
  if (!fs.existsSync(file)) return null;
  try {
    return new Function('window', fs.readFileSync(file, 'utf8') + '\nreturn window.' + varName + ';')({});
  } catch (e) { return null; }
}

const R = loadJsVar(path.join(ROOT, 'dashboard', 'data.js'), 'REPORTS') || {};
const SC = loadJsVar(path.join(ROOT, 'dashboard', 'screener.js'), 'SCREENER');

const list = (R.reports || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
const last = list[list.length - 1] || {};
let desp = '';

if (type === 'morning') {
  const m = last.morning;
  if (!m) { console.log('今日无早报数据，跳过通知'); process.exit(0); }
  const picks = (m['今日关注'] || []).slice(0, 3).map((x) => x.name).filter(Boolean);
  const n = (m['今日关注'] || []).length;
  desp = '今日早报已发布并更新网页看板。\n\n' +
    '📌 今日可关注：' + (picks.join('、') || '—') + (n > picks.length ? ' 等 ' + n + ' 只' : '') +
    '\n\n' + (m.title || '');
} else if (type === 'evening') {
  const e = last.evening;
  if (!e) { console.log('今日无晚报数据，跳过通知'); process.exit(0); }
  const all = [];
  for (const s of (e['明日关注'] || [])) for (const p of (s.picks || [])) if (p.name) all.push(p.name);
  desp = '今日晚报已发布并更新网页看板。\n\n' +
    '🌙 明日可关注：' + (all.slice(0, 3).join('、') || '—') + (all.length > 3 ? ' 等 ' + all.length + ' 只' : '') +
    '\n\n博主观点 ' + ((e['博主观点'] || []).length) + ' 条 · 板块 ' + ((e['明日关注'] || []).length) + ' 个';
} else if (type === 'screener') {
  const arr = Array.isArray(SC) ? SC : (SC ? [SC] : []);
  const cur = arr[0];
  if (!cur) { console.log('无选股数据，跳过通知'); process.exit(0); }
  const top = (cur.list || []).slice(0, 5).map((x) => x.name + '(' + x.gain + '%)').join('、');
  desp = '今日技术面筛选完成，共 ' + ((cur.list || []).length) + ' 只符合条件。\n\n前 5 只：' + (top || '—');
} else {
  desp = '看板已更新。';
}

// 追加所有可达入口（第一条是主入口，其余是冗余备份）
const SITE = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8')); }
  catch (e) { return {}; }
})();
const main = process.env.SITE_URL || SITE.siteUrl || '';
if (!main) { console.error('✗ 未配置 siteUrl，无法生成通知'); process.exit(1); }
desp += '\n\n🔗 看板：' + main;
if (SITE.fallbackUrl && SITE.fallbackUrl !== main) desp += '\n备用入口：' + SITE.fallbackUrl;
desp += '\n\n—— 由 A股推送系统 自动推送';

const r = spawnSync(process.execPath, [path.join(__dirname, 'notify.js'), title, desp], {
  encoding: 'utf8', env: process.env
});
if (r.stdout) console.log(r.stdout.trim());
if (r.stderr) console.error(r.stderr.trim());
process.exitCode = r.status || 0;
