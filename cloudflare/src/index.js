import { DurableObject } from 'cloudflare:workers';
import { launch } from '@cloudflare/playwright';
import seed from '../../verification-results/today.json';
import { LearningService } from './service.js';
import { fetchTodayLearningTime } from './fetch-smile.js';

function json(value, status = 200) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (status === 429) headers['Retry-After'] = String(value.retry_after_seconds);
  return new Response(JSON.stringify(value), { status, headers });
}

export class LearningStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.service = new LearningService(ctx.storage, env, seed, (env, progress, clock) => fetchTodayLearningTime(env, progress, clock, launch));
    ctx.blockConcurrencyWhile(() => this.service.initialize());
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/dashboard') return json(this.service.snapshot());
    if (request.method === 'POST' && url.pathname === '/api/refresh') {
      const [status, data] = await this.service.refresh();
      return json(data, status);
    }
    return json({ message: 'not_found' }, 404);
  }
}

export default {
  async fetch(request, env) {
    let response;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') response = json({ status: 'ok' });
      else if (url.pathname.startsWith('/api/')) {
        if (request.method === 'POST' && (request.headers.get('X-Learning-Request') !== '1' || request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)) return json({ message: 'request_not_allowed' }, 403);
        const store = env.LEARNING_STORE.get(env.LEARNING_STORE.idFromName('family-learning-records'));
        response = await store.fetch(request);
      } else response = await env.ASSETS.fetch(request);
    } catch { response = json({ message: 'service_unavailable' }, 503); }
    response = new Response(response.body, response);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return response;
  }
};
