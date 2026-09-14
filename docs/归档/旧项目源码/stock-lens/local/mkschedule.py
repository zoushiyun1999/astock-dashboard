#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 Windows 计划任务定义（XML），供 install_schedule.bat 用 schtasks /XML 导入。
==============================================================================

为什么不直接用 `schtasks /Create /SC DAILY /ST 07:00`：

    那个命令行没有「错过后补跑」的开关。任务只在触发那一刻开火，
    电脑若处于关机状态就整天不跑 —— 而本机不可能 7x24 开机，这正是本项目的
    常态。对应的设置项 StartWhenAvailable 只存在于 XML 与 PowerShell 两种途径里；
    本机不能假定 PowerShell 执行策略开放，所以走 XML。

    配上 update.py 里的「按轮次幂等」检查，效果是：
        该轮时间点开机 -> 正常跑
        该轮时间点关机 -> 下次开机后自动补跑（若该轮已跑过则自动跳过，不重复取数）

为什么是 4 个触发点而不是 1 个：

    需求是「每天至少三次」+ 晚报 22:00 出。四个点的分工：
        07:00  早报（开盘必读 9 点前更新，7 点抓的是当天已发布的最新一篇）
        12:00  盘中刷新行情
        16:00  收盘后行情
        22:00  晚报（湖南人 / shengHuo329）
    时间表定义在 update.py 的 RUN_HOURS，两边必须一致 —— 幂等按轮次判断，
    这里少一个触发点就会导致某一轮永远不跑。

XML 必须是 UTF-16 编码，schtasks 只接受 Unicode 定义文件（UTF-8 会报错）。
"""

import json
import os
import re
import sys
import xml.sax.saxutils as sx
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "schedule"
OUT_XML = OUT_DIR / "stock-lens-daily.xml"

TASK_NAME = "stock-lens-daily"

# 与 update.py 的 RUN_HOURS 必须严格一致
RUN_HOURS = [7, 12, 16, 22]

TEMPLATE = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>stock-lens daily data refresh (4 slots/day; catches up on next boot if a slot was missed)</Description>
    <URI>\\{task}</URI>
  </RegistrationInfo>
  <Triggers>
{triggers}  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{python}</Command>
      <Arguments>"{script}"</Arguments>
      <WorkingDirectory>{cwd}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""

TRIGGER_TPL = """    <CalendarTrigger>
      <StartBoundary>{start}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
"""


def current_user_id():
    """任务主体标识，形如 DESKTOP-ABC\\zoush。

    不填 UserId 时 schtasks /XML 会报参数缺失，所以必须显式给出。
    取当前进程所属用户，而不是硬编码 —— 换机器/换账户都不用改脚本。

    域名来源按可靠性排序：USERDOMAIN 在 Git Bash 里也存在，而 COMPUTERNAME
    常常缺失（Git Bash 不导出它），所以不能只认后者。
    """
    user = os.environ.get("USERNAME") or ""
    domain = os.environ.get("USERDOMAIN") or os.environ.get("COMPUTERNAME") or ""
    if domain and user:
        return f"{domain}\\{user}"
    return user


def check_run_hours_match():
    """确认 update.py 的 RUN_HOURS 与本文件的定义一致。

    这两个值必须严格相同：调度按这里的时刻触发，而幂等按 update.py 的轮次
    判定。若只改了一边，会出现「某一轮永远不跑」或「同一轮重复取数」——
    两种都是静默故障，不报错，只表现为数据莫名不更新。所以在生成任务前
    主动比对一次，宁可报错也不要写出一个错的计划任务。
    """
    src = (ROOT / "update.py").read_text(encoding="utf-8")
    m = re.search(r"^RUN_HOURS\s*=\s*(\[[^\]]*\])", src, re.MULTILINE)
    if not m:
        print("警告：未能在 update.py 中找到 RUN_HOURS，跳过一致性校验")
        return
    other = json.loads(m.group(1).replace("'", '"'))
    if other != RUN_HOURS:
        raise SystemExit(
            f"RUN_HOURS 不一致：\n"
            f"  update.py     = {other}\n"
            f"  mkschedule.py = {RUN_HOURS}\n"
            f"两处必须相同，否则会出现「某一轮永远不跑」或「同一轮重复取数」。"
        )


def main():
    check_run_hours_match()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    python = sys.executable or "python"
    script = str(ROOT / "update.py")

    today = f"{datetime.now():%Y-%m-%d}"
    triggers = "".join(
        TRIGGER_TPL.format(start=f"{today}T{hh:02d}:00:00") for hh in RUN_HOURS
    )

    xml = TEMPLATE.format(
        task=sx.escape(TASK_NAME),
        triggers=triggers,
        user=sx.escape(current_user_id()),
        python=sx.escape(python),
        script=sx.escape(script),
        cwd=sx.escape(str(ROOT)),
    )

    # encoding="utf-16" 会写出带 BOM 的小端 UTF-16 —— schtasks 要求的正是这个
    with open(OUT_XML, "w", encoding="utf-16") as f:
        f.write(xml)

    print(f"已生成任务定义: {OUT_XML}")
    print(f"  任务名  : {TASK_NAME}")
    print(f"  触发时间: 每天 {len(RUN_HOURS)} 轮 — "
          f"{'、'.join(f'{h:02d}:00' for h in RUN_HOURS)}（错过则在下次开机后补跑）")
    print(f"  执行    : {python} {script}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
