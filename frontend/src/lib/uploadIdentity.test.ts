import { describe, expect, it } from 'vitest';
import { canonicalIdentity, provisionalIdentity, type UploadDestination } from './uploadIdentity';

const dest = (over: Partial<UploadDestination> = {}): UploadDestination => ({
  rootFolderId: null,
  relativePath: '',
  folderResolved: true,
  resolvedFolderId: null,
  ...over,
});

describe('provisionalIdentity', () => {
  const base = { destination: dest(), name: 'a.txt', size: 10, lastModified: 5 };

  it('相同的根目的地、相對路徑、檔名、大小與時間戳記得到相同結果', () => {
    expect(provisionalIdentity(base)).toBe(provisionalIdentity({ ...base }));
  });

  it('檔名不同就不同', () => {
    expect(provisionalIdentity(base)).not.toBe(provisionalIdentity({ ...base, name: 'b.txt' }));
  });

  it('相對路徑不同就不同', () => {
    const other = { ...base, destination: dest({ relativePath: 'sub' }) };
    expect(provisionalIdentity(base)).not.toBe(provisionalIdentity(other));
  });

  it('不受 folderResolved / resolvedFolderId 影響', () => {
    const unresolved = { ...base, destination: dest({ folderResolved: false, resolvedFolderId: null }) };
    const resolved = { ...base, destination: dest({ folderResolved: true, resolvedFolderId: 'F1' }) };
    expect(provisionalIdentity(unresolved)).toBe(provisionalIdentity(resolved));
  });

  it('欄位邊界不會碰撞', () => {
    const a = { ...base, name: 'a', size: 1 };
    const b = { ...base, name: 'a1', size: 0 };
    expect(provisionalIdentity(a)).not.toBe(provisionalIdentity(b));
  });
});

describe('canonicalIdentity', () => {
  const base = {
    id: 'i1',
    destination: dest({ resolvedFolderId: 'F1' }),
    name: 'a.txt',
    contentHash: 'abc:10',
    hashSettled: true,
  };

  it('資料夾未解析時回 null', () => {
    expect(canonicalIdentity({ ...base, destination: dest({ folderResolved: false }) })).toBeNull();
  });

  it('雜湊尚未回報時回 null', () => {
    expect(canonicalIdentity({ ...base, hashSettled: false, contentHash: null })).toBeNull();
  });

  it('目的地、檔名、內容雜湊都相同時相等', () => {
    expect(canonicalIdentity(base)).toBe(canonicalIdentity({ ...base, id: 'i2' }));
  });

  it('同一資料夾內容相同但檔名不同時不相等', () => {
    expect(canonicalIdentity(base)).not.toBe(canonicalIdentity({ ...base, name: 'b.txt' }));
  });

  it('忽略 relativePath，只看 resolvedFolderId（跨入口重試得以合併）', () => {
    const viaFolderDrop = { ...base, destination: dest({ rootFolderId: null, relativePath: 'A', resolvedFolderId: 'F_A' }) };
    const viaInsideFolder = { ...base, destination: dest({ rootFolderId: 'F_A', relativePath: '', resolvedFolderId: 'F_A' }) };
    expect(canonicalIdentity(viaFolderDrop)).toBe(canonicalIdentity(viaInsideFolder));
  });

  it('雜湊已回報但為 null 時，每個項目各自唯一，永不合併', () => {
    const noHash = { ...base, contentHash: null };
    expect(canonicalIdentity(noHash)).not.toBeNull();
    expect(canonicalIdentity(noHash)).not.toBe(canonicalIdentity({ ...noHash, id: 'i2' }));
  });
});
