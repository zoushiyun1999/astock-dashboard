#!/usr/bin/env node
/**
 * 个股「名称 ↔ 代码」双校验器
 *
 * 背景：复盘发现两类硬伤——
 *   1. 代码错配：早报把「龙版传媒」标成 600936（实为北投科技）
 *   2. 幻觉股：晚报出现 A 股查无此股的「晋迪股份/琼泰集团/新相网络」
 *
 * 做法：
 *   ① 拉全市场行情建立 code→name / name→code 双向索引（一次快照）
 *   ② 索引未命中的条目，一律走「二次复核」：先按 code 单查、再按名称搜索
 *      —— 因为东财分页会随行情排序漂移，单次快照可能漏掉个别股票，
 *         不复核会把真实股票（如协鑫能科 002015）误判成幻觉股
 *   ③ 分类处理：名称笔误 → 修正名称；代码错配/缺失 → 回填正确代码；
 *      二次复核仍查无此股 → 判定幻觉，--prune 时剔除
 *
 * 用法：
 *   node tools/check_codes.js              # 只体检，输出报告，不改文件
 *   node tools/check_codes.js --fix        # 修正笔误名称、修正/回填代码
 *   node tools/check_codes.js --prune      # 额外剔除幻觉条目（需配合 --fix）
 *
 * 退出码：0 = 无异常；1 = 发现异常（供 automation 判断是否需要人工介入）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');
const EM = 'https://push2delay.eastmoney.com';
const SEARCH = 'https://searchapi.eastmoney.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };

const FIX = process.argv.includes('--fix');
const PRUNE = process.argv.includes('--prune');

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

/** 名称归一化：全角转半角、去空白 */
function norm(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/\s|　/g, '')
    .trim();
}

function secidOf(code) {
  return (/^[46]/.test(code) ? '1.' : '0.') + code;
}

// ── 索引1：全市场快照（沪深京：主板 + 创业板 + 科创板 + 北交所）──
async function fetchNameIndex() {
  const fsStr = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
  const byCode = {}, byName = {};
  let total = 0;
  for (let pn = 1; pn <= 60; pn++) {
    const url = EM + '/api/qt/clist/get?pn=' + pn + '&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3' +
      '&fs=' + encodeURIComponent(fsStr) + '&fields=f12,f14';
    const j = await getJSON(url);
    const d = (j && j.data && j.data.diff) || [];
    if (!d.length) break;
    d.forEach(function (x) {
      if (!x.f12 || !x.f14) return;
      byCode[String(x.f12)] = x.f14;
      byName[norm(x.f14)] = String(x.f12);
    });
    total += d.length;
    if (total >= (j.data.total || 0)) break;
  }
  return { byCode, byName, total };
}

// ── 索引2（兜底）：按代码单查真实名称 ──
async function lookupByCode(code) {
  if (!code) return null;
  const j = await getJSON(EM + '/api/qt/stock/get?secid=' + secidOf(code) + '&fields=f57,f58');
  const d = j && j.data;
  if (d && d.f57 && d.f58) return { code: String(d.f57), name: String(d.f58) };
  return null;
}

