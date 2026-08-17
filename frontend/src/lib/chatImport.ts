/**
 * Import every media message of a chat into the drive.
 *
 * Everything Telegram- or backend-facing arrives through ImportDeps so the
 * loop itself can be exercised under node by chatImport.selfcheck.ts. This
 * file therefore imports nothing browser-only — liveDeps(), which wires up
 * the real client and the real API, lives in chatImportDeps.ts instead, so
 * the selfcheck's node bundle never has to resolve `telegram` or `axios`.
 */
import { readMedia, deriveFilename } from './telegramMedia';

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
