#!/usr/bin/env bash
# tools/deploy_ecs.sh —— ECS 环境初始化（幂等，可重复执行）
#
# 在**服务器上**执行。前置：仓库已经在服务器上（git clone，或本机打包上传后解压）。
#
#   cd /opt/astock && sudo bash tools/deploy_ecs.sh
#
# 它做四件事：
#   ① 时区设为 Asia/Shanghai —— 定时任务的前提。时区错了不会报错，
#      只会把数据写到错误的日期，症状隐蔽、排查成本高。
#   ② 安装运行时：Node 22、Python 3 + Pillow（长图切片必需）、git、curl、flock。
#   ③ 安装 git post-commit 钩子 —— 本地提交自动上云的唯一通道（AGENTS 规则 10）。
#   ④ 自检并打印还缺什么。
#
# **不做**的三件事（涉及凭据与调度，必须手工确认）：
#   · 不写 LLM_API_KEY（见 docs/上云部署方案.md 的环境变量清单）
#   · 不写 .gh-token（GitHub PAT）
#   · 不改 crontab（脚本末尾会把该贴的内容打印出来）
#
# 退出码：0 全部就绪；1 有步骤失败（会打印具体哪一步）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

FAIL=0
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; FAIL=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

# ── 权限 ──
if [ "$(id -u)" -ne 0 ]; then
  bad "需要 root。请用：sudo bash tools/deploy_ecs.sh"
  exit 1
fi

# ── 包管理器探测 ──
if command -v dnf >/dev/null 2>&1; then
  PKG=dnf
elif command -v yum >/dev/null 2>&1; then
  PKG=yum
elif command -v apt-get >/dev/null 2>&1; then
  PKG=apt
else
  bad "未识别的包管理器（既无 dnf/yum 也无 apt-get）"
  exit 1
fi
ok "包管理器：$PKG"

pkg_install() {
  case "$PKG" in
    dnf) dnf install -y "$@" ;;
    yum) yum install -y "$@" ;;
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
  esac
}

# ── ① 时区 ──
say "① 时区"
if command -v timedatectl >/dev/null 2>&1; then
  CURRENT_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || echo '')"
  if [ "$CURRENT_TZ" = "Asia/Shanghai" ]; then
    ok "已为 Asia/Shanghai"
  else
    timedatectl set-timezone Asia/Shanghai && ok "已设为 Asia/Shanghai（原：${CURRENT_TZ:-未知}）"
  fi
else
  ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo "Asia/Shanghai" > /etc/timezone \
    && ok "已通过 /etc/localtime 设为 Asia/Shanghai"
fi

OFFSET="$(date '+%z')"
if [ "$OFFSET" = "+0800" ]; then
  ok "当前偏移 $OFFSET"
else
  bad "时区偏移仍为 $OFFSET（应为 +0800）→ 定时任务会写错日期，务必先解决"
fi

# ── ② 运行时 ──
say "② 基础依赖"
for c in git curl; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c 已存在"; else
    pkg_install "$c" && ok "$c 安装完成" || bad "$c 安装失败"
  fi
done

if command -v flock >/dev/null 2>&1; then
  ok "flock 已存在（tools/cron.sh 的并发互斥依赖它）"
else
  case "$PKG" in
    apt) pkg_install util-linux ;;
    *)   pkg_install util-linux ;;
  esac
  command -v flock >/dev/null 2>&1 && ok "flock 安装完成" || bad "flock 安装失败"
fi

say "③ Node 22"

# 判断「现有 node 是否 ≥22」。包管理器装完 node 后 bash 可能还缓存着「找不到」，
# 所以每次先 hash -r 清缓存，否则会把刚装好的 node 误判为未安装。
node_ok22() {
  hash -r 2>/dev/null
  command -v node >/dev/null 2>&1 || return 1
  local m
  m="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
  [ "${m:-0}" -ge 22 ] 2>/dev/null
}

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
fi
if [ "${NODE_MAJOR:-0}" -ge 22 ] 2>/dev/null; then
  ok "已装 node $(node -v)"
