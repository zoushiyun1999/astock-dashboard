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
  - 微信通知相关命令（`notify_digest.js` / `notify.js`）**已于 2026-09-12 下线**，调用即空转，勿再使用

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
16. **写 `data.js` 的脚本必须保留安全阀**：`tools/verify.js` 与 `tools/screener.js` 用
    `loadDataStrict()`（解析失败即中止）+ `saveDataSafe()`（规模骤减拦截 + 乐观锁防并发覆盖）。
    **禁止改回 `try { eval(...) } catch (e) {}` 那种静默降级**——data.js 一旦写坏，下一步就会把
    全部历史 reports 与 calendar 覆盖成空。改这两个脚本后请用 `--dry`（选股）或沙箱验证安全阀仍生效。
17. **`evening` 有两套并行结构，别当成重复字段删掉**：`明日关注`（短线 Tab，带 picks 明细，
    由 verify.js 写 verify 标记）与 `板块热点`（晚报 Tab，扁平摘要）。**两者条数必须一致**，
    不一致时两个 Tab 会显示不同的板块数（`health_check.js` 会报警）。
18. **本地模式下唯一的停摆检测是 `node tools/health_check.js`**（`health_site.js` 只跑在云端
    workflow 里）。它用「交易日无数据 + `logs/<日期>.md` 是否存在」区分「数据源未发布」（正常）
    与「管线没跑」（真问题）。定期跑一次，或出问题时先跑它。
19. **「任务几点该有数据」只在 `dashboard/js/app.js` 的 `DUE` 常量里定义一次**。
    改任何任务时间时：先改 `DUE`，再改页面上出现的文案，最后跑
    `node tools/_test_health_logic.js`（17 项断言，会捕获阈值/判定写错）。
    历史教训：`srcMeta()` 和 `renderHealth()` 曾各写一套阈值，量价任务后移到 15:10 时
    只改了一处，健康条每天 15:00 起误报「量价未更新」。
20. **改 `srcMeta()` / `renderHealth()` / `updateEveningDot()` 必须跑**
    `node tools/_test_health_logic.js`。这三个函数是**时间相关**的判定，读代码极容易看走眼
    （周末还无法用真实页面触发，因为休市会短路）。测试脚本从 `app.js` 里按大括号配对抽出真函数，
    用假 Date / 假 DOM 跑断言 —— 抽出失败会直接报错，不会静默跳过。
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

## 发布链路（改任何与"上线"相关的东西前先看这张图）

```
写数据 → bash tools/publish.sh "说明"
           ├─ bump_version.sh（版本号 + sort_reports + 日历图压缩/回收 + sync_holidays + export_json）
           ├─ git commit
           ├─ .git/hooks/post-commit → tools/gh_push_api.js（GitHub Trees API）
           │    └─ 无 .gh-token 时：静默跳过，退出码 0（不阻塞本地提交）
           └─ 有 .gh-token 时 → GitHub Actions publish.yml → https://asx.79zl.cn/（约 1 分钟）
```

> 微信通知环节已于 2026-09-12 从链路中移除，不要在任何任务 prompt 里重新引入。

## 变更流程

先改文档（AGENTS.md / MEMORY.md），再改实践，不反过来。
