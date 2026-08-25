#!/usr/bin/env node
// JSAN Dev AI — schema verification.
//
// Builds a throwaway database in the OS temp directory and exercises the
// constraints the application relies on, so a schema change that quietly
// breaks a cascade or a uniqueness rule fails here instead of in production.
//
//   npm run verify        (from portal/database)

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, transaction, checkIntegrity } from './sqlite.js';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsan-db-')), 'verify.db');
const db = connect({ file });

const passed = [];
const failed = [];
function check(name, fn) {
  try { fn(); passed.push(name); }
  catch (error) { failed.push(`${name}: ${error.message}`); }
}

const userId = crypto.randomUUID();
const insertUser = (id, email) => db.prepare(
  `INSERT INTO jsan_users(id,name,email,password_hash,litellm_user_id,litellm_key_ciphertext,litellm_key_iv,litellm_key_tag,last_login_at)
   VALUES(?,?,?,?,?,?,?,?,?)`
).run(id, 'Dev One', email, 'bcrypt$hash', `llm-${id}`, 'ct', 'iv', 'tag', new Date().toISOString());

check('a user can be inserted', () => {
  insertUser(userId, 'dev@jsanconsulting.com');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_users').get().n, 1);
});

check('created_at defaults to an ISO-8601 UTC instant', () => {
  const { created_at } = db.prepare('SELECT created_at FROM jsan_users WHERE id=?').get(userId);
  assert.match(created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `got ${created_at}`);
  assert.ok(Math.abs(Date.now() - Date.parse(created_at)) < 60_000, 'timestamp is not current');
});

check('email uniqueness ignores case', () => {
  assert.throws(() => insertUser(crypto.randomUUID(), 'DEV@JSANCONSULTING.COM'), /UNIQUE/i);
});

check('sign-in lookup matches any casing', () => {
  assert.equal(db.prepare('SELECT id FROM jsan_users WHERE email=?').get('Dev@JsanConsulting.com')?.id, userId);
});

const conversationId = crypto.randomUUID();
check('a conversation and its messages can be inserted', () => {
  db.prepare('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES(?,?,?,?)')
    .run(conversationId, userId, 'First question', 'code');
  for (const [role, content] of [['user', 'hi'], ['assistant', 'hello']]) {
    db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES(?,?,?,?)')
      .run(crypto.randomUUID(), conversationId, role, content);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_messages').get().n, 2);
});

check('an unknown message role is rejected', () => {
  assert.throws(() => db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES(?,?,?,?)')
    .run(crypto.randomUUID(), conversationId, 'system', 'nope'), /CHECK/i);
});

check('an unknown conversation mode is rejected', () => {
  assert.throws(() => db.prepare('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES(?,?,?,?)')
    .run(crypto.randomUUID(), userId, 'title', 'turbo'), /CHECK/i);
});

check('a conversation for a missing user is rejected', () => {
  assert.throws(() => db.prepare('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES(?,?,?,?)')
    .run(crypto.randomUUID(), 'ghost', 'title', 'auto'), /FOREIGN KEY/i);
});

check('NOT NULL is enforced', () => {
  assert.throws(() => db.prepare('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES(?,?,?,?)')
    .run(crypto.randomUUID(), userId, null, 'auto'), /NOT NULL/i);
});

check('STRICT keeps text columns textual', () => {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES(?,?,?,?)').run(id, userId, 12345, 'auto');
  // A number converts to TEXT losslessly, so a reader never gets a number back.
  const row = db.prepare('SELECT title, typeof(title) t FROM jsan_conversations WHERE id=?').get(id);
  assert.equal(row.t, 'text', `title stored as ${row.t}`);
  assert.equal(typeof row.title, 'string');
  // A BLOB has no lossless text form, so STRICT refuses it outright.
  assert.throws(() => db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES(?,?,?,?)')
    .run(crypto.randomUUID(), id, 'user', new Uint8Array([1, 2, 3])), /cannot store BLOB value in TEXT column/i);
  db.prepare('DELETE FROM jsan_conversations WHERE id=?').run(id);
});

check('the conversation list query is served by its index', () => {
  const plan = db.prepare(
    'EXPLAIN QUERY PLAN SELECT id FROM jsan_conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 60'
  ).all(userId).map(row => row.detail).join(' | ');
  assert.match(plan, /jsan_conversations_user_updated_idx/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, `the sort is not served by the index: ${plan}`);
});

check('a failed transaction rolls back', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM jsan_users').get().n;
  assert.throws(() => transaction(db, () => {
    insertUser(crypto.randomUUID(), 'second@jsanconsulting.com');
    throw new Error('seat cap reached');
  }), /seat cap/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_users').get().n, before);
});

check('deleting a user cascades to conversations and messages', () => {
  db.prepare('DELETE FROM jsan_users WHERE id=?').run(userId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_conversations').get().n, 0, 'conversations survived');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_messages').get().n, 0, 'messages survived');
});

check('the database is still structurally sound', () => assert.deepEqual(checkIntegrity(db), []));

db.close();
fs.rmSync(path.dirname(file), { recursive: true, force: true });

for (const name of passed) console.log(`  PASS  ${name}`);
for (const name of failed) console.log(`  FAIL  ${name}`);
console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
