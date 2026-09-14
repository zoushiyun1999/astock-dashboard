#!/usr/bin/env node
'use strict';
/**
 * 运维公共模块（零依赖）—— 规模骤减闸门 / 数据快照 / 告警通道。
 *
 * 为什么集中在这里：
 *   · 「规模骤减闸门」有两个入口（publish.sh 副闸比 HEAD、gh_push_api.js 主闸比远端），
 *     必须用**同一个纯函数** `scaleBlocked()` 与**同一套阈值** `SCALE`，杜绝实现漂移
 *     （否则会出现"副闸放行、主闸拦截"的口径不一致）。
 *   · 「告警通道」`logs/ALERT.md` 是通知下线后唯一的失败出口（规则 18 本地模式全靠它）。
 *   · 「数据快照」`tools/backups/` 是回滚的第一道保险（P2-8）。
 *
 * 依赖方向：本模块**零本地依赖**（不 require data_store），是依赖图的最底层；
 *   data_store.js / gh_push_api.js 都 require 本模块。
 *
 * CLI（供 shell 调用）：
 *   node tools/lib/ops.js --scale-gate --against-head   # 副闸：工作区 data.js vs HEAD
 *   node tools/lib/ops.js --snapshot                    # 快照 HEAD 版 data.js（保留 7 份）
 *   node tools/lib/ops.js --list-open                   # 打印未闭环告警条数（单个数字）
 *   node tools/lib/ops.js --append-alert --stage S --detail D --fix F [--result R] [--script SC]
 *
 * 退出码：--scale-gate 触发闸门 = 1；其余 = 0。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');
const SC_FILE = path.join(ROOT, 'dashboard', 'screener.js');   // P2-4 后 screener 的真源
const BACKUP_DIR = path.join(ROOT, 'tools', 'backups');
const ALERT_FILE = path.join(ROOT, 'logs', 'ALERT.md');
const BACKUP_KEEP = 7;

/** 规模骤减阈值（跨文件共享约定，单点定义）。
 *  判定：after ≤ prev-(MAX_ABS_LOSS+1) 且 after < prev*MIN_KEEP_RATIO。
 *  校验：7→7✘｜7→6 不拦（仅降1）｜7→5 拦✔｜7→4 拦✔｜4→3 不拦✔｜4→2 拦✔。 */
