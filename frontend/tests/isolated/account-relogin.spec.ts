import { test, expect } from '../support/fixtures.ts';

test('an offline linked account offers a targeted login beside remove', async ({ page, openDrive, drive }) => {
  drive.accounts.push({
    telegram_user_id: 77,
    label: 'secondary',
    is_primary: 0,
    file_count: 12,
  });

  await openDrive();
  await page.getByTitle('設定 / Telegram 帳號').click();

  const accountRow = page.getByText('secondary', { exact: true }).locator('..').locator('..');
  await expect(accountRow.getByRole('button', { name: '登入', exact: true })).toBeVisible();
  await expect(accountRow.getByRole('button', { name: '移除', exact: true })).toBeVisible();

  await accountRow.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '重新登入 secondary' })).toBeVisible();
  await expect(page.getByRole('button', { name: '掃描 QR Code' })).toBeVisible();
});
