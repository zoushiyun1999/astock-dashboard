#!/usr/bin/env node
'use strict';
/**
 * tools/sync_from_api.js —— 把 GitHub 远端的最新文件同步到本地（服务器专用）
 *
 * 为什么需要：内地机房 `git pull` 不通（github.com 的 git 协议被干扰），
 * 但 `api.github.com` 可用，而发布链路本来就是走它。
 *
 * 🔴 为什么「必须」做（不是可选优化）：
 *   `gh_push_api.js` 是**按文件内容差异推送**的 —— 只推「本地与远端不同」的文件。
 *   所以本地若存在**落后**的旧文件，推送时会把它**推回远端**，静默撤销别人的修复。
 *   2026-09-22 实测：ECS 上的文件停在 09-21 20:05 的克隆状态，落后于远端的有
 *   `tools/lib/llm.js` / `tools/job_evening.js` / `docs/上云部署方案.md` / `AGENTS.md` /
 *   `dashboard/data.js` … 一旦 publish 就会整体回退。
 *   → **切换产线前必须先跑本脚本，让本地与远端一致。**
 *
 * 同步范围与 `gh_push_api.js` 的推送范围**完全一致**（同一套 SKIP_DIR / DENY_FILE / SKIP_PATH），
 * 因为只有落在该范围内的文件才会被推回远端。
 *
 * 用法：
 *   node tools/sync_from_api.js                              # 只报告差异（默认，不写任何文件）
 *   node tools/sync_from_api.js --apply                      # 实际写入
 *   node tools/sync_from_api.js --only tools/lib/llm.js --apply
 *
 * 退出码：0 已一致 / 已同步完成；1 有差异但未 --apply；2 出错。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const KEY_ENV = 'GITHUB_TOKEN';

// ── 与 gh_push_api.js 保持一致的推送范围规则（改这里必须同步改那边）──
const SKIP_DIR = new Set(['.git', '.workbuddy', '.gh-config', 'node_modules', '.github-cache', 'logs', '归档', 'backups']);
const DENY_FILE = /^(\.gh-token|\.env|\.env\..*|.*\.token|.*\.pem|.*\.key|.*\.p12|id_rsa.*)$/i;
const SKIP_PATH = /(^|\/)(tmp_|_tmp|temp_|_preview|_test|_shot)/i;

function readToken() {
  if (process.env[KEY_ENV]) return String(process.env[KEY_ENV]).trim();
  const f = path.join(ROOT, '.gh-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}
const TOKEN = readToken();
const DEFAULT_REPO = 'zoushiyun1999/astock-dashboard';

/** 路径是否在推送范围内（范围内 = 会被推回远端 = 必须与远端一致）。 */
function inScope(rel) {
  const parts = rel.split('/');
  for (const p of parts) if (SKIP_DIR.has(p)) return false;
  if (DENY_FILE.test(rel) || DENY_FILE.test(path.basename(rel))) return false;
  if (SKIP_PATH.test(rel)) return false;
  return true;
}

/** git blob 哈希：sha1("blob " + 字节数 + "\0" + 内容)。与 `git hash-object` 同算法。 */
function gitBlobSha(buf) {
  const h = crypto.createHash('sha1');
  h.update('blob ' + buf.length + '\0');
  h.update(buf);
  return h.digest('hex');
}

