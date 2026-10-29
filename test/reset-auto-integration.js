'use strict';
// End-to-end main/preload/renderer/official-CLI protocol using isolated fake accounts.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const testNode = process.env.RESET_TEST_NODE || require('child_process').execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-auto-integration-'));
process.env.HOME = root; process.env.USERPROFILE = root; process.env.CLI_ACCOUNTS_ROOT = path.join(root,'accounts');
delete process.env.CODEX_HOME; delete process.env.CLAUDE_CONFIG_DIR;
const { app, BrowserWindow } = require('electron');app.setPath('userData',path.join(root,'electron'));
const source=process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname,'..');
const home=path.join(process.env.CLI_ACCOUNTS_ROOT,'codex','fixture');fs.mkdirSync(home,{recursive:true});
const fake=path.join(root,'codex');
process.env.PATH = root + path.delimiter + path.dirname(testNode) + path.delimiter + '/usr/bin:/bin';
const fakeShell=path.join(root,'fixture-shell');
fs.writeFileSync(fakeShell, '#!/bin/sh\nprintf \'%s\\n\' \'' + process.env.PATH.replaceAll("'", "'\\''") + '\'\n', {mode:0o700});
process.env.SHELL=fakeShell;
fs.writeFileSync(fake, `#!${testNode}
const fs=require('fs'),path=require('path'),rl=require('readline');
const file=path.join(__dirname,'server.json');
if(process.argv[2]==='login')process.exit(0);
const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 const state=JSON.parse(fs.readFileSync(file,'utf8'));
 if(m.method==='initialize')return send(m.id,{});
 if(m.method==='account/read')return send(m.id,{account:{type:'chatgpt',email:'fixture@example.invalid'}});
 if(m.method==='account/rateLimits/read')return send(m.id,{rateLimitResetCredits:{availableCount:state.used?0:1,credits:state.used?[]:[{id:'fixture-credit',resetType:'codexRateLimits',status:'available',expiresAt:state.expiry}]},rateLimits:{primary:{usedPercent:state.used?0:95,resetsAt:state.expiry+3600,windowDurationMins:300},secondary:null}});
 if(m.method==='account/rateLimitResetCredit/consume'){
  if(m.params.creditId!=='fixture-credit')throw Error('wrong credit');
  const outcome=state.used?'alreadyRedeemed':'reset';state.used=true;state.calls.push(m.params);fs.writeFileSync(file,JSON.stringify(state));return send(m.id,{outcome});
 }
 throw Error('unexpected method '+m.method);
});
`,{mode:0o700});
fs.symlinkSync(fake,path.join(root,'claude'));
fs.writeFileSync(path.join(root,'server.json'),JSON.stringify({used:false,expiry:Math.floor(Date.now()/1000)+590,calls:[]}));
const claims=Buffer.from(JSON.stringify({email:'fixture@example.invalid','https://api.openai.com/auth':{chatgpt_plan_type:'pro'}})).toString('base64url');
fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{id_token:'x.'+claims+'.x',access_token:'synthetic-fixture-only'}}));
fs.writeFileSync(path.join(process.env.CLI_ACCOUNTS_ROOT,'state.json'),JSON.stringify({version:1,apiFetch:false,claude:{active:'default',profiles:[]},codex:{active:'fixture',profiles:['fixture']},realBin:{codex:fake,claude:fake}}));
require(path.join(source,'src/main.js'));
async function until(fn,message){const end=Date.now()+12000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error(message);}
app.whenReady().then(async()=>{
 await until(()=>BrowserWindow.getAllWindows().length,'window missing');const win=BrowserWindow.getAllWindows()[0];
 await until(()=>win.webContents.executeJavaScript(`Boolean(document.querySelector('#codex .row .more'))`).catch(()=>false),'renderer missing');
 await win.webContents.executeJavaScript(`document.querySelector('#codex .row .more').click();document.querySelector('[role=menuitemcheckbox]').click()`);
 await until(()=>fs.existsSync(path.join(home,'reset-auto-use.jsonl')) && fs.readFileSync(path.join(home,'reset-auto-use.jsonl'),'utf8').includes('"event":"verification"'),'automatic use was not verified');
 const log=fs.readFileSync(path.join(home,'reset-auto-use.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(log.at(-1).resetConfirmed,true);assert.equal(log.at(-1).apiOutcome,'reset');assert(log.at(-1).usedAt);assert.equal(log.at(-1).before.primary.usedPercent,95);assert.equal(log.at(-1).after.primary.usedPercent,0);
 const server=JSON.parse(fs.readFileSync(path.join(root,'server.json')));assert.equal(server.calls.length,1);assert.equal(server.calls[0].creditId,'fixture-credit');
 const state=JSON.parse(fs.readFileSync(path.join(process.env.CLI_ACCOUNTS_ROOT,'state.json')));assert.equal(state.codex.active,'fixture');assert.equal(state.codex.resetCreditAutoUse.fixture.enabled,true);
 await until(()=>win.webContents.executeJavaScript(`document.querySelector('#codex .row').textContent.includes('초기화 확인')`),'UI verification missing');
 const text=await win.webContents.executeJavaScript(`document.querySelector('#codex .row').textContent`);assert(text.includes('0%') && text.includes('0개'));
 await win.webContents.executeJavaScript(`document.querySelector('#codex .row .more').click();document.querySelector('[role=menuitemcheckbox]').click()`);
 await until(()=>JSON.parse(fs.readFileSync(path.join(process.env.CLI_ACCOUNTS_ROOT,'state.json'))).codex.resetCreditAutoUse.fixture.enabled===false,'disable not saved');
 console.log('PASS packaged end-to-end: real UI → IPC → persisted opt-in → pinned fake CLI → specific credit consume → post-read reset/cache/log → opt-out; no real accounts');
 app.isQuitting=true;app.quit();
}).catch(e=>{console.error(e);app.exit(1);});
app.on('will-quit',()=>fs.rmSync(root,{recursive:true,force:true}));
