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
# ⚠️ flock 属 util-linux：Linux（含 ECS）必有，**Git Bash 上没有**。
#    旧写法 `if ! flock -n 9` 在 flock 缺失时会因 `!` 取反而被当成「拿到锁失败」→
#    **每个任务都被静默跳过**，且日志写成「另一个任务正在运行」（完全误导）。
#    2026-09-22 本机 Git Bash 实测：health / morning 全部被跳过、退出码还是 0。
#    现在显式区分「真抢占不到锁」与「本机没有 flock」两种情况。
if command -v flock >/dev/null 2>&1; then
  exec 9>"/tmp/astock_job.lock"
  if ! flock -n 9; then
    log "· 另一个 astock 任务正在运行 → 跳过 $TASK（避免 dashboard/data.js 并发覆盖）"
    exit 0
  fi
else
  log "! flock 不可用（非 Linux 环境？）→ 跳过并发互斥，继续执行 $TASK"
fi

DAY="$(date '+%Y-%m-%d')"

# ── 过渡期预同步（双环境共存的安全阀）──────────────────────────────────
# 本机与 ECS 会交替写 dashboard/ 与 tools/，而 gh_push_api.js 是**按文件内容差异推送**的：
# 落后的一侧一旦发布，就会把它手里的旧文件推回远端、**静默撤销另一侧的成果**
# （2026-09-22 两次实证：ECS 克隆后的旧代码；本机落后的 data.js）。
# 服务器侧跑**全量**同步（代码与数据都不该落后）；任务的 dashboard 文件由各 job
# 自己的 pre_sync 再兜一层。health 是只读任务（不写盘、不发布）→ 跳过。
# 放在 flock 之后：避免两个任务同时同步。
if [ "$TASK" != "health" ]; then
  SYNC_OUT="$(node tools/sync_from_api.js --apply 2>&1)"
  SYNC_RC=$?
  if [ "$SYNC_RC" -eq 0 ]; then
    log "· 预同步：$(printf '%s' "$SYNC_OUT" | tail -1)"
  else
    log "! 预同步失败（rc=$SYNC_RC）→ 继续执行；本次发布有「把旧文件推回远端」的风险"
  fi
fi

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
      # 推荐走势跟踪（2026-09-24，方案 B）：抓日K算「买入后逐日走势」+ 聚合渠道级战绩。
      # 串在这里而不是新增 cron 槽：① 与 verify 同源同参数（都用腾讯日K、都已节流 400ms）
      # ② 必须在 publish **之前**跑，否则 dashboard/track.js 要等下一轮才上线
      # 软步骤：失败只记录不阻塞发布 —— 前端拿不到 track.js 时按钮会提示「暂无走势数据」，
      # 不会白屏，也不会影响 verify 的成果发布。
      node tools/track.js || log "· track.js 失败（不阻塞发布；前端将显示暂无走势数据）"
      bash tools/publish.sh "次日验证 + 走势跟踪 $DAY"
      rc=$?
      # 自检兜底（2026-09-24）：契约/资源/账本/两套单测。🔴 **约 5 天跑一次**（用户 2026-09-24 要求，
      # 不必每晚）—— 用状态文件 tools/.last_selfcheck 节流；失败不写状态 → 次日重试。
      LAST_SC=$(cat tools/.last_selfcheck 2>/dev/null || echo 0)
      NOW_SC=$(date +%s)
      if [ $((NOW_SC - LAST_SC)) -ge 432000 ]; then
        if node tools/selfcheck.js; then
          echo "$NOW_SC" > tools/.last_selfcheck
        else
          log "· selfcheck 有失败（见上，不阻塞；未写状态，明天再试）"
        fi
      fi
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
