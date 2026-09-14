#!/usr/bin/env node
/**
 * 前端判定逻辑回归测试（不需要浏览器，跑在 Node 里）
 *
 * 为什么存在：
 *   app.js 里「几点该有数据」这类判定是**时间相关**的，读代码很容易看走眼，
 *   而它们全部躲在 IIFE 内部、周末又无法用真实页面触发（休市会短路）。
 *   2026-09-12 就因此漏掉了两个每天都在触发的 bug：
 *     · 健康条只查「最新一期有没有数据」，不查「最新一期是不是今天」
 *       → 周一管线全挂时反而显示"🟢 各源运行正常"
 *     · 健康条的量价阈值是 15:00，任务 15:10 才跑 → 每天 15:00 起误报
 *
 * 做法：从 dashboard/js/app.js 里**按大括号配对抽出**这几个纯函数，
 *       塞进一个带假 Date / 假 document / 假 localStorage 的 vm 上下文里跑，
 *       再用断言验证行为。抽出失败会直接报错（不会静默跳过）。
 *
 * 用法：node tools/test_health_logic.js
 * 退出码：0 = 全部通过；1 = 有断言失败
 *
 * ⚠️ 文件名不要改回 `_test_` 前缀：gh_push_api.js 的 SKIP_PATH 会把它当本地临时文件跳过，
 *    导致它上不了云端仓库（2026-09-14 由 `_test_health_logic.js` 改为此名）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP_JS = path.join(ROOT, 'dashboard', 'js', 'app.js');
const SRC = fs.readFileSync(APP_JS, 'utf8');

/* ── 从 app.js 源码里抽出需要的片段（按大括号配对，抽出失败即报错）── */
function extractFn(src, name) {
  const re = new RegExp('\\bfunction\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('在 app.js 里找不到函数 ' + name + '()，测试无法运行');
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('函数 ' + name + '() 的大括号不闭合');
}

/* ⚠️ 这里是唯一的函数清单：抽出来的片段会被拼进同一个 vm 上下文，
   所以**依赖链上的每个函数都要列进来**（漏一个 → 运行时 ReferenceError，
   而不是静默跳过）。2026-09-15 起 srcMeta 改为以 curDate 为基准，
   依赖链变成 isTradingDay → parseYmd，以及 screenerOn / verifyOn。 */
const FN_NAMES = ['parseYmd', 'ymdOf', 'isTradingDay', 'isTradingToday', 'todayYmd',
  'screenerList', 'screenerOn', 'verifyOn', 'scRanToday', 'verifyRanToday',
  'srcMeta', 'metaTime', 'renderHealth', 'updateEveningDot',
  // 空态文案（休市 / 历史缺口 / 今日待更新 三者的区分）—— 是用户直接看到的字，必须测
  'esc', 'fmtDate', 'emptyCard', 'todayDue', 'emptyFor'];
const PARTS = {};
FN_NAMES.forEach(n => { PARTS[n] = extractFn(SRC, n); });

const dueMatch = SRC.match(/var DUE = \{[^}]*\};/);
if (!dueMatch) throw new Error('在 app.js 里找不到 DUE 常量定义，测试无法运行');
PARTS.DUE = dueMatch[0];

const weekMatch = SRC.match(/var WEEK = \[[^\]]*\];/);
if (!weekMatch) throw new Error('在 app.js 里找不到 WEEK 常量定义，测试无法运行');
PARTS.WEEK = weekMatch[0];

const HOLIDAYS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8')).years;

