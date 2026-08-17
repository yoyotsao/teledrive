/**
 * The real ImportDeps: wires runImport (chatImport.ts) up to the actual
 * Telegram client and the actual backend API. Split out of chatImport.ts so
 * that file — and chatImport.selfcheck.ts, which bundles it for node — never
 * has to resolve `telegram` or `axios`, both of which are browser-only.
 *
 * Deliberately branch-free beyond the folder-reuse lookup and the listing
 * pagination below.
 */
import { getPrimaryClient, loadAccounts } from './gramjs';
import { api } from '../api/client';
import type { ImportDeps } from './chatImport';

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
