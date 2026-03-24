# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-24
**Commit:** d795788
**Branch:** (current)

## ⚠️ IMPORTANT: Service Restart After Code Changes

Since the backend uses **in-memory storage** (`_files_metadata`), **any code changes require a service restart** to take effect.

### Restart Steps:

1. **Kill backend process**
   ```powershell
   # Find PID on port 8000
   netstat -ano | findstr ":8000"
   taskkill /F /PID <PID>
   ```

2. **Restart backend**
   ```powershell
   cd D:\teledrive\backend
   python main.py
   ```

3. **Rebuild frontend if changed**
   ```powershell
   cd D:\teledrive\frontend
   npm run build
   # Restart preview if needed
   ```

### Quick Restart Script:
```powershell
# Kill and restart backend
powershell -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess" | % { taskkill /F /PID $_ }
powershell -Command "Start-Process -FilePath 'python' -ArgumentList 'main.py' -WorkingDirectory 'D:\teledrive\backend' -NoNewWindow"
```

### Verify Services:
```powershell
curl http://localhost:8000/api/v1/files
curl http://localhost:4173
```

---

## OVERVIEW

Telegram Cloud Storage - A personal cloud storage system using Telegram as the backend. Files upload/download directly via MTProto - no server bandwidth usage.

## STRUCTURE

```
teledrive/
├── backend/              # Python FastAPI backend (port 8000)
│   ├── main.py          # Entry point
│   ├── app/api/         # REST endpoints
│   ├── app/services/    # Business logic
│   └── tests/           # Unit tests
├── frontend/            # React + TypeScript (Vite, port 5173)
│   ├── src/            # React source
│   └── dist/           # Production build
├── start.sh            # Launcher script
└── generate_session.py # Telegram session generator
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Backend API | `backend/main.py` + `backend/app/api/routes.py` | FastAPI endpoints |
| Frontend entry | `frontend/src/main.tsx` | React bootstrap |
| File browser UI | `frontend/src/components/ChonkyDrive.tsx` | Chonky component |
| MTProto client | `backend/app/services/telethon_service.py` | Python Telegram client |
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

## COMMANDS

```bash
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
- Backend stores only metadata (file_id, access_hash, message_id)
- Uses both Telethon (backend) and GramJS (browser) for MTProto
- No formal CI/CD - manual deployment via shell scripts
- Minimal testing infrastructure - only unittest in backend