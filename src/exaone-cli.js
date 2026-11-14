'use strict';
// Console commands for the EXAONE API category.
//   cli-accounts exaone list [--json]
//   cli-accounts exaone add <name> [--with-api-key]
//   cli-accounts exaone rm <name>
//   cli-accounts exaone use <name>
//   cli-accounts exaone rename <name> <new-name>
//   cli-accounts exaone apikey set <name> | apikey rm <name> | apikey [status] [--json]
//   cli-accounts exaone check [name] [--json]
//   cli-accounts exaone env [name]            (variable names only; values are never printed)
//   cli-accounts exaone run [name] -- <command> [args...]
const exaone = require('./exaone');
const store = require('./store');

const KNOWN_FLAGS = ['--json', '--with-api-key', '--profile'];

function pad(s, n) { s = String(s ?? ''); return s + ' '.repeat(Math.max(0, n - [...s].length)); }
function fmtTime(iso) { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1)}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function fmtRate(rateLimit) {
  if (!rateLimit) return '';
  const parts = [];
  for (const [window, name] of [['minute', '분'], ['day', '일']]) {
    const w = rateLimit[window];
    if (w && (w.remaining != null || w.limit != null)) parts.push(`${name} ${w.remaining ?? '?'}/${w.limit ?? '?'}`);
  }
  return parts.length ? `남은 호출 ${parts.join(' · ')}` : '';
}
function describe(account) {
  const key = account.apiKey && account.apiKey.apiKey ? `API 키${account.apiKey.masked ? ' ' + account.apiKey.masked : ''}` : '(API 키 없음)';
  const c = account.check;
  const checked = !c ? '' : c.ok ? ` · 연결 확인 ${fmtTime(c.checkedAt)}${fmtRate(c.rateLimit) ? ' · ' + fmtRate(c.rateLimit) : ''}` : ` · 연결 실패 ${fmtTime(c.checkedAt)} (${c.error})`;
  return key + checked;
}

// Text listing shared with `cli-accounts list`.
function printList(snap = exaone.snapshot()) {
  console.log(`${exaone.ID}:`);
  if (!snap.accounts.length) { console.log(`    (계정 없음 · cli-accounts exaone add <name>)`); return; }
  for (const a of snap.accounts) {
    const shown = a.label !== a.name ? `${a.label} (${a.name})` : a.name;
    console.log(`  ${a.active ? '*' : ' '} ${pad(shown, 14)} ${describe(a)}`);
  }
}

// JSON rows merged into `cli-accounts list --json`. Not delegable: there is no CLI to pin.
function jsonAccounts(snap = exaone.snapshot()) {
  return snap.accounts.map((a) => ({ tool: exaone.ID, profileId: a.name, active: a.active, apiKey: Boolean(a.apiKey && a.apiKey.apiKey), delegable: false, baseUrl: snap.baseUrl, model: snap.model }));
}

async function setKey(name) {
  const id = exaone.resolve(name);
  const raw = await require('./secret-input').readSecret(`exaone / ${id} API 키 (입력은 표시되지 않음): `);
  const r = exaone.setKey(id, raw);
  if (r.warning) console.error(`경고: ${r.warning}`);
  console.log(`exaone / ${id}: API 키 등록됨 (${r.masked})`);
  console.log(`이 계정으로 실행하는 명령에는 ${exaone.envNames().join(', ')} 가 주입됩니다 (API 사용량 과금).`);
}

