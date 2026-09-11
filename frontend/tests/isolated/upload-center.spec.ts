import { createHash } from 'node:crypto';
import { expect, test } from '../support/fixtures.ts';

/** 與 frontend/src/lib/hashFile.ts 的 sha256File() 同格式：<hex64>:<size>。 */
function fingerprint(bytes: Buffer): string {
  return `${createHash('sha256').update(bytes).digest('hex')}:${bytes.length}`;
}

/** 讓假後端把這些內容回報成「已存在」，走去重路徑直接註冊，不碰 Telegram。 */
async function dedupeAll(page: import('@playwright/test').Page, drive: any, sources: Map<string, Buffer>) {
  let seq = 0;
  for (const [id] of sources) {
    drive.file(id, {
      filename: `${id}.bin`, filesize: sources.get(id)!.length, parent_id: 'hidden-sources',
      telegram_message_id: 900 + (seq += 1), access_hash: `9000${seq}`,
    });
  }
  await page.route('**/api/v1/files/check-hashes', async (route) => {
    const hashes = route.request().postDataJSON().hashes as string[];
    const results: Record<string, unknown[]> = {};
    for (const [id, bytes] of sources) {
      if (hashes.includes(fingerprint(bytes))) results[fingerprint(bytes)] = [drive.get(id)];
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
  await page.route('**/api/v1/files/register', async (route) => {
    const body = route.request().postDataJSON();
    drive.file(body.file_id, {
      filename: body.filename, filesize: body.filesize, mime_type: body.mime_type ?? null,
      telegram_message_id: body.message_id, access_hash: body.access_hash ?? null,
      parent_id: body.parent_id ?? null, file_hash: body.file_hash ?? null, telegram_user_id: 42,
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(drive.get(body.file_id)) });
  });
}

const center = (page: import('@playwright/test').Page) => page.getByTestId('upload-center');
const rows = (page: import('@playwright/test').Page) => page.getByTestId('upload-center-row');

test('任意時刻只存在一個上傳中心，第二批追加而不取代第一批', async ({ page, openDrive, drive }) => {
  const first = Buffer.from('batch one payload');
  const second = Buffer.from('batch two payload');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', first], ['src-2', second]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: first },
  ]);
  await expect(center(page)).toHaveCount(1);
  // 不要斷言列數：這個檔案走去重路徑會立刻完成，而完成組預設收合,
  // 列會消失且永遠回不來。標題不受收合影響，進行中是「0 / 1」、完成是「1 / 1」，
  // 兩者都含有「/ 1」。
  await expect(center(page).getByTestId('upload-center-title')).toContainText('/ 1');

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'second.txt', mimeType: 'text/plain', buffer: second },
  ]);
  await expect(center(page)).toHaveCount(1);
  await expect(center(page).getByTestId('upload-center-title')).toContainText('/ 2');
});

test('超過 100 個檔案時不刪除早期項目', async ({ page, openDrive, drive }) => {
  const sources = new Map<string, Buffer>();
  const payloads = Array.from({ length: 150 }, (_, i) => Buffer.from(`payload number ${i}`));
  payloads.forEach((bytes, i) => sources.set(`src-${i}`, bytes));

  await openDrive();
  await dedupeAll(page, drive, sources);

  await page.locator('input[type="file"]').first().setInputFiles(
    payloads.map((buffer, i) => ({ name: `file-${String(i).padStart(3, '0')}.txt`, mimeType: 'text/plain', buffer })),
  );

  // 150 / 150 這個標題就是證據：計數來自狀態，超過 100 個項目之後早期項目
  // 沒有被丟掉。至於「DOM 只渲染 viewport 內的列」，由
  // 「展開完成組後仍只渲染 viewport 內的列」那個測試負責驗證上下界。
  await expect(center(page).getByTestId('upload-center-title')).toContainText('150 / 150', { timeout: 30_000 });
});

