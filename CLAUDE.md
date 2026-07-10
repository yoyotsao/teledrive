# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

TeleDrive is a personal cloud storage system that uses Telegram as the storage backend. Files upload and download **directly between the browser and Telegram CDN via MTProto** — binary data never touches the Python backend server. The backend only stores metadata (filename, size, message_id, access_hash, parent_id) in SQLite.

## Commands

### Running the App (Docker)

```bash
docker compose up --build        # build and start
docker compose up -d --build     # background
docker compose down              # stop
docker compose logs -f backend   # follow backend logs
docker compose logs -f frontend  # follow frontend logs
```

### Rebuilding after code changes

```bash
docker compose up --build
```

### Frontend Build & Test

```bash
cd frontend
npm run build           # Production build → frontend/dist
npm run test:e2e        # Playwright E2E tests (headless)
npm run test:e2e:ui     # Playwright with UI
npm run test:e2e:debug  # Debug mode
```

### Session Setup

```bash
python generate_session.py  # Generate TELEGRAM_SESSION_STRING for .env
```

### Killing Ports (Windows — when running outside Docker)

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { taskkill /F /PID $_.OwningProcess }
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { taskkill /F /PID $_.OwningProcess }
```

## Architecture

### Data Flow — Upload

1. Browser generates thumbnail via Canvas API from the local file
2. Browser splits file into 512KB chunks (max 1000 per segment; larger files get a `split_group_id`)
3. Browser uploads chunks to Telegram via **GramJS**, embedding the thumbnail as the document's `thumb` on the final `sendFile`/`SendMultiMedia` call → gets `message_id` (no separate thumbnail message)
4. Small files (≤10MB) batch up to 10 at a time into a single `SendMultiMedia` album call to avoid FLOOD_WAIT
5. Browser calls `POST /api/v1/files/register` with metadata only (including `has_thumbnail`)
6. Backend stores metadata in SQLite — **no binary data**

### Data Flow — Download

1. Browser calls `GET /api/v1/files/{id}/download` to get `message_id` + `access_hash`
2. Browser downloads directly from Telegram CDN via **GramJS**
3. For split files, browser queries all parts by `split_group_id` and merges in order
4. Video streaming uses MediaSource API; Service Worker handles chunked delivery

### Backend (`backend/`)

- **FastAPI** + uvicorn, async throughout
- **Telethon** for MTProto operations (metadata only, no file data)
- **SQLite** via aiosqlite; single DB managed by `Database` class with `init_schema()`
- Service layer: `get_settings()`, `get_database()`, `get_file_service()` — all singletons
- All API routes under `/api/v1` in `app/api/routes.py`
- Pydantic v2 for request/response schemas in `app/models/schemas.py`
- loguru for logging throughout
- Thumbnail cache: `backend/thumbnails/{file_id}.jpg`

### Frontend (`frontend/src/`)

- **React 18 + TypeScript** (strict mode), bundled by Vite
- **GramJS** (`telegram` package) handles all MTProto browser-side operations — wrapped in `lib/gramjs.ts` (`TelegramClientManager`)
- **Chonky** (`@aperturerobotics/chonky`) powers the file browser UI in `components/ChonkyDrive.tsx`
- `lib/semaphore.ts` limits concurrent uploads (`MAX_UPLOAD_CONCURRENCY = 5`)
- `service-worker/index.ts` handles chunked downloads for media playback
- No CSS modules or Tailwind — all styling is inline
- API calls via `src/api/client.ts` (Axios, 5-min timeout); dev proxy routes `/api/v1` → `backend:8000`

### Docker (`docker-compose.yml`)

- **backend**: Python 3.11-slim, mounts `./backend` → `/app`, port 8000
- **frontend**: Node 20-alpine, mounts `./frontend` → `/app`, port 3000
- Both services use `env_file: .env`; frontend gets `BACKEND_URL=http://backend:8000` for inter-container routing

### Key Constants (`frontend/src/config.ts`)

| Constant | Value | Notes |
|---|---|---|
| `MAX_UPLOAD_CONCURRENCY` | 5 | Simultaneous uploads |
| `CHUNK_SIZE` | 512KB | MTProto hard limit |
| `MAX_PARTS_PER_FILE` | 1000 | Triggers file splitting |
| `CHUNK_RETRY_COUNT` | 3 | Retries per chunk |

## API Endpoints

All prefixed with `/api/v1`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/files` | List files (supports `parent_id`, `split_group_id`, pagination) |
| GET | `/files/{id}` | Get file metadata |
| POST | `/files/register` | Register uploaded file (after GramJS upload) |
| PATCH | `/files/{id}` | Update metadata (parent_id for move) |
| DELETE | `/files/{id}` | Delete file |
| GET | `/files/{id}/download` | Get download metadata (message_id, access_hash) |
| GET | `/files/{id}/thumbnail` | Get thumbnail as JPEG |
| GET | `/folders` | List folders |
| POST | `/folders` | Create folder |
| DELETE | `/folders/{id}` | Delete folder |

## Environment Variables

Create `.env` from `.env.example`:

```
TELEGRAM_API_ID=          # From my.telegram.org
TELEGRAM_API_HASH=        # From my.telegram.org
TELEGRAM_SESSION_STRING=  # From generate_session.py
BACKEND_HOST=0.0.0.0      # default
BACKEND_PORT=8000         # default
```

## Development Rules

- **完成修正後必須打開網頁確認成果** — 每次完成功能修改或 bug fix，必須實際在瀏覽器中開啟 `https://teledrive.yoyotsaoteledrive.dpdns.org` 驗證畫面正常、功能符合預期，不得僅憑程式碼審查宣告完成。

## Critical Constraints

- **Binary data must never pass through the Python backend** — this is the core architectural invariant. Upload/download is always browser ↔ Telegram CDN via GramJS.
- Max chunk size is 512KB (MTProto `LIMIT_INVALID` error if exceeded).
- Files >512MB (>1000 chunks) must be split into multiple records sharing a `split_group_id`.
- Do not add endpoints that read/write binary file data.
- Ports are fixed: backend 8000, frontend dev 3000.
- Thumbnails are embedded in the file's own Telegram message as a document thumb (`InputMediaUploadedDocument.thumb` / `sendFile`'s `thumb` option). To download a thumbnail, fetch ONLY the thumb PhotoSize (GramJS `downloadMedia(media, { thumb })`, Telethon `download_media(..., thumb=-1)`) — never the document body.
