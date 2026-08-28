# Chat 媒體匯入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 給定一個 channel/group id，把整個 chat 的媒體由舊到新逐則 forward 到 Saved Messages，並註冊成 `root/{chat name}` 底下的 drive 檔案。

**Architecture:** 純前端功能，後端零改動。新增一個「不 import `telegram` 套件」的純函式模組 `telegramMedia.ts`（媒體解析與檔名推導，可用 node 跑 selfcheck），一個編排模組 `chatImport.ts`，以及一個對話框。`gramjs.ts` 的五處下載路徑改走 `telegramMedia.readMedia()`，順帶補上目前缺少／損壞的 `MessageMediaPhoto` 支援。

**Tech Stack:** React 18 + TypeScript (strict)、GramJS (`telegram` ^2.26.22)、Vite、既有 axios API client (`src/api/client.ts`)。

**Spec:** `docs/superpowers/specs/2026-08-17-chat-media-import-design.md`

## Global Constraints

- **Binary 絕不經過 Python 後端。** 本功能不新增、不修改任何後端檔案。forward 是 Telegram 伺服器內部操作，符合此不變量。
- **本計畫不改動 `backend/` 底下任何檔案。** 沿用既有的 `POST /api/v1/folders`、`GET /api/v1/files`、`POST /api/v1/files/register`。
- **`telegramMedia.ts` 不得 import `telegram` 套件**（也不得 import `gramjs.ts`）。它必須能被 esbuild 打包後在 node 直接跑，所以所有輸入都用 duck typing 接普通物件。
- **TypeScript strict mode**：`frontend/tsconfig.json` 開啟 strict，`npm run build` 會跑 `tsc`，型別錯誤即建置失敗。
- 樣式一律 inline style + `var(--td-*)` CSS 變數，無 CSS modules、無 Tailwind（對齊 `components/RenameDialog.tsx`）。
- Selfcheck 執行方式固定為（在 `frontend/` 目錄下）：
  ```bash
  npx esbuild --bundle --platform=node --format=esm src/lib/<name>.selfcheck.ts | node --input-type=module
  ```
- 提交訊息用 Conventional Commits（對齊 `git log`：`feat(upload): ...`、`refactor(gramjs): ...`）。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| **Create** `frontend/src/lib/telegramMedia.ts` | 純函式：從 message/media 物件解析出下載所需的 ref、大小、mime、縮圖 size type，以及檔名推導。零相依。 |
| **Create** `frontend/src/lib/telegramMedia.selfcheck.ts` | 上者的 assert-based 自我檢查。 |
| **Create** `frontend/src/lib/chatImport.ts` | 匯入編排：解析 chat → 建資料夾 → 收集去重集合 → 逐則 forward + register → 回報進度。相依以參數注入，方便 selfcheck。 |
| **Create** `frontend/src/lib/chatImport.selfcheck.ts` | 去重／跳過／進度計數邏輯的自我檢查。 |
| **Create** `frontend/src/components/ImportChatDialog.tsx` | 匯入 UI：輸入 chat、顯示進度、可中止。 |
| **Modify** `frontend/src/lib/gramjs.ts` | 五處下載路徑改走 `readMedia()`（含 photo 支援）；新增 `resolveChat` / `iterChatMedia` / `forwardToSaved`。 |
| **Modify** `frontend/src/components/ChonkyDrive.tsx` | 掛上匯入對話框的進入點。 |

---

### Task 1: `telegramMedia.ts` — 媒體解析

**Files:**
- Create: `frontend/src/lib/telegramMedia.ts`
- Create: `frontend/src/lib/telegramMedia.selfcheck.ts`

**Interfaces:**
- Consumes: 無。
- Produces:
  ```ts
  export type MediaRef = {
    kind: 'document' | 'photo';
    id: string;                      // String(doc.id) —— 當作 file_id 與去重鍵
    rawId: unknown;                  // 原樣傳進 Api.Input*FileLocation
    accessHash: unknown;
    fileReference?: Uint8Array;
    size: number;
    mimeType: string;
    fullThumbSize: string;           // document: ''; photo: 最大 PhotoSize 的 type
    previewThumbSize: string | null; // 拿來當縮圖的 size type；null = 沒有縮圖
  };
  export function readMedia(media: unknown): MediaRef | null;
  export function photoSizeBytes(size: any): number | null;
  ```

**背景（為什麼要做）:** `gramjs.ts:305` 的 `getFileLocation()` 遇到非 `MessageMediaDocument` 直接 throw；`gramjs.ts:958` 的 `downloadFileChunked()` photo 分支是壞的 —— 它建 `InputDocumentFileLocation`（photo 需要 `InputPhotoFileLocation`）並讀 `photo.size`，但 `Api.Photo` 沒有 `size` 屬性，只有 `sizes[]`。本任務把這些判斷集中成一個可測試的純函式。

- [ ] **Step 1: 寫失敗測試**

建立 `frontend/src/lib/telegramMedia.selfcheck.ts`：

