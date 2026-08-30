# TeleDrive 資安修復計畫

更新日期：2026-08-30  
狀態：執行中（程式修復已完成第一批；管理者憑證輪替仍待處理）

## 目前進度

已完成：

- Backend 移除 Telegram client、message deletion、multipart/binary upload 與 upload-session 死碼。
- 永久刪除只做 owner-scoped SQLite metadata purge，UI 明確告知 Telegram 訊息保留。
- Vite 限制 host 與 filesystem、Docker build context 排除 session／DB／測試登入狀態。
- JWT secret 至少 32 bytes 且缺少時拒絕啟動；token 有效期縮短為 24 小時。
- Challenge pending／verified store 有 TTL 清理與容量上限，Nginx challenge route 加入 rate limit。
- CORS 改為明確 origin；Backend／Nginx 加入安全標頭、CSP 與 request body 上限。
- 所有 metadata 寫入、trash、restore、purge SQL 都強制 owner scope，並驗證 parent ownership／folder cycle。
- Telegram StringSession 與 JWT 已由 localStorage 遷移至 IndexedDB，舊 key 會自動清除。
- Frontend production 與 Python runtime dependency audit 均為 0 known vulnerabilities。
- `TESTING.md` 預設三層測試通過：Backend 184、Vitest 168、isolated Playwright 42。

尚需管理者或部署環境完成：

- 本機 `.env` 的 JWT secret 已於 2026-08-30 輪替；既有 backend JWT 已失效。
- 在 Telegram 撤銷舊 session，並立即由 BotFather 輪替 Bot token 與其他可能外洩的憑證。
- 確認輪替成功後，移除本機 `.session_string.txt`、`backend/memory.session` 與舊 `storageState.json`。
- 清查 Git history、CI artifact、Docker cache／registry image 是否曾包含上述秘密。
- 正式網域完成 HTTPS 後啟用 HSTS，並以明確 production `CORS_ORIGINS` 部署。
- 由管理者明確選擇時再執行 live Telegram smoke suite；本次未自動執行。

## 目標與不可破壞的架構限制

本計畫依照已確認風險的可利用性排序，先處理真實憑證與可直接利用的攻擊鏈，再進行認證、依賴及部署硬化。

所有修復必須遵守以下限制：

- Binary data 不得進入 Python backend（8000）。
- 檔案傳輸路徑只能是 Telegram CDN 與 Browser GramJS 之間。
- Backend 僅負責 SQLite metadata。
- 永久刪除只移除 SQLite metadata，不刪除 Telegram Saved Messages。
- Backend 與 Browser 都不提供 Telegram message deletion 功能。
- Frontend 固定使用 port 3000，Backend 固定使用 port 8000。
- Frontend 環境變數必須使用 `VITE_` prefix。
- UI/E2E 驗證使用 Playwright MCP，不進行人工瀏覽器測試。

## 執行順序

依序執行：`PR 0 → PR 1 → PR 2 → PR 3 → PR 4 → PR 5`。

在 PR 0 的憑證輪替完成前，不應重新公開 dev server、發佈 Docker image 或部署正式環境。

## PR 0：立即止血與憑證輪替（P0）

### 管理者操作

1. 在 Telegram「裝置」頁面撤銷可能對應下列檔案的 session：
   - `frontend/tests/storageState.json`
   - `.session_string.txt`
   - `backend/memory.session`
   - `.env` 中既有的 `TELEGRAM_SESSION_STRING`
2. 產生新的高強度 `JWT_SECRET`，使已存在的 JWT 全部失效。
3. 將 SQLite 備份移出 repo，保存到有加密及存取控制的備份位置。
4. 清除可能包含憑證的本機 Docker build cache、image，以及遠端 registry tag。
5. 收緊 `.env`、session、Playwright storage state 與 DB 備份的檔案 ACL，只允許必要帳號存取。

### 驗收條件

- 舊 JWT 呼叫受保護 API 時回傳 401。
- 舊 Telegram sessions 已被終止。
- repo、Docker build context、image layer 與測試產物皆掃描不到 session 或 token。
- Port 3000、8000 在完成必要修復前不對外開放。

## PR 1：恢復 metadata-only 邊界（P0）

### Backend 修改

