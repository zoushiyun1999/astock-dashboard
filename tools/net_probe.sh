#!/usr/bin/env bash
# 数据源连通性探测 —— 用于判断「把生成层搬到云端」是否可行。
#
# 只在 GitHub Actions runner（海外 IP）上跑才有意义：本地跑的国内 IP 测不出海外可达性。
# 入口：仓库 Actions 页 → 「数据源连通性探测」→ Run workflow。
#
# 判定标准 —— **HTTP 200 不等于可用**（风控页同样返回 200，这是本项目踩过的坑）：
#   · 200 且命中断言子串   → 可用
#   · 200 但缺断言子串     → 疑似风控页 / 空数据
#   · 200 但命中风控关键词 → 疑似风控页
#   · 非 200               → 不可达
#
# 本脚本只读、不产生任何仓库改动；退出码恒为 0（它是诊断工具，不是门禁）。

set -u

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
OK=0; WARN=0; FAIL=0

# 注意：**不要用 curl -o 落盘**。Windows 原生 curl 会把 /tmp/x 解析成 C:\tmp\x，
# 而 MSYS 的 head/ls 读的是另一个 /tmp，导致「下载成功但读不到内容」的假故障
# （2026-09-19 实测：curl 报 size=227，文件却是 0 字节或不存在）。
# 把 body 与 meta 一起走 stdout，两个环境行为一致。
META_TAG='@@PROBE_META@@'

# probe <名称> <URL> <断言子串> [Referer]
probe() {
  local name="$1" url="$2" needle="${3:-}" ref="${4:-https://quote.eastmoney.com/}"
  local out meta code size body waf flag

  out=$(curl -s -m 30 --retry 1 --retry-delay 2 -A "$UA" -H "Referer: $ref" \
        -w "\n${META_TAG}%{http_code}|%{size_download}" "$url" 2>/dev/null)
  meta=$(printf '%s' "$out" | tail -n 1 | sed "s/.*${META_TAG}//")
  code=${meta%%|*}
  size=${meta##*|}
  body=$(printf '%s' "$out" | sed '$d')
  [ -z "$code" ] && code=000
  [ -z "$size" ] && size=0

  waf=$(printf '%s' "$body" | head -c 8000 | grep -ciE 'waf|captcha|滑块|验证码|访问受限|请求过于频繁|access denied|forbidden|安全验证' 2>/dev/null)
  [ -z "$waf" ] && waf=0

  if [ "$code" != "200" ]; then
    flag='不可达'; FAIL=$((FAIL + 1))
  elif [ -n "$needle" ] && ! printf '%s' "$body" | grep -q -- "$needle" 2>/dev/null; then
    flag='200 但缺断言子串（疑似风控/空数据）'; WARN=$((WARN + 1))
  elif [ "$waf" -gt 0 ]; then
    flag='200 但命中风控关键词'; WARN=$((WARN + 1))
  else
    flag='可用'; OK=$((OK + 1))
  fi

  printf '  %-24s http=%-4s size=%-9s %s\n' "$name" "$code" "$size" "$flag"
  printf '      resp: %s\n' "$(printf '%s' "$body" | tr -d '\n\r' | head -c 150)"
}

echo '=== A 方案核心：纯脚本生成层的数据源（screener.js / verify.js）==='
probe '东财 push2delay 全市场' \
  'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f3' \
  '"f12"'
probe '东财 push2delay 分时均线' \
  'https://push2delay.eastmoney.com/api/qt/stock/trends2/get?secid=1.603236&fields1=f1,f2,f3&fields2=f51,f53,f58&ndays=1&iscr=0' \
  '"trends"'
probe '东财 push2his 历史K线' \
  'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.603236&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=1&end=20500101&lmt=3' \
  '"klines"'
probe '新浪 日K' \
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh603236&scale=240&ma=no&datalen=3' \
  '"day"'
probe '腾讯 日K' \
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh603236,day,,,3,qfq' \
  'qfqday'

echo ''
echo '=== 抓取源：早报 / 晚报 / 投资日历 ==='
probe '韭研公社 作者页' \
  'https://www.jiuyangongshe.com/u/df07647c21594f8c9c382304128c08f3' \
  '韭研' 'https://www.jiuyangongshe.com/'
probe '韭研公社 文章页' \
  'https://www.jiuyangongshe.com/a/11d4kp8947p' \
  'content' 'https://www.jiuyangongshe.com/'
probe '淘股吧 博客页(湖南人)' \
  'https://m.tgb.cn/blog/444409' \
  'tgb' 'https://m.tgb.cn/'
probe '淘股吧 博客页(行鱼)' \
  'https://m.tgb.cn/blog/563404' \
  'tgb' 'https://m.tgb.cn/'

echo ''
echo '=== 未来可扩展平台（博主 / 平台扩容时用）==='
probe '同花顺' 'https://www.10jqka.com.cn/' '同花顺' 'https://www.10jqka.com.cn/'
probe '雪球'   'https://xueqiu.com/'          '雪球'   'https://xueqiu.com/'
probe '财联社' 'https://www.cls.cn/'          '财联社' 'https://www.cls.cn/'

echo ''
echo '=== runner 出口 IP 归属 ==='
curl -s -m 15 https://ipinfo.io/json 2>/dev/null | head -c 300

echo ''
echo ''
printf '汇总：可用 %d ｜ 存疑 %d ｜ 不可达 %d\n' "$OK" "$WARN" "$FAIL"
