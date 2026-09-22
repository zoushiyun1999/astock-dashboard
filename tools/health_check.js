#!/usr/bin/env node
/**
 * 看板数据体检器 —— 检查 data.js 的结构完整性与前端渲染风险点
 *
 * 用法：node tools/health_check.js
 * 退出码：0 = 无问题；1 = 发现问题（WARNING/ERROR 均计）
 *
 * 2026-09-12 审计补充：
 *   6. 断更检测 —— 交易日无数据时，用 logs/<date>.md 是否存在来区分
 *      「数据源当日没发内容」（正常）与「管线压根没跑」（真问题）。
 *      本地模式下 health_site.js 不会运行，这里是唯一能发现停摆的地方。
 *   7. 晚报双结构一致性 —— evening['板块热点']（晚报 Tab）与 evening['明日关注']（短线 Tab）
 *      描述同一批板块，条数不一致时用户会在两个 Tab 看到不同的板块数。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ops = require('./lib/ops');
const gapCheck = require('./lib/gap_check');   // 断更检测/交易日判定的可测纯逻辑（可被测试脚本 require）
const { loadScreenerFile } = require('./screener');   // v7：量价历史源（覆盖度检查用；损坏→__abort，由调用处兜住）

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');
const SC_FILE = path.join(ROOT, 'dashboard', 'screener.js');   // 停写 data.screener 后的唯一历史源

const issues = [];
const notes = [];   // 提示：不参与退出码，只打印给人工参考（历史遗留、按设计跳过等）
function err(msg) { issues.push({ lv: 'ERROR', msg: msg }); }
function warn(msg) { issues.push({ lv: 'WARN', msg: msg }); }

function load() {
  let data = null;
  if (fs.existsSync(DATA)) {
    try { eval(fs.readFileSync(DATA, 'utf8').replace('window.REPORTS =', 'data =')); } catch (e) { }
  }
  return data;
}

/** 读取独立文件 dashboard/screener.js（停写 data.screener 后的唯一历史源）。
 *  返回 { state, value }：
 *    state='missing'     文件不存在（可能首次运行，尚未跑过 screener）
 *    state='parse-error' 文件存在但解析失败 / window.SCREENER 缺失（数据损坏）
 *    state='ok'          解析成功，value = 数组或单对象
 *  注意：screener 是「量价 Tab」的唯一数据源，故 parse-error 与「空数组」在第 5 节均为 ERROR。 */
function loadScreener() {
  if (!fs.existsSync(SC_FILE)) return { state: 'missing', value: null };
  try {
    const ctx = { window: {} };
    vm.runInNewContext(fs.readFileSync(SC_FILE, 'utf8'), ctx, { filename: 'dashboard/screener.js' });
    const v = ctx.window.SCREENER;
    if (v == null) return { state: 'parse-error', value: null };
    return { state: 'ok', value: v };
  } catch (e) { return { state: 'parse-error', value: null }; }
}

const data = load();
if (!data) { console.log('✗ 读取 data.js 失败'); process.exit(1); }

const reports = data.reports || [];
const screenerState = loadScreener();
const screenerRaw = screenerState.value;
console.log('📦 reports: ' + reports.length + ' 条 | calendar: ' + ((data.calendar || []).length) +
  ' 篇 | screener: ' + (Array.isArray(screenerRaw) ? screenerRaw.length + ' 期' : (screenerRaw ? '单对象(旧结构)' : '无')));

// ── 1. 日期排序与重复 ──
const dates = reports.map(function (r) { return r.date; });
const sorted = dates.slice().sort();
if (JSON.stringify(dates) !== JSON.stringify(sorted)) warn('reports 未按日期升序排列：' + dates.join(','));
const dup = dates.filter(function (d, i) { return dates.indexOf(d) !== i; });
if (dup.length) err('reports 存在重复日期：' + [...new Set(dup)].join(','));

