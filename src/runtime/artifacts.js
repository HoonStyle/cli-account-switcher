'use strict';
// File payload handoff only. The engine owns task/version/owner authorization.
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const LIMITS = Object.freeze({ files: 100, fileBytes: 2 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 });
const sha = data => createHash('sha256').update(data).digest('hex');
function git(cwd, args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG.*)$/.test(name)) delete env[name];
  env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = '/dev/null'; env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: LIMITS.totalBytes + 1024 * 1024 });
}
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(value) || path.posix.isAbsolute(value)) throw Error('Unsafe artifact path');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.trim() !== p || p.endsWith('.') || p.normalize('NFC') !== p)) throw Error('Unsafe artifact path');
  const blocked = /^(?:\.git(?:ignore|attributes|modules)?|\.env(?:\..*)?|\.claude|\.codex|\.openclaw|\.ssh|\.aws|\.azure|\.config|\.idea|\.vscode|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.bashrc|\.zshrc|\.profile|\.mcp\.json|node_modules|bin|obj|dist|build|\.build-cache|target|coverage|__pycache__|\.venv|venv|\.next|\.nuget|credentials?(?:\..*)?|auth(?:\..*)?|secrets?(?:\..*)?|settings(?:\.local)?\.json|appsettings(?:\..*)?\.json|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i;
  if (parts.some(p => blocked.test(p))) throw Error('Protected artifact path: ' + value);
  return value;
}
function rootDir(dir) {
  const resolved = path.resolve(dir);
  if (fs.realpathSync(resolved) !== resolved || !fs.statSync(resolved).isDirectory()) throw Error('Artifact root must be a real directory');
  return resolved;
}
function inspect(root, relative) {
  safePath(relative);
  const parts = relative.split('/'); let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat; try { stat = fs.lstatSync(current); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw Error('Non-regular artifact path: ' + relative);
    if (i === parts.length - 1) {
      if (stat.size > LIMITS.fileBytes) throw Error('Artifact file size limit');
      const bytes = fs.readFileSync(current);
      if (bytes.length > LIMITS.fileBytes) throw Error('Artifact file size limit');
      return { bytes, mode: stat.mode & 0o111 ? '100755' : '100644', hash: sha(bytes) };
    }
  }
}
function baseline(cwd, commit, relative) {
  const records = git(cwd, ['ls-tree', '-z', commit, '--', relative]).toString().split('\0').filter(Boolean);
  if (!records.length) return null;
  if (records.length !== 1) throw Error('Ambiguous baseline path');
  const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(records[0]);
  if (!match || match[3] !== relative) throw Error('Non-regular baseline artifact');
  const bytes = git(cwd, ['cat-file', 'blob', match[2]]);
  if (bytes.length > LIMITS.fileBytes) throw Error('Baseline file size limit');
  return { mode: match[1], hash: sha(bytes) };
}
function checkCommit(cwd, commit) {
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw Error('Invalid baseline commit');
  if (git(cwd, ['rev-parse', '--verify', 'HEAD']).toString().trim() !== commit) throw Error('Artifact baseline HEAD mismatch');
}
const stateEqual = (a, b) => a === null ? b === null : !!b && a.hash === b.hash && a.mode === b.mode;
function contentHash(manifest, payloads) {
  const hash = createHash('sha256').update(JSON.stringify(manifest));
  for (const entry of manifest.files) if (entry.operation === 'write') hash.update(payloads.get(entry.path));
  return hash.digest('hex');
}
function captureInputs({ sources, destination, baselineCommit }) {
  if (!Array.isArray(sources) || !sources.length || sources.length > LIMITS.files) throw Error('Invalid artifact sources');
  const snapshotDir = path.resolve(destination);
  const entries = new Map(), payloads = new Map(); let total = 0, selected = 0;
  const origins = [];
  for (const source of sources) {
    if (typeof source.taskId !== 'string' || !source.taskId || source.taskId.length > 200 || !Number.isInteger(source.resultVersion) || source.resultVersion < 1 || !Array.isArray(source.paths) || !source.paths.length) throw Error('Invalid artifact source receipt');
    const cwd = rootDir(source.cwd); checkCommit(cwd, baselineCommit);
    if (snapshotDir === cwd || snapshotDir.startsWith(cwd + path.sep)) throw Error('Artifact snapshot must not mutate its source worktree');
    const paths = source.paths.map(safePath).sort();
    if (new Set(paths).size !== paths.length) throw Error('Duplicate artifact path');
    if ((selected += paths.length) > LIMITS.files) throw Error('Artifact file count limit');
    origins.push({ taskId: source.taskId, resultVersion: source.resultVersion, paths });
    for (const relative of paths) {
      const current = inspect(cwd, relative), base = baseline(cwd, baselineCommit, relative);
      if (!current && !base) throw Error('Missing artifact is not a baseline deletion: ' + relative);
      const entry = { path: relative, operation: current ? 'write' : 'delete', mode: current?.mode || null, hash: current?.hash || null, size: current?.bytes.length || 0, baseline: base };
      const prior = entries.get(relative);
      if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) throw Error('Conflicting artifact inputs: ' + relative);
      // Case-fold conflicts are unsafe on the default macOS filesystem.
      if (!prior && [...entries.keys()].some(p => { const a = p.toLowerCase(), b = relative.toLowerCase(); return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); })) throw Error('Overlapping artifact inputs: ' + relative);
      if (!prior) { total += entry.size; if (total > LIMITS.totalBytes) throw Error('Artifact total size limit'); entries.set(relative, entry); if (current) payloads.set(relative, current.bytes); }
    }
  }
  origins.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const manifest = { version: 1, baselineCommit, sources: origins, files: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  const hash = contentHash(manifest, payloads);
  if (fs.existsSync(snapshotDir)) { loadSnapshot(snapshotDir, hash); return { snapshotDir, hash, manifest }; }
  fs.mkdirSync(path.dirname(snapshotDir), { recursive: true, mode: 0o700 });
  const staging = snapshotDir + '.' + randomUUID() + '.tmp'; fs.mkdirSync(staging, { mode: 0o700 });
  for (let i = 0; i < manifest.files.length; i++) {
    const entry = manifest.files[i];
    if (entry.operation === 'write') fs.writeFileSync(path.join(staging, `${i}.blob`), payloads.get(entry.path), { mode: 0o400, flag: 'wx' });
  }
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(staging, 'ready.json'), JSON.stringify({ hash }), { mode: 0o400, flag: 'wx' });
  // Atomic directory publication; incomplete staging directories are never usable.
  fs.renameSync(staging, snapshotDir);
  return { snapshotDir, hash, manifest };
}
function loadSnapshot(snapshotDir, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('Invalid artifact snapshot hash');
  const root = rootDir(snapshotDir);
  const ready = inspect(root, 'ready.json'), raw = inspect(root, 'manifest.json');
  if (!ready || !raw || JSON.parse(ready.bytes).hash !== expectedHash) throw Error('Artifact snapshot is not ready');
  const manifest = JSON.parse(raw.bytes);
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > LIMITS.files) throw Error('Invalid artifact manifest');
  const payloads = new Map(); let total = 0;
  for (let i = 0; i < manifest.files.length; i++) {
    const entry = manifest.files[i]; safePath(entry.path);
    if (payloads.has(entry.path) || !['write', 'delete'].includes(entry.operation)) throw Error('Invalid artifact manifest entry');
    if (entry.operation === 'write') {
      const file = inspect(root, `${i}.blob`);
      if (!file || file.hash !== entry.hash || file.bytes.length !== entry.size || !['100644', '100755'].includes(entry.mode)) throw Error('Artifact payload hash mismatch');
      total += file.bytes.length; if (total > LIMITS.totalBytes) throw Error('Artifact total size limit');
      payloads.set(entry.path, file.bytes);
    }
  }
  if (contentHash(manifest, payloads) !== expectedHash) throw Error('Artifact snapshot hash mismatch');
  return { manifest, payloads };
}
function stageInputs({ snapshotDir, destinationWorktree, expectedHash }) {
  const { manifest, payloads } = loadSnapshot(snapshotDir, expectedHash);
  const cwd = rootDir(destinationWorktree); checkCommit(cwd, manifest.baselineCommit);
  const pending = [];
  // Validate the complete set before mutation. A partial prior stage is resumable
  // only where every path still matches the baseline or the exact intended bytes.
  for (const entry of manifest.files) {
    const base = baseline(cwd, manifest.baselineCommit, entry.path);
    if (!stateEqual(base, entry.baseline)) throw Error('Artifact destination baseline mismatch');
    const current = inspect(cwd, entry.path), intended = entry.operation === 'delete' ? null : entry;
    if (stateEqual(current, intended)) continue;
    if (!stateEqual(current, base)) throw Error('Artifact staging conflict: ' + entry.path);
    pending.push(entry);
  }
  for (const entry of pending) {
    const target = path.join(cwd, entry.path);
    // Recheck path components directly before each mutation.
    const current = inspect(cwd, entry.path);
    if (!stateEqual(current, entry.baseline)) throw Error('Artifact changed during staging');
    if (entry.operation === 'delete') fs.unlinkSync(target);
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = target + '.' + randomUUID() + '.artifact-tmp';
      fs.writeFileSync(temporary, payloads.get(entry.path), { mode: entry.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
      fs.chmodSync(temporary, entry.mode === '100755' ? 0o755 : 0o644);
      fs.renameSync(temporary, target);
    }
  }
  for (const entry of manifest.files) if (!stateEqual(inspect(cwd, entry.path), entry.operation === 'delete' ? null : entry)) throw Error('Artifact staging verification failed');
  return { hash: expectedHash, files: manifest.files.map(f => f.path), alreadyStaged: pending.length === 0 };
}
module.exports = { captureInputs, stageInputs, LIMITS };
