#!/usr/bin/env node
/**
 * 云端看板健康检查（GitHub Actions 每日运行）。
 *
 * 检查四件事：
 *  1. 三条访问路径是否可达（自有域名 / Pages 官方地址 / 国内镜像）
 *  2. 线上数据新鲜度（updatedAt 超过阈值未更新 = 调度没跑）
 *  3. 域名到期提醒（域名过期是"链接丢失"最常见的真实死因）
 *  4. 仓库里是否残留硬编码的失效链接
 *
 * 任一项异常 → 通过 Server酱推送微信告警（没有 key 时只打印，不报错）。
 *
 * 环境变量：SITE_URL / FALLBACK_URL / MIRROR_URL / DOMAIN_EXPIRY / SCT_KEY
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SITE = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8')); }
  catch (e) { return {}; }
})();

const SITE_URL = process.env.SITE_URL || SITE.siteUrl || '';
const MIRROR_URL = process.env.MIRROR_URL || SITE.mirrorUrl || '';
const FALLBACK_URL = process.env.FALLBACK_URL || SITE.fallbackUrl || '';
const DOMAIN_EXPIRY = process.env.DOMAIN_EXPIRY || SITE.domainExpiry || '';
const STALE_HOURS = Number(process.env.STALE_HOURS || 26);

const KEYWORD = 'A股';                    // 页面必须含此关键字，防"200 但是空白页"
const issues = [];
const lines = [];

function log(s) { console.log(s); lines.push(s); }

async function probe(name, url, required) {
  if (!url) {
    log('· ' + name + '：未配置，跳过');
    return;
  }
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url + (url.endsWith('/') ? '' : '/') + 'index.html', {
      redirect: 'follow', signal: ctl.signal, cache: 'no-store'
    });
    clearTimeout(timer);
    const html = await res.text();
    const ok = res.ok && html.includes(KEYWORD);
    log((ok ? '✓ ' : '✗ ') + name + '：HTTP ' + res.status + ' · ' + (Date.now() - t0) + 'ms · ' +
      (html.includes(KEYWORD) ? '含内容' : '内容异常'));
    if (!ok && required) issues.push(name + ' 不可达（HTTP ' + res.status + '）');
  } catch (e) {
    log('✗ ' + name + '：' + e.message);
    if (required) issues.push(name + ' 请求失败（' + e.message + '）');
  }
}

async function freshness() {
  if (!SITE_URL) return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(SITE_URL.replace(/\/$/, '') + '/version.json?t=' + Date.now(),
      { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) { issues.push('线上 version.json 不可读'); return; }
    const v = await res.json();
    const m = String(v.updatedAt || '').match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (!m) { issues.push('线上 updatedAt 格式异常：' + v.updatedAt); return; }
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    const hours = (Date.now() - t) / 3600000;
    log('· 数据新鲜度：updatedAt=' + v.updatedAt + '（' + hours.toFixed(1) + ' 小时前）');
    if (isTradingToday() && hours > STALE_HOURS) {
      issues.push('数据已 ' + hours.toFixed(1) + ' 小时未更新');
    }
  } catch (e) {
    log('· 新鲜度检查失败：' + e.message);
  }
}

function isTradingToday() {
  const now = new Date();
  const w = now.getDay();
  if (w === 0 || w === 6) return false;
  const pad = (n) => String(n).padStart(2, '0');
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  try {
    const hs = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8'));
    return (hs[String(now.getFullYear())] || []).indexOf(today) < 0;
  } catch (e) { return true; }
}

function domainExpiry() {
  if (!DOMAIN_EXPIRY) { log('· 域名到期日未配置，跳过提醒'); return; }
  const t = new Date(DOMAIN_EXPIRY + 'T00:00:00+08:00').getTime();
  const days = Math.ceil((t - Date.now()) / 86400000);
  log('· 域名到期：' + DOMAIN_EXPIRY + '（还有 ' + days + ' 天）');
  if (days <= 7) issues.push('域名 ' + days + ' 天后到期，请立即续费');
  else if (days <= 30) issues.push('域名 ' + days + ' 天后到期，记得续费');
}

function scanHardcoded() {
  const BAN = /(e2b\.[a-z0-9.-]+|sandbox\.cloudstudio\.club|3000-[a-f0-9]{8,})/i;
  const files = ['README.md', path.join('dashboard', 'index.html'), path.join('dashboard', 'js', 'app.js')];
  const hits = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(BAN);
    if (m) hits.push(f + ' → ' + m[0]);
  }
  if (hits.length) { log('✗ 发现硬编码失效链接：' + hits.join('；')); issues.push('仓库内仍有硬编码域名：' + hits.join('；')); }
  else log('✓ 无硬编码失效链接');
}

(async function () {
  log('=== 看板健康检查 ' + new Date().toISOString() + ' ===');
  await probe('主站（自有域名）', SITE_URL, true);
  await probe('备用（Pages 官方）', FALLBACK_URL, false);
  await probe('镜像（国内）', MIRROR_URL, false);
  await freshness();
  domainExpiry();
  scanHardcoded();

  if (!issues.length) {
    log('\n✓ 全部正常');
    return;
  }
  log('\n⚠️ 发现 ' + issues.length + ' 项问题：\n- ' + issues.join('\n- '));
  if (process.env.SCT_KEY) {
    const r = spawnSync(process.execPath, [
      path.join(__dirname, 'notify.js'),
      '⚠️ 看板健康检查：' + issues.length + ' 项异常',
      lines.join('\n')
    ], { encoding: 'utf8', env: process.env });
    if (r.stdout) console.log(r.stdout.trim());
    if (r.stderr) console.error(r.stderr.trim());
  } else {
    log('（未配置 SCT_KEY，仅打印不推送）');
  }
  process.exitCode = 1;
})();
