# 一個 Drive 帳號綁多個 Telegram 帳號 — 多帳號並行上傳

## Context

**問題**：TeleDrive 目前「drive 帳號 = Telegram 帳號」是硬綁的。`files.telegram_user_id`
（`backend/app/services/database.py:99`）同時扮演兩個角色 —— 租戶過濾鍵，以及「這個檔案躺在誰的
Saved Messages」。上傳吞吐因此被單一 Telegram 帳號的 flood limit 封頂：`chunkPacer` 學到的
ceiling 就是那個帳號的天花板，`FLOOD_PREMIUM_WAIT`（commit 3886615）更是完全無法靠放慢繞過 ——
它是帳號等級的 tier cap，不是速率問題。

**目標**：一個 drive 底下可掛多個 Telegram 帳號（設定 → 新增帳號），上傳時把檔案分派到各帳號
並行，每個帳號各自跑一套完整的併發預算與 pacer，使總吞吐 ≈ N 倍，並讓單一帳號的 flood 只拖慢
自己那一路。

**已與使用者確認的三個決策**：
1. 帳號綁定驗證 → **先實作 `docs/superpowers/plans/2026-07-30-bot-challenge-auth.md`**，
   多帳號綁定直接複用同一條 challenge 流程。session string 不上後端。
2. 併發預算 → **每帳號一套完整預算**（各自 3 檔併發 / 12 chunk 併發 / 獨立 pacer）。
3. 分派 → **逐檔 round-robin，且大檔的 split 段也跨帳號並行**。

---

## Phase 0（前置，獨立完成並驗證）

執行既有的 `docs/superpowers/plans/2026-07-30-bot-challenge-auth.md`，不做任何改寫。
它會刪掉 `/auth/login`、`_parse_gramjs_session()`、`user_sessions.py`，並建立
`backend/app/services/bot_challenge.py` 的 `new_challenge` / `ingest_updates` /
`take_verified` / `poll_loop`。

**本計畫對它的唯一追加要求**：`take_verified(nonce)` 回傳的 dict 要保留 `username` /
`first_name`，Phase 3 的帳號列表拿它當顯示名稱，不必再開一個 API。那份 plan 已經這樣寫了。

Phase 0 的前置條件（使用者要先做）：@BotFather 建 bot、`.env` 設 `TELEGRAM_BOT_TOKEN`，
以及設固定的 `JWT_SECRET`（`backend/app/auth.py:9` 目前預設隨機，重啟即全員登出）。

---

## Phase 1 — 後端：拆開 owner 與 storage account

### 資料模型

`files.telegram_user_id` 的兩個角色拆成兩欄。**語意變更是這次的核心**：

| 欄位 | 新語意 |
|---|---|
| `owner_id` | drive 帳號 = 主 Telegram 帳號的 user id。**所有租戶過濾改用它** |
| `telegram_user_id` | 這份 metadata 對應的訊息躺在**哪個** Telegram 帳號的 Saved Messages |

`backend/app/services/database.py` 的 `init_schema()`（既有的 try/except `ALTER TABLE` 就地
migration 風格，`:72-112`）追加：

```sql
ALTER TABLE files ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0;
UPDATE files SET owner_id = telegram_user_id WHERE owner_id = 0;   -- 單帳號時期兩者相同

CREATE TABLE IF NOT EXISTS linked_accounts (
    owner_id          INTEGER NOT NULL,
    telegram_user_id  INTEGER NOT NULL,
    label             TEXT,
    is_primary        INTEGER NOT NULL DEFAULT 0,
    added_at          TEXT NOT NULL,
    PRIMARY KEY (owner_id, telegram_user_id)
);
-- 回填：既有每個 distinct telegram_user_id 都是自己的 owner + primary
INSERT OR IGNORE INTO linked_accounts (owner_id, telegram_user_id, is_primary, added_at)
SELECT DISTINCT telegram_user_id, telegram_user_id, 1, datetime('now') FROM files;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_unique ON linked_accounts(telegram_user_id);
```

