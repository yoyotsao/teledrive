# Chat 媒體匯入 — 設計文件

日期：2026-08-17
狀態：待實作

## 目標

給定一個 channel / group 的 id（或 username / t.me 連結），把該 chat 內**所有媒體**（圖片、影片、檔案）由舊到新逐則 forward 到使用者自己的 Saved Messages，並在 drive 的 `root/{chat name}` 資料夾下註冊成檔案。

## 為什麼一定要 forward 到 Saved Messages

現有下載路徑全部硬編 peer `"me"`：

- `frontend/src/lib/gramjs.ts:305` — `getFileLocation()` → `getMessages("me", ...)`
- `frontend/src/lib/gramjs.ts:836` — `downloadFileMetadata()`
- `frontend/src/lib/gramjs.ts:770` — `downloadThumbnails()`

若只把來源 chat 的 message id 寫進 DB 而不 forward，這三條路徑都會查不到訊息。forward 到 Saved Messages 後，匯入的檔案與一般上傳的檔案在下載端完全同構，不需要為「外來檔案」開第二條下載路徑。

forward 是 Telegram 伺服器內部搬移 media 參照，**不傳輸檔案內容** — 不耗使用者頻寬，也不違反「binary 不經過 Python 後端」的架構不變量。

## 架構

純前端功能，**後端零改動**。

新增：

- `frontend/src/lib/chatImport.ts` — 匯入邏輯與純函式（檔名推導、去重）
- `frontend/src/lib/chatImport.selfcheck.ts` — assert-based 自我檢查
- 一個匯入對話框元件（沿用 `components/` 既有的 inline style 風格）

修改 `frontend/src/lib/gramjs.ts`：

- 新增 `resolveChat(input)`、`iterChatMedia(entity)`、`forwardToSaved(entity, msgId)`
- 為 `MessageMediaPhoto` 補上下載分支（見「照片支援」）

沿用既有後端 API：`POST /api/v1/folders`、`GET /api/v1/files`、`POST /api/v1/files/register`。

## 流程

1. **解析 chat** — `client.getEntity(input)`。輸入可為 `@username`、`t.me/...` 或數字 id（含 `-100` 前綴）。私有 channel 用數字 id 解析失敗時，先 `getDialogs({ limit: 200 })` 灌 peer 快取再重試一次；仍失敗則明確報「此帳號無法存取該 chat」。
2. **前置檢查** — 若 `entity.noforwards` 為真，立刻中止並告知「此 chat 禁止轉發，無法匯入」。不要開跑後才失敗。
3. **建立/沿用資料夾** — 資料夾名取 `entity.title`（`User` 型則取 `firstName lastName`）。先 `GET /folders?parent_id=null` 找同名資料夾，有就沿用，沒有才 `POST /folders`。
4. **建立去重集合** — `GET /files?parent_id={folderId}`（分頁取完），收集所有 `file_id`。這是續傳與重跑去重的唯一依據。
5. **由舊到新迭代** — `client.iterMessages(entity, { reverse: true })`，在 JS 端過濾出 `message.media` 為 `MessageMediaDocument` 或 `MessageMediaPhoto` 的訊息。

   不使用 Telegram 端的 `InputMessagesFilter*`：沒有任何單一 filter 同時涵蓋 photo + video + document，用多個 filter 分別掃再合併會破壞「由舊到新」的單一順序。全量迭代每次 `getHistory` 回 100 則，成本可接受。
6. **逐則 forward** — 取來源 media 的 id（`document.id` 或 `photo.id`）。已在去重集合中則跳過；否則 `forwardMessages("me", { messages: [msgId], fromPeer: entity })`，經既有 `messageRateLimiter` 節流，取回新訊息。
7. **註冊** — `POST /files/register`：

   | 欄位 | 值 |
   |---|---|
   | `message_id` | forward 後在 Saved Messages 的新 message id |
   | `file_id` | 轉發後訊息中 media 的 id（假設 forward 不改變 media id，故等同來源 id，可當去重鍵） |
   | `access_hash` | forward 後訊息中 media 的 access_hash |
   | `parent_id` | 步驟 3 的資料夾 id |
   | `telegram_user_id` | 執行匯入的主帳號（`getPrimaryClient()`） |
   | `filename` | 見「檔名推導」 |
   | `filesize` / `mime_type` / `has_thumbnail` | 見「其他 metadata」 |
   | `file_hash` | `null` |

   註冊成功後把 `file_id` 加進去重集合。
8. **進度與中斷** — 對話框顯示「已匯入 N / 已跳過 M」，可隨時停止。停止或關閉網頁後重跑同一個 chat，靠步驟 4 的去重集合自動從中斷處接續。

## 檔名推導

`deriveFilename(message): string` — 純函式，`chatImport.ts` 匯出，由 selfcheck 覆蓋所有分支。

| 來源 | 規則 |
|---|---|
| document 有 `DocumentAttributeFilename` | 直接用 `fileName` |
| 有 `DocumentAttributeVideo`、無檔名 | `video_{msgId}.{ext}` |
| 有 `DocumentAttributeAudio` 且有 `title` | `{performer} - {title}.{ext}`（無 performer 則只用 title） |
| 有 `DocumentAttributeAudio` 無 title | `audio_{msgId}.{ext}` |
| 有 `DocumentAttributeAnimated` | `gif_{msgId}.mp4` |
| 有 `DocumentAttributeSticker` | `sticker_{msgId}.webp` |
| 其他 document 無檔名 | `file_{msgId}.{ext}` |
| `MessageMediaPhoto` | `photo_{YYYYMMDD_HHmmss}_{msgId}.jpg`，時間取 `message.date` |

