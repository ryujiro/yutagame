import { todayJst } from './learning.js';
import { summarizeLedger } from './family-safety.js';

export function recentBalance(ledger, now = Date.now()) {
  const today=todayJst(now), yesterday=todayJst(now-86400000);
  const inWindow=date=>date>=yesterday && date<=today;
  const days=ledger.learning_history.filter(d=>inWindow(d.date));
  const events=ledger.grant_history.filter(e=>inWindow(todayJst(Date.parse(e.occurred_at))));
  const bridges=ledger.last_sync_at ? [{checked_at:ledger.last_sync_at,read_status:ledger.integration_status==='connected' ? 'ok' : 'error'}] : [];
  return {...summarizeLedger(days,events,bridges,now),window_start:yesterday,window_end:today};
}
