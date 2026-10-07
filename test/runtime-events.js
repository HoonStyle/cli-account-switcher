'use strict';
// Isolated ledger snapshots; no runners or model calls.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-events-'));
process.env.HOME = tmp; process.env.USERPROFILE = tmp;
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');
const { Engine } = require('../src/runtime/engine');
const engine = new Engine(path.join(tmp, 'runtime'));
const db = engine.db;
try {
  assert.deepEqual(db.eventsTail('absent'), []);
  for (const count of [500, 501, 1000]) {
    const rootId = `root-${count}`, lastType = count === 501 ? 'root_completed' : 'root_cancelled';
    db.put('root', { id: rootId, status: count === 501 ? 'completed' : 'cancelled' });
    db.transaction(() => {
      for (let number = 1; number <= count; number++) {
        // Global sequence numbers have gaps within a root: cursors cannot be offsets.
        db.event('other-root', 'unrelated', { number });
        db.event(rootId, number === count ? lastType : 'progress', { number });
      }
    });
    const tail = db.eventsTail(rootId);
    assert.equal(tail.length, 500);
    assert.equal(tail[0].body.number, count - 499);
    assert.equal(tail.at(-1).body.number, count);
    assert.equal(tail.at(-1).type, lastType);
    assert(tail.every((event, index) => event.rootId === rootId && (!index || event.seq > tail[index - 1].seq)));
    const forward = db.events(rootId);
    assert.equal(forward[0].body.number, 1);
    assert.equal(forward.at(-1).body.number, 500);
    const remaining = db.events(rootId, forward.at(-1).seq);
    assert.deepEqual(remaining.map(event => event.body.number), Array.from({ length: count - 500 }, (_, i) => i + 501));
    const earlier = db.eventsTail(rootId, tail[0].seq);
    assert.deepEqual([...earlier, ...tail].map(event => event.body.number), Array.from({ length: count }, (_, i) => i + 1));
    assert.deepEqual(db.eventsTail(rootId, [...earlier, ...tail][0].seq), []);
    const snapshot = engine.get(rootId);
    assert.deepEqual(snapshot.events, tail, 'User-facing snapshots must include the newest terminal event');
    assert.equal(snapshot.events.slice(-12).at(-1).type, lastType);
  }
  console.log('PASS newest 500-event snapshots at 500/501/1000 events, root isolation, backward/forward cursor compatibility');
} finally { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
