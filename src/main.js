'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const P = require('./paths');
const store = require('./store');
const claude = require('./claude');
const codex = require('./codex');
const apiKeys = require('./api-keys');
const apiCost = require('./api-cost');
const wrappers = require('./wrappers');
const terminal = require('./terminal');
const { modelCatalog } = require('./model-catalog');

const edition = require('./edition.json');
const INSPECT = { claude: claude.inspect, codex: codex.inspect };
const antigravity = require('./antigravity').manager();
const exaone = require('./exaone');
const providers = require('./providers');
let win = null;
let tray = null;
let tasksWin = null;

const usageApi = edition.directUsageApi ? require('./usage-api') : null;
function requireUsageApi() { if (!usageApi) throw new Error('이 배포판은 로컬 사용량 기록만 지원합니다.'); }
let apiErrors = {};
const resetAutoUse = require('./reset-credit-auto-use').createAutoUse(store, { onChange: refresh });

// Server-side usage lookup. Scheduling policy (freshness window, backoff, sequential calls)
// lives in usage-api.refreshAll; this just wires modes: 'auto' (panel open or background timer, only when the
// setting is on), 'manual' (⌘R), 'force' (explicit per-account click / post-login one-off).
async function apiRefresh(mode, only, tools = P.TOOLS) {
  if (!usageApi) { if (mode === 'auto') return null; requireUsageApi(); }
  const state = store.load();
  if (mode === 'auto' && !state.apiFetch) return null;
  const r = await usageApi.refreshAll(store, tools, { mode, only });
  for (const tool of Object.keys(r)) for (const [name, v] of Object.entries(r[tool])) {
    const key = `${tool}/${name}`;
    if (v === 'ok') delete apiErrors[key];
    else if (!String(v).startsWith('skip:')) apiErrors[key] = v;
  }
  refresh();
  return usageApi.summarize(r);
}

// Organization spend for API-key accounts (admin key). Independent of the subscription usage API so it
// also works in the distribution edition; automatic calls are at most every 30 minutes per account.
async function costRefresh(opts = {}) {
  const r = await apiCost.refreshAll(store.load(), opts);
  if (Object.keys(r).length) refresh();
  return r;
}

// After "add" or "login" we can't know when the browser login finishes, so poll the account
// status until login finishes. A post-login API lookup requires the user's API setting.
const loginWatchers = new Map();
function watchLogin(tool, name) {
  const key = `${tool}/${name}`;
  if (tool === 'codex') resetAutoUse.setEnabled(name, false).catch(() => {});
  if (loginWatchers.has(key)) clearInterval(loginWatchers.get(key));
  const home = store.profileHome(tool, name);
  const startedAt = Date.now();
  if (tool === 'claude') claude.invalidate(home); else if (tool === 'codex') codex.invalidate(home);
  const wasLoggedIn = INSPECT[tool](home).loggedIn;
  let seenLogout = !wasLoggedIn; // for re-login on an already logged-in account, wait for a change
  const authMtime = () => { try { return require('fs').statSync(({ codex: path.join(home, 'auth.json'), claude: path.join(home, '.claude.json'), gemini: path.join(P.configDir('gemini', home), 'oauth_creds.json') })[tool]).mtimeMs; } catch { return 0; } };
  const mtime0 = authMtime();
  const timer = setInterval(async () => {
    if (Date.now() - startedAt > 10 * 60 * 1000) { clearInterval(timer); loginWatchers.delete(key); return; }
    let info;
    if (tool === 'claude') claude.invalidate(home); else if (tool === 'codex') codex.invalidate(home); // bypass the 60 s auth-status cache while waiting
    try { info = INSPECT[tool](home); } catch { return; }
    if (!info.loggedIn) { seenLogout = true; return; }
    if (!seenLogout && authMtime() === mtime0) return; // nothing changed yet
    clearInterval(timer); loginWatchers.delete(key);
    if (tool === 'codex') require('./codex-reset-credits').invalidate(home);
    if (edition.credentialMetadata && tool === 'claude') require('./claude-cred').token(home);
    refresh();
    if (usageApi && store.load().apiFetch) await apiRefresh('force', key).catch(() => {});
  }, 3000);
  loginWatchers.set(key, timer);
}

