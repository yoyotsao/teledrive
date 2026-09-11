# 共用私有頻道儲存與舊檔一次性搬移

日期：2026-09-11

狀態：依第二輪 review 修訂，待再次審閱；功能、搬移腳本與真實 Telegram 自動驗收尚未實作或執行。

## 1. 目的與範圍

目前三個 Telegram 帳號已加入同一個私有頻道，且皆為管理員。使用者希望把新檔集中存入該頻道，降低單一儲存帳號失效造成檔案無法讀取的風險；同時提供一次性腳本，把既有檔案從各帳號的 Saved Messages 搬到頻道，保留 TeleDrive 的資料夾與檔案參考。

本次設計包含：

- 「設定 > 管理帳號 > 新增頻道」及逐帳號驗證。
- 全 drive 的上傳目的地選擇：Saved Messages（`@me`）或一個已設定的私有頻道。
- 一般上傳、批次上傳、分割檔案、下載、預覽、縮圖與影片串流的頻道支援。
- 原儲存帳號失效時，以其他可用帳號讀取同一則頻道訊息。
- 參考現有匯入 chat 的一次性搬移腳本、持久化進度與回復流程。

V1 同時只設定一個頻道，不建立多頻道分流、三份副本或同步服務。「新增頻道」是登錄既有頻道，不是透過 Telegram 建立頻道、加入頻道或修改管理員權限。未啟用頻道時，保持原有多帳號分配並上傳到各帳號自己的 `@me`。

設計預設：如果任何已連結帳號未通過驗證，顯示警告並阻擋啟用。這是草案採用的產品決策，使用者可以在審閱時改為允許部分帳號；後者必須另行定義可用帳號集合，不能只加警告而保持原排程。

## 2. 不可違反的架構

- Python backend 固定 port 8000，僅處理 SQLite metadata、設定及作業紀錄。
- 所有 Telegram RPC 由瀏覽器內的 GramJS client 執行；檔案 binary 僅在 Telegram CDN 與瀏覽器之間傳輸。
- 搬移優先使用 Telegram 端轉存。Python 不下載、不上傳、不代理檔案，也不接收 base64 檔案、縮圖或內容驗證用的 bytes。
- Frontend 固定 port 3000；供產品 Vite bundle 使用的設定才使用 `VITE_` 前綴。Telegram session、test-owner auth 與 CI-only credential 是 secret，禁止使用 `VITE_`。
- Secret 不得進入 URL/query string、frontend API request、bundle/build output、console/log、Playwright trace/video/screenshot/artifact 或提交的 fixture；缺少真實 Telegram CI 設定時，必須在 backend、frontend、Playwright、IndexedDB/session storage 或 Telegram 啟動前 fail closed。
- 功能驗收使用 Playwright MCP，不安排手動測試。單元及資料庫測試補足 UI 難以觸發的失敗情境。

共用頻道提供多帳號存取同一份資料的能力，不能保證頻道被刪除、訊息被刪除或 Telegram 服務不可用時仍能復原。完成搬移前，仍在 `@me` 的舊檔需要原帳號。

## 3. 現有程式依據

以下由 gpt-5.6-terra 子代理讀取工作區後整理；行號為撰寫時定位，實作前應重新定位。工作區既有 `gramjs.ts`、`segmentScheduler.ts` 與相關測試修改須保留。

| 區域 | 現況與實作接點 |
| --- | --- |
| 設定 UI | `frontend/src/components/SettingsDialog.tsx:134` 已有帳號管理區。 |
| 帳號 API | `frontend/src/api/client.ts:123` 提供 linked accounts 型別與 list/link/unlink。 |
| 一般／批次上傳 | `frontend/src/lib/gramjs.ts:549` 的 `sendFile`、`:820` 的 `UploadMedia`、`:912` 的 `SendMultiMedia` 及 fallback 使用 Saved Messages。 |
| 檔案 metadata 註冊 | `frontend/src/components/ChonkyDrive.tsx:900` 附近含分割檔註冊，須傳遞實際上傳位置。 |
| 下載 | `frontend/src/lib/download.ts:9` 依逐檔帳號選 client；分割檔依 `part_index` 取得各 part。 |
| 訊息／媒體定位 | `frontend/src/lib/gramjs.ts:454`、`:975`、`:1029`、`:1063` 的 location、縮圖、metadata、download 均需支援 chat。 |
| 縮圖／影片 | `frontend/src/components/ChonkyDrive.tsx:384` 的縮圖分組、`frontend/src/main.tsx:246` 起的 SW 請求及 split metadata 皆需接入位置解析。 |
| 匯入 chat | `frontend/src/lib/chatImport.ts:107` 先 `forwardToSaved` 再註冊目的地 metadata；`gramjs.ts:1388` 使用 `forwardMessages('me', …)`，目前依賴 primary client。 |
| 資料可見性 | `backend/app/services/database.py:430` 的檔案查詢以 `owner_id` 隔離 drive；`telegram_user_id` 是逐檔儲存帳號，不是 drive 擁有者。 |
| 去重與寫入 | `files.file_id` 是全域 PK；hash 去重依 `(file_hash, owner_id)`。`backend/app/services/database.py:243` 的 `insert_file` 使用 `INSERT OR REPLACE`，不適合直接用於搬移。 |
| 檔案取代 | `backend/app/services/file_service.py:140` 的註冊會依同資料夾 filename 取代 live row，搬移不能走這條新增／取代流程。 |
| 移除帳號 | `backend/app/api/routes.py:219` 在帳號仍有檔案時回 409；目前計數包含垃圾桶。需改成檢查是否仍有只能由該帳號存取的參考。 |

相關既有設計：`docs/superpowers/specs/2026-08-17-chat-media-import-design.md`。

## 4. 方案選擇

| 方案 | 效果與取捨 |
| --- | --- |
| 共用頻道位置＋逐帳號解析（採用） | 每份檔案只存一次；任一有權限的帳號可讀。需要完整修改位置解析與讀取入口。 |
| 三帳號各存一份 `@me` | 需三次上傳、三組位置及副本一致性機制，與使用者已準備的頻道配置不符。 |
| 僅改上傳目的地 | 修改較少，但讀取仍綁原帳號，不能達成帳號失效後繼續讀檔的目標。 |

採用第一案。設定只決定新工作的目的地；既有檔案永遠依自己的位置讀取，不能依當下的全域上傳設定推算位置。

## 5. 設定與驗證互動

### 5.1 新增頻道

1. 使用者進入「設定 > 管理帳號」，看到目前目的地及「新增頻道」。
2. 點擊後開啟 dialog，輸入「頻道 ID」，例如 `-1001234567890`；說明所有已連結帳號都必須已加入。
3. 接受 Bot API marked channel ID（例如 `-1001234567890`）或純數字原始 channel ID。API／DB 唯一格式為 **MTProto raw channel ID 的正整數十進位字串**，例如兩種輸入都存成 `"1234567890"`。詳細轉換見 6.1；不以一般負群組 ID 猜測頻道，不要求使用者輸入 access hash。
4. 點擊「驗證」後，列出本 drive 所有已連結帳號，包括 primary。不能只檢查目前已連線的 client，也不能把 session 過期帳號靜默排除。
5. 每個帳號顯示驗證中、可讀寫、可讀但不可發文、未加入／無法存取、需要重新登入或暫時無法驗證。
6. 全部帳號確認可讀且可發文後，顯示解析出的頻道名稱及 ID；「儲存並啟用」才可點擊。儲存成功後更新全域目的地。
7. 任何帳號失敗時顯示具名警告與原因，保留輸入及各帳號結果，可重試；取消或驗證失敗均保留原目的地。

