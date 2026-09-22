#!/usr/bin/env node
'use strict';
/**
 * 数据读写安全阀（公共模块）—— loadDataStrict / saveDataSafe / abort / 跨进程文件锁。
 *
 * 背景（规则 16）：写入型脚本必须「解析失败即中止」+「规模骤减拦截」+「乐观锁防并发覆盖」。
 *   原先 verify.js / screener.js / check_codes.js 各抄一份（3 份重复，已见文案漂移），
 *   sort_reports.js 则完全没有。本模块把它们收敛为**单一定义**，阈值只改一处。
 *
 * 跨进程文件锁（2026-09-22 新增，根治「并发双写」）：
 *   场景：PC 关机后开机补跑时，主任务与看门狗同时醒，双方都在「load → 改 → save」
 *   data.js。乐观锁（saveDataSafe 的 srcAtRead 比对）能保证后写者不覆盖先写者，
 *   但代价是后写者整轮作废（抓取/计算全部白跑）。文件锁让后写者先**等待**，
 *   拿到锁后读到的是最新数据，从根上避免白跑与互相覆盖。
 *
 *   设计要点：
 *   · **锁是显式的，不藏在 loadDataStrict 里**：job_morning/job_evening 用 loadDataStrict
 *     做幂等读后会再子进程调 merge_report —— 若读时自动加锁，父进程会把自己的子进程
 *     锁死到超时。因此锁只给「load→save 全程无网络、毫秒级完成」的写入方
 *     （merge_report）显式使用；verify 这类 load→save 间隔数分钟网络抓取的脚本
 *     **有意不加跨段锁**（持锁数分钟会把并发任务堵到 45s 超时，比乐观锁更糟），
 *     继续由 saveDataSafe 的乐观锁兜底。
 *   · 锁文件放 os.tmpdir()（本机所有 node 进程共享），按目标文件路径哈希命名 ——
 *     不进仓库、不进 dashboard/ 发布目录，测试用的临时文件也不污染真实锁。
 *   · `wx` 独占创建 = 原子抢占；陈旧锁（>LOCK_STALE_MS，持锁进程崩溃后遗留）可接管。
 *   · 可重入：同进程多次 acquire 只持一把锁；saveDataSafe 顺手释放；
 *     「acquire 后未 save 就退出」由 process.on('exit') 兜底释放。
 *   · 等锁超时（默认 45s）→ abort 明确报错，绝不静默覆盖。
 *     可用环境变量 ASTOCK_LOCK_WAIT_MS 覆盖等待时长（测试用）。
 *
 * 依赖方向：本模块 require ./ops（取 scaleBlocked / SCALE / readCounts），
 *   不再反向依赖 —— 避免环。SCALE / readCounts 在这里**再导出**，兑现
 *   "阈值与计数在 data_store 可见" 的跨文件约定（消费者仍可从本模块取得）。
 *
 * 与 verify.js 旧实现保持逐字节相同的报错文案与行为，仅把阈值换成组合式（P2-2）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const crypto = require('crypto');
const ops = require('./ops');

const ROOT = path.resolve(__dirname, '..', '..');

/** data.js 的绝对路径（单点定义，避免各脚本各拼一次）。 */
function DATA_PATH() { return path.join(ROOT, 'dashboard', 'data.js'); }

/** 规模骤减阈值（从 ops 再导出，满足跨文件约定的「data_store 导出 SCALE」）。 */
const SCALE = ops.SCALE;

// ── 跨进程文件锁 ────────────────────────────────────────────────
const LOCK_STALE_MS = 10 * 60 * 1000;   // 陈旧锁接管阈值：持锁进程崩溃遗留 10 分钟后可接管
const LOCK_WAIT_MS = (function () {
  const n = parseInt(process.env.ASTOCK_LOCK_WAIT_MS || '', 10);
  return (n > 0 ? n : 45) * 1000;       // 默认等 45s；测试可用 ASTOCK_LOCK_WAIT_MS=1 缩短
})();
const heldLocks = new Map();            // 锁路径 → true（本进程持有的锁，用于可重入与退出释放）

/** 目标文件对应的锁文件路径（tmpdir + 路径哈希，跨进程一致）。 */
function lockPathFor(file) {
  const key = crypto.createHash('md5').update(path.resolve(file)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'astock-lock-' + key + '.lock');
}

function readLockInfo(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/** 同步睡眠（阻塞当前进程，用于等锁轮询）。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { /* 宿主不支持 Atomics.wait 时不等待（极端环境降级为忙轮询） */ }
}

