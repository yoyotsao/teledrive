import { describe, expect, it } from 'vitest';
import source from './SettingsDialog.tsx?raw';

describe('settings invalidate the upload topology snapshot', () => {
  it('invalidates after linking and unlinking accounts', () => {
    expect(source).toContain("import { invalidateFrozenUploadContext } from '../lib/durableUploadRuntime';");
    expect(source).toMatch(/await saveAccount\([\s\S]*?invalidateFrozenUploadContext\(\);[\s\S]*?await reload\(\)/);
    expect(source).toMatch(/await flushThenUnlinkSecondaryAccount\([\s\S]*?invalidateFrozenUploadContext\(\);[\s\S]*?await reload\(\)/);
  });

  it('invalidates after a storage target change is saved', () => {
    expect(source).toContain('<StorageTargetDialog onSaved={invalidateFrozenUploadContext} />');
  });
});
