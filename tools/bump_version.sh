#!/bin/bash
# 刷新 dashboard/index.html 中资源引用的版本号（v=时间戳），防止浏览器缓存旧文件
# 用法：bash tools/bump_version.sh（可在任意目录运行）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 应用级互斥锁（可重入，P2-5）：被 publish.sh 调用时 PUBLISH_LOCK_HELD=1 → 直接返回，避免自死锁；
# 被任务（早报/晚报链路）直接调用时自行加锁，退出时释放。锁被占满重试则 exit 0（跳过，安全）。
source "$SCRIPT_DIR/lib/lock.sh"
lock_guard
trap 'lock_release' EXIT INT TERM

INDEX="$SCRIPT_DIR/../dashboard/index.html"
TS=$(date +%Y%m%d%H%M)
if [ -f "$INDEX" ]; then
  sed -i "s/?v=[0-9]*/?v=$TS/g" "$INDEX"
  echo "index.html 版本号已刷新为 v=$TS"
else
  echo "错误：找不到 $INDEX"
  exit 1
fi

# 校正 reports 顺序（按日期升序、最新在末尾），前端 idx=length-1 依赖此顺序
# 复用本步骤：早报/晚报/量价选股跑 bump 时都会顺带校正，避免定时任务写入乱序
NODE_BIN="/c/Users/zoush/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
[ -x "$NODE_BIN" ] || NODE_BIN="node"
WIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd -W)"
# 安全阀感知（缺口 A）：sort_reports 因「规模骤减 / 解析失败 / 乐观锁冲突」主动中止时退出码 2，
# 表示 data.js 已异常，此时继续 commit+push 无意义且危险 → 硬中止发布；
# 退出码 1 等其他错误仍软放行（符合规则 16b：日历压缩/排序等软步骤失败不阻塞发布）。
rc=0
"$NODE_BIN" "$WIN_DIR/tools/sort_reports.js" || rc=$?
if [ "$rc" -eq 2 ]; then
  echo "✗ sort_reports 安全阀触发（规模骤减/解析失败/并发写）→ 中止发布，详见 logs/ALERT.md" >&2
  exit 1
fi

# 同步休市日到前端（config/trade_holidays.json -> dashboard/holidays.js）
"$NODE_BIN" "$WIN_DIR/tools/sync_holidays.js" || true

# 压缩新下载的日历原图（可选步骤：本机没有 Python/Pillow 时自动跳过，不阻塞发布）
#   实测：2 张 2008px 宽的长图 10.96MB -> 4.24MB（-61%），PSNR 50-55dB（肉眼无损），分辨率不变
#   幂等：产物是调色板 PNG，第二次运行会直接跳过
PY_BIN=""
for c in "/c/Users/zoush/.workbuddy/binaries/python/envs/default/Scripts/python.exe" python3 python; do
  if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then PY_BIN="$c"; break; fi
done
if [ -n "$PY_BIN" ]; then
  "$PY_BIN" "$WIN_DIR/tools/optimize_calendar.py" --quiet || true
else
  echo "（未找到 Python，跳过日历图压缩）"
fi

# 回收日历孤儿图：data.js 的 calendar 只保留最近 5 篇，磁盘图片必须同步删，
# 否则 dashboard/calendar/ 会无限膨胀并拖慢每次发布。
"$NODE_BIN" "$WIN_DIR/tools/clean_calendar.js" --quiet || true

# 导出 data.json / version.json（前端按 version.json 轻量轮询，避免每分钟拉全量 data.js）
# ⚠️ 这一步失败必须让整条发布失败：data.js 已更新但 data.json 没更新时，
#    前端轮询拿到的仍是旧版本，而 publish.sh 会照样 commit + push，
#    结果是「看着发布成功、线上数据却停在上一期」。故不加 `|| true`。
if ! "$NODE_BIN" "$WIN_DIR/tools/export_json.js"; then
  echo "✗ export_json.js 失败：data.json/version.json 未更新，中止发布（避免线上数据与 data.js 不一致）" >&2
  "$NODE_BIN" "$WIN_DIR/tools/lib/ops.js" --append-alert --stage "bump/export_json" --script "bump_version.sh" \
    --result OPEN --detail "export_json.js 失败，data.json / version.json 未更新" \
    --fix "检查 dashboard/data.js / screener.js 是否可解析；修复后重发" --link "dashboard/data.json" || true
  exit 1
fi
