import { LearningError, isoJst, todayJst, validDate } from './learning.js';

export const MONTHLY_SUBJECTS = { MAT: '数学', ENG: '英語', JPN: '国語', SCI: '理科', SOC: '社会' };
export const MONTHLY_FAILURE = '月の取り組みを取得できませんでした。前回の記録を表示しています。';
const SELECTORS = {
  root: '.monthlyRoot__sslKD', title: '.title__WpbZL > div:last-child', grade: '.gradeText__hL0ZG',
  total: '.totalContainer__XpCSt .studiedCount__ITtrS', target: '.totalContainer__XpCSt .totalCount__sao43',
  rows: '.statusRoot__GYJb7', name: '.subjectText__bwaB5', count: '.subjectCount__HmPoV .studiedCount__mtwi1',
  guide: '.subjectCount__HmPoV .totalCount__GuHj5',
};
function invalid(code = 'monthly_invalid') { throw new LearningError('extraction', code); }
function count(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) invalid(); return value; }
function displayCount(text, guide = false) {
  const value = text.normalize('NFKC').replace(/\s/g, '');
  if (!(guide ? /^\/\d+$/ : /^\d+$/).test(value)) invalid('monthly_display_invalid');
  return count(Number(guide ? value.slice(1) : value));
}
export function cleanMonthly(value, requireTimestamp = true) {
  if (!value || typeof value.month !== 'string' || !/^\d{4}-\d{2}$/.test(value.month) || !validDate(`${value.month}-01`) || !Number.isInteger(value.grade) || value.grade < 1 || value.grade > 3) invalid();
  const total_count = count(value.total_count), target_count = count(value.target_count), subjects = {};
  if (!value.subjects || Array.isArray(value.subjects) || typeof value.subjects !== 'object' || Object.keys(value.subjects).length !== 5) invalid();
  for (const name of Object.values(MONTHLY_SUBJECTS)) {
    const row = value.subjects[name];
    if (!row) invalid();
    subjects[name] = { count: count(row.count), target: count(row.target) };
  }
  if (Object.values(subjects).reduce((sum, row) => sum + row.count, 0) !== total_count || Object.values(subjects).reduce((sum, row) => sum + row.target, 0) !== target_count) invalid('monthly_total_mismatch');
  const result = { month: value.month, grade: value.grade, total_count, target_count, subjects };
  if (requireTimestamp) {
    if (typeof value.fetched_at !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.fetched_at) || !Number.isFinite(Date.parse(value.fetched_at))) invalid('monthly_timestamp_invalid');
    result.fetched_at = isoJst(Date.parse(value.fetched_at));
  }
  return result;
}
export function parseMonthly(data) {
  const reports = data?.response_data?.monthly_reports;
  if (!Array.isArray(reports) || reports.length > 120) invalid('monthly_schema_changed');
  const seen = new Set();
  return reports.map(item => {
    if (!Number.isInteger(item?.year) || item.year < 2000 || item.year > 2100 || !Number.isInteger(item.month) || item.month < 1 || item.month > 12 || !Array.isArray(item.report?.subjects_report)) invalid();
    const month = `${item.year}-${String(item.month).padStart(2, '0')}`;
    if (seen.has(month)) invalid('monthly_duplicate'); seen.add(month);
    const subjects = {};
    for (const row of item.report.subjects_report) {
      const name = MONTHLY_SUBJECTS[row?.subject];
      if (!name || Object.hasOwn(subjects, name)) invalid('monthly_subject_invalid');
      subjects[name] = { count: row.studied_count, target: row.guide_study_count };
    }
    return cleanMonthly({ month, grade: item.grade, total_count: item.report.total_studied_count, target_count: item.report.total_guide_study_count, subjects }, false);
  });
}
export function mergeMonthly(history, record) {
  const byMonth = new Map();
  for (const value of [...history, record]) {
    const clean = cleanMonthly(value), previous = byMonth.get(clean.month);
    if (!previous || Date.parse(clean.fetched_at) > Date.parse(previous.fetched_at)) byMonth.set(clean.month, clean);
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 120);
}
export async function extractMonthly(page, reports, month, clock = Date.now) {
  const expected = reports.filter(record => record.month === month);
  if (expected.length !== 1) invalid('monthly_current_missing');
  const roots = page.locator(SELECTORS.root).filter({ visible: true });
  await roots.first().waitFor({ timeout: 8000 });
  if (await roots.count() !== 1) invalid('monthly_display_ambiguous');
  const root = roots.first();
  const text = async selector => {
    const field = root.locator(selector).filter({ visible: true });
    if (await field.count() !== 1) invalid('monthly_display_ambiguous');
    return field.innerText();
  };
  const read = async () => {
    if ((await text(SELECTORS.title)).trim() !== `${Number(month.slice(5))}月の学習` || (await text(SELECTORS.grade)).trim() !== `中${expected[0].grade}`) invalid('monthly_display_month_mismatch');
    const subjects = {};
    for (const row of await root.locator(SELECTORS.rows).filter({ visible: true }).all()) {
      const field = async selector => {
        const locator = row.locator(selector).filter({ visible: true });
        if (await locator.count() !== 1) invalid('monthly_display_ambiguous');
        return locator.innerText();
      };
      const name = (await field(SELECTORS.name)).trim();
      if (!Object.values(MONTHLY_SUBJECTS).includes(name) || Object.hasOwn(subjects, name)) invalid('monthly_subject_invalid');
      subjects[name] = { count: displayCount(await field(SELECTORS.count)), target: displayCount(await field(SELECTORS.guide), true) };
    }
    return cleanMonthly({ month, grade: expected[0].grade, total_count: displayCount(await text(SELECTORS.total)), target_count: displayCount(await text(SELECTORS.target), true), subjects }, false);
  };
  const result = await read();
  if (JSON.stringify(result) !== JSON.stringify(expected[0]) || JSON.stringify(result) !== JSON.stringify(await read())) invalid('monthly_api_display_mismatch');
  if (todayJst(clock()).slice(0, 7) !== month) invalid('monthly_date_changed');
  return { ...result, fetched_at: isoJst(clock()) };
}
export async function fetchMonthlyRecord(page, clock = Date.now) {
  const month = todayJst(clock()).slice(0, 7);
  const [response] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return ['smile-zemi.jp', 'm.smile-zemi.jp'].includes(url.hostname) && /^\/api\/chu\/timeline\/v2\/monthly-report\/[^/]+$/.test(url.pathname) && response.request().method() === 'GET';
    }, { timeout: 8000 }),
    page.getByRole('button', { name: '月', exact: true }).click({ timeout: 8000 }),
  ]);
  if (response.status() !== 200) invalid('monthly_http_error');
  return extractMonthly(page, parseMonthly(await response.json()), month, clock);
}
