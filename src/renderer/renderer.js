'use strict';
const $ = (s, r = document) => r.querySelector(s);
const TOOLS = ['claude', 'codex'];
// API-key provider categories; each has a <section id="<id>"> and a state[<id>] snapshot.
const PROVIDERS = ['exaone', 'gemini-api'];
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
  const lines = ws.map((w) => `<div class="usage-window ${cls(w.pct)}"><span class="window-label">${esc(w.l)}</span><span class="window-value num">${show(w.pct)}%${suffix}</span><span class="reset-time num">${compact ? relShort(w.at) : rel(w.at)}</span><span class="usage-track" aria-hidden="true"><span class="usage-fill" style="width:${Math.min(100,Math.max(0,show(w.pct)))}%"></span></span></div>`).join('');
  const note = ['claude', 'codex'].includes(tool) ? `<div class="usage-note">${err ? '이전 값 · 조회 실패 · ' : ''}${esc(age(p.usage.capturedAt))}</div>` : '';
  return `<div class="usage" title="${remaining ? '남은 한도' : '사용률'} · 리셋까지 남은 시간 (${src}, ${age(p.usage.capturedAt)})${err ? ' · API 조회 실패: ' + esc(err) : ''}">${lines}${note}</div>`;
}

// API-key accounts: month-to-date organization spend via a separate admin key (plain keys cannot read billing).
function costCell(tool, p) {
  const c = p.apiCost;
  if (!c) return '<div class="usage" title="사용량 기록 없음">—</div>';
  const month = Number(String(c.month).slice(5)) || '';
  const usd = (v) => (v < 0 ? '-$' : '$') + Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const slot = (label, value, note, title, cls = '') => `<div class="usage-window cost${cls}" title="${esc(title)}"><span class="window-label">${esc(label)}</span><span class="window-value num">${esc(value)}</span><span class="reset-time">${esc(note)}</span></div>`;
  // Slot 1: this month's spend — the organization total with an admin key, otherwise this Mac's Claude Code sessions.
  let spend;
  if (c.adminKey) {
    // 403: the key is valid but its account lacks the organization admin permission; 401: the key itself was rejected.
    const denied = /^HTTP 403/.test(c.error || ''), rejected = /^HTTP 401/.test(c.error || '');
    const failed = denied ? '권한 없음' : rejected ? '키 오류' : '조회 실패';
    const fix = denied ? ` · 조직 관리자 권한이 필요합니다: ${c.org === 'Anthropic' ? '개인(Individual) Console 계정은 Organization 페이지에서 조직을 설정한 뒤 관리자 키(sk-ant-admin…)를 등록하세요' : '조직 소유자의 관리자 키(sk-admin-…)를 등록하세요'}` : rejected ? ' · 키가 거부되었습니다. 관리자 키를 다시 확인하세요' : '';
    const orgOk = c.amountUsd != null;
    const local = !orgOk && c.local ? c.local : null; // fall back to this Mac while the organization lookup fails
    const value = orgOk ? usd(c.amountUsd) : local ? usd(local.monthUsd) : c.pending ? '조회 중…' : c.error ? failed : '미조회';
    const note = c.pending ? '조회 중' : orgOk ? (c.error ? '이전 값' : c.capturedAt ? age(c.capturedAt) : '') : local ? '이 PC' : '';
    const title = `${orgOk ? `${c.org} 조직` : local ? '이 PC의 Claude Code' : c.org + ' 조직'} ${month}월 사용 금액 (UTC 기준 · 관리자 키 ${c.masked || ''})${c.capturedAt ? ' · ' + age(c.capturedAt) : ''}${c.error ? ' · 조직 조회 실패: ' + c.error + fix : ''}`;
    spend = slot(`${month}월 사용`, value, note, title, c.error && !orgOk && !local ? ' hi' : '');
  } else if (c.local) {
    spend = slot(`${month}월 사용`, usd(c.local.monthUsd), '이 PC', `이 PC의 Claude Code 세션 ${c.local.sessions}개가 보고한 ${month}월 사용 금액 (UTC 기준 · Claude Code 자체 계산) · 다른 기기나 API 직접 호출은 빠집니다 · 조직 전체 금액은 관리자 키로 조회`);
  } else if (tool === 'claude') {
    spend = slot(`${month}월 사용`, '—', '', '설정의 \'Claude 사용량 수집 (statusline)\'을 켜면 이 PC에서 이 계정으로 쓴 Claude Code 사용 금액을 합산합니다. 조직 전체 금액은 관리자 키를 등록하세요 (개인 Console 계정은 조직 설정 필요).');
  } else {
    return `<div class="usage api-cost single"><button class="btn small admin-key" title="${esc(c.org)} 관리자 키(${esc(c.keyHint)})를 등록하면 이번 달 조직 사용 금액을 보여 줍니다. 일반 API 키로는 조회할 수 없고, 충전 잔액은 어느 API로도 제공되지 않습니다.">사용 금액 연결</button></div>`;
  }
  if (tool !== 'claude') return `<div class="usage api-cost single">${spend}</div>`;
  // Slot 2 (Claude): balance entered from the Console Billing page minus this Mac's spend since then.
  const b = c.balance;
  const balance = b
    ? slot('잔액≈', usd(b.estimateUsd), `기준 ${age(b.at)}`, `추정 잔액 = 입력한 잔액 ${usd(b.baseUsd)} (${new Date(b.at).toLocaleString('ko-KR')}) − 이후 이 PC의 Claude Code 사용 ${usd(b.spentSinceUsd)} · 다른 기기·API 직접 호출·자동 충전은 반영되지 않으니 Console Billing에서 가끔 다시 입력하세요`, b.estimateUsd < 5 ? ' crit' : b.estimateUsd < 20 ? ' hi' : '')
    : `<button class="btn small balance-set" title="Console Billing 페이지의 현재 잔액을 입력하면 이후 이 PC의 Claude Code 사용 금액을 빼서 추정 잔액을 보여 줍니다 (잔액은 API로 제공되지 않음)">잔액 입력</button>`;
  return `<div class="usage api-cost">${spend}${balance}</div>`;
}

