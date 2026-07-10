# 內嵌縮圖 + 資料夾上傳 album 聚批 — 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 縮圖改為內嵌在檔案自身 Telegram message 的 document thumb(額外 message 成本歸零),資料夾上傳的小檔案走 album 聚批(10 檔 = 1 則 SendMultiMedia),消除 FLOOD_WAIT。

**Architecture:** 前端 GramJS 直傳 Telegram(binary 絕不經過 Python 後端);後端 SQLite 只存 metadata。本計畫將 `files.thumbnail_message_id` 欄位替換為 `has_thumbnail` 布林(DB 可整個重建、無 migration),縮圖 bytes 以 `SaveFilePart`(非 message)上傳後填入 `InputMediaUploadedDocument.thumb` / `sendFile` 的 `thumb` 選項。

**Tech Stack:** FastAPI + aiosqlite + Telethon(後端)、React 18 + TypeScript + GramJS(前端)、pytest、Playwright。

**Spec:** `docs/superpowers/specs/2026-07-10-embedded-thumb-album-upload-design.md`

## Global Constraints

- Binary 檔案資料絕不經過 Python 後端(核心架構不變量;縮圖端點既有的 base64 快取行為除外)。
- 下載縮圖只能抓 thumb PhotoSize(GramJS `downloadMedia` 的 `thumb` 參數 / Telethon `download_media(..., thumb=-1)`),**絕不下載 document 本體**(可能是 500MB 影片)。
- 所有 message-creating RPC(sendFile / SendMultiMedia)必須經過 `messageRateLimiter`;`SaveFilePart` / `SaveBigFilePart` 不經過。
- album 一批最多 10 個檔案(Telegram SendMultiMedia 上限)。
- 小檔門檻 10MB(`SINGLE_PATH_SIZE_LIMIT` / `uploadFileSplit` 的 `useBigFile` 門檻,兩者既有值一致)。
- DB 直接重建:改 schema 後刪除舊 `.db` 檔,不寫 migration。
- 開發規範:完成後必須在瀏覽器開啟 `https://teledrive.yoyotsaoteledrive.dpdns.org` 實際驗證。
- Commit message 用 conventional commits,不加 attribution。

---

### Task 1: 後端 — `thumbnail_message_id` → `has_thumbnail` 欄位替換

**Files:**
- Modify: `backend/tests/test_folder_cascade_delete.py`
- Modify: `backend/app/services/database.py`(schema、`insert_file`、`update_file`)
- Modify: `backend/app/models/schemas.py:49`
- Modify: `backend/app/services/file_service.py`(所有 `thumbnail_message_id` 引用)
- Modify: `backend/app/api/routes.py`(request models、register/update/delete/thumbnail 端點、`_download_thumbnail_base64`、刪除 deprecated 端點)
- Modify: `backend/cleanup_orphans.py:68`

**Interfaces:**
- Produces(後續 task 依賴):
  - `POST /api/v1/files/register` 接受 `has_thumbnail: bool = False`(不再接受 `thumbnail_message_id`)
  - `FileInfo` Pydantic 模型含 `has_thumbnail: bool`(不再有 `thumbnail_message_id`)
  - `PATCH /files/{id}` 只接受 `parent_id`
  - `POST /files/thumbnail/upload` 與 `POST /videos/thumbnail` 端點**移除**

- [ ] **Step 1: 改寫既有測試(RED)**

`backend/tests/test_folder_cascade_delete.py` 的 `_insert` 與 `_build_tree`、斷言改為:

```python
async def _insert(db: Database, file_id: str, parent_id=None, is_dir=False,
                  msg_id=None, has_thumb=False):
    await db.insert_file(
        file_id=file_id,
        filename=file_id,
        filesize=0,
        mime_type=None,
        file_type="other",
        telegram_message_id=msg_id,
        has_thumbnail=has_thumb,
        created_at="2026-01-01T00:00:00",
        direct_url=None,
        access_hash=None,
        parent_id=parent_id,
        is_dir=is_dir,
        telegram_user_id=USER_ID,
    )


async def _build_tree(db: Database):
    """root_folder/ ├─ file_a (msg 11, embedded thumb) └─ sub_folder/ └─ file_b (msg 21)"""
    await _insert(db, "root_folder", is_dir=True)
    await _insert(db, "file_a", parent_id="root_folder", msg_id=11, has_thumb=True)
    await _insert(db, "sub_folder", parent_id="root_folder", is_dir=True)
    await _insert(db, "file_b", parent_id="sub_folder", msg_id=21)
    await _insert(db, "outside_file", msg_id=99)  # must survive the delete
```

`test_delete_folder_cascades_and_reports_telegram_messages` 中的斷言(縮圖已內嵌,不再有獨立縮圖 message):

```python
        assert deleted_count == 4
        # embedded thumbs die with the file message — only file messages listed
        assert sorted(message_ids) == [11, 21]
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd backend && python -m pytest tests/test_folder_cascade_delete.py -v`
Expected: FAIL — `insert_file() got an unexpected keyword argument 'has_thumbnail'`

