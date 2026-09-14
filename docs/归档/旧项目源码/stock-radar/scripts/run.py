"""stock-radar 采集调度入口。

用法：
    python scripts/run.py --slot morning      # 早报（韭研 · 开盘必读）
    python scripts/run.py --slot evening      # 晚报（淘股吧 · 两位博主）
    python scripts/run.py --slot calendar     # 投资日历（变更驱动）
    python scripts/run.py --slot all          # 全部
    python scripts/run.py --slot evening --no-detail   # 跳过详情页（更快）

每次跑完会自动导出前端数据到 src/app/static/data.json。
"""
from __future__ import annotations

import sys
import json
import argparse
import logging
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.collectors.fetcher import Fetcher                       # noqa: E402
from src.collectors.jiuyan import (                               # noqa: E402
    JiuyanUserCollector,
    JiuyanArticleDetail,
)
from src.collectors.tgb import TgbBlogCollector                   # noqa: E402
from src.collectors.images import download_images                 # noqa: E402
from src.store.db import Store                                    # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("radar")

SLOT_MAP = {
    "morning": "morning",
    "evening": "evening",
    "calendar": "on_change",
    "all": None,
}


def load_config() -> dict:
    with open(ROOT / "config" / "sources.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def build_fetcher(cfg: dict) -> Fetcher:
    fc = cfg.get("fetch", {})
    return Fetcher(
        user_agent=fc.get("user_agent"),
        timeout=fc.get("timeout_sec", 25),
        retry=fc.get("retry", 3),
        backoff=fc.get("retry_backoff_sec", 5),
        interval=fc.get("interval_sec", 3),
        referer="https://www.jiuyangongshe.com/",
    )


def run_slot(slot: str, with_detail: bool = True) -> dict:
    cfg = load_config()
    store = Store(ROOT / cfg["storage"]["sqlite_path"])
    fetcher = build_fetcher(cfg)
    img_dir = ROOT / cfg["storage"]["images_dir"]

    want = SLOT_MAP[slot]
    sources = [
        s for s in cfg["sources"]
        if s.get("enabled", True) and (want is None or s.get("schedule") == want)
    ]

    run_id = store.start_run(slot)
    total_new = 0
    detail: dict[str, int] = {}

    try:
        for s in sources:
            kind = s["kind"]
            label = s.get("label", s["id"])
            log.info("── 采集 %s (%s)", label, kind)
            items: list[dict] = []

            if kind == "jiuyan_user":
                col = JiuyanUserCollector(s, fetcher)
                items = col.fetch(max_pages=int(s.get("max_pages", 1)))

                # 只对最新若干篇抓详情，控制请求量
                limit = int(s.get("detail_limit", 3))
                if with_detail and items:
                    det = JiuyanArticleDetail(fetcher)
                    for it in items[:limit]:
                        det.fetch(it)

                if s.get("download_images"):
                    for it in items[:limit]:
                        saved = download_images(
                            it.get("images", []), img_dir, fetcher,
                            referer=s.get("url", ""),
                        )
                        it["local_images"] = saved

            elif kind == "tgb_blog":
                col = TgbBlogCollector(s, fetcher)
                items = col.fetch_list()
                if with_detail:
                    items = [col.fetch_detail(it) for it in items[:5]]
                else:
                    items = items[:5]
                # 标题推断的日期落入时间字段
                for it in items:
                    d = it.get("inferred_date", "")
                    if not it.get("published_at") and d and d != "1970-01-01":
                        it["published_at"] = f"{d} 22:00:00"
                    it["create_time"] = it.get("published_at", "")

                if s.get("download_images"):
                    for it in items:
                        saved = download_images(
                            it.get("images", []), img_dir, fetcher,
                            referer="https://www.tgb.cn/",
                        )
                        it["local_images"] = saved

            else:
                log.warning("未知采集器类型: %s", kind)
                continue

            n = store.upsert_articles(items)
            detail[s["id"]] = n
            total_new += n
            log.info("   %s：入库 %d 条", label, n)

        store.finish_run(run_id, total_new, "ok")
        log.info("✔ 完成 slot=%s 新增 %d 条 %s", slot, total_new, detail)

        export_frontend_data(store, cfg)
        return {"slot": slot, "new": total_new, "detail": detail, "stats": store.stats()}

    except Exception as exc:  # noqa: BLE001
        store.finish_run(run_id, total_new, "error", str(exc)[:500])
        log.exception("采集失败 slot=%s", slot)
        raise
    finally:
        fetcher.close()
        store.close()


def export_frontend_data(store: Store, cfg: dict) -> Path:
    """导出前端静态数据。"""
    out_dir = ROOT / "src" / "app" / "static"
    out_dir.mkdir(parents=True, exist_ok=True)

    sources_meta = {}
    for s in cfg["sources"]:
        sources_meta[s["id"]] = {
            "label": s.get("label"),
            "author": s.get("author"),
            "kind": s.get("kind"),
            "schedule": s.get("schedule"),
        }

    articles = store.recent_articles(limit=120)
    payload = {
        "generated_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "stats": store.stats(),
        "sources": sources_meta,
        "articles": articles,
        "events": store.upcoming_events(limit=40),
    }

    dest = out_dir / "data.json"
    dest.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log.info("前端数据已导出: %s (%d 篇)", dest, len(articles))
    return dest


def main() -> None:
    ap = argparse.ArgumentParser(description="stock-radar 采集器")
    ap.add_argument("--slot", required=True,
                    choices=["morning", "evening", "calendar", "all"])
    ap.add_argument("--no-detail", action="store_true",
                    help="跳过详情页抓取（更快，但正文/图片不全）")
    args = ap.parse_args()
    run_slot(args.slot, with_detail=not args.no_detail)


if __name__ == "__main__":
    main()
