### TeleDrive Core Development Instructions (V2026.4)

1. Critical Architecture Constraints
- Data Flow: Binary data MUST NOT touch Python backend (8000).
- Transfer Path: Telegram CDN <-> Browser (GramJS).
- Backend Role: SQLite Metadata only. NO file proxying.

2. Development Standards
- Port Locking: Port 8000 (Backend), Port 3000 (Frontend).
- Environment: Frontend variables MUST use VITE_ prefix.
- Verification: NO manual testing. Use Playwright MCP to verify.

3. Execution Commands
- Kill Backend: powershell -Command "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /F /PID $_.OwningProcess }"
- Kill Frontend: powershell -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /F /PID $_.OwningProcess }"
- Start Backend: cd backend && python main.py
- Start Frontend: cd frontend && npm run dev -- --port 3000 --strictPort
- Auto-Validation: skill(name="playwright", user_message="...")