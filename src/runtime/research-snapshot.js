'use strict';
// Private, copy-once attempt assets, not links back into a mutable installation.
// Deliberately use per-file copies: Electron ASAR directories do not support cp.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const LIMIT = 512 * 1024 * 1024;
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function failure(code, message) { const e = Error(message); e.code = code; return e; }
function inside(root, file) { return file === root || file.startsWith(root + path.sep); }
function files(root, options = {}) {
  const entries = []; let bytes = 0;
  root = fs.realpathSync(root);
  function visit(file, relative, ancestors) {
    const real = fs.realpathSync(file), st = fs.statSync(real);
    if (!inside(root, real)) throw failure('CAPABILITY_MISSING', 'Research assets contain an external symlink');
    if (ancestors.has(real)) throw failure('CAPABILITY_MISSING', 'Research assets contain a symlink cycle');
    if (st.isDirectory()) {
      const seen = new Set(ancestors); seen.add(real);
      for (const name of fs.readdirSync(real).sort()) {
        if (name === '__pycache__' || name.endsWith('.pyc') || (options.omitSitePackages && name === 'site-packages')) continue;
        visit(path.join(real, name), path.join(relative, name), seen);
      }
    } else if (st.isFile()) {
      bytes += st.size;
      if (bytes > LIMIT || entries.length >= 40000) throw failure('CAPABILITY_MISSING', 'Research asset snapshot exceeds its limit');
      entries.push({ relative, file: real, bytes: st.size, executable: Boolean(st.mode & 0o111), hash: digest(fs.readFileSync(real)) });
    } else throw failure('CAPABILITY_MISSING', 'Research assets contain a special file');
  }
  visit(root, '', new Set());
  return entries;
}
function treeHash(entries) { return digest(JSON.stringify(entries.map(({ relative, bytes, executable, hash }) => ({ relative, bytes, executable, hash })))); }
function copyEntries(entries, target) {
  fs.mkdirSync(target, { mode: 0o700 });
  for (const e of entries) {
    const output = path.join(target, e.relative);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const data = fs.readFileSync(e.file);
    if (digest(data) !== e.hash) throw failure('CAPABILITY_STALE', 'Research installation changed while preparing its snapshot');
    fs.writeFileSync(output, data, { flag: 'wx', mode: e.executable ? 0o500 : 0o400 });
  }
}
function copyFile(source, target, expected, executable = false) {
  const data = fs.readFileSync(source);
  if (digest(data) !== expected) throw failure('CAPABILITY_STALE', 'Research executable changed while preparing its snapshot');
  fs.writeFileSync(target, data, { flag: 'wx', mode: executable ? 0o500 : 0o400 });
}
function seal(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) seal(path.join(root, entry.name));
  fs.chmodSync(root, 0o500);
}
function verifyNativeClosure(binary, root, requireNative = false) {
  // Initial implementation is intentionally limited to independently relocatable
  // macOS Python/Node builds. An absolute Homebrew dylib would reopen N3.
  if (process.platform !== 'darwin') throw failure('CAPABILITY_MISSING', 'Research snapshots currently require a relocatable macOS runtime');
  const magic = fs.readFileSync(binary).subarray(0, 4).toString('hex');
  if (!['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic)) {
    if (requireNative) throw failure('CAPABILITY_MISSING', 'Research requires a native relocatable interpreter, not a mutable launcher');
    return;
  }
  const output = execFileSync('/usr/bin/otool', ['-l', binary], { encoding: 'utf8', timeout: 10000 });
  const commands = output.split(/Load command \d+/);
  const deps = commands.filter(c => /\bcmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LOAD_UPWARD_DYLIB)\b/.test(c)).map(c => /\bname (.+?) \(offset/.exec(c)?.[1]).filter(Boolean);
  const executableDir = binary === path.join(root, 'node') ? root : path.join(root, 'python/bin');
  const expand = value => value.startsWith('@loader_path/') ? path.resolve(path.dirname(binary), value.slice(13)) : value.startsWith('@executable_path/') ? path.resolve(executableDir, value.slice(17)) : value;
  const rpaths = commands.filter(c => /\bcmd LC_RPATH\b/.test(c)).map(c => /\bpath (.+?) \(offset/.exec(c)?.[1]).filter(Boolean).map(expand);
  if (rpaths.some(p => !inside(root, p))) throw failure('CAPABILITY_MISSING', 'Research runtime has an external native search path');
  for (const dep of deps) {
    if (!dep || dep.startsWith('/usr/lib/') || dep.startsWith('/System/Library/')) continue;
    if (dep.startsWith('@loader_path/') || dep.startsWith('@executable_path/')) {
      const resolved = expand(dep);
      if (inside(root, resolved) && fs.existsSync(resolved)) continue;
    }
    if (dep.startsWith('@rpath/') && rpaths.some(p => fs.existsSync(path.join(p, dep.slice(7))))) continue;
    throw failure('CAPABILITY_MISSING', 'Research runtime has a non-relocatable native dependency');
  }
}
function validateSnapshot(snapshot, expectedHash) {
  try {
    const root = fs.realpathSync(snapshot);
    if (root !== snapshot) throw Error('path');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (digest(JSON.stringify(manifest)) !== expectedHash) throw Error('manifest');
    const actual = files(root).filter(e => e.relative !== 'manifest.json');
    if (treeHash(actual) !== manifest.assetsHash) throw Error('assets');
    return manifest;
  } catch { throw failure('CAPABILITY_RUNTIME_CHANGED', 'Research snapshot is missing or changed'); }
}
module.exports = { digest, failure, inside, files, treeHash, copyEntries, copyFile, seal, verifyNativeClosure, validateSnapshot };
