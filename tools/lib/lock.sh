#!/bin/bash
# 应用级发布互斥锁（bash 函数库，source 使用）。
#
# 为什么需要（P2-5）：同一 automation 可能数分钟内被触发两次，两次都会走
#   「写数据 + publish」；而 21:00 晚报 / 21:30 验证仅隔 30 分钟，重叠是常态。
#   publish.sh 的 commit/push 段是真正的竞态区，必须被一把锁包住全程。
#
# 与 .git/index.lock 守卫的关系：两者**正交**。
#   · 本应用锁 = 「两个发布进程同时跑」；
#   · index.lock 守卫 = 「被中断留下的**陈旧** git 锁」。
#   应用锁**先于** index.lock 守卫获取、由 trap 释放，互不干扰（规则 24 只包裹、不改动它）。
#
# 可重入：publish.sh 加锁后调用 bump_version.sh，后者用环境变量
#   PUBLISH_LOCK_HELD=1 直接返回，避免自死锁。
#
# 活性检测：锁文件第一行是持有者的 bash PID（$$）。用 Git Bash 的 `kill -0 "$pid"`
#   判活性 ——**绝不用 tasklist**（它给的是 Windows PID，与 bash 的 MSYS PID 不同名，
#   规则 24 已踩过同类坑）。再加 30 分钟超时兜底为陈旧。
#
# 抢占：有界重试（3 次 × 30s）。仍被占用则 `exit 0` + 写 logs/ALERT.md：
#   本次数据已在盘上，下一次任意发布会自动带上，跳过是安全的。

PUBLISH_LOCK_NAME=".git/astock-publish.lock"
PUBLISH_LOCK_TIMEOUT_SEC=$((30 * 60))
PUBLISH_LOCK_RETRY=3
PUBLISH_LOCK_INTERVAL=30

_publish_lock_path() {
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$root" ] || root="$(pwd)"
  echo "$root/$PUBLISH_LOCK_NAME"
}

_publish_lock_alert() {
  # 尽力写告警；失败也不影响主流程
  local lf="$1" detail="$2"
  local sv="${SCRIPT_DIR:-$(pwd)}"
  local nb="/c/Users/zoush/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
  [ -x "$nb" ] || nb="node"
  "$nb" "$sv/lib/ops.js" --append-alert --stage "publish/互斥锁" \
    --script "lock.sh" --result "OPEN" \
    --detail "$detail" --fix "确认无残留进程后删除 $lf 再重发" --link "$lf" >/dev/null 2>&1 || true
}

