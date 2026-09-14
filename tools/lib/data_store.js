#!/usr/bin/env node
'use strict';
/**
 * 数据读写安全阀（公共模块）—— loadDataStrict / saveDataSafe / abort。
 *
 * 背景（规则 16）：写入型脚本必须「解析失败即中止」+「规模骤减拦截」+「乐观锁防并发覆盖」。
 *   原先 verify.js / screener.js / check_codes.js 各抄一份（3 份重复，已见文案漂移），
 *   sort_reports.js 则完全没有。本模块把它们收敛为**单一定义**，阈值只改一处。
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
const ops = require('./ops');

const ROOT = path.resolve(__dirname, '..', '..');

/** data.js 的绝对路径（单点定义，避免各脚本各拼一次）。 */
function DATA_PATH() { return path.join(ROOT, 'dashboard', 'data.js'); }

/** 规模骤减阈值（从 ops 再导出，满足跨文件约定的「data_store 导出 SCALE」）。 */
const SCALE = ops.SCALE;

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
 *  调用方后面会就地改 data，用引用做基线会被自己的修改带跑，安全阀就永远不触发。 */
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
 *  baseline 传 loadDataStrict() 的**返回对象**（含 reports0 / calendar0 数字快照）。 */
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
}

module.exports = {
  SCALE, DATA_PATH, abort, loadDataStrict, saveDataSafe,
  readCounts: ops.readCounts, parseDataSrc: ops.parseDataSrc
};