function creditCell(tool, p) {
  // API-key Codex accounts have no ChatGPT credits or reset credits; keep the row to its identity line.
  if (tool !== 'codex' || !p.loggedIn || p.apiKey?.apiKey) return '';
  const compact = state.density !== 'comfortable';
  const c = p.credits;
  const err = state.apiErrors?.[`${tool}/${p.name}`] || state.apiMeta?.[`${tool}/${p.name}`]?.lastError;
  const stale = c && (!c.capturedAt || Date.now() - Date.parse(c.capturedAt) > 86400000 || err);
  const value = !c ? '미조회' : c.unlimited ? '무제한' : c.balance != null ? Number(c.balance).toLocaleString('ko-KR', {maximumFractionDigits: 20}) : c.hasCredits === false ? '없음' : '미제공';
  const note = c ? `${stale ? '이전 값 · ' : ''}${age(c.capturedAt)}` : '계정 메뉴에서 지금 조회';
  const r = p.resetCredits;
  const known = Number.isSafeInteger(r?.availableCount) && r.availableCount >= 0;
  const previous = known && (r.stale || r.status === 'error');
  const count = known ? `${r.availableCount.toLocaleString('ko-KR')}개` : r?.status === 'error' ? '조회 실패' : r?.status === 'unavailable' ? '미제공' : '미조회';
  const resetNote = r?.status === 'error' ? `${known ? '이전 값 · ' : ''}조회 실패${r.capturedAt ? ' · ' + age(r.capturedAt) : ''}` : known ? `${previous ? '이전 값 · ' : ''}${age(r.capturedAt) || '시각 미확인'}` : r?.status === 'unavailable' ? '계정에서 정보 미제공' : '조회를 눌러 확인';
  const expiryAt = known && r.nearestExpiry && Number.isFinite(Date.parse(r.nearestExpiry)) ? new Date(r.nearestExpiry) : null;
  const expiry = !expiryAt ? '' : compact ? `만료 ${expiryAt.getMonth() + 1}/${expiryAt.getDate()} ${String(expiryAt.getHours()).padStart(2, '0')}:${String(expiryAt.getMinutes()).padStart(2, '0')}` : `만료 예정 ${expiryAt.toLocaleString('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`;
  const automatic = p.resetAutoUse;
  const last = automatic?.lastResult;
  const used = last?.usedAt ? `최근 사용 ${new Date(last.usedAt).toLocaleString('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})} · ${last.resetConfirmed === true ? '초기화 확인' : '초기화 미확인'}` : last?.apiOutcome === 'alreadyRedeemed' ? '이미 처리된 사용 확인 · 시각 미제공' : '';
  const autoTitle = '앱이 실행 중일 때 만료 10분 전부터 사용을 요청합니다. 최초 포함 최대 3회, 1분 간격이며 성공하면 중단합니다.';
  const autoNote = automatic?.enabled ? `<span class="resource-note auto-reset" title="${autoTitle}">${compact ? '자동 사용' : '자동 사용 켜짐 · 만료 10분 전'}</span>${automatic.text && automatic.status !== 'waiting' ? `<span class="resource-note auto-text">${esc(automatic.text)}</span>` : ''}` : '';
  // Compact keeps one line: the collection-time notes move into the tooltip and stale values get a short visible marker.
  const prev = (on) => (on ? '<span class="resource-note prev">이전 값</span>' : '');
  const title = compact ? ` title="일반 크레딧 ${esc(value)} · ${esc(note)} / 리셋권 ${esc(count)} · ${esc(resetNote)}${used ? ' / ' + esc(used) : ''}"` : '';
  return `<div class="resources" id="resources-${esc(p.name)}"${title}>
    <div class="resource${!c || (c.balance == null && !c.unlimited) ? ' unknown' : ''}" title="제공된 크레딧 잔액 · 통화나 토큰으로 환산하지 않음"><span class="resource-label">일반 크레딧</span><b class="num">${esc(value)}</b>${prev(Boolean(c && stale))}<span class="resource-note">${esc(note)}</span></div>
    <div class="resource reset-credits${previous ? ' stale' : ''}${!known ? ' unknown' : ''}"><span class="resource-label">리셋권</span><b class="num">${esc(count)}</b>${prev(previous)}<span class="resource-note">${esc(resetNote)}</span>${expiry ? `<span class="resource-note expiry">${esc(expiry)}</span>` : ''}${autoNote}${used ? `<span class="resource-note">${esc(used)}</span>` : ''}<span class="reset-actions"><button class="btn small reset-check" title="공식 codex app-server로 리셋권 개수와 만료 시각을 조회합니다">조회</button><button class="btn small reset-use"${known && r.availableCount === 0 ? ' disabled' : ''} title="가장 먼저 만료되는 리셋권 1개를 지금 사용해 한도를 초기화합니다">지금 사용</button></span></div>
  </div>`;
}
function row(tool, p, active) {
  const on = p.name === active;
  const keyed = Boolean(p.apiKey?.apiKey);
  const idLine = keyed ? `API 키${p.apiKey.masked ? ' ' + esc(p.apiKey.masked) : ''}` : p.loggedIn ? esc(p.email || '이메일 미확인') : '로그인 필요';
  const shown = p.label || p.name;
  return `<div class="row" role="radio" tabindex="0" aria-checked="${on}" data-name="${esc(p.name)}" aria-label="${esc(shown)} ${on ? '사용 중' : '전환'}"${tool === 'codex' && p.loggedIn && !keyed ? ` aria-describedby="resources-${esc(p.name)}"` : ''}>
    <span class="check">${ICON.check}</span>
    <div class="id"><div class="name"><span class="label" title="${esc([p.isDefault ? '기본 홈 (원래 설정 폴더)' : '', p.name !== shown ? '폴더: ' + p.name : '', p.loggedIn && !keyed ? p.email || '' : ''].filter(Boolean).join(' · '))}">${esc(shown)}</span>${p.isDefault ? '<span class="tag">기본</span>' : ''}${p.plan ? `<span class="plan" title="${esc(p.planDetail || (p.planUntil ? '갱신/만료 ' + new Date(p.planUntil).toLocaleDateString('ko-KR') : ''))}">${esc(p.plan)}</span>` : ''}</div><div class="email ${p.loggedIn ? '' : 'warn'}" title="${esc(p.email || '')}">${idLine}</div></div>
    ${keyed ? costCell(tool, p) : p.loggedIn ? usageCell(tool, p) : `<span class="login-actions"><button class="btn small login">로그인</button><button class="btn small keyset" title="구독 로그인 대신 API 키로 인증">API 키</button></span>`}
    <button class="iconbtn more" aria-label="${esc(p.name)} 더 보기" aria-haspopup="menu" aria-expanded="false">${ICON.more}</button>
    ${creditCell(tool, p)}
  </div>`;
}

