#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# A股推送系统 · 一键部署「量价补跑」触发端点（rerun.79zl.cn）
# 幂等：重复运行安全（已存在的隧道/DNS/服务会跳过）。
# 需 root 运行： sudo bash tools/setup_rerun.sh
#
# ⚠️ 前置（只需一次，且需浏览器）：
#   先跑 `cloudflared tunnel login`（手机/电脑浏览器打开它给的 URL，
#   授权并选择 79zl.cn 域名）。登录后会生成 /root/.cloudflared/cert.pem。
#   若 79zl.cn 不在你的 Cloudflare 账户，login/route 都会失败——这是前提。
#
# 想彻底免 login？在 Cloudflare 面板创建隧道并拿到 token 后，用：
#   CF_TUNNEL_TOKEN=<粘贴token> sudo bash tools/setup_rerun.sh
# 该模式下脚本跳过 login/create/route，直接用 token 启动隧道。
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail

TUNNEL_NAME="astock-rerun"
HOST="rerun.79zl.cn"
ASTOCK_DIR="/opt/astock"
RERUN_KEY="astock-rerun-2026"
CF_DIR="/root/.cloudflared"
TOKEN="${CF_TUNNEL_TOKEN:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "!! 请使用 root 运行： sudo bash $0" >&2; exit 1
fi

step(){ echo; echo "==> $1"; }

step "[1/7] 检查 cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "    未安装，下载 linux-amd64 ..."
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o /usr/local/bin/cloudflared \
    || { echo "!! 下载失败（ECS 需能访问 github.com）"; exit 1; }
  chmod +x /usr/local/bin/cloudflared
fi
cloudflared --version | head -1

TUNNEL_ID=""
if [ -n "$TOKEN" ]; then
  step "[2/7] 使用 CF_TUNNEL_TOKEN 模式（跳过 login/create/route）"
  echo "    隧道由 Cloudflare 面板预创建，DNS 记录请在面板确认已指向本隧道。"
else
  step "[2/7] 检查 Cloudflare 登录态"
  if [ ! -f "$CF_DIR/cert.pem" ]; then
    echo "!! 未发现 $CF_DIR/cert.pem" >&2
    echo "   请先在能开浏览器的机器上跑一次： cloudflared tunnel login" >&2
    echo "   （选择 79zl.cn 域名授权），完成后再重跑本脚本。" >&2
    exit 1
  fi

  step "[3/7] 创建隧道（若不存在）"
  if cloudflared tunnel list 2>/dev/null | grep -qw "$TUNNEL_NAME"; then
    echo "    隧道 $TUNNEL_NAME 已存在，跳过"
  else
    OUT=$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1)
    echo "$OUT"
    TUNNEL_ID=$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)
  fi

  step "[4/7] 配置 DNS 记录 ($HOST)"
  if cloudflared tunnel route list "$TUNNEL_NAME" 2>/dev/null | grep -qw "$HOST"; then
    echo "    $HOST 已存在，跳过"
  else
    cloudflared tunnel route dns "$TUNNEL_NAME" "$HOST" || echo "    (route dns 可能已存在，忽略)"
  fi
fi

step "[5/7] 写隧道配置 $CF_DIR/config.yml"
if [ -z "$TUNNEL_ID" ]; then
  TUNNEL_ID=$(cloudflared tunnel inspect "$TUNNEL_NAME" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)
fi
if [ -n "$TOKEN" ]; then
  # token 模式：config 用 token，不依赖 credentials 文件
  cat > "$CF_DIR/config.yml" <<YML
tunnel: ${TUNNEL_NAME}
ingress:
  - hostname: ${HOST}
    service: http://localhost:8787
  - service: http_status:404
YML
else
  cat > "$CF_DIR/config.yml" <<YML
tunnel: ${TUNNEL_ID:-$TUNNEL_NAME}
credentials-file: $CF_DIR/${TUNNEL_ID:-$TUNNEL_NAME}.json
ingress:
  - hostname: ${HOST}
    service: http://localhost:8787
  - service: http_status:404
YML
fi
echo "    tunnel id = ${TUNNEL_ID:-<token模式>}"

step "[6/7] 安装 systemd 单元并启动"
cp "$ASTOCK_DIR/tools/rerun-server.service" /etc/systemd/system/ 2>/dev/null \
  || { echo "!! 找不到 $ASTOCK_DIR/tools/rerun-server.service，请先同步代码： node tools/sync_from_api.js --apply"; exit 1; }
cp "$ASTOCK_DIR/tools/cloudflared-astock-rerun.service" /etc/systemd/system/ 2>/dev/null
systemctl daemon-reload
systemctl enable --now rerun-server.service
# token 模式下用 --token 启动（覆盖默认 unit 的 run 行为）
if [ -n "$TOKEN" ]; then
  systemctl stop cloudflared-astock-rerun.service 2>/dev/null
  cloudflared tunnel run --token "$TOKEN" --config "$CF_DIR/config.yml" >/var/log/cloudflared.log 2>&1 &
  echo "    token 模式已后台启动 cloudflared（日志 /var/log/cloudflared.log）"
else
  systemctl enable --now cloudflared-astock-rerun.service
fi
sleep 4

step "[7/7] 验活"
if curl -fsS --max-time 15 "https://${HOST}/health"; then
  echo ""; echo "✅ 完成！网页「自动补跑」按钮现在可用。"
else
  echo "⚠️ health 未通过。排查："
  echo "   journalctl -u rerun-server -n 50"
  echo "   journalctl -u cloudflared-astock-rerun -n 50  (或 tail -n 50 /var/log/cloudflared.log)"
  echo "   curl -v https://${HOST}/health"
  exit 2
fi
