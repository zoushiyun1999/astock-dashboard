#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
博主内容采集（早报 / 晚报 / 投资日历）
======================================

设计约束（与 stock-lens 无后台架构一致）：
  - 只用 Python 标准库（urllib），零第三方依赖
  - 跑完即退，不常驻
  - **不下载图片**：列表接口已带正文摘要，图片留在原站，前端点击原文跳转
  - 单源失败不影响其它源，失败时沿用上次留档

已实测的数据源（2026-09-11，全部免登录）：
  韭研公社  博主页 /u/{user_id}        Nuxt SSR，数据内联在 window.__NUXT__
  淘股吧    博客页 /blog/{blog_id}     纯 SSR，文章链接直出，但按时间正序

解析难点（已解决，勿重复踩）：
  1. __NUXT__ 是压缩后的 IIFE：字段可能被替换成变量（如 title 变成 x）。
     解法：按 title:"..." 锚点切区块，块内独立取字段。
  2. 淘股吧列表页按时间正序，翻页接口需登录。
     解法：抓首页全部条目，从标题解析日期后倒序取最新。
  3. 淘股吧图片懒加载（src 是占位符，真址在 data-original）——
     本项目不下载图片，此坑不影响，仅记录备查。
"""

import re
import json
import html as htmllib
import urllib.request
import urllib.error
import ssl
from datetime import datetime, timedelta, timezone

CN_TZ = timezone(timedelta(hours=8))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

TIMEOUT = 20

# 部分财经站点证书链不完整，仅对图片/静态资源场景放宽；
# 这里抓的是公开页面，禁用校验不影响数据可信度。
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE


# ------------------------------------------------------------------ 抓取

def http_get(url, referer=None):
    """GET 文本并返回 str；失败抛异常。"""
    headers = {
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=_SSL_CTX) as resp:
        raw = resp.read()
    return raw.decode("utf-8", errors="replace")


# ------------------------------------------------------------------ 工具

def _unescape(s):
    """把 JS 字符串字面量还原成普通文本。"""
    if not s:
        return ""
    try:
        return json.loads('"' + s + '"')
    except Exception:
        return (s.replace('\\"', '"')
                 .replace("\\u002F", "/")
                 .replace("\\/", "/")
                 .replace("\\n", "\n")
                 .replace("\\t", " "))


def _clean(text, limit=None):
    """压平空白，可选截断。"""
    t = re.sub(r"<[^>]+>", " ", text or "")
    t = htmllib.unescape(t)
    t = re.sub(r"\s+", " ", t).strip()
    if limit and len(t) > limit:
        t = t[:limit].rstrip() + "…"
    return t


# 开盘必读那类帖子的开头是固定目录（"文章目录，建议按需查看 1、要闻简讯 2、……"），
# 真正的内容在目录之后。直接截断只会得到一串章节编号，对读者零价值。
#
# 设计取舍：这里只做「剥离开头编号目录」这一件确定性高的事，不再去猜正文里
# 的小标题。试过用正则继续剥"一、盘前资讯 1、要闻简讯"，结果是投资日历这类
# 正常开头被连带削掉、早报正文被cut一半 —— 润色收益不稳，风险却是丢内容。
# 摘要的定位是"让人决定要不要点原文"，多留一句小标题完全可接受。
_JY_NUM = re.compile(r"(?<!\d)(\d{1,2})\s*[、.．]\s*")


def _strip_toc(text, limit=None):
    """去掉开头的编号式目录，返回正文摘要。

    做法是找「从 1 开始连续递增的编号序列」，序列断档处即为目录末尾。
    比单一正则稳，因为目录条目名长短不一（"要闻简讯"4 字 vs
    "盘前个股人气热度"8 字），定长匹配必然切歪。

    切割点取最后一个编号的起始位置：宁可留下末尾那条条目名（"12、调研点评"），
    也绝不多切一个字 —— 丢内容是比留噪声严重得多的错误。
    """
    t = text or ""
    if len(t) < 40:
        return _clean(t, limit)

    first = None
    want = 1
    end = 0
    for m in _JY_NUM.finditer(t[:600]):
        n = int(m.group(1))
        if n == 1 and first is None:
            first = m.start()
            want = 2
            end = m.start()
            continue
        if first is None:
            continue
        if n != want:
            break
        want += 1
        end = m.start()

    # 至少认到 5 条才算目录，避免把正文里的"1、"误当目录
    if first is not None and want >= 5 and end > 20:
        t = t[end:].lstrip(" ，,、。;；:：-—")
    return _clean(t, limit)


# ------------------------------------------------------------------ 韭研公社

JIYAN_BASE = "https://www.jiuyangongshe.com"

# 单条文章的锚点与字段
_JY_ANCHOR = re.compile(r'\btitle:"((?:[^"\\]|\\.){1,200})"')
_JY_CONTENT = re.compile(r'\bcontent:"((?:[^"\\]|\\.){0,4000})"')
_JY_CREATE = re.compile(r'\bcreate_time:"([^"]{0,30})"')
_JY_SYNC = re.compile(r'\bsync_time:"([^"]{0,30})"')
_JY_AID = re.compile(r'\barticle_id:"([a-z0-9]{8,32})"')
_JY_STOCK = re.compile(r'name:"([^"]{1,24})",code:"([a-z]{2}\d{6})"')


def _jiyan_blocks(page_html):
    """按 title 锚点把内联数据切块，避免跨条目串字段。"""
    hits = list(_JY_ANCHOR.finditer(page_html))
    out = []
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else min(len(page_html), m.start() + 6000)
        out.append(page_html[m.start():end])
    return out


def _jiyan_parse_block(block):
    t = _JY_ANCHOR.search(block)
    if not t:
        return None
    title = _unescape(t.group(1)).strip()
    if len(title) < 4:
        return None

    c = _JY_CONTENT.search(block)
    aid = _JY_AID.search(block)
    create = _JY_CREATE.search(block)
    sync = _JY_SYNC.search(block)

    stocks, seen = [], set()
    for name, code in _JY_STOCK.findall(block):
        if code in seen:
            continue
        seen.add(code)
        stocks.append({"name": name, "code": code})

    pub = (create.group(1) if create else "") or (sync.group(1) if sync else "")

    return {
        "title": title,
        "summary": _strip_toc(_unescape(c.group(1)), 400) if c else "",
        "publishedAt": pub,
        "stocks": stocks[:8],
        "url": f"{JIYAN_BASE}/a/{aid.group(1)}" if aid else JIYAN_BASE,
    }


def fetch_jiuyan_user(user_id, limit=12):
    """抓韭研公社某博主的最新文章。"""
    url = f"{JIYAN_BASE}/u/{user_id}"
    page = http_get(url, referer=JIYAN_BASE)

    items, seen = [], set()
    for block in _jiyan_blocks(page):
        p = _jiyan_parse_block(block)
        if not p:
            continue
        key = p["url"] or p["title"]
        if key in seen:
            continue
        seen.add(key)
        items.append(p)
        if len(items) >= limit:
            break

    if not items:
        raise RuntimeError("未解析到任何条目（页面结构可能已变更）")
    return items


# ------------------------------------------------------------------ 淘股吧

TGB_BASE = "https://www.tgb.cn"

_TGB_LINK = re.compile(
    r'href=["\'](?:https?://www\.tgb\.cn)?(/a/([A-Za-z0-9]{8,24}))["\'][^>]*>([^<]{2,120})'
)

# 标题里的日期：9.11 / 9-11 / 0911
_TGB_DATES = [
    re.compile(r"(\d{1,2})[.\-](\d{1,2})\s*[:：]"),
    re.compile(r"(\d{1,2})[.](\d{1,2})(?=[^\d])"),
    re.compile(r"(?<!\d)(\d{2})(\d{2})(?!\d)"),
]


def _tgb_infer_date(title, now=None):
    """从标题推断日期 -> YYYY-MM-DD。带合理性校验，避免把代码当日期。"""
    now = now or datetime.now(CN_TZ)
    for pat in _TGB_DATES:
        for m in pat.finditer(title):
            try:
                mo, day = int(m.group(1)), int(m.group(2))
            except (ValueError, IndexError):
                continue
            if not (1 <= mo <= 12 and 1 <= day <= 31):
                continue
            try:
                dt = datetime(now.year, mo, day, tzinfo=CN_TZ)
            except ValueError:
                continue
            # 跨年：若推断日期比今天晚 30 天以上，视为去年
            if (dt - now).days > 30:
                dt = datetime(now.year - 1, mo, day, tzinfo=CN_TZ)
            return dt.strftime("%Y-%m-%d")
    return None


def fetch_tgb_blog(blog_id, limit=6):
    """抓淘股吧某博主的最新文章（按标题日期倒序）。"""
    url = f"{TGB_BASE}/blog/{blog_id}"
    page = http_get(url, referer=TGB_BASE)

    rows, seen = [], set()
    for full, sid, title in _TGB_LINK.findall(page):
        title = title.strip()
        if sid in seen or not title:
            continue
        seen.add(sid)
        rows.append({
            "title": title,
            "summary": "",
            "publishedAt": (_tgb_infer_date(title) or "") and
                           (_tgb_infer_date(title) + " 22:00:00"),
            "stocks": [],
            "url": TGB_BASE + full,
            "_date": _tgb_infer_date(title) or "1970-01-01",
        })

    if not rows:
        raise RuntimeError("未解析到任何条目（页面结构可能已变更）")

    rows.sort(key=lambda r: r["_date"], reverse=True)
    for r in rows:
        r.pop("_date", None)
    return rows[:limit]


# ------------------------------------------------------------------ 对外入口

def build_sections(sources_cfg):
    """按配置采集全部博主源。

    返回 {section_key: {"ok":bool, "asOf":str|None, "error":str|None, "items":[...]}}
    """
    out = {}
    for spec in sources_cfg:
        key = spec["key"]
        try:
            if spec["type"] == "jiuyan":
                items = fetch_jiuyan_user(spec["id"], spec.get("limit", 12))
            elif spec["type"] == "tgb":
                items = fetch_tgb_blog(spec["id"], spec.get("limit", 6))
            else:
                raise RuntimeError(f"未知类型: {spec['type']}")

            for it in items:
                it["source"] = spec.get("label", key)
                it["author"] = spec.get("author", "")
            out[key] = {"ok": True, "asOf": None, "error": None, "items": items}

        except Exception as exc:  # noqa: BLE001 —— 单源失败隔离
            out[key] = {"ok": False, "asOf": None,
                        "error": f"{type(exc).__name__}: {exc}"[:160],
                        "items": []}
    return out
