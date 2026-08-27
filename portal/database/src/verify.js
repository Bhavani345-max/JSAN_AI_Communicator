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

const accessCodeId = crypto.randomUUID();
const insertCode = (id, hash, extra = {}) => db.prepare(
  `INSERT INTO jsan_access_codes(id,code_hash,code_ciphertext,code_iv,code_tag,code_hint,label,assigned_email,max_uses,created_by)
   VALUES(?,?,?,?,?,?,?,?,?,?)`
).run(id, hash, 'ct', 'iv', 'tag', 'JSAN-...-9K2Q', extra.label ?? 'For Dev One',
      extra.assignedEmail ?? null, extra.maxUses ?? 1, extra.createdBy ?? userId);

check('an access code can be issued', () => {
  insertCode(accessCodeId, 'hash-one', { assignedEmail: 'dev@jsanconsulting.com' });
  const row = db.prepare('SELECT * FROM jsan_access_codes WHERE id=?').get(accessCodeId);
  assert.equal(row.uses, 0);
  assert.equal(row.max_uses, 1);
  assert.equal(row.revoked_at, null);
});

check('two codes cannot share a hash', () => {
  assert.throws(() => insertCode(crypto.randomUUID(), 'hash-one'), /UNIQUE/i);
});

check('an access code lookup matches the assigned address in any casing', () => {
  const row = db.prepare('SELECT id FROM jsan_access_codes WHERE code_hash=? AND assigned_email=?')
    .get('hash-one', 'Dev@JsanConsulting.com');
  assert.equal(row?.id, accessCodeId);
});

check('a code that allows no uses at all is rejected', () => {
  assert.throws(() => insertCode(crypto.randomUUID(), 'hash-zero', { maxUses: 0 }), /CHECK/i);
});

check('spending a code is what stops it being spent twice', () => {
  const spend = () => transaction(db, () => {
    const row = db.prepare('SELECT uses,max_uses FROM jsan_access_codes WHERE id=?').get(accessCodeId);
    if (row.uses >= row.max_uses) throw new Error('access code already used');
    db.prepare('UPDATE jsan_access_codes SET uses=uses+1,last_used_at=?,last_used_by=? WHERE id=?')
      .run(new Date().toISOString(), 'dev@jsanconsulting.com', accessCodeId);
  });
  spend();
  assert.equal(db.prepare('SELECT uses FROM jsan_access_codes WHERE id=?').get(accessCodeId).uses, 1);
  assert.throws(spend, /already used/);
});

check('a redemption names the developer a code let in', () => {
  db.prepare('INSERT INTO jsan_access_code_redemptions(id,code_id,user_id,email) VALUES(?,?,?,?)')
    .run(crypto.randomUUID(), accessCodeId, userId, 'dev@jsanconsulting.com');
  const row = db.prepare(`SELECT r.email, c.code_hint FROM jsan_access_code_redemptions r
    JOIN jsan_access_codes c ON c.id = r.code_id WHERE r.user_id = ?`).get(userId);
  assert.equal(row?.email, 'dev@jsanconsulting.com');
  assert.equal(row?.code_hint, 'JSAN-...-9K2Q');
});

check('a redemption cannot point at a code that was never issued', () => {
  assert.throws(() => db.prepare('INSERT INTO jsan_access_code_redemptions(id,code_id,user_id,email) VALUES(?,?,?,?)')
    .run(crypto.randomUUID(), 'ghost-code', userId, 'nobody@jsanconsulting.com'), /FOREIGN KEY/i);
});

check('deleting a user cascades to conversations and messages', () => {
  db.prepare('DELETE FROM jsan_users WHERE id=?').run(userId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_conversations').get().n, 0, 'conversations survived');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_messages').get().n, 0, 'messages survived');
});

check('a redemption survives the developer whose account is removed', () => {
  const row = db.prepare('SELECT user_id,email FROM jsan_access_code_redemptions WHERE code_id=?').get(accessCodeId);
  assert.ok(row, 'the redemption was deleted with the user');
  assert.equal(row.user_id, null, 'user_id was not cleared');
  assert.equal(row.email, 'dev@jsanconsulting.com', 'the address was lost');
});

check('an issued code outlives the admin who issued it', () => {
  const row = db.prepare('SELECT created_by,uses FROM jsan_access_codes WHERE id=?').get(accessCodeId);
  assert.ok(row, 'the access code was deleted with its author');
  assert.equal(row.created_by, null, 'created_by was not cleared');
  assert.equal(row.uses, 1, 'the usage record was lost');
});

check('deleting a code takes its redemptions with it', () => {
  db.prepare('DELETE FROM jsan_access_codes WHERE id=?').run(accessCodeId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_access_code_redemptions').get().n, 0,
    'a redemption outlived the code it points at');
});

