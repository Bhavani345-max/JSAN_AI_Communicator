// JSAN Dev AI — SQLite connection helper.
//
// Uses the built-in node:sqlite module (Node 22.5+), so the database needs no
// native dependency and no separate service. Node still prints an
// ExperimentalWarning for it; run with NODE_NO_WARNINGS=1 to silence that.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** Absolute path of the database file (override with SQLITE_PATH). */
export function databasePath() {
  const configured = String(process.env.SQLITE_PATH || '').trim();
  return path.resolve(PACKAGE_ROOT, configured || 'data/jsan.db');
}

/** ISO-8601 UTC timestamp in the exact format the schema defaults produce. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Open the database and apply the pragmas the app depends on.
 *
 * These are per-connection, not stored in the file, so every process that
 * opens the database has to set them again:
 *   foreign_keys  — without it ON DELETE CASCADE silently does nothing
 *   journal_mode  — WAL lets reads run while a write is in flight (persisted)
 *   busy_timeout  — wait for the single writer lock instead of failing at once
 *   synchronous   — NORMAL is the durable-enough pairing for WAL
 */
export function openDatabase({ file = databasePath(), readOnly = false } = {}) {
  if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return db;
}

/** Create the tables and indexes. Idempotent — safe to run on every boot. */
export function initSchema(db) {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/** Open an initialized database in one step. */
export function connect(options) {
  const db = openDatabase(options);
  if (!options?.readOnly) initSchema(db);
  return db;
}

/**
 * Run `fn` inside a write transaction, rolling back if it throws.
 *
 * BEGIN IMMEDIATE takes SQLite's single write lock up front. That is the
 * replacement for the `pg_advisory_xact_lock` the Postgres registration path
 * uses: it serializes the seat-count check against a concurrent signup, so two
 * registrations cannot both read "19 users" and both insert.
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

/** Structural + referential health check. Returns [] when the file is clean. */
export function checkIntegrity(db) {
  const problems = db.prepare('PRAGMA integrity_check').all()
    .map(row => row.integrity_check)
    .filter(value => value !== 'ok');
  const orphans = db.prepare('PRAGMA foreign_key_check').all();
  for (const row of orphans) {
    problems.push(`orphaned row in ${row.table} (rowid ${row.rowid}) -> ${row.parent}`);
  }
  return problems;
}
