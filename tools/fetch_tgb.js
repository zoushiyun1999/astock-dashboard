#!/usr/bin/env node
'use strict';
/**
 * tools/fetch_tgb.js —— 淘股吧（m.tgb.cn）取数器（零依赖，只用 Node 内置模块）
 *
 * 用途：为「晚报」提供两个博主的当日内容。
 *
 * ⚠️ 实测结论（2026-09-21，与旧文档不符之处以实测为准）：
 *   ① **两个博主的正文都是图片，页面里没有正文文字。**
 *      旧 automation prompt 称「正文文字在 div#gtgioMsg 的 subject 属性里，约 4000 字符」——
 *      **那是评论**（gtgioMsg* 是评论区，用户名是其他网友）。主帖的 subject 只有标题。
 *      实测：湖南人当日帖 6 张正文图、行鱼 49 张；页面里除了站内提示语没有正文文字。
 *      → 因此晚报**必须走多模态读图**，不存在「纯文字抓取」的捷径。
 *   ② 博客列表的日期是完整格式 `2026-09-21 17:04`，位于 <span class="content_time …">，
 *      紧跟其后的是 <a class="contentTitle" href="/a/<id>">标题</a>。
 *   ③ **列表实测为降序（新的在前）**，与旧文档「正序」的说法相反 →
 *      本脚本解析出时间后**自己排序**，不依赖页面顺序（页面改版也不会影响结果）。
 *   ④ 正文图标签形如：
 *        <img data-type='contentImage'
 *             onclick='loadImg(this,"…/xxx.png_max.png")'
 *             src="https://www.tgb.cn/placeHolder.png"
 *             data-original="…/xxx.png_760w.png">
 *      · `src` 恒为占位符，**不可用**；可用的是 `loadImg` 的原图与 `data-original` 的缩略图。
 *   ⑤ 🔴 `_max.png` 在 CDN 上**可能不存在**（返回 OSS 的 NoSuchKey XML，401 字节）→
 *      必须回退到 `_760w.png`。地址后缀是 `.png` 但**实际内容可能是 JPEG**（魔数 ff d8 ff e0），
 *      所以校验一律按**魔数**，不按扩展名。
 *
 * 用法：
 *   node tools/fetch_tgb.js --blog 444409 --list [--n 10]
 *   node tools/fetch_tgb.js --blog 444409 --date 2026-09-21 --json --images-dir D:/tmp/hnr
 *   node tools/fetch_tgb.js --blog 444409 --date 2026-09-21 --images-dir D:/tmp/hnr --quiet
 *
 * 输出：--json 时，stdout 只有一段 JSON（进度信息一律走 stderr），便于调用方解析。
 *
 * 退出码：0 成功；1 用法/网络/解析失败；3 目标日期该博主无帖子（**正常情况**，调用方据此跳过）。
 */

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://m.tgb.cn';
const CONCURRENCY = 4;          // 下载并发：太高会触发 WAF
const LIST_RE = /<span class="content_time[^"]*"><span>(\d{4}-\d{2}-\d{2} \d{2}:\d{2})<\/span>[^<]*<\/span>[\s\S]{0,240}?<a class="contentTitle" href="(\/a\/[A-Za-z0-9]+)">([\s\S]*?)<\/a>/g;

function parseArgs(argv) {
  const out = { blog: '', list: false, date: '', json: false, imagesDir: '', quiet: false, n: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--blog') out.blog = argv[++i] || '';
    else if (a === '--list') out.list = true;
    else if (a === '--date') out.date = argv[++i] || '';
    else if (a === '--json') out.json = true;
    else if (a === '--images-dir') out.imagesDir = argv[++i] || '';
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--n') out.n = parseInt(argv[++i], 10) || 10;
    else if (a === '--help' || a === '-h') {
      console.log('用法：node tools/fetch_tgb.js --blog <id> [--list | --date YYYY-MM-DD [--json] [--images-dir DIR]]');
      process.exit(0);
    } else throw new Error('未知参数：' + a);
  }
  if (!out.blog) throw new Error('缺少 --blog（湖南人 444409 / 行鱼复盘 563404）');
  if (!out.list && !out.date) throw new Error('需要 --list 或 --date');
  return out;
}