else
  if [ "$NODE_MAJOR" != "0" ]; then
    warn "现有 node 版本为 v$NODE_MAJOR，低于 22（本项目的 job_*.js 依赖全局 fetch）→ 尝试升级"
  fi

  # ⚠️ 国内机房**不要**直接走 rpm.nodesource.com —— 实测在阿里云内地 ECS 上经常只有
  #    几十 KB/s 甚至直接超时，卡住整条部署且报错信息指向不了真因。按「就近」顺序回退：
  #      ① dnf 自带 nodejs:22 模块（走阿里云内网镜像，最快且受包管理器统一管理）
  #      ② 阿里云 nodejs-release 镜像的官方 tarball
  #      ③ 最后才用 nodesource 脚本（保底）

  # ① 发行版模块
  if dnf -q module list nodejs 2>/dev/null | grep -qE '^[[:space:]]*nodejs[[:space:]]+22'; then
    echo "  · 尝试 dnf 模块 nodejs:22（阿里云镜像）"
    dnf -y module install nodejs:22 >/dev/null 2>&1 || true
  fi

  # ② 官方 tarball：按镜像逐个试（下列地址均已实测可下载）
  #    ⚠️ 必须用**显式版本路径** `v<版本>/`：
  #       · 阿里云镜像上 `latest-v22.x/` 返回 **404**（2026-09-21 实测），
  #         曾据此写出「从索引解析最新版」的逻辑，结果 URL 拼成 latest-v22.x/<文件> 直接 404。
  #       · 清华 tuna 的目录结构不同（同样 404），不要加进来。
  if ! node_ok22; then
    NODE_VER="22.22.2"
    NODE_FILE="node-v$NODE_VER-linux-x64.tar.xz"
    NODE_DIR="${NODE_FILE%.tar.xz}"
    for M in \
      "https://cdn.npmmirror.com/binaries/node" \
      "https://mirrors.aliyun.com/nodejs-release" \
      "https://mirrors.huaweicloud.com/nodejs" \
      "https://nodejs.org/dist" ; do
      node_ok22 && break
      echo "  · 尝试 $M/v$NODE_VER/$NODE_FILE"
      curl -fsS -m 300 -L "$M/v$NODE_VER/$NODE_FILE" -o "/tmp/$NODE_FILE" || { warn "该镜像不可用 → 换下一个"; continue; }
      SZ="$(stat -c %s "/tmp/$NODE_FILE" 2>/dev/null || echo 0)"
      if [ "${SZ:-0}" -lt 1000000 ]; then
        warn "下载不完整（${SZ} 字节）→ 换下一个镜像"
        rm -f "/tmp/$NODE_FILE"
        continue
      fi
      if mkdir -p /usr/local/lib && tar -xJf "/tmp/$NODE_FILE" -C /usr/local/lib; then
        for b in node npm npx; do
          [ -x "/usr/local/lib/$NODE_DIR/bin/$b" ] && \
            ln -sf "/usr/local/lib/$NODE_DIR/bin/$b" "/usr/local/bin/$b"
        done
      fi
      rm -f "/tmp/$NODE_FILE"
    done
  fi

  # ③ 保底：nodesource（国内可能很慢）
  if ! node_ok22; then
    echo "  · 回退到 nodesource 脚本（国内可能很慢，请耐心等待）"
    case "$PKG" in
      apt) curl -fsSL https://deb.nodesource.com/setup_22.x | bash - ;;
      *)   curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - ;;
    esac
    pkg_install nodejs
  fi

  if node_ok22; then
    ok "node $(node -v)（路径 $(command -v node)）"
  else
    bad "node 22 安装失败（三条路径都不通）→ 手工安装见 docs/上云部署方案.md"
  fi
fi

say "④ Python + Pillow（长图切片用）"
PY=""
for c in python3 python; do
  command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }
done
if [ -z "$PY" ]; then
  case "$PKG" in
    apt) pkg_install python3 python3-pip ;;
    *)   pkg_install python3 python3-pip ;;
  esac
  command -v python3 >/dev/null 2>&1 && PY=python3
