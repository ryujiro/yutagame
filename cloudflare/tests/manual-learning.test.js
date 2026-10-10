import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { manualLearning } from '../src/manual-learning.js';
import { LearningError } from '../src/learning.js';
import worker from '../src/index.js';

function database() {
  const sql=new DatabaseSync(':memory:');
  for(const file of ['0001_family_safety.sql','0002_manual_learning.sql']) sql.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  return {prepare(query) {const statement=sql.prepare(query);let args=[];return {bind(...a){args=a;return this;},async first(){return statement.get(...args)||null;},async run(){return statement.run(...args);},async all(){return {results:statement.all(...args)};}};},
    async batch(items){return Promise.all(items.map(s=>s.run()));},close(){sql.close();}};
}
const now=Date.parse('2026-10-11T10:00:00+09:00');
const record={date:'2026-10-10',total_minutes:198,subjects:null,fetched_at:'2026-10-10T18:22:00+09:00'};
const fresh={date:'2026-10-11',total_minutes:7,subjects:{数学:7},fetched_at:'2026-10-11T10:00:00+09:00'};
const saved={record,history:[record]};
const environment=db=>({LEDGER_DB:db,BROWSER:{},SMILE_ZEMI_LOGIN_ID:'synthetic-id',SMILE_ZEMI_PASSWORD:'synthetic-password'});
test('GETはログインせず、手動更新は最新学習を永続保存する',async()=>{
  const db=database();let calls=0;
  const env=environment(db), clock=()=>now;
  const fetcher=async()=>{calls++;return fresh;};
  const first=await manualLearning(env,saved,clock,fetcher);
  assert.equal(calls,0);assert.equal(first.snapshot().refresh_mode,'manual_login');
  assert.equal((await first.refresh())[0],200);assert.equal(calls,1);
  const next=await manualLearning(env,saved,clock,fetcher);
  assert.deepEqual(next.snapshot().record,fresh);assert.equal((await next.refresh())[0],429);assert.equal(calls,1);db.close();
});
test('別Workerの同時要求でもログインは1回、失敗時も前回値を保持する',async()=>{
  const db=database();let release,entered,calls=0;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const fetcher=async()=>{calls++;entered();await gate;throw new LearningError('authentication','login_rejected');};
  const a=await manualLearning(environment(db),saved,()=>now,fetcher);
  const b=await manualLearning(environment(db),saved,()=>now,fetcher);
  const pending=a.refresh();await started;
  assert.equal((await b.refresh())[0],409);release();
  const result=await pending;assert.equal(result[0],502);assert.deepEqual(result[1].record,record);assert.equal(calls,1);
  assert.equal(JSON.stringify(result).includes('synthetic-password'),false);db.close();
});
test('未設定・別サイトからのPOSTはログインせず拒否する',async()=>{
  const db=database();let calls=0;
  const missing=await manualLearning({LEDGER_DB:db,BROWSER:{}},saved,()=>now,()=>{calls++;});
  assert.equal((await missing.refresh())[0],503);assert.equal(calls,0);
  const denied=await worker.fetch(new Request('https://test/api/refresh',{method:'POST',headers:{Origin:'https://other','X-Learning-Request':'1'},body:'{}'}),environment(db));
  assert.equal(denied.status,403);db.close();
});
test('1日5回の上限を翌日へ持ち越さず、取得不能を0分にしない',async()=>{
  const db=database();let time=now,calls=0;
  const clock=()=>time,fetcher=async()=>{calls++;throw new LearningError('connection','fetch_failed');};
  for(let i=0;i<5;i++) {const s=await manualLearning(environment(db),saved,clock,fetcher);assert.equal((await s.refresh())[0],502);time+=601000;}
  const blocked=await manualLearning(environment(db),saved,clock,fetcher);
  assert.equal((await blocked.refresh())[0],429);assert.equal(calls,5);assert.equal(blocked.snapshot().record.total_minutes,198);
  time+=86400000;const next=await manualLearning(environment(db),saved,clock,fetcher);
  assert.equal((await next.refresh())[0],502);assert.equal(calls,6);db.close();
});
