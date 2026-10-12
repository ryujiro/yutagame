import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeStudy } from '../src/study-archive.js';
import { todayJst, isoJst } from '../src/learning.js';
import { recentBalance } from '../src/balance.js';

const url=process.env.LEDGER_UI_URL;
const options={executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'};
function snapshot() {
  const now=Date.now(),today=todayJst(now),fetched_at=isoJst(now);
  const record={date:today,total_minutes:7,subjects:{数学:7},fetched_at};
  const days=Array.from({length:150},(_,i)=>({...record,date:todayJst(now-i*86400000),total_minutes:i ? 10 : 7,subjects:null}));
  const ledger={learning_history:days,grant_history:[],adjustment_history:[],adjustment_ready:true,integration_status:'connected',last_sync_at:fetched_at};ledger.recent=recentBalance(ledger,now);
  return {today,record,history:[record],ledger,refresh_mode:'manual_login',credentials_ready:true,
    study_history:summarizeStudy(days,{status:'complete',cursor:null,checked_at:fetched_at})};
}
async function check(page) {
  assert.match(await page.title(),/まなびノート/);assert.equal(await page.locator('vite-error-overlay').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
}
test('累計・全150日・月選択・更新・取得失敗・ゼロを3幅で確認（合成）',{skip:!url},async()=>{
  const browser=await chromium.launch(options),dir=join(tmpdir(),'manabi-archive-ui');await mkdir(dir,{recursive:true});
  try {
    for(const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page=await browser.newPage({viewport:{width,height}}),errors=[];let data=snapshot(),posts=0;
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      await page.route('**/api/**',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({json:data});});
      await page.goto(url);const section=page.getByRole('region',{name:'これまでの取り組み',exact:true});await section.locator('.archive-summary').waitFor();
      assert.equal(await section.locator('.archive-summary strong').first().innerText(),'24時間57分');
      assert.equal(await section.locator('.archive-summary strong').nth(1).innerText(),'150日');
      await section.scrollIntoViewIfNeeded();await check(page);await page.screenshot({path:join(dir,`archive-${width}.png`)});
      await section.getByText('日別の記録',{exact:true}).click();assert.equal(await section.locator('.archive-days tbody tr').count(),150);
      await section.getByLabel('表示する月').selectOption(data.today.slice(0,7));
      assert.equal(await section.locator('.archive-days tbody tr').count(),data.study_history.months[0].recorded_days);
      const balance=await page.locator('.ledger-balance strong').innerText();
      await page.getByRole('button',{name:'学習時間を更新',exact:true}).click();assert.equal(posts,1);
      assert.equal(await page.locator('.ledger-balance strong').innerText(),balance);
      data.study_history.scan.status='error';await page.getByRole('button',{name:'残高を更新',exact:true}).click();
      await section.getByText('過去の取得が途中で止まりました。取得済みの記録を表示しています。',{exact:true}).waitFor();
      assert.equal(await section.locator('.archive-summary strong').first().innerText(),'24時間57分');
      data.study_history=summarizeStudy([{...data.record,total_minutes:0,subjects:null}]);
      await page.getByRole('button',{name:'残高を更新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.archive-summary strong')?.textContent==='0時間0分');
      assert.equal(await section.getByLabel('表示する月').inputValue(),data.today.slice(0,7));
      data.study_history=summarizeStudy([]);await page.getByRole('button',{name:'残高を更新',exact:true}).click();await section.getByText('過去の学習時間はまだ取得していません。',{exact:true}).waitFor();
      await check(page);assert.deepEqual(errors,[]);await page.close();
    }
  } finally {await browser.close();}
});

test('本番の過去累計・日別全件・月選択をAPIと3幅で照合（GETのみ）',{skip:!url || !process.env.ARCHIVE_EXPECT_LIVE},async()=>{
  const browser=await chromium.launch(options),dir=join(tmpdir(),'manabi-archive-ui');await mkdir(dir,{recursive:true});
  try {
    for(const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page=await browser.newPage({viewport:{width,height}}),errors=[];let posts=0;
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      await page.route('**/api/**',route=>{if(route.request().method()!=='GET'){posts++;return route.abort();}return route.continue();});
      const response=page.waitForResponse(r=>r.url().endsWith('/api/dashboard')&&r.ok());await page.goto(url);const data=await(await response).json();
      assert.equal(data.study_history.scan.status,'complete');const section=page.getByRole('region',{name:'これまでの取り組み',exact:true});await section.locator('.archive-summary').waitFor();
      assert.equal(await section.locator('.archive-summary strong').nth(1).innerText(),`${data.study_history.recorded_days}日`);
      const total=data.study_history.total_minutes;assert.equal(await section.locator('.archive-summary strong').first().innerText(),`${Math.floor(total/60)}時間${total%60}分`);
      await section.scrollIntoViewIfNeeded();await check(page);await page.screenshot({path:join(dir,`archive-live-${width}.png`)});
      await section.getByText('日別の記録',{exact:true}).click();assert.equal(await section.locator('.archive-days tbody tr').count(),data.study_history.recorded_days);
      const oldest=data.study_history.months.at(-1);await section.getByLabel('表示する月').selectOption(oldest.month);assert.equal(await section.locator('.archive-days tbody tr').count(),oldest.recorded_days);
      assert.equal(posts,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({width,days:data.study_history.recorded_days,total,first:data.study_history.first_date,last:data.study_history.last_date,posts}));await page.close();
    }
  } finally {await browser.close();}
});