```ts
/**
 * Self-check for telegramMedia — the media-shape guesswork that used to be
 * scattered through gramjs.ts download paths. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/telegramMedia.selfcheck.ts | node --input-type=module
 *
 * Why this matters: a photo built as an InputDocumentFileLocation downloads
 * garbage or errors, and `photo.size` is undefined on Api.Photo (it only has
 * sizes[]). Both bugs are silent at the type level because gramjs hands us
 * `any`. These asserts are what "we read the right bytes" means.
 */
import { readMedia, photoSizeBytes } from './telegramMedia.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

// --- document ---------------------------------------------------------------
const doc = {
  className: 'MessageMediaDocument',
  document: {
    id: 111, accessHash: 222, fileReference: new Uint8Array([1, 2]),
    size: 4096, mimeType: 'video/mp4',
    thumbs: [
      { type: 'i', bytes: new Uint8Array([9]) },   // stripped —— 不可用
      { type: 'm', size: 800 },
      { type: 'x', size: 9000 },
    ],
    attributes: [],
  },
};
const d = readMedia(doc)!;
check('document: kind', d.kind === 'document');
check('document: id is a decimal string', d.id === '111');
check('document: size', d.size === 4096);
check('document: mime', d.mimeType === 'video/mp4');
check('document: fullThumbSize is empty', d.fullThumbSize === '');
check('document: preview picks largest real thumb', d.previewThumbSize === 'x');

const docNoThumb = { ...doc, document: { ...doc.document, thumbs: [] } };
check('document without thumbs has no preview', readMedia(docNoThumb)!.previewThumbSize === null);

const docStrippedOnly = {
  ...doc,
  document: { ...doc.document, thumbs: [{ type: 'i', bytes: new Uint8Array([9]) }] },
};
check('document with only a stripped thumb has no preview',
  readMedia(docStrippedOnly)!.previewThumbSize === null);

const docNoMime = { ...doc, document: { ...doc.document, mimeType: undefined } };
check('document without mime falls back to octet-stream',
  readMedia(docNoMime)!.mimeType === 'application/octet-stream');

// --- photo ------------------------------------------------------------------
const photo = {
  className: 'MessageMediaPhoto',
  photo: {
    id: 333, accessHash: 444, fileReference: new Uint8Array([3]),
    sizes: [
      { type: 'i', bytes: new Uint8Array([7]) },       // stripped
      { type: 'm', size: 1200 },
      { type: 'y', sizes: [100, 2000, 50000] },        // PhotoSizeProgressive
    ],
  },
};
const p = readMedia(photo)!;
check('photo: kind', p.kind === 'photo');
check('photo: id', p.id === '333');
check('photo: mime is jpeg', p.mimeType === 'image/jpeg');
check('photo: size comes from the largest size, progressive included',
  p.size === 50000);
check('photo: fullThumbSize is the largest size type', p.fullThumbSize === 'y');
check('photo: preview is the smallest real size', p.previewThumbSize === 'm');

check('progressive size uses the last entry of sizes[]',
  photoSizeBytes({ type: 'y', sizes: [1, 2, 3] }) === 3);
check('stripped size has no byte count',
  photoSizeBytes({ type: 'i', bytes: new Uint8Array([1]) }) === null);

// --- 其他 --------------------------------------------------------------------
check('unsupported media returns null',
  readMedia({ className: 'MessageMediaPoll' }) === null);
check('null media returns null', readMedia(null) === null);
check('document media without a document returns null',
  readMedia({ className: 'MessageMediaDocument' }) === null);

console.log('\nAll telegramMedia checks passed.');
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd frontend
npx esbuild --bundle --platform=node --format=esm src/lib/telegramMedia.selfcheck.ts | node --input-type=module
```
Expected: FAIL —— esbuild 報 `Could not resolve "./telegramMedia.ts"`。

- [ ] **Step 3: 寫最小實作**

建立 `frontend/src/lib/telegramMedia.ts`：

```ts
/**
 * Pure media-shape helpers, shared by the download paths in gramjs.ts and by
 * chat import. Deliberately imports nothing — not even `telegram` — so it can
 * be bundled and run under node by telegramMedia.selfcheck.ts. Everything is
 * duck-typed because gramjs hands the download paths `any`.
 */

export type MediaRef = {
  kind: 'document' | 'photo';
  /** Decimal string form of the media id — this is the drive's file_id and the import dedupe key. */
  id: string;
  /** Passed straight back into Api.Input*FileLocation; a bigint in production. */
  rawId: unknown;
  accessHash: unknown;
  fileReference?: Uint8Array;
  size: number;
  mimeType: string;
  /** thumbSize for fetching the FULL media: '' for documents, the largest PhotoSize type for photos. */
  fullThumbSize: string;
  /** thumbSize for fetching a preview, or null when there is nothing usable. */
  previewThumbSize: string | null;
};

/**
 * Byte count of one PhotoSize variant, or null when it carries no separate
 * file (stripped/cached sizes hold inline `bytes` that aren't a standalone
 * JPEG). PhotoSizeProgressive has no `size` — its byte count is the last
 * entry of `sizes[]`.
 */
export function photoSizeBytes(size: any): number | null {
  if (!size || size.bytes) return null;
  if (typeof size.size === 'number') return size.size;
  if (Array.isArray(size.sizes) && size.sizes.length > 0) {
    return Number(size.sizes[size.sizes.length - 1]);
  }
  return null;
}

/** Real (separately downloadable) sizes, ascending by byte count. */
function realSizesAscending(sizes: any[] | undefined): { type: string; bytes: number }[] {
  return (sizes ?? [])
    .map((s) => ({ type: s?.type, bytes: photoSizeBytes(s) }))
    .filter((s): s is { type: string; bytes: number } =>
      typeof s.type === 'string' && s.bytes !== null)
    .sort((a, b) => a.bytes - b.bytes);
}

export function readMedia(media: unknown): MediaRef | null {
  const m = media as any;
  if (!m) return null;

  if (m.className === 'MessageMediaDocument') {
    const doc = m.document;
    if (!doc) return null;
    const thumbs = realSizesAscending(doc.thumbs);
    return {
      kind: 'document',
      id: String(doc.id),
      rawId: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      size: Number(doc.size ?? 0),
      mimeType: doc.mimeType || 'application/octet-stream',
      fullThumbSize: '',
      previewThumbSize: thumbs.length ? thumbs[thumbs.length - 1].type : null,
    };
  }

  if (m.className === 'MessageMediaPhoto') {
    const photo = m.photo;
    if (!photo) return null;
    const sizes = realSizesAscending(photo.sizes);
    if (!sizes.length) return null;
    const largest = sizes[sizes.length - 1];
    return {
      kind: 'photo',
      id: String(photo.id),
      rawId: photo.id,
      accessHash: photo.accessHash,
      fileReference: photo.fileReference,
      size: largest.bytes,
      mimeType: 'image/jpeg',
      // A photo has no "whole file" — you download one of its sizes. The
      // largest size IS the file as far as the drive is concerned.
      fullThumbSize: largest.type,
      previewThumbSize: sizes[0].type,
    };
  }

  return null;
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd frontend
npx esbuild --bundle --platform=node --format=esm src/lib/telegramMedia.selfcheck.ts | node --input-type=module
```
Expected: 每行 `ok - ...`，最後 `All telegramMedia checks passed.`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/telegramMedia.ts frontend/src/lib/telegramMedia.selfcheck.ts
git commit -m "feat(media): pure media-shape helpers with photo support"
```

---

### Task 2: 檔名推導

**Files:**
- Modify: `frontend/src/lib/telegramMedia.ts`（append）
- Modify: `frontend/src/lib/telegramMedia.selfcheck.ts`（append）

**Interfaces:**
- Consumes: Task 1 的 `readMedia`（本任務不直接呼叫，但同檔案）。
- Produces:
  ```ts
  export function extFromMime(mime: string | undefined): string;
  export function sanitizeFilename(name: string): string;
  export function deriveFilename(message: any): string;   // message: { id, date, media }
  ```

**背景:** Channel 媒體常常沒有 `DocumentAttributeFilename`（影片、語音），原生照片則永遠沒有檔名。規則見 spec 的「檔名推導」表。所有合成檔名都嵌入 `msgId`，因此天然不撞名。

- [ ] **Step 1: 寫失敗測試**

在 `telegramMedia.selfcheck.ts` 的 `console.log('\nAll telegramMedia checks passed.')` **之前**插入：

```ts
// --- 檔名推導 ---------------------------------------------------------------
import { deriveFilename, sanitizeFilename, extFromMime } from './telegramMedia.ts';

