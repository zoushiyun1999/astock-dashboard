# MEMORY.md

> 项目长期记忆。工作中学到新东西主动回写，不等提醒。
> 凭据只记位置不记值；代码里能查到的东西不往这里复制。
> 逐日运行细节见 `.workbuddy/memory/YYYY-MM-DD.md`。

## 项目快照

- **项目名**：A股推送系统
- **当前阶段**：**云端发布链路已全量切换完成**（静态托管 + 自有域名 `https://asx.79zl.cn/`）。5 个定时任务 prompt 均已剥离沙箱部署，改走 `tools/publish.sh` + `tools/notify_digest.js`。
- **最后更新**：2026-09-10

## 架构决策记录（ADR）

| 日期 | 决策 | 原因 | 放弃的方案 |
| --- | --- | --- | --- |
| 2026-09-10 | 看板改为「静态托管 + 固定自有域名」，URL 与部署次数解耦 | e2b 动态沙箱每次部署换 URL、空闲自动停机（错误码 12809），用户无法稳定访问 | 继续用 `workbuddy_sites_deploy` 动态沙箱（链接漂移是设计使然，无法修复） |
| 2026-09-10 | 访问链接单一事实源化：只存 `config/site.json` + GitHub variable `SITE_URL` | prompt/README/推送模板三处硬编码，域名一变全是死链（已积累两代死链） | 各处硬编码 URL |
| 2026-09-10 | 生成层保留 LLM 依赖，调度/发布层先上云（分阶段迁移） | 早报/晚报的读图与摘要强依赖 LLM，一次性重写风险高 | 一次性全量迁云 |
| 2026-09-10 | 定时任务统一改为「`bash tools/publish.sh "<说明>"` → `node tools/notify_digest.js <type> <标题>`」两步，prompt 内不出现任何 URL | 链接来源收敛到 `config/site.json` 一处；避免 prompt 硬编码导致域名变更后死链 | 在 prompt 里调 `workbuddy_sites_deploy` 再手动 curl Server酱 |
| 2026-09-10 | 用 git `post-commit` 钩子自动推 GitHub | 让存量 automation 的 `git commit` 步骤零改动即可自动发布，不必逐条改 prompt | 逐条改 prompt 里的提交步骤 |

## 环境事实

- 本机 Windows，Node 22.22.2 / 24.14.0，Python 3.13.12（均在 `~/.workbuddy/binaries/` 隔离目录）。
- **本机命令行无法访问 `github.com`**（代理 502 / 直连超时），但**可以访问 `api.github.com`**（走 WorkBuddy 代理）。因此所有推送走 `tools/gh_push_api.js`（Git Trees API），不走 git 协议。`gitee.com` 可达，`github.io` 可达。
- 仓库已有 remote：`zoushiyun1999/astock-dashboard`（**必须 Public**，免费账号私有仓库不能用 Pages）。
- `dashboard/` 纯静态，`data.js` 为 `window.REPORTS = {...}` 全局变量，顶层字段：`updatedAt / calendar / reports / screener`。
- 数据源：韭研公社（开盘必读、A股投资日历）、淘股吧（湖南人、行鱼复盘）。
- Server酱 key **曾明文写在 automation prompt 里**（错误做法），现已从全部 prompt 移除，改由 `tools/notify.js` 读取；GitHub 侧存于 Secrets `SCT_KEY`。**仍建议轮换**（历史明文已进入对话记录）。

## 云端发布链路（2026-09-10 落地，改动前必读）

```
数据写入 dashboard/data.js（automation 用 Write）
        ↓
bash tools/publish.sh "说明"
  ├─ bump_version.sh  → 刷新 index.html 版本号 + sort_reports + sync_holidays + export_json
  │                     （产出 dashboard/data.json + dashboard/version.json）
  ├─ git commit
  ├─ .git/hooks/post-commit → tools/gh_push_api.js 自动推送（无需人工 push）
  └─ GitHub Actions publish.yml → 发布到 https://asx.79zl.cn/
        ↓
node tools/notify_digest.js <morning|evening|screener> "标题"
  └─ 从 data.js 自动汇总摘要 + 从 config/site.json 取链接 → tools/notify.js 发微信
```

