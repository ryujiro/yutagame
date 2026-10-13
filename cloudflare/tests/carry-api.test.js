import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { todayJst } from '../src/learning.js';

function database() {
  const sql=new DatabaseSync(':memory:');
  for(const file of ['0001_family_safety.sql','0002_manual_learning.sql','0003_manual_adjustments.sql']) sql.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  return {sql,prepare(query){const s=sql.prepare(query);let args=[];return {bind(...values){args=values;return this;},async all(){return {results:s.all(...args)};},async first(){return s.get(...args)||null;},async run(){return s.run(...args);}};},async batch(items){return Promise.all(items.map(s=>s.run()));}};
}
test('実WorkerとSQLiteのGETは繰り越しを再計算し、再読込で二重加算・DB変更しない',async()=>{
  const db=database(),today=todayJst(),yesterday=todayJst(Date.now()-86400000);
  try {
    for(const [date,minutes] of [[yesterday,30],[today,10]]) db.sql.prepare('INSERT INTO learning_days(date,total_minutes,fetched_at) VALUES(?,?,?)').run(date,minutes,date+'T10:00:00+09:00');
    db.sql.prepare('INSERT INTO manual_adjustments(request_id,effective_date,created_at,delta_minutes) VALUES(?,?,?,?)').run('synthetic-adjustment',yesterday,new Date().toISOString(),5);
    const env={LEDGER_DB:db,BALANCE_START_DATE:yesterday};
    for(let i=0;i<2;i++) {
      const response=await worker.fetch(new Request('https://test/api/dashboard'),env),data=await response.json();
      assert.equal(response.status,200);assert.equal(data.ledger.carry.carry_in_minutes,35);
      assert.equal(data.ledger.carry.estimated_balance_minutes,45);
      assert.equal(data.ledger.adjustment_ready,true);assert.equal(data.ledger.carry_error,undefined);
    }
    assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM manual_adjustments').get().n,1);
    const invalid=await (await worker.fetch(new Request('https://test/api/dashboard'),{LEDGER_DB:db})).json();
    assert.ok(invalid.ledger.carry_error);assert.equal(invalid.ledger.carry,undefined);
    assert.equal(invalid.ledger.adjustment_error,undefined);
  } finally {db.sql.close();}
});
test('手動調整の読取障害では繰り越しを算出せず、学習表示を保持',async()=>{
  const db=database();
  try {
    const broken={...db,prepare(query){if(query.startsWith('SELECT request_id,effective_date'))throw new Error('synthetic_read_error');return db.prepare(query);}};
    const response=await worker.fetch(new Request('https://test/api/dashboard'),{LEDGER_DB:broken,BALANCE_START_DATE:todayJst()}),data=await response.json();
    assert.equal(response.status,200);assert.ok(data.record);assert.equal(data.ledger.carry,null);
    assert.ok(data.ledger.adjustment_error);assert.equal(JSON.stringify(data).includes('synthetic_read_error'),false);
  } finally {db.sql.close();}
});