// ── 2. 逐条字段完整性 ──
reports.forEach(function (r) {
  const d = r.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) err(d + ' 日期格式异常：' + d);

  const mo = r.morning;
  if (mo) {
    if (!mo.generatedAt) warn(d + ' 早报缺 generatedAt');
    if (!mo.sections) warn(d + ' 早报缺 sections');
    else {
      if (!Array.isArray(mo.sections['要闻简讯'])) warn(d + ' 早报缺 要闻简讯');
      if (!mo.sections['盘前人气股']) warn(d + ' 早报缺 盘前人气股');
    }
    const picks = mo['今日关注'] || [];
    if (!picks.length) warn(d + ' 早报「今日关注」为空');
    picks.forEach(function (p, i) {
      if (!p.name) err(d + ' 早报今日关注[' + i + '] 缺 name');
      if (!p.code) warn(d + ' 早报今日关注[' + i + '] ' + (p.name || '?') + ' 缺 code');
      if (!p.status) warn(d + ' 早报今日关注[' + i + '] ' + (p.name || '?') + ' 缺 status（用户最看重字段）');
      if (!p.reason) warn(d + ' 早报今日关注[' + i + '] ' + (p.name || '?') + ' 缺 reason');
    });
  }

  const ev = r.evening;
  if (ev) {
    if (!ev.generatedAt) warn(d + ' 晚报缺 generatedAt');
    if (!ev['大盘概况'] || !ev['大盘概况'].metrics) warn(d + ' 晚报缺 大盘概况.metrics');
    if (!Array.isArray(ev['博主观点']) || !ev['博主观点'].length) warn(d + ' 晚报缺 博主观点');
    const groups = ev['明日关注'] || [];
    if (!groups.length) warn(d + ' 晚报「明日关注」为空（短线关注 Tab 会空）');
    groups.forEach(function (g, gi) {
      if (!g.sector) warn(d + ' 晚报明日关注[' + gi + '] 缺 sector');
      if (!g.chain) warn(d + ' 晚报明日关注[' + gi + '] 缺 chain（博主思路）');
      (g.picks || []).forEach(function (p, pi) {
        if (!p.name) err(d + ' 晚报明日关注[' + gi + '].picks[' + pi + '] 缺 name');
        if (!p.code) warn(d + ' 晚报 ' + (g.sector || '?') + ' 的 ' + (p.name || '?') + ' 缺 code');
        if (!p.status) warn(d + ' 晚报 ' + (p.name || '?') + ' 缺 status（用户最看重字段）');
      });
    });
  }

  if (!mo && !ev) warn(d + ' 既无早报也无晚报（空记录）');
});

// ── 3. verify 标记合理性 ──
let vTotal = 0, vHit = 0, vBad = 0, vNoBy = 0;
const noBy = [];
reports.forEach(function (r) {
  const scan = function (arr, tag) {
    (arr || []).forEach(function (p) {
      if (!p || !p.verify) return;
      vTotal++;
      const v = p.verify;
      // 来源标记：v6 起 verify.js 写 by='snapshot'|'hist'。
      // 缺 by ⇒ 该条不是经 verify.js 落的（历史上的临时回补脚本正是这么写错的：
      // 把运行日快照填进 at=报告日 的记录，事后无法与真数据区分）。
      if (!v.by) { vNoBy++; if (noBy.length < 5) noBy.push(r.date + ' ' + tag + ' ' + p.name); }
      // hit=null 表示「停牌/无数据」（verify.js 约定），此时 gain 本就为 null，不算异常。
      if (v.hit === null || v.hit === undefined) return;
      // ±21% 闸门的前提是「该股有涨跌幅限制」。**次新股（上市前 5 个交易日）不设涨跌幅限制**，
      // 单日 ±200% 都合法 —— 2026-09-18 实测 601091 C沈鼓 20.80 → 57.77（+177.7%），
      // 曾被本检查误报为「可能数据错配」。判定依据用**本期报告自己声明的文字**
      // （本系统的 C 前缀次新在 status/reason 里必然写明），声明缺失时仍按异常上报。
      const NO_LIMIT = /无涨跌幅限制|不设.{0,2}涨跌幅/;
      const nolimit = NO_LIMIT.test((p.status || '') + ' ' + (p.role || '') + ' ' + (p.reason || ''));
      if (typeof v.gain !== 'number' || !isFinite(v.gain)) { vBad++; warn(r.date + ' ' + tag + ' ' + p.name + ' 的 verify.gain 非数字：' + JSON.stringify(v.gain)); }
      else {
        if (v.gain > 0) vHit++;
        if (v.gain > 21) { if (!nolimit) warn(r.date + ' ' + tag + ' ' + p.name + ' 涨幅 ' + v.gain + '% 异常（可能数据错配，A股单日上限约20%）'); }
        if (v.gain < -21) { if (!nolimit) warn(r.date + ' ' + tag + ' ' + p.name + ' 跌幅 ' + v.gain + '% 异常'); }
      }
      if (v.hit !== true && v.hit !== false) warn(r.date + ' ' + tag + ' ' + p.name + ' 的 verify.hit 非布尔：' + JSON.stringify(v.hit));
    });
  };
  if (r.morning) scan(r.morning['今日关注'], '早报');
  if (r.evening) (r.evening['明日关注'] || []).forEach(function (g) { scan(g.picks, '晚报'); });
});
console.log('✅ verify 标记：' + vTotal + ' 条，其中上涨 ' + vHit + ' 条（胜率 ' + (vTotal ? (vHit / vTotal * 100).toFixed(1) : 0) + '%）');
if (vNoBy) {
  warn('verify 缺来源标记 by 的条目 ' + vNoBy + ' 条（应=0）：' + noBy.join('、') +
    (vNoBy > noBy.length ? '…' : '') +
    '。这些条目不是 verify.js 落的，数据来源与日期是否对应**无法自证**；' +
    '请用 `node tools/verify.js --rebuild` 重算（见 AGENTS.md 规则 25b）');
}

