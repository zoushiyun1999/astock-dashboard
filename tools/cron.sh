#!/usr/bin/env bash
# tools/cron.sh —— 服务器端定时任务统一入口
#
# 为什么必须走统一入口：
#   ① **并发互斥**：早报、晚报、量价、验证都会重写 dashboard/data.js，
#      两个任务重叠执行会互相覆盖对方成果（历史上「PC 关机后开机补跑」踩过这个坑）。
#      所有任务经同一把 flock，天然串行。
#   ② **环境变量单点加载**：LLM_API_KEY / LLM_* 只在 ~/.astock.env 写一次，
#      不散落到各 crontab 行里（也避免 key 出现在 crontab 明文里）。
#   ③ **时区断言**：服务器时区不是 +0800 会让「今天」整体错位一天，
#      且症状是「数据写到了错误的日期」而不是报错 —— 必须在入口硬拦。
#
# 用法：
#   bash tools/cron.sh morning     # 早报（08:30）
#   bash tools/cron.sh evening     # 晚报（21:00）
#   bash tools/cron.sh screener    # 量价选股（交易日 15:10）
#   bash tools/cron.sh verify      # 次日验证（交易日 21:30）
#   bash tools/cron.sh health      # 数据体检（每天 07:00）
#
# 安装 crontab（服务器时区须为 Asia/Shanghai）：
#   crontab -e
#   ---------------------------------------------------------------
#   0  7  * * *    cd /opt/astock && bash tools/cron.sh health    >> logs/cron.log 2>&1
#   30 8  * * *    cd /opt/astock && bash tools/cron.sh morning   >> logs/cron.log 2>&1
#   10 15 * * 1-5  cd /opt/astock && bash tools/cron.sh screener  >> logs/cron.log 2>&1
#   0  21 * * *    cd /opt/astock && bash tools/cron.sh evening   >> logs/cron.log 2>&1
#   30 21 * * 1-5  cd /opt/astock && bash tools/cron.sh verify    >> logs/cron.log 2>&1
#   ---------------------------------------------------------------
#
# 退出码：透传被调任务的退出码；0 表示成功或「正常跳过」。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT" || exit 1

# cron 环境的 PATH 极简，必须显式补全（否则 node 找不到）
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# ── 环境变量（不入库；含 LLM_API_KEY、LLM_BASE_URL、LLM_TEXT_MODEL、LLM_VISION_MODEL 等）──
ENV_FILE="${ASTOCK_ENV:-$HOME/.astock.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

LOG="$ROOT/logs/cron.log"
mkdir -p "$ROOT/logs"

log() {
  local msg
  msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  printf '%s\n' "$msg"
  printf '%s\n' "$msg" >> "$LOG"
}

TASK="${1:-}"
case "$TASK" in
  morning|evening|screener|verify|health) ;;
  *)
    log "用法：bash tools/cron.sh <morning|evening|screener|verify|health>"
    exit 1
    ;;
esac

# ── 时区断言（时区错误不会报错，只会把数据写到错误的日期）──
TZ_OFFSET="$(date '+%z')"
if [ "$TZ_OFFSET" != "+0800" ]; then
  log "✗ 服务器时区不是 +0800（当前 $TZ_OFFSET）→ 中止 $TASK"
  log "  修复：sudo timedatectl set-timezone Asia/Shanghai"
  exit 1
fi

# ── 并发互斥 ──
exec 9>"/tmp/astock_job.lock"
if ! flock -n 9; then
  log "· 另一个 astock 任务正在运行 → 跳过 $TASK（避免 dashboard/data.js 并发覆盖）"
  exit 0
fi

DAY="$(date '+%Y-%m-%d')"
log "▶ $TASK 开始"

rc=0
case "$TASK" in
  morning)
    node tools/job_morning.js
    rc=$?
    ;;
  evening)
    node tools/job_evening.js
    rc=$?
    ;;
  screener)
    node tools/screener.js
    rc=$?
    if [ "$rc" -eq 0 ]; then
      bash tools/publish.sh "量价选股 $DAY"
      rc=$?
    else
      log "· screener 退出码 $rc → 不发布（非交易日或上游故障闸门）"
    fi
    ;;
  verify)
    node tools/verify.js --rebuild
    rc=$?
    if [ "$rc" -eq 0 ]; then
      bash tools/publish.sh "次日验证 $DAY"
      rc=$?
    fi
    ;;
  health)
    node tools/health_check.js
    rc=$?
    ;;
esac

if [ "$rc" -eq 0 ]; then
  log "■ $TASK 结束（退出码 0）"
else
  log "■ $TASK 结束（退出码 $rc，需关注）"
fi
exit "$rc"
