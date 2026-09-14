"""HTTP 抓取工具：统一 UA、超时、重试、限速。"""
from __future__ import annotations

import time
import random
import logging
from typing import Optional

import httpx

log = logging.getLogger(__name__)

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class Fetcher:
    """带限速与重试的同步抓取器。"""

    def __init__(
        self,
        user_agent: str = DEFAULT_UA,
        timeout: int = 25,
        retry: int = 3,
        backoff: float = 5.0,
        interval: float = 3.0,
        referer: Optional[str] = None,
    ) -> None:
        self.interval = interval
        self.retry = retry
        self.backoff = backoff
        self._last_request_at = 0.0
        headers = {"User-Agent": user_agent, "Accept-Language": "zh-CN,zh;q=0.9"}
        if referer:
            headers["Referer"] = referer
        self._client = httpx.Client(
            headers=headers,
            timeout=timeout,
            follow_redirects=True,
            verify=False,  # 部分财经站点证书链不完整
        )

    def _throttle(self) -> None:
        """确保请求之间至少间隔 interval 秒。"""
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.interval:
            time.sleep(self.interval - elapsed + random.uniform(0, 0.5))

    def get(self, url: str, **kwargs) -> Optional[str]:
        """GET 文本，失败重试。返回 None 表示彻底失败。"""
        for attempt in range(1, self.retry + 1):
            self._throttle()
            try:
                resp = self._client.get(url, **kwargs)
                self._last_request_at = time.monotonic()
                resp.raise_for_status()
                resp.encoding = resp.encoding or "utf-8"
                return resp.text
            except Exception as exc:  # noqa: BLE001
                self._last_request_at = time.monotonic()
                log.warning("抓取失败(%d/%d) %s -> %s: %s",
                            attempt, self.retry, url, type(exc).__name__, exc)
                if attempt < self.retry:
                    time.sleep(self.backoff * attempt)
        log.error("放弃抓取: %s", url)
        return None

    def get_bytes(self, url: str, **kwargs) -> Optional[bytes]:
        """GET 二进制（用于图片）。"""
        for attempt in range(1, self.retry + 1):
            self._throttle()
            try:
                resp = self._client.get(url, **kwargs)
                self._last_request_at = time.monotonic()
                resp.raise_for_status()
                return resp.content
            except Exception as exc:  # noqa: BLE001
                self._last_request_at = time.monotonic()
                log.warning("图片抓取失败(%d/%d) %s: %s", attempt, self.retry, url, exc)
                if attempt < self.retry:
                    time.sleep(self.backoff * attempt)
        return None

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Fetcher":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
