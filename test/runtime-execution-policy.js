'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),cp=require('child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'execution-policy-'));
const {normalizeExecutionPolicy,executionEnv}=require('../src/runtime/execution-policy');
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
const project=path.join(tmp,'project');fs.mkdirSync(project);cp.execFileSync('git',['init','-q',project]);
if(process.platform==='darwin') {
  const inv=buildInvocation({binding,role:'child',permission:'workspace-write',executionPolicy:'build-test',cwd:project,dir:tmp});
  assert(inv.args[inv.args.indexOf('--tools')+1].includes('Bash'));
  assert(inv.args.includes('--restricted'));
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
}
console.log('PASS explicit build grant, legacy/read-only preservation, bounded command rules, sandbox fail-closed settings, environment/auth separation, required artifact schema');
