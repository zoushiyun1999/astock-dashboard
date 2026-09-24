#!/usr/bin/env node
/**
 * 前端「代码版本」计算与盖章（2026-09-24）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * index.html 末尾的「破缓存自检」原本比对的是资源版本号 `?v=<时间戳>`。
 * 但 `?v=` **每次 publish 都会 bump**（早报/晚报/选股/验证 → 3~5 次/天），
 * 且它同时挂在 CSS 和 4 个 JS 上 —— 于是**纯数据更新也会触发一次整页重载**。
 * 用户观感就是"进去加载比较慢"：页面刚出来、正准备读，它闪一下又从头加载。
 *
 * 而数据变化本来就有另一条路：app.js 每 60s 拉一次 version.json，
 * key 变了就下载 data.json 就地重渲染（不重载）。**整页重载只为"代码变了"服务。**
 *
 * 做法：把**前端代码的内容**算成短哈希，盖章进 index.html 的 <meta name="cv">，
 * 再由 export_json.js 带进 version.json；客户端只比对 version.json.code 与自己的 meta。
 *
 * ── 🔴 归一化是必需的，不是可选的 ──────────────────────────────────
 * index.html 自己就含 `?v=<时间戳>`（每次 bump 都变），而盖章又会改写 meta 的内容 ——
 * 若不先把这两处抹掉再哈希，哈希会跟着时间戳一起变，等于什么都没做（且无法幂等）。
 * 所以 normalizeHtml() 先抹掉 `?v=<数字>` 与 cv meta 的 content，再参与计算。
 *
 * 用法：
 *   node tools/code_version.js          # 计算并盖章（幂等：内容没变则不写盘）
 *   node tools/code_version.js --check  # 只打印，不写文件
 *   node tools/code_version.js --print  # 只打印当前哈希（= 文件里章的值）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DASH = path.join(__dirname, '..', 'dashboard');

/**
 * 参与哈希的文件：**只放影响主看板 index.html 的前端代码**。
 *  · 不含 data.js / screener.js / holidays.js —— 那是「数据」，
 *    由 60s 轮询就地更新，**不该**触发整页重载（这正是本次要修的问题）
 *  · 不含 sectors.html —— 独立页、自管缓存（它靠手改 ?v=）。
 *    改它不需要主看板重载；而它共用的 style.css 已在列表里，CSS 变更不会漏。
 */
const CODE_FILES = ['index.html', 'css/style.css', 'js/app.js'];

/** 盖章用的 meta。内容只允许小写十六进制，便于正则安全匹配 */
const META_RE = /<meta\s+name="cv"\s+content="([0-9a-f]*)"\s*>/;
const META_TAG = (h) => '<meta name="cv" content="' + h + '">';

/**
 * 抹掉 index.html 里「每次发布都会变」的两处 —— 否则哈希跟着时间戳走。
 * 只对 index.html 归一化；CSS / JS 是纯代码，原样参与。
 *
 * 🔴 盖章那行必须**整行删掉**，不是把 content 抹空。
 *    只抹空的话「还没盖章」与「已盖章」两种状态归一化结果不同 →
 *    首次盖章写进去的哈希与第二次算出来的不一致（首次那个是错的），
 *    要跑两遍才收敛。2026-09-24 实测踩到：run1=34122979b3b0 → run2=80a0a7c167a7。
 *    删整行（含换行）才能让两种状态完全等价。换行也要一起删 —— 插入时就是 `tag + '\n'`。
 */
function normalizeHtml(text) {
  return String(text)
    .replace(/\?v=\d+/g, '?v=')                              // 资源版本号：每次 publish 都变
    .replace(new RegExp(META_RE.source + '\\n?'), '');        // 自身盖章：整行删除，避免自指
}

/** 纯函数：给定 [{name, text}] 算短哈希。导出是为了让测试用内存数据直接断言 */
function hashEntries(entries) {
  const h = crypto.createHash('md5');
  entries.forEach(function (e) {
    const text = e.name === 'index.html' ? normalizeHtml(e.text) : e.text;
    // 文件名也进哈希：漏跑 / 顺序变化同样要反映出来
    h.update(e.name + '\u0000' + text + '\u0000', 'utf8');
  });
  return h.digest('hex').slice(0, 12);
}

/** 读盘版：给定 dashboard 目录，返回哈希（不写盘） */
function computeHash(dashDir) {
  const dir = dashDir || DASH;
  const entries = CODE_FILES.map(function (f) {
    return { name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') };
  });
  return hashEntries(entries);
}

/** 读 index.html 里现有的章（没盖章返回空串） */
function readStamp(dashDir) {
  const dir = dashDir || DASH;
  const p = path.join(dir, 'index.html');
  if (!fs.existsSync(p)) return '';
  const m = fs.readFileSync(p, 'utf8').match(META_RE);
  return m ? m[1] : '';
}

/**
 * 把哈希写进 index.html。返回 true = 真的改了文件，false = 已是最新（幂等）。
 * 锚点顺序：样式表 link 之后 → <head> 之后 → 报错（宁可显式失败，也别悄悄塞错位置）。
 */
function stamp(dashDir, hash) {
  const dir = dashDir || DASH;
  const p = path.join(dir, 'index.html');
  let html = fs.readFileSync(p, 'utf8');

  if (META_RE.test(html)) {
    const next = html.replace(META_RE, META_TAG(hash));
    if (next === html) return false;
    fs.writeFileSync(p, next, 'utf8');
    return true;
  }

  const anchors = [
    /(<link\s+rel="stylesheet"[^>]*>\n)/,
    /(<head[^>]*>\n?)/
  ];
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].test(html)) {
      fs.writeFileSync(p, html.replace(anchors[i], '$1' + META_TAG(hash) + '\n'), 'utf8');
      return true;
    }
  }
  throw new Error('index.html 里找不到可插入 cv meta 的锚点（样式表 link / <head>）');
}

function main() {
  const args = process.argv.slice(2);
  const check = args.indexOf('--check') >= 0;
  const printOnly = args.indexOf('--print') >= 0;

  const hash = computeHash();
  const cur = readStamp();

  if (printOnly) { console.log(cur || '(未盖章)'); return; }

  if (check) {
    console.log('计算哈希 : ' + hash);
    console.log('文件里章 : ' + (cur || '(未盖章)'));
    console.log(hash === cur ? '✓ 一致，无需盖章' : '✗ 不一致（需要盖章）');
    process.exit(hash === cur ? 0 : 1);
  }

  const changed = stamp(null, hash);
  console.log('代码版本 cv=' + hash + (changed ? '（已盖章到 index.html）' : '（未变，跳过写入）'));
}

if (require.main === module) main();

module.exports = { CODE_FILES, META_RE, META_TAG, normalizeHtml, hashEntries, computeHash, readStamp, stamp };
