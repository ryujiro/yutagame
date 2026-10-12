import { LearningService } from './service.js';
import { fetchTodayLearningTime } from './fetch-smile.js';
import { importLearning } from './family-safety.js';
import { cleanArchive } from './study-archive.js';

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
async function realFetch(env,progress,clock,archiveOptions) {
  const { launch }=await import('@cloudflare/playwright');
  return fetchTodayLearningTime(env,progress,clock,launch,archiveOptions);
}
export async function manualLearning(env,saved,clock=Date.now,fetcher=realFetch) {
  const store=storage(env.LEDGER_DB);
  const wrappedFetch=(env,progress,clock)=>fetcher(env,progress,clock,{
    resume:service.state.study_archive,
    async onPage(records,scan) {
      const checkpoint=cleanArchive(scan);
      await importLearning(env.LEDGER_DB,records);
      service.state.study_archive=checkpoint;
      await store.put('dashboard',service.state);
    },
  });
  const service=new LearningService(store,env,saved.record,wrappedFetch,clock,{refreshIntervalMs:0});
  await service.initialize();
  const history=new Map([...service.state.history,...saved.history].map(r=>[`${r.date}|${r.fetched_at}`,r]));
  service.state.history=[...history.values()].sort((a,b)=>Date.parse(b.fetched_at)-Date.parse(a.fetched_at)).slice(0,100);
  const guard=await env.LEDGER_DB.prepare('SELECT * FROM learning_refresh_guard WHERE id=1').first();
  const snapshot=()=>{
    const data=service.snapshot();
    const now=clock(), busy=guard.lease_until>now;
    return {...data,refresh_mode:'manual_login',credentials_ready:data.credentials_ready && !!env.BROWSER,
      refreshing:busy,retry_after_seconds:0,next_refresh_at:null};
  };
  return { snapshot,
    async refresh() {
      if (!snapshot().credentials_ready) return [503,{...snapshot(),request_message:'スマイルゼミのログイン設定がまだ完了していません。'}];
      const started=clock();
      // One database claim gates every Worker instance before any login attempt.
      const claim=await env.LEDGER_DB.prepare('UPDATE learning_refresh_guard SET last_started=?,lease_until=? WHERE id=1 AND lease_until<=?')
        .bind(started,started+130000,started).run();
      if ((claim.meta?.changes ?? claim.changes)!==1) {
        const state=await env.LEDGER_DB.prepare('SELECT * FROM learning_refresh_guard WHERE id=1').first();
        Object.assign(guard,state);
        return [409,{...snapshot(),request_message:'学習記録を取得しています。少しお待ちください。'}];
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
