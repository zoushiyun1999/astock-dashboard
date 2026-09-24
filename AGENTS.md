# AGENTS.md

> 项目级 Agent 工作约束。任何"干活"类请求开始前必读。

## 项目标识

- **项目名**：A股推送系统
- **根目录**：`D:\workbuddylujing\A股推送系统`（2026-09-12 从隔离区恢复而来；隔离区原件 `D:\WorkBuddy_删除隔离_2026-09-10\WorkBuddy\A股推送系统\` 只读保留）
- **创建日期**：2026-08-31
- **一句话目标**：每天自动把分散的股票信息整合成早报/晚报/选股/验证四类简报，输出到网页看板（5 个 Tab：早报 / 晚报 / 短线 / 量价 / 日历）。
- **当前运行模式**：**本地生成 + 云端发布**（2026-09-14 恢复上云）。定时任务在本机跑，数据经
  `bash tools/publish.sh` 提交本地 git，再由 `post-commit` 钩子调 `tools/gh_push_api.js` 推送 GitHub，
  Actions 自动发布到 `https://asx.79zl.cn/`（约 1 分钟）。项目根 `.gh-token` 已配置；
  **缺失或权限不足时自动降级为「仅本地提交」**，不阻塞任务。微信通知已于 2026-09-12 下线。

## 技术栈

- 语言/运行时：Node.js 22（`~/.workbuddy/binaries/node/versions/22.22.2-2/`）、Python 3.13（仅工具脚本）
- 前端：原生 HTML/CSS/JS，无框架、无构建步骤，`dashboard/` 目录整体即站点
- 关键依赖：无第三方 npm 依赖（脚本全部零依赖，只用 Node 内置模块）
- 常用命令：
  - **一次发布（改完数据必跑）**：`bash tools/publish.sh "<说明>"`（无 `.gh-token` 时自动降级为"仅本地提交"）
  - 刷新版本号 + 排序 + 导出 JSON：`bash tools/bump_version.sh`
  - 站点体检：`node tools/health_site.js`
  - 个股代码校验：`node tools/check_codes.js --fix --prune`
  - 数据体检：`node tools/health_check.js`
  - 日历图压缩（Pillow，缺依赖自动跳过）：`python tools/optimize_calendar.py`
  - 日历孤儿图回收（`bump_version.sh` 已串联）：`node tools/clean_calendar.js`
  - 本地预览：`python -m http.server <高位端口> --bind 127.0.0.1`（在 `dashboard/` 下）
  - 微信通知**已于 2026-09-12 下线、2026-09-14 删除脚本**（`tools/notify.js` / `tools/notify_digest.js`
    已不存在）。任何任务 prompt 都不要再引入；日后若真要恢复推送，从 git 历史（2026-09-14 之前的提交）取回这两个文件

## 工作约束

1. 结论先行，再给理由；不铺垫背景。
2. 默认中文；代码、命令、变量名用英文。
3. 方案有问题直接指出，不谄媚、不夸需求。
4. 需要选择时给 A/B/C 排序方案 + 权衡，不问"你确定吗"。
5. 改动前先读相关文件，不凭猜测编辑。
6. 破坏性操作（删除、重装、覆盖）必须先说明影响并等确认。
7. **前端样式/逻辑改动必须先本地截图验证再交付**——用户主用手机看，不能让他当测试员。方法见 `.workbuddy/memory/2026-09-06.md`（Edge headless 截图）。
   注意：**截图是自检手段，不等于要放进交付物**。只有当前端真的改了、且用户需要看效果时才展示；
   改后端脚本/文档/配置不需要截图，本地预览 URL 也不要习惯性附带（用户 2026-09-12 明确反馈过）。
8. **同一文件的多处 Edit 必须串行执行**，并行 Edit 有竞态且工具仍返回成功。

## 目录约定

```
config/            数据源与站点配置（sources.json / trade_holidays.json / site.json）
dashboard/         网站站点根目录（整体发布，勿放非站点文件）
  data.js          ⚠️ 定时任务写入，勿手改；data.json / version.json 由 export_json.js 派生，勿手改
  js/app.js        渲染逻辑与交互
  css/style.css    样式
  calendar/        投资日历原图（体积大，注意仓库膨胀）
tools/             生成、校验、导出、体检脚本（Node，零依赖）
logs/              每日运行日志（append-only）
docs/              方案与说明文档
.github/workflows/ 云端调度与发布
```

