'use strict';
const fs = require('fs');
const { randomUUID } = require('crypto');
const { request, ensureService, readDashboard } = require('./client');
async function run(argv) {
  const [command, ...rest] = argv;
  if (command === 'start') { console.log(JSON.stringify(await ensureService(), null, 2)); return; }
  if (command === 'submit') {
    if (rest.length !== 1) throw new Error('tasks submit <spec.json>');
    const spec = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
    spec.requestId ||= randomUUID();
    await ensureService(); console.log(JSON.stringify(await request('submit', spec), null, 2)); return;
  }
  if (['list', 'health'].includes(command)) { console.log(JSON.stringify(await request(command), null, 2)); return; }
  if (['get', 'cancel'].includes(command)) { console.log(JSON.stringify(await request(command, { id: rest[0] }), null, 2)); return; }
  if (['respond', 'resume'].includes(command)) {
    if (rest.length !== 2) throw Error(`tasks ${command} <id> <request.json> (requestId, generation, inputVersion, message required)`);
    console.log(JSON.stringify(await request(command, { id: rest[0], request: JSON.parse(fs.readFileSync(rest[1], 'utf8')) }), null, 2)); return;
  }
  if (command === 'ack') { console.log(JSON.stringify(await request('ack', { id: rest[0], version: Number(rest[1]) }), null, 2)); return; }
  if (command === 'result') {
    const detail = await readDashboard(rest[0]);
    if (!['ready', 'completed'].includes(detail.root.status)) throw new Error(`Result not ready: ${detail.root.status} / ${detail.root.status === 'needs_user' ? detail.root.inputRequest?.reason || detail.root.attention || '' : detail.root.attention || ''}`);
    await new Promise((resolve, reject) => process.stdout.write(detail.root.finalResponse + '\n', e => e ? reject(e) : resolve()));
    if(detail.root.coordinator?.tool !== 'openclaw') await request('ack', { id: detail.root.id, version: detail.root.finalVersion }); return;
  }
  console.log('cli-accounts tasks start|health|list|submit <spec.json>|get <id>|result <id>|cancel <id>|respond <id> <request.json>|resume <id> <request.json>|ack <id> <version>');
}
module.exports = { run };
