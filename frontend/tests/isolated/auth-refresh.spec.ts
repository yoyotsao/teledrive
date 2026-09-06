import { expect, test } from '../support/fixtures.ts';

test('refreshes one expired JWT and retries the original metadata request', async ({ page, openDrive }) => {
  let refreshCalls = 0;
  let retriedWithFreshToken = false;

  // Registered after the fixture's in-memory API, so this handler gets first
  // refusal and falls through for every request unrelated to this scenario.
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const authorization = route.request().headers()['authorization'];

    if (path === '/auth/refresh') {
      refreshCalls += 1;
      expect(authorization).toBe('Bearer isolated-test-token');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'fresh-test-token' }),
      });
    }

    if (path === '/files' && authorization === 'Bearer isolated-test-token') {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Invalid or expired token' }),
      });
    }

    if (path === '/files' && authorization === 'Bearer fresh-test-token') {
      retriedWithFreshToken = true;
    }
    return route.fallback();
  });

  await openDrive();

  await expect.poll(() => refreshCalls).toBe(1);
  await expect.poll(() => retriedWithFreshToken).toBe(true);
  await expect(page.getByTestId('drive-drop-zone')).toBeVisible();
});
