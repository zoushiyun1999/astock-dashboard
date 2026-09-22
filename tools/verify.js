#!/usr/bin/env node
/**
 * 次日验证器 —— 给博主推荐的个股补上「实际表现」标记
 *
 * 闭环逻辑（每个交易日 21:30 收盘后运行，晚于晚报 21:00）：
 *   · 今天早报「今日关注」：盘前推荐，看今天收盘表现 → 用今天行情 f3
 *   · 最近一篇晚报「明日关注」：盘后推荐，看"下一个交易日"(=今天)表现 → 用今天行情 f3
 * 命中即写入 verify: { gain, hit, price, code, at }，前端渲染 ✅/❌/⏸ 标记。
 * 已验证过的（verify 已存在）自动跳过，保证幂等、不覆盖。
 *
 * v2 修正：
 *   1. 交易日感知：周末 + 节假日（config/trade_holidays.json）直接跳过，避免用陈旧行情错标
 *   2. 「明日关注」改为匹配"最近一篇早于今天的晚报"（而非严格"昨天"），
 *      修复周一漏标（昨天=周日无报告）与周六错标（用周五收盘价标周五的明日关注）
 *   3. 停牌/无数据：f3 非有效数字 → 标"停牌"（hit=null），不再误标 ❌
 *   4. 记录匹配到的股票代码 code 到 verify（便于审计）
 *
 * v3 修正：
 *   5. 推荐股优先用 code 匹配（改名免疫）：早报/晚报若已带 code 字段则直接按代码查；
 *      无 code 才回退名称精确匹配。匹配成功后把 code 回写到推荐股，此后改名也不漏标。
 *
 * v4 修正（2026-09-12 审计）：
 *   6. **修掉一个会静默清空全部历史的 bug**：原实现用 `try { eval(...) } catch (e) {}` 读 data.js，
 *      解析失败会被静默吞掉，data 退化成空结构后又被原样写回 —— 7 天历史 + 全部日历一次性清空。
 *      现在改为「解析失败即中止」，并在写回前加「规模校验 + 乐观锁」（见 loadDataStrict / saveDataSafe）。
 *      并发场景：晚报 21:00、次日验证 21:30 改同一个文件，若晚报超时到 21:30 之后就会互相覆盖。
 *
 * v5 修正（2026-09-14 21:30，口径改造）：
 *   7. **verify 增写实盘口径字段**：open / openPct / buyRet / netRet / locked / basis。
 *      旧 gain（验证日收盘涨跌幅，相对昨收）不是实盘收益，保留仅为向后兼容。
 *      回补 6 个交易日 66 条实测：平均低开 -1.71%，开盘买入毛 +0.80%，扣费净 +0.60% —— 
 *      与"平均高开 3.78%"的旧结论方向相反（旧结论样本有偏）。前端应优先显示 buyRet/netRet。
 *   8. **一字板必须剔除**：开=高=低=收 → locked=true，netRet 置 null。
 *   9. 行情池再补**北交所** `m:0+t:81+s:2048`（全池 5913 只，原沪深主板仅 3487）。
 *   10. `at` 必须是实际取行情那一天；晚报的「明日」若尚无行情则不标，留待下一交易日。
 *
 * v6 修正（2026-09-18 00:30，历史缺口回补）：
 *   11. **新增历史回补**（`--rebuild`）：用**历史日线**给「已收盘但未标记」的推荐补 verify，
 *       并按 `rec.date` 重算每条推荐的**应验日**（早报=当日，晚报=次一交易日），
 *       与 `verify.at` 对不上的显式重标。
 *       动机（2026-09-18 审计发现）：09-14 那次回补把**运行日（09-14）的快照**写进了
 *       `at=09-07/09-09/09-10` 的记录里 —— 33 条 verify 的 `at` 与数据不符（同一条记录
 *       在不同 `at` 下出现**完全相同的 open/buyRet**，真实行情不可能）。旧口径的
 *       「+0.80% / 净 +0.60%」结论即建立在这批错标样本上，不可再引用。
 *   12. **默认路径（21:40 定时跑）行为不变**：仍用 push2delay 全市场快照标记「今日」的推荐；
 *       但在写回前会**自动追加一次回补遍历，且只处理 `at < 今天` 的目标日** ——
 *       这样「PC 关机导致任务没跑」的缺口会在下一次成功运行时自愈，且绝不触碰当天快照的判定。
 *   13. 历史日线走**腾讯**（`web.ifzq.gtimg.cn`，与 tools/screener.js 同源），不是东财：
 *       本机 `push2his.eastmoney.com` / `1.` / `2.` 三个域名全部 `UND_ERR_SOCKET`（实测 0/5），
 *       而 `push2delay` 正常但**不提供历史**（`dktotal: 0`）。
 *       用**前复权**序列：同日内复权因子为常数，故 `close/open`（buyRet）与不复权完全一致。
 *       腾讯码前缀：北交所 `bj`、沪市（含 688/900）`sh`、深市（含 300/301）`sz`。
 *
 * 休市日维护：每年初用 westock data_trade_calendar(year=下一年) 刷新 config/trade_holidays.json。
 *
 * 用法：node tools/verify.js              # 快照标记今日 + 自动回补"今天之前"的缺口
 *       node tools/verify.js --dry        # 只打印，不写文件
 *       node tools/verify.js --rebuild    # 只用历史日线全量重算（含今日，若已收盘）
 *       node tools/verify.js --rebuild --dry
 *
 * 数据源：当日 = 东方财富 push2delay 全市场快照；历史 = 腾讯前复权日线。
 */
