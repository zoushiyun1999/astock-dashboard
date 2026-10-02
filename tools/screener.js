#!/usr/bin/env node
/**
 * 量价选股器 —— 按用户设定的技术面条件筛选沪深主板个股
 *
 * 条件：
 *   1. 涨幅 2.5% ~ 7%
 *   2. 换手率 2.5% ~ 20%
 *   3. 总市值 20亿 ~ 500亿
 *   4. 股价全天运行在分时均线上方（默认 ≥95% 时间 & 收盘在均线上）
 *   5. 非创业板(300/301)、非科创板(688)、非 ST / 退市
 *   6. 量比 ≥ 1.5（2026-09-22 由 1 上调：1.0~1.3 属正常水平，不构成"放量"证据）
 *   7. 连续收阳（默认 ≥2 天）
 *   8. 高位过滤：近 20 日累计涨幅 ≤ 25%（2026-09-22 新增；防追在趋势末端，
 *      如 7 连阳股第 8 天追入。上市不足 21 根 K 线的新股无法计算 → 跳过该条不拦截）
 *
 * 用法：node tools/screener.js            # 跑筛选并写入 dashboard/data.js 的顶层 screener 字段
 *       node tools/screener.js --dry      # 只打印结果，不写文件
 *
 * 数据源：东方财富行情(延迟) + 腾讯日K + 东财分时
 *
 * 2026-09-12 审计修复：
 *   · 原实现用 `try { eval(readFileSync(data.js)) } catch (e) {}` 读数据，解析失败被静默吞掉后
 *     data 退化成空结构并被原样写回，**会一次性清空全部 reports 与 calendar**。
 *     现在改为 loadDataStrict（解析失败即中止）+ saveDataSafe（规模校验 + 乐观锁，防并发覆盖）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
// 优先 IPv4（与 verify.js / fetch_jy_article.js 保持一致）。本机 DNS 对这些域名同时返回 AAAA+A，
// 默认顺序下 undici 走 IPv6 失败不回落，会把网络故障伪装成「没有数据」。
// ⚠️ 注意：2026-09-21 曾出现「push2 全系域名持续被重置」的故障（IPv4 与 IPv6 均失败，
//    同域 quote.eastmoney.com 正常），该行**当时并未修复它**。排查此类故障时不要止步于本行，
//    需用「同域对照 + 沙箱外进程对照」区分是域名被针对、还是本机出网被限。
require('dns').setDefaultResultOrder('ipv4first');
const { loadDataStrict, saveDataSafe } = require('./lib/data_store');
const ops = require('./lib/ops');
const { preSync } = require('./lib/pre_sync');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');
const SC_FILE = path.join(ROOT, 'dashboard', 'screener.js'); // 独立文件，与 data.js 隔离，防早报/晚报整体重写覆盖
const EM = 'https://push2delay.eastmoney.com';
// 交易日判定口径与 health_check.js / verify.js 一致，收敛到 tools/lib/gap_check.js。
// ⚠️ config/trade_holidays.json 结构是 { note, years: { "2026": [...] } }，必须取 .years[年份]（规则 16c）。
const gapCheck = require('./lib/gap_check');
const HOLIDAY_YEARS = (function () {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8')).years || {};
  } catch (e) {
    return {};   // 读不到时退化为「仅排除周末」，不阻断主流程
  }
})();

/** 🔴 是否应跳过（周末/节假日）：放在抓数之前，无条件拦截。
 *  背景（2026-10-02 修复）：旧守卫只在「抓到 0 只」时才判休市，但休市日东财接口
 *  仍返回最近交易日快照（market.length>0）→ 守卫被绕过 → 把上一交易日数据
 *  错贴休市日日期写进看板（本次 10-02 国庆即此）。现改为抓数前先判，非交易日直接跳过。 */
function isSkipDay(dateObj, holidayYears) {
  return !gapCheck.isTradingDay(dateObj, holidayYears);
}

