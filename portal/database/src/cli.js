#!/usr/bin/env node
// JSAN Dev AI — SQLite database CLI.
//
// Run from portal/database as `npm run init` / `status` / `reset`, or from
// portal as `npm run db:init` and friends.
//
//   node src/cli.js init     create (or upgrade) the database file
//   node src/cli.js status   report tables, row counts and integrity
//   node src/cli.js reset    delete and recreate it (needs --force)

import fs from 'node:fs';
import { connect, openDatabase, initSchema, databasePath, checkIntegrity } from './sqlite.js';

const TABLES = ['jsan_users', 'jsan_conversations', 'jsan_messages', 'jsan_message_images'];

function sizeOf(file) {
  try { return `${(fs.statSync(file).size / 1024).toFixed(1)} KB`; }
  catch { return 'missing'; }
}

function init() {
  const file = databasePath();
  const existed = fs.existsSync(file);
  const db = connect({ file });
  const version = db.prepare("SELECT value FROM jsan_schema_meta WHERE key='schema_version'").get()?.value;
  db.close();
  console.log(`${existed ? 'Updated' : 'Created'} ${file}`);
  console.log(`Schema version ${version}, tables: ${TABLES.join(', ')}`);
}

function status() {
  const file = databasePath();
  if (!fs.existsSync(file)) {
    console.error(`No database at ${file}. Run: npm run db:init`);
    process.exitCode = 1;
    return;
  }
  const db = openDatabase({ file, readOnly: true });
  const version = db.prepare("SELECT value FROM jsan_schema_meta WHERE key='schema_version'").get()?.value;
  const journal = db.prepare('PRAGMA journal_mode').get()?.journal_mode;

  console.log(`File          ${file}`);
  console.log(`Size          ${sizeOf(file)}`);
  console.log(`Schema        version ${version}`);
  console.log(`Journal mode  ${journal}`);
  console.log('Rows');
  for (const table of TABLES) {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    console.log(`  ${table.padEnd(20)} ${count}`);
  }
  const indexes = db.prepare(
    "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name"
  ).all();
  console.log('Indexes');
  for (const index of indexes) console.log(`  ${index.name.padEnd(44)} on ${index.tbl_name}`);

  const problems = checkIntegrity(db);
  db.close();
  console.log(problems.length ? `Integrity     FAILED\n  ${problems.join('\n  ')}` : 'Integrity     ok');
  if (problems.length) process.exitCode = 1;
}

function reset() {
  if (!process.argv.includes('--force')) {
    console.error('reset deletes all data. Re-run with --force to confirm.');
    process.exitCode = 1;
    return;
  }
  const file = databasePath();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  initSchema(openDatabase({ file })).close();
  console.log(`Recreated empty ${file}`);
}

const command = process.argv[2] || 'init';
const commands = { init, status, reset };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use init, status or reset.`);
  process.exit(1);
}
commands[command]();