async function run(args) {
  const sep = args.indexOf('--');
  const head = sep === -1 ? args : args.slice(0, sep);
  const tail = sep === -1 ? [] : args.slice(sep + 1);
  const flags = new Set(head.filter((a) => a.startsWith('--')));
  for (const flag of flags) if (!KNOWN_FLAGS.includes(flag)) throw new Error(`지원하지 않는 EXAONE 옵션입니다: ${flag}`);
  let profile;
  const positional = [];
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '--profile') { profile = head[++i]; if (!profile || profile.startsWith('--')) throw new Error('--profile 에는 계정 이름이 필요합니다'); }
    else if (!head[i].startsWith('--')) positional.push(head[i]);
  }
  const [command = 'list', a1, a2] = positional;
  const json = flags.has('--json');

  if (command === 'list' || command === 'ls') {
    const snap = exaone.snapshot();
    if (json) { console.log(JSON.stringify({ ...snap, accounts: snap.accounts }, null, 2)); return; }
    console.log(`EXAONE API · ${snap.model} · ${snap.baseUrl} (API 키 계정 · OpenAI 호환)`);
    printList(snap);
    return;
  }
  if (command === 'add') {
    if (!a1) throw new Error('사용법: cli-accounts exaone add <name> [--with-api-key]');
    const r = exaone.add(a1);
    console.log(`추가됨: ${r.id}`);
    if (flags.has('--with-api-key')) return setKey(r.id);
    console.log(`API 키 등록: cli-accounts exaone apikey set ${r.id}`);
    return;
  }
  if (command === 'rm' || command === 'remove') {
    if (!a1) throw new Error('사용법: cli-accounts exaone rm <name>');
    const r = exaone.remove(a1);
    console.log(`제거됨: ${r.id} (등록된 API 키도 삭제)`);
    return;
  }
  if (command === 'use' || command === 'switch') {
    if (!a1) throw new Error('사용법: cli-accounts exaone use <name>');
    const r = exaone.setActive(a1);
    console.log(`exaone → ${r.id}`);
    console.log('exaone run 에서 계정을 생략하면 이 계정의 키를 사용합니다.');
    return;
  }
  if (command === 'rename' || command === 'mv') {
    if (!a1 || !a2) throw new Error('사용법: cli-accounts exaone rename <현재 이름> <새 이름>');
    const r = exaone.rename(a1, a2);
    console.log(`${a1} → ${r.label}  (ID ${r.id}은 그대로)`);
    return;
  }
  if (command === 'apikey' || command === 'api-key' || command === 'key') {
    if (a1 === 'set' || a1 === 'add') {
      if (!a2) throw new Error('사용법: cli-accounts exaone apikey set <name>   (키는 stdin 또는 숨김 입력)');
      if (positional[3]) throw new Error('API 키를 명령줄 인자로 넘기지 마세요. 파이프(stdin)나 숨김 입력을 사용하세요.');
      return setKey(a2);
    }
    if (a1 === 'rm' || a1 === 'remove') {
      if (!a2) throw new Error('사용법: cli-accounts exaone apikey rm <name>');
      const r = exaone.removeKey(a2);
      console.log(r.removed ? `exaone / ${r.id}: API 키 제거됨` : `exaone / ${r.id}: 등록된 API 키 없음`);
      return;
    }
    const snap = exaone.snapshot();
    const rows = snap.accounts.map((a) => ({ tool: exaone.ID, profileId: a.name, label: a.label, apiKey: Boolean(a.apiKey && a.apiKey.apiKey), masked: a.apiKey ? a.apiKey.masked : null }));
    if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) console.log(`${pad(r.tool, 7)} ${pad(r.label !== r.profileId ? `${r.label} (${r.profileId})` : r.profileId, 20)} ${r.apiKey ? `API 키${r.masked ? ' ' + r.masked : ''}` : '-'}`);
    return;
  }
  if (command === 'check') {
    const r = await exaone.check(a1 ?? profile);
    if (json) { console.log(JSON.stringify(r, null, 2)); return; }
    if (r.ok) console.log(`exaone / ${r.id}: 연결 확인 ✓ ${fmtTime(r.checkedAt)}${r.models.length ? ` · 모델 ${r.models.join(', ')}` : ''}${fmtRate(r.rateLimit) ? ' · ' + fmtRate(r.rateLimit) : ''}`);
    else { console.error(`exaone / ${r.id}: 연결 실패 (${r.error})`); process.exitCode = 1; }
    return;
  }
  if (command === 'env') {
    const { id } = exaone.launchEnv(a1 ?? profile, {});
    console.log(`exaone / ${id}: 실행 시 주입되는 변수 (값은 표시하지 않음)`);
    for (const name of exaone.envNames()) console.log(`  ${name}`);
    console.log(`실행: cli-accounts exaone run ${id} -- <command> [args...]`);
    return;
  }
  if (command === 'run' || command === 'exec') {
    if (sep === -1 || !tail.length) throw new Error('사용법: cli-accounts exaone run [name] -- <command> [args...]');
    const { code, signal } = await exaone.run(a1 ?? profile, tail);
    if (signal) process.kill(process.pid, signal); else process.exitCode = code;
    return;
  }
  throw new Error('사용법: cli-accounts exaone list|add <name> [--with-api-key]|rm <name>|use <name>|rename <name> <new>|apikey set|rm <name>|apikey [status]|check [name]|env [name]|run [name] -- <command...>');
}

module.exports = { run, printList, jsonAccounts, describe };