/** 🔴 剔除历史里任何「非交易日」记录（纯函数，便于单测）。
 *  历史上若误写入休市/周末期（如 2026-10-02 国庆误写），下次运行自动清理，
 *  避免看板出现「休市日却有数据」的矛盾记录。解析不了的日期保守保留。 */
function pruneNonTrading(scList, holidayYears) {
  if (!Array.isArray(scList)) return scList;
  return scList.filter(function (x) {
    if (!x || !x.date) return true;
    var d = new Date(x.date + 'T00:00:00');
    if (isNaN(d.getTime())) return true;
    return gapCheck.isTradingDay(d, holidayYears);
  });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };

// ── 可调阈值 ──
const CFG = {
  gainMin: 2.5, gainMax: 7,        // 涨幅 %
  turnMin: 2.5, turnMax: 20,       // 换手 %
  capMin: 20, capMax: 500,         // 市值 亿元
  volRatioMin: 1.5,                // 量比（09-22 由 1 上调至 1.5）
  yangMin: 2,                      // 最少连续收阳天数
  aboveRateMin: 0.95,              // 分时价格在均线上方的时间占比
  gain20Max: 25,                   // 近 20 日累计涨幅上限 %（高位过滤，09-22 新增）
  maxHold: 40                      // 最多保留多少只
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJSON(url, headers, retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      const r = await fetch(url, { headers: headers || H });
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

/** 拉取沪深主板全市场行情（排除创业板/科创板/北交所） */
async function fetchMarket() {
  let all = [];
  for (let pn = 1; pn <= 60; pn++) {
    const url = `${EM}/api/qt/clist/get?pn=${pn}&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=m:0+t:6,m:1+t:2&fields=f2,f3,f8,f10,f12,f14,f20,f100`;
    const j = await getJSON(url);
    const d = (j && j.data && j.data.diff) || [];
    if (!d.length) break;
    all = all.concat(d);
    if (all.length >= (j.data.total || 0)) break;
  }
  return all;
}

/** 🔴 瞬时空响应自愈（2026-09-30 加固）
 *  背景：`getJSON` 只对「请求抛错」重试；当上游（push2delay）返回 HTTP 200 但 body 为空
 *  （瞬时空页 / 连接抖动，历史上 09-21、09-28~09-30 反复出现），`getJSON` 当作成功返回，
 *  `fetchMarket()` 拿到空数组 → 直接判「全市场 0 只」→ 交易日触发 fault 标记，需手动补跑。
 *  本函数：交易日却抓到 0 只属异常，先整段重试 `fetchMarket` 最多 2 次（每次退避 1.5s）排除瞬时空响应；
 *  非交易日本就跳过、无需重试（避免无谓延迟）。返回最终 market（重试后仍 0 才交给 main 判故障）。
 *  抽成独立函数以便单测（mock fetch + 已知交易日即可断言自愈次数与结果）。 */
async function fetchMarketWithRetry(dateObj) {
  let market = await fetchMarket();
  if (!market.length && gapCheck.isTradingDay(dateObj, HOLIDAY_YEARS)) {
    for (let a = 1; a <= 2; a++) {
      console.log('  ⚠ 交易日抓取全市场 0 只（疑似上游瞬时空响应），1.5s 后重试（' + a + '/2）');
      await sleep(1500);
      market = await fetchMarket();
      if (market.length) break;
    }
  }
  return market;
}

/** 排除 ST / 退市 / 新股(N前缀) / 次新(C前缀)
 *  注意：A股新股名形如「N华虹」、次新形如「C华虹」，字母紧贴名字**中间无空格**，
 *  原来的 /N\s|C\s/ 要求字母后跟空白，实际一个都匹配不到，形同虚设。
 *  改用锚定行首的 /^N|^C/（真实股票名不含半角 N/C 开头，无正常股被误伤，已用 146 个真实名断言验证）。 */
function isBadName(name) { return /ST|退|^N|^C/.test(name); }

function passBase(x) {
  if (typeof x.f3 !== 'number' || !isFinite(x.f3)) return false;
  if (typeof x.f8 !== 'number' || typeof x.f10 !== 'number' || typeof x.f20 !== 'number') return false;
  if (isBadName(x.f14)) return false;
  if (/^(300|301|688|8|4|92)/.test(x.f12)) return false;   // 排除创业板/科创板/北交所（含 920x，P2-9）
  const cap = x.f20 / 1e8;
  return x.f3 >= CFG.gainMin && x.f3 <= CFG.gainMax &&
    x.f8 >= CFG.turnMin && x.f8 <= CFG.turnMax &&
    cap >= CFG.capMin && cap <= CFG.capMax &&
    x.f10 >= CFG.volRatioMin;
}

/** 并发执行（带并发上限，避免被限流） */
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k]); }
  }));
  return out;
}

