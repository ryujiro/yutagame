import test from 'node:test';
import assert from 'node:assert/strict';
import { recentBalance } from '../src/balance.js';
import { summarizeLedger } from '../src/family-safety.js';

const now=Date.parse('2026-10-11T10:00:00+09:00');
const day=(date,total_minutes)=>({date,total_minutes,fetched_at:`${date}T08:00:00+09:00`});
const event=(id,date,amount)=>({event_id:id,occurred_at:`${date}T10:00:00+09:00`,
  confirmation_status:amount==null ? 'needs_review' : 'confirmed',granted_minutes:amount});
const ledger=(days,events,time=now)=>summarizeLedger(days,events,[{read_status:'ok',checked_at:new Date(time).toISOString()}],time);

test('残高は今日・昨日だけ。古い未確認・欠損・学習は計算に含めず、原本を変更しない',()=>{
  const original=ledger([day('2026-10-11',8),day('2026-10-10',198),day('2026-10-08',1000)],
    [event('1','2026-10-10',60),event('2','2026-10-10',60),event('3','2026-10-10',90),event('4','2026-10-09',null)]);
  const before=structuredClone(original),recent=recentBalance(original,now);
  assert.equal(original.balance_minutes,null);assert.equal(recent.balance_minutes,-4);
  assert.equal(recent.total_learning_minutes,206);assert.equal(recent.total_granted_minutes,210);
  assert.equal(recent.pending_count,0);assert.deepEqual(recent.missing_learning_days,[]);
  assert.equal(recent.window_start,'2026-10-10');assert.equal(recent.window_end,'2026-10-11');
  assert.deepEqual(original,before);
});
test('日付変更で2日前の値を外し、未取得を0分に置き換えない',()=>{
  const time=now+86400000;
  const recent=recentBalance(ledger([day('2026-10-11',8),day('2026-10-10',198)],[event('1','2026-10-10',210)],time),time);
  assert.equal(recent.balance_minutes,8);assert.equal(recent.today_learning_minutes,null);assert.equal(recent.total_granted_minutes,0);
  const emptyTime=time+86400000;
  const empty=recentBalance(ledger([day('2026-10-11',8)],[],emptyTime),emptyTime);
  assert.equal(empty.total_learning_minutes,null);assert.equal(empty.balance_minutes,null);
});
test('対象2日内の未確認・学習欠損・PC切断は未確定表示を維持',()=>{
  const uncertain=recentBalance(ledger([day('2026-10-10',198)],[event('1','2026-10-11',null)]),now);
  assert.equal(uncertain.balance_minutes,null);assert.equal(uncertain.pending_count,1);assert.deepEqual(uncertain.missing_learning_days,['2026-10-11']);
  const offline=ledger([day('2026-10-11',8)],[]);offline.integration_status='stale';
  assert.equal(recentBalance(offline,now).balance_minutes,null);
});
test('UTCの付与時刻も日本時間の2日境界で判定し、未来日は含めない',()=>{
  const events=[event('old','2026-10-09',100),event('in','2026-10-10',10),event('future','2026-10-12',500)];
  events[0].occurred_at='2026-10-09T14:59:59Z';events[1].occurred_at='2026-10-09T15:00:00Z';events[2].occurred_at='2026-10-11T15:00:00Z';
  const recent=recentBalance(ledger([day('2026-10-12',999),day('2026-10-11',8),day('2026-10-10',20)],events),now);
  assert.equal(recent.total_learning_minutes,28);assert.equal(recent.total_granted_minutes,10);assert.equal(recent.balance_minutes,18);
});
test('推定を確定原本と分離し、今回の6件で402−430＋30＝2分を表示',()=>{
  const source=ledger([day('2026-10-11',103),day('2026-10-10',299)],[]);
  source.grant_history=[60,60,80,100,70,60].map((amount,index)=>({...event(String(index),index<3 ? '2026-10-10' : '2026-10-11',null),estimated_minutes:amount}));
  source.adjustment_history=[{effective_date:'2026-10-10',delta_minutes:30}];
  const before=structuredClone(source),recent=recentBalance(source,now);
  assert.equal(recent.estimated_balance_minutes,2);assert.equal(recent.estimated_total_granted_minutes,430);
  assert.equal(recent.balance_minutes,null);assert.equal(recent.total_granted_minutes,0);
  assert.equal(recent.pending_count,6);assert.deepEqual(source,before);
  assert.equal(recentBalance(source,now).estimated_balance_minutes,2);
});
test('確認済みは実分数だけ、未確定は推定だけを1回ずつ差し引く',()=>{
  const source=ledger([day('2026-10-11',100)],[{...event('confirmed','2026-10-11',60),estimated_minutes:100}, {...event('estimate','2026-10-11',null),estimated_minutes:30}]);
  const recent=recentBalance(source,now);
  assert.equal(recent.total_granted_minutes,60);assert.equal(recent.estimated_total_granted_minutes,90);assert.equal(recent.estimated_balance_minutes,10);
});
test('分数不明・不正推定・学習欠損は0扱いせず、推定残高もnull',()=>{
  for(const estimate of [null,undefined,0,-1,1.5,1441,'30']) {
    const recent=recentBalance(ledger([day('2026-10-11',100)],[{...event('unknown','2026-10-11',null),estimated_minutes:estimate}]),now);
    assert.equal(recent.estimated_balance_minutes,null);assert.equal(recent.estimated_total_granted_minutes,null);assert.equal(recent.unestimated_grant_count,1);
  }
  const missing=recentBalance(ledger([day('2026-10-10',100)],[{...event('missing','2026-10-11',null),estimated_minutes:30}]),now);
  assert.equal(missing.estimated_balance_minutes,null);
});
test('PCがスリープ中は保存分の推定残高を維持し、接続状態を偽らない',()=>{
  const source=ledger([day('2026-10-11',100)],[{...event('estimate','2026-10-11',null),estimated_minutes:120}]);
  source.integration_status='stale';source.last_sync_at=new Date(now-3600000).toISOString();
  const recent=recentBalance(source,now);
  assert.equal(recent.estimated_balance_minutes,-20);assert.equal(recent.integration_status,'stale');assert.equal(recent.balance_minutes,null);
});
test('日付変更で古い推定と調整は対象外、推定不明の過去記録は妨げない',()=>{
  const source=ledger([day('2026-10-11',100),day('2026-10-10',299)], [event('old','2026-10-09',null), {...event('yesterday','2026-10-10',null),estimated_minutes:200}, {...event('today','2026-10-11',null),estimated_minutes:40}]);
  source.adjustment_history=[{effective_date:'2026-10-10',delta_minutes:30}];
  assert.equal(recentBalance(source,now).estimated_balance_minutes,189);
  const next=now+86400000;source.last_sync_at=new Date(next).toISOString();
  const recent=recentBalance(source,next);assert.equal(recent.estimated_balance_minutes,60);assert.equal(recent.estimated_total_granted_minutes,40);
  assert.equal(recent.manual_adjustment_minutes,0);assert.equal(recent.pending_count,1);
});
