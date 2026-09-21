#!/usr/bin/env node
'use strict';
/**
 * tools/job_evening.js —— 晚报生成（服务器版：纯脚本 + LLM API，不依赖桌面端 Agent）
 *
 * 流程：
 *   ① 交易日判断 → 非交易日退出
 *   ② 幂等守卫：当日已有 evening → 退出
 *   ③ 抓两个博主（fetch_tgb.js）：
 *        · 湖南人 444409 —— 正文**全是图片**（实测 6 张）
 *        · 行鱼复盘 563404 —— 正文同样以图片为主（实测 49 张）
 *   ④ 两个博主当天都没有帖子 → 记日志退出，**不写空 evening**
 *      （历史先例：2026-09-08 三源均未发文，系统正确地跳过了）
 *   ⑤ 长图切片（slice_image.py，Pillow）：实测有 530x6157 / 760x4135 的超长表格图，
 *      整张交给模型会被压缩到无法阅读 → 必须切片
 *   ⑥ 分批送视觉模型转录（imageReadUser），每批 4 张切片
 *   ⑦ 汇总转录文本 → LLM 生成 evening 结构
 *      ⚠️「板块热点」与「明日关注」条数必须完全一致，merge_report 会强制校验
 *   ⑧ merge_report（退出码 3 → 反馈重试一次）→ check_codes → publish
 *   ⑨ 追加 logs/<date>.md
 *
 * 用法：
 *   node tools/job_evening.js
 *   node tools/job_evening.js --date 2026-09-21
 *   node tools/job_evening.js --dry                  # 只抓取+读图，看转录结果，不写盘
 *   node tools/job_evening.js --no-publish
 *   node tools/job_evening.js --max-slices 24        # 限制送入模型的切片总数（控成本）
 *
 * 退出码：
 *   0 成功 / 非交易日 / 当日两源均无内容（正常跳过）
 *   1 参数或环境错误
 *   2 抓取失败
 *   3 LLM 连续两次产出不合法
 *   4 merge_report 内容校验失败
 *   5 安全阀中止
 *   6 发布失败
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'dashboard', 'data.js');
const LOG_DIR = path.join(ROOT, 'logs');

const llm = require('./lib/llm');
const P = require('./lib/prompts');
const ops = require('./lib/ops');
const gapCheck = require('./lib/gap_check');
const { loadDataStrict } = require('./lib/data_store');

/** 两个博主。blog id 见 automation 配置：湖南人 444409 / 行鱼复盘 563404。 */
const BLOGS = [
  { key: 'hnr', author: '湖南人', blog: '444409' },
  { key: 'xy', author: '行鱼复盘', blog: '563404' },
];

// 每批送入视觉模型的切片数。
// 实测（2026-09-21）：送 4 张 → 输出被截断、JSON 不闭合；降到 2 张**仍会截断**
// （长表格在转录到 1564 token 处断开，而 max_tokens 已设 8192，说明是模型侧的输出上限）。
// 故取 1 张/次。代价是调用次数 = 切片数（湖南人约 9 次、行鱼可达 60+ 次），
// 但这是无人值守任务，多花十几分钟远好过整份晚报失败。
const BATCH = 1;
const NET_HINTS = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|timeout|HTTP [45]\d\d/i;

/* ───────────────────────── 基础设施 ───────────────────────── */

function parseArgs(argv) {
  const out = { date: '', dry: false, force: false, publish: true, maxSlices: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i] || '';
    else if (a === '--dry') out.dry = true;
    else if (a === '--force') out.force = true;
    else if (a === '--no-publish') out.publish = false;
    else if (a === '--max-slices') out.maxSlices = parseInt(argv[++i], 10) || 0;
    else if (a === '--help' || a === '-h') {
      console.log('用法：node tools/job_evening.js [--date YYYY-MM-DD] [--dry] [--force] [--no-publish] [--max-slices N]');
      process.exit(0);
    } else throw new Error('未知参数：' + a);
  }
  return out;
}

function run(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return {
      code: (e.status == null ? 1 : e.status),
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: (e.stderr ? String(e.stderr) : '') + String(e.message || ''),
    };
  }
}

function loadHolidays() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'trade_holidays.json'), 'utf8')).years || {};
  } catch (e) {
    console.warn('⚠️ 读不到 config/trade_holidays.json → 退化为仅排除周末');
    return {};
  }
}

