import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMonthly, MONTHLY_FAILURE } from '../src/monthly.js';
import { monthlyApi } from './monthly-fixture.js';
import { todayJst } from '../src/learning.js';
import { recentBalance, carryBalance } from '../src/balance.js';

const url=process.env.LEDGER_UI_URL;
const options={executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'};
function snapshot() {
  const now=Date.now(),today=todayJst(now),yesterday=todayJst(now-86400000),fetched_at=new Date(now).toISOString();
  const record={date:today,total_minutes:7,subjects:{数学:7},fetched_at};
  const ledger={learning_history:[record,{...record,date:yesterday,total_minutes:8,subjects:{数学:8}}],grant_history:[],adjustment_history:[],adjustment_ready:true,last_sync_at:fetched_at,integration_status:'connected'};
  ledger.recent=recentBalance(ledger,now);ledger.carry=carryBalance(ledger,todayJst(now-86400000),now);
  const monthly={...parseMonthly(monthlyApi())[0],month:today.slice(0,7),fetched_at};
  return {today,record,history:[record],ledger,refresh_mode:'manual_login',credentials_ready:true,retry_after_seconds:0,monthly_record:monthly,monthly_history:[monthly],monthly_error:null};
}
async function check(page) {
  assert.match(await page.title(),/まなびノート/);assert.equal(await page.locator('vite-error-overlay').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
}
test('月実績と学習更新・履歴・未取得・ゼロを3幅で確認し、残高を変えない（合成）',{skip:!url},async()=>{
  const browser=await chromium.launch(options),dir=join(tmpdir(),'manabi-monthly-ui');await mkdir(dir,{recursive:true});
  try {
    for(const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page=await browser.newPage({viewport:{width,height}}),errors=[];let data=snapshot(),posts=0;
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      await page.route('**/api/**',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({json:data});});
      await page.goto(url);const section=page.getByRole('region',{name:'今月の取り組み',exact:true});await section.locator('table').waitFor();
      assert.equal(await section.locator('.monthly-summary strong').first().innerText(),'15');assert.equal(await section.locator('.monthly-summary strong').nth(1).innerText(),'10');
      assert.equal(await section.getByRole('rowheader',{name:'数学',exact:true}).count(),1);assert.equal(await section.locator('tbody tr').count(),5);
      await section.scrollIntoViewIfNeeded();await check(page);await page.screenshot({path:join(dir,`monthly-${width}.png`)});
      data.monthly_record.subjects.数学.count=2;data.monthly_record.total_count=16;
      await page.getByRole('button',{name:'学習時間を更新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.monthly-summary strong')?.textContent==='16');
      assert.equal(await page.locator('.total-number').innerText(),'7');assert.equal((await page.locator('.ledger-balance strong').innerText()).replace(/\s/g,''),'15分');assert.equal(posts,1);
      data.monthly_error=MONTHLY_FAILURE;await page.getByRole('button',{name:'学習時間を更新',exact:true}).click();await page.getByText(MONTHLY_FAILURE,{exact:true}).waitFor();
      assert.equal(await section.locator('.monthly-summary strong').first().innerText(),'16');
      const previous=new Date(`${data.monthly_record.month}-01T12:00:00Z`);previous.setUTCMonth(previous.getUTCMonth()-1);
      data.monthly_history=[data.monthly_record,{...data.monthly_record,month:previous.toISOString().slice(0,7)}];
      await page.getByRole('button',{name:'残高を更新',exact:true}).click();await page.getByRole('button',{name:'取得履歴',exact:true}).click();await page.locator('.monthly-history .monthly-study').nth(1).waitFor();
      assert.equal(await page.locator('.monthly-history .monthly-study').count(),2);await check(page);
      await page.getByRole('button',{name:'今日の学習',exact:true}).click();
      data.monthly_record=null;data.monthly_error=null;await page.getByRole('button',{name:'残高を更新',exact:true}).click();await page.getByText('今月の取り組みはまだ取得していません。',{exact:true}).waitFor();
      data=snapshot();data.monthly_record.total_count=0;for(const value of Object.values(data.monthly_record.subjects))value.count=0;
      await page.getByRole('button',{name:'残高を更新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.monthly-summary strong')?.textContent==='0');await check(page);
      assert.deepEqual(errors,[]);await page.close();
    }
  } finally {await browser.close();}
});
test('本番の月実績・日別時間・残高をAPIと3幅で照合（読み取りのみ）',{skip:!url || !process.env.MONTHLY_EXPECT_LIVE},async()=>{
  const browser=await chromium.launch(options),dir=join(tmpdir(),'manabi-monthly-ui');await mkdir(dir,{recursive:true});
  try {
    for(const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page=await browser.newPage({viewport:{width,height}}),errors=[];let posts=0;
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      await page.route('**/api/**',route=>{if(route.request().method()!=='GET'){posts++;return route.abort();}return route.continue();});
      const response=page.waitForResponse(r=>r.url().endsWith('/api/dashboard') && r.ok());await page.goto(url);const data=await (await response).json();assert.ok(data.monthly_record);
      const section=page.getByRole('region',{name:'今月の取り組み',exact:true});await section.locator('table').waitFor();
      assert.equal(await section.locator('.monthly-summary strong').first().innerText(),String(data.monthly_record.total_count));
      assert.equal(await section.locator('.monthly-summary strong').nth(1).innerText(),String(data.monthly_record.target_count));
      for(const [name,value] of Object.entries(data.monthly_record.subjects)) {
        const row=section.getByRole('rowheader',{name,exact:true}).locator('..');assert.equal(await row.locator('td').first().innerText(),String(value.count));assert.equal(await row.locator('td').nth(1).innerText(),String(value.target));
      }
      assert.equal(await page.locator('.total-number').innerText(),String(data.ledger.carry.today_learning_minutes ?? '—'));
      await section.scrollIntoViewIfNeeded();await check(page);await page.screenshot({path:join(dir,`monthly-live-${width}.png`)});
      await page.getByRole('button',{name:'取得履歴',exact:true}).click();await page.locator('.monthly-history table').waitFor();assert.equal(posts,0);assert.deepEqual(errors,[]);
      console.log(JSON.stringify({production_read_only:true,width,month:data.monthly_record.month,total:data.monthly_record.total_count,target:data.monthly_record.target_count,daily_minutes:data.record.total_minutes,balance:data.ledger.carry.estimated_balance_minutes,posts}));await page.close();
    }
  } finally {await browser.close();}
});
