"""图片下载：把原站图片落盘到本地，避免外链失效。

原站图片（尤其复盘图）经常变更或需要 referer，
本地留一份可保证前端长期可读。

性能说明：
  图片是纯静态资源，对站点压力远小于页面请求，
  因此用线程池并发下载（默认 6 并发），不走 Fetcher 的限速逻辑。
"""
from __future__ import annotations

import hashlib
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable

import httpx

from .fetcher import DEFAULT_UA

log = logging.getLogger(__name__)

_EXT_MAP = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def _filename(url: str) -> str:
    """用 URL 哈希做文件名，保留原扩展名。"""
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
    tail = url.split("?")[0].rsplit(".", 1)
    ext = "." + tail[1].lower() if len(tail) == 2 and len(tail[1]) <= 5 else ".jpg"
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        ext = ".jpg"
    return h + ext


def download_images(
    urls: Iterable[str],
    out_dir: Path,
    fetcher=None,
    referer: str = "",
    workers: int = 6,
) -> list[str]:
    """并发下载图片，返回文件名列表。已存在的跳过。

    fetcher 参数保留是为了兼容调用方签名，实际不用其限速逻辑。
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    jobs: list[tuple[str, Path]] = []
    saved: list[str] = []
    for url in dict.fromkeys(urls):
        if not url or not url.startswith("http"):
            continue
        name = _filename(url)
        dest = out_dir / name
        if dest.exists() and dest.stat().st_size > 0:
            saved.append(name)
            continue
        jobs.append((url, dest))

    if not jobs:
        return saved

    headers = {"User-Agent": DEFAULT_UA}
    if referer:
        headers["Referer"] = referer

    def one(url: str, dest: Path) -> str | None:
        try:
            with httpx.Client(headers=headers, timeout=30,
                              follow_redirects=True, verify=False) as c:
                r = c.get(url)
                r.raise_for_status()
                if len(r.content) < 512:      # 过滤占位/错误图
                    return None
                dest.write_bytes(r.content)
                return dest.name
        except Exception as exc:  # noqa: BLE001
            log.debug("图片失败 %s: %s", url[:80], exc)
            return None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(one, u, d) for u, d in jobs]
        for f in as_completed(futs):
            name = f.result()
            if name:
                saved.append(name)

    log.info("图片：新增 %d / 共 %d", len(saved) - (len(urls) - len(jobs)), len(saved))
    return saved