async function api(urlPath) {
  const r = await fetch('https://api.github.com' + urlPath, {
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'astock-sync',
    },
  });
  if (!r.ok) throw new Error(urlPath + ' → HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return r.json();
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const oi = argv.indexOf('--only');
  const only = oi >= 0 ? argv.slice(oi + 1).filter((a) => !a.startsWith('--')) : null;

  if (!TOKEN) {
    console.error('✗ 缺令牌：请把 PAT 写入项目根 .gh-token，或设 GITHUB_TOKEN 环境变量');
    return 2;
  }

  console.log('· 取远端文件清单…');
  const meta = await api('/repos/' + DEFAULT_REPO);
  const branch = meta.default_branch || 'main';
  const tree = await api('/repos/' + DEFAULT_REPO + '/git/trees/' + branch + '?recursive=1');

  // 先算出「范围内」的完整远端文件集。
  // ⚠️ 必须与下面的 --only 过滤**分开**：`extra`（本地多出的文件）必须以**完整**远端集为准，
  //    否则用 --only 时会把其余所有文件误报成「远端没有」（2026-09-22 实测踩到）。
  const remoteInScope = (tree.tree || [])
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, sha: e.sha }))
    .filter((e) => inScope(e.path));
  const remoteSet = new Set(remoteInScope.map((e) => e.path));

  let blobs = remoteInScope;
  if (only && only.length) {
    const want = new Set(only.map((f) => f.replace(/\\/g, '/')));
    blobs = blobs.filter((b) => want.has(b.path));
    const got = new Set(blobs.map((b) => b.path));
    want.forEach(function (w) { if (!got.has(w)) console.log('⚠️ 远端没有这个文件（已跳过）：' + w); });
  }

  const need = [];
  let same = 0;
  for (const b of blobs) {
    const full = path.join(ROOT, b.path);
    let cur = null;
    try { cur = fs.readFileSync(full); } catch (e) { /* 本地缺失 */ }
    if (cur && gitBlobSha(cur) === b.sha) { same++; continue; }
    need.push({ path: b.path, sha: b.sha, isNew: !cur });
  }

  console.log('· 本次比对 ' + blobs.length + ' 个文件：一致 ' + same + '，需同步 ' + need.length);
  if (!need.length) {
    // 只比对子集时不能说「完全一致」——那句话会让用户以为整个工作区都对齐了
    console.log(only && only.length
      ? '✔ 指定的 ' + blobs.length + ' 个文件与远端一致'
      : '✔ 本地与远端完全一致，无需同步');
    return 0;
  }

  console.log('');
  need.forEach(function (n) {
    console.log('  ' + (n.isNew ? '＋ 新增' : '≠ 更新') + '  ' + n.path);
  });

  // 本地多出的文件只报告、不删除（可能是本机特有数据，删错代价大）
  const extra = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIR.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = path.relative(ROOT, full).replace(/\\/g, '/');
        if (!inScope(rel)) continue;
        if (!remoteSet.has(rel)) extra.push(rel);
      }
    }
  })(ROOT);
  if (extra.length) {
    console.log('');
    // ⚠️ 措辞必须准确：`gh_push_api.js` 推的是「本地与远端不同的文件」，
    //    本地新增文件（远端没有）**同样会被推上去**。所以这里不能写「不会被推上去」。
    console.log('· ⚠️ 本地有、远端没有的文件 ' + extra.length + " 个（publish 时**会被推上去**，请确认是本项目该有的文件）：");
    extra.slice(0, 20).forEach(function (e) { console.log('    ?  ' + e); });
    if (extra.length > 20) console.log('    … 还有 ' + (extra.length - 20) + ' 个');
  }

  if (!apply) {
    console.log('');
    console.log('（这是预演。确认无误后加 --apply 实际写入。）');
    return 1;
  }

  console.log('');
  let ok = 0;
  const failed = [];
  for (const n of need) {
    try {
      const blob = await api('/repos/' + DEFAULT_REPO + '/git/blobs/' + n.sha);
      const buf = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8');
      // 写入前复验：解码结果必须与期望的 blob sha 一致，避免半截内容落盘
      if (gitBlobSha(buf) !== n.sha) throw new Error('blob 内容校验不符（期望 ' + n.sha + '）');
      const full = path.join(ROOT, n.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      ok++;
      console.log('  ✔ ' + n.path + '  ' + buf.length + ' 字节');
    } catch (e) {
      failed.push(n.path + ' → ' + (e && e.message ? e.message : e));
      console.log('  ✗ ' + n.path + ' → ' + (e && e.message ? e.message : e));
    }
  }

  console.log('');
  console.log('· 同步完成：成功 ' + ok + ' / ' + need.length + (failed.length ? '，失败 ' + failed.length : ''));
  return failed.length ? 2 : 0;
}

main().then(function (rc) { process.exitCode = rc; })
  .catch(function (e) {
    console.error('✗ 未捕获异常：' + (e && e.stack ? e.stack : e));
    process.exitCode = 2;
  });