const DATE = 1755388800; // 2026-08-17T00:00:00Z

function docMessage(attributes: any[], mimeType = 'application/octet-stream') {
  return {
    id: 42,
    date: DATE,
    media: { className: 'MessageMediaDocument', document: { id: 1, accessHash: 2, size: 1, mimeType, attributes } },
  };
}

check('real filename wins',
  deriveFilename(docMessage([{ className: 'DocumentAttributeFilename', fileName: 'report.pdf' }])) === 'report.pdf');

check('video without a filename is named from the message id',
  deriveFilename(docMessage([{ className: 'DocumentAttributeVideo' }], 'video/mp4')) === 'video_42.mp4');

check('audio with title and performer',
  deriveFilename(docMessage([{ className: 'DocumentAttributeAudio', title: 'Song', performer: 'Band' }], 'audio/mpeg'))
    === 'Band - Song.mp3');

check('audio with title only',
  deriveFilename(docMessage([{ className: 'DocumentAttributeAudio', title: 'Song' }], 'audio/mpeg'))
    === 'Song.mp3');

check('audio without title',
  deriveFilename(docMessage([{ className: 'DocumentAttributeAudio' }], 'audio/ogg')) === 'audio_42.ogg');

check('animated gif',
  deriveFilename(docMessage([{ className: 'DocumentAttributeAnimated' }], 'video/mp4')) === 'gif_42.mp4');

check('sticker',
  deriveFilename(docMessage([{ className: 'DocumentAttributeSticker' }], 'image/webp')) === 'sticker_42.webp');

check('bare document falls back to file_ with a mime-derived extension',
  deriveFilename(docMessage([], 'application/zip')) === 'file_42.zip');

check('unknown mime falls back to its subtype',
  deriveFilename(docMessage([], 'application/x-weird')) === 'file_42.x-weird');

check('missing mime falls back to bin',
  deriveFilename(docMessage([], '')) === 'file_42.bin');

check('filename attribute wins even for a video',
  deriveFilename(docMessage(
    [{ className: 'DocumentAttributeVideo' }, { className: 'DocumentAttributeFilename', fileName: 'clip.mkv' }],
    'video/mp4')) === 'clip.mkv');

const photoMsg = {
  id: 77,
  date: DATE,
  media: { className: 'MessageMediaPhoto', photo: { id: 3, accessHash: 4, sizes: [{ type: 'x', size: 10 }] } },
};
check('photo name embeds its timestamp and message id',
  deriveFilename(photoMsg) === 'photo_20260817_000000_77.jpg');

// sanitize
check('path separators are stripped',
  sanitizeFilename('a/b\\c.txt') === 'a_b_c.txt');
check('control characters are stripped but spaces survive',
  sanitizeFilename('a b\nc.txt') === 'a bc.txt');
check('an empty name becomes a placeholder',
  sanitizeFilename('   ') === 'unnamed');
const long = 'x'.repeat(300) + '.mp4';
check('long names are truncated to 200 chars', sanitizeFilename(long).length === 200);
check('truncation keeps the extension', sanitizeFilename(long).endsWith('.mp4'));

check('extFromMime maps known types', extFromMime('image/jpeg') === 'jpg');
check('extFromMime handles parameters', extFromMime('image/jpeg; charset=binary') === 'jpg');
```

**注意：** import 語句要移到檔案頂端與 Task 1 的 import 合併，寫成：
```ts
import { readMedia, photoSizeBytes, deriveFilename, sanitizeFilename, extFromMime } from './telegramMedia.ts';
```
並刪掉上面插入區塊裡那行重複的 import。

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd frontend
npx esbuild --bundle --platform=node --format=esm src/lib/telegramMedia.selfcheck.ts | node --input-type=module
```
Expected: FAIL —— esbuild 報 `No matching export ... "deriveFilename"`。

- [ ] **Step 3: 寫最小實作**

在 `telegramMedia.ts` 末端追加：

