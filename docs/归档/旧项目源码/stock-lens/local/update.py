#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stock-lens 本地数据更新脚本
============================

架构定位：这是「无后台」方案里的唯一可执行单元 —— 跑一次、拉数据、写文件、退出。
它不是一个服务，不占端口、不常驻内存，所以不存在"后端"。

产物：web/data.js   （写成 window.DATA = {...}，供静态页面用 <script src> 引入）

为什么要写成 .js 而不是 .json：
    浏览器在 file:// 协议下用 fetch('data.json') 会被同源策略拦截
    （file 被视为 opaque origin）。而 <script src="data.js"> 不受此限制。
    这是「双击 HTML 就能看、零服务器」能成立的关键。

降级策略：
    单项拉取失败时，自动沿用上一次的留档并在前端标注「数据陈旧 + 实际日期」。
    不假设失败后重跑就能恢复 —— 数据源由第三方维护，抖动是常态。
"""

import json
import os
import re
import subprocess
import sys
import glob
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent            # stock-lens 项目根
WEB_DIR = ROOT / "web"
DATA_JS = WEB_DIR / "data.js"
SNAPSHOT = ROOT / "data.snapshot.json"   # 纯 JSON 留档，便于降级读取与人工排查
LOG = ROOT / "update.log"
LOGS_DIR = ROOT / "logs"              # 多轮次运行时的分槽日志（见 run_slot）

# 每天要跑几个时段、各自什么时钟点。改这里即可调整更新频率。
# 顺序必须按时间升序 —— 运行时靠顺序定位"当前是第几轮"。
RUN_HOURS = [7, 12, 16, 22]

CN_TZ = timezone(timedelta(hours=8))
TIMEOUT = 90

# 博主采集模块在项目根的 src/ 下，按需导入（失败不影响行情取数）
sys.path.insert(0, str(PROJECT_ROOT))
try:
    from src.collectors.blogs import build_sections as collect_blogs
except Exception as _e:  # noqa: BLE001
    collect_blogs = None
    _BLOG_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"
else:
    _BLOG_IMPORT_ERROR = None


# ---------------------------------------------------------------- 基础设施

def current_slot():
    """当前处于当天第几轮（0-based）。

    判据：取 RUN_HOURS 里最靠近「现在」且不晚于现在的那一格。
    22:00 之后到次日 07:00 之前都算最后一轮。

    为什么不用「就近取整」：就近会让 20:59 落到 22 点的槽位，而 22 点的
    晚报彼时还没发布 —— 抓到的会是前一天的。宁可算作上一轮。
    """
    h = datetime.now(CN_TZ).hour
    slot = 0
    for i, hh in enumerate(RUN_HOURS):
        if h >= hh:
            slot = i
    return slot


def log(msg):
    line = f"[{datetime.now(CN_TZ):%Y-%m-%d %H:%M:%S}] {msg}"
    print(line)
    targets = [LOG]
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        targets.append(LOGS_DIR / f"slot{current_slot()}.log")
    except OSError:
        pass
    for p in targets:
        try:
            with open(p, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass


def load_config():
    with open(ROOT / "config.json", encoding="utf-8") as f:
        return json.load(f)


def resolve_node(cfg):
    explicit = (cfg.get("paths") or {}).get("node")
    if explicit and Path(explicit).exists():
        return explicit
    found = _which("node")
    if found:
        return found
    candidates = sorted(
        glob.glob(str(Path.home() / ".workbuddy" / "binaries" / "node" / "versions" / "*" / "node.exe")),
        reverse=True,
    )
    if candidates:
        return candidates[0]
    raise RuntimeError("找不到 node，请在 config.json 的 paths.node 里指定绝对路径")


def resolve_westock_tool(cfg):
    """定位 westock-tool 的打包 CLI（选股 / 排行 / 标签）。"""
    explicit = (cfg.get("paths") or {}).get("westock_tool_index")
    if explicit and Path(explicit).exists():
        return explicit
    pattern = str(
        Path.home() / ".workbuddy" / "plugins" / "cache" / "*"
        / "finance-data" / "*" / "skills" / "westock-tool" / "scripts" / "index.js"
    )
    hits = sorted(glob.glob(pattern))
    if hits:
        return hits[-1]          # 版本号最大者
    raise RuntimeError("找不到 westock-tool/scripts/index.js，请在 config.json 里指定绝对路径")


def resolve_westock_go(cfg):
    """定位 westock Go CLI（行情 / 板块 / 热搜）。"""
    explicit = (cfg.get("paths") or {}).get("westock_go")
    if explicit and Path(explicit).exists():
        return explicit
    for cand in (Path.home() / ".local" / "bin" / "westock.exe",
                 Path.home() / ".local" / "bin" / "westock"):
        if cand.exists():
            return str(cand)
    found = _which("westock")
    if found:
        return found
    raise RuntimeError("找不到 westock CLI，请在 config.json 里指定绝对路径")


def _which(name):
    from shutil import which
    p = which(name)
    if p:
        return p
    if os.name == "nt":
        p = which(name + ".exe")
        if p:
            return p
    p = which(name + ".cmd")   # npm 全局装的 CLI 在 Windows 上是 .cmd
    return p


def run(cmd):
    """执行命令并返回 stdout（UTF-8 解码，失败抛异常）。"""
    proc = subprocess.run(
        cmd,
        capture_output=True,
        timeout=TIMEOUT,
        cwd=str(ROOT),
    )
    out = proc.stdout.decode("utf-8", errors="replace").strip()
    err = proc.stderr.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0 and not out:
        raise RuntimeError(condense_error(err, proc.returncode))
    return out


def condense_error(stderr, code):
    """把多行堆栈压成一行摘要 —— 完整内容留在 update.log 的上下文里没意义，
    真正有用的是「哪一步、什么错」。"""
    for line in stderr.splitlines():
        line = line.strip()
        if not line or line.startswith(("at ", "^", "throw ", "}", "node:")):
            continue
        return f"exit={code} {line[:120]}"
    return f"exit={code}（无输出）"


def parse_md_table(text):
    """把 CLI 输出的 Markdown 表格解析成 list[dict]。"""
    lines = [l.strip() for l in text.splitlines() if l.strip().startswith("|")]
    if len(lines) < 2:
        return []
    header = [c.strip() for c in lines[0].strip("|").split("|")]
    rows = []
    for line in lines[1:]:
        body = line.strip("|")
        if set(body.replace("|", "").strip()) <= set("-: "):
            continue                      # 分隔行
        cells = [c.strip() for c in body.split("|")]
        if len(cells) != len(header):
            continue
        rows.append(dict(zip(header, cells)))
    return rows


def to_float(v, default=None):
    try:
        return float(str(v).replace(",", "").replace("%", ""))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- 数据拉取

# 各预设返回的关键指标字段不同（LowPE->PE_TTM、HighDividend->DividendRatioTTM、
# HighROE->ROEWeighted…），所以不能硬编码列，要保留「该预设自己的那几列」。
PICK_RESERVED = {"code", "name", "ClosePrice", "ChangePCT"}


def fetch_picks(tool_index, node, spec):
    """条件选股。--raw 返回严格 JSON，是唯一能直接吃到结构化结果的入口。"""
    out = run([node, tool_index, "filter", "--preset", spec["preset"],
               "--limit", str(spec.get("limit", 15)), "--raw"])
    data = json.loads(out)
    if isinstance(data, dict) and data.get("success") is False:
        raise RuntimeError(data.get("error", {}).get("message", "unknown"))
    if not isinstance(data, list) or not data:
        raise RuntimeError(f"返回空结果（原始: {out[:80]}）")
    items = []
    for r in data:
        metrics = {}
        for k, v in r.items():
            if k in PICK_RESERVED:
                continue
            f = to_float(v)
            if f is not None:
                metrics[k] = f
        items.append({
            "code": r.get("code", ""),
            "name": r.get("name", ""),
            "price": to_float(r.get("ClosePrice")),
            "chg": to_float(r.get("ChangePCT")),
            "metrics": metrics,
        })
    return items


def fetch_sectors(westock, limit):
    out = run([westock, "sector", "ranking"])
    rows = parse_md_table(out)
    if not rows:
        raise RuntimeError("板块排行返回空表")
    items = []
    for r in rows[:limit]:
        items.append({
            "name": r.get("name", ""),
            "code": r.get("code", ""),
            "chg": to_float(r.get("changePct")),
            "mainNetInflow": to_float(r.get("mainNetInflow")),
            "turnoverRate": to_float(r.get("turnoverRate")),
            "upCount": r.get("upCount", ""),
            "leader": r.get("leader", ""),
        })
    return items


def fetch_hot(westock, limit):
    out = run([westock, "hot", "sector"])
    rows = parse_md_table(out)
    if not rows:
        raise RuntimeError("热搜板块返回空表")
    items = []
    for r in rows[:limit]:
        items.append({
            "name": r.get("name", ""),
            "rank": r.get("rank", ""),
            "rankdelta": r.get("rankdelta", ""),
            "chg": to_float(r.get("zdf")),
            "heat": to_float(r.get("index")),
        })
    return items


def fetch_watchlist(westock, codes):
    if not codes:
        return []
    out = run([westock, "quote", ",".join(codes)])
    rows = parse_md_table(out)
    if not rows:
        raise RuntimeError("自选行情返回空表")
    by_code = {r.get("code"): r for r in rows}
    items = []
    for code in codes:                     # 保持用户配置的顺序
        r = by_code.get(code)
        if not r:
            continue
        items.append({
            "code": code,
            "name": r.get("name", ""),
            "price": to_float(r.get("price")),
            "chg": to_float(r.get("change_percent")),
            "turnoverRate": to_float(r.get("turnover_rate")),
            "pe": to_float(r.get("pe_ratio")),
            "pb": to_float(r.get("pb_ratio")),
            "chg5d": to_float(r.get("chg_5d")),
            "chg20d": to_float(r.get("chg_20d")),
            "mktCap": to_float(r.get("total_market_cap")),
        })
    return items


# ---------------------------------------------------------------- 降级与落盘

def load_previous():
    """读上一次的留档，用于单项失败时降级。"""
    if SNAPSHOT.exists():
        try:
            with open(SNAPSHOT, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            pass
    return {"generatedAt": None, "sections": {}}


def slot_done(prev, slot):
    """本轮次是否已经成功取过数 —— 「开机补跑」的幂等闸门。

    背景：本机不可能 7x24 开机。计划任务设了 StartWhenAvailable 后，错过的
    触发点会在下次开机时补跑；但补跑可能与正常触发撞车，所以必须能判断
    「这一轮干过了没有」。

    判据用 okCount > 0 而不是「跑过」：若整轮全部取数失败（数据源全挂），
    仍然允许后续重试，不能因为「试过一次」就把这一轮彻底锁死。

    02:00-06:59 属"深夜补跑"窗口：此时若昨日任一轮已成功，视为收工。
    否则开机瞬间会把前一天的每一轮依次补跑（最多 4 次全量请求），没有意义。
    """
    gen = (prev or {}).get("generatedAt")
    if not gen:
        return False
    now = datetime.now(CN_TZ)
    if (prev.get("okCount") or 0) <= 0:
        return False

    stamp = gen[:16]                       # YYYY-MM-DD HH:MM
    today = now.strftime("%Y-%m-%d")
    if stamp.startswith(today):
        # 当日：只有「上次成功就落在当前这一轮的时间窗里」才算跑过。
        # 用 == 而非 >=：早报跑完不该让中午那轮也跳过。
        return _slot_of_stamp(stamp) == slot

    # 深夜窗口（早于首个轮次，但还没到今天 07:00）
    if now.hour < RUN_HOURS[0] and gen.startswith((now - timedelta(days=1)).strftime("%Y-%m-%d")):
        return True
    return False


def _slot_of_stamp(stamp):
    """把 "YYYY-MM-DD HH:MM" 映射到轮次序号（0-based）。"""
    h = int(stamp[11:13])
    slot = 0
    for i, hh in enumerate(RUN_HOURS):
        if h >= hh:
            slot = i
    return slot


def section_ok(key, items, prev):
    return {"ok": True, "asOf": None, "error": None, "items": items}


def section_failed(key, err, prev):
    """拉取失败 -> 沿用上次留档，并明确标注数据日期。"""
    old = (prev.get("sections") or {}).get(key) or {}
    old_items = old.get("items") or []
    as_of = old.get("asOf") or prev.get("generatedAt")
    if old_items:
        log(f"  ! {key} 拉取失败（{err}）-> 降级使用 {as_of} 的留档，共 {len(old_items)} 条")
        return {"ok": False, "asOf": as_of, "error": str(err), "items": old_items}
    log(f"  ! {key} 拉取失败（{err}）-> 无历史留档可用")
    return {"ok": False, "asOf": None, "error": str(err), "items": []}


def write_outputs(snapshot):
    WEB_DIR.mkdir(parents=True, exist_ok=True)

    with open(SNAPSHOT, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)

    payload = json.dumps(snapshot, ensure_ascii=False)
    with open(DATA_JS, "w", encoding="utf-8") as f:
        f.write("// 由 update.py 自动生成，请勿手改。\n")
        f.write(f"window.DATA = {payload};\n")

    log(f"已写出 {DATA_JS}（{len(payload) / 1024:.1f} KB）")


# ---------------------------------------------------------------- 主流程

def main():
    log("=" * 56)
    log("stock-lens 本地数据更新开始")

    # --force 跳过当日幂等检查，用于手工排查或强制刷新
    force = "--force" in sys.argv[1:]
    prev = load_previous()

    if not force and slot_done(prev, current_slot()):
        log(f"本轮（第 {current_slot() + 1}/{len(RUN_HOURS)} 轮）今天已成功更新过"
            f"（{prev['generatedAt']}，{prev['okCount']}/{prev.get('totalCount', 5)} 成功）")
        log("本次跳过 —— 属于计划任务的开机补跑保护。强制重跑请加 --force")
        log("=" * 56)
        return 0

    cfg = load_config()
    try:
        node = resolve_node(cfg)
        tool_index = resolve_westock_tool(cfg)
        westock = resolve_westock_go(cfg)
    except RuntimeError as e:
        log(f"致命：{e}")
        return 2

    log(f"node        : {node}")
    log(f"westock-tool: {tool_index}")
    log(f"westock-go  : {westock}")

    sections = {}

    # 1) 条件选股（多组预设）
    log("[1/5] 条件选股")
    groups = []
    for spec in cfg.get("picks", []):
        key = f"picks::{spec['preset']}"
        try:
            items = fetch_picks(tool_index, node, spec)
            log(f"  + {spec['label']}（{spec['preset']}）{len(items)} 只")
            groups.append({"label": spec["label"], "preset": spec["preset"],
                           "ok": True, "error": None, "items": items})
        except Exception as e:              # noqa: BLE001 —— 单组失败不影响其它组
            old_groups = (prev.get("sections", {}).get("picks", {}) or {}).get("groups", [])
            old = next((g for g in old_groups if g.get("preset") == spec["preset"]), None)
            if old and old.get("items"):
                log(f"  ! {spec['label']} 失败（{e}）-> 沿用留档 {len(old['items'])} 只")
                groups.append({**old, "ok": False, "error": str(e)})
            else:
                log(f"  ! {spec['label']} 失败（{e}）-> 无留档")
                groups.append({"label": spec["label"], "preset": spec["preset"],
                               "ok": False, "error": str(e), "items": []})

    # 汇总各组的可用性
    picks_asof = prev.get("generatedAt")
    all_failed = all(not g["ok"] for g in groups) and groups
    sections["picks"] = {
        "ok": not all_failed,
        "asOf": picks_asof if any(not g["ok"] for g in groups) else None,
        "error": None,
        "groups": groups,
    }

    # 2) 热点板块
    log("[2/5] 热点板块")
    try:
        items = fetch_sectors(westock, cfg.get("sectors", {}).get("count", 15))
        log(f"  + 板块排行 {len(items)} 条")
        sections["sectors"] = section_ok("sectors", items, prev)
    except Exception as e:                  # noqa: BLE001
        sections["sectors"] = section_failed("sectors", e, prev)

    # 3) 热搜板块
    log("[3/5] 热搜板块")
    try:
        items = fetch_hot(westock, cfg.get("hot", {}).get("count", 12))
        log(f"  + 热搜板块 {len(items)} 条")
        sections["hot"] = section_ok("hot", items, prev)
    except Exception as e:                  # noqa: BLE001
        sections["hot"] = section_failed("hot", e, prev)

    # 4) 自选跟踪
    log("[4/5] 自选跟踪")
    try:
        items = fetch_watchlist(westock, cfg.get("watchlist", []))
        log(f"  + 自选行情 {len(items)} 只")
        sections["watchlist"] = section_ok("watchlist", items, prev)
    except Exception as e:                  # noqa: BLE001
        sections["watchlist"] = section_failed("watchlist", e, prev)

    # 5) 博主内容（早报 / 晚报 / 投资日历）
    log("[5/5] 博主内容")
    blog_specs = cfg.get("blogs", [])
    if not blog_specs:
        sections["blogs"] = {"ok": True, "asOf": None, "error": None, "groups": []}
        log("  - 未配置 blogs，跳过")
    elif collect_blogs is None:
        sections["blogs"] = {"ok": False, "asOf": None,
                             "error": _BLOG_IMPORT_ERROR, "groups": []}
        log(f"  ! 采集模块导入失败：{_BLOG_IMPORT_ERROR}")
    else:
        try:
            got = collect_blogs(blog_specs)
            groups = []
            for spec in blog_specs:
                key = spec["key"]
                sec = got.get(key) or {"ok": False, "error": "未返回", "items": []}
                if sec["ok"]:
                    log(f"  + {spec['label']} {len(sec['items'])} 条")
                    groups.append({"key": key, "label": spec["label"],
                                   "author": spec.get("author", ""),
                                   "ok": True, "error": None, "items": sec["items"]})
                else:
                    # 单源失败 -> 沿用上次留档
                    old_groups = (prev.get("sections", {}).get("blogs", {}) or {}).get("groups", [])
                    old = next((g for g in old_groups if g.get("key") == key), None)
                    if old and old.get("items"):
                        log(f"  ! {spec['label']} 失败（{sec['error']}）-> 沿用留档 {len(old['items'])} 条")
                        groups.append({**old, "ok": False, "error": sec["error"]})
                    else:
                        log(f"  ! {spec['label']} 失败（{sec['error']}）-> 无留档")
                        groups.append({"key": key, "label": spec["label"],
                                       "author": spec.get("author", ""),
                                       "ok": False, "error": sec["error"], "items": []})

            any_ok = any(g["ok"] for g in groups)
            stale = any(not g["ok"] for g in groups)
            sections["blogs"] = {
                "ok": bool(groups) and any_ok,
                "asOf": prev.get("generatedAt") if stale else None,
                "error": None,
                "groups": groups,
            }
        except Exception as e:              # noqa: BLE001
            sections["blogs"] = section_failed("blogs", e, prev)

    ok_count = sum(1 for k in ("sectors", "hot", "watchlist") if sections[k]["ok"])
    ok_count += 1 if sections["picks"]["ok"] else 0
    ok_count += 1 if sections.get("blogs", {}).get("ok") else 0

    snapshot = {
        "generatedAt": datetime.now(CN_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "okCount": ok_count,
        "totalCount": 5,
        "sections": sections,
    }
    write_outputs(snapshot)
    log(f"完成：{ok_count}/5 个板块取数成功")
    log("=" * 56)
    return 0


if __name__ == "__main__":
    sys.exit(main())
