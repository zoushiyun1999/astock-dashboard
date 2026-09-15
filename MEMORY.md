# MEMORY.md

> 项目长期记忆。工作中学到新东西主动回写，不等提醒。
> 凭据只记位置不记值；代码里能查到的东西不往这里复制。
> 逐日运行细节见 `.workbuddy/memory/YYYY-MM-DD.md`。

## 项目快照

- **项目名**：A股推送系统
- **当前阶段**：**2026-09-14 已恢复云端发布**。看板线上地址 `https://asx.79zl.cn/` 恢复正常，数据与本地同步。
  - 恢复路径：2026-09-12 从删除隔离区重建（`D:\workbuddylujing\A股推送系统\`；原件只读保留在 `D:\WorkBuddy_删除隔离_2026-09-10\`）
    → 2026-09-14 用户手动启用仓库 Pages + 配置新 fine-grained PAT（`.gh-token`）→ 首次带 PAT 推送成功（远端 commit `e16f5e69`）。
  - 6 个定时任务已重建并全部 ACTIVE；**微信推送通知功能已按用户要求下线**。
  - ⚠️ 恢复期间线上曾因 `has_pages` 未启用 + 无令牌而**两个地址全 404 达 4 天**（09-10~09-14），
    表现是「域名解析正常但 GitHub 回 Site not found」——**404 时先查 Pages，别去动 DNS**（DNS 一直是好的）。
- **最后更新**：2026-09-14
- **系统总览文档**：`docs/系统功能与运行逻辑总览.md`（2026-09-10 建）。改动系统前先读它——含 5 个 Tab 的数据结构、全景数据流、6 个定时任务、前端三层防缓存、工具脚本清单、「想改 X 改哪里」对照表、硬性规则。比本文件更完整的对照基线。

> ⚠️ **看板实际是 5 个 Tab**（早报 / 晚报 / 短线 / 量价 / 日历），不是"四类简报"。另外「短线」Tab 的数据源是 `evening.明日关注`（即板块热点），**不是** `watchlist` 字段。

## 2026-09-12 恢复重建记录（本次）

- **恢复方式**：`robocopy /E` 从隔离区**复制**到新目录（非移动）。隔离区原件 35M / 102 次提交 / `.gh-token` / `tmp_*` **一字未动**（已核验时间戳与工作区状态均与会话前一致）。
- **排除项**：5 个 `tmp_*` 残留（约 400KB，9/10 中断现场）+ 旧 `.gh-token`（凭据一律不复用）。
- **验收通过**：`node tools/health_check.js` 0 错误 / 6 条历史告警；`bash tools/bump_version.sh` 四步全过（版本号→sort_reports→sync_holidays→export_json）；本地 `http://127.0.0.1:8899/` 真实渲染，5 个 Tab 全部有内容、历史日期可回看（09-01~09-10；其中 **09-10 无晚报**、**09-08 全天缺失**，均属历史事实而非恢复故障）。
- **通知功能**：09-12 先加禁用开关 → **09-14 连脚本一起删除**（`tools/notify.js` / `tools/notify_digest.js` 已不存在）。
  因此 Server酱 key 不再需要提供。日后若真要恢复推送：`git show 7e47e2a:tools/notify.js` 可从历史取回
  （`7e47e2a` 是删除前的最后一个版本，另 `notify_digest.js` 同）。
- **验证手段（可复用）**：本机 Edge 无头模式 + DevTools 协议（Node 22 自带 `fetch` + 全局 `WebSocket`，零依赖）真实渲染并逐 Tab 截图；脚本 `verify_page.js` 放在本次恢复会话目录。比装 `agent-browser`（需下 ~500MB Chromium，且本机访问 github.com 不通）可靠得多。
- ⚠️ **踩坑**：恢复前 8899 端口上已有一个**今天 18:42 启动的残留 `python -m http.server`**，它在服务隔离区的旧副本，会把请求抢走（Windows 下 `http.server` 开了 `SO_REUSEADDR`，多进程可绑同一端口，命中不确定）。表现为「磁盘文件已是新版、浏览器却拿到旧版」。已停掉该残留进程，改为单一服务进程。
- ⚠️ **git 状态**：`tmp_*` 原本是被提交进 HEAD 的（提交 `16701ef`/`f324111` 为"临时验证"所留），所以按用户要求排除后，工作区会显示这些文件为「已删除」——预期行为，首次 `publish.sh` 会自动带上这个清理提交。


## 架构决策记录（ADR）

