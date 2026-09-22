#!/usr/bin/env node
'use strict';
/**
 * fetch_jy_calendar.js —— 韭研公社「A股投资日历」专版取数器（零依赖，仅 Node 内置模块）
 *
 * 背景（2026-09-22 上云迁移）：
 *   投资日历是独立数据源，与早报「开盘必读」(df07647c)、晚报「湖南人/行鱼」(淘股吧) 都不同。
 *   历史本地流程把日历抓取揉进晚报任务；服务器版 job_evening.js 在迁移时把第三源整段删了，
 *   导致日历停更（data.js 里最新一篇停在 2026-09-20）。本脚本把日历抓取抽成独立工具，
 *   供 job_evening.js 调用，也可单独跑。
 *
 *   韭研公社一律走 Node fetch + 桌面 UA（与 fetch_jy_article.js 同一 proven 路径），
 *   **不要用 WebFetch**（15 分钟缓存会误判「最新帖还是昨天的」）。
 *
 * 输出契约（写入 --out-json）：
 *   { "date": "<today>", "at": "<stamp>", "calendar": [ {id,title,author,publishedAt,url,images[],events:[]} ] }
 *   · images 为相对站点根的路径数组："calendar/<id>_img<n>.<ext>"（与 data.js 现有口径一致）
 *   · events 暂留空数组 —— 前端 renderCalendar 对 events 是可选（缺则事件列表空白，不崩），
 *     主展示是 images 长图。后续若要用 LLM/视觉从长图提炼结构化事件，再加。
 *
 * 幂等：作者页最新一篇的 id 若已在 data.js.calendar 中 → 视为已收录，跳过下载与产出（除非 --force）。
 *
 * 用法：
 *   node tools/fetch_jy_calendar.js --list [--n 10]          # 列出作者最近文章（含是否已收录）
 *   node tools/fetch_jy_calendar.js --check                  # 仅判断最新一篇是否已收录
 *   node tools/fetch_jy_calendar.js --fetch [--out-json tmp_calendar.json]
 *                                     [--images-dir dashboard/calendar] [--force] [--dry] [--merge]
 *
 * 退出码：0 成功/已是最新/正常跳过；1 用法或网络或解析失败；2 无新日历（供调用方区分）
 */

const fs = require('fs');
const path = require('path');

try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) { /* 旧版 Node 忽略 */ }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';
// 韭研公社账号昵称「A股投资日历」（绝不追高的老韭菜）。与早报「开盘必读」(df07647c) 是不同账号。
const AUTHOR_ID = '648089de4f1649de9e18b8285faca8b8';
const AUTHOR_URL = 'https://www.jiuyangongshe.com/u/' + AUTHOR_ID;
const ARTICLE_URL = 'https://www.jiuyangongshe.com/a/';
const SITE = 'https://www.jiuyangongshe.com';

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');

/* ───────────────────────── 参数解析 ───────────────────────── */

function parseArgs(argv) {
  const out = { mode: '', n: 10, outJson: '', imagesDir: '', force: false, dry: false, merge: false, date: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.mode = 'list';
    else if (a === '--check') out.mode = 'check';
    else if (a === '--fetch') out.mode = 'fetch';
    else if (a === '--n') out.n = parseInt(argv[++i], 10) || 10;
    else if (a === '--out-json') out.outJson = argv[++i] || '';
    else if (a === '--images-dir') out.imagesDir = argv[++i] || '';
    else if (a === '--date') out.date = argv[++i] || '';
    else if (a === '--force') out.force = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--merge') out.merge = true;
    else if (a === '--help' || a === '-h') out.mode = 'help';
    else throw new Error('未知参数：' + a);
  }
  if (!out.mode) out.mode = 'fetch';
  return out;
}

const USAGE = [
  '用法：',
  '  node tools/fetch_jy_calendar.js --list [--n 10]',
  '  node tools/fetch_jy_calendar.js --check',
  '  node tools/fetch_jy_calendar.js --fetch [--out-json tmp_calendar.json] [--images-dir dashboard/calendar] [--force] [--dry] [--merge]',
].join('\n');

/* ───────────────────────── 网络 ───────────────────────── */

async function get(url, referer) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (referer) headers['Referer'] = referer;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' @ ' + url);
  return r;
}

async function getText(url) { return (await get(url)).text(); }
async function getBuffer(url, referer) {
  const r = await get(url, referer);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
}

