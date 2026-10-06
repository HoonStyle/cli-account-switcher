'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'project-folder-ui-'));app.setPath('userData',dir);
const preload=path.join(dir,'preload.js');
fs.writeFileSync(preload,`const {contextBridge}=require('electron');let chosen=null,fail=false,delay=0;const web=process.argv.includes('--picker=web');const api={state:async()=>({tools:{codex:{active:'default',profiles:[]},claude:{profiles:[]}}}),onState:()=>{},tasksStart:async()=>({}),tasksBindings:async()=>[],tasksList:async()=>[]};if(web)api.tasksBrowseFolders=async p=>{const wait=delay;delay=0;if(wait)await new Promise(r=>setTimeout(r,wait));if(fail)throw Error('폴더 접근 실패');return {path:p||'/host',parent:p?'/host':null,roots:[{name:'홈',path:'/host'}],folders:p&&p!='/host'?[]:[{name:'한글 프로젝트 #1',path:'/host/한글 프로젝트 #1'},{name:'Other',path:'/host/Other'}]}};else api.tasksChooseProject=async p=>{if(fail)throw Error('선택 실패');return chosen};contextBridge.exposeInMainWorld('api',api);contextBridge.exposeInMainWorld('fixture',{choose:v=>chosen=v,fail:v=>fail=v,delay:v=>delay=v});`);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 for(const mode of ['native','web']){
  const win=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,additionalArguments:['--picker='+mode]}});
  const run=code=>win.webContents.executeJavaScript(`(async()=>{const $=id=>document.getElementById(id);${code}})()`);
  try{
   await win.loadFile(path.resolve(__dirname,'../src/renderer/tasks.html'));await pause(80);await run(`$('open-form').click();$('project').value='/original';`);
   if(mode==='native'){
    await run(`$('choose-project').click();`);await pause(20);assert.equal(await run(`return $('project').value;`),'/original');
    await run(`window.fixture.choose('/selected/한글 프로젝트 #1');$('choose-project').click();`);await pause(20);assert.equal(await run(`return $('project').value;`),'/selected/한글 프로젝트 #1');
    await run(`window.fixture.fail(true);$('choose-project').click();`);await pause(20);assert(await run(`return !$('choose-project').disabled&&$('project').value==='/selected/한글 프로젝트 #1'&&$('notice').textContent.includes('선택 실패');`));
   }else{
    await run(`$('project').value='';$('choose-project').click();`);await pause(30);assert(await run(`return $('folder-dialog').open&&$('folder-list').children.length===2;`));
    await run(`$('folder-search').value='한글';$('folder-search').dispatchEvent(new Event('input'));`);assert.equal(await run(`return $('folder-list').children.length;`),1);
    await run(`$('folder-list').firstChild.click();`);await pause(30);assert.equal(await run(`return $('folder-path').textContent;`),'/host/한글 프로젝트 #1');
    await run(`$('folder-select').click();`);
    // Dialog close/focus restoration is queued by Chromium; wait for the
    // observable state instead of assuming a CI renderer settles in 20 ms.
    let selected;
    for(let attempt=0;attempt<100;attempt++){
     selected=await run(`return {open:$('folder-dialog').open,value:$('project').value,focus:document.activeElement.id};`);
     if(!selected.open&&selected.value==='/host/한글 프로젝트 #1'&&selected.focus==='choose-project')break;
     await pause(20);
    }
    assert(!selected.open&&selected.value==='/host/한글 프로젝트 #1'&&selected.focus==='choose-project',JSON.stringify(selected));
    await run(`$('choose-project').click();`);await pause(20);await run(`$('folder-up').click();`);await pause(20);await run(`$('folder-cancel').click();`);assert.equal(await run(`return $('project').value;`),'/host/한글 프로젝트 #1');
    await run(`window.fixture.fail(true);$('choose-project').click();`);await pause(20);assert(await run(`return !$('folder-error').hidden&&$('folder-select').disabled;`));
    await run(`window.fixture.fail(false);$('folder-roots').firstChild.click();`);await pause(20);assert(await run(`return $('folder-error').hidden&&!$('folder-select').disabled;`));
    await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await pause(20);assert(await run(`return !$('folder-dialog').open;`));
    await run(`window.fixture.delay(120);$('choose-project').click();`);await pause(15);await run(`$('folder-cancel').click();`);await pause(140);assert(await run(`return !$('folder-dialog').open&&$('project').value==='/host/한글 프로젝트 #1';`));
    await run(`$('project').value='';$('choose-project').click();`);await pause(30);win.setContentSize(390,850);await pause(30);assert(await run(`const d=$('folder-dialog');return document.documentElement.scrollWidth<=innerWidth&&d.scrollWidth<=d.clientWidth;`));
    if(process.env.FOLDER_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.FOLDER_UI_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.FOLDER_UI_SCREENSHOT_DIR,'folder-picker-mobile.png'),(await win.webContents.capturePage()).toPNG());}
   }
  }finally{win.destroy();}
 }
 console.log('PASS project picker native selection/cancel/error, web browse/search/select/up/cancel/Escape/recovery/stale-response and 390px layout');
}).then(()=>app.quit(),e=>{console.error(e);app.exit(1)});
