export const STAGES = ['connection', 'login_page', 'authentication', 'records_page', 'extraction'];
export const REQUIRED_ENV = ['SMILE_ZEMI_LOGIN_ID', 'SMILE_ZEMI_PASSWORD'];
// Only these fixed identifiers may leave the browser. Never publish exception text.
export const ERROR_CODES = [
  'fetch_failed', 'missing_environment_variables', 'manual_authentication_required',
  'single_child_required_manual_selection_needed', 'browser_binding_missing',
  'fetch_timeout', 'browser_timeout', 'browser_operation_failed', 'unsafe_destination',
  'login_form_payload_not_ready', 'request_handling_failed', 'login_http_error',
  'login_destination_changed', 'login_rejected_no_automatic_retry',
  'authentication_success_not_confirmed', 'children_response_timeout',
  'timeline_timeout', 'timeline_http_error', 'timeline_response_unreadable', 'timeline_missing',
  'timeline_schema_changed', 'timeline_invalid', 'timeline_subject_invalid',
  'today_record_missing', 'today_record_missing_or_ambiguous',
  'today_display_missing_or_ambiguous', 'display_missing_or_ambiguous', 'display_changed',
  'duration_missing_or_ambiguous', 'duration_invalid', 'invalid_record', 'invalid_subjects',
  'invalid_timestamp', 'subject_total_mismatch', 'subject_name_invalid',
  'api_display_mismatch', 'jst_date_changed_retry_required',
];
export const SUBJECTS = { MAT: '数学', JPN: '国語', SCI: '理科', SOC: '社会', ENG: '英語', TEC: '技術', HOM: '家庭', HAP: '保体', ART: '美術', MUS: '音楽', EKN: '英検', EK2: '英語プレミアム' };
export const SELECTORS = {
  marker: '.dailyLogRoot__J7L4P', root: '.dailyRoot__a754V', date: '.date__FKSSm',
  total: '.studyDateInner__s0Jtj > div:last-child', subjects: '.subject__bWHro',
  name: '.summary__raEvD .name__TRpmJ', minutes: '.summary__raEvD .time__Pn3gb',
};