/** 连续收阳天数 + 近 20 日累计涨幅：主源新浪日K，备用腾讯（腾讯高频会被 WAF 拦截）。
 *  K 线窗口从 10 根扩到 30 根：连阳只看最近几天，但高位过滤需要 ≥21 根收盘价。 */
async function fillYang(s) {
  const sym = (s.f12.startsWith('6') ? 'sh' : 'sz') + s.f12;
  let pairs = null;

  // 源1：新浪（稳定）
  const sn = await getJSON(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=30`,
    { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/' });
  if (Array.isArray(sn) && sn.length) {
    pairs = sn.map(function (d) { return [parseFloat(d.open), parseFloat(d.close)]; });
  }

  // 源2：腾讯（备用）
  if (!pairs) {
    const tx = await getJSON(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,30,qfq`,
      { 'User-Agent': UA });
    const k = (tx && tx.data && tx.data[sym] && tx.data[sym].qfqday) || [];
    if (k.length) pairs = k.map(function (r) { return [parseFloat(r[1]), parseFloat(r[2])]; });
  }

  const r = computeYangGain20(pairs, CFG);
  s.yang = r.yang;
  s.gain20 = r.gain20;          // 近 20 日累计涨幅 %；K 线不足 21 根（新股）为 null
  s.yangOK = !!pairs;
  return s;
}

/** 纯函数：从 [open, close] 序列计算连阳天数与近 20 日累计涨幅（供 fillYang 与单测共用）。
 *  · yang：从最新一根往回数「close > open」的连续天数（与旧实现逐字节同语义）；
 *  · gain20：最新收盘 / 21 根前的收盘 - 1（即 20 个交易日的涨幅，%）；不足 21 根 → null；
 *  · 数据里含非有限值 → 该根按「非阳线」处理、gain20 视为无法计算（null）。 */
function computeYangGain20(pairs, cfg) {
  const out = { yang: 0, gain20: null, histOK: false };
  if (!Array.isArray(pairs) || !pairs.length) return out;
  let n = 0;
  for (let i = pairs.length - 1; i >= 0; i--) {
    const o = pairs[i][0], c = pairs[i][1];
    if (isFinite(o) && isFinite(c) && c > o) n++; else break;
  }
  out.yang = n;
  if (pairs.length >= 21) {
    const last = pairs[pairs.length - 1][1];
    const prev = pairs[pairs.length - 21][1];
    if (isFinite(last) && isFinite(prev) && prev > 0) {
      out.gain20 = +(((last / prev) - 1) * 100).toFixed(2);
      out.histOK = true;
    }
  }
  return out;
}

/** 分时均线：价格在均线上方的时间占比 + 收盘是否在均线上 */
async function fillAvg(s) {
  const secid = (s.f12.startsWith('6') ? '1.' : '0.') + s.f12;
  const j = await getJSON(`${EM}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2&fields2=f51,f53,f58&iscr=0&ndays=1`);
  const t = (j && j.data && j.data.trends) || [];
  let under = 0, tot = 0, last = 0, lastAvg = 0;
  t.forEach(function (row) {
    const p = row.split(',');
    if (p.length < 3) return;
    const price = parseFloat(p[1]), avg = parseFloat(p[2]);
    if (!isFinite(price) || !isFinite(avg) || avg <= 0) return;
    tot++; if (price < avg) under++;
    last = price; lastAvg = avg;
  });
  s.aboveRate = tot ? +(1 - under / tot).toFixed(3) : 0;
  s.closeAbove = last > lastAvg;
  s.avgOK = tot > 0;      // 分时数据是否真的取到（用于 P2-7 显式 warnings，区分"网络失败"与"真没票"）
  return s;
}

