# 客戶端 E: 槽掛載 — 唯讀瀏覽 + `/game` zip 封裝

## Context

TeleDrive 目前只能用瀏覽器操作。需求是在客戶端 Windows PC 把同一份雲端硬碟掛成 E: 槽。

**實際要放的內容只有三類**，全部是「大檔、循序讀、幾乎只讀」：

1. 備份的照片
2. 先下載但不知何時會玩的本機遊戲
3. 想看的電影 / 演唱會影片

使用型態：每幾個月開幾小時，單次工作集 < 100GB，本機有 512GB NVMe 當快取，
目的是取代 8TB HDD 的**冷資料**部分。

### 決策（已確認）

| 項目 | 決定 |
|---|---|
| WebDAV server 位置 | 跑在客戶端 PC；metadata 走現有 HTTPS API，位元組直連 Telegram MTProto → **核心不變量「binary 不經過 Python backend」不變** |
| 專案位置 | **獨立新 git repo**（見第二部分） |
| 掛載方式 | rclone mount + WinFsp |
| 寫入範圍 | 只有 `/game`（自動打包 zip）；其他路徑唯讀，照片/影片上傳一律走網頁 |
| `/game` 呈現 | 打包後**仍顯示為資料夾**，內容由 zip 的 central directory 虛擬展開（唯讀） |
| 取回本機 | Explorer **右鍵選單「儲存在本地」**，對 E: 下的檔案與資料夾都適用 |

### 可行性結論：可行，但有一項明確做不到

**做不到：偵測執行 exe 就自動下載後無縫啟動。** Windows 執行 exe 是記憶體映射載入映像，
loader 不會等下載解壓完成，會直接失敗或判定無回應 → 取回改為明確的右鍵動作。

**Windows 11 右鍵選單限制**：Win11 第一層精簡選單只顯示 MSIX 打包 + `IExplorerCommand`
的項目；registry verb 會被降到「顯示更多選項」（Shift+F10）子選單。第一版接受這個位置。

---

# 第一部分：TeleDrive 專案（本 repo）要改的

整體原則是**能不改就不改**。bridge 完全靠現有 public API 運作，以下兩項只是為了少一份
跨 repo 重複與少一個失敗模式。

## 1.1 `/auth/login` 同時接受 Telethon StringSession（約 6 行）

**現況**：`backend/app/api/routes.py:112` 的 login 只吃 GramJS 格式 session
（解析器在同檔 `:38` `_parse_gramjs_session`）。bridge 用的是 `generate_session.py`
產生的 Telethon StringSession，格式不同。

**若不改**：bridge 得自己實作 `_parse_gramjs_session` 的反向轉換（Telethon → GramJS，
約 15 行的 struct/base64 打包），且未來 backend 認證格式一變就會壞。

**改法**：在 `login()` 裡把 session 解析改成「先試 GramJS，失敗則當 Telethon StringSession」：

```python
try:
    session = _parse_gramjs_session(request.session_string)
except Exception:
    from telethon.sessions import StringSession
    session = StringSession(request.session_string)
```

其餘流程（`client.connect()` → `get_me()` → `store_user_session` → `create_jwt`）完全不動。
瀏覽器端行為不變（照樣走 GramJS 分支）。

**驗收**：用 `generate_session.py` 產生的字串 POST `/auth/login` 能拿到 JWT，
且用該 JWT 呼叫 `GET /files` 回到正確的 `telegram_user_id` 資料；網頁登入不受影響。

## 1.2 `.env` 固定 `JWT_SECRET`

**現況**：`backend/app/auth.py:9` 未設環境變數時用 `secrets.token_hex(32)`
→ **每次 backend 重啟所有 JWT 失效**。

**影響**：bridge 會在 401 時自動重新 login，功能上能吸收；但每次重啟都要重跑一次
MTProto 登入驗證，多一個沒必要的失敗點（也讓網頁使用者被登出）。

**改法**：`.env` 加一行固定值（不是程式碼改動），`.env.example` 補上說明。

**驗收**：`docker compose restart backend` 後，舊 JWT 仍可呼叫 `GET /files`。

## 1.3 暫不做（列出來避免重複討論）

- **`GET /files/resolve?path=/a/b/c` 路徑解析端點**：bridge 逐層走 `parent_id` 加本機
  目錄快取就夠。等實測 PROPFIND 真的慢再加。
- **任何 WebDAV 端點、任何位元組進出 backend 的端點**：違反核心不變量。
  現有 `GET /files/{id}/stream`（`routes.py:413`）本方案不使用。
- **schema 改動**：`split_group_id` / `part_index` / `total_parts` / `original_name`
  已足夠表達 bridge 要寫入的一切。

---

# 第二部分：新專案規格（交給新的 Claude session 開發）

