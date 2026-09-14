#!/usr/bin/env node
/**
 * 通过 GitHub API 推送文件（不依赖 git 协议）。
 *
 * 为什么需要它：本机到 github.com 的 git 端口不通（代理 502 / 直连超时），
 * 但 api.github.com 可达，所以改用 Git Trees API 直接提交。
 *
 * 特性：
 *   · 真增量：本地算 git blob sha 与远端 tree 比对，只上传有变化的文件
 *   · 自动删除：远端有、本地没有的文件会被删掉（可用 --no-delete 关闭）
 *   · 二进制走 blobs API，文本内联进 tree
 *   · 跳过 .git / .workbuddy / .gh-config / node_modules / logs / docs/归档
 *
 * 用法：
 *   node tools/gh_push_api.js                        # 全量比对（默认仓库见 config/site.json）
 *   node tools/gh_push_api.js --only dashboard/data.js dashboard/data.json
 *   node tools/gh_push_api.js -m "自定义提交信息"
 *
 * 令牌读取顺序：环境变量 GITHUB_TOKEN → 项目根 .gh-token 文件（已 gitignore）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const ops = require('./lib/ops');

const ROOT = path.join(__dirname, '..');
const SC_FILE = path.join(ROOT, 'dashboard', 'screener.js');   // P2-4 后 screener 的真源
const API = 'https://api.github.com';
const DEFAULT_REPO = 'zoushiyun1999/astock-dashboard';

// logs/ 也跳过：里面记着本机绝对路径与历史部署链接，公开仓库没必要暴露
// 归档/ 跳过：docs/归档 是本地历史资料（旧项目源码、诊断报告、工作日志），
//             含主机名/会话 ID 等本机信息，只留本地，不进公开仓库。
// backups/ 跳过：tools/backups 是本地数据快照（回滚保险），只留本地（规则 25 双闸门）。
const SKIP_DIR = new Set(['.git', '.workbuddy', '.gh-config', 'node_modules', '.github-cache', 'logs', '归档', 'backups']);

// 安全闸门：这些文件绝不外传。注意 .gitignore 对 API 推送无效，必须在这里硬拦。
const DENY_FILE = /^(\.gh-token|\.env|\.env\..*|.*\.token|.*\.pem|.*\.key|.*\.p12|id_rsa.*)$/i;

// 本地工作文件（抓取原文、临时图片、合并脚本等），公开仓库不需要
const SKIP_PATH = /(^|\/)(tmp_|_tmp|temp_|_preview|_test|_shot)/i;
const DENY_CONTENT = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,          // GitHub 各类令牌
  /SCT[0-9A-Za-z]{20,}/,                  // Server酱 SendKey
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/    // 私钥
];
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.docx', '.xlsx']);

function fail(msg) {
  console.error('✗ ' + msg);
  // 通知已下线（规则 18）：失败必须落到 logs/ALERT.md，否则静默丢失（P1-5）。
  try {
    ops.appendAlert({
      stage: 'gh_push_api', result: 'OPEN', script: 'gh_push_api.js',
      detail: String(msg), fix: '检查 .gh-token 有效性 / 网络 / data.js 规模，详见上方日志',
      link: 'logs/ALERT.md'
    });
  } catch (e) { /* 告警写入失败不叠加故障 */ }
  process.exit(1);
}

