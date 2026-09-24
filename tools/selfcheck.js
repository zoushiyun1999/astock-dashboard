#!/usr/bin/env node
/**
 * 自检程序（2026-09-24）：把「本会话踩过的每一类 bug」固化成可重复执行的守卫。
 * 用法：
 *   node tools/selfcheck.js            # 本地静态 + 数据契约 + 两套单元测试
 *   node tools/selfcheck.js --online   # 追加线上一致性检查（cv==code、关键资源 200）
 * 退出码：0 全过 / 1 有失败。cron.sh 在每晚 verify 发布后软调用（失败只记日志不阻塞）。
 *
 * 覆盖的「案底」（每条守卫对应一次真实事故，别删）：
 *   A. 滑块公式两处维护不一致 → 量价滑块偏 2px（renderPicks vs positionSubGlider）
 *   B. loadTrack 丢 el.src → 走势按钮 Promise 永远挂起「点不开」
 *   C. 失败 Promise 永久缓存 → 第一次网络抖动后整个会话打不开
 *   D. emptyCard 传了 EMPTY_ICO 里不存在的图标键（'⏭'）→ 静默降级
 *   E. verifyBadge 调用点漏传 (code, ch) → 徽章静默消失
 *   F. 代码改了没重新盖章（cv 与 version.json.code 漂移）→ 触发多余整页重载
 *   G. CSS 类在 JS 里用了但 style.css 没定义（改版遗留）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ONLINE = process.argv.includes('--online');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const results = [];              // {group, name, ok, detail}
function record(group, name, ok, detail) { results.push({ group, name, ok, detail }); }
function check(group, name, fn) {
  try {
    const r = fn();
    record(group, name, r === true || (r && r.ok), r && r.ok ? r.detail : String(r && r.detail || '未通过'));
  } catch (e) {
    record(group, name, false, '检查器异常: ' + e.message);
  }
}
/** async 版：check() 不等待 Promise，会把「还没跑完」记成失败 —— 异步检查必须用这个（首版踩过） */
async function acheck(group, name, fn) {
  try {
    const r = await fn();
    record(group, name, r === true || (r && r.ok), r && r.ok ? r.detail : String(r && r.detail || '未通过'));
  } catch (e) {
    record(group, name, false, '检查器异常: ' + e.message);
  }
}

/* ── 1. 两套单元测试 ── */
function runSuite(file) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join('tools', file)], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => {
      const m = out.match(/共\s*(\d+)\s*项断言/);
      resolve({ code, total: m ? +m[1] : null, tail: out.trim().split('\n').slice(-2).join(' | ') });
    });
    p.on('error', e => resolve({ code: -1, total: null, tail: e.message }));
  });
}

