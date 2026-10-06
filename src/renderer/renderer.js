'use strict';
const $ = (s, r = document) => r.querySelector(s);
const TOOLS = ['claude', 'codex'];
let state = null;

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function rel(epoch) {
  if (!epoch) return '';
  const diff = epoch * 1000 - Date.now();
  if (diff <= 0) return '리셋됨';
  if (diff < 3600e3) return `${Math.ceil(diff / 60e3)}분`;
  if (diff < 86400e3) { const h = Math.floor(diff / 3600e3), m = Math.round((diff % 3600e3) / 60e3); return m ? `${h}시간 ${m}분` : `${h}시간`; }
  return `${Math.floor(diff / 86400e3)}일`;
}
// Short reset countdown for compact rows: 3시간 12분 → 3h, 5일 → 5d, 40분 → 40m
function relShort(epoch) {
  if (!epoch) return '';
  const diff = epoch * 1000 - Date.now();
  if (diff <= 0) return '0';
  if (diff < 3600e3) return `${Math.ceil(diff / 60e3)}m`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}h`;
  return `${Math.floor(diff / 86400e3)}d`;
}
function age(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '시각 미확인';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60e3));
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
}
const cls = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'hi' : '');

// Two windows per tool, normalised to {label, pct, resetsAt}.
function windows(tool, u) {
  if (!u) return [];
  if (tool === 'claude') return [['5h', u.fiveHour], ['주', u.sevenDay]].map(([l, w]) => ({ l, pct: w?.usedPercent, at: w?.resetsAt }));
  if (tool === 'gemini') {
    // Show the most-consumed buckets first; keep the row compact (max 3 lines).
    return (u.buckets || []).filter((b) => b.usedPercent != null).sort((a, b) => b.usedPercent - a.usedPercent).slice(0, 3)
      .map((b) => ({ l: b.model.replace(/^gemini-/, '').replace(/-preview.*$/, '·p'), pct: b.usedPercent, at: b.resetsAt }));
  }
  const lbl = (w, fb) => (w?.windowMinutes ? (w.windowMinutes <= 360 ? '5h' : w.windowMinutes >= 10000 ? '주' : `${Math.round(w.windowMinutes / 60)}h`) : fb);
  return [[u.primary, '1차'], [u.secondary, '2차']].map(([w, fb]) => ({ l: lbl(w, fb), pct: w?.usedPercent, at: w?.resetsAt }));
}

function usageCell(tool, p) {
  const ws = windows(tool, p.usage).filter((w) => w.pct != null);
  const err = state.apiErrors?.[`${tool}/${p.name}`] || state.apiMeta?.[`${tool}/${p.name}`]?.lastError;
  const src = p.usage?.source === 'api' ? 'API' : tool === 'claude' ? 'statusline' : '세션 기록';
  const noLocal = tool === 'gemini' ? ' (로컬 기록 없음 · … → 사용량 지금 조회)' : '';
  if (!ws.length) {
    const title = err ? `API 조회 실패: ${err}` : p.usage ? `기록 ${age(p.usage.capturedAt)}` : `사용량 기록 없음${noLocal}`;
    return `<div class="usage" title="${esc(title)}">${p.usage?.limitReached ? '한도 도달' : err ? '<span class="hi">조회 실패</span>' : '—'}</div>`;
  }
  const remaining = state.usageMode === 'remaining';
  const show = (pct) => Math.round(remaining ? Math.max(0, 100 - pct) : pct);
  const compact = state.density !== 'comfortable';
  const suffix = remaining && !compact ? ' 남음' : ''; // compact: mode is shown in the footer instead
  const lines = ws.map((w) => `<div><span class="${cls(w.pct)}"><b class="num">${show(w.pct)}%</b>${suffix}</span> ${w.l}·<span class="num">${compact ? relShort(w.at) : rel(w.at)}</span></div>`).join('');
  const note = ['claude', 'codex'].includes(tool) ? `<div class="muted">${err ? '이전 값 · 조회 실패 · ' : ''}${esc(age(p.usage.capturedAt))}</div>` : '';
  return `<div class="usage" title="${remaining ? '남은 한도' : '사용률'} · 리셋까지 남은 시간 (${src}, ${age(p.usage.capturedAt)})${err ? ' · API 조회 실패: ' + esc(err) : ''}">${lines}${note}</div>`;
}

function creditCell(tool, p) {
  if (tool !== 'codex' || !p.loggedIn) return '';
  const c = p.credits;
  const err = state.apiErrors?.[`${tool}/${p.name}`] || state.apiMeta?.[`${tool}/${p.name}`]?.lastError;
  const stale = c && (!c.capturedAt || Date.now() - Date.parse(c.capturedAt) > 86400000 || err);
  const value = !c ? '미조회' : c.unlimited ? '무제한' : c.balance != null ? Number(c.balance).toLocaleString('ko-KR', {maximumFractionDigits: 20}) : c.hasCredits === false ? '없음' : '미제공';
  const note = c ? `${stale ? '이전 값 · ' : ''}${age(c.capturedAt)}` : '계정 메뉴에서 지금 조회';
  const r = p.resetCredits;
  const known = Number.isSafeInteger(r?.availableCount) && r.availableCount >= 0;
  const previous = known && (r.stale || r.status === 'error');
  const count = known ? `${r.availableCount.toLocaleString('ko-KR')}개` : r?.status === 'error' ? '조회 실패' : r?.status === 'unavailable' ? '미제공' : '미조회';
  const resetNote = r?.status === 'error' ? `${known ? '이전 값 · ' : ''}조회 실패${r.capturedAt ? ' · ' + age(r.capturedAt) : ''}` : known ? `${previous ? '이전 값 · ' : ''}${age(r.capturedAt) || '시각 미확인'}` : r?.status === 'unavailable' ? '계정에서 정보 미제공' : '계정 메뉴에서 지금 조회';
  const expiry = known && r.nearestExpiry && Number.isFinite(Date.parse(r.nearestExpiry)) ? `만료 예정 ${new Date(r.nearestExpiry).toLocaleString('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}` : '';
  return `<div class="resources" id="resources-${esc(p.name)}">
    <div class="resource${!c || (c.balance == null && !c.unlimited) ? ' unknown' : ''}" title="제공된 크레딧 잔액 · 통화나 토큰으로 환산하지 않음"><span class="resource-label">일반 크레딧</span><b class="num">${esc(value)}</b><span class="resource-note">${esc(note)}</span></div>
    <div class="resource reset-credits${previous ? ' stale' : ''}${!known ? ' unknown' : ''}"><span class="resource-label">리셋권</span><b class="num">${esc(count)}</b><span class="resource-note">${esc(resetNote)}</span>${expiry ? `<span class="resource-note expiry">${esc(expiry)}</span>` : ''}</div>
  </div>`;
}
function row(tool, p, active) {
  const on = p.name === active;
  const idLine = p.loggedIn ? esc(p.email || '이메일 미확인') : '로그인 필요';
  const shown = p.label || p.name;
  return `<div class="row" role="radio" tabindex="0" aria-checked="${on}" data-name="${esc(p.name)}" aria-label="${esc(shown)} ${on ? '사용 중' : '전환'}"${tool === 'codex' && p.loggedIn ? ` aria-describedby="resources-${esc(p.name)}"` : ''}>
    <span class="check">${ICON.check}</span>
    <div class="id"><div class="name"><span class="label" title="${esc([p.isDefault ? '기본 홈 (원래 설정 폴더)' : '', p.name !== shown ? '폴더: ' + p.name : ''].filter(Boolean).join(' · '))}">${esc(shown)}</span>${p.isDefault ? '<span class="tag">기본</span>' : ''}${p.plan ? `<span class="plan" title="${esc(p.planDetail || (p.planUntil ? '갱신/만료 ' + new Date(p.planUntil).toLocaleDateString('ko-KR') : ''))}">${esc(p.plan)}</span>` : ''}</div><div class="email ${p.loggedIn ? '' : 'warn'}" title="${esc(p.email || '')}">${idLine}</div></div>
    ${p.loggedIn ? usageCell(tool, p) : `<button class="btn small login">로그인</button>`}
    <button class="iconbtn more" aria-label="${esc(p.name)} 더 보기" aria-haspopup="menu" aria-expanded="false">${ICON.more}</button>
    ${creditCell(tool, p)}
  </div>`;
}

function render() {
  if (!state) return;
  document.body.classList.toggle('compact', state.density !== 'comfortable');
  for (const tool of TOOLS) {
    const t = state.tools[tool];
    const list = $(`#${tool} .list`);
    list.innerHTML = t.profiles.map((p) => row(tool, p, t.active)).join('');
    list.querySelectorAll('.row').forEach((el) => {
      const name = el.dataset.name;
      const p = t.profiles.find((x) => x.name === name);
      const sw = () => { if (el.getAttribute('aria-checked') !== 'true') run(() => api.setActive(tool, name), `${tool} → ${name}`); };
      el.onclick = (e) => { if (!e.target.closest('button')) sw(); };
      el.onkeydown = (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sw(); } };
      const login = el.querySelector('.login'); if (login) login.onclick = () => run(() => api.login(tool, name), '터미널에서 로그인을 마치면 자동으로 채워집니다');
      el.querySelector('.more').onclick = (e) => openMenu(e.currentTarget, [
        { label: p.loggedIn ? '다시 로그인' : '로그인', act: () => run(() => api.login(tool, name), '터미널에서 로그인을 마치면 자동으로 갱신됩니다') },
        ...(state.directUsageApi ? [{ label: tool === 'codex' ? '사용량 · 크레딧 · 리셋권 조회' : '사용량 지금 조회 (API)', act: () => runMsg(() => api.apiRefreshOne(tool, name)) }] : []),
        { label: '이름 변경', act: () => startRename(el, tool, name, p.label || p.name) },
        { label: '설정 폴더 열기', act: () => api.openHome(tool, name) },
        ...(p.isDefault ? [] : [{ hr: true }, { label: '제거…', danger: true, act: () => run(() => api.removeProfile(tool, name), '') }]),
      ]);
    });
  }
  const ps = state.pathStatus; const b = $('#pathBanner');
  if (ps.first) b.hidden = true;
  else {
    b.hidden = false;
    b.innerHTML = `<span title="${esc(ps.shellHint)}">새 터미널의 PATH에 래퍼가 없어 전환이 적용되지 않습니다.</span><button class="btn small primary" id="regPath">PATH에 등록</button><button class="btn small" id="copyHint" title="${esc(ps.shellHint)}">복사</button>`;
    $('#regPath').onclick = () => runMsg(() => api.registerPath());
    $('#copyHint').onclick = () => run(() => api.copy(ps.shellHint.replace(/^.*?: /, '')), '복사됨 · 셸 설정 파일에 붙여넣고 새 터미널을 여세요');
  }
  const iv = state.apiIntervalMinutes;
  const srcs = [state.usageHook ? 'statusline' : null, state.apiFetch ? `API ${iv >= 60 ? iv / 60 + '시간' : iv + '분'} 간격` : null].filter(Boolean);
  $('#hookDot').className = 'dot ' + (srcs.length ? 'on' : '');
  const modeNote = state.usageMode === 'remaining' ? '남은 비율 · ' : '';
  $('#hookText').textContent = modeNote + (srcs.length ? `출처: 세션 기록 · ${srcs.join(' · ')}` : '출처: 세션 기록만');
  fit();
}

