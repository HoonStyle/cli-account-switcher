'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { createAutoUse, STATE, LOG, redemptionKey, resetObserved } = require(process.argv[2] || '../src/reset-credit-auto-use');
const rpc = require('../src/codex-reset-credits');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-auto-use-test-'));
let checks = 0;
function fixture(label) {
  const home = path.join(root, label); fs.mkdirSync(home);
  let time = Date.parse('2026-10-23T00:00:00Z'), calls = [], reads = 0;
  let creditRows = [{ id: 'credit-A', resetType: 'codexRateLimits', status: 'available', expiresAt: time / 1000 + 600 }];
  let accountKey = 'account-one', used = 85, implementation = null, readImplementation = null;
  let state = { apiFetch: false, codex: { active: 'untouched', profiles: ['work'] } };
  const store = { load: () => structuredClone(state), save: s => { state = structuredClone(s); }, profileHome: () => home };
  const details = () => ({ accountKey, credits: { availableCount: creditRows.length, credits: structuredClone(creditRows) }, rateLimits: { primary: { usedPercent: used, resetsAt: time / 1000 + 3600, windowDurationMins: 300 }, secondary: null } });
  const options = { now: () => time, recordDetails: rpc.recordDetails, readDetails: async () => { reads++; return readImplementation ? readImplementation() : details(); }, consume: async (h, params, opts) => {
    assert.equal(h, home); assert.equal(opts.expectedAccountKey, accountKey); assert.equal(opts.beforeSend(), true);
    calls.push(params);
    if (implementation) return implementation(params);
    used = 0; creditRows = []; return 'reset';
  }};
  let service = createAutoUse(store, options);
  return { home, store, details, options, get service() { return service; }, restart() { service = createAutoUse(store, options); }, get calls() { return calls; }, get reads() { return reads; },
    time: t => { time += t; }, setRows: r => { creditRows = r; }, rows: () => creditRows, setUsed: u => { used = u; }, setAccount: k => { accountKey = k; }, consume: fn => { implementation = fn; }, read: fn => { readImplementation = fn; },
    log: () => fs.existsSync(path.join(home, LOG)) ? fs.readFileSync(path.join(home, LOG), 'utf8').trim().split('\n').map(JSON.parse) : [],
    state: () => JSON.parse(fs.readFileSync(path.join(home, STATE), 'utf8')) };
}
async function test(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
(async () => {
  await test('default off: no network calls, no active-account changes', async () => {
    const f = fixture('off'); await f.service.tick(true); assert.equal(f.reads, 0); assert.equal(f.service.summary('work').enabled, false); assert.equal(f.store.load().codex.active, 'untouched');
  });
  await test('exact 10-minute boundary, API-fetch independent, verified timestamps and log', async () => {
    const f = fixture('boundary'); f.setRows([{ ...f.rows()[0], expiresAt: f.rows()[0].expiresAt + 1 }]);
    await f.service.setEnabled('work', true); assert.equal(f.calls.length, 0);
    f.time(1000); await f.service.tick(true); assert.equal(f.calls.length, 1);
    const log = f.log(); assert.deepEqual(log.map(l => l.event), ['attempt','result','verification']);
    assert.equal(log[2].resetConfirmed, true); assert.equal(log[2].before.primary.usedPercent, 85); assert.equal(log[2].after.primary.usedPercent, 0);
    assert(log[2].usedAt && log[2].verifiedAt); assert.equal(f.store.load().codex.active, 'untouched');
    assert(!JSON.stringify(log).includes('credit-A'), 'opaque ID excluded from human logs');
    assert(!fs.readFileSync(path.join(f.home,rpc.CACHE),'utf8').includes('credit-A'));
    f.restart(); await f.service.tick(true); assert.equal(f.calls.length, 1, 'no repeat after restart');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.home,LOG)).mode & 0o777, 0o600);
  });
  await test('expired, missing expiry, unsupported type/status and unknown counts never fall back to another credit', async () => {
    const f = fixture('invalid'); const c = f.rows()[0]; f.setRows([{...c,expiresAt:c.expiresAt-600}, {...c,id:'none',expiresAt:null}, {...c,id:'redeemed',status:'redeemed'}, {...c,id:'other',resetType:'other'}, {...c,id:'later',expiresAt:c.expiresAt+4000}]);
    await f.service.setEnabled('work',true); assert.equal(f.calls.length,0);
  });
  await test('earliest expiring credit only, expired record cannot target an unexpired replacement', async () => {
    const f=fixture('earliest'), c=f.rows()[0]; f.setRows([{...c,id:'later',expiresAt:c.expiresAt+100}, {...c,id:'first',expiresAt:c.expiresAt-100}]);
    await f.service.setEnabled('work',true); assert.deepEqual(f.calls.map(c=>c.creditId),['first']);
  });
  await test('timeout after server consumption survives restart and absent available-credit row', async () => {
    const f=fixture('timeout');let first=true;
    f.consume(()=>{ if(first){first=false;f.setRows([]);f.setUsed(0);throw Error('private token');}return 'alreadyRedeemed'; });
    await f.service.setEnabled('work',true); f.restart(); f.time(61000); await f.service.tick();
    assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);
    const last=f.log().at(-1);assert.equal(last.apiOutcome,'alreadyRedeemed');assert.equal(last.usedAt,null);assert(last.acknowledgedAt);assert.equal(last.resetConfirmed,true);
    assert(!JSON.stringify(f.log()).includes('private token'));
  });
  await test('two independent devices: same credit ID/key, server consumes once', async () => {
    const a=fixture('device-one'),b=fixture('device-two');let consumed=0;const seen=new Set();
    const server=p=>{if(seen.has(p.idempotencyKey))return 'alreadyRedeemed';seen.add(p.idempotencyKey);consumed++;return 'reset';};
    a.consume(server);b.consume(server);
    await Promise.all([a.service.setEnabled('work',true),b.service.setEnabled('work',true)]);
    assert.equal(consumed,1);assert.equal(a.calls[0].idempotencyKey,b.calls[0].idempotencyKey);
    const results=[a.log().at(-1),b.log().at(-1)];
    assert.deepEqual(results.map(r=>r.apiOutcome).sort(),['alreadyRedeemed','reset']);
    assert.equal(results.find(r=>r.apiOutcome==='alreadyRedeemed').usedAt,null);
    assert(results.every(r=>r.resetConfirmed===false),'unchanged windows not mislabeled as verified reset');
  });
  await test('same-home concurrent workers use an interprocess-compatible lock', async () => {
    const f=fixture('lock');let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
    f.consume(async()=>{enter();await gate;f.setRows([]);return 'reset';});
    const first=f.service.setEnabled('work',true);await entered;
    const other=createAutoUse(f.store,f.options);await other.tick(true);assert.equal(f.calls.length,1);release();await first;
  });
  await test('nothingToReset is logged as not reset and rechecked without changing logical key', async () => {
    const f=fixture('nothing');f.consume(()=> 'nothingToReset');await f.service.setEnabled('work',true);
    assert.equal(f.log().at(-1).resetConfirmed,false);assert.equal(f.log().at(-1).usedAt,null);
    f.time(61000);await f.service.tick();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);
    await f.service.setEnabled('work',false);await f.service.tick(true);assert.equal(f.calls.length,2);
  });
  await test('one-minute spacing and three total requests survive forced checks, restart and opt-in', async () => {
    const f=fixture('limit');f.consume(()=> 'nothingToReset');await f.service.setEnabled('work',true);
    f.time(59999);f.restart();await f.service.tick(true);assert.equal(f.calls.length,1);
    await f.service.setEnabled('work',false);await f.service.setEnabled('work',true);assert.equal(f.calls.length,1);
    f.time(1);await f.service.tick(true);assert.equal(f.calls.length,2);
    f.time(59999);await f.service.tick(true);assert.equal(f.calls.length,2);
    f.time(1);await f.service.tick(true);assert.equal(f.calls.length,3);
    f.restart();f.time(60000);await f.service.tick(true);
    await f.service.setEnabled('work',false);await f.service.setEnabled('work',true);
    assert.equal(f.calls.length,3);assert(f.calls.every(c=>JSON.stringify(c)===JSON.stringify(f.calls[0])));
    const attempts=f.log().filter(e=>e.event==='attempt');assert.deepEqual(attempts.map(e=>e.attemptCount),[1,2,3]);
    assert.equal(Date.parse(attempts[1].requestedAt)-Date.parse(attempts[0].requestedAt),60000);
    assert.equal(Date.parse(attempts[2].requestedAt)-Date.parse(attempts[1].requestedAt),60000);
    assert.equal(f.log().filter(e=>e.event==='stopped').length,1);assert.equal(f.log().at(-1).resetConfirmed,false);
    assert.equal(f.service.summary('work').status,'stopped');
  });
  await test('lost responses stop at three even after expiry; unknown is not mislabeled as failure', async () => {
    const f=fixture('unknown-limit'),c=f.rows()[0];
    f.consume(()=>{f.setRows([{...c,id:'later',expiresAt:c.expiresAt+4000}]);throw Error('lost response');});
    await f.service.setEnabled('work',true);
    for(let i=0;i<2;i++){f.time(60000);f.restart();await f.service.tick(true);}
    f.time(600000);f.restart();await f.service.tick(true);assert.equal(f.calls.length,3);
    assert(f.calls.every(c=>c.creditId==='credit-A'));
    const last=f.service.summary('work').lastResult;assert.equal(last.reason,'attemptLimit');assert.equal(last.apiOutcome,'unknown');assert.equal(last.resetConfirmed,null);
  });
  await test('legacy logs retain both count and latest request time on upgrade', async () => {
    const f=fixture('legacy');f.consume(()=> 'nothingToReset');await f.service.setEnabled('work',true);
    f.time(60000);await f.service.tick(true);
    const state=f.state();for(const attempt of Object.values(state.attempts)){delete attempt.attemptCount;delete attempt.nextAttemptAt;}
    fs.writeFileSync(path.join(f.home,STATE),JSON.stringify(state));
    f.restart();f.time(59999);await f.service.tick(true);assert.equal(f.calls.length,2);
    f.time(1);await f.service.tick(true);assert.equal(f.calls.length,3);
    f.time(60000);f.restart();await f.service.tick(true);assert.equal(f.calls.length,3);
  });
  await test('legacy credit already requested eleven times gets no fresh budget', async () => {
    const f=fixture('legacy-exhausted');f.consume(()=> 'nothingToReset');await f.service.setEnabled('work',true);
    const state=f.state(),entry=f.log().find(e=>e.event==='attempt');
    for(const attempt of Object.values(state.attempts)){delete attempt.attemptCount;delete attempt.nextAttemptAt;}
    fs.writeFileSync(path.join(f.home,STATE),JSON.stringify(state));
    fs.writeFileSync(path.join(f.home,LOG),Array.from({length:11},()=>JSON.stringify(entry)+'\n').join(''));
    f.restart();f.time(60000);await f.service.tick(true);assert.equal(f.calls.length,1);
    assert.equal(f.service.summary('work').lastResult.attemptCount,11);
  });
  await test('durable reservation blocks fourth request even if audit append was interrupted', async () => {
    const f=fixture('reserved');f.consume(()=>{throw Error('offline');});await f.service.setEnabled('work',true);
    const state=f.state();Object.values(state.attempts)[0].attemptCount=3;fs.writeFileSync(path.join(f.home,STATE),JSON.stringify(state));
    fs.writeFileSync(path.join(f.home,LOG),'');f.restart();f.time(60000);await f.service.tick(true);assert.equal(f.calls.length,1);
  });
  await test('success on third request still verifies later without another consume', async () => {
    const f=fixture('third-success');let n=0;
    f.consume(()=>{if(++n<3)return 'nothingToReset';f.setRows([]);f.setUsed(0);f.read(()=>{throw Error('offline');});return 'reset';});
    await f.service.setEnabled('work',true);
    for(let i=0;i<2;i++){f.time(60000);await f.service.tick(true);}
    assert.equal(f.calls.length,3);assert.equal(f.log().at(-1).resetConfirmed,null);
    f.read(null);f.restart();f.time(31000);await f.service.tick();assert.equal(f.calls.length,3);
    assert.equal(f.log().at(-1).resetConfirmed,true);assert.equal(f.log().filter(e=>e.event==='stopped').length,0);
  });
  await test('concurrent workers cannot reserve a fourth request', async () => {
    const f=fixture('concurrent-limit');f.consume(()=> 'nothingToReset');await f.service.setEnabled('work',true);
    f.time(60000);await f.service.tick(true);f.time(60000);
    let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
    f.consume(async()=>{enter();await gate;return 'nothingToReset';});
    const third=f.service.tick(true);await entered;
    const other=createAutoUse(f.store,f.options);await other.tick(true);release();await third;
    f.time(60000);await other.tick(true);assert.equal(f.calls.length,3);
  });
  await test('successful consume plus failed read logs unverified, later verifies without spending again', async () => {
    const f=fixture('verify');f.consume(()=>{f.setRows([]);f.setUsed(0);f.read(()=>{throw Error('offline');});return 'reset';});
    await f.service.setEnabled('work',true);assert.equal(f.log().at(-1).resetConfirmed,null);
    f.read(null);f.time(31000);await f.service.tick();assert.equal(f.calls.length,1);assert.equal(f.log().at(-1).resetConfirmed,true);
  });
  await test('changed login disables the option; off during network read fences consumption', async () => {
    const f=fixture('identity');f.setRows([]);await f.service.setEnabled('work',true);f.setAccount('account-two');await f.service.tick(true);
    assert.equal(f.service.summary('work').enabled,false);assert.equal(f.calls.length,0);
    const g=fixture('off-race');g.setRows([]);await g.service.setEnabled('work',true);
    g.setRows([{id:'new',resetType:'codexRateLimits',status:'available',expiresAt:Date.parse('2026-10-23T00:09:00Z')/1000}]);
    let release,enter;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r);g.read(async()=>{enter();await gate;return g.details();});
    const p=g.service.tick(true);await entered;await g.service.setEnabled('work',false);release();await p;assert.equal(g.calls.length,0);
  });
  await test('disable wins over an earlier in-flight enable', async () => {
    const f=fixture('enable-race');let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
    f.read(async()=>{enter();await gate;return f.details();});
    const pending=f.service.setEnabled('work',true);await entered;await f.service.setEnabled('work',false);release();await pending;
    assert.equal(f.service.summary('work').enabled,false);assert.equal(f.calls.length,0);
  });
  await test('startup/resume checks and shutdown stop timers; sleeping past expiry does not spend', async () => {
    const f=fixture('resume');f.setRows([]);await f.service.setEnabled('work',true);
    let callback,cleared=false;const monitor=new EventEmitter();const stop=f.service.start({setInterval:fn=>(callback=fn,1),clearInterval:()=>{cleared=true;}},monitor);
    assert.equal(monitor.listenerCount('resume'),1);await f.service.tick(true);f.time(3600000);monitor.emit('resume');stop();assert(cleared);assert.equal(monitor.listenerCount('resume'),0);await callback();assert.equal(f.calls.length,0);
  });
  await test('official RPC validates account, specific ID and last-moment opt-out; no raw secrets leak', async () => {
    let sent=[];const opts={expectedAccountKey:require('crypto').createHash('sha256').update(JSON.stringify(['test@example.invalid',null])).digest('hex'),beforeSend:()=>true,
      bindingFor:()=>({tool:'codex',profileId:'work',home:root,executable:'/fixture/codex'}),spawn:(exe,args,options)=>{
        assert.equal(options.env.CODEX_HOME,root);const p=new EventEmitter();p.stdout=new EventEmitter();p.stdin=new EventEmitter();p.stdin.end=()=>{};p.kill=()=>{};
        p.stdin.write=text=>{const m=JSON.parse(text);sent.push(m);if(m.id)setImmediate(()=>p.stdout.emit('data',Buffer.from(JSON.stringify({id:m.id,result:m.id===2?{account:{type:'chatgpt',email:'test@example.invalid'}}:m.id===3?{outcome:'reset'}:{}})+'\n')));};return p;
      }};
    assert.equal(await rpc.consume(root,{creditId:'specific',idempotencyKey:'test'},opts),'reset');assert.equal(sent.at(-1).params.creditId,'specific');
    sent=[];await assert.rejects(rpc.consume(root,{creditId:'specific',idempotencyKey:'test'},{...opts,beforeSend:()=>false}));assert(!sent.some(m=>m.method.endsWith('/consume')));
    sent=[];await assert.rejects(rpc.consume(root,{creditId:'specific',idempotencyKey:'test'},{...opts,expectedAccountKey:'changed'}));assert(!sent.some(m=>m.method.endsWith('/consume')));
  });
  assert.equal(resetObserved({},{}),null);assert.match(redemptionKey('a'),/^[a-f0-9-]{36}$/);
  console.log(`PASS ${checks} auto-use regression scenarios (synthetic accounts only)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