`idx_linked_unique` 是安全性質，不是效能：**一個 Telegram 帳號只能屬於一個 drive**，否則 A 把
B 的帳號綁進自己 drive 就能看到 B 的檔案清單。

索引改綁 `owner_id`（`database.py:116-125`）：
- `idx_files_user_parent` → `ON files(owner_id, isDir, parent_id)`
- `idx_files_hash` → `ON files(file_hash, owner_id)` ← dedup 因此自動跨帳號生效

### 查詢層

`database.py` 中所有帶 `telegram_user_id = ?` 的租戶過濾（`:203, :224, :240, :318` 等）一律改
`owner_id = ?`。`file_service.py` 對應調整。`insert_file` 同時寫入兩欄。
`find_file_by_name_and_parent()`（`file_service.py:247`，同名取代語意）也走 `owner_id`。

**逐一檢查每個 `telegram_user_id` 出現處，判斷它問的是「誰的 drive」還是「存在誰那」**，
不要整批 sed。這是本 phase 唯一容易出錯的地方。

### Auth 與 JWT

`app/auth.py`：JWT payload 的 `user_id` 語意改為 **owner_id**，另加 `acting_account_id`
（實際登入的那個 Telegram 帳號，供 log 與 UI 顯示）。

`/auth/verify`（Phase 0 建立）成功拿到 `from.id` 後：
```python
owner = await db.get_owner_of(tg_user_id)       # 查 linked_accounts
if owner is None:                                # 首次登入 → 自己就是 owner
    await db.link_account(tg_user_id, tg_user_id, is_primary=True)
    owner = tg_user_id
token = create_jwt(owner_id=owner, acting=tg_user_id)
```

### 新端點

| Method | Path | 行為 |
|---|---|---|
| GET | `/api/v1/accounts` | 列出當前 owner 的 linked accounts（id / label / is_primary / 檔案數） |
| POST | `/api/v1/accounts/challenge` | 回 `{nonce, bot_username}`。**複用 `bot_challenge.new_challenge()`**，不新寫一套 |
| POST | `/api/v1/accounts/verify` | 帶 `{nonce}` + 現有 JWT。`take_verified(nonce)` 拿到 `from.id` → 綁到 JWT 的 owner。已被別人綁走 → 409 |
| DELETE | `/api/v1/accounts/{tg_user_id}` | 解除綁定。**該帳號名下仍有檔案 → 409 並回檔案數**；`is_primary` 一律拒絕 |

DELETE 的 409 是刻意的：解綁等於讓那些檔案永遠下載不到（access_hash 綁帳號，換帳號無效）。
搬移檔案要靠 forward 到別的帳號再重 register，不在本次範圍。

### 回應 schema

`app/models/schemas.py` 的 `FileInfo` 加 `telegram_user_id: int`。**前端下載時靠它挑 client，
少了這欄整個 Phase 4 無法運作。**

---

## Phase 2 — 前端：從單例 client 變成 client pool

這是改動最大的一塊，`frontend/src/lib/gramjs.ts`（1575 行）。

### 2.1 帳號憑證儲存

`saveCredentialsToStorage` / `loadCredentialsFromStorage`（`gramjs.ts:1560-1575`）改成多筆：

```ts
// localStorage key 'tg_accounts': Array<{ id: number; label: string; session: string }>
// 'tg_jwt' 不變（一個 drive 一個 JWT）
// 讀取時若 'tg_accounts' 不存在但舊的 'tg_session' 在 → 就地遷移成單元素陣列後刪除舊 key
```

### 2.2 per-account 的限流狀態

目前是 module 級全域共用，這正是「每帳號一套完整預算」要拆掉的東西：

