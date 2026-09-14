"""韭研公社采集器。

已验证（2026-09-11）实测结构：
  博主页 https://www.jiuyangongshe.com/u/{user_id} 为 Nuxt SSR，
  内联 window.__NUXT__ 中的 list:[...] 每条结构（字段顺序固定）：

    {comment_count:30, ..., stock_list:[{...},{stock_id:"...",name:"优彩资源",code:"sz002998"}],
     old_type:c, sync_time:"2026-09-11 07:53:01", type:c,
     title:"9月11日开盘必读资讯", content:"文章目录，建议按需查看...",
     sensitive_words:"习", article_id:"2gstt0j29y6",
     cover:"https:\\u002F\\u002Fcdn...", ...}

  注意：
    - article_id 是短 ID（[a-z0-9]{8,20}），出现在 title/content 之后。
    - 详情页 URL 形如 /a/{article_id}。
    - stock_list 首元素可能是变量引用（x/y/z），只有字面量才可解析。
    - 时间字段 create_time 通常不在列表里，用 sync_time 作为发布时间。
"""
from __future__ import annotations

import re
import json
import logging
from typing import Any, Optional

from .fetcher import Fetcher

log = logging.getLogger(__name__)

BASE = "https://www.jiuyangongshe.com"

# 以 title 为锚点切分条目（title 是每条最稳定的字段）
_ANCHOR = re.compile(r'\btitle:"((?:[^"\\]|\\.){1,200})"')

_F_CONTENT = re.compile(r'\bcontent:"((?:[^"\\]|\\.){0,3000})"')
_F_SYNC = re.compile(r'\bsync_time:"([^"]{0,30})"')
_F_CREATE = re.compile(r'\bcreate_time:"([^"]{0,30})"')
_F_AID = re.compile(r'\barticle_id:"([a-z0-9]{8,32})"')
_F_STOCK = re.compile(r'name:"([^"]{1,24})",code:"([a-z]{2}\d{6})"')
_F_COVER = re.compile(r'\bcover:"((?:[^"\\]|\\.){10,300})"')


def _unescape(s: str) -> str:
    if not s:
        return ""
    try:
        return json.loads(f'"{s}"')
    except Exception:  # noqa: BLE001
        return (
            s.replace('\\"', '"')
            .replace("\\u002F", "/")
            .replace("\\/", "/")
            .replace("\\n", "\n")
            .replace("\\t", " ")
        )


def _slice_blocks(html: str) -> list[str]:
    """以 title 为锚点把内联数据切成独立区块。

    上界取下一个 title 的位置，保证不串条。
    """
    hits = list(_ANCHOR.finditer(html))
    if not hits:
        return []

    blocks: list[str] = []
    for i, m in enumerate(hits):
        start = m.start()
        end = hits[i + 1].start() if i + 1 < len(hits) else min(len(html), start + 6000)
        blocks.append(html[start:end])
    return blocks


def _parse_block(block: str) -> Optional[dict[str, Any]]:
    t = _ANCHOR.search(block)
    if not t:
        return None
    title = _unescape(t.group(1)).strip()
    if not title or len(title) < 4:
        return None

    c = _F_CONTENT.search(block)
    s = _F_SYNC.search(block)
    cr = _F_CREATE.search(block)
    aid = _F_AID.search(block)
    cov = _F_COVER.search(block)

    stocks = [{"name": n, "code": c2} for n, c2 in _F_STOCK.findall(block)]
    # 去重
    uniq, seen = [], set()
    for st in stocks:
        k = st["code"]
        if k in seen:
            continue
        seen.add(k)
        uniq.append(st)

    pub = (cr.group(1) if cr else "") or (s.group(1) if s else "")

    return {
        "article_id": aid.group(1) if aid else "",
        "title": title,
        "content": _unescape(c.group(1)).strip() if c else "",
        "create_time": pub,
        "sync_time": s.group(1) if s else "",
        "stocks": uniq,
        "cover": _unescape(cov.group(1)) if cov else "",
        "url": f"{BASE}/a/{aid.group(1)}" if aid else "",
    }


class JiuyanUserCollector:
    """抓取韭研公社某个博主的最新文章列表。"""

    def __init__(self, source: dict, fetcher: Fetcher) -> None:
        self.src = source
        self.fetcher = fetcher

    def fetch(self, max_pages: int = 1) -> list[dict[str, Any]]:
        user_id = self.src["user_id"]
        author = self.src.get("author", "")
        items: list[dict[str, Any]] = []
        seen: set[str] = set()

        for page in range(1, max_pages + 1):
            url = f"{BASE}/u/{user_id}" + (f"/page/{page}" if page > 1 else "")
            html = self.fetcher.get(url)
            if not html:
                log.warning("博主页抓取失败: %s", url)
                continue

            page_items = []
            for b in _slice_blocks(html):
                p = _parse_block(b)
                if not p:
                    continue
                key = p["article_id"] or p["title"]
                if key in seen:
                    continue
                seen.add(key)
                p["author"] = author
                p["source_id"] = self.src["id"]
                p["source_label"] = self.src.get("label", "")
                page_items.append(p)

            log.info("韭研 %s 第 %d 页：命中 %d 条", author, page, len(page_items))
            items.extend(page_items)

        return items


