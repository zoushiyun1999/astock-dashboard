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

# node.exe 是 Windows 程序，需要 Windows 风格路径（/c/... → C:/...）；提前算好，副闸也用得到。
WIN_SCRIPT="$(cd "$SCRIPT_DIR" && pwd -W)"
WIN_ROOT="$(cd "$ROOT" && pwd -W)"

# ── 应用级互斥锁（P2-5）：包住「bump → commit → push」全程 ──────────────
# 与下方 index.lock 守卫正交：本锁管「两进程同时发布」，守卫管「陈旧 git 锁残留」。
# 锁被占用时有界重试后 exit 0（跳过本次；数据已在盘上，下次发布会自动带上）。
# 锁先于 index.lock 守卫获取、由 trap 释放，不干扰守卫（规则 24）。
source "$SCRIPT_DIR/lib/lock.sh"
lock_acquire
trap 'lock_release' EXIT INT TERM

# 未闭环告警提示：通知已下线，logs/ALERT.md 是唯一的失败出口（规则 18）。
OPEN_CNT="$("$NODE_BIN" "$WIN_SCRIPT/lib/ops.js" --list-open 2>/dev/null | tr -dc '0-9')"
[ -n "$OPEN_CNT" ] || OPEN_CNT=0
if [ "$OPEN_CNT" -gt 0 ] 2>/dev/null; then
  echo "⚠️  存在 $OPEN_CNT 条未闭环告警（logs/ALERT.md）—— 上次发布或任务可能失败，请核查"
fi

# ── 陈旧 git 锁守卫 ──────────────────────────────────────────────
# 症状：git commit 报 'Unable to create index.lock: File exists'，
#       而第 1/4 步（刷版本号/导出）已正常跑完 → 发布静默中断，数据只落一半。
# 成因：上一轮任务被中断/杀掉（超时、调度重启），锁未回收留下 0 字节空文件。
# 处置：仅当「锁存在」且「当前无 git 进程」时才删除 —— 有活跃 git 进程时绝不动，
#       避免打断正在进行的提交。删除后打印告警，便于事后回溯中断原因。
if git rev-parse --git-dir >/dev/null 2>&1; then
  GIT_DIR_PATH="$(git rev-parse --git-dir)"
  LOCK_FILE="$GIT_DIR_PATH/index.lock"
  if [ -f "$LOCK_FILE" ]; then
    # 统计活跃 git 进程。两个坑：
    #   1) tasklist 在 Git Bash 下要用单破折号 `-FI`，`//FI` 会报「无效参数」；
    #   2) `grep -c` 无匹配时输出 0 但退出码为 1，若写成 `|| echo 0` 会拼出 "0\n0"
    #      让 [ -eq ] 崩掉。故先取原始输出再 tr 清空白，最后兜底赋 0。
    GIT_PROCS="$(tasklist -FI "IMAGENAME eq git.exe" -NH 2>/dev/null | grep -ci "git.exe" | tr -d '[:space:]')"
    [ -n "$GIT_PROCS" ] || GIT_PROCS=0
    if [ "$GIT_PROCS" -eq 0 ] 2>/dev/null; then
      echo "⚠️  检测到陈旧 git 锁（$LOCK_FILE，无活跃 git 进程）→ 自动清除"
      echo "    成因通常是上一轮任务被中断/杀掉，锁未回收。"
      rm -f "$LOCK_FILE"
    else
      echo "⚠️  检测到 git 锁且有 $GIT_PROCS 个 git 进程在运行 → 不干预，等待其自行释放"
    fi
  fi
fi

echo "== 1/4 刷新版本号与数据产物 =="
bash "$SCRIPT_DIR/bump_version.sh"

