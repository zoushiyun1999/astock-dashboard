#!/usr/bin/env node
// 校正 dashboard/data.js 中 reports 数组顺序：
// 按 date 升序排列（旧 -> 新），最新在末尾；保留最近 MAX 条。
// 前端 app.js 依赖此顺序（idx = length-1 指向最新），乱序会导致默认显示旧日期。
const fs = require('fs');
const path = require('path');

const F = path.join(__dirname, '..', 'dashboard', 'data.js');
const MAX = 7;

let s = fs.readFileSync(F, 'utf8');
const m = s.match(/window\.REPORTS\s*=\s*([\s\S]*);\s*$/);
if (!m) { console.error('未找到 window.REPORTS，退出'); process.exit(1); }
const R = eval('(' + m[1] + ')');

const before = (R.reports || []).map(x => x.date).join(',');
R.reports.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
if (R.reports.length > MAX) R.reports = R.reports.slice(-MAX);
const after = R.reports.map(x => x.date).join(',');

const out = 'window.REPORTS = ' + JSON.stringify(R, null, 2) + ';\n';
fs.writeFileSync(F, out);
console.log('reports 重排: [' + before + ']  ->  [' + after + ']   (count=' + R.reports.length + ')');