> 這一段是自足的開發規格。新 session 只需要本節 + 讀取 TeleDrive repo 中被引用的
> 那幾個檔案位置，不需要重新探索整個 codebase。

## 2.1 專案定位

`teledrive-webdav`：**獨立 git repo**，Python，裝在客戶端 Windows PC。
把 TeleDrive 掛成本機磁碟（預設 E:），唯讀瀏覽 + `/game` 自動打包 + 右鍵取回本機。
不進 Docker，不改 TeleDrive repo（除第一部分那兩項）。

```
Explorer 右鍵「儲存在本地」──▶ registry verb ──▶ POST 127.0.0.1:8081/rpc/fetch-local
                                                          │
E:  ──rclone mount(WinFsp)──▶ http://127.0.0.1:8081  (bridge, Python)
                                        │
                     metadata (HTTPS + JWT)          位元組 (MTProto)
                                        ▼                    ▼
                     teledrive...dpdns.org/api/v1      Telegram CDN
```

## 2.2 檔案結構

| 檔案 | 職責 |
|---|---|
| `bridge.py` | wsgidav `DAVProvider`；非 `/game` 路徑一律唯讀；cheroot 綁 127.0.0.1；`/rpc/*` 端點 |
| `tdapi.py` | backend REST client：JWT 取得/快取/401 自動重登、路徑→file_id 解析 + 短期快取 |
| `tgio.py` | `SeekableRemoteFile`（Range 讀、split 虛擬串接）、`upload_big_file`（512KB 分塊 + >512MB 切檔） |
| `zipfs.py` | 讀 zip central directory → 虛擬目錄樹；單一 entry 的 range 讀取 |
| `gamestage.py` | `/game` staging + debounce 打包 + 上傳 + 清理 |
| `fetchlocal.py` | 「儲存在本地」：判斷 zip/一般檔 → 下載 → 解壓/複製到 `local_dir` → 進度 |
| `install_menu.py` | 註冊/移除 Explorer 右鍵 verb |
| `config.example.ini` | `api_id`/`api_hash`/`session`/`base_url`/`port`/`cache_dir`/`local_dir`/`staging_dir`/`debounce_minutes` |
| `requirements.txt` | `wsgidav`, `cheroot`, `telethon`, `requests` |
| `start.bat` | 啟動 bridge + `rclone mount` |
| `tests/test_split_math.py`, `tests/test_zipfs.py` | 純函式測試，離線可跑 |

**注意**：因為第一部分 1.1 讓 backend 接受 Telethon StringSession，
本專案**不需要** session 格式轉換模組。一份 `generate_session.py` 產生的字串
同時用於 MTProto 直連與換 JWT。

## 2.3 對外契約（TeleDrive API，皆需 `Authorization: Bearer <jwt>`）

| 用途 | 端點 | 備註 |
|---|---|---|
| 換 JWT | `POST /api/v1/auth/login` `{session_string}` | 回 `{token, user_id, …}`，30 天 |
| 列目錄 | `GET /api/v1/files?parent_id=&page_size=10000` | split 檔已折疊成 `part_index=0` 一列（`backend/app/services/database.py:345`） |
| 取下載資訊 | `GET /api/v1/files/{id}/download` | 回 `message_id` + `access_hash` |
| 取 split 全部 parts | `GET /api/v1/files/by-split-group/{id}` | 依 `part_index` 排序（`routes.py:686`） |
| 上傳後登錄 | `POST /api/v1/files/register` | 欄位見 `routes.py:85` `RegisterFileRequest` |
| 建資料夾 | `POST /api/v1/folders` | |
| 去重查詢 | `GET /api/v1/files/check-hash` | 前 100MB sample hash，與網頁端同語意 |

## 2.4 關鍵演算法

### (a) split 檔虛擬串接（`tgio.py`）

TeleDrive 大檔切成多則訊息，共用 `split_group_id`，以 `part_index` 排序，
每列 `filesize` 是**該段**大小。做法：取全部 parts → 建累積 offset 表 →
全域 offset 映射到 (part, 內部 offset) → 跨界讀取拆多段。
參考實作（瀏覽器端、整檔 Blob 版）：`frontend/src/lib/gramjs.ts:1309 downloadFileMerge`；
本專案要改成**串流**。

- 位元組讀取用 `client.iter_download(document, offset=…, limit=…)`，
  Telethon 自行處理 4096 對齊與 chunk 規則。
- **不要**照抄 `backend/app/services/telethon_service.py:204 download_file` 的手寫
  `GetFileRequest`：其中 `remaining_bytes - 1` 未對齊，是既有的可疑寫法。
