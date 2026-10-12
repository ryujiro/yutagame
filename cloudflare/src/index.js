import { savedDashboard } from './saved-records.js';
import { familySafetyApi, ledgerDashboard, importLearning } from './family-safety.js';
import { manualLearning } from './manual-learning.js';
import { recentBalance } from './balance.js';
import { adjustmentApi, readAdjustments } from './manual-adjustments.js';

function json(value, status = 200) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (status === 429) headers['Retry-After'] = String(value.retry_after_seconds);
  return new Response(JSON.stringify(value), { status, headers });
}

export default {
  async scheduled(controller, env, ctx) {
    if (env.LEDGER_DB) ctx.waitUntil(savedDashboard(env).then(d => importLearning(env.LEDGER_DB,d.history)));
  },
  async fetch(request, env) {
    let response;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') response = json({ status: 'ok', mode: 'saved_records' });
      else if (url.pathname === '/api/manual-adjustments') {
        const [status,body]=await adjustmentApi(request,env);
        response=json(body,status);
      }
      else if (url.pathname.startsWith('/api/family-safety/')) {
        const [status, body] = await familySafetyApi(request,env,url.pathname);
        response = json(body,status);
      }
      else if ((url.pathname === '/api/dashboard' && request.method === 'GET') || (url.pathname === '/api/refresh' && request.method === 'POST' && env.BROWSER && env.LEDGER_DB)) {
        let dashboard = await savedDashboard(env), status=200;
        if (env.BROWSER && env.LEDGER_DB) {
          if (request.method==='POST' && (request.headers.get('Origin')!==url.origin || request.headers.get('X-Learning-Request')!=='1')) return json({message:'forbidden'},403);
          try {
            const learning=await manualLearning(env,dashboard);
            if (request.method==='POST') [status,dashboard]=await learning.refresh();
            else dashboard=learning.snapshot();
          } catch {
            dashboard={...dashboard,request_message:'最新記録の取得処理を利用できませんでした。前回の記録を表示しています。'};
            if (request.method==='POST') status=503;
          }
        }
        if (env.LEDGER_DB) {
          try {
            dashboard.ledger = await ledgerDashboard(env.LEDGER_DB,dashboard.history);
            dashboard.ledger.recent = recentBalance(dashboard.ledger);
            try {
              dashboard.ledger.adjustment_history=await readAdjustments(env.LEDGER_DB);
              dashboard.ledger.adjustment_ready=true;
              dashboard.ledger.recent=recentBalance(dashboard.ledger);
            } catch {
              dashboard.ledger.adjustment_error='手動調整の記録を読み込めませんでした。';
              dashboard.ledger.recent.balance_minutes=null;
              dashboard.ledger.recent.confirmed_balance_minutes=null;
              dashboard.ledger.recent.estimated_balance_minutes=null;
            }
          }
          catch { dashboard.ledger_error = '時間の記録を読み込めませんでした。'; }
        }
        response = json(dashboard,status);
      }
      else if (url.pathname.startsWith('/api/')) response = json({ message: 'not_found' }, 404);
      else response = await env.ASSETS.fetch(request);
    } catch { response = json({ message: 'service_unavailable' }, 503); }
    response = new Response(response.body, response);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return response;
  }
};