- [ ] **Step 3: database.py**

`init_schema()` 的 CREATE TABLE(line 50)欄位替換:

```sql
                telegram_message_id INTEGER,
                has_thumbnail INTEGER NOT NULL DEFAULT 0,
```

`insert_file()`:參數 `thumbnail_message_id: Optional[int]` 改為 `has_thumbnail: bool = False`(保持在 `telegram_message_id` 之後);SQL 欄位清單 `thumbnail_message_id` → `has_thumbnail`;VALUES 對應值改為 `1 if has_thumbnail else 0`。

`update_file()`(line 333):移除 `thumbnail_message_id` 參數與其 `updates.append(...)` 分支,只保留 `parent_id` / `set_parent_id`。

- [ ] **Step 4: schemas.py**

line 49 替換:

```python
    has_thumbnail: bool = Field(default=False, description="Whether a thumbnail is embedded in the file's own Telegram message")
```

- [ ] **Step 5: file_service.py**

- row 映射(line 47 及所有 `FileInfo(...)` 建構,lines 194/284/344/459):`thumbnail_message_id=row['thumbnail_message_id']` → `has_thumbnail=bool(row['has_thumbnail'] or 0)`;由既有 FileInfo 轉建構的地方用 `has_thumbnail=file_info.has_thumbnail`。資料夾(line 459)給 `has_thumbnail=False`。
- `register_uploaded_file()`(line 221):參數 `thumbnail_message_id: Optional[int] = None` → `has_thumbnail: bool = False`,傳入 `insert_file` 與回傳的 `FileInfo`。line 299 log 同步改字。
- `delete_folder` 的 message 收集(line 494):

```python
            for mid in (r.get('telegram_message_id'),)
```

- `update_file()`(line 511):移除 `thumbnail_message_id` 參數,只轉發 `parent_id` / `set_parent_id`。

- [ ] **Step 6: routes.py**

- `RegisterFileRequest`(line 210):`thumbnail_message_id: Optional[int] = None` → `has_thumbnail: bool = False`。
- `UpdateFileRequest`(line 225):移除 `thumbnail_message_id` 欄位(只剩 `parent_id`)。
- 移除 `VideoThumbnailRequest`(line 229)與兩個 deprecated 端點:`POST /files/thumbnail/upload`(line 328)、`POST /videos/thumbnail`(line 345),連同 `UploadFile, File` import 若無其他使用者。
- `register_file` 端點(line 314):`thumbnail_message_id=request.thumbnail_message_id` → `has_thumbnail=request.has_thumbnail`。
- delete 端點(lines 444-460):fallback dict 與 message 收集移除縮圖:

```python
        all_parts = [{
            "file_id": file_id,
            "telegram_message_id": file_info.telegram_message_id,
        }]
        ...
        message_ids = [
            p["telegram_message_id"]
            for p in all_parts
            if p.get("telegram_message_id")
        ]
```

(folder delete 走 `file_service.delete_folder`,Step 5 已改。)
- `update_file` 端點(line 483):移除 `thumbnail_message_id` 轉發與 log 字樣。
- `get_file_thumbnail`(line 541)的 message 選擇邏輯替換 lines 563-571:

```python
        # Thumbnails are embedded in the file's own message. For videos we must
        # have an embedded thumb; downloading the document itself is forbidden.
        is_video = mime_type.startswith('video/')
        if is_video and not file_info.has_thumbnail:
            raise HTTPException(status_code=404, detail="No thumbnail available")
        message_id = file_info.telegram_message_id
        if not message_id:
            raise HTTPException(status_code=404, detail="No thumbnail available")
```

- `_download_thumbnail_base64`(line 70)整個改寫(只抓內嵌 thumb;圖片 document 無 thumb 時才 fallback 下載完整圖片 — 圖片本體小,安全):

```python
async def _download_thumbnail_base64(client, message_id: int) -> Optional[str]:
    """Download ONLY the embedded thumb PhotoSize of the file's own message.

    Never downloads the document body (could be a 500MB video). Falls back to
    the full document only for image/* mime types (the image IS the thumbnail
    source and is small).
    """
    try:
        import io
        message = await client.get_messages('me', ids=message_id)
        if not message:
            logger.error(f"Thumbnail: Message {message_id} not found")
            return None
        media = getattr(message, 'media', None)
        doc = getattr(media, 'document', None) if media else None
        if doc is None:
            return None

        if getattr(doc, 'thumbs', None):
            buf = io.BytesIO()
            # thumb=-1 → largest embedded PhotoSize; a few KB, never the document
            await client.download_media(message, file=buf, thumb=-1)
            data = buf.getvalue()
            if data:
                return base64.b64encode(data).decode()

        if (getattr(doc, 'mime_type', '') or '').startswith('image/'):
            buf = io.BytesIO()
            await client.download_media(message, file=buf)
            data = buf.getvalue()
            if data:
                return base64.b64encode(data).decode()
        return None
    except Exception as e:
        logger.error(f"_download_thumbnail_base64 failed: {e}")
        return None
```