/** 进度信息一律走 stderr —— --json 模式下 stdout 必须保持纯净。 */
function log(s) { process.stderr.write(s + '\n'); }

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': BASE + '/' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ← ' + url);
  return await res.text();
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 解析博客列表 → [{at, id, url, title}]，按时间**降序**（最新在前）。 */
function parseList(html) {
  const rows = [];
  LIST_RE.lastIndex = 0;
  let m;
  while ((m = LIST_RE.exec(html))) {
    rows.push({ at: m[1], id: m[2].replace('/a/', ''), url: BASE + m[2], title: stripTags(m[3]) });
  }
  const seen = new Set();
  const uniq = [];
  rows.forEach(function (r) {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    uniq.push(r);
  });
  // 不依赖页面顺序：自己按时间降序排（oldest→newest 的比较，降序取最新）
  uniq.sort(function (a, b) { return a.at < b.at ? 1 : (a.at > b.at ? -1 : 0); });
  return uniq;
}

/** 按 HTML 出现顺序提取**主帖正文**的图片（去重），保留 `_max` 原图与 `_760w` 回退两个地址。
 *
 *  🔴 为什么必须先切出正文段：同一日期目录下混有**评论者的配图**。
 *     实测 2026-09-21：湖南人全页 6 张里 1 张属评论、行鱼 49 张里 3 张属评论。
 *     依据 DETAILS.md §9.2「同日期图片 ≠ 正文图片」——
 *     按 `YYYY/MM/DD/` 前缀全抓、或直接全页抓，都会把评论配图当正文图。
 *     切法：主帖标识 `span#ztgioMsg` → 第一个评论容器 `gtgioMsg` 之间。
 *  找不到主帖标识时（页面改版）回退全文并置 scoped=false，
 *  由调用方打印告警 —— 宁可多抓几张，也不要静默漏掉正文。 */
function parseImages(html) {
  let scope = html, scoped = false;
  const a = html.indexOf('ztgioMsg');
  if (a >= 0) {
    const b = html.indexOf('gtgioMsg', a);
    scope = (b < 0) ? html.slice(a) : html.slice(a, b);
    scoped = true;
  }
  const out = [];
  const seen = new Set();
  const tagRe = /<img[^>]*contentImage[^>]*>/g;
  let m;
  while ((m = tagRe.exec(scope))) {
    const tag = m[0];
    const maxM = tag.match(/loadImg\(this,\s*["']([^"']+)["']\)/);
    const origM = tag.match(/data-original=["']([^"']+)["']/);
    const primary = maxM ? maxM[1] : '';
    const fallback = origM ? origM[1] : '';
    const key = primary || fallback;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ primary: primary, fallback: fallback });
  }
  return { images: out, scoped: scoped };
}

/** 图片魔数判断（不信扩展名 —— 淘股吧的 `.png` 实际常是 JPEG）。 */
function isImageBuf(buf) {
  if (buf.length < 12) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;                       // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;     // PNG
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP') return true;                               // WebP
  if (/^GIF8[79]a$/.test(buf.slice(0, 6).toString('ascii'))) return true;                       // GIF
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true;                                          // BMP
  return false;
}

