#!/usr/bin/env bash
# stock-lens 服务器端一次性初始化
# 在阿里云服务器上以 root 运行：  bash setup-server.sh
#
# 前置：payload 已由本地 push.sh 上传到 /tmp/sl-payload/
#   /tmp/sl-payload/app/            <- 本地 local/ 的内容
#   /tmp/sl-payload/westock-tool/   <- Node 版选股 CLI（跨平台单文件包）
#   /tmp/sl-payload/westock-data/   <- 含 Linux 版安装脚本
#   /tmp/sl-payload/nginx-stock-lens.conf

set -euo pipefail

APP_DIR=/opt/stock-lens
VENDOR="$APP_DIR/vendor"
SVC_USER=stocklens
PORT=8080
PAYLOAD=/tmp/sl-payload
CRON_FILE=/etc/cron.d/stock-lens
HTPASSWD=/etc/nginx/.htpasswd-stocklens

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash setup-server.sh）"
[[ -d "$PAYLOAD" ]] || die "找不到 $PAYLOAD，请先在本地运行 push.sh"

# ---------------------------------------------------------------- 1. 基础环境
log "1/8 安装基础软件"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx python3 curl ca-certificates apache2-utils >/dev/null

# 时区必须是北京时间，否则 cron 的 18:10 会跑在 UTC
log "2/8 设置时区为 Asia/Shanghai"
timedatectl set-timezone Asia/Shanghai 2>/dev/null || ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
echo "    当前时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"

# ---------------------------------------------------------------- 2. Node
log "3/8 安装 Node.js 20"
if command -v node >/dev/null 2>&1 && [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 18 ]]; then
  echo "    已安装：$(node -v)"
else
  # Ubuntu 自带的 nodejs 通常是 12.x，太老，必须用 NodeSource
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  echo "    已安装：$(node -v)"
fi

# ---------------------------------------------------------------- 3. 服务账号
log "4/8 创建服务账号与目录"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd -r -m -d "/home/$SVC_USER" -s /usr/sbin/nologin "$SVC_USER"
  echo "    已创建用户 $SVC_USER"
else
  echo "    用户 $SVC_USER 已存在"
fi

mkdir -p "$APP_DIR"
cp -a "$PAYLOAD/app/." "$APP_DIR/"

mkdir -p "$VENDOR"
rm -rf "$VENDOR/westock-tool" "$VENDOR/westock-data"
cp -a "$PAYLOAD/westock-tool" "$VENDOR/westock-tool"
cp -a "$PAYLOAD/westock-data" "$VENDOR/westock-data"

# ---------------------------------------------------------------- 4. Linux 版 CLI
log "5/8 安装 westock CLI（Linux 版）"
# 本机那份是 Windows exe，服务器上用不了；用官方 setup.sh 拉 Linux 二进制
if [[ -x "/home/$SVC_USER/.local/bin/westock" ]]; then
  echo "    已安装：$(sudo -H -u "$SVC_USER" /home/$SVC_USER/.local/bin/westock --version 2>&1 | head -1)"
else
  chown -R "$SVC_USER":"$SVC_USER" "/home/$SVC_USER"
  sudo -H -u "$SVC_USER" bash "$VENDOR/westock-data/scripts/setup.sh" -d "/home/$SVC_USER/.local/bin" \
    || warn "westock 安装脚本返回非零，稍后靠实测步骤判断是否可用"
  [[ -x "/home/$SVC_USER/.local/bin/westock" ]] \
    && echo "    安装成功" \
    || warn "未找到二进制，数据取数会降级为留档"
fi

# ---------------------------------------------------------------- 5. 配置指向
log "6/8 写入服务器端配置"
python3 - "$APP_DIR" <<'PY'
import json, sys
app = sys.argv[1]
p = f"{app}/config.json"
c = json.load(open(p, encoding="utf-8"))
c.setdefault("paths", {})
c["paths"]["node"] = ""
c["paths"]["westock_tool_index"] = f"{app}/vendor/westock-tool/scripts/index.js"
c["paths"]["westock_go"] = ""
json.dump(c, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("    config.json 已指向服务器路径")
PY

mkdir -p "$APP_DIR/web"
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"

# ---------------------------------------------------------------- 6. nginx
log "7/8 配置 nginx + 访问口令"
cp "$PAYLOAD/nginx-stock-lens.conf" /etc/nginx/sites-available/stock-lens
ln -sf /etc/nginx/sites-available/stock-lens /etc/nginx/sites-enabled/stock-lens
rm -f /etc/nginx/sites-enabled/default

PASS=""
if [[ -f "$HTPASSWD" ]]; then
  echo "    口令文件已存在，保留原密码"
else
  PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 14)"
  htpasswd -cb "$HTPASSWD" lens "$PASS" >/dev/null
  chmod 640 "$HTPASSWD"; chown root:www-data "$HTPASSWD"
fi

nginx -t >/dev/null 2>&1 || die "nginx 配置校验失败，请运行 nginx -t 查看"
systemctl enable --now nginx >/dev/null 2>&1
systemctl reload nginx

# ---------------------------------------------------------------- 7. 定时任务
log "8/8 注册定时任务（每天 18:10 北京时间）"
cat > "$CRON_FILE" <<CRON
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SHELL=/bin/bash
10 18 * * * $SVC_USER cd $APP_DIR && /usr/bin/python3 update.py >> $APP_DIR/cron.log 2>&1
CRON
chmod 644 "$CRON_FILE"
echo "    已写入 $CRON_FILE"

# ---------------------------------------------------------------- 8. 实测
log "实测：在服务器上真跑一次取数"
sudo -H -u "$SVC_USER" bash -c "cd $APP_DIR && /usr/bin/python3 update.py" || warn "取数失败，详见下方日志"

# ---------------------------------------------------------------- 汇总
IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

cat <<SUMMARY

────────────────────────────────────────────────────────────
 部署完成

 访问地址   http://$IP:$PORT
 用户名     lens
 密码       ${PASS:-（沿用之前设置的密码）}

 注意：还需在【阿里云控制台 → 轻量应用服务器 → 防火墙】
       放行 TCP $PORT 端口，否则上面这个地址打不开。

 查看取数日志   tail -f $APP_DIR/update.log
 查看 cron 日志 tail -f $APP_DIR/cron.log
 手动跑一次     sudo -H -u $SVC_USER bash -c 'cd $APP_DIR && python3 update.py'
 改看什么内容   编辑 $APP_DIR/config.json 后重跑
────────────────────────────────────────────────────────────
SUMMARY