// ── 4. calendar 结构 ──
(data.calendar || []).forEach(function (c, i) {
  if (!c.id) err('calendar[' + i + '] 缺 id');
  if (!c.title) warn('calendar[' + i + '] 缺 title');
  if (!Array.isArray(c.events) || !c.events.length) warn('calendar[' + i + '] 缺 events');
  (c.images || []).forEach(function (img) {
    const p = path.join(ROOT, 'dashboard', img);
    if (!fs.existsSync(p)) warn('calendar[' + i + '] 图片文件缺失：' + img);
  });
});

// ── 5. screener 结构（停写 data.screener 后改读独立文件 dashboard/screener.js）──
// screener 是「量价 Tab」的唯一数据源：解析失败 / 空数组都必须是 ERROR（否则静默空 Tab）。
if (screenerState.state === 'parse-error') {
  err('dashboard/screener.js 解析失败 / window.SCREENER 缺失（数据损坏；量价 Tab 将无数据）');
} else if (screenerState.state === 'missing') {
  notes.push('dashboard/screener.js 缺失（尚未跑过 screener？量价 Tab 暂无数据；data.screener 已停写，不再作为来源）');
} else {
  const arr = Array.isArray(screenerRaw) ? screenerRaw : [screenerRaw];
  if (!Array.isArray(screenerRaw)) err('screener 仍是旧的单对象结构（应为数组）');
  if (!arr.length) err('dashboard/screener.js 为空数组（量价 Tab 将无数据；screener 是量价 Tab 的唯一数据源）');
  arr.forEach(function (s, i) {
    if (!s.date) err('screener[' + i + '] 缺 date');
    if (!Array.isArray(s.list)) err('screener[' + i + '] 缺 list');
    (s.list || []).forEach(function (x) {
      if (!x.name || !x.code) warn('screener[' + i + '] 条目缺 name/code：' + JSON.stringify(x).slice(0, 80));
    });
  });
}