- 刪除 `/api/v1/files/upload`，不可再宣告或解析 `UploadFile`／`File`。
- 移除 `_delete_telegram_messages()` 及其所有呼叫。
- 移除 `TelegramMTProtoService.delete_file()`、`delete_messages()`，以及不符合 metadata-only 架構的 backend upload/download 方法。
- 移除 purge route 對 `get_bot_service()` 的依賴。
- Backend 不再載入或使用 `TELEGRAM_SESSION_STRING`。
- 保留 Bot API challenge login；它只能驗證 Telegram identity，不可接觸使用者 StringSession 或檔案 binary。

### 永久刪除的固定行為

永久刪除流程只能執行：

1. 驗證 JWT 並取得 `owner_id`。
2. 以 `owner_id` 查詢目標及其 subtree。
3. 從 SQLite 刪除該 owner 的 metadata。
4. 回傳刪除的 metadata 筆數。

永久刪除不得：

- 建立 Telethon 或 GramJS Telegram client。
- 呼叫 Telegram Bot API 或 MTProto message deletion。
- 回傳 message IDs 讓 frontend 繼續刪除 Telegram message。
- 刪除或修改 Telegram Saved Messages 中的內容。

### Frontend 修改

- 移除任何 Telegram message deletion 呼叫與相關 UI 邏輯。
- 更新確認視窗及 Trash UI 文案：永久刪除只移除 TeleDrive 紀錄，Telegram 中的原始訊息會保留。
- metadata purge 成功後重新載入檔案清單及 trash 狀態。

### 驗收條件

- 上傳、下載、預覽的 binary request 不會進入 port 8000。
- Purge 只產生 SQLite `DELETE`，不產生 Telegram 網路請求。
- 即使 client 提供任意 `message_id`，Backend 也不會對 Telegram 執行任何操作。
- 自動測試斷言 purge 過程不建立 Telegram client。

## PR 2：封鎖檔案與建置洩漏（P0／P1）

### Docker context

在 `backend/.dockerignore` 加入：

```text
*.session
teledrive.db*
*.log
tests/
.pytest_cache/
```

在 `frontend/.dockerignore` 加入：

```text
tests/
test-results/
playwright-report/
**/storageState.json
```

### Playwright credentials

- Storage state 必須輸出到臨時測試目錄。
- 不得將正式站台的 Telegram session 或 JWT 作為固定 fixture。
- 測試完成後清除 storage state。
- CI artifact 不得上傳包含 credential 的 storage state。

### Vite dev server

- 預設只監聽 `127.0.0.1`。
- 移除 `allowedHosts: true`，改為明確 host 白名單。
- 移除 `fs.allow: ['..']`。
- 若確實需要 LAN 測試，必須透過明確的開發環境變數啟用，且不得使用正式憑證。
- 升級至不受 Windows `server.fs.deny` bypass 影響的 Vite 版本。

### 驗收條件

- Vite 無法讀取 `.env`、`.session_string.txt`、`memory.session`、DB 備份或 storage state。
- Docker builder 與 final image 都不包含敏感檔案。
- Git、Docker context 與 build artifact secret scan 無命中。

## PR 3：認證、租戶隔離與 API 硬化（P1）

### JWT 與 Browser session

- 啟動時要求 `JWT_SECRET` 非空且至少 32 bytes；設定不合法時 fail closed。
- `.env.example` 不得以容易誤用的空 JWT secret 表示可選設定。
- 縮短 access token 有效時間。
- 優先將 backend JWT 改為 `Secure`、`HttpOnly`、`SameSite` cookie，並加入 CSRF 防護。
- Telegram StringSession 預設只保存在記憶體。
- 若提供「記住登入」，必須使用使用者密碼衍生的 WebCrypto key 加密；不可用程式內硬編碼金鑰。

### Bot challenge

- `_pending` 與 `_verified` 都要定期清除逾期資料。
- 設定最大 challenge 數量及每個 IP／帳號的速率限制。
- 對 challenge、verify 加入全域 rate limit 與合理 timeout。
- 不在 log 中記錄完整 nonce、token 或其他 credential。

### Tenant isolation

- 所有 get、update、trash、restore、purge、recursive CTE 與 bulk delete 都必須在 SQL 層加入 `owner_id`。
- `parent_id` 必須指向相同 owner 的有效資料夾。
- 防止資料夾移入自己或自己的 descendant。
- split group 查詢及變更必須限定相同 owner。
- 避免先驗證後更新之間的 TOCTOU；ownership 條件應包含在同一個 SQL statement 或 transaction 中。

### 輸入與錯誤處理