| 日期 | 决策 | 原因 | 放弃的方案 |
| --- | --- | --- | --- |
| 2026-09-10 | 看板改为「静态托管 + 固定自有域名」，URL 与部署次数解耦 | e2b 动态沙箱每次部署换 URL、空闲自动停机（错误码 12809），用户无法稳定访问 | 继续用 `workbuddy_sites_deploy` 动态沙箱（链接漂移是设计使然，无法修复） |
| 2026-09-10 | 访问链接单一事实源化：只存 `config/site.json` + GitHub variable `SITE_URL` | prompt/README/推送模板三处硬编码，域名一变全是死链（已积累两代死链） | 各处硬编码 URL |
| 2026-09-10 | 生成层保留 LLM 依赖，调度/发布层先上云（分阶段迁移） | 早报/晚报的读图与摘要强依赖 LLM，一次性重写风险高 | 一次性全量迁云 |
| 2026-09-10 | 定时任务统一改为「`bash tools/publish.sh "<说明>"` → `node tools/notify_digest.js <type> <标题>`」两步，prompt 内不出现任何 URL | 链接来源收敛到 `config/site.json` 一处；避免 prompt 硬编码导致域名变更后死链 | 在 prompt 里调 `workbuddy_sites_deploy` 再手动 curl Server酱 |
| 2026-09-10 | 用 git `post-commit` 钩子自动推 GitHub | 让存量 automation 的 `git commit` 步骤零改动即可自动发布，不必逐条改 prompt | 逐条改 prompt 里的提交步骤 |
| 2026-09-12 | 服务器推送通知整体下线（脚本 + 任务 prompt + 文档） | 用户明确要求删除；通知是唯一需要长期保管凭据的环节，去掉后本地模式零凭据依赖 | 保留通知但换新 key |
| 2026-09-12 | `publish.sh` 无令牌时降级为"仅本地提交"并 `exit 0` | 本地模式下 4 个任务每次都硬失败；任务失败态会掩盖真实问题、污染日志 | 保持报错（用户一看到红就以为系统挂了） |
| 2026-09-12 | 新增根目录 `.gitattributes` 固定脚本为 LF | 本机 `core.autocrlf=true` 且此前无 `.gitattributes`，任何一次 checkout /fresh clone 都会把 `.sh`/钩子写成 CRLF，bash 直接 `bad interpreter` 哑火 | 依赖"目前恰好没被重写过"的运气 |
| 2026-09-12 | 清理 3 处通知残留（两个 workflow + `health_site.js`） | 本地脚本下线了但 `.github/` 里还留着 Server酱 步骤，一推 GitHub 就会"复活"每天发微信 | 只删本地脚本，靠"反正不推"规避 |
| 2026-09-12 | 死代码：删 `verify_data.js`/`_morning_today.py`/`publish_and_notify.sh`；`dashboard/server.js`+`package.json` 移到 `tools/legacy-sandbox/` | 前两者硬编码早已不存在的旧路径 `C:\Users\zoush\WorkBuddy\...`，跑必崩且误导；后两者是沙箱遗物，却在公网站点根目录里会随发布上传 | 直接删（想保留本地起服务能力） |
| 2026-09-12 | 日历图片方案选「调色板量化 PNG」而不是 WebP | 实测：两类长图（2008×20640 / 2008×23960）量化 256 色后 10.96MB→4.24MB（-61%），**分辨率不变、PSNR 50-55dB**；而 WebP 受单边 16383 限制必须先缩放，且缩放插值让压缩率反而变差（1594×16383 只有 2.89MB，比原尺寸的 1.86MB 还大） | 转 WebP（要改 data.js 路径 + 牺牲分辨率） |
| 2026-09-12 | 新增 `tools/clean_calendar.js` 回收日历孤儿图，接入 `bump_version.sh` | `calendar` 数组只留最近 5 篇，但磁盘图片从不删 → `dashboard/calendar/` 无限膨胀、每次发布都要重传 | 靠人工定期清理 |
| 2026-09-12 | `verify.js` / `screener.js` 读 data.js 改为 `loadDataStrict` + `saveDataSafe` | 原实现 `try { eval } catch {}` 会在 data.js 写坏时静默降级成空结构，再被原样写回 → **7 天历史 + 全部日历一次性清空**。且 21:00 晚报与 21:30 次日验证本来就改同一个文件 | 保持 catch 吞异常（等于把数据安全押在"data.js 永远不坏"上） |
| 2026-09-12 | 安全阀的基线用**数字快照**而不是对象引用 | 第一版写成 `saveDataSafe(DATA, data, loaded.data, ...)`，`next` 与 `prevData` 是同一个对象引用，调用方就地修改会连带改掉基线 → "骤减"检查永远不触发。是测试时发现的 | — |
| 2026-09-12 | 中止统一走 `abort()` 抛错 + 顶层 `.catch()`，不用 `process.exit(1)` | Windows 下管道输出是异步的，`process.exit` 可能把报错信息截断，而这正是运维最需要看到的 | `process.exit(1)`（实测会把关键报错吞掉） |
| 2026-09-12 | `health_check.js` 新增断更检测 + 晚报双结构一致性检查 | 本地模式下 `health_site.js` 不运行，**没有任何机制发现管线停摆**。断更检测用「交易日无数据 + `logs/<日期>.md` 是否存在」区分"数据源没发布"（正常）与"管线没跑"（真问题） | 只做结构校验 |
| 2026-09-12 | 一致性检查只对**最新一期**计入 WARN，历史遗留降为提示 | 09-03 那条历史漂移会让体检永久退出码 1，噪声会让真正的告警被忽略 | 历史与新问题一起报警 |
| 2026-09-12 | 09-02/09-03 的 `generatedAt` 依 `logs/` 记载据实补回 | 缺字段是历史遗留，但运行时间在日志里有据可查，补回后可让体检输出变得可信 | 一直留着 3 条 WARN |
| 2026-09-12 | `一键推送GitHub.bat` 归档到 `tools/legacy-sandbox/`；删除空的 `.gh-config/` | 该脚本依赖 `gh` CLI + git 协议，本机访问不了 github.com，且仓库早已存在，放在根目录会误导 | 留在根目录 |
| 2026-09-10 | 云化方案暂缓，先出「系统总览文档」作为规划基线 | 用户决定"先不做"；没有准确的现状描述，规划容易基于过时记忆。盘点中发现多处 MEMORY.md 描述已过时（Tab 数、任务数） | 直接开工云化改造 |
| 2026-09-14 | 恢复云端发布：Pages Source 定为 **`GitHub Actions`** + 新建 fine-grained PAT（Contents / Workflows 双写） | 站点根在 `dashboard/` 子目录，分支部署必然 404；发布链路本就是 `upload-pages-artifact(path: dashboard)` + `deploy-pages` | 继续纯本地模式（线上永久停在恢复前，用户拿不到可用链接） |
| 2026-09-14 | 站点 404 的诊断顺序定为「**先 Pages，后 DNS**」 | 实测 DNS 一直是对的（`asx` CNAME → `zoushiyun1999.github.io`，阿里云云解析），而 `has_pages` 才是真因。顺序搞反会白折腾 DNS | 见到 404 就去改 DNS 记录 |
| 2026-09-14 | **清理 11 个文件**：死代码（`notify.js`/`notify_digest.js`）+ 归档遗物（`tools/legacy-sandbox/` 整目录）+ 5 份过时/重复文档（`GitHub上线清单.md`、`测试指南.md`、`网页看板-运行逻辑与数据来源.md`、`ui_report.docx`、`复盘_20260907.html`） | 反复删除/恢复期间积累的**误导性**冗余：`网页看板-…` 与 `系统功能与运行逻辑总览.md` 内容重叠且后者更全、已是基线；`GitHub上线清单` 还在教 gh CLI 登录与"配微信密钥"；通知已下线而脚本留着让人以为功能还在 | 全部保留（占地方、误导后来者） |
| 2026-09-14 | `tools/_test_health_logic.js` → **`tools/test_health_logic.js`**（去掉 `_test` 前缀） | `gh_push_api.js` 的 `SKIP_PATH` 正则命中 `_test*`，把它当本地临时文件跳过 → 这个被 AGENTS 规则 20 强制要求运行的测试脚本**从未上过云端仓库** | 改 `SKIP_PATH` 正则（影响面更大，且 `_test` 前缀理应留给本地临时件） |
| 2026-09-14 | **禁止用「一条命令多路径」的 `git rm`**（含中文路径时尤甚）；批量删除改用 Node + 先 dry-run | 实测一次 `git rm -q <11 个路径>` 后，`tools/` 与 `docs/` 下**未被指定的 20 多个文件也一起从工作区消失**（index 未丢，`git checkout HEAD -- tools docs` 完整恢复，零损失）。已写入 AGENTS 硬性规则 23 | 继续用 git rm 并靠运气 |
| 2026-09-15 | 日期导航从「全局前一天/后一天」改为 **每个 Tab 内一条日期选择条**（自然日 ±1 + 原生 `<input type=date>` + 「最新」），主状态 **`idx` → `curDate`** | 用户明确要求"能选时间"：旧的两个按钮到不了指定日期，也永远点不到休市日 —— 于是"当天没有数据"只能显示成语义含糊的"待更新"。改用 `curDate` 后可选范围含休市日与历史缺口日 | 保留全局按钮 + 只在"有数据的那几期"之间跳（那样永远无法表达"这天没数据"） |
| 2026-09-15 | 空态文案**四分**：`休市·无数据` ／ `当日无数据`（历史交易日缺口）／ `待更新`（今天未到计划点）／ `今日…未生成`（过点仍无）。到期点文案单点定义在 `todayDue()` | 用户明确要求"休市就直接注明没有数据，不要写待更新"。休市日说"待更新"是错的（那天根本不会有数据）；历史交易日说"待更新"也是错的（早就该有） | 所有情况统一显示"待更新" |
| 2026-09-15 | 投资日历 Tab 的"时间"维度定为**发布期**（`calBar()` 按期刊出），不跟随自然日 | 博主发布的是月度长图，与交易日没有对应关系；并且它原本的 chips 只在 `length > 1` 时才出现，单期时没有任何选择控件 | 让日历也跟随 `curDate`（会得到一个"选了某天但日历内容不变"的错位界面） |
| 2026-09-15 | 顶部 header 压成 **2 行（65px，滚动后 32px）**：品牌+日期同行、状态一行放完、**healthBar 正常时 `display:none` 不占位** | 用户反馈"顶部标题 + 每日更新状态的板块太大，完全没必要"。实测原来要吃掉近 190px（header 150 + 健康条 38），而其中"日期"在 header / 日期条 / 选择器里出现三次、"各源运行正常"与 5 个绿点完全重复。**顶部开销写进了 `tools/verify_page.js` 的 `report.headerHeight` 固定监控**，防止以后被改胖 | 只微调 padding / 字号（省不到 30px，信息重复没解决） |
| 2026-09-15 | header 状态项用 **`SHORT_NAME`** 映射（量价选股→量价、投资日历→日历），footer 仍用全称 | 全称在 430px 屏上合计 > 可用宽度 → 折成两行，白占 18px。短名与 Tab 名一致，反而更好认 | 把 `srcMeta()` 里的 name 直接改成短名（footer 是完整句子，短名会读不通） |
| 2026-09-15 | 顶部状态行与页脚**不再列「次日验证」**（`srcMeta()` 少一行），但**保留** `verifyRanToday()` + `DUE.verify` 的健康监控 | 用户要求去掉。它的 `row(..., at='')` **时间参数永远是空串**（后台脚本没有"生成时间"），在一排 `早报 12:36 / 晚报 21:04` 里只剩一个光秃秃的词。**判断依据：没有时间的数据源不该混进时间行**。"它有没有跑"属于异常信息，交给 `renderHealth()` 在异常时提示 | 连监控一起删（那这项任务悄悄停掉就没人发现了） |
| 2026-09-15 | 早报「**并发双写**」定案：`merge_report.js` 按 date 幂等，**只保证不出现两个同日条目，不保证内容不被覆盖**；PC 开机补跑时段的产出必须假定可能被另一实例覆盖 | 08:30 主任务与 10:00 看门狗在 PC 开机后同时醒来抢跑，两实例都跑完「抓取→写 tmp → merge_report → check_codes → publish」全链路；后写者静默覆盖先写者。且 Actions 里留下**两个同题 success run**（`e8f03e5` / `c92686f`），日后回看极易误判为「重复发布事故」。**判断"线上是哪一版"只能读 `dashboard/data.js` 的内容指纹**（`morning.generatedAt` + 关注股名单/条数），**不能读 `logs/`**——两实例的 WARN 时间戳完全相同（都是 13:21），零区分度 | ① 靠 `logs/` 判断线上版本；② 给 `dashboard/data.js` 加文件锁（PID + 时间戳租约，是根治方向，本轮未实施） |

