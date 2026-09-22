#!/usr/bin/env node
'use strict';
/**
 * 云端看门狗检测（GitHub Actions 定时调用；本机也可手动跑）。
 *
 * 背景（B 方案，2026-09-22）：主产线全量迁到阿里云 ECS 后，本机看门狗任务全部停用。
 * ECS 是单点 —— 它宕机/断网/cron 失败时没有任何东西会说话。本脚本在 GitHub 的
 * runner 上（独立于 ECS 与本机的第三方环境）检测「今天该有的简报是否真的上线了」，
 * 缺失则 exit 1，由 workflow 层开/评 GitHub issue 告警；数据恢复后自动关 issue。
 *
 * 判定口径（与 health_check / gap_check 一致）：
 *   · 非交易日（周末/节假日）该简报本就无数据 → 跳过（exit 0）
 *   · 已知永久缺口（config/known_gaps.json）→ 跳过
 *   · 交易日报表里有当日记录且含对应字段 → exit 0
 *   · 其余（交易日报表缺失该简报）→ exit 1
 *
 * 用法：node tools/watchdog_check.js <morning|evening> [--date YYYY-MM-DD]
 *   --date 仅测试用；默认查今天。
 *
 * 退出码：0 = 正常/跳过；1 = 数据缺失（触发告警）；2 = 用法错误/网络失败（不告警，
 *         网络抖动不该开 issue —— 下一个周期自然会重查）。
 */
const fs = require('fs');
const path = require('path');
const gapCheck = require('./lib/gap_check');

const ROOT = path.resolve(__dirname, '..');

const HOLIDAYS = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8')).years || {}; }
  catch (e) { return {}; }
})();

const KNOWN_GAPS = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'known_gaps.json'), 'utf8')).dates || []; }
  catch (e) { return []; }
})();

// 链接唯一事实源（AGENTS 规则 1）：主站取不到再试 fallback
const SITE = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8')); }
  catch (e) { return {}; }
})();

function pad2(n) { return String(n).padStart(2, '0'); }

async function fetchLiveReports() {
  const base = [SITE.siteUrl, SITE.fallbackUrl].filter(Boolean);
  for (const u of base) {
    const url = u.replace(/\/+$/, '') + '/data.json?t=' + Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.error('· ' + url + ' → HTTP ' + res.status); continue; }
      const obj = JSON.parse(await res.text());
      const R = (obj && obj.REPORTS) ? obj.REPORTS : obj;   // 导出格式是 {"REPORTS":{...}}
      if (R && Array.isArray(R.reports)) return R;
      console.error('· ' + url + ' 结构异常（无 reports 数组）');
    } catch (e) {
      console.error('· ' + url + ' 获取失败：' + e.message);
    }
  }
  return null;
}

(async function main() {
  const argv = process.argv.slice(2);
  const which = argv.find(function (a) { return a === 'morning' || a === 'evening'; }) || '';
  if (!which) {
    console.error('用法: node tools/watchdog_check.js <morning|evening> [--date YYYY-MM-DD]');
    process.exit(2);
  }
  const di = argv.indexOf('--date');
  const now = new Date();
  const today = (di >= 0 && argv[di + 1])
    ? argv[di + 1]
    : now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());

  // 1) 非交易日 → 该简报本就没有
  const d = new Date(today + 'T00:00:00');
  if (!gapCheck.isTradingDay(d, HOLIDAYS)) {
    console.log('✔ ' + today + ' 非交易日（周末/休市）→ ' + which + ' 本就无数据，跳过');
    return;
  }
  // 2) 已知永久缺口
  if (KNOWN_GAPS.indexOf(today) >= 0) {
    console.log('✔ ' + today + ' 已知永久缺口 → 跳过');
    return;
  }

  // 3) 取线上数据
  const R = await fetchLiveReports();
  if (!R) {
    console.error('✗ 线上 data.json 不可达（主站与 fallback 均失败）→ 不判定，退出码 2');
    process.exit(2);
  }

  const rec = (R.reports || []).find(function (r) { return r.date === today; });
  const present = !!(rec && rec[which] && typeof rec[which] === 'object');
  if (present) {
    console.log('✔ ' + today + ' ' + which + ' 已上线（updatedAt=' + (R.updatedAt || '?') + '）');
    return;
  }

  console.error('✗ ' + today + '（交易日）线上缺少 ' + which +
    '。请检查 ECS：logs/cron.log、logs/ALERT.md，或手动补跑 bash tools/cron.sh ' + which);
  process.exit(1);
})().catch(function (e) {
  console.error('✗ watchdog_check 异常（不判定，退出码 2）：' + e.message);
  process.exit(2);
});