function snapshot() {
  const state = store.load();
  const out = { tools: {}, pathStatus: wrappers.pathStatus(), usageHook: wrappers.usageHookStatus(), root: P.ROOT, isWin: P.IS_WIN, directUsageApi: edition.directUsageApi, edition: edition.name, apiFetch: Boolean(usageApi && state.apiFetch), apiErrors, apiMeta: state.apiMeta || {}, apiIntervalMinutes: state.apiIntervalMinutes || (usageApi?.DEFAULT_INTERVAL_MIN || 30), usageMode: state.usageMode || 'used', density: state.density || 'compact', zoom: zoom(), zooms: ZOOMS };
  for (const tool of P.TOOLS) {
    out.tools[tool] = {
      active: state[tool].active,
      profiles: state[tool].profiles.map((name) => {
        const home = store.profileHome(tool, name);
        let info;
        try { info = INSPECT[tool](home); } catch (e) { info = { error: e.message, home }; }
        const out = { name, label: store.label(state, tool, name), isDefault: name === 'default', ...info, ...(tool === 'claude' ? { apiKey: apiKeys.status('claude', name) } : { apiKey: { apiKey: /^api_?key$/i.test(info.authMode || ''), masked: null } }), ...(tool === 'codex' ? { resetAutoUse: resetAutoUse.summary(name) } : {}), models: modelCatalog(tool, home) };
        if (out.apiKey?.apiKey) out.apiCost = apiCost.snapshot(tool, name, Date.now(), { configDir: tool === 'claude' ? P.configDir('claude', home) : null });
        return out;
      }),
    };
  }
  out.antigravity = antigravity.snapshot();
  for (const p of providers.list) out[p.ID] = p.snapshot(state);
  return out;
}

// CSS px. Compact (one line per account) is wider so identity, both quota windows and the Codex reset actions
// share a line; comfortable keeps the original two-line width. Height = max (also capped to the work area).
const PANEL = { width: 440, compactWidth: 560, height: 1000 };
function panelWidth(z = zoom()) {
  const css = store.load().density === 'comfortable' ? PANEL.width : PANEL.compactWidth;
  let avail = Infinity;
  try { avail = require('electron').screen.getPrimaryDisplay().workArea.width - 16; } catch {}
  return Math.round(Math.min(css * z, Math.max(PANEL.width * z, avail)));
}
// UI scale ("글자 크기"). Window size = CSS px × zoom; the renderer keeps measuring in CSS px.
const ZOOMS = [1, 1.1, 1.25, 1.5];
function zoom() { const z = Number(store.load().zoom); return ZOOMS.includes(z) ? z : 1; }

function createWindow() {
  win = new BrowserWindow({
    width: panelWidth(), height: PANEL.height, show: false,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: true,
    transparent: process.platform === 'darwin', backgroundColor: process.platform === 'darwin' ? '#00000000' : '#0f172a',
    title: 'CLI Account Switch',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, zoomFactor: zoom() },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), process.argv.includes('--screenshot-menu') ? { hash: 'menu' } : {});
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  // Popover behaviour: clicking anywhere else dismisses the panel.
  win.on('blur', () => { if (!win.webContents.isDevToolsOpened()) win.hide(); });
  // Dev aid: `electron . --screenshot out.png` renders the window, saves it, and quits.
  const shotIdx = process.argv.indexOf('--screenshot');
  if (shotIdx > 0 && process.argv[shotIdx + 1]) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.capturePage();
      require('fs').writeFileSync(process.argv[shotIdx + 1], img.toPNG());
      app.isQuitting = true; app.quit();
    }, 1500));
  }
}

// Place the panel directly under (or, on Windows with a bottom taskbar, above) the tray icon.
function positionPanel() {
  const { screen } = require('electron');
  const tb = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const area = display.workArea;
  const [w, h] = win.getSize();
  let x = Math.round(tb.x + tb.width / 2 - w / 2);
  x = Math.max(area.x, Math.min(x, area.x + area.width - w));
  const below = tb.y + tb.height + h <= area.y + area.height || tb.y < area.y + area.height / 2;
  const y = below ? Math.round(tb.y + tb.height + 4) : Math.round(tb.y - h - 4);
  win.setPosition(x, Math.max(area.y, y), false);
}

