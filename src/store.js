import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { contactId, now, recordId } from './core.js';

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, profile_url TEXT UNIQUE NOT NULL, name TEXT,
        keywords TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, degree INTEGER);
      CREATE TABLE IF NOT EXISTS outreach (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, profile_url TEXT NOT NULL,
        action TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, sent_at TEXT, done_at TEXT,
        last_error TEXT, created_at TEXT NOT NULL, UNIQUE(contact_id, action));
      CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY, profile_url TEXT, stage TEXT, error TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(outreach)').all().some(c => c.name === 'done_at')) this.db.exec('ALTER TABLE outreach ADD COLUMN done_at TEXT');
    // Old drafts still need successful Sheet synchronization before completion.
    this.db.exec("UPDATE outreach SET status='pending_sheet' WHERE status IN ('ready','awaiting_review')");
  }
  close() { this.db.close(); }
  lock() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT pid FROM locks WHERE name=?').get('workflow');
      if (row) {
        let alive = true;
        try { process.kill(row.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        if (alive) throw new Error(`Another workflow is running (PID ${row.pid})`);
        this.db.prepare('DELETE FROM locks WHERE name=?').run('workflow');
      }
      this.db.prepare('INSERT INTO locks VALUES (?,?)').run('workflow', process.pid);
      this.db.exec("UPDATE outreach SET status='send_unknown', last_error='Previous process stopped during sending' WHERE status='sending'; COMMIT");
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  unlock() { this.db.prepare('DELETE FROM locks WHERE name=? AND pid=?').run('workflow', process.pid); }
  discover(person, keyword) {
    const id = contactId(person.url);
    const old = this.db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
    const keywords = [...new Set([...(old ? JSON.parse(old.keywords) : []), keyword])];
    this.db.prepare(`INSERT INTO contacts VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, keywords=excluded.keywords, last_seen_at=excluded.last_seen_at, degree=excluded.degree`)
      .run(id, person.url, person.name || old?.name || '', JSON.stringify(keywords), old?.first_seen_at || now(), now(), person.degree ?? old?.degree ?? null);
    return id;
  }
  get(id) { return this.db.prepare('SELECT * FROM outreach WHERE id=?').get(id); }
  hasProfile(url) { return Boolean(this.db.prepare('SELECT 1 FROM outreach WHERE contact_id=? LIMIT 1').get(contactId(url))); }
  all() { return this.db.prepare('SELECT * FROM outreach ORDER BY created_at').all(); }
  contacts() { return this.db.prepare('SELECT * FROM contacts ORDER BY first_seen_at DESC, id').all(); }
  saveProfile(person, action, payload) {
    const id = recordId(person.url, action);
    this.db.prepare('INSERT INTO outreach (id,contact_id,profile_url,action,payload,status,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, contactId(person.url), person.url, action, JSON.stringify(payload), 'pending_sheet', now());
    return this.get(id);
  }
  error(url, stage, error) { this.db.prepare('INSERT INTO errors(profile_url,stage,error,created_at) VALUES (?,?,?,?)').run(url, stage, error, now()); }
  update(id, status, error = null) { this.db.prepare('UPDATE outreach SET status=?,last_error=? WHERE id=?').run(status, error, id); }
  markDone(id, addedAt) {
    const timestamp = addedAt && !Number.isNaN(Date.parse(addedAt)) ? new Date(addedAt).toISOString() : now();
    this.db.prepare("UPDATE outreach SET status='done',done_at=COALESCE(done_at,?),last_error=NULL WHERE id=?").run(timestamp, id);
  }
  recordEditedMessage(id, message) {
    const record = this.get(id);
    if (!record) return;
    const payload = JSON.parse(record.payload);
    payload.editedMessage = message;
    this.db.prepare('UPDATE outreach SET payload=? WHERE id=?').run(JSON.stringify(payload), id);
  }
}