/* ───────────────────────── 解析（复用 fetch_jy_article 思路）───────────────────────── */

/** 作者页文章列表（按时间降序，保持文档顺序）。同时带「发布时间」用于 publishedAt。 */
function parseArticleList(html) {
  const out = [];
  const seen = new Set();
  const re = /class="book-title[^"]*"[^>]*>\s*<span>([^<]{2,90})<\/span>[\s\S]{0,600}?href="\/a\/([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const title = m[1], id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const head = html.slice(Math.max(0, m.index - 500), m.index);
    const ts = head.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g);
    out.push({ id, title, at: ts ? ts[ts.length - 1] : '' });
  }
  if (out.length) return out;
  // 兜底：纯 NUXT 列表
  const re2 = /article_id:"([^"]+)"[\s\S]{0,2000}?title:"([^"]{2,90})"[\s\S]{0,2000}?create_time:"([^"]+)"/g;
  while ((m = re2.exec(html))) out.push({ id: m[1], title: m[2], at: m[3] });
  return out;
}

/** 从文章页取出 `content` 字段的**原始 HTML 字符串**（保留转义、不剥标签）。
 *  与 fetch_jy_article.extractBody 同源：扫描 JS 字符串字面量、保留反斜杠、JSON.parse 还原。 */
function extractContentRaw(html, title) {
  const anchor = 'title:"' + title + '"';
  let i = html.indexOf(anchor);
  if (i < 0) {
    const j = html.indexOf(title);
    if (j < 0) throw new Error('标题锚点未命中：' + title);
    i = j;
  }
  const c = html.indexOf('content:"', i);
  if (c < 0) throw new Error('未找到 content 字段（标题锚点之后）');
  let p = c + 9, raw = '"';
  while (p < html.length) {
    const ch = html[p];
    if (ch === '\\') { raw += html[p] + html[p + 1]; p += 2; continue; }
    if (ch === '"') break;
    raw += ch; p++;
  }
  raw += '"';
  return JSON.parse(raw);   // 还原成含真实 < > 的 HTML 字符串
}

/** 从正文 HTML 抽取图片 URL（src 与 data-src 都取，去重；跳过 data: 与明显装饰）。 */
function extractImages(html) {
  const urls = [];
  const seen = new Set();
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const pick = function (attr) {
      const r = new RegExp(attr + '\\s*=\\s*["\']([^"\']+)["\']', 'i');
      const mm = tag.match(r);
      return mm ? mm[1].trim() : '';
    };
    const src = pick('data-src') || pick('src');   // 优先 data-src（懒加载真实地址）
    if (!src || /^data:/i.test(src)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    urls.push(src);
  }
  return urls;
}

