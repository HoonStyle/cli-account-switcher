'use strict';
// API key controls in the account panel. Fixture IPC only; no real keys or CLIs.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-keys-ui-'));
app.setPath('userData', tmp);
const preload = path.join(tmp, 'preload.js');
fs.writeFileSync(preload, `
const {contextBridge}=require('electron');
const calls=[];
const prof=(name,extra={})=>({name,label:name,isDefault:name==='default',loggedIn:false,email:null,plan:null,usage:null,apiKey:{apiKey:false,masked:null},...extra});
const state={pathStatus:{first:true},usageMode:'used',density:'compact',
  tools:{claude:{active:'default',profiles:[prof('default',{loggedIn:true,email:'sub@example.invalid',plan:'Max'}),prof('api',{loggedIn:true,apiKey:{apiKey:true,masked:'…1234'}})]},
         codex:{active:'default',profiles:[prof('default'),prof('worker')]}},
  antigravity:{accounts:[]}};
contextBridge.exposeInMainWorld('api',{state:async()=>JSON.parse(JSON.stringify(state)),onState:()=>{},resize:()=>{},antigravity:async()=>state.antigravity,
  setActive:async(t,n)=>{calls.push({m:'setActive',t,n})},
  addProfile:async(t,n)=>{calls.push({m:'addProfile',t,n});state.tools[t].profiles.push(prof(n));return {id:n}},
  login:async(t,n)=>{calls.push({m:'login',t,n})},
  setApiKey:async(t,n,k)=>{calls.push({m:'setApiKey',t,n,k});const p=state.tools[t].profiles.find(p=>p.name===n);p.apiKey={apiKey:true,masked:t==='claude'?'…'+k.slice(-4):null};return n+': API 키 등록됨'},
  removeApiKey:async(t,n)=>{calls.push({m:'removeApiKey',t,n});state.tools[t].profiles.find(p=>p.name===n).apiKey={apiKey:false,masked:null};return n+': API 키 제거됨'},
});
contextBridge.exposeInMainWorld('fixture',{calls:()=>calls});
`);
const KEY = 'sk-ant-fake-ui-key-00000000009876';
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 440, height: 900, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { if (process.env.UI_SCREENSHOT_DIR) fs.writeFileSync(path.join(process.env.UI_SCREENSHOT_DIR, name), (await win.capturePage()).toPNG()); };
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    await js('new Promise(r=>setTimeout(r,100))');
    const initial = await js(`({api:document.querySelector('#claude .row[data-name="api"]').textContent,worker:!!document.querySelector('#codex .row[data-name="worker"] .keyset'),overflow:document.documentElement.scrollWidth>innerWidth})`);
    assert.match(initial.api, /API 키 …1234/); assert(initial.worker); assert(!initial.overflow);
    await shot('api-keys-initial.png');

    // Row button → inline password entry → setApiKey; typing in it never switches account.
    const set = await js(`(async()=>{
      const row=()=>document.querySelector('#codex .row[data-name="worker"]');
      row().querySelector('.keyset').click();await new Promise(r=>setTimeout(r,20));
      const input=row().querySelector('.keyentry input');const type=input.type;input.click();
      input.value='sk-fake-codex-ui-key-0000005678';
      return {type,before:fixture.calls().length};
    })()`);
    assert.equal(set.type, 'text'); assert.equal(set.before, 0, 'clicking the key field must not switch accounts');
    await shot('api-keys-entry.png');
    await js(`(async()=>{document.querySelector('#codex .row[data-name="worker"] .keyentry').requestSubmit();await new Promise(r=>setTimeout(r,50));})()`);
    const afterSet = await js(`({calls:fixture.calls(),entry:!!document.querySelector('.keyentry'),text:document.querySelector('#codex .row[data-name="worker"]').textContent,html:document.body.innerHTML.includes('sk-fake-codex-ui-key')})`);
    assert.deepEqual(afterSet.calls, [{ m: 'setApiKey', t: 'codex', n: 'worker', k: 'sk-fake-codex-ui-key-0000005678' }]);
    assert(!afterSet.entry); assert.match(afterSet.text, /API 키/); assert(!afterSet.html, 'key must not remain in the DOM');

    // Add form "API 키로 추가" → addProfile without login, then key entry on the new row.
    await js(`(async()=>{
      const add=document.querySelector('#claude .addrow');add.querySelector('.link').click();
      add.querySelector('input:not([type=checkbox])').value='newkey';add.querySelector('.addkey').click();
      await new Promise(r=>setTimeout(r,50));
    })()`);
    await shot('api-keys-add.png');
    await js(`(async()=>{const f=document.querySelector('#claude .row[data-name="newkey"] .keyentry');f.querySelector('input').value=${JSON.stringify(KEY)};f.requestSubmit();await new Promise(r=>setTimeout(r,50));})()`);
    const added = await js(`({calls:fixture.calls().slice(1),text:document.querySelector('#claude .row[data-name="newkey"]').textContent})`);
    assert.deepEqual(added.calls.map(c => c.m), ['addProfile', 'setApiKey']);
    assert.equal(added.calls[1].k, KEY); assert.match(added.text, /API 키 …9876/);

    // Menu → remove.
    await js(`(async()=>{document.querySelector('#claude .row[data-name="api"] .more').click();await new Promise(r=>setTimeout(r,20));
      [...document.querySelectorAll('.menu button')].find(b=>b.textContent==='API 키 제거').click();await new Promise(r=>setTimeout(r,50));})()`);
    const removed = await js(`({last:fixture.calls().at(-1),text:document.querySelector('#claude .row[data-name="api"]').textContent})`);
    assert.deepEqual(removed.last, { m: 'removeApiKey', t: 'claude', n: 'api' });
    win.setSize(360, 900); await js('new Promise(r=>setTimeout(r,50))');
    assert(!(await js('document.documentElement.scrollWidth>innerWidth')));
    await shot('api-keys-narrow.png');
    console.log('PASS API key UI: row entry, add-with-key, menu remove, no key left in DOM, 2 widths');
  } finally { win.destroy(); }
}).then(() => app.quit(), e => { console.error(e); app.exit(1); });
