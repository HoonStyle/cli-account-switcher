#!/usr/bin/env node
'use strict';
// Console interface. Installed as `cli-accounts` next to the shims.
//   cli-accounts list [claude|codex]
//   cli-accounts use <claude|codex> <profile>
//   cli-accounts usage [claude|codex] [profile|--all] [--json]
//   cli-accounts add <claude|codex> <profile> [--no-share]
//   cli-accounts rm <claude|codex> <profile> [--delete-files]
//   cli-accounts login <claude|codex> [profile]
const path = require('path');
const P = require('./paths');
const store = require('./store');
const edition = require('./edition.json');
const inspectors = { claude: require('./claude').inspect, codex: require('./codex').inspect };

const TOOLS = P.TOOLS;
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.filter((a) => !a.startsWith('--'));
const [cmd, a1, a2] = args;

function die(msg) { console.error(msg); process.exit(1); }
function tool(t) { if (!TOOLS.includes(t)) die(`도구는 claude 또는 codex: ${t || '(없음)'}`); return t; }
function pad(s, n) { s = String(s ?? ''); return s + ' '.repeat(Math.max(0, n - [...s].length)); }

function fmtReset(epoch) {
  if (!epoch) return '-';
  const diff = epoch * 1000 - Date.now();
  const d = new Date(epoch * 1000);
  const abs = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const rel = diff <= 0 ? '리셋됨' : diff < 3600e3 ? `${Math.ceil(diff / 60e3)}분 후` : diff < 86400e3 ? `${Math.floor(diff / 3600e3)}시간 후` : `${Math.floor(diff / 86400e3)}일 후`;
  return `${abs} (${rel})`;
}
function fmtAge(iso) {
  if (!iso) return '-';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60e3);
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
}
function usageMode() {
  if (flags.has('--remaining')) return 'remaining';
  if (flags.has('--used')) return 'used';
  return store.load().usageMode === 'remaining' ? 'remaining' : 'used';
}
function bar(pct) {
  if (pct == null) return '  (데이터 없음)';
  const remaining = usageMode() === 'remaining';
  const shown = remaining ? Math.max(0, 100 - pct) : pct;
  const n = Math.round(Math.min(100, Math.max(0, shown)) / 5);
  return `[${'#'.repeat(n)}${'.'.repeat(20 - n)}] ${String(Math.round(shown)).padStart(3)}%${remaining ? ' 남음' : ''}`;
}

function profiles(t) {
  const st = store.load();
  return st[t].profiles.map((name) => ({ name, label: store.label(st, t, name), active: name === st[t].active, ...inspectors[t](store.profileHome(t, name)) }));
}
const shown = (p) => (p.label !== p.name ? `${p.label} (${p.name})` : p.name);

function cmdList() {
  const ts = a1 ? [tool(a1)] : TOOLS;
  for (const t of ts) {
    console.log(`${t}:`);
    for (const p of profiles(t)) {
      const id = p.loggedIn ? `${p.email || '이메일 미확인'}${p.plan ? ' · ' + p.plan : ''}` : '(로그인 안 됨)';
      console.log(`  ${p.active ? '*' : ' '} ${pad(shown(p), 14)} ${id}`);
    }
  }
}

function usageRows(t, p) {
  const u = p.usage;
  if (!u) return [];
  if (t === 'claude') {
    const rows = [['5시간', u.fiveHour], ['주간', u.sevenDay], ...(u.extra || []).map((e) => [e.name, e])];
    return rows.map(([l, w]) => ({ label: l, pct: w && w.usedPercent, resetsAt: w && w.resetsAt }));
  }
  if (t === 'gemini') {
    return (u.buckets || []).map((b) => ({ label: b.model.replace(/^gemini-/, '').replace(/-preview.*$/, '(p)'), pct: b.usedPercent, resetsAt: b.resetsAt }));
  }
  const lbl = (w, fb) => (w && w.windowMinutes ? (w.windowMinutes <= 360 ? '5시간' : w.windowMinutes >= 10000 ? '주간' : `${Math.round(w.windowMinutes / 60)}시간`) : fb);
  return [['1차', u.primary], ['2차', u.secondary]].map(([fb, w]) => ({ label: lbl(w, fb), pct: w && w.usedPercent, resetsAt: w && w.resetsAt }));
}