## 环境事实

- 本机 Windows，Node 22.22.2 / 24.14.0，Python 3.13.12（均在 `~/.workbuddy/binaries/` 隔离目录）。
- **本机命令行无法访问 `github.com`**（代理 502 / 直连超时），但**可以访问 `api.github.com`**（走 WorkBuddy 代理）。因此所有推送走 `tools/gh_push_api.js`（Git Trees API），不走 git 协议。`gitee.com` 可达，`github.io` 可达。
- 仓库已有 remote：`zoushiyun1999/astock-dashboard`（**必须 Public**，免费账号私有仓库不能用 Pages）。
- `dashboard/` 纯静态，`data.js` 为 `window.REPORTS = {...}` 全局变量，顶层字段：`updatedAt / calendar / reports / screener`。
- 数据源：韭研公社（开盘必读、A股投资日历）、淘股吧（湖南人、行鱼复盘）。
- ⚠️ **定时任务会真的跑，并在提交时 `git add -A`**：2026-09-12 21:00 的晚报任务在人工操作期间自动运行，
  它 `git add -A && commit` 把当时**所有未提交的改动**（包括人正在写、还是半成品的脚本，甚至
  `__pycache__/*.pyc`）一起提交了。所以：改脚本期间若碰到整点/半点，先把自己的状态提交掉，
  或者事后用 `git log --stat` 复核被卷进去的文件。`.gitignore` 已加 `tmp_*` 与 `__pycache__/`。
