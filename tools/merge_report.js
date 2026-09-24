#!/usr/bin/env node
'use strict';
/**
 * merge_report.js —— 早报/晚报「JSON 中间件 → 安全落盘」中间件（阶段 1：纯新增，不改 automation）。
 *
 * 背景（规则 16 / 评审 P1-2）：
 *   早报（08:30）与晚报（21:00）原先由 Agent 直接 Edit/Write 改 `dashboard/data.js`，
 *   完全绕过项目规则要求的统一安全阀。本脚本把职责拆开：
 *     Agent 只写结构化 JSON（项目根 tmp_*.json）→ 本脚本校验 → 合并 → 走统一安全阀落盘。
 *
 * 结构完全对齐参考样板 `tools/sort_reports.js`：
 *   · 接公共安全阀（`lib/data_store.js` 的 loadDataStrict / saveDataSafe）
 *   · 专用退出码（0 成功｜1 用法/IO/JSON 语法｜2 安全阀中止｜3 内容校验失败）
 *   · 硬失败写 `logs/ALERT.md`；WARN 只 stdout + 当日 `logs/<date>.md`（绝不写 ALERT）
 *   · `require.main === module` 守卫 + 可测接缝（`ASTOCK_DATA_FILE` 环境变量 / 纯函数）
 *
 * 用法：
 *   node tools/merge_report.js --kind morning --in tmp_morning_2026-09-15.json
 *   node tools/merge_report.js --kind evening --in tmp_evening_2026-09-15.json [--dry] [--date YYYY-MM-DD]
 *
 * 测试接缝：`ASTOCK_DATA_FILE` 指向临时副本即可测试（不设则写真文件 dashboard/data.js）；
 *   `ASTOCK_LOG_DIR` 覆盖 WARN 落日志的目录（默认仓库 `logs/`）。
 *
 * ⚠️ 三条硬要求（漏了不报错，务必对照）：
 *   1. §3.4 `verify` 标记必须保留（重跑补跑时按 code/name 回填旧 verify）
 *   2. §5 `saveDataSafe` 的 baseline 必须传 loadDataStrict() 返回的**整个对象**
 *   3. §3.2/§3.3 reports 升序（slice(-7)）与 calendar 降序（slice(0,5)）方向相反
 */
const fs = require('fs');
const path = require('path');
const { loadDataStrict, saveDataSafe, acquireDataLock, releaseDataLock } = require('./lib/data_store');   // 复用统一安全阀
const ops = require('./lib/ops');                                        // ALERT 通道 + stampMin

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');
const MAX = 7;          // reports 保留条数（与 sort_reports.js:20 一致）
const CAL_MAX = 5;      // calendar 保留篇数（AGENTS.md 规则 14）

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^\d{6}$/;
// 三段式启发式：命中「板数 token」...
const BOARD_WORDS = /(\d+\s*连?板|首板|连板|涨停)/;
// ...以及「位置词」之一
const POS_WORDS = /(首板|低位|中位|高位|退潮|主升|高潮|反抽|分歧|一字|未启动|启动|加速|补涨|轮动|分化|龙头|断板|炸板|退潮段|情绪核心)/;
// H8 高板股（≥5 板）必须写明的风险口径词。
// ⚠️ 必须包含「炸板」—— 它在**同一个文件的 POS_WORDS** 里已被认作合法位置词，
//    而且是 A 股描述「盘中涨停被打开」的标准术语，语义上比「断板」更精确。
//    2026-09-23 事故：LLM 写「8天6板+炸板」被 H8 判违规 → 整份晚报合并失败。
// 放宽到「明确劝退」的整组词：只要 status 里出现任一个，就说明模型做了风险表态。
// 注意这不会让闸门失效 —— 像「5板+传媒+华字辈」这种**完全没提风险**的写法仍然会被拦下。
const RISK_WORDS = /(高位|断板|不参与|炸板|跌停|退潮|风险|警惕|谨慎|勿追|回避)/;

/* ─────────────────────────── 通用小工具 ─────────────────────────── */

function isStr(x) { return typeof x === 'string'; }
function nonEmpty(x) { return isStr(x) && x.trim().length > 0; }
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function isArr(x) { return Array.isArray(x); }

function typeOf(x) {
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  if (x === undefined) return 'undefined';
  return typeof x;
}

/** 当日日期串（YYYY-MM-DD）；供 validate 的 W4 判断用，保持 validate 纯函数特性。 */
function todayStamp(d) { return ops.stampMin(d || new Date()).slice(0, 10); }

/* ─────────────────────────── 参数解析 ─────────────────────────── */

