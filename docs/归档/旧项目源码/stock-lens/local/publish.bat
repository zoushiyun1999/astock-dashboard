@echo off
chcp 65001 >nul
REM ============================================================================
REM  stock-lens: refresh data, then publish the static site to EdgeOne Makers.
REM
REM  This is the whole "deployment" step for the serverless setup:
REM    update.py     pulls data and writes web/data.js   (runs locally)
REM    edgeone ...   uploads web/ to the edge network    (free, no server)
REM
REM  First run only: you must log in once (a browser window opens).
REM      npx edgeone login --site china
REM  After that this script is a single double-click.
REM
REM  Where to see the site:
REM    - your own domain, once bound in the EdgeOne console
REM    - or the platform sub-domain shown at the end of a deploy
REM ============================================================================

set "PROJECT=stock-lens"
set "NODE_DIR=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-2"
set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=python"
if not exist "%NODE_DIR%\npx.cmd" set "NODE_DIR="

cd /d "%~dp0"

echo [1/2] Refreshing data ...
"%PY%" update.py
if errorlevel 1 (
  echo.
  echo Data refresh failed. See update.log for details.
  pause
  exit /b 1
)

echo.
echo [2/2] Publishing web/ to EdgeOne Makers ...
if defined NODE_DIR (
  call "%NODE_DIR%\npx.cmd" -y edgeone makers deploy ./web -n "%PROJECT%"
) else (
  call npx -y edgeone makers deploy ./web -n "%PROJECT%"
)
if errorlevel 1 (
  echo.
  echo Publish failed.
  echo If you have never logged in, run this once in a terminal:
  echo     npx edgeone login --site china
  pause
  exit /b 1
)

echo.
echo Done. The address printed above is your site.
pause