## 硬性规则（违反会导致线上故障）

1. **禁止硬编码访问链接**。链接唯一事实源是 `config/site.json`，运行时取值顺序为
   环境变量 `SITE_URL` → `config/site.json` 的 `siteUrl`。脚本内需要 URL 时用 node 读该文件，不要写字面量。
   （通知下线后可用的现成封装只剩 `tools/publish.sh` 的收尾提示。）
2. **禁止在 `dashboard/` 下放临时文件**。该目录整体发布到公网。
3. **站点产物同步**：改动 `data.js` / `screener.js` 后必须跑 `tools/export_json.js`
   （或直接跑 `bump_version.sh`，它已串联），否则前端轮询拿不到新版本。
4. **数据写入顺序**：`reports` 数组为「newest-at-bottom」，裁剪必须 `sort by date` 后 `slice(-7)`。
5. **推荐的个股代码必须用 `tools/check_codes.js` 反查校验**，不得凭模型记忆填写。
6. 不提交凭据、密钥、token 到仓库；只在 MEMORY.md 记录"位置"，不记录"值"。
7. 不擅自引入新框架/大依赖，先提方案。
8. 不动 `.workbuddy/` 目录。
9. **禁止改回 `workbuddy_sites_deploy` 沙箱部署**。看板部署形态是「GitHub Pages + 自有域名
   `https://asx.79zl.cn/`」，发布只走 `tools/publish.sh`。沙箱域名每次部署都变、空闲会停机，
   是历史上链接失效的根因。
10. **`.git/hooks/post-commit` 必须存在**（源文件 `tools/git-hooks/post-commit`）。它是本地提交
    自动上云的唯一通道，删除或丢失会导致数据停在本地、线上不更新。重建仓库后要重装该钩子。
11. **改 `.github/workflows/*.yml` 后必须做 YAML 语法校验**。`screener.yml` 曾因 `run:` 里跨行
    字符串导致解析失败，**整整 6 天从未成功运行过而无人察觉**。
12. **`publish.sh` 在无 `.gh-token` 时必须「跳过推送 + `exit 0`」**，不得报错退出。它被 4 个定时
    任务直接调用，一旦报错就会让每次运行都判为失败（数据其实已提交）。
13. **换行符由仓库根的 `.gitattributes` 固定**（`*.sh` 与 `tools/git-hooks/*` 强制 LF）。
    本机 `core.autocrlf=true`，若哪个环节把脚本写成 CRLF，bash 会直接报
    `bad interpreter: /bin/bash^M`，整条发布链路哑火且报错难查。
14. **`dashboard/calendar/` 图片必须只增"被引用"的**：`calendar` 数组只留最近 5 篇，
    磁盘图片靠 `tools/clean_calendar.js` 回收（`bump_version.sh` 已串联）。新下载的原图交给
    `tools/optimize_calendar.py` 压缩，**不要手工塞未压缩的长图**——它是站点体积最大的来源。
15. **不要在 `bump_version.sh` 之外单独跑 `git commit` + `bump_version.sh`**：`publish.sh`
    已串联全部收尾步骤，重复执行只会制造空提交。需要只提交不发布时，用 `git add -A && git commit`。
16. **写 `data.js` 的脚本必须保留安全阀**：**单一定义在 `tools/lib/data_store.js`**
    （`loadDataStrict()` 解析失败即中止 + `saveDataSafe()` 规模骤减拦截 + 乐观锁防并发覆盖）。
    `tools/verify.js`、`tools/screener.js`、`tools/check_codes.js`、`tools/sort_reports.js`
    **共同 require 这一份**，禁止各自复制或在本地重写。
    **禁止改回 `try { eval(...) } catch (e) {}` 那种静默降级**——data.js 一旦写坏，下一步就会把
    全部历史 reports 与 calendar 覆盖成空。改这些脚本后请用 `--dry`（选股）或沙箱验证安全阀仍生效。
    ⚠️ **适用对象是所有「写入型」脚本，不只上面点名的三个**：新增任何会重写 `data.js` 的脚本，
    必须走同一套安全阀，禁止裸 `fs.writeFileSync(DATA, ...)`
    （2026-09-14 审计发现 `check_codes.js --fix` 被漏掉：它跑一轮网络校验要几分钟，
    期间早报/晚报可能已改过 data.js，裸写会把对方成果整体覆盖）。
