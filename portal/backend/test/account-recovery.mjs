// JSAN Dev AI - password resets, lockouts and seats, end to end.
//
//   npm run test:recovery      (from portal/backend)
//
// The three things an admin could not do before these routes existed: help
// somebody who forgot their password, lift a lockout, and give up the seat of
// somebody who left. The last one is the delicate one - a departure must free
// the seat and kill the gateway key without destroying the conversations - so
// the checks below assert on what survives as hard as on what stops working.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsan-recovery-'));
const PORT = 8092;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(dir, 'recovery.db');

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.SQLITE_PATH = DB;
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.KEY_ENCRYPTION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.LITELLM_MASTER_KEY = 'sk-test-master';
process.env.LITELLM_BASE_URL = 'http://litellm.test';
process.env.REGISTRATION_ACCESS_CODE = '';
process.env.ALLOWED_EMAIL_DOMAIN = 'jsan.com';
// Two seed accounts plus two seats, so the seat arithmetic is observable.
process.env.MAX_USERS = '4';
process.env.LOGIN_MAX_ATTEMPTS = '3';
process.env.LOGIN_LOCKOUT_MINUTES = '30';
process.env.ADMIN_EMAILS = 'admindev@jsan.com';
process.env.SEED_ACCOUNTS = JSON.stringify([
  { name: 'Admin', email: 'admindev@jsan.com', password: 'admindev@43' },
  { name: 'Developer', email: 'developerai@jsan.com', password: 'developerai@333' }
]);

// --- Stub LiteLLM ----------------------------------------------------------
const realFetch = globalThis.fetch;
const gatewayCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!target.startsWith(process.env.LITELLM_BASE_URL)) return realFetch(url, options);
  const route = target.slice(process.env.LITELLM_BASE_URL.length).split('?')[0];
  gatewayCalls.push({ route, body: options.body ? JSON.parse(options.body) : null });
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (route === '/user/new') return reply({ user_id: JSON.parse(options.body).user_id });
  if (route === '/key/generate') return reply({ key: `sk-${crypto.randomUUID()}` });
  if (route === '/user/list') return reply({ users: [] });
  return reply({ ok: true });
};

