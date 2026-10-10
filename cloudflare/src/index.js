import { savedDashboard } from './saved-records.js';

function json(value, status = 200) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (status === 429) headers['Retry-After'] = String(value.retry_after_seconds);
  return new Response(JSON.stringify(value), { status, headers });
}

export default {
  async fetch(request, env) {
    let response;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') response = json({ status: 'ok', mode: 'saved_records' });
      else if (url.pathname === '/api/dashboard' && request.method === 'GET') response = json(await savedDashboard(env));
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
