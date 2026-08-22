/**
 * Self-check for the chat-import naming/dedupe rules. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/importNaming.selfcheck.ts | node --input-type=module
 *
 * Why this matters: chat import forwards files instead of downloading them, so
 * it can never hash their contents. "Is this the same file?" therefore rests
 * entirely on (name, size, mime), and "what do I call the ones that aren't?"
 * rests entirely on uniqueName. Get either wrong and an import either drops
 * files it should have kept or fills the drive with same-named rows.
 */
import { buildFolderIndex, rememberImported, resolveImport, uniqueName } from './importNaming.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

const entry = (fileId: string, filename: string, filesize: number, mimeType: string | null) =>
  ({ fileId, filename, filesize, mimeType });

// --- 已知 media id：維持既有的續傳去重 ------------------------------------------
{
  const index = buildFolderIndex([entry('101', 'a.mp4', 10, 'video/mp4')]);
  const decision = resolveImport(index, entry('101', 'whatever.mp4', 999, 'video/mp4'));
  check('a media id already in the folder is skipped regardless of its name',
    decision.action === 'skip');
}

// --- 同名 + 同大小 + 同 MIME：視為同一個檔案 -------------------------------------
{
  const index = buildFolderIndex([entry('101', 'a.mp4', 10, 'video/mp4')]);
  const decision = resolveImport(index, entry('202', 'a.mp4', 10, 'video/mp4'));
  check('a different media id with the same name, size and mime is treated as the same file',
    decision.action === 'skip');
}

// --- 三個條件缺一就不是同檔，一律改名保留 -----------------------------------------
{
  const index = buildFolderIndex([entry('101', 'a.mp4', 10, 'video/mp4')]);
  const bySize = resolveImport(index, entry('202', 'a.mp4', 11, 'video/mp4'));
  check('the same name with a different size is a different file, renamed',
    bySize.action === 'import' && bySize.filename === 'a (1).mp4');

  const byMime = resolveImport(index, entry('303', 'a.mp4', 10, 'video/quicktime'));
  check('the same name and size with a different mime is a different file, renamed',
    byMime.action === 'import' && byMime.filename === 'a (1).mp4');
}

// --- 沒撞到任何東西就原名匯入 ----------------------------------------------------
{
  const index = buildFolderIndex([entry('101', 'a.mp4', 10, 'video/mp4')]);
  const decision = resolveImport(index, entry('202', 'b.mp4', 10, 'video/mp4'));
  check('a name nobody has taken is imported unchanged',
    decision.action === 'import' && decision.filename === 'b.mp4');
}

// --- 大小寫：下載到 Windows 會撞名，所以比對一律正規化 -------------------------------
{
  const index = buildFolderIndex([entry('101', 'A.JPG', 10, 'image/jpeg')]);
  check('name matching for the same-file test is case-insensitive',
    resolveImport(index, entry('202', 'a.jpg', 10, 'image/jpeg')).action === 'skip');

  const renamed = resolveImport(index, entry('303', 'a.jpg', 11, 'image/jpeg'));
  check('name matching for the collision test is case-insensitive too',
    renamed.action === 'import' && renamed.filename === 'a (1).jpg');
}

// --- MIME 正規化：參數與大小寫不算差異 --------------------------------------------
{
  const index = buildFolderIndex([entry('101', 'a.mp4', 10, 'video/mp4')]);
  check('mime comparison ignores parameters and case',
    resolveImport(index, entry('202', 'a.mp4', 10, 'Video/MP4; codecs=avc1')).action === 'skip');
}

// --- 缺 MIME 的既有列不會被當成「和任何 MIME 都相同」--------------------------------
{
  const index = buildFolderIndex([entry('101', 'a.mp4', 10, null)]);
  check('a row with no mime only matches another with no mime',
    resolveImport(index, entry('202', 'a.mp4', 10, 'video/mp4')).action === 'import');
  check('two rows with no mime still match',
    resolveImport(index, entry('202', 'a.mp4', 10, null)).action === 'skip');
}

// --- 連續撞名：序號遞增，不是每次都 (1) ------------------------------------------
{
  const index = buildFolderIndex([entry('101', 'a.mp4', 10, 'video/mp4')]);

  const first = resolveImport(index, entry('202', 'a.mp4', 11, 'video/mp4'));
  check('first collision takes (1)', first.action === 'import' && first.filename === 'a (1).mp4');
  rememberImported(index, entry('202', first.action === 'import' ? first.filename : '', 11, 'video/mp4'));

  const second = resolveImport(index, entry('303', 'a.mp4', 12, 'video/mp4'));
  check('second collision takes (2), not (1) again',
    second.action === 'import' && second.filename === 'a (2).mp4');
  rememberImported(index, entry('303', second.action === 'import' ? second.filename : '', 12, 'video/mp4'));

  const third = resolveImport(index, entry('404', 'a.mp4', 13, 'video/mp4'));
  check('third collision takes (3)', third.action === 'import' && third.filename === 'a (3).mp4');
}

// --- 重跑：既有的 (1) 已佔位，新檔接續 (2)，序號不會層層疊加 --------------------------
{
  const index = buildFolderIndex([
    entry('101', 'a.mp4', 10, 'video/mp4'),
    entry('202', 'a (1).mp4', 11, 'video/mp4'),
  ]);
  const decision = resolveImport(index, entry('303', 'a.mp4', 12, 'video/mp4'));
  check('an existing (1) is skipped over rather than nested into "a (1) (1).mp4"',
    decision.action === 'import' && decision.filename === 'a (2).mp4');
}

// --- rememberImported 記的是最終檔名，不是原始檔名 ----------------------------------
{
  const index = buildFolderIndex([entry('101', 'a.mp4', 10, 'video/mp4')]);
  rememberImported(index, entry('202', 'a (1).mp4', 11, 'video/mp4'));
  const decision = resolveImport(index, entry('303', 'a (1).mp4', 11, 'video/mp4'));
  check('a just-imported file is matched by the name it was actually stored under',
    decision.action === 'skip');
}

// --- uniqueName 的邊界 ---------------------------------------------------------
{
  const taken = new Set(['readme', 'readme (1)']);
  check('a name with no extension gets the counter appended at the end',
    uniqueName(taken, 'README') === 'README (2)');
}
{
  check('a dotfile keeps its leading dot and is treated as extensionless',
    uniqueName(new Set(['.env']), '.env') === '.env (1)');
}
{
  const long = 'x'.repeat(200) + '.mp4';
  const renamed = uniqueName(new Set([long.toLowerCase()]), long);
  check('a maximum-length name stays within the 200-char cap after renaming',
    renamed.length <= 200);
  check('truncation eats the base name, never the counter or the extension',
    renamed.endsWith(' (1).mp4'));
}
{
  check('an untaken name is returned untouched',
    uniqueName(new Set(['b.mp4']), 'a.mp4') === 'a.mp4');
}

console.log('\nAll importNaming checks passed.');
