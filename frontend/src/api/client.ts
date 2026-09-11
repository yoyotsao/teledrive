import axios from 'axios';
import { FileListResponse, FileInfo } from '../types';
import { loadJwt, saveJwt } from '../lib/gramjs';
import {
  RETIRE_PENDING_UPLOAD_STATISTIC,
  type UploadReport,
  type UploadReportSendResult,
} from '../lib/uploadStatistics';

export interface UploadStatisticsResponse {
  today: string;
  timezone: string;
  first_day: string | null;
  days: { day: string; bytes: number }[];
  accounts: { telegram_user_id: number; label: string | null; bytes: number }[];
}

/**
 * The server makes this one response after a Telegram account has already
 * been unlinked. All other failures remain retryable browser-side.
 */
export function classifyUploadStatisticsFailure(error: unknown): typeof RETIRE_PENDING_UPLOAD_STATISTIC | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  return error.response?.status === 403
    && error.response.data?.detail === 'Account is not linked to this drive'
    ? RETIRE_PENDING_UPLOAD_STATISTIC
    : undefined;
}

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000, // metadata requests only; file bytes never use this client
});

type RetryableRequest = NonNullable<Parameters<typeof client.request>[0]> & {
  _teledriveAuthRetried?: boolean;
};

let refreshPromise: Promise<string> | null = null;

/**
 * Refresh all concurrent metadata requests through one shared exchange. A
 * batch upload can have dozens of check/register calls in flight when the JWT
 * expires; without the single-flight promise they would all race to refresh.
 */
async function refreshAccessToken(staleToken: string): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = axios.post<{ token: string }>(
      '/api/v1/auth/refresh',
      undefined,
      { headers: { Authorization: `Bearer ${staleToken}` }, timeout: 15000 },
    ).then(async (response) => {
      await saveJwt(response.data.token);
      return response.data.token;
    }).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}
client.interceptors.request.use((config) => {
  const token = loadJwt();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const request = error?.config as RetryableRequest | undefined;
    const currentToken = loadJwt();
    if (error?.response?.status !== 401 || !request || request._teledriveAuthRetried || !currentToken) {
      throw error;
    }

    request._teledriveAuthRetried = true;
    try {
      // A slower request may return its 401 after another request has already
      // refreshed the credential. In that case retry with the current token;
      // refreshing again would turn one expiry into a refresh storm.
      const sentAuthorization = request.headers?.Authorization ?? request.headers?.authorization;
      const sentToken = typeof sentAuthorization === 'string' && sentAuthorization.startsWith('Bearer ')
        ? sentAuthorization.slice('Bearer '.length)
        : null;
      const token = sentToken && sentToken !== currentToken
        ? currentToken
        : await refreshAccessToken(currentToken);
      request.headers = request.headers ?? {};
      request.headers.Authorization = `Bearer ${token}`;
      return client.request(request);
    } catch (refreshError) {
      window.dispatchEvent(new CustomEvent('teledrive:auth-expired'));
      throw refreshError;
    }
  },
);

export interface LoginResponse {
  token: string;
  user_id: number;
  username?: string;
  first_name?: string;
}

// One automatic retry for timeouts — the initial request can occasionally lose
// the race against server/proxy warm-up right after a reload.
async function withTimeoutRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const isTimeout = err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '');
    if (!isTimeout) throw err;
    try {
      return await fn();
    } catch {
      throw new Error('載入逾時，請稍後再試');
    }
  }
}

export interface LinkedAccount {
  telegram_user_id: number;
  label: string | null;
  is_primary: number;
  file_count: number;
}

export interface ChallengeResponse {
  nonce: string;
  bot_username: string;
  expires_in: number;
}

/** Persisted channel selection plus enable-time audit; never runtime authority. */
export interface StorageTargetResponse {
  storage_mode: 'saved_messages' | 'channel';
  channel_id: string | null;
  channel_title: string | null;
  version: number;
  accounts_version: number;
  verifications: StorageTargetVerification[];
}

export interface StorageTargetVerification {
  telegram_user_id: number;
  channel_id: string;
  channel_title: string | null;
  can_read: boolean;
  can_write: boolean;
  status: 'verified';
  checked_at: string;
  accounts_version: number;
}

export interface StorageTargetPutRequest {
  storage_mode: 'saved_messages' | 'channel';
  channel_id?: string;
  channel_title?: string;
  expected_version: number;
  expected_accounts_version: number;
  verifications: StorageTargetVerificationRequest[];
}

