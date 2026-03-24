# Telegram Cloud Storage

A personal cloud storage system using Telegram as the backend storage provider. Files upload and download directly from Telegram via MTProto - **no server bandwidth usage**.

## Features

- **Direct Upload**: Browser → Telegram (GramJS MTProto), no server
- **Direct Download**: Browser → Backend (metadata) → Telegram (MTProto), no server bandwidth
- **No Docker Required**: Pure Python + Node.js
- **Low Resource**: Backend only stores metadata, no file streaming
- **File Browser**: Navigate files with grid/list views
- **Large File Support**: Works with files of any size

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Upload Flow                                │
│                                                                 │
│   Browser ──(MTProto WebSocket)──▶ Telegram CDN                │
│       │                                                          │
│       └── POST /files/register ──▶ Backend (metadata only)      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        Download Flow                              │
│                                                                 │
│   Browser ──GET /files/{id}/download──▶ Backend (metadata)       │
│       │                     ◀─────────── file_id, access_hash   │
│       │                                                          │
│       └───(MTProto WebSocket)──▶ Telegram CDN ──▶ Browser       │
└─────────────────────────────────────────────────────────────────┘
```

**Key Points**:
- Files NEVER pass through backend server
- Only file metadata (name, size, message_id, access_hash) stored on backend
- Both upload and download use direct MTProto connections

## Prerequisites

- Node.js 18+
- Python 3.10+
- FFmpeg (for video thumbnails — install via `winget install Gyan.FFmpeg` on Windows, `apt install ffmpeg` on Linux, or `brew install ffmpeg` on macOS)
- Telegram API ID & Hash ([my.telegram.org](https://my.telegram.org))
- Telegram Session String (user account)

## Quick Start

### 0. Install & Configure

```bash
chmod +x install.sh start.sh
./install.sh
cp .env.example .env
# Edit .env with your credentials
```

### 1. Generate Session String

Option A: Interactive script
```bash
python generate_session.py
```

Option B: Manual

```python
from telethon import TelegramClient

client = TelegramClient('session', api_id=YOUR_API_ID, api_hash='YOUR_API_HASH')
await client.start()
print(client.session.save())
```

### 2. Configure

```bash
cd teledrive
cp .env.example .env
# Edit .env with your API credentials and session string
```

### 3. Start Backend

```bash
cd backend
pip install -r requirements.txt
python main.py
```

### 4. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

### 5. Configure in Browser

1. Open http://localhost:5173
2. Enter API ID, API Hash, and Session String
3. Click "Connect"

## Dependencies

**Backend** (minimal, ~15 packages):
- FastAPI + uvicorn
- Telethon (MTProto)
- Pydantic

**Frontend**:
- React
- GramJS (MTProto for browser)
- FilePond (upload UI)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/files/register` | Register uploaded file metadata |
| GET | `/api/v1/files` | List all files |
| GET | `/api/v1/files/{file_id}` | Get file info |
| GET | `/api/v1/files/{file_id}/download` | Get download metadata |
| DELETE | `/api/v1/files/{file_id}` | Delete file |

## VPS Deployment

```bash
# Minimal VPS setup
sudo apt update && sudo apt install python3-pip nodejs npm

# Clone and configure
git clone <repo>
cd teledrive
cp .env.example .env
# Edit .env

# Start backend
cd backend && pip install -r requirements.txt
nohup python main.py &

# Build frontend
cd ../frontend && npm install && npm run build
npm run preview  # or serve with nginx
```

## Hardware Requirements

- **CPU**: 1 core
- **RAM**: 512MB (backend) + 512MB (frontend if built)
- **Disk**: Minimal (only metadata storage)

No Docker, no Bot API server, no heavy dependencies.

## Troubleshooting

### Connection Failed
- Verify API ID/Hash are correct
- Verify session string is valid
- Check browser console for errors

### Upload Not Working
- Ensure connection shows "Connected"
- Check browser console for MTProto errors

### Download Issues
- Session string must be for user account
- Verify file still exists in Telegram Saved Messages

## License

MIT