// ── 索引3（兜底）：按名称搜索代码 ──
async function lookupByName(name) {
  const url = SEARCH + '/api/suggest/get?input=' + encodeURIComponent(name) +
    '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8';
  const j = await getJSON(url, { 'User-Agent': UA });
  const arr = (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
  const hit = arr.filter(function (x) { return norm(x.Name) === norm(name); })[0];
  if (hit && hit.Code) return { code: String(hit.Code), name: String(hit.Name) };
  // 退一步：同类 A 股里取第一个（仅当搜索结果唯一时）
  if (arr.length === 1 && arr[0].Code) return { code: String(arr[0].Code), name: String(arr[0].Name) };
  return null;
}

function loadData() {
  let data = null;
  if (fs.existsSync(DATA)) {
    try { eval(fs.readFileSync(DATA, 'utf8').replace('window.REPORTS =', 'data =')); } catch (e) { }
  }
  return data;
}

/** 收集 data.js 中所有推荐条目（带数组与索引，便于回写/删除） */
function collectPicks(data) {
  const out = [];
  (data.reports || []).forEach(function (rec) {
    const date = rec.date || '';
    if (rec.morning && Array.isArray(rec.morning['今日关注'])) {
      rec.morning['今日关注'].forEach(function (p, pi) {
        if (p && p.name) out.push({ pick: p, where: date + ' 早报·今日关注[' + pi + ']', arr: rec.morning['今日关注'], idx: pi });
      });
    }
    if (rec.evening && Array.isArray(rec.evening['明日关注'])) {
      rec.evening['明日关注'].forEach(function (g, gi) {
        (g.picks || []).forEach(function (p, pi) {
          if (p && p.name) out.push({ pick: p, where: date + ' 晚报·明日关注[' + gi + '].picks[' + pi + ']', arr: g.picks, idx: pi });
        });
      });
    }
  });
  return out;
}

(async function main() {
  console.log('▶ 个股代码校验开始');
  const idx = await fetchNameIndex();
  console.log('  全市场索引：' + idx.total + ' 只');
  if (idx.total < 1000) { console.log('  ✗ 行情索引异常，放弃校验（避免误改数据）'); process.exit(1); }

  const data = loadData();
  if (!data) { console.log('  ✗ 读取 data.js 失败'); process.exit(1); }

  const items = collectPicks(data);
  console.log('  待校验推荐条目：' + items.length + ' 条');

  const ok = [], filled = [], renamed = [], mismatched = [], ghost = [], pruneTargets = [];

  for (const it of items) {
    const p = it.pick;
    const name = p.name;
    const code = p.code ? String(p.code).replace(/\D/g, '') : '';
    const nName = norm(name);

    let realName = idx.byCode[code] || null;   // 该代码对应的真实名称（可能 null）
    let nameCode = idx.byName[nName] || null;  // 该名称对应的代码（可能 null）

    // 命中即通过
    if (code && realName && norm(realName) === nName) { ok.push({ where: it.where, name: name, code: code }); continue; }

    // 未命中 → 二次复核（防止分页漂移误判）
    if (code && !realName) {
      const r = await lookupByCode(code);
      if (r) realName = r.name;
    }
    if (!nameCode) {
      const r = await lookupByName(name);
      if (r) nameCode = r.code;
    }

    // 名称能查到 → 以名称为准（推荐名来自博主原文/人气榜，代码才是模型补的，易错）
    if (nameCode) {
      // 名称与代码本就对应（可能二次复核才确认）→ 通过
      if (code === nameCode) { ok.push({ where: it.where, name: name, code: code }); continue; }
      if (!code) {
        filled.push({ where: it.where, name: name, newCode: nameCode });
        if (FIX) p.code = nameCode;
      } else {
        mismatched.push({
          where: it.where, name: name, oldCode: code, newCode: nameCode,
          note: realName ? '该代码实为「' + realName + '」' : '代码不存在'
        });
        if (FIX) p.code = nameCode;
      }
      continue;
    }
    // 名称查不到、但代码有效 → 名称笔误（真实股票，绝不删除，只改名）
    if (realName) {
      renamed.push({ where: it.where, oldName: name, realName: realName, code: code });
      if (FIX) p.name = realName;
      continue;
    }
    if (!nameCode && !realName) {
      // 二次复核仍查不到 → 幻觉股
      ghost.push({ where: it.where, name: name, code: code });
      if (PRUNE) pruneTargets.push(it);
      continue;
    }
    ok.push({ where: it.where, name: name, code: code || nameCode });
  }

  console.log('\n【校验结果】');
  console.log('  ✅ 名称/代码一致：' + ok.length + ' 条');
  if (filled.length) {
    console.log('\n  🆕 缺失代码可回填：' + filled.length + ' 条' + (FIX ? '（已回填）' : '（未启用 --fix）'));
    filled.forEach(function (x) { console.log('    · ' + x.where + '  ' + x.name + ' → ' + x.newCode); });
  }
  if (mismatched.length) {
    console.log('\n  ⚠️  代码错配/无效：' + mismatched.length + ' 条' + (FIX ? '（已修正）' : '（未启用 --fix）'));
    mismatched.forEach(function (x) {
      console.log('    · ' + x.where + '  ' + x.name + '  原code ' + x.oldCode + '（' + x.note + '）→ 修正为 ' + x.newCode);
    });
  }
  if (renamed.length) {
    console.log('\n  ✏️  名称笔误（真实股票，仅改名不删除）：' + renamed.length + ' 条' + (FIX ? '（已修正）' : '（未启用 --fix）'));
    renamed.forEach(function (x) {
      console.log('    · ' + x.where + '  ' + x.oldName + ' → 正确名称「' + x.realName + '」(' + x.code + ')');
    });
  }
  if (ghost.length) {
    console.log('\n  ❌ 查无此股（二次复核确认，疑似幻觉）：' + ghost.length + ' 条' + (PRUNE && FIX ? '（已剔除）' : '（未启用 --prune）'));
    ghost.forEach(function (x) { console.log('    · ' + x.where + '  ' + x.name + (x.code ? ' (' + x.code + ')' : ' (无代码)')); });
  }

  if (FIX) {
    if (PRUNE && pruneTargets.length) {
      const byArr = new Map();
      pruneTargets.forEach(function (it) {
        if (!byArr.has(it.arr)) byArr.set(it.arr, []);
        byArr.get(it.arr).push(it.idx);
      });
      byArr.forEach(function (idxs, arr) {
        idxs.sort(function (a, b) { return b - a; }).forEach(function (i) { arr.splice(i, 1); });
      });
    }
    fs.writeFileSync(DATA, 'window.REPORTS = ' + JSON.stringify(data, null, 2) + ';\n');
    console.log('\n  ✔ 已写回 dashboard/data.js' + (PRUNE ? '，剔除 ' + pruneTargets.length + ' 条幻觉股' : ''));
  } else {
    console.log('\n  （体检模式，未修改任何文件。加 --fix 生效，加 --prune 剔除幻觉股）');
  }

  process.exit(ghost.length || mismatched.length || renamed.length ? 1 : 0);
})();
