import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recentBalance } from '../src/balance.js';
import { todayJst } from '../src/learning.js';

const url=process.env.LEDGER_UI_URL;
const options={executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'};
function snapshot({stale=false,extra=0,unknown=false,learning=103}={}) {
  const now=Date.now(),today=todayJst(now),yesterday=todayJst(now-86400000);
  const record={date:today,total_minutes:learning,subjects:{数学:learning},fetched_at:`${today}T21:33:00+09:00`};
  const ledger={integration_status:stale ? 'stale' : 'connected',last_sync_at:new Date(now-(stale ? 3600000 : 0)).toISOString(),adjustment_ready:true,
    learning_history:[record,{date:yesterday,total_minutes:299,fetched_at:`${yesterday}T23:00:00+09:00`}],
    grant_history:[60,60,80,100,70,60].map((minutes,index)=>({event_id:String(index),occurred_at:`${index<3 ? yesterday : today}T12:00:00+09:00`,estimated_minutes:minutes,granted_minutes:null,confirmation_status:'needs_review'})),
    adjustment_history:[{request_id:'original',effective_date:yesterday,delta_minutes:30,note:'',reversal_of:null,created_at:`${yesterday}T09:19:00+09:00`}]};
  if(extra) ledger.grant_history.unshift({event_id:'new',occurred_at:`${today}T21:00:00+09:00`,estimated_minutes:extra,granted_minutes:null,confirmation_status:'needs_review'});
  if(unknown) ledger.grant_history[0].estimated_minutes=null;
  ledger.recent=recentBalance(ledger,now);
  return {today,server_time:new Date(now).toISOString(),record,history:[record],ledger,refresh_mode:'manual_login',credentials_ready:true,retry_after_seconds:0};
}
async function balance(page,value) {
  await page.waitForFunction(v=>document.querySelector('.ledger-balance strong')?.textContent.replace(/\s/g,'')===(v==null ? '—' : `${v}分`),value);
}
test('推定残高・最終受信・不明分数と残高だけの更新（合成応答）',{skip:!url},async()=>{
  const browser=await chromium.launch(options),dir=join(tmpdir(),'manabi-estimated-ui');await mkdir(dir,{recursive:true});
  try {
    for(const [width,height] of [[1440,1000],[390,844],[320,740]]) {
      const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      let data=snapshot(),posts=0,reads=0;
      await page.route('**/api/**',route=>{if(route.request().method()!=='GET')posts++;reads++;return route.fulfill({json:data});});
      await page.goto(url);await balance(page,2);assert.match(await page.title(),/まなびノート/);
      assert.equal(await page.locator('vite-error-overlay').count(),0);assert.equal(await page.locator('.balance-basis').innerText(),'推定');
      assert.equal(await page.locator('.total-number').innerText(),'103');assert.equal(await page.locator('.ledger-totals dd').nth(1).innerText(),'430 分');
      assert.equal(await page.getByText('推定の付与6件を含みます。',{exact:true}).isVisible(),true);
      assert.equal(await page.getByText(/未確認です/).count(),0);assert.equal(await page.getByRole('button',{name:/確定|確認する/}).count(),0);
      await page.screenshot({path:join(dir,`estimated-${width}.png`)});
      data=snapshot({stale:true});await page.getByRole('button',{name:'残高を更新',exact:true}).click();await page.getByText(/最終受信.*時点の記録です/).waitFor();await balance(page,2);
      data=snapshot({extra:60});await page.getByRole('button',{name:'残高を更新',exact:true}).click();await balance(page,-58);
      data=snapshot({unknown:true});await page.getByRole('button',{name:'残高を更新',exact:true}).click();await balance(page,null);
      await page.getByText('付与1件の分数が不明です。',{exact:true}).waitFor();
      assert.equal(posts,0);assert.ok(reads>=4);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await page.close();
    }
  } finally {await browser.close();}
});
test('30秒ごとの自動GETと復帰時再読込はログインせず、通信障害でも前回値を保持（合成）',{skip:!url},async()=>{
  const browser=await chromium.launch(options);
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    let data=snapshot({stale:true}),reads=0,posts=0,failing=false;
    await page.clock.install();
    await page.route('**/api/**',route=>{
      reads++;if(route.request().method()!=='GET')posts++;
      return failing ? route.fulfill({status:503,json:{message:'synthetic_failure'}}) : route.fulfill({json:data});
    });
    await page.goto(url);await balance(page,2);await page.getByText(/最終受信.*時点の記録です/).waitFor();
    data=snapshot({extra:60});await page.clock.runFor(31000);await balance(page,-58);
    assert.equal(await page.getByText(/PCの最新記録を確認できていません/).count(),0);
    data=snapshot({extra:30});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await balance(page,-28);
    failing=true;await page.clock.runFor(31000);await page.getByText('残高の最新記録を確認できません。前回の記録を表示しています。',{exact:true}).waitFor();await balance(page,-28);
    failing=false;data=snapshot();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await balance(page,2);
    assert.equal(posts,0);assert.ok(reads>=5);assert.equal(await page.getByText(/残高の最新記録を確認できません/).count(),0);assert.deepEqual(errors,[]);await page.close();
  } finally {await browser.close();}
});
test('遅い自動GETが学習更新の新しい結果を巻き戻さない（合成）',{skip:!url},async()=>{
  const browser=await chromium.launch(options);
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    let reads=0,posts=0,release,entered;
    const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
    await page.clock.install();
    await page.route('**/api/dashboard',async route=>{
      reads++;const data=snapshot();if(reads===2){entered();await gate;}await route.fulfill({json:data});
    });
    await page.route('**/api/refresh',route=>{posts++;return route.fulfill({json:snapshot({learning:133})});});
    await page.goto(url);await balance(page,2);await page.clock.runFor(31000);await started;
    await page.getByRole('button',{name:'学習時間を更新',exact:true}).click();await balance(page,32);
    release();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await balance(page,32);assert.equal(await page.locator('.total-number').innerText(),'133');assert.equal(posts,1);assert.deepEqual(errors,[]);await page.close();
  } finally {await browser.close();}
});

