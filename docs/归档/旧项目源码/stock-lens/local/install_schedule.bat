@echo off
chcp 65001 >nul
REM ============================================================================
REM  Register a daily Windows Scheduled Task that refreshes stock-lens data.
REM
REM  Created from an XML definition (not from schtasks command-line switches)
REM  because the setting that matters here -- "run as soon as possible after a
REM  scheduled start is missed" -- has no command-line equivalent. This machine
REM  is not on 24/7, so a missed slot must be caught up on next boot.
REM
REM  Four triggers per day, matching RUN_HOURS in update.py:
REM    07:00  morning briefing      12:00  intraday refresh
REM    16:00  after close           22:00  evening recap
REM
REM  Pairing with the per-slot idempotency check inside update.py, the behaviour is:
REM    - booted at the slot time -> runs normally
REM    - powered off at that time -> runs shortly after the PC comes back on
REM    - that slot already ran   -> the catch-up run exits immediately (no dupes)
REM    - 02:00-06:59 boot        -> considered done if any slot of yesterday ran
REM ============================================================================

set "TASK=stock-lens-daily"
set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=python"
set "XML=%~dp0schedule\stock-lens-daily.xml"

echo [1/2] Generating task definition ...
"%PY%" "%~dp0mkschedule.py"
if errorlevel 1 goto :fail

echo.
echo [2/2] Registering scheduled task: %TASK%
schtasks /Create /TN "%TASK%" /XML "%XML%" /F
if errorlevel 1 goto :fail

echo.
echo OK. Runs 4x daily (07:00 / 12:00 / 16:00 / 22:00);
echo     if the PC is off at a slot time it runs after the next boot.
echo.
echo   Inspect : schtasks /Query /TN "%TASK%" /V /FO LIST
echo   Run now : schtasks /Run   /TN "%TASK%"
echo   Remove  : schtasks /Delete /TN "%TASK%" /F
echo.
pause
exit /b 0

:fail
echo.
echo FAILED. Try running this file as Administrator.
pause
exit /b 1