- 默认分支 `main`，无 git remote（推送走 API，仓库名硬编码在 `tools/gh_push_api.js`）。
- Server酱推送通知**已于 2026-09-12 下线、2026-09-14 删除脚本**（`tools/notify.js` / `tools/notify_digest.js` 已不复存在，需用时从 `7e47e2a` 取回）。因此 Server酱 SendKey **不再需要提供、也不再需要轮换**；GitHub Secrets 里若还有旧 `SCT_KEY`，可一并删除。

## 云端发布链路（2026-09-10 落地，改动前必读）

```
数据写入 dashboard/data.js（automation 用 Write）
        ↓
bash tools/publish.sh "说明"
  ├─ bump_version.sh  → 刷新 index.html 版本号 + sort_reports + sync_holidays + export_json
  │                     （产出 dashboard/data.json + dashboard/version.json）
  ├─ git commit
  ├─ .git/hooks/post-commit → tools/gh_push_api.js 自动推送（无需人工 push）
  │    └─ 无 .gh-token 时：静默跳过、退出码 0（**不阻塞本地提交**）
  └─ 有 .gh-token 时 → GitHub Actions publish.yml → 发布到 https://asx.79zl.cn/
```

> ⚠️ **2026-09-12 修正**：原先第 3 步在无 `.gh-token` 时 `exit 1`，导致本地模式下每次定时任务
> 都在最后一步硬失败。已加"本地模式守卫"：无令牌则跳过推送并 `exit 0`。验收命令
> `bash tools/publish.sh "测试"` 在无令牌下退出码必须为 **0**。
>
> 微信通知环节已于同日从链路中移除。