'use strict';
const fs = require('fs');
const path = require('path');
// v6：历史日线/部分东财域名在本机走 IPv6 会被重置（UND_ERR_SOCKET），强制 IPv4 优先。
// 已实测：push2delay 在两种解析顺序下均正常，故该设置不会影响原有快照路径。
require('dns').setDefaultResultOrder('ipv4first');
const { loadDataStrict, saveDataSafe, acquireDataLock, releaseDataLock, abort } = require('./lib/data_store');
const ops = require('./lib/ops');
const { preSync } = require('./lib/pre_sync');
// v7：量价入选股验证 —— dashboard/screener.js 是量价历史的唯一源（loadScreenerFile 自带
// 「损坏即中止、绝不当作首期」的安全语义，复用它而非本地重写解析）。
const { loadScreenerFile } = require('./screener');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');
const SC_FILE = path.join(ROOT, 'dashboard', 'screener.js');
const HOLIDAYS_FILE = path.join(ROOT, 'config', 'trade_holidays.json');
const EM = 'https://push2delay.eastmoney.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─────────────────────────────────────────────────────────────────────────────
 * 数据读写的两道安全阀（2026-09-12 审计后补；2026-09-14 抽为公共模块）
 *
 * loadDataStrict（解析失败即中止）+ saveDataSafe（规模骤减拦截 + 乐观锁防并发覆盖）
 * 已收敛到 tools/lib/data_store.js，与 screener.js / check_codes.js / sort_reports.js 共用同一份，
 * 阈值只改一处（规则 16）。此处不再保留本地副本。
 * ───────────────────────────────────────────────────────────────────────────── */

async function getJSON(url, retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      const r = await fetch(url, { headers: H });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      if (/^<!DOCTYPE|waf\.tencent|<html/i.test(txt)) throw new Error('被风控拦截');
      return JSON.parse(txt);
    } catch (e) {
      if (i === retry) return null;
      await sleep(400 * (i + 1));
    }
  }
}

/** 拉沪深全市场行情，建立 代码 → {名称,涨跌幅,现价} 映射
 *  注意：东方财富该接口单页最多返回 100 条（pz 上限亦被服务端截断），
 *  故 pz 固定为 100 并逐页拉取；以 total 字段判定是否已拉全，避免漏页。
 *
 *  2026-09-14 修复：原 fs 只取 m:0+t:6,m:1+t:2（沪深主板），
 *  导致早报/晚报推荐的创业板(300/301)、科创板(688) 股**永远拿不到行情**，
 *  findQuote 返回 null 后静默跳过 → 这些推荐永久无 verify 标记、不计入胜率。
 *  已实测 09-03 芒果超媒(300413)、09-04 皖仪科技(688600)、09-09 本川智能(300964)、
 *  南大环境(300864) 共 4 条受影响。现补齐创业板(t:80)与科创板(t:23)。
 *  同日再补北交所(m:0+t:81+s:2048) → 全池 5913 只。 */
async function fetchQuotes() {
  const map = {};
  const fsStr = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
  let total = Infinity;
  for (let pn = 1; pn <= 90; pn++) {
    const url = `${EM}/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=${encodeURIComponent(fsStr)}&fields=f12,f14,f3,f2,f15,f16,f17,f18`;
    const j = await getJSON(url);
    const dj = (j && j.data) || {};
    const d = dj.diff || [];
    if (dj.total && typeof dj.total === 'number') total = dj.total;
    if (!d.length) break;
    d.forEach(function (x) {
      map[x.f12] = {
        name: x.f14, gain: x.f3, price: x.f2, close: x.f2,
        high: x.f15, low: x.f16, open: x.f17, prevClose: x.f18
      };
    });
    if (Object.keys(map).length >= total) break; // 已拉全市场
  }
  return map;
}

