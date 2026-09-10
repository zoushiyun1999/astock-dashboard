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
 * 休市日维护：每年初用 westock data_trade_calendar(year=下一年) 刷新 config/trade_holidays.json。
 *
 * 用法：node tools/verify.js            # 跑验证并写回 data.js
 *       node tools/verify.js --dry      # 只打印，不写文件
 *
 * 数据源：东方财富行情（push2delay，收盘后无延迟问题）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');
const HOLIDAYS_FILE = path.join(ROOT, 'config', 'trade_holidays.json');
const EM = 'https://push2delay.eastmoney.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

/** 拉沪深主板全市场行情，建立 代码 → {名称,涨跌幅,现价} 映射
 *  注意：东方财富该接口单页最多返回 100 条（pz 上限亦被服务端截断），
 *  故 pz 固定为 100 并逐页拉取；以 total 字段判定是否已拉全，避免漏页。 */
async function fetchQuotes() {
  const map = {};
  let total = Infinity;
  for (let pn = 1; pn <= 80; pn++) {
    const url = `${EM}/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=m:0+t:6,m:1+t:2&fields=f12,f14,f3,f2`;
    const j = await getJSON(url);
    const dj = (j && j.data) || {};
    const d = dj.diff || [];
    if (dj.total && typeof dj.total === 'number') total = dj.total;
    if (!d.length) break;
    d.forEach(function (x) { map[x.f12] = { name: x.f14, gain: x.f3, price: x.f2 }; });
    if (Object.keys(map).length >= total) break; // 已拉全市场
  }
  return map;
}

function fmtDate(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
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

/** 按 name 优先、code 兜底匹配行情，返回 {code,name,gain,price} 或 null */
function findQuote(quotes, p) {
  if (!p) return null;
  // 1. 先按名称精确匹配（name 是博主原文，最可靠；顺带纠正可能的错误 code）
  const key = String(p.name || '').trim();
  if (key) {
    for (const k in quotes) {
      if (quotes[k].name === key) {
        return { code: k, name: quotes[k].name, gain: quotes[k].gain, price: quotes[k].price };
      }
    }
  }
  // 2. 名称匹配不到，回退 code 匹配（覆盖个股改名：旧名失效但 code 仍有效）
  if (p.code && quotes[p.code]) {
    const q = quotes[p.code];
    return { code: p.code, name: q.name, gain: q.gain, price: q.price };
  }
  return null;
}

/** 生成 verify 标记：停牌/无数据 → hit=null；正常 → gain/hit */
function markVerify(q, at) {
  const gain = (typeof q.gain === 'number' && isFinite(q.gain)) ? q.gain : null;
  if (gain === null) {
    return { gain: null, hit: null, price: (typeof q.price === 'number' ? q.price : null), code: q.code, note: '停牌/无数据', at: at };
  }
  return { gain: gain, hit: gain > 0, price: (typeof q.price === 'number' ? q.price : null), code: q.code, at: at };
}

(async function main() {
  const now = new Date();
  const todayStr = fmtDate(now);
  console.log('▶ 次日验证开始 ' + todayStr + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'));

  // 交易日感知：周末/节假日跳过
  if (!isTradingDay(now)) {
    console.log('   非交易日（周末/节假日），跳过验证，不写文件');
    return;
  }

  let data = { updatedAt: '', calendar: [], reports: [] };
  if (fs.existsSync(DATA)) {
    try { eval(fs.readFileSync(DATA, 'utf8').replace('window.REPORTS =', 'data =')); } catch (e) { }
  }

  const quotes = await fetchQuotes();
  console.log('   行情样本 ' + Object.keys(quotes).length + ' 只');

  let changed = 0;
  let suspended = 0;

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

  if (process.argv.includes('--dry')) { console.log('（--dry 模式，未写入文件）'); return; }

  data.updatedAt = fmtDate(now) + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  fs.writeFileSync(DATA, 'window.REPORTS = ' + JSON.stringify(data, null, 2) + ';\n');
  console.log('   ✔ 已写回 dashboard/data.js');
})();
