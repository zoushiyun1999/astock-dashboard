#!/bin/bash
# 一键发布：刷新版本号 → 同步 JSON 产物 → 本地 git 提交 → 推送到 GitHub → 触发云端发布
#
# 用法：bash tools/publish.sh "提交说明"
# 说明：
#   · 第一步 bump_version.sh 会顺带做 sort_reports / sync_holidays / export_json
#   · 推送走 tools/gh_push_api.js（GitHub API），因为本机 git 协议到 github.com 不通
#   · 推送成功后 GitHub Actions 会自动发布到 https://asx.79zl.cn/（支持自有域名）
#   · 令牌从项目根 .gh-token 读取（已 gitignore）
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

MSG="${1:-看板数据 $(date +%Y-%m-%d)}"
NODE_BIN="/c/Users/zoush/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
[ -x "$NODE_BIN" ] || NODE_BIN="node"

echo "== 1/4 刷新版本号与数据产物 =="
bash "$SCRIPT_DIR/bump_version.sh"

echo "== 2/4 本地 git 提交 =="
git add -A
git -c core.quotepath=false commit -m "$MSG" 2>&1 | tail -1 || echo "（无变化或非 git 仓库，跳过）"

echo "== 3/4 推送到 GitHub =="
# node.exe 是 Windows 程序，需要 Windows 风格路径（/c/... → C:/...）
WIN_SCRIPT="$(cd "$SCRIPT_DIR" && pwd -W)"
"$NODE_BIN" "$WIN_SCRIPT/gh_push_api.js" -m "$MSG" || {
  echo "✗ 推送失败，请检查 .gh-token 是否有效";
  exit 1;
}

echo "== 4/4 完成 =="
echo "云端发布中，约 1 分钟后生效：https://asx.79zl.cn/"
