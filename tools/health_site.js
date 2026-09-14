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
 * 任一项异常 → 打印问题清单并以退出码 1 结束（GitHub Actions 会在运行历史里标红，不等你去发现）。
 * 本脚本**不发送任何推送通知**（Server酱已于 2026-09-12 整体下线）。
 *
 * 环境变量：SITE_URL / FALLBACK_URL / MIRROR_URL / DOMAIN_EXPIRY
 */
const fs = require('fs');
const path = require('path');

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

function log(s) { console.log(s); }

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
    // 注意：trade_holidays.json 的真实结构是 { note, years: { "2026": [...] } }，
    // 必须取 .years[年] —— 曾误写成 hs[年]，永远得到 undefined，
    // 使「节假日」被一律判为交易日，休市日会误报「数据已 26 小时未更新」。
    const hs = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8'));
    const list = (hs.years && hs.years[String(now.getFullYear())]) || [];
    return list.indexOf(today) < 0;
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

/** GitHub 令牌探活 + 到期提醒（P1-4）。
 *  · 探活：GET /repos/{repo}，401/403 → 令牌无效/过期（ERROR）。
 *  · 到期：fine-grained PAT 不通过 API 暴露 expires_at，只能读 config/site.json 的 tokenExpiry；
 *    剩余 <30 天报 ERROR，<7 天更紧急。到期日不是密钥，可入库（规则 6 只禁密钥"值"）。 */
async function tokenCheck() {
  const repo = SITE.repo || 'zoushiyun1999/astock-dashboard';
  const TOKEN = process.env.GITHUB_TOKEN ||
    (fs.existsSync(path.join(ROOT, '.gh-token')) ? fs.readFileSync(path.join(ROOT, '.gh-token'), 'utf8').trim() : '');
  if (!TOKEN) {
    log('· GitHub 令牌：未配置（无 .gh-token / GITHUB_TOKEN），跳过探活');
  } else {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch('https://api.github.com/repos/' + repo, {
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'astock-health'
        },
        signal: ctl.signal, cache: 'no-store'
      });
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403) {
        log('✗ GitHub 令牌探活：HTTP ' + res.status + '（无效或权限不足）');
        issues.push('GitHub 令牌无效/已过期（HTTP ' + res.status + '）→ 发布将硬失败、线上停更');
      } else if (!res.ok) {
        log('· GitHub 令牌探活：HTTP ' + res.status + '（非 401/403，暂不判为失效）');
      } else {
        const j = await res.json().catch(() => null);
        log('✓ GitHub 令牌有效（repo ' + repo + (j && j.private === false ? '，public' : '') + '）');
      }
    } catch (e) {
      log('· GitHub 令牌探活失败（网络）：' + e.message);
    }
  }
  // ② 到期日
  const exp = process.env.TOKEN_EXPIRY || SITE.tokenExpiry || '';
  if (!exp) { log('· 令牌到期日未配置，跳过提醒'); return; }
  const t = new Date(exp + 'T00:00:00+08:00').getTime();
  const days = Math.ceil((t - Date.now()) / 86400000);
  log('· 令牌到期：' + exp + '（还有 ' + days + ' 天）');
  if (days <= 7) issues.push('GitHub 令牌 ' + days + ' 天后到期，请立即轮换（到期后发布硬失败、线上停更且无通知）');
  else if (days <= 30) issues.push('GitHub 令牌 ' + days + ' 天后到期，记得轮换');
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
  await tokenCheck();
  scanHardcoded();

  if (!issues.length) {
    log('\n✓ 全部正常');
    return;
  }
  log('\n⚠️ 发现 ' + issues.length + ' 项问题：\n- ' + issues.join('\n- '));
  // 通知功能已于 2026-09-12 下线：不再推送，只靠退出码 1 让 GitHub Actions 标红。
  process.exitCode = 1;
})();
