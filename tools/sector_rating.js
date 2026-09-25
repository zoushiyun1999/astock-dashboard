#!/usr/bin/env node
/**
 * sector_rating.js —— 板块评级（2026-09-25）
 *
 * 给「热点板块页」的博主板块加状态标注：可关注 / 过热勿追 / 退潮观望 / 中性。
 * 数据源：东方财富板块列表（与量价选股同源；软依赖——抓不到时只跳过，报告照常发布）。
 * 评级：确定性规则引擎，不过 LLM；每条评级在抽屉里给出命中依据，可解释、可核对。
 *
 * 用法：
 *   node tools/sector_rating.js                # 拉东财全量快照 + 读 dashboard/data.js 最新晚报板块
 *   node tools/sector_rating.js --in snap.json # 用本地快照跑（测试/排查，不拉网）
 *
 * 输出：dashboard/sector_rank.js（window.SECTOR_RATING，几十 KB 级小文件，publish 自动带上）
 *
 * ⚠️ 评级语义是「状态判断」（可关注/观望/过热勿追），不是荐股口径；与个股 status 体系一致。
 * 东财字段：f3=涨跌幅% f12=代码 f14=名称 f62=主力净流入(元) f104=上涨家数 f105=下跌家数
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DASH = path.join(ROOT, 'dashboard');
const OUT_FILE = path.join(DASH, 'sector_rank.js');
const DATA_FILE = path.join(DASH, 'data.js');

/* ── 纯函数（导出供 test_scripts 断言）────────────────────────── */

/** 板块名归一化：全角→半角、去空白、去常见装饰后缀（概念/板块/指数/行情）。 */
function normalizeName(s) {
  return String(s || '')
    .replace(/[\u3000\s]+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/(概念|板块|指数|行情)$/g, '')
    .toLowerCase();
}

/**
 * 名称匹配：精确 → 双向包含。
 * 包含匹配的 tie-break 用**成交额最大**（turnover），不是名字最短——
 * 博主说的是大类（「医药」），东财是细分（医药电商/医药商业/生物医药概念），
 * 取成交额最大者最接近「大类」语义（2026-09-25 实测「取最短」会错配到医药电商）。
 * 返回 { row, how } 或 null。how: 'exact' | 'contain'。
 */
function matchSector(name, pool) {
  const q = normalizeName(name);
  if (!q || !pool || !pool.length) return null;
  let exact = null;
  let best = null;
  for (const row of pool) {
    const c = normalizeName(row.name);
    if (!c) continue;
    if (c === q) { exact = row; break; }
    if (c.indexOf(q) >= 0 || q.indexOf(c) >= 0) {
      const tv = (typeof row.turnover === 'number' && isFinite(row.turnover)) ? row.turnover : -1;
      if (!best || tv > best._tv) best = Object.assign({ _tv: tv }, row);
    }
  }
  if (exact) return { row: exact, how: 'exact' };
  if (best) return { row: best, how: 'contain' };
  return null;
}

/**
 * 评级规则引擎。输入：chg 涨跌幅%，inflow 主力净流入(元)，up/down 涨跌家数。
 * 返回 { rating, why: string[] }。rating ∈ '可关注'|'过热勿追'|'退潮观望'|'中性'。
 * 规则优先级：过热勿追 > 退潮观望 > 可关注 > 中性。
 * 阈值依据：高开>5% 追入胜率 35%（n=17，09-22 统计）的教训外推到板块级——
 * 涨幅过热(+4%)或「价涨钱出」都不给好脸色。
 */