export interface StorageMigrationEvidence {
  telegram_user_id: number;
  result_version: number;
  target_channel_id: string;
  destination_message_id: number;
  media_kind: 'document' | 'photo';
  media_id: string;
  size_bytes: number;
  photo_variant?: string | null;
  read_probe_ok: boolean;
  checked_at: string;
  source_read_probe_ok?: boolean;
  source_checked_at?: string | null;
}

export interface StorageMigrationItem {
  migration_id: string;
  item_id: string;
  file_id: string;
  group_id: string;
  part_index?: number | null;
  state: string;
  version: number;
  source_location: Record<string, unknown>;
  expected_location_version: number;
  operation_id?: string | null;
  operation_result_version?: number | null;
  applied_location_version?: number | null;
  evidence: StorageMigrationEvidence[];
}

export interface StorageMigrationJob {
  migration_id: string;
  state: string;
  version: number;
  dry_run: boolean;
  target_channel_id: string;
  target_version: number;
  accounts_version: number;
  target_snapshot: Record<string, unknown>;
  items: StorageMigrationItem[];
}

/** Durable, metadata-only send intent. Telegram bytes and credentials stay in GramJS. */
export interface TelegramOperationRequest {
  operation_id: string;
  kind: 'upload' | 'chat_import' | 'migration';
  logical_file_id: string;
  group_id?: string | null;
  part_index?: number | null;
  uploader_id: number;
  target_kind: 'saved_messages' | 'channel' | '@me';
  target_channel_id?: string | null;
  target_peer_key: string;
  created_target_version: number;
  created_accounts_version: number;
  random_id: string;
  rpc_kind: string;
  request_metadata: Record<string, unknown>;
}

export interface TelegramOperation extends TelegramOperationRequest {
  state: string;
  version: number;
  result_version?: number | null;
  registered_file_id?: string | null;
  destination_message_id?: number | null;
  destination_media_kind?: string | null;
  destination_media_id?: string | null;
  destination_size?: number | null;
  destination_access_hash?: string | null;
}

export interface TelegramOperationPatch {
  expected_operation_version: number;
  state?: 'sending' | 'recovering' | 'retryable' | 'uncertain' | 'tombstoned';
  retry_at?: string;
  error_code?: string;
  tombstone_reason?: string;
  mapping?: Record<string, unknown>;
  media_identity?: Record<string, unknown>;
}

export interface FileLocationSwitchBinding {
  owner_id: number;
  file_id: string;
  operation_id: string;
  result_version: number;
  location_version: number;
}

export interface TelegramOperationRegistrationBinding {
  operation_id: string;
  owner_id: number;
  file_id: string;
}

/** Browser-provided enable-time audit submitted with a storage-target save. */
export interface StorageTargetVerificationRequest {
  telegram_user_id: number;
  channel_title?: string | null;
  can_read: boolean;
  can_write: boolean;
  status: 'verified';
  checked_at: string;
}

