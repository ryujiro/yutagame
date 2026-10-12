import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRecord, todayJst, isoJst, minutes, parseTimeline, equalRecords, extractToday, errorMessage, LearningError, STAGES } from '../src/learning.js';
import { LearningService } from '../src/service.js';

const NOW = Date.parse('2026-10-10T18:00:00+09:00');
// 合成データはテスト用。本番はverification-resultsの実取得記録を読む。
const RECORD = { date: '2026-10-10', total_minutes: 7, subjects: { 数学: 7 }, fetched_at: '2026-10-10T18:00:00+09:00' };
const SEED = { ...RECORD, fetched_at: '2026-10-10T16:00:00+09:00' };
const ENV = { SMILE_ZEMI_LOGIN_ID: 'unit-test-id', SMILE_ZEMI_PASSWORD: 'unit-test-password' };
const storage = () => {
  let saved;
  return { async get() { return structuredClone(saved); }, async put(_, value) { saved = structuredClone(value); } };
};
async function service(options = {}) {
  const instance = new LearningService(options.storage || storage(), options.env || ENV, SEED,
    options.fetcher || (async (_, progress) => { for (const s of STAGES) progress[s] = 'passed'; return RECORD; }),
    options.clock || (() => NOW));
  await instance.initialize();
  return instance;
}

test('日本時間の深夜境界と取得日時', () => {
  assert.equal(todayJst(Date.parse('2026-10-10T15:00:00Z')), '2026-10-11');
  assert.equal(todayJst(Date.parse('2026-10-10T14:59:59Z')), '2026-10-10');
  assert.equal(isoJst(NOW), RECORD.fetched_at);
});
test('時間表記を厳密に読む', () => {
  assert.equal(minutes('１時間 ２分'), 62);
  assert.equal(minutes('合計学習時間：7分'), 7);
  for (const invalid of ['-1分', '7', '7分 8分', '約7分']) assert.throws(() => minutes(invalid));
});
test('未知教科・負数・bool・合計不一致を拒否', () => {
  for (const record of [{ ...RECORD, total_minutes: true }, { ...RECORD, total_minutes: -1 }, { ...RECORD, subjects: { 数学: 1 } }, { ...RECORD, subjects: { unknown: 7 } }]) assert.throws(() => cleanRecord(record));
});
test('存在しない日付とタイムゾーンなし日時を拒否', () => {
  assert.throws(() => cleanRecord({ ...RECORD, date: '2026-02-30' }));
  assert.throws(() => cleanRecord({ ...RECORD, fetched_at: '2026-10-10T18:00:00' }));
});
test('null教科を保持、余計な情報を除外', () => {
  const sanitized = cleanRecord({ ...RECORD, subjects: null, ticket: 'synthetic-not-a-real-token', childName: 'synthetic-name' });
  assert.equal(sanitized.subjects, null);
  assert.deepEqual(Object.keys(sanitized).sort(), ['date', 'fetched_at', 'subjects', 'total_minutes']);
});
test('正規APIから日付・分数・教科だけ読む', () => {
  const result = parseTimeline({ response_data: { timelines: [{ date: RECORD.date, elapsed_time: 7, reports: [{ subject: 'MAT', elapsed_time: 7 }], childName: 'synthetic' }] } });
  assert.deepEqual(result, [{ date: RECORD.date, total_minutes: 7, subjects: { 数学: 7 } }]);
});
test('APIの重複日付・未知教科・重複教科を拒否', () => {
  const row = { date: RECORD.date, elapsed_time: 7, reports: [{ subject: 'MAT', elapsed_time: 7 }] };
  assert.throws(() => parseTimeline({ response_data: { timelines: [row, row] } }));
  assert.throws(() => parseTimeline({ response_data: { timelines: [{ ...row, reports: [{ subject: 'UNKNOWN', elapsed_time: 7 }] }] } }));
  assert.throws(() => parseTimeline({ response_data: { timelines: [{ ...row, elapsed_time: 14, reports: [row.reports[0], row.reports[0]] }] } }));
});
test('教科の順序が違っても照合、分数の違いを検出', () => {
  assert.ok(equalRecords({ ...RECORD, subjects: { 数学: 2, 国語: 5 } }, { ...RECORD, subjects: { 国語: 5, 数学: 2 } }));
  assert.ok(!equalRecords(RECORD, { ...RECORD, total_minutes: 8 }));
  assert.ok(!equalRecords(RECORD, { ...RECORD, subjects: null }));
});
test('初期GETは認証しない、元の取得日時を保持', async () => {
  const instance = await service({ fetcher: () => { throw new Error('unexpected_login'); } });
  assert.equal(instance.snapshot().record.fetched_at, SEED.fetched_at);
  assert.equal(instance.snapshot().history.length, 1);
});
test('成功・履歴・再起動後の待ち時間と連打を検証', async () => {
  const disk = storage();
  const instance = await service({ storage: disk });
  const [status, response] = await instance.refresh();
  assert.equal(status, 200);
  assert.deepEqual(response.record, RECORD);
  assert.equal(response.history.length, 2);
  assert.equal(response.refreshing, false);
  const restored = await service({ storage: disk });
  assert.equal((await restored.refresh())[0], 429);
  assert.deepEqual(restored.snapshot().record, RECORD);
});
test('認証失敗時は前回値を保持し自動再試行しない', async () => {
  let calls = 0;
  const disk = storage();
  const instance = await service({ storage: disk, fetcher: async () => { calls++; throw new LearningError('authentication', 'login_rejected'); } });
  const [status, response] = await instance.refresh();
  assert.equal(status, 502);
  assert.deepEqual(response.record, SEED);
  assert.equal(response.verification_stages.authentication, 'failed');
  assert.equal((await instance.refresh())[0], 429);
  assert.equal(calls, 1);
  assert.equal((await service({ storage: disk })).snapshot().error.stage, 'authentication');
});
test('同時更新は取得を1回に制限', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const instance = await service({ fetcher: async () => { entered(); await gate; return RECORD; } });
  const first = instance.refresh();
  await started;
  assert.equal((await instance.refresh())[0], 409);
  assert.ok(instance.snapshot().refreshing);
  release();
  assert.equal((await first)[0], 200);
});
test('未設定ならログインしない', async () => {
  let called = false;
  const instance = await service({ env: {}, fetcher: () => { called = true; } });
  const [status, response] = await instance.refresh();
  assert.equal(status, 503);
  assert.equal(called, false);
  assert.equal(response.missing_environment_variables.length, 2);
});
test('例外文字列を応答や保存に含めない', async () => {
  const disk = storage();
  const instance = await service({ storage: disk, fetcher: () => { throw new Error('unit-test-password Cookie=synthetic-token'); } });
  const [, response] = await instance.refresh();
  for (const text of [JSON.stringify(response), JSON.stringify(await disk.get())]) {
    assert.ok(!text.includes('unit-test-password')); assert.ok(!text.includes('synthetic-token'));
  }
});
test('今日以外の結果を受理しない', async () => {
  const instance = await service({ fetcher: async () => ({ ...RECORD, date: '2026-10-09' }) });
  assert.equal((await instance.refresh())[0], 502);
  assert.deepEqual(instance.snapshot().record, SEED);
});
test('保存できない場合は認証前に止める', async () => {
  let called = false;
  const instance = await service({ storage: { get: async () => null, put: async () => { throw new Error('storage'); } }, fetcher: () => { called = true; } });
  const [status, response] = await instance.refresh();
  assert.equal(status, 503); assert.equal(called, false); assert.equal(response.error.stage, 'storage');
  assert.equal(response.refreshing, false); assert.equal(instance.busy, false);
});

