# 內嵌縮圖 + 資料夾上傳 album 聚批 — 設計文件

日期:2026-07-10
狀態:已實作(album 聚批機制在真實帳號測試中證實不可行,已改採替代方案,見下方「實作後發現的問題」)

## 目標(原始設計)

消除小檔案上傳(尤其是縮圖與整個資料夾上傳)造成的 FLOOD_WAIT:

1. **縮圖不再產生獨立 Telegram message** — 改用 `InputMediaUploadedDocument.thumb` / `sendFile()` 的 `thumb` 參數內嵌在檔案本身的 message 上,額外 message 成本歸零。**（實作後發現:僅單檔/大檔路徑可行,詳見下方)**
2. **資料夾上傳導入 album 聚批** — 小檔案(≤10MB)累積 10 個一批,用一次 `SendMultiMedia` 送出。**（實作後發現:`SendMultiMedia` 在此帳號/GramJS 版本組合下完全無法運作,已改為逐檔案送出,詳見下方)**

## 實作後發現的問題(2026-07-10 補充,依發現順序記錄)

### 問題 1:`InputMediaUploadedDocument.thumb` 導致 `400 MEDIA_INVALID`

用真實帳號測試後發現:只要 `SendMultiMedia` 批次中任一項目的 `InputMediaUploadedDocument` 帶 `thumb` 欄位,整批就被伺服器以 `400 MEDIA_INVALID` 拒絕。移除 thumb 後這個特定錯誤消失,但接著發現問題 2。

另外,GramJS 的 `sendFile()` 便利方法的 `thumb` 參數不接受「已預先上傳好的 InputFile」——它期望原始檔案(自己內部上傳),與 `InputMediaUploadedDocument.thumb`(手動組 TL 請求專用,需要預先上傳的 InputFile)語意不同,兩者不可混用(這個問題只影響單檔路徑,已修正)。

### 問題 2:`messages.SendMultiMedia` 本身在此環境下完全無法運作(關鍵發現)

移除 thumb 後,album 批次上傳從「明確報錯」變成「永久卡住不回應」。用 CDP 監看原始 WebSocket 封包直接證實:`SendMultiMedia` 請求確實送出且被伺服器 ACK,但**從未收到 RPC 結果**——不是報錯,是完全沒有回應。進一步測試排除以下可能:

- 不是縮圖問題(移除縮圖後依然卡住)
- 不是併發縮圖下載干擾(清空所有 has_thumbnail 檔案後依然卡住)
- 不是圖片格式問題(純二進位非圖片檔案一樣卡住)
- 不是批次項目數問題(即使 batch size = 1 的單一項目「批次」也一樣卡住)
- 不是帳號被 Telegram 限流(官方 Telegram App 在同一帳號上可以正常多檔上傳)

結論:**`messages.SendMultiMedia` 這個 RPC 方法,在此帳號與這個 GramJS 版本(layer 198,即最新版 2.26.22)的組合下,無法正常取得回應**,屬於用戶端函式庫層級的相容性問題,非帳號限流、非請求內容問題。

**最終修正**:`uploadAlbum()` 放棄 `SendMultiMedia` 分組送出,改為逐檔案透過 `sendFileLocked()`(與單檔路徑相同、已證實可靠的機制)個別送出,靠既有的 `messageRateLimiter` 節流避免 FLOOD_WAIT。已用真實帳號驗證:4 張圖片一起丟,全部成功取得有效的 `telegram_message_id`。

**目標未能達成的部分**:「N 檔案 = 1 則 message」的訊息數縮減效益**沒有實現**——`SendMultiMedia` 批次送出本身就是失效的,只能逐檔案送出。album 累積器(`ALBUM_BATCH = 10`)保留,但現在只是控制「一次並行送出幾個檔案」的分組,不再減少實際 message 數。縮圖內嵌功能維持只在單檔/大檔路徑生效。

### 實際效果(100 張照片的資料夾)

| | 現行(功能加入前) | 原訂目標 | 實際結果 |
|---|---|---|---|
| 檔案 messages | 100(逐一 sendFile,受 rate limiter 節流) | 10(album ×10) | 100(逐一 sendFile,受 rate limiter 節流)—— **與加入本功能前相同** |
| 縮圖 messages | 100(逐一 sendFile) | 0(內嵌 thumb) | 0,但**僅限單檔/大檔路徑**;經小檔累積器上傳的檔案沒有縮圖 |

本次改動實際帶來的效益:縮圖不再是獨立 message(僅單檔/大檔路徑成立)、rate limiter 節流仍持續發揮 FLOOD_WAIT 防護效果。「批次縮減 message 數」這個當初的核心賣點在此環境下不可行。

