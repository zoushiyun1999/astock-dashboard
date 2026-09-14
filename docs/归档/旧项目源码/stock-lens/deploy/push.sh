#!/usr/bin/env bash
# stock-lens 本地 -> 服务器推送并部署
# 在本机 Git Bash 里运行：  ./push.sh root@<服务器公网IP>
#
# 做的事：
#   1. 打包 local/ 与两个 CLI 技能目录
#   2. scp 到服务器 /tmp/sl-payload
#   3. ssh 过去执行 setup-server.sh
#
# 只想检查打包是否正常、不连服务器：  ./push.sh --stage-only
#
# 服务器系统需为 Ubuntu 22.04 / 24.04 或 Debian 系。

set -euo pipefail

TARGET="${1:-}"
SSH_PORT="${SSH_PORT:-22}"
STAGE_ONLY=0
[[ "$TARGET" == "--stage-only" ]] && STAGE_ONLY=1

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

if [[ $STAGE_ONLY -eq 0 ]]; then
  [[ -n "$TARGET" ]] || die "用法: ./push.sh root@<服务器公网IP>   例: ./push.sh root@47.98.1.2
     只想检查打包：./push.sh --stage-only"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SKILLS="$HOME/.workbuddy/plugins/cache/cb_teams_marketplace/finance-data/1.5.0/skills"

[[ -d "$ROOT/local" ]] || die "找不到 $ROOT/local"

log "1/4 探测本地 CLI 技能目录"
TOOL_DIR="$(ls -d "$SKILLS"/westock-tool 2>/dev/null | tail -1 || true)"
DATA_DIR="$(ls -d "$SKILLS"/westock-data 2>/dev/null | tail -1 || true)"
[[ -n "$TOOL_DIR" ]] || die "找不到 westock-tool 技能目录，请检查 $SKILLS"
[[ -n "$DATA_DIR" ]] || die "找不到 westock-data 技能目录，请检查 $SKILLS"
# 版本号可能变化，用通配再兜一层
if [[ ! -d "$TOOL_DIR" ]]; then
  TOOL_DIR="$(ls -d "$HOME"/.workbuddy/plugins/cache/*/finance-data/*/skills/westock-tool 2>/dev/null | tail -1)"
  DATA_DIR="$(ls -d "$HOME"/.workbuddy/plugins/cache/*/finance-data/*/skills/westock-data 2>/dev/null | tail -1)"
fi
echo "    $TOOL_DIR"
echo "    $DATA_DIR"

log "2/4 组装待上传内容"
STAGE="$HERE/.stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -a "$ROOT/local/." "$STAGE/app/"
# 运行时产物不必上传；.bat 是 Windows 专用的，服务器上走 cron
rm -f "$STAGE/app/update.log" "$STAGE/app/cron.log" "$STAGE/app"/*.bak
rm -f "$STAGE/app"/*.bat
cp -a "$TOOL_DIR" "$STAGE/westock-tool"
cp -a "$DATA_DIR" "$STAGE/westock-data"
cp "$HERE/setup-server.sh" "$HERE/nginx-stock-lens.conf" "$STAGE/"
SIZE="$(du -sh "$STAGE" | awk '{print $1}')"
echo "    待上传 $(find "$STAGE" -type f | wc -l) 个文件，共 $SIZE"

if [[ $STAGE_ONLY -eq 1 ]]; then
  log "干跑模式：打包已完成，未连接服务器"
  echo "    内容清单（前 20 项）："
  ( cd "$STAGE" && find . -type f | sort | head -20 | sed 's/^/      /' )
  echo
  echo "    确认无误后，正式执行：  ./push.sh root@<服务器公网IP>"
  exit 0
fi

log "3/4 上传到 $TARGET:/tmp/sl-payload"
ssh -p "$SSH_PORT" "$TARGET" "rm -rf /tmp/sl-payload && mkdir -p /tmp/sl-payload"
scp -P "$SSH_PORT" -q -r "$STAGE/." "$TARGET:/tmp/sl-payload/"
echo "    上传完成"

log "4/4 在服务器上执行初始化"
ssh -p "$SSH_PORT" "$TARGET" "bash /tmp/sl-payload/setup-server.sh"

rm -rf "$STAGE"
log "全部完成"
