/**
 * Deleting is a soft delete, and the trash is where that becomes visible.
 *
 * The distinction the UI has to keep straight: DELETE /files puts a subtree in
 * the trash and leaves the Telegram messages alone, while purge is the only
 * irreversible action. Confusing the two costs the user their files, so every
 * destructive path here goes through a confirm dialog and every test checks
 * what the fake backend was actually asked to do.
 */
import { card, cards, contextMenu, expect, rightClickBackground, test } from '../support/fixtures.ts';

const trashTab = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '垃圾桶' });
const driveTab = (page: import('@playwright/test').Page) =>
  page.getByLabel('我的雲端硬碟');

test('deleting asks first, then moves the file to the trash', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'bye.txt' }));

  await card(page, 'bye.txt').click();
  await page.getByRole('button', { name: '🗑️ 刪除' }).click();
  await expect(page.getByText('確定要將 1 個項目移至垃圾桶嗎？')).toBeVisible();
  await page.getByRole('button', { name: '移至垃圾桶' }).click();

  await expect(card(page, 'bye.txt')).toHaveCount(0);
  await trashTab(page).click();
  await expect(card(page, 'bye.txt')).toBeVisible();
});

test('cancelling the confirm leaves the file alone', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'stay.txt' }));

  await card(page, 'stay.txt').click();
  await page.getByRole('button', { name: '🗑️ 刪除' }).click();
  await page.getByRole('button', { name: '取消' }).click();

  await expect(card(page, 'stay.txt')).toBeVisible();
  expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
});

test('warns that deleting a folder takes its contents with it', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'inside.txt', parent_id: 'f1' });
  });

  await card(page, 'Docs').click();
  await page.getByRole('button', { name: '🗑️ 刪除' }).click();

  await expect(page.getByText('（資料夾將連同全部內容一起移入）')).toBeVisible();
});

test('a deleted folder takes its whole subtree with it', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'inside.txt', parent_id: 'f1' });
    d.file('b', { filename: 'elsewhere.txt' });
  });

  await card(page, 'Docs').click();
  await page.getByRole('button', { name: '🗑️ 刪除' }).click();
  await page.getByRole('button', { name: '移至垃圾桶' }).click();

  await expect(card(page, 'Docs')).toHaveCount(0);
  expect(fake.get('a')?.trashed_at).not.toBeNull();
  expect(fake.get('b')?.trashed_at).toBeNull();
});

test('the trash lists what was deleted, not what was inside it', async ({ page, openDrive }) => {
  // Listing the descendants too would bury the thing the user actually deleted.
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'inside.txt', parent_id: 'f1' });
  });
  await card(page, 'Docs').click();
  await page.getByRole('button', { name: '🗑️ 刪除' }).click();
  await page.getByRole('button', { name: '移至垃圾桶' }).click();

  await trashTab(page).click();

  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'Docs')).toBeVisible();
});

test('restoring puts the subtree back where it was', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'inside.txt', parent_id: 'f1' });
  });
  await card(page, 'Docs').click();
  await page.getByRole('button', { name: '🗑️ 刪除' }).click();
  await page.getByRole('button', { name: '移至垃圾桶' }).click();
  await trashTab(page).click();

  await card(page, 'Docs').click();
  await page.getByRole('button', { name: '♻️ 還原' }).click();

  await expect(page.getByText('垃圾桶是空的')).toBeVisible();
  await driveTab(page).click();
  await card(page, 'Docs').dblclick();
  await expect(card(page, 'inside.txt')).toBeVisible();
});

test('the trash offers restore and permanent delete, never a plain delete', async ({ page, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'gone.txt', trashed_at: '2026-01-01T00:00:00' }));

  await trashTab(page).click();
  await card(page, 'gone.txt').click();

  await expect(page.getByRole('button', { name: '♻️ 還原' })).toBeVisible();
  await expect(page.getByRole('button', { name: '🗑️ 永久刪除' })).toBeVisible();
  await expect(page.getByRole('button', { name: '🗑️ 刪除' })).toHaveCount(0);
});

test('permanently deleting removes the record for good', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'gone.txt', trashed_at: '2026-01-01T00:00:00' }));
  await trashTab(page).click();

  await card(page, 'gone.txt').click();
  await page.getByRole('button', { name: '🗑️ 永久刪除' }).click();
  await expect(page.getByText(/Telegram Saved Messages 中的原始訊息會保留/)).toBeVisible();
  await page.getByRole('button', { name: '永久移除紀錄' }).click();

  await expect(page.getByText('垃圾桶是空的')).toBeVisible();
  expect(fake.get('a')).toBeUndefined();
  expect(fake.requests.some((r) => r.method === 'DELETE' && r.path === '/files/a/purge')).toBe(true);
});

test('emptying the trash warns that it cannot be undone', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => {
    d.file('a', { filename: 'one.txt', trashed_at: '2026-01-01T00:00:00' });
    d.file('b', { filename: 'two.txt', trashed_at: '2026-01-01T00:00:00' });
  });
  await trashTab(page).click();

  await rightClickBackground(page);
  await contextMenu(page).getByText('清空垃圾桶').click();
  await expect(page.getByText(/這只會永久移除 TeleDrive 紀錄/)).toBeVisible();
  await expect(page.getByText(/Telegram Saved Messages 中的原始訊息會保留/)).toBeVisible();
  await page.getByRole('button', { name: '清空垃圾桶' }).click();

  await expect(page.getByText('垃圾桶是空的')).toBeVisible();
  expect(fake.rows).toHaveLength(0);
});

test('the drive listing never shows trashed items', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.file('a', { filename: 'live.txt' });
    d.file('b', { filename: 'deleted.txt', trashed_at: '2026-01-01T00:00:00' });
  });

  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'live.txt')).toBeVisible();
});