(原本 `GetFileRequest` / `InputPhotoFileLocation` 的 photo-message 路徑刪除 — 新 DB 不再有獨立縮圖 photo message;`from telethon.tl.functions.upload import GetFileRequest` 等 import 一併移除,若無其他使用者。)

- [ ] **Step 7: cleanup_orphans.py**

line 68 的收集改為:

```python
        for mid in (r.get("telegram_message_id"),)
```

- [ ] **Step 8: 刪除舊開發 DB(schema 用 CREATE TABLE IF NOT EXISTS,不刪不會重建)**

Run: `ls backend/*.db` 找出檔名(預期 `backend/teledrive.db`),然後刪除該檔(僅開發環境資料,使用者已確認無運行中 DB)。若 docker 服務在跑先 `docker compose down`。

- [ ] **Step 9: 跑測試確認通過(GREEN)**

Run: `cd backend && python -m pytest tests/ -v`
Expected: PASS(3 個 cascade delete 測試全綠)

- [ ] **Step 10: 確認後端無殘留引用**

Run: `grep -rn "thumbnail_message_id" backend/`
Expected: 無任何輸出

- [ ] **Step 11: Commit**

```bash
git add backend/
git commit -m "feat(backend): replace thumbnail_message_id with has_thumbnail (embedded thumbs)"
```

---

### Task 2: gramjs.ts — 上傳附帶內嵌縮圖、下載改抓 doc thumb

**Files:**
- Modify: `frontend/src/lib/gramjs.ts`(`uploadAlbum`、`uploadFileSplit`、`downloadThumbnail`、`downloadThumbnails`,新增私有 helper)

**Interfaces:**
- Consumes: 既有 `messageRateLimiter`、`sendFileLocked(params)`、`CustomFile`、`generateRandomBigInt()`。
- Produces(Task 3/4 依賴,簽名務必一致):
  - `uploadAlbum(files: File[], onProgress?: (fileIdx: number, pct: number) => void, thumbs?: Array<Blob | null>): Promise<Array<{ message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean }>>`
  - `uploadFileSplit(file: File, onProgress?: (pct: number) => void, thumb?: Blob | null): Promise<{ parts: [...]; originalName: string; totalParts: number; hasThumbnail: boolean }>`
  - `downloadThumbnails(messageIds: number[]): Promise<Map<number, Blob>>`(輸入語意改為**檔案自身的** `telegram_message_id`)
  - 本 task **保留** `uploadThumbnail()`(Task 3 才移除,維持每個 commit 可編譯)

- [ ] **Step 1: 新增私有 helper `uploadThumbInputFile`**

加在 `sendFileLocked` 方法之後:

```typescript
  /**
   * Upload thumbnail bytes and return an InputFile for embedding as a document
   * thumb. This is SaveFilePart traffic — NOT a message send — so it does not
   * go through messageRateLimiter. Returns undefined on any failure (non-fatal:
   * the file uploads without a thumbnail).
   */
  private async uploadThumbInputFile(thumb: Blob | null | undefined): Promise<Api.TypeInputFile | undefined> {
    if (!thumb || !this.client) return undefined;
    try {
      const arrayBuffer = await thumb.arrayBuffer();
      const buf = (globalThis as any).Buffer.from(new Uint8Array(arrayBuffer));
      const customFile = new CustomFile('thumb.jpg', thumb.size, '', buf);
      return await (this.client as any).uploadFile({ file: customFile, workers: 1 });
    } catch (err) {
      console.warn('[Thumb] thumb bytes upload failed (non-fatal):', err);
      return undefined;
    }
  }
```

- [ ] **Step 2: `uploadFileSplit` 增加 `thumb` 參數**

簽名改為:

```typescript
  async uploadFileSplit(file: File, onProgress?: (pct: number) => void, thumb?: Blob | null): Promise<{
    parts: Array<{ message_id: number; file_id: string; access_hash?: string; size: number }>;
    originalName: string;
    totalParts: number;
    hasThumbnail: boolean;
  }> {
```

小檔路徑(≤10MB,line 367 附近):

```typescript
      const thumbInput = await this.uploadThumbInputFile(thumb);
      const message = await this.sendFileLocked({
        file: customFile,
        workers: 4,
        forceDocument: true,
        ...(thumbInput ? { thumb: thumbInput } : {}),
      });
```

小檔 return 加 `hasThumbnail: !!thumbInput`。

大檔路徑:在 while 迴圈前加 `let thumbAttached = false;`,只在第一段(`segmentStartOffset === 0` 時)附 thumb:

```typescript
      const thumbInput = segmentStartOffset === 0 ? await this.uploadThumbInputFile(thumb) : undefined;
      if (thumbInput) thumbAttached = true;
      const message = await this.sendFileLocked({
        file: inputFileBig,
        forceDocument: true,
        ...(thumbInput ? { thumb: thumbInput } : {}),
      });
```

大檔 return 加 `hasThumbnail: thumbAttached`。

- [ ] **Step 3: `uploadAlbum` 增加 `thumbs` 參數與回傳 `has_thumbnail`**

