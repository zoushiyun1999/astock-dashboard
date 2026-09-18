#!/usr/bin/env node
'use strict';
/**
 * fetch_jy_article.js —— 韭研公社「开盘必读资讯」取数器（零依赖，仅 Node 内置模块）
 *
 * 背景（2026-09-18 踩坑）：
 *   ① 以前靠首页 `__NUXT__` 里的「最新热度」列表拿当日帖的 article_id。
 *      该列表**按热度排序**，2026-09-18 实测当天根本没有收录「9月18日开盘必读资讯」
 *      （整页 grep「必读」＝0 次）→ 会误判成「数据源今天没发」。
 *   ② 正解是走**作者页**：账号昵称就叫「开盘必读」，user_id = df07647c21594f8c9c382304128c08f3，
 *      `/u/<user_id>` 返回 SSR 页，列出全部历史文章（标题 + article_id + create_time）。
 *   ③ 文章正文在 `content:"…"` 里，是 **JS 字符串字面量**，HTML 被整段转义成 `\u003C` 形式。
 *      必须「保留反斜杠原文 → JSON.parse → 剥 HTML 标签」。若手工扫转义时把 `\` 吞掉，
 *      `\uXXXX` 与 `\n` 会残留成字面文本，整篇塌成一行、长度虚高约 10 倍。
 *
 * 用法：
 *   # 列出作者最近文章（默认最近 10 篇）
 *   node tools/fetch_jy_article.js --list [--n 15]
 *
 *   # 抓当日（或指定日期）《N月N日开盘必读资讯》正文 -> 纯文本
 *   node tools/fetch_jy_article.js --date 2026-09-18 [--out D:/tmp/morning.txt]
 *
 *   # 只解析已落盘的 HTML（离线复用，不再发请求）
 *   node tools/fetch_jy_article.js --html D:/tmp/a.html --from-html --date 2026-09-18
 *
 * 退出码：0 成功；1 用法/网络/解析失败（找不到当日帖时明确报错，不静默产出空文件）。
 */

const fs = require('fs');
const path = require('path');

// 腾讯/公社域名在本机需优先 IPv4，否则偶发连接被重置
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) { /* 旧版 Node 忽略 */ }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';
const AUTHOR_ID = 'df07647c21594f8c9c382304128c08f3';   // 账号昵称「开盘必读」
const AUTHOR_URL = 'https://www.jiuyangongshe.com/u/' + AUTHOR_ID;
const ARTICLE_URL = 'https://www.jiuyangongshe.com/a/';

/* ───────────────────────── 参数解析 ───────────────────────── */

function parseArgs(argv) {
  const out = { mode: '', date: '', out: '', html: '', n: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.mode = 'list';
    else if (a === '--from-html') out.mode = 'from-html';
    else if (a === '--date') out.date = argv[++i] || '';
    else if (a === '--out') out.out = argv[++i] || '';
    else if (a === '--html') out.html = argv[++i] || '';
    else if (a === '--n') out.n = parseInt(argv[++i], 10) || 10;
    else if (a === '--help' || a === '-h') out.mode = 'help';
    else throw new Error('未知参数：' + a);
  }
  if (!out.mode) out.mode = out.html ? 'from-html' : (out.date ? 'article' : 'list');
  return out;
}

const USAGE = [
  '用法：',
  '  node tools/fetch_jy_article.js --list [--n 15]',
  '  node tools/fetch_jy_article.js --date 2026-09-18 [--out D:/tmp/morning.txt]',
  '  node tools/fetch_jy_article.js --html D:/tmp/a.html --from-html --date 2026-09-18',
  '',
  '不带 --list / --date / --html 时默认按 --list 处理。',
].join('\n');

/* ───────────────────────── 网络 ───────────────────────── */

async function get(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' @ ' + url);
  return r.text();
}

/* ───────────────────────── 解析 ───────────────────────── */

/** 从作者页 HTML 里抽出文章列表（按时间降序）。
 *
 * ⚠️ 不要依赖 `__NUXT__` 里的字段顺序：作者页的对象是
 *    `title → content → article_id → … → create_time`
 *    而首页是 `article_id → … → title → … → create_time`。写死顺序的单个正则必然一边失效
 *    （2026-09-18 踩过：作者页的正则恒返回 0 条，被误读成「页面结构变了」）。
 *    这里改为解析**渲染层**：`<span>标题</span>` + 其后的 `href="/a/<id>"`，与字段顺序无关。
 */
