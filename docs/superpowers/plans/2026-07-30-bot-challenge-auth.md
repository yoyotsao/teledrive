# 移除 session string 的傳輸路徑 — 改用 Bot 挑戰碼驗證身分

## Context

**問題**：`POST /api/v1/auth/login`（`backend/app/api/routes.py:112`）要求前端把完整的
Telegram session string 送到後端。那串東西裡面是 **auth_key**，等於整個 Telegram 帳號的
控制權（讀所有私訊、以該身分發訊息、無需驗證碼）。後端拿它只為了一件事：確認
`telegram_user_id`，好知道 SQLite 裡的 metadata 該歸誰。

**現況讓事情更糟**：驗證完的 Telethon client 被存進 `user_sessions.py:7` 一個沒有 TTL、
沒有上限的全域 dict，而 `get_user_client` 在 `routes.py:11` 被 import 卻**從未被呼叫**。
等於把 auth_key 常駐在 server 記憶體裡，換不到任何功能。

**目標**：auth_key 永不離開瀏覽器。後端只收到「我就是這個 user_id」的證明。

**不在範圍內**（已與使用者確認）：`localStorage` 裡那份 session。GramJS 必須在瀏覽器跑
MTProto，session 一定得是前端可讀的，換 IndexedDB 或加密都只是障眼法 —— XSS 一樣拿得到。
真正有效的是 CSP 與依賴管控，另案處理。

**信任根**：改成信任「Telegram 告訴我們這則訊息的 `from_id` 是誰」。使用者的身分本來就由
Telegram 定義，這個信任是恰當的，而且後端不再需要持有任何憑證。

---

## 流程

```
1. POST /auth/challenge            → { nonce, bot_username, expires_in: 120 }
2. 前端用自己的 GramJS client：sendMessage('@<bot>', nonce)
3. POST /auth/verify { nonce }     → 200 { token, user_id, username, first_name }
                                     202 尚未收到（前端輪詢）
                                     401 nonce 無效 / 已過期 / 已用過
4. verify 成功後，前端刪掉自己那則 nonce 訊息（保持對話乾淨）
```

後端有一個背景 long-polling 迴圈在跑 Bot API `getUpdates`，看到 text 命中 `_pending`
就記下 `from.id`。`from` 物件同時帶 `username` / `first_name`，所以 `LoginResponse`
的欄位全部免費拿到，**後端完全不需要連 MTProto 來驗證身分**。

### 為什麼是背景迴圈，不是在 handler 裡直接 `getUpdates`

`getUpdates` 的 offset 是**全域單一游標**。若在 request handler 裡呼叫，兩個並行的驗證
請求會互相吃掉對方的 update，變成隨機失敗。這是不能為了少寫幾行而簡化掉的正確性問題。

---

## 要改的檔案

### 新增 `backend/app/services/bot_challenge.py`（約 50 行）

單一職責：管挑戰碼的生命週期，不碰 HTTP 路由也不碰 DB。

- `_pending: dict[str, float]` — nonce → 到期時間戳
- `_verified: dict[str, dict]` — nonce → `{user_id, username, first_name}`
- `new_challenge() -> str` — `secrets.token_urlsafe(16)`，TTL 120s，順手清掉過期項目
- `ingest_updates(updates: list) -> None` — **純函式，這是測試的主要標的**。
  掃訊息，text 命中 `_pending` 就搬到 `_verified`
- `take_verified(nonce) -> dict | None` — **pop，不是 get**。nonce 一次性，防重放
- `poll_loop()` — `getUpdates?offset=N&timeout=25` long polling，把結果餵給
  `ingest_updates`。網路 I/O 只在這裡，跟上面的純邏輯分開

### `backend/app/api/routes.py`

- **刪除**：`login()`（`:112`）、`_parse_gramjs_session()`（`:38`）、
  `_GRAMJS_DOMAIN_TO_IP`、`LoginRequest`、`store_user_session` / `get_user_client` import（`:11`）
- **新增**：`POST /auth/challenge`、`POST /auth/verify`。`LoginResponse` 沿用不動
- bot token 未設定時 `/auth/challenge` 回 **503**，訊息明確指出要設哪個環境變數

### `backend/main.py`

lifespan 啟動 / 取消 `poll_loop`。啟動時呼叫 Bot API `getMe` 取得 bot username 並快取
（不必再開一個環境變數手動維護），同時呼叫 `deleteWebhook` —— 若該 bot 曾設過 webhook，
`getUpdates` 會一路回 409。

