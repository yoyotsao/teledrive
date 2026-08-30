import axios from 'axios';
import { FileListResponse, FileInfo } from '../types';
import { loadJwt } from '../lib/gramjs';

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000, // metadata requests only; file bytes never use this client
});

client.interceptors.request.use((config) => {
  const token = loadJwt();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

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

export const api = {
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