function fmtDate(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ─────────────────────────────────────────────────────────────────────────────
 * v6：历史日线（回补用）
 *
 * 数据源选择（2026-09-18 实测）：
 *   · 东财 `push2his.eastmoney.com` / `1.` / `2.` → 本机 0/5 成功，全部 UND_ERR_SOCKET；
 *     `push2delay` 可达但不提供历史（`dktotal: 0`、`klines: []`）。
 *   · 腾讯 `web.ifzq.gtimg.cn/appstock/app/fqkline/get` → 5/5 稳定，
 *     且本仓库 tools/screener.js 已在用同源同参数，口径已知。
 *
 * 用**前复权**（qfq）：同一天内复权因子是常数，`close/open` 不受影响，
 *   故 buyRet / netRet 与不复权完全一致；`openPct` 也因分子分母同尺度而一致。
 *   已用 09-11 晚报 + 09-14 早报共 18 条**已正确落库**的记录反查：
 *   openPct / buyRet 逐条吻合（阈值 0.02pp），证明该源与 push2delay 快照同口径。
 * ───────────────────────────────────────────────────────────────────────────── */
const TX_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

/** 腾讯行情代码：北交所 bj / 沪市（含科创板 688、B 股 900）sh / 深市（含创业板 300、301）sz */
function txSymbol(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (!c) return null;
  if (/^(43|83|87|88|92)/.test(c)) return 'bj' + c;   // 北交所
  if (/^(6|9)/.test(c)) return 'sh' + c;              // 沪市
  return 'sz' + c;                                    // 深市
}

/** 拉一段日线（前复权）。返回 [{date,open,close,high,low}]；失败返回 null。
 *  v7 修正（2026-09-22）：改用**计数式**请求（`day,,,N,qfq`）。
 *  日期区间式（`day,from,to,N,qfq`）在腾讯侧**不含当日 bar**（当日数据未进区间接口的库），
 *  实测 19:04 回补时 target=当日的 13 条全被误标「停牌」，而计数式已含当日 bar。
 *  故按 from..to 的自然日跨度 + 10 根余量换算 count，一次拉回后由 barAsQuote 按精确日期取用
 *  （多余的早期 bar 恰好保证 barAsQuote 能取到「昨收」）。 */
async function fetchDayBars(code, fromYmd, toYmd) {
  const s = txSymbol(code);
  if (!s) return null;
  const span = Math.round((new Date(toYmd + 'T00:00:00') - new Date(fromYmd + 'T00:00:00')) / 86400000) + 10;
  const count = Math.min(Math.max(span, 10), 320);
  // ⚠️ param 字段序：sym,day,start,end,count,fq —— start/end 留空 = 3 个逗号（day,,,N,qfq）。
  //    多一个逗号 count 挤进 fq 位、少一个逗号 end 吃掉 count 位，都会整天拉取失败（实测）。
  const url = TX_KLINE + '?param=' + s + ',day,,,' + count + ',qfq';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      if (/^<!DOCTYPE|<html/i.test(txt)) throw new Error('被风控拦截');
      const j = JSON.parse(txt);
      const blk = j && j.data && j.data[s];
      const arr = blk && (blk.qfqday || blk.day);
      if (!Array.isArray(arr)) throw new Error('无 day 数组');
      return arr.map(function (a) {
        return { date: a[0], open: +a[1], close: +a[2], high: +a[3], low: +a[4] };
      });
    } catch (e) {
      if (i === 2) { console.warn('   ⚠ 历史日线拉取失败 ' + code + '：' + e.message); return null; }
      await sleep(600 * (i + 1));
    }
  }
}

/** 从日线序列里取某日 bar + 昨收，组装成 markVerify 认识的 quote 结构。
 *  必须能取到**前一交易日**才能算涨跌幅/openPct，故调用方的 from 要往前留几天。 */
function barAsQuote(bars, code, date, name) {
  if (!bars) return null;
  const i = bars.findIndex(function (b) { return b.date === date; });
  if (i <= 0) return null;
  const b = bars[i], prev = bars[i - 1].close;
  if (!prev) return null;
  return {
    code: code, name: name,
    gain: +((b.close / prev - 1) * 100).toFixed(2),
    price: b.close, close: b.close, open: b.open, high: b.high, low: b.low, prevClose: prev
  };
}


/** 读取休市日配置（config/trade_holidays.json） */
let HOLIDAY_YEARS = {};
try { HOLIDAY_YEARS = (JSON.parse(fs.readFileSync(HOLIDAYS_FILE, 'utf8')).years) || {}; } catch (e) { HOLIDAY_YEARS = {}; }

/** 判断是否交易日：周末跳过 + 节假日（配置文件）跳过 */
function isTradingDay(d) {
  const w = d.getDay();
  if (w === 0 || w === 6) return false;
  const list = HOLIDAY_YEARS[String(d.getFullYear())] || [];
  return list.indexOf(fmtDate(d)) < 0;
}

/** 由 YYYY-MM-DD 取下一个交易日（晚报「明日关注」的应验日口径） */
function nextTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  for (let i = 0; i < 25; i++) {
    d.setDate(d.getDate() + 1);
    if (isTradingDay(d)) return fmtDate(d);
  }
  return null;
}

/** 由 YYYY-MM-DD 往回取第 n 个交易日（给历史日线窗口留出「昨收」） */
function shiftTradingDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  let left = Math.abs(n), step = n < 0 ? 1 : -1;
  while (left > 0) {
    d.setDate(d.getDate() + step);
    if (isTradingDay(d)) left--;
  }
  return fmtDate(d);
}

