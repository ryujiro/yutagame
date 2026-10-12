import { cleanRecord, isoJst, parseTimeline, todayJst, validDate } from './learning.js';

export function cleanArchive(value) {
  if (!value || !['complete', 'partial', 'error'].includes(value.status) ||
      !(value.cursor === null || validDate(value.cursor)) ||
      value.status === 'complete' && value.cursor !== null ||
      typeof value.checked_at !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.checked_at) ||
      !Number.isFinite(Date.parse(value.checked_at))) throw new Error('archive_invalid');
  return { status: value.status, cursor: value.cursor, checked_at: isoJst(Date.parse(value.checked_at)) };
}

export function parseArchivePage(data, clock = Date.now, before = null) {
  const records = parseTimeline(data).map(record => cleanRecord({ ...record, fetched_at: isoJst(clock()) }));
  if (records.some(record => record.date > todayJst(clock()) || before && record.date > before)) throw new Error('archive_date_invalid');
  const cursor = data?.response_data?.previous_studied_date;
  if (!(cursor === null || validDate(cursor)) || cursor !== null &&
      (!records.length || records.some(record => record.date <= cursor) || before && cursor >= before)) throw new Error('archive_cursor_invalid');
  return { records, cursor };
}

// Use the site's authenticated "more" button; a saved cursor can skip already stored pages.
export async function fetchStudyArchive(page, initial, sourceUrl, {
  clock = Date.now, deadline = Date.now() + 45000, resume = null, onPage = async () => {},
} = {}) {
  let cursor = resume?.status !== 'complete' && validDate(resume?.cursor) ? resume.cursor : null;
  let routeMatch, routeHandler;
  const state = status => ({ status, cursor, checked_at: isoJst(clock()) });
  try {
    const first = parseArchivePage(initial, clock);
    cursor = cursor || first.cursor;
    await onPage(first.records, state(cursor === null ? 'complete' : 'partial'));
    if (cursor === null) return state('complete');
    const url = new URL(sourceUrl);
    if (url.protocol !== 'https:' || !['smile-zemi.jp', 'm.smile-zemi.jp'].includes(url.hostname) ||
        !/^\/api\/chu\/timeline\/v2\/daily-report\/[^/]+$/.test(url.pathname) || url.username || url.password) throw new Error('archive_source_invalid');
    if (cursor !== first.cursor) {
      const savedCursor = cursor;
      routeMatch = destination => destination.origin === url.origin && destination.pathname === url.pathname;
      let redirected = false;
      routeHandler = async route => {
        const request = route.request(), destination = new URL(request.url());
        if (!redirected && request.method() === 'GET' && destination.searchParams.get('before') === first.cursor?.replaceAll('-', '')) {
          redirected = true;
          destination.search = '';
          destination.searchParams.set('before', savedCursor.replaceAll('-', ''));
          destination.searchParams.set('days', '7');
          await route.fallback({ url: destination.href });
        } else await route.fallback();
      };
      await page.route(routeMatch, routeHandler);
    }
    while (cursor !== null) {
      const remaining = deadline - Date.now();
      if (remaining < 1000) return state('partial');
      const timeout = Math.min(8000, remaining);
      const more = page.getByRole('button', { name: 'もっと見る', exact: true });
      await more.waitFor({ timeout });
      const [response] = await Promise.all([
        page.waitForResponse(response => {
          const destination = new URL(response.url());
          return destination.origin === url.origin && destination.pathname === url.pathname && response.request().method() === 'GET';
        }, { timeout }),
        more.click({ timeout }),
      ]);
      if (response.status() !== 200) throw new Error('archive_http_error');
      const next = parseArchivePage(await response.json(), clock, cursor);
      const checkpoint = { status: next.cursor === null ? 'complete' : 'partial', cursor: next.cursor, checked_at: isoJst(clock()) };
      await onPage(next.records, checkpoint);
      cursor = next.cursor;
    }
    return state('complete');
  } catch {
    const failed = state('error');
    try { await onPage([], failed); } catch { /* Keep the last durable checkpoint. */ }
    return failed;
  } finally {
    if (routeMatch) { try { await page.unroute(routeMatch, routeHandler); } catch { /* Browser may already be closed. */ } }
  }
}

export function summarizeStudy(history = [], scan = null) {
  const byDate = new Map();
  for (const value of history) {
    const record = cleanRecord(value);
    const previous = byDate.get(record.date);
    if (!previous || Date.parse(record.fetched_at) > Date.parse(previous.fetched_at)) byDate.set(record.date, record);
  }
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  const months = new Map();
  for (const record of days) {
    const month = record.date.slice(0, 7), summary = months.get(month) || { month, total_minutes: 0, recorded_days: 0 };
    summary.total_minutes += record.total_minutes; summary.recorded_days++;
    months.set(month, summary);
  }
  return { total_minutes: days.length ? days.reduce((sum, day) => sum + day.total_minutes, 0) : null,
    recorded_days: days.length, first_date: days.at(-1)?.date || null, last_date: days[0]?.date || null,
    days, months: [...months.values()], scan };
}