/** 时间戳 → 本地日期串（给"没有 list 数据"的 harness 兜底一个合理的 curDate） */
function ymdOf(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/* ── 组装一个"假环境"来跑这些函数 ── */
function makeHarness(nowTs, opts) {
  opts = opts || {};
  const els = {};
  const store = Object.assign({}, opts.storage || {});

  const documentStub = {
    getElementById: function (id) {
      if (!els[id]) {
        els[id] = {
          className: '', innerHTML: '', textContent: '', style: {},
          classList: { toggle: function () {}, add: function () {}, remove: function () {} }
        };
      }
      return els[id];
    }
  };

  function FakeDate() {
    const args = Array.prototype.slice.call(arguments);
    if (args.length === 0) return new Date(nowTs);
    return new (Function.prototype.bind.apply(Date, [null].concat(args)))();
  }
  FakeDate.prototype = Date.prototype;
  FakeDate.now = function () { return nowTs; };
  FakeDate.parse = Date.parse;
  FakeDate.UTC = Date.UTC;

  const reports = opts.reports || { reports: opts.list || [], calendar: [] };
  reports.reports = opts.list || [];

  const ctx = {
    Date: FakeDate,
    document: documentStub,
    console: console,
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    window: {
      REPORTS: reports,
      SCREENER: opts.screener || null,
      TRADE_HOLIDAYS: opts.tradeHolidays || HOLIDAYS
    },
    list: opts.list || [],
    // curDate = 当前选中的日期（app.js 的主状态）。默认取最后一期，
    // 想看"停在历史日期"的行为就显式传 curDate（场景 5）。
    curDate: opts.curDate !== undefined ? opts.curDate
      : (opts.list && opts.list.length ? opts.list[opts.list.length - 1].date : ymdOf(nowTs)),
    curTab: opts.curTab || 'morning'
  };
  vm.createContext(ctx);
  vm.runInContext([PARTS.DUE, PARTS.WEEK].concat(FN_NAMES.map(n => PARTS[n])).join('\n\n'), ctx);
  return { ctx: ctx, els: els, store: store };
}

/* ── 断言工具 ── */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label,
    '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected));
}

const T = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();
const REC = (date, o) => Object.assign({ date: date }, o || {});

/* ════════════════ 场景 1 · 回归 #1：周一管线全挂 ════════════════ */
console.log('\n场景 1 · 周一 10:00，今天一条数据都没写（最新一期是上周五）');
{
  const list = [REC('2026-09-11', { morning: { generatedAt: '2026-09-11 08:33' },
                                    evening: { generatedAt: '2026-09-11 21:05' } })];
  const h = makeHarness(T(2026, 9, 14, 10, 0), {
    list: list,
    screener: [{ date: '2026-09-11', list: [1], runAt: '2026-09-11 15:10' }]
  });
  h.ctx.renderHealth();
  const bar = h.els['healthBar'];
  console.log('    健康条 → class="' + bar.className + '"  内容=' + JSON.stringify(bar.innerHTML));
  ok(bar.className.indexOf('close') < 0, '交易日不应显示「休市」');
  ok(bar.className !== 'health ok', '不应显示「各源运行正常」（修复前恰恰是 ok）');
  ok(/今日无任何数据/.test(bar.innerHTML), '应明确报出「今日无任何数据」');
}

/* ════════════════ 场景 2 · 回归 #2：量价阈值 ════════════════ */
console.log('\n场景 2 · 交易日，今天的量价还没跑（任务 15:10 才开始）');
{
  const list = [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33' },
                                    evening: { generatedAt: '2026-09-14 21:05' } })];
  const mk = (hh, mm) => makeHarness(T(2026, 9, 14, hh, mm), {
    list: list,
    screener: [{ date: '2026-09-11', list: [1], runAt: '2026-09-11 15:10' }]
  });

  let h = mk(15, 0); h.ctx.renderHealth();
  ok(h.els['healthBar'].className === 'health ok', '15:00 不应报「量价未更新」（修复前会误报）');

  h = mk(15, 5); h.ctx.renderHealth();
  ok(h.els['healthBar'].className === 'health ok', '15:05 不应报「量价未更新」（任务还没开始）');

  h = mk(15, 25); h.ctx.renderHealth();
  ok(/量价未更新/.test(h.els['healthBar'].innerHTML), '15:25 应报「量价未更新」（已过 15:20 到期点）');

  h = mk(15, 5);
  h.ctx.renderHealth();
  const meta = h.ctx.srcMeta(list[0]);
  const scRow = meta.filter(s => s.name === '量价选股')[0];
  eq(scRow.state, 'wait', '15:05 时 header 的量价状态应为 wait');
  ok(h.els['healthBar'].className === 'health ok', '15:05 时健康条与 header 自洽（都不报警）');
}