test('公開版の推定残高と自動GETを読み取りだけで照合',{skip:!url || !process.env.LEDGER_EXPECT_LIVE},async()=>{
  const browser=await chromium.launch(options),dir=join(tmpdir(),'manabi-estimated-ui');await mkdir(dir,{recursive:true});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],reads=[];let posts=0;
    page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install();
    await page.route('**/api/**',route=>{
      if(route.request().method()!=='GET'){posts++;return route.abort();}
      return route.continue();
    });
    page.on('response',response=>{if(response.url().endsWith('/api/dashboard') && response.ok())reads.push(response);});
    await page.goto(url);await page.locator('.ledger-balance strong').waitFor();
    const automatic=page.waitForResponse(response=>response.url().endsWith('/api/dashboard') && response.ok());
    await page.clock.runFor(31000);await (await automatic).json();
    await page.waitForFunction(()=>document.querySelector('.ledger-balance strong')?.textContent.trim().length>0);
    await page.getByRole('button',{name:'残高を更新',exact:true}).click();
    await page.getByRole('button',{name:'残高を更新',exact:true}).evaluate(button=>new Promise(resolve=>{
      if(!button.disabled)return resolve();
      const observer=new MutationObserver(()=>{if(!button.disabled){observer.disconnect();resolve();}});
      observer.observe(button,{attributes:true,attributeFilter:['disabled']});
    }));
    assert.ok(reads.length>=3);assert.equal(posts,0);
    const latest=await reads.at(-1).json(),recent=latest.ledger.recent;
    await balance(page,recent.estimated_balance_minutes);
    assert.equal(await page.locator('.ledger-totals dd').nth(1).innerText(),`${recent.estimated_total_granted_minutes ?? '—'} 分`);
    assert.equal(await page.getByRole('button',{name:/確定|確認する/}).count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);await page.screenshot({path:join(dir,'live-390.png')});
    console.log(JSON.stringify({production_read_only:true,dashboard_reads:reads.length,posts,learning:recent.total_learning_minutes,grants:recent.estimated_total_granted_minutes,adjustments:recent.manual_adjustment_minutes,balance:recent.estimated_balance_minutes}));
    await page.close();
  } finally {await browser.close();}
});
