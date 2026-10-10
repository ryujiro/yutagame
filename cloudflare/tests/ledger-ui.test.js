import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { recentBalance } from '../src/balance.js';
import { todayJst } from '../src/learning.js';

test('学習・2日分残高の統合画面と履歴（実ブラウザ）',{skip:!process.env.LEDGER_UI_URL},async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const directory=process.env.LEDGER_ARTIFACT_DIR || join(tmpdir(),'manabi-ledger-ui');await mkdir(directory,{recursive:true});
  try {
    for(const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
      await page.goto(process.env.LEDGER_UI_URL);
      await page.getByRole('heading',{name:'今日の学習時間',exact:true}).waitFor();
      assert.equal(await page.getByRole('heading',{name:'時間の残高',exact:true}).isVisible(),true);
      assert.equal(await page.locator('.sidebar nav button').count(),2);
      assert.equal(await page.getByRole('button',{name:'時間の残高',exact:true}).count(),0);
      if(process.env.LEDGER_EXPECT_LIVE==='1') {
        const data=await (await page.request.get(`${process.env.LEDGER_UI_URL}/api/dashboard`)).json();
        const recent=data.ledger.recent;
        assert.equal(await page.locator('.ledger-totals dd').nth(0).innerText(),`${recent.total_learning_minutes} 分`);
        assert.equal(await page.locator('.ledger-totals dd').nth(1).innerText(),`${recent.total_granted_minutes} 分`);
        assert.equal(await page.locator('.ledger-balance strong').innerText(),recent.balance_minutes==null ? '—' : `${recent.balance_minutes} 分`);
        assert.equal((await page.request.post(`${process.env.LEDGER_UI_URL}/api/family-safety/events`,{data:{}})).status(),401);
        assert.equal((await page.request.post(`${process.env.LEDGER_UI_URL}/api/balance/adjust`,{data:{}})).status(),404);
        await page.screenshot({path:join(directory,`home-live-${width}.png`),fullPage:false});
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      let mode='known';
      await page.route('**/api/dashboard',async route=>{
        const response=await route.fetch(),data=await response.json();
        const now=Date.parse(data.server_time),today=data.today,yesterday=todayJst(now-86400000),old=todayJst(now-172800000);
        const record={date:today,total_minutes:8,subjects:{数学:3,美術:5},fetched_at:`${today}T08:00:00+09:00`};
        const ledger={integration_status:'connected',last_sync_at:new Date(now).toISOString(),
          learning_history:[{...record},{date:yesterday,total_minutes:198,fetched_at:`${yesterday}T08:00:00+09:00`},{date:old,total_minutes:500,fetched_at:`${old}T08:00:00+09:00`}],
          grant_history:[{event_id:'a',occurred_at:`${yesterday}T16:55:53+09:00`,granted_minutes:90,confirmation_status:'confirmed'},
            {event_id:'b',occurred_at:`${yesterday}T14:00:00+09:00`,granted_minutes:60,confirmation_status:'confirmed'},
            {event_id:'c',occurred_at:`${yesterday}T10:00:00+09:00`,granted_minutes:60,confirmation_status:'confirmed'},
            {event_id:'d',occurred_at:`${old}T10:00:00+09:00`,estimated_minutes:60,confirmation_status:'needs_review'}]};
        if(mode==='pending') ledger.grant_history.push({event_id:'e',occurred_at:`${today}T09:00:00+09:00`,estimated_minutes:15,confirmation_status:'needs_review'});
        if(mode==='empty') {ledger.learning_history=[];ledger.grant_history=[];}
        ledger.recent=recentBalance(ledger,now);
        await route.fulfill({response,json:{...data,record:mode==='empty' ? null : record,history:mode==='empty' ? [] : [record],ledger}});
      });
      await page.reload();await page.locator('.ledger-balance strong').getByText('-4').waitFor();
      assert.equal(await page.locator('.total-number').innerText(),'8');
      assert.equal(await page.getByText('付与1件が要確認です。',{exact:true}).count(),0);
      await page.screenshot({path:join(directory,`home-known-${width}.png`),fullPage:false});
      await page.getByRole('button',{name:'取得履歴',exact:true}).click();
      await page.getByText('90分',{exact:true}).waitFor();await page.getByText('推定 60分',{exact:true}).waitFor();
      await page.getByRole('button',{name:'今日の学習に戻る',exact:true}).click();
      await page.getByRole('heading',{name:'今日の学習時間',exact:true}).waitFor();
      mode='pending';await page.reload();await page.getByText('昨日・今日の付与1件が未確認です。',{exact:true}).waitFor();
      assert.equal(await page.locator('.ledger-balance strong').innerText(),'—');
      mode='empty';await page.reload();await page.getByRole('heading',{name:'今日の学習時間',exact:true}).waitFor();
      assert.equal(await page.locator('.total-number').innerText(),'—');assert.equal(await page.locator('.ledger-balance strong').innerText(),'—');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally {await browser.close();}
});