/* ════════════════ 场景 3 · 未到点不该报警 ════════════════ */
console.log('\n场景 3 · 交易日 07:00，今天还什么都没跑（尚未到任何到期点）');
{
  const list = [REC('2026-09-11', { morning: {}, evening: {} })];
  const h = makeHarness(T(2026, 9, 14, 7, 0), { list: list, screener: [{ date: '2026-09-11', list: [1] }] });
  h.ctx.renderHealth();
  ok(h.els['healthBar'].className === 'health ok', '07:00 不该报警（最早到期点 8:40）');
}

console.log('\n场景 4 · 交易日 09:00，今天有数据但早报缺失');
{
  const list = [REC('2026-09-14', { evening: { generatedAt: '2026-09-14 21:05' } })];
  const h = makeHarness(T(2026, 9, 14, 9, 0), { list: list, screener: [{ date: '2026-09-14', list: [1] }] });
  h.ctx.renderHealth();
  ok(/早报缺失/.test(h.els['healthBar'].innerHTML), '09:00 应报「早报缺失」（8:40 已过点）');
}

/* ════════════════ 场景 5 · 回归 #3：未读红点记账 ════════════════ */
console.log('\n场景 5 · 晚报未读红点的记账时机');
{
  const list = [REC('2026-09-04', { evening: { generatedAt: '2026-09-04 21:05' } }),
                REC('2026-09-11', { evening: { generatedAt: '2026-09-11 21:05' } })];
  const NOW = T(2026, 9, 12, 22, 0);

  let h = makeHarness(NOW, { list: list, curDate: '2026-09-04', curTab: 'evening' });
  h.ctx.updateEveningDot();
  eq(h.store['lastSeenEvening'], undefined, '停在历史日期看晚报 → 不该写 lastSeenEvening（修复前会写）');

  h = makeHarness(NOW, { list: list, curDate: '2026-09-11', curTab: 'evening' });
  h.ctx.updateEveningDot();
  eq(h.store['lastSeenEvening'], '2026-09-11', '停在最新一期看晚报 → 应记为已读');

  h = makeHarness(NOW, { list: list, curDate: '2026-09-11', curTab: 'morning' });
  h.ctx.updateEveningDot();
  eq(h.store['lastSeenEvening'], undefined, '停在最新一期但没打开晚报 → 不该记为已读');
}

/* ════════════════ 场景 6 · 计划时间标记 ════════════════ */
console.log('\n场景 6 · 量价今天没跑时，15:10 必须标记为「计划时间」');
{
  const list = [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33' },
                                    evening: { generatedAt: '2026-09-14 21:05' } })];
  const h = makeHarness(T(2026, 9, 14, 10, 0), {
    list: list,
    screener: [{ date: '2026-09-11', list: [1], runAt: '2026-09-11 15:10' }]
  });
  const meta = h.ctx.srcMeta(list[0]);
  const sc = meta.filter(s => s.name === '量价选股')[0];
  const mo = meta.filter(s => s.name === '早报')[0];
  eq(sc.planned, true, '今天没跑 → planned 应为 true');
  eq(h.ctx.metaTime(sc), '15:10(计划)', 'metaTime 应输出 15:10(计划)');
  eq(mo.planned, false, '真实 generatedAt → planned 应为 false');
  eq(h.ctx.metaTime(mo), '08:33', 'metaTime 应输出真实时间 08:33');
}

/* ════════════════ 场景 7 · 休市分支（P2-6 原本零覆盖） ════════════════ */
console.log('\n场景 7 · 休市分支 —— 节假日 / 周末走 if(!isTradingToday()) return "close"');
{
  // 2026-09-25 周五，在 trade_holidays.json 内（中秋）
  let h = makeHarness(T(2026, 9, 25, 10, 0), { list: [REC('2026-09-24', { morning: {}, evening: {} })] });
  h.ctx.renderHealth();
  eq(h.els['healthBar'].className, 'health close', '节假日应显示「休市」');
  ok(/休市/.test(h.els['healthBar'].innerHTML), '节假日文案含「休市」');
  // 2026-09-12 周六
  h = makeHarness(T(2026, 9, 12, 22, 0), { list: [REC('2026-09-11', { morning: {}, evening: {} })] });
  h.ctx.renderHealth();
  eq(h.els['healthBar'].className, 'health close', '周末应显示「休市」');
}

