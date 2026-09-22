# A股推送系统 · 项目总结报告

> 生成日期：2026-09-22 ｜ 项目根目录：`D:\workbuddylujing\A股推送系统`
> 配套事实源：`AGENTS.md`（工作约束）、`config/sources.json`（数据源清单）、`config/site.json`（访问链接）
> 说明：本报告基于当前代码、配置与运行日志整理。部分早期文档（如 `README.md`）内容已落后于现状，以 `AGENTS.md` 与运行日志为准。

---

## 一、项目目标与背景

**一句话目标**：每天自动把分散的股票信息整合成「早报 / 晚报 / 选股 / 验证」四类简报，输出到手机可直接打开的网页看板（5 个 Tab），实现「有发就推、没发就停」的无人值守更新。

**背景与演进**：
- 项目创建于 2026-08-31，最初依赖「电脑常开 + 本地 git 钩子」维持更新，存在「关机即断更」的硬伤。
- 2026-09-12 从删除隔离区恢复，下线微信通知（Server酱）。
- 2026-09-14 恢复上云（GitHub Pages + 自有域名 `https://asx.79zl.cn/`）。
- 2026-09-22 完成**第二条产线（阿里云 ECS 试用实例）**的部署，早报/晚报已跑通并由服务器定时接管，彻底摆脱「本机必须常开」的约束。

**核心用户价值**：把盘前/盘后分散在韭研公社、淘股吧等多个来源的信息，经抓取 + AI 读图/摘要，统一为适合手机阅读的简报，并提供投资日历原图、历史回看、次日实盘验证。

---

## 二、整体架构与技术栈

### 2.1 架构总览（数据流）

```
┌──────────────────────────────────────────────────────────────┐
│  双环境生成（任一端运行即可，互不冲突靠 pre_sync 兜底）          │
│   ① 本机（Windows + WorkBuddy 定时任务）                        │
│   ② 阿里云 ECS（Alibaba Cloud Linux 3，试用至 2026-12-21）      │
└───────────────┬──────────────────────────────────┬───────────┘
                │ 抓取 + 生成                       │
   ┌────────────▼──────────┐              ┌─────────▼──────────┐
   │ job_morning.js         │              │ job_evening.js      │
   │ job_evening.js         │              │ screener.js         │
   │ screener.js / verify.js│              │ verify.js           │
   └────────────┬──────────┘              └─────────┬──────────┘
                │ 写入 dashboard/data.js（安全阀）   │
                └───────────────┬──────────────────┘
                                ▼
                 tools/publish.sh（版本号 + 排序 + 导出 JSON + 日历压缩/回收）
                                │
          post-commit 钩子 → tools/gh_push_api.js（GitHub API 推送）
                                │
                                ▼
              GitHub Pages + 自有域名 https://asx.79zl.cn/
                                │
                                ▼
                 手机/浏览器打开 dashboard/index.html（5 Tab 看板）
```

**调度形态**：两端均通过 `tools/cron.sh` 统一入口（flock 互斥 + 时区断言 + 任务前 `sync_from_api --apply` 全量预同步），crontab 配置为：
`07:00 health / 08:30 morning / 15:10(工作日) screener / 21:00 evening / 21:30(工作日) verify`。

### 2.2 技术栈

| 维度 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 22 + Python 3.13 | 脚本全部**零第三方 npm 依赖**（仅用 Node 内置模块）；Python 仅用于 Pillow 长图切片/压缩 |
| 前端 | 原生 HTML/CSS/JS | 无框架、无构建步骤；`dashboard/` 整目录即站点 |
| 数据格式 | `window.REPORTS = {...}`（data.js） | 看板直接 `<script>` 加载；派生 `data.json` / `version.json` 供轻量轮询 |
| AI 能力 | 智谱 BigModel API（文本 + 视觉） | 封装在 `tools/lib/llm.js`，用于晚报读图摘要、早报提炼 |
| 发布 | GitHub Trees API + GitHub Pages | `gh_push_api.js` 按 blob 差异推送；自有域名 CNAME |
| 云端 | 阿里云 ECS（2核2G，Alibaba Cloud Linux 3） | `cron.sh` + `deploy_ecs.sh` 初始化，SSH 免密运行 |
| 存储/版本 | git（本地仓库 + 远端 GitHub） | 数据可回滚；`post-commit` 自动上云 |

