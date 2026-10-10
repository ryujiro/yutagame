import bundled from '../../public-data/dashboard.json' with { type: 'json' };
import { cleanRecord, isoJst, todayJst, STAGES, errorMessage } from './learning.js';

const STATUSES = ['not_configured', 'passed', 'failed', 'missing_credentials'];
const CODES = ['fetch_failed', 'manual_authentication_required', 'single_child_required_manual_selection_needed'];

export function cleanSavedData(value) {
  if (!value || !Array.isArray(value.history) || value.history.length > 100) throw new Error('invalid_data');
  const history = value.history.map(record => cleanRecord(record)).sort((a, b) => Date.parse(b.fetched_at) - Date.parse(a.fetched_at));
  let lastAttempt = null;
  if (value.last_attempt != null) {
    if (typeof value.last_attempt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.last_attempt) || !Number.isFinite(Date.parse(value.last_attempt))) throw new Error('invalid_attempt');
    lastAttempt = isoJst(Date.parse(value.last_attempt));
  }
  const status = STATUSES.includes(value.collection_status) ? value.collection_status : 'not_configured';
  const stage = STAGES.includes(value.failure_stage) ? value.failure_stage : 'extraction';
  const code = CODES.includes(value.failure_code) ? value.failure_code : 'fetch_failed';
  return { history, last_attempt: lastAttempt, collection_status: status,
    failure_stage: status === 'failed' ? stage : null, failure_code: status === 'failed' ? code : null };
}

export async function savedDashboard(env = {}, fetcher = fetch, clock = Date.now) {
  let saved = cleanSavedData(bundled), sourceError = false;
  // 固定の公開JSONだけを読む。ログイン・トークン・Cookieは扱わない。
  if (env.RECORDS_URL) {
    try {
      const url = new URL(env.RECORDS_URL);
      if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' || url.username || url.password || url.search) throw new Error('invalid_source');
      // workerdはredirect='error'に非対応。manualで3xxを受理せず止める。
      const response = await fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(6500) });
      if (!response.ok) throw new Error('source_unavailable');
      const text = await response.text();
      if (text.length > 150000) throw new Error('source_too_large');
      const remote = cleanSavedData(JSON.parse(text));
      // 古いCDN応答で、ビルドに含めた取得結果を巻き戻さない。
      const remoteTime = Date.parse(remote.last_attempt || remote.history[0]?.fetched_at || '') || 0;
      const bundledTime = Date.parse(saved.last_attempt || saved.history[0]?.fetched_at || '') || 0;
      if (remoteTime >= bundledTime) saved = remote;
    } catch { sourceError = true; }
  }
  const error = sourceError ? { title: '最新の保存記録を確認できませんでした', message: '保存された記録を表示しています。時間をおいて表示を更新してください。', stage: 'connection' }
    : saved.collection_status === 'failed' ? errorMessage(saved.failure_code, saved.failure_stage) : null;
  return { record: saved.history[0] || null, history: saved.history, today: todayJst(clock()),
    server_time: isoJst(clock()), refreshing: false, retry_after_seconds: 0, next_refresh_at: null,
    refresh_mode: 'saved_records', collection_status: saved.collection_status,
    last_collection_attempt: saved.last_attempt, error };
}
