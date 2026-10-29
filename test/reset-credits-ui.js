'use strict';
// Real Chromium layout and interactions with synthetic account data only.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-credits-ui-'));
app.setPath('userData', tmp);
const preload = path.join(tmp, 'preload.js');
fs.writeFileSync(preload, `
const {contextBridge}=require('electron');
const now=new Date().toISOString();
const cases=[{availableCount:2,status:'available',capturedAt:now,nearestExpiry:'2026-10-22T20:54:03.000Z'},
 {availableCount:0,status:'available',capturedAt:now},
 {availableCount:null,status:'unqueried'},
 {availableCount:2,status:'error',stale:true,capturedAt:now},
 {availableCount:null,status:'unavailable'}];
const state={density:'compact',usageMode:'remaining',directUsageApi:true,pathStatus:{first:true},apiMeta:{},tools:{
 claude:{active:'claude',profiles:[{name:'claude',label:'Claude',loggedIn:true,plan:'Max'}]},
 codex:{active:'account0',profiles:cases.map((r,i)=>({name:'account'+i,label:['개인','업무','보조','이전 값','미제공'][i],loggedIn:true,plan:'Pro',usage:{capturedAt:now,primary:{usedPercent:25,windowMinutes:300},secondary:{usedPercent:60,windowMinutes:10080}},credits:{balance:'62500',capturedAt:now},resetCredits:r,resetAutoUse:{enabled:i===0,status:i===0?'waiting':'off',text:i===0?'만료 10분 전 자동 사용 대기':'',lastResult:i===0?{usedAt:now,resetConfirmed:true}:null}}))}}};
let notify, selected=0, toggled=[],logs=[];
contextBridge.exposeInMainWorld('api',{state:async()=>state,onState:fn=>notify=fn,resize:()=>{},setActive:async()=>{selected++;return state;},apiRefreshOne:async()=>'조회했습니다',setResetAutoUse:async(name,on)=>{toggled.push([name,on]);state.tools.codex.profiles.find(p=>p.name===name).resetAutoUse.enabled=on;return '설정 저장';},openResetAutoUseLog:async name=>{logs.push(name);return '로그 파일';}});
contextBridge.exposeInMainWorld('fixture',{density:d=>{state.density=d;notify(state);},selected:()=>selected,toggled:()=>toggled,logs:()=>logs});
`);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:440,height:900,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 try {
  await win.loadFile(path.resolve(__dirname,'../src/renderer/index.html'));
  await win.webContents.executeJavaScript(`new Promise(r=>setTimeout(r,80))`);
  for(const width of [440,360])for(const density of ['compact','comfortable']){
   win.setSize(width,900);
   const result=await win.webContents.executeJavaScript(`(()=>{
    fixture.density(${JSON.stringify(density)});
    const rows=[...document.querySelectorAll('#codex .row')];
    const texts=rows.map(r=>r.querySelector('.reset-credits').textContent);
    const overflow=[...document.querySelectorAll('.resources,.resource')].some(el=>el.scrollWidth>el.clientWidth+1);
    return {texts,overflow,descriptions:rows.every(r=>document.getElementById(r.getAttribute('aria-describedby'))),pageOverflow:document.documentElement.scrollWidth>innerWidth};
   })()`);
   assert.match(result.texts[0],/2개/); assert.match(result.texts[1],/0개/);
   assert.match(result.texts[2],/미조회/); assert(!result.texts[2].includes('0개'));
   assert.match(result.texts[3],/이전 값.*조회 실패/); assert.match(result.texts[4],/미제공/);
   assert(result.descriptions); assert(!result.overflow, `${width} ${density}: resources overflow`);
   assert(!result.pageOverflow,`${width} ${density}: page overflow`);
  }
  win.setSize(440,900);
  const interaction=await win.webContents.executeJavaScript(`(async()=>{
   fixture.density('compact');
   const row=document.querySelectorAll('#codex .row')[1],button=row.querySelector('.more');
   button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));button.click();
   const labels=[...document.querySelectorAll('.menu button')].map(b=>b.textContent);
   return {labels,selected:fixture.selected()};
  })()`);
  assert(interaction.labels.includes('사용량 · 크레딧 · 리셋권 조회'));
  assert(interaction.labels.includes('만료 10분 전 리셋권 자동 사용'));
  assert(interaction.labels.includes('리셋권 자동 사용 로그 파일 보기'));
  assert.equal(interaction.selected,0,'opening resource refresh must not switch account');
  const toggles=await win.webContents.executeJavaScript(`(async()=>{
   const checkbox=document.querySelector('.menu [role=menuitemcheckbox]');
   const before=checkbox.getAttribute('aria-checked');checkbox.click();
   await new Promise(r=>setTimeout(r,40));
   document.querySelectorAll('#codex .row')[1].querySelector('.more').click();
   const after=document.querySelector('.menu [role=menuitemcheckbox]').getAttribute('aria-checked');
   [...document.querySelectorAll('.menu button')].find(b=>b.textContent.includes('로그 파일')).click();
   await new Promise(r=>setTimeout(r,40));
   return {before,after,toggled:fixture.toggled(),logs:fixture.logs(),selected:fixture.selected(),text:document.querySelector('#codex .row').textContent};
  })()`);
  assert.equal(toggles.before,'false');assert.equal(toggles.after,'true');
  assert.deepEqual(toggles.toggled,[['account1',true]]);assert.deepEqual(toggles.logs,['account1']);assert.equal(toggles.selected,0);
  assert.match(toggles.text,/최근 사용.*초기화 확인/);
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  if(process.env.UI_SCREENSHOT) fs.writeFileSync(process.env.UI_SCREENSHOT,(await win.capturePage()).toPNG());
  console.log('PASS: reset-credit UI known/zero/unknown/error/unsupported, accessible descriptions, 2 widths × 2 densities, refresh action isolation');
 }finally{win.destroy();}
}).then(()=>app.quit(),e=>{console.error(e);app.exit(1);});