# 读取进程启动时刻（/proc/<pid>/stat 第 22 字段：自开机以来的时钟滴答数）。
# 用于交叉校验：锁记录的 pid 若被无关进程复用，其启动时刻必与锁记录不符 → 判为陈旧。
# 不可读（进程已退出 / 非 MSYS 进程）→ 返回非 0（调用方据此跳过该项校验，退回 kill -0 + 超时）。
_publish_lock_proc_start() {
  local pid="$1" s
  [ -n "$pid" ] && [ -r "/proc/$pid/stat" ] || return 1
  s="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  s="${s##*) }"                       # 丢弃 "pid (comm) "，余串以 state 字段开头
  # 余串第 1 字段 = 原第 3 字段(state)，故原第 22 字段(starttime) = 余串第 20 字段
  printf '%s\n' "$s" | awk '{print $20}'
}

# 供 bump_version.sh 使用：若已被 publish 持有则直接返回（可重入），否则尝试加锁。
lock_guard() {
  if [ "${PUBLISH_LOCK_HELD:-}" = "1" ]; then return 0; fi
  lock_acquire
}

# 获取锁：成功 export PUBLISH_LOCK_HELD=1；失败（仍被占用）exit 0 + ALERT。
lock_acquire() {
  if [ "${PUBLISH_LOCK_HELD:-}" = "1" ]; then return 0; fi
  local lf; lf="$(_publish_lock_path)"
  local attempt=1
  while [ "$attempt" -le "$PUBLISH_LOCK_RETRY" ]; do
    if [ -f "$lf" ]; then
      local pid="" age="" lock_host="" lock_start=""
      pid="$(head -n1 "$lf" 2>/dev/null | tr -d '[:space:]')"
      lock_host="$(sed -n '3p' "$lf" 2>/dev/null | tr -d '[:space:]')"
      lock_start="$(sed -n '4p' "$lf" 2>/dev/null | tr -d '[:space:]')"
      local mt now
      mt="$(stat -c %Y "$lf" 2>/dev/null || echo 0)"
      now="$(date +%s)"
      age=$(( now - mt ))
      local alive=0
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
      # 交叉校验：kill -0 判活 ≠ 原持有者仍在 —— pid 可能已被无关进程复用（同机 30min 内）。
      local stale=0
      if [ "$alive" -eq 1 ]; then
        if [ -n "$lock_host" ] && [ "$lock_host" != "$(hostname 2>/dev/null || echo unknown)" ]; then
          stale=1                                   # 主机名不符 → 必非本机并发持有者
        fi
        if [ "$stale" -eq 0 ] && [ -n "$lock_start" ]; then
          local cur_start
          cur_start="$(_publish_lock_proc_start "$pid" 2>/dev/null || echo "")"
          if [ -n "$cur_start" ] && [ "$cur_start" != "$lock_start" ]; then
            stale=1                                 # 启动时刻不符 → 原持有者已退出、pid 被复用
          fi
        fi
      fi
      if [ "$alive" -eq 0 ] || [ "$age" -gt "$PUBLISH_LOCK_TIMEOUT_SEC" ] || [ "$stale" -eq 1 ]; then
        echo "⚠️  检测到陈旧发布锁（pid=${pid:-?}，存活=$alive，stale=$stale，age=${age}s）→ 自动清除"
        rm -f "$lf"
      else
        echo "· 发布锁被 pid=$pid 占用（age=${age}s），${PUBLISH_LOCK_INTERVAL}s 后重试（$attempt/$PUBLISH_LOCK_RETRY）"
        sleep "$PUBLISH_LOCK_INTERVAL"
        attempt=$((attempt + 1))
        continue
      fi
    fi
    # 尝试写入锁：pid / 时间 / 主机名 / 持有者启动时刻（后两项用于防 pid 复用）
    local self_start
    self_start="$(_publish_lock_proc_start "$$" 2>/dev/null || echo "")"
    printf '%s\n%s\n%s\n%s\n' "$$" "$(date +%Y-%m-%dT%H:%M:%S)" "$(hostname 2>/dev/null || echo unknown)" "$self_start" > "$lf" 2>/dev/null
    if [ -f "$lf" ] && [ "$(head -n1 "$lf" 2>/dev/null | tr -d '[:space:]')" = "$$" ]; then
      export PUBLISH_LOCK_HELD=1
      return 0
    fi
    attempt=$((attempt + 1))
  done
  # 仍拿不到 → 跳过本次发布（安全），并留痕
  echo "⚠️  发布锁持续被占用，跳过本次发布（数据已在盘上，下次发布会自动带上）"
  _publish_lock_alert "$lf" "发布锁 $lf 持续被占用，本次发布被跳过"
  exit 0
}

# 释放锁：仅当锁文件第一行 === 当前进程 PID 时才删除（避免子进程误删父进程的锁）。
lock_release() {
  [ "${PUBLISH_LOCK_HELD:-}" = "1" ] || return 0
  local lf; lf="$(_publish_lock_path)"
  if [ -f "$lf" ] && [ "$(head -n1 "$lf" 2>/dev/null | tr -d '[:space:]')" = "$$" ]; then
    rm -f "$lf"
  fi
  unset PUBLISH_LOCK_HELD
}
