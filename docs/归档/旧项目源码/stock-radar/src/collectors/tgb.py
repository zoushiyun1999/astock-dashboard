"""淘股吧采集器。

实测结论（2026-09-11）：
  - 博主博客页 https://www.tgb.cn/blog/{blog_id} 纯 SSR、**免登录**，
    HTML 中直接包含文章链接 /a/{short_id} 与标题，一页约 31 篇。
  - 该列表页**按时间正序**（旧的在前），且翻页 AJAX 接口
    (/user/blog/moreTopic) 需要登录态，不可用。
  - 因此策略：抓首页全部条目 → 从标题解析日期 → 按日期倒序取最新 N 条。
    这两个博主都是「每日固定一篇」，标题规律稳定：
      湖南人      : 9.11湖南人涨停复盘+晚间消息汇总
      shenghuo329 : 行鱼复盘0911：xxxx
  - 详情页 https://www.tgb.cn/a/{short_id} 纯 SSR，
    正文容器 class="article-text p_coten"。
"""
from __future__ import annotations

import re
import logging
from datetime import datetime
from typing import Any, Optional

from .fetcher import Fetcher

log = logging.getLogger(__name__)

BASE = "https://www.tgb.cn"

_ARTICLE_RE = re.compile(
    r'href=["\'](?:https?://www\.tgb\.cn)?(/a/([A-Za-z0-9]{8,24}))["\'][^>]*>([^<]{2,120})'
)
_IMG_RE = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']')
_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)

# 标题里的日期：9.11 / 9.9 / 0911 / 2026-09-11
_DATE_PATTERNS = [
    re.compile(r"(\d{1,2})[.\-](\d{1,2})\s*[:：]"),   # 9.11: / 09-11:
    re.compile(r"(\d{1,2})[.](\d{1,2})(?=[^\d])"),    # 9.11（非时间）
    re.compile(r"(?<!\d)(\d{2})(\d{2})(?!\d)"),       # 0911（紧随"复盘"后）
]


def infer_date(title: str, today: Optional[datetime] = None) -> Optional[str]:
    """从标题推断文章日期，返回 YYYY-MM-DD。

    只接受合法月份/日期，并用「不能晚于今天太多」做合理性校验，
    避免把股票代码等数字误当日期。
    """
    now = today or datetime.now()
    for pat in _DATE_PATTERNS:
        for m in pat.finditer(title):
            try:
                mo, day = int(m.group(1)), int(m.group(2))
            except (ValueError, IndexError):
                continue
            if not (1 <= mo <= 12 and 1 <= day <= 31):
                continue
            year = now.year
            try:
                dt = datetime(year, mo, day)
            except ValueError:
                continue
            # 跨年处理：若推断出的日期比今天晚 30 天以上，认为是去年的
            if (dt - now).days > 30:
                dt = datetime(year - 1, mo, day)
            return dt.strftime("%Y-%m-%d")
    return None