/** 获取 file 的排他锁。同进程可重入；跨进程竞争时最多等 LOCK_WAIT_MS。 */
function acquireDataLock(file) {
  const p = lockPathFor(file);
  if (heldLocks.has(p)) return;                       // 可重入：同进程多次 load 不叠加
  const deadline = Date.now() + LOCK_WAIT_MS;
  let info = readLockInfo(p);
  for (;;) {
    const stale = !!info && (Date.now() - (info.ts || 0) > LOCK_STALE_MS);
    if (!info || stale) {
      if (stale) { try { fs.unlinkSync(p); } catch (e) { /* 被别人抢删也无妨 */ } }
      try {
        fs.writeFileSync(p, JSON.stringify({ pid: process.pid, ts: Date.now(), file: path.resolve(file) }),
          { flag: 'wx' });                            // O_EXCL：原子抢占，输者回到等待
        heldLocks.set(p, true);
        if (stale) console.log('· 检测到陈旧锁（>' + (LOCK_STALE_MS / 60000) + ' 分钟，疑似上次进程异常退出）→ 已接管');
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    if (Date.now() > deadline) {
      abort('✗ 等待文件锁超时（' + (LOCK_WAIT_MS / 1000) + 's，持锁 pid=' + (info && info.pid) +
        '）：另一个任务正在读写 ' + path.basename(file) +
        '，本次中止（未写任何文件）。稍后重跑本任务即可。');
    }
    sleepSync(300);
    info = readLockInfo(p);
  }
}

/** 释放 file 的锁（仅当本进程持有；锁内容不属于本进程时不删，防止误删他人的锁）。 */
function releaseDataLock(file) {
  const p = lockPathFor(file);
  if (!heldLocks.has(p)) return;
  const info = readLockInfo(p);
  if (info && info.pid === process.pid) { try { fs.unlinkSync(p); } catch (e) { /* 已被删则忽略 */ } }
  heldLocks.delete(p);
}

/** 进程退出兜底：load 了但没走到 saveDataSafe 就退出（幂等早退/校验失败/崩溃）→ 释放全部锁。
 *  只删自己 pid 的锁；极端崩溃（kill -9）由陈旧锁接管机制兜底。 */
process.on('exit', function () {
  heldLocks.forEach(function (v, p) {
    const info = readLockInfo(p);
    if (info && info.pid === process.pid) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }
  });
});

/** 中止执行：抛出可被顶层识别的中断信号。
 *  不用 process.exit(1) —— Windows 下管道输出是异步的，直接退出可能把报错信息截断，
 *  而这恰恰是运维最需要看到的内容。消息由顶层 catch 统一打印。 */
function abort(msg) {
  const e = new Error(msg);
  e.__abort = true;
  throw e;
}

/** 严格读取 data.js。任何异常都直接中止，绝不静默降级成空结构。
 *  返回值里的 reports0 / calendar0 是**读取当时的规模快照**（数字，不是引用）——
 *  调用方后面会就地改 data，用引用做基线会被自己的修改带跑，安全阀就永远不触发。
 *  注意：本函数**不加锁**（见文件头「锁是显式的」）—— job_morning/job_evening 用它做
 *  幂等读后还会子进程调 merge_report，若读时自动加锁，父进程会把自己的子进程锁死到超时。
 *  写入方需要跨段锁时，在调用本函数前显式 acquireDataLock(file)。 */
function loadDataStrict(file) {
  if (!fs.existsSync(file)) {
    return { data: { updatedAt: '', calendar: [], reports: [] }, src: '', reports0: 0, calendar0: 0 };
  }
  const src = fs.readFileSync(file, 'utf8');
  if (!/window\.REPORTS\s*=/.test(src)) {
    abort('✗ data.js 里找不到 `window.REPORTS =`，为避免清空看板历史，本次中止（未写任何文件）');
  }
  let data;
  try {
    // 用 vm 而不是 new Function/eval：语法错误会准确指到 data.js 自己的行号
    const ctx = { window: {} };
    vm.runInNewContext(src, ctx, { filename: 'dashboard/data.js' });
    data = ctx.window.REPORTS;
  } catch (e) {
    abort('✗ data.js 解析失败：' + e.message +
      '\n  为避免清空看板历史，本次中止（未写任何文件）。请先人工确认 dashboard/data.js 是否被写坏。');
  }
  if (!data || !Array.isArray(data.reports)) {
    abort('✗ data.js 结构异常（reports 不是数组），本次中止（未写任何文件）');
  }
  return {
    data: data,
    src: src,
    reports0: data.reports.length,
    calendar0: (data.calendar || []).length
  };
}

/** 写回前校验：① 历史不得骤减（组合阈值）② 文件不得被并发任务改过。
 *  baseline 传 loadDataStrict() 的**返回对象**（含 reports0 / calendar0 数字快照）。
 *  写成功后顺手释放跨段锁（未持锁的调用方如 test_scripts 直调 → 释放为无害空操作）。 */
function saveDataSafe(file, next, baseline, srcAtRead) {
  const afterN = (next.reports || []).length;
  const afterC = (next.calendar || []).length;
  const prevN = (baseline && typeof baseline.reports0 === 'number') ? baseline.reports0 : 0;
  const prevC = (baseline && typeof baseline.calendar0 === 'number') ? baseline.calendar0 : 0;

  if (ops.scaleBlocked(prevN, afterN, 'reports')) {
    abort('✗ reports 数量骤减（' + prevN + ' → ' + afterN +
      '），为避免清空看板历史，拒绝写回');
  }
  if (ops.scaleBlocked(prevC, afterC, 'calendar')) {
    abort('✗ calendar 数量骤减（' + prevC + ' → ' + afterC + '），拒绝写回');
  }
  // 乐观锁：读到这里之间文件被别的任务（早报/晚报/选股）改过 → 中止，别覆盖别人的成果
  const nowSrc = fs.readFileSync(file, 'utf8');
  if (nowSrc !== srcAtRead) {
    abort('✗ data.js 在本次运行期间被其他任务修改过（很可能是晚报/早报并发写），' +
      '为避免覆盖对方的改动，本次中止。请稍后重跑本任务。');
  }
  fs.writeFileSync(file, 'window.REPORTS = ' + JSON.stringify(next, null, 2) + ';\n');
  releaseDataLock(file);
}

module.exports = {
  SCALE, DATA_PATH, abort, loadDataStrict, saveDataSafe,
  lockPathFor, acquireDataLock, releaseDataLock,      // 锁原语导出（测试与特殊编排用）
  readCounts: ops.readCounts, parseDataSrc: ops.parseDataSrc
};
