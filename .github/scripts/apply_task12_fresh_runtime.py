from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:160]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'frontend/src/components/ChonkyDrive.tsx',
    "import { uploadFileSpread, type SplitUploadProgress } from '../lib/splitUpload';",
    "import { uploadFileSpread, type SplitUploadProgress } from '../lib/splitUpload';\nimport { durableUploadFile } from '../lib/durableUploadRuntime';",
)
replace_once(
    'frontend/src/components/ChonkyDrive.tsx',
    '''    // Unpinned: segments of a >512MB file are dispatched to different accounts
    // and upload concurrently. Each takes a slot on the account it lands on.
    const uploadResult = await uploadFileSpread(file, onProgress, thumbBlob);
    console.log('[Upload] Upload completed, parts:', uploadResult.parts.length);

    return {
      parts: uploadResult.parts.map((p, i) => ({ ...p, has_thumbnail: i === 0 && uploadResult.hasThumbnail })),
      fileHash,
      alreadyRegistered: false,
    };''',
    '''    // Durable shared-storage uploads freeze the target/writer, persist every
    // operation + random id before Telegram can create a message, persist the
    // authoritative result, and only then commit metadata registration.
    const uploadResult = await durableUploadFile(file, {
      parentId: currentFolderId,
      fileHash,
      thumb: thumbBlob,
      onProgress,
    });
    console.log('[Upload] Durable upload completed, parts:', uploadResult.parts.length);

    return {
      parts: uploadResult.parts.map((p, i) => ({ ...p, has_thumbnail: i === 0 && uploadResult.hasThumbnail })),
      fileHash,
      alreadyRegistered: true,
    };''',
)

replace_once(
    'frontend/src/lib/uploadOperations.ts',
    '''    logical_file_id: input.logicalFileId,''',
    '''    logical_file_id: totalParts > 1
      ? `${input.logicalFileId}:part:${part.partIndex}`
      : input.logicalFileId,''',
)
