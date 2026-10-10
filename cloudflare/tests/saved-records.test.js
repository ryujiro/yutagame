import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSavedData, savedDashboard } from '../src/saved-records.js';
import worker from '../src/index.js';
import bundled from '../../public-data/dashboard.json' with { type: 'json' };

const fallback = bundled.history[0];

const record = { date: '2026-10-10', total_minutes: 7, subjects: { 数学: 7 }, fetched_at: '2026-10-10T19:00:00+09:00' };
const source = { history: [record], last_attempt: record.fetched_at, collection_status: 'passed' };
const env = { RECORDS_URL: 'https://raw.githubusercontent.com/example/repo/main/public-data/dashboard.json' };
const now = () => Date.parse('2026-10-10T19:30:00+09:00');

test('公開JSONから新しい記録を読み、取得日時を読み込み時刻に置き換えない', async () => {
  const data = await savedDashboard(env, async () => Response.json(source), now);
  assert.deepEqual(data.record, record);
  assert.equal(data.refresh_mode, 'saved_records');
  assert.equal(data.last_collection_attempt, record.fetched_at);
  assert.equal(data.retry_after_seconds, 0);
});
test('最新確認失敗でも実取得済み記録を保持し、例外やCookieを応答に含めない', async () => {
  const data = await savedDashboard(env, async () => { throw new Error('Cookie=synthetic-private-token'); }, now);
  assert.deepEqual(data.record, fallback);
  assert.ok(data.error);
  assert.ok(!JSON.stringify(data).includes('synthetic-private-token'));
});
test('不一致の合計・教科と過大な応答を受理しない', async () => {
  for (const body of [JSON.stringify({ ...source, history: [{ ...record, total_minutes: 8 }] }), ' '.repeat(150001)]) {
    const data = await savedDashboard(env, async () => new Response(body), now);
    assert.deepEqual(data.record, fallback);
    assert.ok(data.error);
  }
});
test('CDNの古い記録で同梱記録を巻き戻さない', async () => {
  const old = { ...source, last_attempt: '2026-10-10T15:00:00+09:00', history: [{ ...record, fetched_at: '2026-10-10T15:00:00+09:00' }] };
  assert.deepEqual((await savedDashboard(env, async () => Response.json(old), now)).record, fallback);
});
test('公開記録・取得状態に余計な認証情報を残さない', () => {
  const clean = cleanSavedData({ ...source, ticket: 'synthetic-token', failure_stage: 'synthetic-token', history: [{ ...record, password: 'synthetic-secret' }] });
  assert.ok(!JSON.stringify(clean).includes('synthetic'));
});
test('日付の日本時間判定とnull教科、空記録を保持する', async () => {
  const data = await savedDashboard(env, async () => Response.json({ ...source, history: [{ ...record, subjects: null }] }), () => Date.parse('2026-10-10T15:00:00Z'));
  assert.equal(data.today, '2026-10-11');
  assert.equal(data.record.date, '2026-10-10');
  assert.equal(data.record.subjects, null);
  assert.equal((await savedDashboard(env, async () => Response.json({ ...source, history: [] }), now)).record, null);
});
test('未知の取得先は呼び出さず、HTTPS公開GitHub JSONに限定する', async () => {
  let calls = 0;
  for (const url of ['http://raw.githubusercontent.com/file', 'https://example.com/file', 'https://token@raw.githubusercontent.com/file', 'https://raw.githubusercontent.com/file?token=x']) {
    assert.ok((await savedDashboard({ RECORDS_URL: url }, () => { calls++; }, now)).error);
  }
  assert.equal(calls, 0);
});
test('無料WorkerはPOSTでログインせず、healthと画面を提供する', async () => {
  const env = { ASSETS: { fetch: async () => new Response('<html>fixture</html>') } };
  const health = await worker.fetch(new Request('https://fixture.test/api/health'), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, 'saved_records');
  assert.equal((await worker.fetch(new Request('https://fixture.test/api/refresh', { method: 'POST' }), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://fixture.test'), env)).status, 200);
});
