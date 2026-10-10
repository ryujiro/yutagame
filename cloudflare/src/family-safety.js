import { timingSafeEqual } from 'node:crypto';
import { todayJst, isoJst } from './learning.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const eventId = /^[a-f0-9]{64}$/;
function stamp(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid_timestamp');
  return new Date(value).toISOString();
}
function only(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('invalid_fields');
}
function minutes(value, nullable = false) {
  if (nullable && value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 1440) throw new Error('invalid_minutes');
  return value;
}
export function cleanGrant(value, now = Date.now()) {
  only(value, ['event_id', 'source_id', 'subject_id', 'occurred_at', 'allow_until', 'observed_at', 'source', 'detection_method', 'estimated_minutes']);
  if (!eventId.test(value.event_id) || !uuid.test(value.source_id) || !/^[a-z0-9_-]{1,40}$/.test(value.subject_id)) throw new Error('invalid_id');
  if (!['windows_wpc_sync', 'windows_wpc_policy'].includes(value.source) || value.detection_method !== 'explicit_allow_until_deadline') throw new Error('invalid_source');
  const occurred_at = stamp(value.occurred_at), allow_until = stamp(value.allow_until), observed_at = stamp(value.observed_at);
  if (Date.parse(allow_until) <= Date.parse(occurred_at) || Date.parse(occurred_at) > now + 300000 || Date.parse(observed_at) > now + 300000) throw new Error('invalid_time_range');
  // A deadline proves permission was changed, not the number of minutes chosen.
  return { event_id: value.event_id, source_id: value.source_id, subject_id: value.subject_id,
    occurred_at, allow_until, observed_at, source: value.source, detection_method: value.detection_method,
    estimated_minutes: minutes(value.estimated_minutes, true) };
}
export function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const actual = Buffer.from(request.headers.get('Authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function ingestGrant(db, value, now = Date.now()) {
  const e = cleanGrant(value, now);
  await db.prepare(`INSERT INTO grant_events
    (event_id,source_id,subject_id,occurred_at,allow_until,observed_at,source,detection_method,estimated_minutes,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`)
    .bind(e.event_id,e.source_id,e.subject_id,e.occurred_at,e.allow_until,e.observed_at,e.source,e.detection_method,e.estimated_minutes,new Date(now).toISOString()).run();
  const stored = await db.prepare('SELECT source_id,subject_id,occurred_at,allow_until FROM grant_events WHERE event_id=?').bind(e.event_id).first();
  if (!stored || ['source_id','subject_id','occurred_at','allow_until'].some(key => stored[key] !== e[key])) return [409, { error: 'event_conflict' }];
  return [200, { accepted: true, event_id: e.event_id }];
}
export async function confirmGrant(db, id, value, now = Date.now()) {
  only(value, ['granted_minutes', 'method']);
  const amount = minutes(value.granted_minutes);
  if (!eventId.test(id) || value.method !== 'parent_verified_selected_minutes') throw new Error('invalid_confirmation');
  const stored = await db.prepare('SELECT confirmation_status,granted_minutes FROM grant_events WHERE event_id=?').bind(id).first();
  if (!stored) return [404, { error: 'event_not_found' }];
  if (stored.confirmation_status === 'confirmed' && stored.granted_minutes !== amount) return [409, { error: 'confirmation_conflict' }];
  await db.batch([
    db.prepare('INSERT INTO grant_confirmations(event_id,granted_minutes,confirmed_at,method) VALUES(?,?,?,?) ON CONFLICT(event_id) DO NOTHING').bind(id,amount,new Date(now).toISOString(),value.method),
    db.prepare(`UPDATE grant_events SET granted_minutes=(SELECT granted_minutes FROM grant_confirmations WHERE event_id=?),confirmation_status='confirmed' WHERE event_id=?`).bind(id,id),
  ]);
  const result = await db.prepare('SELECT granted_minutes FROM grant_confirmations WHERE event_id=?').bind(id).first();
  return result.granted_minutes === amount ? [200, { confirmed: true, event_id: id }] : [409, { error: 'confirmation_conflict' }];
}
export async function ingestStatus(db, value, now = Date.now()) {
  only(value, ['source_id','checked_at','read_status','coverage_start','local_used_minutes']);
  if (!uuid.test(value.source_id) || !['ok','error'].includes(value.read_status)) throw new Error('invalid_status');
  const checked = stamp(value.checked_at), coverage = value.coverage_start == null ? null : stamp(value.coverage_start);
  if (Date.parse(checked) > now + 300000 || (value.local_used_minutes != null && (!Number.isInteger(value.local_used_minutes) || value.local_used_minutes < 0 || value.local_used_minutes > 1440))) throw new Error('invalid_status');
  await db.prepare(`INSERT INTO bridge_status(source_id,checked_at,read_status,coverage_start,local_used_minutes) VALUES(?,?,?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,read_status=excluded.read_status,
    coverage_start=excluded.coverage_start,local_used_minutes=excluded.local_used_minutes
    WHERE excluded.checked_at>=bridge_status.checked_at`).bind(value.source_id,checked,value.read_status,coverage,value.local_used_minutes ?? null).run();
  return [200, { accepted: true }];
}
export async function importLearning(db, history) {
  const daily = new Map();
  for (const record of history) if (!daily.has(record.date) || Date.parse(record.fetched_at) > Date.parse(daily.get(record.date).fetched_at)) daily.set(record.date, record);
  if (daily.size) await db.batch([...daily.values()].map(r => db.prepare(`INSERT INTO learning_days(date,total_minutes,fetched_at,subjects_json) VALUES(?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET total_minutes=excluded.total_minutes,fetched_at=excluded.fetched_at,subjects_json=excluded.subjects_json
    WHERE excluded.fetched_at>learning_days.fetched_at`).bind(r.date,r.total_minutes,new Date(r.fetched_at).toISOString(),JSON.stringify(r.subjects))));
}
export function summarizeLedger(days, events, bridges, now = Date.now()) {
  const today = todayJst(now), learned = days.reduce((sum,r) => sum+r.total_minutes,0);
  const confirmed = events.filter(e => e.confirmation_status === 'confirmed');
  const spent = confirmed.reduce((sum,e) => sum+e.granted_minutes,0);
  const pending = events.filter(e => e.confirmation_status !== 'confirmed');
  const learningDates = new Set(days.map(d => d.date));
  const missingDays = [...new Set(events.map(e => todayJst(Date.parse(e.occurred_at))))].filter(d => !learningDates.has(d));
  const connected = bridges.length > 0 && bridges.every(b => b.read_status === 'ok' && now-Date.parse(b.checked_at) <= 300000);
  const day = days.find(d => d.date === today);
  return { today_learning_minutes: day?.total_minutes ?? null,
    today_granted_minutes: connected ? confirmed.filter(e => todayJst(Date.parse(e.occurred_at)) === today).reduce((sum,e) => sum+e.granted_minutes,0) : null,
    total_learning_minutes: days.length ? learned : null, total_granted_minutes: spent,
    confirmed_balance_minutes: days.length ? learned-spent : null,
    balance_minutes: connected && days.length && pending.length === 0 && missingDays.length === 0 ? learned-spent : null,
    missing_learning_days: missingDays,
    pending_count: pending.length, integration_status: connected ? 'connected' : bridges.length ? 'stale' : 'not_connected',
    coverage_start: days.length ? days.at(-1).date : null,
    learning_history: days, grant_history: events,
    last_sync_at: bridges.map(b => b.checked_at).sort().at(-1) || null,
    server_time: isoJst(now) };
}
export async function ledgerDashboard(db, history, now = Date.now()) {
  await importLearning(db, history);
  const [days, events, bridges] = await Promise.all([
    db.prepare('SELECT date,total_minutes,fetched_at FROM learning_days ORDER BY date DESC').all(),
    db.prepare('SELECT event_id,occurred_at,allow_until,source,detection_method,estimated_minutes,granted_minutes,confirmation_status,observed_at FROM grant_events ORDER BY occurred_at DESC').all(),
    db.prepare('SELECT checked_at,read_status FROM bridge_status').all(),
  ]);
  return summarizeLedger(days.results,events.results,bridges.results,now);
}
export async function familySafetyApi(request, env, path) {
  if (!authorized(request, env.FAMILY_SAFETY_INGEST_TOKEN)) return [401, { error: 'unauthorized' }];
  if (!env.LEDGER_DB) return [503, { error: 'storage_not_configured' }];
  if (request.method !== 'POST') return [405, { error: 'method_not_allowed' }];
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return [415, { error: 'json_required' }];
  const body = await request.text();
  if (body.length > 4096) return [413, { error: 'request_too_large' }];
  try {
    const data = JSON.parse(body);
    if (path === '/api/family-safety/events') return await ingestGrant(env.LEDGER_DB,data);
    if (path === '/api/family-safety/status') return await ingestStatus(env.LEDGER_DB,data);
    const confirm = path.match(/^\/api\/family-safety\/events\/([a-f0-9]{64})\/confirm$/);
    if (confirm) return await confirmGrant(env.LEDGER_DB,confirm[1],data);
    return [404, { error: 'not_found' }];
  } catch (error) {
    if (error.message?.startsWith('invalid_') || error instanceof SyntaxError) return [400, { error: 'invalid_request' }];
    return [503, { error: 'storage_unavailable' }];
  }
}