- **入口 URL 只存在于 `config/site.json`**：`siteUrl`（主）、`fallbackUrl`（备用）、`domainExpiry`。
- `tools/notify.js` 内置硬拦截：正文/标题出现 `e2b.*`、`sandbox.cloudstudio.club`、`3000-<hex>` 直接 fail。
- `tools/health_site.js`：三入口探活 + 数据新鲜度（>26h 且交易日告警）+ 域名到期提醒 + 全仓硬编码链接扫描。本地与 `.github/workflows/health.yml` 各跑一次。
- `tools/publish_and_notify.sh` 是上面两步的封装（含等云端生效轮询），嫌两步麻烦可用它一个命令。
- `tools/gh_push_api.js` 的三重防护：`SKIP_DIR` / `DENY_FILE`（`.gh-token`、`.env`、`*.key`）+ `DENY_CONTENT`（内容里扫 token 特征）+ 删除保护（文件数骤减时拒绝删远端）。
- `dashboard/CNAME` = `asx.79zl.cn`（GitHub Pages 自定义域名，必须与 `config/site.json` 的 host 一致）。

## 云端 runner 实测事实（2026-09-10 探测，云化前必读）

用临时 `.github/workflows/_probe*.yml` 在真实 GitHub runner（ubuntu-24.04，Azure 美西，出口 IP 128.24.161.85）跑通，结论：

- **国内数据源从海外 runner 全部可达**：韭研公社 200/1.3s、淘股吧 200/1.8s、腾讯行情 200、Server酱 200。
- **⚠️ 东财 `push2his` 与 新浪 `hq.sinajs.cn` 必须带 Referer**，否则失败（本地测不出来）：
  - 东财缺 Referer → `curl: (52) Empty reply`；带 `Referer: https://quote.eastmoney.com/` → 200
  - 新浪缺 Referer → 403；带 `Referer: https://finance.sina.com.cn/` → 200
  - 同时要带浏览器 UA。这是**地域 + 防盗链**双重判定。
- **图片下载链路可用**：淘股吧当天抓到 18 张图，下载得 JPEG 760×277 / 34KB；投资日历 CDN 长图 JPEG 2240×1008 / 965KB。
- **五个大模型 API 全部连通**（返回 401/404，仅缺 Key）：阿里百炼 dashscope、智谱 bigmodel、DeepSeek、火山方舟、Kimi。
- **页面内容同源同质**：韭研公社 HTML 125KB / 15 条 `/a/` 链接，最新帖 ID 与本地抓取一致 → 解析逻辑可原样复用。
- 平台限制（官方文档）：cron 最小 5 分钟；高负载时**延迟 15–30 分钟**（整点最堵）；Public 仓库 60 天无活动自动禁用 schedule（已有 keepalive.yml 兜底）；schedule 无失败通知（已有 health.yml 兜底）。

**成本结论**：Public 仓库 Actions 分钟数无限免费，唯一变动成本是大模型调用，**¥6–10/月**（均衡档：Qwen3-VL-8B + DeepSeek V4 Flash）。

**方案文档**：`docs/定时任务云端化方案.md`（含三路线对比、成本明细、分阶段落地步骤）。

## 踩坑与结论

