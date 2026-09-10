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
 *   · 跳过 .git / .workbuddy / .gh-config / node_modules / logs
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

const ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';
const DEFAULT_REPO = 'zoushiyun1999/astock-dashboard';

// logs/ 也跳过：里面记着本机绝对路径与历史部署链接，公开仓库没必要暴露
const SKIP_DIR = new Set(['.git', '.workbuddy', '.gh-config', 'node_modules', '.github-cache', 'logs']);

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

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

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