- **入口 URL 只存在于 `config/site.json`**：`siteUrl`（主）、`fallbackUrl`（备用）、`domainExpiry`。
- ~~`tools/notify.js` 内置硬拦截：正文/标题出现 `e2b.*`、`sandbox.cloudstudio.club`、`3000-<hex>` 直接 fail~~
  （该脚本已于 2026-09-14 删除；同类黑名单仍保留在 `tools/health_site.js` 的 `BAN` 正则里）
- `tools/health_site.js`：三入口探活 + 数据新鲜度（>26h 且交易日告警）+ 域名到期提醒 + 全仓硬编码链接扫描。本地与 `.github/workflows/health.yml` 各跑一次。
- `tools/publish_and_notify.sh` **已于 2026-09-12 删除**（通知下线后无调用方）。
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
- **⚠️ 湖南人帖子不是"纯图片"**（2026-09-10 实测修正）：正文文字就在帖子 HTML 的 `subject` 属性里（`div#gtgioMsg102827446`），含复盘/龙虎榜、热点题材（带消息面）、盘前公告与新闻、外围市场，约 4000 字符；图片只是其中的连板梯队表等表格。因此**纯正则切段即可拿到晚报 70–80% 内容，不必然需要大模型读图**。评论区也常有用户贴的完整文字版。
- **本机 `schtasks.exe` 被安全策略拦截**（Program Blacklist，不可绕过），无法从命令行创建 Windows 计划任务；只能用图形界面手动建或去安全中心放开。
- **公共 `rsshub.app` 本机不通**（直连超时 / 代理 502，与 github.com 同因）。RSSHub 有 `/taoguba/blog/:id`、`/jiuyangongshe/user/:uid` 路由，覆盖本项目全部源，但要用得自建实例。

- **韭研公社文章正文与配图不用 API、不用登录，直接从页面内联 payload 取**（2026-09-13 实测）：文章页 HTML 里有
  `__NUXT__=(function(...){...}(...))` 的 IIFE，`eval` 后取 `data[0].data` 即得全部字段——
  `content`（正文 HTML，`<img src>` 就是原图地址，去掉 `?x-oss-process=...` 水印参数即原图）、
  `title` / `create_time` / `cover` / `stock_list`（本文关联个股，带 name + code，可直接喂给 `check_codes.js`）。
  用户主页同理，`/a/{id}` 链接按出现顺序即「最新在前」，比解析 DOM 稳。提取时注意 `seg.slice(0, seg.indexOf('</script>'))` 截断。
- **超长日历图（2008×17040 这类）必须切片后再读**：整图交给读图会把表格缩到不可辨认。按高度切 6-8 段、
  各留 60px 重叠防切断行，逐段识别才能拿到完整日期/事件表。
