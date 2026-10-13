import { todayJst, validDate } from './learning.js';
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

// Rebuild from immutable daily records; a reread never adds the carry twice.
// Missing learning records are unknown, including days without PC grants.
export function carryBalance(ledger, startDate, now = Date.now()) {
  const today = todayJst(now), yesterday = todayJst(now - 86400000);
  if (!validDate(startDate) || startDate > today) throw new Error('invalid_carry_start_date');
  const learning = new Map(ledger.learning_history.map(d => [d.date, d.total_minutes]));
  const grants = new Map(), adjustments = new Map(), missing = [];
  let pending = 0, todayPending = 0, unknown = 0;
  for (const event of ledger.grant_history) {
    const day = todayJst(Date.parse(event.occurred_at));
    if (day < startDate || day > today) continue;
    const confirmed = event.confirmation_status === 'confirmed';
    const amount = confirmed ? event.granted_minutes : event.estimated_minutes;
    if (!confirmed) { pending++; if (day === today) todayPending++; }
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1440) {
      unknown++; grants.set(day, null);
    } else if (!grants.has(day) || grants.get(day) !== null) {
      grants.set(day, (grants.get(day) || 0) + amount);
    }
  }
  for (const adjustment of ledger.adjustment_history || []) {
    if (adjustment.effective_date < startDate || adjustment.effective_date > today) continue;
    adjustments.set(adjustment.effective_date, (adjustments.get(adjustment.effective_date) || 0) + adjustment.delta_minutes);
  }
  let incoming = 0, previous = null, current;
  const start = Date.parse(startDate + 'T00:00:00+09:00');
  for (let time = start; time <= now; time += 86400000) {
    const date = todayJst(time), learned = learning.get(date) ?? null;
    const granted = grants.has(date) ? grants.get(date) : 0;
    const correction = adjustments.get(date) || 0;
    if (learned === null) missing.push(date);
    const net = learned === null || granted === null ? null : learned - granted + correction;
    const closing = incoming === null || net === null ? null : incoming + net;
    const day = { date, incoming_minutes: incoming, learning_minutes: learned,
      granted_minutes: granted, adjustment_minutes: correction, net_minutes: net,
      closing_minutes: closing, outgoing_minutes: closing === null ? null : Math.max(0, closing) };
    if (date === yesterday) previous = day;
    if (date === today) current = day;
    incoming = day.outgoing_minutes;
  }
  return { mode: 'daily_carry', start_date: startDate, today, yesterday,
    earlier_carry_minutes: previous?.incoming_minutes ?? (previous ? null : 0),
    yesterday_net_minutes: previous?.net_minutes ?? (previous ? null : 0),
    yesterday_closing_minutes: previous?.closing_minutes ?? (previous ? null : 0),
    carry_in_minutes: current.incoming_minutes,
    today_learning_minutes: current.learning_minutes, today_granted_minutes: current.granted_minutes,
    manual_adjustment_minutes: current.adjustment_minutes,
    estimated_balance_minutes: current.closing_minutes,
    pending_count: pending, today_pending_count: todayPending, unestimated_grant_count: unknown,
    missing_learning_days: missing, integration_status: ledger.integration_status,
    last_sync_at: ledger.last_sync_at,
    adjustment_history: (ledger.adjustment_history || []).filter(a => a.effective_date >= yesterday && a.effective_date <= today) };
}