/** 按 name 优先、code 兜底匹配行情，返回 {code,name,gain,price,close,open,high,low,prevClose} 或 null */
function findQuote(quotes, p) {
  if (!p) return null;
  // 1. 先按名称精确匹配（name 是博主原文，最可靠；顺带纠正可能的错误 code）
  const key = String(p.name || '').trim();
  if (key) {
    for (const k in quotes) {
      if (quotes[k].name === key) {
        return {
          code: k, name: quotes[k].name, gain: quotes[k].gain, price: quotes[k].price,
          close: quotes[k].close, open: quotes[k].open, high: quotes[k].high, low: quotes[k].low,
          prevClose: quotes[k].prevClose
        };
      }
    }
  }
  // 2. 名称匹配不到，回退 code 匹配（覆盖个股改名：旧名失效但 code 仍有效）
  if (p.code && quotes[p.code]) {
    const q = quotes[p.code];
    return {
      code: p.code, name: q.name, gain: q.gain, price: q.price,
      close: q.close, open: q.open, high: q.high, low: q.low, prevClose: q.prevClose
    };
  }
  return null;
}

/** 手续费口径：双边佣金万五 + 卖出印花千五 */
const FEE_BUY = 0.0005, FEE_SELL = 0.0005, STAMP = 0.001;

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

/** 生成 verify 标记。
 *  实盘口径：开盘买入 → 收盘卖出（早报=当日开盘买；晚报=次一交易日开盘买）。
 *  · 停牌/无数据 → hit=null，只留价格
 *  · 一字板（开=高=低=收）→ locked=true，netRet=null，统计时必须剔除
 *  · gain/hit 为旧口径（验证日收盘涨跌幅，相对昨收），保留仅为向后兼容
 *  `by` = 数据来源（'snapshot' 当日 push2delay 快照 / 'hist' 历史日线）。
 *    v6 起它是**幂等判据**：历史回补只跳过 `by==='hist'` 的记录，
 *    因为 09-14 那批错标记录的 `at` 恰好等于应验日 —— 只看 `at` 会漏掉它们。 */
