@echo off
setlocal
cd /d "%~dp0"
title MabarBang Launcher

echo ============================================================
echo   MABAR BANG - kikobooo x arvana prod
echo   Port: 5050 ^| Local Server (Windows)
echo ============================================================
echo.

:: 1. Otomatis Buka Blokir (Hapus Zone.Identifier jika diunduh dari web)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path '%~dp0' -Recurse -Include *.exe,*.bat -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1

:: 2. Jalankan MabarBang.exe
if exist "%~dp0MabarBang.exe" (
    echo [INFO] Menjalankan MabarBang.exe ...
    "%~dp0MabarBang.exe"
    goto end
)

if exist "%~dp0bin\mabarbang\MabarBang.exe" (
    echo [INFO] Menjalankan bin\mabarbang\MabarBang.exe ...
    "%~dp0bin\mabarbang\MabarBang.exe"
    goto end
)

echo [ERROR] MabarBang.exe tidak ditemukan!
pause

:end
if %ERRORLEVEL% neq 0 (
    echo.
    echo [WARNING] Aplikasi berhenti dengan error code: %ERRORLEVEL%
    pause
)
