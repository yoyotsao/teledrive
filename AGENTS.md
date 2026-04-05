# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-30
**Commit:** f105e35
**Branch:** master

---

## 🛑 核心架構紅線 (CRITICAL ARCHITECTURE CONSTRAINTS)

**在提出任何技術方案前，必須嚴格遵守以下紅線。若方案違反任一條，該方案即為「非法」，禁止提出：**

### 檔案流向絕對限制

- 檔案的二進位數據 (Binary Data) **嚴禁經過或觸碰 Python 後端 (port 8000)**
- 後端職責**僅限於**讀寫 SQLite、存取 message_id、access_hash 與 path 等 Metadata

### 下載/串流路徑限制

- **禁止**任何形式的「後端代理下載」或「後端轉發流」方案
- 所有檔案傳輸**必須**是：`Telegram CDN <-> Browser (GramJS)`

### 優化邏輯限制

- 任何關於播放、上傳的優化，**僅限於**前端邏輯
- 例如：調整 Buffer、Parallel chunks、WASM 處理
- **嚴禁**為了「實現功能」或「播放穩定性」而要求後端處理檔案流

---

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

- **Development**: Vite dev server (port **3000**) - `npm run dev`
- **Production**: Serve `dist/` folder with nginx/apache
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

---

## ARCHITECTURE RESPONSIBILITIES

### Backend (port 8000)

**職責：只讀寫 DB，存取 Telegram Message ID 與 Path**
- 讀寫 SQLite 資料庫 (`teledrive.db`)
- 儲存/讀取 **Telegram Message ID** - 用於定位 Telegram 上的檔案
- 儲存/讀取 **File Path** - 用於記錄資料夾層級結構
- **不處理任何檔案內容** - 檔案絕對不會傳到後端
- **不處理上傳/下載邏輯** - 只有存取 metadata

### Frontend (port 3000)

**職責：所有運算與檔案處理邏輯都在前端**
- **上傳**：使用 GramJS (瀏覽器 MTProto) 直接連接 Telegram CDN，完全繞過後端
- **下載**：使用 GramJS 直接從 Telegram CDN 下載，完全繞過後端
- **縮圖產生**：在前端使用 FFmpeg WASM 或 Canvas 產生影片/圖片縮圖
- **所有資料運算** - 檔案處理、壓縮、格式轉換、串流緩衝控制（Chunked streaming）
- 僅將最終的 `message_id` 和 `access_hash` 傳給後端儲存

### Telegram

**職責：直接與前端連接，儲存檔案與縮圖**
- 透過 MTProto (GramJS 前端) 連接
- **儲存檔案** - 檔案實際存放於 Telegram Saved Messages
- **儲存縮圖** - 縮圖也存於 Telegram
- 前端直接與 Telegram 交換資料，**後端不經手**

---

### 資料流向圖

```
上傳流程:
1. 前端產生縮圖 (Canvas/FFmpeg WASM)
2. 前端上傳縮圖至 Telegram → 取得縮圖 msg_id
3. 前端上傳檔案至 Telegram → 取得檔案 msg_id
4. 前端呼叫後端 POST /files/register (傳送 縮圖msg_id, 檔案msg_id, access_hash, path 等 metadata)
5. 後端寫入 SQLite DB

下載流程:
1. 前端呼叫後端 GET /files/{id} 取得 msg_id + access_hash
2. 前端使用 GramJS 直接從 Telegram CDN 下載檔案
```

---

## 開發守則 (SUMMARY)

| 行為 | 允許 | 禁止 |
|------|------|------|
| 檔案經過後端 | ❌ | 檔案絕對不經過後端 |
| 後端只存取 metadata | ✅ | 這是後端職責 |
| 後端處理下載流 | ❌ | 禁止 |
| 前端透過 GramJS 直接對 Telegram | ✅ | 這是設計目標 |
| 前端調整 Chunk 閾值 | ✅ | 這是前端優化的正確方向 |
| 後端代理 HTTP Stream | ❌ | 違反架構核心原則 |

---

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
│   ├── src/
│   │   ├── api/        # API client
│   │   ├── components/ # React components
│   │   ├── lib/        # GramJS, videoThumbnail
│   │   └── types/      # TypeScript interfaces
│   ├── dist/           # Production build
│   └── vite.config.ts  # Vite config
├── start.sh            # Launcher script
├── restart.bat         # Restart script (Windows)
└── generate_session.py # Telegram session generator
```

---

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Backend API | `backend/main.py` + `backend/app/api/routes.py` | FastAPI endpoints |
| Frontend entry | `frontend/src/main.tsx` | React bootstrap |
| File browser UI | `frontend/src/components/ChonkyDrive.tsx` | Chonky component, thumbnails, preview |
| GramJS wrapper | `frontend/src/lib/gramjs.ts` | Browser MTProto client (upload/download) |
| Video thumbnail | `frontend/src/lib/videoThumbnail.ts` | FFmpeg WASM video thumbnails |
| Database | `backend/app/services/database.py` | SQLite operations |
| Config/env | `frontend/.env` | Vite env vars (VITE_ prefix) |
| Vite config | `frontend/vite.config.ts` | Build config, polyfills |

---

## CONVENTIONS

- **Strict TypeScript**: `frontend/tsconfig.json` has `strict: true`, `noUnusedLocals`, `noUnusedParameters`
- **Build**: Frontend uses Vite (`npm run build` → `dist/`)
- **Dev server**: `npm run dev` (port 3000) - has API proxy
- **Preview**: `npm run preview` (port 4173) - static only, NO API proxy
- **Python**: FastAPI with uvicorn, Pydantic v2
- **Entry**: Backend `python main.py`, Frontend `npm run dev`

---

## ANTI-PATTERNS (本專案絕對禁止模式)

| 模式 | 狀態 | 說明 |
|------|------|------|
| Files through backend | ❌ NEVER | 檔案絕對不經過後端 |
| Traditional Streaming | ❌ 禁止 | 禁止在後端建立 Stream Pipe 或使用後端進行轉碼播放 |
| Backend Upload/Download | ❌ 禁止 | 禁止使用 REST API 進行檔案傳輸 - 必須使用 GramJS 在瀏覽器端處理 |
| Backend Proxy HTTP | ❌ 禁止 | 禁止後端代理 HTTP 請求進行檔案傳輸 |
| Wrong env prefix | ❌ | Frontend env vars MUST use `VITE_` prefix (e.g., `VITE_API_ID`) |
| Preview for testing | ❌ | `npm run preview` has NO API proxy - use `npm run dev` instead |
| Forget to restart | ❌ | Backend state is in-memory + SQLite, changes require restart |

---

## COMMANDS

```bash
# Restart (Windows)
restart.bat