16b. **`bump_version.sh` 里的 `|| true` 只允许出现在「软步骤」上**：日历图压缩 / 孤儿图回收 /
    排序 / 休市日同步失败可以不阻塞发布；但 **`export_json.js` 是必需步骤，失败必须 `exit 1`**。
    它负责由 data.js 派生 data.json / version.json，失败时前端轮询拿到的仍是旧版本，
    而 publish.sh 照样 commit + push 并提示"发布成功"——症状是「看着成功、线上停在上一期」。
16c. **`config/trade_holidays.json` 的真实结构是 `{ note, years: { "2026": [...] } }`**：
    取休市日列表必须用 `.years[年份]`。曾误写成 `hs[年份]`（`health_site.js`），
    恒得 `undefined` → 所有节假日被判为交易日 → 每逢长假线上必误报「数据未更新」。
16d. **正则 / 过滤条件必须用真实数据跑一遍断言，不能只看代码"像是对的"**。
    已踩过两次：① `screener.js` 排除新股写 `/N\s|C\s/`（要求字母后跟空白），
    但 A 股新股名是 `N华虹`、次新是 `C华虹`，**中间根本没有空格** → 一个都匹配不到，形同虚设；
    ② `health_site.js` 取错结构层级（见 16c）。凡新增/修改筛选或匹配逻辑，
    至少跑：真实样本（从 `data.js` 抽 100+ 条）+ 边界用例（正例/反例各若干）两轮断言，
    并确认改动前后**结果集差异符合预期**。
17. **`evening` 有两套并行结构，别当成重复字段删掉**：`明日关注`（短线 Tab，带 picks 明细，
    由 verify.js 写 verify 标记）与 `板块热点`（晚报 Tab，扁平摘要）。**两者条数必须一致**，
    不一致时两个 Tab 会显示不同的板块数（`health_check.js` 会报警）。
18. **本地模式下唯一的停摆检测是 `node tools/health_check.js`**（`health_site.js` 只跑在云端
    workflow 里）。它用「交易日无数据 + `logs/<日期>.md` 是否存在」区分「数据源未发布」（正常）
    与「管线没跑」（真问题）。定期跑一次，或出问题时先跑它。
19. **「任务几点该有数据」只在 `dashboard/js/app.js` 的 `DUE` 常量里定义一次**。
    改任何任务时间时：先改 `DUE`，再改页面上出现的文案，最后跑
    `node tools/test_health_logic.js`（17 项断言，会捕获阈值/判定写错）。
    历史教训：`srcMeta()` 和 `renderHealth()` 曾各写一套阈值，量价任务后移到 15:10 时
    只改了一处，健康条每天 15:00 起误报「量价未更新」。
20. **改 `srcMeta()` / `renderHealth()` / `updateEveningDot()` 必须跑**
    `node tools/test_health_logic.js`。这三个函数是**时间相关**的判定，读代码极容易看走眼
    （周末还无法用真实页面触发，因为休市会短路）。测试脚本从 `app.js` 里按大括号配对抽出真函数，
    用假 Date / 假 DOM 跑断言 —— 抽出失败会直接报错，不会静默跳过。
    ⚠️ **不要把它改回 `_test_` 前缀**：`gh_push_api.js` 的 `SKIP_PATH` 正则会命中 `_test*`，
    把它当本地临时文件跳过 → 脚本永远上不了云端仓库（2026-09-14 踩过，改名即修）。
21. **GitHub Pages 的 Source 必须是 `GitHub Actions`，不能选 `Deploy from a branch`**：仓库根没有
    `index.html`，站点根是 `dashboard/` 子目录，而 `publish.yml` 用的正是
    `actions/upload-pages-artifact (path: dashboard)` + `actions/deploy-pages`。
    选分支模式会去发布仓库根，首页必 404。Pages 设置入口是**仓库级**
    `Settings → Pages`（账号级那个「已验证的域名」页与本站无关，别走错）。
    另注：**DNS 早已配好**（`asx` CNAME → `zoushiyun1999.github.io`，阿里云云解析），
    站点 404 时先查 Pages 而不是 DNS。
