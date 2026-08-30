/**
 * Why this matters: chat import forwards files instead of downloading them, so
 * it can never hash their contents. "Is this the same file?" therefore rests
 * entirely on (name, size, mime), and "what do I call the ones that aren't?"
 * rests entirely on uniqueName. Get either wrong and an import either drops
 * files it should have kept or fills the drive with same-named rows.
 */
import { describe, expect, it } from 'vitest';
import { buildFolderIndex, rememberImported, resolveImport, uniqueName } from './importNaming.ts';

const entry = (fileId: string, filename: string, filesize: number, mimeType: string | null) =>
  ({ fileId, filename, filesize, mimeType });

/** A folder holding one 10-byte a.mp4. */
const folderWithAmp4 = () => buildFolderIndex([entry('101', 'a.mp4', 10, 'video/mp4')]);

describe('resolveImport — is this the same file?', () => {
  // --- 已知 media id：維持既有的續傳去重 ------------------------------------------
  it('skips a media id already in the folder, whatever it is called now', () => {
    const decision = resolveImport(folderWithAmp4(), entry('101', 'whatever.mp4', 999, 'video/mp4'));

    expect(decision.action).toBe('skip');
  });

  // --- 同名 + 同大小 + 同 MIME：視為同一個檔案 -------------------------------------
  it('skips a different media id with the same name, size and mime', () => {
    const decision = resolveImport(folderWithAmp4(), entry('202', 'a.mp4', 10, 'video/mp4'));

    expect(decision.action).toBe('skip');
  });

  // --- 三個條件缺一就不是同檔，一律改名保留 -----------------------------------------
  it('renames rather than drops when the size differs', () => {
    const decision = resolveImport(folderWithAmp4(), entry('202', 'a.mp4', 11, 'video/mp4'));

    expect(decision).toMatchObject({ action: 'import', filename: 'a (1).mp4' });
  });

  it('renames rather than drops when the mime differs', () => {
    const decision = resolveImport(folderWithAmp4(), entry('303', 'a.mp4', 10, 'video/quicktime'));

    expect(decision).toMatchObject({ action: 'import', filename: 'a (1).mp4' });
  });

  // --- 沒撞到任何東西就原名匯入 ----------------------------------------------------
  it('imports an untaken name unchanged', () => {
    const decision = resolveImport(folderWithAmp4(), entry('202', 'b.mp4', 10, 'video/mp4'));

    expect(decision).toMatchObject({ action: 'import', filename: 'b.mp4' });
  });

  // --- 大小寫：下載到 Windows 會撞名，所以比對一律正規化 -------------------------------
  it('matches names case-insensitively, for both the same-file and collision tests', () => {
    const index = buildFolderIndex([entry('101', 'A.JPG', 10, 'image/jpeg')]);

    expect(resolveImport(index, entry('202', 'a.jpg', 10, 'image/jpeg')).action).toBe('skip');
    expect(resolveImport(index, entry('303', 'a.jpg', 11, 'image/jpeg')))
      .toMatchObject({ action: 'import', filename: 'a (1).jpg' });
  });

  // --- MIME 正規化：參數與大小寫不算差異 --------------------------------------------
  it('ignores mime parameters and case', () => {
    const decision = resolveImport(
      folderWithAmp4(), entry('202', 'a.mp4', 10, 'Video/MP4; codecs=avc1'),
    );

    expect(decision.action).toBe('skip');
  });

  // --- 缺 MIME 的既有列不會被當成「和任何 MIME 都相同」--------------------------------
  it('does not let a row with no mime match every mime', () => {
    const index = buildFolderIndex([entry('101', 'a.mp4', 10, null)]);

    expect(resolveImport(index, entry('202', 'a.mp4', 10, 'video/mp4')).action).toBe('import');
    expect(resolveImport(index, entry('202', 'a.mp4', 10, null)).action).toBe('skip');
  });
});

describe('resolveImport — collision numbering', () => {
  // --- 連續撞名：序號遞增，不是每次都 (1) ------------------------------------------
  it('increments the counter across successive collisions', () => {
    const index = folderWithAmp4();
    const names: string[] = [];

    for (const [fileId, size] of [['202', 11], ['303', 12], ['404', 13]] as const) {
      const decision = resolveImport(index, entry(fileId, 'a.mp4', size, 'video/mp4'));
      expect(decision.action).toBe('import');
      const filename = decision.action === 'import' ? decision.filename : '';
      names.push(filename);
      rememberImported(index, entry(fileId, filename, size, 'video/mp4'));
    }

    expect(names).toEqual(['a (1).mp4', 'a (2).mp4', 'a (3).mp4']);
  });

  // --- 重跑：既有的 (1) 已佔位，新檔接續 (2)，序號不會層層疊加 --------------------------
  it('steps over an existing (1) instead of nesting into "a (1) (1).mp4"', () => {
    const index = buildFolderIndex([
      entry('101', 'a.mp4', 10, 'video/mp4'),
      entry('202', 'a (1).mp4', 11, 'video/mp4'),
    ]);

    const decision = resolveImport(index, entry('303', 'a.mp4', 12, 'video/mp4'));

    expect(decision).toMatchObject({ action: 'import', filename: 'a (2).mp4' });
  });

  // --- rememberImported 記的是最終檔名，不是原始檔名 ----------------------------------
  it('remembers a just-imported file under the name it was actually stored as', () => {
    const index = folderWithAmp4();
    rememberImported(index, entry('202', 'a (1).mp4', 11, 'video/mp4'));

    const decision = resolveImport(index, entry('303', 'a (1).mp4', 11, 'video/mp4'));

    expect(decision.action).toBe('skip');
  });
});

describe('uniqueName', () => {
  it('returns an untaken name untouched', () => {
    expect(uniqueName(new Set(['b.mp4']), 'a.mp4')).toBe('a.mp4');
  });

  it('appends the counter at the end of an extensionless name', () => {
    expect(uniqueName(new Set(['readme', 'readme (1)']), 'README')).toBe('README (2)');
  });

  it('keeps a dotfile’s leading dot and treats it as extensionless', () => {
    expect(uniqueName(new Set(['.env']), '.env')).toBe('.env (1)');
  });

  it('truncates the base name, never the counter or the extension', () => {
    const long = 'x'.repeat(200) + '.mp4';

    const renamed = uniqueName(new Set([long.toLowerCase()]), long);

    expect(renamed.length).toBeLessThanOrEqual(200);
    expect(renamed.endsWith(' (1).mp4')).toBe(true);
  });
});
