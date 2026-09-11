# TeleDrive

A personal cloud storage system using Telegram for file storage. Files upload and download **directly between the browser and Telegram via GramJS MTProto**. Python handles authentication and SQLite metadata; it never proxies file or thumbnail bytes.

## Architecture

```text
Public web access:
  Browser → Cloudflare → cloudflared → nginx:3000
                                         ├── static frontend
                                         └── /api/v1 → backend:8000 → SQLite

Files and thumbnails:
  Browser ←──────── GramJS MTProto ────────→ Telegram CDN
      └── metadata registration / lookup → /api/v1
```

Docker Compose manages `backend`, `frontend` (nginx), and `cloudflared`. The connector shares the frontend container's network namespace, so the tunnel's `http://localhost:3000` origin reaches nginx. Tunnel routes are managed in Cloudflare, not in a local configuration file.

The frontend is published on host port **3000**. The backend is bound to **127.0.0.1:8000** on the host; public API requests go through nginx. Telegram file transfers bypass both Cloudflare Tunnel and Python.

## Quick Start — Docker Compose

### 1. Prepare credentials

- Install [Docker and Docker Compose](https://docs.docker.com/get-docker/).
- Obtain a Telegram API ID and hash from [my.telegram.org](https://my.telegram.org/apps).
- Create a Telegram bot with **@BotFather** and save its token for login verification.
- Prepare a Cloudflare account, a domain managed by Cloudflare, and a remotely managed Cloudflare Tunnel for your public hostname.

Users log in through the browser using a Telegram QR code or phone number, with a 2FA password if enabled. The browser sends a one-time nonce to the configured bot; the backend verifies it and issues a JWT. No pre-generated Telegram session string is needed in `.env`.

### 2. Configure TeleDrive

From the repository root:

```bash
cp .env.example .env
```

Fill in all five required variables:

| Variable | Purpose |
|---|---|
| `VITE_TELEGRAM_API_ID` | Telegram API ID, embedded in the frontend build |
| `VITE_TELEGRAM_API_HASH` | Telegram API hash, embedded in the frontend build |
| `TELEGRAM_BOT_TOKEN` | Bot token required for login |
| `JWT_SECRET` | Stable signing secret, at least 32 bytes |
| `CLOUDFLARE_TUNNEL_TOKEN` | Connector token for your Cloudflare Tunnel |

Generate a JWT secret with Python, then paste the output into `.env`:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Keep the same JWT secret across restarts to preserve login tokens. Only the Telegram API ID and hash belong in `VITE_` variables; bot, JWT, and tunnel secrets stay server-side.

### 3. Configure the tunnel

Follow [Cloudflare's tunnel setup instructions](https://developers.cloudflare.com/tunnel/setup/) to create or select a remotely managed tunnel. Copy the connector token from its installation command into `CLOUDFLARE_TUNNEL_TOKEN`.

Add a published application route for your hostname (for example, `drive.example.com`) with service **`http://localhost:3000`**. Compose runs the connector, so no separate host installation of cloudflared is needed for this deployment.

The current Compose file requires a non-empty tunnel token during configuration parsing, even when selecting only the application services. For development without a tunnel, use the native development instructions below.

### 4. Start

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f backend frontend cloudflared
```

Open `https://drive.example.com` using your configured hostname, or [http://localhost:3000](http://localhost:3000) on the host, and log in with Telegram.

## Configuration details

| Variable | Scope / default |
|---|---|
| `CORS_ORIGINS` | Optional JSON list of allowed browser origins; defaults to `http://localhost:3000` and `http://127.0.0.1:3000` |
| `BACKEND_HOST` | Native backend default: `0.0.0.0`; Compose fixes it to `0.0.0.0` inside the container |
| `BACKEND_PORT` | Keep `8000`; Compose fixes it to `8000` |
| `TELEDRIVE_DB_PATH` | Compose sets `/data/teledrive.db`; native backend defaults to `backend/teledrive.db` |

The deployed frontend calls `/api/v1` on its own origin through nginx. A separate public backend URL is unnecessary. If a separate browser origin needs API access, add that exact origin to `CORS_ORIGINS` as a JSON list.

Docker reads the root `.env` for Compose interpolation. The two Telegram `VITE_` variables are **build-time** settings: rebuild the frontend after changing them. Compose explicitly sets the backend host, port, and database path, so changing those root `.env` values does not override the container settings.

## Maintenance

Run these commands from the repository root:

```bash
# Restart existing services (does not apply changed environment variables)
docker compose restart

# Apply application, dependency, or .env changes
docker compose up -d --build

# Follow one service's logs
docker compose logs -f cloudflared
docker compose logs -f backend

# Stop and remove containers, preserving the database volume
docker compose down
```

Because cloudflared shares the frontend network namespace, manage them together when rebuilding or recreating the frontend. If the connector fails after a frontend replacement, recreate both:

```bash
docker compose up -d --force-recreate frontend cloudflared
```

### Database and backups

SQLite lives at `/data/teledrive.db` in the `teledrive-data` named volume (its Docker name normally includes the Compose project prefix). The mounted `backend/` source directory is not the deployed database location.

Create a consistent SQLite snapshot with Python's backup API, then copy it to the host. These commands require a running backend container; use a new destination filename for each backup:

```bash
docker compose exec backend python -c "import sqlite3; src = sqlite3.connect('/data/teledrive.db'); dst = sqlite3.connect('/tmp/teledrive-backup.db'); src.backup(dst); dst.close(); src.close()"
docker compose cp backend:/tmp/teledrive-backup.db ./teledrive-backup.db
```

Store backups outside the repository, and preserve `.env` separately. The database contains drive metadata and account links, not Telegram file bytes. **`docker compose down -v` deletes the named volume and its metadata**; use plain `docker compose down` for routine shutdown.

## Native development — without Docker or a tunnel

Use Python 3.11 and a Node.js version supported by the installed Vite release (the Docker build uses Node 20). Keep ports **8000** and **3000** available; stop an existing Compose deployment before using those ports locally.

The following commands use a POSIX shell. From the repository root:

```bash
python3 -m venv venv
venv/bin/python -m pip install -r backend/requirements.txt
cd frontend
npm ci
```

Create the root `.env` from `.env.example` if it does not already exist, then configure `TELEGRAM_BOT_TOKEN` and `JWT_SECRET`. A tunnel token is not needed for native processes. Set `BACKEND_HOST=127.0.0.1` for local development and keep `BACKEND_PORT=8000`.

Create `frontend/.env.local` containing only your frontend API credentials:

```dotenv
VITE_TELEGRAM_API_ID=your_api_id_here
VITE_TELEGRAM_API_HASH=your_api_hash_here
```

Vite reads environment files from `frontend/`; the native backend reads `../.env` when started from `backend/`. Do not copy root secrets into the frontend environment file.

Start each process in a separate terminal, initially at the repository root:

```bash
# Terminal 1
cd backend
../venv/bin/python main.py
```

```bash
# Terminal 2
cd frontend
npm run dev -- --port 3000 --strictPort
```

On Windows PowerShell, create the virtual environment with `python -m venv venv`, install dependencies using `venv/Scripts/python.exe -m pip install -r backend/requirements.txt`, and start the backend from `backend/` with `../venv/Scripts/python.exe main.py`. The frontend commands are the same; use `Copy-Item .env.example .env` to create the root configuration.

Use [http://127.0.0.1:3000](http://127.0.0.1:3000). Vite proxies `/api/v1` to `http://127.0.0.1:8000`. Stop each process with Ctrl+C; restart the backend after Python changes. Native development uses `backend/teledrive.db`, separate from the Docker volume.

See [TESTING.md](TESTING.md) for automated test suites and dependencies. Browser verification uses Playwright MCP as required by [AGENTS.md](AGENTS.md).

## API overview

Routes below use the `/api/v1` prefix. Drive operations require a bearer JWT obtained through the login challenge flow. See the local backend's [OpenAPI documentation](http://127.0.0.1:8000/docs) for the full schema.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/challenge` | Create a login challenge |
| POST | `/auth/verify` | Exchange a verified challenge for a JWT |
| POST | `/auth/refresh` | Refresh authentication |
| GET | `/accounts` | List linked Telegram accounts |
| GET | `/files` | List files with filtering, sorting, and pagination |
| GET | `/files/{id}` | Get file metadata |
| POST | `/files/register` | Register metadata after browser upload |
| PATCH | `/files/{id}` | Update metadata |
| DELETE | `/files/{id}` | Move a file to trash |
| POST | `/files/{id}/restore` | Restore a trashed file |
| DELETE | `/files/{id}/purge` | Permanently remove trashed metadata |
| GET | `/files/{id}/download` | Get Telegram download coordinates |
| GET | `/folders` | List folders |
| POST | `/folders` | Create a folder |
| DELETE | `/folders/{id}` | Delete a folder |

Thumbnails are downloaded and cached by the browser; there is no backend thumbnail endpoint or thumbnail cache directory.

## Features

- Drag-and-drop upload of files and folders
- Large files split across Telegram messages using a shared `split_group_id`
- Browser-generated video/image thumbnails and video streaming
- Folder navigation, grid/list views, search, sorting, renaming, and moving
- Trash and restore
- Multiple linked Telegram accounts

## Troubleshooting

**Compose reports a missing tunnel token** — Set `CLOUDFLARE_TUNNEL_TOKEN` in the root `.env`. The current Compose deployment includes the connector as a required service.

**Public hostname returns an origin error** — Check `docker compose ps` and frontend/cloudflared logs. Confirm the tunnel route targets `http://localhost:3000`. If the frontend was replaced, recreate frontend and cloudflared together using the maintenance command above.

**Login challenge returns 503** — Check backend logs and `TELEGRAM_BOT_TOKEN`. An absent token or failed bot initialization makes login unavailable.

**Backend fails with a JWT configuration error** — Set a stable `JWT_SECRET` of at least 32 bytes, then run `docker compose up -d --build`.

**Telegram API credentials are missing** — For Docker, fill the two root `VITE_TELEGRAM_API_*` values and rebuild. For native development, put them in `frontend/.env.local` and restart Vite.

**Port already in use** — Stop the existing deployment or native process using ports 8000/3000. Keep these ports fixed.

**Thumbnail is missing** — Thumbnails are handled by the browser and Telegram. Inspect browser network errors using Playwright MCP; there is no backend thumbnail cache to delete.

## License

MIT