```ts
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/flac': 'flac',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt',
};

export function extFromMime(mime: string | undefined): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  if (!base) return 'bin';
  if (MIME_EXT[base]) return MIME_EXT[base];
  const subtype = base.split('/')[1];
  return subtype || 'bin';
}

/** UTC yyyymmdd_hhmmss from a Telegram unix timestamp (seconds). */
function stamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * Strip anything that would break a path or a UI row, and cap the length so a
 * pathological caption-as-filename can't blow past filesystem limits on
 * download. The extension is preserved across truncation.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')  // control chars, e.g. newlines in captions
    .replace(/[/\\]/g, '_')
    .trim();
  if (!cleaned) return 'unnamed';
  const MAX = 200;
  if (cleaned.length <= MAX) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX - ext.length) + ext;
}

function attr(attributes: any[] | undefined, className: string): any {
  return (attributes ?? []).find((a) => a?.className === className);
}

/**
 * Best available name for a message's media. Captions are deliberately NOT
 * used: they are frequently long prose with newlines and emoji, and when a
 * real DocumentAttributeFilename exists it is always the better name anyway.
 * Every synthesized name embeds the message id, so names never collide.
 */
export function deriveFilename(message: any): string {
  const msgId = message?.id;
  const media = message?.media;

  if (media?.className === 'MessageMediaPhoto') {
    return `photo_${stamp(Number(message?.date ?? 0))}_${msgId}.jpg`;
  }

  const doc = media?.document;
  const attributes = doc?.attributes as any[] | undefined;
  const mime = doc?.mimeType as string | undefined;
  const ext = extFromMime(mime);

  const named = attr(attributes, 'DocumentAttributeFilename');
  if (named?.fileName) return sanitizeFilename(String(named.fileName));

  if (attr(attributes, 'DocumentAttributeAnimated')) return `gif_${msgId}.${ext}`;
  if (attr(attributes, 'DocumentAttributeSticker')) return `sticker_${msgId}.${ext}`;

  const audio = attr(attributes, 'DocumentAttributeAudio');
  if (audio) {
    if (audio.title) {
      const label = audio.performer ? `${audio.performer} - ${audio.title}` : String(audio.title);
      return sanitizeFilename(`${label}.${ext}`);
    }
    return `audio_${msgId}.${ext}`;
  }

  if (attr(attributes, 'DocumentAttributeVideo')) return `video_${msgId}.${ext}`;

  return `file_${msgId}.${ext}`;
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd frontend
npx esbuild --bundle --platform=node --format=esm src/lib/telegramMedia.selfcheck.ts | node --input-type=module
```
Expected: 全部 `ok - ...`。若 `photo_20260817_000000_77.jpg` 那條失敗，代表 `DATE` 常數對應的 UTC 時間不同 —— 用 `node -e "console.log(new Date(1755388800*1000).toISOString())"` 確認，並把測試裡的期望字串改成實際 UTC 值（不要改實作去遷就）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/telegramMedia.ts frontend/src/lib/telegramMedia.selfcheck.ts
git commit -m "feat(media): derive filenames for media that carries none"
```

---

### Task 3: `gramjs.ts` 下載路徑支援照片

**Files:**
- Modify: `frontend/src/lib/gramjs.ts`（`getFileLocation` 約 292-320；`downloadThumbnails` 約 761-800；`downloadFileMetadata` 約 826-866；`downloadFileChunked` 約 958-1005；`downloadFileChunkedByOffset` 約 1140-1147）

**Interfaces:**
- Consumes: Task 1 的 `readMedia`、`MediaRef`。
- Produces:
  ```ts
  // getFileLocation 的回傳型別改變 —— Task 4/5 不直接用，但同檔案內的呼叫端要一起改
  private async getFileLocation(messageId, forceRefresh?, expectedFileId?): Promise<MediaRef>
  ```

**背景:** 目前 `getFileLocation()` 對 photo 直接 throw，`downloadFileChunked()` 的 photo 分支用錯 location 型別且讀不存在的 `photo.size`。三處 `Api.InputDocumentFileLocation`（`gramjs.ts:793`、`:1002`、`:1142`）要改成依 `MediaRef.kind` 分派。

- [ ] **Step 1: 加入 import 與共用的 location builder**

在 `gramjs.ts` 的 import 區加入：
```ts
import { readMedia, type MediaRef } from './telegramMedia';
```

在 `TelegramClientManager` class 外、`export class` 之前加入模組層級的 helper：

```ts
/**
 * Build the right file location for a media ref. Photos need
 * InputPhotoFileLocation with a size type — an InputDocumentFileLocation with
 * a photo id downloads nothing useful, which is the bug this replaces.
 */
function fileLocationFor(ref: MediaRef, thumbSize: string): Api.TypeInputFileLocation {
  if (ref.kind === 'photo') {
    return new Api.InputPhotoFileLocation({
      id: ref.rawId as any,
      accessHash: ref.accessHash as any,
      fileReference: ref.fileReference,
      thumbSize,
    });
  }
  return new Api.InputDocumentFileLocation({
    id: ref.rawId as any,
    accessHash: ref.accessHash as any,
    fileReference: ref.fileReference,
    thumbSize,
  });
}
```

- [ ] **Step 2: 改寫 `getFileLocation`**

把 `fileLocationCache` 的型別與整個方法本體換成：

```ts
  private fileLocationCache = new Map<number, MediaRef>();

  private async getFileLocation(
    messageId: number,
    forceRefresh = false,
    expectedFileId?: string,
  ): Promise<MediaRef> {
    if (!forceRefresh) {
      const cached = this.fileLocationCache.get(messageId);
      if (cached) return cached;
    }
    const messages = await this.client!.getMessages("me", { ids: [messageId] });
    const message = messages[0] as Api.Message;
    if (!message?.media) throw new Error("Message has no media");
    const ref = readMedia(message.media);
    if (!ref) throw new Error('Unsupported media type: ' + (message.media as any)?.className);
    if (expectedFileId && ref.id !== expectedFileId) {
      // Message ids are only unique within one account. If we ever ask the
      // wrong client, this is what turns "silently downloaded someone else's
      // file" into a loud failure.
      throw new Error(
        `Message ${messageId} on account ${this.accountId} holds document ${ref.id}, expected ${expectedFileId}`
      );
    }
    this.fileLocationCache.set(messageId, ref);
    return ref;
  }
```

- [ ] **Step 3: 改寫三處 location 建構與兩處 media 解析**

`downloadFileChunkedByOffset` 的 `toLocation`（約 `gramjs.ts:1140`）：
```ts
    const toLocation = (ref: MediaRef) => fileLocationFor(ref, ref.fullThumbSize);
```
同時把該方法內引用 `loc.docId` / `loc.accessHash` 的地方一併改成 `ref`（`toLocation` 的參數型別已變）。

`downloadFileChunked`（約 `gramjs.ts:965-1005`）：把整段 `if (media?.className === 'MessageMediaDocument') { ... } else if (...MessageMediaPhoto...) { ... } else { throw }` 換成：
```ts
    const ref = readMedia(message.media);
    if (!ref) throw new Error('Unsupported media type: ' + (message.media as any)?.className);
    const fileSize = ref.size;
    console.log('[Streaming] Total size:', fileSize);
```
並把下方 `const location = new Api.InputDocumentFileLocation({...})` 換成：
```ts
    const location = fileLocationFor(ref, ref.fullThumbSize);
```
移除已不再使用的 `docId` / `accessHash` / `fileReference` 區域變數。

`downloadFileMetadata`（約 `gramjs.ts:843-866`）：把 media 分支換成：
```ts
    const ref = readMedia(message.media);
    if (!ref) throw new Error("Unsupported media type: " + (message.media as any)?.className);
    console.log('[FileMetadata] Got metadata - size:', ref.size, 'mimeType:', ref.mimeType);
    return { size: ref.size, mimeType: ref.mimeType };