function showWindow() {
  if (!win) createWindow();
  positionPanel();
  win.webContents.send('state', snapshot());
  win.show(); win.focus();
  apiRefresh('auto').catch(() => {});
  costRefresh().catch(() => {});
}
function togglePanel() { if (win && win.isVisible()) win.hide(); else showWindow(); }

function openTasksWindow() {
  if (tasksWin && !tasksWin.isDestroyed()) { tasksWin.show(); tasksWin.focus(); return true; }
  tasksWin = new BrowserWindow({
    width: 1100, height: 820, minWidth: 800, minHeight: 600, title: '작업 관리 · CLI Account Switch',
    backgroundColor: '#0f172a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  tasksWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  tasksWin.webContents.on('will-navigate', (event) => event.preventDefault());
  tasksWin.loadFile(path.join(__dirname, 'renderer', 'tasks.html'));
  tasksWin.on('closed', () => { tasksWin = null; });
  return true;
}

function buildTrayMenu() {
  const snap = snapshot();
  const sub = (tool) => snap.tools[tool].profiles.map((p) => ({
    label: `${p.label}${p.email ? '  ·  ' + p.email : ''}`,
    type: 'radio', checked: p.name === snap.tools[tool].active,
    click: () => { store.setActive(tool, p.name); refresh(); },
  }));
  return Menu.buildFromTemplate([
    { label: 'Claude Code', submenu: sub('claude') },
    { label: 'Codex', submenu: sub('codex') },
    { type: 'separator' },
    { label: '패널 열기', click: showWindow },
    { label: '작업 관리', click: openTasksWindow },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function refresh() {
  if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
  if (tasksWin && !tasksWin.isDestroyed()) tasksWin.webContents.send('state', snapshot());
}

app.whenReady().then(() => {
  try { wrappers.installShims(); } catch (e) { console.error('shim install failed', e); }
  const icon = require('./icon').trayIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  if (icon.isEmpty()) tray.setTitle('⇄'); // fallback: text glyph is always visible on macOS
  tray.setToolTip('CLI Account Switch');
  // Left click: popover panel. Right click: quick-switch context menu.
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  createWindow();
  if (!process.argv.includes('--screenshot')) {
    if (usageApi) {
      const stop = require('./claude-refresh').startUsageRefresh(apiRefresh);
      app.once('before-quit', stop);
    }
    const stopReset = resetAutoUse.start(globalThis, require('electron').powerMonitor);
    app.once('before-quit', stopReset);
    const stopLocal = require('./local-refresh').startLocalRefresh(refresh);
    app.once('before-quit', stopLocal);
    const costTimer = setInterval(() => costRefresh().catch(() => {}), apiCost.STALE_MS);
    costRefresh().catch(() => {});
    app.once('before-quit', () => clearInterval(costTimer));
  }
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menu bar app, no Dock icon
  app.on('activate', showWindow);
  if (process.argv.includes('--screenshot')) showWindow();
});

ipcMain.handle('hide', () => { if (win) win.hide(); return true; });
// Fit the panel to its content (renderer reports the natural height).
ipcMain.handle('resize', (_e, h) => {
  if (!win) return false;
  const z = zoom();
  // The panel opens 4px under the menu bar, so only a small margin above the Dock/taskbar is needed.
  const maxH = Math.min(Math.round(PANEL.height * z), require("electron").screen.getPrimaryDisplay().workArea.height - 16);
  const height = Math.max(240, Math.min(maxH, Math.ceil(h * z)));
  const width = panelWidth(z);
  const [cw, ch] = win.getSize();
  if (cw !== width || ch !== height) { win.setSize(width, height, false); if (win.isVisible()) positionPanel(); }
  return true;
});
ipcMain.handle('setZoom', (_e, z) => {
  const v = ZOOMS.includes(Number(z)) ? Number(z) : 1;
  store.setSetting('zoom', v);
  if (win) { win.webContents.setZoomFactor(v); win.setSize(panelWidth(v), win.getSize()[1], false); }
  refresh();
  return true;
});
ipcMain.handle('quit', () => { app.isQuitting = true; app.quit(); return true; });
ipcMain.handle('setApiFetch', async (_e, on) => { requireUsageApi(); store.setSetting('apiFetch', Boolean(on)); refresh(); return on ? (await apiRefresh('auto')).text : 'API 조회를 껐습니다'; });
ipcMain.handle('setApiInterval', (_e, min) => { requireUsageApi(); store.setSetting('apiIntervalMinutes', Math.max(1, Number(min) || (usageApi?.DEFAULT_INTERVAL_MIN || 30))); refresh(); return true; });
ipcMain.handle('apiRefresh', async () => (await apiRefresh('manual')).text);
ipcMain.handle('apiRefreshOne', async (_e, tool, name) => {
  requireUsageApi();
  const key = `${tool}/${name}`;
  const r = await usageApi.refreshAll(store, [tool], { mode: 'force', only: key });
  const v = r[tool][name];
  if (v === 'ok') delete apiErrors[key]; else if (!String(v).startsWith('skip:')) apiErrors[key] = v;
  refresh();
  if (tool === 'codex') {
    const reset = codex.inspect(store.profileHome(tool, name)).resetCredits;
    const value = reset.availableCount !== null ? `${reset.availableCount}개${reset.stale ? ' (이전 값)' : ''}` : reset.status === 'unavailable' ? '정보 미제공' : '미조회';
    const resetNote = reset.status === 'error' ? `리셋권 조회 실패${reset.availableCount !== null ? ' · 이전 ' + reset.availableCount + '개' : ''}` : `리셋권 ${value}`;
    const usageNote = v === 'ok' ? '사용량 조회 완료' : String(v).startsWith('skip:') ? '사용량: ' + v.slice(6) : '사용량 조회 실패';
    return `${usageNote} · ${resetNote}`;
  }
  if (v === 'ok') return '조회했습니다';
  throw new Error(String(v).startsWith('skip:') ? v.replace(/^skip: /, '건너뜀: ') : `API 조회 실패: ${v}`);
});
ipcMain.handle('setResetAutoUse', async (event, name, on) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('계정 패널에서만 설정할 수 있습니다');
  await resetAutoUse.setEnabled(name, on);
  refresh();
  return on ? '만료 10분 전 자동 사용을 켰습니다 · 앱이 실행 중일 때 동작합니다' : '리셋권 자동 사용을 껐습니다';
});
const panelOnly = (event) => { if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('계정 패널에서만 사용할 수 있습니다'); };
ipcMain.handle('checkResetCredits', async (event, name) => {
  panelOnly(event);
  const r = await resetAutoUse.check(store.resolve('codex', name));
  refresh();
  return `리셋권 ${r.count}개${r.nearestExpiry ? ' · 가장 빠른 만료 ' + new Date(r.nearestExpiry).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}`;
});
ipcMain.handle('useResetCredit', async (event, name) => {
  panelOnly(event);
  try { return await resetAutoUse.useNow(store.resolve('codex', name)); } finally { refresh(); }
});
ipcMain.handle('openResetAutoUseLog', async (_event, name) => {
  const id = store.resolve('codex', name);
  const file = path.join(store.profileHome('codex', id), require('./reset-credit-auto-use').LOG);
  if (!require('fs').existsSync(file)) return '아직 자동 사용 기록이 없습니다';
  shell.showItemInFolder(file);
  return '자동 사용 로그 파일 위치를 열었습니다';
});
ipcMain.handle('setUsageMode', (_e, mode) => { store.setSetting('usageMode', mode === 'remaining' ? 'remaining' : 'used'); refresh(); return true; });
ipcMain.handle('setDensity', (_e, d) => { store.setSetting('density', d === 'comfortable' ? 'comfortable' : 'compact'); refresh(); return true; });

app.on('window-all-closed', (e) => e && e.preventDefault && e.preventDefault());
// ⌘Q / AppleScript quit / OS shutdown: let the window actually close instead of hiding.
app.on('before-quit', () => { antigravity.cancelUsage(); app.isQuitting = true; });

ipcMain.handle('state', () => snapshot());
ipcMain.handle('antigravity', async (_e, action, value) => {
  if (!['check', 'save', 'activate', 'remove', 'recover', 'refreshUsage'].includes(action)) throw Error('Unsupported Antigravity action');
  if (action === 'refreshUsage') {
    const pending = antigravity.refreshUsage(); refresh();
    try { return await pending; } finally { refresh(); }
  }
  if (action === 'activate') {
    const answer = await dialog.showMessageBox(win, { type: 'question', buttons: ['취소', '공용 로그인 전환'], defaultId: 0, cancelId: 0,
      message: 'Antigravity 공용 로그인을 전환할까요?', detail: '이 컴퓨터의 Antigravity 앱·IDE·CLI가 공유하는 인증을 변경합니다. 모두 종료한 뒤 전환해 주세요. 앱을 자동 종료하거나 다시 시작하지 않습니다.' });
    if (answer.response !== 1) return { cancelled: true };
  }
  const result = await antigravity[action](value); refresh(); return result;
});
// API-key provider categories (exaone, gemini-api) share one action set; the key value only
// ever travels renderer → main → key file.
async function providerAction(p, action, value, extra) {
  if (!['add', 'remove', 'setActive', 'rename', 'setKey', 'removeKey', 'check', 'openDocs'].includes(action)) throw Error(`Unsupported ${p.SHORT} action`);
  if (action === 'openDocs') { await shell.openExternal(p.DOCS); return true; }
  if (action === 'remove') {
    // A modal dialog steals focus; keep the panel open while it is up.
    const id = p.resolve(value);
    win.removeAllListeners('blur');
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['제거', '취소'], defaultId: 0, cancelId: 1,
      message: `${p.SHORT} 계정 "${p.label(store.load(), id)}" 제거`, detail: '등록된 API 키 파일도 함께 삭제됩니다.',
    });
    win.on('blur', () => { if (!win.webContents.isDevToolsOpened()) win.hide(); });
    if (response !== 0) return false;
    p.remove(id); refresh(); return true;
  }
  if (action === 'setKey') {
    const r = p.setKey(value, typeof extra === 'string' ? extra : '');
    refresh();
    return `${p.label(store.load(), r.id)}: API 키 등록됨 (${r.masked})${r.warning ? ' · ' + r.warning : ''}`;
  }
  if (action === 'removeKey') { const r = p.removeKey(value); refresh(); return `${p.label(store.load(), r.id)}: ${r.removed ? 'API 키 제거됨' : '등록된 API 키 없음'}`; }
  if (action === 'check') {
    const r = await p.check(value); refresh();
    if (!r.ok) throw new Error(`연결 실패: ${r.error}`);
    const minute = r.rateLimit && r.rateLimit.minute;
    const rate = minute && minute.remaining != null ? ` · 분 남은 호출 ${minute.remaining}/${minute.limit ?? '?'}` : '';
    return `${p.label(store.load(), r.id)}: 연결 확인 완료${r.models.length ? ' · ' + r.models.join(', ') : ''}${rate}`;
  }
  if (action === 'rename') { const r = p.rename(value, extra); refresh(); return r; }
  const r = p[action](value); refresh(); return r;
}
ipcMain.handle('provider', (_e, id, action, value, extra) => {
  const p = providers.byId[id];
  if (!p) throw Error('Unknown provider');
  return providerAction(p, action, value, extra);
});
ipcMain.handle('exaone', (_e, action, value, extra) => providerAction(exaone, action, value, extra));
ipcMain.handle('setActive', (_e, tool, name) => { store.setActive(tool, name); refresh(); return snapshot(); });
ipcMain.handle('addProfile', (_e, tool, name, opts) => { const r = store.addProfile(tool, name, opts); refresh(); return r; });
ipcMain.handle('rename', (_e, tool, name, newLabel) => { const r = store.rename(tool, name, newLabel); refresh(); return r; });
ipcMain.handle('removeProfile', async (_e, tool, name) => {
  // A modal dialog steals focus; keep the panel open while it is up.
  win.removeAllListeners('blur');
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['목록에서만 제거', '파일까지 삭제', '취소'], defaultId: 0, cancelId: 2,
    message: `계정 "${store.label(store.load(), tool, name)}" 제거`, detail: '파일까지 삭제하면 이 계정의 로그인 정보와 세션 기록이 지워집니다.',
  });
  win.on('blur', () => { if (!win.webContents.isDevToolsOpened()) win.hide(); });
  if (response === 2) return false;
  store.removeProfile(tool, name, { deleteFiles: response === 1 });
  if (['claude', 'codex'].includes(tool)) { apiCost.removeKey(tool, name); apiCost.clearBalance(tool, name); }
  refresh();
  return true;
});
ipcMain.handle('setApiKey', (_e, tool, name, key) => {
  if (!P.TOOLS.includes(tool)) throw new Error('Unsupported tool');
  const id = store.resolve(tool, name);
  const r = apiKeys.register(tool, id, typeof key === 'string' ? key : '');
  (tool === 'claude' ? claude : codex).invalidate(store.profileHome(tool, id));
  refresh();
  return `${store.label(store.load(), tool, id)}: API 키 등록됨 (${r.masked})${r.warning ? ' · ' + r.warning : ''}`;
});
// Admin key for month-to-date organization spend (API-key accounts only). The key never comes back to the renderer.
ipcMain.handle('apiCost', async (_e, action, tool, name, key) => {
  if (action === 'refreshAll') {
    const r = await costRefresh({ force: true });
    const n = Object.keys(r).length, failed = Object.values(r).filter((v) => v !== 'ok').length;
    return n ? `사용 금액 ${n - failed}/${n}개 계정 갱신${failed ? ' · 실패 ' + failed : ''}` : '';
  }
  if (!['claude', 'codex'].includes(tool)) throw new Error('Unsupported tool');
  const id = store.resolve(tool, name);
  const label = store.label(store.load(), tool, id);
  if (action === 'setKey') {
    const r = apiCost.setKey(tool, id, typeof key === 'string' ? key : '');
    refresh();
    const v = await apiCost.refresh(tool, id, { force: true });
    refresh();
    return `${label}: 관리자 키 등록됨 (${r.masked})${r.warning ? ' · ' + r.warning : ''} · ${v === 'ok' ? '사용 금액 조회 완료' : '사용 금액 조회 실패: ' + v}`;
  }
  if (action === 'removeKey') { apiCost.removeKey(tool, id); refresh(); return `${label}: 관리자 키 제거됨`; }
  if (action === 'setBalance') { const b = apiCost.setBalance(tool, id, key); refresh(); return `${label}: 잔액 기준 $${b.baseUsd.toFixed(2)} 저장 · 이후 이 PC의 Claude Code 사용 금액을 차감해 추정합니다`; }
  if (action === 'clearBalance') { apiCost.clearBalance(tool, id); refresh(); return `${label}: 잔액 기준을 지웠습니다`; }
  if (action === 'refresh') {
    const pending = apiCost.refresh(tool, id, { force: true }); refresh();
    const v = await pending; refresh();
    if (v === 'ok') return `${label}: 사용 금액 조회 완료`;
    throw new Error(String(v).startsWith('skip:') ? v.replace(/^skip: /, '') : `사용 금액 조회 실패: ${v}`);
  }
  throw new Error('Unsupported action');
});
ipcMain.handle('removeApiKey', (_e, tool, name) => {
  if (!P.TOOLS.includes(tool)) throw new Error('Unsupported tool');
  const id = store.resolve(tool, name);
  apiKeys.unregister(tool, id);
  (tool === 'claude' ? claude : codex).invalidate(store.profileHome(tool, id));
  refresh();
  return `${store.label(store.load(), tool, id)}: API 키 제거됨`;
});
ipcMain.handle('login', (_e, tool, name) => { terminal.openLoginTerminal(tool, store.profileHome(tool, name), name === 'default'); watchLogin(tool, name); return true; });
ipcMain.handle('installShims', () => { const r = wrappers.installShims(); refresh(); return r; });
ipcMain.handle('registerPath', () => {
  const r = wrappers.registerPath(); refresh();
  return r.alreadyPresent ? `${r.file.replace(P.HOME, '~')}에 이미 있습니다. 새 터미널을 열어 확인하세요.` : `${r.file.replace(P.HOME, '~')}에 추가했습니다. ${r.note}`;
});
ipcMain.handle('usageHook', (_e, enable) => { const r = enable ? wrappers.enableUsageHook() : wrappers.disableUsageHook(); refresh(); return r || true; });
ipcMain.handle('openHome', (_e, tool, name) => shell.openPath(P.configDir(tool, store.profileHome(tool, name))));
ipcMain.handle('copy', (_e, text) => { require('electron').clipboard.writeText(text); return true; });