function render() {
  if (!state) return;
  document.body.classList.toggle('compact', state.density !== 'comfortable');
  $('#account-count').textContent = (TOOLS.reduce((n, tool) => n + (state.tools[tool]?.profiles.length || 0), 0) + (state.antigravity?.accounts.length || 0) + PROVIDERS.reduce((n, id) => n + (state[id]?.accounts.length || 0), 0)) + '개 계정';
  renderAntigravity();
  for (const id of PROVIDERS) renderProvider(id);
  for (const tool of TOOLS) {
    const t = state.tools[tool];
    const list = $(`#${tool} .list`);
    list.innerHTML = t.profiles.map((p) => row(tool, p, t.active)).join('');
    list.querySelectorAll('.row').forEach((el) => {
      const name = el.dataset.name;
      const p = t.profiles.find((x) => x.name === name);
      const sw = () => { if (el.getAttribute('aria-checked') !== 'true') run(() => api.setActive(tool, name), `${tool} → ${name}`); };
      el.onclick = (e) => { if (!e.target.closest('button, input, form')) sw(); };
      el.onkeydown = (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sw(); } };
      const resetCheck = el.querySelector('.reset-check'); if (resetCheck) resetCheck.onclick = () => checkReset(resetCheck, name);
      const resetUse = el.querySelector('.reset-use'); if (resetUse) resetUse.onclick = () => useReset(resetUse, p);
      const keyset = el.querySelector('.keyset'); if (keyset) keyset.onclick = () => startKeyEntry(el, tool, name);
      const adminKey = el.querySelector('.admin-key'); if (adminKey) adminKey.onclick = () => startKeyEntry(el, tool, name, 'admin');
      const balanceSet = el.querySelector('.balance-set'); if (balanceSet) balanceSet.onclick = () => startBalanceEntry(el, tool, name);
      const login = el.querySelector('.login'); if (login) login.onclick = () => run(() => api.login(tool, name), '터미널에서 로그인을 마치면 자동으로 채워집니다');
      el.querySelector('.more').onclick = (e) => openMenu(e.currentTarget, [
        { label: p.loggedIn ? '다시 로그인' : '로그인', act: () => run(() => api.login(tool, name), '터미널에서 로그인을 마치면 자동으로 갱신됩니다') },
        ...(state.directUsageApi ? [{ label: tool === 'codex' ? '사용량 · 크레딧 · 리셋권 조회' : '사용량 지금 조회 (API)', act: () => runMsg(() => api.apiRefreshOne(tool, name)) }] : []),
        ...(tool === 'codex' ? [
          { html: CHECK(p.resetAutoUse?.enabled) + '만료 10분 전 리셋권 자동 사용', checked: Boolean(p.resetAutoUse?.enabled), disabled: !p.loggedIn && !p.resetAutoUse?.enabled,
            title: '앱이 켜져 있을 때만 동작합니다. 사용 시각과 초기화 확인 결과를 로그에 남깁니다.', act: () => runMsg(() => api.setResetAutoUse(name, !p.resetAutoUse?.enabled)) },
          { label: '리셋권 조회', disabled: !p.loggedIn, act: () => checkReset(null, name) },
          { label: '리셋권 지금 사용…', disabled: !p.loggedIn || p.resetCredits?.availableCount === 0, act: () => useReset(null, p) },
          { label: '리셋권 자동 사용 로그 파일 보기', act: () => runMsg(() => api.openResetAutoUseLog(name)) },
        ] : []),
        { label: p.apiKey?.apiKey ? 'API 키 변경…' : 'API 키 등록…', title: '구독 로그인 대신 API 키로 인증합니다 (API 사용량 과금)', act: () => startKeyEntry(el, tool, name) },
        ...(p.apiKey?.apiKey ? [{ label: 'API 키 제거', act: () => runMsg(() => api.removeApiKey(tool, name)) }] : []),
        ...(p.apiKey?.apiKey && p.apiCost ? [
          { label: p.apiCost.adminKey ? '사용 금액 관리자 키 변경…' : '사용 금액 관리자 키 등록…', title: `${p.apiCost.org} 관리자 키로 이번 달 조직 사용 금액을 조회합니다 (일반 API 키로는 조회 불가)`, act: () => startKeyEntry(el, tool, name, 'admin') },
          ...(p.apiCost.adminKey ? [
            { label: '사용 금액 지금 조회', act: () => runMsg(() => api.apiCost('refresh', tool, name)) },
            { label: '관리자 키 제거', act: () => runMsg(() => api.apiCost('removeKey', tool, name)) },
          ] : []),
          ...(tool === 'claude' ? [
            { label: p.apiCost.balance ? '잔액 다시 입력…' : '충전 잔액 입력…', title: 'Console Billing 페이지의 현재 잔액을 입력하면 이 PC의 Claude Code 사용 금액을 빼서 추정합니다', act: () => startBalanceEntry(el, tool, name) },
            ...(p.apiCost.balance ? [{ label: '잔액 기준 지우기', act: () => runMsg(() => api.apiCost('clearBalance', tool, name)) }] : []),
          ] : []),
        ] : []),
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

// Short form for the row; the full text (with rate-limit counts) goes into the row title.
function exaoneCheckLine(c, full = false) {
  if (!c) return '연결 미확인';
  const when = new Date(c.checkedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (!c.ok) return `연결 실패 ${when} · ${c.error}`;
  const m = c.rateLimit?.minute, d = c.rateLimit?.day;
  const rate = [m && m.remaining != null ? `분 ${m.remaining}/${m.limit ?? '?'}` : null, d && d.remaining != null ? `일 ${d.remaining}/${d.limit ?? '?'}` : null].filter(Boolean).join(' · ');
  return `연결 확인 ${when}${full && rate ? ' · 남은 호출 ' + rate : ''}`;
}
// API-key provider accounts (exaone, gemini-api): no login, no CLI home. The key never reaches the renderer.
// An API-key category with no accounts stays out of the panel; the settings menu offers "<이름> 계정 추가…".
function providerName(id) { return state?.[id]?.label || $(`#${id} > h2`)?.textContent || id; }
function syncProviderVisibility(id) {
  const section = $(`#${id}`); if (!section) return;
  section.hidden = !(state?.[id]?.accounts?.length) && !section.querySelector('.addrow.open');
}
function showProviderAdd(id) {
  const section = $(`#${id}`); if (!section) return;
  const add = section.querySelector('.addrow');
  section.hidden = false; add.classList.add('open'); add.querySelector('input').focus(); fit();
}
function renderProvider(id) {
  const ex = state[id] || { accounts: [], envNames: [] };
  const keyVars = (ex.envNames || []).filter((n) => /_API_KEY$/.test(n)).join('·');
  const list = $(`#${id} .list`);
  if (!list) return;
  syncProviderVisibility(id);
  list.innerHTML = ex.accounts.length ? ex.accounts.map((a) => {
    const on = a.active;
    const keyed = Boolean(a.apiKey?.apiKey);
    const shown = a.label || a.name;
    return `<div class="row" role="radio" tabindex="0" aria-checked="${on}" data-name="${esc(a.name)}" aria-label="${esc(shown)} ${on ? '사용 중' : '전환'}">
    <span class="check">${ICON.check}</span>
    <div class="id"><div class="name"><span class="label" title="${esc(a.name !== shown ? 'ID: ' + a.name : '')}">${esc(shown)}</span></div><div class="email" title="${esc(keyed ? exaoneCheckLine(a.check, true) : 'API 키를 등록하면 연결 확인과 실행을 쓸 수 있습니다')}">${keyed ? `API 키${a.apiKey.masked ? ' ' + esc(a.apiKey.masked) : ''} · ${esc(exaoneCheckLine(a.check, state.density === 'comfortable'))}` : 'API 키 필요'}</div></div>
    ${keyed ? '' : '<span class="login-actions"><button class="btn small keyset" title="${esc(ex.label || id)} API 키 등록">API 키</button></span>'}
    <button class="iconbtn more" aria-label="${esc(a.name)} 더 보기" aria-haspopup="menu" aria-expanded="false">${ICON.more}</button>
  </div>`;
  }).join('') : '<p class="hint">계정이 없습니다. 계정을 추가한 뒤 API 키를 등록하세요.</p>';
  for (const el of list.querySelectorAll('.row')) {
    const name = el.dataset.name;
    const a = ex.accounts.find((x) => x.name === name);
    const sw = () => { if (el.getAttribute('aria-checked') !== 'true') run(() => api.provider(id, 'setActive', name), `${id} → ${a.label || name}`); };
    el.onclick = (e) => { if (!e.target.closest('button, input, form')) sw(); };
    el.onkeydown = (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sw(); } };
    const keyset = el.querySelector('.keyset'); if (keyset) keyset.onclick = () => startKeyEntry(el, id, name);
    el.querySelector('.more').onclick = (e) => openMenu(e.currentTarget, [
      { label: a.apiKey?.apiKey ? 'API 키 변경…' : 'API 키 등록…', title: `실행 시 ${keyVars}로 주입합니다 (API 사용량 과금)`, act: () => startKeyEntry(el, id, name) },
      ...(a.apiKey?.apiKey ? [
        { label: `연결 확인 (${ex.checkPath || '모델 목록'})`, act: () => runMsg(() => api.provider(id, 'check', name)) },
        { label: 'API 키 제거', act: () => runMsg(() => api.provider(id, 'removeKey', name)) },
      ] : []),
      { label: '실행 명령 복사', title: `cli-accounts ${id} run <계정> -- <명령>`, act: () => run(() => api.copy(`cli-accounts ${id} run ${name} -- `), '복사됨 · 뒤에 실행할 명령을 붙이세요') },
      { label: 'API 문서 열기', act: () => api.provider(id, 'openDocs') },
      { label: '이름 변경', act: () => startRename(el, id, name, a.label || name, (v) => api.provider(id, 'rename', name, v)) },
      { hr: true },
      { label: '제거…', danger: true, act: () => run(() => api.provider(id, 'remove', name), '') },
    ]);
  }
}

function renderAntigravity() {
  const agy = state.antigravity || { accounts: [] };
  $('#agy-current').textContent = agy.error || (agy.checkedAt ? `확인한 로그인: ${agy.current?.email || '없음'} · ${new Date(agy.checkedAt).toLocaleTimeString('ko-KR')}` : '현재 로그인 미확인');
  $('#agy-recover').hidden = !agy.recoveryRequired;
  renderAntigravityUsage(agy);
  const list = $('#antigravity .list');
  list.innerHTML = agy.accounts.map(account => `<div class="row" data-id="${esc(account.id)}"><span class="check"></span><div class="id"><div class="name">${esc(account.label)}</div><div class="email">${esc(account.email)}</div></div><button class="iconbtn more" aria-label="${esc(account.label)} 메뉴">${ICON.more}</button><button class="btn small login agy-switch" ${agy.recoveryRequired ? 'disabled' : ''}>이 계정으로 전환</button></div>`).join('');
  for (const row of list.querySelectorAll('.row')) {
    row.querySelector('.agy-switch').onclick = () => run(() => api.antigravity('activate', row.dataset.id), '');
    row.querySelector('.more').onclick = event => openMenu(event.currentTarget, [
      { label: '저장 목록에서 제거 (로그인 유지)', act: () => run(() => api.antigravity('remove', row.dataset.id), '저장 목록에서 제거했습니다') },
    ]);
  }
}
function renderAntigravityUsage(agy) {
  const quota = agy.usage;
  const remaining = state.usageMode === 'remaining';
  const compact = state.density !== 'comfortable';
  $('#agy-usage-refresh').disabled = Boolean(agy.usagePending || agy.recoveryRequired);
  $('#agy-usage-refresh').textContent = agy.usagePending ? '조회 중…' : '사용량 조회';
  $('#agy-usage').setAttribute('aria-busy', String(Boolean(agy.usagePending)));
  // The official report has no account identity: never attribute it to a
  // saved account row or refresh a different account by switching logins.
  $('#agy-usage').innerHTML = (quota?.groups || []).map(group => `<div class="agy-quota-group"><span class="agy-quota-name">${esc(group.name)}</span><div class="agy-quota-windows">${group.buckets.map(bucket => {
    const value = Math.round(remaining ? bucket.remainingPercent : bucket.usedPercent);
    const title = `${bucket.label} ${value}% ${remaining ? '남음' : '사용'}${bucket.resetsAt ? ' · 리셋 ' + new Date(bucket.resetsAt * 1000).toLocaleString('ko-KR') : ''}`;
    return `<div class="usage-window ${cls(bucket.usedPercent)}" title="${esc(title)}"><span class="window-label">${esc(bucket.label)}</span><span class="window-value num">${value}%</span><span class="reset-time num">${compact ? relShort(bucket.resetsAt) : rel(bucket.resetsAt)}</span><span class="usage-track" aria-hidden="true"><span class="usage-fill" style="width:${value}%"></span></span></div>`;
  }).join('')}</div></div>`).join('');
  const status = $('#agy-usage-status');
  status.classList.toggle('usage-error', Boolean(agy.usageError));
  status.textContent = agy.usagePending ? '공식 agy에서 조회 중…' : agy.usageError ? `${quota ? '이전 값 · ' : ''}${agy.usageError}` : quota ? `${remaining ? '남은 비율' : '사용한 비율'} · 공식 agy · ${age(quota.capturedAt)}` : '사용량 미조회';
}
$('#agy-usage-refresh').onclick = () => run(() => api.antigravity('refreshUsage'), '사용량 조회 완료');
$('#agy-check').onclick = () => run(() => api.antigravity('check'), '로그인 확인 완료');
$('#agy-recover').onclick = () => run(() => api.antigravity('recover'), '이전 인증 복원 완료');
$('#agy-save').onsubmit = event => {
  event.preventDefault();
  const input = $('#agy-save input');
  if (input.value.trim()) run(async () => { await api.antigravity('save', input.value.trim()); input.value = ''; }, '현재 로그인을 저장했습니다');
};

// Report natural content height so the window shrinks/grows to fit.
function fit() {
  if (menuEl) return; // a menu may have borrowed extra height; don't shrink under it
  const panel = $('#panel'); panel.classList.add('fit');
  const h = panel.getBoundingClientRect().height + 2;
  panel.classList.remove('fit');
  api.resize(h);
}

// Inline rename: swap the label for an input; Enter saves, Esc/blur cancels.
function startRename(rowEl, tool, name, current, doRename = (v) => api.rename(tool, name, v)) {
  const span = rowEl.querySelector('.label');
  const input = document.createElement('input');
  input.className = 'rename'; input.value = current; input.setAttribute('aria-label', '새 이름');
  span.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== current) await run(() => doRename(v), `${current} → ${v}`);
    else { state = await api.state(); render(); }
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(false);
  input.onclick = (e) => e.stopPropagation();
}

// Reset credits: official app-server RPC in the main process; use always asks first.
async function checkReset(btn, name) {
  if (btn) { btn.disabled = true; btn.textContent = '조회 중…'; }
  await runMsg(() => api.checkResetCredits(name));
}
async function useReset(btn, p) {
  const r = p.resetCredits || {};
  const when = r.nearestExpiry && Number.isFinite(Date.parse(r.nearestExpiry)) ? new Date(r.nearestExpiry).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '확인 안 됨';
  const count = Number.isSafeInteger(r.availableCount) ? `${r.availableCount}개` : '미조회';
  if (!confirm(`${p.label || p.name} 계정의 Codex 리셋권 1개를 지금 사용할까요?\n\n보유 ${count} · 가장 빠른 만료 ${when}\n가장 먼저 만료되는 리셋권을 사용해 현재 사용 한도를 초기화합니다. 되돌릴 수 없습니다.`)) return;
  if (btn) { btn.disabled = true; btn.textContent = '사용 중…'; }
  say('리셋권 사용 요청 중…');
  await runMsg(() => api.useResetCredit(p.name));
}

// Inline API key entry. The key goes straight to the main process and is never kept in state.
function startKeyEntry(rowEl, tool, name, mode = 'api') {
  rowEl.querySelector('.keyentry')?.remove();
  const form = document.createElement('form');
  form.className = 'keyentry';
  const prov = PROVIDERS.includes(tool) ? (state[tool] || {}) : null;
  const cost = mode === 'admin' ? state.tools?.[tool]?.profiles.find((x) => x.name === name)?.apiCost : null;
  const hint = cost ? `${cost.keyHint} (${cost.org} 관리자 키 · 이번 달 조직 사용 금액 조회 전용)` : tool === 'claude' ? 'sk-ant-… (이 프로필 실행 시 ANTHROPIC_API_KEY로 사용)' : prov ? `${prov.keyHint || ''} (실행 시 ${(prov.envNames || []).filter((n) => /_API_KEY$/.test(n)).join('·')}로 주입)` : 'sk-… (공식 codex login --with-api-key)';
  form.innerHTML = `<input type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="${esc(name)} ${cost ? '관리자 키' : 'API 키'}" placeholder="${esc(hint)}"><button type="submit" class="btn small primary">저장</button><button type="button" class="btn small cancel">취소</button>`;
  rowEl.appendChild(form); fit();
  const input = form.querySelector('input');
  const close = () => { form.remove(); fit(); };
  form.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); };
  form.querySelector('.cancel').onclick = close;
  form.onsubmit = (e) => {
    e.preventDefault(); const key = input.value.trim(); if (!key) return;
    input.value = ''; form.querySelectorAll('input, button').forEach((x) => { x.disabled = true; });
    runMsg(() => (cost ? api.apiCost('setKey', tool, name, key) : prov ? api.provider(tool, 'setKey', name, key) : api.setApiKey(tool, name, key)));
  };
  input.focus();
}

// Inline balance entry (USD from the Console Billing page). Stored with the time it was entered.
function startBalanceEntry(rowEl, tool, name) {
  rowEl.querySelector('.keyentry')?.remove();
  const form = document.createElement('form');
  form.className = 'keyentry balanceentry';
  form.innerHTML = `<input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="${esc(name)} 현재 잔액 (USD)" placeholder="Console Billing의 현재 잔액 USD (예: 48.20)"><button type="submit" class="btn small primary">저장</button><button type="button" class="btn small cancel">취소</button>`;
  rowEl.appendChild(form); fit();
  const input = form.querySelector('input');
  const close = () => { form.remove(); fit(); };
  form.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); };
  form.querySelector('.cancel').onclick = close;
  form.onsubmit = (e) => {
    e.preventDefault(); const v = input.value.trim(); if (!v) return;
    form.querySelectorAll('input, button').forEach((x) => { x.disabled = true; });
    runMsg(() => api.apiCost('setBalance', tool, name, v));
  };
  input.focus();
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
    if (typeof it.checked === 'boolean') { btn.setAttribute('role', 'menuitemcheckbox'); btn.setAttribute('aria-checked', String(it.checked)); }
    btn.disabled = Boolean(it.disabled); if (it.title) btn.title = it.title;
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
  const m = $('#msg'); m.textContent = text || ''; m.style.color = err ? 'var(--danger)' : '';
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
  add.querySelector('.addkey').onclick = () => {
    const v = input.value.trim(); if (!v) { input.focus(); return; }
    const folder = same.checked ? 'same' : 'random';
    let id = null;
    run(async () => { id = (await api.addProfile(tool, v, { shareSettings: true, folder })).id; }, `${v} 추가됨 · API 키를 입력하세요`).then(() => {
      reset();
      const el = id && [...document.querySelectorAll(`#${tool} .row`)].find((r) => r.dataset.name === id);
      if (el) startKeyEntry(el, tool, id);
    });
  };
  add.querySelector('form').onsubmit = (e) => {
    e.preventDefault(); const v = input.value.trim(); if (!v) return;
    const folder = same.checked ? 'same' : 'random';
    // Add the account home, then immediately open the login terminal for it (by folder id).
    run(async () => { const r = await api.addProfile(tool, v, { shareSettings: true, folder }); await api.login(tool, r.id); },
      `${v} 추가됨${folder === 'random' ? '' : ''} · 터미널에서 로그인을 마치면 이메일과 사용량이 자동으로 채워집니다`).then(reset);
  };
}

