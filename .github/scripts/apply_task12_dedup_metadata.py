from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'frontend/src/api/client.ts',
    '''    /** Which linked account stores this message; omit for the primary. */\n    telegramUserId?: number;\n  }): Promise<FileInfo> => {''',
    '''    /** Which linked account stores this message; omit for the primary. */\n    telegramUserId?: number;\n    telegramChatId?: string | null;\n    telegramMediaKind?: 'document' | 'photo' | null;\n    telegramMediaId?: string | null;\n    telegramMediaSize?: number | null;\n    telegramPhotoVariant?: string | null;\n    locationVersion?: number;\n  }): Promise<FileInfo> => {''',
)
replace_once(
    'frontend/src/api/client.ts',
    '''      file_hash: params.fileHash,\n      telegram_user_id: params.telegramUserId,\n    });''',
    '''      file_hash: params.fileHash,\n      telegram_user_id: params.telegramUserId,\n      telegram_chat_id: params.telegramChatId,\n      telegram_media_kind: params.telegramMediaKind,\n      telegram_media_id: params.telegramMediaId,\n      telegram_media_size: params.telegramMediaSize,\n      telegram_photo_variant: params.telegramPhotoVariant,\n      location_version: params.locationVersion ?? 0,\n    });''',
)

replace_once(
    'frontend/src/lib/uploadPlanner.ts',
    '''export interface RegisterableExistingPart {\n  filesize: number;''',
    '''export interface RegisterableExistingPart {\n  file_id?: string;\n  filesize: number;''',
)
replace_once(
    'frontend/src/lib/uploadPlanner.ts',
    '''  telegram_user_id?: number;\n}''',
    '''  telegram_user_id?: number | null;\n  telegram_chat_id?: string | null;\n  telegram_media_kind?: 'document' | 'photo' | null;\n  telegram_media_id?: string | null;\n  telegram_media_size?: number | null;\n  telegram_photo_variant?: string | null;\n  location_version?: number;\n  split_group_id?: string | null;\n  is_split_file?: boolean;\n}''',
)
replace_once(
    'frontend/src/lib/uploadPlanner.ts',
    '''  const toPart = (f: FileInfo, index: number): RegisterableExistingPart => ({\n    filesize: f.filesize,''',
    '''  const toPart = (f: FileInfo, index: number): RegisterableExistingPart => ({\n    file_id: f.file_id,\n    filesize: f.filesize,''',
)
replace_once(
    'frontend/src/lib/uploadPlanner.ts',
    '''    has_thumbnail: f.has_thumbnail,\n    telegram_user_id: f.telegram_user_id,\n  });''',
    '''    has_thumbnail: f.has_thumbnail,\n    telegram_user_id: f.telegram_user_id ?? undefined,\n    telegram_chat_id: f.telegram_chat_id,\n    telegram_media_kind: f.telegram_media_kind,\n    telegram_media_id: f.telegram_media_id,\n    telegram_media_size: f.telegram_media_size,\n    telegram_photo_variant: f.telegram_photo_variant,\n    location_version: f.location_version ?? 0,\n    split_group_id: f.split_group_id,\n    is_split_file: f.is_split_file,\n  });''',
)
replace_once(
    'frontend/src/lib/uploadPlanner.ts',
    '''      telegramUserId: part.telegram_user_id,\n    })''',
    '''      telegramUserId: part.telegram_user_id ?? undefined,\n      telegramChatId: part.telegram_chat_id,\n      telegramMediaKind: part.telegram_media_kind,\n      telegramMediaId: part.telegram_media_id,\n      telegramMediaSize: part.telegram_media_size,\n      telegramPhotoVariant: part.telegram_photo_variant,\n      locationVersion: part.location_version ?? 0,\n    })''',
)
