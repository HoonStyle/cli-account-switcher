'use strict';
// Antigravity is a SHARED OS login, not a home-isolated provider. Never put it
// in paths.TOOLS or the managed/pinned execution catalogue.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const P = require('./paths');
const SERVICE = 'dev.hoonstyle.cli-account-switcher.antigravity';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function credentialJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024) throw Error('invalid credential');
  // go-keyring's macOS backend wraps secrets; native keychain APIs do not
  // unwrap them. Decode only its tagged formats, never arbitrary base64.
  // Keep the original raw value elsewhere for exact keyring save/rollback.
  const value = raw.trim();
  let bytes;
  if (value.startsWith('go-keyring-base64:')) {
    const encoded = value.slice('go-keyring-base64:'.length);
    if (!encoded || encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Error('invalid encoding');
    bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw Error('invalid encoding');
  } else if (value.startsWith('go-keyring-encoded:')) {
    const encoded = value.slice('go-keyring-encoded:'.length);
    if (!encoded || encoded.length % 2 || !/^[a-fA-F0-9]+$/.test(encoded)) throw Error('invalid encoding');
    bytes = Buffer.from(encoded, 'hex');
  } else return raw;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseCredential(raw) {
  try {
    const doc = JSON.parse(credentialJson(raw));
    if (!doc.token || !(doc.token.access_token || doc.token.refresh_token)) throw Error();
    let claims = {};
    if (doc.id_token) claims = JSON.parse(Buffer.from(doc.id_token.split('.')[1], 'base64url').toString('utf8'));
    const email = claims.email || doc.id_token_email;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) throw Error();
    // Claims identify a LOCAL saved credential; this is not JWT verification.
    const identity = String(claims.sub || email.toLowerCase());
    return { id: hash(identity).slice(0, 32), email };
  } catch { throw Error('Antigravity 인증 형식을 확인할 수 없습니다. 공식 agy에서 다시 로그인해 주세요.'); }
}

function runningProcesses(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name | ConvertTo-Json -Compress';
      const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000, windowsHide: true }));
      return (Array.isArray(rows) ? rows : [rows]).filter(p => /^(agy|antigravity.*|language_server.*)\.exe$/i.test(p.Name)).map(p => p.ProcessId);
    }
    return execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 5000 })
      .split('\n').flatMap(line => {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        return m && /^(agy|antigravity(?:[ ._-].*)?|language_server(?:[._-].*)?)$/i.test(path.basename(m[2])) ? [Number(m[1])] : [];
      });
  } catch { throw Error('Antigravity 실행 상태를 확인하지 못해 전환을 중단했습니다.'); }
}

function nativeVault() {
  if (!['darwin', 'win32'].includes(process.platform)) throw Error('Antigravity 계정 전환은 현재 macOS·Windows에서만 지원합니다.');
  const { AsyncEntry } = require('@napi-rs/keyring');
  function entry(service, account) {
    // go-keyring uses service:account on Windows, not keyring-rs's default target.
    return process.platform === 'win32' ? AsyncEntry.withTarget(`${service}:${account}`, service, account) : new AsyncEntry(service, account);
  }
  return {
    get: async (s, a) => { const bytes = await entry(s, a).getSecret(); return bytes === null ? null : Buffer.from(bytes).toString('utf8'); },
    set: (s, a, v) => entry(s, a).setSecret(Buffer.from(v, 'utf8')),
    remove: (s, a) => entry(s, a).deleteCredential(),
  };
}

