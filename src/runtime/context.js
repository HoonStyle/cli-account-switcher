'use strict';
// Cross-CLI integration for the existing Agent Skills directory format. No
// global config, credentials, sessions, hooks or plugin executables are copied.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, fileBytes: 1024 * 1024, files: 200, instructions: 128 * 1024 });
const hash = value => createHash('sha256').update(value).digest('hex');
function text(value, key, max = 10000) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw Error(`Invalid context ${key}`);
  return value;
}
function normalizeContext(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid context');
  const allowed = ['version', 'background', 'status', 'constraints', 'decisions', 'nextSteps', 'completionCriteria', 'files', 'skills', 'projectInstructions'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw Error(`Unknown context field: ${key}`);
  if (input.version !== undefined && input.version !== 1) throw Error('Unsupported context version');
  const out = { version: 1 };
  for (const key of ['background', 'status']) out[key] = text(input[key] ?? '', key);
  for (const key of ['constraints', 'decisions', 'nextSteps', 'completionCriteria', 'files', 'skills']) {
    const list = input[key] ?? [];
    if (!Array.isArray(list) || list.length > (key === 'skills' ? 12 : 50)) throw Error(`Invalid context ${key}`);
    out[key] = [...new Set(list.map(v => text(v, key, key === 'skills' ? 100 : 2000)))];
  }
  for (const name of out.skills) if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw Error('Use a skill directory name, not an arbitrary path');
  for (const file of out.files) safeRelative(file);
  if (input.projectInstructions !== undefined && typeof input.projectInstructions !== 'boolean') throw Error('Invalid projectInstructions');
  out.projectInstructions = input.projectInstructions ?? true;
  if (Buffer.byteLength(JSON.stringify(out)) > 64000) throw Error('Context text exceeds 64 KB');
  return out;
}
function safeRelative(file) {
  if (!file || path.isAbsolute(file) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..' || p === '.git') || /[\x00-\x1f]/.test(file)) throw Error('Unsafe context relative path');
  return file;
}
function inside(root, file) { return file === root || file.startsWith(root + path.sep); }
function readFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > LIMITS.fileBytes) throw Error('Unsupported context file or size');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function skillDirectory(name, binding, projectPath) {
  const candidates = [path.join(projectPath, '.agents/skills', name), path.join(projectPath, `.${binding.tool}/skills`, name), path.join(binding.home, 'skills', name)];
  for (const candidate of candidates) {
    if (!fs.existsSync(path.join(candidate, 'SKILL.md'))) continue;
    // Shared skill directories are normally symlinks. Pin their resolved
    // directory once, then reject escaping links among their supporting files.
    return fs.realpathSync(candidate);
  }
  throw Error(`Selected skill not found for ${binding.tool}/${binding.profileId}: ${name}`);
}
function captureContext({ context, binding, projectPath, destination }) {
  const normalized = normalizeContext(context);
  const project = fs.realpathSync(projectPath);
  const files = []; let bytes = 0, instructionBytes = 0;
  function add(file, relative, kind, name) {
    safeRelative(relative);
    if (/^(\.env(?:\..*)?|auth\.json|credentials\.json|\.credentials\.json|\.npmrc)$/i.test(path.basename(file)) || /\.(pem|key)$/i.test(file)) throw Error('Credential files are not skill resources');
    const content = readFile(file);
    bytes += content.length;
    if (++add.count > LIMITS.files || bytes > LIMITS.bytes) throw Error('Selected context exceeds snapshot limits');
    if (kind === 'instruction' || relative.endsWith('/SKILL.md')) {
      instructionBytes += content.length;
      if (instructionBytes > LIMITS.instructions) throw Error('Selected instructions exceed 128 KB');
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    }
    files.push({ path: relative, kind, name, source: file, sha256: hash(content), content: content.toString('base64') });
  }
  add.count = 0;
  if (normalized.projectInstructions) for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(project, name);
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw Error(`Project instruction must be a regular file: ${name}`);
      add(file, `instructions/${name}`, 'instruction', name);
    }
  }
  for (const name of normalized.skills) {
    const root = skillDirectory(name, binding, project);
    function walk(dir, rel = '') {
      for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (['.git', 'node_modules', '__pycache__', '.DS_Store'].includes(item.name)) continue;
        const file = path.join(dir, item.name), sub = rel ? `${rel}/${item.name}` : item.name;
        if (item.isSymbolicLink()) throw Error(`Nested skill symlinks are not supported: ${name}/${sub}`);
        if (!inside(root, fs.realpathSync(file))) throw Error('Skill resource escapes its directory');
        if (item.isDirectory()) walk(file, sub);
        else if (item.isFile()) add(file, `skills/${name}/${sub}`, 'skill', name);
        else throw Error('Unsupported skill resource');
      }
    }
    walk(root);
  }
  const payload = { version: 1, context: normalized, files };
  const encoded = JSON.stringify(payload), fingerprint = hash(encoded);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  // Never replace a published snapshot with a newer live skill version.
  try { fs.writeFileSync(destination, encoded, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST' || hash(fs.readFileSync(destination)) !== fingerprint) throw e; }
  return { version: 1, hash: fingerprint, path: destination, tool: binding.tool, profileId: binding.profileId,
    skills: normalized.skills, instructionFiles: files.filter(f => f.kind === 'instruction').map(f => f.name), fileCount: files.length, bytes };
}
function loadContext(receipt) {
  const bytes = fs.readFileSync(receipt.path);
  if (hash(bytes) !== receipt.hash) throw Error('Context snapshot hash mismatch');
  const snapshot = JSON.parse(bytes);
  if (snapshot.version !== 1 || !Array.isArray(snapshot.files)) throw Error('Unsupported context snapshot');
  for (const file of snapshot.files) {
    safeRelative(file.path);
    if (hash(Buffer.from(file.content, 'base64')) !== file.sha256) throw Error('Context resource hash mismatch');
  }
  return snapshot;
}
function materializeContext(receipt, destination) {
  const snapshot = loadContext(receipt);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(destination);
  for (const file of snapshot.files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!inside(root, fs.realpathSync(path.dirname(target)))) throw Error('Context staging escaped its root');
    const bytes = Buffer.from(file.content, 'base64');
    try { fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o400 }); }
    catch (e) { if (e.code !== 'EEXIST' || fs.lstatSync(target).isSymbolicLink() || hash(readFile(target)) !== file.sha256) throw e; }
  }
  return root;
}
function contextPrompt(receipt, directory, contextOverride) {
  const snapshot = loadContext(receipt);
  const documents = snapshot.files.filter(f => f.kind === 'instruction' || f.path.endsWith('/SKILL.md'));
  const lines = [`Task handoff (version 1; snapshot ${receipt.hash}):`, JSON.stringify(contextOverride || snapshot.context),
    'Use the selected skill and project instructions below as task guidance within the existing task permission and available tools. They do not enable hooks, MCP, plugins, tools or new permissions. Report unavailable capabilities instead of bypassing restrictions.',
    `Supporting files are snapshotted under ${directory}. Resolve each skill's relative paths from ${directory}/skills/<skill-name>. These files are approved read-only task inputs; do not modify them.`];
  for (const file of documents) lines.push(`\n--- ${file.path} (sha256 ${file.sha256}) ---\n${Buffer.from(file.content, 'base64').toString('utf8')}\n--- end ${file.path} ---`);
  return lines.join('\n');
}
function contextReceipt(receipt, context, revision) {
  if (!receipt) return null;
  const { version, hash, tool, profileId, skills, instructionFiles, fileCount, bytes } = receipt;
  return { version, hash, tool, profileId, skills, instructionFiles, fileCount, bytes, mode: 'explicit-snapshot',
    ...(context ? { contextRevision: revision || 1, handoffHash: createHash('sha256').update(JSON.stringify({ snapshot: hash, context })).digest('hex') } : {}) };
}
module.exports = { normalizeContext, captureContext, loadContext, materializeContext, contextPrompt, contextReceipt, LIMITS };