const TOKEN = (function () {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const f = path.join(ROOT, '.gh-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
})();

async function api(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'astock-dashboard'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  if (!res.ok) fail(method + ' ' + urlPath + ' → HTTP ' + res.status + '\n  ' + text.slice(0, 400));
  return json;
}

/** 计算文件在 git 中的 blob sha（与 GitHub 的算法一致） */
function gitBlobSha(buf) {
  const header = Buffer.from('blob ' + buf.length + '\0', 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

/** 解析 `window.REPORTS = {...}` 源码，取回对象（用于读取条数）。 */
function parseDataSrc(src) {
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx, { filename: 'dashboard/data.js' });
  const d = ctx.window.REPORTS;
  if (!d || typeof d !== 'object') return null;
  return d;
}

/** 取远端 dashboard/data.js 的 blob 内容并解析出条数（主闸基线）。
 *  远端无该文件 / 取 blob 失败 → 返回 null（调用方据此跳过闸门，不阻断正常发布）。 */
async function remoteDataCounts(repo, blobSha) {
  if (!blobSha) return null;
  const blob = await api('GET', '/repos/' + repo + '/git/blobs/' + blobSha);
  if (!blob || !blob.content) return null;
  const buf = blob.encoding === 'base64'
    ? Buffer.from(blob.content, 'base64')
    : Buffer.from(blob.content, 'utf8');
  const d = parseDataSrc(buf.toString('utf8'));
  if (!d) return null;
  const counts = ops.readCounts(d);
  counts.hasScreener = ops.hasScreenerField(d);   // 远端(=基线) data.js 是否仍带 screener 字段
  return counts;
}

/** 取远端 dashboard/screener.js 的 blob 内容并解析出**历史期数**（主闸基线）。
 *  该文件约 24KB，与已拉取的 216KB data.js 相比成本可忽略；两边口径必须与副闸一致。
 *  远端无该文件 / 取 blob 失败 / 解析失败 → 返回 null（调用方据此跳过，不阻断正常发布）。 */
async function remoteScreenerCount(repo, blobSha) {
  if (!blobSha) return null;
  const blob = await api('GET', '/repos/' + repo + '/git/blobs/' + blobSha);
  if (!blob || !blob.content) return null;
  const buf = blob.encoding === 'base64'
    ? Buffer.from(blob.content, 'base64')
    : Buffer.from(blob.content, 'utf8');
  return ops.screenerHistCount(buf.toString('utf8'));
}

/** 主闸：比较远端（公开现状）与本地待推版本的 data.js 规模，骤减则拦截。
 *  口径与副闸（publish.sh 比 HEAD）完全一致：同一纯函数 scaleBlocked + 同一阈值 SCALE。
 *  screener 迁移豁免**显式且会消失**：仅当**远端(基线)仍带 screener 字段**且**本地已删该字段**
 *  （即一次「首次迁移」）才豁免；其余照常 scaleBlocked。判据看**远端(基线)侧**，
 *  否则本地一旦删字段就永不复原 → 会**永久拦截**量价任务。
 *  取远端 blob 失败则**跳过闸门**（宁可无闸也不阻断正常发布）。 */
async function scaleGate(repo, remoteMap) {
  if (process.env.ASTOCK_SKIP_GATE === '1') {
    console.log('⚠️ ASTOCK_SKIP_GATE=1 → 已旁路规模骤减主闸（紧急模式）');
    return;
  }
  try {
    const localSrc = fs.readFileSync(path.join(ROOT, 'dashboard', 'data.js'), 'utf8');
    const localD = parseDataSrc(localSrc);
    if (!localD) { console.log('· 主闸：本地 data.js 结构异常，跳过规模闸门'); return; }
    const localC = ops.readCounts(localD);
    const remoteC = await remoteDataCounts(repo, remoteMap['dashboard/data.js']);
    if (!remoteC) {
      console.log('· 主闸：远端尚无 data.js 或无法取回内容 → 跳过规模闸门');
      return;
    }
    const blocked = [];
    ['reports', 'calendar'].forEach(function (k) {
      if (ops.scaleBlocked(remoteC[k], localC[k], k)) blocked.push(k + ' ' + remoteC[k] + ' → ' + localC[k]);
    });
    // screener 迁移豁免：远端(基线)仍带 screener 字段 且 本地已删该字段（首次迁移）→ 放行；
    // 其余（含两侧都带字段却 5→0 = 迁移没发生 / 并存期损坏）照常 scaleBlocked。
    const screenerExempt = remoteC.hasScreener === true && !ops.hasScreenerField(localD);
    if (!screenerExempt && ops.scaleBlocked(remoteC.screener, localC.screener, 'screener')) {
      blocked.push('screener ' + remoteC.screener + ' → ' + localC.screener);
    }
    // screener.js（P2-4 后的**真源**）期数主闸：与副闸同口径（同 scaleBlocked / 同阈值）。
    // 远端约 24KB，成本可忽略；解析失败(null) 交由 Fix#2a 处理，不重复报。
    const remoteSC = await remoteScreenerCount(repo, remoteMap['dashboard/screener.js']);
    const localSC = fs.existsSync(SC_FILE) ? ops.screenerHistCount(fs.readFileSync(SC_FILE, 'utf8')) : null;
    if (remoteSC != null && localSC != null && ops.scaleBlocked(remoteSC, localSC, 'screenerHist')) {
      blocked.push('screener.js ' + remoteSC + ' → ' + localSC + ' 期');
    }
    if (blocked.length) {
      fail('规模骤减主闸拦截（远端 → 本地）：' + blocked.join('；') +
        '。已阻止推送以免公开仓库历史被截断；确属正常请用 ASTOCK_SKIP_GATE=1 重试。');
    }
    console.log('✔ 主闸通过（远端→本地 reports ' + remoteC.reports + '→' + localC.reports +
      '，calendar ' + remoteC.calendar + '→' + localC.calendar +
      (remoteSC != null && localSC != null ? ('，screener.js ' + remoteSC + '→' + localSC + ' 期') : '') + '）');
  } catch (e) {
    console.log('· 主闸异常，跳过（不阻断发布）：' + e.message);
  }
}

function collect(onlyList) {
  if (onlyList && onlyList.length) return onlyList.map((f) => f.replace(/\\/g, '/'));
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIR.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = path.relative(ROOT, full).replace(/\\/g, '/');
        if (DENY_FILE.test(rel)) { console.log('🔒 拒绝上传敏感文件：' + rel); continue; }
        if (SKIP_PATH.test(rel)) continue;                    // 本地工作文件，静默跳过
        out.push(rel);
      }
    }
  })(ROOT);
  return out;
}