## 背景

- 一般拖放/選檔上傳(`startUploadBatch`)已於 commit `02a773c` 導入 album 批次,但 album 路徑**不產縮圖**(本次順帶補上)。
- 資料夾上傳(`uploadFolder`)完全未走 album 路徑:每檔一次 `sendFile` + 每張縮圖再一次 `sendFile`。
- 縮圖上傳(`uploadThumbnail`)每張獨立一則 message,是 FLOOD_WAIT 的主要來源之一。
- **DB 可整個重寫**(無運行中資料、無需遷移),schema 直接改乾淨。

## 設計

### 1. DB Schema(breaking change,直接重建)

- `files` 資料表**移除** `thumbnail_message_id INTEGER` 欄位。
- **新增** `has_thumbnail INTEGER NOT NULL DEFAULT 0`(0/1)。
- 縮圖一律內嵌在檔案自身 message 的 document thumb(PhotoSize)上;`has_thumbnail = 1` 表示上傳時成功附上縮圖。
- 分段大檔(split file)只有第一段(parts[0],即原本掛縮圖的那筆)設 `has_thumbnail = 1`。
- 開發環境直接刪除舊 `teledrive.db` 重建,不寫 migration。

### 2. 上傳端 — 縮圖內嵌

#### gramjs.ts

- `uploadAlbum(files, thumbs?, onProgress?)`:新增可選參數 `thumbs?: (Blob | null)[]`,與 `files` 對齊。
  - 有縮圖的檔案:先以 `client.uploadFile()` 上傳縮圖 bytes 取得 `InputFile`(這是 `SaveFilePart`,**不是 message**,不經 `messageRateLimiter`),填入 `InputMediaUploadedDocument.thumb`。
  - 回傳值增加每檔 `has_thumbnail: boolean`(縮圖是否成功附上)。
- `uploadFileSplit(file, onProgress?, thumb?)`:新增可選 `thumb?: Blob`。
  - 小檔路徑(≤10MB CustomFile):`sendFile` 帶 `thumb` 選項。
  - 大檔路徑(InputFileBig):僅第一段的 `sendFileLocked` 附 thumb。
- **移除** `uploadThumbnail()`(獨立縮圖 message 的唯一生產者)。

#### ChonkyDrive.tsx

- `uploadWithThumbnail`(單檔路徑):縮圖擷取照舊與 chunk 上傳並行,但改為在最後 `sendFile` **之前** await 縮圖(擷取 <1s,大檔上傳遠慢於此,幾乎零額外等待),作為 `thumb` 傳入。移除上傳後的 `PATCH updateFile(thumbnail_message_id)` 與 `scheduleThumbnailRefresh` 呼叫。
- `uploadAlbumBatch`(album 路徑):flush 前對圖片/影片並行擷取縮圖(影片沿用 15s timeout),傳入 `uploadAlbum` 的 `thumbs`。**修復 album 路徑無縮圖的既有缺口。**
- `registerFile` 一律帶 `hasThumbnail`(取代 thumbnailMessageId)。

### 3. 資料夾上傳 — 最小改動聚批

保留 `uploadFolder` 現有「邊掃描邊上傳」結構,新增**小檔累積器**:

- fresh(通過 hash 去重)且 ≤10MB 的檔案進 buffer;湊滿 **10 個**即以 `uploadAlbumBatch` flush;遍歷與所有上傳完成前做最後一次 flush(不足 10 也送)。
- album 實際送往 Saved Messages,`parent_id` 只是 DB metadata(`registerFile` 逐檔各自帶自己的 folderId),因此**同一批可混不同子資料夾的檔案**,累積器不需按資料夾分組。
- 大檔(>10MB)照走現行 `uploadFileEntryFresh` split 路徑,縮圖改為內嵌(await 擷取後傳入 `uploadFileSplit`)。
- hash 去重維持在進 buffer 之前;重複檔不佔批次位。
- 進度 UI 沿用現有 `visibleFiles` 滾動視窗與 `uploadTotals` 計數。

### 4. 下載端 — 縮圖讀取

- `downloadThumbnails(messageIds)`(gramjs.ts):輸入改為 `has_thumbnail = 1` 檔案的 `telegram_message_id`。維持一次 `getMessages` 批次抓 message,再 `client.downloadMedia(message, { thumb: <最大 PhotoSize> })` **只下載內嵌縮圖(幾 KB),絕不下載 document 本體**。
- `loadThumbnails`(ChonkyDrive.tsx):篩選條件由 `f.thumbnail_message_id` 改為 `f.has_thumbnail && f.telegram_message_id`;IndexedDB 快取邏輯(以 `file_id` 為 key)不變。
- 後端 `GET /files/{id}/thumbnail`:`_download_thumbnail_base64` 改為抓檔案自身 message 的 document thumb(Telethon `download_media(message, thumb=-1)`);`thumbnails/{file_id}.jpg` 磁碟快取邏輯不變。