/** 讓 register 對指定檔名回 500，製造「註冊失敗」。 */
async function failRegisterFor(page: import('@playwright/test').Page, filenames: string[]) {
  await page.route('**/api/v1/files/register', async (route) => {
    const body = route.request().postDataJSON();
    if (filenames.includes(body.filename)) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '中繼資料寫入失敗' }) });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...body, file_id: body.file_id, isDir: false }) });
  });
}

test('失敗置頂，失敗篩選只顯示失敗項目與具體原因', async ({ page, openDrive, drive }) => {
  const good = Buffer.from('this one registers fine');
  const bad = Buffer.from('this one fails to register');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-good', good], ['src-bad', bad]]));
  await failRegisterFor(page, ['bad.txt']);

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'good.txt', mimeType: 'text/plain', buffer: good },
    { name: 'bad.txt', mimeType: 'text/plain', buffer: bad },
  ]);

  await expect(page.getByTestId('upload-center-error-badge')).toContainText('失敗 1');
  // 失敗組永遠排在最前面。
  await expect(rows(page).first()).toContainText('bad.txt');
  await expect(rows(page).first()).toContainText('註冊失敗');

  await page.getByTestId('upload-filter-error').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('bad.txt');
});

test('搜尋找得到虛擬 viewport 外與已收合完成組內的項目', async ({ page, openDrive, drive }) => {
  const sources = new Map<string, Buffer>();
  const payloads = Array.from({ length: 150 }, (_, i) => Buffer.from(`searchable payload ${i}`));
  payloads.forEach((bytes, i) => sources.set(`src-${i}`, bytes));

  await openDrive();
  await dedupeAll(page, drive, sources);
  await page.locator('input[type="file"]').first().setInputFiles(
    payloads.map((buffer, i) => ({ name: `file-${String(i).padStart(3, '0')}.txt`, mimeType: 'text/plain', buffer })),
  );
  await expect(page.getByTestId('upload-center-title')).toContainText('150 / 150', { timeout: 30_000 });

  // 完成組預設收合，清單此刻是空的。
  await expect(rows(page)).toHaveCount(0);

  for (const name of ['file-000.txt', 'file-099.txt', 'file-149.txt']) {
    await page.getByTestId('upload-search').fill(name);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(name);
  }
});

test('完整錯誤訊息顯示在列表外的固定區域，不改變列高', async ({ page, openDrive, drive }) => {
  const bad = Buffer.from('registration will fail');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-bad', bad]]));
  await failRegisterFor(page, ['bad.txt']);

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'bad.txt', mimeType: 'text/plain', buffer: bad },
  ]);
  await expect(rows(page)).toHaveCount(1);
  const before = await rows(page).first().boundingBox();

  await page.getByTestId('upload-row-detail-btn').first().click();
  await expect(page.getByTestId('upload-error-detail')).toBeVisible();
  // 列高不變還不夠：列的高度是 VirtualUploadList 用 inline style 寫死的，
  // 就算把錯誤詳情整塊塞進列裡也量不出差別。直接斷言它不在虛擬列表內。
  await expect(page.locator('[data-testid="upload-virtual-list"] [data-testid="upload-error-detail"]')).toHaveCount(0);
  await expect(page.getByTestId('upload-error-detail')).toBeVisible();
  const after = await rows(page).first().boundingBox();
  expect(after!.height).toBe(before!.height);
});