- `Document` 與 `file_reference` 靠 `get_messages('me', ids=…)` 取得並快取；
  `FILE_REFERENCE_EXPIRED` 時重取一次後重試（file_reference 只有數小時效期）。
- **PROPFIND 的 `getcontentlength`**：split 檔必須加總所有 parts，結果快取
  （part 0 的 `filesize` 只是第一段）。

### (b) zip 虛擬展開（`zipfs.py`）

zip 的 central directory 在檔尾 → 讀尾端數十 KB 就有完整清單（檔名、大小、offset）。
`zipfile.ZipFile` 接受任何 seekable file-like → 直接餵 `SeekableRemoteFile`，
**不需下載整包就能瀏覽**。central directory 快取到本機後，之後瀏覽零網路。

- E: 上呈現 `/game/<遊戲名>/`（zip 本體隱藏），體驗上像資料夾沒變過。
- 單檔讀取：entry offset → 全域 offset → (part, 內部 offset)，沿用 (a) 的映射。
- **零額外狀態**：目錄樹唯一真實來源就是 zip 本身。網頁端看到的仍是正常的
  `<遊戲名>.zip`，可直接下載。

### (c) `/game` 移入即打包（`gamestage.py`）

- `/game/*` 的 PUT/MKCOL **不立刻上傳**，先寫入 `staging_dir`。
- 打包單位是 `/game/<第一層資料夾>`。該子樹 `debounce_minutes`（預設 5）沒有新寫入
  → 視為移入完成 → 打包 → 上傳 → 清 staging。
- **zip 用 store 免壓縮**（`ZIP_STORED`）：遊戲檔本來就壓過，省不到空間，
  但換來單一 entry 可直接 range 對應原始位元組，不必解壓整包。zip64 預設啟用。
- 上傳：≤512MB 一則訊息；>512MB 切 512MB 段（`MAX_PARTS=1000 × 512KB`，
  與 `frontend/src/lib/gramjs.ts:502` 同邊界），register N 列並帶
  `is_split_file / split_group_id / part_index / total_parts / original_name`。
- 上傳前查 `/files/check-hash` 去重。不做縮圖、不做 album 分組。
- staging 需要 ≈ 遊戲大小的空間（單次 <100GB，512GB SSD 夠）。

### (d) 寫入保護

不使用 rclone 全域 `--read-only`（那樣 `/game` 也不能寫）。改由 bridge 對 `/game` 以外
的所有寫入動詞（PUT/DELETE/MKCOL/MOVE/PROPPATCH）回 **403**。

### (e) 右鍵「儲存在本地」（`install_menu.py` + `fetchlocal.py`）

- 註冊 `HKCU\Software\Classes\*\shell\TeleDriveFetchLocal` 與 `…\Directory\shell\…`，
  用 `AppliesTo` 限定 `E:\` 底下才顯示（需實測；不生效就退回 handler 內判路徑）。
- verb 只是觸發器：`cmd /c` 打 `POST http://127.0.0.1:8081/rpc/fetch-local`（帶 `%1`），
  邏輯全留在 Python：
  - 目標在虛擬 zip 內 → 下載整包 → 解壓到 `local_dir\<遊戲名>\`
  - 目標是一般檔案/資料夾 → 複製到 `local_dir`
  - console 視窗顯示進度，完成後開 Explorer

## 2.5 rclone 掛載

```
rclone config: type=webdav url=http://127.0.0.1:8081 vendor=other
rclone mount teledrive: E: --network-mode ^
  --cache-dir D:\rclone-cache ^          :: 必須指到 NVMe；預設在 %LOCALAPPDATA%（常是系統碟）
  --vfs-cache-mode full ^                :: sparse，只存讀到的區段
  --vfs-cache-max-size 460G ^            :: 容量驅動淘汰（512G 留 10% 餘裕）
  --vfs-cache-max-age 8760h ^            :: 實質停用時間淘汰
  --vfs-cache-min-free-space 20G ^
  --dir-cache-time 1h ^                  :: 檔案多時 10s 會反覆打 API；網頁改動後 rclone rc vfs/forget
  --vfs-read-chunk-size 32M --vfs-read-chunk-size-limit 512M ^
  --transfers 4 --no-checksum --rc