---

## 三、核心功能模块及职责

### 3.1 数据生成（Job 流水线）

| 脚本 | 职责 |
|---|---|
| `tools/job_morning.js` | **早报流水线**：抓取韭研公社「开盘必读」→ AI 提炼（要闻/人气股/公告/新股/今日关注）→ `merge_report --kind morning` → 发布。 |
| `tools/job_evening.js` | **晚报流水线**：抓取淘股吧湖南人（图片→AI读图）+ 行鱼复盘（文字）→ 合并板块热点与明日关注 → 接入**投资日历第三源**（`fetch_jy_calendar.js`）→ 发布。 |
| `tools/screener.js` | **量价选股**：东方财富延迟行情 + 新浪/腾讯日K，按涨幅/换手/市值/量比/连阳/分时均线筛选全市场 3500+ 只 → 最多 40 只，写入独立 `dashboard/screener.js`（`window.SCREENER`）。 |
| `tools/verify.js` | **次日验证**：给早报/晚报推荐股补实盘涨跌（`buyRet` 毛收益 / `netRet` 扣费净收益），`--rebuild` 按「早报=当日 / 晚报=次交易日」重算并回补缺口。 |
| `tools/fetch_jy_article.js` | 韭研公社「开盘必读」取数器（Nuxt SSR 内联解析）。 |
| `tools/fetch_jy_calendar.js` | 韭研公社「A股投资日历」取数器（**2026-09-22 新建**），按 id 幂等下载原图 + 组装 `calendar` 条目。 |
| `tools/fetch_tgb.js` | 淘股吧博客取数器（湖南人/行鱼），支持图片下载与文字正文提取。 |

### 3.2 发布与同步链路

| 脚本 | 职责 |
|---|---|
| `tools/publish.sh` | 发布收尾总入口：陈旧锁守卫 → `bump_version.sh` → `git commit` → 触发 `post-commit`。无 `.gh-token` 时降级为「仅本地提交 + exit 0」。 |
| `tools/bump_version.sh` | 版本号自增 + `sort_reports.js` 排序裁剪 + 日历图压缩(`optimize_calendar.py`)/回收(`clean_calendar.js`) + `sync_holidays.js` + `export_json.js`。 |
| `tools/export_json.js` | 由 `data.js` 派生 `data.json` / `version.json`（前端轮询依据）。 |
| `tools/gh_push_api.js` | GitHub Trees API 推送；`--only` 指定文件；内置 `scaleGate` 规模骤减拦截；无 token 时静默跳过。 |
| `tools/sync_from_api.js` | 从 GitHub 拉取范围内文件覆盖本地（`sync_from_api --apply`），双环境防互相推回旧文件。 |
| `tools/pre_sync.js` | 单 job 内再兜一层的预同步守卫。 |
| `tools/sync_holidays.js` | 由 `config/trade_holidays.json` 派生 `dashboard/holidays.js`。 |
| `tools/git-hooks/post-commit` | 本地提交自动上云的唯一通道（AGENTS 硬性规则 10）。 |

### 3.3 云端部署

| 脚本 | 职责 |
|---|---|
| `tools/cron.sh` | 服务器端统一入口：时区断言（非 +0800 中止）→ flock 互斥 → 任务前全量 `sync_from_api` → 分发执行 → 透传退出码。 |
| `tools/deploy_ecs.sh` | ECS 初始化（幂等）：设时区 `Asia/Shanghai`、装 Node22/Python3+Pillow/git/curl/flock、装 post-commit 钩子、自检。不碰凭据与 crontab。 |
| `tools/net_probe.sh` | 网络连通性探针（配合 `.github/workflows/net_probe.yml`）。 |

### 3.4 数据校验与健康

