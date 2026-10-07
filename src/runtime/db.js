'use strict';
const fs = require('fs');
const path = require('path');
class Ledger {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(path.join(dir, 'tasks.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Unsupported runtime schema; refusing to modify');
    this.db.exec(`CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, rootId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rootId TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  get(kind, id) { const r = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id); return r ? JSON.parse(r.body) : null; }
  all(kind) { return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(r.body)); }
  put(kind, item) { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, item.id, JSON.stringify(item)); return item; }
  event(rootId, type, body = {}) { this.db.prepare('INSERT INTO events(rootId,at,type,body) VALUES(?,?,?,?)').run(rootId, Date.now(), type, JSON.stringify(body)); }
  events(rootId, after = 0) { return this.db.prepare('SELECT * FROM events WHERE rootId=? AND seq>? ORDER BY seq LIMIT 500').all(rootId, after).map(r => ({ ...r, body: JSON.parse(r.body) })); }
  // Snapshots need the newest window, not the first forward-cursor page. Return
  // chronological order for renderers; `before` pages backward without overlap.
  eventsTail(rootId, before = null) {
    const rows = before == null
      ? this.db.prepare('SELECT * FROM events WHERE rootId=? ORDER BY seq DESC LIMIT 500').all(rootId)
      : this.db.prepare('SELECT * FROM events WHERE rootId=? AND seq<? ORDER BY seq DESC LIMIT 500').all(rootId, before);
    return rows.reverse().map(r => ({ ...r, body: JSON.parse(r.body) }));
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  close() { this.db.close(); }
}
module.exports = { Ledger };
