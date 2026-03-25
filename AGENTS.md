# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-25
**Commit:** d795788
**Branch:** (current)

## ⚠️ IMPORTANT: Service Restart After Code Changes

**Both frontend and backend must be restarted after code changes.**

### Quick Restart

Run the restart script:
```cmd
D:\teledrive\restart.bat
```

### Manual Steps (if needed)

**Backend**
- Uses **SQLite database** (`backend/teledrive.db`) for persistent storage
- File metadata persists across restarts
- Code changes require restart to take effect

### Frontend
- Vite dev server (port **3000**) or preview server (port 4173)
- Code changes require restart

### Full Manual Steps (三步驟):

**1. 殺掉占用端口的 process（如果端口已被占用）**
```cmd
powershell -Command "Get-NetTCPConnection -LocalPort 8000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ }"
powershell -Command "Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ }"
```

**2. 啟動 Backend**
```cmd
start "" /b cmd /c "cd /d D:\teledrive\backend && python main.py"
```

**3. 啟動 Frontend**
```cmd
start "" /b cmd /c "cd /d D:\teledrive\frontend && npm run dev"
```

> 注意：端口占用檢查可省略 - 直接執行殺进程命令，如果端口未被占用會自動跳過。

### Database Location
- `D:\teledrive\backend\teledrive.db`

---

## OVERVIEW

Telegram Cloud Storage - A personal cloud storage system using Telegram as the backend. Files upload/download directly via MTProto - no server bandwidth usage.

## STRUCTURE

```
teledrive/
├── backend/              # Python FastAPI backend (port 8000)
│   ├── main.py          # Entry point
│   ├── teledrive.db     # SQLite database (persistent metadata)
│   ├── app/api/         # REST endpoints
│   ├── app/services/    # Business logic
│   │   ├── database.py  # SQLite database module
│   │   └── file_service.py  # File operations (SQLite-backed)
│   └── tests/           # Unit tests
├── frontend/            # React + TypeScript (Vite, port 3000)
│   ├── src/            # React source
│   └── dist/           # Production build
├── start.sh            # Launcher script
├── restart.bat         # Restart script (Windows)
└── generate_session.py # Telegram session generator
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Backend API | `backend/main.py` + `backend/app/api/routes.py` | FastAPI endpoints |
| Frontend entry | `frontend/src/main.tsx` | React bootstrap |
| File browser UI | `frontend/src/components/ChonkyDrive.tsx` | Chonky component |
| MTProto client | `backend/app/services/telethon_service.py` | Python Telegram client |
| Database | `backend/app/services/database.py` | SQLite operations |
| Config/env | `.env` / `.env.example` | API credentials |

## CONVENTIONS

- **Strict TypeScript**: `frontend/tsconfig.json` has `strict: true`, `noUnusedLocals`, `noUnusedParameters`
- **Build**: Frontend uses Vite (`npm run build` → `dist/`)
- **Python**: FastAPI with uvicorn, Pydantic v2
- **Entry**: Backend `python main.py`, Frontend `npm run dev`
- **Dual package.json**: Root only has playwright, frontend has real deps

## ANTI-PATTERNS (THIS PROJECT)

- **Files through backend**: NEVER - all file transfer bypasses server (direct MTProto)
- **Traditional upload**: No REST file upload - uses GramJS in browser → Telegram CDN
- **Forget to restart**: Backend state is in-memory + SQLite, changes require restart

## COMMANDS

```bash
# Restart (Windows)
restart.bat

# Development
./start.sh                          # Start both services
cd backend && python main.py        # Backend only
cd frontend && npm run dev          # Frontend only

# Build
cd frontend && npm run build        # Production build

# Setup
python generate_session.py          # Get Telegram session
cp .env.example .env && edit .env   # Configure
```

## NOTES

- No Docker required - pure Python + Node.js
- Backend stores metadata in SQLite (`teledrive.db`) - persists across restarts
- Uses both Telethon (backend) and GramJS (browser) for MTProto
- No formal CI/CD - manual deployment via shell scripts
- Minimal testing infrastructure - only unittest in backend