// ── 6. 断更检测 ──
// 为什么需要：新鲜度检查原本只在 tools/health_site.js 里，而它只被 .github/workflows/health.yml
// 调用 —— 当前是「本地模式」（不推 GitHub），等于**根本没有任何机制发现管线停摆**。
// 一个交易日没数据，有两种完全不同的原因，必须区分开：
//   · reports 里没这天 + logs/这天.md 存在  → 当日数据源没发内容，系统行为正确，不算问题
//   · reports 里没这天 + logs/这天.md 也没有 → 管线压根没跑（PC 关机/任务失败），这才是真问题
const HOLIDAYS = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8')).years || {}; }
  catch (e) { return {}; }
})();
// 已知永久缺口（config/known_gaps.json）：历史数据不可再得的交易日。
// 长期对 09-16 报「管线未运行，需排查」是噪音（每次体检都 ERROR/WARN 一条无法消除的旧账），
// 改为单独提示；前端空态卡已向用户说明「历史缺口或当时未运行」。
const KNOWN_GAPS = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'known_gaps.json'), 'utf8')).dates || []; }
  catch (e) { return []; }   // 配置缺失/损坏 → 视为无已知缺口，行为与旧版一致
})();
function isTradingDay(d) {
  return gapCheck.isTradingDay(d, HOLIDAYS);   // 口径收敛到 tools/lib/gap_check.js，与 verify.js 一致
}
(function checkGaps() {
  if (!reports.length) return;
  // 判定逻辑抽到 tools/lib/gap_check.js（纯函数，可被 test_scripts.js 断言）。
  // ⚠️ 2026-09-15 修复：当 now 早于当天最早任务时刻（早报 08:30）时，今天不计入 gaps——
  //    否则交易日凌晨/早上（当天首个任务尚未开始）会误报「管线未运行，需排查」
  //    （每日 07:00 的体检任务会天天撞上这条假警报）。
  const g = gapCheck.computeGaps({
    reportDates: dates,
    now: new Date(),
    holidayYears: HOLIDAYS,
    knownGaps: KNOWN_GAPS,
    hasLog: function (ds) { return fs.existsSync(path.join(ROOT, 'logs', ds + '.md')); }
  });
  const stalled = g.stalled, skipped = g.skipped, known = g.known || [];
  if (!stalled.length && !skipped.length && !known.length) return;
  if (skipped.length) notes.push('交易日无数据但已运行（数据源未发布，属正常）：' + skipped.join(', '));
  if (known.length) notes.push('已知永久缺口（历史数据不可再得，不再告警）：' + known.join(', '));
  if (stalled.length) {
    warn('交易日无数据且无运行日志（管线未运行，需排查）：' + stalled.join(', ') +
      '。检查 logs/ 与任务执行记录，常见原因是 PC 关机/休眠或任务报错。');
  }
})();

// ── 6b. verify 覆盖度（P1-3）──
// 原 :98 `if (!p || !p.verify) return;` 只校验"已存在 verify 的格式"，查不出"该标却没标"。
// 这里对「最近一个已过验证窗口的交易日」统计应标 picks 中有 verify.at 的比例，<80% 报 ERROR。
// 历史教训：5 个交易日 85 条推荐从未验证，靠人肉翻字段才发现。
(function verifyCoverage() {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  const now = new Date();
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  // 最近一个 date < today 且为交易日的报告（其验证窗口已过）
  let d0 = null;
  for (let i = reports.length - 1; i >= 0; i--) {
    const dt = reports[i].date;
    if (dt < today && isTradingDay(new Date(dt + 'T00:00:00'))) { d0 = reports[i]; break; }
  }
  if (!d0) return;
  const cands = [];
  ((d0.morning && d0.morning['今日关注']) || []).forEach(function (p) { if (p && p.name) cands.push(p); });
  // 前一篇有「明日关注」的晚报，其 picks 应在 d0 当天被标（verify.js 的"最近一篇早于今天的晚报"逻辑）
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i];
    if (r.date < d0.date && r.evening && Array.isArray(r.evening['明日关注']) && r.evening['明日关注'].length) {
      r.evening['明日关注'].forEach(function (g) {
        (g.picks || []).forEach(function (p) { if (p && p.name) cands.push(p); });
      });
      break;
    }
  }
  // v7（2026-09-22）：量价入选股纳入覆盖度 —— dashboard/screener.js 历史各期的 list，
  // 口径同晚报（期日的次一交易日应被标）。screener.js 损坏时跳过量价部分，不拖垮整个体检。
  (function addScreenerCands() {
    let periods = null;
    try { periods = loadScreenerFile(); }
    catch (e) { notes.push('screener.js 读取失败，量价覆盖度跳过：' + e.message); return; }
    (periods || []).forEach(function (period) {
      if (!period || !period.date) return;
      const d = new Date(period.date + 'T00:00:00');
      do { d.setDate(d.getDate() + 1); } while (!isTradingDay(d));
      const target = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      if (target !== d0.date) return;
      (period.list || []).forEach(function (p) { if (p && p.code) cands.push(p); });
    });
  })();

  if (!cands.length) return;
  const done = cands.filter(function (p) { return p.verify && p.verify.at; }).length;
  const ratio = done / cands.length;
  console.log('🔬 verify 覆盖度：' + d0.date + ' 应标 ' + cands.length + ' 条，已标 ' + done +
    ' 条（' + (ratio * 100).toFixed(0) + '%）');
  if (ratio < 0.8) {
    err('次日验证覆盖度不足：' + d0.date + ' 应标 ' + cands.length + ' 条，仅标 ' + done +
      ' 条（' + (ratio * 100).toFixed(0) + '% < 80%）—— 检查「A股次日验证」任务是否在跑');
  }
})();

