import { createHash } from 'node:crypto';
import { card, expect, test } from '../support/fixtures.ts';

function fingerprint(bytes: Buffer): string {
  return `${createHash('sha256').update(bytes).digest('hex')}:${bytes.length}`;
}

test('shows a registered file while the rest of its upload batch is still pending', async ({ page, openDrive, drive }) => {
  const fastBytes = Buffer.from('fast upload');
  const slowBytes = Buffer.from('slow upload remains pending');

  await openDrive((d) => {
    // Dedup sources live outside the visible root. This keeps the test entirely
    // metadata-only: no GramJS connection or Telegram write is needed.
    d.file('source-fast', {
      filename: 'source-fast.txt',
      filesize: fastBytes.length,
      parent_id: 'hidden-sources',
      telegram_message_id: 101,
      access_hash: '10101',
    });
    d.file('source-slow', {
      filename: 'source-slow.txt',
      filesize: slowBytes.length,
      parent_id: 'hidden-sources',
      telegram_message_id: 102,
      access_hash: '10202',
    });
  });

  await page.route('**/api/v1/files/check-hashes', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: {
          [fingerprint(fastBytes)]: [drive.get('source-fast')],
          [fingerprint(slowBytes)]: [drive.get('source-slow')],
        },
      }),
    });
  });

  await page.route('**/api/v1/files/register', async (route) => {
    const body = route.request().postDataJSON();
    if (body.filename === 'slow.txt') {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    drive.file(body.file_id, {
      filename: body.filename,
      filesize: body.filesize,
      mime_type: body.mime_type ?? null,
      telegram_message_id: body.message_id,
      access_hash: body.access_hash ?? null,
      parent_id: body.parent_id ?? null,
      has_thumbnail: body.has_thumbnail ?? false,
      is_split_file: body.is_split_file ?? false,
      split_group_id: body.split_group_id ?? null,
      part_index: body.part_index ?? null,
      total_parts: body.total_parts ?? null,
      file_hash: body.file_hash ?? null,
      telegram_user_id: body.telegram_user_id ?? 42,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(drive.get(body.file_id)),
    });
  });

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'fast.txt', mimeType: 'text/plain', buffer: fastBytes },
    { name: 'slow.txt', mimeType: 'text/plain', buffer: slowBytes },
  ]);

  // The first 1-second background refresh must expose fast.txt before the
  // intentionally delayed second registration allows the batch to finish.
  await expect(card(page, 'fast.txt')).toBeVisible({ timeout: 2500 });
  await expect(card(page, 'slow.txt')).toHaveCount(0);
  await expect(card(page, 'slow.txt')).toBeVisible({ timeout: 5000 });
});
