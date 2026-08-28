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
import { buildFolderIndex, rememberImported, resolveImport, type FolderEntry } from './importNaming';

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
  /** Every row already filed under the import folder — the resume log and the taken-name list. */
  existingFiles(folderId: string): Promise<FolderEntry[]>;
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
  // under this folder has been imported, in this run or a previous one. The
  // index also carries the folder's names and (name, size, mime) identities,
  // and is updated as this run registers files, so a name taken a moment ago
  // counts exactly like one that was already in the drive.
  const index = buildFolderIndex(await deps.existingFiles(folderId));

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

    // Forwarding never puts the bytes in the browser, so an imported file has
    // no file_hash to compare. resolveImport() therefore decides "already got
    // it" from the media id plus the (name, size, mime) triple Telegram
    // reports, and renames whatever survives that test into a free name.
    const decision = resolveImport(index, {
      fileId: source.id,
      filename: deriveFilename(message),
      filesize: source.size,
      mimeType: source.mimeType,
    });
    if (decision.action === 'skip') {
      progress.skipped++;
      onProgress({ ...progress });
      continue;
    }

    const filename = decision.filename;
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
      // Record what was actually written to the drive — the stored media id
      // and the final, possibly renamed filename — so this run's view of the
      // folder matches what a re-run will read back from it.
      rememberImported(index, {
        fileId: stored.id,
        filename,
        filesize: stored.size,
        mimeType: stored.mimeType,
      });
      // Guard the case where forwarding rewrites the media id: without this the
      // source id stays unseen and a re-run would import the message again.
      // Only this run benefits — a re-run rebuilds the index from drive rows,
      // which carry the stored id. There the (name, size, mime) test covers
      // it, except for a file that had to be renamed: its stored name no
      // longer matches the name derived from the source, so it would import
      // once more. Telegram forwards keep the source media id, so this stays
      // hypothetical.
      index.ids.add(source.id);
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
