// mime/extension → coarse preview kind
export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';

const TEXT_EXT = /\.(txt|md|markdown|json|csv|log|xml|yaml|yml|ini|js|ts|tsx|jsx|css|html|py|java|c|cpp|h|sh|go|rs|rb|php|sql)$/i;

export function fileKind(mimeType: string | null | undefined, filename: string): FileKind {
  const mt = mimeType || '';
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt === 'application/pdf' || /\.pdf$/i.test(filename)) return 'pdf';
  if (mt.startsWith('text/') || mt === 'application/json' || TEXT_EXT.test(filename)) return 'text';
  return 'other';
}
