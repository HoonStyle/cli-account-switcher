'use strict';
// Chromium event handlers against an isolated API: late drafts and retry identity.
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'response-ui-'));app.setPath('userData',dir);
const preload=path.join(dir,'preload.js');
fs.writeFileSync(preload,`const {contextBridge}=require('electron');let version=1,fail=true,calls=[];
const detail=()=>({root:{id:'fixture',status:'needs_user',generation:1,goal:'question',permission:'read-only',coordinator:{tool:'claude'},round:0,maxRounds:3,inputRequest:{generation:1,version,reason:'Q'+version}},tasks:[],attempts:[],events:[]});
contextBridge.exposeInMainWorld('api',{state:async()=>({tools:{claude:{profiles:[]},codex:{profiles:[]}}}),onState(){},tasksStart:async()=>({status:'ok'}),tasksBindings:async()=>[],tasksList:async()=>[detail().root],tasksGet:async()=>detail(),tasksRespond:async(id,r)=>{calls.push({id,...r});if(fail)throw Error('fixture lost reply');}});
contextBridge.exposeInMainWorld('fixture',{version:v=>version=v,fail:v=>fail=v,calls:()=>calls});`);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 try{
  await win.loadFile(path.resolve(__dirname,'../src/renderer/tasks.html'));
  const result=await win.webContents.executeJavaScript(`(async()=>{
   await new Promise(r=>setTimeout(r,100));await showDetail('fixture');
   $('response').value='Q1 draft';window.fixture.version(2);await showDetail('fixture');$('respond').click();await new Promise(r=>setTimeout(r,50));
   const blocked=window.fixture.calls().length===0 && document.body.textContent.includes('질문이 바뀌었습니다');
   $('response').value='';await showDetail('fixture');$('response').value='Q2 answer';$('respond').click();await new Promise(r=>setTimeout(r,50));
   window.fixture.fail(false);$('respond').click();await new Promise(r=>setTimeout(r,50));
   return {blocked,calls:window.fixture.calls()};
  })()`);
  assert.equal(result.blocked,true);assert.equal(result.calls.length,2);
  for(const r of result.calls){assert.equal(r.generation,1);assert.equal(r.inputVersion,2);assert.equal(r.message,'Q2 answer');assert(r.requestId);}
  assert.equal(result.calls[0].requestId,result.calls[1].requestId);
  console.log('PASS rendered stale Q1 draft never targets Q2; explicit new draft binds Q2; transport retry retains exact request identity');
 }finally{win.destroy();}
}).then(()=>app.quit(),e=>{console.error(e);app.exit(1);});
