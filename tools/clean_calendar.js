#!/usr/bin/env node
/**
 * 投资日历图片垃圾回收 —— 删除 dashboard/calendar/ 里没被 data.js 引用的孤儿图。
 *
 * 为什么需要它：
 *   · 晚报任务把日历原图下载到 dashboard/calendar/，命名规则 `<文章id>_img<N>.<ext>`。
 *   · data.js 的 calendar 数组只保留最近 5 篇，**裁掉的只是数据，磁盘图片从来不删**。
 *   · 结果：仓库和每次 Pages 部署体积无限增长（首批就有单张 5.9MB 的长图）。
 *   本脚本让"数据裁剪"和"文件回收"保持同步。
 *
 * 用法：
 *   node tools/clean_calendar.js             # 执行清理
 *   node tools/clean_calendar.js --dry-run   # 只报告，不删
 *   node tools/clean_calendar.js --quiet     # 安静模式（bump_version.sh 里用）
 *
 * 安全阀（宁可漏删，绝不误删）：
 *   1. data.js 解析不出 calendar，或 calendar 为空 → 直接退出，不删任何东西
 *   2. 引用集合为空 → 退出
 *   3. 只删 dashboard/calendar/ 目录下的图片扩展名文件，其他文件只告警不动
 *   4. 任何单文件删除失败都不影响其余，最后汇总
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DASH = path.join(ROOT, 'dashboard');
const CAL_DIR = path.join(DASH, 'calendar');
const DATA_JS = path.join(DASH, 'data.js');

const DRY = process.argv.includes('--dry-run');
const QUIET = process.argv.includes('--quiet');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg', '.bmp']);
const KB = (n) => (n / 1048576).toFixed(2) + 'MB';

function say(s) { if (!QUIET) console.log(s); }
function warn(s) { console.log(s); }

/** 取出 data.js 的 window.REPORTS */
function loadReports() {
  if (!fs.existsSync(DATA_JS)) return null;
  const src = fs.readFileSync(DATA_JS, 'utf8');
  try {
    return new Function('window', src + '\nreturn window.REPORTS;')({});
  } catch (e) {
    warn('✗ 解析 data.js 失败：' + e.message);
    return null;
  }
}

/** 收集 calendar 里引用的所有图片相对路径（统一成小写、正斜杠、不带 ./）
 *  2026-09-24：每个原图同时保留它的 `_prev.webp` 折叠预览（前端渲染时推导文件名，
 *  data.js 不写这个字段）—— 预览也要登记为"被引用"，否则回收步骤会把它当孤儿删掉
 *  （实测：第一次跑 bump_version 就把 10 张预览全清了）。 */
function collectReferenced(reports) {
  const set = new Set();
  const list = (reports && reports.calendar) || [];
  for (const c of list) {
    for (const img of (c && c.images) || []) {
      if (typeof img !== 'string') continue;
      const norm = img.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
      set.add(norm);
      set.add(norm.replace(/\.png$/, '_prev.webp'));
    }
  }
  return set;
}

function main() {
  if (!fs.existsSync(CAL_DIR)) {
    say('（dashboard/calendar/ 不存在，无需清理）');
    return;
  }

  const reports = loadReports();
  if (!reports) {
    warn('✗ 没读到 data.js 的 REPORTS，为安全起见不执行任何删除。');
    process.exitCode = 1;
    return;
  }

  const cal = reports.calendar || [];
  if (!cal.length) {
    warn('✗ calendar 数组为空，为安全起见不执行任何删除（可能是数据写坏了）。');
    process.exitCode = 1;
    return;
  }

  const referenced = collectReferenced(reports);
  if (!referenced.size) {
    warn('✗ calendar 里没有任何图片引用，为安全起见不执行任何删除。');
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(CAL_DIR).filter((f) => {
    return fs.statSync(path.join(CAL_DIR, f)).isFile();
  });

  const orphans = [];
  const foreign = [];
  let totalBefore = 0;
  let totalAfter = 0;

  for (const f of files) {
    const abs = path.join(CAL_DIR, f);
    const rel = ('calendar/' + f).toLowerCase();
    const bytes = fs.statSync(abs).size;
    totalBefore += bytes;

    if (!IMAGE_EXT.has(path.extname(f).toLowerCase())) {
      foreign.push(f);
      totalAfter += bytes;
      continue;
    }
    if (referenced.has(rel)) {
      totalAfter += bytes;
      continue;
    }
    orphans.push({ f, abs, bytes });
  }

  say('· calendar 引用图片 ' + referenced.size + ' 个，目录内文件 ' + files.length + ' 个');
  if (foreign.length) {
    warn('⚠️ 目录里有 ' + foreign.length + ' 个非图片文件，未处理（请人工确认）：' + foreign.join('、'));
  }

  if (!orphans.length) {
    say('✓ 无孤儿图，calendar/ 共 ' + KB(totalBefore));
    return;
  }

  let freed = 0;
  let failed = 0;
  for (const o of orphans) {
    if (DRY) {
      say('  [dry-run] 将删除 ' + o.f + '（' + KB(o.bytes) + '）');
      freed += o.bytes;
      continue;
    }
    try {
      fs.unlinkSync(o.abs);
      freed += o.bytes;
      say('  已删除 ' + o.f + '（' + KB(o.bytes) + '）');
    } catch (e) {
      failed++;
      warn('  ✗ 删除失败 ' + o.f + '：' + e.message);
    }
  }

  console.log('✓ 孤儿图 ' + orphans.length + ' 个，' +
    (DRY ? '预计释放 ' : '已释放 ') + KB(freed) +
    '（calendar/ ' + KB(totalBefore) + ' → ' + KB(totalAfter - freed) + '）' +
    (failed ? '  失败 ' + failed + ' 个' : ''));
}

main();
