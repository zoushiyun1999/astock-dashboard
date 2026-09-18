#!/usr/bin/env bash
# 数据源连通性探测 —— 用于判断「把生成层搬到云端」是否可行。
# 在 GitHub Actions runner（海外 IP）上跑，逐项打印 HTTP 状态与响应片段。
# 本地跑（国内 IP）结果不代表云端，必须在 runner 上执行才有意义。
set -u
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

probe() {
  local name="$1" url="$2" ref="${3:-}"
  printf '\n== %s ==\n' "$name"
  local body code
  body=$(curl -s -m 25 -A "$UA" -H "Referer: ${ref:-https://quote.eastmoney.com/}" \
         -w '\n__HTTP__%{http_code}__SIZE__%{size_download}' "$url" 2>&1)
  code=$(printf '%s' "$body" | tail -1)
  printf '  status: %s\n' "$code"
  printf '  head  : %s\n' "$(printf '%s' "$body" | head -c 260 | tr -d '\n')"
}

probe "东财 push2delay 全市场列表" \
  "https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f3,f8,f10,f20"

probe "东财 push2delay 分时均线" \
  "https://push2delay.eastmoney.com/api/qt/stock/trends2/get?secid=1.603236&fields1=f1,f2,f3&fields2=f51,f53,f58&ndays=1&iscr=0"

probe "东财 历史K线 push2his（官方备用）" \
  "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.603236&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=1&end=20500101&lmt=3"

probe "新浪 日K（主源）" \
  "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh603236&scale=240&ma=no&datalen=3"

probe "腾讯 日K（备用）" \
  "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh603236,day,,,3,qfq"

printf '\n== 韭研公社 作者页（开盘必读） ==\n'
curl -s -m 30 -A "$UA" -o /tmp/jy.html \
  -w '  http=%{http_code} size=%{size_download}\n' \
  "https://www.jiuyangongshe.com/u/df07647c21594f8c9c382304128c08f3"
printf '  「开盘必读」出现次数: %s\n' "$(grep -o '开盘必读' /tmp/jy.html 2>/dev/null | wc -l)"
printf '  是否命中风控页: %s\n' "$(grep -ciE 'waf|captcha|验证' /tmp/jy.html 2>/dev/null)"

printf '\n== 本机出口 IP 归属 ==\n'
curl -s -m 15 https://ipinfo.io/json 2>/dev/null | head -c 300
printf '\n\n探测结束\n'