- **动态沙箱 ≠ 生产托管**：平台机制是每次部署分配新沙箱、停旧沙箱，空闲会停机。要稳定链接必须换静态托管。
- **WebFetch 有 15 分钟缓存**：判断"最新帖是否为今天"时若命中昨日缓存会误判未发布，应复抓一次再下结论。
- **PC 休眠/关机导致整天数据缺失**：本地 automation 无法执行（9/8 全天缺失），看门狗只补当天、历史缺口需人工补。
- **同一文件多处 Edit 必须串行**：并行 Edit 有竞态，先发的会被覆盖且工具仍返回成功。
- **个股代码必须双校验**：code 不能凭模型记忆填，用 `tools/check_codes.js` 反查。
- **GitHub Actions 的 `run:` 里不要用多行 shell 字符串**：`.github/workflows/screener.yml` 曾因跨行 `desp="..."` 导致 YAML 解析失败，**该文件 6 天里从未成功运行过**。改用 `printf` 或单行。改完 workflow 一定用 `yaml.safe_load` 校验。
- **Windows node.exe 不认 Git Bash 的 `/c/...` 路径**：脚本调 node 前先 `pwd -W` 转成 `C:/...`，否则 `MODULE_NOT_FOUND`。
- **`data.js` 的 reports 顺序是「最旧在前、最新在后」**，truncate 必须按 date 排序后 slice，先 push 再 `slice(0,7)` 会丢最新一条。
- **`git add -A` 会把 `.gh-token` 带进提交**：已在 `.gitignore` 加规则，但 API 推送不受 `.gitignore` 约束，必须靠 `gh_push_api.js` 的 `DENY_FILE` 兜底（曾真的差点推上公网，被 GitHub 以 422 Secret detected 拦下）。

## 用户偏好与纠正

- 极简、干净的 UI；拒绝 emoji/色块 Tab，偏好文字下划线 Tab；多次要求"简洁一点"。
- 决策前要带权衡的 A/B/C **排序**方案；批准后才批量执行；做完后习惯追问"还有其他建议吗"。
- 晚报正文中**不出现**投资日历内容，投资日历只在独立 Tab 展示。

## 外部资源位置

| 资源 | 位置 | 备注 |
| --- | --- | --- |
| 数据源清单 | `config/sources.json` | 4 个源，含发布规律 |
| 站点 URL 单一事实源 | `config/site.json` | `siteUrl` = https://asx.79zl.cn/ ；`fallbackUrl` = https://zoushiyun1999.github.io/astock-dashboard/ |
| GitHub 仓库 | `zoushiyun1999/astock-dashboard`（Public） | 推送用 PAT，存项目根 `.gh-token`（已 gitignore，勿删勿外传） |
| Server酱 key | 项目根 `.sct-key`（本地）/ GitHub Secrets `SCT_KEY` | 不应入仓库；**建议轮换**（曾明文出现在 prompt 与对话中） |
| 自建定时任务的 prompt 全文 | `automation_update` 的 view 模式 | 5 个任务 ID 见下 |

### 5 个定时任务（2026-09-10 全部切换到新发布链路）

| ID | 名称 | 时间 |
| --- | --- | --- |
| `automation-1788184424861` | A股早报-开盘必读资讯 | 每日 08:30 |
| `automation-1788187841979` | A股量价选股（技术面筛选） | 工作日 14:30 |
| `automation-1788184401617` | A股晚报-AI读图复盘+投资日历专版 | 每日 21:00 |
| `automation-1788328556486` | A股次日验证 | 工作日 21:30 |
| `86ab063f-b627-4af8-a829-9b5e4aa5a40f` | A股早报补跑看门狗 | 每日 10:00 |
| `d97007fc-912c-46dc-b4cf-d2613da7052e` | A股晚报补跑看门狗 | 每日 22:30（**PAUSED**） |

## 待办 / 悬置问题

- [ ] **轮换 Server酱 key**（历史明文已泄露）
- [ ] **撤销/重建 GitHub PAT**（曾明文发在对话里）
- [ ] 在 `config/site.json` 填 `domainExpiry`（79zl.cn 到期日）以启用到期提醒
- [ ] `verify.gain` 口径改造：增加 `buyRet` / `openPct` / `locked` 字段，前端改显示实盘口径（当前显示的是市场涨跌幅，会让用户误以为跟着买能赚）
- [ ] 行情范围补创业板/科创板/北交所（当前只有沪深主板，11 只创业/科创永远验不到）
- [ ] 早报/晚报生成逻辑云化（LLM adapter），彻底摆脱"PC 不在线就断更"
- [ ] 晚报补跑看门狗是否启用（当前 PAUSED，需用户决策）
- [ ] 新浪日K源稳定性观察：连续多日大面积失败则把腾讯源提为主源