- **WebFetch 有 15 分钟缓存**：判断"最新帖是否为今天"时若命中昨日缓存会误判未发布，应复抓一次再下结论。
- **PC 休眠/关机导致整天数据缺失**：本地 automation 无法执行（9/8 全天缺失），看门狗只补当天、历史缺口需人工补。
- **同一文件多处 Edit 必须串行**：并行 Edit 有竞态，先发的会被覆盖且工具仍返回成功。
- **个股代码必须双校验**：code 不能凭模型记忆填，用 `tools/check_codes.js` 反查。
- **GitHub Actions 的 `run:` 里不要用多行 shell 字符串**：`.github/workflows/screener.yml` 曾因跨行 `desp="..."` 导致 YAML 解析失败，**该文件 6 天里从未成功运行过**。改用 `printf` 或单行。改完 workflow 一定用 `yaml.safe_load` 校验。
- **Windows node.exe 不认 Git Bash 的 `/c/...` 路径**：脚本调 node 前先 `pwd -W` 转成 `C:/...`，否则 `MODULE_NOT_FOUND`。
- **`data.js` 的 reports 顺序是「最旧在前、最新在后」**，truncate 必须按 date 排序后 slice，先 push 再 `slice(0,7)` 会丢最新一条。
- **`git add -A` 会把 `.gh-token` 带进提交**：已在 `.gitignore` 加规则，但 API 推送不受 `.gitignore` 约束，必须靠 `gh_push_api.js` 的 `DENY_FILE` 兜底（曾真的差点推上公网，被 GitHub 以 422 Secret detected 拦下）。
- **任何临时产物必须放项目根并加 `tmp_` 前缀**（2026-09-12 加 `.gitignore` 规则 `tmp_*` 根治）。此前 `tmp_*` 被提交进 HEAD，只靠 `gh_push_api.js` 的 `SKIP_PATH` 在推送层兜底；现在本地 `git add` 层面即屏蔽。**特别警告**：Edge headless 做前端截图时 `--user-data-dir` **绝不能指向仓库根**——profile 里的 `Cookies` 被浏览器占用，会让 `git add -A` 直接 `fatal: adding files failed`，整条发布链路中断（2026-09-12 晚报任务实际踩到）。
- **结束 Edge 无头进程要用 PowerShell `Stop-Process -Name msedge -Force`**：`taskkill //F //IM msedge.exe` 返回后进程仍在（残留导致临时目录删不掉）。
- **无头截图两个"失败得莫名其妙"的坑**（2026-09-15 实测）：
  ① `Page.captureScreenshot` 在 **`deviceScaleFactor=2` + 全页高**时会**超时**（CDP timeout 提到 90s 也一样），
     报错只有一句 `timeout Page.captureScreenshot`。**用 dsf=1** 立刻正常，清晰度够看。
  ② 每次截图前**必须先把视口还原成手机高度、再量 `scrollHeight`**：上一次把 height 设成全页高之后，
     页面的最小高度就被那个值撑住，直接再量只会越截越长（后面每一张底下都拖一大片空白）。
  两条都已固化进 `tools/verify_page.js` 的 `shot()`。
- **`tools/verify_page.js` 的浏览器 profile 必须放 `os.tmpdir()`，绝不能落仓库根**：profile 里的 `Cookies`
  被浏览器占用会让 `git add -A` fatal（2026-09-12 晚报任务真实踩到，整条发布链路中断）。
- **改了 `srcMeta` / `renderHealth` / `updateEveningDot` 后必须跑 `node tools/test_health_logic.js`**。
  该脚本把函数抽进**同一个 vm 上下文**，`FN_NAMES` 是唯一依赖清单 —— **漏一个就是 ReferenceError**
  （不是静默跳过）。2026-09-15 起清单含 `parseYmd / isTradingDay / screenerOn / verifyOn / esc / fmtDate / emptyCard / todayDue / emptyFor`。
- **GitHub Pages 返回 "Site not found" ≠ DNS 有问题**（2026-09-14 实测）：`nslookup asx.79zl.cn` 已正确返回
  GitHub Pages 的官方 IP，说明 DNS 全对；真因是**仓库 Pages 未启用**。404 排查顺序应为
  ① `GET /repos/{o}/{r}` 看 `has_pages` ② 仓库 `Settings → Pages` 的 Source 是否 = `GitHub Actions` ③ 最后才看 DNS。
- **`publish.yml` 的 build 步骤会现场跑 `node tools/export_json.js`**，因此线上 `version.json` 的 `exportedAt`
  **是 CI runner 的生成时刻、且是 UTC 时区**（本地 +8）。这是判断「刚才有没有真的部署过」最快的信号：
  如实测 `2026-09-14 05:53` = 北京时间 13:53，与用户手动触发时间精确吻合。
- **`.gh-token` 权限不足的报错很长但很有指向性**：`POST /repos/.../git/blobs → HTTP 403
  Resource not accessible by personal access token` = Contents 只读。而读操作（`/git/ref`、`/git/commits`、`/git/trees`）
  会**照常成功**，所以别被"能读"骗过去——能读不等于能写。