function absUrl(u) {
  if (/^\/\//.test(u)) return 'https:' + u;
  if (/^\//.test(u)) return SITE + u;
  return u;
}

function extFrom(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  const m = (url || '').split('?')[0].match(/\.(png|jpg|jpeg|webp|gif|bmp)(?:$|[#?])/i);
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}

/* ───────────────────────── 轻量图片尺寸嗅探（用于过滤装饰小图）───────────────────────── */

function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {            // PNG
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0x47 && buf[1] === 0x49) {            // GIF
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xFF && buf[1] === 0xD8) {            // JPEG：扫 SOF0/SOF2
      let p = 2;
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xFF) { p++; continue; }
        const marker = buf[p + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
        }
        const len = buf.readUInt16BE(p + 2);
        p += 2 + len;
      }
    }
  } catch (e) { /* 嗅探失败不阻塞，交由尺寸阈值兜底 */ }
  return null;
}

const MIN_BYTES = 15 * 1024;   // 小于 15KB 视为装饰/头像/emoji
const MIN_SIDE = 250;          // 长边小于 250px 视为装饰

/* ───────────────────────── 读 data.js 已收录日历（幂等）───────────────────────── */

function loadExistingIds() {
  if (!fs.existsSync(DATA)) return new Set();
  const src = fs.readFileSync(DATA, 'utf8');
  try {
    const data = new Function('window', src + '\nreturn window.REPORTS;')({});
    return new Set(((data && data.calendar) || []).map(function (c) { return c && c.id; }).filter(Boolean));
  } catch (e) { return new Set(); }
}

/* ───────────────────────── 主流程 ───────────────────────── */

function stampMin(d) {
  d = d || new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') { console.log(USAGE); return; }

  const list = parseArticleList(await getText(AUTHOR_URL)).slice(0, args.n);
  if (!list.length) throw new Error('作者页未解析出任何文章（页面结构可能又变了）');

  if (args.mode === 'list') {
    const existing = loadExistingIds();
    console.log('作者：A股投资日历  ' + AUTHOR_URL);
    list.forEach(function (x) {
      console.log('  ' + (x.at || '?') + '  ' + x.id + '  ' + x.title +
        (existing.has(x.id) ? '  [已收录]' : ''));
    });
    return;
  }

  const latest = list[0];
  const existing = loadExistingIds();
  if (existing.has(latest.id) && !args.force) {
    console.log('· 最新一篇 ' + latest.id + '《' + latest.title + '》已收录 → 跳过（如需重抓用 --force）');
    if (args.mode === 'check') process.exitCode = 0;
    return;   // 幂等：无新日历
  }

  if (args.mode === 'check') {
    console.log('· 有新日历：' + latest.id + '《' + latest.title + '》@ ' + (latest.at || '?'));
    process.exitCode = 0;
    return;
  }

  // ── fetch 模式 ──
  console.log('# 命中最新 ' + (latest.at || '?') + '  ' + ARTICLE_URL + latest.id);
  const html = await getText(ARTICLE_URL + latest.id);
  const contentHtml = extractContentRaw(html, latest.title);
  let imgUrls = extractImages(contentHtml);
  console.log('· 正文中找到 ' + imgUrls.length + ' 张图片 URL');

  const imagesDir = path.resolve(args.imagesDir || path.join(ROOT, 'dashboard', 'calendar'));
  const saved = [];
  if (!args.dry) {
    fs.mkdirSync(imagesDir, { recursive: true });
    let n = 0;
    for (const u of imgUrls) {
      const abs = absUrl(u);
      n++;
      const fname = latest.id + '_img' + n;
      try {
        const { buf, type } = await getBuffer(abs, ARTICLE_URL + latest.id);
        // 过滤装饰小图：尺寸或长边不达标则跳过
        if (buf.length < MIN_BYTES) { console.log('  ✗ 跳过 ' + fname + '（' + (buf.length / 1024).toFixed(0) + 'KB 过小，疑似装饰图）'); continue; }
        const sz = imageSize(buf);
        if (sz && Math.max(sz.w, sz.h) < MIN_SIDE) { console.log('  ✗ 跳过 ' + fname + '（' + sz.w + 'x' + sz.h + ' 过小）'); continue; }
        const fpath = path.join(imagesDir, fname + extFrom(abs, type));
        fs.writeFileSync(fpath, buf);
        saved.push('calendar/' + path.basename(fpath));
        console.log('  ✔ ' + path.basename(fpath) + '  ' + (buf.length / 1024).toFixed(0) + 'KB' +
          (sz ? '  ' + sz.w + 'x' + sz.h : ''));
      } catch (e) {
        console.warn('  ✗ 下载失败 ' + fname + '：' + e.message);
      }
    }
  } else {
    // dry：仅预览，不下载
    saved.push.apply(saved, imgUrls.map(function (u, i) { return 'calendar/' + latest.id + '_img' + (i + 1) + extFrom(u, ''); }));
  }

  if (!saved.length) {
    console.warn('⚠️ 没有可用图片（全部被过滤或下载失败）→ 不产出空日历条目');
    process.exitCode = 2;
    return;
  }

  const entry = {
    id: latest.id,
    title: latest.title,
    author: 'A股投资日历',
    publishedAt: latest.at || stampMin(),
    url: ARTICLE_URL + latest.id,
    images: saved,
    events: [],
  };
  const payload = { date: args.date || stampMin().slice(0, 10), at: stampMin(), calendar: [entry] };

  const outPath = args.outJson || path.join(ROOT, 'tmp_calendar_' + latest.id + '.json');
  if (!args.dry) {
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log('✔ 已写出日历条目 JSON → ' + outPath);
  } else {
    console.log('（dry-run，未写盘）\n' + JSON.stringify(payload, null, 2));
  }

  if (args.merge && !args.dry) {
    const { execFileSync } = require('child_process');
    const r = execFileSync('node', ['tools/merge_report.js', '--kind', 'calendar', '--in', outPath], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(r);
  }
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('✗ ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

// 导出纯函数供单测（不影响 CLI 入口）
module.exports = { parseArticleList, extractContentRaw, extractImages, imageSize, absUrl, extFrom, AUTHOR_ID };