/* ════════════════ 场景 8 · TRADE_HOLIDAYS 结构回归（防 16c 回退） ════════════════ */
console.log('\n场景 8 · window.TRADE_HOLIDAYS 必须是扁平 {"2026":[…]}');
{
  const flat = { '2026': HOLIDAYS['2026'] };
  let h = makeHarness(T(2026, 9, 25, 10, 0), { list: [], tradeHolidays: flat });
  eq(h.ctx.isTradingToday(), false, '扁平 {"2026":[…]} → 节假日判为休市');
  h = makeHarness(T(2026, 9, 14, 10, 0), { list: [], tradeHolidays: flat });
  eq(h.ctx.isTradingToday(), true, '普通交易日（周一）判为交易日');
  // 若 app.js 误改成读 .years[年]（正是 health_site.js 曾犯的 P0）→ 扁平数据下节假日识别失败
  const nested = { years: { '2026': HOLIDAYS['2026'] } };
  h = makeHarness(T(2026, 9, 25, 10, 0), { list: [], tradeHolidays: nested });
  eq(h.ctx.isTradingToday(), true, '{years:{…}} 形态识别不到节假日 → 证明 app.js 取扁平结构');
}

/* ════════════════ 场景 9 · 跨日不沿用昨日 ════════════════ */
console.log('\n场景 9 · 跨日：新交易日不得沿用昨日记录');
{
  const list = [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33' },
                                    evening: { generatedAt: '2026-09-14 21:05' } })];
  const scr = [{ date: '2026-09-14', list: [1], runAt: '2026-09-14 15:12' }];
  // 09-15 00:05：新交易日、尚无当日数据，但未到任何到期点
  let h = makeHarness(T(2026, 9, 15, 0, 5), { list: list, screener: scr });
  h.ctx.renderHealth();
  ok(h.els['healthBar'].className.indexOf('close') < 0, '00:05 新交易日不应显示「休市」');
  ok(!/早报缺失|晚报缺失/.test(h.els['healthBar'].innerHTML),
    '00:05 不得把昨日记录当成今日（不误报字段缺失）');
  // 09-15 22:00：已过所有到期点仍无当日数据 → 报「今日无任何数据」
  h = makeHarness(T(2026, 9, 15, 22, 0), { list: list, screener: scr });
  h.ctx.renderHealth();
  ok(/今日无任何数据/.test(h.els['healthBar'].innerHTML), '22:00 跨日无数据 → 报「今日无任何数据」');
}

/* ════════════════ 场景 10 · 状态 miss → ok 翻转 ════════════════ */
console.log('\n场景 10 · 早报 miss → 补齐后翻转 ok');
{
  let h = makeHarness(T(2026, 9, 14, 9, 0), {
    list: [REC('2026-09-14', { evening: { generatedAt: '2026-09-14 21:05' } })],
    screener: [{ date: '2026-09-14', list: [1] }]
  });
  h.ctx.renderHealth();
  ok(/早报缺失/.test(h.els['healthBar'].innerHTML), '09:00 缺早报 → 报「早报缺失」');
  h = makeHarness(T(2026, 9, 14, 9, 0), {
    list: [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33' },
                              evening: { generatedAt: '2026-09-14 21:05' } })],
    screener: [{ date: '2026-09-14', list: [1] }]
  });
  h.ctx.renderHealth();
  eq(h.els['healthBar'].className, 'health ok', '补上早报后 → 「各源运行正常」');
}

