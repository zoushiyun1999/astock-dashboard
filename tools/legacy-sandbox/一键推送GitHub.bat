@echo off
chcp 65001 >nul
title A股看板 - 推送到 GitHub
cd /d "%~dp0"

set "GH=C:\Program Files\GitHub CLI\gh.exe"
if not exist "%GH%" set "GH=gh"

echo.
echo ============================================
echo    A股看板  -  推送到 GitHub
echo ============================================
echo.
echo 这个脚本做两件事：
echo   1. 登录你的 GitHub 账号
echo   2. 创建仓库并把看板代码传上去
echo.
echo 第一部分需要你在浏览器里点几下，我会一步步提示。
echo.
pause

echo.
echo --------------------------------------------
echo  第一步：登录 GitHub
echo --------------------------------------------
echo.
echo 屏幕上会显示一段网址和一个 8 位授权码，形如 ABCD-1234
echo.
echo   请这样操作：
echo     1. 用浏览器打开那段网址
echo     2. 输入那 8 位授权码
echo     3. 点绿色的 Authorize github 按钮
echo.
echo 完成后回到这个窗口，它会自动继续。（可能需要等十几秒）
echo.
pause

"%GH%" auth login --web --git-protocol https
if errorlevel 1 goto fail

echo.
echo 登录成功！
echo.

echo --------------------------------------------
echo  第二步：创建仓库并推送代码
echo --------------------------------------------
echo.
echo 仓库名用 astock-dashboard，设为【公开】。
echo 必须公开：免费账号的私有仓库用不了 Pages。
echo 公开的只是简报内容，微信推送密钥存在 Settings 里，不会公开。
echo.
pause

"%GH%" repo create astock-dashboard --public --source=. --remote=origin --push
if errorlevel 1 goto fail

echo.
echo ============================================
echo   完成！
echo ============================================
echo.
echo 请往上翻，找到这一行：
echo     https://github.com/你的用户名/astock-dashboard
echo.
echo 那就是你的仓库地址，把它发给我。
echo.
pause
exit /b 0

:fail
echo.
echo ============================================
echo   出错了
echo ============================================
echo.
echo 请把这个窗口里的内容截图发给我，我来排查。
echo.
pause
exit /b 1
