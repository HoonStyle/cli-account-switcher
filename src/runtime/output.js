'use strict';
const fs = require('fs'), path = require('path');
const STDOUT_LIMIT = 65536, STDERR_LIMIT = 16384;
function fileText(file, limit, tail = false) {
  let fd;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (!tail && stat.size > limit)) return null;
    const start = tail ? Math.max(0, stat.size - limit) : 0;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const length = fs.readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.subarray(0, length).toString('utf8'), truncated: start > 0, at: stat.mtimeMs };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function json(file) {
  try { return JSON.parse(fileText(file, 1024 * 1024)?.text || 'null'); } catch { return null; }
}
function attemptOutput(runtimeDir, attempt) {
  const empty = { attemptId: attempt.id, state: attempt.state, stdout: '', stderr: '', updatedAt: null, childPid: null, truncated: false };
  if (!attempt.dir) return empty;
  // IDs come from the ledger, never use request text as a filesystem path.
  if (!/^[A-Za-z0-9-]+$/.test(attempt.id)) throw Error('Invalid attempt ID');
  const expected = path.join(fs.realpathSync(runtimeDir), 'attempts', attempt.id);
  if (fs.realpathSync(attempt.dir) !== expected) throw Error('Attempt output path mismatch');
  const matches = value => value?.attemptId === attempt.id && !!attempt.token && value.token === attempt.token;
  const live = json(path.join(expected, 'live.json'));
  if (matches(live) && Number.isInteger(live.childPid) && live.childPid > 0) empty.childPid = live.childPid;
  const output = json(path.join(expected, 'terminal.json'));
  if (matches(output)) return { ...empty,
    stdout: String(output.stdout || '').slice(-STDOUT_LIMIT), stderr: String(output.stderr || '').slice(-STDERR_LIMIT),
    updatedAt: Number.isFinite(output.at) ? output.at : null, truncated: !!output.truncated };
  // Completed runs from older versions keep their existing logs.
  const stdout = fileText(path.join(expected, 'stdout.log'), STDOUT_LIMIT, true);
  const stderr = fileText(path.join(expected, 'stderr.log'), STDERR_LIMIT, true);
  return { ...empty, stdout: stdout?.text || '', stderr: stderr?.text || '',
    updatedAt: Math.max(stdout?.at || 0, stderr?.at || 0) || null, truncated: !!(stdout?.truncated || stderr?.truncated) };
}
module.exports = { attemptOutput, STDOUT_LIMIT, STDERR_LIMIT };
