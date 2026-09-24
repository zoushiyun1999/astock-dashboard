#!/usr/bin/env node
/**
 * 推荐效果跟踪器 —— 给每条推荐算「买入后逐日走势」，并聚合出渠道级战绩
 * （2026-09-24 新增，方案 B）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 现有 `verify.js` 只做 **T+1 单日**（`basis:'open-to-close'`：次日开盘买、当天收盘卖）。
 * 用户想验证的是「**这些推荐后续几天到底行不行**」——单日一条记录回答不了，
 * 而且报告只留 7 期 / 选股只留 8 期（约两周），任何基于报告的统计**样本上限被钉死在两周**，
 * 永远得不出可信结论。
 *
 * 所以本脚本做了两件独立的事：
 *   ① 单条明细（`series`）→ 喂前端的「走势」按钮，覆盖留存窗口内的推荐
 *   ② 累计战绩（`stats`）→ 喂前端的「效果统计」面板，**独立于报告轮换、只增不删**
 *      （靠仓内账本 `tools/track_ledger.json` 累积，不会被 slice(-7) 冲掉）
 *
 * ── 应验日（入场日）口径 ────────────────────────────────────────
 * 与 `verify.js` **完全一致**，不自创第二套口径：
 *   · 早报「今日关注」  ch='m' → 入场日 = 报告当日          （盘前推荐，当日开盘买）
 *   · 晚报「明日关注」  ch='e' → 入场日 = 报告次一交易日    （盘后推荐，次日开盘买）
 *   · 量价选股          ch='s' → 入场日 = 期日的次一交易日  （15:10 发布，次日开盘买）
 * 入场价 = 入场日**开盘价**；`days[0]` 就是入场日收盘（= 现有 buyRet 的口径）。
 *
 * ── 一字板 ──────────────────────────────────────────────────────
 * 开=高=低=收 的入场日实际买不到 → `locked=true`，**该条不计入 stats**（沿用 verify 的剔除规则），
 * 但明细里仍保留、显式标注，避免"看不见的样本偏差"。
 *
 * 用法：
 *   node tools/track.js            # 抓行情 → 更新账本 → 生成 dashboard/track.js
 *   node tools/track.js --dry      # 只打印统计，不写任何文件
 *   node tools/track.js --limit 5  # 只抓前 N 只（调试用，结果不完整，勿发布）
 *
 * 依赖：腾讯日K（复用 verify.js 的 fetchDayBars，同源同参数同节流，避免第二套实现漂移）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const V = require('./verify.js');

const ROOT = path.resolve(__dirname, '..');
const DASH = path.join(ROOT, 'dashboard');
const LEDGER = path.join(__dirname, 'track_ledger.json');   // 仓内账本，**不发布到站点**
const OUT = path.join(DASH, 'track.js');

/** 跟踪到「入场日后第 N 个交易日」；N=0 即入场日当天 */
const MAX_T = 10;
/** 统计面板展示的口径（列）—— 0=当日，1/3/5/10=买入后第 N 个交易日 */
const STAT_AT = [0, 1, 3, 5, 10];
/** 账本保留最近 N 个自然日内的推荐（约半年），超出即裁掉，避免无限膨胀 */
const LEDGER_KEEP_DAYS = 200;
/** 请求间隔（ms）—— 与 verify.js 同值，防腾讯 WAF */
const GAP_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

/** 执行 `window.X = {...}` 取变量；解析失败**抛错**（绝不像旧代码那样静默吞掉，见 verify v4 教训） */
function loadVar(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const fn = new Function('window', src + '\nreturn window.' + name + ';');
  return fn({});
}

/**
 * 收集留存窗口内的全部推荐 → 待跟踪条目。
 * key 用 `ch|code|recDate`：同一只票在不同日/不同渠道推荐是**不同条目**（入场点不同），
 * 必须各算各的，否则会把"同一只票的多次推荐"混成一条、样本数直接失真。
 */
function collectRecs(reports, periods) {
  const out = [];
  (reports || []).forEach(function (r) {
    if (!r || !r.date) return;
    (r.morning && r.morning['今日关注'] || []).forEach(function (p) {
      if (p && p.code) out.push({ ch: 'm', code: String(p.code), name: p.name || '', rec: r.date, entryDate: r.date });
    });
    (r.evening && r.evening['明日关注'] || []).forEach(function (sec) {
      (sec.picks || []).forEach(function (p) {
        if (p && p.code) out.push({ ch: 'e', code: String(p.code), name: p.name || '', rec: r.date, entryDate: V.nextTradingDay(r.date) });
      });
    });
  });
  (periods || []).forEach(function (per) {
    if (!per || !per.date) return;
    (per.list || []).forEach(function (p) {
      if (p && p.code) out.push({ ch: 's', code: String(p.code), name: p.name || '', rec: per.date, entryDate: V.nextTradingDay(per.date) });
    });
  });
  // 同一 key 可能因报告内重复出现而多算 → 去重（保留首个）
  const seen = {};
  return out.filter(function (x) {
    const k = x.ch + '|' + x.code + '|' + x.rec;
    if (seen[k]) return false;
    seen[k] = 1;
    x.k = k;
    return true;
  });
}

