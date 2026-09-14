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

const PARTS = {};
['isTradingToday', 'screenerList', 'srcMeta', 'metaTime', 'renderHealth', 'updateEveningDot']
  .forEach(n => { PARTS[n] = extractFn(SRC, n); });

const dueMatch = SRC.match(/var DUE = \{[^}]*\};/);
if (!dueMatch) throw new Error('在 app.js 里找不到 DUE 常量定义，测试无法运行');
PARTS.DUE = dueMatch[0];

const HOLIDAYS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8')).years;

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
      TRADE_HOLIDAYS: HOLIDAYS
    },
    list: opts.list || [],
    idx: opts.idx === undefined ? 0 : opts.idx,
    curTab: opts.curTab || 'morning'
  };
  vm.createContext(ctx);
  vm.runInContext([PARTS.DUE, PARTS.isTradingToday, PARTS.screenerList, PARTS.srcMeta,
    PARTS.metaTime, PARTS.renderHealth, PARTS.updateEveningDot].join('\n\n'), ctx);
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

  let h = makeHarness(NOW, { list: list, idx: 0, curTab: 'evening' });
  h.ctx.updateEveningDot();
  eq(h.store['lastSeenEvening'], undefined, '停在历史日期看晚报 → 不该写 lastSeenEvening（修复前会写）');

  h = makeHarness(NOW, { list: list, idx: 1, curTab: 'evening' });
  h.ctx.updateEveningDot();
  eq(h.store['lastSeenEvening'], '2026-09-11', '停在最新一期看晚报 → 应记为已读');

  h = makeHarness(NOW, { list: list, idx: 1, curTab: 'morning' });
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

console.log('\n' + '─'.repeat(58));
console.log(fail === 0
  ? '全部通过 ✅   共 ' + pass + ' 项断言'
  : '有 ' + fail + ' 项失败 ❌   通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