fi
if [ -n "$PY" ]; then
  ok "$PY $("$PY" --version 2>&1)"

  # 有的发行版自带 python3 但没带 pip（阿里云 Linux 3 常见）→ 缺了下面必然失败
  if ! "$PY" -m pip --version >/dev/null 2>&1; then
    warn "缺少 pip → 安装 python3-pip"
    pkg_install python3-pip || true
  fi

  if "$PY" -c "import PIL" >/dev/null 2>&1; then
    ok "Pillow 已安装（$("$PY" -c 'import PIL;print(PIL.__version__)' 2>/dev/null)）"
  else
    # ⚠️ 优先用发行版 RPM，**不要**先试 pip ——
    #    Alibaba Cloud Linux 3 的系统 python3 是 **3.6**（2021 年 EOL），
    #    Pillow 早已没有 cp36 预编译包，pip 会退化成「从源码编译」，
    #    然后必然失败：缺 zlib 头文件，而且该 python 连 `_ctypes` 都没有
    #    （2026-09-21 在真实 ECS 上实测，报 RequiredDependencyException: zlib）。
    #    RPM（python3-pillow）是编译好的成品，一条命令几秒钟完成。
    PY_VER="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)"
    case "$PKG" in
      apt) PIL_PKG="python3-pil" ;;
      *)   PIL_PKG="python3-pillow" ;;
    esac
    if [ "${PY_VER:-}" = "3.6" ]; then
      warn "系统 python 是 3.6（已 EOL）→ 走 RPM 装 Pillow，避免源码编译"
    fi

    if pkg_install "$PIL_PKG" >/dev/null 2>&1 && "$PY" -c "import PIL" >/dev/null 2>&1; then
      ok "Pillow 安装完成（RPM $PIL_PKG：$("$PY" -c 'import PIL;print(PIL.__version__)' 2>/dev/null)）"
    elif "$PY" -m pip install --quiet Pillow 2>/dev/null && "$PY" -c "import PIL" >/dev/null 2>&1; then
      ok "Pillow 安装完成（pip 默认源）"
    elif "$PY" -m pip install --quiet \
           -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com \
           Pillow 2>/dev/null && "$PY" -c "import PIL" >/dev/null 2>&1; then
      ok "Pillow 安装完成（走阿里云 PyPI 镜像）"
    else
      bad "Pillow 安装失败 → 长图切片不可用（晚报读图会长图糊掉）"
      warn "补救：装新版 Python 后指定解释器 ——"
      warn "  dnf install -y python3.11 python3.11-pip"
      warn "  python3.11 -m pip install -i https://mirrors.aliyun.com/pypi/simple/ Pillow"
      warn "  然后在本文件环境变量里加 PYTHON_BIN=python3.11"
    fi
  fi

  # 若解释器名不是 python3，告知调用方如何指定
  if [ "$PY" != "python3" ]; then
    warn "Python 命令名是 $PY；请在 ~/.astock.env 里加：PYTHON_BIN=$PY"
  fi
else
  bad "未找到 python3"
fi

# ── ⑤ git 身份 + 钩子 ──
say "⑤ git 身份与钩子"
if command -v git >/dev/null 2>&1; then
  if [ -z "$(git config --global user.email 2>/dev/null)" ]; then
    git config --global user.name "astock-bot"
    git config --global user.email "astock-bot@localhost"
    ok "已设置 git 身份 astock-bot@localhost（没有它 publish.sh 的 commit 会失败）"
  else
    ok "git 身份已配置：$(git config --global user.name) <$(git config --global user.email)>"
  fi
  # 服务器上不做换行符转换，一切交给仓库的 .gitattributes（否则脚本可能被写成 CRLF）
  git config --global core.autocrlf input
  ok "core.autocrlf=input"
else
  bad "git 不可用，跳过身份配置"
fi

if [ ! -d "$ROOT/.git" ]; then
  bad "当前目录不是 git 仓库（$ROOT/.git 不存在）→ 无法安装钩子"
else
  HOOK_SRC="$ROOT/tools/git-hooks/post-commit"
  HOOK_DST="$ROOT/.git/hooks/post-commit"
  if [ ! -f "$HOOK_SRC" ]; then
    bad "缺少钩子源文件 $HOOK_SRC"
  else
    # ⚠️ 必须检查安装结果：这是「本地提交自动上云」的唯一通道，装失败 = 数据永远停在服务器，
    #    而旧写法无论成败都打印「已安装」→ 又一处静默故障。
    #    另外 cp 带 -f：阿里云 Linux 对 root 有 `alias cp='cp -i'`，脚本虽是非交互 shell
    #    不展开 alias，但 -f 能顺带处理目标已存在/不可写的情况。
    if cp -f "$HOOK_SRC" "$HOOK_DST" && chmod +x "$HOOK_DST" && [ -x "$HOOK_DST" ]; then
      ok "已安装 post-commit 钩子（本地提交 → 自动推送 GitHub 的唯一通道）"
      # 自检：钩子里不得存在「未加兜底的 pwd -W」—— Linux 上会让 WIN_ROOT 变空串，
      # 于是去执行 /tools/gh_push_api.js（不存在）→ 推送永远失败**且不报错**（静默故障）。
      if grep -v '^[[:space:]]*#' "$HOOK_DST" | grep 'pwd -W' | grep -qv '||'; then
        bad "钩子里有未加兜底的 pwd -W → Linux 上推送会静默失败，请更新 tools/git-hooks/post-commit"
      else
        ok "钩子自检：pwd -W 均已兜底（或未使用）"
      fi
    else
      bad "post-commit 钩子安装失败 → 本地提交不会自动上云，数据只留在服务器"
    fi
  fi
