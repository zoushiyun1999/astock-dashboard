#!/bin/bash
# 发布 + 微信通知（供定时任务调用，替代原先的「部署沙箱 + 手动 curl 推送」）
#
# 用法：bash tools/publish_and_notify.sh morning|evening|screener [日期]
#
# 为什么要封装：
#   · 原任务流程是「workbuddy_sites_deploy 得到沙箱 shareLink → 用它发微信」，
#     沙箱链接会失效、会漂移，是用户「链接不稳定」的根源。
#   · 现在改为：提交即推送 GitHub → Actions 发布到固定域名 https://asx.79zl.cn/
#   · 链接统一从 config/site.json 读取，绝不在任务 prompt 里硬编码。
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

TYPE="$1"
[ -z "$TYPE" ] && { echo "用法：bash tools/publish_and_notify.sh morning|evening|screener [日期]"; exit 1; }
DATE="${2:-$(date +%Y-%m-%d)}"
NODE_BIN="/c/Users/zoush/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
[ -x "$NODE_BIN" ] || NODE_BIN="node"
WIN_ROOT="$(cd "$ROOT" && pwd -W)"

case "$TYPE" in
  morning)  TITLE="🌅 A股早报已更新（${DATE}）" ;;
  evening)  TITLE="🌙 A股晚报已更新（${DATE}）" ;;
  screener) TITLE="🔍 量价选股已更新（${DATE}）" ;;
  *) echo "未知类型：$TYPE"; exit 1 ;;
esac

echo "== 1/3 发布到云端 =="
bash "$SCRIPT_DIR/publish.sh" "看板数据 ${DATE} ${TYPE}"

echo "== 2/3 等待云端发布生效 =="
SITE_URL=$("$NODE_BIN" -e "console.log(require('$WIN_ROOT/config/site.json').siteUrl)")
for i in 1 2 3 4 5 6; do
  sleep 20
  if curl -s -m 15 -o /dev/null -w '%{http_code}' "$SITE_URL" 2>/dev/null | grep -q 200; then
    echo "   站点可达（第 ${i} 次探测）：$SITE_URL"
    break
  fi
  echo "   第 ${i} 次探测未通过，继续等待…"
done

echo "== 3/3 微信通知 =="
"$NODE_BIN" "$WIN_ROOT/tools/notify_digest.js" "$TYPE" "$TITLE" || echo "（通知失败，不影响发布）"

echo "== 完成 =="