- `{ext}` 由 mime 推導：小對照表（`video/mp4`→`mp4`、`image/jpeg`→`jpg`、`audio/mpeg`→`mp3`…），查不到則退回 mime 的 subtype，再查不到則 `bin`。
- 所有合成檔名都含 `msgId`，天然不撞名。
- 真檔名經 `sanitize()`：移除路徑分隔字元與控制字元、截斷到 200 字（保留副檔名）。
- **不使用 caption 當檔名**。caption 常是長段文字或含 emoji／換行，當檔名品質不穩定；有 `DocumentAttributeFilename` 時它也不會比真檔名好。

## 其他 metadata

- `filesize`：document 取 `document.size`；photo 取最大的 `PhotoSize.size`。注意 `PhotoSizeProgressive` 沒有 `size`，要取其 `sizes[]` 的最後一個元素。
- `mime_type`：document 取 `document.mimeType`；photo 固定 `image/jpeg`。
- `has_thumbnail`：document 看 `document.thumbs?.length > 0`；photo 恆為 `true`（photo 自帶較小的 size 可當縮圖）。
- `file_hash`：一律 `null`。計算 SHA-256 需要把整個檔案下載到瀏覽器，等於放棄 forward 的零流量優勢。代價：這些檔案不參與既有的雜湊去重功能。本功能自己的去重改用 `file_id`（Telegram media id），對「同一個 chat 重跑」這個實際場景已足夠。

## 照片支援

Channel 內的圖片多為原生 `MessageMediaPhoto` 而非 document。目前程式碼不支援：

- `gramjs.ts:305` `getFileLocation()` — 遇到非 `MessageMediaDocument` 直接 throw。
- `gramjs.ts:958` `downloadFileChunked()` — photo 分支**是壞的**：用了 `InputDocumentFileLocation`（photo 需要 `InputPhotoFileLocation`），且讀 `photo.size`，但 `Api.Photo` 沒有 `size` 屬性，只有 `sizes[]`。
- `gramjs.ts:770` `downloadThumbnails()` — 只認 document 的 `thumbs`。

需要在下列五處補 photo 分支，改用 `Api.InputPhotoFileLocation`（`thumbSize` 帶 PhotoSize 的 `type`）：

1. `getFileLocation()`
2. `downloadFileChunked()`（同時修掉現有壞分支）
3. `downloadFileChunkedByOffset()`
4. `downloadFileMetadata()`
5. `downloadThumbnails()`（photo 取較小的 size 當縮圖）

估計約 60 行。這同時修好一個既有的潛在 bug。

## 錯誤處理

| 情況 | 行為 |
|---|---|
| `entity.noforwards` | 開跑前中止，明確告知禁止轉發 |
| chat 無法解析 | 中止，告知此帳號無法存取 |
| `FLOOD_WAIT_x` | 沿用既有 rate limiter：等待後從同一則繼續，不跳過 |
| 單則 forward 失敗（來源已刪除、媒體過期） | 記錄並跳過，繼續下一則；結束時回報跳過清單 |
| `register` 失敗 | 該則視為失敗跳過（訊息已在 Saved Messages，下次重跑會被 forward 第二份 — 已知缺陷，見下） |

已知缺陷：forward 成功但 register 失敗時，重跑會產生重複的 Saved Messages 訊息（去重集合來自 DB，不含未註冊的那則）。發生機率低且後果僅為一份多餘副本，不為此加狀態表。

## 測試

- `frontend/src/lib/chatImport.selfcheck.ts` — assert-based，餵假 message 物件覆蓋 `deriveFilename` 的每個分支、`sanitize` 的邊界（超長檔名、含 `/`、含控制字元）、以及去重跳過邏輯。風格對齊既有的 `splitUpload.selfcheck.ts`。
- 瀏覽器實測：依 `CLAUDE.md` 的開發規則，實際匯入一個含照片與影片的 channel，確認 drive 內縮圖顯示正常、照片可下載、影片可播放。

## 刻意不做

- **批次 forward**（一次 100 則，快約百倍）。批次回傳的訊息與來源訊息需靠比對 media id 對應，複雜度不划算。以 `ponytail:` 註記在逐則 forward 處，標明升級路徑。
- **後端匯入任務表 / 背景執行**。所有 Telegram 操作在瀏覽器端，後端沒有使用者 session（認證走 bot challenge，session string 從不送到後端），無法代跑。
- **保留來源 chat 的時間分組或相簿結構**。全部平鋪在 `root/{chat name}` 下。
- **匯入文字訊息**。此功能只處理媒體。

## 開放風險

大型 channel 的絕對耗時：逐則 forward 約 1 則/秒，一萬則約需 3 小時，且網頁必須全程開著。續傳機制讓它可以分多次完成，但這仍是使用體驗上最明顯的限制。若實測發現無法接受，升級路徑是上面「刻意不做」的批次 forward。