function appendLog(date, lines) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, date + '.md'), '\n' + lines.join('\n') + '\n');
  } catch (e) {
    console.warn('⚠️ 日志写入失败（不影响主流程）：' + e.message);
  }
}

function hasEvening(date) {
  const { data } = loadDataStrict(DATA);
  const rec = (data.reports || []).find(function (r) { return r && r.date === date; });
  return !!(rec && rec.evening);
}

/** 只保留 merge_report 需要的字段，避免模型多吐的键污染 data.js。 */
function shapeEvening(c, today, now, sources) {
  const picks = function (a) {
    return (Array.isArray(a) ? a : []).map(function (p) {
      p = p || {};
      return {
        name: String(p.name || '').trim(),
        code: String(p.code || '').trim(),
        role: String(p.role || '').trim(),
        status: String(p.status || '').trim(),
        reason: String(p.reason || '').trim(),
      };
    });
  };
  const m = c['大盘概况'] || {};
  return {
    date: today,
    at: now,
    evening: {
      sources: sources,
      generatedAt: now,
      '博主观点': (Array.isArray(c['博主观点']) ? c['博主观点'] : []).map(function (b) {
        b = b || {};
        return { author: String(b.author || '').trim(), view: String(b.view || '').trim() };
      }),
      '大盘概况': {
        summary: String(m.summary || '').trim(),
        metrics: (Array.isArray(m.metrics) ? m.metrics : []).map(function (x) {
          x = x || {};
          return { k: String(x.k || '').trim(), v: String(x.v || '').trim(), d: String(x.d || '').trim(), up: !!x.up };
        }),
      },
      '连板梯队': (Array.isArray(c['连板梯队']) ? c['连板梯队'] : []).map(String),
      '明日关注': (Array.isArray(c['明日关注']) ? c['明日关注'] : []).map(function (s) {
        s = s || {};
        return {
          sector: String(s.sector || '').trim(),
          stage: String(s.stage || '').trim(),
          why: String(s.why || '').trim(),
          chain: String(s.chain || '').trim(),
          picks: picks(s.picks),
        };
      }),
      '板块热点': (Array.isArray(c['板块热点']) ? c['板块热点'] : []).map(function (x) {
        x = x || {};
        return {
          name: String(x.name || '').trim(),
          strength: String(x.strength || '').trim(),
          stocks: String(x.stocks || '').trim(),
          catalyst: String(x.catalyst || '').trim(),
        };
      }),
    },
  };
}

/* ───────────────────────── 抓取 + 读图 ───────────────────────── */

/** 抓一个博主当日的帖子与图片。返回 {author, found, post, images:[file], log}。 */
function fetchBlog(b, date, imgDir) {
  const r = run('node', ['tools/fetch_tgb.js', '--blog', b.blog, '--date', date,
    '--json', '--images-dir', imgDir, '--quiet']);
  if (r.code === 3) return { author: b.author, found: false, images: [], log: r.stderr.trim() };
  if (r.code !== 0) {
    throw new Error('抓取 ' + b.author + ' 失败（退出码 ' + r.code + '）：' + r.stderr.trim().slice(0, 300));
  }
  let j;
  try { j = JSON.parse(r.stdout); }
  catch (e) { throw new Error(b.author + ' 返回的 JSON 无法解析：' + r.stdout.slice(0, 200)); }
  return {
    author: b.author, found: true, post: j.post,
    images: (j.images || []).map(function (x) { return x.file; }),
    failed: (j.failed || []).length, log: r.stderr.trim(),
  };
}

/** MSYS / Git-Bash 风格路径（/c/Users/…）→ Windows 风格（C:/Users/…）。
 *  Node 的 spawn 不认前者，会直接报 ENOENT；Linux 上原样返回。 */
function normalizeBin(p) {
  const m = String(p).match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? (m[1].toUpperCase() + ':/' + m[2]) : p;
}

