#!/usr/bin/env node
'use strict';
/**
 * 断更检测 / 交易日判定的可测纯逻辑（无 IO）
 *
 * 背景（AGENTS.md 规则 18）：本地模式下 `tools/health_check.js` 是唯一的停摆检测。
 * 它需要判断「某个交易日 reports 里没数据」到底是
 *   · 数据源当天没发内容（`logs/<日期>.md` 存在）→ 正常
 *   · 管线压根没跑（日志也没有）→ 真停摆
 *
 * ⚠️ 2026-09-15 修复：原实现把「今天」也纳入检查，导致交易日凌晨/早上
 *   （当天首个任务 08:30 还没开始）就误报「管线未运行」——每日 07:00 的体检任务
 *   会天天撞上这条假警报。现规定：当 now 早于当天最早任务时刻（早报 08:30）时，跳过今天。
 *
 * 抽出为独立模块的原因：`health_check.js` 顶层会立即执行体检并 `process.exit`，
 * 测试脚本无法 `require` 它；把这段判定抽成纯函数后，`test_scripts.js` 可直接断言。
 */
'use strict';

/** 当天最早任务时刻（分钟，自 00:00 起）= 早报 08:30。
 *  来源：本机 6 个定时任务中最早的是「早报」08:30；在它跑完之前，今天不该被视为
 *  「应已有数据」。注意这与前端 `dashboard/js/app.js` 的 `DUE` 是**两套**——
 *  `DUE` 只管前端文案与健康条（见 AGENTS.md 规则 19），本常量只管后端断更检测
 *  「今天是否已开始」。 */
const EARLIEST_TASK_MIN = 8 * 60 + 30;

/** 两位补零 */
function pad2(n) { return String(n).padStart(2, '0'); }

/** Date → 'yyyy-mm-dd'（本地时区） */
function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 是否交易日：周末排除 + 节假日（holidayYears = { "2026": ["2026-09-25", ...] }）排除。
 *  与 verify.js / health_check.js 同一口径（年份取字符串键，结构见 AGENTS.md 规则 16c）。 */
function isTradingDay(d, holidayYears) {
  const w = d.getDay();
  if (w === 0 || w === 6) return false;
  const list = (holidayYears && holidayYears[String(d.getFullYear())]) || [];
  return list.indexOf(fmtDate(d)) < 0;
}

/** now 是否早于当天最早任务时刻（默认 08:30）。
 *  严格小于：08:29 → true（跳过今天）；08:30 / 08:31 → false（检查今天）。 */
function isBeforeEarliestTask(now, earliestMin) {
  const min = (earliestMin == null) ? EARLIEST_TASK_MIN : earliestMin;
  return (now.getHours() * 60 + now.getMinutes()) < min;
}

/**
 * 断更检测核心（纯函数，不碰文件系统）。
 * @param {Object}   o
 * @param {string[]} o.reportDates  已有 reports 的日期（其 [0] 作为扫描起点，与旧实现一致）
 * @param {Date}     o.now          当前时刻
 * @param {Object}   o.holidayYears 休市日 { "2026": ["2026-09-25", ...] }
 * @param {Function} o.hasLog       (ds) => boolean：logs/<ds>.md 是否存在
 * @returns {{stalled: string[], skipped: string[]}}
 *   stalled —— 交易日无数据且无日志（管线未运行，需排查）
 *   skipped —— 交易日无数据但有日志（数据源未发布，正常）
 *   当 now 早于当天最早任务时刻（08:30）时，今天不出现在任一列表中。
 */
function computeGaps(o) {
  const reportDates = (o && o.reportDates) || [];
  if (!reportDates.length) return { stalled: [], skipped: [] };
  const now = (o && o.now) || new Date();
  const holidayYears = (o && o.holidayYears) || {};
  const hasLog = (o && o.hasLog) || function () { return false; };
  const skipToday = isBeforeEarliestTask(now);
  const todayStr = fmtDate(now);
  const have = new Set(reportDates);
  const first = new Date(reportDates[0] + 'T00:00:00');
  const gaps = [];
  for (let d = new Date(first); d <= now; d.setDate(d.getDate() + 1)) {
    if (!isTradingDay(d, holidayYears)) continue;
    const ds = fmtDate(d);
    if (have.has(ds)) continue;
    if (ds === todayStr && skipToday) continue;   // 当天首个任务尚未开始 → 今天不是既成事实
    gaps.push({ ds: ds, ran: !!hasLog(ds) });
  }
  return {
    stalled: gaps.filter(function (g) { return !g.ran; }).map(function (g) { return g.ds; }),
    skipped: gaps.filter(function (g) { return g.ran; }).map(function (g) { return g.ds; })
  };
}

module.exports = {
  EARLIEST_TASK_MIN: EARLIEST_TASK_MIN,
  fmtDate: fmtDate,
  isTradingDay: isTradingDay,
  isBeforeEarliestTask: isBeforeEarliestTask,
  computeGaps: computeGaps
};
