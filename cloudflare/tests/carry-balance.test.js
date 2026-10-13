import test from 'node:test';
import assert from 'node:assert/strict';
import { carryBalance } from '../src/balance.js';

const now = Date.parse('2026-10-13T10:00:00+09:00');
const day = (date,total_minutes) => ({date,total_minutes});
const grant = (date,amount) => ({occurred_at:`${date}T12:00:00+09:00`,confirmation_status:'confirmed',granted_minutes:amount});
const ledger = (days,grants=[],adjustments=[]) => ({learning_history:days,grant_history:grants,adjustment_history:adjustments,integration_status:'connected',last_sync_at:new Date(now).toISOString()});

test('開始日前を除外し、初日の繰り越し0から昨日の残りだけを今日へ渡す',()=>{
  const source=ledger([day('2026-10-11',1000),day('2026-10-12',100),day('2026-10-13',20)],
    [grant('2026-10-11',10),grant('2026-10-12',70),grant('2026-10-13',10)],
    [{effective_date:'2026-10-11',delta_minutes:100}]);
  const before=structuredClone(source),result=carryBalance(source,'2026-10-12',now);
  assert.equal(result.earlier_carry_minutes,0);assert.equal(result.yesterday_net_minutes,30);
  assert.equal(result.carry_in_minutes,30);assert.equal(result.estimated_balance_minutes,40);
  assert.deepEqual(source,before);assert.deepEqual(carryBalance(source,'2026-10-12',now),result);
});
test('以前の繰り越しと昨日の増減を合算してから0で下限処理する',()=>{
  const source=ledger([day('2026-10-10',50),day('2026-10-11',0),day('2026-10-12',10),day('2026-10-13',5)],
    [grant('2026-10-12',30)]);
  const result=carryBalance(source,'2026-10-10',now);
  assert.equal(result.earlier_carry_minutes,50);assert.equal(result.yesterday_net_minutes,-20);
  assert.equal(result.carry_in_minutes,30);assert.equal(result.estimated_balance_minutes,35);
});
test('前日の赤字を翌日に持ち越さず、当日のマイナスは当日中に表示する',()=>{
  const source=ledger([day('2026-10-12',103),day('2026-10-13',5)],[grant('2026-10-12',230),grant('2026-10-13',15)]);
  const result=carryBalance(source,'2026-10-12',now);
  assert.equal(result.yesterday_closing_minutes,-127);assert.equal(result.carry_in_minutes,0);
  assert.equal(result.estimated_balance_minutes,-10);
  source.learning_history.push(day('2026-10-14',7));
  assert.equal(carryBalance(source,'2026-10-12',now+86400000).carry_in_minutes,0);
  assert.equal(carryBalance(source,'2026-10-12',now+86400000).estimated_balance_minutes,7);
});
test('UTCの15時で日を切り替え、0分の実記録と未来の記録を正しく扱う',()=>{
  const source=ledger([day('2026-10-12',50),day('2026-10-13',0),day('2026-10-14',1000)],
    [{...grant('2026-10-12',20),occurred_at:'2026-10-12T14:59:59Z'},
      {...grant('2026-10-13',10),occurred_at:'2026-10-12T15:00:00Z'},grant('2026-10-14',1000)]);
  const before=carryBalance(source,'2026-10-12',Date.parse('2026-10-12T14:59:59Z'));
  assert.equal(before.estimated_balance_minutes,30);
  const after=carryBalance(source,'2026-10-12',Date.parse('2026-10-12T15:00:00Z'));
  assert.equal(after.carry_in_minutes,30);assert.equal(after.estimated_balance_minutes,20);
  assert.equal(after.today_learning_minutes,0);
});
test('今日未取得でも昨日の繰り越しは読めるが、今日の残高を0で生成しない',()=>{
  const result=carryBalance(ledger([day('2026-10-12',30)]),'2026-10-12',now);
  assert.equal(result.carry_in_minutes,30);assert.equal(result.today_learning_minutes,null);
  assert.equal(result.estimated_balance_minutes,null);assert.deepEqual(result.missing_learning_days,['2026-10-13']);
});
test('途中の未取得日は付与がなくても不明。後から取得すると再計算できる',()=>{
  const source=ledger([day('2026-10-10',20),day('2026-10-12',30),day('2026-10-13',5)]);
  assert.equal(carryBalance(source,'2026-10-10',now).carry_in_minutes,null);
  source.learning_history.push(day('2026-10-11',0));
  assert.equal(carryBalance(source,'2026-10-10',now).estimated_balance_minutes,55);
});
test('推定付与を使用するが確認済みの原本を変更せず、PC停止中も保存値を表示',()=>{
  const source=ledger([day('2026-10-12',100),day('2026-10-13',20)],
    [{...grant('2026-10-12',30),estimated_minutes:90},
      {...grant('2026-10-13',null),confirmation_status:'needs_review',estimated_minutes:40}]);
  source.integration_status='stale';const before=structuredClone(source);
  const result=carryBalance(source,'2026-10-12',now);
  assert.equal(result.carry_in_minutes,70);assert.equal(result.estimated_balance_minutes,50);
  assert.equal(result.pending_count,1);assert.equal(result.today_pending_count,1);assert.equal(result.integration_status,'stale');assert.deepEqual(source,before);
  source.grant_history[1].estimated_minutes=null;
  assert.equal(carryBalance(source,'2026-10-12',now).estimated_balance_minutes,null);
  assert.equal(carryBalance(source,'2026-10-12',now).unestimated_grant_count,1);
});
test('過去日の調整取消と学習の訂正を日付順で再計算し、二重加算しない',()=>{
  const source=ledger([day('2026-10-12',10),day('2026-10-13',5)],[grant('2026-10-12',30)],
    [{effective_date:'2026-10-12',delta_minutes:40},{effective_date:'2026-10-13',delta_minutes:3}]);
  assert.equal(carryBalance(source,'2026-10-12',now).estimated_balance_minutes,28);
  source.adjustment_history.push({effective_date:'2026-10-12',delta_minutes:-40,reversal_of:'synthetic'});
  assert.equal(carryBalance(source,'2026-10-12',now).estimated_balance_minutes,8);
  source.learning_history[0].total_minutes=50;
  assert.equal(carryBalance(source,'2026-10-12',now).estimated_balance_minutes,28);
  assert.equal(carryBalance(source,'2026-10-12',now).estimated_balance_minutes,28);
});
test('開始日設定がなければ勝手に全過去分や移動する昨日を開始日にしない',()=>{
  for(const invalid of [undefined,'2026-02-30','2026-10-14']) assert.throws(()=>carryBalance(ledger([]),invalid,now));
});
