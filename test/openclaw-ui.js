'use strict';
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oc-ui-')),now=Date.now();
const managed={id:'managed',goal:'기존 스위처 작업',status:'completed',coordinator:{tool:'codex',profileId:'default'},createdAt:now-50000,updatedAt:now-10000};
const root={id:'oc-'+'a'.repeat(32),source:'openclaw',readOnly:true,scope:'session',goal:'#작업 · 오후 요청',status:'running',coordinator:{tool:'openclaw',label:'검토 대화',model:'fixture-model'},createdAt:now-5000,updatedAt:now,external:{channel:'#작업'}};
const detail={root,tasks:[{id:'child',goal:'/root/reviewer',state:'observed_unknown',binding:{tool:'openclaw',label:'/root/reviewer'},updatedAt:now,evidence:'spawn_receipt'}],attempts:[],events:[],external:{conversation:[{role:'user',text:'<img src=x onerror="window.injected=true">',at:now},{role:'assistant',text:'최근 응답',at:now}],runs:[{id:'r1',startedAt:now-5000,endedAt:now-1000,state:'observed_ended'},{id:'r2',startedAt:now,state:'running'}],activity:[{name:'exec',status:'completed'}],partialHistory:true}};
const preload=path.join(dir,'preload.js');fs.writeFileSync(preload,`const {contextBridge}=require('electron');let offline=false,mutations=0,gets=0,managedStatus="completed",delayExternal=false,releaseExternal;const root=${JSON.stringify(root)},detail=${JSON.stringify(detail)};contextBridge.exposeInMainWorld('api',{state:async()=>({tools:{codex:{active:'default',profiles:[{name:'default'}]},claude:{active:'default',profiles:[{name:'default'}]}}}),onState:()=>{},tasksStart:async()=>({status:'ok'}),tasksBindings:async()=>[],tasksList:async()=>[{...${JSON.stringify(managed)},status:managedStatus}],tasksGet:async()=>({root:${JSON.stringify(managed)},tasks:[],attempts:[],events:[]}),tasksExternalList:async()=>{if(delayExternal)await new Promise(r=>releaseExternal=r);return {status:offline?'offline':'ok',roots:[root],checkedAt:Date.now(),windowHours:24}},tasksExternalGet:async()=>{gets++;if(offline)throw Error("offline fixture");return detail},tasksAck:async()=>mutations++,tasksCancel:async()=>mutations++,tasksRespond:async()=>mutations++});contextBridge.exposeInMainWorld('fixture',{offline:v=>offline=v,managedStatus:v=>managedStatus=v,delay:v=>delayExternal=v,release:()=>{delayExternal=false;releaseExternal?.()},counts:()=>({mutations,gets})});`);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});try{
 const run=code=>win.webContents.executeJavaScript(`(async()=>{${code}})()`);
 await win.loadFile(path.resolve(__dirname,'../src/renderer/tasks.html'));await pause(180);await run(`await selectTask('${root.id}');`);
 let result=await run(`return {rows:document.querySelectorAll('.task').length,status:document.getElementById('detail-status').textContent,readOnly:document.getElementById('cancel').hidden,external:!document.getElementById('external-records').hidden,body:document.getElementById('delegations').textContent};`);
 assert.equal(result.rows,2);assert.equal(result.status,'실행 중');assert(result.readOnly&&result.external);assert(result.body.includes('현재 상태 미확인'));assert(!result.body.includes('총괄 검토 대기'));
 assert(await run(`return document.getElementById('external-runs').textContent.includes('완료 미확인') && !window.injected;`));
 await run(`document.getElementById('ack').click();document.getElementById('respond').click();document.getElementById('cancel-confirm').click();`);
 assert.equal((await run(`return window.fixture.counts();`)).mutations,0);
 await run(`const select=document.getElementById('source-filter');select.value='switcher';select.dispatchEvent(new Event('change'));`);assert.equal(await run(`return document.querySelectorAll('.task').length;`),1);
 await run(`document.querySelector('.task').click();await new Promise(r=>setTimeout(r,20));`);assert(await run(`return document.getElementById('external-records').hidden;`));
 await run(`const select=document.getElementById('source-filter');select.value='openclaw';select.dispatchEvent(new Event('change'));document.querySelector('.task').click();await new Promise(r=>setTimeout(r,20));window.fixture.offline(true);await refresh();`);
 result=await run(`return {service:document.getElementById('service').textContent,source:document.getElementById('external-sync').textContent,status:document.getElementById('detail-status').textContent};`);assert.equal(result.service,'서비스 연결됨');assert(result.source.includes('연결 확인 필요'));assert(result.status.includes('이전 기록'));
 await run(`window.fixture.offline(false);await refresh();`);assert.equal(await run(`return document.getElementById('detail-status').textContent;`),'실행 중');
 const isolated=await run(`window.fixture.delay(true);window.fixture.managedStatus('running');const slow=refresh();await new Promise(r=>setTimeout(r,30));const first=managedRoots[0].status;window.fixture.managedStatus('failed');const again=refresh();await new Promise(r=>setTimeout(r,30));const second=managedRoots[0].status;window.fixture.release();await Promise.all([slow,again]);return {first,second};`);
 assert.deepEqual(isolated,{first:'running',second:'failed'},'slow OpenClaw never blocks managed refresh');
 const interactive=await run(`window.fixture.delay(true);const pending=action(async()=>{});await new Promise(r=>setTimeout(r,30));const unlocked=!busy&&!document.getElementById('refresh').disabled;window.fixture.release();await pending;await refreshExternal();return unlocked;`);
 assert(interactive,'slow OpenClaw never holds the managed action UI busy');
 await run(`window.fixture.offline(true);await refresh();await selectTask('${root.id}');`);
 assert(await run(`return document.getElementById('detail-empty').textContent.includes('불러오지 못했습니다');`),'failed detail never stays loading');
 await run(`window.fixture.offline(false);await refresh();document.getElementById('source-filter').value='all';sourceFilter='all';window.fixture.managedStatus('completed');await refresh();document.querySelector('[data-id="managed"]').focus();window.fixture.managedStatus('ready');await refresh();`);
 assert.equal(await run(`return document.activeElement.dataset.id;`),'managed','list reordering preserves keyboard focus');
 assert(await run(`return !document.getElementById('external-sync').hasAttribute('role');`));
 assert.equal(await run(`return category({readOnly:true,status:'waiting'});`),'attention');
 for(const width of [390,1200]){
 win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height:1000},viewPosition:{x:0,y:0},deviceScaleFactor:0,viewSize:{width,height:1000},scale:1});await pause(120);
 assert(await run(`return innerWidth===${width}&&document.documentElement.scrollWidth<=innerWidth;`));
 if(process.env.TASK_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.TASK_UI_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TASK_UI_SCREENSHOT_DIR,`openclaw-${width}.png`),(await win.webContents.capturePage()).toPNG());}
 }
 console.log('PASS OpenClaw UI: combined/source lists, actual read-only guards, uncertain child state, ended != completed, inert text, source-specific outage/recovery and 390/1200px layout');
 }finally{win.destroy();}}).then(()=>app.quit(),e=>{console.error(e);app.exit(1)});
