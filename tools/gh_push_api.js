#!/usr/bin/env node
/**
 * 通过 GitHub API 推送文件（不依赖 git 协议）。
 *
 * 为什么需要它：本机到 github.com 的 git 端口不通（代理 502 / 直连超时），
 * 但 api.github.com 可达，所以改用 Git Trees API 直接提交。
 *
 * 用法：
 *   set GITHUB_TOKEN=ghp_xxx
 *   node tools/gh_push_api.js --repo 用户名/仓库名              # 全量推送（首次）
 *   node tools/gh_push_api.js --repo 用户名/仓库名 --only dashboard/data.js dashboard/data.json
 *
 * 说明：
 *   · 首次推送会创建 main 分支；之后是增量提交（parent = 当前分支最新 commit）
 *   · 二进制文件（图片等）走 blobs API，文本文件内联进 tree
 *   · 自动跳过 .git / .workbuddy / .gh-config / node_modules
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN || '';

// logs/ 也跳过：里面记着本机绝对路径与历史部署链接，公开仓库没必要暴露
const SKIP_DIR = new Set(['.git', '.workbuddy', '.gh-config', 'node_modules', '.github-cache', 'logs']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.docx', '.xlsx']);

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

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
  if (!res.ok) {
    fail(method + ' ' + urlPath + ' → HTTP ' + res.status + '\n  ' + text.slice(0, 400));
  }
  return json;
}

/** 收集要上传的文件（相对路径，POSIX 分隔符） */
function collect(onlyList) {
  if (onlyList && onlyList.length) {
    return onlyList.map((f) => f.replace(/\\/g, '/'));
  }
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIR.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  })(ROOT);
  return out;
}

(async function main() {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--repo');
  const repo = ri >= 0 ? argv[ri + 1] : '';
  const oi = argv.indexOf('--only');
  const only = oi >= 0 ? argv.slice(oi + 1).filter((a) => !a.startsWith('--')) : null;
  const message = (argv.includes('-m') ? argv[argv.indexOf('-m') + 1] : null) ||
    ('看板更新 ' + new Date().toISOString().slice(0, 16).replace('T', ' '));

  if (!TOKEN) fail('缺少环境变量 GITHUB_TOKEN');
  if (!repo || !repo.includes('/')) fail('请传 --repo 用户名/仓库名');

  const files = collect(only);
  console.log('待提交文件：' + files.length + ' 个' + (only ? '（增量）' : '（全量）'));

  // 1. 构造 tree 条目
  const tree = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.log('· 跳过（不存在）' + rel); continue; }
    const buf = fs.readFileSync(abs);
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
  if (!tree.length) { console.log('没有文件需要提交'); return; }
  console.log('· tree 构造完成：' + tree.length + ' 项');

  // 2. 取当前 main 分支的最新 commit（不存在则创建根提交）
  let parentSha = null;
  try {
    const ref = await api('GET', '/repos/' + repo + '/git/ref/heads/main');
    parentSha = ref.object.sha;
  } catch (e) { /* 空仓库 */ }

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
  console.log('  接下来 GitHub Actions 会自动发布到 Pages。');
})().catch((e) => fail(e.message));