function client() {
  let cookie = '';
  return async (method, route, body) => {
    const res = await realFetch(`${BASE}${route}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    for (const line of res.headers.getSetCookie?.() || []) {
      const pair = line.split(';')[0];
      if (pair.startsWith('jsan_session=')) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: res.status, data };
  };
}

const passed = [], failed = [];
async function check(name, fn) {
  try { await fn(); passed.push(name); }
  catch (error) { failed.push(`${name}: ${error.message}`); }
}

await import('../src/server.js');
for (let i = 0; i < 60; i++) { try { await realFetch(`${BASE}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
await new Promise(r => setTimeout(r, 1500));

/** A direct handle, for asserting on what survives rather than on what the API says. */
const { connect } = await import('@jsan/database');
const peek = (sql, ...args) => { const db = connect({ file: DB }); try { return db.prepare(sql).all(...args); } finally { db.close(); } };

const admin = client();
await admin('POST', '/api/auth/login', { email: 'admindev@jsan.com', password: 'admindev@43' });

const findUser = async (email) => {
  const { data } = await admin('GET', '/api/admin/users');
  return data.users.find(u => u.email === email);
};
const inviteAndRegister = async (name, email, password) => {
  const issued = await admin('POST', '/api/admin/access-codes', { assignedEmails: [email] });
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  const person = client();
  const reg = await person('POST', '/api/auth/register',
    { name, email, password, confirmPassword: password, accessCode: issued.data.issued[0].code });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  return person;
};

// ---------------------------------------------------------------------------
// Password resets
// ---------------------------------------------------------------------------

let kiran;
await check('a developer can be invited and registers normally', async () => {
  kiran = await inviteAndRegister('Kiran', 'kiran@jsan.com', 'kiranpass123');
  assert.equal((await kiran('GET', '/api/me')).data.email, 'kiran@jsan.com');
});

let resetCode = null;
await check('an admin can issue a password reset, and read the code back', async () => {
  const user = await findUser('kiran@jsan.com');
  assert.equal(user.canResetPassword, true, 'the page would not offer a reset');
  const { status, data } = await admin('POST', `/api/admin/users/${user.id}/password-reset`);
  assert.equal(status, 201, JSON.stringify(data));
  assert.match(data.code, /^RESET-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/, `unexpected shape: ${data.code}`);
  resetCode = data.code;
  // Readable afterwards, like an access code: an admin who lost the message
  // must not have to issue a second one.
  const listed = await findUser('kiran@jsan.com');
  assert.equal(listed.passwordReset?.code, resetCode, 'the reset cannot be read back');
});

await check('the wrong email with a real code is refused', async () => {
  const { status, data } = await client()('POST', '/api/auth/reset-password',
    { email: 'developerai@jsan.com', code: resetCode, password: 'brandnewpass1', confirmPassword: 'brandnewpass1' });
  assert.equal(status, 403, JSON.stringify(data));
  assert.match(data.error, /not valid for this email/);
});

await check('a made-up code is refused', async () => {
  const { status } = await client()('POST', '/api/auth/reset-password',
    { email: 'kiran@jsan.com', code: 'RESET-AAAAA-BBBBB-CCCCC', password: 'brandnewpass1', confirmPassword: 'brandnewpass1' });
  assert.equal(status, 403);
});

await check('mismatched passwords are refused before anything is written', async () => {
  const { status } = await client()('POST', '/api/auth/reset-password',
    { email: 'kiran@jsan.com', code: resetCode, password: 'brandnewpass1', confirmPassword: 'somethingelse1' });
  assert.equal(status, 400);
  // and the code still works afterwards
  const user = await findUser('kiran@jsan.com');
  assert.ok(user.passwordReset, 'a rejected attempt consumed the reset');
});

await check('the reset sets the new password and signs the developer in', async () => {
  const person = client();
  const { status, data } = await person('POST', '/api/auth/reset-password',
    { email: 'KIRAN@jsan.com', code: resetCode.toLowerCase(), password: 'brandnewpass1', confirmPassword: 'brandnewpass1' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.user.email, 'kiran@jsan.com');
  assert.equal((await person('GET', '/api/me')).status, 200, 'the reset did not sign them in');
});

await check('the new password works and the old one does not', async () => {
  assert.equal((await client()('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'brandnewpass1' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'kiranpass123' })).status, 401);
});

await check('a spent reset code cannot be used again', async () => {
  const { status, data } = await client()('POST', '/api/auth/reset-password',
    { email: 'kiran@jsan.com', code: resetCode, password: 'thirdpassword1', confirmPassword: 'thirdpassword1' });
  assert.equal(status, 403, JSON.stringify(data));
  assert.match(data.error, /already been used/);
});

await check('issuing a second reset retires the first', async () => {
  const user = await findUser('kiran@jsan.com');
  const first = await admin('POST', `/api/admin/users/${user.id}/password-reset`);
  const second = await admin('POST', `/api/admin/users/${user.id}/password-reset`);
  assert.equal(second.status, 201);
  const stale = await client()('POST', '/api/auth/reset-password',
    { email: 'kiran@jsan.com', code: first.data.code, password: 'fourthpassword1', confirmPassword: 'fourthpassword1' });
  assert.equal(stale.status, 403, 'the superseded code still worked');
  assert.match(stale.data.error, /replaced by a newer one/);
  // and only the newest is offered back to the admin
  assert.equal((await findUser('kiran@jsan.com')).passwordReset.code, second.data.code);
});

await check('an expired reset is refused', async () => {
  const user = await findUser('kiran@jsan.com');
  const issued = await admin('POST', `/api/admin/users/${user.id}/password-reset`);
  const db = connect({ file: DB });
  db.prepare('UPDATE jsan_password_resets SET expires_at=? WHERE id=?')
    .run(new Date(Date.now() - 60_000).toISOString(), issued.data.reset.id);
  db.close();
  const { status, data } = await client()('POST', '/api/auth/reset-password',
    { email: 'kiran@jsan.com', code: issued.data.code, password: 'fifthpassword1', confirmPassword: 'fifthpassword1' });
  assert.equal(status, 403, JSON.stringify(data));
  assert.match(data.error, /expired/);
  assert.equal((await findUser('kiran@jsan.com')).passwordReset, null, 'an expired reset is still being offered');
});

await check('a seeded account is refused a reset, with the reason', async () => {
  const seeded = await findUser('developerai@jsan.com');
  assert.equal(seeded.canResetPassword, false, 'the page would offer a reset that cannot hold');
  const { status, data } = await admin('POST', `/api/admin/users/${seeded.id}/password-reset`);
  assert.equal(status, 409, JSON.stringify(data));
  assert.match(data.error, /SEED_ACCOUNTS/);
});

await check('resets are admin-only', async () => {
  const user = await findUser('kiran@jsan.com');
  assert.equal((await kiran('POST', `/api/admin/users/${user.id}/password-reset`)).status, 403);
  assert.equal((await client()('POST', `/api/admin/users/${user.id}/password-reset`)).status, 401);
});

// ---------------------------------------------------------------------------
// Lockouts
// ---------------------------------------------------------------------------

await check('three wrong passwords lock the account, and an admin can lift it', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await client()('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'wrong-password' });
  }
  const locked = await client()('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'brandnewpass1' });
  assert.equal(locked.status, 429, 'the account did not lock');

  const user = await findUser('kiran@jsan.com');
  assert.ok(user.lockedUntil, 'the developer list does not show the lockout');

  const unlocked = await admin('POST', `/api/admin/users/${user.id}/unlock`);
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.data));
  assert.equal(unlocked.data.wasLocked, true);

  const after = await client()('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'brandnewpass1' });
  assert.equal(after.status, 200, 'the developer is still locked out');
  assert.equal((await findUser('kiran@jsan.com')).lockedUntil, null);
});

await check('a successful reset also clears a lockout', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await client()('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'wrong-password' });
  }
  const user = await findUser('kiran@jsan.com');
  assert.ok(user.lockedUntil, 'setup failed: not locked');
  const issued = await admin('POST', `/api/admin/users/${user.id}/password-reset`);
  const done = await client()('POST', '/api/auth/reset-password',
    { email: 'kiran@jsan.com', code: issued.data.code, password: 'sixthpassword12', confirmPassword: 'sixthpassword12' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await client()('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'sixthpassword12' })).status, 200,
    'they proved they hold the code and were still made to wait out the lockout');
});

await check('unlocking is admin-only', async () => {
  const user = await findUser('kiran@jsan.com');
  assert.equal((await kiran('POST', `/api/admin/users/${user.id}/unlock`)).status, 403);
});

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

await check('the seats fill up', async () => {
  await inviteAndRegister('Meera', 'meera@jsan.com', 'meerapass123');
  const { data } = await admin('GET', '/api/admin/overview');
  assert.equal(data.registeredUsers, 4, JSON.stringify(data));
  assert.equal(data.seatsRemaining, 0);
  assert.equal(data.registrationOpen, false);
});

let kiranId = null, conversationsBefore = 0, messagesBefore = 0;
await check('a departing developer gives up their seat without losing their work', async () => {
  const user = await findUser('kiran@jsan.com');
  kiranId = user.id;
  assert.equal(user.canDeactivate, true);

  // Some work of theirs to protect.
  const db = connect({ file: DB });
  const conversationId = crypto.randomUUID();
  db.prepare('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES(?,?,?,?)')
    .run(conversationId, kiranId, 'How do we shard this table?', 'think');
  for (const [role, content] of [['user', 'how do we shard this?'], ['assistant', 'by tenant id']]) {
    db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES(?,?,?,?)')
      .run(crypto.randomUUID(), conversationId, role, content);
  }
  db.close();
  conversationsBefore = peek('SELECT id FROM jsan_conversations WHERE user_id=?', kiranId).length;
  messagesBefore = peek(`SELECT m.id FROM jsan_messages m JOIN jsan_conversations c ON c.id=m.conversation_id WHERE c.user_id=?`, kiranId).length;
  assert.ok(conversationsBefore > 0 && messagesBefore > 0, 'setup failed');

  const before = gatewayCalls.length;
  const { status, data } = await admin('POST', `/api/admin/users/${kiranId}/deactivate`, { reason: 'Left the company' });
  assert.equal(status, 200, JSON.stringify(data));

  // The half that matters on the day: the key stops working.
  const revoked = gatewayCalls.slice(before).find(call => call.route === '/key/delete');
  assert.ok(revoked, 'the gateway key was never revoked');
  assert.deepEqual(revoked.body.key_aliases, ['jsan-kiran@jsan.com']);
});

await check('nothing of theirs was deleted', async () => {
  assert.equal(peek('SELECT id FROM jsan_users WHERE id=?', kiranId).length, 1, 'the account row was deleted');
  assert.equal(peek('SELECT id FROM jsan_conversations WHERE user_id=?', kiranId).length, conversationsBefore, 'conversations were lost');
  assert.equal(peek(`SELECT m.id FROM jsan_messages m JOIN jsan_conversations c ON c.id=m.conversation_id WHERE c.user_id=?`, kiranId).length,
    messagesBefore, 'messages were lost');
});

await check('the seat came back', async () => {
  const { data } = await admin('GET', '/api/admin/overview');
  assert.equal(data.registeredUsers, 3, JSON.stringify(data));
  assert.equal(data.seatsRemaining, 1);
  assert.equal(data.registrationOpen, true);
  assert.equal(data.deactivatedUsers, 1);
  const status = await client()('GET', '/api/auth/registration-status');
  assert.equal(status.data.remaining, 1, 'the sign-in screen still says the portal is full');
});

await check('a deactivated developer cannot sign in', async () => {
  const { status, data } = await client()('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'sixthpassword12' });
  assert.equal(status, 403, JSON.stringify(data));
  assert.equal(data.code, 'account_disabled');
});

await check('a session they already had stops working at once', async () => {
  // `kiran` still holds the cookie from before the deactivation.
  const { status, data } = await kiran('GET', '/api/conversations');
  assert.equal(status, 401, JSON.stringify(data));
  assert.equal(data.code, 'account_disabled');
});

await check('they cannot register again on the same address', async () => {
  const issued = await admin('POST', '/api/admin/access-codes', { assignedEmails: ['kiran@jsan.com'] });
  assert.equal(issued.data.issued.length, 0, 'a code was issued for a deactivated account');
  assert.match(issued.data.skipped[0].error, /[Dd]eactivated/);
});

await check('the freed seat can be given to somebody else', async () => {
  await inviteAndRegister('Suresh', 'suresh@jsan.com', 'sureshpass123');
  const { data } = await admin('GET', '/api/admin/overview');
  assert.equal(data.seatsRemaining, 0);
});

await check('restoring is refused while every seat is taken', async () => {
  const { status, data } = await admin('POST', `/api/admin/users/${kiranId}/restore`);
  assert.equal(status, 409, JSON.stringify(data));
  assert.match(data.error, /seats is taken/);
});

await check('restoring returns the seat, a fresh key and their history', async () => {
  const suresh = await findUser('suresh@jsan.com');
  await admin('POST', `/api/admin/users/${suresh.id}/deactivate`);

  const before = gatewayCalls.length;
  const { status, data } = await admin('POST', `/api/admin/users/${kiranId}/restore`);
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(gatewayCalls.slice(before).some(call => call.route === '/key/generate'), 'no new gateway key was issued');

  const back = await client();
  assert.equal((await back('POST', '/api/auth/login', { email: 'kiran@jsan.com', password: 'sixthpassword12' })).status, 200,
    'they cannot sign in after being restored');
  const conversations = await back('GET', '/api/conversations');
  assert.equal(conversations.data.length, conversationsBefore, 'their conversations did not come back');
  assert.equal(conversations.data[0].title, 'How do we shard this table?');
  assert.equal((await back('GET', '/api/me/api-key')).status, 200, 'their new key cannot be read');
});

await check('an admin account cannot be deactivated', async () => {
  const boss = await findUser('admindev@jsan.com');
  assert.equal(boss.canDeactivate, false, 'the page would offer to lock the admin out of it');
  const { status, data } = await admin('POST', `/api/admin/users/${boss.id}/deactivate`);
  assert.equal(status, 409, JSON.stringify(data));
  assert.match(data.error, /ADMIN_EMAILS/);
});

await check('deactivating and restoring are admin-only', async () => {
  const anon = client();
  assert.equal((await anon('POST', `/api/admin/users/${kiranId}/deactivate`)).status, 401);
  assert.equal((await anon('POST', `/api/admin/users/${kiranId}/restore`)).status, 401);
});

await check('an unknown developer is a clean 404, not a crash', async () => {
  for (const route of ['password-reset', 'unlock', 'deactivate', 'restore']) {
    const { status } = await admin('POST', `/api/admin/users/${crypto.randomUUID()}/${route}`);
    assert.equal(status, 404, `${route} answered ${status}`);
  }
});

await check('the database is still sound after all of that', async () => {
  const { checkIntegrity } = await import('@jsan/database');
  const db = connect({ file: DB });
  const problems = checkIntegrity(db);
  db.close();
  assert.deepEqual(problems, []);
});

for (const name of passed) console.log(`  PASS  ${name}`);
for (const name of failed) console.log(`  FAIL  ${name}`);
console.log(`\n${passed.length} passed, ${failed.length} failed`);
console.log(`\nThrowaway database: ${dir}`);
process.exit(failed.length ? 1 : 0);