(async function main() {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--repo');
  const repo = (ri >= 0 ? argv[ri + 1] : '') || DEFAULT_REPO;
  const oi = argv.indexOf('--only');
  const only = oi >= 0 ? argv.slice(oi + 1).filter((a) => !a.startsWith('--')) : null;
  const noDelete = argv.includes('--no-delete');
  const message = (argv.includes('-m') ? argv[argv.indexOf('-m') + 1] : null) ||
    ('看板更新 ' + new Date().toISOString().slice(0, 16).replace('T', ' '));

  if (!TOKEN) fail('缺少令牌：设置环境变量 GITHUB_TOKEN，或把令牌写入项目根 .gh-token 文件');
  if (!repo.includes('/')) fail('请传 --repo 用户名/仓库名');

  // 1. 取远端现状
  let parentSha = null, remoteMap = {};
  try {
    const ref = await api('GET', '/repos/' + repo + '/git/ref/heads/main');
    parentSha = ref.object.sha;
    const commit = await api('GET', '/repos/' + repo + '/git/commits/' + parentSha);
    const tree = await api('GET', '/repos/' + repo + '/git/trees/' + commit.tree.sha + '?recursive=1');
    for (const t of tree.tree) if (t.type === 'blob') remoteMap[t.path] = t.sha;
  } catch (e) { /* 空仓库 */ }

  // 2. 本地比对，只保留有变化的文件
  const files = collect(only);
  const tree = [];
  const localSet = new Set();
  let skipped = 0;

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.log('· 跳过（不存在）' + rel); continue; }
    localSet.add(rel);
    if (DENY_FILE.test(path.basename(rel))) { console.log('🔒 拒绝上传敏感文件：' + rel); continue; }
    const buf = fs.readFileSync(abs);

    // 内容级检查：即使文件名正常，正文里含凭据也拦下
    if (!BINARY_EXT.has(path.extname(rel).toLowerCase())) {
      const txt = buf.toString('utf8');
      const hit = DENY_CONTENT.find((re) => re.test(txt));
      if (hit) {
        console.error('🔒 ' + rel + ' 正文疑似含凭据（' + hit + '），已阻止上传。');
        console.error('   如确认无误，请先移除该内容或将文件加入 SKIP 列表。');
        process.exit(2);
      }
    }

    const sha = gitBlobSha(buf);
    if (remoteMap[rel] === sha) { skipped++; continue; }      // 内容一致，不上传

    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      const blob = await api('POST', '/repos/' + repo + '/git/blobs', {
        content: buf.toString('base64'), encoding: 'base64'
      });
      tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    } else {
      tree.push({ path: rel, mode: '100644', type: 'blob', content: buf.toString('utf8') });
    }
  }

  // 3. 远端多余的文件 → 删除标记
  //    安全约束：只在「全量模式」且「本地收集到的文件数合理」时才允许删除。
  //    若收集数骤降（例如扫描出错），绝不允许删除 —— 否则会把整个仓库清空。
  let removed = 0;
  const remoteCount = Object.keys(remoteMap).length;
  const safeToDelete = !only && !noDelete && parentSha &&
    remoteCount > 0 && files.length >= remoteCount * 0.5;   // 本地文件数不得少于远端的一半
  if (safeToDelete) {
    for (const rel of Object.keys(remoteMap)) {
      if (!localSet.has(rel)) { tree.push({ path: rel, mode: '100644', type: 'blob', sha: null }); removed++; }
    }
  } else if (!only && !noDelete && parentSha && remoteCount > 0) {
    console.log('⚠️ 本地文件数异常偏少（' + files.length + ' vs 线上 ' + remoteCount +
      '），本次跳过删除以保护仓库。');
  }

  // 2.5 主闸：比较远端公开现状与本地待推 data.js 的规模，骤减即拦截（P1-1 的唯一必经咽喉）
  await scaleGate(repo, remoteMap);

  if (!tree.length) {
    console.log('✓ 无变化（扫描 ' + files.length + ' 个文件，全部与线上一致）');
    return;
  }

  console.log('· 变更：新增/修改 ' + (tree.length - removed) + ' 个，删除 ' + removed + ' 个，未变 ' + skipped + ' 个');

  // 4. 提交
  const treeRes = await api('POST', '/repos/' + repo + '/git/trees',
    parentSha ? { tree, base_tree: parentSha } : { tree });
  const commitRes = await api('POST', '/repos/' + repo + '/git/commits', {
    message, tree: treeRes.sha, parents: parentSha ? [parentSha] : []
  });

  if (parentSha) {
    await api('PATCH', '/repos/' + repo + '/git/refs/heads/main', { sha: commitRes.sha });
  } else {
    await api('POST', '/repos/' + repo + '/git/refs', { ref: 'refs/heads/main', sha: commitRes.sha });
  }

  console.log('✓ 已提交 ' + commitRes.sha.slice(0, 8) + ' → https://github.com/' + repo);
  console.log('  GitHub Actions 正在发布，约 1 分钟后线上更新。');
})().catch((e) => fail(e.message));