| 脚本 | 职责 |
|---|---|
| `tools/health_check.js` | 数据体检：**有 WARN 即 exit 1**；校验报告完整性、verify 覆盖度、缺口。 |
| `tools/health_site.js` | 站点/令牌/域名探活（`config/site.json` 的 `tokenExpiry` / `domainExpiry` 剩余 <30 天报 ERROR）。 |
| `tools/check_codes.js` | 推荐个股代码反查校验（`--fix --prune` 剔除不存在代码；**上游故障期禁用**，避免误删真股票）。 |
| `tools/merge_report.js` | 将 morning/evening/calendar 三类输入**幂等合并**进 `data.js`；`calendar` 为独立通道（`validateCalendar` + `mergeCalendar`，按 id 去重/降序/封顶 5）。 |

### 3.5 前端看板（`dashboard/`）

| 文件 | 职责 |
|---|---|
| `index.html` | 页面骨架：5 Tab（早报/晚报/短线/量价/日历）+ 紧凑 header（65px）+ 破缓存版本自检 + 恢复上次 Tab。 |
| `css/style.css` | 全部样式（移动端优先，涨红跌绿）。 |
| `js/app.js` | 渲染与交互逻辑（Tab 切换/历史回看/日历长图展示/状态行）。 |
| `data.js` / `screener.js` / `data.json` / `version.json` / `holidays.js` | 定时任务生成产物（勿手改）。 |
| `calendar/` | 投资日历原图（体积最大，靠 `clean_calendar.js` 回收）。 |

### 3.6 共享库（`tools/lib/`）

| 文件 | 职责 |
|---|---|
| `data_store.js` | **写入安全阀单一定义**：`loadDataStrict`（解析失败即中止）+ `saveDataSafe`（规模骤减拦截 + 乐观锁防并发覆盖）。所有写入型脚本共享。 |
| `ops.js` | 共享运算（`scaleBlocked` 阈值、`stampMin` 等）。 |
| `llm.js` | LLM 客户端（智谱 BigModel，文本+视觉）。 |
| `prompts.js` | 各场景 prompt 模板。 |
| `gap_check.js` | 数据缺口检测。 |
| `lock.sh` | 本地 flock 辅助。 |

### 3.7 诊断与测试

`test_health_logic.js`、`test_scripts.js`、`verify_page.js`（CDP 截图验证）、`slice_image.py`（长图切片）、`optimize_calendar.py`、`clean_calendar.js`。

---

## 四、关键实现逻辑

### 4.1 多源抓取与「有无更新」判定
- 每个 job 先取各源最新帖发布日期，与「今天」比对：**是今天**才提炼并发布；周末/节假日源不更新则**跳过（不写空数据）**。
- 晚报路径：湖南人正文是图片 → 逐张下载 → `lib/llm.js` 视觉模型读图 → 提炼结构化文字；行鱼为文字帖直接摘要。两者服务不同 Tab（板块热点→晚报 Tab，明日关注→短线 Tab），**条数必须一致**。

### 4.2 数据写入安全阀（防清空历史）
- 所有写入型脚本统一 `require('tools/lib/data_store.js')`：
  - `loadDataStrict`：`data.js` 解析失败**立即中止**，绝不静默降级成空结构（历史上裸 `eval` 曾把全部历史覆盖成空）。
  - `saveDataSafe`：① reports/calendar 数量骤减拦截；② 乐观锁（读→写期间文件被并发任务改过则中止，避免覆盖对方成果）。
- 禁止裸 `fs.writeFileSync(data.js)`，新增写入脚本必须复用此阀。

### 4.3 投资日历独立合并通道（2026-09-22 新增）
- 背景：日历源（`user_id=648089de…`，与早报「开盘必读」`df07647c` 是**不同账号**）发帖不规律（月度长文）。原 `merge_report` 在「两博客源无帖」时会触发 `H2` 强校验，无法孤立更新日历。
- 方案：`merge_report.js` 新增 `kind:'calendar'` 独立通道（`validateCalendar` 仅 id 必填、其余 WARN；`mergeCalendar` 按 id 幂等去重/降序/封顶 5）。`job_evening.js` 在「两源无帖但有新日历」时走该通道独立合并发布，否则按规则跳过。

