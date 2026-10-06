'use strict';
// Real renderer DOM, isolated API fixture: no accounts or model requests.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-model-ui-'));
app.setPath('userData', tmp);
const preload = path.join(tmp, 'preload.js');
fs.writeFileSync(preload, `
const {contextBridge}=require('electron');
const state={tools:{codex:{active:'one',profiles:[{name:'one',label:'One',models:[{id:'codex-main',label:'GPT-6-Astra'},{id:'codex-child',label:'GPT-6-Sol'}]},{name:'other',label:'Other',models:[{id:'other-model',label:'GPT-6-Luna'}]}]},claude:{active:'two',profiles:[{name:'two',label:'Two',models:[{id:'claude-main',label:'Claude Opus 5.5'}]}]}}};
let notify,submitted;
contextBridge.exposeInMainWorld('api',{
state:async()=>state,onState:fn=>{notify=fn;},tasksStart:async()=>({status:'ok'}),tasksBindings:async()=>[{id:'bound',sessionKey:'fixture'}],
tasksList:async()=>[],tasksSubmit:async s=>{submitted=s;return{id:'fixture'};},tasksGet:async()=>({root:{status:'planning',goal:'fixture'}})
});
contextBridge.exposeInMainWorld('fixture',{refresh:()=>notify(state),submitted:()=>submitted,active:id=>{state.tools.codex.active=id;notify(state)},catalog:(remove=true)=>{state.tools.codex.profiles[0].models=[{id:'codex-main',label:'GPT-6-Astra'},...(remove?[]:[{id:'codex-child',label:'GPT-6-Sol'}])];notify(state)}});
`);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1000, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/tasks.html'));
    const result = await win.webContents.executeJavaScript(`(async()=>{
      await new Promise(r=>setTimeout(r,80));
      const byId=id=>document.getElementById(id),main=byId('main-tool'),field=byId('main-model');
      const change=tool=>{main.value=tool;main.dispatchEvent(new Event('change'));};
      change('codex');field.value='codex-main';change('claude');
      const noLeak=field.value===''&&field.tagName==='SELECT'&&field.options[1].textContent==='Claude Opus 5.5';field.value='claude-main';change('codex');
      const mainPreserved=field.value==='codex-main';window.fixture.active('other');const profileScoped=!Array.from(field.options).some(o=>o.value==='codex-main');field.value='other-model';window.fixture.active('one');const profileRestored=field.value==='codex-main';
      const row=document.querySelector('#participants .account-row');
      row.querySelector('input[type=checkbox]').click();row.querySelector('.participant-model').value='codex-child';
      window.fixture.refresh();
      const fresh=document.querySelector('#participants .account-row');
      const preserved=fresh.querySelector('input[type=checkbox]').checked&&fresh.querySelector('.participant-model').tagName==='SELECT'&&fresh.querySelector('.participant-model').value==='codex-child';window.fixture.catalog();const missingPreserved=fresh.querySelector('.participant-model').value==='codex-child';
      byId('project').value='/fixture/project';byId('goal').value='Review fixture';
      byId('submit-form').dispatchEvent(new Event('submit',{cancelable:true}));
      await new Promise(r=>setTimeout(r,30));const cli=window.fixture.submitted();
      change('openclaw');const hidden=byId('main-model-field').hidden&&field.disabled;
      byId('submit-form').dispatchEvent(new Event('submit',{cancelable:true}));
      await new Promise(r=>setTimeout(r,30));
      return {noLeak,mainPreserved,profileScoped,profileRestored,missingPreserved,preserved,hidden,cli,external:window.fixture.submitted()};
    })()`);
    assert(result.noLeak && result.mainPreserved && result.profileScoped && result.profileRestored && result.missingPreserved && result.preserved && result.hidden, JSON.stringify(result));
    assert.equal(result.cli.mainModel, 'codex-main');
    assert.equal(result.cli.participants[0].model, 'codex-child');
    assert(!Object.hasOwn(result.external, 'mainModel'));
    assert.equal(result.external.participants[0].model, 'codex-child');
    if(process.env.MODEL_UI_SCREENSHOT_DIR){await win.webContents.executeJavaScript(`window.fixture.catalog(false);document.getElementById('open-form').click();document.getElementById('main-tool').value='claude';document.getElementById('main-tool').dispatchEvent(new Event('change'));document.getElementById('main-model').value='claude-main';document.getElementById('goal').value='코드 검토';document.activeElement?.blur();window.scrollTo(0,0);`);await new Promise(r=>setTimeout(r,100));fs.mkdirSync(process.env.MODEL_UI_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.MODEL_UI_SCREENSHOT_DIR,'model-dropdowns.png'),(await win.webContents.capturePage()).toPNG());}
    console.log('PASS renderer model selection, per-tool drafts, refresh preservation and OpenClaw-main exclusion');
  } finally { win.destroy(); }
}).then(() => app.quit(), e => { console.error(e); app.exit(1); });