function markVerify(q, at, by) {
  const closeGain = num(q.gain);
  const open = num(q.open), close = num(q.close), high = num(q.high), low = num(q.low);
  const prevClose = num(q.prevClose);
  const src = by || 'snapshot';

  if (open === null || close === null || !open) {
    return {
      gain: closeGain, hit: null, price: (typeof q.price === 'number' ? q.price : null),
      code: q.code, note: '停牌/无数据', at: at, by: src
    };
  }

  const openPct = prevClose ? +((open / prevClose - 1) * 100).toFixed(2) : null;
  const buyRet = +((close / open - 1) * 100).toFixed(2);
  const netRet = +(((close / open) * (1 - FEE_SELL - STAMP) / (1 + FEE_BUY) - 1) * 100).toFixed(2);
  const locked = (high !== null && low !== null && open === high && high === low && low === close);

  const v = {
    gain: closeGain,
    hit: closeGain !== null ? closeGain > 0 : null,
    price: (typeof q.price === 'number' ? q.price : close),
    code: q.code,
    at: at,
    open: open,
    openPct: openPct,
    buyRet: buyRet,
    netRet: locked ? null : netRet,
    locked: locked,
    basis: 'open-to-close',
    by: src
  };
  if (locked) v.note = '一字板·无法买入（剔除）';
  return v;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * v6：历史回补（applyRebuild）
 *
 * 判据（与 21:40 快照路径完全一致，只换数据源）：
 *   · 早报「今日关注」→ 应验日 = 报告当日          （当日开盘买入）
 *   · 晚报「明日关注」→ 应验日 = 报告次一交易日    （次日开盘买入）
 *   · 应验日行情已定稿 才标；未定稿的留给下一轮（`at` 永远等于真实行情日）
 *
 * 幂等：`at` 与应验日一致 且 已有 basis='open-to-close' 的记录直接跳过，不重算不覆盖。
 *   不一致（= 旧错标）或不完整（= v5 之前的老格式）才重算 —— 这正是本次的修复目标。
 * ───────────────────────────────────────────────────────────────────────────── */
async function applyRebuild(data, opts) {
  opts = opts || {};
  const now = new Date();
  const todayStr = fmtDate(now);
  const sessionClosed = now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 5);
  const allowToday = opts.allowToday !== undefined ? !!opts.allowToday : sessionClosed;

  /** 应验日行情是否已定稿 */
  function barReady(target) {
    if (!target) return false;
    if (!isTradingDay(new Date(target + 'T00:00:00'))) return false;
    if (target < todayStr) return true;
    return target === todayStr && allowToday;
  }

  // 1) 汇总所有推荐，算好各自的应验日
  const items = [];
  (data.reports || []).forEach(function (rec) {
    if (!rec || !rec.date || rec.date > todayStr) return;
    (rec.morning && rec.morning['今日关注'] || []).forEach(function (p) {
      if (p) items.push({ p: p, target: rec.date, kind: 'm', rdate: rec.date });
    });
    (rec.evening && rec.evening['明日关注'] || []).forEach(function (g) {
      (g.picks || []).forEach(function (p) {
        if (p) items.push({ p: p, target: nextTradingDay(rec.date), kind: 'e', rdate: rec.date });
      });
    });
  });

  const pending = items.filter(function (x) { return !barReady(x.target); });
  const todo = items.filter(function (x) { return barReady(x.target); });

  // 幂等过滤：**只有「已由历史日线重算过」的记录才跳过**。
  //   ⚠️ 判据必须是 `by==='hist'`，不能只看 `at===target`：
  //   2026-09-18 审计发现 09-14 那次回补把运行日快照写进了 `at=09-07/09-09/09-10`，
  //   那些记录的 `at` **恰好等于**应验日，只看 at 会全部漏过、永远修不掉。
  //   v7 补充：**停牌标记（note 含「停牌」）不参与幂等跳过** —— 2026-09-22 实测 13 条
  //   target=当日的记录因腾讯区间接口缺当日 bar 被误标停牌；允许复核后，下轮数据源
  //   出现该 bar 时会自动纠正为真实标记（真停牌股每轮多拉一次日线，代价可忽略）。
  const stale = todo.filter(function (x) {
    const v = x.p.verify;
    if (!(v && v.at === x.target && v.by === 'hist')) return true;
    return !!(v.note && v.note.indexOf('停牌') >= 0);   // 停牌标记 → 复核
  });

  console.log('   回补扫描：推荐 ' + items.length + ' 条｜应验日未到/未收盘 ' + pending.length +
    ' 条（留待下轮）｜已由历史重算 ' + (todo.length - stale.length) + ' 条｜待重算 ' + stale.length + ' 条');
  if (!stale.length) return { total: items.length, pending: pending.length, changed: 0, reattached: 0, added: 0, corrected: 0, upgraded: 0, suspended: 0, failed: 0 };

  // 2) 代码解析：优先 pick.code，其次已有 verify.code，最后拿全市场快照做名称匹配
  const nameMap = {};
  let need = false;
  stale.forEach(function (x) { if (!(x.p.code || (x.p.verify && x.p.verify.code))) need = true; });
  if (need) {
    console.log('   部分推荐缺 code，拉全市场快照做名称匹配…');
    const q = await fetchQuotes();
    for (const k in q) if (q[k].name) nameMap[q[k].name] = k;
  }
  stale.forEach(function (x) {
    const c = x.p.code || (x.p.verify && x.p.verify.code) || nameMap[String(x.p.name || '').trim()] || null;
    x.code = c;
  });

  const noCode = stale.filter(function (x) { return !x.code; });
  const workable = stale.filter(function (x) { return x.code; });
  if (noCode.length) {
    console.warn('   ⚠ 无法解析代码、本次跳过 ' + noCode.length + ' 条：' +
      noCode.map(function (x) { return x.rdate + '/' + x.kind + ' ' + x.p.name; }).join('、'));
  }

  // 3) 按代码分组，每只只拉一次日线（窗口覆盖该股全部待算应验日 + 前置交易日）
  const byCode = {};
  workable.forEach(function (x) { (byCode[x.code] = byCode[x.code] || []).push(x); });

  let changed = 0, reattached = 0, added = 0, corrected = 0, upgraded = 0, suspended = 0, failed = 0;
  const log = [];
  const codes = Object.keys(byCode);
  for (let ci = 0; ci < codes.length; ci++) {
    const code = codes[ci];
    const group = byCode[code];
    const dates = group.map(function (x) { return x.target; }).sort();
    const from = shiftTradingDays(dates[0], 6);      // 往前多留几个交易日，保证能取到「昨收」
    const bars = await fetchDayBars(code, from, dates[dates.length - 1]);
    await sleep(400);   // v7：150ms 连续拉 100+ 只会触发腾讯 WAF（HTTP 501），放宽到 400ms
    if (!bars) {
      failed += group.length;
      log.push('   ✗ ' + code + ' 日线拉取失败（' + group.length + ' 条未标，下轮重试）');
      continue;
    }
    group.forEach(function (x) {
      const p = x.p, old = p.verify;
      const q = barAsQuote(bars, code, x.target, p.name);
      if (!q) {
        // 该应验日没有 K 线 → 停牌/未上市。写一条"停牌"标记（前端显示 ⏸），
        // 并带 by='hist' 以避免每轮重复重试。
        // v7：与已有停牌标记完全相同 → 静默重写（复核不产生日志/计数噪音）。
        const mark = {
          gain: null, hit: null, price: null, code: code, at: x.target,
          by: 'hist', note: '停牌/无数据（该交易日无K线）'
        };
        const dup = old && old.at === mark.at && old.note === mark.note && old.by === mark.by;
        p.verify = mark;
        if (!dup) {
          suspended++;
          log.push('   ⏸ ' + code + ' ' + p.name + ' @' + x.target + ' 无K线 → 标停牌');
        }
        return;
      }
      p.code = code;
      p.verify = markVerify(q, x.target, 'hist');
      const nv = p.verify;
      if (!old) {
        added++;
        log.push('   ＋ 补标 @' + x.target + '：' + code + ' ' + p.name +
          ' 开盘' + nv.openPct + '% → 收益' + nv.buyRet + '%' + (nv.locked ? '（一字板）' : ''));
      } else if (old.at !== x.target) {
        reattached++;
        log.push('   ↻ 改标 at ' + old.at + ' → ' + x.target + '：' + code + ' ' + p.name +
          '（buyRet ' + old.buyRet + ' → ' + nv.buyRet + '）');
      } else if (old.basis !== 'open-to-close') {
        upgraded++;
        log.push('   ⬆ 升级为实盘口径 @' + x.target + '：' + code + ' ' + p.name +
          '（旧仅 gain=' + old.gain + ' → buyRet=' + nv.buyRet + '%）');
      } else if (old.buyRet == null || Math.abs((old.buyRet || 0) - nv.buyRet) > 0.005) {
        corrected++;
        log.push('   ⚠ 数据纠正 @' + x.target + '：' + code + ' ' + p.name +
          '（旧 openPct=' + old.openPct + ' buyRet=' + old.buyRet + ' gain=' + old.gain +
          ' → 新 openPct=' + nv.openPct + ' buyRet=' + nv.buyRet + ' gain=' + nv.gain + '）');
      }
      changed++;
    });
  }

  if (log.length) { console.log('   回补明细：'); log.forEach(function (l) { console.log(l); }); }
  return { total: items.length, pending: pending.length, changed: changed, reattached: reattached, added: added, corrected: corrected, upgraded: upgraded, suspended: suspended, failed: failed };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * v7：量价入选股验证（applyRebuildScreener）
 *
 * 动机：早报/晚报推荐都有 verify 实盘回路，量价选股是唯一没有成绩单的模块 ——
 *   不知道赚不赚钱之前，任何调参都是拍脑袋（2026-09-22 与用户对齐后补上）。
 *
 * 判据（与晚报完全一致）：
 *   · 数据源 = dashboard/screener.js 历史各期的 list（每只自带 code，无需名称匹配）
 *   · 应验日 = 期日的**次一交易日**（选股 15:10 发布，次日开盘买入）
 *   · 口径 = markVerify 的实盘口径：开盘买→收盘卖、扣双边万五+印花千五、一字板剔除
 *   · 标记直接写回 screener.js 各期 list[].verify；`by==='hist'` 幂等跳过（同 v6）
 *
 * ⚠️ 与 reports 回补的关键差异：量价**没有快照路径**（21:30 的快照只标报告类推荐），
 *   所以默认模式也要用 sessionClosed 判「今天已收盘」—— 否则昨日入选股的应验日（=今天）
 *   永远不会被标记。allowToday 由调用方传 sessionClosed，而不是套用 reports 的 rebuildOnly 逻辑。
 *
 * 返回 { periods, sourceSerial, total, pending, changed, added, corrected, suspended, failed }：
 *   periods/sourceSerial 供 main 做「期数守卫 + 乐观锁」后写回 SC_FILE。
 * ───────────────────────────────────────────────────────────────────────────── */
async function applyRebuildScreener(opts) {
  opts = opts || {};
  const now = new Date();
  const todayStr = fmtDate(now);
  const sessionClosed = now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 5);
  const allowToday = opts.allowToday !== undefined ? !!opts.allowToday : sessionClosed;

  const periods = loadScreenerFile();          // null = 文件缺失（首期，合法）；抛 __abort = 损坏
  if (!Array.isArray(periods) || !periods.length) {
    console.log('   量价：screener.js 无历史期，跳过');
    return { periods: periods || [], sourceSerial: '[]', total: 0, pending: 0, changed: 0, added: 0, corrected: 0, suspended: 0, failed: 0 };
  }
  const sourceSerial = JSON.stringify(periods);   // 写回前乐观锁比对基线（读→写期间被并发改过即中止）

  // 1) 汇总应验条目：期日 r 的入选股 → 应验日 = nextTradingDay(r)
  const items = [];
  periods.forEach(function (period) {
    if (!period || !period.date || period.date > todayStr) return;
    (period.list || []).forEach(function (p) {
      if (p) items.push({ p: p, target: nextTradingDay(period.date), kind: 's', rdate: period.date });
    });
  });
  if (!items.length) {
    console.log('   量价：历史期无入选股');
    return { periods: periods, sourceSerial: sourceSerial, total: 0, pending: 0, changed: 0, added: 0, corrected: 0, suspended: 0, failed: 0 };
  }

  function barReady(target) {
    if (!target) return false;
    if (!isTradingDay(new Date(target + 'T00:00:00'))) return false;
    if (target < todayStr) return true;
    return target === todayStr && allowToday;
  }
  const todo = items.filter(function (x) { return barReady(x.target); });
  // 幂等判据与 v6 相同：只有 by==='hist' 且 at===target 的记录才跳过；
  // v7：停牌标记（note 含「停牌」）复核重试 —— 数据源补出该日 bar 时自动纠正（同 applyRebuild）。
  const stale = todo.filter(function (x) {
    const v = x.p.verify;
    if (!(v && v.at === x.target && v.by === 'hist')) return true;
    return !!(v.note && v.note.indexOf('停牌') >= 0);
  });
  console.log('   量价扫描：入选 ' + items.length + ' 条｜应验日未到 ' + (items.length - todo.length) +
    ' 条｜已标 ' + (todo.length - stale.length) + ' 条｜待标 ' + stale.length + ' 条');
  if (!stale.length) {
    return { periods: periods, sourceSerial: sourceSerial, total: items.length, pending: items.length - todo.length, changed: 0, added: 0, corrected: 0, suspended: 0, failed: 0 };
  }

  // 2) 按代码分组拉日线（量价入选股 code 来自行情接口 f12，必有）
  const byCode = {};
  stale.forEach(function (x) { (byCode[x.p.code] = byCode[x.p.code] || []).push(x); });

  let changed = 0, added = 0, corrected = 0, suspended = 0, failed = 0;
  const log = [];
  const codes = Object.keys(byCode);
  for (let ci = 0; ci < codes.length; ci++) {
    const code = codes[ci];
    const group = byCode[code];
    const tdates = group.map(function (x) { return x.target; }).sort();
    const from = shiftTradingDays(tdates[0], 6);
    const bars = await fetchDayBars(code, from, tdates[tdates.length - 1]);
    await sleep(400);   // v7：150ms 连续拉 100+ 只会触发腾讯 WAF（HTTP 501），放宽到 400ms
    if (!bars) {
      failed += group.length;
      log.push('   ✗ ' + code + ' 日线拉取失败（量价 ' + group.length + ' 条未标，下轮重试）');
      continue;
    }
    group.forEach(function (x) {
      const p = x.p, old = p.verify;
      const q = barAsQuote(bars, code, x.target, p.name);
      if (!q) {
        const mark = { gain: null, hit: null, price: null, code: code, at: x.target, by: 'hist', note: '停牌/无数据（该交易日无K线）' };
        const dup = old && old.at === mark.at && old.note === mark.note && old.by === mark.by;
        p.verify = mark;
        if (!dup) {
          suspended++;
          log.push('   ⏸ ' + code + ' ' + p.name + ' @' + x.target + ' 无K线 → 标停牌');
        }
        return;
      }
      p.verify = markVerify(q, x.target, 'hist');
      const nv = p.verify;
      if (!old) {
        added++;
        log.push('   ＋ 量价补标 @' + x.target + '：' + code + ' ' + p.name +
          ' 开盘' + nv.openPct + '% → 净' + nv.netRet + '%' + (nv.locked ? '（一字板）' : ''));
      } else if (old.at !== x.target) {
        log.push('   ↻ 量价改标 at ' + old.at + ' → ' + x.target + '：' + code + ' ' + p.name);
      } else if (old.basis !== 'open-to-close') {
        corrected++;
        log.push('   ⬆ 量价升级实盘口径 @' + x.target + '：' + code + ' ' + p.name);
      } else if (Math.abs((old.buyRet || 0) - nv.buyRet) > 0.005) {
        corrected++;
        log.push('   ⚠ 量价数据纠正 @' + x.target + '：' + code + ' ' + p.name +
          '（旧 buyRet=' + old.buyRet + ' → 新 ' + nv.buyRet + '）');
      }
      changed++;
    });
  }

  if (log.length) { console.log('   量价明细：'); log.forEach(function (l) { console.log(l); }); }
  return { periods: periods, sourceSerial: sourceSerial, total: items.length, pending: items.length - todo.length, changed: changed, added: added, corrected: corrected, suspended: suspended, failed: failed };
}

