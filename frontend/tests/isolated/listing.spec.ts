/**
 * What the drive shows: folders and files together, sorted, paged, and asked
 * for from the server rather than re-arranged client-side.
 *
 * The listing is where two endpoints have to agree — /folders and /files are
 * fetched separately and merged into one grid — so most of the bugs this
 * catches are "the folder half went missing" ones.
 */
import { breadcrumb, cards, card, expect, test, visibleNames } from '../support/fixtures.ts';

test('shows folders and files from the drive root', async ({ page, openDrive }) => {
  await openDrive((drive) => {
    drive.folder('f1', { filename: 'Photos' });
    drive.file('a', { filename: 'notes.txt', filesize: 120, mime_type: 'text/plain' });
    drive.file('b', { filename: 'report.pdf', filesize: 4096, mime_type: 'application/pdf' });
  });

  await expect(cards(page)).toHaveCount(3);
  await expect(card(page, 'Photos')).toBeVisible();
  await expect(card(page, 'notes.txt')).toBeVisible();
});

test('does not show files that live inside a folder', async ({ page, openDrive }) => {
  await openDrive((drive) => {
    drive.folder('f1', { filename: 'Photos' });
    drive.file('inside', { filename: 'holiday.txt', parent_id: 'f1' });
    drive.file('outside', { filename: 'root.txt' });
  });

  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, 'holiday.txt')).toHaveCount(0);
});

test('opens a folder, shows its contents, and comes back', async ({ page, openDrive }) => {
  await openDrive((drive) => {
    drive.folder('f1', { filename: 'Photos' });
    drive.file('inside', { filename: 'holiday.txt', parent_id: 'f1' });
    drive.file('outside', { filename: 'root.txt' });
  });

  await card(page, 'Photos').dblclick();

  await expect(card(page, 'holiday.txt')).toBeVisible();
  await expect(card(page, 'root.txt')).toHaveCount(0);
  // The breadcrumb is the way back, and it names where you are.
  await expect(breadcrumb(page, 'Photos')).toBeVisible();

  await breadcrumb(page, '我的雲端硬碟').click();

  await expect(card(page, 'root.txt')).toBeVisible();
});

test('tells the user an empty folder is empty', async ({ page, openDrive }) => {
  await openDrive((drive) => {
    drive.folder('f1', { filename: 'Empty' });
  });

  await card(page, 'Empty').dblclick();

  await expect(page.getByText('這個資料夾是空的')).toBeVisible();
});

test('sorting re-asks the server instead of reordering a stale page', async ({ page, drive, openDrive }) => {
  // Client-side sorting would only ever sort the rows already fetched, which
  // silently gives the wrong answer the moment a folder needs a second page.
  await openDrive((d) => {
    d.file('a', { filename: 'banana.txt', filesize: 300 });
    d.file('b', { filename: 'Apple.txt', filesize: 200 });
    d.file('c', { filename: 'cherry.txt', filesize: 100 });
  });
  drive.requests.length = 0;

  await page.getByTitle('排序').selectOption('name:asc');

  await expect.poll(() => visibleNames(page)).toEqual(['Apple.txt', 'banana.txt', 'cherry.txt']);
  const sortQueries = drive.requests
    .filter((r) => r.path === '/files')
    .map((r) => `${r.query.get('sort_by')}:${r.query.get('sort_order')}`);
  expect(sortQueries).toContain('name:asc');
});

test('sorts by size when asked', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.file('a', { filename: 'banana.txt', filesize: 300 });
    d.file('b', { filename: 'Apple.txt', filesize: 200 });
    d.file('c', { filename: 'cherry.txt', filesize: 100 });
  });

  await page.getByTitle('排序').selectOption('size:desc');

  await expect.poll(() => visibleNames(page)).toEqual(['banana.txt', 'Apple.txt', 'cherry.txt']);
});

test('switches between grid and list without losing the listing', async ({ page, openDrive }) => {
  await openDrive((drive) => {
    drive.file('a', { filename: 'notes.txt', filesize: 120 });
  });

  await page.getByRole('button', { name: '☰ 清單' }).click();

  await expect(card(page, 'notes.txt')).toBeVisible();
  // Only the list view has room for the size.
  await expect(card(page, 'notes.txt')).toContainText('120');

  await page.getByRole('button', { name: '⊞ 格狀' }).click();
  await expect(card(page, 'notes.txt')).toBeVisible();
});

test('a split file appears once, not once per part', async ({ page, openDrive }) => {
  // Every part carries the same filename; showing them all is how a 3GB video
  // used to look like six copies of itself.
  await openDrive((drive) => {
    for (const index of [0, 1, 2]) {
      drive.file(`part${index}`, {
        filename: 'big.mp4', filesize: 500, is_split_file: true,
        part_index: index, total_parts: 3, split_group_id: 'grp',
      });
    }
  });

  await expect(cards(page)).toHaveCount(1);
});