### `backend/app/services/config.py`

加 `telegram_bot_token: Optional[str] = None`。`.env.example` 補一行與取得方式說明。

### 刪除

- `backend/app/services/user_sessions.py` —— 整個檔案，已無呼叫者
- `backend/tests/test_login_session_parsing.py` —— 測的是被刪掉的解析器

### 前端

- `src/api/client.ts:41` — `loginToBackend()` 換成 `requestChallenge()` /
  `verifyChallenge(nonce)`
- `src/lib/gramjs.ts` — 加 `sendAuthChallenge(botUsername, nonce)`：`sendMessage` 後回傳
  message id，供成功後刪除。`saveCredentialsToStorage`（`:1540`）不動 —— session 仍要留在
  本機給 GramJS 自己用
- `src/App.tsx:41` — `handleLogin` 改為 challenge → send → 每 1s 輪詢 verify，上限 60s
- `src/components/LoginScreen.tsx` — `onLogin(sessionString)` 簽名不變（前端需要 session
  才能發挑戰訊息）。只改狀態文字：「後端驗證中...」→「Telegram 驗證中...」

### `docs/superpowers/plans/2026-07-30-webdav-client-mount.md`

§1.1 整段作廢改寫。bridge 有 Telethon，一樣走 challenge → 私訊 bot → verify，
**不再需要**讓後端接受 Telethon StringSession 格式，那個格式轉換問題整個消失。
§2.3 的「換 JWT」一列同步更新。

---

## 測試

`backend/tests/test_bot_challenge.py` — 純函式，不碰網路。每一條都對應一個安全性質：

| 測試 | 編碼的意圖 |
|---|---|
| 過期的 nonce `take_verified` 回 `None` | 竊聽到的 nonce 不能無限期使用 |
| 同一 nonce 第二次 `take_verified` 回 `None` | 一次性，防重放換到第二個 JWT |
| 餵含錯誤 nonce 的假 `getUpdates` payload → 不進 `_verified` | 亂猜 nonce 不會意外通過 |
| 正確 nonce 的 `from.id` / `username` 正確落地 | JWT 綁到的是發訊者，不是別人 |

---

## 驗證

1. `cd backend && python -m pytest tests/test_bot_challenge.py`
2. `docker compose up --build`，瀏覽器開 `http://127.0.0.1:3000` 走完一次登入
3. **關鍵驗收** — DevTools Network 開著登入，用 Search 搜 `localStorage.tg_session`
   的值：任何 request body / URL / header 都**找不到**它
4. `grep -rn "session_string" backend/` 只應剩 `generate_session.py`（那是給 bridge
   直連 MTProto 用的本機檔案，不是 API 路徑）
5. `docker compose restart backend` 後舊 JWT 仍可用 —— 前提是 `.env` 有固定
   `JWT_SECRET`（`backend/app/auth.py:9` 目前預設隨機，重啟即全員登出）
6. 最後開 `https://teledrive.yoyotsaoteledrive.dpdns.org` 確認線上環境正常（CLAUDE.md 規則）

---

## 前置條件與已知風險

**你要先做一件事**：到 @BotFather 建一個 bot，把 token 放進 `.env` 的
`TELEGRAM_BOT_TOKEN`。沒有這個東西整套動不了。

1. ~~**`sendMessage` 到未互動過的 bot**~~ —— **2026-08-07 實測通過**：瀏覽器 GramJS 對
   從未互動過的 `@TDSessionVerifybot` 直接 `sendMessage` 成功，`getUpdates` 也如期收到，
   不需要先按 `/start`。`t.me/<bot>?start=<nonce>` deep link 退路用不上。
2. **JWT 仍是 30 天的長效 bearer**（`auth.py:11`）。偷到 JWT 的人能操作 metadata。這次
   不處理，但它現在是最弱的一環 —— 換掉 session 傳輸後，剩下的攻擊面就是它。
3. **CORS `allow_origins=["*"]`**（`config.py:26`）。因為用 Bearer 而非 cookie，不構成
   CSRF，但等於任何網頁都能拿偷來的 JWT 直打 API。另案。
4. nonce 會經過 Telegram，Telegram 看得到 —— 無妨，nonce 對它沒用，換 JWT 得打後端，
   且一次性 + 120s 過期。
