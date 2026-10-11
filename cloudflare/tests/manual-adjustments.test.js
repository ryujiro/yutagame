import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { adjustmentApi, readAdjustments } from '../src/manual-adjustments.js';
import { recentBalance } from '../src/balance.js';
import worker from '../src/index.js';

const now=Date.parse('2026-10-11T00:30:00+09:00');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const add=(n,delta=30,note='')=>({request_id:id(n),delta_minutes:delta,note});
const undo=(n,original)=>({request_id:id(n),reversal_of:id(original)});
function database() {
  const sql=new DatabaseSync(':memory:');
  for(const name of ['0001_family_safety','0002_manual_learning','0003_manual_adjustments']) sql.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
  return {prepare(query) {const statement=sql.prepare(query);let params=[];return {
    bind(...args) {params=args;return this;},async run(){return statement.run(...params);},
    async first(){return statement.get(...params) || null;},async all(){return {results:statement.all(...params)};}
  };},async batch(statements){return Promise.all(statements.map(s=>s.run()));},close(){sql.close();}};
}
const request=(value,headers={},method='POST')=>new Request('https://test/api/manual-adjustments',{method,headers:{Origin:'https://test','Content-Type':'application/json','X-Balance-Request':'1',...headers},...(method==='GET' ? {} : {body:JSON.stringify(value)})});
const write=(db,value,time=now)=>adjustmentApi(request(value),{LEDGER_DB:db},time);
function ledger(adjustments=[],time=now) {
  return {integration_status:'connected',last_sync_at:new Date(time).toISOString(),
    learning_history:[{date:'2026-10-10',total_minutes:198},{date:'2026-10-11',total_minutes:8}],
    grant_history:[{event_id:'one',occurred_at:'2026-10-10T10:00:00+09:00',granted_minutes:210,confirmation_status:'confirmed'}],adjustment_history:adjustments};
}

