import { todayJst } from './learning.js';
import { summarizeLedger } from './family-safety.js';

export function recentBalance(ledger, now = Date.now()) {
  const today=todayJst(now), yesterday=todayJst(now-86400000);
  const inWindow=date=>date>=yesterday && date<=today;
  const days=ledger.learning_history.filter(d=>inWindow(d.date));
  const events=ledger.grant_history.filter(e=>inWindow(todayJst(Date.parse(e.occurred_at))));
  const bridges=ledger.last_sync_at ? [{checked_at:ledger.last_sync_at,read_status:ledger.integration_status==='connected' ? 'ok' : 'error'}] : [];
  const base=summarizeLedger(days,events,bridges,now);
  const adjustments=(ledger.adjustment_history || []).filter(a=>inWindow(a.effective_date));
  const correction=adjustments.reduce((sum,a)=>sum+a.delta_minutes,0);
  const pending=events.filter(e=>e.confirmation_status!=='confirmed');
  const unknown=pending.filter(e=>!Number.isInteger(e.estimated_minutes) || e.estimated_minutes<1 || e.estimated_minutes>1440);
  const estimatedTotal=unknown.length ? null : base.total_granted_minutes+pending.reduce((sum,e)=>sum+e.estimated_minutes,0);
  // Estimates are a separate display value, never a confirmation of the original events.
  const estimatedBalance=base.total_learning_minutes==null || estimatedTotal==null || base.missing_learning_days.length ? null : base.total_learning_minutes-estimatedTotal+correction;
  return {...base,window_start:yesterday,window_end:today,adjustment_history:adjustments,
    manual_adjustment_minutes:correction,
    estimated_total_granted_minutes:estimatedTotal,estimated_balance_minutes:estimatedBalance,
    unestimated_grant_count:unknown.length,
    balance_minutes:base.balance_minutes==null ? null : base.balance_minutes+correction,
    confirmed_balance_minutes:base.confirmed_balance_minutes==null ? null : base.confirmed_balance_minutes+correction};
}