// ---------------------------------------------------------------------------
// Password resets and released seats — schema version 6
// ---------------------------------------------------------------------------
//
// Both tables record something *about* an account rather than something the
// account owns, which is what makes their cascades worth pinning down. A reset
// must not outlive the developer it would let in, a released seat must not
// outlive the account it was released from, and neither may take the admin who
// wrote it down with them when that admin's own account goes.
//
// These start from users of their own: by this point the checks above have
// deleted theirs, which is rather the point of them.

const developerId = crypto.randomUUID();
const adminId = crypto.randomUUID();
const resetId = crypto.randomUUID();

const insertReset = (id, hash, options = {}) => db.prepare(
  `INSERT INTO jsan_password_resets(id,user_id,email,code_hash,code_ciphertext,code_iv,code_tag,code_hint,expires_at,created_by)
   VALUES(?,?,?,?,?,?,?,?,?,?)`
).run(
  id,
  options.userId ?? developerId,
  options.email ?? 'kiran@jsanconsulting.com',
  hash, 'ct', 'iv', 'tag', 'RESET-...-7VQU',
  'expiresAt' in options ? options.expiresAt : new Date(Date.now() + 86_400_000).toISOString(),
  'createdBy' in options ? options.createdBy : adminId
);

check('a password reset can be issued against a developer', () => {
  insertUser(developerId, 'kiran@jsanconsulting.com');
  insertUser(adminId, 'admin@jsanconsulting.com');
  insertReset(resetId, 'reset-hash-one');
  const row = db.prepare('SELECT * FROM jsan_password_resets WHERE id=?').get(resetId);
  assert.equal(row.used_at, null, 'a fresh reset was already spent');
  assert.equal(row.revoked_at, null, 'a fresh reset was already retired');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `got ${row.created_at}`);
});

check('two resets cannot share a hash', () => {
  assert.throws(() => insertReset(crypto.randomUUID(), 'reset-hash-one'), /UNIQUE/i);
});

check('a reset that never lapses is refused', () => {
  // expires_at is NOT NULL deliberately: a reset with no expiry is a spare key.
  assert.throws(() => insertReset(crypto.randomUUID(), 'reset-hash-two', { expiresAt: null }), /NOT NULL/i);
});

check('a reset for a developer who does not exist is refused', () => {
  assert.throws(() => insertReset(crypto.randomUUID(), 'reset-hash-three', { userId: 'ghost' }), /FOREIGN KEY/i);
});

check('a reset is matched to its address in any casing', () => {
  const row = db.prepare('SELECT id FROM jsan_password_resets WHERE code_hash=? AND email=?')
    .get('reset-hash-one', 'Kiran@JsanConsulting.com');
  assert.equal(row?.id, resetId);
});

check('a developer can give up their seat', () => {
  db.prepare('INSERT INTO jsan_disabled_users(user_id,email,reason,disabled_by) VALUES(?,?,?,?)')
    .run(developerId, 'kiran@jsanconsulting.com', 'left the team', adminId);
  const row = db.prepare('SELECT * FROM jsan_disabled_users WHERE user_id=?').get(developerId);
  assert.equal(row.reason, 'left the team');
  assert.match(row.disabled_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `got ${row.disabled_at}`);
});

check('the same seat cannot be given up twice', () => {
  assert.throws(() => db.prepare('INSERT INTO jsan_disabled_users(user_id,email) VALUES(?,?)')
    .run(developerId, 'kiran@jsanconsulting.com'), /UNIQUE|PRIMARY KEY/i);
});

check('a seat cannot be released for a developer who does not exist', () => {
  assert.throws(() => db.prepare('INSERT INTO jsan_disabled_users(user_id,email) VALUES(?,?)')
    .run('ghost', 'nobody@jsanconsulting.com'), /FOREIGN KEY/i);
});

check('a reset and a released seat both outlive the admin behind them', () => {
  db.prepare('DELETE FROM jsan_users WHERE id=?').run(adminId);
  const reset = db.prepare('SELECT created_by FROM jsan_password_resets WHERE id=?').get(resetId);
  assert.ok(reset, 'the reset was deleted with the admin who issued it');
  assert.equal(reset.created_by, null, 'created_by was not cleared');
  const released = db.prepare('SELECT disabled_by,email FROM jsan_disabled_users WHERE user_id=?').get(developerId);
  assert.ok(released, 'the record was deleted with the admin who wrote it');
  assert.equal(released.disabled_by, null, 'disabled_by was not cleared');
  assert.equal(released.email, 'kiran@jsanconsulting.com', 'the address was lost');
});

check('deleting a developer takes their reset and their released seat with them', () => {
  db.prepare('DELETE FROM jsan_users WHERE id=?').run(developerId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_password_resets').get().n, 0,
    'a reset outlived the account it would have let into');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jsan_disabled_users').get().n, 0,
    'a deactivation record outlived the account it was about');
});

check('the database is still structurally sound', () => assert.deepEqual(checkIntegrity(db), []));

db.close();
fs.rmSync(path.dirname(file), { recursive: true, force: true });

for (const name of passed) console.log(`  PASS  ${name}`);
for (const name of failed) console.log(`  FAIL  ${name}`);
console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