/** 解析 CLI 参数；任何非法用法直接 throw（顶层映射为 exit 1）。 */
function parseArgs(argv) {
  const out = { kind: '', input: '', dry: false, date: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') { out.kind = argv[++i] || ''; }
    else if (a === '--in') { out.input = argv[++i] || ''; }
    else if (a === '--dry') { out.dry = true; }
    else if (a === '--date') { out.date = argv[++i] || ''; }
    else {
      throw new Error('✗ 未知参数：' + a +
        '\n用法：node tools/merge_report.js --kind morning|evening|calendar --in <tmp_*.json> [--dry] [--date YYYY-MM-DD]');
    }
  }
  if (out.kind !== 'morning' && out.kind !== 'evening' && out.kind !== 'calendar') {
    throw new Error('✗ --kind 必须是 morning / evening / calendar，实到 "' + out.kind + '"');
  }
  if (!out.input) {
    throw new Error('✗ 缺少必填参数 --in <path>（JSON 中间件路径）');
  }
  if (out.date && !DATE_RE.test(out.date)) {
    throw new Error('✗ --date 格式错误：期望 YYYY-MM-DD，实到 "' + out.date + '"');
  }
  return out;
}

/* ─────────────────────────── 内容校验（纯函数，无 IO） ─────────────────────────── */