test('追加・減算・再取得が学習と付与の実記録を変更しない',async()=>{
  const db=database();
  assert.equal((await write(db,add(1)))[0],200);assert.equal((await write(db,add(2,-10)))[0],200);
  const source=ledger(await readAdjustments(db)),before=structuredClone(source),recent=recentBalance(source,now);
  assert.equal(recent.balance_minutes,16);assert.equal(recent.manual_adjustment_minutes,20);
  assert.equal(recent.today_learning_minutes,8);assert.equal(recent.total_learning_minutes,206);assert.equal(recent.total_granted_minutes,210);
  assert.deepEqual(structuredClone(source),before);assert.equal(recentBalance(ledger(await readAdjustments(db)),now).balance_minutes,16);
  assert.equal((await readAdjustments(db)).length,2);db.close();
});
test('同じ操作の再送は1件。異なる内容は409、別操作は個別に記録',async()=>{
  const db=database();await write(db,add(1));
  assert.equal((await write(db,add(1)))[1].replayed,true);assert.equal((await write(db,add(1,10)))[0],409);
  await write(db,add(2));assert.equal((await readAdjustments(db)).length,2);
  assert.equal(recentBalance(ledger(await readAdjustments(db)),now).balance_minutes,56);db.close();
});
test('同時再送も操作番号で1件だけになる',async()=>{
  const db=database(),results=await Promise.all([write(db,add(1)),write(db,add(1))]);
  assert.ok(results.every(r=>r[0]===200));assert.equal((await readAdjustments(db)).length,1);db.close();
});
test('取り消しは原本を残して反対符号の履歴を1件だけ追加',async()=>{
  const db=database();await write(db,add(1));await write(db,undo(2,1));
  assert.equal((await write(db,undo(2,1)))[1].replayed,true);
  assert.equal((await write(db,undo(3,1)))[0],409);assert.equal((await write(db,undo(4,2)))[0],409);
  assert.equal((await write(db,undo(5,99)))[0],404);
  const rows=await readAdjustments(db);assert.equal(rows.length,2);
  assert.equal(rows.find(r=>r.request_id===id(1)).delta_minutes,30);
  assert.equal(rows.find(r=>r.request_id===id(2)).delta_minutes,-30);
  assert.equal(recentBalance(ledger(rows),now).balance_minutes,-4);db.close();
});
test('別操作番号の同時取り消しも1件に限定',async()=>{
  const db=database();await write(db,add(1));
  const results=await Promise.all([write(db,undo(2,1)),write(db,undo(3,1))]);
  assert.deepEqual(results.map(r=>r[0]).sort(),[200,409]);assert.equal((await readAdjustments(db)).length,2);db.close();
});
test('翌日の取り消しは元の日付で計算し、3日目に一緒に対象外になる',async()=>{
  const db=database();await write(db,add(1));await write(db,undo(2,1),now+86400000);
  const rows=await readAdjustments(db);assert.ok(rows.every(r=>r.effective_date==='2026-10-11'));
  assert.equal(recentBalance(ledger(rows,now+86400000),now+86400000).manual_adjustment_minutes,0);
  const expired=recentBalance(ledger(rows,now+172800000),now+172800000);
  assert.equal(expired.adjustment_history.length,0);assert.equal(expired.manual_adjustment_minutes,0);
  assert.equal((await readAdjustments(db)).length,2);db.close();
});
test('期限外の調整を取り消せず、新規調整は日本時間の日付で保存',async()=>{
  const db=database();await write(db,add(1));
  assert.equal((await write(db,undo(2,1),now+172800000))[0],409);
  assert.equal((await readAdjustments(db))[0].effective_date,'2026-10-11');db.close();
});
test('今日・昨日の調整だけを合計し、過去・未来は履歴だけ保持',()=>{
  const rows=[['2026-10-09',100],['2026-10-10',30],['2026-10-11',-10],['2026-10-12',1000]].map(([effective_date,delta_minutes])=>({effective_date,delta_minutes}));
  const recent=recentBalance(ledger(rows),now);assert.equal(recent.balance_minutes,16);assert.equal(recent.adjustment_history.length,2);
});
test('欠損・未確認・PC切断の残高を調整だけで確定しない',()=>{
  const source=ledger([{effective_date:'2026-10-11',delta_minutes:30}]);
  for(const variant of [{...source,learning_history:[]},{...source,grant_history:[{event_id:'unknown',occurred_at:'2026-10-11T00:01:00+09:00',confirmation_status:'needs_review'}]}, {...source,integration_status:'stale'}]) {
    assert.equal(recentBalance(variant,now).balance_minutes,null);
  }
});
test('パスワードなしだが外部Origin・ヘッダーなしは拒否',async()=>{
  const db=database();
  assert.equal((await adjustmentApi(request(add(1),{Origin:'https://other'}),{LEDGER_DB:db}))[0],403);
  assert.equal((await adjustmentApi(request(add(1),{'X-Balance-Request':''}),{LEDGER_DB:db}))[0],403);
  assert.equal((await adjustmentApi(request(add(1),{},'GET'),{LEDGER_DB:db}))[0],405);
  assert.equal((await adjustmentApi(request(add(1)),{}))[0],503);
  assert.equal((await adjustmentApi(request(add(1),{'Content-Type':'text/plain'}),{LEDGER_DB:db}))[0],415);
  assert.equal((await readAdjustments(db)).length,0);assert.equal((await write(db,add(1)))[0],200);db.close();
});
test('0・小数・過大値・不正型・日時や認証情報の混入を拒否',async()=>{
  const db=database();
  const invalid=[null,[],... [0,1.5,1441,-1441,'30'].map(delta=>add(1,delta)),{...add(1),request_id:[id(1)]},
    {...add(1),note:'a'.repeat(121)},{...add(1),note:1},...['effective_date','password','cookie','granted_minutes'].map(key=>({...add(1),[key]:'x'})),{...undo(1,2),delta_minutes:30}];
  for(const value of invalid) assert.equal((await write(db,value))[0],400);
  assert.equal((await write(db,{...add(1),extra:'x'.repeat(5000)}))[0],413);
  assert.equal((await readAdjustments(db)).length,0);db.close();
});
test('保存先障害を安全な文言にし、Family Safety書込認証を維持',async()=>{
  const broken={prepare(){throw new Error('private_failure');}};
  const result=await write(broken,add(1));assert.equal(result[0],503);assert.equal(JSON.stringify(result).includes('private_failure'),false);
  assert.equal((await worker.fetch(request(add(1)),{LEDGER_DB:broken})).status,503);
  assert.equal((await worker.fetch(new Request('https://test/api/family-safety/events',{method:'POST',body:'{}'}),{})).status,401);
});
test('dashboardに全履歴・利用準備状態を添付し、読み取り障害でも学習を維持',async()=>{
  const db=database();await write(db,add(1));
  let response=await worker.fetch(new Request('https://test/api/dashboard'),{LEDGER_DB:db});
  let data=await response.json();assert.equal(response.status,200);assert.equal(data.ledger.adjustment_ready,true);assert.equal(data.ledger.adjustment_history.length,1);
  const failing={prepare(query){if(query.includes('manual_adjustments')) throw new Error('private_failure');return db.prepare(query);},batch:s=>db.batch(s)};
  response=await worker.fetch(new Request('https://test/api/dashboard'),{LEDGER_DB:failing});data=await response.json();
  assert.equal(response.status,200);assert.equal(data.record.total_minutes,198);assert.ok(data.ledger.adjustment_error);
  assert.equal(data.ledger.recent.balance_minutes,null);assert.equal(data.ledger.recent.confirmed_balance_minutes,null);
  assert.equal(data.ledger.adjustment_ready,undefined);assert.equal(JSON.stringify(data).includes('private_failure'),false);db.close();
});
