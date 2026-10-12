import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMonthly, parseMonthly, mergeMonthly, MONTHLY_FAILURE } from '../src/monthly.js';
import { LearningService } from '../src/service.js';
import { recentBalance } from '../src/balance.js';
import { monthlyApi } from './monthly-fixture.js';

const NOW=Date.parse('2026-10-12T22:00:00+09:00');
const daily={date:'2026-10-12',total_minutes:7,subjects:{数学:7},fetched_at:'2026-10-12T22:00:00+09:00'};
const seed={...daily,fetched_at:'2026-10-12T20:00:00+09:00'};
const monthly=()=>({...parseMonthly(monthlyApi())[0],fetched_at:daily.fetched_at});
const disk=()=>{let value;return {get:async()=>structuredClone(value),put:async(_,v)=>{value=structuredClone(v);}};};
async function service(storage,fetcher,clock=()=>NOW) {
  const value=new LearningService(storage,{SMILE_ZEMI_LOGIN_ID:'synthetic-id',SMILE_ZEMI_PASSWORD:'synthetic-password'},seed,fetcher,clock,{refreshIntervalMs:0});
  await value.initialize();return value;
}
test('月の実績・目安・教科だけを抽出し、秘密や名前を落とす',()=>{
  const input=monthlyApi();input.response_data.monthly_reports[0].childName='synthetic-name';input.ticket='synthetic-ticket';
  const result=parseMonthly(input)[0];assert.equal(result.total_count,15);assert.equal(result.target_count,10);assert.equal(result.subjects.社会.count,5);
  const clean=cleanMonthly({...result,fetched_at:daily.fetched_at,ticket:'synthetic-ticket'});
  assert.deepEqual(Object.keys(clean),['month','grade','total_count','target_count','subjects','fetched_at']);
  assert.ok(!JSON.stringify(clean).includes('synthetic'));
});
test('月APIの未知・重複教科、重複月、合計不一致を拒否',()=>{
  for(const change of [m=>m.report.subjects_report[0].subject='UNKNOWN',m=>m.report.subjects_report.push(m.report.subjects_report[0]),m=>m.report.total_studied_count++,m=>m.report.total_guide_study_count++,m=>m.report.subjects_report.pop(),m=>m.grade=4,m=>m.month=13]) {
    const input=monthlyApi();change(input.response_data.monthly_reports[0]);assert.throws(()=>parseMonthly(input));
  }
  const input=monthlyApi();input.response_data.monthly_reports.push(input.response_data.monthly_reports[0]);assert.throws(()=>parseMonthly(input));
});
test('不明を0にせず、実際の0は許可。負数・bool・小数・巨大値・日時不正を拒否',()=>{
  for(const value of [null,undefined,-1,true,1.5,1000001]) {
    const record=monthly();record.subjects.数学.count=value;assert.throws(()=>cleanMonthly(record));
  }
  const zero=monthly();zero.total_count=0;for(const row of Object.values(zero.subjects))row.count=0;assert.equal(cleanMonthly(zero).total_count,0);
  assert.throws(()=>cleanMonthly({...monthly(),fetched_at:'2026-10-12T22:00:00'}));
});
test('同月を二重加算せず最新値に置換し、古い再送で巻き戻さず翌月も保持',()=>{
  const record=monthly(),newer={...monthly(),total_count:16,subjects:{...monthly().subjects,数学:{count:2,target:2}},fetched_at:'2026-10-12T22:01:00+09:00'};
  let history=mergeMonthly([],record);history=mergeMonthly(history,record);assert.equal(history.length,1);assert.equal(history[0].total_count,15);
  history=mergeMonthly(history,newer);history=mergeMonthly(history,record);assert.equal(history[0].total_count,16);
  history=mergeMonthly(history,{...record,month:'2026-11',fetched_at:'2026-11-01T00:00:00+09:00'});assert.equal(history.length,2);assert.equal(history[1].total_count,16);
});
test('既存保存先から月実績を復元し、GETではログインしない',async()=>{
  const storage=disk(),instance=await service(storage,async()=>({...daily,monthly:monthly()}));
  const [status,response]=await instance.refresh();assert.equal(status,200);assert.deepEqual(response.record,daily);assert.equal(response.monthly_record.total_count,15);
  const restored=await service(storage,()=>{throw Error('unexpected login');});assert.equal(restored.snapshot().monthly_record.total_count,15);assert.equal(restored.snapshot().monthly_history.length,1);
  await instance.refresh();assert.equal(instance.snapshot().monthly_history.length,1);
});
test('月取得失敗/不正値でも日別時間は成功し、前の月実績と安全なエラーだけ保存',async()=>{
  const storage=disk();let fetched={...daily,monthly:monthly()};const instance=await service(storage,async()=>fetched);
  await instance.refresh();
  for(const bad of [{monthly_error:'Cookie=synthetic-secret'},{monthly:{...monthly(),total_count:null}},{monthly:{...monthly(),month:'2026-09'}}]) {
    fetched={...daily,total_minutes:8,subjects:{数学:8},...bad};const [status,response]=await instance.refresh();
    assert.equal(status,200);assert.equal(response.record.total_minutes,8);assert.equal(response.monthly_record.total_count,15);assert.equal(response.monthly_error,MONTHLY_FAILURE);
    assert.ok(!JSON.stringify(await storage.get()).includes('synthetic-secret'));
  }
  const restored=await service(storage,async()=>daily);assert.equal(restored.snapshot().monthly_error,MONTHLY_FAILURE);
});
test('破損した月記録で既存日別記録を消さず、月跨ぎでは今月未取得と過去保存を区別',async()=>{
  const storage=disk(),instance=await service(storage,async()=>({...daily,monthly:monthly()}));await instance.refresh();
  const november=await service(storage,async()=>daily,()=>Date.parse('2026-10-31T15:00:00Z'));
  assert.equal(november.snapshot().monthly_record,null);assert.equal(november.snapshot().monthly_history.length,1);
  const saved=await storage.get();saved.monthly_history[0].total_count=null;await storage.put('',saved);
  const corrupt=await service(storage,async()=>daily);assert.deepEqual(corrupt.snapshot().record,daily);assert.equal(corrupt.snapshot().monthly_record,null);assert.equal(corrupt.snapshot().monthly_error,MONTHLY_FAILURE);
});
test('月実績を残高へ混ぜず、月変更後も日別と付与の計算を維持',()=>{
  const ledger={learning_history:[daily],grant_history:[],last_sync_at:new Date(NOW).toISOString(),integration_status:'connected'};
  assert.deepEqual(recentBalance({...ledger,monthly_record:monthly()},NOW),recentBalance(ledger,NOW));
});
