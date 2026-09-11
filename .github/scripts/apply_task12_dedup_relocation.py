from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:180]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


path = 'frontend/src/components/ChonkyDrive.tsx'
replace_once(
    path,
    "import { durableUploadFile } from '../lib/durableUploadRuntime';",
    "import { durableUploadFile } from '../lib/durableUploadRuntime';\nimport { ensureDedupPartsInCurrentTarget } from '../lib/dedupRelocationRuntime';",
)

replace_once(
    path,
    '''        if (asExisting.length > 0) {
          onProgress?.(100);
          await registerDuplicateParts(file, fileHash, asExisting, currentFolderId);
          return {
            // file_id is unused here — alreadyRegistered=true tells the caller to
            // skip registerUploadedParts, which is the only consumer that needs it.
            parts: asExisting.map((p) => ({ message_id: p.telegram_message_id, file_id: '', access_hash: p.access_hash ?? undefined, size: p.filesize, has_thumbnail: p.has_thumbnail ?? false, account_id: p.telegram_user_id ?? 0 })),
            fileHash,
            alreadyRegistered: true,
          };
        }''',
    '''        if (asExisting.length > 0) {
          onProgress?.(100);
          const targetParts = await ensureDedupPartsInCurrentTarget(asExisting);
          await registerDuplicateParts(file, fileHash, targetParts, currentFolderId);
          return {
            // file_id is unused here — alreadyRegistered=true tells the caller to
            // skip registerUploadedParts, which is the only consumer that needs it.
            parts: targetParts.map((p) => ({ message_id: p.telegram_message_id, file_id: p.telegram_media_id ?? '', access_hash: p.access_hash ?? undefined, size: p.filesize, has_thumbnail: p.has_thumbnail ?? false, account_id: p.telegram_user_id ?? 0 })),
            fileHash,
            alreadyRegistered: true,
          };
        }''',
)

replace_once(
    path,
    '''          uploadPromises.push(
            registerDuplicateParts(file, fileHash, reusable, destination.resolvedFolderId)
              .then(done).catch((err) => failed('register', err)),
          );''',
    '''          uploadPromises.push(
            ensureDedupPartsInCurrentTarget(reusable)
              .then((targetParts) => registerDuplicateParts(file, fileHash, targetParts, destination.resolvedFolderId))
              .then(done).catch((err) => failed('register', err)),
          );''',
)

# Channel uploads must never enter the legacy album pipeline, which prepares
# media against @me before a target/writer is frozen. Saved Messages keeps the
# legacy optimization while shared-channel files use the durable single/split
# runtime until the album pipeline itself is fully journal-aware.
replace_once(
    path,
    '''    const SINGLE_PATH_SIZE_LIMIT = 10 * 1024 * 1024;
    const albumPipeline = createAlbumPipeline();''',
    '''    const SINGLE_PATH_SIZE_LIMIT = 10 * 1024 * 1024;
    const batchStorageTarget = await api.getStorageTarget();
    const albumPipeline = createAlbumPipeline();''',
)
replace_once(
    path,
    '''      if (isAlbumEligibleMedia(file) && file.size <= SINGLE_PATH_SIZE_LIMIT) {''',
    '''      if (batchStorageTarget.storage_mode === 'saved_messages' && isAlbumEligibleMedia(file) && file.size <= SINGLE_PATH_SIZE_LIMIT) {''',
)
