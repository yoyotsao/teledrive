from pathlib import Path

# --- GramJS: allow the stream bridge to reuse the resolver's exact media ref. ---
p = Path('frontend/src/lib/gramjs.ts')
t = p.read_text()
old = "  async downloadFileChunkedByOffset(messageId: number, offset: number, limit: number, fileSize?: number, expectedFileId?: string): Promise<Blob> {"
new = """  async downloadFileChunkedByOffset(\n    messageId: number,\n    offset: number,\n    limit: number,\n    fileSize?: number,\n    expectedFileId?: string,\n    resolvedRef?: MediaRef,\n    refreshResolvedRef?: () => Promise<MediaRef>,\n  ): Promise<Blob> {"""
assert old in t, 'chunk method signature changed'
t = t.replace(old, new, 1)
old = "      const ref = await this.getFileLocation(messageId, false, expectedFileId);"
new = "      const ref = resolvedRef ?? await this.getFileLocation(messageId, false, expectedFileId);"
assert old in t, 'initial chunk ref lookup changed'
t = t.replace(old, new, 1)
old = "          const fresh = await this.getFileLocation(messageId, true, expectedFileId);"
new = "          const fresh = refreshResolvedRef\n            ? await refreshResolvedRef()\n            : await this.getFileLocation(messageId, true, expectedFileId);"
assert old in t, 'refresh chunk ref lookup changed'
t = t.replace(old, new, 1)
p.write_text(t)

# --- Main window: metadata authority + resolver-owned Telegram reads. ---
p = Path('frontend/src/main.tsx')
t = p.read_text()
old = "import { getPrimaryClient, getClientFor, getAllClients, loadJwt } from './lib/gramjs';"
new = """import { getAllClients } from './lib/gramjs';\nimport { api } from './api/client';\nimport { resolveFileLocation } from './lib/fileLocationResolver';\nimport { fileInfoToLocation } from './lib/storageLocation';\nimport { MainWindowStreamBridge } from './lib/mainWindowStreamBridge';"""
assert old in t, 'main imports changed'
t = t.replace(old, new, 1)

old = """// Skip the getMe() ping in ensureTelegramConnected() if the connection was verified
// alive (by either the keepalive tick or a prior chunk request) within this window —
// avoids a round trip before every single 512KB SW chunk request.
const CONNECTION_CHECK_INTERVAL_MS = 20000;
let lastVerifiedAliveAt = 0;
let isStreamingActive = false;
"""
assert old in t, 'connection globals changed'
t = t.replace(old, '', 1)

start = t.index('/** Client for the account that stores a message.')
end = t.index('/**\n * Start periodic keepalive ping', start)
t = t[:start] + t[end:]

t = t.replace('  isStreamingActive = false;\n', '', 1)
t = t.replace('  isStreamingActive = true;\n', '', 1)
t = t.replace('      lastVerifiedAliveAt = Date.now();\n', '', 1)

anchor = "const streamGate = new StreamGate();\n"
assert anchor in t
bridge = r'''
const streamBridge = new MainWindowStreamBridge({
  getFile: api.getFile,
  resolve: resolveFileLocation,
  readChunk: async (resolved, offset, length, file) => {
    const manager = resolved.manager as any;
    if (!manager?.downloadFileChunkedByOffset) {
      throw Object.assign(new Error('Main-window Telegram reader is unavailable'), { code: 'CLIENT_UNAVAILABLE' });
    }
    const frozenLocation = fileInfoToLocation(file);
    if (!frozenLocation) throw Object.assign(new Error('Missing canonical location'), { code: 'READ_UNAVAILABLE' });
    const blob = await manager.downloadFileChunkedByOffset(
      resolved.message.id,
      offset,
      length,
      resolved.media.size || file.filesize,
      resolved.media.id,
      resolved.media,
      async () => (await resolveFileLocation(frozenLocation, 'stream')).media,
    );
    return blob.arrayBuffer();
  },
});
'''
t = t.replace(anchor, anchor + bridge, 1)

start = t.index('async function handleGetFileChunk(event: MessageEvent) {')
end = t.index('/**\n * Handle GET_FILE_METADATA request', start)
new_chunk = r'''async function handleGetFileChunk(event: MessageEvent) {
  const msg = event.data;
  const requestId = String(msg.request_id ?? msg.requestId ?? '');
  const port = event.ports[0];

  try {
    if (!streamGate.accepts()) {
      port?.postMessage({ request_id: requestId, error: 'CLIENT_UNAVAILABLE' });
      return;
    }
    startKeepalive();
    const result = await streamBridge.handle({
      request_id: requestId,
      file_id: String(msg.file_id ?? msg.fileId ?? ''),
      part_id: msg.part_id,
      location_version: Number(msg.location_version ?? 0),
      offset: Number(msg.offset ?? 0),
      length: Number(msg.length ?? msg.limit ?? 0),
    });
    if (result.error || !result.chunk) {
      port?.postMessage({ request_id: requestId, error: result.error ?? 'READ_UNAVAILABLE' });
      return;
    }
    port?.postMessage({ request_id: requestId, chunk: result.chunk }, [result.chunk]);
  } catch (err: any) {
    port?.postMessage({ request_id: requestId, error: err?.code || err?.message || 'READ_UNAVAILABLE' });
  }
}

'''
t = t[:start] + new_chunk + t[end:]

