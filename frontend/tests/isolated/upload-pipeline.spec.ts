import { createHash } from 'node:crypto';
import { card, expect, test } from '../support/fixtures.ts';

function fingerprint(bytes: Buffer): string {
  return `${createHash('sha256').update(bytes).digest('hex')}:${bytes.length}`;
}

test('does not wait for every selected file hash before processing the first file', async ({ page, openDrive, drive }) => {
  const fastBytes = Buffer.from('first hash finishes');
  const slowBytes = Buffer.from('second hash lookup is deliberately slow');
  const fastHash = fingerprint(fastBytes);
  const slowHash = fingerprint(slowBytes);

  await openDrive((d) => {
    d.file('source-fast', {
      filename: 'source-fast.txt',
      filesize: fastBytes.length,
      parent_id: 'hidden-sources',
      telegram_message_id: 201,
      access_hash: '20101',
    });
    d.file('source-slow', {
      filename: 'source-slow.txt',
      filesize: slowBytes.length,
      parent_id: 'hidden-sources',
      telegram_message_id: 202,
      access_hash: '20202',
    });
  });

  await page.route('**/api/v1/files/check-hashes', async (route) => {
    const hashes = route.request().postDataJSON().hashes as string[];
    if (hashes.includes(slowHash)) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    const results: Record<string, unknown[]> = {};
    if (hashes.includes(fastHash)) results[fastHash] = [drive.get('source-fast')];
    if (hashes.includes(slowHash)) results[slowHash] = [drive.get('source-slow')];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results }),
    });
  });

  await page.route('**/api/v1/files/register', async (route) => {
    const body = route.request().postDataJSON();
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

  // The old all-files pre-pass could not register fast.txt until the delayed
  // slow lookup returned. The streaming planner exposes it on the first poll.
  await expect(card(page, 'fast.txt')).toBeVisible({ timeout: 2500 });
  await expect(card(page, 'slow.txt')).toHaveCount(0);
  await expect(card(page, 'slow.txt')).toBeVisible({ timeout: 5000 });
});
