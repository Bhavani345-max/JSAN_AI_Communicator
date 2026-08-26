// JSAN Dev AI - admin access codes, end to end.
//
//   npm test        (from portal/backend, or `npm run test:api` from portal)
//
// Boots the real server against a throwaway SQLite file with LiteLLM stubbed
// out, then drives it over HTTP exactly as the browser does. Registration is
// the one route where a mistake hands out a seat, so the refusals get as much
// attention here as the successes: a code that belongs to somebody else, one
// already spent, one withdrawn, one lapsed, and the admin routes reached by an
// account that is not an admin.
//
// This configuration has no REGISTRATION_ACCESS_CODE at all, so an issued code
// is the only way in. test/shared-code.mjs covers the other half - a
// deployment that still sets one - because that is decided when the process
// starts and cannot be varied inside a single run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsan-e2e-'));
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.SQLITE_PATH = path.join(dir, 'e2e.db');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.KEY_ENCRYPTION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.LITELLM_MASTER_KEY = 'sk-test-master';
process.env.LITELLM_BASE_URL = 'http://litellm.test';
// Deliberately empty: an issued code must be the only way in.
process.env.REGISTRATION_ACCESS_CODE = '';
process.env.ALLOWED_EMAIL_DOMAIN = 'jsan.com';
process.env.MAX_USERS = '20';
process.env.ADMIN_EMAILS = 'admindev@jsan.com';
process.env.SEED_ACCOUNTS = JSON.stringify([
  { name: 'Admin', email: 'admindev@jsan.com', password: 'admindev@43' },
  { name: 'Developer', email: 'developerai@jsan.com', password: 'developerai@333' }
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
  if (route === '/key/update' || route === '/key/delete' || route === '/user/delete') return reply({ ok: true });
  if (route === '/user/list') return reply({ users: [] });
  if (route === '/v1/models') return reply({ data: [] });
  return reply({});
};

// --- Tiny HTTP client that keeps a cookie jar ------------------------------
function client() {
  let cookie = '';
  return async (method, route, body) => {
    const res = await realFetch(`${BASE}${route}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const line of set) {
      const pair = line.split(';')[0];
      if (pair.startsWith('jsan_session=')) cookie = pair;
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

// Wait for the port to answer, then for seeding to finish.
for (let i = 0; i < 60; i++) {
  try { await realFetch(`${BASE}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 200)); }
}
await new Promise(r => setTimeout(r, 1500));

const admin = client();
const dev = client();

