'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-ui-'));
app.setPath('userData', tmp);
const preload = path.join(tmp, 'preload.js');
fs.writeFileSync(preload, `
const {contextBridge}=require('electron');const calls=[];
const quota={source:'agy-cli',scope:'shared-login',capturedAt:new Date().toISOString(),groups:[
{name:'Gemini',buckets:[{id:'gemini-weekly',label:'주간',window:'weekly',remainingPercent:100,usedPercent:0,resetsAt:Date.now()/1000+604800}]},
{name:'Claude·GPT',buckets:[{id:'3p-weekly',label:'주간',window:'weekly',remainingPercent:75,usedPercent:25,resetsAt:Date.now()/1000+604800}]}]};
const state={usageMode:'remaining',pathStatus:{first:true},tools:{claude:{active:'default',profiles:[]},codex:{active:'default',profiles:[]}},antigravity:{accounts:[{id:'a'.repeat(32),label:'개인',email:'personal@example.invalid'}],usage:null,usagePending:false}};let listener=()=>{};
contextBridge.exposeInMainWorld('api',{state:async()=>state,onState:fn=>listener=fn,resize:()=>{},antigravity:async(action)=>{calls.push(action);state.antigravity.usagePending=true;listener(state);await new Promise(r=>setTimeout(r,80));state.antigravity.usage=quota;state.antigravity.usagePending=false;listener(state);return state.antigravity;}});
contextBridge.exposeInMainWorld('fixture',{calls:()=>calls,update:(patch)=>{Object.assign(state,patch);listener(state);},agy:(patch)=>{Object.assign(state.antigravity,patch);listener(state);}});
`);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 440, height: 900, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  const js = source => win.webContents.executeJavaScript(source);
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    await js('new Promise(r=>setTimeout(r,80))');
    assert.match(await js('document.querySelector("#agy-usage-status").textContent'), /미조회/);
    await js('document.querySelector("#agy-usage-refresh").click()');
    assert.equal(await js('document.querySelector("#agy-usage-refresh").disabled'), true);
    await js('document.querySelector("#agy-usage-refresh").click();new Promise(r=>setTimeout(r,130))');
    assert.deepEqual(await js('fixture.calls()'), ['refreshUsage']);
    for (const density of ['compact', 'comfortable']) {
      await js(`fixture.update({density:${JSON.stringify(density)}})`);
      for (const width of [440, 360]) {
        win.setSize(width, 900);
        const view = await js(`({groups:document.querySelectorAll('.agy-quota-group').length,windows:document.querySelectorAll('#agy-usage .usage-window').length,overflow:document.documentElement.scrollWidth>innerWidth,text:document.querySelector('#agy-usage').textContent,savedRow:document.querySelector('#antigravity .row').textContent})`);
        assert.equal(view.groups, 2); assert.equal(view.windows, 2); assert(!view.overflow);
        assert.match(view.text, /Gemini/); assert.match(view.text, /Claude·GPT/); assert.match(view.text, /75%/); assert(!view.text.includes('5시간'));
        assert(!view.savedRow.includes('%'), 'unidentified shared CLI usage is not attached to a saved identity');
        if (process.env.UI_SCREENSHOT_DIR) fs.writeFileSync(path.join(process.env.UI_SCREENSHOT_DIR, `usage-${density}-${width}.png`), (await win.capturePage()).toPNG());
      }
    }
    await js('fixture.update({usageMode:"used"})'); assert.match(await js('document.querySelector("#agy-usage").textContent'), /25%/);
    await js('fixture.agy({usageError:"로그인 확인 필요"})'); assert.match(await js('document.querySelector("#agy-usage-status").textContent'), /이전 값/);
    await js('fixture.agy({usage:{capturedAt:new Date().toISOString(),groups:[{name:"<img src=x onerror=alert(1)>",buckets:[{label:"주간",remainingPercent:50,usedPercent:50}]}]},usageError:null})');
    assert.equal(await js('document.querySelector("#agy-usage img")'), null);
    console.log('PASS quota UI: one row per shared group, weekly-only, 440/360px × 2 densities, loading/single click, used/remaining, stale error, identity scope, escaping');
  } finally { win.destroy(); }
}).then(() => app.quit(), e => { console.error(e); app.exit(1); });
app.on('will-quit', () => fs.rmSync(tmp, { recursive: true, force: true }));