test('展開完成組後仍只渲染 viewport 內的列，證明虛擬捲動', async ({ page, openDrive, drive }) => {
  const sources = new Map<string, Buffer>();
  const payloads = Array.from({ length: 150 }, (_, i) => Buffer.from(`windowing payload ${i}`));
  payloads.forEach((bytes, i) => sources.set(`src-${i}`, bytes));

  await openDrive();
  await dedupeAll(page, drive, sources);
  await page.locator('input[type="file"]').first().setInputFiles(
    payloads.map((buffer, i) => ({ name: `file-${String(i).padStart(3, '0')}.txt`, mimeType: 'text/plain', buffer })),
  );
  await expect(page.getByTestId('upload-center-title')).toContainText('150 / 150', { timeout: 30_000 });

  // 收合狀態下清單是空的——這正是 Task 7 那個斷言恆真的原因。
  await expect(rows(page)).toHaveCount(0);

  await page.getByTestId('upload-toggle-completed').click();

  // 展開後真的有列被渲染。必須用會自動重試的斷言：面板的重繪走 requestAnimationFrame
  // 排程，click() 之後的同一個 tick 還沒有列，非重試的 count() 會讀到 0。
  await expect(rows(page)).not.toHaveCount(0);

  // ……但遠少於 150。兩個條件同時成立才叫虛擬捲動：
  // 只有上界會被空清單滿足，只有下界無法排除全部渲染。
  const rendered = await rows(page).count();
  expect(rendered).toBeLessThan(150);
});

test('開啟影片預覽時收合並讓開播放器，關閉後維持收合', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('collapse me while the player is open');
  await openDrive((d) => {
    d.file('clip', { filename: 'clip.mp4', filesize: 2048, mime_type: 'video/mp4', telegram_message_id: 501, access_hash: '50101' });
  });
  await dedupeAll(page, drive, new Map([['src-1', payload]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: payload },
  ]);
  await expect(page.getByTestId('upload-center')).toBeVisible();

  await page.getByText('clip.mp4').first().dblclick();

  await expect(page.getByTestId('upload-center')).toHaveCount(0);
  const button = page.getByTestId('upload-center-collapsed');
  await expect(button).toBeVisible();

  // 預覽期間固定在左上安全區（top:12, left:12）——預覽卡片的 ✕／↓ 在卡片右上
  // 角，而卡片置中、最寬 90vw，左上角永遠在卡片之外。這裡不試圖證明「沒有遮住
  // 播放器」：isolated 層的 <video> 沒有來源、預覽框會縮到畫面中央，重疊檢查對
  // 任何錯誤位置都會通過。真正的遮擋驗收在 Task 11 的線上驗收。
  const btn = (await button.boundingBox())!;
  expect(btn.x).toBeCloseTo(12, 0);
  expect(btn.y).toBeCloseTo(12, 0);

  // 預覽期間點擊不展開。
  await button.click();
  await expect(page.getByTestId('upload-center')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('upload-center')).toHaveCount(0);
  await expect(page.getByTestId('upload-center-collapsed')).toBeVisible();
});

test('圖片預覽不觸發收合', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('image preview must not collapse the panel');
  await openDrive((d) => {
    d.file('pic', { filename: 'pic.jpg', filesize: 1024, mime_type: 'image/jpeg', telegram_message_id: 502, access_hash: '50202' });
  });
  await dedupeAll(page, drive, new Map([['src-1', payload]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: payload },
  ]);
  await expect(page.getByTestId('upload-center')).toBeVisible();

  await page.getByText('pic.jpg').first().dblclick();
  await expect(page.getByTestId('upload-center')).toBeVisible();
});

test('窄螢幕改為底部 sheet，且不超出畫面', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('narrow viewport layout');
  await page.setViewportSize({ width: 390, height: 780 });
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', payload]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: payload },
  ]);

  const vp = page.viewportSize()!;
  const box = (await page.getByTestId('upload-center').boundingBox())!;
  // 精確釘住 8px 安全間距（>=8 連舊版被 maxWidth 夾出來的 358px 面板都會通過）。
  expect(box.x).toBeCloseTo(8, 0);
  expect(box.x + box.width).toBeCloseTo(vp.width - 8, 0);
  // 底部 sheet：貼齊底邊。
  expect(box.y + box.height).toBeCloseTo(vp.height, 0);
  // 60vh 上限直接讀 computed style，不依賴內容長到撐滿。
  const maxH = await page.getByTestId('upload-center').evaluate((el) => getComputedStyle(el).maxHeight);
  expect(maxH).toBe(`${Math.round(vp.height * 0.6)}px`);

  // 篩選與清除控制皆可鍵盤操作。
  await page.getByTestId('upload-filter-error').focus();
  await expect(page.getByTestId('upload-filter-error')).toBeFocused();
  await page.getByTestId('upload-center-clear').focus();
  await expect(page.getByTestId('upload-center-clear')).toBeFocused();
});

