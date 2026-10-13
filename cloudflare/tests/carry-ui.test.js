import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { carryBalance } from '../src/balance.js';

const url=process.env.LEDGER_UI_URL;
test('繰り越し内訳・翌日・赤字リセットを3幅で表示し、残高更新はGETだけ（合成）',{skip:!url},async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/chromium'});
  const directory='/tmp/manabi-carry-ui';await mkdir(directory,{recursive:true});
  try {
    for (const width of [1440,390,320]) {
      const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      let today='2026-10-13',posts=0;
      const days=[{date:'2026-10-12',total_minutes:100},{date:'2026-10-13',total_minutes:20}];
      const grants=[{occurred_at:'2026-10-12T12:00:00+09:00',granted_minutes:70,confirmation_status:'confirmed'},
        {occurred_at:'2026-10-13T12:00:00+09:00',granted_minutes:10,confirmation_status:'confirmed'}];
      await page.route('**/api/**',route=>{
        if(route.request().method()!=='GET')posts++;
        const now=Date.parse(today+'T18:00:00+09:00'),record={...days.find(d=>d.date===today),subjects:null,fetched_at:today+'T18:00:00+09:00'};
        const ledger={learning_history:days,grant_history:grants,adjustment_history:[],adjustment_ready:true,integration_status:'connected',last_sync_at:new Date(now).toISOString()};
        ledger.carry=carryBalance(ledger,'2026-10-12',now);
        return route.fulfill({json:{today,record,history:[record],ledger,credentials_ready:true,refresh_mode:'manual_login',error:null}});
      });
      const balance=async value=>page.waitForFunction(v=>document.querySelector('.ledger-balance strong')?.textContent.replace(/\s/g,'')===`${v}分`,value);
      await page.goto(url);await balance(40);assert.match(await page.title(),/まなびノート/);
      assert.equal(await page.locator('vite-error-overlay').count(),0);
      assert.deepEqual(await page.locator('.carry-totals dd').allTextContents(),['0 分','30 分','30 分']);
      assert.equal(await page.getByText('2日分の学習',{exact:true}).count(),0);
      await page.screenshot({path:`${directory}/carry-${width}.png`});
      today='2026-10-14';days.push({date:today,total_minutes:8});
      await page.getByRole('button',{name:'残高を更新',exact:true}).click();await balance(48);
      assert.deepEqual(await page.locator('.carry-totals dd').allTextContents(),['30 分','10 分','40 分']);
      grants[1].granted_minutes=100;
      await page.getByRole('button',{name:'残高を更新',exact:true}).click();await balance(8);
      assert.deepEqual(await page.locator('.carry-totals dd').allTextContents(),['30 分','-80 分','0 分']);
      grants.push({occurred_at:today+'T12:00:00+09:00',granted_minutes:20,confirmation_status:'confirmed'});
      await page.getByRole('button',{name:'残高を更新',exact:true}).click();await balance(-12);
      today='2026-10-15';days.push({date:today,total_minutes:0});
      await page.getByRole('button',{name:'残高を更新',exact:true}).click();await balance(0);
      assert.equal(await page.locator('.carry-totals dd').nth(2).innerText(),'0 分');
      assert.equal(posts,0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);await page.close();
    }
  } finally {await browser.close();}
});