function createManager({ root = path.join(P.ROOT, 'antigravity'), common = path.join(P.HOME, '.cli-accounts-antigravity'), tokenFile = path.join(P.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), vault, processes = runningProcesses, usageFetcher = require('./antigravity-usage').fetchUsage } = {}) {
  const registryFile = path.join(root, 'registry.json');
  const journalFile = path.join(common, 'transaction.json');
  const lockFile = path.join(common, 'switch.lock');
  const namespace = hash(path.resolve(root)).slice(0, 24);
  let current = null, checkedAt = null;
  let usage = null, usageError = null, usagePending = null, usageController = null;
  const key = id => `${namespace}/${id}`;
  const backend = () => {
    vault ||= nativeVault();
    return Object.fromEntries(['get', 'set', 'remove'].map(method => [method, async (...args) => {
      try { return await vault[method](...args); }
      catch { throw Error('OS 키링 작업을 완료하지 못했습니다. 잠금·접근 권한·저장 크기를 확인해 주세요.'); }
    }]));
  };
  const atomic = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  };
  const readFile = file => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw Error('unsafe file');
      return fs.readFileSync(file, 'utf8');
    } catch (e) { if (e.code === 'ENOENT') return null; throw Error('Antigravity 저장 파일을 안전하게 읽을 수 없습니다.'); }
  };
  function registry() {
    const text = readFile(registryFile);
    if (text === null) return { version: 1, accounts: [] };
    try {
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.some(a => !/^[a-f0-9]{32}$/.test(a.id) || typeof a.label !== 'string' || typeof a.email !== 'string')) throw Error();
      return data;
    } catch { throw Error('Antigravity 계정 목록이 손상되어 작업을 중단했습니다.'); }
  }
  function snapshot() {
    try { return { mode: 'shared-login', accounts: registry().accounts, current, checkedAt, usage, usageError, usagePending: Boolean(usagePending), recoveryRequired: fs.existsSync(journalFile) }; }
    catch (e) { return { mode: 'shared-login', accounts: [], current: null, checkedAt: null, error: e.message, recoveryRequired: fs.existsSync(journalFile) }; }
  }
  async function locked(action, { recovery = false } = {}) {
    fs.mkdirSync(common, { recursive: true, mode: 0o700 });
    let release;
    try { release = await require('proper-lockfile').lock(common, { lockfilePath: lockFile, stale: 30000, update: 5000, retries: 0 }); }
    catch { throw Error('다른 Antigravity 계정 작업이 진행 중입니다. 중단된 작업은 30초 후 복구할 수 있습니다.'); }
    try {
      if (!recovery && fs.existsSync(journalFile)) throw Error('이전 Antigravity 전환 복구가 필요합니다: cli-accounts antigravity recover');
      return await action();
    } finally {
      await release();
    }
  }
  function assertClosed() {
    if (processes().length) throw Error('Antigravity 앱·IDE·agy를 모두 종료한 뒤 전환해 주세요. 자동 종료하지 않습니다.');
  }
  async function live() {
    let keyring;
    try { keyring = await backend().get('gemini', 'antigravity'); }
    catch { throw Error('OS 키링을 읽지 못했습니다. 잠금·접근 권한을 확인해 주세요.'); }
    const file = readFile(tokenFile);
    const a = keyring === null ? null : parseCredential(keyring);
    const b = file === null ? null : parseCredential(file);
    if (a && b && a.id !== b.id) throw Error('Antigravity 키링과 파일의 계정이 다릅니다. 공식 agy에서 로그인을 정리해 주세요.');
    return { keyring, file, raw: keyring ?? file, info: a || b };
  }
  async function check() {
    const value = await live(); current = value.info; checkedAt = new Date().toISOString(); return snapshot();
  }
  function refreshUsage() {
    // All callers join the same request. The shared switch lock also prevents
    // changing the live credential while the official CLI is querying it.
    if (usagePending) return usagePending;
    usageController = new AbortController();
    usageError = null;
    usagePending = locked(async () => { usage = await usageFetcher({ signal: usageController.signal }); })
      .catch(error => { usageError = error.message; throw error; })
      .finally(() => { usagePending = null; usageController = null; })
      .then(() => snapshot());
    return usagePending;
  }
  function cancelUsage() { usageController?.abort(); }
  async function save(label) {
    if (!require('./store').validName(label)) throw Error('계정 이름은 글자·숫자·공백·._-만, 41자 이내로 입력해 주세요.');
    return locked(async () => {
      const value = await live();
      if (!value.info) throw Error('저장할 로그인이 없습니다. 공식 agy에서 로그인한 뒤 현재 로그인을 저장해 주세요.');
      const data = registry();
      if (data.accounts.some(a => a.label === label && a.id !== value.info.id)) throw Error('이미 쓰는 계정 이름입니다.');
      try { await backend().set(SERVICE, key(value.info.id), value.raw); }
      catch { throw Error('OS 키링에 계정을 저장하지 못했습니다.'); }
      const account = { ...value.info, label, savedAt: new Date().toISOString() };
      data.accounts = data.accounts.filter(a => a.id !== account.id).concat(account);
      atomic(registryFile, JSON.stringify(data, null, 2));
      current = value.info; checkedAt = account.savedAt; return snapshot();
    });
  }
  function select(query) {
    const hits = registry().accounts.filter(a => a.id === query || a.label === query || a.email === query);
    if (hits.length !== 1) throw Error('저장된 Antigravity 계정을 정확한 이름 또는 ID로 지정해 주세요.');
    return hits[0];
  }
  async function restore(saved) {
    if (saved.keyring === null) await backend().remove('gemini', 'antigravity');
    else await backend().set('gemini', 'antigravity', saved.keyring);
    if (saved.file === null) { if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile); }
    else atomic(tokenFile, saved.file);
    if (await backend().get('gemini', 'antigravity') !== saved.keyring || readFile(tokenFile) !== saved.file) throw Error('restore mismatch');
  }
  async function activate(query) {
    return locked(async () => {
      assertClosed();
      const selected = select(query);
      let raw;
      try { raw = await backend().get(SERVICE, key(selected.id)); } catch { throw Error('저장된 계정의 OS 키링 접근이 거부되었습니다.'); }
      const target = parseCredential(raw);
      const targetFile = credentialJson(raw);
      if (target.id !== selected.id) throw Error('저장된 계정과 인증 정보가 일치하지 않습니다.');
      const before = await live();
      usage = null; usageError = null;
      // Persist refreshed tokens to the matching saved account before switching away.
      if (before.info && registry().accounts.some(a => a.id === before.info.id)) await backend().set(SERVICE, key(before.info.id), before.raw);
      if (before.info?.id === target.id) { current = before.info; checkedAt = new Date().toISOString(); return snapshot(); }
      const backup = { keyring: before.keyring, file: before.file };
      // Separate entries preserve raw bytes and fit Windows' per-credential
      // blob limit; a combined JSON backup can exceed it even for valid tokens.
      await backend().set(SERVICE, 'previous-shared-keyring', backup.keyring ?? '');
      await backend().set(SERVICE, 'previous-shared-file', backup.file ?? '');
      atomic(journalFile, JSON.stringify({ version: 1, target: target.id, startedAt: new Date().toISOString() }));
      try {
        assertClosed();
        await backend().set('gemini', 'antigravity', raw);
        // Do not create a second plaintext credential store. Update an existing
        // official fallback only, so it cannot retain the prior account.
        if (before.file !== null) atomic(tokenFile, targetFile);
        if (await backend().get('gemini', 'antigravity') !== raw || (before.file !== null && readFile(tokenFile) !== targetFile)) throw Error('readback mismatch');
        fs.unlinkSync(journalFile);
      } catch {
        try { await restore(backup); fs.unlinkSync(journalFile); }
        catch { current = null; checkedAt = null; throw Error('전환을 완료하지 못했고 인증 복구가 필요합니다: cli-accounts antigravity recover'); }
        throw Error('Antigravity 전환에 실패하여 기존 인증을 복원했습니다.');
      }
      current = target; checkedAt = new Date().toISOString(); return snapshot();
    });
  }
  async function recover() {
    return locked(async () => {
      assertClosed();
      usage = null; usageError = null;
      if (!fs.existsSync(journalFile)) return snapshot();
      try {
        const keyring = await backend().get(SERVICE, 'previous-shared-keyring');
        const file = await backend().get(SERVICE, 'previous-shared-file');
        if (keyring === null || file === null) throw Error('missing backup');
        const saved = { keyring: keyring || null, file: file || null };
        if (saved.keyring !== null) parseCredential(saved.keyring);
        if (saved.file !== null) parseCredential(saved.file);
        await restore(saved); fs.unlinkSync(journalFile);
      } catch { throw Error('Antigravity 인증 복구를 완료하지 못했습니다. 키링 접근 권한을 확인해 주세요.'); }
      return check();
    }, { recovery: true });
  }
  async function remove(query) {
    return locked(async () => {
      const selected = select(query), data = registry();
      await backend().remove(SERVICE, key(selected.id));
      data.accounts = data.accounts.filter(a => a.id !== selected.id);
      atomic(registryFile, JSON.stringify(data, null, 2)); return snapshot();
    });
  }
  return { snapshot, check, save, activate, remove, recover, refreshUsage, cancelUsage };
}
let singleton;
function manager() { return singleton || (singleton = createManager()); }
module.exports = { createManager, manager, parseCredential, runningProcesses, nativeVault, SERVICE };