- **⚠️ `.gitignore` 对 API 推送通道完全无效**（2026-09-14 实测踩到）：本项目的上传有**两条独立通道**——
  ① `git commit`（受 `.gitignore` 约束）② `.git/hooks/post-commit` → `tools/gh_push_api.js`（**自己走目录树，
  一行都不读 `.gitignore`**，只在代码里用 `SKIP_DIR` / `SKIP_PATH` / `DENY_FILE` 硬拦）。
  后果实录：归档 `docs/归档/` 时只加了 `.gitignore`，`post-commit` 照样把 **51 个归档文件**推上了
  **public** 仓库（含旧项目 `AGENTS.md/MEMORY.md`、`开机自动关机诊断报告.md`——写着主机名
  `DESKTOP-NQT2JG0\zoush`、QClaw 会话 ID、注册表路径）。
  **规则：任何"只留本地"的目录，`.gitignore` 与 `gh_push_api.js` 的 `SKIP_DIR` 必须同时加。**
  撤回方式：`git rm -r --cached <dir>` → commit → 钩子自动把远端多余文件删掉（脚本第 159–169 行，
  全量模式下「本地没有的远端文件」会打 `sha: null` 删除标记）。
- **删除前必须核对完整清单再动手，且优先用回收站**（2026-09-14）：`send2trash` 移入回收站的删除是
  好做法，但要**注意「删完立刻 `os.path.exists` 复检」会误报失败**——Windows 的 8.3 短名解析
  （`WORKBU~2\2015D7~1`）在目录已删后报 `WinError 2`，实际删除是成功的。
  判断真实结果要看**残留目录内容是否为空**，不要只看异常。
  另：**当前会话的工作目录被进程锁住，删不掉**（`WinError 32`），属正常现象，等会话关闭再删。
- **`send2trash` 可通过主 venv 安装**：`C:/Users/zoush/.workbuddy/binaries/python/envs/default/Scripts/pip.exe
  install send2trash`。补充：PowerShell 的 `New-Object -ComObject Shell.Application` 走回收站
  **被安全策略拦截**（"COM object instantiation can run arbitrary code"），`winshell`/`send2trash`
  默认也未安装 —— 三条路只剩 pip 装 `send2trash` 可用。

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
| Server酱 key | ~~`.sct-key` / GitHub Secrets `SCT_KEY`~~ **2026-09-12 起不再使用，2026-09-14 相关脚本一并删除** | 历史遗留：`tools/notify.js` 当年实际**只读环境变量 `SCT_KEY`**，项目里从来不存在 `.sct-key` 文件（文档与实现不一致）。日后若恢复推送需**重建脚本** + 新 key |
| 自建定时任务的 prompt 全文 | `automation_update` 的 view 模式 | 5 个任务 ID 见下 |

### 6 个定时任务（2026-09-12 重建，全部 ACTIVE）

| ID | 名称 | 时间 |
| --- | --- | --- |
| `0edec1bb-7218-4991-a906-b99d789a9843` | A股早报-开盘必读资讯 | 每日 08:30 |
| `5cff8748-1e37-48d9-ad29-282b141bfa4f` | A股量价选股 | 工作日 15:10 |
| `a7e3083b-c6da-4fe3-b6c4-1a69de6b7fb7` | A股晚报-AI读图复盘+投资日历专版 | 每日 21:00 |
| `7de2afd7-883b-40ac-af53-413f5b4ecf2d` | A股次日验证 | 工作日 21:30 |
| `3e2314c2-3644-43ed-a84c-e3e9a21ba177` | A股早报补跑看门狗 | 每日 10:00 |
| `f72377e1-4d16-4db4-b6af-a31fd144df28` | A股晚报补跑看门狗 | 每日 22:30 |

> 旧 ID（`automation-17881844*` / `86ab063f-*` / `d97007fc-*`）已随 2026-09-10 清空失效，`.workbuddy/automations/` 里仅剩历史 memory 作参考。
> 变更点：量价选股 **14:30 → 15:10**（修「盘中跑入选数被压低」缺陷）；晚报看门狗 **PAUSED → ACTIVE**；6 个 prompt 均删掉了通知步骤。

## 待办 / 悬置问题

