# 历史沿革：A股简报系统的三代演化

> 本文档于 2026-09-14 从 5 个工作区目录的日志中提炼，用于替代已清理的旧会话目录。
> 记录"为什么是今天这个样子"，避免后人重复已经走过的弯路。

---

## 一、三代版本对照

| 代 | 代号 | 工作区 | 架构 | 结局 |
|---|---|---|---|---|
| 一代 | — | `C:\Users\zoush\WorkBuddy` | 早期版本 | 2026-09-10 随全量清理移入删除隔离区 |
| 二代 | **stock-radar** | `2026-09-11-22-13-32` | SQLite + 逐篇抓详情 + 图片下载 | ❌ 单次采集 **19分58秒**，被用户否决搁置 |
| 二代旁支 | **stock-lens** | `2026-09-11-20-31-59` | 离线批处理 + 静态文件，零第三方依赖 | ⚠️ 技术方案成立，但采集模块未落地 |
| **三代** | **A股推送系统** | `A股推送系统\` | 静态看板 + 定时任务 + 云端发布 | ✅ **当前在用** |

**关键结论：`2026-09-11-22-13-32`（stock-radar）不是"重复文件"，是 9/11 那条被否掉的慢版本路线。**
它的工作日志原件见 `旧项目源码/stock-radar/工作日志-2026-09-11.md`，末尾自述：

> 本工作区 `stock-radar` 的第一版实现（SQLite + 图片下载 + 逐篇详情抓取）单次采集 **19分58秒**，
> 用户明确反馈"太慢了"……**结论：本项目后续以 stock-lens 为主体，本工作区搁置。**

---

## 二、stock-radar 为什么慢（反面教材，值得记住）

架构上的三处开销叠加：

1. **SQLite 落库** —— 每条内容入库、建索引
2. **图片下载** —— 341 张图落到本地
3. **逐篇抓详情页** —— 列表拿到后还要对每篇再发一次请求

对比 stock-lens 的做法（同样场景 **0.9 秒**）：**不抓详情页、不下载图片、不落库**。

> **可复用结论**：情报聚合类工具，速度的决定因素是"要不要为列表里的每一项再发一次请求"。
> 只要放弃详情页与图片，耗时可以降两个数量级。

## 三、stock-lens 的技术遗产（已进入正式项目）

虽然是旁支，但它的技术判断大多被三代继承：

| 发现 | 影响 |
|---|---|
| **`file://` 下 `fetch('data.json')` 被同源策略拦，但 `<script src="data.js">` 不受限** | 决定了数据写成 `window.DATA = {…}`——这是"双击 HTML 就能看"能成立的前提 |
| `westock-tool` / `westock-data` CLI **无凭证依赖**（`env -i` 下仍可运行） | 取数脚本可脱离本机部署 |
| **第三方数据服务会抖动**（同刻 `filter` 正常而 `strategy` 报错） | → **选股结果必须落库留档**，不能假设重跑可恢复 |
| `westock quote` 的 `total_market_cap` 单位是**亿元**；`filter --preset MainInflow` 的 `MainNetFlow` 是**元** | 跨字段单位不能凭字段名猜，要看数量级结合价格/股本反推 |
| `filter --preset` 每个预设返回的**指标列不同** | 前端表格列必须动态生成，不能硬编码 |
| **雪球 robots 明文禁止将内容用于 AI 系统/RAG、禁止创建归档缓存数据集** | **不做自动采集**，改为浏览器书签手动投喂 |

### 部署路线的三次反转（都在 stock-lens 期完成）

1. **云函数并不省钱**：腾讯云 SCF 免费额度**已取消**，三个月后每月自动扣 12.8 元（¥153.6/年），
   比轻量服务器 ¥99/年还贵。→ "拿云函数替代服务器省钱"是伪命题。
2. **未备案 ≠ 一定慢**，取决于用谁的域名：
   - 自有未备案域名 → 只能走境外节点，估算 670–1400ms
   - 平台分配的 `*.edgeone.cool` → **备案义务在平台**，实测 **0.32–0.50s**
3. **备案约束的是"域名解析到境内服务器"，不是"能不能对外访问"** → 纯 `IP:端口` 不触发备案。
   但**"不买服务器 + 想用国内加速节点 + 域名未备案"这个组合走不通**——云厂商要求先买一台
   中国内地节点服务器才能拿备案服务码。

### stock-lens 期踩过的坑

