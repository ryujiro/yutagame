import { LearningError, SELECTORS, parseTimeline, extractToday, todayJst } from './learning.js';
import { fetchMonthlyRecord } from './monthly.js';

const LOGIN = 'https://smile-zemi.jp/mimamoru-net/ui/login';
const LOGIN_API = 'https://m.smile-zemi.jp/api/common/login';
const HOSTS = new Set(['smile-zemi.jp', 'm.smile-zemi.jp']);
async function challenge(page) {
  if (page.frames().some(frame => /recaptcha|hcaptcha|challenges\.cloudflare/.test(new URL(frame.url()).hostname))) return true;
  for (const selector of ['iframe[title*="reCAPTCHA"]', 'iframe[title*="CAPTCHA"]', 'input[autocomplete="one-time-code"]']) {
    if (await page.locator(selector).filter({ visible: true }).count()) return true;
  }
  return await page.getByText(/認証コードを入力|確認コードを入力|ロボットではないことを確認/).filter({ visible: true }).count() > 0;
}

// 画面操作・DOM/API照合をPython版と同じ条件で行う。秘密・DOMは保存しない。
export async function fetchTodayLearningTime(env, progress, clock = Date.now, launchBrowser) {
  if (!env.SMILE_ZEMI_LOGIN_ID || !env.SMILE_ZEMI_PASSWORD) throw new LearningError('authentication', 'missing_environment_variables');
  if (!env.BROWSER) throw new LearningError('connection', 'browser_binding_missing');
  let browser, stage = 'connection', transportFailure, timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (browser) browser.close().catch(() => {});
  }, 110000);
  const observation = {};
  let ready;
  const recordsReceived = new Promise(resolve => { ready = resolve; });
  let childrenReady;
  const childrenReceived = new Promise(resolve => { childrenReady = resolve; });
  try {
    browser = await launchBrowser(env.BROWSER);
    if (timedOut) throw new LearningError(stage, 'fetch_timeout');
    const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await context.route('**/*', async route => {
      try {
        const request = route.request(), destination = new URL(request.url());
        if (destination.protocol !== 'https:' || [...destination.searchParams.values()].some(v => v === env.SMILE_ZEMI_LOGIN_ID || v === env.SMILE_ZEMI_PASSWORD)) {
          transportFailure = 'unsafe_destination'; await route.abort(); return;
        }
        if (request.url() === LOGIN_API && request.method() === 'POST') {
          const payload = request.postDataJSON();
          if (payload?.user_id !== env.SMILE_ZEMI_LOGIN_ID || payload?.password !== env.SMILE_ZEMI_PASSWORD) {
            transportFailure = 'login_form_payload_not_ready'; await route.abort(); return;
          }
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !HOSTS.has(destination.hostname)) {
          await route.abort(); return;
        }
        await route.fallback();
      } catch {
        transportFailure = 'request_handling_failed';
        try { await route.abort(); } catch { /* 秘密を含み得る例外を出力しない。 */ }
      }
    });
    page.on('response', async response => {
      const request = response.request();
      const path = new URL(request.url()).pathname;
      const timeline = /^\/api\/chu\/timeline\/v2\/daily-report\/[^/]+$/.test(path);
      if (request.method() !== 'GET' || !HOSTS.has(new URL(request.url()).hostname)) return;
      try {
        if (response.status() !== 200) {
          if (timeline) observation.failure = 'timeline_http_error';
          return;
        }
        if (path === '/api/common/children') {
          const children = (await response.json())?.response_data?.child;
          observation.childCount = Array.isArray(children) ? children.length : null;
        } else if (timeline) observation.records = parseTimeline(await response.json());
      } catch { observation.failure = 'timeline_response_unreadable'; }
      finally { if (timeline) ready(); if (path === '/api/common/children') childrenReady(); }
    });
    const response = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response || response.status() >= 400) throw new LearningError(stage, 'login_http_error');
    progress.connection = 'passed'; stage = 'login_page';
    const destination = new URL(page.url());
    if (destination.protocol !== 'https:' || destination.hostname !== 'smile-zemi.jp') throw new LearningError(stage, 'login_destination_changed');
    await page.locator('input[type="password"]').filter({ visible: true }).first().waitFor();
    await page.getByRole('button', { name: 'ログイン', exact: true }).waitFor();
    if (await challenge(page)) throw new LearningError(stage, 'manual_authentication_required');
    progress.login_page = 'passed'; stage = 'authentication';
    await page.locator('input[type="email"][name="userId"]').fill(env.SMILE_ZEMI_LOGIN_ID);
    await page.locator('input[type="password"][name="password"]').fill(env.SMILE_ZEMI_PASSWORD);
    const [loginResponse] = await Promise.all([
      page.waitForResponse(r => r.url() === LOGIN_API && r.request().method() === 'POST', { timeout: 25000 }),
      page.getByRole('button', { name: 'ログイン', exact: true }).click(),
    ]);
    if (loginResponse.status() !== 200) throw new LearningError(stage, 'login_rejected_no_automatic_retry');
    let loginResult = await loginResponse.json();
    const confirmed = !!loginResult?.response_data?.ticket;
    loginResult = null;
    if (!confirmed) throw new LearningError(stage, 'authentication_success_not_confirmed');
    await page.locator('input[type="password"]').waitFor({ state: 'hidden', timeout: 15000 });
    await page.getByText('ログアウト', { exact: true }).filter({ visible: true }).waitFor({ timeout: 15000 });
    if (await challenge(page)) throw new LearningError(stage, 'manual_authentication_required');
    progress.authentication = 'passed'; stage = 'records_page';
    await page.locator(SELECTORS.marker).filter({ visible: true }).waitFor();
    let childTimer;
    try {
      await Promise.race([childrenReceived, new Promise((_, reject) => { childTimer = setTimeout(() => reject(new LearningError(stage, 'children_response_timeout')), 15000); })]);
    } finally { clearTimeout(childTimer); }
    if (observation.childCount !== 1) throw new LearningError(stage, 'single_child_required_manual_selection_needed');
    progress.records_page = 'passed'; stage = 'extraction';
    let timer;
    try {
      await Promise.race([recordsReceived, new Promise((_, reject) => { timer = setTimeout(() => reject(new LearningError(stage, 'timeline_timeout')), 30000); })]);
    } finally { clearTimeout(timer); }
    if (observation.failure || !observation.records) throw new LearningError(stage, observation.failure || 'timeline_missing');
    await page.locator(SELECTORS.root).filter({ visible: true }).first().waitFor();
    const result = await extractToday(page, observation.records, todayJst(clock()), clock);
    progress.extraction = 'passed';
    // Monthly counts are optional and never replace the validated daily minutes.
    try { return { ...result, monthly: await fetchMonthlyRecord(page, clock) }; }
    catch { return { ...result, monthly_error: true }; }
  } catch (error) {
    if (error instanceof LearningError) throw error;
    throw new LearningError(stage, transportFailure || 'browser_operation_failed');
  } finally {
    clearTimeout(timeout);
    if (browser) {
      try { await browser.close(); } catch { /* browser errorの内容を記録しない。 */ }
    }
  }
}
