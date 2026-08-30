/**
 * Why this matters: resumability rests entirely on skipping media whose id is
 * already in the drive. If that dedupe is wrong, a re-run silently forwards a
 * second copy of every file in the chat — no error anywhere, just a duplicated
 * folder. These asserts are what "re-running is safe" means.
 *
 * Everything Telegram-shaped arrives through ImportDeps (see chatImportDeps.ts),
 * which is exactly why this file can run under node with no client at all.
 */
import { describe, expect, it } from 'vitest';
import { runImport, type ImportDeps } from './chatImport.ts';

function namedDoc(id: number, docId: number, fileName: string, size = 10, mimeType = 'video/mp4') {
  return {
    id,
    date: 1755388800,
    media: {
      className: 'MessageMediaDocument',
      document: {
        id: docId, accessHash: 999, size, mimeType,
        attributes: [{ className: 'DocumentAttributeFilename', fileName }],
        thumbs: [],
      },
    },
  };
}

const docMsg = (id: number, docId: number) => namedDoc(id, docId, `f${docId}.mp4`);

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
    existingFiles: async () => [],
    register: async (p) => { registered.push(p); },
    accountId: 7,
    ...overrides,
  };
  return { deps, forwarded, registered };
}

/**
 * Forwards by echoing the source media under a new message id. `mediaIdShift`
 * defaults to rewriting the media id too, so anything these cases dedupe was
 * deduped by the (name, size, mime) test rather than by the media-id test that
 * already existed; pass 0 for the way Telegram actually behaves, where a
 * forward keeps the source's media id.
 */
function echoDeps(messages: any[], overrides: Partial<ImportDeps> = {}, mediaIdShift = 5000) {
  const byId = new Map<number, any>(messages.map((m) => [m.id, m]));
  return makeDeps({
    iterChatMedia: () => messages,
    forwardToSaved: async (_e, msgId) => {
      const doc = byId.get(msgId).media.document;
      return namedDoc(
        msgId + 1000, Number(doc.id) + mediaIdShift,
        doc.attributes[0].fileName, doc.size, doc.mimeType,
      );
    },
    ...overrides,
  });
}

const never = () => false;
const noop = () => {};