/** 从 status 解析连板数：匹配 N连板 / N板，取最大数字 N；无则 0。 */
function boardCount(status) {
  const s = String(status == null ? '' : status);
  const re = /(\d+)\s*连?板/g;
  let max = 0, m;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/** 必填非空字符串（H3）。 */
function reqStr(errors, p, val) {
  if (!nonEmpty(val)) {
    errors.push({ code: 'H3', msg: '✗ [' + p + '] 必填但为空。期望：非空字符串；实到：' +
      JSON.stringify(val === undefined ? null : val) + '。' });
    return false;
  }
  return true;
}

/** ⑤ 自动修补（方案 A）：≥5 板缺风险词的 picks/关注股 → status 追加「高位」并打标记。
 *  幂等：先按键（code 优先，否则 name）收集，再按同一键在两个列表中回填 —— 因为
 * 校验（validate）与落盘（applyToData）之间没有共享对象，keys 是唯一的桥梁。
 *  @returns {Array<{key:string, from:string, to:string}>} 修补明细（供日志）
 */
function autoTagHighBoards(json, keys) {
  const applied = [];
  if (!isArr(keys) || !keys.length) return applied;
  const keySet = new Set(keys);
  const lists = [];
  // morning（形态 A）：扁平今日关注
  if (json && isObj(json.morning) && isArr(json.morning['今日关注'])) {
    lists.push(json.morning['今日关注']);
  }
  // evening（形态 B）：明日关注[].picks
  if (json && isObj(json.evening) && isArr(json.evening['明日关注'])) {
    json.evening['明日关注'].forEach(function (g) {
      if (g && isArr(g.picks)) lists.push(g.picks);
    });
  }
  lists.forEach(function (list) {
    list.forEach(function (p) {
      if (!isObj(p)) return;
      const k = nonEmpty(p.code) ? p.code : (nonEmpty(p.name) ? p.name : '');
      if (!k || !keySet.has(k)) return;
      if (RISK_WORDS.test(String(p.status || ''))) return;   // 手工已补（或本轮回填过）→ 跳过
      const from = String(p.status == null ? '' : p.status);
      p.status = autoTagHighBoard(from);
      p.statusAutoTagged = true;
      applied.push({ key: k, from: from, to: p.status });
    });
  });
  return applied;
}

/** 必填非空数组（H4）。返回是否为「非空数组」。 */
function reqArr(errors, p, val, hint) {
  if (!isArr(val) || val.length === 0) {
    errors.push({ code: 'H4', msg: '✗ [' + p + '] 为空数组。期望：≥1 条' +
      (hint ? '（' + hint + '）' : '') + '；实到：' + (isArr(val) ? 0 : typeOf(val)) + ' 条。' });
    return false;
  }
  return true;
}

/** code 校验：非空必须 6 位数字（H6）；空/缺 → W2（交由 check_codes.js 回填）。 */
function checkCode(errors, warnings, p, code) {
  if (!nonEmpty(code)) {
    warnings.push({ code: 'W2', msg: '⚠️ [' + p + '] 为空/缺失，将由 check_codes.js --fix 回填（规则 5）——本步不拦写。' });
    return;
  }
  if (!CODE_RE.test(code)) {
    errors.push({ code: 'H6', msg: '✗ [' + p + '] 必须为 6 位数字，实到 "' + code + '"。' });
  }
}

/** ⑤ 候选标记：给 5 板缺风险词的 status 追加「高位」，返回新串。
 *  幂等 —— 已含风险词则原样返回（调用方应先判 RISK_WORDS）。 */
function autoTagHighBoard(status) {
  const s = String(status == null ? '' : status);
  const tag = '高位';
  // 已有感叹号/分隔结尾就直接接「高位」，否则补一个「+」保持可读
  if (/[+·、,，/]$/.test(s) || s === '') return s + tag;
  return s + '+' + tag;
}

/**
 * status 规则：H8 高板股口径词（**自动修补 + WARN**，不再硬失败）+ W1 三段式（警告）。
 *
 * 🔴 2026-09-23 决策（方案 A）：`n >= 5` 缺风险词时，**只告警不拦写**，由 applyToData 落盘前
 *    自动补「高位」。理由（两次真实停摆都源于此条硬门槛）：
 *      · 09-22：LLM 写「8天6板+炸板」，风险词表不含「炸板」→ 整份晚报被拒；
 *      · 更早：5 板股写「5板+传媒+华字辈」（纯描述、无表态）→ 同样整份被拒。
 *    事实是：**"该不该劝退" 是内容判断，不该由正则决定一份晚报的生死**。校验层该守的是
 *    「结构与安全」（H1~H7），而不是替模型做措辞取舍。故这里降级为「标注 + 自动补词」：
 *      · 保留信号 —— WARN 会落 logs/<date>.md，且 status 里被显式加上「高位」，
 *        前端与人工复盘都能一眼看出这是机器补的（见 `statusAutoTagged` 标记）；
 *      · 保留威慑 —— prompts.js 仍要求模型自己写风险词，WARN 是提示它下一期写好。
 *    ⚠️ 守卫：只在 n>=5 触发；`n<5` 的普通票不受任何影响。
 * @returns {boolean} 是否发生了自动修补（调用方据此打 `statusAutoTagged`）
 */
function checkStatus(errors, warnings, p, status, ctx) {
  if (!nonEmpty(status)) return false;   // 必填检查已覆盖
  const n = boardCount(status);
  let tagged = false;
  if (n >= 5 && !RISK_WORDS.test(status)) {
    warnings.push({ code: 'W7', msg: '⚠️ [' + p + '] ' + n + ' 板以上个股未写风险口径（实到 "' + status +
      '"）。**已放行并自动补「高位」**，不拦写；下期请在 status 里自行写明（高位/断板/不参与/炸板…）。' +
      (ctx ? '（' + ctx + '）' : '') });
    tagged = true;
  }
  const hasBoard = BOARD_WORDS.test(status);
  const hasPos = POS_WORDS.test(status);
  if (!hasBoard || !hasPos) {
    warnings.push({ code: 'W1', msg: '⚠️ [' + p + '] status 建议同时体现「板数 / 位置 / 特征」（实到 "' +
      status + '"）——仅提示，不拦写。' });
  }
  return tagged;
}

/** W3 条数超出建议区间（仅提示）。 */
function rangeWarn(warnings, p, len, lo, hi) {
  if (len < lo || len > hi) {
    warnings.push({ code: 'W3', msg: '⚠️ [' + p + '] 条数 ' + len + ' 超出建议区间 ' + lo + '–' + hi + '（仅提示，不拦写）。' });
  }
}

/** 早报（形态 A）校验。 */
function validateMorning(json, res, opts) {
  const E = res.errors, W = res.warnings;
  if (!isObj(json.morning)) {
    E.push({ code: 'H2', msg: '✗ 缺少顶层 "morning" 对象，实到 ' + typeOf(json.morning) + '。' });
    return;
  }
  const m = json.morning;
  reqStr(E, 'morning.title', m.title);
  reqStr(E, 'morning.source', m.source);
  reqStr(E, 'morning.sourceUrl', m.sourceUrl);

  if (!isObj(m.sections)) {
    E.push({ code: 'H3', msg: '✗ [morning.sections] 必填但缺失或非对象，实到 ' + typeOf(m.sections) + '。' });
  } else {
    const s = m.sections;
    if (reqArr(E, 'morning.sections.要闻简讯', s['要闻简讯'], '盘前要闻简讯')) {
      rangeWarn(W, 'morning.sections.要闻简讯', s['要闻简讯'].length, 5, 12);
    }
    if (!isObj(s['盘前人气股'])) {
      E.push({ code: 'H3', msg: '✗ [morning.sections.盘前人气股] 必填但缺失或非对象，实到 ' + typeOf(s['盘前人气股']) + '。' });
    }
    reqArr(E, 'morning.sections.重点公告', s['重点公告'], '重点公告');
    if (s['今日新股'] !== undefined && !isStr(s['今日新股'])) {
      E.push({ code: 'H3', msg: '✗ [morning.sections.今日新股] 期望字符串，实到 ' + typeOf(s['今日新股']) + '。' });
    }
  }

  if (reqArr(E, 'morning.今日关注', m['今日关注'], '早报重点关注个股')) {
    rangeWarn(W, 'morning.今日关注', m['今日关注'].length, 6, 10);
    m['今日关注'].forEach(function (p, i) {
      const base = 'morning.今日关注[' + i + ']';
      if (!isObj(p)) { E.push({ code: 'H5', msg: '✗ [' + base + '] 必须是对象，实到 ' + typeOf(p) + '。' }); return; }
      reqStr(E, base + '.name', p.name);
      reqStr(E, base + '.sector', p.sector);
      reqStr(E, base + '.status', p.status);
      reqStr(E, base + '.reason', p.reason);
      checkCode(E, W, base + '.code', p.code);
      if (checkStatus(E, W, base + '.status', p.status, 'name=' + (p.name || '?') + ' code=' + (p.code || '?'))) {
        res.autoTagKeys.push(nonEmpty(p.code) ? p.code : (nonEmpty(p.name) ? p.name : ''));
      }
    });
  }
}

/** 投资日历条目校验（独立通道 kind='calendar' 专用，亦被 validateEvening 复用）。
 *  calendar 数组是**顶层独立数据**，与 reports / evening 解耦：
 *   · id 必填（幂等去重键）
 *   · title/author/publishedAt/url 仅 WARN（展示字段，缺失不拦写）
 *   · images / events 若存在则须为数组（主展示是 images 长图，events 可选） */
function validateCalendar(json, res) {
  const E = res.errors, W = res.warnings;
  const list = json.calendar;
  if (!isArr(list)) {
    E.push({ code: 'H3', msg: '✗ [calendar] 期望数组，实到 ' + typeOf(list) + '。' });
    return;
  }
  list.forEach(function (c, i) {
    const base = 'calendar[' + i + ']';
    if (!isObj(c)) { E.push({ code: 'H5', msg: '✗ [' + base + '] 必须是对象，实到 ' + typeOf(c) + '。' }); return; }
    reqStr(E, base + '.id', c.id);
    ['title', 'author', 'publishedAt', 'url'].forEach(function (f) {
      if (!nonEmpty(c[f])) W.push({ code: 'W5', msg: '⚠️ [' + base + '.' + f + '] 建议非空（日历条目展示字段）。' });
    });
    if (c.images !== undefined && !isArr(c.images)) {
      E.push({ code: 'H3', msg: '✗ [' + base + '.images] 期望数组，实到 ' + typeOf(c.images) + '。' });
    }
    if (c.events !== undefined && !isArr(c.events)) {
      E.push({ code: 'H3', msg: '✗ [' + base + '.events] 期望数组，实到 ' + typeOf(c.events) + '。' });
    }
  });
}

/** 晚报（形态 B）校验。 */
function validateEvening(json, res, opts) {
  const E = res.errors, W = res.warnings;
  if (!isObj(json.evening)) {
    E.push({ code: 'H2', msg: '✗ 缺少顶层 "evening" 对象，实到 ' + typeOf(json.evening) + '。' });
    return;
  }
  const ev = json.evening;

  // 博主观点
  if (reqArr(E, 'evening.博主观点', ev['博主观点'], '博主观点')) {
    ev['博主观点'].forEach(function (b, i) {
      const base = 'evening.博主观点[' + i + ']';
      if (!isObj(b)) { E.push({ code: 'H5', msg: '✗ [' + base + '] 必须是对象，实到 ' + typeOf(b) + '。' }); return; }
      reqStr(E, base + '.author', b.author);
      reqStr(E, base + '.view', b.view);
    });
  }

  // 大盘概况
  if (!isObj(ev['大盘概况'])) {
    E.push({ code: 'H3', msg: '✗ [evening.大盘概况] 必填但缺失或非对象，实到 ' + typeOf(ev['大盘概况']) + '。' });
  } else {
    const d = ev['大盘概况'];
    reqStr(E, 'evening.大盘概况.summary', d.summary);
    if (reqArr(E, 'evening.大盘概况.metrics', d.metrics, '大盘指标')) {
      d.metrics.forEach(function (x, i) {
        const base = 'evening.大盘概况.metrics[' + i + ']';
        if (!isObj(x)) { E.push({ code: 'H5', msg: '✗ [' + base + '] 必须是对象，实到 ' + typeOf(x) + '。' }); return; }
        reqStr(E, base + '.k', x.k);
        // 🟡 metrics[].v：指标数值抓不到只是「内容缺失」，不影响报告可用性 → 降为 WARN，不拦写。
        //   边界：校验的目的是防【数据结构与安全】问题（规则 17 条数一致性 / 日期格式 / code 合法性 /
        //   必填对象缺失），**不是苛求内容完整**。真实历史里 09-11 晚报 metrics 的深证成指/创业板指
        //   曾抓不到值（v=""），若硬拦会导致「当天没有晚报」——这是校验过严引发停摆的头号现实触发点。
        //   故此处放行；但 metrics[].k（指标名）仍硬拦：只有名字没数值可以接受，只有数值没名字不行。
        if (!nonEmpty(x.v)) {
          W.push({ code: 'W6', msg: '⚠️ [' + base + '.v] 指标值（' + (nonEmpty(x.k) ? x.k : '?') +
            '）为空/缺失，已放行不拦写（内容缺失，不影响报告可用性）。' });
        }
        // d / up 可选（up 可为 null）
      });
    }
  }

  // 可选字段：类型若存在则须正确
  if (ev['连板梯队'] !== undefined && !isArr(ev['连板梯队'])) {
    E.push({ code: 'H3', msg: '✗ [evening.连板梯队] 期望字符串数组，实到 ' + typeOf(ev['连板梯队']) + '。' });
  }
  if (ev['市场情绪'] !== undefined && !isStr(ev['市场情绪'])) {
    E.push({ code: 'H3', msg: '✗ [evening.市场情绪] 期望字符串，实到 ' + typeOf(ev['市场情绪']) + '。' });
  }
  if (ev.sources !== undefined && !isArr(ev.sources)) {
    E.push({ code: 'H3', msg: '✗ [evening.sources] 期望字符串数组，实到 ' + typeOf(ev.sources) + '。' });
  }
  if (ev.links !== undefined && !isObj(ev.links)) {
    E.push({ code: 'H3', msg: '✗ [evening.links] 期望对象，实到 ' + typeOf(ev.links) + '。' });
  }

  // 明日关注
  let tmrLen = 0;
  if (reqArr(E, 'evening.明日关注', ev['明日关注'], '明日主线板块')) {
    tmrLen = ev['明日关注'].length;
    rangeWarn(W, 'evening.明日关注', tmrLen, 4, 8);
    ev['明日关注'].forEach(function (g, i) {
      const base = 'evening.明日关注[' + i + ']';
      if (!isObj(g)) { E.push({ code: 'H5', msg: '✗ [' + base + '] 必须是对象，实到 ' + typeOf(g) + '。' }); return; }
      reqStr(E, base + '.sector', g.sector);
      reqStr(E, base + '.stage', g.stage);
      reqStr(E, base + '.why', g.why);
      reqStr(E, base + '.chain', g.chain);
      if (!isArr(g.picks)) {
        E.push({ code: 'H5', msg: '✗ [' + base + '.picks] 必填且必须是数组（允许空数组），实到 ' + typeOf(g.picks) + '。' });
      } else {
        g.picks.forEach(function (p, j) {
          const pb = base + '.picks[' + j + ']';
          if (!isObj(p)) { E.push({ code: 'H5', msg: '✗ [' + pb + '] 必须是对象，实到 ' + typeOf(p) + '。' }); return; }
          reqStr(E, pb + '.name', p.name);
          reqStr(E, pb + '.role', p.role);
          reqStr(E, pb + '.status', p.status);
          reqStr(E, pb + '.reason', p.reason);
          checkCode(E, W, pb + '.code', p.code);
          if (checkStatus(E, W, pb + '.status', p.status, 'name=' + (p.name || '?') + ' code=' + (p.code || '?'))) {
            res.autoTagKeys.push(nonEmpty(p.code) ? p.code : (nonEmpty(p.name) ? p.name : ''));
          }
        });
      }
    });
  }

  // 板块热点
  if (reqArr(E, 'evening.板块热点', ev['板块热点'], '晚报板块热点')) {
    ev['板块热点'].forEach(function (x, i) {
      const base = 'evening.板块热点[' + i + ']';
      if (!isObj(x)) { E.push({ code: 'H5', msg: '✗ [' + base + '] 必须是对象，实到 ' + typeOf(x) + '。' }); return; }
      reqStr(E, base + '.name', x.name);
      reqStr(E, base + '.strength', x.strength);
      reqStr(E, base + '.stocks', x.stocks);
      reqStr(E, base + '.catalyst', x.catalyst);
      // kind（2026-09-24 新增，可选）：行业/概念 分类，供热点板块页分组。
      // 🔴 可选字段守卫：缺失不告警（历史数据没有此字段）；值非法只 W 不拦 —— 内容判断不拦写。
      if (x.kind !== undefined && x.kind !== null && x.kind !== '行业' && x.kind !== '概念') {
        W.push({ code: 'W8', msg: '⚠️ [' + base + '.kind] 应为「行业」或「概念」，实到「' + x.kind +
          '」—— 已放行，热点板块页会把它归入「全部」。' });
      }
    });
    // H7 规则 17：条数严格相等（仅当 明日关注 > 0，与 health_check.js:258 同口径）
    if (tmrLen > 0 && ev['板块热点'].length !== tmrLen) {
      E.push({ code: 'H7', msg:
        '✗ [evening.板块热点] 条数与 [evening.明日关注] 不一致：\n' +
        '   期望：两者条数严格相等；实到：板块热点=' + ev['板块热点'].length + ' 条、明日关注=' + tmrLen + ' 条。\n' +
        '   原因：它们描述的是同一批板块（短线 Tab 用「明日关注」，晚报 Tab 用「板块热点」），\n' +
        '        条数不等会让两个 Tab 显示不同板块数。\n' +
        '   修法：把「板块热点」增/删到与「明日关注」相同的 ' + tmrLen + ' 条；每条字段为\n' +
        '        {name, strength, stocks, catalyst}（name 用 sector 简称）。' });
    }
  }

  // calendar（可选，仅晚报可带）—— 复用独立校验函数。
  // 🔴 2026-09-23 事故（务必保留这个 guard）：这里曾**无条件**调用 validateCalendar，
  //    而 calendar 是可选字段（只有日历源当天有新帖才带）。于是任何不带日历的晚报
  //    都会被 H3「期望数组，实到 undefined」拦死 —— 09-22 晚报连续三次合并失败全部由此引起。
  //    日历源一两周才发一篇，绝大多数晚报都不带该字段，所以这个 bug 的命中率接近 100%。
  //    判据必须是 `!== undefined`：允许显式传 [] （表示「本期确实没有日历更新」），
  //    只把「字段完全缺失」当作正常情况跳过。
  if (json.calendar !== undefined) validateCalendar(json, res);
}

/**
 * 纯函数：只校验，无 IO。返回 { errors: [{code,msg}], warnings: [{code,msg}] }。
 * @param {'morning'|'evening'} kind
 * @param {object} json  待校验的 JSON 中间件
 * @param {{today?:string}} [opts] today 用于 W4（不传则跳过 W4，保持纯函数）
 */
function validate(kind, json, opts) {
  opts = opts || {};
  const res = { errors: [], warnings: [], autoTagKeys: [] };
  if (!isObj(json)) {
    res.errors.push({ code: 'H2', msg: '✗ JSON 顶层必须是对象，实到 ' + typeOf(json) + '。' });
    return res;
  }
  // H1 date 格式
  if (!isStr(json.date) || !DATE_RE.test(json.date)) {
    res.errors.push({ code: 'H1', msg: '✗ [date] 格式错误：期望 YYYY-MM-DD，实到 ' + JSON.stringify(json.date) + '。请改写 date。' });
  }
  if (kind === 'morning') validateMorning(json, res, opts);
  else if (kind === 'evening') validateEvening(json, res, opts);
  else if (kind === 'calendar') validateCalendar(json, res);

  // W4 date 非今天
  if (opts.today && isStr(json.date) && DATE_RE.test(json.date) && json.date !== opts.today) {
    res.warnings.push({ code: 'W4', msg: '⚠️ [date] ' + json.date + ' 不是今天（' + opts.today + '），补跑/跨日可忽略（不拦写）。' });
  }
  return res;
}

/* ─────────────────────────── 合并（纯函数：仅依赖传入 data + 时间） ─────────────────────────── */

/** 顶层 calendar 数组合并：幂等去重（按 id）+ 降序（最新在最前）+ 封顶 CAL_MAX。
 *  被 evening 分支（叠加日历）与 calendar 独立通道（孤立更新）复用。 */
function mergeCalendar(R, list) {
  if (!isArr(list) || !list.length) return;
  list.forEach(function (c) {
    if (!c || !nonEmpty(c.id)) return;
    if (!R.calendar.some(function (x) { return x && x.id === c.id; })) R.calendar.push(c);
  });
  R.calendar.sort(function (a, b) {
    const pa = (a && a.publishedAt) || '';
    const pb = (b && b.publishedAt) || '';
    return pa < pb ? 1 : pa > pb ? -1 : 0;
  });
  if (R.calendar.length > CAL_MAX) R.calendar = R.calendar.slice(0, CAL_MAX);
}



/** 建立「code|name → verify」索引（同一 pick 可能两者都在）。 */
function verifyIndex(items) {
  const m = new Map();
  (items || []).forEach(function (p) {
    if (!p || !p.verify) return;
    if (nonEmpty(p.code)) m.set('code:' + p.code, p.verify);
    if (nonEmpty(p.name)) m.set('name:' + p.name, p.verify);
  });
  return m;
}

/** 🔴 保留旧 verify（硬要求 §3.4）：按 code（空则 name）匹配，命中则回填到新 pick。 */
function restoreVerify(newItems, oldItems) {
  if (!isArr(newItems) || !newItems.length) return;
  const idx = verifyIndex(oldItems);
  if (!idx.size) return;
  newItems.forEach(function (p) {
    if (!p || p.verify) return;                 // 新数据自带 verify 则不覆盖
    let v = null;
    if (nonEmpty(p.code)) v = idx.get('code:' + p.code);
    if (!v && nonEmpty(p.name)) v = idx.get('name:' + p.name);
    if (v) p.verify = v;
  });
}

/** 把晚报「明日关注[]」下的所有 picks 展平（验证标记按 code/name 全局唯一，展平即可）。 */
function flattenPicks(ev) {
  const out = [];
  ((ev && ev['明日关注']) || []).forEach(function (g) {
    ((g && g.picks) || []).forEach(function (p) { out.push(p); });
  });
  return out;
}

/**
 * 纯函数：把一份 JSON 合并进 data，返回 next（就地改 data）。
 * 写入语义见设计 §3.2 / §3.3 / §3.4。
 * @param {object} data    loadDataStrict 返回的 data（就地修改）
 * @param {'morning'|'evening'} kind
 * @param {object} json
 * @param {string} nowStamp 兜底时间戳（YYYY-MM-DD HH:mm）
 */
function applyToData(data, kind, json, nowStamp) {
  const R = data;
  const date = json.date;
  const at = json.at || nowStamp;

  if (!isArr(R.reports)) R.reports = [];
  if (!isArr(R.calendar)) R.calendar = [];

  // 🔴 日历独立通道：只刷新顶层 calendar 数组，绝不触碰 reports / evening。
  //   用于「博客两源无帖、但投资日历博主发了新帖」的孤立更新，避免为更新日历而写空 evening。
  if (kind === 'calendar') {
    mergeCalendar(R, json.calendar);
    R.updatedAt = at;
    return R;
  }

  const rec = R.reports.find(function (r) { return r && r.date === date; });

  if (kind === 'morning') {
    const morning = json.morning;
    // 保留旧 verify（重跑/补跑不得清零）
    if (rec && rec.morning) restoreVerify(morning['今日关注'], rec.morning['今日关注']);
    if (rec) rec.morning = morning;                 // 已有当日条目：只更新 morning，保留 evening
    else R.reports.push({ date: date, morning: morning });
  } else {
    const evening = json.evening;
    if (rec && rec.evening) restoreVerify(flattenPicks(evening), flattenPicks(rec.evening));
    if (rec) rec.evening = evening;                 // 已有当日条目：只更新 evening，保留 morning
    else R.reports.push({ date: date, evening: evening });
  }

  // ⚠️ 规模阀边界（Fix #3，如实记录、非 Bug）：saveDataSafe 的 reports/calendar 规模骤减阀只能拦
  //   【本次运行自身造成的缩减】，**不是历史丢失探测器**。因本函数已把 reports 封顶 MAX(7)、
  //   calendar 封顶 CAL_MAX(5)，故 reports 只有「读入 ≥ 9」才可能触发（calendar 需 ≥ 7），
  //   健康文件日常永不触发。真实的历史截断/丢期检测由 health_check.js 的断更检测负责，勿在此重复实现。
  // 🔴 reports 升序（newest-at-bottom）：sort 后 slice(-MAX)。禁止 slice(0,MAX)（会切掉最新一条）。
  R.reports.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  if (R.reports.length > MAX) R.reports = R.reports.slice(-MAX);

  // 🔴 calendar 降序（最新在最前）：与 reports 方向相反。仅 evening 携带时叠加到顶层数组。
  if (kind === 'evening' && isArr(json.calendar) && json.calendar.length) {
    mergeCalendar(R, json.calendar);
  }

  // 顶层 updatedAt 必须更新（规则 26）
  R.updatedAt = at;
  return R;
}

/* ─────────────────────────── 编排 ─────────────────────────── */

/** 追加 WARN 到当日 logs/<date>.md（best-effort，绝不写 ALERT）。 */
function appendDailyLog(logDir, date, lines) {
  if (!lines.length) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, date + '.md'), lines.join('\n') + '\n');
  } catch (_) { /* 日志写入失败不叠加故障 */ }
}