### 4.4 双环境互斥与预同步
- **风险**：本机与 ECS 交替写 `dashboard/` 与 `tools/`；`gh_push_api.js` 按内容差异推送，落后侧一旦发布会把旧文件**静默推回远端、撤销另一侧成果**。
- **兜底**：`cron.sh` 每个写盘任务前先 `sync_from_api --apply` 全量拉取（代码+数据都不该落后）；单 job 内 `pre_sync.js` 再兜一层；`data_store` 乐观锁防并发覆盖。health 为只读任务，跳过预同步。

### 4.5 前端看板渲染与破缓存
- 看板随 `?v=版本号` 引用资源；内置脚本比对「当前页面版本」与「服务端最新 HTML 版本」，不一致则自动重载一次（同一版本每会话只刷一次），解决手机强缓存导致「更新看不见」的问题。
- 历史回看：早报/晚报保留最近 7 天，可切日期；选中日期无数据时明确说明原因（休市/历史缺口/未到点），**不写「待更新」**。

---

## 五、目录结构说明

```
A股推送系统/
├── AGENTS.md            # 项目级工作约束（权威，干活前必读）
├── README.md            # 概览文档（部分内容已落后于现状）
├── MEMORY.md            # 跨会话长期记忆（项目事实压缩）
├── config/              # 配置（单一事实源）
│   ├── site.json        #   访问链接（siteUrl/mirrorUrl/fallbackUrl/到期日）
│   ├── sources.json     #   数据源与调度清单（4 类简报 + 日历源）
│   └── trade_holidays.json
├── dashboard/           # 网站站点根目录（整体发布）
│   ├── index.html       #   页面骨架（5 Tab）
│   ├── css/style.css    #   样式
│   ├── js/app.js        #   渲染逻辑
│   ├── data.js          #   ⚠ 定时任务写入
│   ├── screener.js      #   ⚠ 量价选股结果（独立）
│   ├── data.json/version.json/holidays.js  # ⚠ 派生
│   ├── calendar/        #   投资日历原图
│   └── CNAME            #   GitHub Pages 自定义域名
├── tools/               # 生成/校验/发布/部署脚本（Node，零依赖）
│   ├── job_*.js         #   早报/晚报流水线
│   ├── fetch_*.js       #   各源取数器（article/calendar/tgb）
│   ├── screener.js / verify.js
│   ├── merge_report.js  #   三类数据幂等合并（含 calendar 通道）
│   ├── publish.sh / bump_version.sh / export_json.js
│   ├── gh_push_api.js / sync_from_api.js / pre_sync.js
│   ├── cron.sh / deploy_ecs.sh
│   ├── health_check.js / health_site.js / check_codes.js
│   ├── lib/             #   共享库（data_store/ops/llm/prompts/gap_check/lock）
│   └── git-hooks/post-commit
├── .github/workflows/   # 云端调度（health/keepalive/net_probe/publish/screener/verify）
├── logs/                # 每日运行日志（append-only，含 ALERT.md）
└── docs/                # 方案与审计文档（上云/审计报告/逻辑说明等）
```

---

## 六、已完成与待完善

### 6.1 已完成 ✅

| 模块 | 状态 |
|---|---|
| 四类简报全链路（早报/晚报/选股/验证） | ✅ 本地 + ECS 均跑通，发布实测通过 |
| 投资日历接入 `job_evening`（第三源） | ✅ 2026-09-22 新建 `fetch_jy_calendar.js` + `merge_report` calendar 通道 + 部署 GitHub（commit `6e06c8f5`） |
| ECS 第二条产线 | ✅ 早报/晚报已接管并首次发布成功（09-22）；`deploy_ecs.sh` 初始化脚本就绪 |
| 数据写入安全阀 | ✅ `data_store.js` 统一收敛，乐观锁 + 规模骤减拦截 |
| 上游故障闸门 | ✅ 东财 `push2` 本机网络重置时，选股「全市场 0 只」判为非交易日/故障，不写盘 |
| 双环境预同步 | ✅ `cron.sh` 任务前 `sync_from_api --apply` + `pre_sync` 兜底 |
| 微信通知下线 | ✅ 2026-09-12 整体下线，脚本已删除 |
| 前端看板 | ✅ 5 Tab + 历史回看 + 破缓存自检 + 紧凑 header，已多轮截图验证 |

### 6.2 待完善 / 已知风险 ⚠️（2026-09-22 17:40 更新处置状态）

