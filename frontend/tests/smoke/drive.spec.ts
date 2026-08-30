/**
 * The cheapest useful check against the live site: is it up, is the session
 * still good, does the real backend answer, and does a full folder round-trip
 * (create → rename → trash → restore → purge) survive it?
 *
 * Deliberately metadata-only. Folders have no Telegram message, so this costs
 * no upload quota and cannot trip FLOOD_WAIT — it is the test to run first
 * when something looks wrong in production, before the heavier media specs.
 *
 * Everything it creates is named with a run-unique suffix and purged at the
 * end, including on failure, so a red run never leaves litter in the drive.
 */
import { expect, test } from '@playwright/test';

const RUN_ID = `pw-smoke-${Date.now()}`;
const cards = (page: import('@playwright/test').Page) => page.locator('[data-file-card="true"]');
const card = (page: import('@playwright/test').Page, name: string) =>
  cards(page).filter({ hasText: name }).first();
const dialogInput = (page: import('@playwright/test').Page) =>
  page.getByTestId('drive-drop-zone').getByRole('textbox');

test.describe('live drive @real', () => {
  test.slow(); // the live site is on the far side of a real network

  test('the site loads with the cached session', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: '登出' })).toBeVisible();
    await expect(page.getByPlaceholder('搜尋雲端硬碟')).toBeVisible();
  });

  test('the backend answers the file listing', async ({ page }) => {
    const listing = page.waitForResponse(
      (r) => r.url().includes('/api/v1/files') && r.request().method() === 'GET',
    );

    await page.goto('/');

    expect((await listing).status()).toBe(200);
  });

  test('a folder survives create, rename, trash, restore and purge', async ({ page }) => {
    const name = `${RUN_ID}-folder`;
    const renamed = `${name}-renamed`;
    await page.goto('/');
    await expect(page.getByRole('button', { name: '登出' })).toBeVisible();

    try {
      await page.getByRole('button', { name: '+ 新資料夾' }).click();
      await dialogInput(page).fill(name);
      await page.getByRole('button', { name: '建立' }).click();
      await expect(card(page, name)).toBeVisible();

      // It has to still be there after a reload — i.e. it reached the database,
      // not just the React state.
      await page.reload();
      await expect(card(page, name)).toBeVisible();

      await card(page, name).click();
      await page.getByRole('button', { name: '✏️ 重新命名' }).click();
      await dialogInput(page).fill(renamed);
      await page.getByRole('button', { name: '確定' }).click();
      await expect(card(page, renamed)).toBeVisible();

      await card(page, renamed).click();
      await page.getByRole('button', { name: '🗑️ 刪除' }).click();
      await page.getByRole('button', { name: '移至垃圾桶' }).click();
      await expect(card(page, renamed)).toHaveCount(0);

      await page.getByRole('button', { name: '垃圾桶' }).click();
      await expect(card(page, renamed)).toBeVisible();
      await card(page, renamed).click();
      await page.getByRole('button', { name: '♻️ 還原' }).click();

      await page.getByLabel('我的雲端硬碟').click();
      await expect(card(page, renamed)).toBeVisible();
    } finally {
      await purgeLeftovers(page, RUN_ID);
    }
  });
});

/** Trash and then permanently delete anything this run created. */
async function purgeLeftovers(page: import('@playwright/test').Page, runId: string): Promise<void> {
  await page.getByLabel('我的雲端硬碟').click().catch(() => {});
  await page.getByPlaceholder('搜尋雲端硬碟').fill(runId).catch(() => {});
  for (const leftover of await cards(page).all()) {
    await leftover.click();
    await page.getByRole('button', { name: '🗑️ 刪除' }).click();
    await page.getByRole('button', { name: '移至垃圾桶' }).click();
  }

  await page.getByRole('button', { name: '垃圾桶' }).click();
  for (const trashed of await cards(page).filter({ hasText: runId }).all()) {
    await trashed.click();
    await page.getByRole('button', { name: '🗑️ 永久刪除' }).click();
  }
  await expect(cards(page).filter({ hasText: runId })).toHaveCount(0);
}
