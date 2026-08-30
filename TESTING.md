# Testing TeleDrive

Four layers, ordered by what they cost to run. The first three are the default
suite: no Telegram account, no network, nothing left behind. The fourth talks to
the live site and is opt-in.

```
node scripts/run-tests.mjs           # layers 0–2, ~45s
node scripts/run-tests.mjs --smoke   # …and layer 3
```

| Layer | Where | What it proves | Cost |
|---|---|---|---|
| 0 · unit | `frontend/src/lib/*.test.ts` (Vitest) | Pure logic: segment planning, dedup canonicalisation, chunk assembly, the upload pacer, QR expiry, chat import | ~27s, no browser |
| 1 · API | `backend/tests/` (pytest) | All 26 endpoints: auth, ownership isolation, listing, trash, folders, dedup, download coordinates | ~5s, temp SQLite |
| 2 · UI | `frontend/tests/isolated/` (Playwright) | The file browser against an in-memory backend: navigation, sort, search, rename, move, trash, URL state, session | ~10s, headless Chromium |
| 3 · smoke | `frontend/tests/smoke/` (Playwright, `@real`) | The live site with a real Telegram session: upload, thumbnails, preview, video streaming, dedup | minutes, needs a login |

Anything that needs real MTProto lives in layer 3 and **only** there. That is the
deliberate boundary: layers 0–2 are cheap because they never touch Telegram, and
layer 3 exists because nothing else can prove bytes actually move.

## Running one layer

```bash
node scripts/run-tests.mjs --only=backend    # or unit / ui / smoke

cd backend  && python -m pytest              # -k name, -x, --tb=long all work
cd frontend && npm run test:unit             # npm run test:unit:watch
cd frontend && npm run test:e2e              # npm run test:e2e:ui for the picker
cd frontend && npm run test:e2e:smoke        # opens a login window the first time
cd frontend && npm run test:e2e:report       # last Playwright HTML report
```

`PYTHON=py -3.11 node scripts/run-tests.mjs` picks a different interpreter.

## Layer 1 — backend (pytest)

`backend/tests/conftest.py` does three things, in this order, and the order
matters:

1. **Fixes the environment before importing `app.*`.** `database.DB_PATH` is read
   from `TELEDRIVE_DB_PATH` at import time and `Settings` falls back to the real
   `../.env`. Get this wrong and a test run writes to the production SQLite file
   with production credentials loaded.
2. **Runs coroutines on one shared event loop.** No `pytest-asyncio` dependency:
   a `pytest_pyfunc_call` hook drives `async def` tests, and helpers use
   `_await_or_run`, so `make_file(...)` in a sync test is `await make_file(...)`
   in an async one.
3. **Makes the network unreachable.** The metadata backend has no Telegram user
   client. An autouse fixture turns any accidental outbound HTTP call into a
   failed assertion, so Bot-API polling cannot quietly escape a test either.

Fixtures worth knowing:

| Fixture | What you get |
|---|---|
| `client` / `other_client` / `anon_client` | TestClients for drive A, drive B, and no token. Real JWTs, so `get_current_user` is under test too |
| `db`, `file_service` | A fresh temp SQLite per test, wired into the singletons |
| `make_file(...)` | One row straight into the DB — the setup shortcut for listing/trash/ownership tests |
| `bot_login` | Drives the login challenge without a bot: `bot_login.deliver(nonce, user_id)` |

`test_api_authz.py` enumerates the router at runtime, so **an endpoint added
without `Depends(get_current_user)` fails the suite** even though nobody wrote a
test for it. Making one public on purpose means adding it to `PUBLIC_PATHS`,
which a reviewer sees in the diff.

Dependencies: `pip install -r backend/requirements.txt -r backend/requirements-dev.txt`.

## Layer 2 — isolated UI (Playwright)

`frontend/tests/support/` holds the harness:

- `fakeDrive.ts` — an in-memory replica of the backend's **rules**, not just its
  shapes. `/files` at a folder returns files only; search spans the drive and
  includes folders; the trash lists roots only; a split file appears once. A
  looser fake would let UI tests pass on behaviour the app never actually sees.
- `fixtures.ts` — extends `test` with `drive` (the fake) and `openDrive(seed)`.
  It seeds a signed-in `localStorage`, routes `/api/v1` to the fake, and cuts
  every route out of the machine, WebSockets included — GramJS reaches Telegram
  over a WebSocket, which `page.route()` does not intercept.

```ts
test('shows what is in the folder', async ({ page, openDrive }) => {
  await openDrive((drive) => {
    drive.folder('f1', { filename: 'Photos' });
    drive.file('a', { filename: 'notes.txt' });
  });

  await expect(card(page, 'notes.txt')).toBeVisible();
});
```

`drive.requests` records every call, so a test can assert what the UI *asked
for* — e.g. that changing the sort re-queries the server instead of reordering a
stale page, or that a rename sends `{filename}` and not `{filename, parent_id}`
(which would silently move the file to the root).

Selectors come from three `data-testid`s in the app — `drive-drop-zone`,
`drive-scroll`, `context-menu` — plus `data-file-card` / `data-file-id` on each
card. Prefer those over text where a label is repeated in the sidebar or toolbar.

## Layer 3 — smoke (`@real`)

Runs against `https://teledrive.yoyotsaoteledrive.dpdns.org` (override with
`TELEDRIVE_URL`). Login is a Telegram bot challenge and cannot be automated, so
the `auth` setup project opens a visible Chrome window the first time and caches
the session in `frontend/tests/smoke/storageState.json` (git-ignored).

Start with `drive.spec.ts`: it is metadata-only, costs no upload quota, cannot
trip FLOOD_WAIT, and cleans up after itself even on failure. The media specs are
the expensive ones.

## Not tests: `frontend/tests/experiments/`

Benchmarks for the upload path, behind their own config so nothing collects them
by accident. See that directory's README.

## Known failures

`folders-and-editing.spec.ts` marks one test `test.fail()`: dragging a file onto
the breadcrumb to move it up a level does nothing. The breadcrumb only renders
while nothing is selected, but `handleFileDragStart` selects the dragged card —
so starting the drag is what unmounts the drop target. The test asserts the
intended behaviour, so fixing the app turns it into an unexpected pass and
whoever fixes it removes the marker.
