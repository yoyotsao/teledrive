// Types matching backend FileInfo schema
export interface FileInfo {
  file_id: string;
  filename: string;
  filesize: number;
  mime_type: string | null;
  file_type: string;
  telegram_message_id: number | null;
  created_at: string;
  direct_url: string | null;
  access_hash: string | null;
}

export interface FileListResponse {
  files: FileInfo[];
  total: number;
  page: number;
  page_size: number;
}

export interface FileData {
  id: string;
  name: string;
  isDir: boolean;
  path: string;
  size?: number;
  modifiedAt?: string;
}

export interface UploadResult {
  message_id: number;
  file_id: string;
  access_hash: string;
  size: number;
  mime_type: string;
  filename: string;
}