fi

# ── ⑥ 自检 ──
say "⑥ 自检"
[ -f "$ROOT/dashboard/data.js" ] && ok "dashboard/data.js 存在" || bad "dashboard/data.js 缺失"
[ -f "$ROOT/config/site.json" ] && ok "config/site.json 存在" || bad "config/site.json 缺失"
[ -f "$ROOT/config/trade_holidays.json" ] && ok "config/trade_holidays.json 存在" || bad "缺失休市日配置"

if [ -f "$ROOT/.gh-token" ]; then
  ok ".gh-token 已存在（注意：需 Contents: RW + Workflows: RW 两个权限）"
else
  warn ".gh-token 缺失 → publish.sh 会降级为「仅本地提交」，数据不上云"
fi

ENV_FILE="${ASTOCK_ENV:-$HOME/.astock.env}"
if [ -f "$ENV_FILE" ]; then
  ok "环境变量文件 $ENV_FILE 存在"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  if [ -n "${LLM_API_KEY:-}" ]; then
    ok "LLM_API_KEY 已配置（长 ${#LLM_API_KEY}）"
  else
    bad "LLM_API_KEY 未配置 → job_morning / job_evening 无法运行"
  fi
  echo "     LLM_BASE_URL     = ${LLM_BASE_URL:-（默认 dashscope 兼容模式）}"
  echo "     LLM_TEXT_MODEL   = ${LLM_TEXT_MODEL:-（默认 qwen-plus）}"
  echo "     LLM_VISION_MODEL = ${LLM_VISION_MODEL:-（默认 qwen-vl-max）}"
else
  warn "环境变量文件 $ENV_FILE 不存在（job_morning / job_evening 会因缺 key 退出）"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m环境就绪。\033[0m 接下来手工做两件事：\n'
else
  printf '\033[31m有步骤失败\033[0m（见上方 ✘ 项）。修复后重新运行本脚本即可（幂等）。\n\n还需手工完成：\n'
fi
cat <<'EOF'

  1) 配置凭据（智谱 BigModel）
       umask 077
       cat > ~/.astock.env <<'ENV'
LLM_API_KEY=<智谱 key，形如 id.secret>
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_TEXT_MODEL=glm-4.7-flash
LLM_THINKING=disabled
LLM_VISION_MODEL=glm-4.6v-flashx
PYTHON_BIN=python3
ENV
       # ⚠️ heredoc 的结束标记 ENV 必须顶格，否则内容会一直读到文件末尾
       # 说明：glm-4.7-flash 是「思考模型」，不关思考则 content 恒为空 → 必须 LLM_THINKING=disabled
       #       视觉用付费档 glm-4.6v-flashx：免费档实测持续 429，晚报 10~25 次请求根本跑不完
       #       全天成本约 ¥0.01
       # 再把 GitHub PAT 写到仓库根（不要提交）
       echo 'github_pat_xxx' > .gh-token && chmod 600 .gh-token

  2) 装 crontab
       crontab -e    # 粘贴：
       0  7  * * *    cd REPO && bash tools/cron.sh health    >> logs/cron.log 2>&1
       30 8  * * *    cd REPO && bash tools/cron.sh morning   >> logs/cron.log 2>&1
       10 15 * * 1-5  cd REPO && bash tools/cron.sh screener  >> logs/cron.log 2>&1
       0  21 * * *    cd REPO && bash tools/cron.sh evening   >> logs/cron.log 2>&1
       30 21 * * 1-5  cd REPO && bash tools/cron.sh verify    >> logs/cron.log 2>&1
       （把 REPO 换成实际路径）

  3) 手工验收（不要等定时触发，先手动跑一遍）
       node tools/lib/llm.js --check      # 配置自检，缺 key 退 1
       node tools/lib/llm.js --ping       # 真实调用一次，验证鉴权
       node tools/job_morning.js --dry    # 只抓取+提炼，不写盘
       node tools/job_evening.js --dry    # 同上（晚报会真的下载并读图）

EOF
exit "$FAIL"