22. **`.gh-token` 必须是 fine-grained PAT，且同时具备两个权限**：`Contents: Read and write`
    （传数据/图片）与 `Workflows: Read and write`（推 `.github/workflows/` 的更新）。
    只给 Contents 会在 `POST /git/blobs` 报 **403 `Resource not accessible by personal access token`**；
    缺 Workflows 则会在建 tree/commit 阶段被拒。**注意 `.gh-token` 会被 `gh_push_api.js` 主动拦截，
    但 `publish.sh` 失败后不要重复跑**（会多刷一次版本号），直接 `node tools/gh_push_api.js` 重试即可。
23. **删文件禁止用「一条命令带多个路径」的 `git rm`**（尤其路径里含中文）。2026-09-14 实测：一条
    `git rm -q "tools/notify.js" … "docs/网页看板-….md"` 执行后，`tools/` 与 `docs/` 下**未被指定的
    20 多个文件也一起从工作区消失了**（index 里仍在，`git checkout HEAD -- tools docs` 可完整恢复，
    无永久损失）。安全做法：
    ① 优先用 Node 删除并**先 dry-run 打印命中列表**：
    `node -e 'const fs=require("fs");const hit=…;console.log(hit);hit.forEach(f=>fs.unlinkSync(f))'`；
    ② 或用 shell 通配符/目录名（尽量不出现中文路径参数）；③ **一次只删一个路径**，删完立刻
    `ls <目录>` + `git status --short` 核对数量。**任何批量删除后必须核对「删除条数 == 预期条数」**。
24. **`publish.sh` 内置陈旧锁守卫，不要绕过它手工删锁**：脚本开头会检测 `.git/index.lock`，
    仅当「锁存在且无活跃 git 进程」时自动清除并打印告警；有活跃 git 进程时**不干预**。
    背景：`.git/index.lock` 若因上一轮任务被中断（超时、调度重启）而残留，`publish.sh` 的
    第 1/4 步（刷版本号 + 导出 JSON）会**正常跑完**，第 2/4 步 git commit 才报
    `Unable to create index.lock: File exists` → **发布静默中断、数据只落一半**，
    而报错信息完全指向不了真因。2026-09-14 量价选股任务疑似因此长期无产出。
    维护提醒（改这段守卫时必看）：① `tasklist` 在 Git Bash 下要用**单破折号** `-FI`，
    `//FI` 会报「无效参数」；② `grep -c` 无匹配时输出 `0` 但**退出码为 1**，
    写成 `... || echo 0` 会拼出 `"0\n0"` 让 `[ -eq ]` 崩掉 —— 必须先取原始输出、
    再 `tr -d '[:space:]'` 清空白、最后兜底赋 0。
    手工救急时（守卫生效前）：确认无 git 进程 → `rm -f .git/index.lock` →
    **单独执行 `git add -A && git commit`，不要重跑 `publish.sh`**（会多刷一次版本号）。

25. **`docs/归档/` 是本地专用目录，绝不能进版本库或公开仓库**。两道闸门缺一不可：
    - `.gitignore` 的 `docs/归档/`（只管 `git commit`）
    - `tools/gh_push_api.js` 的 `SKIP_DIR` 里的 `归档`（**API 推送脚本不读 `.gitignore`**）
    背景：2026-09-14 归档旧工作区时，`post-commit` 钩子把 51 个归档文件（含旧项目
    `AGENTS.md/MEMORY.md`、`开机自动关机诊断报告.md`——里面写着主机名 `DESKTOP-NQT2JG0\zoush`、
    QClaw 会话 ID、注册表路径）直接推到了 **public** 仓库。已通过一次提交删除 49 个远端文件撤回。
    ⚠️ 只加 `.gitignore` 不够：**该脚本的 `collect()` 自己走目录树，完全不看 `.gitignore`**。
    新增任何"只留本地"的目录，**必须同时改 `SKIP_DIR`**。

> **通用教训**：本项目有两条独立的上传通道（`git commit` 与 `gh_push_api.js`），
> 任何"排除文件"的规则都要在**两处**各写一遍。只改一处 = 漏一半。