function rateRules(chg, inflow, up, down) {
  const why = [];
  const tot = (up || 0) + (down || 0);
  const upR = tot > 0 ? up / tot : null;
  const chgOk = typeof chg === 'number' && isFinite(chg);
  const inOk = typeof inflow === 'number' && isFinite(inflow);
  if (!chgOk || !inOk || upR === null) {
    return { rating: '中性', why: ['数据不全（缺涨跌幅/资金/家数）→ 保守给中性'] };
  }
  const inYi = (inflow / 1e8).toFixed(2);   // 亿元，展示用
  why.push('涨跌幅 ' + (chg > 0 ? '+' : '') + chg + '%，主力净流入 ' +
    (inflow >= 0 ? '+' : '') + inYi + ' 亿，上涨/下跌 ' + up + '/' + down);

  if (chg > 4) {
    why.push('当日涨幅 > 4%：情绪过热，次日溢价历史胜率低（参照个股高开教训）');
    return { rating: '过热勿追', why };
  }
  if (chg > 2 && inflow < 0) {
    why.push('涨 > 2% 但主力资金净流出：价涨钱出，冲高大概率是兑现盘');
    return { rating: '过热勿追', why };
  }
  if (inflow < 0 && upR < 0.45) {
    why.push('资金净流出且上涨家数占比 ' + Math.round(upR * 100) + '% < 45%：赚钱效应退潮');
    return { rating: '退潮观望', why };
  }
  if (inflow > 0 && upR >= 0.55) {
    why.push('主力净流入为正且上涨家数占比 ' + Math.round(upR * 100) + '% ≥ 55%：资金与广度同向');
    return { rating: '可关注', why };
  }
  why.push('资金/广度方向不一致，无明确信号');
  return { rating: '中性', why };
}

/** 对一期晚报的板块列表整体评级。sectors=[{name,kind?}]，snap={industry:[],concept:[]}。 */
function rateAll(sectors, snap, snapDate) {
  const pool = (snap.industry || []).concat(snap.concept || []);
  const items = [];
  const unmatched = [];
  (sectors || []).forEach(function (x) {
    if (!x || !x.name) return;
    const m = matchSector(x.name, pool);
    if (!m) { unmatched.push(x.name); return; }
    const r = rateRules(m.row.chg, m.row.inflow, m.row.up, m.row.down);
    items.push({
      name: x.name,
      kind: x.kind || null,
      matched: m.row.name,
      how: m.how,
      rating: r.rating,
      why: r.why,
      chg: m.row.chg,
      inflowYi: +(m.row.inflow / 1e8).toFixed(2),
      up: m.row.up,
      down: m.row.down,
    });
  });
  return { snapshotDate: snapDate || null, items: items, unmatched: unmatched };
}

/* ── IO（CLI 部分）──────────────────────────────────────────── */

/** 拉东财板块全量。kind: '2'=行业 '3'=概念。失败抛错（由调用方兜）。
 *  🔴 双通道（2026-09-25 实测教训）：东财对 `clist` 路径做了 TLS 指纹风控——
 *  Node fetch(undici) 一律 UND_ERR_SOCKET（连 push2delay 也掐），而 curl 能通。
 *  所以先试 fetch（ECS 上一直用 node 抓东财、大概率直接通），失败降级 curl 子进程。
 *  host 用 push2delay（verify.js 同款）：收盘后 delay 数据即终值，对评级无影响。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const EM_HEADERS = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };

function curlJSON(url) {
  return new Promise(function (resolve, reject) {
    execFile('curl', ['--noproxy', '*', '-s', '-m', '15', '-H', 'User-Agent: ' + UA,
      '-H', 'Referer: https://quote.eastmoney.com/', url],
      { maxBuffer: 8 * 1024 * 1024 }, function (err, stdout) {
        if (err) return reject(new Error('curl ' + err.message));
        resolve(stdout);
      });
  });
}

async function fetchSectorList(kind) {
  // 🔴 匿名请求每页上限 100 条（pz>100 也只返 100，2026-09-25 实测）→ 按 total 分页拉全
  const base = 'https://push2delay.eastmoney.com/api/qt/clist/get?po=1&np=1' +
    '&fltt=2&invt=2&fid=f62&fs=m:90+t:' + kind +
    '&fields=f3,f6,f12,f14,f62,f104,f105&pz=100&pn=';
  const grab = async u => {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(12000), headers: EM_HEADERS });
      if (r.ok) return await r.text();
    } catch (e) { /* 走 curl 降级 */ }
    const txt = await curlJSON(u);
    if (/^<!DOCTYPE|<html/i.test(txt)) throw new Error('东财返回 HTML（疑似风控页）');
    return txt;
  };
  const out = [];
  let total = Infinity;
  for (let pn = 1; out.length < total; pn++) {
    const j = JSON.parse(await grab(base + pn));
    const data = j && j.data;
    if (!data || !Array.isArray(data.diff)) throw new Error('东财返回无 data.diff (t=' + kind + ' pn=' + pn + ')');
    total = typeof data.total === 'number' ? data.total : Infinity;
    for (const x of data.diff) {
      out.push({
        code: x.f12, name: x.f14,
        chg: typeof x.f3 === 'number' ? x.f3 : null,
        turnover: typeof x.f6 === 'number' ? x.f6 : null,   // 成交额（元），匹配 tie-break 用
        inflow: typeof x.f62 === 'number' ? x.f62 : null,
        up: typeof x.f104 === 'number' ? x.f104 : 0,
        down: typeof x.f105 === 'number' ? x.f105 : 0,
      });
    }
    if (pn > 12) break;   // 保险丝：最多 12 页
    await new Promise(r2 => setTimeout(r2, 350));   // 防 WAF 节流
  }
  return out;
}

