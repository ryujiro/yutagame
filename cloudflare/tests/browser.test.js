import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { fetchTodayLearningTime } from '../src/fetch-smile.js';
import { STAGES, LearningError } from '../src/learning.js';

const clock = () => Date.parse('2026-10-10T18:00:00+09:00');
const credentials = { BROWSER: {}, SMILE_ZEMI_LOGIN_ID: 'unit-test-id', SMILE_ZEMI_PASSWORD: 'unit-test-password' };
// このHTML/APIは合成フィクスチャ。実サイト・認証情報・子どものデータを使わない。
function html(mismatch = false) {
  return `<!doctype html><html lang="ja"><head><meta charset="UTF-8"></head><body><input type="email" name="userId"><input type="password" name="password"><button>ログイン</button><script>
  document.querySelector('button').onclick=async()=>{
    const response=await fetch('https://m.smile-zemi.jp/api/common/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:document.querySelector('[name=userId]').value,password:${mismatch ? "''" : "document.querySelector('[name=password]').value"}})});
    if(!response.ok)return;
    document.body.innerHTML='<button>ログアウト</button><div class="dailyLogRoot__J7L4P"><div class="dailyRoot__a754V"><div class="date__FKSSm">10/10(土)</div><div class="studyDateInner__s0Jtj"><div>合計</div><div>7分</div></div><div class="subject__bWHro"><div class="summary__raEvD"><div class="name__TRpmJ">数学</div><div class="time__Pn3gb">7</div></div></div></div></div>';
    fetch('https://m.smile-zemi.jp/api/common/children');
    fetch('https://m.smile-zemi.jp/api/chu/timeline/v2/daily-report/synthetic-child');
  };</script></body></html>`;
}
async function fixture(options = {}) {
  const executablePath=process.env.CHROME_PATH || (process.platform==='win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/chromium');
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const stats = { posts: 0, contexts: 0, unexpectedRequests: 0 };
  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await originalNewContext(...args);
    stats.contexts++;
    // 下位ハンドラとして応答を模擬。取得処理の安全確認ハンドラが先に実行される。
    await context.route('**/*', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
      if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
      if (path.endsWith('/ui/login')) { await route.fulfill({ contentType: 'text/html', body: html(options.mismatch) }); return; }
      if (path.endsWith('/common/login')) {
        stats.posts++;
        await route.fulfill({ status: options.reject ? 401 : 200, headers: cors, json: { response_data: options.reject ? {} : { ticket: 'synthetic-ticket-not-a-real-session' } } }); return;
      }
      if (path.endsWith('/common/children')) {
        await new Promise(resolve => setTimeout(resolve, 75));
        await route.fulfill({ headers: cors, json: { response_data: { child: Array.from({ length: options.children ?? 1 }, () => ({})) } } }); return;
      }
      if (path.includes('/daily-report/')) {
        await new Promise(resolve => setTimeout(resolve, 150));
        await route.fulfill({ headers: cors, json: { response_data: { timelines: [{ date: '2026-10-10', elapsed_time: options.apiMismatch ? 8 : 7, reports: [{ subject: 'MAT', elapsed_time: options.apiMismatch ? 8 : 7 }] }] } } }); return;
      }
      stats.unexpectedRequests++;
      await route.abort();
    });
    {
      const originalNewPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await originalNewPage();
        page.on('pageerror', error => { stats.pageError = error.name; });
        const setDefault = page.setDefaultTimeout.bind(page);
        page.setDefaultTimeout = timeout => setDefault(Math.min(timeout, 2000));
        const wait = page.waitForResponse.bind(page);
        page.waitForResponse = (predicate, config) => wait(predicate, { ...config, timeout: 1000 });
        return page;
      };
    }
    return context;
  };
  return { browser, stats, launch: async () => browser };
}

test('正規フォーム操作と遅延API待ち合わせ、DOM/API照合（合成）', async () => {
  const f = await fixture();
  const progress = Object.fromEntries(STAGES.map(s => [s, 'unverified']));
  let result;
  try { result = await fetchTodayLearningTime(credentials, progress, clock, f.launch); }
  catch (error) { throw new Error(JSON.stringify({ stage: error.stage, code: error.code, stats: f.stats, progress })); }
  assert.deepEqual(result, { date: '2026-10-10', total_minutes: 7, subjects: { 数学: 7 }, fetched_at: '2026-10-10T18:00:00+09:00' });
  assert.ok(STAGES.every(s => progress[s] === 'passed'));
  assert.equal(f.stats.posts, 1); assert.equal(f.stats.unexpectedRequests, 0);
  assert.equal(f.browser.isConnected(), false);
});
test('401は認証段階で止め、ブラウザを閉じて再試行しない（合成）', async () => {
  const f = await fixture({ reject: true });
  await assert.rejects(fetchTodayLearningTime(credentials, {}, clock, f.launch), error => error instanceof LearningError && error.stage === 'authentication');
  assert.equal(f.stats.posts, 1); assert.equal(f.browser.isConnected(), false);
});
test('実入力と違う認証POSTを送信前に止める（合成）', async () => {
  const f = await fixture({ mismatch: true });
  await assert.rejects(fetchTodayLearningTime(credentials, {}, clock, f.launch), error => error.code === 'login_form_payload_not_ready');
  assert.equal(f.stats.posts, 0); assert.equal(f.browser.isConnected(), false);
});
test('複数の子どもでは取り違えず停止（合成）', async () => {
  const f = await fixture({ children: 2 });
  await assert.rejects(fetchTodayLearningTime(credentials, {}, clock, f.launch), error => error.stage === 'records_page');
  assert.equal(f.browser.isConnected(), false);
});
test('DOM/APIの分数不一致では取得成功にしない（合成）', async () => {
  const f = await fixture({ apiMismatch: true });
  await assert.rejects(fetchTodayLearningTime(credentials, {}, clock, f.launch), error => error.code === 'api_display_mismatch');
  assert.equal(f.browser.isConnected(), false);
});