# --------------------------------------------------------------------------
# 文章详情：正文 + 图片
# --------------------------------------------------------------------------
_DETAIL_IMG = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']')
_DETAIL_TAG = re.compile(r"<[^>]+>")


def _resolve_js_args(html: str) -> dict[str, Any]:
    """解析 Nuxt 的 IIFE 实参表。

    window.__NUXT__=(function(a,b,c,...){...}(v0,v1,v2,...));
    返回 {参数名: 实参值}，用于还原被压缩成变量的字段。
    """
    m = re.search(
        r"window\.__NUXT__=\(function\(([^)]*)\)",
        html,
    )
    if not m:
        return {}
    names = [n.strip() for n in m.group(1).split(",") if n.strip()]

    j = html.rfind("}(", m.start())
    if j < 0:
        return {}
    k = html.find(")", j)
    args_str = html[j + 2: k]
    if not args_str:
        return {}

    # 按顶层逗号切分
    args, depth, cur, in_str, esc = [], 0, "", False, False
    for ch in args_str:
        if in_str:
            cur += ch
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            cur += ch
        elif ch in "([{":
            depth += 1
            cur += ch
        elif ch in ")]}":
            depth -= 1
            cur += ch
        elif ch == "," and depth == 0:
            args.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        args.append(cur.strip())

    out: dict[str, Any] = {}
    for name, val in zip(names, args):
        v = val.strip()
        if v.startswith('"') and v.endswith('"'):
            out[name] = _unescape(v[1:-1])
        elif v in ("true", "false"):
            out[name] = v == "true"
        elif v.isdigit():
            out[name] = int(v)
        else:
            out[name] = None
    return out


def _detail_content(html: str) -> tuple[str, list[str], str, str]:
    """从文章详情页提取 (正文文本, 图片列表, 标题, 作者)。"""
    title, author = "", ""
    content_html = ""

    tm = re.search(r'\btitle:"((?:[^"\\]|\\.){2,300})"', html)
    if tm:
        title = _unescape(tm.group(1))

    # 作者：user:{user_id:g,nickname:"...",...,style_str:"..."}
    um = re.search(r'user:\{user_id:\w+,nickname:"((?:[^"\\]|\\.){1,60})"', html)
    if um:
        author = _unescape(um.group(1))

    cm = re.search(r'\bcontent:"((?:[^"\\]|\\.){20,})"', html)
    if cm:
        content_html = _unescape(cm.group(1))

    # 图片（正文内嵌）
    imgs: list[str] = []
    for src in _DETAIL_IMG.findall(content_html):
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = BASE + src
        if src.startswith("http"):
            imgs.append(src)
    # 兜底：直接从详情页找 cdn 图片
    if not imgs:
        for src in _DETAIL_IMG.findall(html):
            if "cdn.jiuyangongshe.com" in src:
                imgs.append(src if src.startswith("http") else "https:" + src)
    imgs = list(dict.fromkeys(imgs))

    # 正文纯文本
    text = re.sub(r"<img[^>]*>", " [图片] ", content_html)
    text = re.sub(r"</p>|<br\s*/?>", "\n", text)
    text = _DETAIL_TAG.sub("", text)
    text = _unescape(text)
    text = re.sub(r"[ \t\u3000]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    return text, imgs, title, author


class JiuyanArticleDetail:
    """抓取韭研公社文章详情（正文 + 图片）。"""

    def __init__(self, fetcher: Fetcher) -> None:
        self.fetcher = fetcher

    def fetch(self, item: dict[str, Any]) -> dict[str, Any]:
        url = item.get("url") or f"{BASE}/a/{item.get('article_id', '')}"
        if not url.rstrip("/").endswith(str(item.get("article_id", ""))):
            return item
        html = self.fetcher.get(url)
        if not html:
            return item

        text, imgs, title, author = _detail_content(html)
        if text and len(text) > len(item.get("content") or ""):
            item["content"] = text
        if imgs:
            item["images"] = imgs
        if title:
            item["title"] = title
        if author:
            item["author"] = author
        return item


class JiuyanCalendarCollector:
    """首页时间轴事件（备用源：事件数据为 JS 异步加载，当前多为空）。"""

    def __init__(self, source: dict, fetcher: Fetcher) -> None:
        self.src = source
        self.fetcher = fetcher

    def fetch(self) -> list[dict[str, Any]]:
        html = self.fetcher.get(BASE + "/")
        if not html:
            return []

        events: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for m in re.finditer(
            r'(\d{4}-\d{2}-\d{2})[\s\S]{0,300}?事件[\s\S]{0,100}?>([^<>]{2,90})<',
            html,
        ):
            key = (m.group(1), m.group(2).strip())
            if key in seen:
                continue
            seen.add(key)
            events.append({"date": key[0], "event": key[1]})

        log.info("投资日历时间轴：获得 %d 条事件", len(events))
        return events
