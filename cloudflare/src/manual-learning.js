import { LearningService } from './service.js';
import { fetchTodayLearningTime } from './fetch-smile.js';
import { todayJst } from './learning.js';

function storage(db) {
  return {
    async get() {
      const row=await db.prepare('SELECT snapshot FROM learning_live_state WHERE id=1').first();
      return row ? JSON.parse(row.snapshot) : undefined;
    },
    async put(_,value) {
      await db.prepare('INSERT INTO learning_live_state(id,snapshot) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot')
        .bind(JSON.stringify(value)).run();
    },
  };
}
async function realFetch(env,progress,clock) {
  const { launch }=await import('@cloudflare/playwright');
  return fetchTodayLearningTime(env,progress,clock,launch);
}
export async function manualLearning(env,saved,clock=Date.now,fetcher=realFetch) {
  const service=new LearningService(storage(env.LEDGER_DB),env,saved.record,fetcher,clock);
  await service.initialize();
  const history=new Map([...service.state.history,...saved.history].map(r=>[`${r.date}|${r.fetched_at}`,r]));
  service.state.history=[...history.values()].sort((a,b)=>Date.parse(b.fetched_at)-Date.parse(a.fetched_at)).slice(0,100);
  const guard=await env.LEDGER_DB.prepare('SELECT * FROM learning_refresh_guard WHERE id=1').first();
  const snapshot=()=>{
    const data=service.snapshot();
    const now=clock(), busy=guard.lease_until>now;
    return {...data,refresh_mode:'manual_login',credentials_ready:data.credentials_ready && !!env.BROWSER,
      refreshing:busy,retry_after_seconds:Math.max(data.retry_after_seconds,Math.max(0,Math.ceil((guard.last_started+600000-now)/1000)))};
  };
  return { snapshot,
    async refresh() {
      if (!snapshot().credentials_ready) return [503,{...snapshot(),request_message:'スマイルゼミのログイン設定がまだ完了していません。'}];
      if (service.snapshot().retry_after_seconds) return [429,{...snapshot(),request_message:'続けて取得するには10分ほど時間をおいてください。'}];
      const started=clock(), day=todayJst(started);
      // One database claim gates every Worker instance before any login attempt.
      const claim=await env.LEDGER_DB.prepare(`UPDATE learning_refresh_guard SET last_started=?,lease_until=?,
        attempts=CASE WHEN quota_day=? THEN attempts+1 ELSE 1 END,quota_day=?
        WHERE id=1 AND lease_until<=? AND last_started<=? AND (quota_day<>? OR attempts<5)`)
        .bind(started,started+130000,day,day,started,started-600000,day).run();
      if ((claim.meta?.changes ?? claim.changes)!==1) {
        const state=await env.LEDGER_DB.prepare('SELECT * FROM learning_refresh_guard WHERE id=1').first();
        Object.assign(guard,state);
        const message=state.lease_until>started ? '学習記録を取得しています。少しお待ちください。'
          : state.quota_day===day && state.attempts>=5 ? '本日の取得回数の上限に達しました。明日また更新できます。'
          : '続けて取得するには10分ほど時間をおいてください。';
        return [state.lease_until>started ? 409 : 429,{...snapshot(),request_message:message}];
      }
      try {
        const [status,data]=await service.refresh();
        return [status,{...data,refresh_mode:'manual_login'}];
      } finally {
        await env.LEDGER_DB.prepare('UPDATE learning_refresh_guard SET lease_until=0 WHERE id=1 AND last_started=?').bind(started).run();
      }
    },
  };
}
