/**
 * Creating folders, renaming, and moving things between folders.
 *
 * These are the operations where the UI has to send exactly the right request:
 * a rename that also sends parent_id would silently move the file, and a move
 * that omits parent_id would silently do nothing. So several tests assert on
 * the request the fake backend received, not only on what the screen shows.
 */
import {
  breadcrumb, card, cards, contextMenu, dialogInput, drive, expect, test, visibleNames,
} from '../support/fixtures.ts';

test('creates a folder and shows it straight away', async ({ page, openDrive }) => {
  await openDrive();

  await page.getByRole('button', { name: '+ 新資料夾' }).click();
  await dialogInput(page).fill('Invoices');
  await page.getByRole('button', { name: '建立' }).click();

  await expect(card(page, 'Invoices')).toBeVisible();
});

test('creates the folder inside the folder you are looking at', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => d.folder('outer', { filename: 'Outer' }));
  await card(page, 'Outer').dblclick();
  await expect(breadcrumb(page, 'Outer')).toBeVisible();

  await page.getByRole('button', { name: '+ 新資料夾' }).click();
  await dialogInput(page).fill('Inner');
  await page.getByRole('button', { name: '建立' }).click();

  await expect(card(page, 'Inner')).toBeVisible();
  const created = fake.requests.find((r) => r.method === 'POST' && r.path === '/folders');
  expect(created?.body).toEqual({ name: 'Inner', parent_id: 'outer' });
});

test('refuses a folder name that would break the path', async ({ page, drive: fake, openDrive }) => {
  // parent_id is the only hierarchy; a separator in a name is a fake path.
  await openDrive();

  await page.getByRole('button', { name: '+ 新資料夾' }).click();
  await dialogInput(page).fill('a/b');
  await page.getByRole('button', { name: '建立' }).click();

  await expect(page.getByText('名稱不可包含 / 或 \\')).toBeVisible();
  expect(fake.requests.filter((r) => r.method === 'POST' && r.path === '/folders')).toHaveLength(0);
});

test('refuses an empty folder name', async ({ page, drive: fake, openDrive }) => {
  await openDrive();

  await page.getByRole('button', { name: '+ 新資料夾' }).click();
  await dialogInput(page).fill('   ');
  await page.getByRole('button', { name: '建立' }).click();

  await expect(page.getByText('名稱不可為空')).toBeVisible();
  expect(fake.requests.filter((r) => r.method === 'POST' && r.path === '/folders')).toHaveLength(0);
});

test('renames a file without moving it', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'old.txt', parent_id: 'f1' });
  });
  await card(page, 'Docs').dblclick();
  await card(page, 'old.txt').click();

  await page.getByRole('button', { name: '✏️ 重新命名' }).click();
  await dialogInput(page).fill('new.txt');
  await page.getByRole('button', { name: '確定' }).click();

  await expect(card(page, 'new.txt')).toBeVisible();
  const patch = fake.requests.find((r) => r.method === 'PATCH');
  // parent_id absent, not null: sending it would move the file to the root.
  expect(patch?.body).toEqual({ filename: 'new.txt' });
  expect(fake.get('a')?.parent_id).toBe('f1');
});

test('a cancelled rename changes nothing', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => d.file('a', { filename: 'keep.txt' }));
  await card(page, 'keep.txt').click();

  await page.getByRole('button', { name: '✏️ 重新命名' }).click();
  await dialogInput(page).fill('gone.txt');
  await page.getByRole('button', { name: '取消' }).click();

  await expect(card(page, 'keep.txt')).toBeVisible();
  expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
});

test('moves a file into a folder by dragging it there', async ({ page, drive: fake, openDrive }) => {
  await openDrive((d) => {
    d.folder('target', { filename: 'Target' });
    d.file('a', { filename: 'move-me.txt' });
  });

  await card(page, 'move-me.txt').dragTo(card(page, 'Target'));

  await expect(card(page, 'move-me.txt')).toHaveCount(0);
  expect(fake.get('a')?.parent_id).toBe('target');

  await card(page, 'Target').dblclick();
  await expect(card(page, 'move-me.txt')).toBeVisible();
});

