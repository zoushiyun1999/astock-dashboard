#!/usr/bin/env node
/**
 * 导出 data.json + version.json，供前端「轻量轮询 + 无感更新」使用。
 *
 * 为什么需要它：
 *  · data.js 是 window.REPORTS = {...} 形式，只能整文件加载（当前约 170KB）。
 *    手机端每分钟轮询一次全量数据太浪费流量。
 *  · version.json 只有几百字节，前端先比对它的 key，变了才去拉 data.json。
 *  · 本地双击 index.html（file://）时 fetch 会被 CORS 拦，此时前端自动退回
 *    window.REPORTS（data.js 仍在 index.html 里引入），不会白屏。
 *
 * 用法：node tools/export_json.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DASH = path.join(__dirname, '..', 'dashboard');

/** 执行形如 `window.X = {...}` 的脚本并取出变量（比 JSON.parse 更稳，能容忍正文里的分号） */
function loadJsVar(file, varName) {
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8');
  try {
    const fn = new Function('window', src + '\nreturn window.' + varName + ';');
    return fn({});
  } catch (e) {
    console.error('解析失败 ' + path.basename(file) + '：' + e.message);
    return null;
  }
}

const REPORTS = loadJsVar(path.join(DASH, 'data.js'), 'REPORTS');
if (!REPORTS) {
  console.error('未取到 window.REPORTS，跳过导出');
  process.exit(1);
}
const SCREENER = loadJsVar(path.join(DASH, 'screener.js'), 'SCREENER');

const payload = JSON.stringify({ REPORTS: REPORTS, SCREENER: SCREENER });
const key = crypto.createHash('md5').update(payload).digest('hex').slice(0, 16);

fs.writeFileSync(path.join(DASH, 'data.json'), payload, 'utf8');

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
  ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

const meta = {
  key: key,
  updatedAt: REPORTS.updatedAt || '',
  reports: (REPORTS.reports || []).length,
  bytes: Buffer.byteLength(payload),
  exportedAt: stamp
};
fs.writeFileSync(path.join(DASH, 'version.json'), JSON.stringify(meta, null, 2), 'utf8');

console.log('已导出 data.json / version.json');
console.log('  key=' + key + '  updatedAt=' + meta.updatedAt +
  '  reports=' + meta.reports + '  ' + Math.round(meta.bytes / 1024) + 'KB');
