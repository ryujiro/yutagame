import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanArchive, fetchStudyArchive, parseArchivePage, summarizeStudy } from '../src/study-archive.js';
import { recentBalance } from '../src/balance.js';

const clock = () => Date.parse('2026-10-12T22:00:00+09:00');
const api = (date, minutes, cursor = null) => ({ response_data: { previous_studied_date: cursor,
  timelines: [{ date, elapsed_time: minutes, reports: [{ subject: 'MAT', elapsed_time: minutes }] }] } });
const source = 'https://m.smile-zemi.jp/api/chu/timeline/v2/daily-report/synthetic-child?days=7';
const record = (date, minutes) => ({ date, total_minutes: minutes, subjects: null, fetched_at: '2026-10-12T22:00:00+09:00' });
function fixture(next, requests = []) {
  let handler;
  return {
    async route(match, callback) { handler = callback; }, async unroute() { handler = null; },
    getByRole(role, options) {
      assert.equal(role, 'button'); assert.equal(options.name, 'もっと見る');
      return { async waitFor() {}, async click() {
        let url = source.replace('?days=7', '?before=20261005&days=7');
        if (handler) await handler({ request: () => ({ method: () => 'GET', url: () => url }), async fallback(options) { url = options?.url || url; } });
        requests.push(url);
      } };
    },
    async waitForResponse() {
      return { status: () => 200, json: next, request: () => ({ method: () => 'GET' }), url: () => source };
    },
  };
}

test('日別の実時間だけを抽出し、欠損・未来・不正カーソル・教科不一致を拒否', () => {
  assert.deepEqual(parseArchivePage(api('2026-10-12', 7), clock).records.map(r => r.total_minutes), [7]);
  for (const data of [api('2026-10-13', 1), api('2026-10-12', 1, '2026-10-12'),
    { response_data: { timelines: [] } }, api('2026-10-12', -1), api('2026-10-12', 1, '2026-02-30')]) {
    assert.throws(() => parseArchivePage(data, clock));
  }
  const bad = api('2026-10-12', 7); bad.response_data.timelines[0].reports[0].elapsed_time = 6;
  assert.throws(() => parseArchivePage(bad, clock));
  assert.throws(() => cleanArchive({ status: 'complete', cursor: '2026-10-01', checked_at: record('', 0).fetched_at }));
});

test('カーソルに従って終端まで取得し、秘密・識別子を結果に残さない', async () => {
  const pages = [], requests = [];
  const page = fixture(async () => api('2026-10-05', 10), requests);
  const result = await fetchStudyArchive(page, api('2026-10-12', 7, '2026-10-05'), source,
    { clock, onPage: async (records, scan) => pages.push({ records, scan }) });
  assert.equal(result.status, 'complete'); assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).search, '?before=20261005&days=7');
  assert.equal(pages.flatMap(p => p.records).reduce((sum, r) => sum + r.total_minutes, 0), 17);
  assert.ok(!JSON.stringify({ result, pages }).includes('synthetic-secret'));
  assert.ok(!JSON.stringify({ result, pages }).includes('synthetic-child'));
});

test('通信障害は取得済みを残し、次の更新で保存カーソルから続ける', async () => {
  const pages = []; let gets = 0;
  const fail = fixture(async () => { gets++; throw new Error('synthetic-secret'); });
  const partial = await fetchStudyArchive(fail, api('2026-10-12', 7, '2026-10-05'), source,
    { clock, onPage: async (records, scan) => pages.push({ records, scan }) });
  assert.equal(partial.status, 'error'); assert.equal(partial.cursor, '2026-10-05'); assert.equal(gets, 1);
  assert.equal(pages[0].records.length, 1); assert.ok(!JSON.stringify(pages).includes('synthetic-secret'));
  const requests = [], page = fixture(async () => api('2026-09-28', 10), requests);
  const resumed = await fetchStudyArchive(page, api('2026-10-12', 7, '2026-10-05'), source,
    { clock, resume: { ...partial, cursor: '2026-09-28' } });
  assert.equal(new URL(requests[0]).searchParams.get('before'), '20260928'); assert.equal(resumed.status, 'complete');
});

test('時間切れ・カーソル循環・危険な送信先は打ち切り、ゼロを補わない', async () => {
  let gets = 0;
  const page = fixture(async () => { gets++; return api('2026-10-05', 1, '2026-10-05'); });
  const first = api('2026-10-12', 7, '2026-10-05');
  assert.equal((await fetchStudyArchive(page, first, source, { clock, deadline: 0 })).status, 'partial');
  assert.equal(gets, 0);
  assert.equal((await fetchStudyArchive(page, first, 'https://untrusted.test/api/chu/timeline/v2/daily-report/id', { clock })).status, 'error');
  assert.equal(gets, 0);
  assert.equal((await fetchStudyArchive(page, first, source, { clock })).status, 'error'); assert.equal(gets, 1);
});

test('100日を超えても日ごと最新値を全件集計し、2日残高には過去を混ぜない', () => {
  const history = Array.from({ length: 150 }, (_, i) => record(new Date(clock() - i * 86400000).toISOString().slice(0, 10), 1));
  const data = summarizeStudy([...history, history[0]]);
  assert.equal(data.total_minutes, 150); assert.equal(data.recorded_days, 150); assert.equal(data.days.length, 150);
  assert.equal(data.months.reduce((sum, m) => sum + m.total_minutes, 0), 150);
  const ledger = { learning_history: data.days, grant_history: [], adjustment_history: [], integration_status: 'connected' };
  assert.equal(recentBalance(ledger, clock()).total_learning_minutes, 2);
  assert.equal(summarizeStudy([]).total_minutes, null);
  assert.equal(summarizeStudy([record('2026-10-12', 0)]).total_minutes, 0);
});