- [x] ~~轮换 Server酱 key~~ — 2026-09-12 推送通知功能已整体下线，不再需要（若日后恢复推送则仍需用新 key）
- [x] ~~撤销/重建 GitHub PAT~~ → **2026-09-14 完成，当天并已轮换一次**（首个 token 在本轮对话明文出现，随即换成新 token）。
      - **位置**：项目根 `.gh-token`（`github_pat_` 前缀、**93 字符**、单行无空格换行），
        由 `.gitignore` + `gh_push_api.js` 的 `DENY_FILE` 双重兜底，**不会被上传**。
      - **权限要求（踩过）**：`Contents: Read and write` + `Workflows: Read and write`，**两个都要**。
        只给 Contents 会在 `POST /git/blobs` 报 **403 `Resource not accessible by personal access token`**；
        而 `/git/ref`、`/git/commits`、`/git/trees` 的**读操作会照常成功** —— 别被"能读"骗过去。
      - **有效期 2026-12-13（90 天）**。⚠️ 到期前 30 天务必换新。**纠偏（2026-09-14）：真实行为是
        「硬失败 `exit 1`（但同样无通知）」，不是「静默降级为仅本地提交」** —— `publish.sh` 只在
        `.gh-token` **文件不存在**时降级；token 存在但过期/吊销时，`gh_push_api.js` 会在
        `POST /git/blobs`(:152) 或 `POST /git/trees`(:185) 处 401 → `fail()` exit 1 → `publish.sh:79` exit 1。
        现已由 `tools/health_site.js` 的 `tokenCheck()`（探活 + 读 `config/site.json` 的 `tokenExpiry`，
        剩余 <30 天报 ERROR）机器探测，不再靠人肉记。
      - 💡 **反直觉结论**：在对话里发 token，轮换多少次新 token 都会再次明文出现，**轮换本身不是有效缓解**。
        真正有效的是「**设 90 天过期** + 最小权限（只授权这 1 个仓库 + 仅 Contents/Workflows 两项）」——
        泄露的影响因此有界、有时限。以后不必为"发过 token"反复重生成。
- [ ] ⚠️ **晚报任务（每日 21:00）提示词缺「非交易日 / 今天未发布」的显式跳过兜底**：原文只说"不是今天则带 `?t=` 复抓再判定"，**没写判定后怎么办**（早报那版有明确的跳过分支）。周末与节假日存在写入脏数据的风险，待用户决定是否补一句
- [ ] 在 `config/site.json` 填 `domainExpiry`（79zl.cn 到期日）以启用到期提醒
- [x] ~~`verify.gain` 口径改造~~ → **2026-09-14 21:30 完成数据侧**：verify 增写
      `open / openPct / buyRet / netRet / locked / basis:'open-to-close'`，`gain/hit` 保留做兼容。
      **前端仍显示 `gain`（旧口径），待改 `verifyBadge()` 优先展示 `buyRet` / `netRet` 并给一字板独立标记**。
      （AGENTS 硬性规则 26）
- [x] ~~行情范围补创业板/科创板/北交所~~ → **2026-09-14 完成**：`verify.js` 补 `m:0+t:80`/`m:1+t:23`，
      本轮临时脚本另加北交所 `m:0+t:81+s:2048`，全池 **5913 只**（原沪深主板 3487）。
      ⚠️ 北交所那一段尚未并入 `tools/verify.js`，下次改该脚本时一并加上。
- [x] ~~历史缺口回补~~ → **2026-09-14 完成**：09-07、09-09、09-10、09-11、09-14 共 85 条推荐已补标，
      verify 总数 40 → **108 条**。**教训：`verify.at` 的取值分布是判断"任务是否真的跑过"的最快手段**——
      当时只有 09-03/04/08 三个值，一眼就看出任务长期空转（且缺口全是亏损日，属幸存者偏差）。
- [ ] 早报/晚报生成逻辑云化（LLM adapter），彻底摆脱"PC 不在线就断更"
- [ ] 云端自动化 `cloud:6776601`「生成昨日 AI 重点资讯总结」**无法通过工具删除**
      （接口只读，返回 `delete is not supported for cloud automations`），已 PAUSED 无副作用。
      需用户在手机 App / Web 端「自动化」入口手动删。从 2026-09-10 挂到现在。
- [ ] 晚报补跑看门狗是否启用（当前 PAUSED，需用户决策）
- [x] ~~09-11（周五）整天空洞是否回补~~ → 2026-09-12 晚报任务已补跑（写入 `2026-09-11 evening`，git `2b58a6e`）。湖南人 `2v0p2GUgbtk`；行鱼 9/11 未发布；日历无新帖
- [ ] ⚠️ **湖南人帖子在未登录状态下只暴露 1-2 张图**（2026-09-12 实测）：正文文字仍完整（subject 属性约 2000-4000 字符，覆盖 70-100% 内容），但连板梯队表等图片拿不到 → 盘面数据需用财经媒体复盘交叉核对
- [ ] ⚠️ **2026-09-11 只有 evening、缺 morning**（09-11 处于 9/10 清空、9/12 恢复之间；9/12 21:05 只补跑了晚报）。
      09-13 早报任务与本日晚报任务都判定「不在本任务范围内」而未擅自写入 → 待用户决定是否回补
- [ ] 清理项目根残留：`一键推送GitHub.bat`（已被 SKIP_PATH 保护不会上传，但占地方、易误读）
- [ ] 新浪日K源稳定性观察：连续多日大面积失败则把腾讯源提为主源