/** 汇总网络部分失败信息（P2-7）：把"因网络抖动系统性偏少"与"真的只有 N 只"区分开。
 *  返回 string[]，写进 result.warnings 并在控制台 ⚠️ 打印。纯函数，便于单测（测试 #12）。 */
function buildWarnings(o) {
  o = o || {};
  const w = [];
  if (o.yangFail > 0) w.push('K线获取失败 ' + o.yangFail + ' 只');
  if (o.avgFail > 0) w.push('分时获取失败 ' + o.avgFail + ' 只');
  return w;
}

/**
 * 从博主真实推荐名单构建「股票名 → 板块」映射，用于热点归属标注。
 * 旧逻辑误用的是「板块热点[].stocks」（形如"核心股2-5只"的描述文本），永远匹配不上。
 * 现改为：① 最近有数据的晚报「明日关注」各板块 picks 真实股票名 → 板块名
 *         ② 最近有数据的早报「今日关注」股票名 → 其 sector（如"地产经纪+AI应用"）
 * 两者合并，命中的入选股即打上「属于当日主线/博主看好」标签。
 */
// 板块关键词 → 行业正则（用户可在此扩充；仅当当日有该主线板块时才用于标注）
const SECTOR_KW = {
  '地产': /房地产|园区开发|物业服务/,
  '算力/AI': /计算机|软件|通信|半导体|元件|光学光电子|消费电子|互联网|通信设备/,
  '军工': /军工|国防|航空装备|地面兵装|航海装备|航天/,
  '农业/种业': /农业|种业|种植|饲料|渔业|农用/,
  '券商/金融': /证券|非银金融|银行|保险/,
  '医药': /医药|生物制品|医疗|化学制药|中药|医疗器械/,
  '新能源/车': /电力设备|电池|光伏|汽车|汽车零部件/,
  '消费': /零售|食品|饮料|家电|服装|家居|旅游|酒店|传媒|化妆品/,
  '化工': /化学制品|化学原料|塑料|橡胶|化纤/,
  '有色/资源': /工业金属|贵金属|小金属|煤炭|钢铁|石油|矿业/
};

// 收集当日活跃板块关键词（从最新有数据的博主板块名/个股 sector 提取）
function collectActiveKws(reports) {
  const kws = {};
  const texts = [];
  for (let i = reports.length - 1; i >= 0 && texts.length < 30; i--) {
    const rec = reports[i];
    if (!rec) continue;
    if (rec.evening && rec.evening['明日关注']) rec.evening['明日关注'].forEach(function (g) { if (g.sector) texts.push(g.sector); });
    if (rec.morning && rec.morning['今日关注']) rec.morning['今日关注'].forEach(function (p) { if (p.sector) texts.push(p.sector); });
    if (rec.evening && rec.evening['板块热点']) rec.evening['板块热点'].forEach(function (g) { if (g.name) texts.push(g.name); });
  }
  texts.forEach(function (t) {
    Object.keys(SECTOR_KW).forEach(function (k) {
      const parts = k.split('/');
      if (t.indexOf(parts[0]) >= 0 || (parts[1] && t.indexOf(parts[1]) >= 0)) kws[k] = 1;
    });
  });
  return kws;
}

// 个股热点归属：先精确匹配博主真实推荐名单，否则用行业匹配当日活跃主线
function buildTag(name, industry, nameMap, activeKws) {
  if (nameMap[name]) return nameMap[name];
  if (industry) {
    let hit = null;
    Object.keys(activeKws).some(function (k) {
      if (SECTOR_KW[k] && SECTOR_KW[k].test(industry)) { hit = k; return true; }
    });
    if (hit) return hit;
  }
  return '';
}

