from conftest import OWNER_A


def test_statistics_are_idempotent_and_owner_scoped(client, other_client, db, run):
    run(db.link_account(OWNER_A, OWNER_A, is_primary=True))
    row = dict(stream_id='tab-one', telegram_user_id=OWNER_A, day='2026-09-06', bytes=524288)
    assert client.post('/api/v1/statistics/uploads', json=row).status_code == 200
    assert client.post('/api/v1/statistics/uploads', json=row).status_code == 200
    row['bytes'] = 1048576
    assert client.post('/api/v1/statistics/uploads', json=row).status_code == 200
    row['bytes'] = 524288
    client.post('/api/v1/statistics/uploads', json=row)
    result = client.get('/api/v1/statistics/uploads?end=2026-09-06').json()
    assert result['days'][0]['bytes'] == 1048576
    assert result['accounts'][0]['bytes'] == 1048576
    assert other_client.get('/api/v1/statistics/uploads?end=2026-09-06').json()['days'][0]['bytes'] == 0
    assert other_client.post('/api/v1/statistics/uploads', json=row).status_code == 403


def test_statistics_sum_tabs_accounts_and_keep_days_separate(client, db, run):
    for account in [OWNER_A, 3003]:
        run(db.link_account(OWNER_A, account))
    for stream, account, day, size in [('a', OWNER_A, '2026-09-06', 100), ('b', OWNER_A, '2026-09-06', 200), ('a', 3003, '2026-09-06', 400), ('a', OWNER_A, '2026-09-05', 800)]:
        assert client.post('/api/v1/statistics/uploads', json=dict(stream_id=stream, telegram_user_id=account, day=day, bytes=size)).status_code == 200
    result = client.get('/api/v1/statistics/uploads?end=2026-09-06').json()
    assert [d['bytes'] for d in result['days'][:2]] == [700, 800]
    assert len(result['days']) == 30
    assert sum(a['bytes'] for a in result['accounts']) == 700


def test_statistics_require_auth_and_valid_input(client, anon_client):
    assert anon_client.get('/api/v1/statistics/uploads').status_code == 401
    assert anon_client.post('/api/v1/statistics/uploads', json={}).status_code == 401
    assert client.post('/api/v1/statistics/uploads', json=dict(stream_id='a', telegram_user_id=OWNER_A, day='bad-date', bytes=-1)).status_code == 422