test('相同失敗檔案再次選取時直接轉為第 2 次嘗試，DOM 只有一列', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('this will fail once then succeed');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', payload]]));

  let failNext = true;
  await page.route('**/api/v1/files/register', async (route) => {
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '中繼資料寫入失敗' }) });
    }
    const body = route.request().postDataJSON();
    drive.file(body.file_id, {
      filename: body.filename, filesize: body.filesize, telegram_message_id: body.message_id,
      access_hash: body.access_hash ?? null, parent_id: body.parent_id ?? null, telegram_user_id: 42,
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(drive.get(body.file_id)) });
  });

  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles([{ name: 'retry.txt', mimeType: 'text/plain', buffer: payload }]);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('註冊失敗');

  await input.setInputFiles([{ name: 'retry.txt', mimeType: 'text/plain', buffer: payload }]);
  await expect(page.getByTestId('upload-center-error-badge')).toHaveCount(0);
  await expect(page.getByTestId('upload-center-title')).toContainText('1 / 1');
  // 這次重試成功，項目轉為完成，落入預設收合的完成組。不能沿用「重試後 rows 立刻
  // 等於 1」的斷言：合併成功到完成、完成組收合幾乎在同一個 requestAnimationFrame
  // 內發生（重繪節流見 lib/renderScheduler.ts），DOM 從沒有機會停留在「可見、
  // attempt=2」這個瞬間態，斷言只會一路重試到逾時、卡在 0——這正是本檔案第一個
  // 測試在 Ruling 18 之前踩到的同一個陷阱。展開完成組後再看，才能穩定證明「只有
  // 一列，而且標著第 2 次嘗試」——如果合併其實沒發生（形成了獨立的第二個項目），
  // 上面的 error-badge／title 斷言就會先失敗（會變成失敗 1、title 1 / 2），
  // 這裡則會多出一列。
  await page.getByTestId('upload-toggle-completed').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('第 2 次嘗試');
});

test('同名但內容不同的兩個檔案顯示兩列並各自更新', async ({ page, openDrive, drive }) => {
  const first = Buffer.from('same name, first content');
  const second = Buffer.from('same name, different content entirely');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', first], ['src-2', second]]));

  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles([{ name: 'dup.txt', mimeType: 'text/plain', buffer: first }]);
  await expect(page.getByTestId('upload-center-title')).toContainText('1 / 1');

  await input.setInputFiles([{ name: 'dup.txt', mimeType: 'text/plain', buffer: second }]);
  await expect(page.getByTestId('upload-center-title')).toContainText('2 / 2');
});

test('同一資料夾中內容相同、檔名不同的兩個檔案各自成列且都註冊成功', async ({ page, openDrive, drive }) => {
  const shared = Buffer.from('identical bytes under two names');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', shared]]));

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: shared },
    { name: 'beta.txt', mimeType: 'text/plain', buffer: shared },
  ]);

  await expect(page.getByTestId('upload-center-title')).toContainText('2 / 2');
  await page.getByTestId('upload-filter-complete').click();
  await expect(rows(page)).toHaveCount(2);
  // 兩份中繼資料都真的寫進了假後端。上面的 DOM 檢查只證明兩列各自渲染且完成，
  // 但列上顯示的檔名來自前端自己的 File 物件——就算後端存錯了也照樣顯示正確，
  // 所以還要核對後端真的存了什麼。直接讀 drive.rows（由 dedupeAll 的 register
  // 處理常式以 POST body 的 filename 寫入），不透過 UI 折射。也不用
  // drive.requests——dedupeAll 的 register 路由蓋過 fixtures.ts 的通用路由且
  // 沒有 fallback，那個陣列在本檔案任何走 dedupeAll 的測試裡永遠是空的。
  const texts = await rows(page).allTextContents();
  expect(texts.some((t) => t.includes('alpha.txt'))).toBe(true);
  expect(texts.some((t) => t.includes('beta.txt'))).toBe(true);
  const registeredNames = drive.rows
    .filter((r) => r.filename === 'alpha.txt' || r.filename === 'beta.txt')
    .map((r) => r.filename)
    .sort();
  expect(registeredNames).toEqual(['alpha.txt', 'beta.txt']);
});