26. **「推荐效果验证」的口径必须写实盘，且 `at` 必须是行情日**。`verify` 字段固定为：
    ```json
    { "gain": 1.36, "hit": true, "price": 15.63, "code": "600410", "at": "2026-09-14",
      "open": 15.69, "openPct": 1.75, "buyRet": -0.38, "netRet": -0.58,
      "locked": false, "basis": "open-to-close", "by": "snapshot" }
    ```
    - `gain` / `hit` = **旧口径**，验证日收盘涨跌幅（相对昨收）。**保留只为向后兼容**，
      它不是实盘收益，前端展示应优先用 `buyRet` / `netRet`。
    - `buyRet` = 开盘买入 → 收盘卖出，毛收益%；`netRet` = 扣双边万五 + 印花千五。
      早报推荐 = 当日开盘买；晚报「明日关注」= **次一交易日**开盘买。
    - `locked`（一字板，开=高=低=收）**必须为 true 且 `netRet` 置 null** ——
      一字板买不进/卖不出，算进收益会系统性高估。统计时一律剔除。
    - `at` **必须是实际取行情的那一天**，不能写成推荐日。晚报的「明日」若尚无行情，
      **本轮不标**，留给下一交易日的任务，否则口径错位（2026-09-14 19:07 的晚报
      17 只就是待 09-15 才标）。
    - **`by` = 数据来源**（v6 起）：`'snapshot'` = 当日 push2delay 快照，`'hist'` = 历史日线。
      `verify.js` 的**幂等判据是 `by`，不是 `at`** —— 见规则 26b。
    - 行情池必须覆盖 **创业板 `m:0+t:80` / 科创板 `m:1+t:23` / 北交所 `m:0+t:81+s:2048`**，
      只取沪深主板会让这些推荐**永久无标记且不外报错**（2026-09-14 实测：全池 5913 只 vs 主板 3487 只）。
    - **历史缺口回补只允许走 `node tools/verify.js --rebuild`**（v6）。它按
      「早报=报告当日 / 晚报=次一交易日」重算应验日，用历史日线取行情，并把 `by` 写成 `'hist'`。
      **禁止再写「拿运行日快照填历史日期」的临时回补脚本**（规则 26b）。
      默认路径（21:40 定时跑）在写回前会自动追加一次**只处理「应验日 < 今天」**的回补遍历 ——
      PC 关机造成的缺口会在下次成功运行时自愈，且不触碰当天快照的判定。

26b. 🔴 **`verify` 的日期与数据可能对不上，判据必须基于「来源」而非「日期」**（2026-09-18 审计，
    本项目最严重的一次数据事故）。2026-09-14 那次回补把**运行日（09-14）的快照**写进了
    `at=09-07/09-09/09-10` 的记录，**33 条 verify 的 `at` 全部是错的**，而它们的 `at`
    **恰好等于各自主张的应验日** —— 所以：
    - **只看 `at === 应验日` 的幂等/校验逻辑永远发现不了这类错误**，必须靠 `by` 字段区分来源；
    - 那批数据使「开盘买入毛 +0.80% / 平均低开 -1.71%」的结论**完全失效**
      （修正后实测：平均**高开 +2.41%**，开盘买入毛 **-0.37%**、净 **-0.57%**，n=99）。
    - **任何"回补"都必须留可自证来源**：写 `by`，并让 `health_check.js` 的
      「verify 缺 by」WARN 保持为 0。
    - 自查手法：同一条记录在不同 `at` 下出现**完全相同的 open/buyRet** ⇒ 必然错标。
    - 数据源事实：`push2his.eastmoney.com`（含 `1.`/`2.` 前缀）在**本机不可达**
      （`UND_ERR_SOCKET`，实测 0/5），而 `push2delay` 可达但**无历史**（`dktotal: 0`）。
      历史日线用**腾讯** `web.ifzq.gtimg.cn/appstock/app/fqkline/get`（与 `screener.js` 同源）；
      **该域名在 Node 下必须 `require('dns').setDefaultResultOrder('ipv4first')`**，否则走 IPv6 被重置。