```

- **時間淘汰要關掉**：age 到期就丟等於把還會用的資料重抓一次，白費頻寬又吃 SSD TBW。
  這個使用型態沒有別的資料競爭快取，上次用過的東西數月後很可能還在，第二次開即本機速度。
- SSD 壽命非問題：約 0.6TB/年寫入，512GB 消費級 NVMe TBW 約 300TB。
- **不套 rclone crypt / compress**：否則網頁端下載到加密/壓縮後內容，
  失去「瀏覽器也能直接看」這個核心價值。

## 2.6 明確不做

- 一般檔案的 PUT / 覆寫 / 版本回收（照片影片上傳走網頁，那邊有縮圖、去重、album）
- **block 級部分更改**：WebDAV 只有整檔 PUT，rclone 也是整檔重傳 → 這條路做不到。
  真要做得改用 WinFsp（`winfspy`）自己實作檔案系統才會收到 `write(offset, len)`；
  儲存端不用改（`split_group_id` + `part_index` 已是 block 結構），但整個 M1–M4 幾乎重做。
  三類內容都不需要。
- **遊戲直接在 E: 執行**：反作弊（EAC/BattlEye）與 mmap 會擋，且要跑就得資料在本機。
  改成「取回解壓到本機再玩」把問題全部繞開。
- MSIX + `IExplorerCommand`（Win11 第一層右鍵選單）、PyInstaller 打包 exe、
  開機自啟、GUI 設定介面。

## 2.7 已知限制與風險

1. **首次上傳 8TB 是主要成本**：上行 100Mbps ≈ 7.4 天、20MB/s ≈ 4.5 天，期間會撞 FLOOD_WAIT。
2. **唯一副本風險**：Telegram 帳號被封或誤刪即全失，無版本保護 → 定位為第二份冷封存。
3. **session 開始要等取回**：單一 Telethon 連線約 10MB/s → 100GB ≈ 2.8 小時。
   解法優先序：(a) 前一晚先按「儲存在本地」預熱；(b) 真的要即時再做並行 chunk 下載
   （多 sender 拉不同 offset，3–8 倍，列 M5，M1 量測後再決定）。
4. **照片別用 E: 瀏覽**：幾萬張小檔是 WebDAV + rclone 最弱的場景。看照片走網頁。
5. **4K remux 直接播會邊緣**：1080p remux（~30Mbps）順；4K（50–80Mbps）先取回本機再看。
6. **同名檔案**：DB 沒有 `UNIQUE(filename,parent_id)` → 取 `created_at` 最新者並記 warning。
7. **一機一份 bridge**：只有跑 bridge 的那台 PC 能掛 E:。
8. Windows 11 右鍵選單位置限制（見上）。

## 2.8 里程碑與驗收

- **M1 唯讀瀏覽與讀取**：`tdapi.py` + JWT 自動重登 + PROPFIND/GET/HEAD + Range +
  split 虛擬串接 + 非 `/game` 寫入 403。
  驗收：`rclone ls teledrive:` 與網頁列表一致；小檔 / 非 split 大檔 / split 大檔各取一份，
  SHA256 與網頁下載相同；量測冷讀吞吐（決定要不要 M5）。
- **M2 zip 虛擬展開**：`zipfs.py`。
  驗收：手動上傳一個 store 模式 zip（含巢狀目錄、>4GB 內容）後，E: 上能瀏覽整棵樹
  且**不觸發整包下載**（用 `rclone rc` 的傳輸量佐證）；單檔複製出來 SHA256 正確。
- **M3 `/game` 移入即打包**：`gamestage.py`。
  驗收：把多層資料夾（含空目錄、長路徑、非 ASCII 檔名）移入 `/game`，
  debounce 到期後網頁出現 `<名稱>.zip`，E: 上仍顯示為資料夾且內容正確。
- **M4 右鍵取回 + 交付**：`fetchlocal.py`、`install_menu.py`、`start.bat`、README。
  驗收：對虛擬 zip 資料夾右鍵取回 → 解壓後遊戲能執行；對影片檔取回 → hash 正確；
  快取到 `--vfs-cache-max-size` 上限時淘汰正常。
- **M5（選配，先不做）**：並行 chunk 下載。

## 2.9 驗證方式

1. 協定層：`curl -X PROPFIND -H "Depth: 1" http://127.0.0.1:8081/` 檢查 XML；
   `curl -r 100-200` 檢查 206 與位元組；對非 `/game` 路徑 `curl -X PUT` 應得 403。
2. 端到端 hash：取回後 `certutil -hashfile SHA256` 與原檔比對
   （小檔 / 600MB split 檔 / zip 內單一 entry 各一）。
3. 離線單元測試（不需 Telegram）：
   - `tests/test_split_math.py`：offset→(part, 內部 offset) 映射、跨界切段、切檔邊界。
   - `tests/test_zipfs.py`：本機造 store zip 餵假的 seekable 物件，
     斷言虛擬樹結構與單 entry 位元組範圍正確。
4. 掛載後 Explorer 手動走一遍：瀏覽虛擬 zip、右鍵取回、`/game` 移入。
5. 最後在瀏覽器開 `https://teledrive.yoyotsaoteledrive.dpdns.org`
   確認 `/game` 上傳的 zip 在網頁上顯示、下載正常（`CLAUDE.md` 的驗證規則）。