async function cmdUsage() {
  const ts = a1 ? [tool(a1)] : TOOLS;
  const all = flags.has('--all') || a2 === '--all';
  const out = {};
  // --api = manual (60s floor per account); --api --force = per-account force (10s floor, 429 backoff still honoured).
  // With the apiFetch setting on, a plain `usage` behaves like the app's auto mode (freshness window).
  if (flags.has('--api') && !edition.directUsageApi) die('이 배포판은 로컬 사용량 기록만 지원합니다.');
  if (edition.directUsageApi && (flags.has('--api') || store.load().apiFetch)) {
    const ua = require('./usage-api');
    const mode = flags.has('--force') ? 'force' : flags.has('--api') ? 'manual' : 'auto';
    const only = a1 && a2 && a2 !== '--all' ? `${a1}/${a2}` : undefined; // a single named account
    const r = await ua.refreshAll(store, ts, { mode, only });
    for (const t of ts) for (const [n, v] of Object.entries(r[t])) if (v !== 'ok' && !String(v).startsWith('skip:')) console.error(`[api] ${t}/${n}: ${v}`);
    if (!flags.has('--json')) console.error(`[api] ${ua.summarize(r).text}`);
  }
  for (const t of ts) {
    const list = profiles(t).filter((p) => (a2 && a2 !== '--all' ? p.name === a2 || p.label === a2 : all ? true : p.active));
    if (a2 && a2 !== '--all' && list.length === 0) die(`${t}에 프로필 ${a2} 없음`);
    out[t] = list.map((p) => ({ name: p.name, active: p.active, email: p.email, plan: p.plan, usage: p.usage, ...(t === 'codex' ? { credits: p.credits, resetCredits: p.resetCredits } : {}) }));
    if (flags.has('--json')) continue;
    for (const p of list) {
      console.log(`${t} / ${shown(p)}${p.active ? ' (활성)' : ''}  ${p.email || ''}${p.plan ? ' · ' + p.plan : ''}`);
      if (t === 'codex') {
        const c = p.credits, r = p.resetCredits;
        console.log(`  일반 크레딧 ${!c ? '미조회' : c.unlimited ? '무제한' : c.balance ?? (c.hasCredits === false ? '없음' : '미제공')} · ${fmtAge(c?.capturedAt)}`);
        console.log(`  한도 리셋 크레딧 ${r.availableCount !== null ? r.availableCount + '회' : r.status === 'unqueried' ? '미조회' : r.status === 'error' ? '조회 실패' : '미제공'}${r.stale ? ' · 이전 값' : ''} · ${fmtAge(r.capturedAt)}${r.nearestExpiry ? ' · 만료 ' + r.nearestExpiry : ''}`);
      }
      const rows = usageRows(t, p);
      if (!rows.length) {
        console.log({ claude: '  사용량 기록 없음 (설정에서 "사용량 수집"을 켜고 Claude를 한 번 사용하세요)', codex: '  사용량 기록 없음 (이 계정으로 Codex를 한 번 사용하세요)', gemini: '  사용량 기록 없음 (Gemini는 로컬 기록이 없어 API 조회만 가능: usage gemini --api)' }[t]);
        continue;
      }
      for (const r of rows) console.log(`  ${pad(r.label, t === 'gemini' ? 14 : 6)} ${bar(r.pct)}  리셋 ${fmtReset(r.resetsAt)}`);
      const u = p.usage;
      console.log(`  기록 ${fmtAge(u.capturedAt)} (${u.source === 'api' ? 'API' : t === 'claude' ? 'statusline' : '세션 기록'}${u.tier ? ' · ' + u.tier : ''})${u.planType ? ' · ' + u.planType : ''}${u.limitReached ? ' · ' + u.limitReached : ''}`);
    }
  }
  if (flags.has('--json')) console.log(JSON.stringify(out, null, 2));
}