/* ════════════════ 场景 11 · evening 到期点边界（DUE.evening=1270） ════════════════ */
console.log('\n场景 11 · 晚报到期点边界 21:09 / 21:11');
{
  const list = [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33' } })];
  const scr = [{ date: '2026-09-14', list: [1] }];
  let h = makeHarness(T(2026, 9, 14, 21, 9), { list: list, screener: scr });
  h.ctx.renderHealth();
  ok(!/晚报缺失/.test(h.els['healthBar'].innerHTML), '21:09 未到点 → 不报晚报缺失');
  h = makeHarness(T(2026, 9, 14, 21, 11), { list: list, screener: scr });
  h.ctx.renderHealth();
  ok(/晚报缺失/.test(h.els['healthBar'].innerHTML), '21:11 过点 → 报晚报缺失');
}

/* ════════════════ 场景 12 · renderHealth 与 srcMeta 对量价判据一致（P2-3） ════════════════ */
console.log('\n场景 12 · 量价「跑了但选 0 只」时两处判据一致');
{
  const list = [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33' },
                                    evening: { generatedAt: '2026-09-14 21:05' } })];
  const h = makeHarness(T(2026, 9, 14, 16, 0), {
    list: list,
    screener: [{ date: '2026-09-14', count: 0, list: [], runAt: '2026-09-14 15:12' }]
  });
  h.ctx.renderHealth();
  ok(!/量价未更新/.test(h.els['healthBar'].innerHTML), 'run 过（选 0 只）→ 健康条不报「量价未更新」');
  const scRow = h.ctx.srcMeta(list[0]).filter(s => s.name === '量价选股')[0];
  eq(scRow.state, 'ok', 'srcMeta 量价行判为 ok（与健康条自洽）');
}

/* ════════════════ 场景 13 · 次日验证监控项（P1-3） ════════════════ */
console.log('\n场景 13 · 次日验证：跑没跑仍要监控，但不上顶部状态区');
{
  const scr = [{ date: '2026-09-14', list: [1] }];
  let h = makeHarness(T(2026, 9, 14, 21, 50), {
    list: [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33', '今日关注': [{ name: 'A' }] },
                              evening: { generatedAt: '2026-09-14 21:05' } })],
    screener: scr
  });
  h.ctx.renderHealth();
  ok(/验证未跑/.test(h.els['healthBar'].innerHTML), '21:50 无 verify.at=今天 → 报「验证未跑」');

  h = makeHarness(T(2026, 9, 14, 21, 50), {
    list: [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33',
                                          '今日关注': [{ name: 'A', verify: { at: '2026-09-14' } }] },
                              evening: { generatedAt: '2026-09-14 21:05' } })],
    screener: scr
  });
  h.ctx.renderHealth();
  ok(!/验证未跑/.test(h.els['healthBar'].innerHTML), '有 verify.at=今天 → 不报「验证未跑」');
  // 顶部状态区**不再列**「次日验证」（2026-09-15 用户要求去掉：它没有生成时间，
  // 混在一排时间戳里没信息量）。但它"跑没跑"的监控必须留着 —— 否则这项任务
  // 悄悄停掉就没人发现了。
  eq(h.ctx.srcMeta(null).filter(s => s.name === '次日验证').length, 0, 'srcMeta 不含「次日验证」行');
  eq(h.ctx.verifyRanToday(), true, 'verifyRanToday 仍可用（renderHealth 依赖它）');
}

