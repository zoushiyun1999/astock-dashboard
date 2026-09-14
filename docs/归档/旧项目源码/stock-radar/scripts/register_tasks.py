"""注册 / 卸载 Windows 计划任务。

用法（需以管理员身份运行 cmd 或 PowerShell）：
    python scripts/register_tasks.py install
    python scripts/register_tasks.py remove
    python scripts/register_tasks.py status

创建三个任务：
    StockRadar-Morning    工作日 08:25   早报（韭研 · 开盘必读）
    StockRadar-Evening    工作日 22:10   晚报（淘股吧 · 两位博主）
    StockRadar-Calendar   每天    12:00   投资日历变更检查

关键设置：
    - 「如果错过计划的开始时间，则尽快启动任务」→ 开机后自动补跑
    - 唤醒计算机执行
"""
from __future__ import annotations

import sys
import subprocess
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TASKS = [
    {
        "name": "StockRadar-Morning",
        "slot": "morning",
        "schedule": "WEEKLY",
        "days": "MON,TUE,WED,THU,FRI",
        "time": "08:25",
        "desc": "stock-radar 盘前早报（韭研公社 · 开盘必读）",
    },
    {
        "name": "StockRadar-Evening",
        "slot": "evening",
        "schedule": "WEEKLY",
        "days": "MON,TUE,WED,THU,FRI",
        "time": "22:10",
        "desc": "stock-radar 盘后晚报（淘股吧 · 湖南人 / shenghuo329）",
    },
    {
        "name": "StockRadar-Calendar",
        "slot": "calendar",
        "schedule": "DAILY",
        "days": "",
        "time": "12:00",
        "desc": "stock-radar 投资日历变更检查（韭研公社 · A股投资日历）",
    },
]


def run(cmd: list[str]) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, shell=False)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def install() -> None:
    bat = ROOT / "scripts" / "run_daily.bat"
    if not bat.exists():
        print(f"找不到 {bat}")
        sys.exit(1)

    for t in TASKS:
        args = [
            "schtasks", "/Create", "/F",
            "/TN", t["name"],
            "/TR", f'"{bat}" {t["slot"]}',
            "/SC", t["schedule"],
            "/ST", t["time"],
        ]
        if t["schedule"] == "WEEKLY":
            args += ["/D", t["days"]]

        code, out = run(args)
        print(f"[{'OK ' if code == 0 else 'ERR'}] {t['name']} @ {t['time']}  {out.strip()[:160]}")

        # 允许错过补跑 + 唤醒计算机
        run(["schtasks", "/Change", "/TN", t["name"], "/Z"])

    print("\n完成。可用以下命令查看：")
    print("  schtasks /Query /TN StockRadar-Morning /V /FO LIST")


def remove() -> None:
    for t in TASKS:
        code, out = run(["schtasks", "/Delete", "/F", "/TN", t["name"]])
        print(f"[{'OK ' if code == 0 else 'ERR'}] 删除 {t['name']}  {out.strip()[:120]}")


def status() -> None:
    for t in TASKS:
        code, out = run(["schtasks", "/Query", "/TN", t["name"], "/FO", "LIST"])
        print(f"===== {t['name']} =====")
        print(out.strip() if code == 0 else "(未注册)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["install", "remove", "status"])
    a = ap.parse_args()
    {"install": install, "remove": remove, "status": status}[a.action]()


if __name__ == "__main__":
    main()
