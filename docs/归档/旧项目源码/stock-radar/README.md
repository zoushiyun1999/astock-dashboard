# stock-radar · A股信息雷达

采集指定财经站点与博主内容 → 结构化摘要 → 静态网站展示，每天定时更新。

---

## 一、当前数据源（均已实测打通）

| 分类 | 源 | 入口 | 更新时点 | 状态 |
|---|---|---|---|---|
| **早报** | 韭研公社 · **开盘必读** | `jiuyangongshe.com/u/df0764…c08f3` | 每日 ~07:50 | ✅ |
| **晚报** | 淘股吧 · **湖南人** | `tgb.cn/blog/444409` | 每日 ~17:00 | ✅ |
| **晚报** | 淘股吧 · **shenghuo329（行鱼）** | `tgb.cn/blog/563404` | 每日 ~19:45 | ✅ |
| **投资日历** | 韭研公社 · **A股投资日历** | `jiuyangongshe.com/u/648089…c8b8` | 不定期（周末前后） | ✅ |

采集方式：**全部为免登录的 SSR 页面直读**，不涉及登录墙、付费墙、验证码绕过。

---

## 二、目录结构

```
stock-radar/
├── AGENTS.md                  项目约束
├── MEMORY.md                  长期记忆
├── config/
│   └── sources.yaml           源清单 + 调度配置（改这里加源）
├── src/
│   ├── collectors/
│   │   ├── fetcher.py         HTTP 抓取（限速 / 重试 / 统一 UA）
│   │   ├── jiuyan.py          韭研公社（博主列表 + 文章详情）
│   │   ├── tgb.py             淘股吧（博客列表 + 文章详情 + 懒加载图片）
│   │   └── images.py          图片落盘
│   ├── store/
│   │   └── db.py              SQLite（articles / calendar_events / runs）
│   └── app/
│       └── static/
│           ├── index.html     前端页面
│           ├── data.json      由采集脚本自动导出
│           └── images/        下载的图片
├── scripts/
│   ├── run.py                 采集主入口
│   ├── run_daily.bat          Windows 批处理包装（供计划任务调用）
│   └── register_tasks.py      注册 / 卸载 Windows 计划任务
└── data/
    ├── radar.db               SQLite 数据库
    ├── images/                图片
    └── logs/                  运行日志
```

---

## 三、快速开始

### 1. 环境

Python 3.13（已用托管 venv）：

```bash
PY="C:/Users/zoush/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
$PY -m pip install httpx pyyaml
```

### 2. 采集

```bash
$PY scripts/run.py --slot morning     # 早报
$PY scripts/run.py --slot evening     # 晚报（含正文 + 图片，约 5-8 分钟）
$PY scripts/run.py --slot calendar    # 投资日历
$PY scripts/run.py --slot all         # 全部

# 加速：跳过详情页（只要列表）
$PY scripts/run.py --slot evening --no-detail
```

跑完自动导出 `src/app/static/data.json`。

### 3. 打开网站

```bash
cd src/app/static
$PY -m http.server 8848
# 浏览器访问 http://localhost:8848
```

> 直接双击 `index.html` 会因为浏览器跨域策略读不到 `data.json`，**必须走 HTTP 服务**。

### 4. 注册定时任务（可选，需管理员权限）

```bash
$PY scripts/register_tasks.py install
$PY scripts/register_tasks.py status
```

创建三个任务：

| 任务名 | 时间 | 内容 |
|---|---|---|
| StockRadar-Morning | 工作日 08:25 | 早报 |
| StockRadar-Evening | 工作日 22:10 | 晚报 |
| StockRadar-Calendar | 每天 12:00 | 投资日历 |

---

## 四、知悉的技术细节（踩坑记录）

1. **韭研公社**用 Nuxt SSR，数据在内联 `window.__NUXT__` 中，
   但它被压缩成了 **IIFE 函数 + 实参表**（`title` 可能是变量 `x`）。
   破解方式：按 `title:"..."` 锚点切区块，再在每个区块内独立取字段。
   `user_id` 等字段若为变量，需解析函数签名与实参表按位置还原。

2. **淘股吧**博客列表页**按时间正序**（旧的在前），
   且翻页 AJAX 接口 `/user/blog/moreTopic` **需要登录**。
   解法：抓首页全部条目，**从标题解析日期**后倒序取最新。

3. **淘股吧图片是懒加载**：`src` 是 `placeHolder.png` 占位符，
   真实地址在 `data-original`。不处理会拿到一堆占位图。

4. **淘股吧正文容器** `.article-text.p_coten` 内部含
   `<!-- 设置播放器容器 -->` 这类中间注释，**不能当作结束标记**（会截断正文）。
   正确边界是尾部区块注释（`<!--打赏` / `<!--相关` / `<!--评论`）。

5. **韭研公社首页时间轴事件**是 JS 异步加载的，静态抓不到，已弃用该路径。

---

## 五、合规与边界

- 只采集**公开可访问**内容，遵守站点 robots 与使用条款。
- 不绕过登录、付费墙、验证码。
- 所有内容**保留原文链接与作者署名**，本站仅作摘要聚合，不整篇转载。
- 图片仅本地缓存用于个人阅读，版权归原作者所有。
- **不得对外提供荐股、买卖建议**；如需公开分享，应保留原站链接与风险提示。
