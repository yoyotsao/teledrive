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
      onUploadProgress: (event) => {
        if (event.total) {}
      },
    });
    return response.data;
  },

  deleteFile: async (fileId: string): Promise<void> => {
    await client.delete(`/files/${fileId}`);
  },

  getDownloadInfo: async (fileId: string): Promise<FileInfo> => {
    const response = await client.get<FileInfo>(`/files/${fileId}/download`);
    return response.data;
  },
};
