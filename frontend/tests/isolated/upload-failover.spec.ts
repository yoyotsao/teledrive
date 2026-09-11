import { expect, test } from '../support/fixtures.ts';

test('migrates a visible upload back to zero without letting the stale source finalize twice', async ({ page, openDrive, drive }) => {
  await openDrive();

  await expect.poll(() => page.evaluate(() => Boolean(window.__TELEDRIVE_FAILOVER_TEST__))).toBe(true);
  await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.start());

  const row = page.getByTestId('upload-center-row').filter({ hasText: 'failover.bin' });
  await expect(row).toContainText('60%');

  const requestsBeforeMigration = drive.requests.length;
  await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.releaseIdleAccount());
  await expect(row).toContainText('重新分派上傳帳號，該區段將從頭重傳');
  await expect(row).toContainText('0%');
  expect(drive.requests.slice(requestsBeforeMigration)).toEqual([]);

  await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.settleLateSource());
  expect(await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.snapshot())).toEqual({
    sourceFinalizeCalls: 0,
    targetFinalizeCalls: 0,
    migrations: 1,
  });

  await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.finishTarget());
  await expect(row).toContainText('已完成');
  await expect(row).toHaveCount(1);
  expect(await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.snapshot())).toEqual({
    sourceFinalizeCalls: 0,
    targetFinalizeCalls: 1,
    migrations: 1,
  });
});
