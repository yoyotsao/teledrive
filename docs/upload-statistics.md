# Daily upload statistics

The top-right settings dialog has **管理帳號** and **統計** tabs. Statistics
show today's total, today's totals per account, and the last 30 calendar days.
Days use Asia/Taipei (UTC+8); GB is decimal. The panel refreshes every 10 seconds.

Counting starts with this feature; existing file metadata is not backfilled.
Successful browser upload parts contribute their byte length, including
thumbnails. The standalone small-file and album-fallback paths contribute after
their send succeeds. Failed part attempts do not increment the counter; another
actual upload of the same file does. Successfully uploaded parts of a file that
later fails still count. This measures acknowledged upload payload, not network
overhead, current storage size, or Telegram's daily quota. Server-side forwarding
and deduplication skips do not count.

Each browser tab keeps cumulative counters in localStorage, keyed by drive owner,
random stream ID, account and date. Pending reports survive reloads and are retried
while signed in. SQLite uses a MAX upsert, so retrying an acknowledged report or
recovering it from multiple tabs does not double-count. Rejected reports do not
block other accounts. Clearing browser storage before synchronization can discard
pending statistics. No file bytes are sent to the metadata backend.

The backend creates `upload_statistics` on startup. Restart the backend and serve
the updated frontend build together when deploying this change.

Automated checks:

```sh
# From frontend/
npm run build
npm run test:unit -- src/lib/uploadStatistics.test.ts src/lib/gramjsStatistics.test.ts
npx playwright test --config playwright.statistics.config.ts

# From the repository root, with backend test dependencies installed
python -m pytest backend/tests/test_upload_statistics.py backend/tests/test_api_authz.py
```

The statistics Playwright suite serves the built `frontend/dist` files through
browser request routing at localhost:3000, using isolated metadata fixtures. It
does not contact or restart any existing service listening there. Real Telegram
transfers are not part of this suite.