- 限制 `filename`、`file_id`、`mime_type`、`access_hash`、`split_group_id` 的長度。
- `filesize` 必須大於或等於 0。
- SHA-256 必須是 64 位十六進位字串。
- 批次 hash 數量與 request body 大小必須有上限。
- 500 response 只回傳通用錯誤，不回傳 `str(e)`、DB path 或 traceback。
- Log 不得輸出 session、JWT、access hash、登入 code 或 2FA password。

### CORS 與安全標頭

- CORS 改為明確 origin 白名單，不搭配 `*` 與 credentials。
- Nginx 設定合理的 `client_max_body_size`。
- 加入 CSP、`frame-ancestors`、`X-Content-Type-Options`、Referrer Policy、Permissions Policy 與 CORP。
- 正式環境強制 HTTPS；確認全站 HTTPS 後再啟用 HSTS。
- Backend port 8000 不直接暴露公網，只允許 frontend／reverse proxy 存取。

### 驗收條件

- 空或過短 JWT secret 會讓服務啟動失敗。
- 跨 tenant 的讀、寫、移動、trash、restore、purge 全部回傳 403 或 404。
- Challenge flood 不會造成記憶體持續成長。
- CSP 啟用後，GramJS WSS、Service Worker、blob preview 與登入流程仍正常。

## PR 4：依賴與環境重建（P1）

### Frontend

- 升級 Vite 至已修補版本。
- 升級 Axios、follow-redirects、form-data、ip-address 及相關 transitive dependencies。
- 更新並提交 `package-lock.json`。
- 確認升級後的 Node 版本需求，並同步更新 frontend Docker base image。

### Backend

- 升級 FastAPI、Starlette、python-multipart、idna、pyasn1。
- `python-multipart` 至少使用 audit 指出的完整修補版本。
- 使用 uv 或 pip-tools 建立精確版本與 hashes 的 lockfile。
- 依 lockfile 重建 backend virtual environment，避免沿用目前漂移的 venv。
- Docker base image 使用明確版本或 digest。

### CI gate

- Production dependencies 不得有 high／critical 漏洞。
- Lockfile 有未提交變更時 CI 失敗。
- Python dependencies 必須可由 lockfile 重現。
- 定期執行 `npm audit`、`pip-audit` 與 container scan。

### 驗收條件

- `npm audit --omit=dev` 無 high／critical。
- `pip-audit` 無 runtime high／critical。
- 全新環境可只依 lockfile 完成安裝與測試。

## PR 5：安全回歸測試與最終驗證（P2）

### Backend 自動測試

- 空 JWT secret、過短 secret 與偽造 token。
- Purge 只刪 metadata，不呼叫 Telegram service。
- Deprecated upload route 不存在，且 backend 不解析 multipart file body。
- Challenge rate limit、TTL、最大容量及 verified cleanup。
- Parent ownership、循環目錄與跨 tenant subtree。
- Update／delete／purge 的 owner-scoped SQL。
- 500 response 不洩漏內部 exception 或 DB path。

### Playwright MCP E2E

- QR／手機登入與登出。
- 登出後 credential 清除。
- Browser 直接上傳、下載及預覽 Telegram 檔案。
- 多 Telegram account 使用正確的 GramJS client。
- Trash、restore 與 metadata-only purge。
- Purge 後 TeleDrive 不再顯示紀錄，但 Telegram Saved Messages 保持不變。
- Network trace 證明 binary data 沒有送往 port 8000。
- 未登入、跨 origin 與敏感檔案路徑皆被阻擋。

### 最終掃描

- 掃描目前工作目錄與完整 Git history 的 secrets。
- 掃描 npm、Python 與 container dependencies。
- 檢查 Docker image layer 與 build context。
- 確認正式部署只對外提供必要入口，backend 8000 不直接公開。

## 完成定義

只有在以下條件全部成立時，資安修復才算完成：

- 已撤銷所有可能外洩的 Telegram sessions 並輪替 JWT secret。
- Backend 完全不接觸檔案 binary，也不刪除 Telegram message。
- 永久刪除只執行 owner-scoped SQLite metadata deletion。
- Vite、Docker、測試 artifact 不會暴露 credential。
- 跨 tenant 操作有 API 與 SQL 雙層防護。
- Production dependency audit 無 high／critical。
- Backend security tests 與 Playwright MCP E2E 全數通過。
- Git worktree 只包含預期的修復變更。