```

`downloadThumbnails`（約 `gramjs.ts:780-800`）：把「只認 document thumbs」的那段換成：
```ts
          const ref = readMedia(msg.media);
          if (!ref?.previewThumbSize) return; // no usable preview — nothing to show
          try {
            // Fetch the thumb via GetFile on the MAIN connection with cdnSupported
            // OFF, instead of downloadMedia — downloadMedia borrows an exported
            // sender to the file's media DC, and that extra ws-proxied connection
            // reconnect-loops ("Connection closed while receiving data"). Keeping
            // thumbnails on the main sender (like the parallel preview path) avoids it.
            const location = fileLocationFor(ref, ref.previewThumbSize);
```
（其餘 `client.invoke(new Api.upload.GetFile({ ... }))` 的部分保持不動。）

- [ ] **Step 4: 型別檢查**

```bash
cd frontend
npx tsc --noEmit
```
Expected: 沒有錯誤。若出現 `Property 'docId' does not exist on type 'MediaRef'`，代表還有 `getFileLocation` 的舊呼叫端沒改到 —— 用 `grep -n "docId" src/lib/gramjs.ts` 找出來改成 `rawId` / 走 `fileLocationFor`。

- [ ] **Step 5: 建置**

```bash
cd frontend
npm run build
```
Expected: build 成功。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/gramjs.ts
git commit -m "fix(gramjs): download photos through InputPhotoFileLocation"
```

---

### Task 4: `gramjs.ts` 存取來源 chat

**Files:**
- Modify: `frontend/src/lib/gramjs.ts`（在 `TelegramClientManager` 內、`sendAuthChallenge` 之前新增三個方法）

**Interfaces:**
- Consumes: Task 1 的 `readMedia`。
- Produces（`TelegramClientManager` 的 public 方法）：
  ```ts
  async resolveChat(input: string): Promise<{ entity: any; title: string; noForwards: boolean }>;
  async *iterChatMedia(entity: any): AsyncGenerator<any /* Api.Message */>;
  async forwardToSaved(entity: any, messageId: number): Promise<any /* Api.Message */>;
  ```

- [ ] **Step 1: 實作三個方法**

在 `gramjs.ts` 的 `TelegramClientManager` 內新增：

```ts
  /**
   * Resolve a channel/group from a username, t.me link, or numeric id.
   *
   * A numeric id alone is not enough for a private channel — MTProto needs the
   * peer's access_hash, which only lives in the session's entity cache. So on
   * failure we pull the dialog list once (which populates that cache) and try
   * again before giving up.
   */
  async resolveChat(input: string): Promise<{ entity: any; title: string; noForwards: boolean }> {
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized');

    const raw = input.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
    const asNumber = /^-?\d+$/.test(raw) ? Number(raw) : null;
    const target: string | number = asNumber ?? raw;

    let entity: any;
    try {
      entity = await this.client.getEntity(target as any);
    } catch (err) {
      console.warn('[ChatImport] getEntity failed, refreshing dialogs and retrying', err);
      await this.client.getDialogs({ limit: 200 });
      try {
        entity = await this.client.getEntity(target as any);
      } catch {
        throw new Error(`此帳號無法存取 chat「${input}」。請先用同一個 Telegram 帳號開啟過該對話。`);
      }
    }

    const title = entity.title
      || [entity.firstName, entity.lastName].filter(Boolean).join(' ')
      || entity.username
      || String(input);
    return { entity, title, noForwards: Boolean(entity.noforwards) };
  }

  /**
   * Yield the chat's media messages oldest-first.
   *
   * No server-side InputMessagesFilter is used: no single filter covers
   * photos + videos + documents at once, and running several filtered passes
   * would break the single oldest-to-newest ordering the import relies on for
   * resumability. Filtering client-side costs one getHistory page per 100
   * messages, which is cheap next to the forward rate limit.
   */
  async *iterChatMedia(entity: any): AsyncGenerator<Api.Message> {
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized');
    for await (const message of this.client.iterMessages(entity, { reverse: true })) {
      const msg = message as Api.Message;
      if (msg?.media && readMedia(msg.media)) yield msg;
    }
  }

  /**
   * Forward one message into Saved Messages and return the new message.
   *
   * ponytail: one message per call, paced by messageRateLimiter (~3/s). Telegram
   * accepts up to 100 ids per forwardMessages call, which would be ~100x faster;
   * the upgrade path is batching and matching the returned messages back to
   * their sources by media id, since the API gives no explicit mapping.
   */
  async forwardToSaved(entity: any, messageId: number): Promise<Api.Message> {
    await this.waitUntilReady();
    if (!this.client) throw new Error('Client not initialized');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.messageRateLimiter.wait();
        const result = await this.client.forwardMessages('me', {
          messages: [messageId],
          fromPeer: entity,
        });
        const forwarded = (result as any[])[0] as Api.Message;
        if (!forwarded?.id) throw new Error(`Forward of message ${messageId} returned no message`);
        return forwarded;
      } catch (err: any) {
        if (isFloodError(err) && attempt < 2) {
          this.penalizeForFlood('forwardMessages', err);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Forward of message ${messageId} failed after retries`);
  }
```

- [ ] **Step 2: 型別檢查與建置**

```bash
cd frontend
npx tsc --noEmit && npm run build
```
Expected: 皆成功。若 `iterMessages` 的 `reverse` 選項被回報為不存在，改用 `(this.client as any).iterMessages(entity, { reverse: true })` 並在該行上方註明是 GramJS 型別定義的缺漏。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/gramjs.ts
git commit -m "feat(gramjs): resolve, iterate and forward a source chat's media"
```

---

### Task 5: `chatImport.ts` 匯入編排

**Files:**
- Create: `frontend/src/lib/chatImport.ts`
- Create: `frontend/src/lib/chatImport.selfcheck.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `readMedia`、`deriveFilename`；Task 4 的 `resolveChat` / `iterChatMedia` / `forwardToSaved`；既有的 `api.listFolders`、`api.createFolder`、`api.listFiles`、`api.registerFile`（`src/api/client.ts`）；`getPrimaryClient()`（`gramjs.ts:1404`）。
- Produces:
  ```ts
  export type ImportProgress = { imported: number; skipped: number; failed: number; scanned: number; current: string };
  export type ImportDeps = {
    resolveChat(input: string): Promise<{ entity: any; title: string; noForwards: boolean }>;
    iterChatMedia(entity: any): AsyncIterable<any>;
    forwardToSaved(entity: any, messageId: number): Promise<any>;
    ensureFolder(name: string): Promise<string>;
    existingFileIds(folderId: string): Promise<Set<string>>;
    register(params: RegisterParams): Promise<void>;
    accountId: number;
  };
  export type RegisterParams = {
    filename: string; filesize: number; mimeType: string; messageId: number;
    fileId: string; accessHash: string; parentId: string; hasThumbnail: boolean;
    telegramUserId: number;
  };
  export async function runImport(
    input: string,
    deps: ImportDeps,
    onProgress: (p: ImportProgress) => void,
    shouldStop: () => boolean,
  ): Promise<ImportProgress>;
  export function liveDeps(): ImportDeps;
  ```

**設計理由:** 所有外部相依（Telegram、後端 API）以 `ImportDeps` 注入，讓 selfcheck 能用假的 deps 在 node 裡跑完整個迴圈，驗證去重與計數 —— 這些正是最容易寫錯又不會噴錯的部分。`liveDeps()` 負責接上真的實作，本身沒有分支邏輯。

- [ ] **Step 1: 寫失敗測試**

建立 `frontend/src/lib/chatImport.selfcheck.ts`：

```ts
/**
 * Self-check for runImport. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/chatImport.selfcheck.ts | node --input-type=module
 *
 * Why this matters: resumability rests entirely on skipping media whose id is
 * already in the drive. If that dedupe is wrong, a re-run silently forwards a
 * second copy of every file in the chat — no error anywhere, just a duplicated
 * folder. These asserts are what "re-running is safe" means.
 */