async function main() {
  const now = new Date();
  const todayStr = fmtDate(now);
  const dry = process.argv.includes('--dry');
  const rebuildOnly = process.argv.includes('--rebuild');
  console.log('▶ 次日验证开始 ' + todayStr + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') +
    (rebuildOnly ? '　【--rebuild 历史回补模式】' : ''));

  // ⚠️ 读 data.js 之前先与远端对齐：另一个环境可能刚写入过标记，
  //    用陈旧数据会重复标记 / 覆盖对方的成果。
  preSync('验证');
  const loaded = loadDataStrict(DATA);
  const data = loaded.data;

  let changed = 0;
  let suspended = 0;

  // ── 当日快照标记（原 v5 路径；--rebuild 模式跳过）────────────────────────────
  if (!rebuildOnly) {
    if (!isTradingDay(now)) {
      console.log('   非交易日（周末/节假日）→ 跳过当日快照标记（历史回补仍会执行）');
    } else {
      const quotes = await fetchQuotes();
      console.log('   行情样本 ' + Object.keys(quotes).length + ' 只');

      // 1. 今日早报「今日关注」→ 今日行情
      (data.reports || []).forEach(function (rec) {
        if (!rec || rec.date !== todayStr || !rec.morning || !rec.morning['今日关注']) return;
        rec.morning['今日关注'].forEach(function (p) {
          if (!p || p.verify) return;
          const q = findQuote(quotes, p);
          if (q) { p.code = q.code; p.verify = markVerify(q, todayStr); changed++; if (p.verify.hit === null) suspended++; }
        });
      });

      // 2. 最近一篇早于今天、且有「明日关注」的晚报 → 今日行情
      let prevEv = null;
      for (let i = (data.reports || []).length - 1; i >= 0; i--) {
        const rec = data.reports[i];
        if (rec && rec.date && rec.date < todayStr && rec.evening && rec.evening['明日关注']) { prevEv = rec; break; }
      }
      if (prevEv) {
        console.log('   明日关注来源：' + prevEv.date + ' 晚报');
        prevEv.evening['明日关注'].forEach(function (g) {
          (g.picks || []).forEach(function (p) {
            if (!p || p.verify) return;
            const q = findQuote(quotes, p);
            if (q) { p.code = q.code; p.verify = markVerify(q, todayStr); changed++; if (p.verify.hit === null) suspended++; }
          });
        });
      } else {
        console.log('   无早于今天的晚报明日关注');
      }

      console.log('   补充验证标记 ' + changed + ' 条' + (suspended ? '（其中停牌/无数据 ' + suspended + ' 条）' : ''));
    }
  }

  // ── v6 历史缺口回补 ────────────────────────────────────────────────────────
  // 默认模式**只处理「应验日 < 今天」**的推荐，把当天的判定完全留给快照路径（职责不重叠）；
  // --rebuild 模式额外放行今天（仅当已收盘），用于一次性全量重算。
  // 注意：绝不能用「是否 --rebuild」当 allowToday —— 凌晨补跑时今天还没开盘，
  // 会把「尚未到来的应验日」误判为停牌（2026-09-18 首次试跑即踩到）。
  const sessionClosed = now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 5);
  console.log('   ── 历史缺口回补 ──');
  const rb = await applyRebuild(data, { allowToday: rebuildOnly ? sessionClosed : false });

  if (rb && rb.failed) {
    console.warn('   ⚠ 有 ' + rb.failed + ' 条因日线拉取失败未处理，下轮会自动重试');
  }

  // ── 量价入选股验证（v7）──
  // 与 reports 的回补不同：量价没有快照路径，默认模式也用 sessionClosed 判「今天已收盘」。
  // screener.js 文件损坏（__abort）时记 ALERT 并跳过量价部分，**不拖累**报告标记与 data.js 保存。
  console.log('   ── 量价入选股验证 ──');
  let sc = null;
  try {
    sc = await applyRebuildScreener({ allowToday: sessionClosed });
  } catch (e) {
    if (e && e.__abort) {
      console.error(e.message);
      try {
        ops.appendAlert({ stage: 'verify', result: 'OPEN', script: 'verify.js',
          detail: 'screener.js 验证中止：' + e.message, fix: 'dashboard/screener.js 疑似损坏，人工检查后再重跑量价验证', link: 'dashboard/screener.js' });
      } catch (_) { /* 忽略 */ }
    } else { throw e; }
  }

  if (dry) { console.log('（--dry 模式，未写入文件）'); return; }

  const stamp = fmtDate(now) + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const touched = changed + ((rb && rb.changed) || 0);

  // 量价标记写回 screener.js（独立于 data.js：即使本轮报告无变化，量价标记也要落盘）。
  // 守卫：① 期数不得减少 ② 乐观锁 —— 读基线 sourceSerial 与现文件不一致 → 中止。
  if (sc && sc.changed) {
    acquireDataLock(SC_FILE);
    try {
      const cur = loadScreenerFile();
      if (JSON.stringify(cur) !== sc.sourceSerial) {
        abort('✗ dashboard/screener.js 在验证期间被其他任务修改过（很可能是量价选股并发运行），' +
          '为避免覆盖，量价标记本次中止写回（报告标记已保存）。请重跑本任务自动补齐。');
      }
      fs.writeFileSync(SC_FILE, 'window.SCREENER = ' + JSON.stringify(sc.periods, null, 2) + ';\n');
      console.log('   ✔ 已写回 dashboard/screener.js（量价标记 ' + sc.changed +
        ' 条' + (sc.failed ? '，失败 ' + sc.failed + ' 条留待下轮' : '') + '）');
    } finally {
      releaseDataLock(SC_FILE);
    }
  }

  if (!touched) {
    console.log('   · 本轮无新增/无修正标记，不写文件（保持 updatedAt 不变）');
    return;
  }
  data.updatedAt = stamp;
  saveDataSafe(DATA, data, loaded, loaded.src);   // baseline 传 loadDataStrict 的返回对象（含 reports0/calendar0 数字快照）
  console.log('   ✔ 已写回 dashboard/data.js（快照 ' + changed + ' 条｜回补 ' + ((rb && rb.changed) || 0) + ' 条）');
}