function parseArticleList(html) {
  const out = [];
  const seen = new Set();
  // 渲染层：标题在 `class="book-title…"><span>标题</span>`，正文里第一个 `href="/a/<id>"`
  const re = /class="book-title[^"]*"[^>]*>\s*<span>([^<]{2,90})<\/span>[\s\S]{0,600}?href="\/a\/([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const title = m[1], id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    // 发布时间在标题块**之前**的 fs13-ash div；取其前面最后一个完整时间戳
    const head = html.slice(Math.max(0, m.index - 500), m.index);
    const ts = head.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g);
    out.push({ id, title, at: ts ? ts[ts.length - 1] : '' });
  }
  // 站点本身按时间降序输出，**保持文档顺序**（不要再 sort：缺 at 时排序会反过来）
  if (out.length) return out;

  // 兜底：纯 NUXT 列表（对象窗口取 ±，覆盖两种字段顺序）
  const re2 = /article_id:"([^"]+)"[\s\S]{0,2000}?title:"([^"]{2,90})"[\s\S]{0,2000}?create_time:"([^"]+)"/g;
  while ((m = re2.exec(html))) out.push({ id: m[1], title: m[2], at: m[3] });
  if (out.length) return out;

  const re3 = /title:"([^"]{2,90})"[\s\S]{0,1200}?article_id:"([^"]+)"[\s\S]{0,1200}?create_time:"([^"]+)"/g;
  while ((m = re3.exec(html))) out.push({ id: m[2], title: m[1], at: m[3] });
  return out;
}

/** 从文章页 HTML 里按标题锚点取出正文，还原成纯文本。 */
function extractBody(html, title) {
  const anchor = 'title:"' + title + '"';
  let i = html.indexOf(anchor);
  if (i < 0) {
    // 兜底：标题可能被 HTML 转义或位于渲染层
    const j = html.indexOf(title);
    if (j < 0) throw new Error('标题锚点未命中：' + title);
    i = j;
  }
  const c = html.indexOf('content:"', i);
  if (c < 0) throw new Error('未找到 content 字段（标题锚点之后）');

  // 扫描 JS 字符串字面量：**保留转义原文**，交给 JSON.parse 还原
  let p = c + 9, raw = '"';
  while (p < html.length) {
    const ch = html[p];
    if (ch === '\\') { raw += html[p] + html[p + 1]; p += 2; continue; }
    if (ch === '"') break;
    raw += ch; p++;
  }
  raw += '"';

  let out;
  try { out = JSON.parse(raw); }
  catch (e) { throw new Error('content 字面量 JSON.parse 失败：' + e.message); }

  return stripHtml(out);
}

function stripHtml(s) {
  return String(s)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr|section)>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 2026-09-18 -> 9月18日（去前导零，与公社标题口径一致）。 */
function toCnDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return m + '月' + d + '日';
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') { console.log(USAGE); return; }

  if (args.mode === 'list') {
    const html = await get(AUTHOR_URL);
    const list = parseArticleList(html).slice(0, args.n);
    if (!list.length) throw new Error('作者页未解析出任何文章（页面结构可能又变了）');
    console.log('作者：开盘必读  ' + AUTHOR_URL);
    list.forEach(x => console.log('  ' + (x.at || '?') + '  ' + x.id + '  ' + x.title));
    return;
  }

  if (!args.date) throw new Error('--date 必填（YYYY-MM-DD）\n\n' + USAGE);
  const title = toCnDate(args.date) + '开盘必读资讯';

  let html;
  if (args.mode === 'from-html') {
    if (!args.html) throw new Error('--html 必填（配合 --from-html）');
    html = fs.readFileSync(args.html, 'utf8');
  } else {
    // 先确认当日帖已发布（作者页），再抓文章页
    const list = parseArticleList(await get(AUTHOR_URL));
    const hit = list.find(x => x.title === title);
    if (!hit) {
      const near = list.slice(0, 5).map(x => x.at + ' ' + x.title).join('\n  ');
      throw new Error('作者页未找到《' + title + '》——可能当日未发布（当前最近 5 篇）：\n  ' + near);
    }
    console.log('# 命中 ' + hit.at + '  ' + ARTICLE_URL + hit.id);
    html = await get(ARTICLE_URL + hit.id);
  }

  const text = extractBody(html, title);
  if (!text) throw new Error('正文为空');

  const dest = args.out || path.join(process.cwd(), 'tmp_jy_' + args.date + '.txt');
  fs.writeFileSync(dest, text, 'utf8');
  const lines = text.split('\n').filter(x => x.trim()).length;
  console.log('✔ ' + title + '  ->  ' + dest);
  console.log('  ' + text.length + ' 字符 / ' + lines + ' 非空行');
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
