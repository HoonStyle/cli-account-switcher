'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
const {spawn,spawnSync}=require('child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'service-test-'));
process.env.HOME=path.join(tmp,'home');process.env.CLI_ACCOUNTS_ROOT=path.join(tmp,'accounts');process.env.CLI_ACCOUNTS_NO_NOTIFICATIONS='1';fs.mkdirSync(process.env.HOME);
const {request,dir,socket}=require('../src/runtime/client');
const service=path.resolve(__dirname,'../src/runtime/service.js');let child;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){child=spawn(process.execPath,[service],{env:process.env,stdio:'ignore'});for(let i=0;i<100;i++){try{const h=await request('health');if(h.pid===child.pid)return h;}catch{}await sleep(30);}throw new Error('Service unavailable');}
async function stop(signal){const c=child;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Service stop timeout')),5000);c.once('exit',()=>{clearTimeout(timer);resolve();});c.kill(signal);});child=null;}
(async()=>{try{
 const first=await start();assert.equal(first.status,'ok');assert.deepEqual(await request('list'),[]);
 if(process.platform!=='win32')assert.equal(fs.statSync(socket).mode&0o777,0o600);
 const duplicate=spawnSync(process.execPath,[service],{env:process.env,encoding:'utf8',timeout:5000});
 assert.equal(duplicate.status,1);assert.match(duplicate.stderr,/occupied/);assert.equal((await request('health')).pid,first.pid);
 await assert.rejects(request('unsupported'),/Unknown task method/);
 console.log('PASS real service socket, private mode, singleton and unknown-method rejection');
 await stop('SIGKILL');assert(fs.existsSync(path.join(dir,'service.lock')));
 const second=await start();assert.notEqual(second.pid,first.pid);assert.deepEqual(await request('list'),[]);
 await stop('SIGTERM');assert(!fs.existsSync(path.join(dir,'service.lock')));
 console.log('PASS process crash/stale-lock restart and graceful lock cleanup');
}finally{if(child){try{await stop('SIGKILL');}catch{}}}
})().catch(e=>{console.error(e);process.exitCode=1;});
