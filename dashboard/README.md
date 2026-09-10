# 📊 A股速览 · 网页看板项目

移动端优先的每日简报看板：**早报**（8:30 盘前）+ **晚报**（21:00 复盘），卡片式排版，支持最近 7 天历史回看。

## 📁 项目结构

```
dashboard/
├── index.html          # 页面骨架（结构，一般不常改）
├── css/
│   └── style.css       # ✅ 样式表（改排版/配色/字号都在这）
├── js/
│   └── app.js          # ✅ 渲染逻辑（改板块展示方式、交互在这）
├── data.js             # ⚠️ 数据文件（定时任务自动写入，勿手改）
├── package.json        # 项目元信息 + 本地预览命令
└── README.md           # 本文件
```

## 🎨 怎么改排版和效果

| 想改什么 | 去哪里改 |
|---|---|
| 整体配色（主题蓝、涨红跌绿、背景色） | `css/style.css` 最上方 `:root` 变量 |
| 卡片圆角、阴影、间距 | `css/style.css` 的 `--radius`、`--shadow`、`.card` |
| 某板块的字号/颜色 | `css/style.css` 对应注释分区（如 `.news`、`.sector`） |
| 早报/晚报的板块顺序或内容 | `js/app.js` 的 `renderMorning()` / `renderEvening()` |
| Tab、日期切换、空状态文案 | `js/app.js` 的 `switchTab()` / `render()` / `emptyCard()` |
| 顶栏品牌名、Tab 文案 | `index.html` |

## 🚀 本地预览

直接双击 `index.html` 即可查看（无需任何环境）。

也可以用本地服务器预览（后续部署手机访问时同款方式）：

```bash
# 方式一：Node
npx serve . -l 8080        # 然后浏览器打开 http://localhost:8080

# 方式二：Python
python -m http.server 8080  # 然后浏览器打开 http://localhost:8080
```

## 🔗 数据来源

- `data.js` 由「A股推送系统」的两个定时任务（早报 8:30 / 晚报 21:00）自动写入
- 结构：`window.REPORTS = { updatedAt, reports: [{ date, morning, evening }] }`
- `morning` = 韭研公社·开盘必读摘要；`evening` = 湖南人/行鱼复盘总结 + 投资日历
- 保留最近 7 天，超出自动清理
