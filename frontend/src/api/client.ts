import axios from 'axios';
import { FileListResponse, FileInfo, UploadResult } from '../types';

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 300000, // 5 min for large uploads
});

export const api = {
  listFiles: async (page: number = 1, pageSize: number = 50, parentId?: string): Promise<FileListResponse> => {
    const response = await client.get<FileListResponse>('/files', {
      params: { page, page_size: pageSize, parent_id: parentId },
    });
    return response.data;
  },

  listFolders: async (parentId: string | null = null): Promise<FileListResponse> => {
    const response = await client.get<FileListResponse>('/folders', {
      params: { parent_id: parentId },
    });
    return response.data;
  },

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

  uploadFile: async (file: File, parentId?: string): Promise<UploadResult> => {
    const formData = new FormData();
    formData.append('file', file);
    if (parentId !== undefined) {
      formData.append('parent_id', parentId);
    }
    const response = await client.post<UploadResult>('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  getDownloadInfo: async (fileId: string): Promise<FileInfo> => {
    const response = await client.get<FileInfo>(`/files/${fileId}/download`);
    return response.data;
  },

  getThumbnail: async (fileId: string): Promise<string | null> => {
    const response = await client.get<{ thumbnail: string; mime_type: string }>(`/files/${fileId}/thumbnail`);
    if (response.data && response.data.thumbnail) {
      return `data:${response.data.mime_type};base64,${response.data.thumbnail}`;
    }
    return null;
  },

  uploadThumbnail: async (thumbnailBlob: Blob): Promise<{ message_id: number; file_id: string; thumbnail_data?: string }> => {
    const formData = new FormData();
    formData.append('file', thumbnailBlob, 'thumbnail.jpg');
    const response = await client.post<{ message_id: number; file_id: string; thumbnail_data?: string }>('/files/thumbnail/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  updateFile: async (fileId: string, thumbnailMessageId?: number, thumbnailData?: string, parentId?: string): Promise<FileInfo> => {
    const response = await client.patch<FileInfo>(`/files/${fileId}`, {
      thumbnail_message_id: thumbnailMessageId,
      thumbnail_data: thumbnailData,
      parent_id: parentId,
    });
    return response.data;
  },

  moveFile: async (fileId: string, newParentId: string | null): Promise<FileInfo> => {
    const response = await client.patch<FileInfo>(`/files/${fileId}`, {
      parent_id: newParentId,
    });
    return response.data;
  },

  deleteFile: async (fileId: string): Promise<void> => {
    await client.delete(`/files/${fileId}`);
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
