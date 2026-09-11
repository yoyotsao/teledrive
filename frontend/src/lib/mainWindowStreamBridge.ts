import type { FileInfo } from '../types';
import { fileInfoToLocation, type StreamLocationRequest } from './storageLocation';
import type { ResolvedFileLocation } from './fileLocationResolver';

export interface MainWindowStreamBridgeDeps {
  getFile(fileId: string): Promise<FileInfo>;
  resolve(location: NonNullable<ReturnType<typeof fileInfoToLocation>>, purpose: 'stream'): Promise<ResolvedFileLocation>;
  readChunk(
    resolved: ResolvedFileLocation,
    offset: number,
    length: number,
    file: FileInfo,
  ): Promise<ArrayBuffer>;
}

export interface StreamBridgeResult {
  request_id: string;
  chunk?: ArrayBuffer;
  error?: string;
}

export interface StreamMetadataRequest {
  request_id: string;
  file_id: string;
  location_version: number;
}

export interface StreamMetadataResult {
  request_id: string;
  metadata?: { size: number; mimeType: string };
  error?: string;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return error instanceof Error && error.message ? error.message : 'READ_UNAVAILABLE';
}

export function streamPreviewUrl(file: Pick<FileInfo, 'file_id' | 'location_version'>): string {
  return `/preview-video/${encodeURIComponent(file.file_id)}/${file.location_version ?? 0}`;
}

/**
 * Main-window authority for service-worker range reads. It rechecks metadata
 * both before and after the Telegram read so a migration cannot race stale
 * bytes into a response after location_version changed.
 */
export class MainWindowStreamBridge {
  constructor(private readonly deps: MainWindowStreamBridgeDeps) {}

  private async resolveCurrent(fileId: string, expectedVersion: number): Promise<{
    file: FileInfo;
    resolved: ResolvedFileLocation;
  } | { error: 'STALE_LOCATION' | 'READ_UNAVAILABLE' }> {
    const file = await this.deps.getFile(fileId);
    if ((file.location_version ?? 0) !== expectedVersion) return { error: 'STALE_LOCATION' };

    const location = fileInfoToLocation(file);
    if (!location) return { error: 'READ_UNAVAILABLE' };

    const resolved = await this.deps.resolve(location, 'stream');
    if (resolved.locationVersion !== expectedVersion) return { error: 'STALE_LOCATION' };
    return { file, resolved };
  }

  async metadata(request: StreamMetadataRequest): Promise<StreamMetadataResult> {
    try {
      const current = await this.resolveCurrent(request.file_id, request.location_version);
      if ('error' in current) return { request_id: request.request_id, error: current.error };
      return {
        request_id: request.request_id,
        metadata: {
          size: current.resolved.media.size || current.file.filesize,
          mimeType: current.file.mime_type || 'video/mp4',
        },
      };
    } catch (error) {
      return { request_id: request.request_id, error: errorCode(error) };
    }
  }

  async handle(request: StreamLocationRequest): Promise<StreamBridgeResult> {
    try {
      const current = await this.resolveCurrent(request.file_id, request.location_version);
      if ('error' in current) return { request_id: request.request_id, error: current.error };

      const chunk = await this.deps.readChunk(
        current.resolved,
        request.offset,
        request.length,
        current.file,
      );

      const after = await this.deps.getFile(request.file_id);
      if ((after.location_version ?? 0) !== request.location_version) {
        return { request_id: request.request_id, error: 'STALE_LOCATION' };
      }

      return { request_id: request.request_id, chunk };
    } catch (error) {
      return { request_id: request.request_id, error: errorCode(error) };
    }
  }
}
