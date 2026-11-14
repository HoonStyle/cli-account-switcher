'use strict';
// Reads a secret from piped stdin, or from a hidden prompt on a TTY. Never from argv.
async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) { data += chunk; if (data.length > 4096) throw new Error('입력이 너무 깁니다'); }
    return data;
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (err) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stderr.write('\n'); err ? reject(err) : resolve(value); };
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new Error('취소됨'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
module.exports = { readSecret };