簽名(`onProgress` 維持第二參數,不破壞既有呼叫):

```typescript
  async uploadAlbum(
    files: File[],
    onProgress?: (fileIdx: number, pct: number) => void,
    thumbs?: Array<Blob | null>,
  ): Promise<Array<{ message_id: number; file_id: string; access_hash?: string; size: number; has_thumbnail: boolean }>> {
```

`inputFiles` 的 map 內、`uploadFile` 之後補上 thumb 上傳:

```typescript
        const thumbInput = await this.uploadThumbInputFile(thumbs?.[idx]);
        return { inputFile, thumbInput, file };
```

`multiMedia` 組裝改為:

```typescript
    const multiMedia = inputFiles.map(({ inputFile, thumbInput, file }) =>
      new Api.InputSingleMedia({
        media: new Api.InputMediaUploadedDocument({
          file: inputFile,
          mimeType: file.type || 'application/octet-stream',
          attributes: [new Api.DocumentAttributeFilename({ fileName: file.name })],
          ...(thumbInput ? { thumb: thumbInput } : {}),
        }),
        message: '',
        randomId: generateRandomBigInt(),
      })
    );
```

invoke 前加一行 log(Task 5 的 E2E 依賴這個字串,勿改字):

```typescript
    console.log('[Album] SendMultiMedia batch size:', files.length);
```

最後的 return map 每項加 `has_thumbnail: !!inputFiles[idx].thumbInput && !!msg`(失敗項 `{ message_id: 0, ... }` 給 `has_thumbnail: false`)。

- [ ] **Step 4: `downloadThumbnails` / `downloadThumbnail` 改抓 document 內嵌 thumb**

`downloadThumbnails` 的 withSlot 內容改為(**只**下載 thumb PhotoSize,絕不下載 document 本體):

```typescript
        downloadSemaphore.withSlot(async () => {
          const msg = message as Api.Message | undefined;
          if (!msg || !msg.media) return;
          const media = msg.media as any;
          const doc = media?.className === 'MessageMediaDocument' ? media.document : undefined;
          if (!doc?.thumbs?.length) return; // no embedded thumb — nothing to show
          try {
            const buffer = await this.client!.downloadMedia(msg.media, { thumb: doc.thumbs.length - 1 });
            if (buffer) {
              result.set(msg.id, new Blob([buffer], { type: 'image/jpeg' }));
            }
          } catch (err) {
            console.warn('[Thumb] Batch download failed for message', msg.id, err);
          }
        })
```

單筆 `downloadThumbnail(messageId)` 用同樣邏輯改寫(getMessages 單筆 → 檢查 `doc.thumbs` → `downloadMedia(message.media, { thumb: doc.thumbs.length - 1 })`,無 thumb 時 throw `new Error("No embedded thumbnail")`)。

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: 無錯誤(`uploadThumbnail` 仍在,所有既有呼叫端未破壞)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/gramjs.ts
git commit -m "feat(gramjs): embed thumbnails via thumb param on sendFile/SendMultiMedia, download doc thumbs"
```

---

### Task 3: 前端欄位切換 + 單檔/album 路徑內嵌縮圖

**Files:**
- Create: `frontend/src/lib/thumbCapture.ts`
- Modify: `frontend/src/types/index.ts:9`
- Modify: `frontend/src/api/client.ts`(registerFile、移除 uploadThumbnail/updateFile/generateVideoThumbnail)
- Modify: `frontend/src/lib/uploadPlanner.ts`(`RegisterableExistingPart`、`registerDuplicateParts`)
- Modify: `frontend/src/components/ChonkyDrive.tsx`(`uploadWithThumbnail`、`uploadAlbumBatch`、`loadThumbnails`、`registerDependents`、移除 `scheduleThumbnailRefresh`)
- Modify: `frontend/src/lib/gramjs.ts`(移除 `uploadThumbnail()`)

**Interfaces:**
- Consumes: Task 2 的 `uploadAlbum(files, onProgress?, thumbs?)`(回傳含 `has_thumbnail`)、`uploadFileSplit(file, onProgress?, thumb?)`(回傳含 `hasThumbnail`)。
- Produces(Task 4 依賴):
  - `captureThumb(file: File, timeoutMs?: number): Promise<Blob | null>`(from `lib/thumbCapture.ts`)
  - `api.registerFile` 參數 `hasThumbnail?: boolean`(不再有 `thumbnailMessageId`)
  - `uploadAlbumBatch(batch, hashes, onProgress?)` 回傳項含 `has_thumbnail: boolean`
  - `RegisterableExistingPart` 含 `has_thumbnail?: boolean`

- [ ] **Step 1: 建立共用縮圖擷取 helper `frontend/src/lib/thumbCapture.ts`**

```typescript
import { generateThumbnail } from '../api/client';
import { generateVideoThumbnail } from './videoThumbnail';

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Capture a thumbnail blob from a local image/video file. Returns null for
 * non-media files, on capture failure, or on timeout — callers treat null as
 * "upload without thumbnail" (non-fatal).
 */