export class LearningError extends Error {
  constructor(stage, code) { super(code); this.stage = stage; this.code = code; }
}
export function isoJst(time = Date.now()) { return new Date(time + 9 * 3600000).toISOString().slice(0, 19) + '+09:00'; }
export function todayJst(time = Date.now()) { return isoJst(time).slice(0, 10); }
export function validDate(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const value = Date.parse(day + 'T12:00:00Z');
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === day;
}
export function minutes(text) {
  const normalized = String(text).normalize('NFKC').replace(/\s+/g, '');
  const found = /^(?:(?:合計|学習時間|合計学習時間|当日の合計学習時間)[:：]?)?(?:(\d+)時間)?(\d+)分$/.exec(normalized);
  if (!found) throw new LearningError('extraction', 'duration_missing_or_ambiguous');
  const result = Number(found[1] || 0) * 60 + Number(found[2]);
  if (!Number.isSafeInteger(result)) throw new LearningError('extraction', 'duration_invalid');
  return result;
}
export function cleanRecord(value, requireTimestamp = true) {
  if (!value || !validDate(value.date) || !Number.isSafeInteger(value.total_minutes) || value.total_minutes < 0) throw new LearningError('extraction', 'invalid_record');
  let subjects = null;
  if (value.subjects != null) {
    const names = Object.values(SUBJECTS);
    if (Array.isArray(value.subjects) || typeof value.subjects !== 'object' || !Object.keys(value.subjects).length) throw new LearningError('extraction', 'invalid_subjects');
    subjects = {};
    for (const [name, number] of Object.entries(value.subjects)) {
      if (!names.includes(name) || !Number.isSafeInteger(number) || number < 0) throw new LearningError('extraction', 'invalid_subjects');
      subjects[name] = number;
    }
    if (Object.values(subjects).reduce((a, b) => a + b, 0) !== value.total_minutes) throw new LearningError('extraction', 'subject_total_mismatch');
  }
  const result = { date: value.date, total_minutes: value.total_minutes, subjects };
  if (requireTimestamp) {
    if (typeof value.fetched_at !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.fetched_at) || !Number.isFinite(Date.parse(value.fetched_at))) throw new LearningError('extraction', 'invalid_timestamp');
    result.fetched_at = isoJst(Date.parse(value.fetched_at));
  }
  return result;
}
export function parseTimeline(data) {
  const timelines = data?.response_data?.timelines;
  if (!Array.isArray(timelines)) throw new LearningError('extraction', 'timeline_schema_changed');
  const seen = new Set();
  return timelines.map(item => {
    if (!validDate(item?.date) || seen.has(item.date) || !Array.isArray(item.reports)) throw new LearningError('extraction', 'timeline_invalid');
    seen.add(item.date);
    const subjects = {};
    for (const report of item.reports) {
      const name = SUBJECTS[report?.subject];
      if (!name || Object.hasOwn(subjects, name) || !Number.isSafeInteger(report.elapsed_time) || report.elapsed_time < 0) throw new LearningError('extraction', 'timeline_subject_invalid');
      subjects[name] = report.elapsed_time;
    }
    return cleanRecord({ date: item.date, total_minutes: item.elapsed_time, subjects: Object.keys(subjects).length ? subjects : null }, false);
  });
}
export function equalRecords(a, b) {
  return a.date === b.date && a.total_minutes === b.total_minutes &&
    (a.subjects === null && b.subjects === null || a.subjects !== null && b.subjects !== null &&
      Object.keys(a.subjects).length === Object.keys(b.subjects).length &&
      Object.entries(a.subjects).every(([name, value]) => b.subjects[name] === value));
}
async function visibleOne(root, selector, stage = 'extraction') {
  const locator = root.locator(selector).filter({ visible: true });
  if (await locator.count() !== 1) throw new LearningError(stage, 'display_missing_or_ambiguous');
  return locator;
}
export async function extractToday(page, records, today, clock = Date.now) {
  const expected = records.filter(record => record.date === today);
  if (expected.length === 0) throw new LearningError('extraction', 'today_record_missing');
  if (expected.length !== 1) throw new LearningError('extraction', 'today_record_missing_or_ambiguous');
  const d = new Date(today + 'T12:00:00+09:00');
  const weekday = new Intl.DateTimeFormat('ja-JP', { weekday: 'short', timeZone: 'Asia/Tokyo' }).format(d);
  const [, month, day] = today.split('-').map(Number);
  const label = `${month}/${day}(${weekday})`;
  const matching = [];
  for (const root of await page.locator(SELECTORS.root).filter({ visible: true }).all()) {
    if ((await (await visibleOne(root, SELECTORS.date)).innerText()).normalize('NFKC').trim() === label) matching.push(root);
  }
  if (matching.length !== 1) throw new LearningError('extraction', 'today_display_missing_or_ambiguous');
  const root = matching[0];
  const read = async () => {
    if ((await (await visibleOne(root, SELECTORS.date)).innerText()).normalize('NFKC').trim() !== label) throw new LearningError('extraction', 'display_changed');
    const total = minutes(await (await visibleOne(root, SELECTORS.total)).innerText());
    const subjects = {};
    for (const row of await root.locator(SELECTORS.subjects).filter({ visible: true }).all()) {
      const name = (await (await visibleOne(row, SELECTORS.name)).innerText()).trim();
      if (!Object.values(SUBJECTS).includes(name) || Object.hasOwn(subjects, name)) throw new LearningError('extraction', 'subject_name_invalid');
      subjects[name] = minutes((await (await visibleOne(row, SELECTORS.minutes)).innerText()) + '分');
    }
    return cleanRecord({ date: today, total_minutes: total, subjects: Object.keys(subjects).length ? subjects : null }, false);
  };
  const result = await read();
  if (!equalRecords(result, expected[0])) throw new LearningError('extraction', 'api_display_mismatch');
  if (!equalRecords(result, await read())) throw new LearningError('extraction', 'display_changed');
  if (todayJst(clock()) !== today) throw new LearningError('extraction', 'jst_date_changed_retry_required');
  return { ...result, fetched_at: isoJst(clock()) };
}
export function errorMessage(code, stage) {
  code = ERROR_CODES.includes(code) ? code : 'fetch_failed';
  stage = STAGES.includes(stage) ? stage : 'extraction';
  let title, message;
  if (code === 'today_record_missing' && stage === 'extraction') {
    title = '今日の学習記録はまだありません'; message = 'みまもるネットへのログインはできましたが、今日の記録は取得元にありません。学習後、タブレットから記録が反映されてから更新してください。';
  } else if (code === 'missing_environment_variables') {
    title = '更新の準備ができていません'; message = '環境設定にログインIDとパスワードを登録してください。';
  } else if (code === 'manual_authentication_required') {
    title = '手動での確認が必要です'; message = 'みまもるネットを開き、認証コードなどの確認を済ませてください。';
  } else if (code === 'single_child_required_manual_selection_needed') {
    title = 'お子さまの選択が必要です'; message = '現在は、お子さまが1人の中学生コースに対応しています。';
  } else if (stage === 'authentication') {
    title = 'ログインを確認できませんでした'; message = '時間をおいて更新してください。続く場合は、みまもるネットのログイン状態を確認してください。';
  } else if (['connection', 'login_page'].includes(stage)) {
    title = 'みまもるネットに接続できませんでした'; message = '接続状況を確認し、時間をおいて更新してください。';
  } else {
    title = '学習記録を取得できませんでした'; message = 'みまもるネットで今日の記録を確認し、時間をおいて更新してください。';
  }
  return { title, message, stage, code };
}