start = t.index('async function handleGetFileMetadata(event: MessageEvent) {')
end = t.index('/**\n * Handle GET_SPLIT_METADATA request', start)
new_meta = r'''async function handleGetFileMetadata(event: MessageEvent) {
  const msg = event.data;
  const requestId = String(msg.request_id ?? msg.requestId ?? '');
  const port = event.ports[0];
  const result = await streamBridge.metadata({
    request_id: requestId,
    file_id: String(msg.file_id ?? msg.fileId ?? ''),
    location_version: Number(msg.location_version ?? 0),
  });
  if (result.error) port?.postMessage({ request_id: requestId, error: result.error });
  else port?.postMessage({ request_id: requestId, metadata: result.metadata });
}

'''
t = t[:start] + new_meta + t[end:]

start = t.index('async function handleGetSplitMetadata(event: MessageEvent) {')
end = t.index('\nReactDOM.createRoot', start)
new_split = r'''async function handleGetSplitMetadata(event: MessageEvent) {
  const { splitGroupId } = event.data;
  const port = event.ports[0];
  try {
    const data = await api.getSplitGroupFiles(String(splitGroupId));
    const parts = [...data.files].sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0));
    if (parts.length === 0) throw new Error('No parts found for split group');

    let totalSize = 0;
    const partsWithOffset = parts.map((part) => {
      const startOffset = totalSize;
      totalSize += part.filesize;
      return {
        fileId: part.file_id,
        locationVersion: part.location_version ?? 0,
        size: part.filesize,
        startOffset,
      };
    });

    port?.postMessage({ metadata: {
      totalSize,
      mimeType: parts[0]?.mime_type || 'video/mp4',
      parts: partsWithOffset,
    } });
  } catch (err: any) {
    port?.postMessage({ error: err?.code || err?.message || 'READ_UNAVAILABLE' });
  }
}
'''
t = t[:start] + new_split + t[end:]
p.write_text(t)

# --- Service worker: logical/version protocol only. ---
p = Path('frontend/src/service-worker/index.ts')
t = p.read_text()
old = "function bufferFor(fileId: string, messageId: string, accountId: string, fileSize: number): PreloadBuffer {\n  const key = `${fileId}:${messageId}`;"
new = "function bufferFor(fileId: string, locationVersion: number, fileSize: number): PreloadBuffer {\n  const key = `${fileId}:v${locationVersion}`;"
assert old in t, 'bufferFor signature changed'
t = t.replace(old, new, 1)
old = "    requestChunkFromApp(fileId, messageId, accountId, offset, limit, fileSize));"
new = "    requestChunkFromApp(fileId, locationVersion, offset, limit, fileSize));"
assert old in t
t = t.replace(old, new, 1)

t = t.replace("  messageId: number;\n  /** Linked account holding this part's message — access_hash is account-scoped. */\n  accountId: number;", "  fileId: string;\n  locationVersion: number;", 1)

start = t.index('/**\n * Parse URL to extract fileId, messageId and the account that stores it.')
end = t.index('/**\n * Request file chunk from main app via postMessage', start)
new_parse = r'''/**
 * Parse a versioned preview URL. Telegram peer/message/account identity stays
 * exclusively in the main window resolver.
 * URL format: /preview-video/{fileId}/{locationVersion}
 */
function parseVideoUrl(pathname: string): { fileId: string; locationVersion: number } | null {
  const parts = pathname.replace(VIDEO_PREVIEW_PATH, '').split('/');
  if (parts.length >= 2 && parts[0] && /^\d+$/.test(parts[1])) {
    return { fileId: decodeURIComponent(parts[0]), locationVersion: Number(parts[1]) };
  }
  return null;
}

'''
t = t[:start] + new_parse + t[end:]

# Replace requestChunkFromApp and requestChunkOnce as a single block.
start = t.index('async function requestChunkFromApp(')
end = t.index('/**\n * Get file metadata', start)
new_requests = r'''async function requestChunkFromApp(
  fileId: string,
  locationVersion: number,
  offset: number,
  limit: number,
  fileSize?: number,
  retries = 3,
  baseDelay = 1000,
): Promise<ArrayBuffer> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await requestChunkOnce(fileId, locationVersion, offset, limit, fileSize);
    } catch (err: any) {
      lastError = err;
      if (err?.message === 'CLIENT_UNAVAILABLE' || err?.message === 'STALE_LOCATION') throw err;
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError || new Error('Chunk request failed after retries');
}

function requestChunkOnce(
  fileId: string,
  locationVersion: number,
  offset: number,
  limit: number,
  _fileSize?: number,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error(`Chunk request timeout: offset=${offset}, limit=${limit}`));
    }, 30000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.error) reject(new Error(event.data.error));
      else if (event.data?.chunk) resolve(event.data.chunk);
      else reject(new Error('Invalid response from main app'));
    };

    self.clients.matchAll().then((clients) => {
      if (clients.length === 0) {
        clearTimeout(timeout);
        channel.port1.close();
        reject(new Error('CLIENT_UNAVAILABLE'));
        return;
      }
      clients[0].postMessage({
        type: 'GET_FILE_CHUNK',
        request_id: requestId,
        file_id: fileId,
        location_version: locationVersion,
        offset,
        length: limit,
      }, [channel.port2]);
    });
  });
}

'''
t = t[:start] + new_requests + t[end:]

