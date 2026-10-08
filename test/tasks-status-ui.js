'use strict';
// Real Electron renderer with synthetic, isolated API. No accounts or model calls.
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'switch-task-status-'));
app.setPath('userData',dir);
const now=Date.now();
const codex={tool:'codex',profileId:'one',model:'gpt-6-astra'},claude={tool:'claude',profileId:'two',model:'claude-opus-5-5'};
const root={id:'demo',status:'running',goal:'작업관리 화면을 쉽게 바꾸고, 위임 작업의 실행·오류 상태를 보여주세요.',projectPath:'/Projects/account-switcher',coordinator:{tool:'openclaw'},createdAt:now-150000,updatedAt:now-2000,participants:[codex,claude],observation:{counts:{total:4,running:2,queued:1,succeeded:1,failed:0,unknown:0},requiresAttention:false}};
const tasks=[
 {id:'t1',goal:'실제 실행 신호와 마지막 출력 시각을 확인하고 상태를 정리합니다.',binding:codex,state:'queued',observation:{executionState:'running',activity:'running',heartbeatStatus:'fresh',heartbeatAt:now-1000,lastOutputAt:now-13000}},
 {id:'t2',goal:'일반 사용자 관점에서 문구와 화면 흐름을 검토합니다.',binding:claude,state:'queued',observation:{executionState:'running',activity:'quiet',heartbeatStatus:'fresh',heartbeatAt:now-1000,lastOutputAt:now-360000}},
 {id:'t3',goal:'모바일 너비와 키보드 이동을 확인합니다.',binding:codex,state:'queued',observation:{executionState:'queued',activity:'queued',waitReason:'account_busy'}},
 {id:'t4',goal:'새 작업 설정과 완료 결과 흐름을 점검합니다.',binding:claude,state:'succeeded',result:{summary:'검토를 마쳤습니다. <img src=x onerror="window.injected=true">'},review:{decision:'accepted',reason:'사용자 관점의 문구를 반영했습니다.'},observation:{executionState:'succeeded',activity:'succeeded'}}
];
const initial={root,tasks,attempts:tasks.map((t,i)=>({id:'a'+i,taskId:t.id,createdAt:now-100000,startedAt:now-90000,state:t.observation.executionState,binding:t.binding})),events:[{seq:1,at:now-150000,type:'submitted',body:{}},{seq:2,at:now-100000,type:'delegated',body:{}},{seq:3,at:now-90000,type:'runner_receipt',body:{}}]};
const preload=path.join(dir,'preload.js');
fs.writeFileSync(preload,`const {contextBridge}=require('electron');let detail=${JSON.stringify(initial)},offline=false,notify,acks=0,cancels=0,gets=0,responses=[],detailReplies=[],detailCalls=0;const state={tools:{codex:{active:'one',profiles:[{name:'one',label:'개발 담당'}]},claude:{active:'two',profiles:[{name:'two',label:'UX 검토'}]}}};
contextBridge.exposeInMainWorld('api',{state:async()=>state,onState:f=>notify=f,tasksStart:async()=>({status:'ok'}),tasksBindings:async()=>[],tasksList:async()=>{if(offline)throw Error('fixture offline');return[detail.root]},tasksGet:async()=>{gets++;const next=responses.shift();if(next){await new Promise(r=>setTimeout(r,next.delay));if(next.error)throw Error(next.error);return next.detail}return detail},tasksTaskDetail:async()=>{detailCalls++;const next=detailReplies.shift();if(!next)throw Error('missing detail fixture');await new Promise(r=>setTimeout(r,next.delay||0));if(next.error)throw Error(next.error);return next.task},tasksAck:async()=>{acks++},tasksRespond:async()=>{},tasksCancel:async()=>{cancels++;detail.root.status='cancel_requested'}});
contextBridge.exposeInMainWorld('fixture',{set:d=>detail=d,get:()=>detail,offline:v=>offline=v,refreshState:()=>notify(state),queue:r=>responses=r,detailQueue:r=>detailReplies=r,counts:()=>({acks,cancels,gets,detailCalls})});`);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:1100,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 let checks=0;const check=(v,msg)=>{assert(v,msg);checks++;};
 try{
  await win.loadFile(path.resolve(__dirname,'../src/renderer/tasks.html'));await pause(120);
  const run=code=>win.webContents.executeJavaScript(`(async()=>{${code}})()`);
  // A CI display can constrain native window resizing. Exercise Chromium's
  // actual viewport/media queries, independently of the host screen size.
  const viewport=async(width,height)=>{
    win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height},viewPosition:{x:0,y:0},deviceScaleFactor:0,viewSize:{width,height},scale:1});
    let actual;
    for(let attempt=0;attempt<40;attempt++){
      actual=await run(`return {width:innerWidth,height:innerHeight,mobile:matchMedia('(max-width:680px)').matches};`);
      if(actual.width===width&&actual.height===height&&actual.mobile===(width<=680))return;
      await pause(50);
    }
    assert.fail(`viewport ${width}x${height} did not settle: ${JSON.stringify(actual)}`);
  };
  await viewport(1200,1100);
  let result=await run(`const $=id=>document.getElementById(id);return {open:$('create-task').open,cards:$('delegations').children.length,body:$('delegations').textContent,final:$('final').hidden,ack:$('ack').hidden,injected:!!window.injected};`);
  check(!result.open && result.cards===4,'task-first dashboard and visible delegation cards');
  const race=await run(`const old=window.fixture.get(), latest=JSON.parse(JSON.stringify(old)); latest.root.status='failed'; window.fixture.queue([{delay:50,detail:old},{delay:5,detail:latest}]); await Promise.all([showDetail('demo'),showDetail('demo')]); return document.getElementById('detail-status').textContent;`);
  check(race==='오류 발생','older same-task response cannot overwrite latest failure');
  const lateError=await run(`const current=window.fixture.get();window.fixture.queue([{delay:50,error:'old error'},{delay:5,detail:current}]);await Promise.all([showDetail('demo'),showDetail('demo')]);return document.getElementById('detail-status').textContent;`);
  check(lateError==='실행 중','obsolete request error cannot override newer success');
  check(result.body.includes('실행 중') && result.body.includes('새 출력 없음') && result.body.includes('다른 작업을 실행 중'),'truthful running/quiet/account wait states');
  check(result.body.includes('총괄 검토 · 수용') && !result.injected,'review separate and provider HTML remains inert');
  const output=process.env.TASK_UI_SCREENSHOT_DIR;
  if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'task-dashboard-desktop.png'),(await win.webContents.capturePage()).toPNG());}
  result=await run(`const b=document.querySelector('.task');b.focus();const details=document.querySelector('.delegate details:not([hidden])');details.open=true;const d=window.fixture.get();d.tasks[0].observation.lastOutputAt=Date.now();window.fixture.set(d);await refresh();return {focus:document.activeElement===b,open:details.open,same:b===document.querySelector('.task')};`);
  check(result.focus&&result.open&&result.same,'refresh preserves node, focus and expanded details');
  check(await run(`const d=window.fixture.get();d.root.status='needs_user';window.fixture.set(d);await refresh();return document.getElementById('respond-area').hidden && document.getElementById('next-body').textContent.includes('원래 OpenClaw 대화');`),'OpenClaw continuation stays with bound owner');
  result=await run(`const d=window.fixture.get();d.root.coordinator={tool:'codex',profileId:'one'};d.root.status='needs_user';d.root.attention='어느 화면부터 고칠까요?';window.fixture.set(d);await refresh();document.getElementById('response').value='입력 중인 답변';document.getElementById('response').focus();await refresh();return {value:document.getElementById('response').value,focus:document.activeElement.id,visible:!document.getElementById('respond-area').hidden};`);
  check(result.value==='입력 중인 답변'&&result.focus==='response'&&result.visible,'needs_user input and focus survive refresh');
  result=await run(`const d=window.fixture.get();d.root.attention='launch_blocked: fixture failure';window.fixture.set(d);await refresh();return document.getElementById('next-title').textContent+' '+document.getElementById('detail-status').textContent;`);
  check(result.includes('오류')&&!result.includes('답변 필요'),'system error must not be described as user question');
  result=await run(`const d=window.fixture.get();d.root.inputRequest={kind:'coordinator',reason:'launch_blocked: 라벨을 유지할까요?',summary:'launch_blocked: 라벨을 유지할까요?'};d.root.attention='runner_unknown:a1';window.fixture.set(d);await refresh();return {body:document.getElementById('next-body').textContent,label:document.getElementById('detail-status').textContent};`);
  check(result.label==='답변 필요'&&result.body.includes('라벨을 유지할까요?')&&!result.body.includes('중복 작업'),'input request prose cannot be mistaken for a diagnostic prefix or overwritten by runner warnings');
  result=await run(`const d=window.fixture.get();d.root.inputRequest={kind:'preflight',reason:'launch_blocked: fixture missing',summary:'fixture missing'};window.fixture.set(d);await refresh();return {body:document.getElementById('next-body').textContent,label:document.getElementById('detail-status').textContent};`);
  check(result.label==='준비 실패'&&result.body.includes('fixture missing'),'typed preflight blocker takes priority over concurrent runner diagnostic');
  result=await run(`const d=window.fixture.get();d.root.status='running';d.root.attention=null;d.tasks[0].observation.activity='unknown';d.tasks[0].observation.heartbeatStatus='stale';d.tasks[1].state='failed';d.tasks[1].observation={executionState:'failed',activity:'failed',error:{message:'CLI 실행 종료',exitCode:1}};window.fixture.set(d);await refresh();return document.getElementById('delegations').textContent;`);
  check(result.includes('실행 확인 필요')&&result.includes('종료 코드 1'),'unknown != failed and actual failure reason shown');
  result=await run(`const d=window.fixture.get();d.root.coordinator={tool:'openclaw'};d.root.status='ready';d.root.finalResponse='검증 결과입니다.';d.root.finalVersion=2;window.fixture.set(d);await refresh();return {hidden:document.getElementById('ack').hidden,help:document.getElementById('ack-help').textContent,ready:document.getElementById('detail-status').textContent};`);
  check(result.hidden&&result.help.includes('실제 전달')&&result.ready==='결과 도착','OpenClaw readiness never self-acks channel delivery');
  check(await run(`const d=window.fixture.get();d.root.finalDelivery='unknown';window.fixture.set(d);await refresh();return document.getElementById('next-title').textContent.includes('전달 여부 확인 필요') && !document.getElementById('final').hidden && document.getElementById('ack').hidden;`),'saved final plus unknown delivery remains visible but is not declared received');
  check(await run(`const d=window.fixture.get();d.root.status='needs_user';d.root.attentionDelivery='delivered';window.fixture.set(d);await refresh();const ok=document.getElementById('next-body').textContent.includes('안내는 전달됐으며 답변을 기다립니다');d.root.status='ready';window.fixture.set(d);await refresh();return ok;`),'delivered notice does not complete or resume a needs_user task');
  result=await run(`const d=window.fixture.get();d.root.coordinator={tool:'codex',profileId:'one'};window.fixture.set(d);await refresh();const button=document.getElementById('ack');button.click();await new Promise(r=>setTimeout(r,20));return {hidden:button.hidden,count:window.fixture.counts().acks};`);
  check(!result.hidden&&result.count===1,'CLI result can be explicitly acknowledged');
  result=await run(`const d=window.fixture.get();d.root.status='running';window.fixture.set(d);await refresh();document.getElementById('cancel').click();const before=window.fixture.counts().cancels;document.getElementById('cancel-back').click();document.getElementById('cancel').click();document.getElementById('cancel-confirm').click();await new Promise(r=>setTimeout(r,20));return {before,after:window.fixture.counts().cancels,status:document.getElementById('detail-status').textContent};`);
  check(result.before===0&&result.after===1&&result.status==='중단 처리 중','cancel requires confirmation and not prematurely cancelled');
  result=await run(`document.querySelectorAll('.delegate > details:not(.terminal)').forEach(n=>n.open=false);const d=window.fixture.get(),t=d.tasks.find(t=>t.id==='t4');t.resultVersion=1;t.detailsTruncated=true;t.detailRevision='r1';t.result.summary='미리보기';window.fixture.set(d);window.fixture.detailQueue([{task:{...t,result:{summary:'전체 한글 🦕 결과 끝',artifacts:Array.from({length:21},(_,i)=>'/산출물/'+i+'-'+'긴경로'.repeat(101)+'.txt')}}}]);await refresh();return window.fixture.counts().detailCalls;`);
  check(result===0,'collapsed result previews do not request full evidence');
  await run(`document.querySelector('.delegate[data-id="t4"] > details').open=true;`);await pause(30);
  check(await run(`return document.querySelector('.delegate[data-id="t4"] > details pre').textContent.includes('전체 한글 🦕 결과 끝');`),'expansion restores exact full evidence instead of presenting a truncated result as complete');
  check(await run(`const s=document.querySelector('.delegate[data-id="t4"] > details pre').textContent;return s.includes('산출물')&&s.includes('/산출물/20-'+'긴경로'.repeat(101)+'.txt');`),'full evidence displays all artifact paths without preview count or length limits');
  await run(`await refresh();`);
  check(await run(`return window.fixture.counts().detailCalls===1;`),'unchanged result revision reuses loaded evidence');
  await run(`const d=window.fixture.get(),t=d.tasks.find(t=>t.id==='t4');window.fixture.detailQueue([{delay:70,task:{...t,result:{summary:'OLD RESULT'}}},{delay:5,task:{...t,result:{summary:'NEW RESULT'}}}]);t.detailRevision='r2';window.fixture.set(d);await refresh();t.detailRevision='r3';window.fixture.set(d);await refresh();`);await pause(90);
  check(await run(`const s=document.querySelector('.delegate[data-id="t4"] > details pre').textContent;return s.includes('NEW RESULT')&&!s.includes('OLD RESULT');`),'older result-page reconstruction cannot overwrite a new result revision');
  await run(`const d=window.fixture.get();d.tasks.find(t=>t.id==='t4').detailRevision='r4';window.fixture.detailQueue([{error:'Query changed; restart'}]);window.fixture.set(d);await refresh();`);await pause(25);
  check(await run(`const s=document.querySelector('.delegate[data-id="t4"] > details pre').textContent;return s.includes('전체 조회 실패')&&s.includes('미리보기');`),'revision conflict remains an explicit retrieval failure with preview preserved');
  result=await run(`window.fixture.offline(true);await refresh();return {service:document.getElementById('service').textContent,notice:document.getElementById('notice').textContent,disabled:document.getElementById('submit').disabled,kept:document.getElementById('delegations').children.length};`);
  check(result.notice.includes('작업 오류와는 별개')&&result.disabled&&result.kept===4,'offline keeps previous state without declaring task failure');
  await run(`window.fixture.offline(false);await refresh();`);
  check(await run(`return document.getElementById('notice').textContent==='';`),'connection warning clears after successful refresh');
  await run(`document.getElementById('search').value='없는 작업';document.getElementById('search').dispatchEvent(new Event('input'));`);
  check(await run(`return !document.getElementById('list-empty').hidden;`),'search empty state');
  await run(`document.getElementById('filter-all').click();window.fixture.set(${JSON.stringify(initial)});await refresh();`);
  for(const width of [390,375,800,1200]){
    await viewport(width,width===800 ? 450 : 1000);
    check(await run(`return document.documentElement.scrollWidth<=innerWidth;`),`no horizontal overflow at ${width}`);
    if(width===390){
      await run(`syncTaskIndex(false);`);
      check(await run(`return getComputedStyle(document.getElementById('list')).display==='none' && document.getElementById('toggle-list').getAttribute('aria-expanded')==='false';`),'mobile index collapses with accurate accessible state');
      await run(`document.activeElement?.blur();window.scrollTo(0,0);`);await pause(100);
      if(output)fs.writeFileSync(path.join(output,'task-dashboard-mobile.png'),(await win.webContents.capturePage()).toPNG());
      await run(`document.getElementById('toggle-list').click();`);
      check(await run(`return getComputedStyle(document.getElementById('list')).display!=='none' && document.getElementById('toggle-list').getAttribute('aria-expanded')==='true';`),'mobile index expands for task selection');
      await run(`document.querySelector('.task').click();await new Promise(r=>setTimeout(r,25));`);
      check(await run(`return document.activeElement.id==='detail-title' && getComputedStyle(document.getElementById('list')).display==='none';`),'mobile selection reveals detail and moves focus out of collapsed index');
      await run(`document.querySelector('[data-filter=active]').click();`);
      check(await run(`return getComputedStyle(document.getElementById('list')).display!=='none';`),'state filter opens mobile task index');
      await run(`syncTaskIndex(false);`);
    }else if(width>680) check(await run(`return getComputedStyle(document.getElementById('list')).display!=='none';`),'desktop index stays visible after mobile collapse');
  }
  console.log(`PASS ${checks} task-status UI checks: live states, review, delivery, errors, cancel, focus/drafts, offline, responsive layout`);
 }finally{win.destroy();}
}).then(()=>app.quit(),e=>{console.error(e);app.exit(1)});
