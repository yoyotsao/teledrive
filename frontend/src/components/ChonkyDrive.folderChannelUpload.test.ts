import { describe, expect, it } from 'vitest';
import source from './ChonkyDrive.tsx?raw';

const folderStart = source.indexOf('const uploadFolder = async');
const folderSource = folderStart >= 0 ? source.slice(folderStart) : '';

describe('folder uploads with shared channel storage', () => {
  it('routes channel-mode files through the durable channel upload path', () => {
    expect(folderStart).toBeGreaterThanOrEqual(0);
    expect(folderSource).toContain('const folderStorageTarget = await api.getStorageTarget()');
    expect(folderSource).toMatch(
      /if \(folderStorageTarget\.storage_mode === 'channel'\)[\s\S]*?durableUploadFile\(file,/,
    );
    expect(folderSource).toMatch(
      /if \(folderStorageTarget\.storage_mode === 'saved_messages'[\s\S]*?albumPipeline\.enqueue\(/,
    );
  });
});
