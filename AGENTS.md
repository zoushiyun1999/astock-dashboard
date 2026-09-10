# AGENTS.md

> 项目级 Agent 工作约束。任何"干活"类请求开始前必读。

## 项目标识

- **项目名**：A股推送系统
- **根目录**：`C:\Users\zoush\WorkBuddy\A股推送系统`
- **创建日期**：2026-08-31
- **一句话目标**：每天自动把分散的股票信息整合成早报/晚报/选股/验证四类简报，输出到网页看板，并通过微信提醒。

## 技术栈

- 语言/运行时：Node.js 22（`~/.workbuddy/binaries/node/versions/22.22.2-2/`）、Python 3.13（仅工具脚本）
- 前端：原生 HTML/CSS/JS，无框架、无构建步骤，`dashboard/` 目录整体即站点
- 关键依赖：无第三方 npm 依赖（脚本全部零依赖，只用 Node 内置模块）
- 常用命令：
  - **一次发布（改完数据必跑）**：`bash tools/publish.sh "<说明>"`
  - **发布 + 等生效 + 微信通知**：`bash tools/publish_and_notify.sh morning|evening|screener [日期]`
  - **只发通知**：`node tools/notify_digest.js morning|evening|screener "<标题>"`
  - 刷新版本号 + 排序 + 导出 JSON：`bash tools/bump_version.sh`
  - 站点体检：`node tools/health_site.js`
  - 个股代码校验：`node tools/check_codes.js --fix --prune`
  - 数据体检：`node tools/health_check.js`
  - 本地预览：`python -m http.server <高位端口> --bind 127.0.0.1`（在 `dashboard/` 下）

## 工作约束

1. 结论先行，再给理由；不铺垫背景。
2. 默认中文；代码、命令、变量名用英文。
3. 方案有问题直接指出，不谄媚、不夸需求。
4. 需要选择时给 A/B/C 排序方案 + 权衡，不问"你确定吗"。
5. 改动前先读相关文件，不凭猜测编辑。
6. 破坏性操作（删除、重装、覆盖）必须先说明影响并等确认。
7. **前端样式/逻辑改动必须先本地截图验证再交付**——用户主用手机看，不能让他当测试员。方法见 `.workbuddy/memory/2026-09-06.md`（Edge headless 截图）。
8. **同一文件的多处 Edit 必须串行执行**，并行 Edit 有竞态且工具仍返回成功。

## 目录约定

```
config/            数据源与站点配置（sources.json / trade_holidays.json / site.json）
dashboard/         网站站点根目录（整体发布，勿放非站点文件）
  data.js          ⚠️ 定时任务写入，勿手改；data.json / version.json 由 export_json.js 派生，勿手改
  js/app.js        渲染逻辑与交互
  css/style.css    样式
tools/             生成、校验、导出、体检脚本（Node，零依赖）
logs/              每日运行日志（append-only）
docs/              方案与说明文档
.github/workflows/ 云端调度与发布
```

## 硬性规则（违反会导致线上故障）

1. **禁止硬编码访问链接**。链接唯一事实源是 `config/site.json`，运行时取值顺序为
   环境变量 `SITE_URL` → `config/site.json` 的 `siteUrl`。新链接产生时必须走 `tools/notify.js`。
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

## 发布链路（改任何与"上线"相关的东西前先看这张图）

```
写数据 → bash tools/publish.sh "说明"
           ├─ bump_version.sh（版本号 + sort_reports + export_json）
           ├─ git commit
           ├─ .git/hooks/post-commit → tools/gh_push_api.js（GitHub Trees API）
           └─ GitHub Actions publish.yml → https://asx.79zl.cn/（约 1 分钟）
         → node tools/notify_digest.js <type> "标题"（自动带 site.json 里的链接）
```

## 变更流程

先改文档（AGENTS.md / MEMORY.md），再改实践，不反过来。
