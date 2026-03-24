# Backend Agent Guide

## OVERVIEW

Python FastAPI service handling metadata storage, file registration, and MTProto uploads via Telethon.

## STRUCTURE

```
backend/
├── main.py                    # FastAPI app entry, lifespan, CORS setup
├── app/api/routes.py          # REST endpoints (/api/v1/*)
├── app/services/
│   ├── config.py              # pydantic-settings configuration
│   ├── telethon_service.py    # Telethon MTProto client wrapper
│   ├── file_service.py        # File metadata operations (in-memory)
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
| Metadata storage | `app/services/file_service.py` | In-memory dict, needs database in production |

## CONVENTIONS

- **Settings**: Use `get_settings()` singleton from `app.services.config`
- **Service layer**: Singleton pattern via `get_<service>()` functions
- **Pydantic v2**: Use `BaseModel`, `Field`, `pydantic_settings`
- **Async**: All route handlers async, services use `async/await`
- **Logging**: Use `loguru.logger` throughout
- **File storage**: In-memory dict (demo), requires database for production

## ANTI-PATTERNS

- **Don't store files on backend** — files go directly to Telegram, backend only stores metadata
- **Don't use sync I/O in routes** — use async handlers, not `time.sleep()`
- **Don't hardcode config** — always read from environment via `get_settings()`