| 事项 | 说明 | 状态 |
|---|---|---|
| **双端互斥自动化不足** | 任一侧发布后，另一侧必须 `sync_from_api --apply` 对齐，否则落后侧会把旧文件推回。 | 🟡 **已部分根治（09-22）**：`gh_push_api.js` 新增**陈旧推送闸**（远端 data.js/screener.js 时间戳更新 → 拦截回退式推送）；`cron.sh` 已有任务前全量预同步。剩余：本机任务与看门狗同时醒的场景靠文件锁兜底（见下条）。 |
| **云端发布可靠性** | 4 个 GitHub Actions workflow 已被 `disabled_manually`，且 `.gh-token` 缺 `Actions:write`；当前发布依赖 `post-commit → gh_push_api.js` 单路径，无冗余。 | ⚪ 待用户决策（需重新生成带 Actions:write 的 PAT 或重启用 workflows）。 |
| **ECS 试用到期** | 实例试用至 **2026-12-21**；到期前需购买或迁移，否则第二产线停摆。 | 🟡 已创建两条提醒自动化（**2026-11-21** 提前 30 天 / **2026-12-14** 提前 7 天，均 ACTIVE）；购买/迁移决策仍待用户。 |
| **验证口径语义坑** | `verify.gain` 记的是「验证日收盘涨跌幅（相对昨收）」而非实盘收益。 | ✅ **已核实无需改动（09-22）**：前端 `app.js` 已按新口径实现 —— `buyRet`/`netRet` 为主展示，`gain` 弱化并标注 `[收盘]`（app.js 454-473 行）。回测结论不变（人气榜推荐按开盘买入手均负收益）。 |
| **09-16 数据缺口** | 该日为永久缺口，health_check 长期 WARN 是噪音。 | ✅ **已处理（09-22）**：新增 `config/known_gaps.json` 白名单，`gap_check.computeGaps` 支持 `knownGaps` 通道，09-16 降为提示（health_check 现为 🟢 0 ERROR 0 WARN）；前端空态卡早已向用户说明「历史缺口或当时未运行」。 |
| **并发双写窗口** | PC 关机后开机补跑时主任务与看门狗并发读写 `data.js`。 | ✅ **已根治（09-22）**：`tools/lib/data_store.js` 新增**跨进程文件锁**（tmpdir 锁文件 + wx 原子抢占 + 陈旧锁 10 分钟接管 + 退出兜底释放 + 等锁 45s 超时明确报错），`merge_report` 在 load→save 毫秒级区间显式持锁；长网络区间写入方（verify 等）有意不加跨段锁，继续由乐观锁兜底。 |
| **网络依赖脆弱** | 韭研公社必须 `curl`/Node `fetch` 直连（WebFetch 15 分钟缓存会误判）；东财 `push2*` 域名本机持续重置，依赖 `push2delay` + 故障闸门。 | ⚪ 既有闸门已够用，属外部环境约束，暂无进一步动作。 |
| **文档滞后** | `README.md` 仍写「本地模式」等旧表述。 | ✅ **已更新（09-22）**：运行状态、架构图说明、定时任务三章改为双环境 + ECS 现状。 |

---

## 七、运维要点速查（给维护者）

1. **改完数据必跑** `bash tools/publish.sh "<说明>"`；改 `data.js`/`screener.js` 后必须跑 `export_json.js`（或 `bump_version.sh`），否则前端轮询拿不到新版本。
2. **链接禁止硬编码**，统一从 `config/site.json` 取值。
3. **`.git/hooks/post-commit` 必须存在**——本地提交上云的唯一通道。
4. **禁止 `git add -A`**——多个定时任务可能并发写 `data.js`，会被卷进提交互相覆盖；一律显式写路径。
5. **`dashboard/` 不放临时文件**（整目录发布公网）；`calendar/` 只留被引用图，靠 `clean_calendar.js` 回收。
6. **前端改动先本地截图验证**再交付（用户主用手机）；截图是自检手段，不一定放进交付物。
7. **双环境任一端发布后，另一端先 `node tools/sync_from_api.js --apply`** 再跑任务，避免推回旧文件。

---

_信息仅供参考，投资有风险。_
