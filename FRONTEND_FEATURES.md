# TeleDrive 前端功能規格書

## 專案概述

TeleDrive 是一個使用 Telegram 作為後端儲存的個人雲端儲存系統。前端採用 React + TypeScript + Vite 建構，透過 MTProto（GramJS）直接與 Telegram 通訊，所有檔案傳輸繞過後端伺服器，後端僅儲存檔案的中繼資料（metadata）。

---

## 一、核心功能

### 1.1 檔案瀏覽與導航

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 根目錄顯示 | 顯示根目錄（Saved Messages）的檔案與資料夾 | `ChonkyDrive.tsx` |
| 資料夾導航 | 雙擊進入資料夾，支援麵包屑導航 | `ChonkyDrive.tsx` |
| 麵包屑導航 | 顯示目前路徑，可點擊返回上層 | `ChonkyDrive.tsx` |
| 返回上層 | 支援返回上一層資料夾 | `ChonkyDrive.tsx` |
| 視圖模式切換 | Grid / List 兩種檢視模式切換 | `ChonkyDrive.tsx` |
| 檔案列表 | 顯示檔案名稱、大小、類型縮圖 | `ChonkyDrive.tsx` |

### 1.2 檔案上傳

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 拖曳上傳 | 支援將外部檔案拖曳至瀏覽器上傳 | `ChonkyDrive.tsx` |
| 點擊上傳 | 點擊上傳按鈕選擇檔案上傳 | `ChonkyDrive.tsx` |
| 多檔上傳 | 支援一次選擇多個檔案上傳 | `ChonkyDrive.tsx` |
| 分塊上傳 | 大檔案自動分割為 512KB 分塊上傳至 Telegram | `gramjs.ts` |
| 上傳進度顯示 | 顯示各檔案的上傳狀態與進度 | `ChonkyDrive.tsx` |
| 上傳完成通知 | 上傳成功/失敗顯示勾選或叉號 | `ChonkyDrive.tsx` |

### 1.3 檔案下載

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 預覽模式下載 | 在預覽視窗中點擊下載按鈕下載檔案 | `ChonkyDrive.tsx` |
| 分塊下載 | 大檔案使用 chunked GetFile API 分塊下載 | `gramjs.ts` |
| 分離檔案合併下載 | 自動下載並合併所有分塊 | `gramjs.ts` |
| 原始檔名還原 | 下載時使用原始檔名（針對分塊檔案） | `ChonkyDrive.tsx` |

### 1.4 檔案預覽

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 圖片預覽 | 雙擊圖片檔案顯示預覽 | `ChonkyDrive.tsx` |
| 影片預覽 | 雙擊影片檔案播放（支援串流播放） | `ChonkyDrive.tsx` |
| 檔案類型檢測 | 自動偵測 MIME Type | `ChonkyDrive.tsx` |
| 預覽關閉 | 點擊外部或關閉按鈕關閉預覽 | `ChonkyDrive.tsx` |

### 1.5 資料夾管理

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 建立資料夾 | 點擊按鈕輸入名稱建立新資料夾 | `ChonkyDrive.tsx` |
| 刪除資料夾 | 選取後按 Delete 鍵刪除 | `ChonkyDrive.tsx` |

### 1.6 檔案管理

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 選取檔案 | 單擊選取檔案 | `ChonkyDrive.tsx` |
| 多重選取 | Ctrl+Click 切換選取、Shift+Click 範圍選取 | `ChonkyDrive.tsx` |
| 刪除檔案 | 選取後按 Delete 鍵刪除（會詢問確認） | `ChonkyDrive.tsx` |
| 移動檔案 | 拖曳檔案至資料夾移動位置 | `ChonkyDrive.tsx` |
| 重新整理 | 操作後自動重新整理列表 | `ChonkyDrive.tsx` |

### 1.7 縮圖顯示

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 圖片縮圖 | 自動顯示圖片縮圖 | `ChonkyDrive.tsx` |
| 影片縮圖 | 自動顯示影片縮圖（右下角顯示播放鍵） | `ChonkyDrive.tsx` |
| 延遲載入 | 縮圖使用 lazy loading | `ChonkyDrive.tsx` |

---

## 二、連線與驗證

