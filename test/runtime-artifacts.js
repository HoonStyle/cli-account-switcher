'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const { captureInputs, stageInputs, LIMITS } = require('../src/runtime/artifacts');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-artifacts-')));
const source = path.join(temp, 'source'); fs.mkdirSync(source);
function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
git(source, 'init'); git(source, 'config', 'user.email', 'fixture@example.invalid'); git(source, 'config', 'user.name', 'Fixture');
for (const [file, content] of Object.entries({ 'modified.cs': 'baseline', 'deleted.cs': 'delete me', 'executable.sh': 'echo baseline\n', 'unchanged.cs': 'leave alone' })) fs.writeFileSync(path.join(source, file), content);
git(source, 'add', '.'); git(source, 'commit', '-m', 'baseline');
const baselineCommit = git(source, 'rev-parse', 'HEAD'); let seq = 0;
function worktree() { const dir = path.join(temp, 'work-' + ++seq); git(source, 'worktree', 'add', '--detach', dir, baselineCommit); return dir; }
function capture(paths, options = {}) { return captureInputs({ sources: [{ taskId: 'source-task', resultVersion: 3, cwd: source, paths }], destination: path.join(temp, 'snapshot-' + ++seq), baselineCommit, ...options }); }
function stage(snapshot, target) { return stageInputs({ snapshotDir: snapshot.snapshotDir, destinationWorktree: target, expectedHash: snapshot.hash }); }
fs.writeFileSync(path.join(source, 'modified.cs'), 'implementation');
fs.unlinkSync(path.join(source, 'deleted.cs'));
fs.mkdirSync(path.join(source, 'new')); fs.writeFileSync(path.join(source, 'new', 'implementation.cs'), 'new code');
fs.chmodSync(path.join(source, 'executable.sh'), 0o755);
const paths = ['modified.cs', 'deleted.cs', 'new/implementation.cs', 'executable.sh'];
const snapshot = capture(paths), target = worktree();
assert.equal(snapshot.manifest.sources[0].resultVersion, 3);
assert.equal(snapshot.manifest.sources[0].taskId, 'source-task');
assert.equal(stage(snapshot, target).alreadyStaged, false);
assert.equal(fs.readFileSync(path.join(target, 'modified.cs'), 'utf8'), 'implementation');
assert.equal(fs.existsSync(path.join(target, 'deleted.cs')), false);
assert.equal(fs.readFileSync(path.join(target, 'new/implementation.cs'), 'utf8'), 'new code');
assert(fs.statSync(path.join(target, 'executable.sh')).mode & 0o111);
assert.equal(fs.readFileSync(path.join(target, 'unchanged.cs'), 'utf8'), 'leave alone');
assert.equal(stage(snapshot, target).alreadyStaged, true);
assert.equal(capture(paths, { destination: snapshot.snapshotDir }).hash, snapshot.hash);
// Source changes after capture cannot alter the immutable handoff.
fs.writeFileSync(path.join(source, 'modified.cs'), 'later source changes');
const later = worktree(); stage(snapshot, later);
assert.equal(fs.readFileSync(path.join(later, 'modified.cs'), 'utf8'), 'implementation');
console.log('PASS tracked/untracked/deleted/mode payloads, receipts, immutability and idempotent staging');

const recovery = worktree();
fs.writeFileSync(path.join(recovery, 'modified.cs'), 'implementation');
fs.unlinkSync(path.join(recovery, 'deleted.cs'));
stage(snapshot, recovery); assert.equal(stage(snapshot, recovery).alreadyStaged, true);
const conflict = worktree(); fs.writeFileSync(path.join(conflict, 'modified.cs'), 'foreign changes');
assert.throws(() => stage(snapshot, conflict), /conflict/);
assert(fs.existsSync(path.join(conflict, 'deleted.cs')), 'Validate all targets before deleting anything');
assert.equal(fs.existsSync(path.join(conflict, 'new/implementation.cs')), false);
console.log('PASS partial-stage recovery and all-path conflict preflight');

