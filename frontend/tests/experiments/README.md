# Experiments

Benchmarks and investigation harnesses, not tests. Nothing here asserts a
property the product must keep, so no project in `playwright.config.ts` collects
this directory and no runner picks it up. They live behind their own config
instead.

They exist because the upload path's real constraints — Telegram's account-level
`SaveFilePart` rate limit, dedup avoiding MTProto traffic entirely — are only
visible under load against the live account. Keep them working; just don't let
them gate a commit.

| File | What it measures |
|---|---|
| `upload-perf.spec.ts` | Throughput while dropping N synthetic files. Tunable with `PERF_FILE_COUNT`, `PERF_FILE_KB`, `PERF_DURATION_S`. |
| `generate_test_files.py` | Produces real files on disk for the runs that need them rather than synthetic blobs. |

Run one explicitly, from `frontend/`:

```bash
npx playwright test --config=playwright.experiments.config.ts
PERF_FILE_COUNT=100 npx playwright test --config=playwright.experiments.config.ts upload-perf
```

They reuse the session the smoke suite caches, so run `npm run test:e2e:smoke`
at least once first to produce `tests/smoke/storageState.json`.