### 2.1 Telegram 連線

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 環境變數設定 | 從 `.env` 讀取 VITE_TELEGRAM_API_ID、VITE_TELEGRAM_API_HASH、VITE_TELEGRAM_SESSION | `SessionConfig.tsx` |
| 客戶端初始化 | 啟動時初始化 GramJS MTProto 客戶端 | `SessionConfig.tsx`, `gramjs.ts` |
| 連線狀態顯示 | 顯示後端與 Telegram 連線狀態 | `SessionConfig.tsx` |
| 重新連線 | 支援手動重試連線 | `SessionConfig.tsx` |
| 連線失敗提示 | 顯示連線錯誤訊息 | `SessionConfig.tsx` |

### 2.2 後端連線

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 後端健康檢查 | 啟動時檢查後端是否可連線 | `SessionConfig.tsx` |
| API 代理 | Vite dev server 代理 `/api` 請求至後端 port 8000 | `vite.config.ts` |
| 錯誤處理 | 顯示後端連線失敗訊息 | `SessionConfig.tsx` |

---

## 三、進階功能

### 3.1 分塊檔案（Split File）處理

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 大檔分割上傳 | 檔案 > 3900 parts（~2GB）自動分割多個檔案 | `gramjs.ts` |
| 分塊 group ID | 使用 split_group_id 識別同一檔案的所有分塊 | `ChonkyDrive.tsx` |
| 分塊合併下載 | 自動查詢並依序下載合併所有分塊 | `gramjs.ts` |
| 去重顯示 | UI 自動隱藏重複的分塊，顯示為單一檔案 | `ChonkyDrive.tsx` |

### 3.2 影片串流播放

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 分塊下載播放 | 邊下載邊播放（MediaSource API） | `ChonkyDrive.tsx` |
| Fallback 模式 | 不支援 MediaSource 時使用 Blob URL | `ChonkyDrive.tsx` |
| 下載進度顯示 | 顯示已下載資料量（MB） | `ChonkyDrive.tsx` |

### 3.3 縮圖產生

| 功能 | 說明 | 實作位置 |
|------|------|----------|
| 圖片縮圖產生 | 使用 Canvas 產生 200px 縮圖 | `client.ts` |
| 影片縮圖產生 | 使用 HTML5 Video + Canvas 產生縮圖 | `videoThumbnail.ts` |
| 縮圖上傳 | 將產生的縮圖上傳至 Telegram | `gramjs.ts` |
| 縮圖關聯 | 將縮圖訊息 ID 儲存至檔案 metadata | `ChonkyDrive.tsx` |

---

## 四、技術架構

### 4.1 技術堆疊

| 類別 | 技術 | 版本/備註 |
|------|------|----------|
| 框架 | React | 18+ |
| 語言 | TypeScript | strict mode |
| 建置工具 | Vite | port 3000 |
| MTProto | GramJS | 2.10.8 |
| API 客戶端 | Axios | - |
| 檔案瀏覽器元件 | @aperturerobotics/chonky | - |
| HTTP 代理 | Vite Proxy | `/api` → `localhost:8000` |

### 4.2 資料流向

```
上傳流程：
┌─────────────────────────────────────────────────────────────────────┐
│  1. 前端產生縮圖（Canvas/Video + Canvas）                            │
│  2. 前端使用 GramJS 上傳縮圖至 Telegram → 取得縮圖 message_id        │
│  3. 前端使用 GramJS 分塊上傳檔案至 Telegram → 取得各分塊 message_id  │
│  4. 前端呼叫後端 POST /files/register                               │
│     （傳送：filename, filesize, message_id, access_hash, 等）       │
│  5. 後端寫入 SQLite（只儲存 metadata，不經手檔案）                  │
└─────────────────────────────────────────────────────────────────────┘

下載流程：
┌─────────────────────────────────────────────────────────────────────┐
│  1. 前端呼叫後端 GET /files/{id}                                    │
│  2. 後端回傳：message_id + access_hash                              │
│  3. 前端使用 GramJS 直接從 Telegram CDN 下載                        │
│     （不經過後端伺服器）                                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.3 檔案結構

```
frontend/src/
├── api/
│   └── client.ts          # Axios API 客戶端，所有後端 API 呼叫
├── components/
│   ├── ChonkyDrive.tsx    # 主檔案瀏覽器元件（含預覽、播放）
│   └── SessionConfig.tsx  # 連線設定與狀態顯示
├── lib/
│   ├── gramjs.ts          # GramJS MTProto 包裝類別
│   └── videoThumbnail.ts  # 影片縮圖產生
├── types/
│   └── index.ts           # TypeScript 介面定義
├── App.tsx                # 根元件
└── main.tsx               # React 進入點