# ── 规模骤减副闸（P1-1）：bump_version 之后、git add 之前 ──
# 比对「排序裁剪后的工作区 data.js」vs「HEAD（上一已发布态）」。口径与 gh_push_api.js 的
# 主闸一致（同一纯函数 scaleBlocked + 同一阈值）；副闸放行 ≠ 授权发布，主闸在推送时总会再跑。
echo "== 1.5/4 规模骤减副闸（工作区 vs HEAD）=="
if [ "${ASTOCK_SKIP_GATE:-}" = "1" ]; then
  echo "⚠️  ASTOCK_SKIP_GATE=1 → 已旁路规模副闸（紧急模式）"
else
  "$NODE_BIN" "$WIN_SCRIPT/lib/ops.js" --scale-gate --against-head || {
    echo "✗ 规模骤减副闸触发：拒绝提交（详见 logs/ALERT.md）。确属正常可用 ASTOCK_SKIP_GATE=1 旁路重发。" >&2
    exit 1
  }
fi

echo "== 2/4 本地 git 提交 =="
COMMIT_SHORT=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  git add -A
  if git diff --cached --quiet; then
    echo "（无文件变化，跳过提交）"
  elif git -c core.quotepath=false commit -m "$MSG" >/dev/null 2>&1; then
    COMMIT_SHORT="$(git rev-parse --short HEAD)"
    echo "commit $COMMIT_SHORT"
  else
    echo "（提交失败，继续尝试推送）"
  fi
else
  echo "（非 git 仓库，跳过）"
fi

echo "== 3/4 推送到 GitHub =="
# 本地模式守卫：未配置令牌时「跳过推送」而不是「报错退出」。
# 否则每次定时任务都会在最后一步硬失败（数据其实已提交，但任务被判失败）。
TOKEN_FILE="$ROOT/.gh-token"
if [ ! -f "$TOKEN_FILE" ] && [ -z "$GITHUB_TOKEN" ]; then
  echo "（未找到 .gh-token，本地模式：跳过云端推送）"
  echo "== 4/4 完成（仅本地仓库）=="
  # 发布（本地提交）成功 → 快照 HEAD 版 data.js，保留 7 份（P2-8，best-effort）
  "$NODE_BIN" "$WIN_SCRIPT/lib/ops.js" --snapshot || true
  WIN_ROOT_DISPLAY="$(cd "$ROOT" && pwd -W 2>/dev/null || echo "$ROOT")"
  printf '提示：把 GitHub PAT 写入 %s\\.gh-token 后，本命令会自动上线。\n' "$WIN_ROOT_DISPLAY"
  exit 0
fi

# node.exe 是 Windows 程序，需要 Windows 风格路径（/c/... → C:/...）
WIN_SCRIPT="$(cd "$SCRIPT_DIR" && pwd -W)"
WIN_ROOT="$(cd "$ROOT" && pwd -W)"
"$NODE_BIN" "$WIN_SCRIPT/gh_push_api.js" -m "$MSG" || {
  echo "✗ 推送失败，请检查 .gh-token 是否有效";
  "$NODE_BIN" "$WIN_SCRIPT/lib/ops.js" --append-alert --stage "3/4-推送" --script "publish.sh" \
    --result OPEN --detail "gh_push_api.js 推送失败（见上方日志）" \
    --fix "检查 .gh-token 有效性 / 网络；直接 node tools/gh_push_api.js 重试（勿重复跑 publish.sh，会多刷版本号）" \
    --link "logs/ALERT.md" || true
  exit 1;
}

echo "== 4/4 完成 =="
# 发布成功 → 快照 HEAD 版 data.js（此时工作区 = 已发布良态），保留 7 份（P2-8，best-effort）
"$NODE_BIN" "$WIN_SCRIPT/lib/ops.js" --snapshot || true
# 链接唯一事实源是 config/site.json，禁止硬编码
SITE_URL="$("$NODE_BIN" -e "try{console.log(require('$WIN_ROOT/config/site.json').siteUrl||'')}catch(e){console.log('')}")"
echo "云端发布中，约 1 分钟后生效：${SITE_URL:-（config/site.json 未配置 siteUrl）}"
