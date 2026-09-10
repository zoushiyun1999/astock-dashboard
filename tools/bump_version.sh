#!/bin/bash
# 刷新 dashboard/index.html 中资源引用的版本号（v=时间戳），防止浏览器缓存旧文件
# 用法：bash tools/bump_version.sh（可在任意目录运行）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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
"$NODE_BIN" "$WIN_DIR/tools/sort_reports.js" || true

# 同步休市日到前端（config/trade_holidays.json -> dashboard/holidays.js）
"$NODE_BIN" "$WIN_DIR/tools/sync_holidays.js" || true

# 导出 data.json / version.json（前端按 version.json 轻量轮询，避免每分钟拉全量 data.js）
"$NODE_BIN" "$WIN_DIR/tools/export_json.js" || true