start = t.index('async function requestFileMetadata(')
end = t.index('// Fetch event handler - intercept requests', start)
new_meta_req = r'''async function requestFileMetadata(fileId: string, locationVersion: number): Promise<{ size: number; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const requestId = `meta_${Date.now()}`;
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Metadata request timeout'));
    }, 10000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.error) reject(new Error(event.data.error));
      else if (event.data?.metadata) resolve(event.data.metadata);
      else reject(new Error('Invalid metadata response'));
    };
    self.clients.matchAll().then((clients) => {
      if (clients.length === 0) {
        clearTimeout(timeout);
        channel.port1.close();
        reject(new Error('CLIENT_UNAVAILABLE'));
        return;
      }
      clients[0].postMessage({
        type: 'GET_FILE_METADATA',
        request_id: requestId,
        file_id: fileId,
        location_version: locationVersion,
      }, [channel.port2]);
    });
  });
}

'''
t = t[:start] + new_meta_req + t[end:]

old = "        const buffer = bufferFor(splitGroupId, String(part.messageId), String(part.accountId ?? 0), part.size);"
new = "        const buffer = bufferFor(part.fileId, part.locationVersion, part.size);"
assert old in t, 'split buffer call changed'
t = t.replace(old, new, 1)
old = "        const metadata = await requestFileMetadata(urlParams.fileId, urlParams.messageId, urlParams.accountId);"
new = "        const metadata = await requestFileMetadata(urlParams.fileId, urlParams.locationVersion);"
assert old in t, 'metadata call changed'
t = t.replace(old, new, 1)
old = "        const buffer = bufferFor(urlParams.fileId, urlParams.messageId, urlParams.accountId, metadata.size);"
new = "        const buffer = bufferFor(urlParams.fileId, urlParams.locationVersion, metadata.size);"
assert old in t, 'normal buffer call changed'
t = t.replace(old, new, 1)

t = t.replace("statusText: 'Bad Request - URL should be /preview-video/{fileId}/{messageId}/{accountId}',", "statusText: 'Bad Request - URL should be /preview-video/{fileId}/{locationVersion}',", 1)
t = t.replace("'messageId:', urlParams.messageId", "'locationVersion:', urlParams.locationVersion", 1)
t = t.replace("errorMessage.includes('No clients available') || errorMessage.includes('main app may not be running')", "errorMessage.includes('CLIENT_UNAVAILABLE')", 1)
t = t.replace("message = 'Main application not running. Please refresh the page.';", "message = 'CLIENT_UNAVAILABLE';", 1)
p.write_text(t)

# --- Video URL construction: never expose Telegram identity to the service worker. ---
p = Path('frontend/src/components/ChonkyDrive.tsx')
t = p.read_text()
import_anchor = "import { downloadFileToDisk, fetchFileBlob, fetchFileThumbnail, thumbnailCacheKey } from '../lib/download';"
assert import_anchor in t, 'Chonky download import changed'
t = t.replace(import_anchor, import_anchor + "\nimport { streamPreviewUrl } from '../lib/mainWindowStreamBridge';", 1)
old = """                    : `/preview-video/${previewFile.file_id}/${previewFile.telegram_message_id}/${previewFile.telegram_user_id ?? 0}`}"""
new = """                    : streamPreviewUrl(previewFile)}"""
assert old in t, 'main video URL changed'
t = t.replace(old, new, 1)

start = t.index('function VideoPreviewLoader(')
end = t.index('\nexport { VideoPreviewLoader };', start)
new_loader = r'''function VideoPreviewLoader({ fileId, locationVersion }: { fileId: string; locationVersion: number }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const src = `/preview-video/${encodeURIComponent(fileId)}/${locationVersion}`;

  useEffect(() => {
    const video = document.createElement('video');
    video.src = src;
    const onCanPlay = () => setLoading(false);
    const onError = () => { setLoading(false); setError('Failed to load video'); };
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('error', onError);
    const timeout = setTimeout(() => setLoading(false), 3000);
    return () => {
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('error', onError);
      clearTimeout(timeout);
    };
  }, [src]);

  return (
    <div style={{ padding: '8px', minHeight: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {loading && <div style={{ textAlign: 'center', color: '#6b7280' }}><div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div><div>Loading video...</div></div>}
      {error && <div style={{ color: '#dc2626', textAlign: 'center' }}>{error}</div>}
      <video src={src} controls autoPlay style={{ maxWidth: '100%', maxHeight: 'calc(90vh - 100px)', display: loading ? 'none' : 'block' }} />
    </div>
  );
}
'''
t = t[:start] + new_loader + t[end:]
p.write_text(t)