const SCALE = { MIN_KEEP_RATIO: 0.8, MAX_ABS_LOSS: 1 };

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地时间戳：YYYY-MM-DD HH:mm */
function stampMin(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 文件名时间戳：YYYYMMDD-HHmmss */
function stampFile(d) {
  d = d || new Date();
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

/** 纯函数：规模骤减判定。prev==0（首期/无基线）直接放行。 */
function scaleBlocked(prev, after, varname) {
  if (typeof prev !== 'number' || typeof after !== 'number') return false;
  if (!(prev > 0)) return false;                                   // 首期写入 / 无基线
  if (after > prev - (SCALE.MAX_ABS_LOSS + 1)) return false;       // 降幅不足 2，放行
  if (!(after < prev * SCALE.MIN_KEEP_RATIO)) return false;        // 未跌破 80%，放行
  return true;
}

/** 统计 data 对象里的三处历史规模。screener 兼容数组与旧的单对象结构。 */
function readCounts(data) {
  const d = data || {};
  return {
    reports: Array.isArray(d.reports) ? d.reports.length : 0,
    calendar: Array.isArray(d.calendar) ? d.calendar.length : 0,
    screener: Array.isArray(d.screener) ? d.screener.length : (d.screener ? 1 : 0)
  };
}

/** 传入的 data.js 对象是否**仍带** screener 字段 —— 用于「停写 data.screener」迁移的**显式且会消失**的豁免判定。
 *  语义（判据必须看**基线/对照侧**，而不是只看工作区）：
 *   · 副闸：baseData = HEAD 版；curData = 工作区。主闸：远端 = 基线，local = 本侧。
 *   · 豁免成立 = **基线仍带 screener 字段** 且 **本侧已删该字段**  → 正是一次「首次迁移」，放行；
 *   · 其余一律照常进入 scaleBlocked：基线无字段 ⇒ 迁移已完成，归零照常拦；
 *     两侧都带字段却 5→0 ⇒ 迁移并未发生（真损坏 / 并存期损坏），也拦。
 *  这样「首次迁移自动放行、之后自动收紧」，且绝不会因工作区永不带该字段而**永久拦截**。 */
function hasScreenerField(data) {
  return !!data && typeof data === 'object' &&
    Object.prototype.hasOwnProperty.call(data, 'screener') &&
    data.screener != null;
}

/** 执行形如 `window.REPORTS = {...}` 的源码并取出对象；解析失败抛异常。 */
function parseDataSrc(src) {
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx, { filename: 'dashboard/data.js' });
  const d = ctx.window.REPORTS;
  if (!d || typeof d !== 'object') throw new Error('window.REPORTS 缺失或非对象');
  return d;
}

/** 读取 git HEAD 版指定文件（基线）；失败/文件不存在返回 null。 */
function gitShowHead(rel) {
  try {
    return execFileSync('git', ['show', 'HEAD:' + rel], {
      cwd: ROOT, maxBuffer: 64 * 1024 * 1024
    }).toString('utf8');
  } catch (e) {
    return null;
  }
}

/** 读取 git HEAD 版 dashboard/data.js（基线）；失败返回 null。 */
function gitShowHeadData() {
  return gitShowHead('dashboard/data.js');
}

/** 从 dashboard/screener.js 的源码里读出**历史期数**（window.SCREENER 数组长度）。
 *  · number = 期数（含 0）；
 *  · null   = 源码为空 / 解析失败 / window.SCREENER 非数组 → 无法判定，闸门侧**跳过**，
 *    不重复告警（这类损坏由 Fix #2a 的 loadScreenerFile / health_check 负责中止）。
 *  兼容旧的单对象结构（{date,list}）计为 1 期，与 readCounts 口径一致。 */
function screenerHistCount(src) {
  if (typeof src !== 'string' || !src.trim()) return null;
  try {
    const ctx = { window: {} };
    vm.runInNewContext(src, ctx, { filename: 'dashboard/screener.js' });
    const v = ctx.window.SCREENER;
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object' && Array.isArray(v.list)) return 1;
    return null;
  } catch (e) {
    return null;
  }
}

/* ───────────────────────── 告警通道 logs/ALERT.md ───────────────────────── */

/** 追加一条告警。条目格式（跨文件共享约定）：
 *  ## <YYYY-MM-DD HH:mm> | <OPEN/CLOSED/ABORT> | <脚本> | <阶段>
 *  - 详情：… / - 校验：… / - 处置：… / - 关联：…
 *  可选字段：script、check、link。result 缺省 OPEN。 */
function appendAlert(o) {
  o = o || {};
  const result = String(o.result || 'OPEN').toUpperCase();
  const script = o.script || o.stage || '-';
  const stage = o.stage || '-';
  const lines = [
    '## ' + stampMin() + ' | ' + result + ' | ' + script + ' | ' + stage,
    '- 详情：' + (o.detail || '-'),
    '- 校验：' + (o.check || '-'),
    '- 处置：' + (o.fix || '-'),
    '- 关联：' + (o.link || '-'),
    ''
  ];
  fs.mkdirSync(path.dirname(ALERT_FILE), { recursive: true });
  fs.appendFileSync(ALERT_FILE, lines.join('\n') + '\n');
  return true;
}

/** 列出「未闭环」告警条目（result 不为 CLOSED 的都算，含 OPEN/ABORT/FAIL）。
 *  健康检查据此报 ERROR；规则 18 本地模式下这是唯一的停摆检测。 */
function listOpen() {
  if (!fs.existsSync(ALERT_FILE)) return [];
  const txt = fs.readFileSync(ALERT_FILE, 'utf8');
  const out = [];
  txt.split(/\r?\n/).forEach(function (line) {
    if (line.indexOf('## ') !== 0) return;
    const parts = line.slice(3).split('|').map(function (s) { return s.trim(); });
    const result = (parts[1] || '').toUpperCase();
    if (result && result !== 'CLOSED') {
      out.push({ when: parts[0] || '', result: result, script: parts[2] || '', stage: parts[3] || '', raw: line });
    }
  });
  return out;
}

/* ───────────────────────── 数据快照 tools/backups/ ───────────────────────── */

/** 快照 HEAD 版 dashboard/data.js 到 tools/backups/，保留最近 7 份。
 *  best-effort：任何失败都只告警，不抛（不阻塞发布）。 */
function snapshotData() {
  try {
    const src = gitShowHeadData();
    if (src == null) { console.warn('⚠️ 快照跳过：无法读取 HEAD 版 data.js'); return null; }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, 'data.js.' + stampFile());
    fs.writeFileSync(file, src);
    const all = fs.readdirSync(BACKUP_DIR)
      .filter(function (f) { return /^data\.js\.\d{8}-\d{6}$/.test(f); })
      .sort();
    while (all.length > BACKUP_KEEP) {
      const old = all.shift();
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
    console.log('✔ 已快照 data.js → tools/backups/' + path.basename(file) +
      '（现保留 ' + all.length + ' 份）');
    return file;
  } catch (e) {
    console.warn('⚠️ 快照失败（不影响发布）：' + e.message);
    return null;
  }
}

/* ───────────────────────── CLI ───────────────────────── */

/** 副闸：工作区（已排序裁剪后的）data.js vs HEAD，跌幅超阈值即拦截。
 *  screener 字段被有意从 data.js 移除（迁到 dashboard/screener.js）→ after==0 不算骤减。 */
function cmdScaleGate() {
  if (process.env.ASTOCK_SKIP_GATE === '1') {
    console.log('⚠️ ASTOCK_SKIP_GATE=1 → 已旁路规模骤减闸门（紧急模式）');
    return 0;
  }
  const baseSrc = gitShowHeadData();
  if (baseSrc == null) { console.log('· 无 HEAD 基线（首次发布？）→ 跳过规模闸门'); return 0; }

  let baseData;
  try { baseData = parseDataSrc(baseSrc); }
  catch (e) { console.log('⚠️ HEAD 版 data.js 解析失败 → 跳过闸门（不阻断发布）：' + e.message); return 0; }

  let curData;
  try { curData = parseDataSrc(fs.readFileSync(DATA, 'utf8')); }
  catch (e) {
    const detail = '工作区 data.js 解析失败：' + e.message;
    console.error('✗ ' + detail);
    appendAlert({ stage: 'publish/副闸(HEAD)', result: 'OPEN', script: 'ops.js', detail: detail, fix: '人工确认 dashboard/data.js；修复后重发', link: 'dashboard/data.js' });
    return 1;
  }

  const b = readCounts(baseData), c = readCounts(curData);
  const blocked = [];
  ['reports', 'calendar'].forEach(function (k) {
    if (scaleBlocked(b[k], c[k], k)) blocked.push(k + ' ' + b[k] + ' → ' + c[k]);
  });
  // screener「迁移豁免」：显式且会消失 —— 仅当**基线(HEAD)仍带 screener 字段**且**工作区已删该字段**
  // （正是一次「首次迁移」）时才豁免；其余一律照常 scaleBlocked。
  // 反例（必须拦）：两侧都带字段却 5→0 = 迁移没发生 / 并存期损坏。
  // 判据看**基线侧**，否则工作区一旦删字段就永不复原 → 会永久拦截量价任务。
  const screenerExempt = hasScreenerField(baseData) && !hasScreenerField(curData);
  if (!screenerExempt && scaleBlocked(b.screener, c.screener, 'screener')) {
    blocked.push('screener ' + b.screener + ' → ' + c.screener);
  }

  // screener.js（P2-4 后的**真源**）期数闸门：搬了家，锁也得跟着搬。
  // 与 data.js 同一套 scaleBlocked / 同一阈值；解析失败(null) 交由 Fix#2a 处理，闸门侧不重复报。
  // 口径与主闸（gh_push_api.js 比远端 screener.js）完全一致，避免「副闸放行、主闸拦截」漂移。
  const baseSC = screenerHistCount(gitShowHead('dashboard/screener.js'));
  const curSC = screenerHistCount(fs.existsSync(SC_FILE) ? fs.readFileSync(SC_FILE, 'utf8') : null);
  if (baseSC != null && curSC != null && scaleBlocked(baseSC, curSC, 'screenerHist')) {
    blocked.push('screener.js ' + baseSC + ' → ' + curSC + ' 期');
  }

  if (blocked.length) {
    const detail = '规模骤减（HEAD → 工作区）：' + blocked.join('；');
    console.error('✗ ' + detail);
    appendAlert({ stage: 'publish/副闸(HEAD)', result: 'OPEN', script: 'ops.js', detail: detail, fix: '确认 data.js 是否被写坏；确属正常请用 ASTOCK_SKIP_GATE=1 旁路后重发', link: 'tools/backups/' });
    return 1;
  }
  console.log('✔ 规模闸门通过（reports ' + b.reports + '→' + c.reports +
    '，calendar ' + b.calendar + '→' + c.calendar + '，screener ' + b.screener + '→' + c.screener + '）');
  return 0;
}

function mainCli() {
  const argv = process.argv.slice(2);
  const get = function (name) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] || '') : ''; };
  let rc = 0;
  if (argv.includes('--scale-gate')) {
    rc = cmdScaleGate();
  } else if (argv.includes('--snapshot')) {
    snapshotData();
  } else if (argv.includes('--list-open')) {
    console.log(listOpen().length);
  } else if (argv.includes('--append-alert')) {
    appendAlert({
      stage: get('--stage'), result: get('--result') || 'OPEN', script: get('--script'),
      detail: get('--detail'), fix: get('--fix'), link: get('--link')
    });
    console.log('已写入告警 logs/ALERT.md');
  } else {
    console.log('用法: node tools/lib/ops.js (--scale-gate --against-head | --snapshot | --list-open | --append-alert --stage S --detail D --fix F)');
  }
  process.exit(rc);
}

if (require.main === module) mainCli();

module.exports = {
  SCALE, scaleBlocked, readCounts, hasScreenerField, parseDataSrc,
  gitShowHead, gitShowHeadData, screenerHistCount,
  appendAlert, listOpen, snapshotData,
  ROOT, DATA, SC_FILE, BACKUP_DIR, ALERT_FILE, BACKUP_KEEP
};