if (require.main === module) {
  main().catch(function (e) {
    if (e && e.__abort) {                                   // 安全阀主动中止 → 写告警 + 退出码 2
      console.error(e.message);
      try {
        ops.appendAlert({
          stage: 'verify', result: 'ABORT', script: 'verify.js',
          detail: e.message, fix: '确认 data.js 是否被写坏 / 是否有并发写；稍后重跑本任务', link: 'dashboard/data.js'
        });
      } catch (_) { /* 忽略 */ }
      process.exitCode = 2;
      return;
    }
    console.error('✗ 未预期错误：' + ((e && e.stack) || e));
    try {
      ops.appendAlert({
        stage: 'verify', result: 'OPEN', script: 'verify.js',
        detail: String((e && e.stack) || e), fix: '检查网络与行情接口；稍后重跑本任务', link: 'dashboard/data.js'
      });
    } catch (_) { /* 忽略 */ }
    process.exitCode = 1;
  });
}

module.exports = {
  markVerify, findQuote, fetchQuotes, num, main,
  // v6 新增（供审计脚本/测试复用）
  applyRebuild, fetchDayBars, barAsQuote, txSymbol, isTradingDay, nextTradingDay, shiftTradingDays,
  // v7 新增（量价入选股验证）
  applyRebuildScreener
};
