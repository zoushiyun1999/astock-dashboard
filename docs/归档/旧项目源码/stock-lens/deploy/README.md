# 部署到阿里云（外出可访问）

目标：手机在任意网络下打开 `http://<服务器IP>:8080` 看同一个页面。

## 为什么不备案也能用

备案约束的是**域名解析到境内服务器**。直接用 `IP:端口` 访问不涉及域名解析，不需要备案。
代价是没有 HTTPS（浏览器会提示"不安全"），对一个只读的个人页面无所谓。

**想更省心的话**：在服务器和手机上都装 Tailscale，走内网地址访问，可以完全不对外开放端口。
但多一层依赖，个人自用建议先用 IP:端口。

## 前提

- 服务器系统：**Ubuntu 22.04 / 24.04** 或 Debian 系（脚本用 apt）
- 能从本机 SSH 登入服务器（默认 22 端口，可用 `SSH_PORT=2222 ./push.sh ...` 改）
- **服务器能用 root 或 sudo**（脚本要装包、改 nginx、写 cron）

## 三步

```bash
cd deploy

# 0. 先干跑，确认打包正常（不连服务器）
bash push.sh --stage-only

# 1. 推送 + 自动部署（会装 nginx、Node 20、Linux 版 CLI，建 cron）
bash push.sh root@<你的服务器公网IP>

# 2. 去阿里云控制台放行端口
#    轻量应用服务器 → 防火墙 → 添加规则 → TCP 8080

# 3. 手机浏览器打开脚本结尾打印的地址，用打印出的账号密码登录
```

> Windows Git Bash 下若 `./push.sh` 报权限错误，改用 `bash push.sh`。

`./push.sh` 结尾会直接打印访问地址、用户名和随机生成的密码 —— **把那行密码记下来**。

## 服务器上的布局

```
/opt/stock-lens/
├── update.py            取数脚本
├── config.json          改这里调整看什么内容
├── web/                 对外提供的静态文件
│   ├── index.html
│   └── data.js          每天 18:10 重新生成
└── vendor/
    ├── westock-tool/    选股 CLI（Node，跨平台）
    └── westock-data/    Linux 版 westock 的安装脚本
/etc/cron.d/stock-lens   每天 18:10 北京时间执行
/etc/nginx/.htpasswd-stocklens   访问口令
```

## 常用运维

```bash
# 看取数有没有成功
tail -f /opt/stock-lens/update.log
tail -f /opt/stock-lens/cron.log

# 立刻手动跑一次
sudo -u stocklens bash -c 'cd /opt/stock-lens && python3 update.py'

# 改看什么内容
vim /opt/stock-lens/config.json     # 改完等 cron 或手动跑一次

# 改密码
sudo htpasswd /etc/nginx/.htpasswd-stocklens lens

# 改端口
sudo vim /etc/nginx/sites-available/stock-lens   # 改 listen，然后 reload
sudo systemctl reload nginx
```

## 更新代码后重新部署

直接再跑一次 `./push.sh root@<IP>` 即可，脚本是幂等的：已有的账号、口令、cron 会保留。

## 已知风险（必须先实测）

**数据源在服务器 IP 上不一定可用。** 本机实测 CLI 无凭证依赖、可直接运行，但服务器是另一个出口 IP，
对方服务是否对云厂商 IP 有风控，**只有真正跑过才知道**。

`setup-server.sh` 最后一步就是实测取数，会打印 `4/4 个板块取数成功` 或 `1/4`。
如果只有 `1/4`，说明服务器上取不到数，此时可以用方案 B：
**本机取数 → 只同步 `web/` 目录到服务器**（页面照样随处可看，代价是本机要开机）。

## 2核2G 够用吗

够。nginx 常驻约 10–20MB，Node 只在 cron 跑那几秒存在。
常态内存占用不到 200MB。这正是"无后台"的好处 —— 服务器上没有任何长期运行的应用进程。