import { runImport, type ImportDeps } from './chatImport.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

function docMsg(id: number, docId: number) {
  return {
    id,
    date: 1755388800,
    media: {
      className: 'MessageMediaDocument',
      document: {
        id: docId, accessHash: 999, size: 10, mimeType: 'video/mp4',
        attributes: [{ className: 'DocumentAttributeFilename', fileName: `f${docId}.mp4` }],
        thumbs: [],
      },
    },
  };
}

function makeDeps(overrides: Partial<ImportDeps> = {}) {
  const forwarded: number[] = [];
  const registered: any[] = [];
  const deps: ImportDeps = {
    resolveChat: async () => ({ entity: { id: 1 }, title: 'My Channel', noForwards: false }),
    iterChatMedia: () => [docMsg(1, 101), docMsg(2, 102), docMsg(3, 103)],
    forwardToSaved: async (_e, msgId) => {
      forwarded.push(msgId);
      return { ...docMsg(msgId + 1000, msgId + 100), id: msgId + 1000 };
    },
    ensureFolder: async () => 'folder-1',
    existingFileIds: async () => new Set<string>(),
    register: async (p) => { registered.push(p); },
    accountId: 7,
    ...overrides,
  };
  return { deps, forwarded, registered };
}

const never = () => false;
const noop = () => {};

// --- 全新匯入 ---------------------------------------------------------------
{
  const { deps, forwarded, registered } = makeDeps();
  const result = await runImport('@chan', deps, noop, never);
  check('fresh import forwards every media message', forwarded.length === 3);
  check('fresh import registers every forwarded message', registered.length === 3);
  check('imported count matches', result.imported === 3);
  check('nothing skipped on a fresh import', result.skipped === 0);
  check('register uses the forwarded message id, not the source id',
    registered[0].messageId === 1001);
  check('register uses the source media id as file_id',
    registered[0].fileId === '101');
  check('register targets the created folder', registered[0].parentId === 'folder-1');
  check('register attributes the file to the importing account',
    registered[0].telegramUserId === 7);
  check('register carries the derived filename', registered[0].filename === 'f101.mp4');
}

// --- 續傳：已存在的媒體要跳過 --------------------------------------------------
{
  const { deps, forwarded, registered } = makeDeps({
    existingFileIds: async () => new Set(['101', '102']),
  });
  const result = await runImport('@chan', deps, noop, never);
  check('resume skips media already in the drive', result.skipped === 2);
  check('resume forwards only what is missing', forwarded.length === 1 && forwarded[0] === 3);
  check('resume registers only what it forwarded', registered.length === 1);
}

// --- 同一次執行內不重複匯入相同媒體 ---------------------------------------------
{
  const { deps, forwarded } = makeDeps({
    iterChatMedia: () => [docMsg(1, 101), docMsg(2, 101)],
  });
  const result = await runImport('@chan', deps, noop, never);
  check('the same media forwarded twice in one run is deduped',
    forwarded.length === 1 && result.skipped === 1);
}

// --- 中止 -------------------------------------------------------------------
{
  const { deps, forwarded } = makeDeps();
  let calls = 0;
  const result = await runImport('@chan', deps, noop, () => ++calls > 1);
  check('stopping halts the loop early', forwarded.length === 1 && result.imported === 1);
}

// --- 禁止轉發 ---------------------------------------------------------------
{
  const { deps, forwarded } = makeDeps({
    resolveChat: async () => ({ entity: { id: 1 }, title: 'Locked', noForwards: true }),
  });
  let message = '';
  try { await runImport('@chan', deps, noop, never); } catch (e: any) { message = e.message; }
  check('a noforwards chat aborts before forwarding anything',
    forwarded.length === 0 && message.includes('禁止轉發'));
}

// --- 單則失敗不中斷整批 -------------------------------------------------------
{
  const { deps, registered } = makeDeps({
    forwardToSaved: async (_e, msgId) => {
      if (msgId === 2) throw new Error('MESSAGE_ID_INVALID');
      return { ...docMsg(msgId + 1000, msgId + 100), id: msgId + 1000 };
    },
  });
  const result = await runImport('@chan', deps, noop, never);
  check('a failed message is counted and the run continues',
    result.failed === 1 && result.imported === 2 && registered.length === 2);
}

console.log('\nAll chatImport checks passed.');
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd frontend
npx esbuild --bundle --platform=node --format=esm src/lib/chatImport.selfcheck.ts | node --input-type=module
```
Expected: FAIL —— esbuild 報 `Could not resolve "./chatImport.ts"`。

- [ ] **Step 3: 寫最小實作**

建立 `frontend/src/lib/chatImport.ts`：

```ts
/**
 * Import every media message of a chat into the drive.
 *
 * Everything Telegram- or backend-facing arrives through ImportDeps so the
 * loop itself can be exercised under node by chatImport.selfcheck.ts. liveDeps()
 * is the only place that touches the real client and the real API, and it is
 * deliberately branch-free.
 */
import { readMedia, deriveFilename } from './telegramMedia';
import { getPrimaryClient } from './gramjs';
import { api } from '../api/client';
import { loadAccounts } from './accountPool';

export type ImportProgress = {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  current: string;
};

export type RegisterParams = {
  filename: string;
  filesize: number;
  mimeType: string;
  messageId: number;
  fileId: string;
  accessHash: string;
  parentId: string;
  hasThumbnail: boolean;
  telegramUserId: number;
};

export type ImportDeps = {
  resolveChat(input: string): Promise<{ entity: any; title: string; noForwards: boolean }>;
  iterChatMedia(entity: any): AsyncIterable<any> | Iterable<any>;
  forwardToSaved(entity: any, messageId: number): Promise<any>;
  ensureFolder(name: string): Promise<string>;
  existingFileIds(folderId: string): Promise<Set<string>>;
  register(params: RegisterParams): Promise<void>;
  accountId: number;
};

