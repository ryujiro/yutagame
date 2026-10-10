import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

test('更新ボタン→POST→ログイン取得結果を表示（実画面・合成応答）',{skip:!process.env.LEDGER_UI_URL},async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const directory=join(tmpdir(),'manabi-manual-ui');await mkdir(directory,{recursive:true});
  try {
    for(const width of [1440,390]) {
      const page=await browser.newPage({viewport:{width,height:1000}});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
      let posts=0,body;
      await page.route('**/api/dashboard',async route=>{
        const r=await route.fetch();body=await r.json();
        body={...body,credentials_ready:true,refresh_mode:'manual_login',retry_after_seconds:0,error:null};
        await route.fulfill({response:r,json:body});
      });
      await page.route('**/api/refresh',async route=>{
        assert.equal(route.request().method(),'POST');assert.equal(route.request().headers()['x-learning-request'],'1');posts++;
        const fresh={date:'2026-10-11',total_minutes:7,subjects:{数学:7},fetched_at:'2026-10-11T10:00:00+09:00'};
        await route.fulfill({json:{...body,record:fresh,history:[fresh,...body.history],retry_after_seconds:600,refreshing:false,
          ledger:{...body.ledger,today_learning_minutes:7,total_learning_minutes:205}}});
      });
      await page.goto(process.env.LEDGER_UI_URL);
      await page.getByRole('heading',{name:'合計学習時間'}).waitFor();
      await page.getByRole('button',{name:'学習時間を更新',exact:true}).click();
      await page.locator('.total-number').getByText('7',{exact:true}).waitFor();
      assert.equal(posts,1);assert.equal(await page.getByRole('button',{name:'学習時間を更新',exact:true}).isDisabled(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
      await page.getByRole('button',{name:'時間の残高',exact:true}).click();
      await page.getByRole('heading',{name:'PC時間の付与履歴'}).waitFor();
      await page.screenshot({path:join(directory,`refresh-${width}.png`),fullPage:false});
      await page.close();
    }
  } finally {await browser.close();}
});
