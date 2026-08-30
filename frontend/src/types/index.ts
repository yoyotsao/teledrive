// Types matching backend FileInfo schema
export interface FileInfo {
  file_id: string;
  filename: string;
  filesize: number;
  mime_type: string | null;
  file_type: string;
  telegram_message_id: number | null;
  has_thumbnail?: boolean;
  created_at: string;
  direct_url: string | null;
  access_hash: string | null;
  parent_id?: string | null;
  isDir?: boolean;
  // Split file fields
  is_split_file?: boolean;
  split_group_id?: string;
  original_name?: string;
  part_index?: number;
  total_parts?: number;
  trashed_at?: string | null;
  file_hash?: string | null;
  /** Linked account whose Saved Messages holds this message — picks the download client. */
  telegram_user_id?: number;
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
  parentId?: string;
  size?: number;
  modDate?: Date;
  thumbnailUrl?: string;
}
