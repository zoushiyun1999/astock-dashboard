#!/usr/bin/env node
'use strict';
/**
 * 脚本级回归测试（评审报告第六节的 #6 / #8 / #9 / #10 / #11 / #12）。
 *
 * 与 test_health_logic.js（前端判定）互补：这里测后端脚本的纯函数与安全阀。
 * 全部用**临时文件**（os.tmpdir()），绝不碰真实 dashboard/data.js。
 *
 * 用法：node tools/test_scripts.js
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astock-test-'));
const dataStore = require('./lib/data_store');
const ops = require('./lib/ops');
const { sortReports } = require('./sort_reports');
const screener = require('./screener');
const checkCodes = require('./check_codes');
const verify = require('./verify');
const gapCheck = require('./lib/gap_check');   // 断更检测/交易日判定纯逻辑（#19）

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, '实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b)); }

let seq = 0;
function tmpFile(content, ext) {
  const f = path.join(tmpDir, 't' + (++seq) + (ext || '.js'));
  fs.writeFileSync(f, content);
  return f;
}
function dataSrc(n) {
  const reports = [];
  for (let i = 0; i < n; i++) reports.push({ date: '2026-09-0' + ((i % 9) + 1), morning: {}, evening: {} });
  return 'window.REPORTS = ' + JSON.stringify({ updatedAt: '', calendar: [], reports: reports }) + ';\n';
}

/* ════════════ #8 · 安全阀阈值（组合式：after ≤ prev-2 且 after < prev*0.8） ════════════ */
console.log('\n#8 · data_store.saveDataSafe 组合阈值（固话 P2-2）');
{
  function trySave(prev, after) {
    const f = tmpFile(dataSrc(prev));
    const srcAtRead = fs.readFileSync(f, 'utf8');
    const next = JSON.parse(JSON.stringify({ reports: new Array(after).fill({}), calendar: [] }));
    try {
      dataStore.saveDataSafe(f, next, { reports0: prev, calendar0: 0 }, srcAtRead);
      return 'ok';
    } catch (e) { return (e && e.__abort) ? 'abort' : 'throw'; }
  }
  eq(trySave(7, 7), 'ok', '7 → 7 放行（正常裁剪，不误拦）');
  eq(trySave(7, 6), 'ok', '7 → 6 放行（仅降 1）');
  eq(trySave(7, 5), 'abort', '7 → 5 拦截（降 2 且 71% < 80%）');
  eq(trySave(7, 4), 'abort', '7 → 4 拦截');
  eq(trySave(4, 3), 'ok', '4 → 3 放行（仅降 1，防小 N 误伤）');
  eq(trySave(4, 2), 'abort', '4 → 2 拦截（降 2 且 50%）');
  eq(trySave(0, 0), 'ok', '0 → 0 放行（首期写入）');
  // 乐观锁
  {
    const f = tmpFile(dataSrc(7));
    const stale = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, dataSrc(7) + '\n// 被别的任务改过');
    const next = { reports: new Array(7).fill({}), calendar: [] };
    let r = 'ok';
    try { dataStore.saveDataSafe(f, next, { reports0: 7, calendar0: 0 }, stale); }
    catch (e) { r = (e && e.__abort) ? 'abort' : 'throw'; }
    eq(r, 'abort', '并发修改（srcAtRead 不符）→ 拦截');
  }
}

/* ════════════ #9 · sort_reports 安全阀 ════════════ */
console.log('\n#9 · sort_reports 安全阀（解析失败 exit=2；不因排序丢条）');
{
  // 正常排序 + 不丢条
  const f = tmpFile('window.REPORTS = ' + JSON.stringify({
    reports: [{ date: '2026-09-03', morning: {}, evening: {} },
              { date: '2026-09-01', morning: {}, evening: {} },
              { date: '2026-09-02', morning: {}, evening: {} }]
  }) + ';\n');
  sortReports(f);
  const after = JSON.parse(fs.readFileSync(f, 'utf8').replace('window.REPORTS =', '').replace(/;\s*$/, ''));
  eq(after.reports.length, 3, '排序后条数不变（3 条）');
  eq(after.reports.map(x => x.date).join(','), '2026-09-01,2026-09-02,2026-09-03', '按 date 升序、最新在末尾');

  // 解析失败 → __abort
  const bad = tmpFile('window.REPORTS = { broken');
  let threw = null;
  try { sortReports(bad); } catch (e) { threw = e; }
  ok(threw && threw.__abort, '解析失败 → 抛 __abort（顶层映射为 exit 2）');

  // 规模骤减 9 → 7（排序裁剪）→ __abort
  const nine = tmpFile(dataSrc(9));
  threw = null;
  try { sortReports(nine); } catch (e) { threw = e; }
  ok(threw && threw.__abort, 'reports 9 → 7（裁剪 2 天）→ 抛 __abort（拦截）');
}

/* ════════════ #10 · 新股 / 次新排除（合成样本） ════════════ */
console.log('\n#10 · screener.isBadName 新股/次新/ST/退市排除');
{
  ['N华虹', 'C华虹', 'N 华虹', 'C 华虹', 'ST中孚', '退市海润'].forEach(function (n) {
    eq(screener.isBadName(n), true, '正例应排除：' + n);
  });
  ['中国平安', '宁德时代', '长春高新', '木林森'].forEach(function (n) {
    eq(screener.isBadName(n), false, '反例应保留：' + n);
  });
  // 排除规则覆盖 920x（北交所）
  eq(screener.passBase({ f3: 3, f8: 5, f20: 100e8, f10: 2, f14: '某股', f12: '920001' }), false,
    'passBase：920001（北交所）被排除');
  eq(screener.passBase({ f3: 3, f8: 5, f20: 100e8, f10: 2, f14: '某股', f12: '600000' }), true,
    'passBase：600000（沪主板）符合基础条件');
}

