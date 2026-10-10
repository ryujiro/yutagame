import { savedDashboard } from './saved-records.js';
import { familySafetyApi, ledgerDashboard, importLearning } from './family-safety.js';

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
      else if (url.pathname.startsWith('/api/family-safety/')) {
        const [status, body] = await familySafetyApi(request,env,url.pathname);
        response = json(body,status);
      }
      else if (url.pathname === '/api/dashboard' && request.method === 'GET') {
        const dashboard = await savedDashboard(env);
        if (env.LEDGER_DB) {
          try { dashboard.ledger = await ledgerDashboard(env.LEDGER_DB,dashboard.history); }
          catch { dashboard.ledger_error = '時間の記録を読み込めませんでした。'; }
        }
        response = json(dashboard);
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
