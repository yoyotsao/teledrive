/**
 * Self-check for runImport. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/chatImport.selfcheck.ts | node --input-type=module
 *
 * Why this matters: resumability rests entirely on skipping media whose id is
 * already in the drive. If that dedupe is wrong, a re-run silently forwards a
 * second copy of every file in the chat — no error anywhere, just a duplicated
 * folder. These asserts are what "re-running is safe" means.
 */
import { runImport, type ImportDeps } from './chatImport.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

function docMsg(id: number, docId: number) {
  return {
    id,
    date: 1755388800,
    media: {
      className: 'MessageMediaDocument',
      document: {
        id: docId, accessHash: 999, size: 10, mimeType: 'video/mp4',
        attributes: [{ className: 'DocumentAttributeFilename', fileName: `f${docId}.mp4` }],
        thumbs: [],
      },
    },
  };
}

function makeDeps(overrides: Partial<ImportDeps> = {}) {
  const forwarded: number[] = [];
  const registered: any[] = [];
  const deps: ImportDeps = {
    resolveChat: async () => ({ entity: { id: 1 }, title: 'My Channel', noForwards: false }),
    iterChatMedia: () => [docMsg(1, 101), docMsg(2, 102), docMsg(3, 103)],
    forwardToSaved: async (_e, msgId) => {
      forwarded.push(msgId);
      return { ...docMsg(msgId + 1000, msgId + 100), id: msgId + 1000 };
    },
    ensureFolder: async () => 'folder-1',
    existingFileIds: async () => new Set<string>(),
    register: async (p) => { registered.push(p); },
    accountId: 7,
    ...overrides,
  };
  return { deps, forwarded, registered };
}

const never = () => false;
const noop = () => {};

// --- 全新匯入 ---------------------------------------------------------------
{
  const { deps, forwarded, registered } = makeDeps();
  const result = await runImport('@chan', deps, noop, never);
  check('fresh import forwards every media message', forwarded.length === 3);
  check('fresh import registers every forwarded message', registered.length === 3);
  check('imported count matches', result.imported === 3);
  check('nothing skipped on a fresh import', result.skipped === 0);
  check('register uses the forwarded message id, not the source id',
    registered[0].messageId === 1001);
  check('register uses the source media id as file_id',
    registered[0].fileId === '101');
  check('register targets the created folder', registered[0].parentId === 'folder-1');
  check('register attributes the file to the importing account',
    registered[0].telegramUserId === 7);
  check('register carries the derived filename', registered[0].filename === 'f101.mp4');
}

// --- 續傳：已存在的媒體要跳過 --------------------------------------------------
{
  const { deps, forwarded, registered } = makeDeps({
    existingFileIds: async () => new Set(['101', '102']),
  });
  const result = await runImport('@chan', deps, noop, never);
  check('resume skips media already in the drive', result.skipped === 2);
  check('resume forwards only what is missing', forwarded.length === 1 && forwarded[0] === 3);
  check('resume registers only what it forwarded', registered.length === 1);
}

// --- 同一次執行內不重複匯入相同媒體 ---------------------------------------------
{
  const { deps, forwarded } = makeDeps({
    iterChatMedia: () => [docMsg(1, 101), docMsg(2, 101)],
  });
  const result = await runImport('@chan', deps, noop, never);
  check('the same media forwarded twice in one run is deduped',
    forwarded.length === 1 && result.skipped === 1);
}

// --- 中止 -------------------------------------------------------------------
{
  const { deps, forwarded } = makeDeps();
  let calls = 0;
  const result = await runImport('@chan', deps, noop, () => ++calls > 1);
  check('stopping halts the loop early', forwarded.length === 1 && result.imported === 1);
}

// --- 禁止轉發 ---------------------------------------------------------------
{
  const { deps, forwarded } = makeDeps({
    resolveChat: async () => ({ entity: { id: 1 }, title: 'Locked', noForwards: true }),
  });
  let message = '';
  try { await runImport('@chan', deps, noop, never); } catch (e: any) { message = e.message; }
  check('a noforwards chat aborts before forwarding anything',
    forwarded.length === 0 && message.includes('禁止轉發'));
}

// --- 單則失敗不中斷整批 -------------------------------------------------------
{
  const { deps, registered } = makeDeps({
    forwardToSaved: async (_e, msgId) => {
      if (msgId === 2) throw new Error('MESSAGE_ID_INVALID');
      return { ...docMsg(msgId + 1000, msgId + 100), id: msgId + 1000 };
    },
  });
  const result = await runImport('@chan', deps, noop, never);
  check('a failed message is counted and the run continues',
    result.failed === 1 && result.imported === 2 && registered.length === 2);
}

console.log('\nAll chatImport checks passed.');