// Report natural content height so the window shrinks/grows to fit.
function fit() {
  if (menuEl) return; // a menu may have borrowed extra height; don't shrink under it
  const panel = $('#panel'); panel.classList.add('fit');
  const h = panel.getBoundingClientRect().height + 2;
  panel.classList.remove('fit');
  api.resize(h);
}

// Inline rename: swap the label for an input; Enter saves, Esc/blur cancels.
function startRename(rowEl, tool, name, current) {
  const span = rowEl.querySelector('.label');
  const input = document.createElement('input');
  input.className = 'rename'; input.value = current; input.setAttribute('aria-label', '새 이름');
  span.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== current) await run(() => api.rename(tool, name, v), `${current} → ${v}`);
    else { state = await api.state(); render(); }
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(false);
  input.onclick = (e) => e.stopPropagation();
}

let menuEl = null;
function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; fit(); } // fit(): give back any height borrowed for the menu
  document.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
function openMenu(anchor, items) {
  closeMenu();
  anchor.setAttribute('aria-expanded', 'true');
  menuEl = document.createElement('div'); menuEl.className = 'menu'; menuEl.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.hr) { menuEl.appendChild(document.createElement('hr')); continue; }
    const btn = document.createElement('button'); btn.setAttribute('role', 'menuitem'); btn.className = it.danger ? 'danger' : '';
    btn.innerHTML = (it.html || esc(it.label)) + (it.k ? `<span class="k">${esc(it.k)}</span>` : '');
    btn.onclick = () => { closeMenu(); it.act(); };
    menuEl.appendChild(btn);
  }
  document.body.appendChild(menuEl);
  const r = anchor.getBoundingClientRect(); const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
  // Always open downward. The panel is sized to its content, so a tall menu may not fit:
  // ask the main process to grow the window for as long as the menu is open (fit() restores it
  // on close). If the screen itself is too short, clamp inside the viewport and scroll the menu.
  const need = r.bottom + 4 + mh + 8;
  menuEl.style.top = (r.bottom + 4) + 'px';
  if (need > window.innerHeight) {
    api.resize(need).then(() => setTimeout(() => {
      if (!menuEl) return;
      const avail = window.innerHeight - (r.bottom + 4) - 8;
      if (avail < mh) { menuEl.style.maxHeight = Math.max(120, avail) + 'px'; menuEl.style.overflowY = 'auto'; }
    }, 30));
  }
  menuEl.querySelector('button').focus();
}
document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target) && !e.target.closest('[aria-haspopup]')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (menuEl) closeMenu(); else api.hide(); } });