function emitWarnings(warnings) {
  warnings.forEach(function (w) { console.warn(w.msg); });
}

/**
 * 编排：读 JSON → 校验 → loadDataStrict → applyToData → saveDataSafe。
 * @param {'morning'|'evening'} kind
 * @param {string} jsonPath  JSON 中间件路径（相对 process.cwd() 解析）
 * @param {string} file      目标 data.js 路径
 * @param {{dry?:boolean,date?:string,logDir?:string,now?:string,__beforeSave?:Function}} [opts]
 */
function mergeReport(kind, jsonPath, file, opts) {
  opts = opts || {};

  // 1) 读 JSON
  const abs = path.resolve(process.cwd(), jsonPath);
  const rel = path.relative(ROOT, abs);
  if (rel === 'dashboard' || rel.indexOf('dashboard' + path.sep) === 0) {
    throw new Error('✗ --in 不允许指向 dashboard/ 目录（该目录整体上公网，违反规则 2）：' + abs);
  }
  if (!fs.existsSync(abs)) throw new Error('✗ 输入文件不存在：' + abs);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); }
  catch (e) { throw new Error('✗ 读取输入文件失败：' + e.message); }
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('✗ JSON 解析失败：' + e.message + '（文件：' + abs + '）'); }
  if (!isObj(json)) throw new Error('✗ JSON 顶层必须是对象，实到 ' + typeOf(json));

  // --date 覆盖（默认以 JSON 内 date 为准）
  if (opts.date) json.date = opts.date;

  // 2) 内容校验（不拦写，只收集 WARN + 自动修补键）→ 真有 H 级错误才 exit 3
  const v = validate(kind, json, { today: todayStamp() });

  // 2.1) 🔧 方案 A 自动修补：≥5 板缺风险词 → status 追加「高位」+ `statusAutoTagged` 标记。
  //      必须在「校验之后、applyToData 之前」执行：此刻 json 尚未进 data，
  //      改的是中间件本身，落盘的就是修补后的内容，不需要回写 tmp_*.json。
  //      注意 autoTagKeys 收集的是**键**（code 优先 / name 兜底），因为 validate 与
  //      applyToData 不共享对象引用 —— 键是二者之间唯一的桥梁。
  const tagged = autoTagHighBoards(json, v.autoTagKeys);
  tagged.forEach(function (t) {
    console.warn('🔧 自动修补 [' + t.key + '] status：' + t.from + '  →  ' + t.to + '（已标 statusAutoTagged）');
  });

  if (v.errors.length) {
    const e = new Error(v.errors.map(function (x) { return x.msg; }).join('\n'));
    e.__validation = true;
    e.__kind = kind;
    throw e;
  }

  // 3) 严格读（解析失败 / 结构异常 → __abort）
  //    🔒 跨进程文件锁：本函数 load→save 之间无网络请求（毫秒级），适合跨段持锁 ——
  //    并发场景（开机补跑时主任务与看门狗同时跑 merge_report）下，后到者先等锁、
  //    拿到后读到最新数据再合并，替代「乐观锁发现被改 → 整轮作废」。持锁期间若
  //    校验失败/dry 提前返回，锁由 dry 分支的显式释放或 process.on('exit') 兜底释放。
  //    注意：loadDataStrict 本身不加锁（job_* 用它做幂等读后还会子进程调本脚本）。
  acquireDataLock(file);
  let loaded;
  try { loaded = loadDataStrict(file); }
  catch (e) { if (e && e.__abort) e.__kind = kind; throw e; }

  // 4) 内存合并
  const nowStamp = opts.now || ops.stampMin();
  const next = applyToData(loaded.data, kind, json, nowStamp);

  const prevN = loaded.reports0, afterN = (next.reports || []).length;
  const prevC = loaded.calendar0, afterC = (next.calendar || []).length;
  const dateList = (next.reports || []).map(function (r) { return r.date; }).join(',');

  const summary = (opts.dry ? '（dry-run，未落盘）' : '') +
    'merge_report[' + kind + '] ' + json.date +
    ' | reports ' + prevN + '→' + afterN + '（dates: ' + dateList + '）' +
    ' | calendar ' + prevC + '→' + afterC +
    ' | 自动修补:' + tagged.length +
    ' | warnings:' + v.warnings.length;

  if (opts.dry) {
    releaseDataLock(file);          // dry 不落盘 → 显式还锁（正常写回路径由 saveDataSafe 释放）
    console.log('✔ ' + summary);
    emitWarnings(v.warnings);
    return next;
  }

  // 5) 安全写回 —— 🔴 baseline 必须是 loadDataStrict() 返回的【整个对象】loaded
  //    （传 loaded.data 会让 baseline.reports0 恒 undefined → 规模阀永不触发；上一轮实际踩过）
  if (typeof opts.__beforeSave === 'function') opts.__beforeSave(file);
  try { saveDataSafe(file, next, loaded, loaded.src); }
  catch (e) { if (e && e.__abort) e.__kind = kind; throw e; }

  console.log('✔ ' + summary);
  emitWarnings(v.warnings);
  // WARN 只落当日 logs/<date>.md，绝不写 ALERT（设计 §4.5 定稿）
  if (v.warnings.length || tagged.length) {
    const logDir = opts.logDir || path.join(ROOT, 'logs');
    const lines = ['', '## ' + ops.stampMin() + ' | merge_report[' + kind + '] WARN',
      '- 文件：' + path.basename(abs)].concat(v.warnings.map(function (w) { return '- ' + w.msg; }));
    if (tagged.length) {
      lines.push('- 🔧 自动修补 ' + tagged.length + ' 处（statusAutoTagged：机器补的「高位」，非模型原话）：');
      tagged.forEach(function (t) { lines.push('  · ' + t.key + '：' + t.from + ' → ' + t.to); });
    }
    appendDailyLog(logDir, json.date, lines);
  }
  return next;
}