/** 调 slice_image.py 把图片目录切成适合视觉模型的片段。返回切片路径数组（保序）。 */
function sliceImages(imgDir, sliceDir) {
  const py = normalizeBin(process.env.PYTHON_BIN || 'python3');
  const r = run(py, ['tools/slice_image.py', imgDir, sliceDir]);
  if (r.code !== 0) {
    throw new Error('切片失败（' + py + ' 退出码 ' + r.code + '）：' + (r.stderr || '').trim().slice(0, 400) +
      '\n  提示：ECS 上需先装 Pillow（python3 -m pip install Pillow），或用 PYTHON_BIN 指定解释器');
  }
  let j;
  try { j = JSON.parse(r.stdout); }
  catch (e) { throw new Error('切片脚本输出无法解析：' + r.stdout.slice(0, 200)); }
  const parts = [];
  (j.slices || []).forEach(function (s) { (s.parts || []).forEach(function (p) { parts.push(p); }); });
  return { parts: parts, failed: (j.failed || []).length };
}

/** 分批送入视觉模型转录，返回 { text, failures }。
 *  ⚠️ 单批失败**不终止整份任务**：跳过后继续，最后汇报失败数。
 *  （视觉模型偶发输出截断导致 JSON 不闭合；若直接抛错，整份晚报就没了 ——
 *   部分内容远好过零产出。） */