// ── 7. 晚报双结构一致性 ──
// evening 里有两套描述同一批板块的结构，服务两个 Tab：
//   · 板块热点 → 晚报 Tab 的扁平摘要（name/strength/stocks/catalyst）
//   · 明日关注 → 短线 Tab 的板块卡片（sector/stage/why/chain/picks）
// 两者条数应当一致；历史上出现过 09-03 板块热点 10 条 vs 明日关注 8 条，用户同一天看到两个数字。
// 只有**最新一期**计入 WARN —— 它的目的是抓"这期又写歪了"，而不是让历史陈账把体检永久标红。
const latestDate = dates[dates.length - 1];
reports.forEach(function (r) {
  const ev = r.evening;
  if (!ev) return;
  const hot = ev['板块热点'], tmr = ev['明日关注'];
  if (Array.isArray(hot)) {
    hot.forEach(function (x, i) {
      if (!x || !x.name) err(r.date + ' 晚报板块热点[' + i + '] 缺 name（晚报 Tab 会显示空板块）');
    });
  } else if (Array.isArray(tmr) && tmr.length) {
    err(r.date + ' 晚报有「明日关注」但缺「板块热点」（晚报 Tab 的板块热点会是空的）');
  }
  if (Array.isArray(hot) && Array.isArray(tmr) && tmr.length &&
      hot.length !== tmr.length) {
    const msg = r.date + ' 晚报「板块热点」(' + hot.length + ') 与「明日关注」(' + tmr.length +
      ') 条数不一致，两个 Tab 会显示不同的板块数';
    if (r.date === latestDate) err(msg + ' ← 本期数据，请修正 prompt 执行结果');
    else notes.push(msg + '（历史遗留，不影响新数据）');
  }
});

// ── 8. 前端关键依赖 ──
const idxHtml = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
const need = ['data.js', 'app.js', 'holidays.js', 'screener.js'];
need.forEach(function (n) { if (idxHtml.indexOf(n) < 0) err('index.html 未引用 ' + n); });
if (!/window\.REPORTS\s*=/.test(fs.readFileSync(DATA, 'utf8'))) err('data.js 格式异常（缺少 window.REPORTS =）');

// ── 7b. 告警通道（P1-5）──
// 通知已下线；logs/ALERT.md 有未闭环条目 → ERROR。本地模式下这是唯一的停摆检测（规则 18）。
(function scanAlerts() {
  const open = ops.listOpen();
  if (open.length) {
    const tail = open.slice(-3).map(function (a) { return a.when + ' ' + (a.stage || a.script || ''); }).join('；');
    err('logs/ALERT.md 有 ' + open.length + ' 条未闭环告警：' + tail + '（详见 logs/ALERT.md，处理完请把对应条目改为 CLOSED）');
  }
})();

// ── 输出 ──
if (notes.length) {
  console.log('\nℹ️  提示 ' + notes.length + ' 条（不影响退出码）：');
  notes.forEach(function (m) { console.log('   · ' + m); });
}
const errs = issues.filter(function (x) { return x.lv === 'ERROR'; });
const warns = issues.filter(function (x) { return x.lv === 'WARN'; });
if (!issues.length) {
  console.log('\n🟢 未发现问题');
} else {
  console.log('\n🔴 ERROR ' + errs.length + ' 条：');
  errs.forEach(function (x) { console.log('   · ' + x.msg); });
  console.log('\n🟡 WARN ' + warns.length + ' 条：');
  warns.forEach(function (x) { console.log('   · ' + x.msg); });
}
process.exit(issues.length ? 1 : 0);