/* ─────────────────────────── CLI ─────────────────────────── */

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const file = process.env.ASTOCK_DATA_FILE || DATA;
    // 🔒 显式契约（Fix #2）：拒绝「data.js 不存在时按首期写入」。
    //   背景：loadDataStrict 对「文件缺失」按首期返回空结构（reports0=0），是个 footgun ——
    //   当前能兜住纯粹是因为下游 saveDataSafe 里的 fs.readFileSync(file) 恰好抛 ENOENT；
    //   哪天那段读被短路，就会把整份历史覆盖成「仅当天一条」。故在此把隐式保障变成显式契约，
    //   默认拒绝而非默认修复。（空文件 / 截断文件仍由 loadDataStrict 的 __abort 兜住。）
    if (!fs.existsSync(file)) {
      throw new Error('✗ dashboard/data.js 不存在：拒绝按「首期」写入，以免把历史覆盖成仅当天一条。若确属首次部署，请先人工创建空结构文件。');
    }
    mergeReport(args.kind, args.input, file, {
      dry: args.dry,
      date: args.date,
      logDir: process.env.ASTOCK_LOG_DIR
    });
  } catch (e) {
    if (e && e.__abort) {                       // 安全阀中止 → ALERT + exit 2
      console.error(e.message);
      try {
        ops.appendAlert({
          stage: 'merge/' + (e.__kind || '?'), result: 'ABORT',
          script: 'merge_report.js', detail: e.message,
          fix: '人工确认 dashboard/data.js 是否被写坏；修复后重跑', link: 'dashboard/data.js'
        });
      } catch (_) { /* 告警写入失败不叠加故障 */ }
      process.exitCode = 2;
    } else if (e && e.__validation) {           // 内容校验失败 → ALERT + exit 3
      console.error(e.message);
      try {
        ops.appendAlert({
          stage: 'merge/' + e.__kind, result: 'OPEN',
          script: 'merge_report.js', detail: e.message,
          fix: '按上方「定位/期望/实到」修正 tmp_*.json 后重跑本脚本；勿手改 data.js', link: 'tools/merge_report.js'
        });
      } catch (_) { /* 告警写入失败不叠加故障 */ }
      process.exitCode = 3;
    } else {                                    // 用法 / IO / JSON 语法错误 → exit 1
      console.error('✗ merge_report 失败：' + ((e && e.stack) || e));
      process.exitCode = 1;
    }
  }
}

module.exports = { parseArgs, validate, applyToData, mergeReport, autoTagHighBoards, autoTagHighBoard, boardCount, MAX, CAL_MAX, DATA, RISK_WORDS };
