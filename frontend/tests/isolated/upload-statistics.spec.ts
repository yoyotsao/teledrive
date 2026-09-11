import { test, expect } from '../support/fixtures';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

test.beforeEach(async ({ page }) => {
  const dist = resolve(import.meta.dirname, '../../dist');
  await page.route('http://localhost:3000/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) return route.fallback();
    const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(dist + '/')) return route.abort();
    const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream';
    try { await route.fulfill({ contentType, body: await readFile(file) }); }
    catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
});

test('settings switches between account management and daily upload statistics', async ({ page, openDrive }) => {
  await openDrive();
  await page.route('**/api/v1/statistics/uploads', route => route.fulfill({ json: {
    today: '2026-09-06', timezone: 'Asia/Taipei', first_day: '2026-09-05',
    accounts: [{ telegram_user_id: 42, label: 'test', bytes: 2_500_000_000 }, { telegram_user_id: 43, label: 'second', bytes: 1_000_000_000 }],
    days: [{ day: '2026-09-06', bytes: 3_500_000_000 }, { day: '2026-09-05', bytes: 8_000_000_000 }, { day: '2026-09-04', bytes: 0 }],
  } }));
  await page.getByTitle('設定 / Telegram 帳號').click();
  const settings = page.getByRole('dialog', { name: '設定' });
  await expect(settings.getByRole('tab', { name: '管理帳號' })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByRole('button', { name: '＋ 新增 Telegram 帳號' })).toBeVisible();
  await settings.getByRole('tab', { name: '統計', exact: true }).click();
  await expect(settings.getByText('今日已上傳', { exact: true })).toBeVisible();
  await expect(settings.getByText('11.50 GB', { exact: true })).toBeVisible();
  await expect(settings.getByText('2.50 GB', { exact: true })).toBeVisible();
  await expect(settings.getByRole('row').filter({ hasText: '2026-09-05' })).toContainText('8.00 GB');
  await expect(settings.getByRole('row').filter({ hasText: '2026-09-04' })).toContainText('—');
  await expect(settings.getByRole('button', { name: '＋ 新增 Telegram 帳號' })).toBeHidden();
  await settings.getByRole('tab', { name: '統計', exact: true }).press('ArrowLeft');
  await expect(settings.getByRole('tab', { name: '管理帳號' })).toBeFocused();
  await expect(settings.getByRole('button', { name: '＋ 新增 Telegram 帳號' })).toBeVisible();
  await settings.getByRole('button', { name: '關閉設定' }).click();
  await expect(settings).toBeHidden();
});

test('statistics reports load errors and recovers on retry on a narrow viewport', async ({ page, openDrive }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openDrive();
  let failing = true;
  await page.route('**/api/v1/statistics/uploads', route => failing
    ? route.fulfill({ status: 503, json: { detail: 'unavailable' } })
    : route.fulfill({ json: { today: '2026-09-06', timezone: 'Asia/Taipei', first_day: null, accounts: [], days: [{ day: '2026-09-06', bytes: 0 }] } }));
  await page.getByTitle('設定 / Telegram 帳號').click();
  await page.getByRole('tab', { name: '統計', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('無法更新上傳統計');
  failing = false;
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await expect(page.getByText('尚無帳號統計')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const box = await page.getByRole('dialog').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
});
