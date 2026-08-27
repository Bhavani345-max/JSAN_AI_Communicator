// JSAN Dev AI - a developer changes their own password.
//
//   npm run test:password      (from portal/backend)
//
// The reset codes tested in account-recovery.mjs are the assisted path, for
// somebody who cannot get in at all. This is the ordinary one, and the point of
// it is that it needs no admin and no code on a chat thread. What the checks
// below care about most: the current password is genuinely required, the old
// one stops working, and a reset the admin had already issued does not survive
// as a spare key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsan-password-'));
const PORT = 8093;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(dir, 'password.db');

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.SQLITE_PATH = DB;
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.KEY_ENCRYPTION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.LITELLM_MASTER_KEY = 'sk-test-master';
process.env.LITELLM_BASE_URL = 'http://litellm.test';
process.env.REGISTRATION_ACCESS_CODE = '';
process.env.ALLOWED_EMAIL_DOMAIN = 'jsan.com';
process.env.MAX_USERS = '4';
process.env.LOGIN_MAX_ATTEMPTS = '3';
process.env.LOGIN_LOCKOUT_MINUTES = '30';
process.env.ADMIN_EMAILS = 'admindev@jsan.com';
process.env.SEED_ACCOUNTS = JSON.stringify([
  { name: 'Admin', email: 'admindev@jsan.com', password: 'admindev@43' }
]);

// --- Stub LiteLLM ----------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!target.startsWith(process.env.LITELLM_BASE_URL)) return realFetch(url, options);
  const route = target.slice(process.env.LITELLM_BASE_URL.length).split('?')[0];
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

const admin = client();
await admin('POST', '/api/auth/login', { email: 'admindev@jsan.com', password: 'admindev@43' });

const findUser = async (email) => {
  const { data } = await admin('GET', '/api/admin/users');
  return data.users.find(u => u.email === email);
};

const FIRST = 'firstpassword1';
const SECOND = 'secondpassword2';

let asha;
await check('a developer registers with an issued code', async () => {
  const issued = await admin('POST', '/api/admin/access-codes', { assignedEmails: ['asha@jsan.com'] });
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  asha = client();
  const reg = await asha('POST', '/api/auth/register',
    { name: 'Asha', email: 'asha@jsan.com', password: FIRST, confirmPassword: FIRST, accessCode: issued.data.issued[0].code });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
});

await check('the form is reached from inside the portal, not from the sign-in card', async () => {
  assert.equal((await asha('GET', '/api/me')).data.email, 'asha@jsan.com');
});

await check('the current password is required, and checked', async () => {
  const { status, data } = await asha('POST', '/api/auth/change-password',
    { currentPassword: 'notmypassword', password: SECOND, confirmPassword: SECOND });
  assert.equal(status, 403, JSON.stringify(data));
  assert.match(data.error, /not your current password/);
});

await check('an empty current password is refused', async () => {
  const { status, data } = await asha('POST', '/api/auth/change-password',
    { currentPassword: '', password: SECOND, confirmPassword: SECOND });
  assert.equal(status, 400, JSON.stringify(data));
});

await check('a short new password is refused', async () => {
  const { status, data } = await asha('POST', '/api/auth/change-password',
    { currentPassword: FIRST, password: 'short1', confirmPassword: 'short1' });
  assert.equal(status, 400, JSON.stringify(data));
  assert.match(data.error, /at least 10 characters/);
});

await check('mismatched new passwords are refused', async () => {
  const { status } = await asha('POST', '/api/auth/change-password',
    { currentPassword: FIRST, password: SECOND, confirmPassword: 'somethingelse2' });
  assert.equal(status, 400);
});

await check('setting the same password again is refused, with the reason', async () => {
  const { status, data } = await asha('POST', '/api/auth/change-password',
    { currentPassword: FIRST, password: FIRST, confirmPassword: FIRST });
  assert.equal(status, 400, JSON.stringify(data));
  assert.match(data.error, /already your password/);
});

await check('none of that changed the password', async () => {
  assert.equal((await client()('POST', '/api/auth/login', { email: 'asha@jsan.com', password: FIRST })).status, 200);
});

let resetCode = null;
await check('an admin issues a reset the developer turns out not to need', async () => {
  const user = await findUser('asha@jsan.com');
  const { status, data } = await admin('POST', `/api/admin/users/${user.id}/password-reset`);
  assert.equal(status, 201, JSON.stringify(data));
  resetCode = data.code;
});

await check('the change goes through, and the session survives it', async () => {
  const { status, data } = await asha('POST', '/api/auth/change-password',
    { currentPassword: FIRST, password: SECOND, confirmPassword: SECOND });
  assert.equal(status, 200, JSON.stringify(data));
  // The cookie is untouched, so the tab they did it in keeps working.
  assert.equal((await asha('GET', '/api/me')).data.email, 'asha@jsan.com');
});

await check('the new password works and the old one does not', async () => {
  assert.equal((await client()('POST', '/api/auth/login', { email: 'asha@jsan.com', password: SECOND })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'asha@jsan.com', password: FIRST })).status, 401);
});

await check('the reset code they never used is retired, not left as a spare key', async () => {
  const { status, data } = await client()('POST', '/api/auth/reset-password',
    { email: 'asha@jsan.com', code: resetCode, password: 'thirdpassword3', confirmPassword: 'thirdpassword3' });
  assert.equal(status, 403, JSON.stringify(data));
  assert.match(data.error, /replaced by a newer one|already been used/);
  const user = await findUser('asha@jsan.com');
  assert.equal(user.passwordReset, null, 'the admin page still shows a live reset');
});

await check('a seeded account is refused, for the reason a reset is', async () => {
  const { status, data } = await admin('POST', '/api/auth/change-password',
    { currentPassword: 'admindev@43', password: 'adminpassword9', confirmPassword: 'adminpassword9' });
  assert.equal(status, 409, JSON.stringify(data));
  assert.match(data.error, /SEED_ACCOUNTS/);
  // and the configured password still works
  assert.equal((await client()('POST', '/api/auth/login', { email: 'admindev@jsan.com', password: 'admindev@43' })).status, 200);
});

await check('changing a password needs a session', async () => {
  const { status } = await client()('POST', '/api/auth/change-password',
    { currentPassword: SECOND, password: 'fourthpassword4', confirmPassword: 'fourthpassword4' });
  assert.equal(status, 401);
});

await check('the failed sign-in left no lockout behind', async () => {
  const user = await findUser('asha@jsan.com');
  assert.equal(user.lockedUntil, null, 'the account is still shown as locked out');
});

await check('the database is still sound after all of that', async () => {
  const { connect, checkIntegrity } = await import('@jsan/database');
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