// API-key providers: add an account, then open the key entry for it. No folder/login step.
for (const pid of PROVIDERS) {
  const add = $(`#${pid} .addrow`); if (!add) continue;
  const input = add.querySelector('input');
  const reset = () => { add.classList.remove('open'); input.value = ''; syncProviderVisibility(pid); fit(); };
  add.querySelector('.link').onclick = () => { add.classList.add('open'); input.focus(); fit(); };
  add.querySelector('.cancel').onclick = reset;
  add.querySelector('form').onsubmit = (e) => {
    e.preventDefault(); const v = input.value.trim(); if (!v) return;
    let id = null;
    run(async () => { id = (await api.provider(pid, 'add', v)).id; }, `${v} 추가됨 · API 키를 입력하세요`).then(() => {
      reset();
      const el = id && [...document.querySelectorAll(`#${pid} .row`)].find((r) => r.dataset.name === id);
      if (el) startKeyEntry(el, pid, id);
    });
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
  { html: CHECK(state?.density !== 'comfortable') + '간결하게', act: () => run(() => api.setDensity('compact'), '') },
  { html: CHECK(state?.density === 'comfortable') + '여유 있게', act: () => run(() => api.setDensity('comfortable'), '') },
  { hr: true },
  ...(state?.zooms || [1, 1.1, 1.25, 1.5]).map((z) => ({ html: CHECK(state?.zoom === z) + `글자 크기 ${Math.round(z * 100)}%`, act: () => run(() => api.setZoom(z), '') })),
  { hr: true },
  ...PROVIDERS.filter((id) => !(state?.[id]?.accounts?.length)).map((id) => ({ label: `${providerName(id)} 계정 추가…`, title: '계정이 없는 API 키 카테고리는 패널에서 숨깁니다', act: () => showProviderAdd(id) })),
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
    const hasAdmin = TOOLS.some((t) => state?.tools?.[t]?.profiles.some((x) => x.apiCost?.adminKey));
    if (hasAdmin && api.apiCost) await api.apiCost('refreshAll').catch(() => {});
    if (state?.apiFetch) { say('API 조회 중…'); await runMsg(() => api.apiRefresh()); }
    else await run(() => Promise.resolve(), '갱신됨');
  } finally { refreshing = false; btn.classList.remove('spin'); btn.disabled = false; }
}
$('#refreshBtn').onclick = refreshNow;
$('#workspaceBtn').hidden = !api.openTasks;
$('#workspaceBtn').onclick = () => run(() => api.openTasks(), '');
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'r') { e.preventDefault(); refreshNow(); } });

api.onState((s) => { state = s; render(); });
api.state().then((s) => {
  state = s; render();
  // Dev aid: index.html#menu opens the settings menu right away (used by --screenshot-menu).
  if (location.hash === '#menu') setTimeout(() => $('#settingsBtn').click(), 200);
});
// Local state is pushed every 30 seconds by the main process, even when hidden.
