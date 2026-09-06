import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
export { runCapabilityProcess, type CapabilityProcessOptions } from './process.js';

/** Local persistent stores own their connection. Never point this at an application database. */
export function createCapabilityDocumentDatabase<T extends { id: string; updatedAt?: string; createdAt?: string }>(input: {
  directory: string;
  filename: string;
  legacyFilename: string;
  readLegacy(value: unknown): T[];
}) {
  let connection: DatabaseSync | undefined;
  let closed = false;
  const directory = path.resolve(input.directory);
  function database() {
    if (closed) throw new Error('Capability store has been disposed.');
    if (connection) return connection;
    mkdirSync(directory, { recursive: true });
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path.join(directory, input.filename));
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, record_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS records_updated ON records(updated_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!db.prepare("SELECT 1 FROM store_meta WHERE key='legacy-imported'").get()) {
          let records: T[] = [];
          try { records = input.readLegacy(JSON.parse(readFileSync(path.join(directory, input.legacyFilename), 'utf8'))); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const insert = db.prepare('INSERT OR IGNORE INTO records VALUES (?, ?, ?)');
          for (const record of records) insert.run(record.id, record.updatedAt || record.createdAt || '', JSON.stringify(record));
          db.prepare("INSERT INTO store_meta VALUES ('legacy-imported', '1')").run();
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      connection = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }
  return {
    database,
    transaction<R>(operation: (db: DatabaseSync) => R): R {
      const db = database();
      db.exec('BEGIN IMMEDIATE');
      try { const result = operation(db); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    get(id: string): T | undefined {
      const row = database().prepare('SELECT record_json FROM records WHERE id=?').get(id);
      return row ? JSON.parse(String(row.record_json)) as T : undefined;
    },
    save(record: T) {
      database().prepare(`INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        updated_at=excluded.updated_at, record_json=excluded.record_json`)
        .run(record.id, record.updatedAt || record.createdAt || '', JSON.stringify(record));
    },
    async dispose() { closed = true; connection?.close(); connection = undefined; },
  };
}