| 現況（module 級） | 位置 | 改法 |
|---|---|---|
| `uploadSemaphore = new Semaphore(12)` | `gramjs.ts:78` | 移進 `TelegramClientManager` instance 欄位 |
| `messageRateLimiter = new RateLimiter(3, 6)` | `gramjs.ts:83` | 同上 |
| `chunkPacer = new AdaptiveRateLimiter({...})` | `gramjs.ts:127` | 同上，且 `storageKey` 改 `` `teledrive_chunk_rate_v2_${accountId}` `` |
| `sendFilePartGated(client, req, label)` | `gramjs.ts:173` | 改成 manager 的 private method，用 `this.chunkPacer` |
| `penalizeForFlood(label, err)` | `gramjs.ts:110` | 同上，用 `this.messageRateLimiter` |
| `getChunkRateStats()` export | `gramjs.ts:161` | 改成 instance method；呼叫端（batch summary log）改成逐帳號印 |

`storageKey` 帶 account id 是必要的：每個帳號的 ceiling 是它自己的 tier 學出來的，混在一起會讓
premium 帳號被 free 帳號的天花板拖住。

`floodText` / `isFloodError` / `isPremiumFloodError` 是純函式，留在 module 級。

### 2.3 Client pool

```ts
// gramjs.ts:1537-1558 的 clientInstance 單例改成
const clients = new Map<number, TelegramClientManager>();
export function getClientFor(accountId: number): TelegramClientManager   // lazy 建構 + initialize
export function getPrimaryClient(): TelegramClientManager                // 登入 / 非上傳路徑沿用
export function getAllClients(): TelegramClientManager[]                 // 上傳分派用
export function resetAllClients(): void                                  // 登出
```

`installTelegramWsProxy()`（`gramjs.ts:47`）本來就用 `__telegramWsProxyInstalled` 做全域一次性
monkey-patch，多 client 各自開 WebSocket 走同一條 patch，**不需要改**。

`fileLocationCache`（`gramjs.ts:255`）已經是 instance 欄位，拆成多 instance 後自然按帳號隔離 ——
順手解掉「cache key 只有 messageId、不含 peer」這個既有隱患。

`App.tsx:24-53` 的啟動流程改成：讀 `tg_accounts` → 對每個帳號 `getClientFor(id).initialize(...)`
（一樣 fire-and-forget，UI 不等 MTProto）。任一帳號握手失敗只標記該帳號離線，**不清空整個
登入狀態** —— 目前 `.catch(() => clearCredentialsFromStorage())` 會把全部踢掉。

---

## Phase 3 — 設定 UI：新增 / 移除帳號

目前沒有設定頁（`SessionConfig.tsx` 只是後端連線狀態橫幅），也沒有 react-router。
新增 `frontend/src/components/SettingsDialog.tsx`，由 `App.tsx` header 加一顆齒輪按鈕開啟
（跟現有主題切換 / 登出鈕並列，inline style 沿用專案慣例）。

內容：
- 帳號列表 —— `GET /accounts`，顯示 label、is_primary、檔案數、目前 pacer 速率
  （`manager.getChunkRateStats()`，讓使用者看得到哪個帳號被 flood 拖住）
- 「新增 Telegram 帳號」→ 開 `LoginScreen` 既有的 QR / phone 流程拿到新 session string
  → 用它 `new TelegramClientManager().initialize(...)` → `POST /accounts/challenge` 拿 nonce
  → **用新帳號的 client** `sendAuthChallenge(botUsername, nonce)`（Phase 0 在 gramjs.ts 加的）
  → 輪詢 `POST /accounts/verify` → 成功則存進 `tg_accounts` 並加入 pool
- 每個非 primary 帳號一顆「移除」；409 時把後端回的檔案數直接顯示出來

`LoginScreen.tsx` 的 `onLogin(sessionString)` 簽名不變，只是這次呼叫端不是 App 而是
SettingsDialog —— 把它從「登入畫面」抽成可嵌入的 session 取得元件，避免複製一份 QR 邏輯。

---

## Phase 4 — 上傳分派與下載路由

### 4.1 逐檔 round-robin

`ChonkyDrive.tsx` 目前 `new Semaphore(MAX_CONCURRENT_FILES)`（`:812` drag/picker、`:1028`
folder）是單一全域 gate。改成每帳號一個 `Semaphore(3)`，並用一個共用的分派器：