### 5. 刪除流程簡化

- 檔案刪除時不再需要刪獨立縮圖 message(routes.py 目前同時收集 `telegram_message_id` 與 `thumbnail_message_id` 去刪),內嵌縮圖隨檔案 message 一併消失。
- `cleanup_orphans.py` 同步移除 thumbnail_message_id 邏輯。

### 6. CLAUDE.md 規則更新

原規則「video 縮圖只能用 `thumbnail_message_id`,絕不 fallback 到 `telegram_message_id`」的顧慮是誤抓整個 video document。新架構下該欄位已不存在,規則改為:

> 縮圖一律內嵌在檔案自身 message 的 document thumb;下載縮圖只能抓 thumb PhotoSize(`downloadMedia` 的 `thumb` 參數 / Telethon `thumb=-1`),**絕不下載 document 本體**。

同步更新 API 表格(PATCH 說明、schema 欄位)。

## 錯誤處理

- 縮圖擷取失敗 / timeout:非致命,該檔以無縮圖上傳,`has_thumbnail = 0`。
- 縮圖 bytes 上傳(SaveFilePart)失敗:同上,退化為無縮圖,不阻擋檔案本體。
- album flush 失敗:沿用現行 — FLOOD 錯誤觸發 `penalizeForFlood` + 單次重試;整批最終失敗時逐檔標記錯誤狀態。
- 資料夾上傳中單一 batch 失敗不影響其他 batch 與大檔上傳。

## 影響檔案清單

| 檔案 | 變更 |
|---|---|
| `backend/app/services/database.py` | schema:移除 `thumbnail_message_id`、新增 `has_thumbnail`;insert/update 函式 |
| `backend/app/models/schemas.py` | Pydantic 模型欄位替換 |
| `backend/app/api/routes.py` | register/update/delete/thumbnail 端點;`_download_thumbnail_base64` 改抓 doc thumb;移除 deprecated 縮圖端點殘留說明 |
| `backend/app/services/file_service.py` | 欄位替換 |
| `backend/cleanup_orphans.py` | 移除縮圖 message 清理邏輯 |
| `backend/tests/test_folder_cascade_delete.py` | 欄位替換 |
| `frontend/src/types/index.ts` | `FileInfo.has_thumbnail` |
| `frontend/src/api/client.ts` | `registerFile` 帶 `hasThumbnail`;`updateFile` 移除 thumbnail 參數(保留 parent 移動) |
| `frontend/src/lib/gramjs.ts` | `uploadAlbum` thumbs 參數、`uploadFileSplit` thumb 參數、移除 `uploadThumbnail`、`downloadThumbnails` 改抓 doc thumb |
| `frontend/src/components/ChonkyDrive.tsx` | 三條上傳路徑改內嵌縮圖;`uploadFolder` 小檔累積器;`loadThumbnails` 篩選條件 |
| `CLAUDE.md` / `FRONTEND_FEATURES.md` | 規則與文件更新 |

## 測試計畫

- **Playwright E2E**:
  - 資料夾上傳(混小檔/大檔/重複檔)→ 驗證檔案數正確、小檔走 album(可由 console log 或 network 觀察 SendMultiMedia 次數)。
  - 多檔照片上傳 → 縮圖正常顯示(驗證 album 路徑內嵌縮圖 + 下載端 thumb 抓取)。
  - 既有 `upload_dedup.spec.ts` 與 perf 測試通過(欄位改名處同步更新)。
- **Backend pytest**:register/list/delete 走新 schema;`test_folder_cascade_delete.py` 更新。
- **手動驗收**(依 CLAUDE.md 開發規範):於 `https://teledrive.yoyotsaoteledrive.dpdns.org` 實際上傳含照片的資料夾,確認縮圖顯示、無 FLOOD_WAIT。

## 明確不做(YAGNI)

- 不寫 DB migration(無既有資料)。
- 不動大檔 chunk 上傳(SaveBigFilePart)路徑的併發模型。
- 不改 `MESSAGE_SENDS_PER_SECOND` 等節流常數(album 化後現值已足夠保守)。
- 不合併 `uploadFolder` 與 `startUploadBatch` 為單一管線(使用者選擇最小改動;留待未來重構)。
