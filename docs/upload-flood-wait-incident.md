# 大型檔案上傳遭遇 `FLOOD_PREMIUM_WAIT`

## 狀況摘要

2026-09-07 使用三個 Telegram 帳號上傳大型檔案時，帳號
`ji32k7au6y4`（Telegram user ID `8838273312`）持續收到
`upload.SaveBigFilePart` 的 `FLOOD_PREMIUM_WAIT`：

```text
[GramJS:8838273312] SaveBigFilePart flood:
A wait of 15 seconds is required (caused by upload.SaveBigFilePart)
(seconds=15, premium=true)
```

等待時間大多介於 14–16 秒。部分 chunk 在重試多次後進入外層失敗：

```text
[SplitUpload:8838273312] part 510 attempt 2 FAILED:
A wait of 16 seconds is required (caused by upload.SaveBigFilePart)
```

`test1` 和 `test2` 仍有完成部分 segment，表示瀏覽器與 Telegram CDN
之間的傳輸沒有全面中斷。主要問題是其中一個帳號被限速後，分配給它的
segment 無法及時完成，最後拖住整個大型檔案。

## 已確認的程式行為

### 1. Premium flood 只等待，不會降速

程式將 `FLOOD_PREMIUM_WAIT` 視為帳號層級的速度限制。收到此錯誤後會
呼叫 `chunkPacer.pause(seconds)`，但不會降低發送速率、不會記錄 flood，
也不會建立新的速率 ceiling。

因此，本次上傳雖然已持續收到 flood，成功中的既有請求仍會觸發
`reportSuccess()`。log 顯示 `ji32k7au6y4` 的目標速率從儲存的
25.6 parts/s 繼續上升，最後到達 32.0 parts/s 上限。

每個 part 通常為 512 KiB，因此 32 parts/s 相當於理論發送速率
16 MiB/s。這只是客戶端排程速率，不代表 Telegram 實際接受的速率。

目前形成的循環為：

```text
等待 14–16 秒
  → 使用原速率重送
  → 再次收到 FLOOD_PREMIUM_WAIT
  → 再等待並重試
```

### 2. 多帳號只有初始分派，沒有執行中故障轉移

大型檔案會被切成多個 segment。每個 segment 開始時透過
`nextAccount()` 選擇一次帳號，之後整個 `uploadSegment()` 都固定由該帳號
處理。

目前沒有以下能力：

- 將被限速帳號標記為暫時不可分派。
- 將已卡住的 segment 重新排入共用工作佇列。
- 讓空閒帳號接手其他帳號未完成的 segment。

所以 `test1`、`test2` 完成原先分配的工作後可能進入閒置，並不會自動接手
`ji32k7au6y4` 的 segment。

### 3. 一個 segment 未完成會阻止整個檔案完成

所有 segment 目前由 `Promise.all()` 等待。只要其中一個 segment 尚未完成，
整個檔案就不會進入完成、排序及 metadata 登記階段。因此使用者看到的是
整體進度停止，而不是單一帳號局部降速。

### 4. 故障轉移必須重傳整個 segment

已上傳的 `SaveBigFilePart` parts 綁定原帳號和該次產生的 `fileId`。另一個
Telegram 帳號不能直接續傳剩餘 parts。

若要故障轉移，必須放棄原帳號尚未完成的暫存 segment，在替代帳號產生新的
`fileId`，並從該 segment 的第一個 part 開始重傳。已由其他帳號完成的
segment 不需要重傳。

## 目前無法從 log 得知的資訊

目前 console 會記錄 flood 和 segment 完成事件，但不會逐筆記錄成功的
`SaveBigFilePart`。因此無法從現有 log 算出「每次 wait 結束後，Telegram
實際接受了多少 parts」。

已知換算方式如下：

```text
成功 bytes ≈ 成功 part 數 × 512 KiB
```

瀏覽器 console 訊息前方的重複數字（例如 `31`、`80`）代表相同 flood
警告被合併的次數，不代表成功上傳的 part 數。

目前的上傳統計只記錄每日、每帳號的累計成功 bytes，沒有依 flood cycle
記錄成功量、活動時間或下一次限流時間。

## 其他觀察

log 中的後端 `401 Unauthorized` 屬於 JWT／metadata API 授權問題，與
Telegram `SaveBigFilePart` 的二進位傳輸是不同路徑。它不會造成前面的
Telegram flood，但若授權無法刷新，Telegram 傳輸完成後仍可能無法登記
檔案 metadata。

## 建議改善方向

1. Premium flood 發生後停止速率 ramp，並加入不永久寫入 storage 的暫時降速。
2. 連續多輪 premium flood 時，將帳號標記為 throttled，暫停分派新 segment。
3. 將 segment 改為可重新排程的工作；超過門檻後由其他健康帳號從頭重傳該
   segment。
4. 在每次 flood cycle 記錄 `acceptedParts`、`acceptedBytes`、活動時間與
   wait 秒數，以量出 Telegram 實際放行量。
5. 清楚區分「帳號等待中」、「segment 重新分派中」及「整個檔案失敗」，避免
   UI 只呈現沒有原因的進度停滯。

## 架構邊界

上述改善仍必須維持 TeleDrive 的核心架構：檔案 bytes 只在瀏覽器與
Telegram CDN 之間傳輸；Python backend 僅儲存 SQLite metadata，不代理
任何檔案內容。
