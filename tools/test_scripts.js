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

// 清理
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

console.log('\n' + '─'.repeat(58));
console.log(fail === 0
  ? '全部通过 ✅   共 ' + pass + ' 项断言'
  : '有 ' + fail + ' 项失败 ❌   通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