let msgTimer = null;
function say(text, err) {
  const m = $('#msg'); m.textContent = text || ''; m.style.color = err ? '#f87171' : '';
  clearTimeout(msgTimer); if (text) msgTimer = setTimeout(() => { m.textContent = ''; }, 4000);
}
async function run(fn, okMsg) {
  try { await fn(); say(okMsg); }
  catch (e) { say(e.message.replace(/^Error invoking remote method '\w+': Error: /, ''), true); }
  state = await api.state(); render();
}

for (const tool of TOOLS) {
  const add = $(`#${tool} .addrow`); const input = add.querySelector('input:not([type=checkbox])'); const same = add.querySelector('.samefolder');
  let userTouchedSame = false;
  same.onchange = () => { userTouchedSame = true; };
  // Non-ASCII names default to a random ASCII folder so paths stay portable (Windows shims, tooling).
  input.oninput = () => { if (!userTouchedSame) same.checked = /^[\x20-\x7E]*$/.test(input.value); };
  const reset = () => { add.classList.remove('open'); input.value = ''; same.checked = true; userTouchedSame = false; fit(); };
  add.querySelector('.link').onclick = () => { add.classList.add('open'); input.focus(); fit(); };
  add.querySelector('.cancel').onclick = reset;
  add.querySelector('form').onsubmit = (e) => {
    e.preventDefault(); const v = input.value.trim(); if (!v) return;
    const folder = same.checked ? 'same' : 'random';
    // Add the account home, then immediately open the login terminal for it (by folder id).
    run(async () => { const r = await api.addProfile(tool, v, { shareSettings: true, folder }); await api.login(tool, r.id); },
      `${v} 추가됨${folder === 'random' ? '' : ''} · 터미널에서 로그인을 마치면 이메일과 사용량이 자동으로 채워집니다`).then(reset);
  };
}