/** 下载一张图：优先原图，失败回退缩略图。返回 {ok, file, bytes, url} 或 {ok:false, error}。 */
async function downloadImage(item, dest, referer) {
  const tries = [item.primary, item.fallback].filter(Boolean);
  let lastErr = '无可下载地址';
  for (let i = 0; i < tries.length; i++) {
    const u = tries[i];
    try {
      const res = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': referer } });
      if (!res.ok) { lastErr = 'HTTP ' + res.status; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const head = buf.slice(0, 24).toString('ascii');
      if (head.indexOf('<?xml') === 0 || head.indexOf('<Error') === 0) {
        lastErr = 'CDN 返回错误页（NoSuchKey）'; continue;
      }
      if (!isImageBuf(buf)) {
        lastErr = '非图片内容（魔数 ' + buf.slice(0, 4).toString('hex') + '）'; continue;
      }
      fs.writeFileSync(dest, buf);
      return { ok: true, file: dest, bytes: buf.length, url: u };
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  return { ok: false, error: lastErr };
}

/** 受限并发映射。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async function () {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ⚠️ 不能带尾部斜杠：`/blog/444409/` 返回 404，`/blog/444409` 才是 200（2026-09-21 实测）
  const html = await get(BASE + '/blog/' + args.blog);
  const list = parseList(html);
  if (!list.length) throw new Error('未能从博客页解析出任何文章（' + args.blog + '）→ 页面结构可能已改版');

  if (args.list) {
    if (!args.quiet) log('博客 ' + args.blog + ' 共 ' + list.length + ' 篇（按时间降序）');
    list.slice(0, args.n).forEach(function (x) {
      process.stdout.write('  ' + x.at + '  ' + x.id + '  ' + x.title + '\n');
    });
    return 0;
  }

  const target = list.find(function (x) { return x.at.slice(0, 10) === args.date; });
  if (!target) {
    log('· ' + args.date + ' 博客 ' + args.blog + ' 无帖子；最近一篇：' +
      (list[0] ? list[0].at + ' ' + list[0].title : '无'));
    if (args.json) {
      process.stdout.write(JSON.stringify({
        blog: args.blog, date: args.date, found: false,
        latest: list[0] || null,
      }, null, 2) + '\n');
    }
    return 3;
  }

  log('· 命中：' + target.at + ' ' + target.title + ' → ' + target.url);
  const artHtml = await get(target.url);
  const parsed = parseImages(artHtml);
  if (!parsed.scoped) log('⚠️ 未找到主帖标识 ztgioMsg → 回退全文抓图，可能混入评论配图');
  const imgs = parsed.images;
  log('· 正文图 ' + imgs.length + ' 张' + (parsed.scoped ? '（已排除评论区配图）' : ''));

  const result = {
    blog: args.blog, date: args.date, found: true,
    post: { id: target.id, url: target.url, title: target.title, at: target.at },
    images: [], failed: [],
  };

  if (args.imagesDir && imgs.length) {
    fs.mkdirSync(args.imagesDir, { recursive: true });
    const results = await mapLimit(imgs, CONCURRENCY, async function (item, idx) {
      const base = path.basename((item.primary || item.fallback).split('?')[0]).replace(/\.png_(max|760w)\.png$/, '');
      const ext = '.jpg';   // 淘股吧实际多为 JPEG；读取方按魔数判断，后缀仅供人看
      const dest = path.join(args.imagesDir, String(idx + 1).padStart(3, '0') + '_' + base + ext);
      return await downloadImage(item, dest, target.url);
    });
    results.forEach(function (r, i) {
      if (r && r.ok) result.images.push({ seq: i + 1, file: r.file, bytes: r.bytes, url: r.url });
      else result.failed.push({ seq: i + 1, error: (r && r.error) || '未知', url: imgs[i].primary });
    });
    log('· 下载成功 ' + result.images.length + ' 张，失败 ' + result.failed.length + ' 张');
    if (result.failed.length) {
      result.failed.slice(0, 5).forEach(function (f) {
        log('    ✗ #' + f.seq + ' ' + f.error);
      });
    }
  }

  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else log('完成：' + target.title);
  return 0;
}

// ⚠️ 不要用 process.exit()：它立即终止进程、不等 stdout flush，
// 在 Windows + undici 组合下实测会触发 libuv 断言崩溃
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)，退出码 3221226505）。
// 改为设置 exitCode 让 Node 自行退出（keep-alive 连接约 4s 后回收）。
main().then(function (rc) { process.exitCode = rc; })
  .catch(function (e) {
    console.error('✗ ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
