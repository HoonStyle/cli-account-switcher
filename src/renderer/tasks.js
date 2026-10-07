'use strict';
const $ = id => document.getElementById(id);
let snapshot, selectedId = null, detailCache = null, rootsCache = [], filter = 'all';
let busy = false, loading = false, connected = false, lastSync = null, selectionVersion = 0, fetchNotice = null, detailRequest = 0;
let requestId = crypto.randomUUID(), resumeRequestId = crypto.randomUUID(), renderedMainKey;
let managedRoots = [], externalRoots = [], sourceFilter = 'all';
const mainModels = new Map(), responseDrafts = new Map();
const terminalRoots = ['completed', 'cancelled', 'failed', 'observed_ended', 'observed_idle'];
const labels = { observed_ended:'실행 종료 · 완료 미확인', observed_idle:'대기 · 최근 실행 없음', observed_unknown:'현재 상태 미확인', observed_stale:'연결 끊김 · 이전 기록', planning:'작업 준비 중', awaiting_review:'결과 검토 중', needs_user:'답변 필요', ready:'결과 도착', cancel_requested:'중단 처리 중', queued:'순서 대기', starting:'시작 중', running:'실행 중', waiting:'응답 대기', blocked:'준비 실패', completed:'확인 완료', succeeded:'실행 완료', failed:'오류 발생', cancelled:'중단됨', pending:'대기 중', awaiting_input:'입력 대기', needs_attention:'확인 필요', unknown:'실행 확인 필요', external_wait:'총괄 응답 대기', quiet:'실행 중 · 새 출력 없음' };
const status = value => labels[value] || '상태 확인 필요';
const rootReason = root => root.status === 'needs_user' && root.inputRequest ? root.inputRequest.reason : root.attention || '';
const inputKind = root => root.status === 'needs_user' ? root.inputRequest?.kind : null;
const systemError = root => inputKind(root) && inputKind(root) !== 'legacy' ? ['preflight','invalid_main_result'].includes(inputKind(root)) : /^(main_result:|launch_blocked:)/.test(rootReason(root));
const rootLabel = root => inputKind(root) === 'preflight' || (!inputKind(root) && rootReason(root).startsWith('launch_blocked:')) ? '준비 실패' : systemError(root) ? '총괄 처리 오류' : status(root.status);
const shortGoal = (goal, limit) => goal.length > limit ? goal.slice(0,limit) + '…' : goal;
const setText = (node, value = '') => { const text = String(value ?? ''); if (node.textContent !== text) node.textContent = text; };
const text = (id, value) => setText($(id), value);
const time = value => value ? new Date(value).toLocaleString('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '기록 없음';
function age(value, until = Date.now()) { if (!value) return '기록 없음'; const s = Math.max(0, Math.floor((until-value)/1000)); return s < 60 ? `${s}초` : s < 3600 ? `${Math.floor(s/60)}분` : `${Math.floor(s/3600)}시간 ${Math.floor(s%3600/60)}분`; }
function accountName(binding = {}) { if (binding.tool === 'openclaw') return `OpenClaw · ${binding.label || binding.agentId || '연결된 대화'}`; const p = snapshot?.tools?.[binding.tool]?.profiles?.find(p => p.name === binding.profileId); return `${binding.tool === 'claude' ? 'Claude' : binding.tool === 'codex' ? 'Codex' : '담당 미지정'} · ${p?.label || binding.profileId || '기본 계정'}`; }
function tone(value) { return ['failed','blocked'].includes(value) ? 'error' : ['unknown','needs_user','needs_attention','quiet','cancel_requested'].includes(value) ? 'warning' : ['ready','completed','succeeded'].includes(value) ? 'success' : ['running','starting','planning','awaiting_review'].includes(value) ? 'running' : ''; }
function badge(node, value, label) { node.className = `badge ${tone(value)}`; setText(node, label || status(value)); }
function notice(message = '') { text('notice', message); }
function category(root) { if (root.readOnly && root.status === 'waiting') return 'attention'; if (root.status === 'ready') return 'ready'; if (terminalRoots.includes(root.status)) return root.status === 'failed' ? 'attention' : 'done'; if (root.attention || root.observation?.requiresAttention || ['needs_user','blocked','needs_attention','observed_unknown','observed_stale'].includes(root.status)) return 'attention'; return 'active'; }
function attentionText(root) {
  const reason = rootReason(root);
  // Coordinator prose is data, never a diagnostic code even when it shares a prefix.
  if (inputKind(root) === 'coordinator') return root.inputRequest.summary || reason;
  if (reason.startsWith('progress_gap:')) return '최근 진행 보고가 뜸합니다. 실행 신호와 마지막 출력 시각을 아래에서 확인하세요. 오류로 확정된 상태는 아닙니다.';
  if (reason.startsWith('runner_unknown:')) return '최근 실행 신호를 확인하지 못했습니다. 실제 실행 여부가 불확실하므로 중복 작업을 시작하기 전에 기록을 확인하세요.';
  if (reason.startsWith('openclaw_binding_')) return '총괄 OpenClaw 대화와 연결이 끊겼습니다. 원래 대화에서 연결을 복구해 주세요. 다른 담당으로 자동 전환하지 않습니다.';
  if (reason.startsWith('launch_blocked:')) return `실행을 시작하지 못했습니다. 계정 로그인과 실행 환경을 확인한 뒤 아래에서 이어갈 지시를 보내거나 작업을 중단하세요.\n${reason.slice(15)}`;
  if (reason === 'openclaw_review_overdue') return '총괄 OpenClaw 대화의 검토를 기다리고 있습니다. 원래 대화에서 진행 상태를 확인해 주세요. 실행 오류로 확정된 상태는 아닙니다.';
  if (reason === 'cancel_confirmation_overdue') return '중단 요청 후 실행 종료 확인이 늦어지고 있습니다. 종료 확인 전까지 중단 완료로 표시하지 않습니다.';
  if (reason.startsWith('spawn_ambiguous:')) return '실행 시작 여부가 불확실합니다. 중복 실행을 막기 위해 자동 재시도하지 않습니다.';
  if (reason.startsWith('main_result:')) return `총괄 담당의 결과를 처리하지 못했습니다. 아래 기록을 확인하고 필요한 지시를 보내주세요.\n${reason.slice(12).trim()}`;
  if (reason && reason !== 'final_result_ready') return reason;
  return '';
}
function nextStep(root) {
  if (root.readOnly) return ({failed:['OpenClaw 오류 확인 필요','원래 대화에서 오류를 확인해 주세요. 이 화면은 읽기 전용입니다.','error'],observed_stale:['OpenClaw 연결 확인 필요','새로고침으로 다시 확인하세요. 표시 중인 내용은 이전 기록입니다.','warning'],waiting:['OpenClaw 응답 대기','원래 대화에서 필요한 입력이나 진행 상황을 확인해 주세요.','warning']})[root.status] || ['', '', ''];
  const extra = attentionText(root);
  if (root.status === 'ready') return ['', '', ''];
  if (root.status === 'completed') return ['', '', ''];
  if (root.status === 'cancelled') return ['', '', ''];
  if (root.status === 'cancel_requested') return ['', '', ''];
  if (systemError(root)) return ['총괄 담당의 처리 중 오류가 발생했습니다', extra, 'error'];
  if (root.status === 'needs_user') return ['답변을 보내야 계속할 수 있습니다', extra || root.summary || '아래에 필요한 정보나 다음 지시를 입력해 주세요.', 'warning'];
  if (extra) return ['진행 상황을 확인해 주세요', extra, 'warning'];
  if (root.status === 'failed') return ['오류로 작업을 마치지 못했습니다', '아래 오류 원인과 진행 기록을 확인하세요. 원인을 해결한 뒤 새 작업을 맡길 수 있습니다.', 'error'];
  if (root.observation?.requiresAttention && root.observation?.counts?.failed) return ['일부 위임 작업에서 오류가 발생했습니다', '담당별 오류를 아래에서 확인하세요. 총괄 담당이 결과를 검토하고 다음 조치를 결정합니다.', 'warning'];
  if (root.observation?.requiresAttention) return ['실행 상태를 확인해 주세요', '아래 담당별 실행 신호와 오류 정보를 확인하세요. 상태가 불확실한 작업은 중복 실행하지 않습니다.', 'warning'];
  if (root.status === 'awaiting_review') return ['', '', ''];
  if (root.status === 'planning') return ['', '', ''];
  if (['blocked','needs_attention'].includes(root.status)) return ['진행을 위해 확인이 필요합니다', '최근 진행 기록을 확인하고 원래 요청한 대화에서 문제 해결을 요청하세요.', 'warning'];
  return ['', '', ''];
}
function fillModelOptions(select, models = [], selected = select.value) {
  const choices = [{ id: '', label: 'CLI 기본 설정' }, ...models];
  // A refreshed catalog must not silently replace the user's explicit selection.
  if (selected && !choices.some(m => m.id === selected)) choices.push({ id: selected, label: `${selected} · 이전 선택` });
  const key = JSON.stringify(choices);
  if (select.dataset.catalog !== key) {
    select.dataset.catalog = key;
    select.replaceChildren(...choices.map(model => {
      const option = document.createElement('option'); option.value = model.id; option.textContent = model.label; return option;
    }));
  }
  select.value = selected || '';
}
function renderAccounts() {
  if (!snapshot) return;
  const tool = $('main-tool').value;
  const account = snapshot.tools[tool], active = account?.profiles.find(p => p.name === account.active);
  const key = JSON.stringify([tool, account?.active || '']);
  if (renderedMainKey) mainModels.set(renderedMainKey, $('main-model').value);
  fillModelOptions($('main-model'), active?.models || [], mainModels.get(key) || '');
  renderedMainKey = key;
  $('main-model-field').hidden = tool === 'openclaw'; $('main-model').disabled = tool === 'openclaw';
  $('binding').hidden = tool !== 'openclaw';
  text('active', tool === 'openclaw' ? '선택한 대화에서 일을 나누고 결과를 받습니다.' : `현재 담당: ${active?.label || active?.name || '활성 계정 없음'}`);
  // Update rows in place: periodic account refresh must not steal focus or erase drafts.
  const keep = new Set();
  for (const name of ['codex','claude']) for (const profile of snapshot.tools[name]?.profiles || []) {
    const key = JSON.stringify({tool:name,profileId:profile.name}); keep.add(key);
    let row = Array.from($('participants').children).find(r => r.dataset.key === key);
    if (!row) {
      row = document.createElement('div'); row.className = 'account-row'; row.dataset.key = key;
      const label = document.createElement('label'); label.className = 'account';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = key;
      const nameText = document.createElement('span'); label.append(input, nameText);
      const model = document.createElement('select'); model.className = 'participant-model'; model.disabled = true;
      input.onchange = () => { model.disabled = !input.checked; };
      row.append(label,model); $('participants').append(row);
    }
    setText(row.querySelector('span'), `${name === 'claude' ? 'Claude' : 'Codex'} · ${profile.label || profile.name}`);
    fillModelOptions(row.querySelector('.participant-model'), profile.models || []);
    row.querySelector('.participant-model').setAttribute('aria-label', `${name} ${profile.label || profile.name} 모델`);
  }
  for (const row of Array.from($('participants').children)) if (!keep.has(row.dataset.key)) row.remove();
}
const mobileLayout=window.matchMedia('(max-width:680px)');
let indexExpanded=false;
function syncTaskIndex(open=indexExpanded) {
  indexExpanded=open;
  document.querySelector('.list-panel').classList.toggle('list-expanded',open);
  $('toggle-list').setAttribute('aria-expanded',String(open || !mobileLayout.matches));
  text('toggle-list',open ? '목록 접기 ↑' : `목록 보기 · ${rootsCache.filter(r=>sourceFilter==='all'||(r.source||'switcher')===sourceFilter).length}건 ↓`);
}
mobileLayout.addEventListener('change',()=>syncTaskIndex());
$('toggle-list').onclick=()=>syncTaskIndex(!indexExpanded);
function renderList() {
  const focused = document.activeElement;
  syncTaskIndex();
  const scopedRoots = rootsCache.filter(r => sourceFilter === 'all' || (r.source || 'switcher') === sourceFilter);
  const counts = {active:0,attention:0,ready:0,done:0}; for (const root of scopedRoots) counts[category(root)]++;
  for (const key of Object.keys(counts)) text(`count-${key}`, counts[key]);
  text('live-summary', `작업 ${scopedRoots.length}건. 진행 중 ${counts.active}건, 확인 필요 ${counts.attention}건, 결과 도착 ${counts.ready}건, 종료 ${counts.done}건.`);
  document.querySelectorAll('.metric').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  $('filter-all').setAttribute('aria-pressed', String(filter === 'all'));
  text('list-heading', {all:'전체 작업',active:'진행 중',attention:'확인 필요',ready:'결과 도착',done:'종료한 작업'}[filter]);
  const query = $('search').value.trim().toLowerCase();
  const shown = scopedRoots.filter(r => (filter === 'all' || category(r) === filter) && [r.goal,r.projectPath,accountName(r.coordinator),r.coordinator?.model].join(' ').toLowerCase().includes(query));
  const order = {attention:0,ready:1,active:2,done:3}; shown.sort((a,b) => order[category(a)]-order[category(b)] || b.createdAt-a.createdAt);
  const keep = new Set(shown.map(r => r.id));
  for (const node of Array.from($('list').children)) if (!keep.has(node.dataset.id)) node.remove();
  shown.forEach((root,i) => {
    let b = Array.from($('list').children).find(b => b.dataset.id === root.id);
    if (!b) {
      b = document.createElement('button'); b.type = 'button'; b.dataset.id = root.id;
      for (const cls of ['badge','task-goal','task-meta']) { const span = document.createElement('span'); span.className = cls; b.append(span); }
      b.onclick = async () => {
        await selectTask(root.id);
        if(mobileLayout.matches && detailCache) { syncTaskIndex(false); $('detail-title').focus({preventScroll:true}); $('detail-title').scrollIntoView({block:'start'}); }
      };
    }
    b.className = `task${root.id === selectedId ? ' selected' : ''}`; b.setAttribute('aria-pressed', String(root.id === selectedId));
    const warning = category(root) === 'attention' && !['needs_user','failed'].includes(root.status);
    badge(b.children[0], systemError(root) ? 'failed' : warning ? 'needs_attention' : root.status, warning ? `${rootLabel(root)} · 확인 필요` : rootLabel(root));
    setText(b.children[1], root.goal || '이름 없는 작업');
    const c = root.observation?.counts;
    setText(b.children[2], `${root.source === 'openclaw' ? 'OpenClaw 대화 · 읽기 전용' : '스위처 작업 · '+accountName(root.coordinator)}${c ? ` · 위임 ${c.total}건` : ''}\n최근 상태 ${time(root.updatedAt || root.createdAt)}`);
    if ($('list').children[i] !== b) $('list').insertBefore(b,$('list').children[i] || null);
  });
  $('list-empty').hidden = !!shown.length;
  text('list-empty', rootsCache.length ? '조건에 맞는 작업이 없습니다. 전체 보기나 다른 검색어를 사용하세요.' : '아직 맡긴 작업이 없습니다. 위의 ‘새 작업 맡기기’로 시작하세요.');
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({preventScroll:true});
}
function createDelegation(id) {
  const card = document.createElement('article'); card.className = 'delegate'; card.dataset.id = id;
  const head = document.createElement('div'); head.className = 'card-head';
  const title = document.createElement('h3'), owner = document.createElement('span'), model = document.createElement('span'); owner.className='owner'; model.className='model'; title.append(owner,model);
  const state = document.createElement('span'); state.className='badge'; head.append(title,state); card.append(head);
  for (const cls of ['goal','activity','review','error-text']) { const node = document.createElement('div'); node.className=cls; card.append(node); }
  const details=document.createElement('details'), summary=document.createElement('summary'), pre=document.createElement('pre'); summary.textContent='결과 및 변경 파일 보기'; details.append(summary,pre); details.ontoggle=()=>{if(details.open)loadTaskDetails(details);}; card.append(details);
  card.append(createTerminal()); return card;
}
function taskDetailText(task) {
  return [(task.goal || '').length > 240 ? `맡긴 내용\n${task.goal}` : '', task.result?.summary,
    task.review?.reason ? `총괄 검토\n${task.review.reason}` : '',
    task.result?.artifacts?.length ? `산출물\n${task.result.artifacts.join('\n')}` : '',
    task.changes?.files?.length ? `변경 파일\n${task.changes.files.join('\n')}\n원본에 자동 반영되지 않았습니다.` : '',
    task.cwd ? `작업 폴더: ${task.cwd}` : ''].filter(Boolean).join('\n\n');
}
async function loadTaskDetails(node) {
  if (!node.open || !node.detailTask?.detailsTruncated || node.detailLoaded || node.detailLoading) return;
  const key = node.dataset.detailKey, task = node.detailTask, rootId = node.detailRoot;
  const current = () => node.isConnected && node.dataset.detailKey === key && selectedId === rootId;
  node.detailLoading = true;
  setText(node.querySelector('pre'), taskDetailText(task) + '\n\n전체 내용을 불러오는 중…');
  try {
    if (!window.api.tasksTaskDetail) throw Error('전체 결과 조회 기능을 사용할 수 없습니다.');
    const full = await window.api.tasksTaskDetail(rootId, task.id, task.resultVersion, task.detailRevision);
    if (!current()) return;
    if (full.id !== task.id || full.resultVersion !== task.resultVersion) throw Error('결과가 변경됐습니다. 새로고침 후 다시 펼쳐 주세요.');
    node.detailLoaded = true; node.detailText = taskDetailText(full);
    setText(node.querySelector('pre'), node.detailText);
  } catch (error) { if (current()) setText(node.querySelector('pre'), taskDetailText(task) + `\n\n전체 조회 실패 · ${error.message}`); }
  finally { if (node.dataset.detailKey === key) node.detailLoading = false; }
}
function updateTaskDetails(node, rootId, task) {
  const key = JSON.stringify([rootId, task.id, task.resultVersion, task.detailRevision]);
  if (node.dataset.detailKey !== key) {
    node.dataset.detailKey = key; node.detailLoaded = false; node.detailLoading = false; node.detailText = '';
  }
  node.detailRoot = rootId; node.detailTask = task;
  if (node.detailLoaded) setText(node.querySelector('pre'), node.detailText);
  else if (!node.detailLoading) setText(node.querySelector('pre'), taskDetailText(task) + (task.detailsTruncated ? '\n\n일부만 표시됨 · 펼치면 전체 내용을 불러옵니다.' : ''));
  if (node.open) loadTaskDetails(node);
}
function terminalText(raw) {
  const value = v => typeof v === 'string' ? v : Array.isArray(v) ? v.filter(b=>b.type==='text').map(b=>b.text).join('\n') : '';
  return String(raw || '').split(/\r?\n/).map(line => {
    let e; try { e=JSON.parse(line); } catch { return line; }
    if (!e || typeof e!=='object') return line;
    if (e.item) {
      const item=e.item;
      if (item.type==='command_execution') return [`$ ${item.command || ''}`,item.aggregated_output || '',item.exit_code != null ? `종료 코드 ${item.exit_code}` : ''].filter(Boolean).join('\n');
      if (item.type==='agent_message') return item.text || '';
      if (item.type==='file_change') return (Array.isArray(item.changes) ? item.changes : []).map(c=>`${c.kind || '변경'} ${c.path}`).join('\n');
      if (item.type==='mcp_tool_call') return `${item.server || ''} / ${item.tool || ''}`;
      return '';
    }
    if (e.type==='assistant' || e.type==='user') return Array.isArray(e.message?.content) ? e.message.content.map(b=>b.type==='text' ? b.text : b.type==='tool_use' ? `${b.name} ${JSON.stringify(b.input || {})}` : b.type==='tool_result' ? value(b.content) : '').filter(Boolean).join('\n') : value(e.message?.content);
    if (e.type==='system') return e.subtype==='init' && e.model ? `모델: ${e.model}` : '';
    if (e.type==='result' || e.structured_output) return e.structured_output?.finalResponse || e.structured_output?.summary || value(e.result) || (Array.isArray(e.errors) ? e.errors.join('\n') : value(e.errors));
    if (e.type==='error' || e.type==='turn.failed') return value(e.message) || value(e.error?.message) || '실행 오류';
    return e.type ? '' : JSON.stringify(e,null,2);
  }).filter(Boolean).join('\n').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
}
function createTerminal() {
  const node=document.createElement('details'); node.className='terminal'; node.hidden=true;
  const summary=document.createElement('summary'); summary.textContent='터미널 보기';
  const bar=document.createElement('div'); bar.className='terminal-toolbar';
  const meta=document.createElement('span'); meta.className='terminal-meta';
  const label=document.createElement('label'), follow=document.createElement('input'); follow.type='checkbox'; follow.checked=true; label.append(follow,document.createTextNode('자동 스크롤')); bar.append(meta,label);
  const output=document.createElement('pre'); output.className='terminal-output'; output.tabIndex=0; output.setAttribute('aria-label','실행 출력');
  node.append(summary,bar,output);
  node.addEventListener('toggle',()=>{ if(node.open) loadTerminal(node); });
  return node;
}
async function loadTerminal(node) {
  if (!node.open || node.hidden || !window.api.tasksOutput) return;
  const rootId=node.dataset.root, attemptId=node.dataset.attempt;
  const version=(node.requestVersion || 0)+1; node.requestVersion=version;
  const current=()=>node.isConnected && node.open && node.requestVersion===version && node.dataset.root===rootId && node.dataset.attempt===attemptId && selectedId===rootId;
  try {
    const data=await window.api.tasksOutput(rootId,attemptId); if(!current())return;
    const stdout=terminalText(data.stdout),stderr=terminalText(data.stderr);
    const content=[data.truncated ? '[최근 출력만 표시]' : '',stdout,stderr ? `[stderr]\n${stderr}` : ''].filter(Boolean).join('\n\n') || (['succeeded','failed','cancelled'].includes(data.state) ? '저장된 출력 없음' : '출력 대기');
    const pre=node.querySelector('pre'),scroll=pre.scrollTop;
    setText(pre,content); pre.scrollTop=node.querySelector('input').checked ? pre.scrollHeight : scroll;
    setText(node.querySelector('.terminal-meta'),[data.childPid ? `PID ${data.childPid}` : '',data.updatedAt ? time(data.updatedAt) : '', '읽기 전용 · 5초 갱신'].filter(Boolean).join(' · '));
  } catch(e) { if(current()) setText(node.querySelector('.terminal-meta'),`출력 조회 실패 · ${e.message}`); }
}
function updateTerminal(node, rootId, attempt) {
  node.hidden=!attempt || attempt.binding?.tool==='openclaw' || !window.api.tasksOutput;
  if(node.hidden)return;
  if(node.dataset.root!==rootId || node.dataset.attempt!==attempt.id){
    node.dataset.root=rootId;node.dataset.attempt=attempt.id;node.requestVersion=(node.requestVersion || 0)+1;
    setText(node.querySelector('pre'),'출력 대기');setText(node.querySelector('.terminal-meta'),'');
  }
  if(node.open)loadTerminal(node);
}
function renderDelegations(detail) {
  text('delegation-source', detail.root.readOnly ? '03 / OpenClaw 위임 기록' : '03 / 스위처 위임');
  if (detail.root.readOnly) {
    const key = JSON.stringify([detail.root.id, detail.tasks]);
    if ($('delegations').dataset.externalKey === key) return;
    $('delegations').dataset.externalKey = key;
    $('delegations').replaceChildren();
    for (const task of detail.tasks || []) {
      const card = createDelegation(task.id);
      setText(card.querySelector('.owner'), task.binding?.label || task.goal);
      setText(card.querySelector('.model'), task.binding?.model || '모델 기록 없음');
      badge(card.querySelector('.badge'), task.state);
      setText(card.querySelector('.goal'), task.goal);
      setText(card.querySelector('.activity'), `마지막 관측 ${time(task.updatedAt)}${task.recordedState ? ' · 당시 상태 '+task.recordedState : ''}`);
      setText(card.querySelector('.review'), task.evidence === 'spawn_receipt' ? '위임 시작 기록만 확인됨' : '');
      card.querySelector('details').hidden = true; $('delegations').append(card);
    }
    text('delegation-count', `${(detail.tasks || []).length}건 관측`);
    $('delegation-empty').hidden = !!detail.tasks?.length;
    text('delegation-empty', '조회한 최근 기록에 위임 내역이 없습니다.');
    return;
  }
  delete $('delegations').dataset.externalKey;
  const tasks = detail.tasks || [], attempts = detail.attempts || [];
  const keep = new Set(tasks.map(t => t.id));
  for (const node of Array.from($('delegations').children)) if (!keep.has(node.dataset.id)) node.remove();
  for (const task of tasks) {
    const candidates = attempts.filter(a => a.taskId === task.id);
    const currentId = task.currentAttemptId || task.observation?.latestAttemptId;
    const attempt = currentId ? candidates.find(a => a.id === currentId) : candidates.at(-1);
    const o = task.observation || attempt?.observation || {}, p = task.binding || detail.root.participants?.find(p => p.id === task.participantId) || attempt?.binding || {};
    let state = o.executionState || o.state || attempt?.state || task.state;
    if (task.state === 'failed') state = 'failed'; // structured task failure can follow a successful CLI exit
    if (!['succeeded','failed','cancelled'].includes(state) && o.activity === 'unknown') state = 'unknown';
    const activity = ['running','starting'].includes(state) && o.activity === 'quiet' ? 'quiet' : state;
    let card = Array.from($('delegations').children).find(c => c.dataset.id === task.id);
    if (!card) { card=createDelegation(task.id); $('delegations').append(card); }
    updateTerminal(card.querySelector('.terminal'),detail.root.id,attempt);
    setText(card.querySelector('.owner'), accountName(p)); setText(card.querySelector('.model'), p.model || 'CLI 기본 모델');
    badge(card.querySelector('.badge'), activity);
    card.dataset.tone=tone(activity);
    setText(card.querySelector('.goal'), shortGoal(task.goal || '위임 작업',240));
    const lines=[];
    if (['running','starting','unknown'].includes(state)) {
      lines.push(o.heartbeatStatus === 'fresh' ? `실행 신호 확인 · ${age(o.heartbeatAt)} 전` : o.heartbeatStatus === 'stale' ? `실행 신호 지연 · 마지막 ${time(o.heartbeatAt)}` : '실행 신호 아직 확인 안 됨');
      lines.push(o.lastOutputAt ? `마지막 출력 · ${age(o.lastOutputAt)} 전` : '아직 출력이 없습니다');
    } else if (state === 'queued') lines.push({account_busy:'이 계정이 다른 작업을 실행 중이라 순서를 기다립니다.',capacity:'다른 작업이 실행 자리를 사용 중입니다.',root_paused:'전체 작업이 잠시 멈춰 있어 대기 중입니다.',scheduler:'실행 순서를 기다리고 있습니다.'}[o.waitReason] || '실행 순서를 기다리고 있습니다.');
    else lines.push(`${status(state)}${attempt?.endedAt ? ` · ${time(attempt.endedAt)}` : ''}`);
    if(attempt?.result?.exit?.code != null) lines.push(`CLI 종료 코드 ${attempt.result.exit.code} · 자식 보고 ${task.result?.success === true ? '성공' : task.result?.success === false ? '실패' : '없음'}`);
    const start = attempt?.startedAt || o.startedAt;
    if (start) lines.push(`소요 ${age(start,attempt?.endedAt || Date.now())}`);
    setText(card.querySelector('.activity'), lines.join('\n'));
    const review = task.review?.decision || (typeof task.review === 'string' ? task.review : null);
    setText(card.querySelector('.review'), review ? `총괄 검토 · ${{accepted:'수용',rejected:'보완 요청',needs_user:'사용자 확인 필요'}[review] || '검토됨'}${task.review?.reason ? ` — ${task.review.reason}` : ''}` : ['succeeded','failed','cancelled'].includes(state) ? '총괄 검토 대기' : '');
    const err = o.error || attempt?.observation?.error;
    const errorNode=card.querySelector('.error-text');
    setText(errorNode, state === 'blocked' ? `준비 실패: ${err?.message || attempt?.result?.reason || '실행 전 준비를 확인해 주세요.'}` : state === 'failed' ? `오류: ${err?.message || task.result?.summary || attempt?.result?.reason || '실행 결과를 처리하지 못했습니다.'}${err?.exitCode != null ? ` (종료 코드 ${err.exitCode})` : ''}` : state === 'unknown' ? '실행 여부가 불확실합니다. 실패로 확정하거나 자동 재실행하지 않습니다.' : '');
    const result=card.querySelector('details'); result.hidden = !task.result && !task.changes && !task.detailsTruncated && (task.goal || '').length <= 240;
    setText(result.querySelector('summary'), task.result || task.changes ? '결과 및 변경 파일 보기' : '맡긴 내용 전체 보기');
    updateTaskDetails(result, detail.root.id, task);
  }
  $('delegation-empty').hidden=!!tasks.length;
  text('delegation-empty', terminalRoots.includes(detail.root.status) || detail.root.status === 'ready' ? '위임 내역 없음' : '위임 대기');
  const c=detail.root.observation?.counts;
  text('delegation-count', c ? `전체 ${c.total} · 실행 ${c.running} · 대기 ${c.queued} · 오류 ${c.failed}${c.blocked ? ` · 준비 실패 ${c.blocked}` : ''}${c.unknown ? ` · 확인 필요 ${c.unknown}` : ''}` : `${tasks.length}개 작업`);
}
const eventLabels = {submitted:'작업 접수',input_requested:'입력 요청 기록',input_request_migrated:'기존 입력 요청 복원',preflight_blocked:'실행 준비 실패',preflight_retry_queued:'기존 작업 재시도 예약',root_resumed:'작업 재개',main_intent:'총괄 담당에게 요청',spawn_intent:'실행 준비',runner_receipt:'실행 시작 확인',delegated:'작업 위임',execution_finished:'실행 종료',result_preserved:'결과 저장',review_delivery_queued:'총괄 검토 요청',main_processed:'총괄 결정 반영',attention:'상태 확인 필요',final_ready:'최종 결과 도착',final_delivery_ack:'사용자 결과 확인 완료',cancel_requested:'중단 요청',runner_spawn_error:'실행 시작 오류',openclaw_wake_requested:'OpenClaw에 검토 알림',openclaw_wake_failed:'OpenClaw 검토 알림 실패',openclaw_delivery_wake_requested:'결과 전달 알림',openclaw_delivery_wake_failed:'결과 전달 알림 실패',openclaw_attention_wake_requested:'입력 필요 알림',openclaw_attention_wake_failed:'입력 필요 알림 실패',attention_delivery_ack:'입력 필요 안내 전달 확인',attention_cleared:'실행 경고 해소'};
function renderExternal(detail) {
  const data = detail.external; $('external-records').hidden = !detail.root.readOnly;
  if (!data || !detail.root.readOnly) return;
  text('external-scope', '대화별 관측 · 읽기 전용 · 실행 종료는 작업 완료 판정이 아닙니다.');
  text('external-limit', [data.partialHistory ? '최근 요청·응답 일부만 표시합니다.' : '', data.partialRuns ? '이전 실행 이력이 더 있습니다.' : '', data.auditUnavailable ? '실행 이력 조회 불가 · 현재 대화 상태만 표시합니다.' : ''].filter(Boolean).join(' '));
  const fill = (id, values, render) => {
    const node = $(id), key = JSON.stringify(values); if (node.dataset.key === key) return;
    node.dataset.key = key; node.replaceChildren(); values.forEach(value => node.append(render(value)));
  };
  fill('external-runs', data.runs || [], run => { const li=document.createElement('li');li.textContent=`${time(run.startedAt)} · ${status(run.state)}${run.endedAt ? ' · '+age(run.startedAt,run.endedAt) : ''}`; return li; });
  fill('external-conversation', data.conversation || [], message => {
    const article=document.createElement('article'),label=document.createElement('small'),pre=document.createElement('pre');
    label.textContent=`${message.role === 'user' ? '요청' : '응답'} · ${time(message.at)}`;pre.textContent=message.text;article.append(label,pre);return article;
  });
  fill('external-activity', data.activity || [], item => { const li=document.createElement('li');li.textContent=`${item.name} · ${{completed:'도구 실행 종료',running:'실행 중',failed:'실패',unknown:'결과 미확인'}[item.status] || item.status}`;return li; });
}
function renderDetail(detail) {
  const root=detail.root; detailCache=detail; renderExternal(detail); $('timeline').hidden=!!root.readOnly;
  $('detail').hidden=false; $('detail-empty').hidden=true;
  badge($('detail-status'),systemError(root) ? 'failed' : root.status,rootLabel(root)); text('detail-title',shortGoal(root.goal || '작업',160));
  $('goal-details').hidden=(root.goal || '').length <= 160; text('goal-full',root.goal || '');
  const main=(detail.attempts || []).filter(a=>a.role === 'main').at(-1);
  let mainTerminal=$('coordinator-terminal').querySelector('.terminal');
  if(!mainTerminal){mainTerminal=createTerminal();$('coordinator-terminal').append(mainTerminal);}
  updateTerminal(mainTerminal,root.id,main);
  text('coordinator-state',main?.state === 'external_wait' ? '총괄 대화의 응답을 기다리고 있습니다' : main?.observation?.activity === 'unknown' ? '총괄 실행 신호 확인 필요' : ['running','starting'].includes(main?.state) ? `총괄 ${status(main.observation?.activity || main.state)} · 마지막 출력 ${main.observation?.lastOutputAt ? age(main.observation.lastOutputAt)+' 전' : '없음'}` : ''); text('detail-time',`접수 ${time(root.createdAt)}`);
  const [title,body,kind]=nextStep(root); text('next-title',title); text('next-body',body); $('next-action').className=`callout ${kind}`; $('next-action').hidden=!title;
  text('detail-owner',`${accountName(root.coordinator)}${root.coordinator?.model ? ` / ${root.coordinator.model}` : ''}`);
  text('detail-elapsed',`${age(root.createdAt,terminalRoots.includes(root.status) || root.status === 'ready' ? root.updatedAt : Date.now())}${root.status === 'ready' ? ' · 결과 확인 대기' : terminalRoots.includes(root.status) ? ' · 종료' : ' 경과'}`);
  text('detail-project',root.projectPath || (root.readOnly ? root.external?.channel || '연결된 대화' : '프로젝트 정보 없음'));
  if (root.readOnly) { text('coordinator-state','OpenClaw 대화별 관측 · 읽기 전용'); text('detail-time',`최근 요청 ${time(root.external?.lastInteractionAt || root.createdAt)}`); text('detail-elapsed',`최근 활동 ${age(root.updatedAt)} 전`); }
  // Provider text is inert: never evaluate Markdown, HTML or terminal escapes.
  text('detail-body',JSON.stringify(detail,null,2));
  $('final').hidden=!root.finalResponse; text('final-response',root.finalResponse || '');
  text('ack',root.status === 'completed' ? '결과 확인 완료됨' : '결과 확인 완료');
  text('ack-help',root.coordinator?.tool === 'openclaw' ? (root.status === 'completed' ? 'OpenClaw 대화로 결과 전달이 확인되었습니다.' : '대화로 실제 전달된 뒤 OpenClaw에서 완료 처리합니다.') : root.status === 'completed' ? '이 결과를 확인한 기록이 저장되었습니다.' : '읽은 뒤 확인하면 이 작업이 완료로 정리됩니다.');
  text('respond',systemError(root) ? '지시를 보내고 다시 진행' : '답변 보내고 이어가기');
  $('respond-area').hidden=root.status !== 'needs_user' || root.coordinator?.tool === 'openclaw';
  $('resume-build').disabled=root.permission !== 'workspace-write';
  text('resume-help', `${root.round || 0}/${root.maxRounds || 3}회 사용 · 준비 실패 ${(detail.tasks || []).filter(t=>t.state==='blocked').length}건은 같은 작업으로 재시도합니다.`);
  if(root.coordinator?.tool === 'openclaw' && root.status === 'needs_user') text('next-body', `${attentionText(root)}\n원래 OpenClaw 대화에서 재개할 수 있습니다.`);
  renderDelegations(detail);
  $('toggle-terminals').hidden=!document.querySelector('.terminal:not([hidden])');
  const events=(detail.events || []).slice(-12).reverse(), key=JSON.stringify(events);
  if ($('events').dataset.key !== key) {
    $('events').dataset.key=key; $('events').replaceChildren();
    for (const e of events) { const li=document.createElement('li'), t=document.createElement('time'), s=document.createElement('span'); t.textContent=time(e.at); s.textContent=(eventLabels[e.type] || '진행 상태 변경')+(e.body?.state ? ` · ${status(e.body.state)}` : ''); li.append(t,s); $('events').append(li); }
  }
  updateControls();
}
function updateControls() {
  const root=detailCache?.root, disabled=busy || !connected;
  $('submit').disabled=disabled; $('refresh').disabled=busy;
  $('respond').disabled=disabled || root?.readOnly || root?.coordinator?.tool === 'openclaw' || root?.status !== 'needs_user';
  $('ack').disabled=disabled || root?.readOnly || root?.status !== 'ready';
  $('ack').hidden=root?.coordinator?.tool === 'openclaw';
  $('cancel').disabled=disabled || !root || root.readOnly || [...terminalRoots,'cancel_requested','ready'].includes(root.status);
  $('cancel').hidden=!!root && (root.readOnly || [...terminalRoots,'ready'].includes(root.status));
  $('cancel-confirm').disabled=$('cancel').disabled;
}
async function showDetail(id) {
  const version=selectionVersion, request=++detailRequest;
  const current=()=>selectedId === id && version === selectionVersion && request === detailRequest;
  try { const detail=await (id.startsWith('oc-') ? window.api.tasksExternalGet(id) : window.api.tasksGet(id)); if(current()) renderDetail(detail); }
  catch(error) { if(current()) throw error; }
}
async function selectTask(id) {
  if (busy) return;
  if (selectedId) responseDrafts.set(selectedId,$('response').value);
  selectedId=id; selectionVersion++; detailCache=null; $('response').value=responseDrafts.get(id) || ''; $('confirm-cancel').hidden=true;
  $('detail').hidden=true; $('detail-empty').hidden=false; text('detail-empty','작업 상태를 불러오고 있습니다…'); renderList(); updateControls();
  try { await showDetail(id); } catch(e) { if(selectedId===id) { text('detail-empty','상세를 불러오지 못했습니다. 연결을 확인한 뒤 새로고침해 주세요.'); notice(`상세 정보를 불러오지 못했습니다. 새로고침해 주세요. ${e.message}`); } }
}
let managedRefresh=null, externalRefresh=null;
async function refreshIndex(source) {
  rootsCache=[...managedRoots,...externalRoots]; renderList(); updateControls();
  if (selectedId && !rootsCache.some(r=>r.id===selectedId)) { notice('선택한 기록이 현재 조회 범위에서 사라졌습니다.'); selectedId=null; selectionVersion++; detailCache=null; $('detail').hidden=true; $('detail-empty').hidden=false; text('detail-empty','목록에서 확인할 기록을 선택해 주세요.'); return; }
  if (!selectedId && rootsCache.length) {
    const query=$('search').value.trim().toLowerCase();
    const candidates=rootsCache.filter(r=>(sourceFilter==='all'||(r.source||'switcher')===sourceFilter)&&(filter==='all'||category(r)===filter)&&[r.goal,r.projectPath,accountName(r.coordinator),r.coordinator?.model].join(' ').toLowerCase().includes(query));
    const best=candidates.find(r=>category(r)!=='done')||candidates[0];if(best)await selectTask(best.id);
  } else if(selectedId && (selectedId.startsWith('oc-') ? source==='openclaw' : source==='switcher')) {
    const row=rootsCache.find(r=>r.id===selectedId);
    if(row?.status==='observed_stale'){ if(detailCache)renderDetail({...detailCache,root:row}); badge($('detail-status'),'needs_attention',status('observed_stale'));text('coordinator-state','OpenClaw 연결 끊김 · 아래는 이전에 조회한 기록입니다.');}
    else try{await showDetail(selectedId);}catch(e){notice(`상세 조회 실패 · ${e.message}`);}
  }
}
function refreshManaged() {
  if(managedRefresh)return managedRefresh;
  managedRefresh=(async()=>{
    try {
      managedRoots=await window.api.tasksList();connected=true;lastSync=Date.now();
      if(fetchNotice && $('notice').textContent===fetchNotice)notice();fetchNotice=null;
      text('service','서비스 연결됨');$('service').className='';text('last-sync',`마지막 확인 ${time(lastSync)}`);
      await refreshIndex('switcher');
    }catch(e){
      connected=false;text('service','연결 확인 필요');$('service').className='offline';text('last-sync',lastSync?`${time(lastSync)}의 이전 상태를 표시 중`:'상태를 불러오지 못했습니다');
      fetchNotice=`최신 상태를 가져오지 못했습니다. 작업 오류와는 별개입니다. 새로고침으로 다시 확인하세요.\n${e.message}`;notice(fetchNotice);
    }finally{managedRefresh=null;updateControls();}
  })();return managedRefresh;
}
function refreshExternal() {
  if(!window.api.tasksExternalList)return Promise.resolve();
  if(externalRefresh)return externalRefresh;
  externalRefresh=(async()=>{
    let ext;
    try{ext=await window.api.tasksExternalList();}catch{ext={status:'offline'};}
    if(Array.isArray(ext.roots))externalRoots=ext.roots;
    if(ext.status!=='ok')externalRoots=externalRoots.map(r=>({...r,status:'observed_stale'}));
    text('external-sync',ext.status==='ok'?`OpenClaw ${externalRoots.length}개 대화 · 최근 ${ext.windowHours||24}시간${ext.truncated?' · 일부 표시':''} · ${time(ext.checkedAt)} 확인`:ext.status==='unavailable'?'OpenClaw 미설치':'OpenClaw 연결 확인 필요 · 새로고침으로 재시도');
    await refreshIndex('openclaw');
  })().finally(()=>{externalRefresh=null;});return externalRefresh;
}
async function refresh() { await Promise.allSettled([refreshManaged(),refreshExternal()]); }
async function action(fn) {
  if (busy) return;
  busy=true; notice(); updateControls();
  try { await fn(); void refreshExternal(); await refreshManaged(); } catch(e) { notice(e.message); }
  finally { busy=false; updateControls(); }
}
function setForm(open) { $('create-task').open=open; $('open-form').setAttribute('aria-expanded',String(open)); if(open) $('goal').focus(); else $('open-form').focus(); }
let folderView=null, folderRequest=0;
function renderFolderList() {
  const query=$('folder-search').value.trim().toLocaleLowerCase();
  const folders=(folderView?.folders || []).filter(f=>f.name.toLocaleLowerCase().includes(query));
  $('folder-list').replaceChildren();
  for(const folder of folders){const button=document.createElement('button');button.type='button';button.textContent=folder.name;button.onclick=()=>browseProjectFolder(folder.path);$('folder-list').append(button);}
  text('folder-status', folders.length ? `${folders.length}개 폴더` : query ? '일치하는 폴더 없음' : '하위 폴더 없음');
}
async function browseProjectFolder(path='') {
  const version=++folderRequest;folderView=null;$('folder-select').disabled=true;$('folder-up').disabled=true;$('folder-list').replaceChildren();$('folder-error').hidden=true;text('folder-status','불러오는 중…');
  try{
    const data=await window.api.tasksBrowseFolders(path);
    if(version!==folderRequest || !$('folder-dialog').open)return;
    folderView=data;text('folder-path',data.path);$('folder-search').value='';$('folder-roots').replaceChildren();
    for(const root of data.roots){const button=document.createElement('button');button.type='button';button.textContent=root.name;button.onclick=()=>browseProjectFolder(root.path);$('folder-roots').append(button);}
    $('folder-up').disabled=!data.parent;$('folder-select').disabled=false;renderFolderList();
  }catch(e){if(version!==folderRequest || !$('folder-dialog').open)return;text('folder-status','');text('folder-error',e.message);$('folder-error').hidden=false;}
}
$('choose-project').onclick=async()=>{
  const button=$('choose-project');button.disabled=true;
  try{
    if(window.api.tasksChooseProject){const selected=await window.api.tasksChooseProject($('project').value.trim());if(selected){$('project').value=selected;$('project').dispatchEvent(new Event('input',{bubbles:true}));}}
    else if(window.api.tasksBrowseFolders){
      $('folder-roots').replaceChildren();const home=document.createElement('button');home.type='button';home.textContent='홈';home.onclick=()=>browseProjectFolder();$('folder-roots').append(home);
      text('folder-path','');$('folder-search').value='';$('folder-dialog').showModal();await browseProjectFolder($('project').value.trim());
    }else throw Error('폴더 선택을 사용할 수 없습니다. 화면을 새로고침해 주세요.');
  }catch(e){notice(e.message);}finally{button.disabled=false;}
};
$('folder-up').onclick=()=>{if(folderView?.parent)browseProjectFolder(folderView.parent);};
$('folder-search').oninput=renderFolderList;
$('folder-close').onclick=$('folder-cancel').onclick=()=>$('folder-dialog').close();
$('folder-dialog').onclose=()=>{folderRequest++;folderView=null;$('choose-project').focus();};
$('folder-select').onclick=()=>{if(!folderView)return;$('project').value=folderView.path;$('project').dispatchEvent(new Event('input',{bubbles:true}));$('folder-dialog').close();};
window.api.onState(state => { snapshot=state; renderAccounts(); });
$('main-tool').onchange=renderAccounts;
$('toggle-terminals').onclick=()=>{
  const nodes=Array.from(document.querySelectorAll('.terminal:not([hidden])'));
  const open=nodes.some(node=>!node.open);for(const node of nodes)node.open=open;
};
$('open-form').onclick=() => setForm(!$('create-task').open); $('close-form').onclick=() => setForm(false);
$('create-task').ontoggle=() => $('open-form').setAttribute('aria-expanded',String($('create-task').open));
document.querySelectorAll('.metric').forEach(b => b.onclick=() => { filter=filter === b.dataset.filter ? 'all' : b.dataset.filter; syncTaskIndex(true); renderList(); });
$('filter-all').onclick=() => { filter='all'; $('search').value=''; syncTaskIndex(true); renderList(); }; $('search').oninput=renderList;
$('refresh').onclick=() => action(async () => { snapshot=await window.api.state(); await loadBindings(false); renderAccounts(); });
$('submit-form').onsubmit=event => {
  event.preventDefault();
  action(async () => {
    const mainTool=$('main-tool').value;
    const participants=Array.from(document.querySelectorAll('#participants input[type=checkbox]:checked')).map(el => { const model=el.closest('.account-row').querySelector('.participant-model').value.trim(); return {...JSON.parse(el.value),...(model ? {model} : {})}; });
    if(!participants.length) throw Error(' 함께 일할 계정을 한 개 이상 선택해 주세요.');
    if(!$('project').value.trim() || !$('goal').value.trim()) throw Error('작업 내용과 프로젝트 폴더를 입력해 주세요.');
    const mainModel=mainTool === 'openclaw' ? '' : $('main-model').value.trim();
    const root=await window.api.tasksSubmit({requestId,mainTool,...(mainModel ? {mainModel} : {}),bindingId:$('binding').value,projectPath:$('project').value.trim(),goal:$('goal').value.trim(),permission:$('permission').value,executionPolicy:$('execution-policy').value,participants});
    selectedId=root.id; selectionVersion++; detailCache=null; filter='all'; $('search').value=''; $('response').value=''; $('confirm-cancel').hidden=true;
    requestId=crypto.randomUUID(); setForm(false); notice('작업을 맡겼습니다. 아래에서 담당별 상태를 확인하세요.');
  });
};
$('ack').onclick=() => { if(selectedId?.startsWith('oc-')||detailCache?.root.readOnly)return; const id=selectedId,version=detailCache?.root.finalVersion; action(async()=>{ await window.api.tasksAck(id,version); notice('결과 확인을 기록했습니다.'); }); };
$('respond').onclick=() => { if(selectedId?.startsWith('oc-')||detailCache?.root.readOnly)return; const id=selectedId; action(async()=>{ const value=$('response').value.trim(); if(!value) throw Error('답변이나 다음 지시를 입력해 주세요.'); const root=detailCache.root, retryTaskIds=detailCache.tasks.filter(t=>t.state==='blocked').map(t=>t.id), extraRounds=Number($('extra-rounds').value), enableBuild=$('resume-build').checked && !$('resume-build').disabled; if(retryTaskIds.length || extraRounds || enableBuild) { const request={requestId:resumeRequestId,extraRounds,retryTaskIds,message:value,...(enableBuild ? {executionPolicy:'build-test'} : {})}; await window.api.tasksResume(id,request); resumeRequestId=crypto.randomUUID(); } else await window.api.tasksRespond(id,value); $('response').value=''; responseDrafts.delete(id); notice('답변을 보냈습니다. 담당자가 작업을 이어갑니다.'); }); };
$('cancel').onclick=()=>{ if(selectedId?.startsWith('oc-')||detailCache?.root.readOnly)return; $('confirm-cancel').hidden=false; $('cancel-back').focus(); };
$('cancel-back').onclick=()=>{ $('confirm-cancel').hidden=true; $('cancel').focus(); };
$('cancel-confirm').onclick=()=>{ if(selectedId?.startsWith('oc-')||detailCache?.root.readOnly)return; const id=selectedId; action(async()=>{ await window.api.tasksCancel(id); $('confirm-cancel').hidden=true; notice('중단을 요청했습니다. 실행 종료를 확인하고 있습니다.'); }); };
async function loadBindings(auto) {
  const bindings=await window.api.tasksBindings(), previous=$('binding').value; $('binding').replaceChildren();
  for(const b of bindings) { const o=document.createElement('option'); o.value=b.id; o.textContent=b.label || b.sessionKey; $('binding').append(o); }
  if(bindings.some(b=>b.id===previous)) $('binding').value=previous;
  $('openclaw-option').disabled=!bindings.length;
  if(auto && bindings.length === 1) $('main-tool').value='openclaw';
}
(async()=>{ try { snapshot=await window.api.state(); renderAccounts(); await window.api.tasksStart(); await loadBindings(true); renderAccounts(); await refresh(); } catch(e) { connected=false; text('service','서비스 연결 실패'); $('service').className='offline'; fetchNotice=`서비스에 연결하지 못했습니다. 새로고침해 주세요. ${e.message}`; notice(fetchNotice); updateControls(); } })();
$('source-filter').onchange=()=>{sourceFilter=$('source-filter').value;renderList();syncTaskIndex(true);};
setInterval(()=>{ if(!document.hidden && !busy) refresh(); },5000);

$('permission').addEventListener('change',()=>{ const write=$('permission').value==='workspace-write'; $('execution-policy').disabled=!write; $('execution-policy').value=write ? 'build-test' : 'edit-only'; });