for (const unsafe of ['../outside', '/absolute', 'new/../../outside', '.git/config', '.env', '.env.local', '.claude/settings.json', 'auth.json', 'credentials.json', 'bin/output.cs', 'obj/output.cs', 'new\\escape', 'new//file', 'new/file\n']) assert.throws(() => capture([unsafe]), /Unsafe|Protected/);
assert.throws(() => capture(['typo.cs']), /not a baseline deletion/);
fs.symlinkSync(path.join(temp, 'source'), path.join(source, 'escape'));
assert.throws(() => capture(['escape/modified.cs']), /Non-regular/);
fs.symlinkSync(path.join(source, 'modified.cs'), path.join(source, 'link.cs'));
assert.throws(() => capture(['link.cs']), /Non-regular/);
fs.writeFileSync(path.join(temp, 'private.cs'), 'outside source');
fs.linkSync(path.join(temp, 'private.cs'), path.join(source, 'hardlink.cs'));
assert.throws(() => capture(['hardlink.cs']), /Non-regular/);
assert.throws(() => capture(['unchanged.cs'], { destination: path.join(source, 'snapshot') }), /must not mutate/);
const symlinkTarget = worktree(); fs.symlinkSync(source, path.join(symlinkTarget, 'new'));
assert.throws(() => stage(snapshot, symlinkTarget), /Non-regular/);
assert.equal(fs.readFileSync(path.join(symlinkTarget, 'modified.cs'), 'utf8'), 'baseline');
assert.throws(() => capture(['modified.cs'], { baselineCommit: '0'.repeat(40) }), /baseline HEAD mismatch/);
assert.throws(() => capture(['modified.cs'], { sources: [{ taskId: 'bad', resultVersion: 0, cwd: source, paths: ['modified.cs'] }] }), /source receipt/);
console.log('PASS traversal, credentials/config/build trees, symlinks, deletion typo and baseline/version validation');

const other = worktree(); fs.writeFileSync(path.join(other, 'modified.cs'), 'different implementation');
assert.throws(() => capture(['modified.cs'], { sources: [source, other].map((cwd, i) => ({ taskId: 'task-' + i, resultVersion: 1, cwd, paths: ['modified.cs'] })) }), /Conflicting/);
assert.throws(() => capture(['modified.cs', 'modified.cs']), /Duplicate/);
fs.writeFileSync(path.join(source, 'MODIFIED.cs'), 'case conflict');
assert.throws(() => capture(['modified.cs', 'MODIFIED.cs']), /Overlapping/);
const duplicates = capture(['unchanged.cs'], { sources: [source, other].map((cwd, i) => ({ taskId: 'task-' + i, resultVersion: 1, cwd, paths: ['unchanged.cs'] })) });
assert.equal(duplicates.manifest.files.length, 1); assert.equal(duplicates.manifest.sources.length, 2);
console.log('PASS conflicting/case-fold overlap rejection and identical-input provenance');

const mutated = capture(['unchanged.cs']);
fs.chmodSync(path.join(mutated.snapshotDir, '0.blob'), 0o600); fs.writeFileSync(path.join(mutated.snapshotDir, '0.blob'), 'tampered');
assert.throws(() => stage(mutated, worktree()), /payload hash mismatch/);
const changedManifest = capture(['unchanged.cs']);
const mf = path.join(changedManifest.snapshotDir, 'manifest.json');
const data = JSON.parse(fs.readFileSync(mf)); data.sources[0].resultVersion++;
fs.chmodSync(mf, 0o600); fs.writeFileSync(mf, JSON.stringify(data));
assert.throws(() => stage(changedManifest, worktree()), /snapshot hash mismatch/);
const incomplete = capture(['unchanged.cs']); fs.unlinkSync(path.join(incomplete.snapshotDir, 'ready.json'));
assert.throws(() => stage(incomplete, worktree()), /not ready/);
fs.writeFileSync(path.join(source, 'oversize.cs'), Buffer.alloc(LIMITS.fileBytes + 1));
assert.throws(() => capture(['oversize.cs']), /size limit/);
assert.throws(() => capture(Array.from({ length: LIMITS.files + 1 }, (_, i) => 'file' + i + '.cs')), /count limit/);
const many = Array.from({ length: 9 }, (_, i) => 'large' + i + '.cs');
for (const name of many) fs.writeFileSync(path.join(source, name), Buffer.alloc(LIMITS.fileBytes));
assert.throws(() => capture(many), /total size limit/);
// Paths are literal even if they contain Git pathspec metacharacters.
fs.writeFileSync(path.join(source, '[literal].cs'), 'literal path');
const literal = capture(['[literal].cs']), literalTarget = worktree(); stage(literal, literalTarget);
assert.equal(fs.readFileSync(path.join(literalTarget, '[literal].cs'), 'utf8'), 'literal path');
console.log('PASS payload/manifest tampering, incomplete publication and size limits');
console.log('Artifact fixtures preserved at ' + temp);
