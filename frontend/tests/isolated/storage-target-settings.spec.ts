import { test, expect } from '../support/fixtures.ts';
import type { Page } from '@playwright/test';

type Account = { telegram_user_id: number; label: string; is_primary: number; file_count: number };
type Verification = { can_read: boolean; can_write: boolean; channel_title?: string; checked_at?: string };

type BackendState = {
  target: any;
  accounts: Account[];
  putBodies: any[];
  conflictOnce: boolean;
};

async function installStorageApi(page: Page, state: BackendState, verification: Record<number, Verification | { error: string }>) {
  await page.addInitScript(({ verification }) => {
    (window as any).__TELEDRIVE_STORAGE_TARGET_VERIFY__ = async (accountId: number) => {
      const row = (verification as any)[accountId];
      if (!row) throw new Error(`no verification for ${accountId}`);
      if (row.error) throw new Error(row.error);
      return { ...row, checked_at: row.checked_at ?? new Date().toISOString() };
    };
  }, { verification });

  await page.route('**/api/v1/storage-target', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.target) });
    }
    if (request.method() === 'PUT') {
      const body = JSON.parse(request.postData() || '{}');
      state.putBodies.push(body);
      if (state.conflictOnce) {
        state.conflictOnce = false;
        state.target = { ...state.target, version: state.target.version + 1 };
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Storage target changed' }) });
      }
      state.target = {
        storage_mode: body.storage_mode,
        channel_id: body.storage_mode === 'channel' ? body.channel_id : null,
        channel_title: body.storage_mode === 'channel' ? (body.channel_title ?? null) : null,
        version: state.target.version + 1,
        accounts_version: state.target.accounts_version,
        verifications: body.verifications ?? [],
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.target) });
    }
    return route.fallback();
  });

  await page.route('**/api/v1/accounts', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts: state.accounts }) });
    }
    return route.fallback();
  });
}

async function openStorage(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '登出' })).toBeVisible();
  await page.getByTitle('設定 / Telegram 帳號').click();
  await page.getByRole('tab', { name: '儲存位置' }).click();
  await expect(page.getByTestId('storage-target-settings')).toBeVisible();
}

function initialState(): BackendState {
  return {
    target: { storage_mode: 'saved_messages', channel_id: null, channel_title: null, version: 2, accounts_version: 5, verifications: [] },
    accounts: [
      { telegram_user_id: 42, label: 'primary', is_primary: 1, file_count: 0 },
      { telegram_user_id: 77, label: 'secondary', is_primary: 0, file_count: 0 },
    ],
    putBodies: [],
    conflictOnce: false,
  };
}

async function chooseChannel(page: Page, value: string) {
  await page.getByLabel('共用私人 broadcast channel').check();
  await page.getByLabel('Canonical raw channel ID').fill(value);
}

test('rejects marked/non-canonical channel ids before save', async ({ page }) => {
  const state = initialState();
  await installStorageApi(page, state, { 42: { can_read: true, can_write: true }, 77: { can_read: true, can_write: true } });
  await openStorage(page);
  await chooseChannel(page, '-100123456789');
  await page.getByTestId('save-storage-target').click();
  await expect(page.getByRole('alert')).toContainText('Invalid Telegram channel ID');
  expect(state.putBodies).toHaveLength(0);
});

test('requires a fresh verification from every linked account', async ({ page }) => {
  const state = initialState();
  await installStorageApi(page, state, { 42: { can_read: true, can_write: true }, 77: { error: 'secondary offline' } });
  await openStorage(page);
  await chooseChannel(page, '123456789');
  await page.getByTestId('save-storage-target').click();
  await expect(page.getByRole('alert')).toContainText('所有目前連結的帳號都必須完成驗證');
  expect(state.putBodies).toHaveLength(0);
});

test('fails closed when any linked account lacks read or write access', async ({ page }) => {
  const state = initialState();
  await installStorageApi(page, state, { 42: { can_read: true, can_write: true }, 77: { can_read: true, can_write: false } });
  await openStorage(page);
  await chooseChannel(page, '123456789');
  await page.getByRole('button', { name: '驗證所有帳號' }).click();
  await expect(page.getByTestId('storage-live-status')).toContainText('降級');
  await page.getByTestId('save-storage-target').click();
  await expect(page.getByRole('alert')).toContainText('read/write 權限');
  await expect(page.getByTestId('storage-live-status')).toContainText('不會 fallback 到 Saved Messages');
});

test('refetches on CAS conflict and requires a new verification attempt', async ({ page }) => {
  const state = initialState();
  state.conflictOnce = true;
  await installStorageApi(page, state, { 42: { can_read: true, can_write: true }, 77: { can_read: true, can_write: true } });
  await openStorage(page);
  await chooseChannel(page, '123456789');
  await page.getByTestId('save-storage-target').click();
  await expect(page.getByRole('alert')).toContainText('已重新整理');
  expect(state.putBodies[0].expected_version).toBe(2);
  await chooseChannel(page, '123456789');
  await page.getByTestId('save-storage-target').click();
  await expect(page.getByRole('status')).toContainText('已啟用');
  expect(state.putBodies[1].expected_version).toBe(3);
});

test('enables a verified channel then saves back to Saved Messages without channel evidence', async ({ page }) => {
  const state = initialState();
  await installStorageApi(page, state, { 42: { can_read: true, can_write: true, channel_title: 'Storage' }, 77: { can_read: true, can_write: true, channel_title: 'Storage' } });
  await openStorage(page);
  await chooseChannel(page, '123456789');
  await page.getByTestId('save-storage-target').click();
  await expect(page.getByRole('status')).toContainText('共用儲存頻道已啟用');
  expect(state.putBodies[0]).toMatchObject({
    storage_mode: 'channel', channel_id: '123456789', expected_version: 2, expected_accounts_version: 5,
  });
  expect(state.putBodies[0].verifications).toHaveLength(2);

  await page.getByLabel('Saved Messages').check();
  await page.getByTestId('save-storage-target').click();
  await expect(page.getByRole('status')).toContainText('Saved Messages');
  expect(state.putBodies[1]).toMatchObject({ storage_mode: 'saved_messages', verifications: [] });
});