// Keep the runtime API narrow: renderers cannot select arbitrary RPC methods.
function taskText(value, name, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 값이 올바르지 않습니다.`);
  return value;
}
function taskSender(event) {
  if (!tasksWin || event.sender !== tasksWin.webContents || event.senderFrame !== tasksWin.webContents.mainFrame) throw new Error('작업 관리 창에서만 사용할 수 있습니다.');
}
async function taskRequest(method, params = {}) {
  const client = require('./runtime/client');
  await client.ensureService({ readOnly: require('./runtime/transport').isReadOnly(method) });
  return client.request(method, params);
}
ipcMain.handle('openTasks', () => openTasksWindow());
ipcMain.handle('tasksChooseProject', async (event, current) => {
  taskSender(event);
  return require('./project-folders').chooseProjectFolder(dialog, tasksWin, current);
});
ipcMain.handle('tasksStart', async (event) => { taskSender(event); return taskRequest('health'); });
ipcMain.handle('tasksBindings', async (event) => { taskSender(event); return taskRequest('bridgeBindings'); });
ipcMain.handle('tasksList', async (event) => {
  taskSender(event); const client = require('./runtime/client');
  await client.ensureService({ readOnly: true }); return client.readDashboardList();
});
const openclawMonitor = require('./dashboard/openclaw').createOpenClawMonitor();
ipcMain.handle('tasksExternalList', async (event) => { taskSender(event); return openclawMonitor.list(); });
ipcMain.handle('tasksExternalGet', async (event, id) => { taskSender(event); return openclawMonitor.get(taskText(id, 'OpenClaw 기록 ID', 100)); });
ipcMain.handle('tasksGet', async (event, id) => {
  taskSender(event); const client = require('./runtime/client');
  await client.ensureService({ readOnly: true });
  return client.readDashboard(taskText(id, '작업 ID', 200));
});
ipcMain.handle('tasksTaskDetail', async (event, id, taskId, resultVersion, queryRevision) => {
  taskSender(event);
  if (!Number.isSafeInteger(resultVersion) || resultVersion < 0) throw Error('결과 버전이 올바르지 않습니다.');
  return require('./runtime/client').readQueryPages(taskText(id, '작업 ID', 200), { view: 'task', taskId: taskText(taskId, '위임 작업 ID', 200), resultVersion, queryRevision: taskText(queryRevision, '조회 버전', 200) });
});
ipcMain.handle('tasksOutput', async (event, id, attemptId) => { taskSender(event); return taskRequest('output', { id: taskText(id, '작업 ID', 200), attemptId: taskText(attemptId, '실행 ID', 200) }); });
function mutableTaskId(id) { const value=taskText(id, '작업 ID', 200); if(value.startsWith('oc-'))throw Error('OpenClaw 기록은 읽기 전용입니다.'); return value; }
ipcMain.handle('tasksCancel', async (event, id) => { taskSender(event); return taskRequest('cancel', { id: mutableTaskId(id) }); });
ipcMain.handle('tasksResume', async (event, id, request) => { taskSender(event); return taskRequest('resume', { id: mutableTaskId(id), request }); });
ipcMain.handle('tasksRespond', async (event, id, request) => { taskSender(event); return taskRequest('respond', { id: mutableTaskId(id), request }); });
ipcMain.handle('tasksSubmit', async (event, input) => {
  taskSender(event);
  const params = require('./runtime/submission').submission(input, store.load());
  return taskRequest('submit', params);
});

ipcMain.handle('tasksAck', async (event, id, version) => {
  taskSender(event);
  if (!Number.isInteger(version) || version < 1) throw new Error('결과 버전이 올바르지 않습니다.');
  return taskRequest('ack', { id: mutableTaskId(id), version });
});