function buildSectorMap(reports) {
  const map = {};
  let gotTmr = false, gotToday = false;
  for (let i = reports.length - 1; i >= 0 && !(gotTmr && gotToday); i--) {
    const rec = reports[i];
    if (!rec) continue;
    if (!gotTmr) {
      const tmr = rec.evening && rec.evening['明日关注'];
      if (tmr && tmr.length) {
        tmr.forEach(function (g) {
          (g.picks || []).forEach(function (p) {
            if (p && p.name) map[p.name] = g.sector || '主线板块';
          });
        });
        gotTmr = true;
      }
    }
    if (!gotToday) {
      const tdy = rec.morning && rec.morning['今日关注'];
      if (tdy && tdy.length) {
        tdy.forEach(function (p) {
          if (p && p.name && !map[p.name]) map[p.name] = p.sector || '早报关注';
        });
        gotToday = true;
      }
    }
  }
  return map;
}

function fmtDate(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function fmtTime(d) { return fmtDate(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

/* ─────────────────────────────────────────────────────────────────────────────
 * 数据读写的两道安全阀（2026-09-12 审计后补；2026-09-14 抽为公共模块）
 *
 * loadDataStrict + saveDataSafe 已收敛到 tools/lib/data_store.js，与 verify.js /
 * check_codes.js / sort_reports.js 共用同一份（规则 16）。此处不再保留本地副本。
 * ───────────────────────────────────────────────────────────────────────────── */

async function main() {
  const now = new Date();
  console.log('▶ 量价选股开始 ' + fmtTime(now));

  // 🔴 2026-10-02 修复：非交易日（周末/节假日）在抓数前无条件跳过，绝不抓取/筛选/写盘。
  //   旧守卫只在「抓到 0 只」时判休市，但休市日东财仍返回最近交易日快照 → 守卫被绕过 →
  //   把上一交易日数据错贴休市日日期写进看板（本次 10-02 国庆即此）。
  //   即便跳过，也顺手清理历史上误写入的非交易日记录（如已被写入的 10-02），
  //   让看板不会长期残留「休市日却有数据」的矛盾记录。
  if (isSkipDay(now, HOLIDAY_YEARS)) {
    try {
      const seed = loadScreenerFile();
      if (Array.isArray(seed) && seed.some(function (x) {
        return x && x.date && !gapCheck.isTradingDay(new Date(x.date + 'T00:00:00'), HOLIDAY_YEARS);
      })) {
        const cleaned = pruneNonTrading(seed, HOLIDAY_YEARS);
        fs.writeFileSync(SC_FILE, 'window.SCREENER = ' + JSON.stringify(cleaned, null, 2) + ';\n');
        console.log('  ℹ 已清理历史中 ' + (seed.length - cleaned.length) + ' 条非交易日记录（休市日自检）。');
      }
    } catch (_) { /* 自检失败不影响跳过 */ }
    console.log('  ℹ ' + fmtDate(now) + ' 为非交易日（周末/节假日）→ 正常跳过，不抓取、不写入、不发布。');
    return;
  }

  // ⚠️ 抓数之前先与远端对齐：历史期数据（dashboard/screener.js）是**追加**的，
  //    拿陈旧副本会丢掉另一侧已发布的期数，并在发布时把它推回远端。
  preSync('选股');
  let market = await fetchMarketWithRetry(now);
  console.log('  全市场（沪深主板）：' + market.length + ' 只');

  // 🔴 上游故障标记（2026-09-30 新增）：交易日抓到全市场 0 只 = 数据源故障。
  //   非交易日（周末/节假日）已在 main() 顶部 isSkipDay 守卫跳过，此处只可能在交易日到达，
  //   故「0 只」只能解读为数据源故障，不再与休市混淆（旧实现曾把两者混为一谈）。
  if (!market.length) {
    // 🔴 上游故障标记（2026-09-30 新增）：交易日抓到全市场 0 只 = 数据源故障。
    //   旧行为：throw abortSc → exit 2 + 不写盘，线上 SCREENER 停在上一交易日，
    //   用户完全分不清"休市 / 未到点"还是"数据源挂了"（本次 09-28~09-30 连续缺失即此）。
    //   现改为：写入一条 fault 标记到 dashboard/screener.js（按日期幂等覆盖当天），
    //   前端 renderScreener 识别后显式提示"上游故障未更新"并给出"查看最近一期有效数据"按钮。
    //   不触碰 data.js（reports/calendar 不变）、不覆盖任何历史期；exit 0 让 cron.sh 照常发布。
    if (process.argv.includes('--dry')) {
      console.error('  (--dry) 上游故障：若非 dry 将写入故障标记到 dashboard/screener.js（不发布）。');
      return;
    }
    var faultResult = {
      date: fmtDate(now),
      runAt: fmtTime(now),
      fault: true,
      reason: '数据源（东财 push2delay 行情接口）在交易时段抓取失败，全市场 0 只，无法筛选。' +
        '通常是上游网络/接口临时故障，不是"没有符合条件个股"。故障恢复后下一交易日会自动补录。',
      count: 0,
      list: []
    };
    writeScreenerFault(faultResult);
    try {
      ops.appendAlert({ stage: 'screener', result: 'FAULT', script: 'screener.js',
        detail: faultResult.reason, fix: '确认 push2 系列域名可达（如 quote.eastmoney.com 应正常）后重跑本任务（幂等覆盖当天标记）', link: 'dashboard/screener.js' });
    } catch (_) { /* 忽略 */ }
    console.error('  ✗ ' + fmtDate(now) + ' 上游故障：' + faultResult.reason);
    console.log('  ✔ 已写入故障标记到 dashboard/screener.js（不覆盖历史期、不触碰 data.js）');
    return;   // exit 0 → cron.sh 会照常发布
  }

  const base = market.filter(passBase);
  console.log('  ① 基础条件命中：' + base.length + ' 只');

  await mapLimit(base, 4, fillYang);
  const yangErr = base.filter(function (s) { return !s.yangOK; }).length;
  const yangPass = base.filter(function (s) { return s.yang >= CFG.yangMin; });
  console.log('  ② 连续收阳 ≥' + CFG.yangMin + ' 天：' + yangPass.length + ' 只' +
    (yangErr ? '（K线获取失败 ' + yangErr + ' 只，已重试）' : ''));

  // ③ 高位过滤（09-22 新增）：近 20 日累计涨幅 ≤ gain20Max。
  //    gain20 === null（上市不足 21 根 K 线的新股）无法计算 → 放行，不拦截。
  const highPass = yangPass.filter(function (s) {
    return s.gain20 === null || s.gain20 <= CFG.gain20Max;
  });
  const highCut = yangPass.length - highPass.length;
  console.log('  ③ 近 20 日涨幅 ≤' + CFG.gain20Max + '%：' + highPass.length + ' 只' +
    (highCut ? '（剔除高位 ' + highCut + ' 只）' : ''));

  await mapLimit(highPass, 4, fillAvg);
  const avgErr = highPass.filter(function (s) { return !s.avgOK; }).length;
  if (avgErr) console.log('     （分时获取失败 ' + avgErr + ' 只）');
  let final = highPass.filter(function (s) {
    return s.aboveRate >= CFG.aboveRateMin && s.closeAbove;
  });
  console.log('  ④ 全天在均线上方：' + final.length + ' 只');

  final.sort(function (a, b) { return b.f3 - a.f3; });
  final = final.slice(0, CFG.maxHold);

  // 读取现有数据（用于热点归属标注 + 保留其他字段）
  const loaded = loadDataStrict(DATA);
  const data = loaded.data;
  const sectorMap = buildSectorMap(data.reports || []);
  const activeKws = collectActiveKws(data.reports || []);

  const list = final.map(function (s) {
    return {
      code: s.f12,
      name: s.f14,
      industry: s.f100 || '',
      price: s.f2,
      gain: s.f3,
      turnover: s.f8,
      volRatio: s.f10,
      cap: +(s.f20 / 1e8).toFixed(0),
      yang: s.yang,
      gain20: s.gain20,            // 近 20 日累计涨幅 %（新股为 null）
      aboveRate: Math.round(s.aboveRate * 100),
      sector: buildTag(s.f14, s.f100, sectorMap, activeKws)
    };
  });

  const result = {
    date: fmtDate(now),
    runAt: fmtTime(now),
    count: list.length,
    criteria: {
      gain: CFG.gainMin + '%-' + CFG.gainMax + '%',
      turnover: CFG.turnMin + '%-' + CFG.turnMax + '%',
      cap: CFG.capMin + '亿-' + CFG.capMax + '亿',
      volRatio: '≥' + CFG.volRatioMin,
      yang: '≥' + CFG.yangMin + '连阳',
      gain20: '≤' + CFG.gain20Max + '%（近 20 日）',
      aboveAvg: '≥' + Math.round(CFG.aboveRateMin * 100) + '% 时间在分时均线上',
      exclude: '创业板/科创板/北交所/ST/退市'
    },
    list: list,
    warnings: buildWarnings({ yangFail: yangErr, avgFail: avgErr })
  };
  result.warnings.forEach(function (w) {
    console.warn('  ⚠️ ' + w + '（入选数可能因网络抖动偏少，不等于"真的只有 N 只符合"）');
  });

  console.log('  ✔ 最终入选 ' + list.length + ' 只');
  list.slice(0, 10).forEach(function (s, i) {
    console.log('    ' + (i + 1) + '. ' + s.name + '(' + s.code + ') 涨' + s.gain + '% 换' +
      s.turnover + '% 量比' + s.volRatio + ' 市值' + s.cap + '亿 ' + s.yang + '连阳' +
      (s.gain20 === null ? '' : ' 20日+' + s.gain20 + '%') + ' 均线上' + s.aboveRate + '%' +
      (s.sector ? ' 【' + s.sector + '】' : ''));
  });

  if (process.argv.includes('--dry')) { console.log('（--dry 模式，未写入文件）'); return; }

  // ── 历史归档：最新在前，保留最近 HISTORY_MAX 期 ──
  // 唯一历史源 = dashboard/screener.js（SC_FILE）。停写 data.screener 后，若种子仍从
  // data.screener 读，每次运行历史都会被重置为仅当日 → 历史全丢（P2-4(b) 关键坑）。
  // loadScreenerFile(): 返回 Array = 正常历史；null = 文件缺失（首次运行，合法空历史）；
  //   抛 __abort = 文件损坏 → 顶层 catch 记 ALERT 并 exit 2（**绝不静默当首次运行覆盖历史**）。
  const HISTORY_MAX = 10;
  const seed = loadScreenerFile();
  let hist = [];
  if (Array.isArray(seed)) hist = seed.slice();
  else if (seed && seed.list) hist = [seed];   // 兼容旧的单对象结构
  const dup = hist.findIndex(function (x) { return x && x.date === result.date; });
  if (dup >= 0) hist[dup] = result; else hist.unshift(result);   // 同一天重复运行则覆盖当天那期
  hist = pruneNonTrading(hist.slice(0, HISTORY_MAX), HOLIDAY_YEARS);

  // 停写 data.screener：前端走 window.SCREENER（index.html 先加载 screener.js），
  // data.screener 那份永不生效，却随 data.js/data.json 每次全量传输（P2-4）。
  delete data.screener;
  data.updatedAt = fmtTime(now);
  saveDataSafe(DATA, data, loaded, loaded.src);   // data.js 不再含 screener；reports/calendar 不变
  fs.writeFileSync(SC_FILE, 'window.SCREENER = ' + JSON.stringify(hist, null, 2) + ';\n');
  console.log('  ✔ 已写回 dashboard/data.js（已移除 data.screener）+ 独立文件 dashboard/screener.js');
  console.log('  ✔ 历史归档 ' + hist.length + ' 期：' + hist.map(function (x) { return x.date + '(' + x.count + ')'; }).join(' → '));
}

/** 局部中止（与共享 abort() 同构，仅补 link 指向 screener.js）。返回异常由调用处 throw。 */
function abortSc(msg) {
  const e = new Error(msg);
  e.__abort = true;
  e.link = 'dashboard/screener.js';
  return e;
}

/** 从独立文件 dashboard/screener.js 读取历史（停写 data.screener 后的唯一历史源）。
 *  · 返回 Array = 正常历史（旧的单对象结构会被包成 [obj]）；
 *  · 返回 null  = **文件不存在** → 首次运行，合法空历史；
 *  · 抛 __abort = 文件存在但**解析失败 / 结构非法** → 绝不能当作首次运行，
 *      否则会把已有的 N 期历史静默覆盖成 1 期（P2-4(b) 静默数据丢失）。
 *  顶层 catch 识别 __abort → 记 ALERT(result=ABORT) + exit 2。
 *  可选参数 file：仅测试用（默认 SC_FILE）。 */
function loadScreenerFile(file) {
  const f = file || SC_FILE;
  if (!fs.existsSync(f)) return null;                       // 文件缺失 = 首次运行，合法
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch (e) {
    throw abortSc('读取 dashboard/screener.js 失败（拒绝当作首次运行覆盖历史）：' + e.message);
  }
  let parsed;
  try {
    const ctx = { window: {} };
    require('vm').runInNewContext(raw, ctx, { filename: 'dashboard/screener.js' });
    parsed = ctx.window.SCREENER;
  } catch (e) {
    throw abortSc('dashboard/screener.js 解析失败（拒绝当作首次运行覆盖历史）：' + e.message);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && parsed.list) return [parsed];               // 兼容旧的单对象结构
  throw abortSc('dashboard/screener.js 结构非法：window.SCREENER 缺失或既非数组也无 list（拒绝当作首次运行覆盖历史）');
}

/** 写入上游故障标记（2026-09-30）：仅追加/覆盖当天 fault 期到 dashboard/screener.js，
 *  不触碰 data.js、不覆盖历史期。与正常路径写盘同构（loadScreenerFile + 按日期 upsert）。
 *  文件损坏时 loadScreenerFile 抛 __abort → 顶层记 ALERT+exit2（绝不静默覆盖历史）。 */
function writeScreenerFault(result) {
  var HISTORY_MAX = 10;
  var seed = loadScreenerFile();
  var hist = [];
  if (Array.isArray(seed)) hist = seed.slice();
  else if (seed && seed.list) hist = [seed];
  var dup = hist.findIndex(function (x) { return x && x.date === result.date; });
  if (dup >= 0) hist[dup] = result; else hist.unshift(result);
  hist = pruneNonTrading(hist.slice(0, HISTORY_MAX), HOLIDAY_YEARS);
  fs.writeFileSync(SC_FILE, 'window.SCREENER = ' + JSON.stringify(hist, null, 2) + ';\n');
}

if (require.main === module) {
  main().catch(function (e) {
    if (e && e.__abort) {                                    // 安全阀主动中止 → 写告警 + 退出码 2
      console.error(e.message);
      try {
        ops.appendAlert({ stage: 'screener', result: 'ABORT', script: 'screener.js',
          detail: e.message, fix: '确认 data.js 是否被写坏 / 是否有并发写；稍后重跑本任务', link: e.link || 'dashboard/data.js' });
      } catch (_) { /* 忽略 */ }
      process.exitCode = 2;
      return;
    }
    console.error('✗ 未预期错误：' + ((e && e.stack) || e));
    try {
      ops.appendAlert({ stage: 'screener', result: 'OPEN', script: 'screener.js',
        detail: String((e && e.stack) || e), fix: '检查网络与行情接口；稍后重跑本任务', link: 'dashboard/data.js' });
    } catch (_) { /* 忽略 */ }
    process.exitCode = 1;
  });
}

module.exports = { isBadName, passBase, buildWarnings, loadScreenerFile, computeYangGain20, CFG, saveDataSafe, main, fetchMarket, fetchMarketWithRetry, isSkipDay, pruneNonTrading };