```ts
// 新檔 frontend/src/lib/accountPool.ts（約 40 行）
// nextAccount(): round-robin 指標，跳過離線帳號
// withAccountSlot(fn): 取得下一個帳號 → 佔用該帳號自己的 fileSemaphore → fn(manager)
```

`startUploadBatch`（`:726`）與 `uploadFolder`（`:906`）把 `fileSemaphore.withSlot(...)`
換成 `withAccountSlot(manager => uploadFileToTelegram(manager, file, ...))`。
album pipeline（`createAlbumPipeline`）同理：**一個 album batch 整批綁同一個帳號**
（`SendMultiMedia` 不能跨帳號），batch 建立時決定帳號。

`registerUploadedParts` / `registerFolderFileParts` / album 的 `dispatchBatch` 在
`api.registerFile` 的 payload 加 `telegram_user_id: manager.accountId`。

### 4.2 大檔 split 段跨帳號（`uploadFileSplit`, `gramjs.ts:456`）

目前是 `while (remainingSize > 0)` 的**序列**迴圈，每 1000 parts 一段、每段一則訊息。
因為每段要用不同帳號，這個方法必須從 manager 的 method 提升為 pool 層的協調函式
（新檔 `frontend/src/lib/splitUpload.ts`）：

1. 先算出 segment 清單：`[{ index, offset, partsInSegment, size }]`
2. 每個 segment 經 `withAccountSlot` 指派帳號，**平行**跑（原本序列）
3. 單一 segment 內部的邏輯不變 —— chunks 走該帳號的 `uploadSemaphore` + `chunkPacer`，
   然後 `InputFileBig` + `sendFileWithOptionalThumb`
4. `thumb` 只掛 `index === 0` 那段（維持現有行為）

**必須同時修掉的既有假設**：`gramjs.ts:615` 的
`uploadedParts.sort((a, b) => a.message_id - b.message_id)`。message_id 只在同一帳號內遞增，
跨帳號排序會把檔案順序打亂 → 合併後檔案損毀。改成用 **segment index** 排序，
`part_index` 直接取 index。這是本 phase 最高風險的一行。

### 4.3 下載必須挑對 client

`access_hash` 是 per-(帳號, 物件) 授權值，用錯帳號的 client 一律失敗；更糟的是
`getMessages("me", { ids: [messageId] })` 在另一個帳號的 Saved Messages 裡**很可能命中一則
編號相同但內容不同的訊息**，變成靜默下載錯檔。所以每個讀取路徑都要先按 `telegram_user_id`
挑 client：

| 位置 | 改法 |
|---|---|
| `getFileLocation` `:269`、`downloadFile` `:1007`、`downloadFileMetadata` `:956`、`downloadFileChunkedByOffset` `:1222` | 呼叫端改成 `getClientFor(file.telegram_user_id)` 上的 method |
| `downloadThumbnails(messageIds[])` `:882` | 目前一次 `getMessages("me", ids)` 批次抓 → 改成**先按帳號分組**，每組一次批次呼叫 |
| `downloadFileMerge(splitGroupId)` `:1329` | 後端回的每個 part 各自帶 `telegram_user_id`，逐 part 挑 client（4.2 之後 part 本來就散在多帳號） |
| SW 串流 `/preview-video/{fileId}/{messageId}`（`service-worker/index.ts:182`、`main.tsx:231`） | URL 加一段 account id，`main.tsx` 轉發時據以挑 client |

**順手加一道防呆**（成本一行，價值很高）：`getFileLocation` 拿到 document 後，比對
`String(doc.id)` 與 DB 的 `file_id`，不符就 throw。DB 存了 `access_hash` / `file_id` 卻從不
使用；有了它，上述「靜默下載錯檔」就變成明確失敗。

---

## 測試

