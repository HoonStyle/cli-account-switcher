'use strict';
// All HOME/config/state paths are temporary. Never install or run a real CLI.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hook-')));
process.env.HOME = tmp; process.env.USERPROFILE = tmp;
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
const P = require('../src/paths'), store = require('../src/store'), wrappers = require('../src/wrappers');
const settingsFile = path.join(P.DEFAULT_HOME.claude, 'settings.json');
const parse = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hook = `node "${path.join(P.BIN_DIR, 'claude-statusline-cache.js')}"`;
const noTemps = () => assert(!fs.readdirSync(P.DEFAULT_HOME.claude).some(name => name.includes('.tmp-')));
function replace(object, key, value, test) {
  const original = object[key]; object[key] = value;
  try { test(original); } finally { object[key] = original; }
}
try {
  const stale = store.load(); stale.statusLineOriginal = { command: 'stale command' }; store.save(stale);
  assert.equal(wrappers.disableUsageHook().alreadyDisabled, true);
  assert.equal(fs.existsSync(P.DEFAULT_HOME.claude), false);
  let result = wrappers.enableUsageHook();
  assert.equal(result.alreadyEnabled, false); assert.equal(result.backup, null);
  assert.equal(parse(settingsFile).statusLine.command, hook);
  assert.equal(store.load().statusLineOriginal, null, 'A fresh setup cannot inherit a previous original command');
  if (!P.IS_WIN) assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  const first = fs.readFileSync(settingsFile, 'utf8'), firstState = fs.readFileSync(P.STATE_FILE, 'utf8');
  const firstNames = fs.readdirSync(P.DEFAULT_HOME.claude);
  assert.deepEqual(wrappers.enableUsageHook(), { alreadyEnabled: true });
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), first);
  assert.equal(fs.readFileSync(P.STATE_FILE, 'utf8'), firstState);
  assert.deepEqual(fs.readdirSync(P.DEFAULT_HOME.claude), firstNames);
  wrappers.disableUsageHook(); assert.deepEqual(parse(settingsFile), {});
  fs.unlinkSync(settingsFile); // The reported regression: directory exists but settings.json does not.
  result = wrappers.enableUsageHook(); assert.equal(result.backup, null);
  assert.equal(parse(settingsFile).statusLine.command, hook);
  wrappers.disableUsageHook();
  console.log('PASS fresh/missing settings setup, private creation, no stale original command and idempotent enable');

  const originalSettings = { permissions: { allow: ['Read'], deny: ['Bash(rm *)'] }, env: { CUSTOM: 'unchanged' }, statusLine: { type: 'command', command: 'node original.js', padding: 7, refreshInterval: 13, custom: 'preserved' }, model: 'fixture' };
  const originalText = JSON.stringify(originalSettings, null, 4) + '\n';
  fs.writeFileSync(settingsFile, originalText); fs.chmodSync(settingsFile, 0o640);
  const priorBackups = new Map(fs.readdirSync(P.DEFAULT_HOME.claude).filter(name => name.includes('.bak-cli-accounts')).map(name => [name, fs.readFileSync(path.join(P.DEFAULT_HOME.claude, name), 'utf8')]));
  result = wrappers.enableUsageHook();
  assert.equal(fs.readFileSync(result.backup, 'utf8'), originalText);
  assert.deepEqual(store.load().statusLineOriginal, originalSettings.statusLine);
  const enabled = parse(settingsFile);
  assert.deepEqual({ ...enabled, statusLine: originalSettings.statusLine }, originalSettings);
  assert.equal(enabled.statusLine.padding, 7); assert.equal(enabled.statusLine.refreshInterval, 13);
  if (!P.IS_WIN) {
    assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o640);
    assert.equal(fs.statSync(result.backup).mode & 0o777, 0o640);
  }
  const disabled = wrappers.disableUsageHook();
  assert.deepEqual(parse(settingsFile), originalSettings);
  assert.deepEqual(parse(disabled.backup), enabled);
  for (const [name, bytes] of priorBackups) assert.equal(fs.readFileSync(path.join(P.DEFAULT_HOME.claude, name), 'utf8'), bytes);
  assert.equal(wrappers.disableUsageHook().alreadyDisabled, true);
  console.log('PASS settings/permissions/mode preservation, full original status line restoration and recoverable non-overwritten backups');

  for (const invalid of ['{broken json', 'null', '[]', 'true']) {
    fs.writeFileSync(settingsFile, invalid);
    const beforeState = fs.readFileSync(P.STATE_FILE, 'utf8'), beforeFiles = fs.readdirSync(P.DEFAULT_HOME.claude);
    assert.throws(() => wrappers.enableUsageHook(), /Cannot update Claude settings/);
    assert.throws(() => wrappers.disableUsageHook(), /Cannot update Claude settings/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), invalid);
    assert.equal(fs.readFileSync(P.STATE_FILE, 'utf8'), beforeState);
    assert.deepEqual(fs.readdirSync(P.DEFAULT_HOME.claude), beforeFiles);
  }
  fs.writeFileSync(settingsFile, originalText);
  const realRead = fs.readFileSync;
  replace(fs, 'readFileSync', (file, ...args) => {
    if (file === settingsFile) throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
    return realRead(file, ...args);
  }, () => {
    assert.throws(() => wrappers.enableUsageHook(), /fixture read denied/);
  });
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalText);
  console.log('PASS malformed/non-object JSON and read failures never reset user settings');

  const beforeState = store.load();
  const realWrite = fs.writeFileSync;
  replace(fs, 'writeFileSync', (file, ...args) => {
    if (typeof file === 'number') {
      realWrite(file, '{partial');
      throw new Error('fixture settings write failed');
    }
    return realWrite(file, ...args);
  }, () => assert.throws(() => wrappers.enableUsageHook(), /fixture settings write failed/));
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalText);
  assert.deepEqual(store.load(), beforeState); noTemps();
  replace(fs, 'copyFileSync', () => { throw new Error('fixture backup failed'); }, () => {
    assert.throws(() => wrappers.enableUsageHook(), /fixture backup failed/);
  });
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalText);
  assert.deepEqual(store.load(), beforeState); noTemps();
  replace(store, 'save', () => { throw new Error('fixture state write failed'); }, () => {
    assert.throws(() => wrappers.enableUsageHook(), /fixture state write failed/);
  });
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalText);
  assert.deepEqual(store.load(), beforeState); noTemps();
  const realSave = store.save;
  let saveCalls = 0;
  replace(store, 'save', state => {
    realSave(state);
    if (++saveCalls === 1) throw new Error('fixture mirror failed after state write');
  }, () => assert.throws(() => wrappers.enableUsageHook(), /fixture mirror failed/));
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalText);
  assert.deepEqual(store.load(), beforeState); noTemps();
  const realRename = fs.renameSync;
  replace(fs, 'renameSync', (from, to) => {
    if (to === settingsFile) throw new Error('fixture settings rename failed');
    return realRename(from, to);
  }, () => {
    assert.throws(() => wrappers.enableUsageHook(), /fixture settings rename failed/);
  });
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalText);
  assert.deepEqual(store.load(), beforeState); noTemps();
  console.log('PASS partial writes, backup/state/mirror/rename failures preserve settings and state with no temporary residue');

  if (!P.IS_WIN) {
    const target = path.join(tmp, 'shared-settings.json');
    fs.renameSync(settingsFile, target); fs.symlinkSync(target, settingsFile);
    wrappers.enableUsageHook(); assert(fs.lstatSync(settingsFile).isSymbolicLink());
    assert.equal(parse(target).statusLine.command, hook);
    wrappers.disableUsageHook(); assert(fs.lstatSync(settingsFile).isSymbolicLink());
    assert.deepEqual(parse(target), originalSettings);
    fs.unlinkSync(target);
    assert.throws(() => wrappers.enableUsageHook(), { code: 'ENOENT' });
    assert(fs.lstatSync(settingsFile).isSymbolicLink(), 'A dangling user symlink must not be silently replaced');
    console.log('PASS settings symlink and target preserved; dangling links fail without replacing them');
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
