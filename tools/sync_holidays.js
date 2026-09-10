#!/usr/bin/env node
// 把 config/trade_holidays.json 同步为 dashboard/holidays.js（供前端判断是否休市）
// 由 bump_version.sh 在每次部署前调用，保证前端休市日与后端 verify 同源。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'config', 'trade_holidays.json');
const OUT = path.join(ROOT, 'dashboard', 'holidays.js');

let data = { years: {} };
try { data = JSON.parse(fs.readFileSync(SRC, 'utf8')); } catch (e) { console.log('  跳过：无休市配置'); return; }
fs.writeFileSync(OUT, 'window.TRADE_HOLIDAYS = ' + JSON.stringify(data.years || {}, null, 2) + ';\n');
console.log('  ✔ 已同步 dashboard/holidays.js（' + Object.keys(data.years || {}).join(',') + '）');
