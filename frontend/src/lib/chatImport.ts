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

  // Aborts a run stuck on a global cause (e.g. PEER_FLOOD, which isFloodError
  // matches but which does not clear in seconds and carries no wait time) after
  // this many failures IN A ROW — a success resets it to 0. Without this, a
  // global failure just burns through the whole chat one doomed forward at a
  // time while the dialog reports "steady progress" importing nothing.
  const MAX_CONSECUTIVE_FAILURES = 5;
  let consecutiveFailures = 0;
  let lastFailure: unknown = null;

  for await (const message of deps.iterChatMedia(entity) as AsyncIterable<any>) {
    if (shouldStop()) break;

    // Tick scan progress for EVERY message, not just media ones: iterChatMedia
    // yields the whole chat now (see gramjs.ts), so a long non-media stretch
    // must still move `scanned` and still be interruptible via shouldStop().
    progress.scanned++;

    const source = readMedia(message.media);
    if (!source) {
      onProgress({ ...progress });
      continue;
    }

    if (seen.has(source.id)) {
      progress.skipped++;
      onProgress({ ...progress });
      continue;
    }

    const filename = deriveFilename(message);
    progress.current = filename;

    try {
      const forwarded = await deps.forwardToSaved(entity, message.id);
      const stored = readMedia(forwarded.media);
      if (!stored) {
        // iterChatMedia already proved the SOURCE readable, so an unreadable
        // forward is anomalous, not expected — treat it as a failure rather
        // than silently registering the source's access_hash against a
        // message id it doesn't belong to (a record that may not download).
        throw new Error(`Forwarded message ${forwarded.id} has no readable media (source message ${message.id})`);
      }
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
      consecutiveFailures = 0;
    } catch (err) {
      console.error('[ChatImport] failed on message', message.id, err);
      progress.failed++;
      consecutiveFailures++;
      lastFailure = err;
    }
    onProgress({ ...progress });

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const reason = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
      throw new Error(`連續 ${MAX_CONSECUTIVE_FAILURES} 則訊息匯入失敗，已中止匯入。最後錯誤：${reason}`);
    }
  }

  return progress;
}
