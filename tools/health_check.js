#!/usr/bin/env node
/**
 * 看板数据体检器 —— 检查 data.js 的结构完整性与前端渲染风险点
 *
 * 用法：node tools/health_check.js
 * 退出码：0 = 无问题；1 = 发现问题（WARNING/ERROR 均计）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');

const issues = [];
function err(msg) { issues.push({ lv: 'ERROR', msg: msg }); }
function warn(msg) { issues.push({ lv: 'WARN', msg: msg }); }

function load() {
  let data = null;
  if (fs.existsSync(DATA)) {
    try { eval(fs.readFileSync(DATA, 'utf8').replace('window.REPORTS =', 'data =')); } catch (e) { }
  }
  return data;
}

const data = load();
if (!data) { console.log('✗ 读取 data.js 失败'); process.exit(1); }

const reports = data.reports || [];
console.log('📦 reports: ' + reports.length + ' 条 | calendar: ' + ((data.calendar || []).length) +
  ' 篇 | screener: ' + (Array.isArray(data.screener) ? data.screener.length + ' 期' : (data.screener ? '单对象(旧结构)' : '无')));

// ── 1. 日期排序与重复 ──
const dates = reports.map(function (r) { return r.date; });
const sorted = dates.slice().sort();
if (JSON.stringify(dates) !== JSON.stringify(sorted)) warn('reports 未按日期升序排列：' + dates.join(','));
const dup = dates.filter(function (d, i) { return dates.indexOf(d) !== i; });
if (dup.length) err('reports 存在重复日期：' + [...new Set(dup)].join(','));

// ── 2. 逐条字段完整性 ──
reports.forEach(function (r) {
  const d = r.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) err(d + ' 日期格式异常：' + d);

  const mo = r.morning;
  if (mo) {
    if (!mo.generatedAt) warn(d + ' 早报缺 generatedAt');
    if (!mo.sections) warn(d + ' 早报缺 sections');
    else {
      if (!Array.isArray(mo.sections['要闻简讯'])) warn(d + ' 早报缺 要闻简讯');
      if (!mo.sections['盘前人气股']) warn(d + ' 早报缺 盘前人气股');
    }
    const picks = mo['今日关注'] || [];
    if (!picks.length) warn(d + ' 早报「今日关注」为空');
    picks.forEach(function (p, i) {
      if (!p.name) err(d + ' 早报今日关注[' + i + '] 缺 name');
      if (!p.code) warn(d + ' 早报今日关注[' + i + '] ' + (p.name || '?') + ' 缺 code');
      if (!p.status) warn(d + ' 早报今日关注[' + i + '] ' + (p.name || '?') + ' 缺 status（用户最看重字段）');
      if (!p.reason) warn(d + ' 早报今日关注[' + i + '] ' + (p.name || '?') + ' 缺 reason');
    });
  }

  const ev = r.evening;
  if (ev) {
    if (!ev.generatedAt) warn(d + ' 晚报缺 generatedAt');
    if (!ev['大盘概况'] || !ev['大盘概况'].metrics) warn(d + ' 晚报缺 大盘概况.metrics');
    if (!Array.isArray(ev['博主观点']) || !ev['博主观点'].length) warn(d + ' 晚报缺 博主观点');
    const groups = ev['明日关注'] || [];
    if (!groups.length) warn(d + ' 晚报「明日关注」为空（短线关注 Tab 会空）');
    groups.forEach(function (g, gi) {
      if (!g.sector) warn(d + ' 晚报明日关注[' + gi + '] 缺 sector');
      if (!g.chain) warn(d + ' 晚报明日关注[' + gi + '] 缺 chain（博主思路）');
      (g.picks || []).forEach(function (p, pi) {
        if (!p.name) err(d + ' 晚报明日关注[' + gi + '].picks[' + pi + '] 缺 name');
        if (!p.code) warn(d + ' 晚报 ' + (g.sector || '?') + ' 的 ' + (p.name || '?') + ' 缺 code');
        if (!p.status) warn(d + ' 晚报 ' + (p.name || '?') + ' 缺 status（用户最看重字段）');
      });
    });
  }

  if (!mo && !ev) warn(d + ' 既无早报也无晚报（空记录）');
});

// ── 3. verify 标记合理性 ──
let vTotal = 0, vHit = 0, vBad = 0;
reports.forEach(function (r) {
  const scan = function (arr, tag) {
    (arr || []).forEach(function (p) {
      if (!p || !p.verify) return;
      vTotal++;
      const v = p.verify;
      if (typeof v.gain !== 'number' || !isFinite(v.gain)) { vBad++; warn(r.date + ' ' + tag + ' ' + p.name + ' 的 verify.gain 非数字：' + JSON.stringify(v.gain)); }
      else {
        if (v.gain > 0) vHit++;
        if (v.gain > 21) warn(r.date + ' ' + tag + ' ' + p.name + ' 涨幅 ' + v.gain + '% 异常（可能数据错配，A股单日上限约20%）');
        if (v.gain < -21) warn(r.date + ' ' + tag + ' ' + p.name + ' 跌幅 ' + v.gain + '% 异常');
      }
      if (v.hit !== true && v.hit !== false) warn(r.date + ' ' + tag + ' ' + p.name + ' 的 verify.hit 非布尔：' + JSON.stringify(v.hit));
    });
  };
  if (r.morning) scan(r.morning['今日关注'], '早报');
  if (r.evening) (r.evening['明日关注'] || []).forEach(function (g) { scan(g.picks, '晚报'); });
});
console.log('✅ verify 标记：' + vTotal + ' 条，其中上涨 ' + vHit + ' 条（胜率 ' + (vTotal ? (vHit / vTotal * 100).toFixed(1) : 0) + '%）');

// ── 4. calendar 结构 ──
(data.calendar || []).forEach(function (c, i) {
  if (!c.id) err('calendar[' + i + '] 缺 id');
  if (!c.title) warn('calendar[' + i + '] 缺 title');
  if (!Array.isArray(c.events) || !c.events.length) warn('calendar[' + i + '] 缺 events');
  (c.images || []).forEach(function (img) {
    const p = path.join(ROOT, 'dashboard', img);
    if (!fs.existsSync(p)) warn('calendar[' + i + '] 图片文件缺失：' + img);
  });
});

// ── 5. screener 结构 ──
if (data.screener) {
  const arr = Array.isArray(data.screener) ? data.screener : [data.screener];
  if (!Array.isArray(data.screener)) err('screener 仍是旧的单对象结构（应为数组）');
  arr.forEach(function (s, i) {
    if (!s.date) err('screener[' + i + '] 缺 date');
    if (!Array.isArray(s.list)) err('screener[' + i + '] 缺 list');
    (s.list || []).forEach(function (x) {
      if (!x.name || !x.code) warn('screener[' + i + '] 条目缺 name/code：' + JSON.stringify(x).slice(0, 80));
    });
  });
}

// ── 6. 前端关键依赖 ──
const idxHtml = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
const need = ['data.js', 'app.js', 'holidays.js', 'screener.js'];
need.forEach(function (n) { if (idxHtml.indexOf(n) < 0) err('index.html 未引用 ' + n); });
if (!/window\.REPORTS\s*=/.test(fs.readFileSync(DATA, 'utf8'))) err('data.js 格式异常（缺少 window.REPORTS =）');

// ── 输出 ──
const errs = issues.filter(function (x) { return x.lv === 'ERROR'; });
const warns = issues.filter(function (x) { return x.lv === 'WARN'; });
if (!issues.length) {
  console.log('\n🟢 未发现问题');
} else {
  console.log('\n🔴 ERROR ' + errs.length + ' 条：');
  errs.forEach(function (x) { console.log('   · ' + x.msg); });
  console.log('\n🟡 WARN ' + warns.length + ' 条：');
  warns.forEach(function (x) { console.log('   · ' + x.msg); });
}
process.exit(issues.length ? 1 : 0);