const CHECK = (on) => (on ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"></svg>');
$('#settingsBtn').onclick = (e) => openMenu(e.currentTarget, [
  { html: CHECK(state?.usageHook) + 'Claude 사용량 수집 (statusline)', act: () => run(() => api.usageHook(!state.usageHook), state?.usageHook ? '수집을 껐습니다' : '다음 Claude 응답부터 기록됩니다') },
  ...(state?.directUsageApi ? [{ html: CHECK(state?.apiFetch) + '서버에서 사용량 조회 (API)', act: () => runMsg(() => api.setApiFetch(!state.apiFetch)) }] : []),
  ...(state?.apiFetch ? [15, 30, 60, 180].map((m) => ({ html: CHECK(state.apiIntervalMinutes === m) + `　자동 조회 간격 ${m >= 60 ? m / 60 + '시간' : m + '분'}`, act: () => run(() => api.setApiInterval(m), '') })) : []),
  { hr: true },
  { html: CHECK(state?.usageMode !== 'remaining') + '사용한 비율로 표시', act: () => run(() => api.setUsageMode('used'), '') },
  { html: CHECK(state?.usageMode === 'remaining') + '남은 비율로 표시', act: () => run(() => api.setUsageMode('remaining'), '') },
  { hr: true },
  { html: CHECK(state?.density !== 'comfortable') + '촘촘하게 (한 줄)', act: () => run(() => api.setDensity('compact'), '') },
  { html: CHECK(state?.density === 'comfortable') + '넉넉하게 (두 줄)', act: () => run(() => api.setDensity('comfortable'), '') },
  { hr: true },
  ...(state?.zooms || [1, 1.1, 1.25, 1.5]).map((z) => ({ html: CHECK(state?.zoom === z) + `글자 크기 ${Math.round(z * 100)}%`, act: () => run(() => api.setZoom(z), '') })),
  { hr: true },
  { label: '셸 래퍼 재설치', act: () => run(() => api.installShims(), '래퍼를 다시 설치했습니다') },
  { label: '새로고침', k: '⌘R', act: refreshNow },
  { hr: true },
  { label: '종료', act: () => api.quit() },
]);
// Like run(), but the resolved value is the status message.
async function runMsg(fn) {
  try { const msg = await fn(); say(typeof msg === 'string' ? msg : ''); }
  catch (e) { say(e.message.replace(/^Error invoking remote method '\w+': Error: /, ''), true); }
  state = await api.state(); render();
}
let refreshing = false;
async function refreshNow() {
  if (refreshing) return;
  refreshing = true; const btn = $('#refreshBtn'); btn.classList.add('spin'); btn.disabled = true;
  try {
    if (state?.apiFetch) { say('API 조회 중…'); await runMsg(() => api.apiRefresh()); }
    else await run(() => Promise.resolve(), '갱신됨');
  } finally { refreshing = false; btn.classList.remove('spin'); btn.disabled = false; }
}
$('#refreshBtn').onclick = refreshNow;
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'r') { e.preventDefault(); refreshNow(); } });

api.onState((s) => { state = s; render(); });
api.state().then((s) => {
  state = s; render();
  // Dev aid: index.html#menu opens the settings menu right away (used by --screenshot-menu).
  if (location.hash === '#menu') setTimeout(() => $('#settingsBtn').click(), 200);
});
// Local state is pushed every 30 seconds by the main process, even when hidden.
