"""SQLite 存储层：文章、事件、采集运行记录。"""
from __future__ import annotations

import json
import hashlib
import logging
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id    TEXT NOT NULL,
    source_label TEXT,
    author       TEXT,
    article_id   TEXT,
    url          TEXT,
    title        TEXT NOT NULL,
    content      TEXT,
    images       TEXT DEFAULT '[]',
    stocks       TEXT DEFAULT '[]',
    published_at TEXT,
    created_at   TEXT,
    content_hash TEXT UNIQUE,
    fetched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_source  ON articles(source_id);
CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at);

CREATE TABLE IF NOT EXISTS calendar_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL,
    event      TEXT NOT NULL,
    source_id  TEXT,
    fetched_at TEXT NOT NULL,
    event_hash TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_cal_date ON calendar_events(event_date);

CREATE TABLE IF NOT EXISTS runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slot       TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    new_items  INTEGER DEFAULT 0,
    status     TEXT,
    message    TEXT
);
"""


def content_hash(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update((p or "").encode("utf-8", "ignore"))
        h.update(b"\x1f")
    return h.hexdigest()


class Store:
    def __init__(self, db_path: str | Path) -> None:
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    # ---------------- articles ----------------
    def upsert_articles(self, items: Iterable[dict[str, Any]]) -> int:
        """插入新文章，返回新增条数（按 content_hash 去重）。"""
        new = 0
        now = datetime.now().isoformat(timespec="seconds")
        for it in items:
            url = it.get("url", "")
            title = (it.get("title") or "").strip()
            if not title:
                continue
            ch = content_hash(it.get("source_id", ""), url, title)
            cur = self.conn.execute(
                """INSERT OR IGNORE INTO articles
                   (source_id, source_label, author, article_id, url, title,
                    content, images, stocks, published_at, created_at,
                    content_hash, fetched_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    it.get("source_id"),
                    it.get("source_label"),
                    it.get("author"),
                    it.get("article_id"),
                    url,
                    title,
                    it.get("content", ""),
                    json.dumps(it.get("images", []), ensure_ascii=False),
                    json.dumps(it.get("stocks", []), ensure_ascii=False),
                    it.get("published_at") or it.get("create_time", ""),
                    it.get("create_time", ""),
                    ch,
                    now,
                ),
            )
            new += cur.rowcount
        self.conn.commit()
        return new

    def recent_articles(self, limit: int = 50, source_id: Optional[str] = None) -> list[dict]:
        sql = "SELECT * FROM articles"
        args: list[Any] = []
        if source_id:
            sql += " WHERE source_id = ?"
            args.append(source_id)
        sql += " ORDER BY COALESCE(created_at, fetched_at) DESC, id DESC LIMIT ?"
        args.append(limit)
        rows = self.conn.execute(sql, args).fetchall()
        return [self._row_to_dict(r) for r in rows]

    @staticmethod
    def _row_to_dict(r: sqlite3.Row) -> dict:
        d = dict(r)
        for k in ("images", "stocks"):
            try:
                d[k] = json.loads(d.get(k) or "[]")
            except Exception:  # noqa: BLE001
                d[k] = []
        return d

    # ---------------- calendar ----------------
    def upsert_events(self, events: Iterable[dict[str, Any]], source_id: str = "jy_calendar") -> int:
        new = 0
        now = datetime.now().isoformat(timespec="seconds")
        for e in events:
            date, ev = e.get("date", ""), (e.get("event") or "").strip()
            if not date:
                continue
            ch = content_hash(date, ev, source_id)
            cur = self.conn.execute(
                """INSERT OR IGNORE INTO calendar_events
                   (event_date, event, source_id, fetched_at, event_hash)
                   VALUES (?,?,?,?,?)""",
                (date, ev, source_id, now, ch),
            )
            new += cur.rowcount
        self.conn.commit()
        return new

    def upcoming_events(self, limit: int = 30) -> list[dict]:
        rows = self.conn.execute(
            """SELECT * FROM calendar_events WHERE event != ''
               ORDER BY event_date ASC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ---------------- runs ----------------
    def start_run(self, slot: str) -> int:
        cur = self.conn.execute(
            "INSERT INTO runs (slot, started_at, status) VALUES (?,?,?)",
            (slot, datetime.now().isoformat(timespec="seconds"), "running"),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def finish_run(self, run_id: int, new_items: int, status: str = "ok", message: str = "") -> None:
        self.conn.execute(
            "UPDATE runs SET ended_at=?, new_items=?, status=?, message=? WHERE id=?",
            (datetime.now().isoformat(timespec="seconds"), new_items, status, message, run_id),
        )
        self.conn.commit()

    def stats(self) -> dict[str, Any]:
        def scalar(sql: str, args: tuple = ()) -> int:
            return int(self.conn.execute(sql, args).fetchone()[0])

        return {
            "articles": scalar("SELECT COUNT(*) FROM articles"),
            "events": scalar("SELECT COUNT(*) FROM calendar_events"),
            "sources": scalar("SELECT COUNT(DISTINCT source_id) FROM articles"),
            "last_run": (
                dict(self.conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone())
                if scalar("SELECT COUNT(*) FROM runs") else None
            ),
        }

    def close(self) -> None:
        self.conn.close()