test('moves a file back to the root by dragging it onto the breadcrumb', async ({ page, drive: fake, openDrive }) => {
  // KNOWN FAILURE — the breadcrumb drop target is unreachable, so this is the
  // one documented way to move a file up a level and it does nothing.
  //
  // The breadcrumb only renders while nothing is selected: a selection swaps
  // the whole row for the item toolbar. But handleFileDragStart() calls
  // setSelectedFiles(new Set([file.id])) on an unselected card, so starting
  // the drag is itself what unmounts the target — and starting from an
  // already-selected card means it was never on screen to begin with. Either
  // way the drop lands on the toolbar, which has no onDrop.
  //
  // Remove test.fail() once the breadcrumb survives a drag (e.g. render the
  // path row alongside the toolbar, or defer the selection to dragend).
  test.fail();

  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'move-me.txt', parent_id: 'f1' });
  });
  await card(page, 'Docs').dblclick();
  await expect(card(page, 'move-me.txt')).toBeVisible();

  await card(page, 'move-me.txt').dragTo(breadcrumb(page, '我的雲端硬碟'));

  expect(fake.get('a')?.parent_id).toBeNull();
});

test('the breadcrumb is gone by the time a dragged file could be dropped on it', async ({ page, openDrive }) => {
  // The mechanism behind the known failure above, pinned on its own so the
  // cause is visible even when the test above is eventually fixed.
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'move-me.txt', parent_id: 'f1' });
  });
  await card(page, 'Docs').dblclick();
  await expect(breadcrumb(page, '我的雲端硬碟')).toBeVisible();

  // Dragging an unselected card selects it — see handleFileDragStart.
  await card(page, 'move-me.txt').hover();
  await page.mouse.down();
  await page.mouse.move(10, 10, { steps: 5 });

  await expect(drive(page).getByText('1 已選取')).toBeVisible();
  await expect(breadcrumb(page, '我的雲端硬碟')).toHaveCount(0);
  await page.mouse.up();
});

test('selecting an item swaps the breadcrumb for the item toolbar', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.file('a', { filename: 'one.txt' });
    d.file('b', { filename: 'two.txt' });
  });

  await card(page, 'one.txt').click();

  await expect(drive(page).getByText('1 已選取')).toBeVisible();
  await expect(page.getByRole('button', { name: '✏️ 重新命名' })).toBeVisible();

  // Rename only makes sense for exactly one item.
  await card(page, 'two.txt').click({ modifiers: ['Control'] });
  await expect(drive(page).getByText('2 已選取')).toBeVisible();
  await expect(page.getByRole('button', { name: '✏️ 重新命名' })).toHaveCount(0);

  await page.getByTitle('清除選取').click();
  await expect(breadcrumb(page, '我的雲端硬碟')).toBeVisible();
});

test('the right-click menu offers what the selection allows', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.folder('f1', { filename: 'Docs' });
    d.file('a', { filename: 'one.txt' });
  });

  await card(page, 'one.txt').click({ button: 'right' });
  await expect(contextMenu(page).getByText('預覽')).toBeVisible();
  await expect(contextMenu(page).getByText('下載')).toBeVisible();
  await expect(contextMenu(page).getByText('移至垃圾桶')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(contextMenu(page)).toHaveCount(0);

  // A folder has no bytes to preview or download.
  await card(page, 'Docs').click({ button: 'right' });
  await expect(contextMenu(page).getByText('重新命名')).toBeVisible();
  await expect(contextMenu(page).getByText('預覽')).toHaveCount(0);
  await expect(contextMenu(page).getByText('下載')).toHaveCount(0);
});

test('keeps folders ahead of files in a search result', async ({ page, openDrive }) => {
  await openDrive((d) => {
    d.file('a', { filename: 'report-2026.txt' });
    d.folder('f1', { filename: 'report archive' });
  });

  await page.getByPlaceholder('搜尋雲端硬碟').fill('report');

  await expect(cards(page)).toHaveCount(2);
  expect(await visibleNames(page)).toEqual(['report archive', 'report-2026.txt']);
});