frontend/
├── .env                   # 環境變數（VITE_ 前綴）
├── vite.config.ts         # Vite 設定（含 API 代理）
└── tsconfig.json          # TypeScript 設定（strict: true）
```

### 4.4 環境變數

| 變數名稱 | 說明 | 範例 |
|----------|------|------|
| VITE_API_ID | Telegram API ID | 12345678 |
| VITE_API_HASH | Telegram API Hash | abcdef1234567890abcdef |
| VITE_TELEGRAM_SESSION | 已儲存的 session 字串 | 各種 base64 |
| VITE_TELEGRAM_API_ID | （同上） | - |
| VITE_TELEGRAM_API_HASH | （同上） | - |

---

## 五、API 端點

### 5.1 檔案相關

| 方法 | 端點 | 說明 |
|------|------|------|
| GET | `/api/v1/files` | 取得檔案列表 |
| POST | `/api/v1/files/register` | 註冊檔案 metadata（上傳後呼叫） |
| GET | `/api/v1/files/{file_id}` | 取得單一檔案資訊 |
| PATCH | `/api/v1/files/{file_id}` | 更新檔案（如 parent_id） |
| DELETE | `/api/v1/files/{file_id}` | 刪除檔案 |
| GET | `/api/v1/files/{file_id}/download` | 取得下載資訊 |
| GET | `/api/v1/files/{file_id}/thumbnail` | 取得縮圖 |
| GET | `/api/v1/files?split_group_id=...` | 取得分割檔案的所有分塊 |

### 5.2 資料夾相關

| 方法 | 端點 | 說明 |
|------|------|------|
| GET | `/api/v1/folders` | 取得資料夾列表 |
| POST | `/api/v1/folders` | 建立資料夾 |
| DELETE | `/api/v1/folders/{folder_id}` | 刪除資料夾 |

---

## 六、已知限制與待處理事項

### 6.1 待處理事項

- [ ] 影片串流播放的 MediaSource API 支援問題（目前使用 fallback blob URL）
- [ ] 分割檔案下載時的進度條顯示
- [ ] 支援更多檔案類型的預覽（音頻、文件）
- [ ] 檔案搜尋功能
- [ ] 檔案重新命名功能
- [ ] 複製檔案功能
- [ ] 檔案分享功能（產生分享連結）

### 6.2 已知限制

- Session 字串必須從 `generate_session.py` 產生，無法直接在瀏覽器中登入
- 大量小檔案上傳時效能可能受影响（每次上傳都是獨立的 MTProto 呼叫）
- 預覽模式下的影片目前使用完整下載（fallback 模式），非真正的串流

---

## 七、开发指南

### 7.1 開發環境啟動

```bash
# 殺掉占用端口的程序（如有必要）
powershell -Command "Get-NetTCPConnection -LocalPort 8000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ }"
powershell -Command "Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ }"

# 啟動後端
cd D:\teledrive\backend && python main.py

# 啟動前端
cd D:\teledrive\frontend && npm run dev
```

### 7.2 測試

- 前端開發伺服器：http://localhost:3000
- 後端 API：http://localhost:8000
- 預覽模式（無 API 代理）：`npm run preview` → port 4173

### 7.3 常見問題

| 問題 | 解決方式 |
|------|----------|
| 後端連線失敗 | 確認 backend 已啟動，port 8000 可連線 |
| Telegram 連線失敗 | 確認 .env 中的 API_ID、API_HASH、SESSION 是否正確 |
| 上傳卡住 | 檢查瀏覽器主控台是否有 MTProto 錯誤 |
| 縮圖顯示不出來 | 檢查是否有 thumbnail_message_id |
| 預覽播放失敗 | 使用 fallback blob URL 下載測試 |

---

*本文件最後更新：2026-04-02*