export async function captureThumb(file: File, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Blob | null> {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return null;
  try {
    const capture = isVideo ? generateVideoThumbnail(file) : generateThumbnail(file, 200);
    return await Promise.race([
      capture,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Thumbnail capture timeout')), timeoutMs)
      ),
    ]);
  } catch (err) {
    console.warn('[Thumb] capture failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  }
}
```

(若 `generateThumbnail` 不是從 `../api/client` export,以 `grep -n "generateThumbnail" frontend/src` 找到實際來源並修正 import — ChonkyDrive.tsx line 2 目前即是 `import { api, generateThumbnail } from '../api/client'`。)

- [ ] **Step 2: types/index.ts**

line 9 替換:

```typescript
  has_thumbnail?: boolean;
```

- [ ] **Step 3: api/client.ts**

- 刪除 `uploadThumbnail`(line 105)、`updateFile`(line 114)、`generateVideoThumbnail`(line 122)三個方法(`moveFile` 保留,負責 PATCH parent_id)。
- `registerFile` params:`thumbnailMessageId?: number` → `hasThumbnail?: boolean`;request body:`thumbnail_message_id: params.thumbnailMessageId` → `has_thumbnail: params.hasThumbnail ?? false`。

- [ ] **Step 4: uploadPlanner.ts — 重複檔沿用來源的 has_thumbnail**

`RegisterableExistingPart` 加欄位:

```typescript
export interface RegisterableExistingPart {
  filesize: number;
  mime_type?: string | null;
  telegram_message_id: number;
  access_hash?: string | null;
  part_index?: number | null;
  has_thumbnail?: boolean;
}
```

`registerDuplicateParts` 的 `api.registerFile` 呼叫加:

```typescript
      hasThumbnail: (part.part_index ?? i) === 0 ? (part.has_thumbnail ?? false) : false,
```

並移除既有的 `thumbnailMessageId` 相關殘留(若有)。

- [ ] **Step 5: ChonkyDrive.tsx — 所有 `asExisting` 映射補 `has_thumbnail`**

三處把 `FileInfo` 映射成 `RegisterableExistingPart` 的地方(`uploadWithThumbnail` 內 hashCheck、`startUploadBatch` 的 duplicates、`uploadFolder` 的 hashCheck)各加一行:

```typescript
            has_thumbnail: f.has_thumbnail,
```

`registerDependents` 的 `asExisting` 映射(來源是上傳結果 parts)加:

```typescript
        has_thumbnail: i === 0 ? (parts[0] as any).has_thumbnail ?? false : false,
```

- [ ] **Step 6: ChonkyDrive.tsx — `uploadWithThumbnail` 改為送檔前附縮圖**

- 縮圖擷取改用共用 helper:`thumbPromise = captureThumb(file, 60000);`(import from `'../lib/thumbCapture'`;移除原本的 `Promise.race` 區塊與 `generateVideoThumbnail` 直接呼叫)。
- 上傳呼叫改為:

```typescript
    const thumbBlob = thumbPromise ? await thumbPromise : null;
    const uploadResult = await telegramClient.uploadFileSplit(file, onProgress, thumbBlob);
```

- `registerFile` 迴圈加 `hasThumbnail: i === 0 && uploadResult.hasThumbnail,`。
- **整段刪除** lines 463-478 的 fire-and-forget 縮圖區塊(`uploadThumbnail` + `api.updateFile` + `scheduleThumbnailRefresh`)。
- 回傳值把 `has_thumbnail` 帶出去給 `registerDependents`:

```typescript
    return uploadResult.parts.map((p, i) => ({ ...p, has_thumbnail: i === 0 && uploadResult.hasThumbnail }));
```

- [ ] **Step 7: ChonkyDrive.tsx — `uploadAlbumBatch` 擷取並傳入縮圖**

函式開頭(呼叫 `uploadAlbum` 前)加:

```typescript
    const thumbs = await Promise.all(batch.map((file) => captureThumb(file)));
```

`uploadAlbum` 呼叫改為三參數:

```typescript
    const albumResults = await telegramClient.uploadAlbum(batch, (fileIdx, pct) => {
      onProgress?.(batch[fileIdx], pct);
    }, thumbs);
```

`registerFile` 加 `hasThumbnail: part.has_thumbnail,`;回傳 map 改為:

```typescript
    return albumResults.map((part) =>
      part.message_id
        ? { message_id: part.message_id, access_hash: part.access_hash, size: part.size, has_thumbnail: part.has_thumbnail }
        : null
    );
```

- [ ] **Step 8: ChonkyDrive.tsx — `loadThumbnails` 與 `scheduleThumbnailRefresh`**

- `loadThumbnails` 的候選篩選(line 69-72 附近)改為:

```typescript
             && f.has_thumbnail
             && f.telegram_message_id
```

- `messageIdToFile` 改以 `telegram_message_id` 為 key:

```typescript
    const messageIdToFile = new Map(misses.map((f) => [f.telegram_message_id!, f]));
```

- 刪除 `scheduleThumbnailRefresh` 的 useCallback 定義(line 216 附近)與相關 timer ref(唯一呼叫點已在 Step 6 刪除)。

- [ ] **Step 9: gramjs.ts — 移除 `uploadThumbnail()`**

刪除整個 `uploadThumbnail` 方法(lines 286-338)。

- [ ] **Step 10: Typecheck + 全案搜尋殘留**

Run: `cd frontend && npx tsc --noEmit`
Expected: 無錯誤

Run: `grep -rn "thumbnail_message_id\|thumbnailMessageId\|uploadThumbnail" frontend/src`
Expected: 無任何輸出

- [ ] **Step 11: Commit**

```bash
git add frontend/src
git commit -m "feat(upload): embed thumbnails in file messages, drop separate thumbnail messages"
```

---

### Task 4: uploadFolder 小檔累積器(album 聚批)

**Files:**
- Modify: `frontend/src/components/ChonkyDrive.tsx`(`uploadAlbumBatch` 增加 per-file parentIds、`uploadFolder` 累積器、`uploadFileEntryFresh` 內嵌縮圖)

**Interfaces:**
- Consumes: Task 3 的 `uploadAlbumBatch`、`captureThumb`、Task 2 的 `uploadFileSplit(file, onProgress?, thumb?)`。
- Produces: `uploadAlbumBatch(batch, hashes, onProgress?, parentIds?)` — `parentIds?: Array<string | null>`,未提供時沿用 `currentFolderId`。

- [ ] **Step 1: `uploadAlbumBatch` 增加 `parentIds` 參數**

簽名加第四參數 `parentIds?: Array<string | null>`;`registerFile` 內:

```typescript
          parentId: (parentIds ? parentIds[j] : currentFolderId) ?? undefined,
```

- [ ] **Step 2: `uploadFileEntryFresh`(大檔路徑)改內嵌縮圖**

```typescript
    const uploadFileEntryFresh = async (file: File, folderPath: string, fileHash: string | null): Promise<void> => {
      const telegramClient = getTelegramClient();
      const folderId = await ensureFolder(folderPath);
      const splitGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const thumbBlob = await captureThumb(file);
      const uploadResult = await telegramClient.uploadFileSplit(file, undefined, thumbBlob);
      await Promise.all(uploadResult.parts.map((part, j) =>
        api.registerFile({
          filename: file.name,
          filesize: part.size,
          mimeType: file.type || undefined,
          messageId: part.message_id,
          fileId: part.file_id,
          accessHash: part.access_hash,
          parentId: folderId ?? undefined,
          hasThumbnail: j === 0 && uploadResult.hasThumbnail,
          isSplitFile: true,
          splitGroupId: splitGroupId,
          partIndex: j,
          totalParts: uploadResult.parts.length,
          originalName: file.name,
          fileHash: fileHash ?? undefined,
        })
      ));
    };
```

(原本函式尾端的 fire-and-forget 縮圖區塊整段刪除 — Task 3 已使其無法編譯,此處是正式替代。)

- [ ] **Step 3: 小檔累積器**

在 `const uploadPromises: Promise<void>[] = [];` 之後加:

```typescript
    // Small-file accumulator: fresh files ≤10MB batch into one SendMultiMedia
    // (10 files = 1 message). Batches may mix files from different subfolders —
    // the album lands in Saved Messages; parent_id is per-file DB metadata.
    type PendingSmall = { file: File; folderPath: string; hash: string | null };
    const ALBUM_BATCH = 10;
    const SMALL_FILE_LIMIT = 10 * 1024 * 1024;
    let smallBuffer: PendingSmall[] = [];

    const flushSmallBuffer = (): void => {
      if (smallBuffer.length === 0) return;
      const batch = smallBuffer;
      smallBuffer = [];
      const p = fileSemaphore.withSlot(async () => {
        const folderIds = await Promise.all(batch.map((e) => ensureFolder(e.folderPath)));
        const results = await uploadAlbumBatch(
          batch.map((e) => e.file),
          batch.map((e) => e.hash),
          (file, pct) => { updateVisible(file.name, { progress: pct }); updateUI(); },
          folderIds,
        );
        results.forEach((res, j) => {
          if (res) {
            completed++;
            updateVisible(batch[j].file.name, { progress: 100, status: 'complete' });
          } else {
            failed++;
            updateVisible(batch[j].file.name, { progress: 0, status: 'error', error: '上傳失敗' });
          }
        });
        updateUI();
      }).catch(() => {
        batch.forEach((e) => {
          failed++;
          updateVisible(e.file.name, { progress: 0, status: 'error', error: '上傳失敗' });
        });
        updateUI();
      });
      uploadPromises.push(p);
    };
```

(注意:`flushSmallBuffer` 必須宣告在 `fileSemaphore`、`uploadAlbumBatch` 可見的位置 — `fileSemaphore` 定義於 line 800 附近,累積器放在其後。)

- [ ] **Step 4: `processEntry` 的 fresh 檔分流**

`processEntry` 內的上傳 promise 改為回傳 `'deferred' | 'done'`,小檔進 buffer 不在此處計數(完成/失敗由 flush 統一計):

```typescript
            const p = (async (): Promise<'deferred' | 'done'> => {
              const fileHash = await hashFileBounded(file);
              if (fileHash) {
                const hashCheck = await api.checkFileHash(fileHash).catch(() => ({ found: false, files: [] as FileInfo[] }));
                if (hashCheck.found && hashCheck.files.length > 0) {
                  console.log('[Upload] Duplicate detected by hash (folder upload):', file.name);
                  const folderId = await ensureFolder(folderPath);
                  const asExisting = hashCheck.files.map((f) => ({
                    filesize: f.filesize,
                    mime_type: f.mime_type,
                    telegram_message_id: f.telegram_message_id!,
                    access_hash: f.access_hash,
                    part_index: f.part_index,
                    has_thumbnail: f.has_thumbnail,
                  }));
                  await registerDuplicateParts(file, fileHash, asExisting, folderId);
                  return 'done';
                }
              }
              if (file.size <= SMALL_FILE_LIMIT) {
                smallBuffer.push({ file, folderPath, hash: fileHash });
                if (smallBuffer.length >= ALBUM_BATCH) flushSmallBuffer();
                return 'deferred';
              }
              await fileSemaphore.withSlot(() => uploadFileEntryFresh(file, folderPath, fileHash));
              return 'done';
            })().then((kind) => {
              if (kind === 'deferred') return;
              completed++;
              updateVisible(file.name, { progress: 100, status: 'complete' });
              updateUI();
            }).catch(() => {
              failed++;
              updateVisible(file.name, { progress: 0, status: 'error', error: '上傳失敗' });
              updateUI();
            });
            uploadPromises.push(p);
```

- [ ] **Step 5: 遍歷結束後的最終 flush**

`await Promise.all(rootEntries.map(...))` 與 `await Promise.allSettled(uploadPromises)` 之間插入:

```typescript
    // Traversal enqueues hash-check promises; they may still be adding files to
    // smallBuffer. Wait for them, flush the tail batch, then wait for the flush.
    await Promise.allSettled(uploadPromises);
    flushSmallBuffer();
    await Promise.allSettled(uploadPromises);
```

(第一個 allSettled 等 hash 檢查/大檔完成 — 此時所有小檔都已進 buffer;flush 會再 push 一個 promise,故需第二個 allSettled。取代原本單一的 `await Promise.allSettled(uploadPromises)`。)

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ChonkyDrive.tsx
git commit -m "feat(upload): batch small files into albums during folder upload"
```

---

### Task 5: E2E 測試、文件更新、建置與線上驗證

**Files:**
- Create: `frontend/tests/upload_album_thumbs.spec.ts`
- Modify: `CLAUDE.md`(縮圖規則、API 表)
- Modify: `FRONTEND_FEATURES.md`(縮圖流程描述,若有)

**Interfaces:**
- Consumes: Task 2 的 console log 字串 `'[Album] SendMultiMedia batch size:'`;既有測試基礎設施(`playwright.config.ts`、storageState、`data-testid="drive-drop-zone"`)。

- [ ] **Step 1: 新增 E2E 測試(先寫,對舊行為必然 FAIL — album 縮圖過去不存在)**

`frontend/tests/upload_album_thumbs.spec.ts`(模式仿照 `upload_dedup.spec.ts`):

```typescript
/**
 * Album batching + embedded thumbnail e2e.
 *
 * Verifies: (1) dropping 25 small files produces ceil(25/10)=3 SendMultiMedia
 * batches (not 25 sendFile messages); (2) dropped images get thumbnails in the
 * grid (embedded doc thumb downloaded via GramJS).
 *
 * Run: cd frontend && npx playwright test upload_album_thumbs --project=chromium --reporter=line
 */
import { test, expect } from '@playwright/test';

const SMALL_FILE_COUNT = 25;
const IMAGE_COUNT = 3;

test.setTimeout(180_000);

test('small files batch into albums and images get embedded thumbnails', async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on('console', (msg) => consoleMessages.push(msg.text()));

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  const loginVisible = await page
    .locator('input[placeholder*="session"], input[placeholder*="Session"]')
    .first().isVisible().catch(() => false);
  if (loginVisible) {
    test.skip(true, 'Login required — configure session in the app first');
    return;
  }
  await page.waitForSelector('text=Root', { timeout: 30_000 });

  // ── Phase A: 25 small binary files → expect 3 album batches ──────────────
  await page.evaluate(async (count: number) => {
    const dt = new DataTransfer();
    for (let i = 0; i < count; i++) {
      const buf = new Uint8Array(2048);
      buf.fill(i & 0xff);
      // random suffix so re-runs don't dedup against previous test data
      const suffix = Math.random().toString(36).slice(2, 8);
      dt.items.add(new File([buf], `album_${suffix}_${i}.bin`, { type: 'application/octet-stream' }));
    }
    const opts: DragEventInit = { dataTransfer: dt, bubbles: true, cancelable: true };
    const target = document.querySelector('[data-testid="drive-drop-zone"]') ?? document.body;
    target.dispatchEvent(new DragEvent('dragenter', opts));
    target.dispatchEvent(new DragEvent('dragover', opts));
    target.dispatchEvent(new DragEvent('drop', opts));
  }, SMALL_FILE_COUNT);

  await page.waitForSelector(`text=/上傳中 ${SMALL_FILE_COUNT} \\/ ${SMALL_FILE_COUNT}/`, { timeout: 120_000 });

  const albumLogs = consoleMessages.filter((m) => m.includes('[Album] SendMultiMedia batch size:'));
  console.log(`[Test] SendMultiMedia batches: ${albumLogs.length}`);
  expect(albumLogs.length, '25 small files should ride exactly 3 album batches').toBe(3);

  // ── Phase B: 3 PNG images → thumbnails render from embedded doc thumbs ───
  await page.evaluate(async (count: number) => {
    const makePng = (hue: number): Promise<Blob> => new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = 400; canvas.height = 300;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
      ctx.fillRect(0, 0, 400, 300);
      ctx.fillStyle = '#fff';
      ctx.font = '48px sans-serif';
      ctx.fillText(String(hue), 20, 60);
      canvas.toBlob((b) => resolve(b!), 'image/png');
    });
    const dt = new DataTransfer();
    const suffix = Math.random().toString(36).slice(2, 8);
    for (let i = 0; i < count; i++) {
      const blob = await makePng(i * 120);
      dt.items.add(new File([blob], `thumb_${suffix}_${i}.png`, { type: 'image/png' }));
    }
    const opts: DragEventInit = { dataTransfer: dt, bubbles: true, cancelable: true };
    const target = document.querySelector('[data-testid="drive-drop-zone"]') ?? document.body;
    target.dispatchEvent(new DragEvent('dragenter', opts));
    target.dispatchEvent(new DragEvent('dragover', opts));
    target.dispatchEvent(new DragEvent('drop', opts));
  }, IMAGE_COUNT);

  await page.waitForSelector(`text=/上傳中 ${IMAGE_COUNT} \\/ ${IMAGE_COUNT}/`, { timeout: 120_000 });

  // Thumbnails arrive async after the folder re-list; poll for blob: <img> tags.
  await expect
    .poll(async () => page.locator('img[src^="blob:"]').count(), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(IMAGE_COUNT);
});
```

- [ ] **Step 2: 啟動服務並跑測試**

Run: `docker compose up -d --build`,等待服務就緒後:
Run: `cd frontend && npx playwright test upload_album_thumbs --project=chromium --reporter=line`
Expected: PASS(兩個 phase 都綠;若環境未配置 session 則 skip — 需在有 session 的環境跑)

Run: `cd frontend && npx playwright test upload_dedup --project=chromium --reporter=line`
Expected: PASS(dedup 路徑未受影響)

- [ ] **Step 3: 更新 CLAUDE.md**

- 「Critical Constraints」最後一條替換為:

```markdown
- Thumbnails are embedded in the file's own Telegram message as a document thumb (`InputMediaUploadedDocument.thumb` / `sendFile`'s `thumb` option). To download a thumbnail, fetch ONLY the thumb PhotoSize (GramJS `downloadMedia(media, { thumb })`, Telethon `download_media(..., thumb=-1)`) — never the document body.
```

- 「Data Flow — Upload」第 1 點改為描述內嵌縮圖(縮圖經 Canvas 產生後,以 SaveFilePart 上傳並附掛在檔案 message 的 thumb,不再有獨立 `thumbnail_message_id`)。
- API 表格:`PATCH /files/{id}` 說明改為「Update metadata (parent_id for move)」。
- `FRONTEND_FEATURES.md` 若提及 thumbnail_message_id,同步改寫。

- [ ] **Step 4: 殘留全案掃描**

Run: `grep -rn "thumbnail_message_id\|thumbnailMessageId" --include="*.py" --include="*.ts" --include="*.tsx" --include="*.md" .`
Expected: 只剩 `docs/superpowers/` 下的 spec/plan 歷史文件(描述舊行為的部分),程式碼與 CLAUDE.md 無殘留

- [ ] **Step 5: 手動線上驗證(CLAUDE.md 開發規範,必做)**

以瀏覽器開啟 `https://teledrive.yoyotsaoteledrive.dpdns.org`:
1. 拖入一個含 20+ 張照片與子資料夾的資料夾 → 上傳完成、資料夾結構正確。
2. 縮圖正常顯示(格狀畫面出現照片縮圖)。
3. DevTools console 無 FLOOD_WAIT 警告;`[Album] SendMultiMedia batch size:` log 出現且批次數 ≈ 檔案數/10。
4. 點開一張照片/一支影片確認預覽/播放正常(下載路徑未受影響)。
5. 刪除剛上傳的資料夾 → 全部消失。

- [ ] **Step 6: Commit**

```bash
git add frontend/tests CLAUDE.md FRONTEND_FEATURES.md
git commit -m "test(e2e): album batching + embedded thumbnail coverage; update docs"
```
