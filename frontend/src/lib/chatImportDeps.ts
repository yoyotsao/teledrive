/** Production wiring for durable, target-aware chat import. */
import { api, type TelegramOperationRequest } from '../api/client';
import { resolveChannelPeerForAccount, validateChannelForAccount } from './channelStorage';
import type { DurableImportParams, ImportDeps } from './chatImport';
import { runChatImportOperation } from './chatImportOperation';
import { getClientFor, loadAccounts } from './gramjs';
import type { FolderEntry } from './importNaming';
import { RecoveryCursorStore } from './telegramOperationRecovery';

function stableRandomId(value: string): string {
  let hash = 1469598103934665603n;
  for (const char of value) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(63, hash * 1099511628211n);
  }
  return (hash || 1n).toString();
}

function compactIdentity(prefix: string, value: string): string {
  return `${prefix}:${stableRandomId(value)}`;
}

export function liveDeps(actingAccountId?: number): ImportDeps {
  const localAccounts = loadAccounts();
  const accountId = actingAccountId ?? localAccounts[0]?.id ?? 0;
  if (!accountId) throw new Error('請先連結可用的 Telegram 帳號');
  const client = getClientFor(accountId);
  const cursorStore = new RecoveryCursorStore();

  const targetContext = async () => {
    const [target, linked] = await Promise.all([api.getStorageTarget(), api.listAccounts()]);
    if (!linked.some((account) => account.telegram_user_id === accountId)) {
      throw new Error(`Telegram 帳號 ${accountId} 不再屬於此雲端硬碟`);
    }
    if (target.storage_mode === 'saved_messages') {
      return {
        target,
        peer: 'me' as any,
        targetPeerKey: `me:${accountId}`,
      };
    }
    const verification = await validateChannelForAccount(client as any, target.channel_id!);
    if (!verification.can_write) throw new Error('UPLOAD_UNAVAILABLE: 選取的帳號目前無法寫入共用儲存頻道');
    const peer = await resolveChannelPeerForAccount(client as any, target.channel_id!);
    if (!peer) throw new Error('UPLOAD_UNAVAILABLE: 無法解析共用儲存頻道');
    return { target, peer, targetPeerKey: String(target.channel_id) };
  };

  return {
    resolveChat: (input) => client.resolveChat(input),
    iterChatMedia: (entity) => client.iterChatMedia(entity),
    forwardToSaved: (entity, messageId) => client.forwardToSaved(entity, messageId),
    accountId,

    forwardAndRegister: async (params: DurableImportParams) => {
      const context = await targetContext();
      const entityId = String((params.entity as any)?.id ?? (params.entity as any)?.channelId ?? 'chat');
      const identity = `${accountId}:${entityId}:${params.sourceMessageId}:${context.target.version}`;
      const operationId = compactIdentity('chat-import', identity);
      const logicalFileId = compactIdentity('chat-file', identity);
      const randomId = stableRandomId(`random:${identity}`);
      const request: TelegramOperationRequest = {
        operation_id: operationId,
        kind: 'chat_import',
        logical_file_id: logicalFileId,
        uploader_id: accountId,
        target_kind: context.target.storage_mode,
        target_channel_id: context.target.storage_mode === 'channel' ? context.target.channel_id : null,
        target_peer_key: context.targetPeerKey,
        created_target_version: context.target.version,
        created_accounts_version: context.target.accounts_version,
        random_id: randomId,
        rpc_kind: 'messages.forwardMessages',
        request_metadata: {
          filename: params.filename,
          filesize: params.filesize,
          mime_type: params.mimeType,
          parent_id: params.parentId,
          has_thumbnail: params.hasThumbnail,
          original_name: params.filename,
          source: {
            source_media_id: params.sourceMediaId,
            source_message_id: params.sourceMessageId,
            source_peer_key: entityId,
          },
        },
      };

      return runChatImportOperation({
        request,
        mimeType: params.mimeType,
        hasThumbnail: params.hasThumbnail,
      }, {
        createOperation: (body) => api.createTelegramOperation(body),
        markSending: (operation) => api.patchTelegramOperation(operation.operation_id, {
          expected_operation_version: operation.version,
          state: 'sending',
        }),
        saveCursor: (value) => cursorStore.save({
          ownerId: accountId,
          operationId: value.operationId,
          randomId: value.randomId,
          uploaderId: value.uploaderId,
          targetPeerKey: value.targetPeerKey,
          phase: 'intent_persisted',
        }),
        forward: async (persistedRandomId) => {
          const sent = await client.forwardToTarget(params.entity, params.sourceMessageId, context.peer, persistedRandomId);
          return {
            messageId: sent.messageId,
            mediaKind: sent.mediaKind,
            mediaId: sent.mediaId,
            size: sent.size,
            mimeType: params.mimeType,
            photoVariant: sent.photoVariant,
            hasThumbnail: params.hasThumbnail,
          };
        },
        persistResult: (operation, media) => api.persistReconciledOperationResult({
          operationId: operation.operation_id,
          expectedOperationVersion: operation.version,
          mapping: {
            uploader_id: operation.uploader_id,
            random_id: operation.random_id,
            target_peer_key: operation.target_peer_key,
            destination_message_id: media.messageId,
          },
          mediaIdentity: {
            destination_media_kind: media.mediaKind,
            destination_media_id: media.mediaId,
            destination_size: media.size,
            ...(media.photoVariant ? { destination_photo_variant: media.photoVariant } : {}),
          },
        }),
        registerOperation: (id) => api.registerTelegramOperation(id),
        clearCursor: () => cursorStore.clear(),
      });
    },

    ensureFolder: async (name) => {
      const existing = await api.listFolders(null);
      const match = existing.files.find((f) => f.filename === name);
      if (match) return match.file_id;
      const created = await api.createFolder(name, null);
      return created.file_id;
    },

    existingFiles: async (folderId) => {
      const entries: FolderEntry[] = [];
      const PAGE = 200;
      for (let page = 1; ; page++) {
        const res = await api.listFiles(page, PAGE, folderId);
        for (const f of res.files) {
          entries.push({ fileId: f.file_id, filename: f.filename, filesize: f.filesize, mimeType: f.mime_type });
        }
        if (res.files.length < PAGE) break;
      }
      return entries;
    },

    // Kept only for the pure loop's legacy fallback. Production always uses
    // forwardAndRegister above, so shared-channel imports never reach this.
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
        telegramUserId: p.telegramUserId,
      });
    },
  };
}
