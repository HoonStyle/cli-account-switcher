'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const P = require('./paths');
const store = require('./store');
const claude = require('./claude');
const codex = require('./codex');
const wrappers = require('./wrappers');
const terminal = require('./terminal');
const { modelCatalog } = require('./model-catalog');

const edition = require('./edition.json');
const INSPECT = { claude: claude.inspect, codex: codex.inspect };
let win = null;
let tray = null;
let tasksWin = null;

const usageApi = edition.directUsageApi ? require('./usage-api') : null;
function requireUsageApi() { if (!usageApi) throw new Error('이 배포판은 로컬 사용량 기록만 지원합니다.'); }
let apiErrors = {};

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

// After "add" or "login" we can't know when the browser login finishes, so poll the account
// status until login finishes. A post-login API lookup requires the user's API setting.
const loginWatchers = new Map();
function watchLogin(tool, name) {
  const key = `${tool}/${name}`;
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
        return { name, label: store.label(state, tool, name), isDefault: name === 'default', ...info, models: modelCatalog(tool, home) };
      }),
    };
  }
  return out;
}

const PANEL = { width: 440, height: 760 }; // CSS px; height = max; the renderer fits to content
// UI scale ("글자 크기"). Window size = CSS px × zoom; the renderer keeps measuring in CSS px.
const ZOOMS = [1, 1.1, 1.25, 1.5];
function zoom() { const z = Number(store.load().zoom); return ZOOMS.includes(z) ? z : 1; }

function createWindow() {
  win = new BrowserWindow({
    width: Math.round(PANEL.width * zoom()), height: PANEL.height, show: false,
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
    const stopLocal = require('./local-refresh').startLocalRefresh(refresh);
    app.once('before-quit', stopLocal);
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
  const maxH = Math.min(Math.round(PANEL.height * z), require("electron").screen.getPrimaryDisplay().workArea.height - 40);
  const height = Math.max(240, Math.min(maxH, Math.ceil(h * z)));
  const width = Math.round(PANEL.width * z);
  const [cw, ch] = win.getSize();
  if (cw !== width || ch !== height) { win.setSize(width, height, false); if (win.isVisible()) positionPanel(); }
  return true;
});
ipcMain.handle('setZoom', (_e, z) => {
  const v = ZOOMS.includes(Number(z)) ? Number(z) : 1;
  store.setSetting('zoom', v);
  if (win) { win.webContents.setZoomFactor(v); win.setSize(Math.round(PANEL.width * v), win.getSize()[1], false); }
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
ipcMain.handle('setUsageMode', (_e, mode) => { store.setSetting('usageMode', mode === 'remaining' ? 'remaining' : 'used'); refresh(); return true; });
ipcMain.handle('setDensity', (_e, d) => { store.setSetting('density', d === 'comfortable' ? 'comfortable' : 'compact'); refresh(); return true; });

app.on('window-all-closed', (e) => e && e.preventDefault && e.preventDefault());
// ⌘Q / AppleScript quit / OS shutdown: let the window actually close instead of hiding.
app.on('before-quit', () => { app.isQuitting = true; });

ipcMain.handle('state', () => snapshot());
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
  refresh();
  return true;
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
  await client.ensureService();
  return client.request(method, params);
}
ipcMain.handle('openTasks', () => openTasksWindow());
ipcMain.handle('tasksChooseProject', async (event, current) => {
  taskSender(event);
  return require('./project-folders').chooseProjectFolder(dialog, tasksWin, current);
});
ipcMain.handle('tasksStart', async (event) => { taskSender(event); return taskRequest('health'); });
ipcMain.handle('tasksBindings', async (event) => { taskSender(event); return taskRequest('bridgeBindings'); });
ipcMain.handle('tasksList', async (event) => { taskSender(event); return taskRequest('list'); });
const openclawMonitor = require('./dashboard/openclaw').createOpenClawMonitor();
ipcMain.handle('tasksExternalList', async (event) => { taskSender(event); return openclawMonitor.list(); });
ipcMain.handle('tasksExternalGet', async (event, id) => { taskSender(event); return openclawMonitor.get(taskText(id, 'OpenClaw 기록 ID', 100)); });
ipcMain.handle('tasksGet', async (event, id) => { taskSender(event); return taskRequest('get', { id: taskText(id, '작업 ID', 200) }); });
ipcMain.handle('tasksOutput', async (event, id, attemptId) => { taskSender(event); return taskRequest('output', { id: taskText(id, '작업 ID', 200), attemptId: taskText(attemptId, '실행 ID', 200) }); });
function mutableTaskId(id) { const value=taskText(id, '작업 ID', 200); if(value.startsWith('oc-'))throw Error('OpenClaw 기록은 읽기 전용입니다.'); return value; }
ipcMain.handle('tasksCancel', async (event, id) => { taskSender(event); return taskRequest('cancel', { id: mutableTaskId(id) }); });
ipcMain.handle('tasksResume', async (event, id, request) => { taskSender(event); return taskRequest('resume', { id: mutableTaskId(id), request }); });
ipcMain.handle('tasksRespond', async (event, id, message) => { taskSender(event); return taskRequest('respond', { id: mutableTaskId(id), message: taskText(message, '추가 지시') }); });
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
