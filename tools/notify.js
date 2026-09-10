#!/usr/bin/env node
/**
 * 统一微信推送（Server酱）。
 *
 * 设计要点：
 *  · 链接只从 config/site.json（或环境变量 SITE_URL）取，绝不硬编码——
 *    这是防止"域名换了但推送里还是旧链接"的最后一道闸。
 *  · 如果正文里出现动态沙箱域名（e2b / sandbox），直接报错，逼你去改配置。
 *
 * 用法：
 *   node tools/notify.js "标题" "内容（支持 markdown）"
 *   node tools/notify.js "标题" --file logs/2026-09-10.md
 *   node tools/notify.js "标题" "内容" --no-link      # 不自动附加看板链接
 *
 * 环境变量：SCT_KEY（必填，存 GitHub Secrets）、SITE_URL（可选，覆盖配置）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SITE = (function () {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8'));
  } catch (e) { return {}; }
})();

const SCT_KEY = process.env.SCT_KEY || '';
const SITE_URL = process.env.SITE_URL || SITE.siteUrl || '';

// 已失效/会漂移的托管域名，出现在正文里一律拦截
const BAN = /(e2b\.[a-z0-9.-]+|sandbox\.cloudstudio\.club|3000-[a-f0-9]{8,})/i;

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function send(title, desp) {
  if (!SCT_KEY) fail('缺少 SCT_KEY（应存于 GitHub Secrets，不要写进代码）');
  if (BAN.test(desp) || BAN.test(title)) {
    fail('正文含动态沙箱/失效域名，疑似硬编码链接。请改为引用 SITE_URL：\n  ' +
      (desp.match(BAN) || [])[0]);
  }
  const body = new URLSearchParams({ title: title, desp: desp }).toString();
  const req = https.request({
    hostname: 'sctapi.ftqq.com',
    path: '/' + SCT_KEY + '.send',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    timeout: 20000
  }, (res) => {
    let out = '';
    res.on('data', (d) => { out += d; });
    res.on('end', () => {
      if (res.statusCode === 200 && !/"code"\s*:\s*[^0]/.test(out)) {
        console.log('✓ 微信推送成功：' + out.slice(0, 120));
      } else {
        console.error('✗ 推送返回异常：' + out.slice(0, 200));
        process.exitCode = 1;
      }
    });
  });
  req.on('error', (e) => fail('推送请求失败：' + e.message));
  req.on('timeout', () => { req.destroy(); fail('推送超时'); });
  req.write(body);
  req.end();
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.log('用法：node tools/notify.js "标题" "内容" [--file 路径] [--no-link]');
    return;
  }
  const title = argv[0];
  let desp = '';
  const noLink = argv.includes('--no-link');
  const fi = argv.indexOf('--file');
  if (fi >= 0 && argv[fi + 1]) {
    desp = fs.readFileSync(argv[fi + 1], 'utf8');
  } else {
    desp = argv.slice(1).filter((a) => !a.startsWith('--')).join('\n');
  }

  if (!noLink) {
    if (!SITE_URL) fail('未配置访问链接：请填 config/site.json 的 siteUrl 或设置环境变量 SITE_URL');
    desp += '\n\n🔗 看板：' + SITE_URL;
    if (SITE.mirrorUrl) desp += '\n（备用入口：' + SITE.mirrorUrl + '）';
  }
  send(title, desp);
}

main();
