#!/usr/bin/env node
'use strict';
// 校正 dashboard/data.js 中 reports 数组顺序：
// 按 date 升序排列（旧 -> 新），最新在末尾；保留最近 MAX 条。
// 前端 app.js 依赖此顺序（idx = length-1 指向最新），乱序会导致默认显示旧日期。
//
// 2026-09-14 审计修复（P1-2 / 缺口 A）：
//   · 原先裸 `fs.writeFileSync(F, out)` 绕过安全阀 —— 现改用公共 data_store 的
//     loadDataStrict（解析失败即中止）+ saveDataSafe（规模骤减拦截 + 乐观锁）。
//   · 阀中止（规模骤减 / 解析失败 / 乐观锁冲突）时写 logs/ALERT.md 并 `process.exit(2)`，
//     供 bump_version.sh 识别为「硬中止」（不再被 `|| true` 静默吞掉）。
//
// 测试接缝：设环境变量 ASTOCK_DATA_FILE 可指向临时副本（bump_version.sh 不设，走默认真文件）。
const fs = require('fs');
const path = require('path');
const { loadDataStrict, saveDataSafe } = require('./lib/data_store');
const ops = require('./lib/ops');

const DATA = path.join(__dirname, '..', 'dashboard', 'data.js');
const MAX = 7;

/** 排序 + 裁剪 MAX 条并安全写回。任何安全阀中止会抛出带 __abort 标记的异常。 */
function sortReports(file) {
  file = file || DATA;
  const loaded = loadDataStrict(file);       // 解析失败 / 结构异常 → throw(__abort)
  const R = loaded.data;

  const before = (R.reports || []).map(function (x) { return x.date; }).join(',');
  R.reports.sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });
  if (R.reports.length > MAX) R.reports = R.reports.slice(-MAX);
  const after = R.reports.map(function (x) { return x.date; }).join(',');

  saveDataSafe(file, R, loaded, loaded.src);  // 规模骤减 / 并发修改 → throw(__abort)
  console.log('reports 重排: [' + before + ']  ->  [' + after + ']   (count=' + R.reports.length + ')');
  return R;
}

if (require.main === module) {
  try {
    sortReports(process.env.ASTOCK_DATA_FILE || DATA);
  } catch (e) {
    if (e && e.__abort) {
      // 安全阀主动中止：写告警 + 专用退出码 2（缺口 A）
      console.error(e.message);
      try {
        ops.appendAlert({
          stage: 'bump/sort_reports', result: 'ABORT', script: 'sort_reports.js',
          detail: e.message, fix: '人工确认 dashboard/data.js 是否被写坏；修复后重发', link: 'dashboard/data.js'
        });
      } catch (_) { /* 告警写入失败不叠加故障 */ }
      process.exitCode = 2;
    } else {
      console.error('✗ sort_reports 失败：' + ((e && e.stack) || e));
      process.exitCode = 1;
    }
  }
}

module.exports = { sortReports, MAX, DATA };