27. **判定"是否推送成功"要看 GitHub Actions runs，不要信脚本提示，也不要只 curl 站点**。
    - `publish.sh` 第 3/4 步与 `gh_push_api.js` 都可能报「✓ 无变化（扫描 N 个文件，全部与线上一致）」，
      **但这不等于没推上去** —— 它与本地 commit 同轮执行时，比对基线还是上一轮（2026-09-14 两次踩到）。
    - 站点也可能陈旧：GitHub Pages 返回 `Cache-Control: max-age=600`，最长 10 分钟看不到新数据。
    - **权威判据**：`GET /repos/zoushiyun1999/astock-dashboard/actions/runs?per_page=5`
      看最新 run 的 `head_sha` 与 `status / conclusion`；或逐文件比对本地 blob sha 与远端 tree
      （`git/ref/heads/main` → `git/commits/<sha>` → `git/trees/<tree>?recursive=1`）。
    - 正常耗时：push 后约 45s 完成，完成后站点即更新。

28. **失败必须落到 `logs/ALERT.md`（告警通道）**：通知已于 2026-09-12 下线，机器可见的失败出口
    只剩这一个（本地模式下 `health_check.js` 是唯一的停摆检测，规则 18）。写告警统一走
    `tools/lib/ops.js` 的 `appendAlert({stage,result,detail,fix})`（CLI：`--append-alert`），
    入口已接：`publish.sh` 各步、`git-hooks/post-commit`、`gh_push_api.js` 的 `fail()`、
    `bump_version.sh` 的 `export_json` 失败分支、`sort_reports.js` 的阀中止。**已处理完的条目请把
    其 `result` 改为 `CLOSED`**，否则 `health_check.js` 会一直报 ERROR。`logs/` 已在
    `gh_push_api.js` 的 `SKIP_DIR` 内，不会外传。

29. **发布链路有应用级互斥锁（`tools/lib/lock.sh`）**：`publish.sh` 开头 `lock_acquire` +
    `trap lock_release` 包住「bump → commit → push」全程；`bump_version.sh` 用 `lock_guard`
    **可重入**（环境变量 `PUBLISH_LOCK_HELD=1`，被 publish 调用时不再重复加锁，避免自死锁）。
    锁文件 `.git/astock-publish.lock`（在 `.git/` 内，天然不进版本库）。活性用 Git Bash 的
    `kill -0`（**绝不用 `tasklist`**，Windows PID 与 bash MSYS PID 不同名）；30 分钟超时兜底陈旧。
    仍被占用则 `exit 0` 跳过本次发布 + 写 ALERT（数据已在盘上，下次发布会自动带上）。
    **与规则 24 的陈旧 `index.lock` 守卫正交，不要互相替代。**

30. **`tools/backups/` 是本地快照目录，必须双闸门**：`.gitignore` 的 `tools/backups/`
    **与** `gh_push_api.js` 的 `SKIP_DIR` 里的 `backups`（规则 25 同构，只改一处 = 漏一半）。
    内容为 `data.js.<YYYYMMDD-HHmmss>`（HEAD 版），保留 7 份，由 `publish.sh` 成功收尾时
    `node tools/lib/ops.js --snapshot` 生成（失败不影响发布）。回滚：
    `cp tools/backups/data.js.<ts> dashboard/data.js && bash tools/publish.sh "回滚到 <ts>"`。

31. **`DUE` 新增 `verify: 1300`（次日验证 21:30→21:40）**：`srcMeta()` 有「次日验证」行、
    `renderHealth()` 有「🔬验证未跑」项。判定统一走顶层 `scRanToday()` / `verifyRanToday()`
    （量价判定只看 `date`，不看 `list.length`，规则 19/20）。改这三个函数仍必须跑
    `node tools/test_health_logic.js`（现有 35 项断言）。

32. **量价选股只写独立文件 `dashboard/screener.js`（`window.SCREENER`）**：`data.js` 的
    `data.screener` 已停写（`screener.js` 会 `delete data.screener`）。**唯一历史源是
    `dashboard/screener.js`**：脚本/体检/前端一律读它；`screener.js` 的「历史累积种子」也必须
    从它读（否则每次运行历史被重置为仅当日）。`export_json.js` 从 `data.json` 的 REPORTS 副本里
    剔除 `.screener`（顶层 SCREENER 仍在），消除 7.6% 重复传输。