function cmdUse() {
  const t = tool(a1);
  if (!a2) die('계정 이름이 필요합니다');
  const id = store.setActive(t, a2)[t].active;
  const home = store.profileHome(t, id);
  console.log(`${t} → ${a2}${id !== a2 ? ` (${id})` : ''} (${id === 'default' ? P.ENV_VAR[t] + ' 미설정' : P.ENV_VAR[t] + '=' + home})`);
  console.log('새로 실행하는 세션부터 적용됩니다. 이미 열린 세션은 영향받지 않습니다.');
}

function cmdAdd() {
  const t = tool(a1);
  if (!a2) die('계정 이름이 필요합니다');
  const folder = flags.has('--random-folder') ? 'random' : flags.has('--same-folder') ? 'same' : 'auto';
  const r = store.addProfile(t, a2, { shareSettings: !flags.has('--no-share'), folder });
  console.log(`추가됨: ${r.label}${r.id !== r.label ? ` (폴더 ${r.id})` : ''} → ${r.home}`);
  if (r.linked.length) console.log(`공유 링크: ${r.linked.join(', ')}`);
  console.log(`로그인: cli-accounts login ${t} ${JSON.stringify(a2).replace(/^"|"$/g, '')}`);
}

function cmdRm() {
  const t = tool(a1);
  if (!a2) die('프로필 이름이 필요합니다');
  store.removeProfile(t, a2, { deleteFiles: flags.has('--delete-files') });
  console.log(`제거됨: ${a2}${flags.has('--delete-files') ? ' (파일 삭제)' : ' (파일은 남김)'}`);
}

function cmdRename() {
  const t = tool(a1);
  const newLabel = args[3];
  if (!a2 || !newLabel) die('사용법: cli-accounts rename <claude|codex> <현재 이름> <새 이름>');
  const r = store.rename(t, a2, newLabel);
  console.log(`${a2} → ${r.label}  (폴더 이름 ${r.id}은 그대로, 로그인 유지)`);
}

