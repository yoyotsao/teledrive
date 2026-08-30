/**
 * Search, the URL, and the session — the state that has to survive a reload.
 *
 * Every view the drive can be in is encoded in the query string
 * (src/hooks/useUrlState.ts), which is what makes a folder link shareable and
 * a refresh non-destructive. If that ever regresses, the app silently drops
 * the user back at the root on every reload.
 */
import { breadcrumb, card, cards, expect, test } from '../support/fixtures.ts';

test('searching spans the whole drive, not just this folder', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('deep', { filename: 'holiday-photo.txt', parent_id: 'f1' });
    d.file('shallow', { filename: 'holiday-notes.txt' });
    d.file('other', { filename: 'unrelated.txt' });
  });

  await page.getByPlaceholder('搜尋雲端硬碟').fill('holiday');

  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, 'holiday-photo.txt')).toBeVisible();
  // The search really went to the server; a client-side filter would only ever
  // see the rows of the folder currently loaded.
  expect(fake.requests.some((r) => r.path === '/files' && r.query.get('search') === 'holiday')).toBe(true);
});

test('says so when a search matches nothing', async ({ page, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'notes.txt' }));

  await page.getByPlaceholder('搜尋雲端硬碟').fill('nothing-like-this');

  await expect(page.getByText('找不到符合的檔案')).toBeVisible();
});

test('clearing the search returns to the drive', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.file('a', { filename: 'notes.txt' });
    d.file('b', { filename: 'other.txt' });
  });
  await page.getByPlaceholder('搜尋雲端硬碟').fill('notes');
  await expect(cards(page)).toHaveCount(1);

  await page.getByPlaceholder('搜尋雲端硬碟').fill('');

  await expect(cards(page)).toHaveCount(2);
});

test('the open folder is in the URL and survives a reload', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'inside.txt', parent_id: 'f1' });
  });

  await card(page, 'Docs').dblclick();
  await expect(page).toHaveURL(/folder=f1/);

  await page.reload();

  await expect(card(page, 'inside.txt')).toBeVisible();
  await expect(breadcrumb(page, 'Docs')).toBeVisible();
});

test('the trash and the sort order are in the URL too', async ({ page, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'notes.txt' }));

  await page.getByRole('button', { name: '垃圾桶' }).click();
  await expect(page).toHaveURL(/view=trash/);

  await page.getByLabel('我的雲端硬碟').click();
  await page.getByTitle('排序').selectOption('name:asc');

  await expect(page).toHaveURL(/sort=name/);
  await expect(page).toHaveURL(/order=asc/);
});

test('the browser back button walks back out of a folder', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('root', { filename: 'root.txt' });
  });
  await card(page, 'Docs').dblclick();
  await expect(breadcrumb(page, 'Docs')).toBeVisible();

  await page.goBack();

  await expect(card(page, 'root.txt')).toBeVisible();
});

test('a deep link opens straight into the folder', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'inside.txt', parent_id: 'f1' });
  });

  await page.goto('/?folder=f1');

  await expect(card(page, 'inside.txt')).toBeVisible();
});

test('logging out clears the session and shows the login screen', async ({ page, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'secret.txt' }));

  await page.getByRole('button', { name: '登出' }).click();

  await expect(page.getByText('掃描 QR Code')).toBeVisible();
  await expect(card(page, 'secret.txt')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('tg_jwt'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('tg_accounts'))).toBeNull();
  expect(await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('teledrive-credentials', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction('credentials').objectStore('credentials').get('active');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  })).toBeUndefined();
});

test('legacy plaintext credentials are migrated out of localStorage', async ({ page, openDrive }) => {
  await openDrive();

  expect(await page.evaluate(() => localStorage.getItem('tg_jwt'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('tg_accounts'))).toBeNull();
  expect(await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('teledrive-credentials', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<any>((resolve, reject) => {
      const request = db.transaction('credentials').objectStore('credentials').get('active');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { jwt: value?.jwt, accountId: value?.accounts?.[0]?.id };
  })).toEqual({ jwt: 'isolated-test-token', accountId: 42 });
});

test('a browser with no session never sees the drive', async ({ page, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'secret.txt' }));

  // Added after the fixture's sign-in script, so it runs after it on the next
  // navigation and wins — clearing storage here alone would just be re-seeded.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('teledrive-credentials', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('credentials', 'readwrite');
      transaction.objectStore('credentials').delete('active');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });
  await page.addInitScript(() => localStorage.clear());
  await page.reload();

  await expect(page.getByText('掃描 QR Code')).toBeVisible();
  await expect(page.getByRole('button', { name: '登出' })).toHaveCount(0);
});

test('the theme choice survives a reload', async ({ page, openDrive }) => {
  await openDrive();
  const before = await page.evaluate(() => document.documentElement.dataset.theme ?? '');

  await page.getByTitle('切換深色/淺色').click();
  const after = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  expect(after).not.toBe(before);

  await page.reload();

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? ''))
    .toBe(after);
});

test('the collapsed sidebar survives a reload', async ({ page, openDrive }) => {
  await openDrive();

  await page.getByLabel('收起側邊欄').click();
  await expect(page.getByLabel('展開側邊欄')).toBeVisible();

  await page.reload();

  await expect(page.getByLabel('展開側邊欄')).toBeVisible();
});