async function transcribe(date, author, parts) {
  if (!parts.length) return { text: '', failures: 0 };
  const batches = [];
  for (let i = 0; i < parts.length; i += BATCH) batches.push(parts.slice(i, i + BATCH));
  const chunks = [];
  let failures = 0;
  for (let i = 0; i < batches.length; i++) {
    const tag = '· 读图 ' + author + ' ' + (i + 1) + '/' + batches.length;
    try {
      const r = await llm.askJson({
        system: P.IMAGE_READ_SYSTEM,
        user: P.imageReadUser(date, author, i, batches.length, batches[i]),
        images: batches[i],
        maxTokens: 8192,
      });
      const txt = (Array.isArray(r.blocks) ? r.blocks : []).map(function (b) {
        return '【' + String(b.title || '未命名').trim() + '】\n' + String(b.content || '').trim();
      }).join('\n');
      if (txt.trim()) chunks.push(txt.trim());
    } catch (e) {
      failures++;
      console.warn(tag + ' 失败（跳过）：' + String(e.message).slice(0, 110));
    }
  }
  if (failures) {
    console.warn('⚠️ ' + author + '：' + failures + '/' + batches.length + ' 张转录失败，内容可能不完整');
  }
  return { text: chunks.join('\n\n'), failures: failures };
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = args.date || gapCheck.fmtDate(new Date());
  const t0 = Date.now();

  if (!llm.cfg().apiKey) {
    console.error('✗ 缺少 LLM_API_KEY。见 docs/上云部署方案.md 的环境变量清单。');
    return 1;
  }

  if (!gapCheck.isTradingDay(new Date(today + 'T00:00:00'), loadHolidays())) {
    console.log('· ' + today + ' 非交易日 → 跳过');
    return 0;
  }

  if (!args.force && hasEvening(today)) {
    console.log('· ' + today + ' 已存在晚报 → 跳过（需要重写请加 --force）');
    return 0;
  }

  const workDir = path.join(ROOT, 'tmp_evening_' + today);
  const imgRoot = path.join(workDir, 'img');
  const sliceRoot = path.join(workDir, 'slice');

  /* ③ 抓两个博主 */
  const fetched = [];
  for (const b of BLOGS) {
    const imgDir = path.join(imgRoot, b.key);
    console.log('· 抓取 ' + b.author + '（blog ' + b.blog + '）…');
    try {
      const r = fetchBlog(b, today, imgDir);
      fetched.push(r);
      console.log('  ' + (r.found
        ? '命中「' + (r.post ? r.post.title : '') + '」，图 ' + r.images.length + ' 张' +
          (r.failed ? '（失败 ' + r.failed + ' 张）' : '')
        : '当日无帖子'));
    } catch (e) {
      const detail = String(e.message || e);
      console.error('✗ ' + detail);
      if (NET_HINTS.test(detail)) {
        ops.appendAlert({
          stage: 'job_evening/抓取', result: 'OPEN', script: 'job_evening.js',
          detail: detail, fix: '检查服务器到 m.tgb.cn 的连通性；确认后重跑 node tools/job_evening.js',
          link: 'logs/' + today + '.md',
        });
        return 2;
      }
      fetched.push({ author: b.author, found: false, images: [], log: detail });
    }
  }

  const active = fetched.filter(function (x) { return x.found; });

  /* ④ 两源皆无 → 不写空 evening */
  if (!active.length) {
    console.log('· ' + today + ' 两个博主均无当日帖子 → 按规则跳过（不写空数据）');
    appendLog(today, ['## ' + today + ' 晚报 - 未产出（两源均无内容）',
      '- 湖南人 / 行鱼复盘 当日均无新帖，按规则不写空 evening']);
    return 0;
  }

  /* ⑤⑥ 切片 + 读图 */
  const materials = [];
  let totalSlices = 0;
  for (const f of active) {
    if (!f.images.length) {
      materials.push({ author: f.author, kind: '无图', text: '（该博主当日帖子没有可读图片）' });
      continue;
    }
    const sliceDir = path.join(sliceRoot, f.author);
    let parts;
    try {
      const s = sliceImages(path.dirname(f.images[0]), sliceDir);
      parts = s.parts;
    } catch (e) {
      console.error('✗ ' + String(e.message || e));
      appendLog(today, ['## ' + today + ' 晚报 - 切片失败', '- ' + String(e.message || e)]);
      ops.appendAlert({
        stage: 'job_evening/切片', result: 'OPEN', script: 'job_evening.js',
        detail: String(e.message || e).slice(0, 600),
        fix: 'ECS 上安装 Pillow：python3 -m pip install Pillow；或设 PYTHON_BIN 指向带 Pillow 的解释器',
        link: 'tools/slice_image.py',
      });
      return 2;
    }
    if (args.maxSlices > 0 && totalSlices + parts.length > args.maxSlices) {
      const keep = Math.max(0, args.maxSlices - totalSlices);
      console.warn('⚠️ 切片总数超限，' + f.author + ' 只读前 ' + keep + ' 张（--max-slices ' + args.maxSlices + '）');
      parts = parts.slice(0, keep);
    }
    totalSlices += parts.length;
    const tr = await transcribe(today, f.author, parts);
    materials.push({
      author: f.author,
      kind: '图片转录（' + parts.length + ' 张切片' + (tr.failures ? '，失败 ' + tr.failures : '') + '）',
      text: tr.text || '（转录为空）',
    });
  }

  if (args.dry) {
    console.log('\n===== 转录结果预览 =====');
    materials.forEach(function (m) {
      console.log('\n--- ' + m.author + ' [' + m.kind + '] ---');
      console.log(m.text.slice(0, 1500) + (m.text.length > 1500 ? '\n…（截断）' : ''));
    });
    console.log('\n===== 继续生成 evening 结构并走校验（--dry 不写盘）=====');
  }

  /* ⑦ 生成 evening JSON */
  const baseUser = P.eveningUser(today, materials);
  let payload = null, hint = '', lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = hint ? baseUser + '\n\n【上一次输出被校验拒绝，请针对性修正后重新输出完整 JSON】\n' + hint : baseUser;
    console.log('· LLM 生成晚报结构（第 ' + (attempt + 1) + ' 次）…');
    let content;
    try {
      content = await llm.askJson({ system: P.EVENING_SYSTEM, user: user, maxTokens: 8192 });
    } catch (e) {
      lastErr = 'LLM 调用或 JSON 解析失败：' + e.message;
      console.error('✗ ' + lastErr);
      if (attempt === 0) continue;
      break;
    }
    payload = shapeEvening(content, today, ops.stampMin(),
      active.map(function (x) { return x.author; }));

    const zw = payload.evening['明日关注'].length;
    const bk = payload.evening['板块热点'].length;
    console.log('· 明日关注 ' + zw + ' 个板块 / 板块热点 ' + bk + ' 个' +
      (zw === bk ? '' : '  ⚠️ 条数不一致（校验会拒绝）'));

    const jsonFile = path.join(ROOT, 'tmp_evening_' + today + '.json');
    fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2), 'utf8');

    // --dry：仍然走一遍 merge_report 的结构校验（它自带 --dry），只是不落盘。
    // 否则「产出能不能通过校验」这一环在 --dry 下永远是假验证。
    const mrArgs = ['tools/merge_report.js', '--kind', 'evening', '--in', jsonFile];
    if (args.dry) mrArgs.push('--dry');
    const mr = run('node', mrArgs);
    if (mr.code === 0) {
      lastErr = '';
      if (args.dry) {
        console.log('· 结构校验通过（--dry 未写盘）：明日关注 ' +
          payload.evening['明日关注'].length + ' 个 / 板块热点 ' +
          payload.evening['板块热点'].length + ' 个');
      }
      break;
    }

    lastErr = (mr.stderr || mr.stdout).trim();
    if (mr.code === 3 && attempt === 0) {
      hint = lastErr.slice(0, 2000);
      console.warn('⚠️ 内容校验未通过（退出码 3）→ 反馈给模型重试一次');
      continue;
    }
    if (mr.code === 2) {
      console.error('✗ 安全阀中止（data.js 疑似损坏或并发写冲突）→ 立即停止');
      appendLog(today, ['## ' + today + ' 晚报 - 安全阀中止', '- ' + lastErr]);
      ops.appendAlert({
        stage: 'job_evening/merge', result: 'ABORT', script: 'job_evening.js',
        detail: lastErr, fix: '人工确认 dashboard/data.js；确认无误后重跑',
        link: 'dashboard/data.js',
      });
      return 5;
    }
    console.error('✗ merge_report 失败（退出码 ' + mr.code + '）：' + lastErr);
    return 4;
  }

  if (!lastErr && args.dry) {
    console.log('\n===== evening JSON 预览（--dry 不写盘）=====');
    console.log(JSON.stringify(payload, null, 2).slice(0, 2500));
    return 0;
  }

  if (lastErr) {
    console.error('✗ 晚报生成失败：' + lastErr);
    appendLog(today, ['## ' + today + ' 晚报 - 未产出', '- ' + lastErr]);
    ops.appendAlert({
      stage: 'job_evening/校验', result: 'OPEN', script: 'job_evening.js',
      detail: lastErr.slice(0, 800), fix: '复查转录质量与 prompt；修正后重跑',
      link: 'logs/' + today + '.md',
    });
    return 3;
  }

  /* ⑧ 代码校验 + 发布 */
  run('node', ['tools/check_codes.js', '--fix', '--prune']);

  let pubInfo = '未发布（--no-publish）';
  if (args.publish) {
    const pu = run('bash', ['tools/publish.sh', '晚报 ' + today]);
    if (pu.code !== 0) {
      console.error('✗ 发布失败（退出码 ' + pu.code + '）');
      appendLog(today, ['## ' + today + ' 晚报 - 已写入但发布失败', '- ' + (pu.stderr || pu.stdout).slice(0, 800)]);
      ops.appendAlert({
        stage: 'job_evening/publish', result: 'OPEN', script: 'job_evening.js',
        detail: (pu.stderr || pu.stdout).slice(0, 800),
        fix: '数据已本地提交，重跑 node tools/gh_push_api.js 补推；不要重跑 publish.sh',
        link: 'tools/publish.sh',
      });
      return 6;
    }
    pubInfo = '已发布（' + (pu.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] + '）';
  }

  /* ⑨ 日志 + 清理 */
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  appendLog(today, [
    '## ' + today + ' 晚报 - ' + (args.publish ? '已发布' : '已写入（未发布）'),
    '- 模式：job_evening.js（服务器版，视觉=' + llm.cfg().visionModel + '）',
    '- 来源：' + active.map(function (x) { return x.author + '（' + x.images.length + ' 图）'; }).join(' / '),
    '- 切片送入模型：' + totalSlices + ' 张',
    '- 产出：博主观点 ' + payload.evening['博主观点'].length + ' 条 / 连板梯队 ' +
      payload.evening['连板梯队'].length + ' 段 / 明日关注 ' +
      payload.evening['明日关注'].length + ' 个板块（板块热点 ' +
      payload.evening['板块热点'].length + ' 个）',
    '- 发布：' + pubInfo,
    '- 耗时：' + secs + 's',
  ]);
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(path.join(ROOT, 'tmp_evening_' + today + '.json')); } catch (e) { /* 忽略 */ }

  console.log('✔ 晚报完成：' + today + '（' + secs + 's，' + pubInfo + '）');
  return 0;
}

// ⚠️ 不要用 process.exit()：会立即终止、不等 stdout flush，
// Windows + undici 下实测触发 libuv 断言崩溃（退出码 3221226505）。改用 exitCode。
main().then(function (rc) { process.exitCode = rc; })
  .catch(function (e) {
    console.error('✗ 未捕获异常：' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  });