| 檔案 | 測什麼（編碼的意圖） |
|---|---|
| `backend/tests/test_linked_accounts.py` | ① 同一 tg 帳號綁第二個 owner → 409（**跨 drive 資料外洩的防線**）② owner A 的 `/files` 看得到掛在其 linked account 名下的檔案 ③ owner B 看不到 ④ 名下有檔案的帳號 DELETE → 409 ⑤ primary DELETE → 拒絕 |
| `backend/tests/test_schema_migration.py` | 對「只有舊欄位」的 DB 跑 `init_schema()` → `owner_id` 全部等於 `telegram_user_id`，且 `linked_accounts` 每人一列 primary（**升級不能讓既有使用者的檔案消失**） |
| `frontend` 新增 `src/lib/splitUpload.test.ts`（或 ponytail 式 `demo()` 自檢） | segment 清單以 index 排序後 offset 連續且總和 = filesize，**即使 message_id 亂序**（4.2 那行的回歸釘子） |

前端沒有既有單元測試框架，只有 Playwright E2E。若不想為此引入 vitest，就在
`splitUpload.ts` 內放一個 `assert` 式自檢函式，由 E2E 或 dev-only 路徑呼叫。

---

## 驗證

1. `cd backend && python -m pytest tests/`
2. **升級路徑**：先用現有 `.db` 檔跑一次 `docker compose up --build`，確認舊檔案清單完整可見、
   可下載（這是 Phase 1 的主要風險）
3. `docker compose up --build` → 開 `http://127.0.0.1:3000`
4. 設定 → 新增第二個 Telegram 帳號，走完 challenge 流程，帳號列表出現兩筆
5. **加速驗收**：拖 20 個中型檔進去，DevTools Console 應看到兩組獨立的 `[ChunkRate]` log
   （不同 accountId），且 localStorage 有兩把 `teledrive_chunk_rate_v2_*`；總耗時明顯短於
   單帳號基準
6. **正確性驗收**：上傳一個 >1GB 的大檔（會切 ≥3 段、散落多帳號）→ 下載回來後
   **比對 SHA-256 與原檔一致**。這是 4.2 排序改動的唯一有效驗收
7. 重新整理頁面，確認縮圖全部載出（驗證 4.3 的按帳號分組批次抓）
8. 影片預覽播放正常（驗證 SW 串流的 account id 傳遞）
9. 最後開 `https://teledrive.yoyotsaoteledrive.dpdns.org` 確認線上環境正常（CLAUDE.md 規則）

---

## 已知風險與範圍外

1. **後端仍有一份 `.env` 全域 session**。`telethon_service.py:329` 與
   `telegram_bot_service.py:34` 讀 `TELEGRAM_SESSION_STRING`，`stream_file` / `get_file_info`
   走的是**這個帳號**的 `get_messages("me")`，跟登入者無關。多帳號後這條路徑對非該帳號的檔案
   一律錯。**實作前要先確認前端還有沒有打這兩個端點**；若沒有，順手刪掉比留著更安全。
2. **瀏覽器可能先成為瓶頸**。N 個帳號 = N 條 MTProto WebSocket + N×12 併發 chunk。若上行頻寬
   或 WebSocket 數先飽和，N 倍吞吐拿不到。使用者已知悉並選擇此方案；若實測撞牆，加一個全域
   上限即可（`accountPool.ts` 內一行）。
3. **解綁帳號 = 那些檔案永久失聯**，故 DELETE 擋在有檔案時。跨帳號搬檔（forward + 重
   register）不在本次範圍。
4. **JWT 仍是 30 天長效 bearer**，`CORS allow_origins=["*"]`。Phase 0 的 plan 已列為另案。
5. `uploadFile()`（`gramjs.ts:391`）與 `downloadThumbnail()`（`:842`）沒有呼叫者，是死碼。
   Phase 2 重構時直接刪掉，少兩個要改成 per-account 的地方。

---

## 建議的落地順序

Phase 0 →（可獨立驗證、可獨立 commit）
Phase 1 → 後端改完，前端不動也應完全正常運作（owner_id == telegram_user_id）
Phase 2 → 前端 pool 化，仍只有一個帳號，行為不變 —— **這一步的驗收就是「什麼都沒變」**
Phase 3 → 能綁第二個帳號，但上傳仍只走 primary
Phase 4 → 才真正開始分派

每一 phase 都能單獨 `docker compose up` 驗證後再進下一步，不要合併 commit。