export async function runImport(
  input: string,
  deps: ImportDeps,
  onProgress: (p: ImportProgress) => void,
  shouldStop: () => boolean,
): Promise<ImportProgress> {
  const { entity, title, noForwards } = await deps.resolveChat(input);
  if (noForwards) {
    throw new Error(`「${title}」禁止轉發內容，無法匯入。`);
  }

  const folderId = await deps.ensureFolder(title);
  // The drive's own records are the resume log: any media id already filed
  // under this folder has been imported, in this run or a previous one.
  const seen = await deps.existingFileIds(folderId);

  const progress: ImportProgress = { scanned: 0, imported: 0, skipped: 0, failed: 0, current: title };

  for await (const message of deps.iterChatMedia(entity) as AsyncIterable<any>) {
    if (shouldStop()) break;

    const source = readMedia(message.media);
    if (!source) continue;

    progress.scanned++;
    if (seen.has(source.id)) {
      progress.skipped++;
      onProgress({ ...progress });
      continue;
    }

    const filename = deriveFilename(message);
    progress.current = filename;

    try {
      const forwarded = await deps.forwardToSaved(entity, message.id);
      const stored = readMedia(forwarded.media) ?? source;
      await deps.register({
        filename,
        filesize: stored.size,
        mimeType: stored.mimeType,
        messageId: forwarded.id,
        fileId: stored.id,
        accessHash: String(stored.accessHash),
        parentId: folderId,
        hasThumbnail: stored.previewThumbSize !== null,
        telegramUserId: deps.accountId,
      });
      seen.add(stored.id);
      // Guard the case where forwarding rewrites the media id: without this the
      // source id stays unseen and a re-run would import the message again.
      seen.add(source.id);
      progress.imported++;
    } catch (err) {
      console.error('[ChatImport] failed on message', message.id, err);
      progress.failed++;
    }
    onProgress({ ...progress });
  }

  return progress;
}