33. 🔴 **`screener.js` 的「全市场 0 只」必须区分「非交易日」与「数据源故障」，两者绝不能都写成
    "入选 0 只"**。`main()` 在 `fetchMarket()` 之后有**上游闸门**，不得删除或绕过：
    - `market.length === 0` 且**非交易日** → 打印跳过原因后 `return`（不写盘）；
    - `market.length === 0` 且**是交易日** → `throw abortSc(...)` → `exit 2` + `ALERT(ABORT)`，
      **不写 `data.js`、不覆盖任何历史期**。
    背景：2026-09-21 东财 `push2*` 全系域名被本机网络持续重置，旧逻辑把一期**假的**
    `2026-09-21 / count=0` 写进了 `dashboard/screener.js`，而其 stdout 与「休市」**完全一致**，
    事后无法区分。⚠️ `config/trade_holidays.json` 必须取 `.years[年份]`（规则 16c），
    取错层级会让所有节假日被误判为交易日、闸门在假期误报故障。
    📌 **同一故障的另一处连带风险**：`check_codes.js` 也依赖 `push2delay`，网络故障期间跑
    `--fix --prune` 会把「请求失败」误判成「代码不存在」→ **剔除真实股票**。
    **故障未恢复前禁止运行该脚本。** 取证手法见 `.workbuddy/memory/DETAILS.md §11`。

34. **排查「数据源不通」必须做两步对照，不能只看 `fetch failed`**（2026-09-21 教训）：
    ① **同域对照**（同域名下其他主机能否通，如 `quote.eastmoney.com`）；
    ② **沙箱外进程对照**（换独立 shell 调系统 Web 客户端再试，排除 agent 工具沙箱限制）。
    同时记录 DNS 解析与**失败耗时**（几十 ms = 被重置；数十秒 = 超时，二者含义完全不同）。
    ⚠️ **若「换一种写法成功了一次」，不要急着下因果结论** —— 闪断窗口会骗人。2026-09-21 就曾把
    `dns.setDefaultResultOrder('ipv4first')` 误判为故障的修复（随后 IPv4 路径同样被重置）。
    判据必须看**持续成功率**（如每 10s × 15 次），而不是单次结果。

35. 🔴 **shell 脚本必须同时能在 Windows(Git Bash) 与 Linux(ECS) 上跑**。项目已从
    「只在 Windows 本机」变成「本机 + 阿里云 ECS」双端，任何 MSYS / Windows 专有构造
    在 Linux 上都会失败。**2026-09-21 部署 ECS 时一次性踩到三个**：
    - **`pwd -W`**（MSYS 专有）。`publish.sh` 开头有 `set -e` → 命令替换失败会让脚本
      **在该行整体退出（rc=2）**，后面 100 多行（含 git 提交与推送）**一行都不执行**；
      `post-commit` 没有 `set -e` 所以不崩，但变量变成**空串** → 去执行 `/tools/gh_push_api.js`
      → **钩子永远推送失败且不报错**（只打印一句「同步失败」），是最危险的静默故障。
      统一写法：`X="$(cd "$D" && pwd -W 2>/dev/null || printf '%s' "$D")"`。
      ⚠️ `bump_version.sh` 早有这个兜底，注释还写明「ubuntu runner 上会失败」——
      **修了一个地方、漏了另外两个**：改这类构造时务必全仓库 grep 一遍。
    - **`tasklist`**（Windows 专有）。`publish.sh` 用它统计活跃 git 进程，Linux 上命令不存在 →
      计数**恒为 0** → 退化成「只要有 `index.lock` 就无条件删除」，可能删掉正在进行的
      git 操作的锁。改为 `pgrep -c -x git` 优先、`tasklist` 兜底。
    - **硬编码 `/c/Users/…node.exe`**：均带 `[ -x "$p" ] || NODE_BIN="node"` 兜底，
      新脚本必须照抄这个模式（服务器上 `node` 在 PATH 里，见 `cron.sh` 的 PATH 补全）。
    **验证手法**：`enable -n pwd` 禁掉内建 + 往 PATH 前面放一个拒绝 `-W` 的假 `pwd`，
    即可在本机真实模拟 Linux（只改 PATH **遮不住** bash 内建 `pwd`，必须 `enable -n`）。
    断言要带对照组（「修复前的写法必须 rc=2」），否则无法证明模拟真的生效。