/* ════════════ #11 · 代码白名单 + secidOf ════════════ */
console.log('\n#11 · check_codes.isValidCode / secidOf（固话 P2-9）');
{
  ['600410', '601398', '603328', '605588', '688600', '000823', '001326', '002745', '003006',
   '300413', '301128', '430047', '830799', '870199', '920001'].forEach(function (c) {
    eq(checkCodes.isValidCode(c), true, '白名单接受 ' + c);
  });
  ['60041', '1234567', 'abc123', '', '6004O A', '12345'].forEach(function (c) {
    eq(checkCodes.isValidCode(c), false, '白名单拒绝 ' + JSON.stringify(c));
  });
  eq(checkCodes.secidOf('600410'), '1.600410', 'secidOf 沪主板 → 1.');
  eq(checkCodes.secidOf('000823'), '0.000823', 'secidOf 深主板 → 0.');
  eq(checkCodes.secidOf('688600'), '1.688600', 'secidOf 科创板 → 1.');
  eq(checkCodes.secidOf('430047'), '0.430047', 'secidOf 北交所 4xx → 0.（修复前错为 1.）');
  eq(checkCodes.secidOf('830799'), '0.830799', 'secidOf 北交所 8xx → 0.');
  eq(checkCodes.secidOf('920001'), '0.920001', 'secidOf 北交所 920x → 0.');
}

/* ════════════ #12 · 网络部分失败不静默 ════════════ */
console.log('\n#12 · screener.buildWarnings 显式告警（固话 P2-7）');
{
  const w = screener.buildWarnings({ yangFail: 3, avgFail: 0 });
  ok(w.length === 1 && /K线获取失败 3 只/.test(w[0]), 'K线失败 3 只 → warnings 含提示');
  const w2 = screener.buildWarnings({ yangFail: 2, avgFail: 5 });
  ok(w2.length === 2, '两类失败 → 两条 warnings');
  eq(screener.buildWarnings({ yangFail: 0, avgFail: 0 }).length, 0, '无失败 → 空 warnings');
}