describe('runImport — a fresh import', () => {
  it('forwards and registers every media message', async () => {
    const { deps, forwarded, registered } = makeDeps();

    const result = await runImport('@chan', deps, noop, never);

    expect(forwarded).toHaveLength(3);
    expect(registered).toHaveLength(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('registers the forwarded copy, not the source message', async () => {
    const { deps, registered } = makeDeps();

    await runImport('@chan', deps, noop, never);

    expect(registered[0]).toMatchObject({
      messageId: 1001,          // the forwarded message id
      fileId: '101',            // the forwarded media id (same as the source here)
      parentId: 'folder-1',
      telegramUserId: 7,        // the importing account owns the copy
      filename: 'f101.mp4',
    });
  });
});

describe('runImport — dedupe', () => {
  it('skips media already in the drive and forwards only the rest', async () => {
    const { deps, forwarded, registered } = makeDeps({
      existingFiles: async () => [
        { fileId: '101', filename: 'f101.mp4', filesize: 10, mimeType: 'video/mp4' },
        { fileId: '102', filename: 'f102.mp4', filesize: 10, mimeType: 'video/mp4' },
      ],
    });

    const result = await runImport('@chan', deps, noop, never);

    expect(result.skipped).toBe(2);
    expect(forwarded).toEqual([3]);
    expect(registered).toHaveLength(1);
  });

  it('does not import the same media twice within one run', async () => {
    const { deps, forwarded } = makeDeps({
      iterChatMedia: () => [docMsg(1, 101), docMsg(2, 101)],
    });

    const result = await runImport('@chan', deps, noop, never);

    expect(forwarded).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });
});

describe('runImport — stopping and refusals', () => {
  it('halts the loop as soon as the caller asks it to stop', async () => {
    const { deps, forwarded } = makeDeps();
    let calls = 0;

    const result = await runImport('@chan', deps, noop, () => ++calls > 1);

    expect(forwarded).toHaveLength(1);
    expect(result.imported).toBe(1);
  });

  it('aborts a noforwards chat before forwarding anything', async () => {
    const { deps, forwarded } = makeDeps({
      resolveChat: async () => ({ entity: { id: 1 }, title: 'Locked', noForwards: true }),
    });

    await expect(runImport('@chan', deps, noop, never)).rejects.toThrow('禁止轉發');
    expect(forwarded).toHaveLength(0);
  });
});

describe('runImport — failures', () => {
  it('counts one failed message and carries on', async () => {
    const { deps, registered } = makeDeps({
      forwardToSaved: async (_e, msgId) => {
        if (msgId === 2) throw new Error('MESSAGE_ID_INVALID');
        return { ...docMsg(msgId + 1000, msgId + 100), id: msgId + 1000 };
      },
    });

    const result = await runImport('@chan', deps, noop, never);

    expect(result).toMatchObject({ failed: 1, imported: 2 });
    expect(registered).toHaveLength(2);
  });

  it('treats an unreadable forward as failed rather than registering a guess', async () => {
    // Falling back to the source's access_hash would write a row that can
    // never be downloaded.
    const { deps, registered } = makeDeps({
      forwardToSaved: async (_e, msgId) => ({ id: msgId + 1000, media: { className: 'MessageMediaPoll' } }),
    });

    const result = await runImport('@chan', deps, noop, never);

    expect(result).toMatchObject({ failed: 3, imported: 0 });
    expect(registered).toHaveLength(0);
  });

  it('gives up after five consecutive failures instead of grinding through', async () => {
    // PEER_FLOOD is an account-level limit that will not clear in a few
    // seconds; hammering it makes it worse.
    const manyDocs = Array.from({ length: 10 }, (_, i) => docMsg(i + 1, 100 + i + 1));
    let calls = 0;
    const { deps } = makeDeps({
      iterChatMedia: () => manyDocs,
      forwardToSaved: async () => { calls++; throw new Error('PEER_FLOOD'); },
    });

    // The abort surfaces the last underlying failure, not a generic message.
    await expect(runImport('@chan', deps, noop, never)).rejects.toThrow('PEER_FLOOD');
    expect(calls).toBe(5);
  });

  it('resets the consecutive-failure counter on every success', async () => {
    // Otherwise a chat with a 20% success rate aborts on total failures.
    const manyDocs = Array.from({ length: 12 }, (_, i) => docMsg(i + 1, 100 + i + 1));
    let calls = 0;
    const { deps, registered } = makeDeps({
      iterChatMedia: () => manyDocs,
      forwardToSaved: async (_e, msgId) => {
        calls++;
        if (calls % 5 !== 0) throw new Error('transient');
        return { ...docMsg(msgId + 1000, msgId + 100), id: msgId + 1000 };
      },
    });

    const result = await runImport('@chan', deps, noop, never);

    expect(calls).toBe(12);
    expect(result).toMatchObject({ imported: 2, failed: 10 });
    expect(registered).toHaveLength(2);
  });
});

describe('runImport — scan progress', () => {
  it('counts and reports non-media messages so a text-heavy chat stays stoppable', async () => {
    const textMsg = { id: 99, date: 1755388800, media: null };
    const { deps } = makeDeps({ iterChatMedia: () => [textMsg, docMsg(1, 101)] });
    const scannedTicks: number[] = [];

    const result = await runImport('@chan', deps, (p) => scannedTicks.push(p.scanned), never);

    expect(result).toMatchObject({ scanned: 2, imported: 1, skipped: 0, failed: 0 });
    expect(scannedTicks).toContain(1);
  });
});

describe('runImport — naming collisions', () => {
  it('imports two same-name, same-size, same-mime files only once', async () => {
    const { deps, registered } = echoDeps([
      namedDoc(1, 101, 'dup.mp4', 10),
      namedDoc(2, 102, 'dup.mp4', 10),
    ]);

    const result = await runImport('@chan', deps, noop, never);

    expect(result).toMatchObject({ imported: 1, skipped: 1 });
    expect(registered).toHaveLength(1);
  });

  it('keeps same-named files of different sizes, numbering them', async () => {
    const { deps, registered } = echoDeps([
      namedDoc(1, 101, 'dup.mp4', 10),
      namedDoc(2, 102, 'dup.mp4', 20),
      namedDoc(3, 103, 'dup.mp4', 30),
    ]);

    const result = await runImport('@chan', deps, noop, never);

    expect(result).toMatchObject({ imported: 3, skipped: 0 });
    expect(registered.map((r) => r.filename)).toEqual(['dup.mp4', 'dup (1).mp4', 'dup (2).mp4']);
  });

  it('renames around a name already taken by a drive row', async () => {
    const { deps, registered } = echoDeps([namedDoc(1, 101, 'dup.mp4', 10)], {
      existingFiles: async () => [{ fileId: '999', filename: 'dup.mp4', filesize: 99, mimeType: 'video/mp4' }],
    });

    const result = await runImport('@chan', deps, noop, never);

    expect(result.imported).toBe(1);
    expect(registered[0].filename).toBe('dup (1).mp4');
  });

  it('skips a file matching a drive row on name, size and mime despite a new media id', async () => {
    const { deps, registered } = echoDeps([namedDoc(1, 101, 'dup.mp4', 10)], {
      existingFiles: async () => [{ fileId: '999', filename: 'dup.mp4', filesize: 10, mimeType: 'video/mp4' }],
    });

    const result = await runImport('@chan', deps, noop, never);

    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(registered).toHaveLength(0);
  });

  it('is stable across re-runs instead of growing "dup (1) (1).mp4"', async () => {
    // Media id kept unchanged, because a real Telegram forward preserves the
    // source's media id.
    const messages = [
      namedDoc(1, 101, 'dup.mp4', 10),
      namedDoc(2, 102, 'dup.mp4', 20),
      namedDoc(3, 103, 'other.mp4', 30),
    ];
    const first = echoDeps(messages, {}, 0);
    const firstResult = await runImport('@chan', first.deps, noop, never);
    expect(firstResult.imported).toBe(3);
    expect(first.registered.map((r: any) => r.filename))
      .toEqual(['dup.mp4', 'dup (1).mp4', 'other.mp4']);

    const rows = first.registered.map((r: any) => ({
      fileId: r.fileId, filename: r.filename, filesize: r.filesize, mimeType: r.mimeType,
    }));
    const second = echoDeps(messages, { existingFiles: async () => rows }, 0);

    const result = await runImport('@chan', second.deps, noop, never);

    expect(result).toMatchObject({ imported: 0, skipped: 3 });
    expect(second.registered).toHaveLength(0);
  });
});
