#!/usr/bin/env node
'use strict';
/**
 * tools/job_morning.js —— 早报生成（服务器版：纯脚本 + LLM API，不依赖桌面端 Agent）
 *
 * 与旧模式的差别：原来由 Agent 抓取 + 提炼 + 调脚本；现在这一整套由本脚本顺序执行。
 *
 * 流程：
 *   ① 交易日判断（gap_check，口径与 verify.js / health_check.js 一致）→ 非交易日退出
 *   ② 幂等守卫：当日 reports 里已有 morning → 退出（避免覆盖人工修正过的内容）
 *   ③ 取数：tools/fetch_jy_article.js --date <date> --out <tmp>
 *   ④ 组装「历史板数参考」：从近 7 期报告抽取个股状态，供模型写 status 时对照
 *   ⑤ LLM 提炼 → 结构化 JSON
 *   ⑥ 写 tmp_morning_<date>.json（**必须自带 morning.generatedAt**，见下方注释）
 *   ⑦ node tools/merge_report.js --kind morning --in <json>
 *      · 退出码 3（内容校验失败）→ 把 stderr 反馈给模型，**自动重试一次**
 *   ⑧ node tools/check_codes.js --fix --prune
 *   ⑨ bash tools/publish.sh "早报 <date>"
 *   ⑩ 追加 logs/<date>.md
 *
 * 用法：
 *   node tools/job_morning.js                     # 正常执行
 *   node tools/job_morning.js --date 2026-09-18   # 指定日期（补跑）
 *   node tools/job_morning.js --dry               # 只到 LLM 出 JSON，不写盘、不发布
 *   node tools/job_morning.js --force             # 忽略幂等守卫
 *   node tools/job_morning.js --no-publish        # 写入但不发布（联调用）
 *
 * 退出码：
 *   0 成功，或「非交易日 / 当日未发布」的正常跳过
 *   1 参数或环境错误（如缺 LLM_API_KEY）
 *   2 取数失败
 *   3 LLM 连续两次产出不合法
 *   4 merge_report 内容校验失败
 *   5 安全阀中止（data.js 疑似损坏或并发写冲突）
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

/** 网络类故障关键词：命中才写 ALERT；否则视为「数据源今天没发」，属正常情况。 */
const NET_HINTS = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|timeout|HTTP [45]\d\d/i;

/* ───────────────────────── 基础设施 ───────────────────────── */

function parseArgs(argv) {
  const out = { date: '', dry: false, force: false, publish: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i] || '';
    else if (a === '--dry') out.dry = true;
    else if (a === '--force') out.force = true;
    else if (a === '--no-publish') out.publish = false;
    else if (a === '--help' || a === '-h') { console.log('用法：node tools/job_morning.js [--date YYYY-MM-DD] [--dry] [--force] [--no-publish]'); process.exit(0); }
    else throw new Error('未知参数：' + a);
  }
  return out;
}

/** 同步执行外部命令，返回 {code, stdout, stderr}（不抛错，由调用方按 code 分支）。 */
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

/** 追加当日日志（append-only）。health_check 靠 logs/<date>.md 的存在区分「管线没跑」与「源没发」。 */
function appendLog(date, lines) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, date + '.md'), '\n' + lines.join('\n') + '\n');
  } catch (e) {
    console.warn('⚠️ 日志写入失败（不影响主流程）：' + e.message);
  }
}

/** 当日 reports 是否已有 morning —— 幂等判据。 */
function hasMorning(date) {
  const { data } = loadDataStrict(DATA);
  const rec = (data.reports || []).find(function (r) { return r && r.date === date; });
  return !!(rec && rec.morning);
}

/**
 * 从近 7 期报告里抽取「个股 → 最近一次状态描述」，作为模型写 status 的对照。
 *
 * 为什么需要：status 要求「板数+位置+特征」三段式，而板数只有历史记录里才有。
 * 旧流程靠 Agent 手工反查（memory 记录过一次误用 grep 导致按日期串味的教训），
 * 这里改成把历史状态**一次性喂给模型**，让它有依据地写，而不是凭感觉编。
 */
function buildBoardReference() {
  try {
    const { data } = loadDataStrict(DATA);
    const map = new Map();
    (data.reports || []).forEach(function (r) {
      const mg = (r.morning && r.morning['今日关注']) || [];
      mg.forEach(function (p) {
        if (p && p.code) map.set(p.code, r.date + ' 早报 ' + (p.name || '') + '：' + (p.status || ''));
      });
      const ev = (r.evening && r.evening['明日关注']) || [];
      ev.forEach(function (s) {
        ((s && s.picks) || []).forEach(function (p) {
          if (p && p.code) map.set(p.code, r.date + ' 晚报 ' + (p.name || '') + '：' + (p.status || ''));
        });
      });
    });
    return map;
  } catch (e) {
    console.warn('⚠️ 历史板数参考构建失败（不阻塞）：' + e.message);
    return new Map();
  }
}