普通成員可以具備讀取能力，但未必能在 broadcast channel 發文。V1 啟用條件是所有已連結帳號都有讀取與發文能力；頻道建立者符合，管理員需具備對應發文權限。單純顯示「管理員」不足以判定能上傳。[Telegram 管理員權限](https://core.telegram.org/constructor/chatAdminRights)

### 5.2 Telegram 驗證方式

- 每個帳號使用自己的登入 session 解析同一 channel ID；先用該 client 的 entity cache，必要時分頁刷新 dialogs 再比對。
- 私有頻道只有數字 ID 不足以完成 RPC；必須先由該帳號取得 entity/access hash。跨帳號或重新登入後不可沿用另一個 session 的 peer access hash。[Telegram peer database](https://core.telegram.org/api/peers)
- 使用 `channels.getParticipant` 查詢該帳號自身身分，搭配 channel 資訊確認可見性、成員狀態與發文權限。`USER_NOT_PARTICIPANT` 與 `CHANNEL_PRIVATE` 顯示具體警告；無法解析、timeout、`FLOOD_WAIT`、登入失效分開呈現，不全部宣稱「不在頻道」。[Telegram 成員查詢](https://core.telegram.org/method/channels.getParticipant)
- 僅接受本功能支援的私有 broadcast channel；群組、supergroup、monoforum、使用者 ID 或公開頻道不在 V1 支援範圍，顯示可理解的錯誤。
- 驗證只讀取 Telegram 資訊，不發測試訊息、不邀請帳號、不提升權限。
- 驗證結果有效五分鐘，僅綁定首次「儲存並啟用」的 canonical channel ID、帳號清單版本及前端各 client 的 `session_generation`。世代是 **純前端 invariant**：每次重新登入、替換 session 或使 client 失效時產生新 token；重新載入頁面即清除可用驗證結果，不能把 server 摘要還原為本機已驗證狀態。這個 TTL 不是已儲存 target 的 runtime 授權或停用計時器。
- 非同步驗證開始時保存 generation，結果返回及送出設定前都必須比對；不一致則捨棄並重新驗證。其他分頁替換／移除本機 session 時須通知使舊 generation 失效。一般網路重新連線若仍是同一 auth session，不必換代。
- Backend 不知道 session generation，不收 session 字串、不新增 epoch handshake，也不宣稱可以拒絕「session stale」。`PUT /storage-target` 僅根據 server 時間檢查每帳號結果 TTL、完整性、owner scope、canonical channel、expected setting version／accounts version；未來時間或超過五分鐘的 `checked_at` 拒絕。前端自行承擔 session freshness；真正的讀寫權限仍由每次 Telegram RPC 判定。
- 前端驗證摘要及後述 migration evidence 都是已登入 drive 使用者的回報，不是 Telegram 簽署證明。Backend enforce 的是資料完整性與交易條件，並非獨立執行或證明 Telegram 驗證。

### 5.3 啟用後

- UI 可切回「Saved Messages（@me）」；只影響後續新工作。移除頻道設定不刪 Telegram 頻道、訊息或既有檔案位置。
- 新增、移除、重新登入帳號會使下一次 enable/save 的摘要失效；已啟用 target 的 runtime resolver/uploader 每次從本 browser 目前已 linked、可用且 live access 的 manager lazy resolve，並快取帳號本地 entity/readability。它不依 enable summary，因此 TTL 過期、reload、relogin 或新 browser 只登入一個 linked account 後仍可使用已儲存 target。
- 啟用後某帳號失效或退頻道，只有尚有至少一個 live reader 或 writer 時才顯示 degraded warning；初次啟用的全員檢查不能變成日後「少一帳號就完全停機」。
- 沒有任何可寫帳號時暫停新上傳、保留 channel target 並回 `UPLOAD_UNAVAILABLE`；不得自動把檔案改存 `@me`。沒有任何可讀帳號時保留 metadata/target 並回可恢復的 `READ_UNAVAILABLE`；不得嘗試 `@me`。恢復任一合格 manager 後在同一 target 正常繼續。
- 只剩一個可讀帳號時提示目前沒有帳號備援；使用者仍可讀取。

## 6. 資料模型與 metadata API

以下是新增契約，不代表現有端點已具備這些能力。

### 6.1 位置與設定

| 位置 | 新增／調整欄位 | 規則 |
| --- | --- | --- |
| Drive 設定 | `storage_mode: saved_messages \| channel`、`channel_id: TEXT nullable`、`channel_title`、`version` | 依 `owner_id` 儲存；預設 `saved_messages`。channel ID 僅存 raw 十進位字串。 |
| 驗證摘要 | `owner_id`、`channel_id`、`telegram_user_id`、`can_read`、`can_write`、`status`、`checked_at`、`accounts_version` | 僅為狀態快照，不儲存可供其他帳號共用的 channel access hash。 |
| `files` | `telegram_chat_id: TEXT nullable` | `NULL` 一律保留舊語意：該 row 的 `telegram_user_id` 帳號之 Saved Messages；頻道僅存 canonical raw ID。 |
| `files` | `telegram_media_id: TEXT nullable` | 將 Telegram document/photo ID 與既有 logical `file_id` 分離；舊 row 保持未知，讀取原 message 後解析，不直接複製 `file_id`。 |
| `files` | `telegram_media_kind: document \| photo \| NULL` | 與 media ID 一起寫入；legacy 兩欄都為 NULL，取得 fresh message 後一併填入，禁止只填其中一欄。 |
| `files` | `location_version: INTEGER`，預設 0 | 搬移提交及快取失效使用的遞增版本。 |
| 檔案 API／TS 型別 | 傳回上述位置欄位 | 一般列表、單檔、split parts、縮圖與 SW metadata 一致。 |

Canonical channel ID 契約：trim 輸入後以 BigInt 解析，raw 輸入去除前導零；拒絕零、小數、科學記號及超出支援範圍的值。對 Telegram 定義範圍內的 marked channel ID `m`，用 `raw = -m - 1000000000000n` 轉換，顯示時反算 `m = -(raw + 1000000000000n)`；不能任意截掉前三個字元。由解析到的 `entity.id` 再核對 raw ID 及 broadcast 類型。API 寫入只接受 canonical raw 字串，marked ID 僅限 UI 輸入／顯示；格式與範圍檢查依 [Telegram dialog ID 定義](https://core.telegram.org/api/bots/ids)。

設定比較、`files.telegram_chat_id`、operation target、migration 唯一鍵、hash target mismatch、API、SW metadata 與 cache key 全部使用同一 canonical 值，不使用 JavaScript Number。位置 key 區分 `saved_messages:<uploader_id>` 與 `channel:<raw_id>`；SQL 中需要唯一性的 peer key 使用非 NULL 的上述字串，避免 NULL unique 語意造成重複。

沿用 `telegram_user_id`、`telegram_message_id`、`access_hash`，但頻道 row 的 `telegram_user_id` 僅記錄執行上傳／搬移的帳號，不代表唯一可讀帳號。頻道讀取使用所選帳號重新取得的 message/media，不能把儲存的舊媒體 access hash 當作跨帳號讀取依據。[InputPeerChannel](https://core.telegram.org/constructor/inputPeerChannel) 的 channel ID 與 access hash 由所選 client 組合。

正式 media identity 為 `(telegram_media_kind, telegram_media_id)`，搭配 location 的 chat/message、媒體大小驗證；cache validation 也包含 kind，不能僅依 MIME 猜測。Document 的大小取 Telegram document size；photo 固定選最大可下載 variant，保存該 variant key 及其 byte size 供兩帳號比較（未知大小先於瀏覽器取得，未確定前不得通過驗證）。兩帳號比較的是同一目的地 media／variant，不要求目的地 media ID 等於來源。

`file_id` 繼續作為應用程式現有穩定識別，搬移不改變它，不依賴轉存前後 media ID 恰好相同。來源與目的地的 Telegram media ID 可以不同；註冊、hash 去重、刪除與快取均需明確區分 logical ID 與 Telegram ID。此變更不擴大為全站重新編號。

既有 split row 的 logical ID 可以是 `${splitGroupId}-${i}`，部分上傳結果的 `file_id` 是 upload handle，不是 Telegram document ID。新上傳與轉存都必須從回傳訊息的 `readMedia(message.media).id` 記錄 `telegram_media_id`。legacy row 先以原帳號和 message 取得 source media，不能以 synthetic ID 做 media 比對或拿它回填欄位；媒體缺失時明確失敗。

Schema migration 僅新增 nullable／有預設值欄位及新表；不推測既有檔案已在頻道，不更動既有檔名、資料夾、hash、垃圾桶狀態及時間戳。所有查詢與變更繼續依 `owner_id` 隔離。

### 6.2 API 責任

- `GET /api/storage-target`：目前設定與驗證摘要。
- `PUT /api/storage-target`：以 expected setting/account version 儲存設定及逐帳號驗證摘要；每一筆含 normalized `channel_id`、`channel_title`、`can_read`、`can_write`、`status`、`checked_at`、`accounts_version`。依 5.2 檢查完整性與 TTL，版本衝突回 409；不檢查 backend 無法得知的 session generation。
- `POST /api/telegram-operations`：idempotent 建立 durable intent，回傳 operation 及 immutable 發送參數；未獲得持久化確認前不能發送訊息。
- `GET /api/telegram-operations`、`GET /api/telegram-operations/{id}`：列出本 owner 未完成工作／取回 intent，供 reload recovery。
- `PATCH /api/telegram-operations/{id}`：以 expected version／lease 記錄 sending、RPC 或 update mapping、結果與錯誤，不能改 frozen account／peer／random ID。
- `POST /api/telegram-operations/{id}/reconcile-result`：只接收 `{ expected_operation_version, mapping, media_identity }`，其中 JSON mapping/media identity 必須已由 browser 用 frozen uploader/peer/random ID 做 read-only GramJS `getMessages`/media read 得到。backend 以 expected operation version 和 immutable owner/uploader/peer/random ID/result identity CAS；完整且相符時在同一 transaction 寫 journal result/version，將 `uncertain → sent`，或對完全相同的既有 `sent` 結果 idempotent 回傳。缺欄位、錯誤 mapping/media、錯誤 frozen identity 或 stale version 一律拒絕且不改狀態。它不 import Telegram client、不做 Telegram RPC、不接收 credential、access hash 或 binary。
- `POST /api/telegram-operations/{id}/register`：新上傳／chat import 的 idempotent metadata commit；同一 transaction 建立 row 與 operation→file 綁定、標為 registered。
- `POST /api/telegram-operation-groups/{group_id}/register`：split upload 的整組 idempotent register，逐 part 檢查 manifest 的預期數量／索引／大小與 sent 結果，同一 transaction 註冊全部 rows 及 bindings；任何 part 尚未 sent 或缺完整結果時回 409，建立零筆新 files rows。屬於 split group 的 operation 不可繞過此入口單獨 register。
- `POST /api/storage-migrations`：建立一次性搬移 manifest，凍結目標頻道、來源位置、parts 集合及版本。
- `GET /api/storage-migrations/{id}`：分頁取得工作、項目與進度。
- `PATCH /api/storage-migrations/{id}/items/{item_id}`：綁定共用 operation、記錄錯誤與重試狀態；forwarded 依 operation 結果衍生，verified 依 evidence 衍生，不接受任意指定 verified／applied。
- `POST /api/storage-migrations/{id}/items/{item_id}/reconcile`：唯一允許 `uncertain → forwarded` 的 endpoint；只接收 item CAS 和已由前述 operation journal 持久化的 `result_version`，在 SQLite 比對 immutable mapping/media identity 後轉換狀態。browser runner 的順序固定為：(1) frozen identity 的 read-only GramJS message/media read，(2) `reconcile-result` 以 operation CAS 持久化 mapping/result version 並使 shared operation `uncertain → sent`，(3) 本 endpoint metadata-only item CAS。backend 本身永遠不做 Telegram RPC。
- `PUT /api/storage-migrations/{id}/items/{item_id}/verifications/{telegram_user_id}`：upsert 9.4 的 evidence，檢查 owner、linked account、result version 與媒體欄位。
- `POST /api/storage-migrations/{id}/groups/{group_id}/commit`：單檔或 split group 的 SQLite 原子位置切換。
- `POST /api/storage-migrations/{id}/groups/{group_id}/rollback`：來源經瀏覽器重新確認可讀後，以版本條件回復 metadata；不刪除任何 Telegram 訊息。

路由名稱可配合現有 router prefix 調整，但責任不得合併成無驗證的任意 row 更新。所有端點使用既有登入驗證及 owner scope；不接受 session 字串、Telegram 二進位資料或任意其他 owner 的檔案。驗證和 journal metadata 不是可信任的任意指令，需做結構、數量、來源版本及狀態檢查。

### 6.2.1 既有 row 的 early relocation primitive

在 migration manifest 前就建立單檔 `switchExistingFileLocation(owner_id, file_id, expected_location_version, operation_id, result_version)` 與 split 專用 `switchExistingFileLocationGroup(owner_id, parts[{file_id, expected_location_version, operation_id, result_version}])`，以及 owner-scoped `POST /file-locations/{file_id}/switch`／`POST /file-location-groups/switch` API。兩者 consume 已存在的 durable operation journal；驗證 immutable owner、同一 frozen target、每個已持久化 destination result/media identity、每個 file source/location/tombstone CAS 後，在**同一 SQLite transaction**原子更新全部既有 row 的 chat/message/media location、遞增各自 `location_version`，並保存 idempotent switch binding。group request 的 part 集合必須恰等於既有 split group，任一 part/version/result/tombstone 不符即零 row 更新。它們只改 location，不改 logical file ID、檔名、parent、trash 或 replace semantics，不接觸 Telegram、不收 binary/credential。

此 primitive 供早期 channel-mode dedup 使用：browser 的原 `@me` 帳號 forward 到 frozen channel → browser 持久化 operation result → single row 或 all-parts group primitive switch。後期 migration 只在此 primitive 外增加 manifest、lease、resume、evidence/quorum 與 group orchestration；不得令早期 dedup 依賴後期 migration task。

### 6.3 共用 durable Telegram operation

一般／批次／split upload、chat import、migration 使用同一 SQLite primitive；migration item 只額外保存既有 row 的 source snapshot、quorum 與 apply 狀態。持久性範圍包含 `@me` 與頻道，不依賴 React state、JS memory 或 maintenance feature flag。

`telegram_operations` 每則預期產生的 Telegram 訊息一筆：

| 欄位 | 契約 |
| --- | --- |
| `operation_id`、`owner_id`、`kind` | UUID；kind 為 upload／chat_import／migration；同一 operation ID 的重試只回原紀錄，payload 不同回 409。 |
| `logical_file_id`、`group_id`、`part_index` | 新工作預先配發穩定 logical ID；split 每 part 一筆且關聯同一 group。migration 沿用現有 file ID。 |
| `uploader_id`、`target_kind`、`target_channel_id`、`target_peer_key`、`created_target_version`、`created_accounts_version` | 實際發送帳號及 immutable frozen target；`@me` 的 peer key 包含 uploader，頻道用 raw ID。後兩者只在 operation 建立時做 CAS/audit，不是發送後 registration 的全域設定拒絕條件。 |
| `random_id`、`rpc_kind`、`request_metadata` | cryptographic 64-bit random ID 以十進位字串保存；每則 message 一個。保存 caption／attributes、來源座標或原檔 fingerprint、file name／size／hash、parent 與 parts layout 等可重建工作的 JSON metadata，不存 bytes、session 或 file reference。 |
| `state`、`version`、`lease_owner`、`lease_expires_at`、`retry_at`、`error_code` | 支援 conditional claim、多分頁互斥、退避及 restart。 |
| `destination_message_id`、`destination_media_kind`、`destination_media_id`、`destination_size`、`destination_access_hash`、`result_version` | RPC／update 解析後逐步補齊；mapping 可以先於 media metadata 抵達。access hash 僅為 uploader 取得的 media metadata，用於相容既有 row，不是共用的 channel peer hash。完整結果後才是 sent。 |
| `registered_file_id`、`created_at`、`updated_at` | registered binding 作為 idempotency 證據；purge 後保留 tombstone，不讓舊 operation 重試復活檔案。 |

DB 對 `(uploader_id, random_id)` 建立唯一約束（比 Telegram peer 範圍更嚴格），因 `updateMessageID` 本身沒有 peer，需能以帳號與 random ID 唯一找到 intent，再以該 intent 的 frozen peer 取回訊息。訊息發送後不得改帳號／peer／random ID；重新登入同一 Telegram 帳號可以重新解析 peer 並恢復，不把 operation 永久綁死在某個前端 session generation。建立 operation 時才 CAS 當前 target/accounts version；Telegram side effect 後的 mapping/register 僅 CAS immutable operation、owner、tombstone 與 source/location，不能因使用者已切換設定或無關帳號變更而拒絕。

| Operation state | Allowed transition | Guard |
| --- | --- | --- |
| `planned` | `sending`, `tombstoned` | create CAS current target/accounts only here; durable intent must exist before RPC. |
| `sending` | `sent`, `recovering`, `retryable`, `uncertain`, `tombstoned` | result becomes `sent` only after immutable result mapping is saved. |
| `recovering` | `sent`, `retryable`, `uncertain`, `tombstoned` | reduce updates/result or retry original identity; never mint a new random ID. |
| `retryable` | `sending`, `recovering`, `tombstoned` | lease/retry time permits; frozen identity remains unchanged. |
| `sent` | `registered`, `committed`, `tombstoned` | register checks owner/result/tombstone/source/location, not a later global target/accounts version. |
| `registered`, `committed`, `tombstoned` | terminal | recovery may inspect but never automatically publish a new Telegram message. |
| `uncertain` | `sent` | Browser-owned frozen-identity read calls `reconcile-result` with expected operation version and authoritative mapping/media JSON; its SQLite transaction checks immutable identity, persists the result and makes this transition. Same complete sent result is idempotent; missing/mismatched/stale input leaves state unchanged. A later metadata-only migration CAS may advance its linked item after exact immutable identity match. Neither backend path emits Telegram RPC. |

Migration item states and transitions are defined exhaustively in 9.2; they are distinct from the shared operation state.

狀態另可附 blocked 原因（例如需要原檔或重新登入）；`uncertain` 僅用於恢復所需資料損壞／不完整、原帳號永久不可登入且結果未取得等例外。正常 timeout、reload、回應遺失進入 recovering，不直接進 uncertain。random ID 的去重是恢復線索，不能當作永久保證或在 `uncertain` 時盲目重送；唯有後述 readonly reconcile 能接受可信 mapping，且不產生訊息。

Migration operation 的 sent 結果供 item 的 forwarded／verified 使用；item apply 的同一交易將 operation 標為 committed。registered／committed 是恢復掃描的完成狀態；rollback 後保留 operation 結果與已消耗的 random ID，不把它重新排入發送。終止／purge tombstone 也不列為可自動重試工作。

### 6.4 訊息去重與 crash recovery

相同帳號、相同 peer、相同 `random_id` 的 Telegram 去重／`updateMessageID` 是可用的 recovery 線索；同一 RPC 尚在進行時可能回 `RANDOM_ID_DUPLICATE`。實作不得把該行為當成永久保證：先從 response、updates 與 frozen peer 解析 mapping，不能因 `uncertain` 或遺失結果盲目重送。這與 peer access hash 必須重新解析是兩件事。[Telegram updates／去重契約](https://core.telegram.org/api/updates)

恢復規則：

1. 訊息發送前先 durable 保存 intent 與 random ID，確認 sending checkpoint；DB 不可寫就不發送。`UploadMedia`／binary 分塊準備不是訊息發布，不能拿其 upload handle 當 random ID 或 destination media ID。
2. RPC response 與 main-window raw update handler 都可補齊 mapping，兩者走同一 idempotent reducer；同一 operation 若收到矛盾 mapping，報資料衝突，不覆寫結果。拿到 message ID 後，以 frozen peer 取得 fresh message 補齊 media kind／ID／size，先保存 sent 結果再註冊 metadata。
3. Main-window client 的 update adapter 使用帳號範圍的 IndexedDB 保存 recovery cursor（seq／pts／qts／date 與各 channel pts）及待寫 backend 的 mapping。接受 mapping 與推進 cursor 在同一本機 transaction 完成，不能先跳過更新再遺失 mapping；不保存任意聊天內容或媒體 bytes。正常更新和 `updates.getDifference`／channel gap recovery 共用 reducer，避免兩套各自推進的 cursor。
4. Reload 先載入未完成 SQLite operations，flush 本機待寫 mapping，再補取缺失更新；仍無 mapping 時，用 **原帳號＋原 target peer＋原 random ID** 重試原訊息 RPC。`RANDOM_ID_DUPLICATE` 保留 identity 並等待更新／退避重試，不換 random ID。不得僅憑相同檔名、大小或鄰近時間猜 destination。
5. 已 sent 未 registered 只重試 metadata commit，不再發送訊息或 binary；registered 重試回既有 binding，不再次走檔名取代／hash 新增流程。新 split group 全部 part sent 後原子註冊整組，避免部分 row 可見。
6. 若尚未發出訊息或重建原 RPC 需要已遺失的 File／過期 upload handle，標 `SOURCE_FILE_REQUIRED`，讓使用者重新選擇並核對原檔 fingerprint／parts。binary 只重送到 Telegram，仍沿用原 operation 的 random ID。已能由 mapping 取回目的地者不需重新選檔；不宣稱 journal 等於保留了使用者本機檔案。
7. 帳號切換只適用尚未建立發送 intent 的新工作；有 sending／recovering intent 的重試不交給其他 uploader。租約防止多分頁重送；即使租約失效競爭，仍使用固定 identity，由 Telegram 去重、DB conditional commit 收斂。
8. 不把去重紀錄當成訊息備份。已知 destination 被刪除時回 `DESTINATION_MISSING`；不用新 random ID 自動重建被刪訊息。刪除／取消後的 tombstone 同樣阻擋遲到註冊。
9. 對 `uncertain` migration item，reconcile 固定有三步且 execution owner 不可混淆：(1) browser runner 以 frozen uploader、peer 和 random ID 執行 read-only GramJS `getMessages`/message-media read；(2) browser 以 `expected_operation_version` 把 response/update mapping 與目的地 identity 作為 JSON 寫入既有 operation journal，只有完整 immutable result 相符才在同一 SQLite transaction 使 shared operation `uncertain → sent` 並取得 authoritative `result_version`；(3) browser 呼叫 migration reconcile endpoint，backend 只用 SQLite 的 persisted result/version 與 item CAS 使 item `uncertain → forwarded`。缺失、錯誤或 stale input 保持原 state。backend 不允許 Telegram RPC，即使 read-only，也不收 session、access hash 或 binary；browser 不可新建 identity 或盲重送。

這些是待實作的 application recovery 契約，不能假設現有 GramJS wrapper 已持久保存更新。現有單檔 `sendFile` wrapper 未提供顯式 random ID 接點，需改用可注入 `randomId` 的直接 `Api.messages.SendMedia` 發布步驟；album 每個 `InputSingleMedia`、forward 每個 vector element 也都使用已保存的 random ID，fallback 不得另產生 ID。

## 7. 上傳流程

1. 排入新工作時凍結目的地與設定版本。執行中的工作、重試及同一個 split group 全部使用同一目的地；設定切換不把半份檔案分散到不同模式。
2. `saved_messages` 模式維持現有帳號選擇和 `@me` 行為。
3. `channel` 模式在每次工作時僅從此 browser 目前 linked、local available 且 live write access 的 manager lazy select uploader，各帳號自行解析目的地 peer；不讀取或延展 enable-time TTL summary。沒有候選時回 `UPLOAD_UNAVAILABLE`、保留 channel target，零 `@me` fallback；候選恢復後同一 target 可續用。
4. 一般 `sendFile`、`UploadMedia`、`SendMultiMedia`、小檔 fallback、split parts 全部使用凍結的 peer；不能只改一個 `sendFile('me')` 呼叫。
5. 發送前建立 6.3 的 durable intent；backend operation 建立成功後，IndexedDB cursor/intent mirror 寫入成功才可 RPC。上傳結果的實際 channel、message ID、media kind／ID 與 uploader 先保存為 sent，再走 idempotent register。crash 在 backend create、IDB mirror、RPC、mapping 或 register 任一邊界時，reconcile SQLite operation、IDB cursor 與 Telegram response/update；album 為一個 group 加每則訊息各一 child operation/random ID，split 亦每 part 一筆，部分結果只可 recover 不能預設整組完成。
6. Telegram 成功而 metadata 註冊失敗時，reload 後從 SQLite operation／update mapping 恢復並只重試註冊；尚未取回 mapping 就進 recovering，依原帳號／peer／random ID 恢復。新上傳只要求 uploader 當次可寫，不套用 migration 的兩帳號 apply quorum。

頻道模式下 hash 命中既有 `@me` 檔案，不能直接沿用該位置並宣稱已存入頻道。先由原帳號 browser manager 以 frozen target forward、持久化 operation result，然後使用 6.2.1 early location-switch primitive 原子改既有 row；split 命中必須以 all-parts group primitive 和每 part 的 version/result binding 在同一 transaction 更新，不能逐 part switch。成功後才視為去重成功。此路徑不建立 migration manifest、不等待 lease/quorum/resume task。來源不可讀或其他搬移條件不滿足時，保留原 row 與可重試的上傳工作，回報 `STORAGE_TARGET_MISMATCH` 及原因，不標示上傳完成。若 hash 命中已在同一目的地的 row，才沿用既有去重行為。

一般 `/files/register` 保持同資料夾／原 filename 的既有 replace 服務語意。operation 首次 register 在同一 transaction 內先檢查 immutable operation、owner、result、tombstone 與 source/location CAS，再新增/replace row 並保存 operation→file binding；任何重試必先回既存 binding，不能再次觸發 replace。例：opA 初次 register 替換同名 row 後，opB 再上傳同名檔完成，opA 重試必回 opA 的 stored result，不能刪除或取代 opB。migration apply/rollback 僅做 location switch，保留最新 rename/move/trash 欄位，絕不呼叫 replace service。

## 8. 統一讀取與帳號容錯

新增共用的 file location resolver，**只在 main window 的 client manager context 執行**，輸入 row／part 位置與操作需求，於該 context 內輸出 client、peer、fresh message/media 及位置版本。所有下載、圖片／影音預覽、縮圖與 split parts 使用此入口；SW 串流經下述 bridge 間接使用。

- `telegram_chat_id=NULL`：只能選原 `telegram_user_id` 的 `@me`。不可拿其他帳號的相同 message ID 嘗試，避免讀到不相干的私有訊息。
- 頻道 row：resolver 從此 browser currently available linked manager lazy resolve/快取每帳號的 live channel access，優先選可用且有該頻道讀取權限的帳號；它不把 enable-time verification TTL 當 runtime access token。讀取 `(channel_id, message_id)` 並驗證正式 `(telegram_media_kind, telegram_media_id)` 與 size／photo variant，取得該 client 可用的 file reference。kind 決定 document／photo location constructor；legacy 兩欄未知時先讀原 message 確認，不能以 MIME 或 logical ID 猜測。reload/relogin/new browser 只要有一個 linked manager 可 live resolve 即可讀；零 reader 回 `READ_UNAVAILABLE` 並保留 metadata/target，不試 `@me`。
- 遇到登入撤銷、帳號無法存取或連線錯誤，以有限次嘗試切到其他候選帳號。`FLOOD_WAIT` 記錄可重試時間，避免忙迴圈。不能把網路錯誤當作訊息永久不存在。
- file reference 過期時以同一位置重新取 message 後重試；更換帳號也重新取 media。
- 串流切換帳號後從尚未完成的 byte range 繼續，已交付 bytes 不重複寫入；快取鍵包含 logical file ID、位置版本、part／range，GramJS entity 快取另外隔離帳號與 session。
- 縮圖批次分組不能只有 storage account；需納入 canonical chat／實際讀取帳號。SW 可見的位置只有純資料 descriptor，不含 GramJS runtime object。
- 頻道訊息已刪除或全部帳號均失敗時顯示原因，保留檔案 row；不以其他位置相同數字的 message ID 兜底。

Window ↔ SW bridge 契約：SW 以 `{request_id, file_id, part_id, location_version, offset, length}` 要求 range；main window 以當前 owner 的 metadata 驗證請求，再執行 resolver／Telegram RPC，回 `{request_id, location_version, offset, bytes}` 或可序列化的 metadata／error。Bytes 透過 transferable ArrayBuffer 在瀏覽器內傳遞，完全不經 Python。

SW 只處理 HTTP range、串流組裝、取消、timeout 與回覆匹配；不持有 Telegram client、session、peer access hash、file reference，也不自行選帳號或呼叫 Telegram。location version 改變時丟棄舊回覆並重新取得 metadata；request ID／offset 防止重試混入舊 bytes。所有 main windows 共用同一 resolver 模組，bridge 綁定發出請求的登入頁面，不任意廣播檔案 bytes。頁面關閉或無可用 client 時回 `CLIENT_UNAVAILABLE`，不改由 backend 代理。

頻道檔案不能因移除原 uploader 而失去 metadata。link 與 unlink 成功時各自在同一 SQLite transaction 遞增 owner 的 `accounts_version`。unlink 保護改為：仍有依賴該帳號 `@me` 的檔案（含所有垃圾桶 rows 與每一 split part）時維持 409；僅有頻道檔案時，至少另一個連結帳號已驗證可讀才允許解除，歷史 uploader 可保留為資料欄位，不作讀取 FK 依賴。解除前的 dependency query 與 delete 必須在同一 transaction 重新檢查。

### 8.1 原 primary 帳號失效後登入

既有 `POST /auth/verify` 已使用 `db.get_owner_of(telegram_user_id)` 找回 linked account 的原 drive，JWT 的 `user_id` 保留原 `owner_id`，`acting_account_id` 記錄實際登入帳號（`backend/app/api/routes.py:134–153`、`backend/app/auth.py:13–21`）。本功能沿用此契約；primary 失效後，其他仍 linked 的帳號可經 bot challenge 重新登入既有 drive。

前端單一 manager 初始化失敗會標為 offline，不應讓仍有效的其他 client 全部登出。每次 relogin、session replacement 或 client invalidation 都使該 manager 的純前端 `sessionGeneration` 失效；backend 不偵測 GramJS session。新瀏覽器只有在該瀏覽器登入過的 sessions，不能從 backend 取得其他帳號 session；首次全員驗證需明示缺少哪些帳號登入。已啟用頻道的 drive 則允許以目前可用的 linked 帳號讀檔，不能每次登入都要求失效帳號再次通過初次啟用檢查。

現有 `getPrimaryClient()` 取本機第一筆 account，並非可靠的頻道讀取選擇；新頻道流程及 chat import 不得依賴它，必須接受 selected `acting_account_id` 與其 manager。新 row 必須記錄實際非零 uploader ID。legacy `telegram_user_id=0` 無法確定原帳號時，先列入 dry-run 的「來源帳號不明」並要求明確對應，不能自動把目前登入的 secondary 當成來源。

資料庫 `is_primary` 目前不可透過 unlink 移除，這項限制保留；前述可移除的帳號指 non-primary linked account。本次不新增 primary promotion／retirement 流程，也不改 `owner_id`。此限制不應阻擋其他 linked 帳號登入與存取已在頻道的檔案。

### 8.2 垃圾桶、永久刪除與訊息生命週期

沿用既有 metadata-only 刪除契約，對 `@me` 與頻道完全一致：移到垃圾桶／還原只更新 SQLite 狀態；永久刪除（purge）／清空垃圾桶只移除對應檔案與資料夾 metadata，**不呼叫 Telegram delete RPC**。split group 的 metadata 以整組交易處理，不存在部分 Telegram parts 刪除或跨帳號刪除權限 fallback。

因此 purge 後 Telegram 訊息仍存在，可能成為無 TeleDrive 檔案參考的 orphan；UI 在永久刪除處明示「僅刪除 TeleDrive 紀錄，Telegram 訊息仍保留」。本功能不提供 Telegram 孤兒清理工具，也不因 unlink／移除頻道設定／migration／rollback 刪除來源或目的地訊息。

Purge 與 operation register／migration apply 使用交易條件互斥；已 purge 的 row 或 group 保留必要的 journal tombstone，遲到的 response／resume 不得復活它。Tombstone 僅保留去重與狀態所需識別，不保留原檔 bytes。已由 Telegram 外部刪除的頻道訊息則按讀取失敗處理，不能以其他帳號恢復同一則已刪訊息。

## 9. 一次性搬移腳本

### 9.1 執行形式與範圍

提供前端 TypeScript 維護腳本 `frontend/src/maintenance/migrateSavedMessagesToChannel.ts`，由固定 SPA 頁面 **`/maintenance/storage-migration`** 載入，在已登入的 TeleDrive 瀏覽器沿用帳號 client manager 執行。現有 App 可依 pathname dispatch 至該頁；重新整理／直接進入同一路徑都須可載入。

`VITE_ENABLE_STORAGE_MIGRATION=true` 是 build-time feature／discoverability gate，預設關閉，關閉時該路徑顯示不可用；它不是 security boundary。頁面受現有登入 gate 保護，未登入先登入並返回原 maintenance 路徑；每個 backend endpoint 仍獨立檢查 JWT 與 owner scope。頁面不在一般帳號設定顯示，不要求貼 session、console 程式或手工組 API request。

頁面至少提供：目的地摘要與「建立 dry-run」、manifest 的逐檔 eligibility／原因／quorum 與總數、以明確按鈕將該 manifest 建立為 apply job、目前 owner 的既有 jobs 列表、以 job ID 檢視／resume、及顯示影響項目後執行 metadata rollback。使用者不需自行尋找 job ID；按鈕狀態依項目及 quorum 顯示，錯誤可在原 job 續跑。關閉 feature flag 只隱藏入口，不刪除 journal。

V1 是一次性、可續跑的工具，不是背景 daemon。瀏覽器關閉即停止 Telegram 作業，重開後讀取 SQLite journal 續跑。提供 `dry-run`（預設）、`apply`、`resume(job_id)` 與 `rollback(job_id)` 模式；dry-run 只讀 Telegram／metadata，不轉存也不更改檔案 row。

預設來源是此 drive 目前全部非資料夾且 `telegram_chat_id=NULL` 的 metadata，包含垃圾桶與 split parts。已在目標頻道者略過；其他頻道位置不納入。以資料庫既有檔案為來源清單，不掃描所有 `@me` 歷史自動新增檔案。

沿用匯入 chat 的 Telegram message 解析、轉存結果抽取及錯誤處理；將 `forwardToSaved` 的能力抽成明確接受目的地與持久 random IDs 的 helper。正常「匯入 chat」也必須服從當前上傳目的地並使用 6.3 operation。它仍是新檔 idempotent register 流程，搬移則更新既有位置，兩者不能共用 `INSERT OR REPLACE`。

### 9.2 狀態與寫入順序

| Migration item state | Allowed next state | Required guard / effect |
| --- | --- | --- |
| `planned` | `sending`, `blocked`, `failed` | Manifest creation freezes owner/target/source/location after current target/accounts CAS; source preflight selects the named outcome. |
| `sending` | `forwarded`, `recovering`, `retryable`, `uncertain` | Same source/acting account sends only the immutable operation/random ID; save authoritative destination before `forwarded`. |
| `recovering` | `forwarded`, `retryable`, `uncertain` | Reduce response/update or retry original identity; never choose a new account/random ID or blind-send an uncertain item. |
| `retryable` | `sending`, `recovering`, `failed` | Lease and `retry_at` CAS; keeps the immutable operation. |
| `forwarded` | `pending_quorum`, `verified`, `retryable`, `failed` | Evidence starts against saved destination result. |
| `pending_quorum` | `verified`, `retryable`, `failed` | Fresh current-linked evidence may advance it; lack/expiry/unlink of evidence cannot trigger re-forward. |
| `verified` | `applied`, `pending_quorum`, `retryable`, `failed` | Commit transaction recalculates every part's fresh quorum; evidence expiry/unlink moves it back. |
| `applied` | `rolled_back` | Fresh browser source-read evidence plus applied location CAS; metadata only. |
| `uncertain` | `forwarded` | Browser first performs frozen uploader/peer/random-ID read-only `getMessages`/media read, then persists exact mapping/media JSON and `result_version` to the operation journal; only afterward does this endpoint make the metadata-only CAS transition. Backend makes no Telegram RPC, accepts no credential/binary, and missing/mismatched persisted data leaves it uncertain. |
| `blocked`, `failed`, `rolled_back` | terminal | Retry/retry-manifest or explicit user action only; no automatic Telegram send/forward mutation. `uncertain` is terminal except for the explicit read-only reconcile transition above. |

1. Preflight：盤點所有 linked accounts 的目標頻道狀態，包括缺 session／offline 原因；依 **每個 item** 判定是否可搬，並不要求所有帳號通過。檢查來源訊息與 parts 完整性，產生預計件數、parts 數、總大小及失敗清單。原帳號 `@me` 無法讀的 item 列為 `SOURCE_ACCOUNT_UNAVAILABLE`，其他 item 繼續。
2. 建立 durable manifest：僅此時 CAS 當前 target/accounts version；每個 item 保存 immutable owner、穩定 file ID、source 完整位置／fresh media identity、target canonical channel、group/part index、原 location version、共用 `operation_id`、狀態及重試時間。random ID、發送帳號與結果僅由 operation 保存，避免兩份權威資料不一致；發送前完成 sending checkpoint。manifest 建立後的 settings 切換或無關帳號連結不會使已轉存 result 無法 apply。
3. V1 由原帳號對其 `@me` message 執行 `messages.forwardMessages`，所以 **同一個來源帳號必須同時能讀來源及寫目標**；只有另一帳號可寫無法代它轉存 `@me`。保留 caption／媒體，預設 `dropAuthor=true`；RPC 的 random ID vector 取自已保存 operations。[Telegram 轉存 API](https://core.telegram.org/method/messages.forwardMessages)
4. RPC response 或 update recovery 取得目的地 message/media 後，browser 先寫 operation journal，item 才成為 forwarded；不得猜 destination message ID。`uncertain` 的 reconcile 亦由 browser read → journal persist → backend metadata transition 三步完成。正常 crash 使用 6.4 恢復。
5. 依 9.4 寫入目的地 verification evidence；至少兩個 distinct linked accounts 通過，其中至少一個不是 uploader。尚無第二個 verifier 的 item 為 pending_quorum；未達標不能 verified／apply。
6. 單檔可獨立提交；split group 必須全部 parts 通過 9.4 的 evidence 條件，backend 在同一 SQLite transaction 重算 currently-linked quorum、檢查 immutable manifest owner/source/tombstone/位置版本、更新整組位置、遞增 location version、將 items 標成 applied 並將 operations 標為 committed。不得因 manifest 後的全域 target/accounts version 改變拒絕；但 evidence 帳號已 unlink 或 evidence 失效時必須重新取得必要 fresh evidence。保留原 file IDs、parent、名稱、hash、排序、垃圾桶狀態及既有顯示時間。
7. 提交後使列表、縮圖與影片 metadata 快取失效。前端仍可依既有 row 身分找到同一檔案。

### 9.3 中斷、重試與回復

- Journal 至少對同一 source location/version 與 target channel 保持唯一操作；claim/lease 避免多分頁或兩個 runner 同時搬同一項。
- Telegram 已轉存且 journal 已保存 destination：resume 直接驗證／提交，不再發送。
- Telegram 回應遺失、程序在 sending 後崩潰：進 recovering，依 6.4 使用原帳號／原 target peer／原 random ID 恢復。update mapping 與相同 identity 的去重結果是正常恢復路徑，但不是永久保證；uncertain 僅用於原帳號永久不可登入且無結果、必要資料缺失或 recovery state 損壞且其他恢復方式均失敗等例外。所有情況都保留原參考，不能換帳號／random ID 猜重傳。
- `FLOOD_WAIT` 保存下次可執行時間，暫停對應帳號；採小批次與有限併發，不使用無限重試或多帳號繞過限制。
- 來源已刪除、受限不可轉存或沒有 media：記錄明確失敗，原 metadata 不變；不繞過 Telegram 內容保護，不自動改成下載重傳。
- DB commit 前檢查 immutable manifest owner、source location version、row 存在及 split parts 集合未變。檔案在搬移期間被 purge／另一次搬移更新則回衝突，不重建已刪除 row；rename/move/trash 等與位置無關的最新欄位不得被舊 snapshot 覆寫。rollback 額外要求每 part fresh browser source-read evidence 與 current applied-location CAS。
- 部分檔案成功可保留結果；split group 部分失敗時整組維持舊參考，已轉存 parts 保留在 journal 待續跑。
- 保留來源 Telegram 訊息，不自動清理來源或目的地孤兒訊息。rollback 先確認來源可讀，再以原子／版本條件還原位置；不覆蓋後續修改，不回復其他檔案 metadata。
- 報告逐檔／group 狀態、已搬件數、待續跑、失敗、未確定與孤兒 destination IDs；不包含 session、access hash、file reference 或媒體 bytes。

### 9.4 Quorum 與 verification evidence

全員通過只適用首次啟用頻道；migration 的寫入與 apply 條件依 item 分開判斷：

| 可用狀態 | 行為 |
| --- | --- |
| 三帳號中一個 offline，其餘兩個可讀目標；某 item 的來源帳號在其中且可寫 | 該 item 可轉存、由兩帳號驗證並 apply；offline 帳號的未轉存 `@me` items blocked。 |
| 來源可讀來源且可寫目標，但只有一個可用 reader | apply job 可轉存至 forwarded／pending_quorum，回 `INSUFFICIENT_VERIFICATION_QUORUM`，保留原 row；不重複轉存，等第二帳號恢復後 resume。 |
| 來源可讀但無目標寫權，其他帳號有寫權 | 該 item 回 `SOURCE_CANNOT_WRITE_TARGET` 並保持 planned；V1 不跨帳號接力轉存來源 `@me`。 |
| Destination 已 durable 記錄，原 uploader 隨後 offline，其餘兩個 linked accounts 可讀 | 兩個其他帳號可驗證並 apply。來源可讀／可寫是發送前置條件與已保存事實，不要求 apply 時原帳號仍在線；rollback 才需重新驗證來源。 |
| Destination 已轉存，但任何一則 part 未達 quorum | 單檔／整個 split group 不 apply，其餘獨立檔案仍可繼續。 |

新增 `migration_item_verifications`：

| 欄位 | 契約 |
| --- | --- |
| `item_id`、`telegram_user_id` | UNIQUE `(item_id, telegram_user_id)`，FK 至該 owner 的 item；同一帳號重試 upsert，不能累積成兩票。 |
| `operation_id`、`result_version`、`target_channel_id`、`destination_message_id` | 必須等於 item 所綁 operation 的 frozen target／結果；結果版本改變使舊 evidence 無效。 |
| `media_kind`、`media_id`、`size_bytes`、`photo_variant` | fresh destination message 的正式 identity／大小，與 operation result 一致；document 的 variant 為 NULL，photo 使用 6.1 固定選擇規則。 |
| `read_probe_ok`、`checked_at`、`received_at` | 瀏覽器以該帳號取回 media 並讀取非空小範圍 bytes（零長度檔以存在及大小驗證），只回傳 boolean 與 metadata。server 記錄 received_at，拒絕未來時間或超過五分鐘的 checked_at。 |

每次 apply 由 backend 在交易內自行計算：所有 part 的 operation 已 sent；每 part 至少兩筆當時仍 linked 至相同 owner、五分鐘內且 `read_probe_ok=true` 的 distinct account evidence；至少一筆的帳號不同於 uploader；channel／message／result version／kind／media ID／size／variant 全部符合該 part 的目的地結果。不能只檢查 `status='verified'`，也不能以 A 驗證 part 1、B 驗證 part 2 當作每 part 的兩票。

Evidence 過期回到 pending_quorum／要求重新驗證，目的地不重傳；移除帳號後其 evidence 不計票，重新取得 quorum 不要求其他 offline 帳號通過。Frontend 送 evidence 前依 5.2 檢查其 session generation；backend 不驗證自己無法得知的世代或 Telegram 事實。長 split group 可以分批轉存，但 apply 前需重新整理整組過期 evidence。

## 10. 驗收條件與交付 gate

功能實作後以 Playwright MCP 驅動已登入／測試用瀏覽器。isolated Playwright 使用可控制的 GramJS fake；真實 Telegram 行為須另外以測試頻道與帳號自動驗證，mock 通過不能宣稱已驗證 Telegram 跨帳號存取。交付前必須有非互動 `npm run test:real-telegram-shared-channel` runner、`frontend/playwright.real-telegram.config.ts` 和受保護 CI job，僅以 CI Node process secrets 注入三個專用測試帳號、test owner auth 與 canonical test channel；它們不得用 `VITE_`、URL、API request、bundle 或 log 傳遞。缺 secret/channel 時 runner 必須在 backend/frontend/Playwright/IndexedDB/session storage/Telegram 前 fail closed 為 `REAL_TELEGRAM_TEST_CONFIG_MISSING`，零 Telegram RPC，並將交付 gate 保留未完成，不得以人工登入或自行點擊取代。runner 在 spawn 前必須確認 8000 與 3000 都未被占用；任一 foreign listener 直接 fail closed、不 kill、不 reuse，也不啟動 Playwright/Telegram。它自建 isolated `TELEDRIVE_DB_PATH`（包含 WAL/SHM）、以 test `JWT_SECRET` 及空 `TELEGRAM_BOT_TOKEN` 啟動 backend 8000；spawn 失敗或 child 退出立即停止，readiness 只在所記錄 backend child 持續存活時進行，並以當次 run nonce 的 authenticated owner-scoped metadata probe 證明該 isolated SQLite DB。然後啟動 strict 3000 frontend；frontend spawn 失敗或 child 退出立即停止，3000 readiness 同樣只在其 child 持續存活時進行。現有 5173/manual auth setup 不可 reuse。runner 只記錄並清理自己 child PID 與明確 temp files，不碰既有 listener。Playwright context 只在 Node memory 的 `addInitScript` 初始化 session/IndexedDB，無 storage-state file，並關閉 trace/video/screenshot、清理 context/artifacts。`npx playwright test --config playwright.real-telegram.config.ts --list` 是不帶 secret、無 Telegram side effect 的 discovery check。

| 情境 | 預期結果 |
| --- | --- |
| 未設定／取消新增頻道 | 一般、批次、fallback、split 上傳仍進入各帳號 `@me`。 |
| 三帳號皆通過 | 可儲存；重新整理後仍選頻道；三帳號所有上傳路徑使用同一 channel。 |
| 一帳號不在頻道 | 顯示該帳號警告，不能啟用，原目的地不變。 |
| 無發文權／session 過期／網路錯誤 | 原因分開顯示，不誤報全員通過；權限恢復可重試。 |
| ID 表示、超出 JS safe integer、dialogs 分頁 | 正確解析同一頻道；拒絕錯誤類型，不誤用其他帳號 entity。 |
| Marked／raw／前導零輸入 | 同一頻道只存一種 raw decimal；DB 唯一鍵、target 比較與 cache key 一致；API 拒絕 marked、浮點及超出支援範圍的值。 |
| 儲存前帳號清單改變 | 驗證失效或 409，重新檢查完整清單。 |
| 驗證期間 session 換代或分頁 reload | 前端丟棄過期結果並重新驗證；backend 僅測試 TTL／清單版本／owner 契約，不假造 session epoch 驗證。 |
| 設定切回 `@me` | 已有頻道檔仍可讀；執行中的 split group 不換目的地。 |
| 原 uploader session 撤銷 | 在其餘帳號可用時，下載、縮圖、圖片與影片／seek、split download 均成功。 |
| Primary 失效後 secondary 重新登入 | 回到原 drive；JWT owner 不變，acting account 為 secondary；可讀既有頻道檔。 |
| 新瀏覽器只登入一帳號 | 首次全員驗證指出缺少 sessions；已啟用頻道仍可用此帳號讀檔。 |
| 所有頻道帳號失效 | 清楚失敗／暫停，不默默退回 `@me`、不刪 metadata。 |
| Enable summary 超過五分鐘／reload／relogin／新 browser | 已儲存 target 不失效；runtime 由目前 live linked manager lazy resolve，不能把舊 summary 當 access token。 |
| 0 writers → one writer 恢復 | 回 `UPLOAD_UNAVAILABLE`、channel target 保留、零 `@me` send；恢復後仍對同一 target 上傳。 |
| 0 readers → one reader 恢復 | 回 `READ_UNAVAILABLE`、metadata/target 保留、零 `@me` read；恢復後可讀同一 channel row。 |
| 不同帳號 `@me` 相同 message ID | 舊檔只讀原帳號，不串到其他帳號訊息。 |
| Hash 命中舊 `@me` row | 不把未搬移檔案標成已在頻道。 |
| 新上傳 Telegram 成功後、journal result／register 前 crash | 以 durable intent 與原 random ID 從 response／update recovery 取得同一目的地訊息，最後只註冊一次。 |
| Intent 保存前 DB 失敗 | 不呼叫訊息發布 RPC；未產生無 journal 的 Telegram 訊息。 |
| RPC 與 update 同時／反序抵達 | mapping reducer idempotent；不重複註冊，矛盾 mapping 拒絕覆寫。 |
| 正常 reload／同帳號重新登入／RANDOM_ID_DUPLICATE | 使用原 peer 與 random ID 恢復；不換 uploader、不重新產生 ID、不當作 uncertain。 |
| 單檔／album／fallback／split／chat import 發布 | 每則訊息的持久 random ID 確實送入 RPC；批次每元素各自對應，沒有 wrapper 隱式換 ID。 |
| 準備階段 crash 且失去本機 File | 顯示 SOURCE_FILE_REQUIRED；重選相符檔案後沿用原 operation，binary 不送 backend。 |
| 搬移一般檔與垃圾桶 | file ID、路徑、名稱、hash、時間與 trash 狀態保持，位置更新且他帳號可讀。 |
| Split group 部分失敗 | 整組原位置不變；resume 不重複轉存已記錄 parts。 |
| Split logical ID 與目的 media ID 不同 | logical ID／parts 關係不變，使用新 `telegram_media_id` 讀取；不將 synthetic ID 當 document ID。 |
| Legacy 帳號 ID 為 0 | 來源不明項目不自動搬移、不誤讀 secondary 的 `@me`。 |
| 轉存後／DB 提交前中斷 | 從 journal 恢復；uncertain 不盲目重發，但若 readonly reconcile 以 frozen identity 取得完全吻合 mapping/media，可轉 forwarded；提交具原子性。 |
| 三帳號中一個 offline | 其餘帳號的 eligible items 可轉存及滿兩票後 apply，不阻擋整個 job。 |
| 只剩一個 reader | 可轉存，回 INSUFFICIENT_VERIFICATION_QUORUM 並停在 pending_quorum；第二帳號回來只驗證／提交。 |
| 來源不可寫，其他帳號可寫 | 回 SOURCE_CANNOT_WRITE_TARGET，不代讀別人 `@me`。 |
| 一帳號重複 evidence／跨 owner／錯誤 message 或 kind／過期 evidence | Backend commit 不計重複票並拒絕不合法資料，直接 PATCH verified 不能繞過 quorum。 |
| Split 每 part 的 evidence 來自不同單一帳號 | 不視為整組雙帳號驗證；每 part 都需滿足 quorum。 |
| Maintenance flag 關閉／未登入／其他 owner job | 頁面不可用或要求登入；API 獨立拒絕越權，feature flag 不承擔授權。 |
| Maintenance dry-run／apply／job 列表／resume／rollback | Playwright 從固定路徑完成所有操作，不需要 console；dry-run 無 Telegram 寫入。 |
| Trash／restore／purge／清空垃圾桶 | 只變更 metadata，Telegram delete RPC 呼叫數為零；purge 後顯示 Telegram 訊息仍保留。 |
| SW range／main window 關閉／位置版本更新 | Bridge 只傳可序列化描述與 bytes，無 GramJS object；舊回覆丟棄，無 client 回 CLIENT_UNAVAILABLE。 |
| 重跑、雙 runner、來源被 purge | 無重複 metadata／錯誤覆寫／已刪 row 復活。 |
| 移除帳號 | 有 `@me` 依賴（含 trash 與每個 split part）仍拒絕；僅頻道檔且有替代讀取帳號時不刪檔、不阻斷存取；成功 link/unlink transaction 使 `accounts_version` 遞增。 |
| Post-side-effect CAS | `freeze A → send A → settings switch B → register A` 成功；`manifest A → forward A → settings switch B → apply A` 成功；無關 account link 單獨不拒絕 apply。 |
| Evidence link race | evidence 帳號在 commit 前 unlink 時不再計票，僅回 pending quorum／重新取 fresh evidence，不重新轉存。 |
| Normal register idempotency | opA 先 replace 同名檔、opB 再完成同名上傳、opA retry 只回 stored binding，不可 replace opB。 |
| 真實 Telegram CI | 三專用帳號跨帳號讀取、failover、lost-response recovery、split per-part quorum、unlink evidence invalidation 全部自動 PASS；缺配置即 gate 未完成。 |
| 架構檢查 | port 8000 網路紀錄只有 JSON metadata，沒有上傳 body、媒體／縮圖 bytes 或下載代理。 |

延伸既有 `chatImport.test.ts`、`telegramMedia.test.ts`、`forwardResult.test.ts`、`frontend/tests/support/fakeDrive.ts` 與 isolated fixtures；backend 增加 legacy schema upgrade、operation idempotency／tombstone、evidence quorum、owner 隔離、狀態轉移、版本衝突與 group 原子提交測試。自動化故障注入覆蓋 intent、訊息送出、mapping/cursor 持久化、sent、register 各 crash 邊界；真實 Telegram 測試確認重送相同 identity 後訊息數與 ID 不變，以及遺失 RPC response 的 update recovery。資料庫 fixture 不讀真實 session／使用者資料。

本次僅新增規格，不執行真實帳號登入、Telegram 發文、檔案搬移或功能驗收；因此真實 Telegram CI 與 Playwright MCP acceptance 均未完成。

## 11. 實作交付順序

1. 完成 canonical location／media kind＋ID 模型、additive schema，以及既有 owner／acting account 的相容性測試。
2. 建立共用 durable operation／idempotent register、顯式 random ID 發布、mapping reducer 及 update recovery。先驗證 crash 邊界，再接入功能；此 primitive 不受 migration feature flag 限制。
3. 完成逐帳號頻道解析、純前端 session freshness、main-window resolver 與 SW bridge，覆蓋所有媒體消費端。
4. 將一般／批次／fallback／split upload 及 chat import 全部接入 frozen target 與 operation，保留 `@me` 相容性。
5. 加入 storage-target UI、逐帳號驗證與持久化設定，啟用後可降級運作。
6. 以共用 primitive 實作 migration manifest、evidence／quorum、atomic apply／rollback 及固定 maintenance 頁面。
7. 執行完整自動化驗收：crash recovery、原帳號失效、quorum 降級、metadata-only purge 與 backend 不接觸 binary。

功能交付須包含上述讀取與搬移驗收；只完成設定按鈕或頻道上傳，不視為完成使用者的帳號備援需求。
