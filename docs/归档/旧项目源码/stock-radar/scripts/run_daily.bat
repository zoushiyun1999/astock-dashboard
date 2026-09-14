@echo off
REM ============================================================
REM stock-radar 采集入口（供 Windows 任务计划程序调用）
REM 用法： run_daily.bat morning|evening|calendar
REM ============================================================
setlocal

set SLOT=%1
if "%SLOT%"=="" set SLOT=all

set ROOT=%~dp0..
set PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe

cd /d "%ROOT%"

set LOGDIR=%ROOT%\data\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

set STAMP=%date:~0,4%%date:~5,2%%date:~8,2%
set LOGFILE=%LOGDIR%\run_%SLOT%_%STAMP%.log

echo [%date% %time%] start slot=%SLOT% >> "%LOGFILE%"
"%PY%" scripts\run.py --slot %SLOT% >> "%LOGFILE%" 2>&1
echo [%date% %time%] exit=%ERRORLEVEL% >> "%LOGFILE%"

endlocal
