from pathlib import Path

p = Path('frontend/tests/isolated/storage-migration.spec.ts')
text = p.read_text(encoding='utf-8')

anchor = '''  const operations = new Map<string, any>();\n  const logs: RequestLog[] = [];\n\n  await page.route('**/api/v1/**', async route => {\n'''
replacement = '''  const operations = new Map<string, any>();\n  const logs: RequestLog[] = [];\n\n  await page.route('**/api/v1/accounts', route => route.fulfill({\n    status: 200,\n    contentType: 'application/json',\n    body: JSON.stringify({ accounts: [\n      { telegram_user_id: 42, label: 'primary', is_primary: 1, file_count: 1 },\n      { telegram_user_id: 77, label: 'secondary', is_primary: 0, file_count: 0 },\n    ] }),\n  }));\n  await page.route('**/api/v1/storage-target', route => route.fulfill({\n    status: 200,\n    contentType: 'application/json',\n    body: JSON.stringify({\n      storage_mode: 'channel', channel_id: '123456789', channel_title: 'Storage',\n      version: 3, accounts_version: 2, verifications: [],\n    }),\n  }));\n\n  await page.route('**/api/v1/**', async route => {\n'''
if anchor not in text:
    raise SystemExit('Task 16 migration API anchor not found')
text = text.replace(anchor, replacement, 1)

for old, new in [
    ("test('feature-gated maintenance page creates a dry-run without Telegram writes', async ({ page }) => {\n",
     "test('feature-gated maintenance page creates a dry-run without Telegram writes', async ({ page, openDrive }) => {\n"),
    ("test('migration forwards only from the frozen source account and stores two independent reader evidences', async ({ page }) => {\n",
     "test('migration forwards only from the frozen source account and stores two independent reader evidences', async ({ page, openDrive }) => {\n"),
    ("test('uncertain reload recovery reuses the persisted operation/random id and never blindly forwards again', async ({ page }) => {\n",
     "test('uncertain reload recovery reuses the persisted operation/random id and never blindly forwards again', async ({ page, openDrive }) => {\n"),
    ("test('applied migration exposes rollback and uses location-version CAS metadata only', async ({ page }) => {\n",
     "test('applied migration exposes rollback and uses location-version CAS metadata only', async ({ page, openDrive }) => {\n"),
]:
    if old not in text:
        raise SystemExit(f'Task 16 test signature not found: {old}')
    text = text.replace(old, new, 1)

# Activate the existing signed-in isolated fixture before switching to the
# maintenance pathname. Keep the custom migration routes installed first so
# they override only the endpoints this spec owns.
needles = [
    "  const backend = await installMigrationApi(page);\n  await openMigration(page);",
    "  const backend = await installMigrationApi(page, [job]);\n  await openMigration(page);",
    "  backend.operations.set(operationId, {",
    "  const backend = await installMigrationApi(page, [makeJob({ state: 'completed', version: 6, items: [appliedItem] })]);\n  await openMigration(page);",
]
text = text.replace(needles[0], "  const backend = await installMigrationApi(page);\n  await openDrive();\n  await openMigration(page);", 1)
text = text.replace(needles[1], "  const backend = await installMigrationApi(page, [job]);\n  await openDrive();\n  await openMigration(page);", 1)
# The uncertain case needs openDrive after the operation fixture is seeded.
uncertain_open = "  });\n\n  await openMigration(page);\n  await page.reload();"
if uncertain_open not in text:
    raise SystemExit('Task 16 uncertain open anchor not found')
text = text.replace(uncertain_open, "  });\n\n  await openDrive();\n  await openMigration(page);\n  await page.reload();", 1)
text = text.replace(needles[3], "  const backend = await installMigrationApi(page, [makeJob({ state: 'completed', version: 6, items: [appliedItem] })]);\n  await openDrive();\n  await openMigration(page);", 1)

p.write_text(text, encoding='utf-8')

# Make the shared fake account list configurable for future migration specs
# without changing the default behavior of existing isolated tests.
fake = Path('frontend/tests/support/fakeDrive.ts')
fake_text = fake.read_text(encoding='utf-8')
class_anchor = '''export class FakeDrive {\n  rows: Row[] = [];\n  requests: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];\n'''
class_replacement = '''export class FakeDrive {\n  rows: Row[] = [];\n  accounts: Array<{ telegram_user_id: number; label: string; is_primary: number; file_count: number }> = [\n    { telegram_user_id: 42, label: 'test', is_primary: 1, file_count: 0 },\n  ];\n  requests: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];\n'''
if class_anchor in fake_text:
    fake.write_text(fake_text.replace(class_anchor, class_replacement, 1), encoding='utf-8')

fixtures = Path('frontend/tests/support/fixtures.ts')
fixtures_text = fixtures.read_text(encoding='utf-8')
old_accounts = '''    if (method === 'GET' && path === '/accounts') {\n      return json({ accounts: [{ telegram_user_id: ACCOUNT_ID, label: 'test', is_primary: 1, file_count: drive.rows.length }] });\n    }\n'''
new_accounts = '''    if (method === 'GET' && path === '/accounts') {\n      return json({ accounts: drive.accounts.map((account) => ({\n        ...account,\n        file_count: account.telegram_user_id === ACCOUNT_ID ? drive.rows.length : account.file_count,\n      })) });\n    }\n'''
if old_accounts in fixtures_text:
    fixtures.write_text(fixtures_text.replace(old_accounts, new_accounts, 1), encoding='utf-8')