# Development (ALWAYS use this for testing)
cd backend && python main.py        # Backend (port 8000)
cd frontend && npm run dev          # Frontend (port 3000) - has API proxy

# Production build
cd frontend && npm run build        # Build to dist/
npm run preview                     # Preview build (NO API proxy)

# Setup
python generate_session.py          # Get Telegram session
cp .env.example .env && edit .env   # Configure
```

---

## WORK COMPLETED

### Issues Fixed

| Issue | Status | Solution |
|-------|--------|----------|
| GramJS client never initialized | ✅ | Added initialization in SessionConfig.tsx |
| Missing MTProto Entity | ✅ | Regenerated session string |
| Backend 500 error | ✅ | Restarted backend |
| Upload stuck at "starting GramJS upload" | ✅ | Working now |
| Thumbnail not showing | ✅ | Modified ChonkyDrive to use GramJS for thumbnails |
| Double-click preview not showing | ✅ | Added downloadFile() in gramjs.ts, use GramJS instead of backend stream |
| Preview mode error (crypto require) | ✅ | Added @rollup/plugin-commonjs with ignoreDynamicRequires |

### Files Modified

| File | Change |
|------|--------|
| `frontend/.env` | Created with VITE_ prefixed credentials |
| `frontend/src/components/SessionConfig.tsx` | Added Telegram client initialization on mount |
| `frontend/src/lib/gramjs.ts` | Added `downloadThumbnail()`, `downloadFile()` methods |
| `frontend/src/components/ChonkyDrive.tsx` | Modified loadThumbnails and handleFileDoubleClick to use GramJS directly |
| `frontend/src/vite-env.d.ts` | Added Vite ImportMeta type definitions |
| `frontend/vite.config.ts` | Added commonjsOptions for build |

### Key Configurations

| Config | Value |
|--------|-------|
| GramJS Version | 2.10.8 (loaded at runtime) |
| Frontend Port | 3000 |
| Backend Port | 8000 |
| Preview Port | 4173 (no proxy) |

---

## VERIFICATION STATUS

### Runtime Verified ✅

- GramJS connects successfully
- Upload works
- Thumbnail download works
- File preview works (double-click)
- Backend API returns 200

### Build Verified ✅

- Frontend builds successfully (`npm run build`)
- Preview mode works (`npm run preview`)

---

## DEPLOYMENT

### Development
```bash
npm run dev  # port 3000, has API proxy
```

### Production
```bash
npm run build                    # Build to dist/
# Serve dist/ with nginx/apache
```

### Nginx Example
```nginx
server {
    listen 80;
    root /path/to/teledrive/frontend/dist;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    location /api/ {
        proxy_pass http://localhost:8000;
    }
}
```

---

## NOTES

- No Docker required - pure Python + Node.js
- Backend stores metadata in SQLite (`teledrive.db`) - persists across restarts
- Uses both Telethon (backend) and GramJS (browser) for MTProto
- No formal CI/CD - manual deployment via shell scripts
- Minimal testing infrastructure - only unittest in backend
- **Important**: Session string stored in `frontend/.env` with `VITE_` prefix
- **Always use `npm run dev` for testing** - preview mode has no proxy

---

## LIMITATIONS

### Service Worker Video Streaming

| Limitation | Description |
|------------|-------------|
| **Telegram client required** | Video streaming requires the main app to be running with an active Telegram connection. If the Telegram client disconnects, streaming returns 503. |
| **Single client connection** | The Service Worker communicates with the main app via postMessage. Only one browser tab with the app can be active at a time for streaming. |
| **No offline playback** | Videos cannot be played offline - they are streamed directly from Telegram CDN via the browser. |
| **Memory usage** | Large video files stream in chunks, but the preload buffer holds only one chunk ahead. Very large files may cause rebuffering on slower connections. |
| **Browser compatibility** | Service Workers and Media Source Extensions are required. Some older browsers or incognito modes may not support full functionality. |
| **Mime type detection** | Relies on Telegram's file metadata for mime type. Some uncommon video formats may fallback to `video/mp4`. |
| **Chunk retry logic** | Failed chunk downloads retry up to 3 times with exponential backoff (1s, 2s, 4s). After max retries, the stream returns 503. |