/** 从 data.js 取最新一期晚报的板块热点。返回 {date, sectors} 或 null。 */
function latestEveningSectors() {
  const s = fs.readFileSync(DATA_FILE, 'utf8');
  const j = JSON.parse(s.slice(s.indexOf('=') + 1).replace(/;\s*$/, ''));
  const list = j.reports || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i].evening;
    if (ev && ev['板块热点'] && ev['板块热点'].length) {
      return { date: list[i].date, sectors: ev['板块热点'] };
    }
  }
  return null;
}

function writeOut(result) {
  const payload = 'window.SECTOR_RATING=' + JSON.stringify(result) + ';';
  fs.writeFileSync(OUT_FILE, payload, 'utf8');
  return Buffer.byteLength(payload);
}

async function main() {
  const args = process.argv.slice(2);
  const inIdx = args.indexOf('--in');
  const onlyIdx = args.indexOf('--only');

  // --only name1,name2：只评指定板块（排查用）
  let onlyNames = null;
  if (onlyIdx >= 0) onlyNames = (args[onlyIdx + 1] || '').split(',').filter(Boolean).map(function (n) { return { name: n }; });

  // 1) 快照：--in 本地文件 或 拉东财
  let snap, snapDate;
  if (inIdx >= 0) {
    const local = JSON.parse(fs.readFileSync(args[inIdx + 1], 'utf8'));
    snap = { industry: local.industry || [], concept: local.concept || [] };
    snapDate = local.date || null;
    console.log('· 快照来源：本地 ' + args[inIdx + 1]);
  } else {
    const [ind, cpt] = await Promise.all([fetchSectorList('2'), fetchSectorList('3')]);
    snap = { industry: ind, concept: cpt };
    snapDate = new Date().toISOString().slice(0, 10);
    console.log('· 东财快照：行业 ' + ind.length + ' + 概念 ' + cpt.length);
  }

  // 2) 待评板块
  let target;
  if (onlyNames) {
    target = { date: null, sectors: onlyNames };
  } else {
    target = latestEveningSectors();
    if (!target) {
      console.log('· data.js 最新晚报没有板块热点 → 无可评级对象，退出 0（软依赖）');
      return 0;
    }
  }
  console.log('· 评级对象：' + target.date + ' 晚报 ' + target.sectors.length + ' 个板块');

  // 3) 评级 + 写出
  const result = rateAll(target.sectors, snap, snapDate);
  result.targetDate = target.date;
  result.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  result.source = '东方财富板块列表（行业+概念，收盘口径）';
  result.disclaimer = '评级为规则引擎对公开行情的状态判断，不构成投资建议；匹配不到的板块不标评级。';
  const bytes = writeOut(result);

  console.log('· 匹配 ' + result.items.length + ' / 未匹配 ' + result.unmatched.length +
    (result.unmatched.length ? '（' + result.unmatched.join('、') + '）' : ''));
  result.items.forEach(function (it) {
    console.log('   [' + it.rating + '] ' + it.name + (it.matched !== it.name ? ' → 东财「' + it.matched + '」' : '') +
      '  ' + (it.chg > 0 ? '+' : '') + it.chg + '% / ' + it.inflowYi + '亿');
  });
  console.log('✔ 已写 dashboard/sector_rank.js（' + (bytes / 1024).toFixed(1) + ' KB）');
  return 0;
}

module.exports = { normalizeName, matchSector, rateRules, rateAll };
if (require.main === module) {
  main().then(function (rc) { process.exitCode = rc; })
    .catch(function (e) {
      console.error('✗ sector_rating：' + e.message);
      process.exitCode = 1;   // 软依赖：非 0 由调用方记日志，不阻塞发布
    });
}