/**
 * 从日线序列切出入场日之后连续 N 个交易日的走势。
 * · 以 **bar 的实际顺序**为准（停牌日直接不出现在日线里 → 自然跳过，不会把停牌日当成一天）
 * · `p` = 相对入场价的涨跌幅（%），四舍五入 2 位
 * · 入场日 bar 缺失（停牌/未上市）→ 返回 null（调用方标 pending，不写错数据）
 */
function trackDays(bars, entryDate, entry, maxT) {
  if (!bars || !bars.length || !entry) return null;
  const i0 = bars.findIndex(function (b) { return b.date === entryDate; });
  if (i0 < 0) return null;
  const out = [];
  for (let i = i0; i < bars.length && out.length < (maxT || MAX_T) + 1; i++) {
    const b = bars[i];
    if (!b || !isFinite(b.close)) continue;
    out.push({ d: b.date, c: +b.close.toFixed(2), p: +(((b.close / entry) - 1) * 100).toFixed(2) });
  }
  return out.length ? out : null;
}

/** 一字板：开=高=低=收（买不到） */
function isLocked(bar) {
  if (!bar) return false;
  return bar.open === bar.high && bar.high === bar.low && bar.low === bar.close;
}

/** 从 days 里取某个 T+N 的 p（拿不到返回 null） */
function atT(days, t) {
  if (!days || days.length <= t) return null;
  const v = days[t].p;
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}

/**
 * 聚合战绩：按渠道 × T+N 累计 {n, sum, win}。
 * 🔴 统计对象是**整个账本**（不是留存窗口），这样样本能随时间累积、不被报告轮换冲掉。
 * 🔴 `locked` 条目整条剔除（买不到，计入会高估）。
 */
function computeStats(ledgerRecs) {
  const stats = {};
  ['m', 'e', 's'].forEach(function (ch) {
    const cell = { total: 0, locked: 0, used: 0, at: {} };
    STAT_AT.forEach(function (t) { cell.at[t] = { n: 0, sum: 0, win: 0 }; });
    stats[ch] = cell;
  });
  Object.keys(ledgerRecs).forEach(function (k) {
    const r = ledgerRecs[k];
    const cell = stats[r.ch];
    if (!cell) return;
    cell.total++;
    if (r.locked) { cell.locked++; return; }
    let used = false;
    STAT_AT.forEach(function (t) {
      const p = r.t ? r.t[t] : null;
      if (typeof p !== 'number' || !isFinite(p)) return;
      const c = cell.at[t];
      c.n++; c.sum += p; if (p > 0) c.win++;
      used = true;
    });
    if (used) cell.used++;
  });
  // 收敛成前端好用的形状（避免把 sum 暴露出去还得前端再算一遍）
  const out = {};
  ['m', 'e', 's'].forEach(function (ch) {
    const c = stats[ch];
    const o = { total: c.total, locked: c.locked, used: c.used, at: {} };
    STAT_AT.forEach(function (t) {
      const x = c.at[t];
      o.at[t] = { n: x.n, avg: x.n ? +(x.sum / x.n).toFixed(2) : null, win: x.n ? +((x.win / x.n) * 100).toFixed(1) : null };
    });
    out[ch] = o;
  });
  return out;
}

