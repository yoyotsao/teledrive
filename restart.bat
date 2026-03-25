@echo off
REM Teledrive Service Restart Script
REM Usage: restart.bat

cd /d D:\teledrive

echo [1/3] Killing existing processes...
powershell -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ }" 2>nul
powershell -Command "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ }" 2>nul
echo Done.

echo [2/3] Starting backend...
start "" /b cmd /c "cd /d D:\teledrive\backend && python main.py"

echo [3/3] Starting frontend...
start "" /b cmd /c "cd /d D:\teledrive\frontend && npm run dev"

echo.
echo Restart complete!
timeout /t 2 /nobreak >nul

powershell -Command "Get-NetTCPConnection -LocalPort 8000,3000 -State Listen -ErrorAction SilentlyContinue | Format-Table LocalPort, OwningProcess -AutoSize"