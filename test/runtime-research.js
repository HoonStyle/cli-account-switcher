'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { normalizeExecutionPolicy, executionEnv } = require('../src/runtime/execution-policy');
const { fetchPublic } = require('../src/runtime/research-mcp');
const { files, verifyNativeClosure } = require('../src/runtime/research-snapshot');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'research-contract-')));
function write(file, data, mode = 0o600) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode }); }
function writable(root) { if (!fs.existsSync(root)) return; const st = fs.lstatSync(root); if (st.isSymbolicLink()) return; fs.chmodSync(root, st.isDirectory() ? 0o700 : 0o600); if (st.isDirectory()) for (const name of fs.readdirSync(root)) writable(path.join(root, name)); }
function portablePython() {
  if (process.env.SWITCHER_TEST_PYTHON) return fs.realpathSync(process.env.SWITCHER_TEST_PYTHON);
  const installed = process.env.UV_PYTHON_INSTALL_DIR || path.join(os.homedir(), '.local/share/uv/python');
  if (fs.existsSync(installed)) for (const name of fs.readdirSync(installed).sort()) {
    const bin = path.join(installed, name, 'bin');
    if (!name.startsWith('cpython-3.') || !fs.existsSync(bin)) continue;
    const executable = fs.readdirSync(bin).find(x => /^python3\.\d+$/.test(x));
    if (executable) return fs.realpathSync(path.join(bin, executable));
  }
  throw Error('Set SWITCHER_TEST_PYTHON to a relocatable macOS Python for hermetic research fixtures');
}
(async () => { let client; try {
  assert.equal(normalizeExecutionPolicy('read-only', 'web-research'), 'web-research');
  assert.throws(() => normalizeExecutionPolicy('workspace-write', 'web-research'), { code: 'POLICY_INCOMPATIBLE' });
  if (process.platform !== 'darwin') {
    assert.throws(() => require('../src/runtime/research-policy').preflightResearch({ binding: { tool: 'claude' } }), { code: 'CAPABILITY_MISSING' });
    console.log('PASS unsupported-platform research refusal; SKIP macOS relocation/MCP fixture tests'); return;
  }
  // Run from an isolated copy so simulated normal helper updates cannot mutate
  // the repository's helper while another test/attempt is using it.
  const app = path.join(tmp, 'app');
  fs.cpSync(path.join(__dirname, '../src'), path.join(app, 'src'), { recursive: true });
  const { preflightResearch, validateResearchInvocation, FLAGS } = require(path.join(app, 'src/runtime/research-policy'));
  const { buildInvocation } = require(path.join(app, 'src/adapters/cli'));
  const home = path.join(tmp, 'profile'), root = path.join(home, 'skills/insane-search');
  const executable = path.join(tmp, 'claude');
  const spawnMarker = path.join(tmp, 'provider-spawns');
  const cliWithFlags = flags => `#!${process.execPath}\nconst fs=require('fs');const arg=process.argv[2];if(arg==='--version')console.log('2.1.290');else if(arg==='--help')console.log(${JSON.stringify(flags.join(' '))});else{fs.appendFileSync(${JSON.stringify(spawnMarker)},'provider\\n');process.exitCode=79;}\n`;
  const cli = cliWithFlags(FLAGS);
  write(executable, cli, 0o700);
  const binding = { tool: 'claude', profileId: 'fixture', executable, home, model: 'sonnet' };
  assert.throws(() => preflightResearch({ binding }), { code: 'CAPABILITY_MISSING' });
  assert.throws(() => preflightResearch({ binding: { ...binding, tool: 'codex' } }), { code: 'POLICY_INCOMPATIBLE' });
  const python = portablePython();
  const version = execFileSync(python, ['-I', '-S', '-c', 'import sys;print("%s.%s" % sys.version_info[:2])'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(root, '.venv/bin'), { recursive: true }); fs.symlinkSync(python, path.join(root, '.venv/bin/python'));
  write(path.join(root, 'SKILL.md'), 'fixture only');
  write(path.join(root, 'engine/__init__.py'), '');
  write(path.join(root, 'engine/safety.py'), 'def classify_url(url):\n    return (not "127.0.0.1" in url, "fixture")\n');
  write(path.join(root, 'engine/transport.py'), 'def pool_enabled():\n    return False\n');
  const deps = path.join(root, '.venv/lib', 'python' + version, 'site-packages');
  const fakeTransport = `from . import requests\nclass CurlOpt:\n    RESOLVE = 10203\n    PROXY = 10004\n`;
  write(path.join(deps, 'curl_cffi/__init__.py'), fakeTransport);
  write(path.join(deps, 'curl_cffi/requests.py'), `calls = 0\nclass Session:\n    def request(self, method, url, **kwargs):\n        global calls\n        calls += 1\n        return {'transport': 'A', 'resolved': [v.decode() for v in self.curl_options[10203]], 'proxy': self.curl_options[10004].decode(), 'automaticRedirects': kwargs['allow_redirects']}\n`);
  const engineCode = `import sys, json, os, socket\nfrom curl_cffi import requests\nurl = sys.argv[1]\nif 'dns-failure' in url:\n    def resolver(*a, **k): raise socket.gaierror('fixture')\nelse:\n    def resolver(*a, **k): return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]\nsocket.getaddrinfo = resolver\ntry:\n    response = requests.Session().request('GET', url)\n    if 'redirect-private' in url: response = requests.Session().request('GET', 'http://169.254.169.254/')\n    result = {'engine': 'A', 'verdict': 'weak_ok', 'response': response, 'credentialPresent': bool(os.getenv('GITHUB_TOKEN')), 'argv': sys.argv[1:], 'calls': requests.calls}\nexcept Exception as error:\n    result = {'blocked': type(error).__name__, 'calls': requests.calls}\nprint(json.dumps(result))\n`;
  write(path.join(root, 'engine/__main__.py'), engineCode);
  const cap = preflightResearch({ binding });
  assert.equal(cap.nativeWebTools, 'not_live_verified'); assert.equal(cap.declaredTools.includes('Read'), false);
  assert.equal(cap.accountBindingRef.length, 64); assert.equal(cap.fingerprint.length, 64);
  assert(!JSON.stringify(cap).includes('GITHUB_TOKEN'));
  const attempt = path.join(tmp, 'attempt'); fs.mkdirSync(attempt);
  const inv = buildInvocation({ binding, role: 'child', permission: 'read-only', executionPolicy: 'web-research', dir: attempt, capabilitySnapshot: cap });
  validateResearchInvocation(binding, inv);
  assert(!inv.args.includes('--safe-mode')); assert(inv.args.includes('--restricted')); assert(inv.args.includes('--disable-slash-commands'));
  assert.equal(inv.args[inv.args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  const settings = JSON.parse(fs.readFileSync(inv.researchSnapshot.settingsFile));
  for (const denied of ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'Agent', 'Task']) assert(settings.permissions.deny.includes(denied));
  const env = executionEnv(inv, { HOME: 'native-home', CLAUDE_CONFIG_DIR: 'selected-profile', GITHUB_TOKEN: 'never-propagate', NODE_OPTIONS: '--untrusted', CLAUDE_CODE_SAFE_MODE: '1' });
  assert.equal(env.HOME, 'native-home'); assert.equal(env.CLAUDE_CONFIG_DIR, 'selected-profile');
  for (const key of ['GITHUB_TOKEN', 'NODE_OPTIONS', 'CLAUDE_CODE_SAFE_MODE']) assert(!Object.hasOwn(env, key));
  const cfg = JSON.parse(fs.readFileSync(inv.researchSnapshot.mcpFile)).mcpServers.switcher_research;
  assert(cfg.command.startsWith(inv.researchSnapshot.path)); assert(cfg.args[0].startsWith(inv.researchSnapshot.path));
  assert(files(inv.researchSnapshot.path).every(f => !fs.lstatSync(f.file).isSymbolicLink()));
  // T21/T22 must cross the real Engine and real runner process, not only call
  // their validators. Every executable below is a local fixture; provider mode
  // appends a durable marker and exits without model/network work.
  const previousAccountsRoot = process.env.CLI_ACCOUNTS_ROOT;
  process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'engine-accounts');
  const store = require(path.join(app, 'src/store'));
  for (const id of ['fixture', 'second']) {
    const configured = store.profileHome('claude', id); fs.mkdirSync(path.dirname(configured), { recursive: true }); fs.symlinkSync(home, configured);
  }
  const state = store.load(); state.claude = { active: 'fixture', profiles: ['default', 'fixture', 'second'] }; state.realBin.claude = executable; store.save(state);
  const { Engine } = require(path.join(app, 'src/runtime/engine'));
  const project = path.join(tmp, 'project'); fs.mkdirSync(project);
  const engine = new Engine(path.join(tmp, 'engine-ledger'));
  const owner = {agentId:'fixture',sessionKey:'agent:fixture:research',sessionId:'session-1',lifecycleRevision:'epoch-1',deliveryTarget:{channel:'discord',accountId:'fixture',to:'channel:fixture'}};
  const link = engine.bindOpenClaw(owner);
  let request = 0;
  const submit = () => engine.submit({ requestId:`research-${++request}`,goal:'Fixture research',projectPath:project,mainKind:'openclaw',bindingId:link.id,participants:[{tool:'claude',profileId:'fixture',model:'sonnet'}],permission:'read-only',executionPolicy:'web-research' });
  const noProviderSpawn = () => assert(!fs.existsSync(spawnMarker), 'Rejected research must execute zero provider processes');
  const helperPath = path.join(app, 'src/runtime/research-mcp.bundle.cjs'), helperBytes = fs.readFileSync(helperPath);
  try {
    for (const missing of FLAGS) {
      write(executable, cliWithFlags(FLAGS.filter(f => f !== missing)), 0o700);
      assert.throws(submit, {code:'CAPABILITY_MISSING'}); noProviderSpawn();
    }
    write(executable, cli, 0o700);
    fs.renameSync(helperPath, helperPath + '.held');
    try { assert.throws(submit, {code:'CAPABILITY_MISSING'}); noProviderSpawn(); } finally { fs.renameSync(helperPath + '.held', helperPath); }
    fs.renameSync(path.join(root,'engine'),path.join(root,'engine-held'));
    try { assert.throws(submit, {code:'CAPABILITY_MISSING'}); noProviderSpawn(); } finally { fs.renameSync(path.join(root,'engine-held'),path.join(root,'engine')); }
    assert.equal(engine.db.all('root').length,0); assert.equal(engine.attempts().length,0);
    console.log(`PASS T21 actual Engine.submit: ${FLAGS.length} missing flags, missing helper and missing engine; roots/attempts/provider spawns all zero`);
    for (const change of ['cli','helper','model','account']) {
      const r=submit(), main=engine.attempts(r.id).find(a=>a.role==='main');
      engine.openClawDecide(r.id,owner,main.id,1,{kind:'delegate',summary:'fixture',delegations:[{participantId:r.participants[0].id,goal:'fixture child',resolvesTaskIds:[],inputs:[]}],reviews:[],finalResponse:''});
      const child=engine.attempts(r.id).find(a=>a.role==='child');
      if(change==='cli')write(executable,cli+'// changed executable\n',0o700);
      if(change==='helper')write(helperPath,Buffer.concat([helperBytes,Buffer.from('\n// changed helper\n')]));
      if(change==='model')child.binding.model='opus';
      if(change==='account')child.binding.profileId='second';
      engine.db.put('attempt',child); engine.tick();
      const blocked=engine.db.get('attempt',child.id);
      assert.equal(blocked.state,'blocked'); assert.equal(blocked.result.code,'CAPABILITY_STALE'); assert.equal(blocked.result.processStarted,false);
      assert.equal(engine.root(r.id).status,'needs_user');assert.equal(engine.db.events(r.id).filter(e=>e.type==='spawn_intent').length,0);noProviderSpawn();
      write(executable,cli,0o700);write(helperPath,helperBytes);
    }
    console.log('PASS T22 actual Engine.tick/prepare: CLI/helper/model/account changes after submission block the existing root; spawn intents/provider spawns zero');
    const policyPath=path.join(app,'src/runtime/research-policy.js'),policyBytes=fs.readFileSync(policyPath);
    const run = (name, changedBinding=binding) => {
      const dir=path.join(tmp,`runner-${name}`);fs.mkdirSync(dir);
      write(path.join(dir,'spec.json'),JSON.stringify({attemptId:name,token:`token-${name}`,binding:changedBinding,invocation:inv,cwd:project,prompt:'fixture'}));
      const result=spawnSync(process.execPath,[path.join(app,'src/runtime/runner.js'),dir],{env:process.env,encoding:'utf8',timeout:20000});
      assert.equal(result.status,0,result.stderr);return JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
    };
    for(const change of ['cli','model','account','policy','settings','helper-missing']) {
      let restore=()=>{},changedBinding=binding;
      if(change==='cli'){write(executable,cli+'// changed after prepare\n',0o700);restore=()=>write(executable,cli,0o700);}
      if(change==='model')changedBinding={...binding,model:'opus'};
      if(change==='account')changedBinding={...binding,profileId:'second'};
      if(change==='policy'){write(policyPath,policyBytes.toString().replace('web-only-snapshot-v1','web-only-snapshot-v2'));restore=()=>write(policyPath,policyBytes);}
      if(change==='settings'){const bytes=fs.readFileSync(inv.researchSnapshot.settingsFile);fs.appendFileSync(inv.researchSnapshot.settingsFile,' ');restore=()=>write(inv.researchSnapshot.settingsFile,bytes);}
      if(change==='helper-missing'){const helper=path.join(inv.researchSnapshot.path,'helper.cjs');fs.chmodSync(inv.researchSnapshot.path,0o700);fs.renameSync(helper,helper+'.held');restore=()=>{fs.renameSync(helper+'.held',helper);fs.chmodSync(inv.researchSnapshot.path,0o500);};}
      try { const receipt=run(change,changedBinding);assert.equal(receipt.state,'blocked');assert.equal(receipt.code,'CAPABILITY_STALE');assert.equal(receipt.failurePhase,'preflight');assert.equal(receipt.processStarted,false);noProviderSpawn(); } finally {restore();}
    }
    // Positive control proves the marker detects a real provider-mode process.
    const control=run('positive-control');assert.equal(control.processStarted,true);assert.equal(control.state,'failed');
    assert.equal(fs.readFileSync(spawnMarker,'utf8'),'provider\n');fs.unlinkSync(spawnMarker);
    console.log('PASS T22 actual runner subprocess: post-prepare CLI/model/account/policy/settings/helper changes block before provider spawn; positive-control provider marker observed exactly once (fixture only)');
  } finally {
    engine.db.close(); if(previousAccountsRoot===undefined)delete process.env.CLI_ACCOUNTS_ROOT;else process.env.CLI_ACCOUNTS_ROOT=previousAccountsRoot;
  }
  client = new Client({ name: 'fixture', version: '1' });
  await client.connect(new StdioClientTransport({ ...cfg, env: { ...env, ...cfg.env, GITHUB_TOKEN: 'never-for-engine' } }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['insane_search_fetch']);
  // W06: installation changes after model start, before first fetch, and between
  // fetches. The copied engine, dependency and helper must continue to be A.
  write(path.join(root, 'engine/__main__.py'), engineCode.replace("'engine': 'A'", "'engine': 'B'"));
  write(path.join(deps, 'curl_cffi/requests.py'), fs.readFileSync(path.join(deps, 'curl_cffi/requests.py'), 'utf8').replace("'transport': 'A'", "'transport': 'B'"));
  write(path.join(app, 'src/runtime/research-mcp.bundle.cjs'), 'throw Error("mutable helper B must never run")');
  validateResearchInvocation(binding, inv); // Installed sources need not exist after pinning.
  const call = async url => client.callTool({ name: 'insane_search_fetch', arguments: { url } });
  for (let i = 0; i < 2; i++) {
    const reply = await call('https://public.example/?q=%24(echo)'); assert(!reply.isError);
    const envelope = JSON.parse(reply.content[0].text), result = JSON.parse(envelope.extraction);
    assert(envelope.untrusted); assert.equal(result.engine, 'A'); assert.equal(result.response.transport, 'A');
    assert.equal(result.credentialPresent, false); assert.equal(result.verdict, 'weak_ok');
    assert.deepEqual(result.response.resolved, ['public.example:443:93.184.216.34']); assert.equal(result.response.automaticRedirects, false); assert.equal(result.response.proxy, '');
    for (const flag of ['--no-playwright', '--no-phase0', '--no-retry']) assert(result.argv.includes(flag));
    write(path.join(root, 'engine/__main__.py'), 'raise RuntimeError("source C must never run")');
  }
  for (const [url, calls] of [['http://127.0.0.1/', 0], ['https://public.example/redirect-private', 1], ['https://public.example/dns-failure', 0]]) {
    const result = JSON.parse(JSON.parse((await call(url)).content[0].text).extraction); assert(result.blocked); assert.equal(result.calls, calls);
  }
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com']) assert((await call(url)).isError);
  await assert.rejects(fetchPublic(inv.researchSnapshot.path, tmp, inv.researchSnapshot.hash, { url: 'https://example.com', command: 'x' }), { code: 'INVALID_RESEARCH_INPUT' });
  assert.throws(() => validateResearchInvocation({ ...binding, model: 'opus' }, inv), { code: 'CAPABILITY_STALE' });
  write(executable, cli + '# updated CLI\n'); assert.throws(() => validateResearchInvocation(binding, inv), { code: 'CAPABILITY_STALE' }); write(executable, cli);
  const attempt2 = path.join(tmp, 'attempt2'); fs.mkdirSync(attempt2);
  assert.throws(() => buildInvocation({ binding, role: 'child', permission: 'read-only', executionPolicy: 'web-research', dir: attempt2, capabilitySnapshot: cap }), { code: 'CAPABILITY_STALE' });
  const pinnedEngine = path.join(inv.researchSnapshot.path, 'engine/__main__.py'); fs.chmodSync(pinnedEngine, 0o600); write(pinnedEngine, 'raise RuntimeError("tampered attempt")');
  const changed = await call('https://public.example'); assert(changed.isError);
  const error = JSON.parse(changed.content[0].text); assert.equal(error.code, 'CAPABILITY_RUNTIME_CHANGED'); assert.equal(error.phase, 'tool_execution'); assert.equal(error.retryModel, false);
  assert.throws(() => validateResearchInvocation(binding, inv), { code: 'CAPABILITY_STALE' });
  const unsafe = path.join(tmp, 'unsafe'); fs.mkdirSync(unsafe); fs.symlinkSync(executable, path.join(unsafe, 'escape'));
  assert.throws(() => files(unsafe), { code: 'CAPABILITY_MISSING' }); assert.throws(() => verifyNativeClosure(executable, tmp, true), { code: 'CAPABILITY_MISSING' });
  const legacy = path.join(tmp, 'legacy'); fs.mkdirSync(legacy);
  assert(buildInvocation({ binding, role: 'child', permission: 'read-only', dir: legacy }).args.includes('--safe-mode'));
  console.log('PASS research: real MCP round trip; immutable helper/engine/dependency W06; submission/runner stale guards; typed runtime errors; no local reads/credentials; public DNS pinning/private redirects; legacy preservation (fixture transport, no network/model calls)');
} finally { await client?.close(); writable(tmp); fs.rmSync(tmp, { recursive: true, force: true }); } })().catch(e => { console.error(e); process.exitCode = 1; });
