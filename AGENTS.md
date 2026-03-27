# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-27
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

**職責：所有運算邏輯都在前端**
- **上傳**：使用 GramJS (瀏覽器 MTProto) 直接連接 Telegram CDN
- **下載**：使用 GramJS 直接從 Telegram CDN 下載
- **縮圖產生**：在前端使用 FFmpeg WASM 或 Canvas 產生影片/圖片縮圖
- **所有資料運算** - 檔案處理、壓縮、格式轉換等
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

### 開發守則

| 行為 | 允許 | 禁止 |
|------|------|------|
| 檔案經過後端 | ❌ | 後端只存取 metadata |
| 後端處理上傳邏輯 | ❌ | 前端負責 |
| 前端直接連接 Telegram | ✅ | 這是設計目標 |
| 後端儲存 message_id + path | ✅ | 這是後端職責 |

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
| GramJS wrapper | `frontend/src/lib/gramjs.ts` | Browser MTProto client |
| Database | `backend/app/services/database.py` | SQLite operations |
| Config/env | `frontend/.env` | Vite env vars (VITE_ prefix) |

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
- **Wrong env prefix**: Frontend env vars MUST use `VITE_` prefix (e.g., `VITE_API_ID`)

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

### Files Modified

- `D:\teledrive\frontend\.env` - Created with VITE_ prefixed credentials
- `D:\teledrive\frontend\src\components\SessionConfig.tsx` - Added Telegram client initialization on mount
- `D:\teledrive\frontend\src\lib\gramjs.ts` - Added `downloadThumbnail()` method
- `D:\teledrive\frontend\src\components\ChonkyDrive.tsx` - Modified `loadThumbnails` to use GramJS directly

### Key Configurations

- **GramJS Version**: 2.10.8 (loaded at runtime)
- **Frontend Port**: 3000
- **Backend Port**: 8000

---

## VERIFICATION STATUS

### Runtime Verified ✅

- GramJS connects successfully (`[GramJS] Connected as: name404notfound`)
- Upload works (`[Upload] File uploaded to Telegram, message_id: 179415`)
- Thumbnail download works (`[Thumb] Downloaded for 螢幕擷取畫面...`)
- Backend API returns 200

### Build Verified ✅

- Frontend builds successfully

---

## NOTES

- No Docker required - pure Python + Node.js
- Backend stores metadata in SQLite (`teledrive.db`) - persists across restarts
- Uses both Telethon (backend) and GramJS (browser) for MTProto
- No formal CI/CD - manual deployment via shell scripts
- Minimal testing infrastructure - only unittest in backend
- **Important**: Session string stored in `frontend/.env` with `VITE_` prefix