- **`sudo -u <user> cmd` 默认不切换 `HOME`** → 以目标用户装 CLI 会装进调用者 HOME，必须 `sudo -H -u`
- **Ubuntu 自带 `nodejs` 版本过低**（22.04 是 12.x）→ 必须走 NodeSource 装 Node 20
- **Windows 计划任务命令行没有"错过后补跑"开关**；`StartWhenAvailable` **只存在于 XML 定义与 PowerShell 两种途径**
- 任务 XML **必须 UTF-16 编码**，`schtasks` 拒收 UTF-8
- 任务主体标识要用 `USERDOMAIN\USERNAME`（Git Bash 不导出 `COMPUTERNAME`，但 `USERDOMAIN` 有值）

---

## 四、2026-09-10 的一次重大清理（背景事实）

用户当天决定弃用整套系统，执行了最大范围删除，随后在 9/12 决定恢复。

**做了什么**：6 个定时任务删除、线上站点 unpublish、GitHub Pages 关闭、本地文件移入
`D:\WorkBuddy_删除隔离_2026-09-10`（140MB，未直接抹除）、`D:\WorkBuddy_备份_2026-09-10`（177MB，含 git bundle 102 次提交）。

**遗留待办（当时未完成）**：
1. 删除 GitHub 仓库 `zoushiyun1999/astock-dashboard`（token 缺 `delete_repo`，403）
2. 吊销 `.gh-token`
3. 删除 `asx.79zl.cn` 的 DNS 解析
4. 关闭云端自动化 `cloud:6776601`（接口只读，当前 PAUSED）

> ⚠️ 其中第 4 项在 2026-09-14 复查时**仍然是 PAUSED 未删除状态**。

### 推送源溯源（重要教训）

用户反馈"怎么还有推送 Server酱微信的"。排查发现：**删本地定时任务 ≠ 停止推送**。
云端的 GitHub Actions 独立运行：

```
GitHub Actions: health.yml（cron '0 20 * * *' = 北京 04:00）
  └─> tools/health_site.js → tools/notify.js
        └─> POST sctapi.ftqq.com/<SCT_KEY>.send → Server酱 → 微信
```

**三层触发源都要查**：① WorkBuddy automation ② GitHub Actions workflow ③ Windows 计划任务。
最终禁用仓库全部 5 个 workflow + 删除 secret `SCT_KEY`。

---

## 五、开机自动关机事件（与股票系统无关，但记录在案）

详见同目录 `开机自动关机诊断报告.md`。摘要：

**根因不是硬件故障，是 QClaw 按微信指令执行了 `shutdown /h`。**

```
你在微信发「休眠」
  → QClaw（channels.openclaw-weixin 通道）
    → AI 判定为休眠请求
      → exec: shutdown /h
```

**决定性证据**：System 日志事件 ID 187，`ApiCallerName = ...\shutdown.exe`；
QClaw 会话轨迹 `*.trajectory.jsonl` 里直接有 `toolMetas: [{"toolName":"exec","meta":"shutdown /h"}]`。

**"开机后立刻又关机"的成因**：QClaw 随开机自启，开机后积压的「休眠」消息被逐条补执行。

### ⚠️ 安全隐患

`~/.qclaw/openclaw.json` 中：

```json
"channels": { "openclaw-weixin": { "enabled": true, "allowFrom": ["*"] } }
```

**`allowFrom: ["*"]` 意味着任何人都能通过微信驱使本机执行任意命令（含关机/休眠）。**
已建议用户切断该通道。**此问题与股票系统无关，但优先级不低——请确认是否已处理。**

已排除的硬件问题：无 Kernel-Power 41 / EventLog 6008、无 WHEA 硬件错误、磁盘 SMART Healthy。

---

## 六、归档目录结构说明

```
docs/归档/
├── 历史沿革-A股简报系统三代演化.md   ← 本文件
├── 一键恢复提示词.md                  恢复流程原文
├── 开机自动关机诊断报告.md
├── 恢复期MEMORY-2026-09-12.md         恢复当天的项目记忆快照
├── 工作日志-2026-09-11-QClaw与清理现场.md
├── 工作日志-2026-09-12-恢复与修bug现场.md
├── 网页验证截图/                      6 张 + verify_report.json
└── 旧项目源码/
    ├── stock-radar/                   二代慢版（14 文件，已去 74MB 图片与 db）
    └── stock-lens/                    二代旁支（26 文件，已去 __pycache__ 与 web.zip）
```

**已丢弃的内容**（判断为无价值，未归档）：
- stock-radar 的 `data/images/`（341 张，73MB）与 `radar.db`（40 条文章记录）
- stock-radar 的 `.git` 目录
- 各目录的 `__pycache__`、`web.zip`、`edge_profile` 等生成物
- 5 个空工作区目录

---

_整理于 2026-09-14。如需追溯更早历史，见备份 `D:\WorkBuddy_备份_2026-09-10`（含 git bundle）。_