def _strip_tags(html: str) -> str:
    text = re.sub(r"<script[\s\S]*?</script>", " ", html)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text)
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"</p>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    for a, b in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                 ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")]:
        text = text.replace(a, b)
    text = re.sub(r"[ \t\u3000]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _body_scope(html: str) -> str:
    """返回正文区域的 HTML 片段。

    article-text 容器内部的注释（如「设置播放器容器」）不能作为结束标记，
    实测真正的边界在其后很远。这里用尾部功能区块注释 + 长度上限双重约束。
    """
    start = re.search(r'<div[^>]+class="[^"]*article-text[^"]*p_coten[^"]*"[^>]*>', html)
    if not start:
        start = re.search(r'<div[^>]+class="[^"]*article-text[^"]*"[^>]*>', html)
    if not start:
        return ""

    tail = html[start.end(): start.end() + 200000]
    # 尾部区块：打赏 / 相关 / 评论 等，取最早出现的那个
    ends = [
        tail.find("<!--打赏"),
        tail.find("<!-- 打赏"),
        tail.find("<!--相关"),
        tail.find("<!-- 相关"),
        tail.find("<!--评论"),
        tail.find("<!-- 评论"),
    ]
    ends = [e for e in ends if e > 0]
    cut = min(ends) if ends else len(tail)
    return tail[:cut]


def _extract_body(html: str) -> str:
    """提取正文文本。"""
    scope = _body_scope(html)
    if not scope:
        return ""
    # 去掉内联的隐藏文本
    scope = re.sub(r'<span[^>]*display\s*:\s*none[^>]*>[\s\S]*?</span>', " ", scope)
    text = _strip_tags(scope)

    # 清理正文开头的导航噪声
    text = re.sub(
        r"^.*?声明：遵守相关法律法规[^\n]{0,120}\n?",
        "",
        text,
        count=1,
        flags=re.S,
    ) if "声明：遵守相关法律法规" in text[:600] else text

    # 去掉「话题与分类 / 主题股票 / 主题概念」这类模板行
    text = re.sub(r"话题与分类：[\s\S]{0,120}?主题概念：", "", text, count=1)
    text = re.sub(r"^[\[【]?\s*淘股吧\s*[\]】]?[\s\S]{0,60}?打赏Ta", "", text, count=1)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def _extract_images(html: str) -> list[str]:
    """提取正文图片。

    淘股吧图片为懒加载：src 是 placeHolder 占位符，
    真实地址在 data-original（src2 为 _max 变体）。
    """
    noise = ("icon", "logo", "medal", "close", "xiala", "avatar",
             "qrcode", "banner", "favicon", "loading", "placeholder",
             "classify_full", "newstock")
    scope = _body_scope(html)
    if not scope:
        return []

    out: list[str] = []
    for tag in re.findall(r"<img[^>]+>", scope):
        src = None
        for attr in ("data-original", "src2", "src"):
            m = re.search(attr + r'=["\']([^"\']+)["\']', tag)
            if m:
                cand = m.group(1)
                if "placeHolder" not in cand:
                    src = cand
                    break
                src = src or cand
        if not src:
            continue
        low = src.lower()
        if any(n in low for n in noise):
            continue
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = BASE + src
        if src.startswith("http"):
            out.append(src)
    return list(dict.fromkeys(out))


def _extract_meta(html: str) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    t = _TITLE_RE.search(html)
    if t:
        raw = _strip_tags(t.group(1))
        parts = [p.strip() for p in raw.split("_")]
        meta["title"] = parts[0]
        if len(parts) >= 2:
            meta["author"] = parts[1]
    m = re.search(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)", html)
    if m:
        meta["published_at"] = m.group(1)
    return meta


class TgbBlogCollector:
    """抓取淘股吧某博主的最新文章（按标题日期倒序）。"""

    def __init__(self, source: dict, fetcher: Fetcher) -> None:
        self.src = source
        self.fetcher = fetcher

    def fetch_list(self) -> list[dict[str, Any]]:
        blog_id = self.src["blog_id"]
        url = f"{BASE}/blog/{blog_id}"
        html = self.fetcher.get(url)
        if not html:
            log.warning("淘股吧博客页抓取失败: %s", url)
            return []

        raw: list[dict[str, Any]] = []
        seen: set[str] = set()
        for full, sid, title in _ARTICLE_RE.findall(html):
            title = title.strip()
            if sid in seen or not title:
                continue
            seen.add(sid)
            d = infer_date(title)
            raw.append(
                {
                    "article_id": sid,
                    "title": title,
                    "url": BASE + full,
                    "inferred_date": d or "1970-01-01",
                    "author": self.src.get("author", ""),
                    "source_id": self.src["id"],
                    "source_label": self.src.get("label", ""),
                }
            )

        # 按推断日期倒序，取最新 N 条
        raw.sort(key=lambda x: x["inferred_date"], reverse=True)
        max_items = int(self.src.get("max_items", 20))
        items = raw[:max_items]

        log.info(
            "淘股吧 %s：共 %d 条，最新 %s，取前 %d",
            self.src.get("author"),
            len(raw),
            items[0]["inferred_date"] if items else "-",
            len(items),
        )
        return items

    def fetch_detail(self, item: dict[str, Any]) -> dict[str, Any]:
        html = self.fetcher.get(item["url"])
        if not html:
            return item
        meta = _extract_meta(html)
        item["content"] = _extract_body(html)
        item["images"] = _extract_images(html)
        if meta.get("title"):
            item["title"] = meta["title"]
        item["published_at"] = meta.get("published_at", item.get("published_at", ""))
        return item