36. 🔴 **整页重载只在「前端代码」变化时发生 —— 靠 `index.html` 的 `<meta name="cv">` 与
    `version.json` 的 `code` 比对**（2026-09-24 起）。`tools/code_version.js` 把前端代码的
    **内容哈希**盖章进 index.html，`export_json.js` 再带进 version.json；客户端拿两者比对，
    不一致才 `location.replace()`。
    - **动机**：旧逻辑比对资源版本号 `?v=<时间戳>`，而它**每次 publish 都 bump**（3~5 次/天）
      且同时挂在 CSS 和 4 个 JS 上 → **纯数据更新也会整页重载**，用户观感「进去加载慢」。
      数据变化本就有 60s 的 `version.json` 轮询就地更新，重载只为代码服务。
    - 🔴 **`CODE_FILES` 只放 `index.html` / `css/style.css` / `js/app.js`**。把
      `data.js` / `screener.js` / `holidays.js` 塞进去会让这个修复**静默失效**（又退回"数据更新也重载"）。
      `test_scripts.js` 的 **#21** 组会拦住这种改动，并检查「已盖章的值 == 当前代码的哈希」（防漂移）。
    - 🔴 **归一化是必需的**：`index.html` 自己含 `?v=<时间戳>`，盖章又改写 meta 自身 →
      不先抹掉这两处，哈希就会跟着时间戳变（`normalizeHtml()` 里 `?v` 抹值、cv meta **整行删除**）。
      ⚠️ meta 必须**整行删（含换行）**，只抹 `content` 会让「未盖章 vs 已盖章」两种状态哈希不同，
      首次写进去的是错值、要跑两遍才收敛（2026-09-24 实测踩到）。
    - **改动前端后**：跑 `bash tools/bump_version.sh`（已串联）或单独 `node tools/code_version.js`；
      忘记盖章会被 #21.7 断言拦下。

37. 🔴 **推送/收尾前跑 `node tools/selfcheck.js`（改动前端后加 `--online`）**（2026-09-24 起）。
    它把本会话踩过的每一类 bug 固化成守卫：滑块公式两处一致（renderPicks vs positionSubGlider）、
    loadTrack 有 el.src 且失败清 TRACK_P、EMPTY_ICO 图标键合法、verifyBadge 调用点带 code+ch、
    cv 章不漂移、CSS 类有定义、数据契约（reports 升序/账本/track.js 结构）、两套单元测试。
    - 每条守卫对应一次真实事故（文件头有「案底」注释），**别删**；新增同类 bug 时**先加守卫再修**。
    - cron.sh 的 verify 分支在发布后软调用（失败只记 cron.log 不回滚）。
    - ⚠️ 守卫本身也会出 bug：selfcheck 首版就犯了两类 —— ① 哈希自己重新实现而不是复用
      `code_version.js` 导出的 `computeHash`（两处维护，算出不同值假报警）；② `check()` 不 await
      async 检查函数。**检查器与被检查代码同样要测**（负样本：临时破坏一处，确认会红再恢复）。
    - ECS 无浏览器，selfcheck 只做静态+数据+单测；CDP 截图/交互验证仍在本机做。

## 发布链路（改任何与"上线"相关的东西前先看这张图）

```
写数据 → bash tools/publish.sh "说明"
           ├─ 陈旧 git 锁守卫（锁存在且无 git 进程 → 自动清除，见硬性规则 24）
           ├─ bump_version.sh（版本号 + sort_reports + 日历图压缩/回收 + sync_holidays
           │                   + code_version 盖章 + export_json；见硬性规则 36）
           ├─ git commit
           ├─ .git/hooks/post-commit → tools/gh_push_api.js（GitHub Trees API）
           │    └─ 无 .gh-token 时：静默跳过，退出码 0（不阻塞本地提交）
           └─ 有 .gh-token 时 → GitHub Actions publish.yml → https://asx.79zl.cn/（约 1 分钟）
```

> 微信通知环节已于 2026-09-12 从链路中移除，不要在任何任务 prompt 里重新引入。

## 变更流程

先改文档（AGENTS.md / MEMORY.md），再改实践，不反过来。
