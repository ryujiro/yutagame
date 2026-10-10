import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

test('時間残高の画面とナビゲーション（実ブラウザ・合成記録）', { skip: !process.env.LEDGER_UI_URL }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const directory=process.env.LEDGER_ARTIFACT_DIR || join(tmpdir(),'manabi-ledger-ui');
  await mkdir(directory, { recursive: true });
  try {
    for (const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page = await browser.newPage({ viewport: { width,height } });
      const errors=[];
      page.on('pageerror',error => errors.push(error.message));
      page.on('console',message => { if (message.type()==='error') errors.push(message.text()); });
      await page.goto(process.env.LEDGER_UI_URL);
      await page.getByRole('heading',{name:'合計学習時間'}).waitFor();
      await page.getByRole('button',{name:'時間の残高',exact:true}).click();
      await page.getByRole('heading',{name:'PC時間の付与履歴'}).waitFor();
      if (process.env.LEDGER_EXPECT_LIVE === '1') {
        const data=await (await page.request.get(`${process.env.LEDGER_UI_URL}/api/dashboard`)).json();
        assert.equal(await page.locator('.ledger-totals dd').nth(2).innerText(),`${data.ledger.total_learning_minutes} 分`);
        assert.equal(await page.locator('.ledger-totals dd').nth(3).innerText(),`${data.ledger.total_granted_minutes} 分`);
        assert.equal(await page.locator('.ledger-status.confirmed').count(),data.ledger.grant_history.filter(e=>e.confirmation_status==='confirmed').length);
        const denied=await page.request.post(`${process.env.LEDGER_UI_URL}/api/family-safety/events`,{data:{}});
        assert.equal(denied.status(),401);
        await page.screenshot({path:join(directory,`live-${width}.png`),fullPage:false});
      }
      await page.screenshot({path:join(directory,`empty-${width}.png`),fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      // Synthetic confirmations test presentation; no invented events enter the server.
      await page.route('**/api/dashboard',async route => {
        const response=await route.fetch(); const data=await response.json();
        data.ledger={...data.ledger,today_learning_minutes:198,today_granted_minutes:210,total_learning_minutes:198,total_granted_minutes:210,
          confirmed_balance_minutes:-12,balance_minutes:null,pending_count:1,missing_learning_days:['2026-10-09'],integration_status:'connected',
          grant_history:[{event_id:'a',occurred_at:'2026-10-10T16:55:53+09:00',granted_minutes:90,confirmation_status:'confirmed'},
            {event_id:'b',occurred_at:'2026-10-09T10:00:00+09:00',estimated_minutes:60,confirmation_status:'needs_review'}]};
        await route.fulfill({response,json:data});
      });
      await page.reload();
      await page.getByRole('button',{name:'時間の残高',exact:true}).click();
      await page.getByText('90分',{exact:true}).waitFor();
      await page.getByText('推定 60分',{exact:true}).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      assert.equal(await page.locator('.ledger-balance strong').innerText(),'—');
      await page.screenshot({path:join(directory,`records-${width}.png`),fullPage:true});
      await page.getByRole('button',{name:'取得履歴',exact:true}).click();
      await page.getByRole('button',{name:'今日の学習に戻る'}).click();
      await page.getByRole('heading',{name:'合計学習時間'}).waitFor();
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally { await browser.close(); }
});