await check('the seeded admin can sign in and is flagged as an admin', async () => {
  const { status, data } = await admin('POST', '/api/auth/login', { email: 'admindev@jsan.com', password: 'admindev@43' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.user.isAdmin, true, 'admin flag missing on login');
  const me = await admin('GET', '/api/me');
  assert.equal(me.data.isAdmin, true, '/api/me does not report admin');
});

await check('a non-admin account is refused the admin routes', async () => {
  const other = client();
  const login = await other('POST', '/api/auth/login', { email: 'developerai@jsan.com', password: 'developerai@333' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.user.isAdmin, false);
  const overview = await other('GET', '/api/admin/overview');
  assert.equal(overview.status, 403, `expected 403, got ${overview.status}`);
  const issue = await other('POST', '/api/admin/access-codes', { label: 'sneaky' });
  assert.equal(issue.status, 403);
});

await check('a signed-out visitor is refused the admin routes', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/admin/access-codes')).status, 401);
});

let personalCode = null, personalId = null;
await check('an admin can generate a code bound to one developer', async () => {
  const { status, data } = await admin('POST', '/api/admin/access-codes', {
    label: 'For Ravi', assignedEmail: 'ravi@jsan.com', maxUses: 1, expiresInDays: 14
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.match(data.code, /^JSAN-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/, `unexpected shape: ${data.code}`);
  assert.equal(data.entry.status, 'active');
  assert.equal(data.entry.assignedEmail, 'ravi@jsan.com');
  assert.equal(data.entry.uses, 0);
  assert.ok(data.entry.expiresAt, 'no expiry set');
  personalCode = data.code; personalId = data.entry.id;
});

await check('an admin can read every code back at any time', async () => {
  const { data } = await admin('GET', '/api/admin/access-codes');
  const entry = data.codes.find(c => c.id === personalId);
  assert.ok(entry, 'the issued code is not listed');
  assert.equal(entry.code, personalCode, 'the list does not carry the code itself');
  assert.equal(entry.readable, true);
  assert.ok(entry.hint.includes('…'), `hint is not masked: ${entry.hint}`);
  assert.ok(data.codes.every(c => typeof c.code === 'string'), 'some codes came back unreadable');
});

await check('the codes are for admins only - nobody else can list them', async () => {
  const other = client();
  await other('POST', '/api/auth/login', { email: 'developerai@jsan.com', password: 'developerai@333' });
  assert.equal((await other('GET', '/api/admin/access-codes')).status, 403);
});

await check('registration is refused without a code', async () => {
  const { status, data } = await dev('POST', '/api/auth/register',
    { name: 'Ravi', email: 'ravi@jsan.com', password: 'ravipass123', confirmPassword: 'ravipass123', accessCode: '' });
  assert.equal(status, 403, JSON.stringify(data));
  assert.match(data.error, /not valid/);
});

await check('registration is refused with a made-up code', async () => {
  const { status } = await dev('POST', '/api/auth/register',
    { name: 'Ravi', email: 'ravi@jsan.com', password: 'ravipass123', confirmPassword: 'ravipass123', accessCode: 'JSAN-AAAAA-BBBBB-CCCCC' });
  assert.equal(status, 403);
});

await check("another developer cannot spend somebody else's code", async () => {
  const { status, data } = await client()('POST', '/api/auth/register',
    { name: 'Priya', email: 'priya@jsan.com', password: 'priyapass123', confirmPassword: 'priyapass123', accessCode: personalCode });
  assert.equal(status, 403, JSON.stringify(data));
  assert.match(data.error, /different email address/);
});

await check('the refused attempt did not spend the code', async () => {
  const { data } = await admin('GET', '/api/admin/access-codes');
  assert.equal(data.codes.find(c => c.id === personalId).uses, 0);
});

await check('the developer it was issued to registers with it, lowercase and dashless', async () => {
  const typed = personalCode.toLowerCase().replace(/-/g, ' ');
  const { status, data } = await dev('POST', '/api/auth/register',
    { name: 'Ravi', email: 'ravi@jsan.com', password: 'ravipass123', confirmPassword: 'ravipass123', accessCode: typed });
  assert.equal(status, 201, JSON.stringify(data));
  assert.equal(data.user.email, 'ravi@jsan.com');
  assert.equal(data.user.isAdmin, false);
});

await check('the code is spent, and says who spent it', async () => {
  const { data } = await admin('GET', '/api/admin/access-codes');
  const entry = data.codes.find(c => c.id === personalId);
  assert.equal(entry.uses, 1);
  assert.equal(entry.status, 'used');
  assert.equal(entry.lastUsedBy, 'ravi@jsan.com');
  assert.ok(entry.lastUsedAt);
});

await check('a spent code cannot be used a second time', async () => {
  const { status, data } = await client()('POST', '/api/auth/register',
    { name: 'Ravi Two', email: 'ravi2@jsan.com', password: 'ravipass123', confirmPassword: 'ravipass123', accessCode: personalCode });
  assert.equal(status, 403, JSON.stringify(data));
  assert.match(data.error, /already been used/);
});

await check('a revoked code stops working', async () => {
  const issued = await admin('POST', '/api/admin/access-codes', { label: 'To be revoked', maxUses: 1, expiresInDays: 7 });
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  const revoked = await admin('POST', `/api/admin/access-codes/${issued.data.entry.id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.entry.status, 'revoked');
  const attempt = await client()('POST', '/api/auth/register',
    { name: 'Nope', email: 'nope@jsan.com', password: 'nopepass123', confirmPassword: 'nopepass123', accessCode: issued.data.code });
  assert.equal(attempt.status, 403);
  assert.match(attempt.data.error, /withdrawn/);
});

await check('an expired code stops working', async () => {
  const issued = await admin('POST', '/api/admin/access-codes', { label: 'Already stale', maxUses: 1, expiresInDays: 0 });
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  assert.equal(issued.data.entry.expiresAt, null, 'expiresInDays 0 should never expire');
  // Backdate it directly, which is the only way to observe the expiry branch.
  const { connect } = await import('@jsan/database');
  const raw = connect({ file: process.env.SQLITE_PATH });
  raw.prepare('UPDATE jsan_access_codes SET expires_at=? WHERE id=?')
    .run(new Date(Date.now() - 60_000).toISOString(), issued.data.entry.id);
  raw.close();
  const attempt = await client()('POST', '/api/auth/register',
    { name: 'Late', email: 'late@jsan.com', password: 'latepass1234', confirmPassword: 'latepass1234', accessCode: issued.data.code });
  assert.equal(attempt.status, 403, JSON.stringify(attempt.data));
  assert.match(attempt.data.error, /expired/);
});

await check('an unbound code lets any allowed address register', async () => {
  const issued = await admin('POST', '/api/admin/access-codes', { label: 'Open seat', maxUses: 2, expiresInDays: 30 });
  assert.equal(issued.data.entry.assignedEmail, null);
  const first = await client()('POST', '/api/auth/register',
    { name: 'Anita', email: 'anita@jsan.com', password: 'anitapass123', confirmPassword: 'anitapass123', accessCode: issued.data.code });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const second = await client()('POST', '/api/auth/register',
    { name: 'Bala', email: 'bala@jsan.com', password: 'balapass1234', confirmPassword: 'balapass1234', accessCode: issued.data.code });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  const third = await client()('POST', '/api/auth/register',
    { name: 'Chandra', email: 'chandra@jsan.com', password: 'chandrapass12', confirmPassword: 'chandrapass12', accessCode: issued.data.code });
  assert.equal(third.status, 403, 'a two-use code admitted a third developer');
});

await check('a code cannot be bound to an address outside the allowed domain', async () => {
  const { data } = await admin('POST', '/api/admin/access-codes', { assignedEmail: 'outsider@gmail.com' });
  assert.equal(data.issued.length, 0, 'a code was issued for an address that could never use it');
  assert.match(data.skipped[0].error, /jsan\.com/);
});

await check('a code cannot be bound to somebody who already has an account', async () => {
  const { data } = await admin('POST', '/api/admin/access-codes', { assignedEmail: 'ravi@jsan.com' });
  assert.equal(data.issued.length, 0, 'a code was issued to somebody who is already registered');
  assert.match(data.skipped[0].error, /already has an account/i);
});

await check('nonsense limits are refused rather than coerced', async () => {
  assert.equal((await admin('POST', '/api/admin/access-codes', { maxUses: 0 })).status, 400);
  assert.equal((await admin('POST', '/api/admin/access-codes', { maxUses: 999 })).status, 400);
  assert.equal((await admin('POST', '/api/admin/access-codes', { expiresInDays: -1 })).status, 400);
  assert.equal((await admin('POST', '/api/admin/access-codes', { expiresInDays: 'soon' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/access-codes', { maxUses: 2.5 })).status, 400);
});

await check('the overview reports seats, codes and who the admins are', async () => {
  const { status, data } = await admin('GET', '/api/admin/overview');
  assert.equal(status, 200);
  assert.equal(data.maxUsers, 20);
  assert.equal(data.sharedCodeEnabled, false);
  assert.deepEqual(data.admins, ['admindev@jsan.com']);
  assert.equal(data.registeredUsers, data.maxUsers - data.seatsRemaining);
  assert.ok(data.totalCodes >= 4, `expected several codes, got ${data.totalCodes}`);
});

await check('a code can be deleted outright', async () => {
  const issued = await admin('POST', '/api/admin/access-codes', { label: 'Typo' });
  const gone = await admin('DELETE', `/api/admin/access-codes/${issued.data.entry.id}`);
  assert.equal(gone.status, 200);
  const { data } = await admin('GET', '/api/admin/access-codes');
  assert.ok(!data.codes.some(c => c.id === issued.data.entry.id), 'the deleted code is still listed');
  assert.equal((await admin('POST', `/api/admin/access-codes/${issued.data.entry.id}/revoke`)).status, 404);
});


await check('an admin can issue codes for a whole list in one submission', async () => {
  const { status, data } = await admin('POST', '/api/admin/access-codes', {
    label: 'October intake',
    assignedEmails: 'kiran@jsan.com, meera@jsan.com\nsuresh@jsan.com',
    maxUses: 1, expiresInDays: 30
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.equal(data.issued.length, 3, `expected 3 codes, got ${data.issued.length}`);
  assert.deepEqual(data.issued.map(i => i.email), ['kiran@jsan.com', 'meera@jsan.com', 'suresh@jsan.com']);
  assert.equal(data.skipped.length, 0, JSON.stringify(data.skipped));
  const codes = new Set(data.issued.map(i => i.code));
  assert.equal(codes.size, 3, 'two developers were given the same code');
  for (const one of data.issued) {
    assert.match(one.code, /^JSAN-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    assert.equal(one.entry.assignedEmail, one.email);
    assert.equal(one.entry.label, 'October intake');
  }
});

await check('one bad address in a pasted list does not cost the good ones', async () => {
  const { status, data } = await admin('POST', '/api/admin/access-codes', {
    assignedEmails: ['deepa@jsan.com', 'not-an-email', 'outsider@gmail.com', 'ravi@jsan.com', 'kiran@jsan.com']
  });
  assert.equal(status, 201, JSON.stringify(data));
  assert.deepEqual(data.issued.map(i => i.email), ['deepa@jsan.com']);
  const reasons = Object.fromEntries(data.skipped.map(sk => [sk.email, sk.error]));
  assert.match(reasons['not-an-email'], /valid email/);
  assert.match(reasons['outsider@gmail.com'], /jsan\.com/);
  assert.match(reasons['ravi@jsan.com'], /already has an account/i);
  assert.match(reasons['kiran@jsan.com'], /unused code/i);
});

await check('the same address listed twice gets one code, not two', async () => {
  const { data } = await admin('POST', '/api/admin/access-codes', {
    assignedEmails: 'vikram@jsan.com, VIKRAM@jsan.com\n vikram@jsan.com '
  });
  assert.equal(data.issued.length, 1, `expected 1 code, got ${data.issued.length}`);
  assert.equal(data.skipped.length, 0, JSON.stringify(data.skipped));
});

await check('a list longer than the batch limit is refused outright', async () => {
  const many = Array.from({ length: 51 }, (_, i) => `bulk${i}@jsan.com`);
  const { status, data } = await admin('POST', '/api/admin/access-codes', { assignedEmails: many });
  assert.equal(status, 400, JSON.stringify(data));
  assert.match(data.error, /at most 50/);
  const listed = await admin('GET', '/api/admin/access-codes');
  assert.ok(!listed.data.codes.some(c => c.assignedEmail === 'bulk0@jsan.com'), 'a refused batch still wrote codes');
});

await check('the developer list names the code that let each person in', async () => {
  const { status, data } = await admin('GET', '/api/admin/users');
  assert.equal(status, 200, JSON.stringify(data));
  const ravi = data.users.find(u => u.email === 'ravi@jsan.com');
  assert.ok(ravi, 'the registered developer is missing');
  assert.equal(ravi.admittedBy, 'issued-code');
  assert.equal(ravi.accessCode?.code, personalCode, 'the wrong code is attributed to this developer');
  assert.equal(ravi.accessCode?.label, 'For Ravi');
  assert.ok(ravi.redeemedAt, 'no redemption time recorded');
  assert.equal(ravi.isAdmin, false);

  const boss = data.users.find(u => u.email === 'admindev@jsan.com');
  assert.equal(boss.admittedBy, 'seed-account', 'a declared account is not labelled as one');
  assert.equal(boss.accessCode, null);
  assert.equal(boss.isAdmin, true);
});

await check('a code used by two developers is attributed to each of them', async () => {
  const { data } = await admin('GET', '/api/admin/users');
  const anita = data.users.find(u => u.email === 'anita@jsan.com');
  const bala = data.users.find(u => u.email === 'bala@jsan.com');
  assert.equal(anita.admittedBy, 'issued-code');
  assert.equal(bala.admittedBy, 'issued-code');
  assert.equal(anita.accessCode.id, bala.accessCode.id, 'they did not share the two-use code');
  assert.equal(anita.accessCode.uses, 2);
  assert.equal(anita.accessCode.code, bala.accessCode.code);
});

await check('the developer list is admin-only', async () => {
  const other = client();
  await other('POST', '/api/auth/login', { email: 'developerai@jsan.com', password: 'developerai@333' });
  assert.equal((await other('GET', '/api/admin/users')).status, 403);
  assert.equal((await client()('GET', '/api/admin/users')).status, 401);
});

await check('the overview counts seats already promised to unspent codes', async () => {
  const { data } = await admin('GET', '/api/admin/overview');
  assert.equal(typeof data.outstandingCodeUses, 'number');
  assert.ok(data.outstandingCodeUses >= 4, `expected outstanding codes, got ${data.outstandingCodeUses}`);
});

for (const name of passed) console.log(`  PASS  ${name}`);
for (const name of failed) console.log(`  FAIL  ${name}`);
console.log(`\n${passed.length} passed, ${failed.length} failed`);
// Left where it is rather than removed: the server still holds the SQLite
// handle open, and Windows refuses to unlink an open file - which would fail
// the run over a temp directory the OS clears anyway.
console.log(`
Throwaway database: ${dir}`);
process.exit(failed.length ? 1 : 0);
