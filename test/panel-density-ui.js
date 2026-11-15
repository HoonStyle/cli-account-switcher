'use strict';
// Real Chromium layout with a synthetic, live-shaped account set (2 Claude, 4 Codex incl. one API key each,
// 1 EXAONE, Antigravity 2 saved + 3 shared groups). Compact (560px panel) must keep every account in one 1080p
// work area with emails and reset actions on the row, without horizontal overflow or wrapped labels; narrower
// compact windows move those into tooltip/menu; comfortable (440px) keeps the two-line rows.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-density-ui-'));
app.setPath('userData', tmp);
const preload = path.join(tmp, 'preload.js');
fs.writeFileSync(preload, `
const {contextBridge}=require('electron');
const now=new Date().toISOString(),sec=Date.now()/1000,month=now.slice(0,7);
const codex=(name,label,used,balance,apiKey)=>({name,label,isDefault:name==='default',loggedIn:true,email:apiKey?null:'user@example.com',plan:apiKey?null:(name==='default'?'Pro':'Business Prolite'),authMode:apiKey?'apikey':'chatgpt',apiKey:{apiKey:!!apiKey,masked:null},
 usage:apiKey?null:{capturedAt:now,source:'session',primary:{usedPercent:Math.max(0,used-30),windowMinutes:300,resetsAt:sec+3*3600},secondary:{usedPercent:used,windowMinutes:10080,resetsAt:sec+3*86400}},
 credits:apiKey?null:{balance,hasCredits:balance!=='0'&&balance!=null,unlimited:false,capturedAt:now},
 resetCredits:apiKey?null:{availableCount:1,status:'available',capturedAt:now,nearestExpiry:new Date(Date.now()+28*86400000).toISOString(),stale:false},
 resetAutoUse:apiKey?null:{enabled:true,status:'waiting',text:''},
 apiCost:apiKey?{adminKey:false,masked:null,org:'OpenAI',keyHint:'sk-admin-…',month,amountUsd:null,capturedAt:null,error:null,pending:false}:undefined});
const claude=(name,apiKey)=>({name,label:name,isDefault:name==='default',loggedIn:true,email:apiKey?null:'user@example.com',plan:apiKey?null:'Max 5x',apiKey:{apiKey:!!apiKey,masked:apiKey?'…1234':null},
 usage:apiKey?null:{capturedAt:now,source:'statusline',fiveHour:{usedPercent:20,resetsAt:sec+2*3600},sevenDay:{usedPercent:81,resetsAt:sec+4*86400}},
 apiCost:apiKey?{adminKey:true,masked:'…WXYZ',org:'Anthropic',keyHint:'sk-ant-admin…',month,amountUsd:1234.5,capturedAt:now,error:null,pending:false,local:{monthUsd:12.5,sessions:3,updatedAt:now},balance:{baseUsd:50,at:now,spentSinceUsd:7.25,estimateUsd:42.75}}:undefined});
const state={density:'compact',usageMode:'remaining',directUsageApi:true,apiFetch:true,apiIntervalMinutes:30,usageHook:true,pathStatus:{first:true},apiMeta:{},apiErrors:{},zoom:1,zooms:[1,1.1,1.25,1.5],
 tools:{claude:{active:'default',profiles:[claude('default',false),claude('exp_api',true)]},
 codex:{active:'hoonlim',profiles:[codex('default','victor',89,'15531.7877535000',false),codex('ej','ej',100,null,false),codex('hoonlim','hoonlim',82,'0',false),codex('victor_api','victor_api',0,null,true)]}},
 exaone:{label:'EXAONE API',envNames:['EXAONE_API_KEY'],checkPath:'GET /v1/models',accounts:[{name:'exaone',label:'exaone',active:true,apiKey:{apiKey:true,masked:'…abcd'},check:{ok:true,checkedAt:now,rateLimit:{minute:{remaining:58,limit:60},day:{remaining:980,limit:1000}}}}]},
 'gemini-api':{label:'Gemini API',envNames:['GEMINI_API_KEY','GOOGLE_API_KEY'],checkPath:'GET /v1beta/models',accounts:[]},
 antigravity:{accounts:[{id:'a'.repeat(32),label:'personal-account',email:'user1@example.com'},{id:'b'.repeat(32),label:'exp',email:'user2@example.com'}],checkedAt:now,current:{email:'user1@example.com'},
  usage:{source:'agy-cli',scope:'shared-login',capturedAt:now,groups:[
   {name:'Gemini',buckets:[{id:'g5',label:'5시간',window:'5h',remainingPercent:99.5,usedPercent:0.5,resetsAt:sec+3600},{id:'gw',label:'주간',window:'weekly',remainingPercent:99.9,usedPercent:0.1,resetsAt:sec+6*86400}]},
   {name:'Claude·GPT',buckets:[{id:'c5',label:'5시간',window:'5h',remainingPercent:98.5,usedPercent:1.5,resetsAt:sec+3600},{id:'cw',label:'주간',window:'weekly',remainingPercent:99.2,usedPercent:0.8,resetsAt:sec+6*86400}]},
   {name:'Gemini 4 Argon',buckets:[{id:'aw',label:'주간',window:'weekly',remainingPercent:99.6,usedPercent:0.4,resetsAt:sec+6*86400}]}]}}};
let listener=null,resized=[];
contextBridge.exposeInMainWorld('api',{state:async()=>state,onState:fn=>{listener=fn;},resize:async h=>{resized.push(h);return true;},hide:()=>{},openTasks:()=>{},quit:()=>{},copy:async()=>{}});
contextBridge.exposeInMainWorld('fixture',{density:d=>{state.density=d;listener&&listener(state);},resized:()=>resized,cost:(tool,name,patch)=>{const p=state.tools[tool].profiles.find(x=>x.name===name);Object.assign(p.apiCost,patch);listener&&listener(state);}});
`);
const WORK_AREA_1080P = 969; // macOS 1920x1080 with the default Dock; main.js caps the panel at workArea - 16
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 440, height: 1400, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  const js = (s) => win.webContents.executeJavaScript(s);
  const measure = (density, width) => js(`(async()=>{fixture.density(${JSON.stringify(density)});await new Promise(r=>setTimeout(r,80));
    const panel=document.querySelector('#panel');panel.classList.add('fit');const total=panel.getBoundingClientRect().height;panel.classList.remove('fit');
    const rows=[...document.querySelectorAll('.row')].map(r=>({section:r.closest('section').id,name:r.dataset.name||r.dataset.id,h:Math.round(r.getBoundingClientRect().height),resources:!!r.querySelector('.resources'),
      usageBelowName:(()=>{const u=r.querySelector('.usage'),n=r.querySelector('.name');return !!(u&&n&&u.getBoundingClientRect().top>=n.getBoundingClientRect().bottom-1);})(),
      emailVisible:(()=>{const e=r.querySelector('.email');return !!(e&&e.offsetParent&&e.getBoundingClientRect().width>0);})(),
      resetButtonsVisible:(()=>{const b=r.querySelector('.reset-use');return !!(b&&b.offsetParent);})()}));
    const wrapped=[...document.querySelectorAll('.row .name .label')].filter(e=>e.getClientRects().length>1).map(e=>e.textContent);
    const clipped=[...document.querySelectorAll('button,input,.row,.resources')].filter(e=>e.offsetParent&&e.getBoundingClientRect().right>innerWidth+1).length;
    const overflow=[...document.querySelectorAll('.resources,.resource,.row .id')].some(el=>el.scrollWidth>el.clientWidth+1);
    return {width:innerWidth,total:Math.round(total),rows,wrapped,clipped,overflow,pageOverflow:document.documentElement.scrollWidth>innerWidth,count:document.querySelector('#account-count').textContent,
      agyStatusInHeading:!!document.querySelector('.agy-usage-heading #agy-usage-status'),hintsHidden:[...document.querySelectorAll('section>p.hint:not([id])')].every(p=>!p.offsetParent)};})()`);
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    await js('new Promise(r=>setTimeout(r,100))');
    win.setContentSize(560, 1400);
    const compact = await measure('compact', 560);
    assert.equal(compact.width, 560);
    assert.equal(compact.count, '9개 계정');
    assert(compact.total <= WORK_AREA_1080P - 16, `compact content ${compact.total}px must fit a 1080p work area`);
    for (const r of compact.rows.filter((x) => ['claude', 'codex'].includes(x.section))) {
      assert(!r.usageBelowName, `${r.name}: compact keeps quota on the identity line`);
      assert(r.h <= 72, `${r.name}: compact row ${r.h}px`);
    }
    const codexRows = Object.fromEntries(compact.rows.filter((x) => x.section === 'codex').map((x) => [x.name, x]));
    assert(codexRows.default.resources && codexRows.ej.resources && codexRows.hoonlim.resources);
    assert(!codexRows.victor_api.resources, 'API-key Codex account has no credits/reset-credit cell');
    assert(codexRows.hoonlim.resetButtonsVisible, 'wide compact keeps 조회/지금 사용 on the resource line');
    assert(compact.rows.find((x) => x.name === 'exp_api').emailVisible, 'API-key marker stays visible in compact');
    assert(compact.rows.find((x) => x.name === 'hoonlim').emailVisible, 'wide compact shows the subscription email');
    assert.deepEqual(compact.wrapped, []); assert.equal(compact.clipped, 0); assert(!compact.overflow); assert(!compact.pageOverflow);
    const agyButtons = await js(`[...document.querySelectorAll('.agy-controls .btn')].filter(b=>b.offsetParent).map(b=>Math.round(b.getBoundingClientRect().height))`);
    assert(agyButtons.every((h) => h <= 34), `Antigravity control buttons stay on one line: ${agyButtons}`);
    // Antigravity: shared quota first, then the saved logins and their controls.
    const agyOrder = await js(`(()=>{const top=s=>document.querySelector(s).getBoundingClientRect().top;return {usage:top('#agy-usage'),heading:top('.agy-usage-heading'),current:top('#agy-current'),list:top('#antigravity .list'),controls:top('.agy-controls')};})()`);
    assert(agyOrder.heading < agyOrder.usage && agyOrder.usage < agyOrder.current && agyOrder.current < agyOrder.list && agyOrder.list < agyOrder.controls, JSON.stringify(agyOrder));
    // Section order: subscription accounts, shared Antigravity login, then API-key categories.
    const order = await js(`[...document.querySelectorAll('main > section')].filter(s=>s.offsetParent).map(s=>s.id)`);
    assert.deepEqual(order, ['claude', 'codex', 'antigravity', 'exaone']);
    // An empty API-key category is hidden; it can still be added from the settings menu.
    const empty = await js(`(async()=>{const vis=id=>!!document.getElementById(id).offsetParent;const before={gemini:vis('gemini-api'),exaone:vis('exaone')};
      document.querySelector('#settingsBtn').click();const labels=[...document.querySelectorAll('.menu button')].map(b=>b.textContent);
      [...document.querySelectorAll('.menu button')].find(b=>b.textContent==='Gemini API 계정 추가…').click();await new Promise(r=>setTimeout(r,40));
      const opened={visible:vis('gemini-api'),open:document.querySelector('#gemini-api .addrow').classList.contains('open'),focused:document.activeElement===document.querySelector('#gemini-api .addrow input')};
      document.querySelector('#gemini-api .addrow .cancel').click();await new Promise(r=>setTimeout(r,40));
      return {before,labels,opened,afterCancel:vis('gemini-api')};})()`);
    assert.deepEqual(empty.before, { gemini: false, exaone: true });
    assert(empty.labels.includes('Gemini API 계정 추가…')); assert(!empty.labels.includes('EXAONE API 계정 추가…'));
    assert.deepEqual(empty.opened, { visible: true, open: true, focused: true }); assert.equal(empty.afterCancel, false);
    assert(compact.agyStatusInHeading); assert(compact.hintsHidden);
    // API-key accounts: month-to-date spend with an admin key, otherwise a connect button (no fabricated amount).
    const spend = await js(`(()=>{const c=document.querySelector('#claude .row[data-name="exp_api"] .api-cost'),x=document.querySelector('#codex .row[data-name="victor_api"] .api-cost');
      return {claude:c&&c.textContent.trim(),codexButton:!!(x&&x.querySelector('.admin-key')&&x.querySelector('.admin-key').offsetParent),codexText:x&&x.textContent.trim()};})()`);
    assert.equal(spend.claude, `${new Date().getUTCMonth() + 1}월 사용$1,234.50방금잔액≈$42.75기준 방금`);
    const titles = await js(`[...document.querySelectorAll('#claude .row[data-name="exp_api"] .api-cost .usage-window')].map(w=>w.title)`);
    assert.match(titles[0], /Anthropic 조직/); assert.match(titles[1], /추정 잔액 = 입력한 잔액 \$50\.00/); assert.match(titles[1], /이 PC의 Claude Code 사용 \$7\.25/);
    assert(!JSON.stringify(titles).includes('sk-ant-admin01'));
    const slotWrap = await js(`[...document.querySelectorAll('#claude .row[data-name="exp_api"] .api-cost .usage-window')].map(w=>[...w.children].map(e=>e.getClientRects().length===1&&e.getBoundingClientRect().height<20))`);
    assert(slotWrap.flat().every(Boolean), 'spend and balance slot texts stay on one line');
    assert(spend.codexButton); assert.equal(spend.codexText, '사용 금액 연결');
    const adminEntry = await js(`(async()=>{document.querySelector('#codex .row[data-name="victor_api"] .admin-key').click();await new Promise(r=>setTimeout(r,30));const f=document.querySelector('#codex .row[data-name="victor_api"] .keyentry');const out={placeholder:f&&f.querySelector('input').placeholder,label:f&&f.querySelector('input').getAttribute('aria-label')};f&&f.querySelector('.cancel').click();await new Promise(r=>setTimeout(r,30));return out;})()`);
    assert.match(adminEntry.placeholder, /sk-admin-… \(OpenAI 관리자 키/); assert.equal(adminEntry.label, 'victor_api 관리자 키');
    const keyedMenu = await js(`(()=>{document.querySelector('#claude .row[data-name="exp_api"] .more').click();const labels=[...document.querySelectorAll('.menu button')].map(b=>b.textContent);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return labels;})()`);
    for (const l of ['사용 금액 관리자 키 변경…', '사용 금액 지금 조회', '관리자 키 제거', '잔액 다시 입력…', '잔액 기준 지우기']) assert(keyedMenu.includes(l), l);
    // A valid key without organization admin permission reads as 권한 없음 with the fix in the tooltip, keeping no amount.
    const denied = await js(`(async()=>{fixture.cost('claude','exp_api',{amountUsd:null,capturedAt:null,error:'HTTP 403 permission_error'});await new Promise(r=>setTimeout(r,40));const c=document.querySelector('#claude .row[data-name="exp_api"] .api-cost');const out={text:c.textContent.trim(),title:c.querySelector('.usage-window').title};fixture.cost('claude','exp_api',{amountUsd:1234.5,capturedAt:new Date().toISOString(),error:null});await new Promise(r=>setTimeout(r,40));return out;})()`);
    assert.equal(denied.text, `${new Date().getUTCMonth() + 1}월 사용$12.50이 PC잔액≈$42.75기준 방금`); assert.match(denied.title, /개인\(Individual\) Console 계정은 Organization 페이지에서 조직을 설정/);
    const deniedNoLocal = await js(`(async()=>{fixture.cost('claude','exp_api',{amountUsd:null,error:'HTTP 403 permission_error',local:null,balance:null});await new Promise(r=>setTimeout(r,40));const c=document.querySelector('#claude .row[data-name="exp_api"] .api-cost');const out={text:c.textContent.trim(),button:!!c.querySelector('.balance-set')};fixture.cost('claude','exp_api',{amountUsd:1234.5,error:null,local:{monthUsd:12.5,sessions:3,updatedAt:new Date().toISOString()},balance:{baseUsd:50,at:new Date().toISOString(),spentSinceUsd:7.25,estimateUsd:42.75}});await new Promise(r=>setTimeout(r,40));return out;})()`);
    assert.equal(deniedNoLocal.text, `${new Date().getUTCMonth() + 1}월 사용권한 없음잔액 입력`); assert(deniedNoLocal.button);
    const balanceEntry = await js(`(async()=>{fixture.cost('claude','exp_api',{balance:null});await new Promise(r=>setTimeout(r,40));document.querySelector('#claude .row[data-name="exp_api"] .balance-set').click();await new Promise(r=>setTimeout(r,30));const f=document.querySelector('#claude .row[data-name="exp_api"] .balanceentry');const out={placeholder:f&&f.querySelector('input').placeholder,mode:f&&f.querySelector('input').inputMode};f&&f.querySelector('.cancel').click();fixture.cost('claude','exp_api',{balance:{baseUsd:50,at:new Date().toISOString(),spentSinceUsd:7.25,estimateUsd:42.75}});await new Promise(r=>setTimeout(r,40));return out;})()`);
    assert.match(balanceEntry.placeholder, /Console Billing의 현재 잔액 USD/); assert.equal(balanceEntry.mode, 'decimal');
    const text = await js(`document.querySelector('#codex .row[data-name="hoonlim"] .resources').textContent`);
    assert.match(text, /일반 크레딧\s*0/); assert.match(text, /리셋권\s*1개/); assert.match(text, /만료 \d+\/\d+ \d{2}:\d{2}/); assert.match(text, /자동 사용/);
    const menu = await js(`(()=>{document.querySelector('#codex .row[data-name="hoonlim"] .more').click();const labels=[...document.querySelectorAll('.menu button')].map(b=>b.textContent);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return labels;})()`);
    assert(menu.includes('리셋권 조회') && menu.some((l) => l.startsWith('리셋권 지금 사용')));
    // Narrower compact window (440px): one line kept by moving email to the tooltip and reset actions to the menu.
    win.setContentSize(440, 1400);
    const mid = await measure('compact', 440);
    assert(mid.total <= WORK_AREA_1080P - 16, `440px compact ${mid.total}px`);
    assert(!mid.rows.find((x) => x.name === 'hoonlim').emailVisible); assert(!mid.rows.find((x) => x.name === 'hoonlim').resetButtonsVisible);
    assert(mid.rows.filter((x) => x.section === 'codex').every((x) => !x.usageBelowName));
    assert.deepEqual(mid.wrapped, []); assert.equal(mid.clipped, 0); assert(!mid.overflow); assert(!mid.pageOverflow);
    // Narrow (360px): the compact row falls back to quota below the identity line, still without overflow.
    win.setContentSize(360, 1400);
    const narrow = await measure('compact', 360);
    assert(narrow.rows.filter((x) => x.section === 'codex' && x.resources).every((x) => x.usageBelowName));
    assert.equal(narrow.clipped, 0); assert(!narrow.pageOverflow); assert(!narrow.overflow);
    win.setContentSize(440, 1400);
    const comfortable = await measure('comfortable', 440);
    for (const r of comfortable.rows.filter((x) => ['claude', 'codex'].includes(x.section) && x.name !== 'exp_api' && x.name !== 'victor_api')) {
      assert(r.usageBelowName, `${r.name}: comfortable keeps two-line rows`); assert(r.emailVisible, `${r.name}: comfortable shows the email`);
    }
    assert(comfortable.rows.find((x) => x.name === 'hoonlim').resetButtonsVisible);
    assert(!comfortable.rows.find((x) => x.name === 'victor_api').resources);
    assert.equal(comfortable.clipped, 0); assert(!comfortable.pageOverflow);
    if (process.env.UI_SCREENSHOT_DIR) {
      for (const density of ['compact', 'comfortable']) {
        const w = density === 'compact' ? 560 : 440;
        win.setContentSize(w, 1400);
        const m = await measure(density, w);
        win.setContentSize(w, Math.min(1400, m.total + 2));
        await js('new Promise(r=>setTimeout(r,80))');
        fs.writeFileSync(path.join(process.env.UI_SCREENSHOT_DIR, `panel-${density}.png`), (await win.capturePage()).toPNG());
      }
    }
    console.log(`PASS panel density UI: 560px compact ${compact.total}px for 9 accounts + 3 shared groups (≤ ${WORK_AREA_1080P - 16}) with emails and reset actions on the row, 440px tooltip/menu fallback ${mid.total}px, API-key rows without resources, 360px two-line fallback, comfortable unchanged`);
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { app.quit(); }
});