export function liveDeps(): ImportDeps {
  const client = getPrimaryClient();
  const accountId = loadAccounts()[0]?.id ?? 0;
  return {
    resolveChat: (input) => client.resolveChat(input),
    iterChatMedia: (entity) => client.iterChatMedia(entity),
    forwardToSaved: (entity, messageId) => client.forwardToSaved(entity, messageId),
    accountId,

    ensureFolder: async (name) => {
      const existing = await api.listFolders(null);
      const match = existing.files.find((f) => f.filename === name);
      if (match) return match.file_id;
      const created = await api.createFolder(name, null);
      return created.file_id;
    },

    existingFileIds: async (folderId) => {
      const ids = new Set<string>();
      const PAGE = 200;
      for (let page = 1; ; page++) {
        const res = await api.listFiles(page, PAGE, folderId);
        for (const f of res.files) ids.add(f.file_id);
        if (res.files.length < PAGE) break;
      }
      return ids;
    },

    register: async (p) => {
      await api.registerFile({
        filename: p.filename,
        filesize: p.filesize,
        mimeType: p.mimeType,
        messageId: p.messageId,
        fileId: p.fileId,
        accessHash: p.accessHash,
        parentId: p.parentId,
        hasThumbnail: p.hasThumbnail,
        // No file_hash: computing SHA-256 would mean downloading every file,
        // throwing away the whole point of forwarding. These files sit out of
        // the hash-dedupe feature by design.
        telegramUserId: p.telegramUserId,
      });
    },
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd frontend
npx esbuild --bundle --platform=node --format=esm src/lib/chatImport.selfcheck.ts | node --input-type=module
```
Expected: 全部 `ok - ...`，最後 `All chatImport checks passed.`

注意：selfcheck 會把 `chatImport.ts` 連同它 import 的 `gramjs.ts`／`api/client.ts` 一起打包，可能在 node 下因瀏覽器 API 而爆掉。若發生，在 esbuild 指令加上 `--external:telegram --external:axios`；仍失敗則把 `liveDeps()` 拆到獨立檔 `chatImportDeps.ts`，讓 `chatImport.ts` 保持零相依。

- [ ] **Step 5: 型別檢查**

```bash
cd frontend
npx tsc --noEmit
```
Expected: 沒有錯誤。若 `loadAccounts` 的回傳形狀不符，用 `grep -n "export function loadAccounts" -A 8 src/lib/accountPool.ts` 確認實際欄位名並修正。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/chatImport.ts frontend/src/lib/chatImport.selfcheck.ts
git commit -m "feat(import): orchestrate forwarding a chat's media into the drive"
```

---

### Task 6: 匯入 UI

**Files:**
- Create: `frontend/src/components/ImportChatDialog.tsx`
- Modify: `frontend/src/components/ChonkyDrive.tsx`

**Interfaces:**
- Consumes: Task 5 的 `runImport`、`liveDeps`、`ImportProgress`。
- Produces:
  ```tsx
  export function ImportChatDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element;
  ```

- [ ] **Step 1: 建立對話框**

建立 `frontend/src/components/ImportChatDialog.tsx`：

```tsx
import { useRef, useState } from 'react';
import { runImport, liveDeps, type ImportProgress } from '../lib/chatImport';

// Import every media message of a chat into root/{chat name}. The whole thing
// runs in this tab — closing it stops the import; re-running resumes, because
// runImport skips media already filed under the folder.
export function ImportChatDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const stopRef = useRef(false);

  const start = async () => {
    const value = input.trim();
    if (!value) { setError('請輸入 chat id、username 或 t.me 連結'); return; }
    setError(null);
    setRunning(true);
    setFinished(false);
    stopRef.current = false;
    try {
      const result = await runImport(value, liveDeps(), setProgress, () => stopRef.current);
      setProgress(result);
      setFinished(true);
      onDone();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}
      onClick={running ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--td-surface)', borderRadius: 8, padding: 24, minWidth: 420, boxShadow: '0 10px 40px var(--td-shadow)' }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--td-text-strong)', marginBottom: 14 }}>
          匯入 chat 媒體
        </div>

        <input
          value={input}
          disabled={running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !running) start(); }}
          placeholder="@channelname、t.me/xxx 或 -1001234567890"
          style={{ width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 6, border: '1px solid var(--td-border)', background: 'var(--td-bg)', color: 'var(--td-text)', boxSizing: 'border-box' }}
        />

        <div style={{ fontSize: 12, color: 'var(--td-text-muted)', marginTop: 8, lineHeight: 1.6 }}>
          會在根目錄建立以 chat 名稱命名的資料夾，由最舊的訊息開始逐則轉發。
          過程中請保持此頁面開啟；中斷後重跑會自動接續。
        </div>

        {progress && (
          <div style={{ fontSize: 13, color: 'var(--td-text)', marginTop: 14, fontVariantNumeric: 'tabular-nums' }}>
            已匯入 {progress.imported}　跳過 {progress.skipped}　失敗 {progress.failed}
            <div style={{ fontSize: 12, color: 'var(--td-text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {finished ? '完成' : progress.current}
            </div>
          </div>
        )}

        {error && <div style={{ fontSize: 13, color: 'var(--td-danger)', marginTop: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          {running ? (
            <button onClick={() => { stopRef.current = true; }} style={btn}>停止</button>
          ) : (
            <>
              <button onClick={onClose} style={btn}>關閉</button>
              <button onClick={start} style={{ ...btn, background: 'var(--td-accent)', color: '#fff', borderColor: 'var(--td-accent)' }}>
                開始匯入
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--td-border)', background: 'var(--td-bg)', color: 'var(--td-text)',
};
```

- [ ] **Step 2: 掛上進入點**

在 `ChonkyDrive.tsx`：
1. 加 import：`import { ImportChatDialog } from './ImportChatDialog';`
2. 加 state：`const [showImportChat, setShowImportChat] = useState(false);`（放在既有的 rename/新資料夾 state 旁邊）
3. 在既有「新增資料夾」按鈕旁加一顆「匯入 chat」按鈕，`onClick={() => setShowImportChat(true)}`，樣式複製鄰近按鈕。
4. 在 `<RenameDialog ...>` 那一區（約 `ChonkyDrive.tsx:2039`）旁加入：
```tsx
        {showImportChat && (
          <ImportChatDialog
            onClose={() => setShowImportChat(false)}
            onDone={() => { void loadFiles(); }}
          />
        )}
```
`loadFiles` 用該元件既有的重新載入函式；用 `grep -n "const loadFiles\|const refresh\|reload" src/components/ChonkyDrive.tsx` 確認實際名稱後替換。

- [ ] **Step 3: 型別檢查與建置**

```bash
cd frontend
npx tsc --noEmit && npm run build
```
Expected: 皆成功。若 `--td-danger` / `--td-accent` 變數不存在，用 `grep -n "\-\-td-" src/theme.css | sort -u` 查出實際變數名替換。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ImportChatDialog.tsx frontend/src/components/ChonkyDrive.tsx
git commit -m "feat(import): add the chat media import dialog"
```

---

### Task 7: 瀏覽器實測

**Files:** 無（驗證任務）

**背景:** `CLAUDE.md` 的開發規則要求每次功能完成必須實際在瀏覽器驗證，不得僅憑程式碼審查宣告完成。記憶中的偏好是用 `http://127.0.0.1:3000` 驗證，不用公開 tunnel URL。

- [ ] **Step 1: 啟動**

```bash
docker compose up -d --build
docker compose logs -f frontend
```
確認 Vite 已就緒後停止 follow。

- [ ] **Step 2: 登入並開啟匯入對話框**

瀏覽器開 `http://127.0.0.1:3000`，登入後點「匯入 chat」。

- [ ] **Step 3: 匯入一個小型測試 chat**

輸入一個自己可存取、內含**照片與影片各至少一則**的 channel/group。按開始，確認：
- 根目錄出現以 chat 名稱命名的資料夾
- 進度數字持續累加
- 完成後資料夾內檔案數與來源媒體數相符

- [ ] **Step 4: 驗證照片路徑（本計畫最主要的風險）**

在該資料夾內確認：
- 照片與影片**都有縮圖**（`downloadThumbnails` 的 photo 分支）
- 點開照片能正常顯示（`downloadFileChunked` 的 `InputPhotoFileLocation`）
- 影片能播放
- 檔名符合 Task 2 的規則（照片為 `photo_YYYYMMDD_HHMMSS_{id}.jpg`）

- [ ] **Step 5: 驗證續傳**

再跑一次同一個 chat，確認「跳過」數等於上一輪的「已匯入」數，且沒有產生重複檔案。

- [ ] **Step 6: 驗證中斷**

匯入較大的 chat，中途按「停止」，確認迴圈停下；再按開始，確認從中斷處接續。

- [ ] **Step 7: 回報**

把每一步的實際觀察結果寫出來。任何一步不符預期就停下來報告，不要宣告完成。

---

## Self-Review

**Spec 覆蓋檢查：**

| Spec 章節 | 對應任務 |
|---|---|
| 為什麼要 forward 到 Saved Messages | Task 4（`forwardToSaved`）、Task 5（編排） |
| 流程 1 解析 chat（含 getDialogs 退路） | Task 4 `resolveChat` |
| 流程 2 `noforwards` 前置檢查 | Task 4 回傳 `noForwards` + Task 5 `runImport` 開頭中止 + selfcheck |
| 流程 3 建立/沿用資料夾 | Task 5 `liveDeps().ensureFolder` |
| 流程 4 去重集合 | Task 5 `existingFileIds` + selfcheck 續傳案例 |
| 流程 5 由舊到新迭代、不用 Telegram filter | Task 4 `iterChatMedia` |
| 流程 6 逐則 forward + 節流 | Task 4 `forwardToSaved`（`messageRateLimiter` + FLOOD 退避） |
| 流程 7 register 欄位對照表 | Task 5 `runImport` + selfcheck 逐欄位斷言 |
| 流程 8 進度與中斷 | Task 5 `onProgress`/`shouldStop` + Task 6 UI |
| 檔名推導表（全部 8 列） | Task 2，每列一條 selfcheck |
| 其他 metadata（filesize/mime/has_thumbnail/file_hash=null） | Task 1（前三項）+ Task 5（`file_hash` 不傳） |
| 照片支援五處 | Task 3 |
| 錯誤處理表 | Task 4（FLOOD）、Task 5（單則失敗跳過、noforwards）+ selfcheck |
| 測試（selfcheck + 瀏覽器實測） | Task 1/2/5 selfcheck、Task 7 |
| 刻意不做：批次 forward | Task 4 的 `ponytail:` 註記 |

無缺口。

**Placeholder 掃描：** 無 TBD/TODO，所有程式碼步驟皆附完整程式碼，所有測試步驟皆附完整測試碼與預期輸出。

**型別一致性：** `MediaRef` 由 Task 1 定義，Task 3/5 使用同一組欄位名（`kind`/`id`/`rawId`/`accessHash`/`fileReference`/`size`/`mimeType`/`fullThumbSize`/`previewThumbSize`）。`ImportDeps` 由 Task 5 定義並由 Task 6 透過 `liveDeps()` 使用，未直接引用其欄位。`resolveChat` 的回傳型別在 Task 4 與 Task 5 的 `ImportDeps` 中一致。
