import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/** Ordered migrations. Index + 1 is the resulting PRAGMA user_version. */
const MIGRATIONS: Array<() => string> = [
  () => readFileSync(join(here, 'schema.sql'), 'utf8'),
  // v2: voice-note drafts
  () => `ALTER TABLE drafts ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
         ALTER TABLE drafts ADD COLUMN audio BLOB;
         ALTER TABLE drafts ADD COLUMN audio_mime TEXT;
         ALTER TABLE drafts ADD COLUMN ptt INTEGER NOT NULL DEFAULT 0;`,
];

/**
 * Opens (creating if needed) the SQLite database with WAL enabled and applies migrations.
 * The parent directory is created with 0700 and the file with 0600.
 * Pass ':memory:' for tests.
 */
export function openDatabase(path: string): DB {
  const inMemory = path === ':memory:';
  if (!inMemory) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSafe(dir, 0o700);
  }
  const db = new Database(path);
  if (!inMemory) {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSafe(f, 0o600);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  if (!inMemory) {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSafe(f, 0o600);
  }
  return db;
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!();
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function chmodSafe(p: string, mode: number): void {
  try {
    chmodSync(p, mode);
  } catch {
    // Non-POSIX filesystems (e.g. some Docker volume drivers) may reject chmod.
  }
}