test('清除已完成與失敗後，進行中的列仍存在', async ({ page, openDrive, drive }) => {
  const quick = Buffer.from('resolves immediately');
  const slow = Buffer.from('this lookup is deliberately slow');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', quick]]));

  // slow.txt 的 hash 查詢卡住，讓它一直停在進行中。
  await page.route('**/api/v1/files/check-hashes', async (route) => {
    const hashes = route.request().postDataJSON().hashes as string[];
    if (hashes.includes(fingerprint(slow))) await new Promise((r) => setTimeout(r, 15_000));
    const results: Record<string, unknown[]> = {};
    if (hashes.includes(fingerprint(quick))) results[fingerprint(quick)] = [drive.get('src-1')];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'quick.txt', mimeType: 'text/plain', buffer: quick },
    { name: 'slow.txt', mimeType: 'text/plain', buffer: slow },
  ]);

  await expect(page.getByTestId('upload-center-title')).toContainText('1 / 2');
  await page.getByTestId('upload-center-clear').click();
  await expect(page.getByTestId('upload-center-title')).toContainText('0 / 1');
  await page.getByTestId('upload-filter-active').click();
  await expect(rows(page).first()).toContainText('slow.txt');
});

test('新增失敗時透過單一摘要 live region 宣告，進度更新不進 live region', async ({ page, openDrive, drive }) => {
  const bad = Buffer.from('announce this failure');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-bad', bad]]));
  await failRegisterFor(page, ['bad.txt']);

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'bad.txt', mimeType: 'text/plain', buffer: bad },
  ]);

  const live = page.getByTestId('upload-live-region');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveText('1 個檔案上傳失敗');
  // 整個面板只有這一個 live region。Ruling 4：範圍不取整頁，而是取上傳中心與
  // live region 共同所在的可定位容器——ChonkyDrive 的 `drive-drop-zone` 根
  // 節點，它的 return 從第一個到最後一個 JSX 元素都在這個 div 底下（含
  // UploadCenter 的 fragment 與 Chonky 的 FileBrowser），所以 live region 與
  // 面板必定同屬這個子樹。已確認 Chonky 套件本身的 dist 沒有輸出任何
  // aria-live 節點，這個子樹縮小不會漏算，也不會因為選到不存在的容器而
  // 恆真地算出別的數字（selector 若打錯 testid，count() 會是 0，斷言仍會
  // 正確失敗，不會巧合地變成 1）。
  expect(await page.getByTestId('drive-drop-zone').locator('[aria-live]').count()).toBe(1);
});

test('面板是具名 region，篩選是可鍵盤操作的 tabs', async ({ page, openDrive, drive }) => {
  const payload = Buffer.from('accessibility surface');
  await openDrive();
  await dedupeAll(page, drive, new Map([['src-1', payload]]));
  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'note.txt', mimeType: 'text/plain', buffer: payload },
  ]);

  await expect(page.getByRole('region', { name: '上傳中心' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /失敗/ })).toBeVisible();
  await page.getByTestId('upload-filter-complete').press('Enter');
  await expect(page.getByTestId('upload-filter-complete')).toHaveAttribute('aria-selected', 'true');
});
