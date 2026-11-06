'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-ui-'));
app.setPath('userData', tmp);
const preload = path.join(tmp, 'preload.js');
fs.writeFileSync(preload, `
const {contextBridge}=require('electron');
const calls=[];
const state={pathStatus:{first:true},tools:{claude:{active:'default',profiles:[]},codex:{active:'default',profiles:[]}},antigravity:{accounts:[{id:'a'.repeat(32),label:'개인',email:'personal@example.invalid'},{id:'b'.repeat(32),label:'업무 <script>',email:'work@example.invalid'}],current:null,checkedAt:null,recoveryRequired:false}};
contextBridge.exposeInMainWorld('api',{state:async()=>state,onState:()=>{},resize:()=>{},antigravity:async(action,value)=>{calls.push({action,value});if(action==='check'){state.antigravity.current={email:'personal@example.invalid'};state.antigravity.checkedAt=new Date().toISOString();}return state.antigravity;}});
contextBridge.exposeInMainWorld('fixture',{calls:()=>calls});
`);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 440, height: 900, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,100))');
    for (const width of [440, 360]) {
      win.setSize(width, 900);
      const state = await win.webContents.executeJavaScript(`({text:document.querySelector('#antigravity').textContent,rows:document.querySelectorAll('#antigravity .row').length,overflow:document.documentElement.scrollWidth>innerWidth,script:document.querySelector('#antigravity script')!==null})`);
      assert.equal(state.rows, 2); assert.match(state.text, /공용 로그인/); assert.match(state.text, /동시 실행은 지원하지/); assert(!state.overflow); assert(!state.script);
    }
    const result = await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#agy-check').click();await new Promise(r=>setTimeout(r,30));
      document.querySelector('#agy-save input').value='테스트';document.querySelector('#agy-save').requestSubmit();await new Promise(r=>setTimeout(r,30));
      document.querySelector('.agy-switch').click();await new Promise(r=>setTimeout(r,30));
      return {calls:fixture.calls(),current:document.querySelector('#agy-current').textContent};
    })()`);
    assert.deepEqual(result.calls.map(c => c.action), ['check', 'save', 'activate']);
    assert.equal(result.calls[1].value, '테스트'); assert.equal(result.calls[2].value, 'a'.repeat(32));
    assert.match(result.current, /personal@example.invalid/);
    if (process.env.UI_SCREENSHOT) fs.writeFileSync(process.env.UI_SCREENSHOT, (await win.capturePage()).toPNG());
    console.log('PASS Antigravity Chromium UI: 2 widths, escaping, login check/save/switch routes');
  } finally { win.destroy(); }
}).then(() => app.quit(), e => { console.error(e); app.exit(1); });