function cmdLogin() {
  const t = tool(a1);
  const st = store.load();
  const name = a2 ? store.resolve(t, a2, st) : st[t].active;
  const home = store.profileHome(t, name);
  require('./launch/profile-resolver').resolveProfile(t, name);
  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const runner = path.join(__dirname, 'launch', 'run.js');
  if (P.IS_WIN) {
    if (/["%!&|<>^\r\n]/.test(runner + name + P.ROOT)) throw new Error('Unsupported Windows login path');
    console.log(`set "CLI_ACCOUNTS_ROOT=${P.ROOT}" && node "${runner}" login ${t} "${name}"`);
  } else console.log(`CLI_ACCOUNTS_ROOT=${quote(P.ROOT)} node ${quote(runner)} login ${t} ${quote(name)}`);
  if (flags.has('--open')) require('./terminal').openLoginTerminal(t, home, name === 'default');
}

function cmdApi() {
  if (!edition.directUsageApi) die('이 배포판은 로컬 사용량 기록만 지원합니다.');
  const ua = require('./usage-api');
  if (a1 === 'on' || a1 === 'off') store.setSetting('apiFetch', a1 === 'on');
  if (a1 === 'interval' && a2) store.setSetting('apiIntervalMinutes', Math.max(1, Number(a2) || ua.DEFAULT_INTERVAL_MIN));
  const s = store.load();
  console.log(`서버 사용량 조회(API): ${s.apiFetch ? '켜짐' : '꺼짐'} · 자동 조회 간격 ${s.apiIntervalMinutes || ua.DEFAULT_INTERVAL_MIN}분`);
  for (const [k, m] of Object.entries(s.apiMeta || {})) {
    const when = (t) => (t ? `${Math.round((Date.now() - t) / 60000)}분 전` : '-');
    console.log(`  ${pad(k, 20)} 마지막 시도 ${when(m.lastAttempt)} · 성공 ${when(m.lastOk)}${m.backoffUntil > Date.now() ? ` · 백오프 ${Math.ceil((m.backoffUntil - Date.now()) / 60000)}분 (${m.lastError})` : ''}`);
  }
}

function cmdDisplay() {
  if (a1 === 'used' || a1 === 'remaining') store.setSetting('usageMode', a1);
  console.log(`사용량 표시: ${store.load().usageMode === 'remaining' ? '남은 비율' : '사용한 비율'}`);
}

function cmdPath() {
  const w = require('./wrappers');
  if (a1 === 'register') {
    const r = w.registerPath();
    console.log(r.alreadyPresent ? `이미 있음: ${r.file}` : `추가됨: ${r.file}\n  ${r.line}${r.backup ? `\n  백업: ${r.backup}` : ''}\n${r.note}`);
  }
  const s = w.pathStatus();
  console.log(`래퍼 경로: ${s.binDir}\n새 터미널 PATH에 포함: ${s.onPath ? '예' : '아니오'} · 실제 바이너리보다 앞: ${s.first ? '예' : '아니오'}`);
  if (!s.first) console.log(`등록: cli-accounts path register  (또는 ${s.shellHint})`);
}

function help() {
  console.log(`cli-accounts <command>
  도구: claude | codex
  run <tool> [--profile <id>] -- <args...>  활성 계정 변경 없이 고정 실행
  dashboard [--port N] [--public-origin URL] 로컬 웹 작업 관리
  tasks                                   독립 작업 서비스와 관리형 위임
  list  [tool]                             계정 목록과 활성 표시
  use   <claude|codex> <name>              활성 계정 전환
  usage [claude|codex] [name|--all] ${edition.directUsageApi ? '[--api [--force]] ' : ''}[--used|--remaining] [--json]   사용량·리셋 시각
${edition.directUsageApi ? '  api   [on|off] | interval <분>           서버 사용량 조회 켜기/끄기 · 자동 조회 간격 · 계정별 조회 이력\n' : ''}  display [used|remaining]                 사용한 비율 / 남은 비율 표시 기본값
  add   <claude|codex> <name> [--no-share] [--same-folder|--random-folder]
                                           계정 추가 (기본: 영문 이름은 폴더도 같게, 한글 등은 임의 폴더)
  rm    <claude|codex> <name> [--delete-files]  계정 제거
  rename <claude|codex> <name> <new-name>  표시 이름 변경 (폴더·로그인은 그대로)
  login <claude|codex> [name] [--open]     로그인 명령 출력 (--open: 새 터미널 창)
  path  [register]                         래퍼 PATH 상태 확인 / 셸 설정에 등록
한 번만 다른 계정으로 실행: CLAUDE_PROFILE=work claude / CODEX_PROFILE=work codex`);
}

(async () => {
  try {
    if (argv[0] === 'run') { await require('./launch/run').runCommand(argv.slice(1)); return; }
    if (argv[0] === 'dashboard') { await require('./dashboard/server').run(argv.slice(1)); return; }
    if (argv[0] === 'tasks') { await require('./runtime/cli').run(argv.slice(1)); return; }
    await ({ list: cmdList, ls: cmdList, use: cmdUse, switch: cmdUse, usage: cmdUsage, api: cmdApi, display: cmdDisplay, path: cmdPath, add: cmdAdd, rm: cmdRm, remove: cmdRm, rename: cmdRename, mv: cmdRename, login: cmdLogin }[cmd] || help)();
  } catch (e) { die(e.message); }
})();
