'use strict';
const fs = require('fs/promises'), path = require('path'), os = require('os');
async function directory(value) {
  const resolved = await fs.realpath(value);
  if (!(await fs.stat(resolved)).isDirectory()) throw Error('폴더를 선택해 주세요.');
  return resolved;
}
function validPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || (value && !path.isAbsolute(value))) throw Error('폴더 경로가 올바르지 않습니다.');
  return value;
}
async function chooseProjectFolder(dialog, window, current = '') {
  validPath(current);
  let defaultPath = os.homedir();
  if (current) { try { defaultPath = await directory(current); } catch {} }
  const result = await dialog.showOpenDialog(window, { title: '프로젝트 폴더 선택', buttonLabel: '이 폴더 선택', defaultPath, properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return directory(result.filePaths[0]);
}
function createFolderBrowser({ home = os.homedir(), extraRoots = process.platform === 'darwin' ? ['/Volumes'] : [] } = {}) {
  return async (requested = '') => {
    validPath(requested);
    const roots = [];
    for (const [index, value] of [home, ...extraRoots].entries()) {
      try { roots.push({ path: await directory(value), name: index === 0 ? '홈' : path.basename(value) === 'Volumes' ? '외장 디스크' : path.basename(value) }); } catch {}
    }
    const inside = value => roots.some(root => value === root.path || value.startsWith(root.path + path.sep));
    let current;
    try { current = await directory(requested || home); } catch { throw Error('폴더를 열 수 없습니다. 경로와 접근 권한을 확인해 주세요.'); }
    if (!inside(current)) throw Error('홈 또는 외장 디스크에서 폴더를 선택해 주세요. 다른 경로는 직접 입력할 수 있습니다.');
    const entries = await fs.readdir(current, { withFileTypes: true });
    const folders = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      try { const resolved = await directory(path.join(current, entry.name)); if (inside(resolved)) folders.push({ name: entry.name, path: resolved }); } catch {}
    }
    folders.sort((a,b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    const parent = path.dirname(current);
    return { path: current, parent: parent !== current && inside(parent) ? parent : null, roots, folders };
  };
}
module.exports = { chooseProjectFolder, createFolderBrowser };
