/**
 * The isolated layer's Playwright fixtures: a logged-in browser talking to an
 * in-memory backend, with every route out of the machine cut.
 *
 * What "isolated" buys: these specs are the only UI tests that can run on every
 * change, in any order, without a Telegram account, without leaving files in a
 * real drive, and without a FLOOD_WAIT. What it costs: nothing that needs real
 * MTProto — upload bytes, download bytes, thumbnails, video streaming — is
 * exercised here. That is the smoke layer's job (tests/smoke, tagged @real).
 */
import { test as base, expect, type Page } from '@playwright/test';
import { FakeDrive } from './fakeDrive.ts';

export { expect };

const ACCOUNT_ID = 42;

/** Seed a signed-in session before any app script runs. */
async function signIn(page: Page): Promise<void> {
  await page.addInitScript((accountId) => {
    // The app shows the drive as soon as it has a JWT; the Telegram handshake
    // runs in the background and is allowed to fail (App.tsx marks the account
    // offline and carries on). That is what lets this layer skip GramJS.
    localStorage.setItem('tg_jwt', 'isolated-test-token');
    localStorage.setItem(
      'tg_accounts',
      JSON.stringify([{ id: accountId, label: 'test', session: '' }]),
    );
  }, ACCOUNT_ID);
}

/** Serve /api/v1 from the in-memory drive. */
async function serveFakeApi(page: Page, drive: FakeDrive): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = request.method();
    let body: any = null;
    try {
      body = request.postData() ? JSON.parse(request.postData()!) : null;
    } catch {
      body = request.postData();
    }
    drive.requests.push({ method, path, query: url.searchParams, body });

    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const notFound = () => json({ detail: 'File not found' }, 404);

    // --- listings ---------------------------------------------------------
    if (method === 'GET' && path === '/files') return json(drive.listFiles(url.searchParams));
    if (method === 'GET' && path === '/folders') return json(drive.listFolders(url.searchParams));
    if (method === 'GET' && path === '/accounts') {
      return json({ accounts: [{ telegram_user_id: ACCOUNT_ID, label: 'test', is_primary: 1, file_count: drive.rows.length }] });
    }

    // --- one item ---------------------------------------------------------
    const fileMatch = path.match(/^\/files\/([^/]+)$/);
    if (fileMatch) {
      const row = drive.get(decodeURIComponent(fileMatch[1]));
      if (!row) return notFound();
      if (method === 'GET') return json(row);
      if (method === 'PATCH') return json(drive.patch(row.file_id, body ?? {}));
      if (method === 'DELETE') return json({ message: 'Moved to trash', items_trashed: drive.trash(row.file_id) });
    }

    const restore = path.match(/^\/files\/([^/]+)\/restore$/);
    if (restore && method === 'POST') {
      const row = drive.restore(decodeURIComponent(restore[1]));
      return row ? json(row) : notFound();
    }

    const purge = path.match(/^\/files\/([^/]+)\/purge$/);
    if (purge && method === 'DELETE') {
      const id = decodeURIComponent(purge[1]);
      if (!drive.get(id)) return notFound();
      return json({ message: 'Permanently deleted', records_deleted: drive.purge(id) });
    }

    const download = path.match(/^\/files\/([^/]+)\/download$/);
    if (download && method === 'GET') {
      const row = drive.get(decodeURIComponent(download[1]));
      if (!row) return notFound();
      return json({
        file_id: row.file_id, filename: row.filename, filesize: row.filesize,
        mime_type: row.mime_type, message_id: row.telegram_message_id, access_hash: row.access_hash,
      });
    }

    // --- folders ----------------------------------------------------------
    if (method === 'POST' && path === '/folders') {
      return json(drive.createFolder(body.name, body.parent_id ?? null));
    }
    const folderMatch = path.match(/^\/folders\/([^/]+)$/);
    if (folderMatch && method === 'DELETE') {
      const id = decodeURIComponent(folderMatch[1]);
      if (!drive.get(id)) return json({ detail: 'Folder not found' }, 404);
      return json({ message: 'Moved to trash', items_trashed: drive.trash(id) });
    }

    // --- dedup (the upload path asks before uploading) ---------------------
    if (method === 'GET' && path === '/files/check-hash') return json({ found: false, files: [] });
    if (method === 'POST' && path === '/files/check-hashes') return json({ results: {} });

    // Anything unhandled is a bug in this fake, not a passing test.
    return json({ detail: `fake backend has no route for ${method} ${path}` }, 501);
  });
}

/**
 * Cut every route out of the machine. GramJS reaches Telegram over a
 * WebSocket, which page.route() does not intercept, so it needs its own gate —
 * without it a stray reconnect could still open a real MTProto connection.
 */
async function cutExternalNetwork(page: Page): Promise<void> {
  await page.routeWebSocket(/^wss?:\/\/(?!localhost|127\.0\.0\.1)/, (ws) => ws.close());
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
}

type Fixtures = {
  /** The in-memory backend. Seed it BEFORE navigating. */
  drive: FakeDrive;
  /** Seed the drive, then open the app and wait for the first listing. */
  openDrive: (seed?: (drive: FakeDrive) => void) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  drive: async ({ page }, use) => {
    const drive = new FakeDrive();
    await cutExternalNetwork(page);
    await serveFakeApi(page, drive);
    await signIn(page);
    await use(drive);
  },

  openDrive: async ({ page, drive }, use) => {
    await use(async (seed) => {
      seed?.(drive);
      await page.goto('/');
      // The logout button only renders once the app considers itself signed in.
      await expect(page.getByRole('button', { name: '登出' })).toBeVisible();
    });
  },
});

/** The file browser itself — the sidebar repeats some of its labels. */
export const drive = (page: Page) => page.getByTestId('drive-drop-zone');

/** Every file/folder card in the current listing, in render order. */
export const cards = (page: Page) => page.locator('[data-file-card="true"]');

/** One card by the name shown on it. */
export const card = (page: Page, name: string) =>
  cards(page).filter({ hasText: name }).first();

/**
 * The names currently rendered, top to bottom. Reads the name element's title
 * attribute rather than the card's text, which also carries the type icon.
 */
export async function visibleNames(page: Page): Promise<string[]> {
  return cards(page).locator('div[title]').evaluateAll(
    (nodes) => nodes.map((n) => n.getAttribute('title') ?? ''),
  );
}

/** A crumb in the path bar — scoped so it never matches the sidebar. */
export const breadcrumb = (page: Page, name: string) =>
  drive(page).getByRole('button', { name, exact: true });

/**
 * The text box inside the rename / new-folder modal. Scoped to the drive
 * because the search box is a text box too.
 */
export const dialogInput = (page: Page) => drive(page).getByRole('textbox');

/** The right-click menu. Several of its labels also appear in the toolbar. */
export const contextMenu = (page: Page) => page.getByTestId('context-menu');

/**
 * Right-click the listing background, which is what opens the "new folder /
 * upload / empty trash" menu. Aims at the bottom of the scroll area: the
 * handler bails out on anything inside a file card, and cards fill the top.
 */
export async function rightClickBackground(page: Page): Promise<void> {
  const scroll = page.getByTestId('drive-scroll');
  const box = await scroll.boundingBox();
  if (!box) throw new Error('the drive scroll area is not on screen');
  await scroll.click({ button: 'right', position: { x: 8, y: box.height - 8 } });
  await expect(contextMenu(page)).toBeVisible();
}
