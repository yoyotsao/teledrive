# Backend Agent Guide

## OVERVIEW

Python FastAPI service handling metadata storage, file registration, and MTProto uploads via Telethon.

## STRUCTURE

```
backend/
├── main.py                    # FastAPI app entry, lifespan, CORS setup
├── teledrive.db               # SQLite database for persistent metadata
├── app/api/routes.py          # REST endpoints (/api/v1/*)
├── app/services/
│   ├── config.py              # pydantic-settings configuration
│   ├── database.py            # SQLite database module (aiosqlite)
│   ├── telethon_service.py    # Telethon MTProto client wrapper
│   ├── file_service.py        # File metadata operations (SQLite-backed)
│   └── telegram_bot_service.py
├── app/models/schemas.py      # Pydantic models (FileInfo, FileListResponse, etc.)
└── tests/
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Config | `app/services/config.py` | pydantic-settings, env via `Settings.from_env()` |
| API routes | `app/api/routes.py` | All `/api/v1/*` endpoints |
| MTProto uploads | `app/services/telethon_service.py` | Telethon client, uploads to Saved Messages |
| Metadata storage | `app/services/file_service.py` | SQLite-backed via `app/services/database.py` |
| Database | `app/services/database.py` | SQLite operations, schema init |

## ⚠️ IMPORTANT: Backend Restart After Code Changes

**Backend uses SQLite database and in-memory state — any code changes require a service restart to take effect.**

### Quick Restart:

```powershell
# Method 1: Kill port 8000 process and restart
netstat -ano | findstr ":8000"
taskkill /F /PID <PID>
cd D:\teledrive\backend && python main.py
```

```powershell
# Method 2: PowerShell one-liner
powershell -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"
cd D:\teledrive\backend && python main.py
```

### Verify Services:
```powershell
curl http://localhost:8000/health
curl http://localhost:8000/api/v1/files
```

### Database Location
- `D:\teledrive\backend\teledrive.db`
- Uses SQLite with `aiosqlite` for async operations
- Tables: `files`, `upload_sessions`

## CONVENTIONS

- **Settings**: Use `get_settings()` singleton from `app.services.config`
- **Service layer**: Singleton pattern via `get_<service>()` functions
- **Pydantic v2**: Use `BaseModel`, `Field`, `pydantic_settings`
- **Async**: All route handlers async, services use `async/await`
- **Logging**: Use `loguru.logger` throughout
- **Database**: Use `get_database()` from `app.services.database` for SQLite operations
- **File storage**: Metadata stored in SQLite (`teledrive.db`), files go directly to Telegram

## ANTI-PATTERNS

- **Don't store files on backend** — files go directly to Telegram, backend only stores metadata
- **Don't use sync I/O in routes** — use async handlers, not `time.sleep()`
- **Don't hardcode config** — always read from environment via `get_settings()`
- **Don't forget to restart** — backend state is in-memory + SQLite, changes require restart