/** 从取数器 stdout 里提取文章 URL（形如 `# 命中 2026-09-21 08:07:24  https://…/a/<id>`）。 */
function extractUrl(stdout) {
  const m = String(stdout || '').match(/https:\/\/www\.jiuyangongshe\.com\/a\/[a-z0-9]+/i);
  return m ? m[0] : '';
}

/** 只保留 merge_report 需要的字段，防止模型多吐的键污染 data.js。 */
function shapeMorning(c, today, now, url) {
  const s = c.sections || {};
  const renqi = s['盘前人气股'] || {};
  return {
    date: today,
    at: now,
    morning: {
      title: String(c.title || '').trim(),
      source: '韭研公社·开盘必读',
      sourceUrl: url || 'https://www.jiuyangongshe.com/',
      // 🔴 必须自带：merge_report.js 只把本对象原样赋值，**不会生成 generatedAt**。
      //    缺失会导致 dashboard/js/app.js 判「早报未生成」，且 health_check.js 报警。
      generatedAt: now,
      sections: {
        '要闻简讯': Array.isArray(s['要闻简讯']) ? s['要闻简讯'].map(String) : [],
        '盘前人气股': {
          '韭研公社': String(renqi['韭研公社'] || ''),
          '同花顺': String(renqi['同花顺'] || ''),
          '东方财富': String(renqi['东方财富'] || ''),
          '淘股吧': String(renqi['淘股吧'] || ''),
        },
        '重点公告': Array.isArray(s['重点公告']) ? s['重点公告'].map(String) : [],
        '今日新股': String(s['今日新股'] || ''),
      },
      '今日关注': (Array.isArray(c['今日关注']) ? c['今日关注'] : []).map(function (p) {
        p = p || {};
        return {
          name: String(p.name || '').trim(),
          code: String(p.code || '').trim(),
          sector: String(p.sector || '').trim(),
          status: String(p.status || '').trim(),
          reason: String(p.reason || '').trim(),
        };
      }),
    },
  };
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

  /* ① 交易日 */
  if (!gapCheck.isTradingDay(new Date(today + 'T00:00:00'), loadHolidays())) {
    console.log('· ' + today + ' 非交易日 → 跳过');
    return 0;
  }

  /* ② 幂等守卫 */
  if (!args.force && hasMorning(today)) {
    console.log('· ' + today + ' 已存在早报 → 跳过（需要重写请加 --force）');
    return 0;
  }

  /* ③ 取数 */
  const rawFile = path.join(ROOT, 'tmp_morning_raw_' + today + '.txt');
  console.log('· 取数中：fetch_jy_article.js --date ' + today);
  const fr = run('node', ['tools/fetch_jy_article.js', '--date', today, '--out', rawFile]);
  if (fr.code !== 0) {
    const detail = (fr.stderr || fr.stdout || '').trim().slice(0, 500) || ('退出码 ' + fr.code);
    const isNet = NET_HINTS.test(detail);
    console.log('· 取数未成功' + (isNet ? '（疑似网络故障）' : '（疑似当日未发布）') + '：' + detail.slice(0, 200));
    appendLog(today, [
      '## ' + today + ' 早报 - 未产出',
      '- 取数失败：' + detail,
      '- 判定：' + (isNet ? '网络故障（已写 ALERT）' : '数据源当日未发布（正常，不告警）'),
    ]);
    if (isNet) {
      ops.appendAlert({
        stage: 'job_morning/取数', result: 'OPEN', script: 'job_morning.js',
        detail: detail, fix: '检查服务器出网与韭研公社可达性；确认后重跑 node tools/job_morning.js',
        link: 'logs/' + today + '.md',
      });
    }
    return 2;
  }

  const body = fs.readFileSync(rawFile, 'utf8');
  const url = extractUrl(fr.stdout);
  if (!body.trim()) {
    console.error('✗ 取数成功但正文为空 → 中止（不写空早报）');
    appendLog(today, ['## ' + today + ' 早报 - 未产出', '- 正文为空，中止']);
    return 2;
  }
  console.log('· 正文 ' + body.length + ' 字符，文章 ' + (url || '(未解析到 URL)'));

  /* ④ 历史板数参考 */
  const ref = buildBoardReference();
  const refText = ref.size
    ? Array.from(ref.entries()).map(function (e) { return e[0] + ' ' + e[1]; }).join('\n')
    : '（无可参考的历史记录）';

  /* ⑤ LLM 提炼（失败时带 stderr 重试一次） */
  const baseUser = P.morningUser(today, url, body) +
    '\n\n【历史板数参考】以下是近期报告里这些个股的状态记录，写 status 时请据此判断板数，不要凭空推测：\n' +
    refText;

  let payload = null;
  let hint = '';
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = hint
      ? baseUser + '\n\n【上一次输出被校验拒绝，请针对性修正后重新输出完整 JSON】\n' + hint
      : baseUser;
    console.log('· LLM 提炼中（第 ' + (attempt + 1) + ' 次）…');
    let content;
    try {
      content = await llm.askJson({ system: P.MORNING_SYSTEM, user: user, maxTokens: 8192 });
    } catch (e) {
      lastErr = 'LLM 调用或 JSON 解析失败：' + e.message;
      console.error('✗ ' + lastErr);
      if (attempt === 0) continue;
      break;
    }
    const now = ops.stampMin();
    payload = shapeMorning(content, today, now, url);

    const jsonFile = path.join(ROOT, 'tmp_morning_' + today + '.json');
    fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2), 'utf8');
    console.log('· 今日关注 ' + payload.morning['今日关注'].length + ' 只，' +
      '要闻 ' + payload.morning.sections['要闻简讯'].length + ' 条，' +
      '公告 ' + payload.morning.sections['重点公告'].length + ' 条');

    if (args.dry) {
      console.log('· --dry：已写出 ' + path.basename(jsonFile) + '，不再写盘/发布');
      return 0;
    }

    /* ⑦ merge_report */
    const mr = run('node', ['tools/merge_report.js', '--kind', 'morning', '--in', jsonFile]);
    if (mr.code === 0) { lastErr = ''; break; }

    lastErr = (mr.stderr || mr.stdout).trim();
    if (mr.code === 3 && attempt === 0) {
      hint = lastErr.slice(0, 2000);
      console.warn('⚠️ 内容校验未通过（退出码 3）→ 反馈给模型重试一次');
      continue;
    }
    if (mr.code === 2) {
      console.error('✗ 安全阀中止（data.js 疑似损坏或并发写冲突）→ 立即停止，不做补救性写入');
      appendLog(today, ['## ' + today + ' 早报 - 安全阀中止', '- ' + lastErr]);
      ops.appendAlert({
        stage: 'job_morning/merge', result: 'ABORT', script: 'job_morning.js',
        detail: lastErr, fix: '人工确认 dashboard/data.js；确认无误后重跑',
        link: 'dashboard/data.js',
      });
      return 5;
    }
    console.error('✗ merge_report 失败（退出码 ' + mr.code + '）：' + lastErr);
    return 4;
  }

  if (lastErr) {
    console.error('✗ 早报生成失败：' + lastErr);
    appendLog(today, ['## ' + today + ' 早报 - 未产出', '- ' + lastErr]);
    ops.appendAlert({
      stage: 'job_morning/校验', result: 'OPEN', script: 'job_morning.js',
      detail: lastErr.slice(0, 800), fix: '人工复查 prompt 或上游正文；修正后重跑',
      link: 'logs/' + today + '.md',
    });
    return 3;
  }

  /* ⑧ 代码校验 */
  const cc = run('node', ['tools/check_codes.js', '--fix', '--prune']);
  console.log(cc.code === 0
    ? '· check_codes：' + (cc.stdout || '').trim().split('\n').slice(-3).join(' / ')
    : '⚠️ check_codes 非零退出（继续，不阻塞发布）：' + (cc.stderr || '').trim().slice(0, 200));

  /* ⑨ 发布 */
  let pubInfo = '未发布（--no-publish）';
  if (args.publish) {
    const pu = run('bash', ['tools/publish.sh', '早报 ' + today]);
    if (pu.code !== 0) {
      console.error('✗ 发布失败（退出码 ' + pu.code + '）：' + (pu.stderr || pu.stdout).slice(0, 400));
      appendLog(today, ['## ' + today + ' 早报 - 已写入但发布失败', '- ' + (pu.stderr || pu.stdout).slice(0, 800)]);
      ops.appendAlert({
        stage: 'job_morning/publish', result: 'OPEN', script: 'job_morning.js',
        detail: (pu.stderr || pu.stdout).slice(0, 800),
        fix: '数据已在本地提交，重跑 node tools/gh_push_api.js 即可补推；不要重跑 publish.sh（会再刷一次版本号）',
        link: 'tools/publish.sh',
      });
      return 6;
    }
    pubInfo = '已发布（' + (pu.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] + '）';
  }

  /* ⑩ 日志 + 清理 */
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  appendLog(today, [
    '## ' + today + ' 早报 - ' + (args.publish ? '已发布' : '已写入（未发布）'),
    '- 模式：job_morning.js（服务器版，LLM=' + llm.cfg().textModel + '）',
    '- 数据源：' + (url || '（URL 未解析）'),
    '- 正文：' + body.length + ' 字符',
    '- 产出：要闻 ' + payload.morning.sections['要闻简讯'].length + ' 条 / 人气股 4 平台 / ' +
      '公告 ' + payload.morning.sections['重点公告'].length + ' 条 / 今日关注 ' +
      payload.morning['今日关注'].length + ' 只',
    '- 发布：' + pubInfo,
    '- 耗时：' + secs + 's',
  ]);
  try { fs.unlinkSync(rawFile); } catch (e) { /* 清理失败无所谓 */ }
  try { fs.unlinkSync(path.join(ROOT, 'tmp_morning_' + today + '.json')); } catch (e) { /* 同上 */ }

  console.log('✔ 早报完成：' + today + '（' + secs + 's，' + pubInfo + '）');
  return 0;
}

main().then(function (rc) { process.exit(rc); })
  .catch(function (e) {
    console.error('✗ 未捕获异常：' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