/** 裁掉太老的账本条目（同时保留其已有的 t 快照——快照是最终态，不会再变） */
function pruneLedger(ledgerRecs, todayStr) {
  const cut = fmtDate(new Date(new Date(todayStr + 'T00:00:00').getTime() - LEDGER_KEEP_DAYS * 86400000));
  let dropped = 0;
  Object.keys(ledgerRecs).forEach(function (k) {
    const r = ledgerRecs[k];
    if (r && r.rec && r.rec < cut) { delete ledgerRecs[k]; dropped++; }
  });
  return dropped;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.indexOf('--dry') >= 0;
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? parseInt(args[li + 1], 10) || 0 : 0;

  const todayStr = fmtDate(new Date());

  const reports = loadVar(path.join(DASH, 'data.js'), 'REPORTS');
  let periods = [];
  try { periods = loadVar(path.join(DASH, 'screener.js'), 'SCREENER') || []; } catch (e) {
    console.warn('⚠️ screener.js 解析失败，量价渠道本轮跳过：' + e.message);
  }

  const recs = collectRecs(reports.reports || [], periods);
  console.log('待跟踪推荐：' + recs.length + ' 条（去重后不同个股 ' +
    new Set(recs.map(function (r) { return r.code; })).size + ' 只）');
  if (li >= 0) console.log('   ⚠️ --limit 调试模式，结果不完整，请勿发布');

  // 账本：历史快照（append-only，不被报告轮换丢弃）
  let ledger = { updatedAt: '', recs: {} };
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { /* 首次运行 */ }
  if (!ledger.recs) ledger.recs = {};

  // 按代码分组，每只只拉一次日线（窗口覆盖该股全部入场日 → 今天）
  const byCode = {};
  recs.forEach(function (r) { (byCode[r.code] = byCode[r.code] || []).push(r); });
  let codes = Object.keys(byCode);
  if (limit) codes = codes.slice(0, limit);

  const from = recs.reduce(function (a, r) { return (!a || r.entryDate < a) ? r.entryDate : a; }, '');
  console.log('日线窗口：' + from + ' → ' + todayStr + '｜共 ' + codes.length + ' 只待抓（间隔 ' + GAP_MS + 'ms）');

  let ok = 0, fail = 0, pending = 0, lockedN = 0;
  const series = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const bars = await V.fetchDayBars(code, from, todayStr);
    if (!bars) { fail++; }
    byCode[code].forEach(function (r) {
      const i0 = bars ? bars.findIndex(function (b) { return b.date === r.entryDate; }) : -1;
      if (!bars || i0 < 0) {
        pending++;                                   // 入场日无 bar（停牌/未上市/未到）→ 不写，留待下轮
        return;
      }
      const entryBar = bars[i0];
      const entry = entryBar.open;
      if (!entry || !isFinite(entry)) { pending++; return; }
      const days = trackDays(bars, r.entryDate, entry, MAX_T);
      if (!days) { pending++; return; }
      const locked = isLocked(entryBar);
      if (locked) lockedN++;
      const t = {};
      STAT_AT.forEach(function (n) { t[n] = atT(days, n); });

      // 账本：只存快照（体积小、可长期累积）；明细只进 dashboard/track.js
      const prev = ledger.recs[r.k];
      ledger.recs[r.k] = {
        code: r.code, name: r.name, ch: r.ch, rec: r.rec,
        entryDate: r.entryDate, entry: +entry.toFixed(2), locked: locked, t: t,
        days: days.length                               // 诊断用：已跟踪到第几天
      };
      if (prev && prev.entry !== ledger.recs[r.k].entry) {
        console.warn('   ⚠️ 入场价变化 ' + r.k + '：' + prev.entry + ' → ' + ledger.recs[r.k].entry +
          '（复权因子变动？账本已更新）');
      }
      series.push({ k: r.k, code: r.code, name: r.name, ch: r.ch, rec: r.rec, m: r.entryDate,
        e: +entry.toFixed(2), locked: locked, days: days });
      ok++;
    });
    if (i % 25 === 24) console.log('   进度 ' + (i + 1) + '/' + codes.length + '（成功 ' + ok + ' 条）');
    if (i < codes.length - 1) await sleep(GAP_MS);
  }

  if (limit) console.log('   ⚠️ --limit 模式：账本/输出均不完整，**不要发布**');

  const dropped = pruneLedger(ledger.recs, todayStr);
  const stats = computeStats(ledger.recs);

  console.log('');
  console.log('抓取结果：成功 ' + ok + ' 条｜入场日无行情（留待下轮）' + pending + ' 条｜日线失败 ' + fail + ' 只股票');
  console.log('一字板剔除：' + lockedN + ' 条（明细保留、不计入 stats）');
  console.log('账本：' + Object.keys(ledger.recs).length + ' 条' + (dropped ? '（裁掉 ' + dropped + ' 条过期）' : ''));
  console.log('战绩（全账本累计）：');
  const CN = { m: '早报', e: '晚报', s: '量价' };
  ['m', 'e', 's'].forEach(function (ch) {
    const c = stats[ch];
    const cells = STAT_AT.map(function (t) {
      const a = c.at[t];
      return 'T+' + t + (a.n ? ' ' + a.avg + '%/' + a.win + '%(n=' + a.n + ')' : ' —');
    }).join('  ');
    console.log('  ' + CN[ch] + '：' + cells);
  });

  if (dry) { console.log('\n--dry：未写任何文件'); return; }

  // 账本时间戳（只更新 updatedAt，recs 是累积的）
  ledger.updatedAt = todayStr + ' ' + pad2(new Date().getHours()) + ':' + pad2(new Date().getMinutes());
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1), 'utf8');

  // 站点产物：stats（全账本）+ series（仅留存窗口，体积有界）
  const payload = {
    updatedAt: ledger.updatedAt,
    maxT: MAX_T,
    statAt: STAT_AT,
    stats: stats,
    series: series
  };
  const js = 'window.TRACK = ' + JSON.stringify(payload) + ';\n';
  fs.writeFileSync(OUT, js, 'utf8');
  console.log('\n已写出 dashboard/track.js（' + Math.round(Buffer.byteLength(js) / 1024) + 'KB，' +
    series.length + ' 条明细）');
}

if (require.main === module) {
  main().catch(function (e) { console.error('✗ track.js 失败：' + e.message); process.exit(1); });
}

module.exports = { collectRecs, trackDays, isLocked, atT, computeStats, pruneLedger, loadVar, MAX_T, STAT_AT };