/* ── 3. 静态守卫 ── */
function staticChecks() {
  const app = read('dashboard/js/app.js');
  const css = read('dashboard/css/style.css');
  const G = '静态守卫';

  // A. 滑块公式必须两处一致（同一次公式只许写一份语义，两处字面量必须完全相同）
  check(G, '滑块公式：renderPicks 与 positionSubGlider 两处一致', () => {
    const gp = app.match(/gliderStyle = 'left:' \+ \(curSub === 'screener' \? '([^']+)' : '([^']+)'\) \+ ';width:([^']+)'/);
    const ps = app.match(/glider\.style\.left = curSub === 'screener' \? '([^']+)' : '([^']+)';\s*\n\s*glider\.style\.width = '([^']+)';/);
    if (!gp || !ps) return { ok: false, detail: '公式写法变了、正则抓不到 —— 请同步更新本守卫' };
    const same = gp[1] === ps[1] && gp[2] === ps[2] && gp[3] === ps[3];
    return { ok: same, detail: same ? 'left/width 字面量一致' : `renderPicks=(${gp[2]},${gp[1]},${gp[3]}) vs positionSubGlider=(${ps[2]},${ps[1]},${ps[3]})` };
  });

  // B. loadTrack 必须真的去加载（el.src），且 track.js 文件存在
  check(G, 'loadTrack：el.src 存在且指向 track.js', () => {
    const okSrc = /el\.src\s*=\s*'track\.js\?v=' \+ assetVer\(\)/.test(app);
    return { ok: okSrc && fs.existsSync(path.join(ROOT, 'dashboard/track.js')),
      detail: okSrc ? 'el.src 已设置' : 'el.src 丢失（走势按钮会永久挂起）' };
  });

  // C. 加载失败必须清 TRACK_P（允许重试），且必须有超时
  check(G, 'loadTrack：失败清空 TRACK_P + 12s 超时', () => {
    const hasClear = /TRACK_P = null;/.test(app);
    const hasTimer = /setTimeout\(function \(\) \{ finish\(false, '加载超时/.test(app);
    return { ok: hasClear && hasTimer, detail: `清槽=${hasClear} 超时=${hasTimer}` };
  });

  // D. EMPTY_ICO：emptyCard 的图标字面量必须都在表里，且不得残留 emoji
  check(G, 'EMPTY_ICO：emptyCard 图标键全部合法、无 emoji 残留', () => {
    const block = app.match(/var EMPTY_ICO = \{[\s\S]*?\n  \};/);
    if (!block) return { ok: false, detail: '找不到 EMPTY_ICO 定义' };
    const keys = new Set([...block[0].matchAll(/^\s{4}(\w+):\s*\{/gm)].map(m => m[1]));
    const calls = [...app.matchAll(/emptyCard\((?:(?!emptyCard)[^)])*?,\s*'(\w+)'\s*\)/g)].map(m => m[1]);
    const bad = calls.filter(k => !keys.has(k));
    const emoji = block[0].match(/['"][^\w\s'"]*[\u{1F300}-\u{1FAFF}\u2600-\u27BF][^'"]*['"]/u);
    if (bad.length) return { ok: false, detail: '未知图标键: ' + bad.join(',') + '（EMPTY_ICO 只有 ' + [...keys].join(',') + '）' };
    if (emoji) return { ok: false, detail: 'EMPTY_ICO 值里混入 emoji: ' + emoji[0] };
    return { ok: true, detail: '键=' + [...keys].join(',') + '，调用点 ' + calls.length + ' 处全部合法' };
  });

  // E. verifyBadge 调用点必须带 (verify, code, ch) —— 单参调用会让徽章静默消失
  check(G, 'verifyBadge：调用点必须传 code 与 ch', () => {
    const calls = [...app.matchAll(/verifyBadge\(([^)]*)\)/g)].map(m => m[1].trim());
    const bad = calls.filter(a => (a.match(/,/g) || []).length < 2);
    return { ok: bad.length === 0, detail: bad.length ? '单参调用: ' + bad.join(' ; ') : '共 ' + calls.length + ' 处，全部带 code+ch' };
  });

  // F1. 已盖章的 cv 与当前代码一致（漂移 = 忘跑 bump_version / code_version）
  //     🔴 直接复用 code_version.js 的 computeHash/readStamp —— 绝不重新实现归一化/哈希
  //     （同一逻辑两处维护正是本守卫要防的 bug 类型，2026-09-24 自检首版就犯了一次）
  check(G, '盖章：index.html 的 cv == 当前代码哈希', () => {
    const cv = require('./code_version.js');
    const stamp = cv.readStamp();
    if (!stamp) return { ok: false, detail: 'index.html 没有 cv 章' };
    const cur = cv.computeHash();
    return { ok: cur === stamp, detail: `stamp=${stamp} compute=${cur}` };
  });

  // F2. version.json.code 与章一致（本地视角；线上一致性见 --online）
  check(G, 'version.json.code 与 index.html 的章一致', () => {
    const stamp = (read('dashboard/index.html').match(/name="cv"\s+content="([0-9a-f]+)"/) || [])[1];
    let j = null;
    try { j = JSON.parse(read('dashboard/version.json')); } catch (e) { return { ok: false, detail: 'version.json 解析失败' }; }
    if (j.code === undefined) return { ok: false, detail: 'version.json 没有 code 字段' };
    return { ok: j.code === stamp, detail: `code=${j.code} cv=${stamp}` };
  });

  // G. 关键 CSS 类：JS 用到的必须在 style.css 有定义（改版遗留守卫）
  check(G, 'CSS 类守卫：JS 使用的 tk/sub/st-verify 类都有定义', () => {
    const need = ['tk-link', 'tk-btn', 'tk-days', 'tk-tbl', 'sub-row', 'st-verify', 'v-up', 'v-down', 'v-warn', 'date-bar', 'db-group', 'db-latest'];
    const missing = need.filter(c => !new RegExp('\\.' + c + '[\\s,{.:]').test(css));
    const orphan = /\.tk-cta[\s,{.:]/.test(css);
    return { ok: !missing.length && !orphan, detail: missing.length ? '缺定义: ' + missing.join(',') : (orphan ? '.tk-cta 已废弃但 CSS 残留' : need.length + ' 个类全部有定义，无废弃残留') };
  });

  // H. index.html 引用的本地资源都存在
  check(G, 'index.html 引用的本地资源文件存在', () => {
    const html = read('dashboard/index.html');
    const refs = [...html.matchAll(/(?:src|href)="(?!https?:)([^"?]+)\?v=\d+"/g)].map(m => m[1]);
    const missing = refs.filter(f => !fs.existsSync(path.join(ROOT, 'dashboard', f)));
    return { ok: !missing.length, detail: missing.length ? '缺文件: ' + missing.join(',') : refs.length + ' 个引用全部存在' };
  });

  return app;
}

/* ── 4. 数据契约 ── */
function dataChecks() {
  const G = '数据契约';
  const loadVar = (f, v) => {
    const s = read(f);
    return new Function('window', s + '\nreturn window.' + v + ';')({});
  };

  check(G, 'data.js 可解析；reports 升序（newest-at-bottom）且 ≤7 期', () => {
    const R = loadVar('dashboard/data.js', 'REPORTS');
    const ds = (R.reports || []).map(r => r.date);
    if (!ds.length) return { ok: false, detail: 'reports 为空' };
    let asc = true;
    for (let i = 1; i < ds.length; i++) if (ds[i] < ds[i - 1]) asc = false;
    return { ok: asc && ds.length <= 7, detail: `${ds.length} 期: ${ds[0]}→${ds[ds.length - 1]} 升序=${asc}` };
  });

  check(G, 'screener.js 可解析且期数 ≤8', () => {
    const S = loadVar('dashboard/screener.js', 'SCREENER');
    const n = (S || []).length;
    return { ok: Array.isArray(S) && n <= 8, detail: n + ' 期' };
  });

  check(G, 'track_ledger.json 可解析；每条记录有 t 快照', () => {
    const L = JSON.parse(read('tools/track_ledger.json'));
    const recs = Object.entries(L.recs || {});
    const bad = recs.filter(([k, v]) => !v.t).map(([k]) => k);
    return { ok: !bad.length, detail: recs.length + ' 条账本记录' + (bad.length ? '，缺 t: ' + bad.slice(0, 3).join(',') : '') };
  });

  check(G, 'dashboard/track.js 结构完整（series/stats/statAt）', () => {
    const T = loadVar('dashboard/track.js', 'TRACK');
    const ks = new Set((T.series || []).map(s => s.k));
    const dup = (T.series || []).length - ks.size;
    const okStats = T.stats && T.stats.m && T.stats.e && T.stats.s;
    return { ok: !!T.series && !!T.statAt && !!okStats && dup === 0,
      detail: `${(T.series || []).length} 条明细（重复 key ${dup}），updatedAt=${T.updatedAt}` };
  });

  check(G, '效果统计的渠道覆盖 = series 的渠道集合', () => {
    const T = loadVar('dashboard/track.js', 'TRACK');
    const inStats = Object.keys(T.stats || {});
    const inSeries = [...new Set((T.series || []).map(s => s.ch))];
    const missing = inSeries.filter(c => !inStats.includes(c));
    return { ok: !missing.length, detail: missing.length ? 'stats 缺渠道: ' + missing.join(',') : 'm/e/s 齐全' };
  });
}

/* ── 5. 线上一致性（--online） ── */
async function onlineChecks() {
  const G = '线上一致性';
  const base = 'https://asx.79zl.cn/';
  const get = async p => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(base + p + '?_s=' + Date.now(), { signal: ac.signal });
      return { status: r.status, text: await r.text() };
    } finally { clearTimeout(t); }
  };

  let html, ver;
  await acheck(G, '线上 index.html / version.json 可达', async () => {
    const a = await get('index.html'), b = await get('version.json');
    html = a.text;
    ver = JSON.parse(b.text);
    return { ok: a.status === 200 && b.status === 200, detail: `index=${a.status} version=${b.status}` };
  });
  await acheck(G, '线上 cv == version.json.code（不触发多余重载）', () => {
    if (!html || !ver) return { ok: false, detail: '前一项未通过，跳过' };
    const cv = (html.match(/name="cv"\s+content="([0-9a-f]+)"/) || [])[1];
    return { ok: cv && cv === ver.code, detail: `cv=${cv} code=${ver.code}` };
  });
  await acheck(G, '线上 app.js 含关键符号（徽章/懒加载守卫）', async () => {
    const a = await get('js/app.js');
    const okSym = a.status === 200 && a.text.indexOf('入场至今') >= 0 && /el\.src\s*=\s*'track\.js/.test(a.text);
    return { ok: okSym, detail: a.status === 200 ? '符号齐全' : 'HTTP ' + a.status };
  });
  await acheck(G, '线上 track.js 可达', async () => {
    const a = await get('track.js');
    return { ok: a.status === 200 && a.text.indexOf('window.TRACK') === 0, detail: 'HTTP ' + a.status };
  });
}

/* ── 主流程 ── */
(async () => {
  console.log('═══ 自检 selfcheck · ' + new Date().toLocaleString('zh-CN', { hour12: false }) +
    (ONLINE ? ' · 含线上检查' : '') + ' ═══');

  const app = staticChecks();
  dataChecks();

  const G = '单元测试';
  const [a, b] = await Promise.all([runSuite('test_scripts.js'), runSuite('test_health_logic.js')]);
  record(G, 'test_scripts.js', a.code === 0, a.code === 0 ? (a.total || '?') + ' 项全过' : a.tail);
  record(G, 'test_health_logic.js', b.code === 0, b.code === 0 ? (b.total || '?') + ' 项全过' : b.tail);
  void app;

  if (ONLINE) await onlineChecks();

  /* 汇总输出 */
  let lastGroup = '', pass = 0, fail = 0;
  for (const r of results) {
    if (r.group !== lastGroup) { console.log('\n── ' + r.group + ' ──'); lastGroup = r.group; }
    console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + (r.ok && r.detail ? '  · ' + r.detail : ''));
    console.log(r.ok ? '' : '        ↳ ' + r.detail);
    r.ok ? pass++ : fail++;
  }
  console.log('\n─── 结论: ' + (fail ? '❌ ' + fail + ' 项失败' : '✅ 全部通过') + `（${pass}/${results.length}）───`);
  process.exit(fail ? 1 : 0);
})();
