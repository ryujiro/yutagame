import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recentBalance } from '../src/balance.js';
import { todayJst } from '../src/learning.js';

const url=process.env.LEDGER_UI_URL;
const browserOptions={executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'};
async function fixture(page) {
  const now=Date.now(),today=todayJst(now),yesterday=todayJst(now-86400000),entries=[];
  const record={date:today,total_minutes:8,subjects:{数学:3,美術:5},fetched_at:`${today}T08:00:00+09:00`};
  const ledger={integration_status:'connected',last_sync_at:new Date(now).toISOString(),adjustment_ready:true,
    learning_history:[record,{date:yesterday,total_minutes:198,fetched_at:`${yesterday}T18:00:00+09:00`}],
    grant_history:[{event_id:'known',occurred_at:`${yesterday}T16:00:00+09:00`,granted_minutes:210,confirmation_status:'confirmed'}],adjustment_history:entries};
  await page.route('**/api/dashboard',route=>route.fulfill({json:{today,server_time:new Date(now).toISOString(),record,history:[record],
    refresh_mode:'manual_login',credentials_ready:true,retry_after_seconds:0,ledger:{...ledger,recent:recentBalance(ledger,now)}}}));
  function store(payload) {
    if(entries.some(e=>e.request_id===payload.request_id)) return;
    const original=entries.find(e=>e.request_id===payload.reversal_of);
    entries.unshift({...payload,effective_date:today,created_at:new Date(`${today}T00:30:00+09:00`).toISOString(),
      delta_minutes:original ? -original.delta_minutes : payload.delta_minutes,note:original ? '取り消し' : payload.note,reversal_of:payload.reversal_of || null});
  }
  return {entries,store};
}
const amount=page=>page.locator('.ledger-balance strong');
async function expectBalance(page,value) {await page.waitForFunction(v=>document.querySelector('.ledger-balance strong')?.textContent.replace(/\s/g,'')===`${v}分`,value);assert.equal(await amount(page).innerText(),`${value} 分`);}

test('手動調整の追加・減算・取消・履歴とレスポンシブ表示（合成応答）',{skip:!url},async()=>{
  const browser=await chromium.launch(browserOptions),dir=join(tmpdir(),'manabi-adjustment-ui');await mkdir(dir,{recursive:true});
  try {
    for(const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
      const journal=await fixture(page);let posts=0,release,entered;
      const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
      await page.route('**/api/manual-adjustments',async route=>{
        assert.equal(route.request().method(),'POST');assert.equal(route.request().headers()['x-balance-request'],'1');
        const payload=route.request().postDataJSON();assert.equal(Object.hasOwn(payload,'password'),false);
        posts++;if(posts===1) {entered();await gate;}journal.store(payload);await route.fulfill({json:{saved:true}});
      });
      await page.goto(url);await expectBalance(page,-4);
      assert.match(await page.title(),/まなびノート/);assert.equal(await page.locator('vite-error-overlay').count(),0);
      await page.getByRole('button',{name:'手動調整を追加',exact:true}).click();
      const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.locator('input[type=password]').count(),0);
      assert.equal(await dialog.getByRole('spinbutton').inputValue(),'30');
      await dialog.getByRole('textbox').fill('追加のごほうび');
      await page.screenshot({path:join(dir,`dialog-${width}.png`)});
      await dialog.getByRole('button',{name:'追加する',exact:true}).click();await started;
      assert.equal(await dialog.getByRole('button',{name:'保存中',exact:true}).isDisabled(),true);release();
      await expectBalance(page,26);assert.equal(posts,1);assert.equal(await page.locator('.total-number').innerText(),'8');
      assert.equal(await page.locator('.ledger-totals dd').nth(0).innerText(),'206 分');
      assert.equal(await page.locator('.ledger-totals dd').nth(1).innerText(),'210 分');
      assert.equal(await page.locator('.adjustment-list time').innerText(),`${Number(todayJst().slice(5,7))}/${Number(todayJst().slice(8))} 00:30`);
      await page.screenshot({path:join(dir,`added-${width}.png`)});
      await page.getByRole('button',{name:'手動調整を追加',exact:true}).click();
      await dialog.getByRole('button',{name:'減算',exact:true}).click();await dialog.getByRole('button',{name:'10分',exact:true}).click();
      await dialog.getByRole('textbox').fill('長いメモ'.repeat(24));await dialog.getByRole('button',{name:'追加する',exact:true}).click();
      await expectBalance(page,16);assert.equal(posts,2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.getByRole('button',{name:'取り消す +30分',exact:true}).click();await dialog.getByRole('button',{name:'取り消す',exact:true}).click();
      await expectBalance(page,-14);assert.equal(posts,3);assert.equal(await page.getByText('取消済み',{exact:true}).isVisible(),true);
      assert.equal(await page.getByRole('button',{name:'取り消す +30分',exact:true}).count(),0);
      await page.reload();await expectBalance(page,-14);assert.equal(journal.entries.length,3);
      await page.getByRole('button',{name:'取得履歴',exact:true}).click();await page.getByRole('heading',{name:'手動調整の履歴',exact:true}).waitFor();
      assert.equal(await page.getByText('+30分',{exact:true}).count(),1);assert.equal(await page.getByText('-30分',{exact:true}).count(),1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.getByRole('button',{name:'今日の学習に戻る',exact:true}).click();
      await page.getByRole('button',{name:'手動調整を追加',exact:true}).click();await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});assert.deepEqual(errors,[]);await page.close();
    }
  } finally {await browser.close();}
});
test('保存確認の失敗後も同じ操作番号で再確認し、二重加算しない（合成障害）',{skip:!url},async()=>{
  const browser=await chromium.launch(browserOptions);
  try {
    for(const lostAck of [false,true]) {
      const page=await browser.newPage(),journal=await fixture(page),payloads=[],errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/api/manual-adjustments',async route=>{
        const payload=route.request().postDataJSON();payloads.push(payload);
        if(payloads.length===1) {if(lostAck) journal.store(payload);await route.fulfill({status:503,json:{message:'synthetic_failure'}});}
        else {journal.store(payload);await route.fulfill({json:{saved:true}});}
      });
      await page.goto(url);await expectBalance(page,-4);await page.getByRole('button',{name:'手動調整を追加',exact:true}).click();
      await page.getByRole('dialog').getByRole('button',{name:'追加する',exact:true}).click();
      if(!lostAck) {
        await page.getByRole('button',{name:'保存結果を再確認',exact:true}).waitFor();
        assert.equal(await page.getByRole('spinbutton').isDisabled(),true);assert.equal(payloads.length,1);
        await page.getByRole('button',{name:'保存結果を再確認',exact:true}).click();
      }
      await expectBalance(page,26);assert.equal(journal.entries.length,1);
      assert.equal(payloads.length,lostAck ? 1 : 2);if(!lostAck) assert.deepEqual(payloads[0],payloads[1]);
      assert.deepEqual(errors,[]);await page.close();
    }
  } finally {await browser.close();}
});
test('ローカルWorker/D1で保存・再送・取消を実確認（本番へは書かない）',{skip:!url || new URL(url).hostname!=='127.0.0.1'},async()=>{
  const request_id=crypto.randomUUID(),headers={'Content-Type':'application/json',Origin:new URL(url).origin,'X-Balance-Request':'1'};
  const post=value=>fetch(`${url}/api/manual-adjustments`,{method:'POST',headers,body:JSON.stringify(value)});
  const payload={request_id,delta_minutes:30,note:'ローカル検証'};
  assert.equal((await post(payload)).status,200);assert.equal((await (await post(payload)).json()).replayed,true);
  const cancel={request_id:crypto.randomUUID(),reversal_of:request_id};assert.equal((await post(cancel)).status,200);
  const data=await (await fetch(`${url}/api/dashboard`)).json(),rows=data.ledger.adjustment_history.filter(a=>a.request_id===request_id || a.reversal_of===request_id);
  assert.equal(rows.length,2);assert.equal(rows.reduce((sum,a)=>sum+a.delta_minutes,0),0);assert.equal(data.ledger.adjustment_ready,true);
});
test('本番の調整ボタン・API準備と画面を確認（読み取りと取消だけ）',{skip:process.env.LEDGER_EXPECT_LIVE!=='1'},async()=>{
  const browser=await chromium.launch(browserOptions),dir=join(tmpdir(),'manabi-adjustment-ui');await mkdir(dir,{recursive:true});
  try {
    for(const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
      await page.goto(url);await page.getByRole('heading',{name:'今日の学習時間',exact:true}).waitFor();
      const data=await (await page.request.get(`${url}/api/dashboard`)).json();
      assert.equal(data.ledger.adjustment_ready,true);assert.equal(data.ledger.adjustment_error,undefined);
      assert.equal(await page.locator('.total-number').innerText(),String(data.ledger.recent.today_learning_minutes));
      assert.equal(await amount(page).innerText(),data.ledger.recent.estimated_balance_minutes==null ? '—' : `${data.ledger.recent.estimated_balance_minutes} 分`);
      assert.equal(await page.locator('.ledger-totals dd').nth(2).innerText(),`${data.ledger.recent.manual_adjustment_minutes} 分`);
      await page.screenshot({path:join(dir,`home-live-${width}.png`)});
      await page.getByRole('button',{name:'手動調整を追加',exact:true}).click();await page.getByRole('dialog').waitFor();
      assert.equal(await page.getByRole('dialog').locator('input[type=password]').count(),0);
      await page.screenshot({path:join(dir,`dialog-live-${width}.png`)});
      await page.getByRole('button',{name:'キャンセル',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await page.close();
    }
  } finally {await browser.close();}
});