export const api = {
  reportUploadStatistics: async (report: UploadReport): Promise<UploadReportSendResult> => {
    try {
      await client.post('/statistics/uploads', report);
    } catch (error) {
      const result = classifyUploadStatisticsFailure(error);
      if (result) return result;
      throw error;
    }
  },

  getUploadStatistics: async (): Promise<UploadStatisticsResponse> => {
    const response = await client.get<UploadStatisticsResponse>('/statistics/uploads');
    return response.data;
  },
  requestChallenge: async (): Promise<ChallengeResponse> => {
    const response = await client.post<ChallengeResponse>('/auth/challenge');
    return response.data;
  },

  /** Returns null while the backend hasn't seen the nonce arrive at the bot yet. */
  verifyChallenge: async (nonce: string): Promise<LoginResponse | null> => {
    const response = await client.post<LoginResponse>('/auth/verify', { nonce });
    return response.status === 202 ? null : response.data;
  },

  listAccounts: async (): Promise<LinkedAccount[]> => {
    const response = await client.get<{ accounts: LinkedAccount[] }>('/accounts');
    return response.data.accounts;
  },

  requestAccountChallenge: async (): Promise<ChallengeResponse> => {
    const response = await client.post<ChallengeResponse>('/accounts/challenge');
    return response.data;
  },

  /** Returns null while the backend hasn't seen the nonce arrive at the bot yet. */
  verifyAccount: async (nonce: string): Promise<LinkedAccount | null> => {
    const response = await client.post<LinkedAccount>('/accounts/verify', { nonce });
    return response.status === 202 ? null : response.data;
  },

  unlinkAccount: async (telegramUserId: number): Promise<void> => {
    await client.delete(`/accounts/${telegramUserId}`);
  },

  getStorageTarget: async (): Promise<StorageTargetResponse> => {
    const response = await client.get<StorageTargetResponse>('/storage-target');
    return response.data;
  },

  putStorageTarget: async (request: StorageTargetPutRequest): Promise<StorageTargetResponse> => {
    const response = await client.put<StorageTargetResponse>('/storage-target', request);
    return response.data;
  },

  createMigrationManifest: async (params: {
    expectedTargetVersion: number;
    expectedAccountsVersion: number;
    dryRun?: boolean;
  }): Promise<StorageMigrationJob> => {
    const response = await client.post<StorageMigrationJob>('/storage-migrations', {
      expected_target_version: params.expectedTargetVersion,
      expected_accounts_version: params.expectedAccountsVersion,
      dry_run: params.dryRun ?? false,
    });
    return response.data;
  },

  listMigrationJobs: async (): Promise<StorageMigrationJob[]> => {
    const response = await client.get<{ migrations: StorageMigrationJob[] }>('/storage-migrations');
    return response.data.migrations;
  },

  getMigrationJob: async (migrationId: string): Promise<StorageMigrationJob> => {
    const response = await client.get<StorageMigrationJob>(`/storage-migrations/${migrationId}`);
    return response.data;
  },

  claimMigrationItem: async (params: {
    migrationId: string;
    itemId: string;
    expectedVersion: number;
    leaseOwner: string;
    leaseSeconds: number;
    operationId?: string;
    state?: string;
    error?: string;
  }): Promise<StorageMigrationItem> => {
    const response = await client.patch<StorageMigrationItem>(
      `/storage-migrations/${params.migrationId}/items/${params.itemId}`,
      {
        expected_version: params.expectedVersion,
        lease_owner: params.leaseOwner,
        lease_seconds: params.leaseSeconds,
        operation_id: params.operationId,
        state: params.state,
        error: params.error,
      },
    );
    return response.data;
  },

  reconcileMigrationItem: async (params: {
    migrationId: string;
    itemId: string;
    expectedItemVersion: number;
    operationResultVersion: number;
  }): Promise<StorageMigrationItem> => {
    const response = await client.post<StorageMigrationItem>(
      `/storage-migrations/${params.migrationId}/items/${params.itemId}/reconcile`,
      {
        expected_item_version: params.expectedItemVersion,
        operation_result_version: params.operationResultVersion,
      },
    );
    return response.data;
  },

  putMigrationEvidence: async (params: {
    migrationId: string;
    itemId: string;
    telegramUserId: number;
    evidence: Omit<StorageMigrationEvidence, 'telegram_user_id' | 'source_checked_at'> & { expected_item_version: number };
  }): Promise<StorageMigrationItem> => {
    const response = await client.put<StorageMigrationItem>(
      `/storage-migrations/${params.migrationId}/items/${params.itemId}/verifications/${params.telegramUserId}`,
      params.evidence,
    );
    return response.data;
  },

  commitMigrationGroup: async (params: {
    migrationId: string;
    groupId: string;
    expectedJobVersion: number;
    expectedItemVersions: Record<string, number>;
  }): Promise<StorageMigrationJob> => {
    const response = await client.post<StorageMigrationJob>(
      `/storage-migrations/${params.migrationId}/groups/${params.groupId}/commit`,
      {
        expected_job_version: params.expectedJobVersion,
        expected_item_versions: params.expectedItemVersions,
      },
    );
    return response.data;
  },

  rollbackMigrationGroup: async (params: {
    migrationId: string;
    groupId: string;
    expectedLocationVersions: Record<string, number>;
  }): Promise<StorageMigrationJob> => {
    const response = await client.post<StorageMigrationJob>(
      `/storage-migrations/${params.migrationId}/groups/${params.groupId}/rollback`,
      { expected_location_versions: params.expectedLocationVersions },
    );
    return response.data;
  },

  createTelegramOperation: async (request: TelegramOperationRequest): Promise<TelegramOperation> => {
    const response = await client.post<TelegramOperation>('/telegram-operations', request);
    return response.data;
  },

  getTelegramOperation: async (operationId: string): Promise<TelegramOperation> => {
    const response = await client.get<TelegramOperation>(`/telegram-operations/${operationId}`);
    return response.data;
  },

  listTelegramOperations: async (includeTerminal = false): Promise<TelegramOperation[]> => {
    const response = await client.get<{ operations: TelegramOperation[] }>('/telegram-operations', {
      params: includeTerminal ? { include_terminal: true } : undefined,
    });
    return response.data.operations;
  },

  patchTelegramOperation: async (operationId: string, request: TelegramOperationPatch): Promise<TelegramOperation> => {
    const response = await client.patch<TelegramOperation>(`/telegram-operations/${operationId}`, request);
    return response.data;
  },

  persistReconciledOperationResult: async (params: {
    operationId: string;
    expectedOperationVersion: number;
    mapping: Record<string, unknown>;
    mediaIdentity: Record<string, unknown>;
  }): Promise<TelegramOperation> => {
    const response = await client.post<TelegramOperation>(
      `/telegram-operations/${params.operationId}/reconcile-result`,
      {
        expected_operation_version: params.expectedOperationVersion,
        mapping: params.mapping,
        media_identity: params.mediaIdentity,
      },
    );
    return response.data;
  },

  registerTelegramOperation: async (operationId: string): Promise<TelegramOperationRegistrationBinding> => {
    const response = await client.post<TelegramOperationRegistrationBinding>(
      `/telegram-operations/${operationId}/register`,
    );
    return response.data;
  },

  registerTelegramOperationGroup: async (groupId: string): Promise<TelegramOperationRegistrationBinding[]> => {
    const response = await client.post<{ bindings: TelegramOperationRegistrationBinding[] }>(
      `/telegram-operation-groups/${groupId}/register`,
    );
    return response.data.bindings;
  },

  switchExistingFileLocation: async (params: {
    fileId: string;
    expectedLocationVersion: number;
    operationId: string;
    resultVersion: number;
  }): Promise<FileLocationSwitchBinding> => {
    const response = await client.post<FileLocationSwitchBinding>(`/file-locations/${params.fileId}/switch`, {
      expected_location_version: params.expectedLocationVersion,
      operation_id: params.operationId,
      result_version: params.resultVersion,
    });
    return response.data;
  },

  switchExistingFileLocationGroup: async (parts: Array<{
    fileId: string;
    expectedLocationVersion: number;
    operationId: string;
    resultVersion: number;
  }>): Promise<FileLocationSwitchBinding[]> => {
    const response = await client.post<{ bindings: FileLocationSwitchBinding[] }>('/file-location-groups/switch', {
      parts: parts.map((part) => ({
        file_id: part.fileId,
        expected_location_version: part.expectedLocationVersion,
        operation_id: part.operationId,
        result_version: part.resultVersion,
      })),
    });
    return response.data.bindings;
  },
  listFiles: async (
    page: number = 1,
    pageSize: number = 50,
    parentId?: string,
    opts?: { sortBy?: string; sortOrder?: string; search?: string; trashed?: boolean },
  ): Promise<FileListResponse> =>
    withTimeoutRetry(async () => {
      const response = await client.get<FileListResponse>('/files', {
        params: {
          page,
          page_size: pageSize,
          parent_id: parentId,
          sort_by: opts?.sortBy,
          sort_order: opts?.sortOrder,
          search: opts?.search || undefined,
          trashed: opts?.trashed || undefined,
        },
        timeout: 15000,
      });
      return response.data;
    }),

  listFolders: async (
    parentId: string | null = null,
    opts?: { sortBy?: string; sortOrder?: string },
  ): Promise<FileListResponse> =>
    withTimeoutRetry(async () => {
      const response = await client.get<FileListResponse>('/folders', {
        params: { parent_id: parentId, sort_by: opts?.sortBy, sort_order: opts?.sortOrder },
        timeout: 15000,
      });
      return response.data;
    }),

  createFolder: async (name: string, parentId: string | null = null): Promise<FileInfo> => {
    const response = await client.post<FileInfo>('/folders', {
      name,
      parent_id: parentId,
    });
    return response.data;
  },

  deleteFolder: async (folderId: string): Promise<void> => {
    await client.delete(`/folders/${folderId}`);
  },

  getFile: async (fileId: string): Promise<FileInfo> => {
    const response = await client.get<FileInfo>(`/files/${fileId}`);
    return response.data;
  },

  getDownloadInfo: async (fileId: string): Promise<FileInfo> => {
    const response = await client.get<FileInfo>(`/files/${fileId}/download`);
    return response.data;
  },

  moveFile: async (fileId: string, newParentId: string | null): Promise<FileInfo> => {
    const response = await client.patch<FileInfo>(`/files/${fileId}`, {
      parent_id: newParentId,
    });
    return response.data;
  },

  registerFile: async (params: {
    filename: string;
    filesize: number;
    mimeType?: string;
    messageId: number;
    fileId: string;
    accessHash?: string;
    parentId?: string;
    hasThumbnail?: boolean;
    isSplitFile?: boolean;
    splitGroupId?: string;
    partIndex?: number;
    totalParts?: number;
    originalName?: string;
    fileHash?: string;
    /** Which linked account stores this message; omit for the primary. */
    telegramUserId?: number;
    telegramChatId?: string | null;
    telegramMediaKind?: 'document' | 'photo' | null;
    telegramMediaId?: string | null;
    telegramMediaSize?: number | null;
    telegramPhotoVariant?: string | null;
    locationVersion?: number;
  }): Promise<FileInfo> => {
    const response = await client.post<FileInfo>('/files/register', {
      filename: params.filename,
      filesize: params.filesize,
      mime_type: params.mimeType,
      message_id: params.messageId,
      file_id: params.fileId,
      access_hash: params.accessHash,
      parent_id: params.parentId,
      has_thumbnail: params.hasThumbnail ?? false,
      is_split_file: params.isSplitFile ?? false,
      split_group_id: params.splitGroupId,
      part_index: params.partIndex,
      total_parts: params.totalParts,
      original_name: params.originalName,
      file_hash: params.fileHash,
      telegram_user_id: params.telegramUserId,
      telegram_chat_id: params.telegramChatId,
      telegram_media_kind: params.telegramMediaKind,
      telegram_media_id: params.telegramMediaId,
      telegram_media_size: params.telegramMediaSize,
      telegram_photo_variant: params.telegramPhotoVariant,
      location_version: params.locationVersion ?? 0,
    });
    return response.data;
  },

  deleteFile: async (fileId: string): Promise<void> => {
    await client.delete(`/files/${fileId}`);
  },

  renameFile: async (fileId: string, filename: string): Promise<FileInfo> => {
    const response = await client.patch<FileInfo>(`/files/${fileId}`, { filename });
    return response.data;
  },

  restoreFile: async (fileId: string): Promise<FileInfo> => {
    const response = await client.post<FileInfo>(`/files/${fileId}/restore`);
    return response.data;
  },

  purgeFile: async (fileId: string): Promise<void> => {
    await client.delete(`/files/${fileId}/purge`);
  },

  getSplitGroupFiles: async (splitGroupId: string): Promise<FileListResponse> => {
    const response = await client.get<FileListResponse>('/files', {
      params: { split_group_id: splitGroupId, page_size: 10000 },
    });
    return response.data;
  },

  checkFileHash: async (hash: string): Promise<{ found: boolean; files: FileInfo[] }> => {
    const response = await client.get<{ found: boolean; files: FileInfo[] }>('/files/check-hash', {
      params: { hash },
    });
    return response.data;
  },

  checkFileHashes: async (hashes: string[]): Promise<Record<string, FileInfo[]>> => {
    const CHUNK = 200;
    const merged: Record<string, FileInfo[]> = {};
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const chunk = hashes.slice(i, i + CHUNK);
      const response = await client.post<{ results: Record<string, FileInfo[]> }>('/files/check-hashes', {
        hashes: chunk,
      });
      Object.assign(merged, response.data.results);
    }
    return merged;
  },
};

export function generateThumbnail(file: File, maxSize: number = 200): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      resolve(null);
      return;
    }

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxSize) {
          height = (height * maxSize) / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width = (width * maxSize) / height;
          height = maxSize;
        }
      }

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
      }

      canvas.toBlob((blob) => {
        URL.revokeObjectURL(img.src);
        resolve(blob);
      }, 'image/jpeg', 0.8);
    };

    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      resolve(null);
    };

    img.src = URL.createObjectURL(file);
  });
}