/* ════════════ #6 · 晚报双结构一致性（源码级回归守卫） ════════════ */
console.log('\n#6 · health_check 双结构一致性判定为「完全一致」（固话 P2-1）');
{
  const hc = fs.readFileSync(path.join(ROOT, 'tools', 'health_check.js'), 'utf8');
  ok(/hot\.length\s*!==\s*tmr\.length/.test(hc), 'health_check.js 使用 !== 判定（要求完全一致）');
  ok(!/Math\.abs\(hot\.length\s*-\s*tmr\.length\)\s*>=\s*2/.test(hc), '不再使用宽松的 >= 2 判定');
  ok(/if \(r\.date === latestDate\) err\(/.test(hc), '最新一期不一致 → err（ERROR，非仅 WARN）');
  // 行为复核：等价纯逻辑，构造 5 vs 4
  const consistency = (hot, tmr) => (Array.isArray(hot) && Array.isArray(tmr) && tmr.length) && hot.length !== tmr.length;
  eq(consistency([1, 2, 3, 4, 5], [1, 2, 3, 4]), true, '5 vs 4 → 判不一致（修复前 diff=1 不报）');
  eq(consistency([1, 2, 3], [1, 2, 3]), false, '3 vs 3 → 一致');
}

/* ════════════ #13 · 消除分叉副本（文件存在性） ════════════ */
console.log('\n#13 · 分叉副本已消除（固话 P3-2/P3-3）');
{
  const legacy = path.join(ROOT, 'tools', '_test_health_logic.会话版.js');
  ok(!fs.existsSync(legacy), 'tools/_test_health_logic.会话版.js 已不存在');
}

/* ════════════ #14 · verify.markVerify 实盘口径（P0 回归守卫：q.close 缺陷） ════════════ */
console.log('\n#14 · verify.markVerify 开盘买入→收盘卖出（含 close；P0 q.close 回归守卫）');
{
  // 完整行情（含 close）：QA 实测 超声电子/华工科技 close=22.63 open=20.80 → buyRet=8.80 netRet=8.58
  const full = { code: '000823', name: '超声电子', gain: 3.1, price: 22.63, close: 22.63,
    open: 20.80, high: 22.63, low: 20.60, prevClose: 21.00 };
  const v = verify.markVerify(full, '2026-09-14');
  ok(v.note !== '停牌/无数据', '含 close 的完整行情 → 不走停牌分支（note=' + JSON.stringify(v.note) + '）');
  eq(v.buyRet, 8.80, 'buyRet = (22.63/20.80-1)*100 = 8.80');
  eq(v.netRet, 8.58, 'netRet（双边佣金万五+卖出印花千五）= 8.58');
  eq(v.openPct, -0.95, 'openPct = 相对昨收 (20.80/21.00-1)*100 = -0.95');
  eq(v.locked, false, '非一字板 → locked=false');
  eq(v.basis, 'open-to-close', 'basis=open-to-close');
  ok(typeof v.buyRet === 'number' && typeof v.netRet === 'number', 'buyRet/netRet 均为数值（不再恒走停牌）');

  // 缺 close → 必须走停牌分支（证明 close 是必需字段，不是死代码）
  const noClose = { code: '000823', name: '超声电子', gain: 3.1, price: 22.63,
    open: 20.80, high: 22.63, low: 20.60, prevClose: 21.00 };
  const v2 = verify.markVerify(noClose, '2026-09-14');
  eq(v2.note, '停牌/无数据', '缺 close → 停牌分支');
  eq(v2.hit, null, '缺 close → hit=null');

  // 一字板：开=高=低=收 → locked=true, netRet=null（统计剔除）
  const lockedQuote = { code: '600000', name: '某股', gain: 10, price: 11, close: 11,
    open: 11, high: 11, low: 11, prevClose: 10 };
  const v3 = verify.markVerify(lockedQuote, '2026-09-14');
  eq(v3.locked, true, '一字板 → locked=true');
  eq(v3.netRet, null, '一字板 → netRet=null（统计时剔除）');

  // findQuote 必须透传 close（防回归：map / return 又漏掉 close）
  const quotes = { '000823': { name: '超声电子', gain: 3.1, price: 22.63, close: 22.63,
    open: 20.80, high: 22.63, low: 20.60, prevClose: 21.00 } };
  const q1 = verify.findQuote(quotes, { code: '000823', name: '超声电子' });
  ok(q1 && q1.close === 22.63, 'findQuote 透传 close（name 精确匹配路径）');
  const q2 = verify.findQuote(quotes, { code: '000823', name: '改名了' });
  ok(q2 && q2.close === 22.63, 'findQuote 透传 close（code 兜底路径）');

  // 源码级守卫：fetchQuotes 的 map 必须含 close
  const vsrc = fs.readFileSync(path.join(ROOT, 'tools', 'verify.js'), 'utf8');
  ok(/close:\s*x\.f2/.test(vsrc), 'verify.js fetchQuotes map 含 close: x.f2');
}

/* ════════════ #15 · screener.loadScreenerFile 首次运行 vs 损坏（防静默覆盖历史） ════════════ */
console.log('\n#15 · screener.loadScreenerFile：文件缺失=首次运行；损坏=ABORT（绝不静默当首次运行）');
{
  eq(screener.loadScreenerFile(path.join(tmpDir, 'no-such-screener.js')), null,
    '文件缺失 → null（首次运行合法）');

  const bad = tmpFile('window.SCREENER = [broken', '.js');
  let t1 = null; try { screener.loadScreenerFile(bad); } catch (e) { t1 = e; }
  ok(t1 && t1.__abort, '解析失败 → 抛 __abort（顶层记 ALERT+exit2，不再静默当首次运行）');

  const noWin = tmpFile('var x = 1;', '.js');
  let t2 = null; try { screener.loadScreenerFile(noWin); } catch (e) { t2 = e; }
  ok(t2 && t2.__abort, 'window.SCREENER 缺失 → 抛 __abort（结构非法）');

  const good = tmpFile('window.SCREENER = ' +
    JSON.stringify([{ date: '2026-09-14', list: [] }]) + ';\n', '.js');
  const arr = screener.loadScreenerFile(good);
  ok(Array.isArray(arr) && arr.length === 1, '正常数组 → 原样返回（历史得以累积）');

  const legacy = tmpFile('window.SCREENER = ' +
    JSON.stringify({ date: '2026-09-14', list: [] }) + ';\n', '.js');
  const arr2 = screener.loadScreenerFile(legacy);
  ok(Array.isArray(arr2) && arr2.length === 1 && arr2[0].date === '2026-09-14',
    '旧单对象结构 → 包成 [obj]（兼容）');
}

/* ════════════ #16 · health_check screener 判定（空数组/解析失败 → ERROR） ════════════ */
console.log('\n#16 · health_check：screener 空数组 / 解析失败 → ERROR（量价 Tab 唯一数据源）');
{
  // health_check.js 顶层会立即执行体检并可能 process.exit，故此处用源码级守卫（同 #6 手法）
  const hc = fs.readFileSync(path.join(ROOT, 'tools', 'health_check.js'), 'utf8');
  ok(/screenerState\.state === 'parse-error'/.test(hc), '区分 parse-error 状态');
  ok(/err\(['"]dashboard\/screener\.js 解析失败/.test(hc), '解析失败 → err（ERROR，不再静默）');
  ok(/err\(['"]dashboard\/screener\.js 为空数组/.test(hc), '空数组 → err（ERROR，量价 Tab 会空）');
  ok(/screenerState\.state === 'missing'/.test(hc), '文件缺失仍走 notes（首次运行安全降级）');
}

/* ════════════ #17 · 规模闸门 screener 迁移豁免（显式且会消失） ════════════ */
console.log('\n#17 · ops.hasScreenerField / scaleBlocked + 双侧闸门源码守卫');
{
  eq(ops.hasScreenerField({ reports: [], screener: [] }), true, '含 screener 字段（数组）→ true');
  eq(ops.hasScreenerField({ reports: [], screener: {} }), true, '含 screener 字段（对象）→ true');
  eq(ops.hasScreenerField({ reports: [] }), false, '无 screener 字段 → false');
  eq(ops.hasScreenerField({ reports: [], screener: null }), false, 'screener:null → false');

  eq(ops.scaleBlocked(5, 0, 'screener'), true, 'screener 5 → 0 触发骤减（迁移完成后必须拦）');
  eq(ops.scaleBlocked(0, 0, 'screener'), false, '0 → 0 不拦（无基线）');

  // 复现双侧闸门的 screener 判定（与 ops.js cmdScaleGate / gh_push_api.js scaleGate 同一表达式）：
  //   豁免成立 = 基线仍带 screener 字段 且 本侧已删该字段（即一次「首次迁移」）
  const gateBlocks = function (baseData, curData) {
    const b2 = ops.readCounts(baseData), c2 = ops.readCounts(curData);
    const exempt = ops.hasScreenerField(baseData) && !ops.hasScreenerField(curData);
    return !exempt && ops.scaleBlocked(b2.screener, c2.screener, 'screener');
  };
  eq(gateBlocks({ screener: [1, 2, 3, 4, 5] }, {}), false,
    '用例1 首次迁移（基线带、本侧无字段）→ 放行（旧判据会永久拦截）');
  eq(gateBlocks({}, {}), false, '用例2 迁移完成（两侧都无字段、0→0）→ 放行');
  eq(gateBlocks({ screener: [1, 2, 3, 4, 5] }, { screener: [] }), true,
    '用例4 并存期真损坏（两侧都带字段、5→0）→ 拦截');
  eq(gateBlocks({ screener: [1, 2, 3, 4, 5] }, { screener: [1, 2, 3] }), true,
    '并存期真损坏（两侧都带字段、5→3）→ 拦截');

  const opsSrc = fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'ops.js'), 'utf8');
  const ghSrc = fs.readFileSync(path.join(ROOT, 'tools', 'gh_push_api.js'), 'utf8');
  ok(/hasScreenerField\(baseData\)/.test(opsSrc), 'ops.js 副闸用 hasScreenerField(baseData) 判「基线侧」');
  ok(/!hasScreenerField\(curData\)/.test(opsSrc), 'ops.js 副闸要求本侧已删该字段');
  ok(/hasScreenerField\(localD\)/.test(ghSrc), 'gh_push_api.js 主闸用 hasScreenerField(localD) 判「本侧」');
  ok(/remoteC\.hasScreener/.test(ghSrc), 'gh_push_api.js 主闸用远端 hasScreener 判「基线侧」');
  ok(!/screener\s*>\s*0\s*&&/.test(opsSrc), 'ops.js 已移除「c.screener > 0」无条件豁免');
  ok(!/screener\s*>\s*0\s*&&/.test(ghSrc), 'gh_push_api.js 已移除「localC.screener > 0」无条件豁免');
}

/* ════════════ #18 · dashboard/screener.js 期数闸门（搬家后新家也要有锁） ════════════ */
console.log('\n#18 · ops.screenerHistCount + screener.js 期数闸门（副闸/主闸同口径）');
{
  const sc = function (n) {
    const arr = [];
    for (let i = 0; i < n; i++) arr.push({ date: '2026-09-' + String(i + 1).padStart(2, '0'), list: [] });
    return 'window.SCREENER = ' + JSON.stringify(arr) + ';\n';
  };
  // screenerHistCount 纯函数
  eq(ops.screenerHistCount(sc(3)), 3, '3 期 → 3');
  eq(ops.screenerHistCount('window.SCREENER = [];\n'), 0, '空数组 → 0');
  eq(ops.screenerHistCount('window.SCREENER = {date:"x",list:[]};\n'), 1, '旧单对象结构 → 1 期');
  eq(ops.screenerHistCount('window.SCREENER = [broken'), null, '解析失败 → null');
  eq(ops.screenerHistCount('var x=1;'), null, 'window.SCREENER 缺失 → null');
  eq(ops.screenerHistCount(''), null, '空源码 → null');
  eq(ops.screenerHistCount(null), null, 'null 源码 → null');

  // 期数闸门判定（与 ops.js cmdScaleGate / gh_push_api.js scaleGate 同一表达式）
  const scGateBlocks = function (baseSrc, curSrc) {
    const bb = ops.screenerHistCount(baseSrc), cc = ops.screenerHistCount(curSrc);
    return bb != null && cc != null && ops.scaleBlocked(bb, cc, 'screenerHist');
  };
  eq(scGateBlocks(sc(10), sc(1)), true, 'screener.js 10 期 → 1 期 → 拦截');
  eq(scGateBlocks(sc(10), sc(10)), false, 'screener.js 10 → 10（正常滚动）→ 放行');
  eq(scGateBlocks(sc(0), sc(1)), false, 'screener.js 0 → 1（首次）→ 放行');
  eq(scGateBlocks(sc(2), sc(1)), false, 'screener.js 2 → 1（防误伤）→ 放行');
  eq(scGateBlocks(sc(5), sc(1)), true, 'screener.js 5 → 1 → 拦截');
  eq(scGateBlocks('window.SCREENER = [broken', sc(1)), false, '解析失败(null) → 闸门跳过（交 Fix#2a）');
  eq(scGateBlocks(null, sc(1)), false, '基线缺失（screener.js 不存在）→ 放行（首次）');

  // 源码守卫
  const opsSrc = fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'ops.js'), 'utf8');
  const ghSrc = fs.readFileSync(path.join(ROOT, 'tools', 'gh_push_api.js'), 'utf8');
  ok(/screenerHistCount\(gitShowHead\('dashboard\/screener\.js'\)\)/.test(opsSrc),
    'ops.js 副闸比对 HEAD:dashboard/screener.js 期数');
  ok(/remoteScreenerCount\(repo, remoteMap\['dashboard\/screener\.js'\]\)/.test(ghSrc),
    'gh_push_api.js 主闸取远端 dashboard/screener.js 期数');
}

/* ════════════ #19 · 断更检测时间边界（2026-09-15 修复：早间不把今天当既成事实） ════════════ */
console.log('\n#19 · gap_check.computeGaps：交易日早于 08:30 不报今天；08:30 起才检查今天');
{
  // 休市日样本（2026 年；09-25 中秋在 config/trade_holidays.json 内）
  const HY = { '2026': JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8')).years['2026'] };
  const D = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
  const reports = ['2026-09-10'];                       // 扫描起点 09-10（周四）
  const logAllButToday = (ds) => ds !== '2026-09-15';   // 历史都有日志，仅今天没有
  const hhmm = (now) => now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');

  // 交易日当天凌晨 / 早间（首个任务 08:30 尚未开始）→ 今天不得进入结果
  [D(2026, 9, 15, 0, 19), D(2026, 9, 15, 7, 0), D(2026, 9, 15, 8, 29)].forEach(function (now) {
    const g = gapCheck.computeGaps({ reportDates: reports, now: now, holidayYears: HY, hasLog: logAllButToday });
    eq(g.stalled.join(','), '', '交易日 ' + hhmm(now) + ' → stalled 为空（不报今天）');
    ok(g.stalled.indexOf('2026-09-15') < 0, '  ↑ 今天(09-15)不在 stalled');
  });

  // 08:30 起（到达最早任务时刻）→ 今天无数据且无日志 → 必须报今天（真停摆）
  [D(2026, 9, 15, 8, 30), D(2026, 9, 15, 8, 31), D(2026, 9, 15, 23, 0)].forEach(function (now) {
    const g = gapCheck.computeGaps({ reportDates: reports, now: now, holidayYears: HY, hasLog: logAllButToday });
    eq(g.stalled.join(','), '2026-09-15', '交易日 ' + hhmm(now) + ' → 报今天（管线未运行）');
  });

  // 历史交易日无数据无日志 → 行为不变（仍报）；有日志 → 进 skipped（数据源未发布，正常）
  {
    const hasLog = (ds) => ds === '2026-09-11';
    let g = gapCheck.computeGaps({ reportDates: reports, now: D(2026, 9, 15, 0, 19), holidayYears: HY, hasLog: hasLog });
    eq(g.stalled.join(','), '2026-09-14', '00:19 历史无日志日(09-14)仍报；今天(09-15)跳过');
    eq(g.skipped.join(','), '2026-09-11', '有日志的 09-11 进 skipped（未发布，属正常）');
    g = gapCheck.computeGaps({ reportDates: reports, now: D(2026, 9, 15, 23, 0), holidayYears: HY, hasLog: hasLog });
    eq(g.stalled.join(','), '2026-09-14,2026-09-15', '23:00 历史(09-14)与今天(09-15)都报');
  }

  // 周末 / 休市日 → 今天本就不是交易日，不报
  {
    const g1 = gapCheck.computeGaps({ reportDates: reports, now: D(2026, 9, 12, 10, 0), holidayYears: HY, hasLog: logAllButToday });
    ok(g1.stalled.indexOf('2026-09-12') < 0 && g1.skipped.indexOf('2026-09-12') < 0, '周六 09-12 不报今天');
    const g2 = gapCheck.computeGaps({ reportDates: ['2026-09-24'], now: D(2026, 9, 25, 10, 0), holidayYears: HY, hasLog: logAllButToday });
    ok(g2.stalled.indexOf('2026-09-25') < 0 && g2.skipped.indexOf('2026-09-25') < 0, '节假日 09-25 不报今天');
  }

  // 边界与纯函数细节
  eq(gapCheck.EARLIEST_TASK_MIN, 510, 'EARLIEST_TASK_MIN = 510（08:30，早报）');
  eq(gapCheck.isBeforeEarliestTask(D(2026, 9, 15, 8, 29)), true, 'isBeforeEarliestTask 08:29 → true（跳过今天）');
  eq(gapCheck.isBeforeEarliestTask(D(2026, 9, 15, 8, 30)), false, 'isBeforeEarliestTask 08:30 → false（到点即检查今天）');
  eq(gapCheck.isBeforeEarliestTask(D(2026, 9, 15, 8, 31)), false, 'isBeforeEarliestTask 08:31 → false');
  eq(gapCheck.computeGaps({ reportDates: [], now: D(2026, 9, 15, 10, 0), holidayYears: HY, hasLog: logAllButToday }).stalled.length, 0, '无 reports → 空结果（安全）');
  eq(gapCheck.isTradingDay(D(2026, 9, 12, 10, 0), HY), false, 'isTradingDay 周六 → false');
  eq(gapCheck.isTradingDay(D(2026, 9, 25, 10, 0), HY), false, 'isTradingDay 节假日 → false');
  eq(gapCheck.isTradingDay(D(2026, 9, 15, 10, 0), HY), true, 'isTradingDay 普通交易日 → true');

  // 源码守卫：health_check.js 断更检测已委派 gap_check，且不再有「固定扫到今天」的循环
  const hc = fs.readFileSync(path.join(ROOT, 'tools', 'health_check.js'), 'utf8');
  ok(/gapCheck\.computeGaps\(/.test(hc), 'health_check.js 断更检测委派 gap_check.computeGaps');
  ok(!/d <= today/.test(hc), 'health_check.js 不再用「d <= today」无条件纳入今天');
}

/* ════════════ #20 · merge_report（早报/晚报 JSON 中间件安全落盘） ════════════ */
console.log('\n#20 · merge_report：校验 / 合并 / 安全阀 / verify 保留 / 幂等与裁剪');
{
  const mr = require('./merge_report');
  // 包裹：所有落盘测试都把 WARN 日志写到临时目录，绝不污染仓库 logs/<date>.md
  const rawMerge = mr.mergeReport.bind(mr);
  const run = (kind, jf, f, opts) => rawMerge(kind, jf, f, Object.assign({ logDir: tmpDir }, opts || {}));

  const jsonFile = (obj) => tmpFile(JSON.stringify(obj, null, 2), '.json');
  const readData = (f) => JSON.parse(fs.readFileSync(f, 'utf8')
    .replace('window.REPORTS =', '').replace(/;\s*$/, ''));
  const fileText = (f) => fs.readFileSync(f, 'utf8');
  const reportsData = (dates) => 'window.REPORTS = ' + JSON.stringify({
    updatedAt: '', calendar: [], reports: dates.map((dt) => ({ date: dt }))
  }) + ';\n';

  // —— 合法样本构建器（字段名逐字取自 dashboard/data.js 真实数据）——
  function morningJson(over) {
    const j = {
      date: '2026-09-15', at: '2026-09-15 08:35',
      morning: {
        title: '9月15日开盘必读资讯', source: '韭研公社·开盘必读',
        sourceUrl: 'https://www.jiuyangongshe.com/a/20azl1mf7re',
        generatedAt: '2026-09-15 08:35',
        sections: {
          '要闻简讯': ['a', 'b', 'c', 'd', 'e'],
          '盘前人气股': { '韭研公社': 'x', '同花顺': 'y', '东方财富': 'z', '淘股吧': 'w' },
          '重点公告': ['p1', 'p2'],
          '今日新股': '今日无新股申购/上市安排'
        },
        '今日关注': [
          { name: '超声电子', code: '000823', sector: '覆铜板/PCB', status: '3板·中位·板块核心', reason: 'r' },
          { name: '中新赛克', code: '002912', sector: 'AI安全', status: '3板·中位·题材龙头', reason: 'r' }
        ]
      }
    };
    return Object.assign(j, over || {});
  }
  function tmrGroup(sector) {
    return { sector: sector, stage: '主升延续·最强主线', why: 'w', chain: 'c',
      picks: [{ name: '超声电子', code: '000823', role: '3板·板块最高身位',
        status: '3板·中位·板块情绪核心', reason: 'r' }] };
  }
  function hotItem(name) {
    return { name: name, strength: 'st', stocks: 'sk', catalyst: 'ca' };
  }
  function eveningJson(over) {
    const j = {
      date: '2026-09-15', at: '2026-09-15 21:05',
      evening: {
        sources: ['湖南人', '行鱼复盘'], generatedAt: '2026-09-15 21:05',
        '博主观点': [{ author: '行鱼复盘', view: 'v' }],
        '大盘概况': { summary: 's', metrics: [{ k: '上证指数', v: '3885.33', d: '-0.07%', up: false }] },
        '连板梯队': ['4板：闽东电力（...）'],
        '明日关注': [tmrGroup('PCB/覆铜板（CCL）')],
        '板块热点': [hotItem('PCB/覆铜板')]
      },
      calendar: [{ id: 'cal-new', title: 't', author: 'a', publishedAt: '2026-09-15 16:00',
        url: 'u', images: [], events: [] }]
    };
    return Object.assign(j, over || {});
  }

  // 1 正常合并（早报）
  {
    const f = tmpFile(dataSrc(0));
    run('morning', jsonFile(morningJson()), f, { now: '2026-09-15 08:35' });
    const d = readData(f);
    eq(d.reports.length, 1, '#20.1 早报合并：reports=1');
    eq(d.reports[0].date, '2026-09-15', '#20.1 早报合并：date 正确');
    eq(d.reports[0].morning['今日关注'].length, 2, '#20.1 早报合并：今日关注 2 条');
    eq(d.updatedAt, '2026-09-15 08:35', '#20.1 updatedAt 更新为 JSON.at');
  }

  // 2 正常合并（晚报，含 calendar）
  {
    const f = tmpFile(dataSrc(0));
    run('evening', jsonFile(eveningJson()), f, { now: '2026-09-15 21:05' });
    const d = readData(f);
    eq(d.reports.length, 1, '#20.2 晚报合并：reports=1');
    ok(!!d.reports[0].evening, '#20.2 晚报合并：含 evening');
    eq(d.calendar.length, 1, '#20.2 晚报合并：calendar 追加 1 篇');
    eq(d.calendar[0].id, 'cal-new', '#20.2 calendar 内容正确');
  }

  // 3 当日已有条目更新（不新增第 2 条）
  {
    const f = tmpFile('window.REPORTS = ' + JSON.stringify({
      updatedAt: '', calendar: [], reports: [{ date: '2026-09-15', morning: { '今日关注': [] } }]
    }) + ';\n');
    run('evening', jsonFile(eveningJson()), f, { now: '2026-09-15 21:05' });
    const d = readData(f);
    eq(d.reports.length, 1, '#20.3 同一条更新：仍是 1 条（不新增）');
    ok(!!d.reports[0].morning && !!d.reports[0].evening, '#20.3 同一条变 {date,morning,evening}');
  }

  // 4 规则17 条数不一致拒绝（H7）+ exit 3 + 文件未变
  {
    const bad = eveningJson();
    bad.evening['明日关注'] = [tmrGroup('A'), tmrGroup('B'), tmrGroup('C'), tmrGroup('D')];
    bad.evening['板块热点'] = [hotItem('A'), hotItem('B'), hotItem('C'), hotItem('D'), hotItem('E')];
    ok(mr.validate('evening', bad, {}).errors.some((e) => e.code === 'H7'), '#20.4 validate 命中 H7');
    const f = tmpFile(dataSrc(0));
    const before = fileText(f);
    let threw = null; try { run('evening', jsonFile(bad), f, {}); } catch (e) { threw = e; }
    ok(threw && threw.__validation, '#20.4 整体 exit 3（__validation）');
    eq(fileText(f), before, '#20.4 文件未变');
  }

  // 5 日期格式错误（H1）
  {
    const bad = morningJson({ date: '2026/09/15' });
    ok(mr.validate('morning', bad, {}).errors.some((e) => e.code === 'H1'), '#20.5 validate 命中 H1');
    const f = tmpFile(dataSrc(0));
    const before = fileText(f);
    let threw = null; try { run('morning', jsonFile(bad), f, {}); } catch (e) { threw = e; }
    ok(threw && threw.__validation, '#20.5 exit 3（__validation）');
    eq(fileText(f), before, '#20.5 文件未变');
  }

  // 6 幂等重复跑
  {
    const f = tmpFile(dataSrc(0));
    const jf = jsonFile(morningJson());
    run('morning', jf, f, { now: '2026-09-15 08:35' });
    const t1 = fileText(f);
    run('morning', jf, f, { now: '2026-09-15 08:35' });
    const t2 = fileText(f);
    eq(readData(f).reports.length, 1, '#20.6 幂等：第二次 reports 条数不变');
    eq(t1, t2, '#20.6 幂等：两次写入内容一致');
  }

  // 7 reports 超 7 裁剪（升序，最新在末尾）
  {
    const f = tmpFile(reportsData(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
      '2026-09-05', '2026-09-06', '2026-09-07']));
    run('morning', jsonFile(morningJson({ date: '2026-09-08' })), f, { now: '2026-09-08 08:35' });
    const d = readData(f);
    eq(d.reports.length, 7, '#20.7 超 7 → slice(-7) 保留 7');
    eq(d.reports[0].date, '2026-09-02', '#20.7 最旧（09-01）被裁');
    eq(d.reports[d.reports.length - 1].date, '2026-09-08', '#20.7 最新在末尾（升序）');
  }

  // 8 calendar 去重 + 保留5（降序）
  {
    const cal = [];
    for (let i = 1; i <= 5; i++) cal.push({ id: 'c' + i, title: 't', author: 'a',
      publishedAt: '2026-09-0' + i + ' 10:00', url: 'u', images: [], events: [] });
    const f = tmpFile('window.REPORTS = ' + JSON.stringify({ updatedAt: '', calendar: cal, reports: [] }) + ';\n');
    const j = eveningJson();
    j.calendar = [
      { id: 'c3', title: 't', author: 'a', publishedAt: '2026-09-03 10:00', url: 'u', images: [], events: [] },
      { id: 'new9', title: 't', author: 'a', publishedAt: '2026-09-09 10:00', url: 'u', images: [], events: [] }
    ];
    run('evening', jsonFile(j), f, { now: '2026-09-15 21:05' });
    const d = readData(f);
    eq(d.calendar.length, 5, '#20.8 去重 + 保留 5 篇');
    eq(d.calendar[0].id, 'new9', '#20.8 最新在最前（降序）');
    eq(new Set(d.calendar.map((x) => x.id)).size, 5, '#20.8 无重复 id');
    ok(d.calendar.every((x, i, a) => i === 0 || a[i - 1].publishedAt >= x.publishedAt),
      '#20.8 publishedAt 降序');
  }

  // 9 规模骤减 → 阀中止（9 → 7，暴露 baseline 传参：传 loaded.data 则此例会漏拦）
  {
    const f = tmpFile(reportsData(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
      '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']));
    const before = fileText(f);
    let threw = null;
    try { run('morning', jsonFile(morningJson({ date: '2026-09-10' })), f, {}); } catch (e) { threw = e; }
    ok(threw && threw.__abort, '#20.9 规模骤减 9→7 → __abort（exit 2）');
    eq(fileText(f), before, '#20.9 文件未变');
  }

  // 10 解析失败 → 阀中止
  {
    const f = tmpFile('window.REPORTS = { broken');
    let threw = null;
    try { run('morning', jsonFile(morningJson()), f, {}); } catch (e) { threw = e; }
    ok(threw && threw.__abort, '#20.10 data.js 解析失败 → __abort（exit 2）');
  }

  // 11 乐观锁冲突 → 阀中止
  {
    const f = tmpFile(dataSrc(0));
    let threw = null;
    try {
      run('morning', jsonFile(morningJson()), f, {
        now: '2026-09-15 08:35',
        __beforeSave: () => fs.appendFileSync(f, '\n// 被并发任务改过')
      });
    } catch (e) { threw = e; }
    ok(threw && threw.__abort, '#20.11 读后文件被篡改 → 乐观锁拦截（__abort）');
  }

  // 12 --dry 不落盘
  {
    const f = tmpFile(dataSrc(0));
    const before = fileText(f);
    run('morning', jsonFile(morningJson()), f, { dry: true, now: '2026-09-15 08:35' });
    eq(fileText(f), before, '#20.12 --dry 不落盘（文件未变）');
  }

  // 13 输入在 dashboard/ 下 → 拒绝（exit 1）
  {
    const f = tmpFile(dataSrc(0));
    let threw = null;
    try { run('morning', path.join('dashboard', 'x.json'), f, {}); } catch (e) { threw = e; }
    ok(threw && !threw.__abort && !threw.__validation, '#20.13 dashboard/ 路径 → 非阀中止非校验（→ exit 1）');
    ok(threw && /dashboard/.test(threw.message), '#20.13 错误信息明确拒绝 dashboard/');
  }

  // 14 code 非 6 位（H6）
  {
    const bad = morningJson();
    bad.morning['今日关注'][0].code = '0008';
    ok(mr.validate('morning', bad, {}).errors.some((e) => e.code === 'H6'), '#20.14 validate 命中 H6');
    const f = tmpFile(dataSrc(0));
    let threw = null; try { run('morning', jsonFile(bad), f, {}); } catch (e) { threw = e; }
    ok(threw && threw.__validation, '#20.14 exit 3');
  }

  // 15 H8 高板股缺口径词
  {
    const bad = morningJson();
    bad.morning['今日关注'][0].status = '5连板·核心';
    ok(mr.validate('morning', bad, {}).errors.some((e) => e.code === 'H8'), '#20.15 validate 命中 H8');
    const f = tmpFile(dataSrc(0));
    let threw = null; try { run('morning', jsonFile(bad), f, {}); } catch (e) { threw = e; }
    ok(threw && threw.__validation, '#20.15 exit 3');
  }

  // 16 verify 保留（早报 + 晚报）
  {
    const f = tmpFile('window.REPORTS = ' + JSON.stringify({
      updatedAt: '', calendar: [],
      reports: [{ date: '2026-09-15', morning: { '今日关注': [
        { name: '超声电子', code: '000823', sector: 'x', status: '3板·中位', reason: 'r',
          verify: { at: '2026-09-15', buyRet: 8.8, netRet: 8.58 } }
      ] } }]
    }) + ';\n');
    run('morning', jsonFile(morningJson()), f, { now: '2026-09-15 09:00' });
    const p = readData(f).reports[0].morning['今日关注'].find((x) => x.code === '000823');
    ok(p && p.verify && p.verify.buyRet === 8.8, '#20.16 早报 verify 保留（重跑不清零）');

    const f2 = tmpFile('window.REPORTS = ' + JSON.stringify({
      updatedAt: '', calendar: [],
      reports: [{ date: '2026-09-15', evening: { '明日关注': [
        { sector: 'A', stage: 's', why: 'w', chain: 'c', picks: [
          { name: '超声电子', code: '000823', role: 'r', status: '3板·中位', reason: 'rr',
            verify: { at: '2026-09-15', buyRet: 4.2 } }
        ] } ] } }]
    }) + ';\n');
    run('evening', jsonFile(eveningJson()), f2, { now: '2026-09-15 22:00' });
    const pick = readData(f2).reports[0].evening['明日关注'][0].picks[0];
    ok(pick.verify && pick.verify.buyRet === 4.2, '#20.16 晚报 picks verify 保留');
  }

  // 17 源码守卫
  {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'merge_report.js'), 'utf8');
    ok(/loadDataStrict\(/.test(src), '#20.17 源码含 loadDataStrict(');
    ok(/saveDataSafe\(/.test(src), '#20.17 源码含 saveDataSafe(');
    ok(/require\.main === module/.test(src), '#20.17 源码含 require.main === module 守卫');
    ok(!/fs\.writeFileSync\(\s*DATA/.test(src), '#20.17 无裸 fs.writeFileSync(DATA');
    ok(/saveDataSafe\(file, next, loaded, loaded\.src\)/.test(src), '#20.17 baseline 传整个 loaded（非 loaded.data）');
    ok(/slice\(-MAX\)/.test(src), '#20.17 reports 升序裁剪 slice(-MAX)');
    ok(/slice\(0, CAL_MAX\)/.test(src), '#20.17 calendar 降序裁剪 slice(0, CAL_MAX)');
  }

  // 18 metrics[].v 空值放宽（Fix #1，go-live 风险：09-11 晚报曾因 metrics v="" 被拒）
  {
    const j = eveningJson();
    j.evening['大盘概况'].metrics = [{ k: '上证指数', v: '3885.33' }, { k: '深证成指', v: '' }];
    const v = mr.validate('evening', j, {});
    ok(!v.errors.some((e) => e.code === 'H3'), '#20.18 metrics[].v 空 → 不再 H3 硬拦');
    ok(v.warnings.some((w) => w.code === 'W6'), '#20.18 metrics[].v 空 → 新增 WARN（W6）');
    const f = tmpFile(dataSrc(0));
    run('evening', jsonFile(j), f, { now: '2026-09-15 21:05' });
    const dd = readData(f);
    eq(dd.reports[0].evening['大盘概况'].metrics.length, 2, '#20.18 整体可写入（exit 0），指标 2 条落盘');

    // metrics[].k 为空 → 仍 H3 硬拦（只有名字没数值可接受，只有数值没名字不行）
    const j2 = eveningJson();
    j2.evening['大盘概况'].metrics = [{ k: '', v: '1' }];
    ok(mr.validate('evening', j2, {}).errors.some((e) => e.code === 'H3'), '#20.18 metrics[].k 为空 → 仍 H3 硬拦');
    const f2 = tmpFile(dataSrc(0));
    const before2 = fileText(f2);
    let threw = null; try { run('evening', jsonFile(j2), f2, {}); } catch (e) { threw = e; }
    ok(threw && threw.__validation, '#20.18 metrics[].k 空 → exit 3 拒写');
    eq(fileText(f2), before2, '#20.18 metrics[].k 空 → 文件未变');
  }

  // 19 CLI 层显式拒绝「data.js 不存在」（Fix #2：把隐式 ENOENT 保障变成显式契约）
  {
    const cp = require('child_process');
    const missing = path.join(tmpDir, 'no-such-data.js');
    const jf = jsonFile(morningJson());
    const alertFile = path.join(ROOT, 'logs', 'ALERT.md');
    const beforeAlert = fs.existsSync(alertFile) ? fs.readFileSync(alertFile, 'utf8') : '';
    const r = cp.spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'merge_report.js'), '--kind', 'morning', '--in', jf],
      { env: Object.assign({}, process.env, { ASTOCK_DATA_FILE: missing }), encoding: 'utf8' });
    eq(r.status, 1, '#20.19 data.js 不存在 → exit 1');
    ok(!fs.existsSync(missing), '#20.19 目标文件未被创建（默认拒绝，非默认修复）');
    ok(/data\.js 不存在/.test(r.stderr || ''), '#20.19 stderr 含明确拒绝文案');
    const afterAlert = fs.existsSync(alertFile) ? fs.readFileSync(alertFile, 'utf8') : '';
    eq(afterAlert, beforeAlert, '#20.19 未写 ALERT');
  }

  // 20 【回归】晚报缺 calendar 字段时，日历校验必须跳过（2026-09-23 事故 #1）
  //   事故：validateEvening 曾**无条件**调用 validateCalendar，而 calendar 是可选字段
  //   （只有日历源当天有新帖才带）→ json.calendar 为 undefined → H3「期望数组，实到 undefined」
  //   → 09-22 晚报连续 3 次合并全部失败，看门狗开 issue。
  //   ⚠️ 旧测试为什么没抓到：eveningJson() 夹具**总是带 calendar**，从未覆盖「字段缺失」路径。
  //   新增可选字段的校验时，必须同时断言「字段缺失」这条分支。
  {
    const j = eveningJson(); delete j.calendar;
    ok(!mr.validate('evening', j, {}).errors.some((e) => e.code === 'H3'),
      '#20.20 晚报缺 calendar 字段 → 不再 H3 硬拦（回归）');
    const f = tmpFile(dataSrc(0));
    run('evening', jsonFile(j), f, { now: '2026-09-15 21:05' });
    const d = readData(f);
    ok(!!d.reports[0].evening, '#20.20 整体可写入：evening 落盘');
    eq(d.calendar.length, 0, '#20.20 无 calendar 字段 → 日历数组保持空');

    // 显式传 [] 也应放行（语义=「本期确实没有日历更新」）
    ok(!mr.validate('evening', eveningJson({ calendar: [] }), {}).errors.some((e) => e.code === 'H3'),
      '#20.20 calendar 显式传 [] → 放行');
    // guard 不能把真错也放过：非数组仍须硬拦
    ok(mr.validate('evening', eveningJson({ calendar: 'oops' }), {}).errors.some((e) => e.code === 'H3'),
      '#20.20 calendar 传成字符串 → 仍 H3 硬拦');
    // calendar 渠道下该字段是必填，缺失必须 H3
    ok(mr.validate('calendar', { date: '2026-09-15' }, {}).errors.some((e) => e.code === 'H3'),
      '#20.20 kind=calendar 缺 calendar → 仍 H3（该渠道必填）');
  }

  // 21 【回归】H8 风险口径词必须认「炸板」（2026-09-23 事故 #2）
  //   事故：LLM 写「8天6板+炸板」被 H8 判违规 → 整份晚报拒写。
  //   而「炸板」在**同文件 POS_WORDS** 里本就被当作合法位置词，属内部自相矛盾。
  {
    const noH8 = (t) => {
      const j = eveningJson();
      j.evening['明日关注'][0].picks[0].status = t;
      return !mr.validate('evening', j, {}).errors.some((e) => e.code === 'H8');
    };
    ok(noH8('8天6板+炸板'), '#20.21 「8天6板+炸板」→ 不再 H8（回归）');
    ok(noH8('5板+炸板'), '#20.21 「5板+炸板」→ 不再 H8（回归）');
    ok(noH8('5板 高位 断板'), '#20.21 「5板 高位 断板」→ 放行');
    ok(noH8('5板+退潮'), '#20.21 「5板+退潮」→ 放行');
    // 闸门不得失效：完全没提风险仍须硬拦
    ok(!noH8('5板+传媒+华字辈'), '#20.21 「5板+传媒+华字辈」无风险词 → 仍 H8 硬拦');
    ok(!noH8('6板 中位 换手板'), '#20.21 「6板 中位 换手板」无风险词 → 仍 H8 硬拦');

    // 09-22 真实事故形态：**同时**缺 calendar 字段 + 高板股写「炸板」→ 必须 0 错误
    {
      const j = eveningJson(); delete j.calendar;
      j.evening['明日关注'][0].picks[0].status = '8天6板+炸板';
      const errs = mr.validate('evening', j, {}).errors;
      eq(errs.length, 0, '#20.21 09-22 事故形态（缺 calendar + 高板炸板）→ 0 错误（端到端回归）');
    }
  }
}

// 清理
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

console.log('\n' + '─'.repeat(58));
console.log(fail === 0
  ? '全部通过 ✅   共 ' + pass + ' 项断言'
  : '有 ' + fail + ' 项失败 ❌   通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
