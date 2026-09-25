# Bug 台账（append-only，勿改历史行）

> 规则（AGENTS 37，2026-09-24 用户要求）：**每个 bug 修完必须在这里记一行，并先固化守卫再修** ——
> 守卫 = `tools/selfcheck.js` 的静态检查或 `tools/test_*.js` 的断言。同类问题不允许第二次。
> 新行加在表格末尾。列：日期 | 现象 | 根因 | 修复 | 守卫。

| 日期 | 现象 | 根因 | 修复 | 守卫 |
|---|---|---|---|---|
| 09-22 | 晚报整份停摆：H8 硬门槛误拦「8天6板+炸板」 | 校验层做内容判断（风险词表收窄） | W7 警告 + 自动补「高位」 | test #20.22（12 项） |
| 09-23 | calendar 缺失时几乎所有晚报被 H3 拦死 | validateCalendar 被无条件调用（可选字段无守卫） | 加字段缺失守卫 | test 夹具必须含「删可选字段」用例 |
| 09-24 | 走势按钮「经常点不开」 | loadTrack 重写时丢 `el.src` → Promise 永久挂起 | 补回 + 12s 超时 | selfcheck「el.src 存在」 |
| 09-24 | 走势按钮一次失败后整个会话打不开 | 失败 Promise 缓存在 TRACK_P 不清空 | 失败清槽允许重试 | selfcheck「失败清 TRACK_P」 |
| 09-24 | 量价滑块偏 2px（收窄容器后暴露） | 滑块定位公式写两份且都错（百分比按 padding-box 解析） | `50%` / `calc(50%-2px)`，两处同步 | selfcheck「滑块公式两处一致」 |
| 09-24 | 推送后新访客触发多余整页重载 | 只推 index.html 未同步 version.json.code | 取线上 version.json 只改 code | selfcheck F2 + `--online` |
| 09-24 | 空态图标静默降级 | emptyCard 传 EMPTY_ICO 不存在的键 `'⏭'` | 改语义键 | selfcheck「EMPTY_ICO 键合法」 |
| 09-24 | 效果统计首列「早/报」竖排换行 | 5 个数字列挤压首列 | 首列 nowrap | CDP 目检（无自动守卫） |
| 09-24 | test 夹具假失败 4 项，报错误导排查方向 | 夹具把 reports 写成"最新在前"（契约是 newest-at-bottom） | 修夹具 | 夹具处注释 + AGENTS 硬性规则 4 |
| 09-24 | selfcheck 首版对 cv 假报警 | 漂移检查重新实现哈希而非复用 computeHash，归一化细节不同 | 改为 require 复用导出 | AGENTS 37：能 import 绝不复制 |
| 09-24 | selfcheck 线上检查全部记失败 | check() 不 await async 函数 | 新增 acheck | AGENTS 37：检查器也要负样本测 |
| 09-24 | CDP 真实点击偶发落空（查看原图/收起按钮，同页时好时坏） | `html{scroll-behavior:smooth}` 使 scrollIntoView 成为动画，测试在滚动前取坐标点到空地 | clickAt 改为「滚完等 900ms 再取坐标」 | DETAILS §4.2 记录姿势 |
| 09-24 | 日历预览推送后损坏（线上 1109655B ≠ 本地 612488B，浏览器无法解码） | gh_push_api 的 BINARY_EXT 白名单缺 .webp → 二进制按 UTF-8 文本读，非法字节变 U+FFFD | 白名单补 .webp/.avif，重推全部预览 | 线上检查文件头（selfcheck --online 可加）；AGENTS：新增二进制格式先加白名单 |
| 09-25 | 东财 clist 接口 node fetch 全挂（UND_ERR_SOCKET），且反复请求后连 curl 也被拉黑；ulist.np 却一直通 | clist 路径对 undici TLS 指纹风控；高频请求触发 IP 粘滞拉黑（本机已知常态，ECS 正常） | fetch→curl 双通道降级；本机调试用浏览器 JSONP 指纹或 --in 本地快照兜底 | AGENTS：新增二进制/数据源先确认双通道；--in 本地快照模式是排查标配 |
| 09-25 | 「医药」被匹配到「医药电商」（小板块）而非大类 | 包含匹配 tie-break 取"名字最短"，语义反了——博主说的大类对应成交额最大的板块 | 改为取 turnover 最大者；#23.2 断言锁行为 | selfcheck 无静态可查项，靠 #23.2 单测 |
