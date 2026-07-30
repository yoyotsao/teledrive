const DB_NAME = 'teledrive-thumbnails';
const STORE_NAME = 'thumbs';
// A single folder can hold thousands of images; at 500 the cache thrashed —
// scrolling evicted thumbnails faster than they were viewed, so previously-seen
// tiles kept re-downloading (and intermittently failing to reappear). Thumbs are
// a few KB each, so 5000 entries is only tens of MB of IndexedDB.
const MAX_ENTRIES = 5000;
const EVICT_COUNT = 500;

// Reuse a single connection instead of opening/closing IndexedDB on every get/set —
// matters now that thumbnail loading fans out several parallel requests per folder.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

export async function getCachedThumbnail(fileId: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(fileId);
    req.onsuccess = () => {
      const entry = req.result as { blob: Blob; ts: number } | undefined;
      resolve(entry?.blob ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedThumbnail(fileId: string, blob: Blob): Promise<void> {
  const db = await openDB();

  const count = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  if (count >= MAX_ENTRIES) {
    const all = await new Promise<Array<{ key: string; ts: number }>>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const entries: Array<{ key: string; ts: number }> = [];
      const cursorReq = tx.objectStore(STORE_NAME).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          entries.push({ key: cursor.key as string, ts: (cursor.value as { ts: number }).ts });
          cursor.continue();
        } else {
          resolve(entries);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    all.sort((a, b) => a.ts - b.ts);
    const toDelete = all.slice(0, EVICT_COUNT).map((e) => e.key);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      toDelete.forEach((key) => store.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put({ blob, ts: Date.now() }, fileId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
