'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),cp=require('child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'execution-policy-'));
const {normalizeExecutionPolicy,executionEnv,buildRules}=require('../src/runtime/execution-policy');
const {buildInvocation,mainSchema}=require('../src/adapters/cli');
assert.equal(normalizeExecutionPolicy('workspace-write'), 'edit-only');
assert.throws(()=>normalizeExecutionPolicy('read-only','build-test'),/workspace-write/);
for(const policy of [null,'arbitrary',{},true]) assert.throws(()=>normalizeExecutionPolicy('workspace-write',policy),/Invalid/);
const fake=path.join(tmp,'claude');
fs.writeFileSync(fake,`#!/bin/sh\nif [ "$1" = "--version" ]; then echo '2.1.290'; else echo '--restricted --settings --permission-prompts'; fi\n`,{mode:0o755});
const binding={tool:'claude',executable:fake};
for(const permission of ['read-only','workspace-write']) for(const role of ['child','main']) {
  const inv=buildInvocation({binding,role,permission,dir:tmp});
  assert(!inv.args[inv.args.indexOf('--tools')+1].includes('Bash'));
  assert(!inv.executionEnv);
}
assert(mainSchema.properties.delegations.items.required.includes('inputs'));
const {Engine}=require('../src/runtime/engine');
const guideContext={db:{get:()=>({goal:'Use project tests'})}};
const guideRoot={permission:'workspace-write',goal:'Build fixture',commit:'fixture'};
const childPrompt=(tool,policy)=>Engine.prototype.prompt.call(guideContext,{...guideRoot,executionPolicy:policy},{role:'child',binding:{tool}});
const guide=childPrompt('claude','build-test');
assert(guide.includes('ONE direct approved command per call'));
assert(guide.includes('npm ci --offline'));
assert(guide.includes('Do not prepend cd, env, export, unset'));
assert(guide.includes('Do not change settings, bypass the sandbox'));
assert(!childPrompt('claude','edit-only').includes('Build/test command protocol'));
assert(!childPrompt('codex','build-test').includes('Build/test command protocol'));

for (const rule of ['npm ci --offline', 'npm ci --offline --ignore-scripts', 'npm run typecheck', 'node --import tsx --test *']) assert(buildRules.includes(rule));
for (const rule of ['npm ci', 'npm install *', 'npm *', 'node *', 'bash *', 'env *']) assert(!buildRules.includes(rule));
const project=path.join(tmp,'project');fs.mkdirSync(project);cp.execFileSync('git',['init','-q',project]);
if(process.platform==='darwin') {
  const inv=buildInvocation({binding,role:'child',permission:'workspace-write',executionPolicy:'build-test',cwd:project,dir:tmp});
  assert(inv.args[inv.args.indexOf('--tools')+1].includes('Bash'));
  assert(inv.args.includes('--restricted'));
  assert(inv.args.includes('--safe-mode')); // Built-in permissions still apply in safe mode.
  assert(!inv.args.some(a=>/bypass|dangerously/.test(a)));
  assert.equal(inv.args[inv.args.indexOf('--permission-prompts')+1],'none');
  const s=JSON.parse(fs.readFileSync(inv.args[inv.args.indexOf('--settings')+1]));
  assert.equal(s.sandbox.enabled,true);assert.equal(s.sandbox.failIfUnavailable,true);
  assert.equal(s.sandbox.allowUnsandboxedCommands,false);assert.equal(s.sandbox.autoAllowBashIfSandboxed,false);
  assert.equal(s.sandbox.filesystem.disabled,false);assert.deepEqual(s.sandbox.excludedCommands,[]);
  assert(s.sandbox.filesystem.denyRead.includes('/Users'));
  assert(s.sandbox.filesystem.allowRead.includes(fs.realpathSync(project)));
  assert(!s.permissions.allow.includes('Bash'));assert(!s.permissions.allow.includes('Bash(node *)'));
  const env=executionEnv(inv,{HOME:'native-home',CLAUDE_CONFIG_DIR:'native-profile',NODE_OPTIONS:'untrusted',NPM_TOKEN:'secret',GITHUB_TOKEN:'secret',DISCORD_TOKEN:'secret',DATABASE_URL:'secret',CLI_ACCOUNTS_SOCKET:'authority',GIT_CONFIG_COUNT:'1',PATH:'untrusted'});
  assert.equal(env.HOME,'native-home');assert.equal(env.CLAUDE_CONFIG_DIR,'native-profile');
  for(const key of ['NODE_OPTIONS','NPM_TOKEN','GITHUB_TOKEN','CLI_ACCOUNTS_SOCKET','GIT_CONFIG_COUNT','DISCORD_TOKEN','DATABASE_URL'])assert(!Object.hasOwn(env,key));
  const outside=path.join(tmp,'uncreated-outside');fs.unlinkSync(env.npm_config_userconfig);fs.symlinkSync(outside,env.npm_config_userconfig);assert.throws(()=>buildInvocation({binding,role:'child',permission:'workspace-write',executionPolicy:'build-test',cwd:project,dir:tmp}),/ELOOP|Unsafe/);assert(!fs.existsSync(outside));fs.unlinkSync(env.npm_config_userconfig);fs.writeFileSync(env.npm_config_userconfig,'');
  assert.notEqual(env.npm_config_userconfig,env.npm_config_globalconfig);assert.equal(fs.readFileSync(env.npm_config_userconfig,'utf8'),'');assert(env.NUGET_PACKAGES.startsWith(fs.realpathSync(project)));
  assert.equal(env.npm_config_engine_strict, 'true');
  const sharedContent=path.join(os.homedir(),'.npm','_cacache');
  if(fs.existsSync(sharedContent)) {
    assert(s.sandbox.filesystem.allowRead.includes(fs.realpathSync(sharedContent)));
    assert(s.sandbox.filesystem.denyWrite.includes(fs.realpathSync(sharedContent)));
    assert.equal(env.npm_config_cache,path.join(os.homedir(),'.npm'));
    assert(env.npm_config_logs_dir.startsWith(fs.realpathSync(project)));
    assert(!s.sandbox.filesystem.allowRead.includes(path.join(os.homedir(),'.npm')));
  }
  assert(s.sandbox.filesystem.allowRead.includes(path.dirname(path.dirname(fs.realpathSync(process.execPath)))));
  // Real linked worktrees store their objects/refs outside cwd. Read access to
  // that exact Git directory is required, while every Git write stays denied.
  cp.execFileSync('git',['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']);
  const linked=path.join(tmp,'linked');cp.execFileSync('git',['-C',project,'worktree','add','--detach',linked],{stdio:'pipe'});
  const li=buildInvocation({binding,role:'child',permission:'workspace-write',executionPolicy:'build-test',cwd:linked,dir:tmp});
  const ls=JSON.parse(fs.readFileSync(li.args[li.args.indexOf('--settings')+1]));
  const common=fs.realpathSync(path.join(project,'.git'));
  assert(ls.sandbox.filesystem.allowRead.includes(common));
  assert(ls.sandbox.filesystem.denyWrite.includes(common));
  assert(!ls.sandbox.filesystem.allowRead.includes(fs.realpathSync(project)));
  assert.equal(ls.sandbox.allowUnsandboxedCommands,false);
  assert.equal(ls.sandbox.network.allowLocalBinding,false);
}
console.log('PASS explicit build grant, legacy/read-only preservation, bounded command rules, sandbox fail-closed settings, environment/auth separation, required artifact schema');
