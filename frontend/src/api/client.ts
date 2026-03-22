import axios from 'axios';
import { FileListResponse, FileInfo, UploadResult } from '../types';

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 300000, // 5 min for large uploads
});

export const api = {
  listFiles: async (page: number = 1, pageSize: number = 50): Promise<FileListResponse> => {
    const response = await client.get<FileListResponse>('/files', {
      params: { page, page_size: pageSize },
    });
    return response.data;
  },

  getFile: async (fileId: string): Promise<FileInfo> => {
    const response = await client.get<FileInfo>(`/files/${fileId}`);
    return response.data;
  },

  uploadFile: async (file: File): Promise<UploadResult> => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await client.post<UploadResult>('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (event) => {
        if (event.total) {
          const pct = Math.round((event.loaded * 100) / event.total);
          console.log(`Upload progress: ${pct}%`);
        }
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