/* ════════════════ 场景 14 · srcMeta 以「选中的日期」为基准 ════════════════ */
console.log('\n场景 14 · 顶部状态区必须跟着选中的日期走（休市 / 历史缺口 / 今日未到点）');
{
  const list = [REC('2026-09-14', { morning: { generatedAt: '2026-09-14 08:33' },
                                    evening: { generatedAt: '2026-09-14 21:05' } })];
  const scr = [{ date: '2026-09-14', list: [1], runAt: '2026-09-14 15:12' }];
  const row = (m, nm) => m.filter(s => s.name === nm)[0];

  // ① 休市日（2026-09-13 周日、2026-09-25 中秋）
  let h = makeHarness(T(2026, 9, 14, 22, 0), { list: list, screener: scr, curDate: '2026-09-13' });
  let m = h.ctx.srcMeta(null);
  eq(row(m, '早报').state, 'close', '休市日 → 早报 close（旧版会显示"待更新"）');
  eq(row(m, '量价选股').state, 'close', '休市日 → 量价 close');
  eq(row(m, '投资日历').state, 'close', '休市日 → 日历 close');
  eq(h.ctx.metaTime(row(m, '早报')), '', '休市日不显示计划时间');

  // ② 历史交易日但没数据（2026-09-08 周二）→ miss，且不留"计划时间"
  h = makeHarness(T(2026, 9, 14, 22, 0), { list: list, screener: scr, curDate: '2026-09-08' });
  m = h.ctx.srcMeta(null);
  eq(row(m, '早报').state, 'miss', '历史交易日无数据 → miss');
  eq(row(m, '早报').planned, false, '历史日期不标 planned');
  eq(h.ctx.metaTime(row(m, '早报')), '', '历史日期不显示计划时间');

  // ③ 今天（2026-09-14 周一）21:00：晚报未到点 → wait 并给出计划时间
  h = makeHarness(T(2026, 9, 14, 21, 0), { list: [], screener: [], curDate: '2026-09-14' });
  m = h.ctx.srcMeta(null);
  eq(row(m, '晚报').state, 'wait', '今天未到点 → wait');
  eq(row(m, '晚报').time, '21:00', '今天未到点 → 显示计划时间');
  eq(row(m, '早报').state, 'miss', '今天已过 8:40 仍无早报 → miss');
}

/* ════════════════ 场景 15 · 空态文案：休市日不能说"待更新" ════════════════ */
console.log('\n场景 15 · 没有数据时的文案必须区分 休市 / 历史缺口 / 今日待更新');
{
  const mk = (nowTs, ds) => makeHarness(nowTs, { list: [], curDate: ds });

  // 休市（周日）→ 必须写"无数据"，且不能说"待更新"
  let h = mk(T(2026, 9, 14, 22, 0), '2026-09-13');
  let s = h.ctx.emptyFor('2026-09-13', '早报');
  ok(/休市/.test(s) && /无数据/.test(s), '周日 → 文案含「休市 · 无数据」');
  ok(!/待更新/.test(s), '周日 → 不得出现「待更新」');

  // 节假日（中秋）—— now 必须落在当天或之后，否则会先命中"未来日期"分支
  h = mk(T(2026, 9, 25, 10, 0), '2026-09-25');
  s = h.ctx.emptyFor('2026-09-25', '晚报');
  ok(/休市/.test(s) && !/待更新/.test(s), '节假日 → 同样按「休市」处理');

  // 历史交易日没数据 → "当日无数据"，也不是"待更新"
  h = mk(T(2026, 9, 14, 22, 0), '2026-09-08');
  s = h.ctx.emptyFor('2026-09-08', '早报');
  ok(/当日无数据/.test(s), '历史交易日无数据 → 文案含「当日无数据」');
  ok(!/待更新/.test(s), '历史交易日无数据 → 不得出现「待更新」');

  // 今天、还没到计划点 → 这里才允许叫"待更新"
  h = mk(T(2026, 9, 15, 7, 0), '2026-09-15');
  s = h.ctx.emptyFor('2026-09-15', '早报');
  ok(/待更新/.test(s), '今天 07:00 早报未到点 → 允许「待更新」');

  // 今天、已过计划点仍没有 → 是"未生成"，不能再说"待更新"
  h = mk(T(2026, 9, 15, 10, 0), '2026-09-15');
  s = h.ctx.emptyFor('2026-09-15', '早报');
  ok(!/待更新/.test(s), '今天已过 8:40 仍无早报 → 不得写「待更新」');
  ok(/未生成/.test(s), '今天已过 8:40 仍无早报 → 提示「未生成」');

  // 未来日期（理论上选不到，防御性）
  h = mk(T(2026, 9, 15, 10, 0), '2026-09-20');
  s = h.ctx.emptyFor('2026-09-20', '早报');
  ok(/还没到/.test(s), '未来日期 → 明确说明"还没到"');
}

console.log('\n' + '─'.repeat(58));
console.log(fail === 0
  ? '全部通过 ✅   共 ' + pass + ' 项断言'
  : '有 ' + fail + ' 项失败 ❌   通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
