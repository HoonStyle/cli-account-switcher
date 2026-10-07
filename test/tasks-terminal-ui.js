'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-terminal-ui-'));app.setPath('userData',dir);
const now=Date.now(),binding={tool:'codex',profileId:'one',model:'gpt-6-astra'};
const initial={root:{id:'root',goal:'로그인 오류 수정',status:'running',coordinator:{tool:'openclaw'},createdAt:now-60000,participants:[binding]},tasks:[{id:'task',goal:'수정 코드를 확인하고 테스트를 실행합니다.',state:'running',binding}],attempts:[{id:'attempt',taskId:'task',role:'child',binding,state:'running',startedAt:now-50000,createdAt:now-50000}],events:[]};
initial.tasks.push({...initial.tasks[0],id:'task-two',goal:'세션 복구 동작을 확인합니다.'});
initial.attempts.push({...initial.attempts[0],id:'attempt-two',taskId:'task-two'});
const preload=path.join(dir,'preload.js');
fs.writeFileSync(preload,`const {contextBridge}=require('electron');let detail=${JSON.stringify(initial)},next=[],content='테스트 실행 중',offline=false,calls=0;contextBridge.exposeInMainWorld('api',{state:async()=>({tools:{codex:{active:'one',profiles:[{name:'one',label:'개발 담당'}]},claude:{profiles:[]}}}),onState:()=>{},tasksStart:async()=>({}),tasksBindings:async()=>[],tasksList:async()=>[detail.root],tasksGet:async()=>detail,tasksOutput:async(id,attemptId)=>{calls++;const q=next.shift();if(q){await new Promise(r=>setTimeout(r,q.delay));return q.data}if(offline)throw Error('연결 확인');return {attemptId,state:'running',childPid:1234,updatedAt:Date.now(),stdout:JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'npm test',aggregated_output:content,exit_code:0}}),stderr:'fixture stderr'};}});contextBridge.exposeInMainWorld('fixture',{content:v=>content=v,offline:v=>offline=v,queue:v=>next=v,advance:()=>{const previous=detail.attempts[0];detail.attempts=[previous,{...previous,id:'new-attempt',createdAt:previous.createdAt-100000}];detail.tasks[0].currentAttemptId='new-attempt'},calls:()=>calls});`);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 const run=code=>win.webContents.executeJavaScript(`(async()=>{${code}})()`);
 try{
  await win.loadFile(path.resolve(__dirname,'../src/renderer/tasks.html'));await pause(100);
  assert.equal(await run(`return window.fixture.calls();`),0,'closed terminals must not poll logs');
  await run(`document.getElementById('toggle-terminals').click();`);await pause(30);
  let result=await run(`const n=document.querySelector('.delegate .terminal');return {open:n.open,text:n.textContent};`);
  assert(result.open&&result.text.includes('$ npm test')&&result.text.includes('테스트 실행 중')&&result.text.includes('stderr')&&result.text.includes('PID 1234'),JSON.stringify(result));
  assert.equal(await run(`return document.querySelectorAll('.delegate .terminal[open]').length;`),2,'expand all opens every delegation terminal');
  await run(`document.querySelectorAll('.delegate .terminal')[1].open=false;`);
  await run(`window.fixture.content('<img src=x onerror="window.injected=true">'+String.fromCharCode(27)+'[31mtest');await refresh();`);await pause(30);
  assert(await run(`const p=document.querySelector('.delegate .terminal-output');return p.textContent.includes('<img')&&!p.querySelector('img')&&!window.injected&&!p.textContent.includes(String.fromCharCode(27));`));
  await run(`window.fixture.content(Array(120).fill('실행 기록').join(String.fromCharCode(10)));await refresh();`);await pause(30);
  await run(`const n=document.querySelector('.delegate .terminal');n.querySelector('input').checked=false;n.querySelector('pre').scrollTop=30;await refresh();`);await pause(30);
  assert.equal(await run(`return document.querySelector('.delegate .terminal pre').scrollTop;`),30,'manual scroll must survive refresh');
  await run(`window.fixture.offline(true);await refresh();`);await pause(30);
  assert(await run(`return document.querySelector('.delegate .terminal').textContent.includes('출력 조회 실패')&&document.querySelector('.delegate .terminal-output').textContent.includes('실행 기록');`));
  await run(`window.fixture.offline(false);window.fixture.content('복구된 출력');await refresh();`);await pause(30);
  assert(await run(`return !document.querySelector('.delegate .terminal').textContent.includes('출력 조회 실패');`));
  await run(`window.fixture.queue([{delay:80,data:{stdout:'OLD',state:'running'}},{delay:5,data:{stdout:'NEW',state:'running'}}]);loadTerminal(document.querySelector('.delegate .terminal'));window.fixture.advance();await refresh();`);await pause(100);
  assert.equal(await run(`return document.querySelector('.delegate .terminal-output').textContent;`),'NEW','current attempt identity survives wall-clock rollback and fences old output');
  const screenshot=process.env.TERMINAL_UI_SCREENSHOT_DIR;
  if(screenshot){await run(`window.fixture.content(['PASS 로그인 처리','PASS 세션 복구','검증 완료: 2개 테스트'].join(String.fromCharCode(10)));await refresh();window.scrollTo(0,0);`);await pause(80);fs.mkdirSync(screenshot,{recursive:true});fs.writeFileSync(path.join(screenshot,'terminal-desktop.png'),(await win.webContents.capturePage()).toPNG());}
  win.setContentSize(390,1000);await pause(80);assert(await run(`return document.documentElement.scrollWidth<=innerWidth;`));
  console.log('PASS terminal open/poll, command/stdout/stderr/PID, inert output, manual scroll, offline recovery, stale-attempt fencing and mobile layout');
 }finally{win.destroy();}
}).then(()=>app.quit(),e=>{console.error(e);app.exit(1)});