test('日付変更後の記録なしと重複を区別し、DOMや0分にフォールバックしない', async () => {
  await assert.rejects(extractToday(null, [RECORD], '2026-10-11'), { code: 'today_record_missing' });
  await assert.rejects(extractToday(null, [RECORD, RECORD], RECORD.date), { code: 'today_record_missing_or_ambiguous' });
});

test('今日の記録なしは前回値・取得日時を保持し、診断を再起動後にも復元', async () => {
  const disk = storage();
  const instance = await service({ storage: disk, fetcher: async (_, progress) => {
    for (const s of STAGES.slice(0, -1)) progress[s] = 'passed';
    throw new LearningError('extraction', 'today_record_missing');
  } });
  const [status, response] = await instance.refresh();
  assert.equal(status, 502); // 今日の分数を取得できたとは返さない。
  assert.deepEqual(response.record, SEED);
  assert.equal(response.history.length, 1);
  assert.equal(response.last_attempt_at, isoJst(NOW));
  assert.equal(response.error.code, 'today_record_missing');
  assert.equal(response.verification_stages.authentication, 'passed');
  assert.equal(response.verification_stages.extraction, 'failed');
  const restored = await service({ storage: disk });
  assert.deepEqual(restored.snapshot().error, response.error);
  assert.deepEqual(restored.snapshot().record, SEED);
});

test('旧形式の保存エラーを読めて、未知の診断文字列や秘密は保存・出力しない', async () => {
  const disk = storage();
  const { code, ...legacy } = errorMessage('fetch_failed', 'connection');
  await disk.put('dashboard', { history: [SEED], lastAttempt: null, error: legacy });
  const instance = await service({ storage: disk, fetcher: async () => {
    throw new LearningError('extraction', 'unit-test-password Cookie=synthetic-token');
  } });
  assert.equal(instance.snapshot().error.code, 'fetch_failed');
  const [, response] = await instance.refresh();
  assert.equal(response.error.code, 'fetch_failed');
  for (const value of [response, await disk.get()]) {
    assert.ok(!JSON.stringify(value).includes('unit-test-password'));
    assert.ok(!JSON.stringify(value).includes('synthetic-token'));
  }
});
