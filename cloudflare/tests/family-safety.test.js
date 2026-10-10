import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { cleanGrant, ingestGrant, confirmGrant, ledgerDashboard, authorized, ingestStatus } from '../src/family-safety.js';
import worker from '../src/index.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_family_safety.sql',import.meta.url),'utf8'));
  return {
    prepare(sql) { const statement = sqlite.prepare(sql); let params = []; return { bind(...args) { params=args; return this; },
      async run() { return statement.run(...params); }, async first() { return statement.get(...params) || null; }, async all() { return { results: statement.all(...params) }; } }; },
    async batch(statements) { sqlite.exec('BEGIN'); try { const rows=await Promise.all(statements.map(s => s.run())); sqlite.exec('COMMIT'); return rows; } catch(e) { sqlite.exec('ROLLBACK'); throw e; } },
    close() { sqlite.close(); },
  };
}
const now = Date.parse('2026-10-10T20:00:00+09:00');
const source = '00000000-0000-0000-0000-000000000001';
const event = (n,amount,hour) => ({ event_id:String(n).padStart(64,'0'),source_id:source,subject_id:'child-1',
  occurred_at:`2026-10-10T${hour}:00:00+09:00`,allow_until:`2026-10-10T${hour}:30:00+09:00`,observed_at:'2026-10-10T20:00:00+09:00',
  source:'windows_wpc_policy',detection_method:'explicit_allow_until_deadline',estimated_minutes:amount });
const learning = [
  {date:'2026-10-10',total_minutes:162,fetched_at:'2026-10-10T16:00:00+09:00',subjects:null},
  {date:'2026-10-10',total_minutes:198,fetched_at:'2026-10-10T18:00:00+09:00',subjects:null},
];
test('複数回の付与と再送を重複なく保存し、未確認分を残高に混ぜない',async () => {
  const db=database();
  for (const e of [event(1,15,'10'),event(2,30,'13'),event(3,60,'17')]) { await ingestGrant(db,e,now); await ingestGrant(db,e,now); }
  await ingestStatus(db,{source_id:source,checked_at:new Date(now).toISOString(),read_status:'ok'},now);
  let ledger=await ledgerDashboard(db,learning,now);
  assert.equal(ledger.grant_history.length,3); assert.equal(ledger.pending_count,3);
  assert.equal(ledger.total_learning_minutes,198); assert.equal(ledger.total_granted_minutes,0); assert.equal(ledger.balance_minutes,null);
  for (const [n,amount] of [[1,15],[2,30],[3,60]]) { await confirmGrant(db,String(n).padStart(64,'0'),{granted_minutes:amount,method:'parent_verified_selected_minutes'},now); }
  ledger=await ledgerDashboard(db,learning,now);
  assert.equal(ledger.total_granted_minutes,105); assert.equal(ledger.balance_minutes,93);
  assert.equal((await confirmGrant(db,event(1,15,'10').event_id,{granted_minutes:20,method:'parent_verified_selected_minutes'},now))[0],409);
  db.close();
});
test('古い再送は日別学習を巻き戻さず、翌日も残高を持ち越す',async () => {
  const db=database(); await ledgerDashboard(db,learning,now);
  const ledger=await ledgerDashboard(db,[learning[0]],now+86400000);
  assert.equal(ledger.total_learning_minutes,198); assert.equal(ledger.today_learning_minutes,null);
  assert.equal(ledger.confirmed_balance_minutes,198); db.close();
});
test('同じ識別番号で違う期限が届いたら二重登録せず競合を報告する',async () => {
  const db=database(), e=event(1,15,'10'); await ingestGrant(db,e,now);
  assert.equal((await ingestGrant(db,{...e,allow_until:'2026-10-10T11:00:00+09:00'},now))[0],409);
  assert.equal((await ledgerDashboard(db,[],now)).grant_history.length,1); db.close();
});
test('PCから確定分数や認証情報を送れず、不明分数はnullのまま残す',() => {
  assert.throws(() => cleanGrant({...event(1,15,'10'),granted_minutes:15},now));
  assert.throws(() => cleanGrant({...event(1,15,'10'),cookie:'secret'},now));
  assert.equal(cleanGrant({...event(1,15,'10'),estimated_minutes:null},now).estimated_minutes,null);
});
test('学習未取得日は0分にせず、欠損がある残高を確定しない',async () => {
  const db=database(); const e=event(1,15,'10');
  await ingestGrant(db,e,now);
  await confirmGrant(db,e.event_id,{granted_minutes:15,method:'parent_verified_selected_minutes'},now);
  await ingestStatus(db,{source_id:source,checked_at:new Date(now).toISOString(),read_status:'ok'},now);
  const ledger=await ledgerDashboard(db,[],now);
  assert.equal(ledger.total_learning_minutes,null); assert.equal(ledger.today_learning_minutes,null);
  assert.equal(ledger.balance_minutes,null); assert.deepEqual(ledger.missing_learning_days,['2026-10-10']);
  db.close();
});
test('認証なしの書き込みは拒否し、学習画面は独立して読める',async () => {
  assert.equal(authorized(new Request('https://test'), 'x'.repeat(40)),false);
  const denied=await worker.fetch(new Request('https://test/api/family-safety/events',{method:'POST',body:'{}'}),{});
  assert.equal(denied.status,401);
  assert.equal((await worker.fetch(new Request('https://test/api/dashboard'),{})).status,200);
});
test('時間記録の保存障害でも既存の学習画面を止めない',async () => {
  const broken={prepare() { throw new Error('synthetic_database_failure'); }};
  const response=await worker.fetch(new Request('https://test/api/dashboard'),{LEDGER_DB:broken});
  assert.equal(response.status,200);
  const body=await response.json(); assert.ok(body.ledger_error); assert.equal(body.record.total_minutes,198);
  assert.equal(JSON.stringify(body).includes('synthetic_database_failure'),false);
});
