// JSAN Dev AI - opening an existing database with the new portal.
//
//   npm run test:migration      (from portal/backend)
//
// Everything else in this folder tests a database this version created. This
// one tests the database the LAST version created: a real schema-version-5
// file, with accounts, conversations, messages, an attached image, access codes
// and their redemptions in it, opened by the portal that now expects version 6.
//
// The upgrade is meant to be nothing but two new tables - no ALTER, no rewrite,
// no migration step to run - so the assertion is the strict one: every row that
// was there before is byte for byte the row that is there afterwards, people
// sign in with the passwords they already had, and a session issued before the
// upgrade is still a session after it. Then the new machinery is exercised on
// top and the same rows are checked again, because a reset or a deactivation
// must not reach anybody else's work either.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsan-migration-'));
const DB = path.join(dir, 'legacy.db');
const FINGERPRINT = path.join(dir, 'fingerprint.json');

// --- Phase one: a database from the previous version -----------------------
const built = spawnSync(process.execPath, [path.join(here, 'fixtures', 'legacy-db.mjs'), DB, FINGERPRINT],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (built.status !== 0) {
  console.error(built.stdout || '');
  console.error(built.stderr || '');
  console.error('could not build the legacy database');
  process.exit(1);
}
const before = JSON.parse(fs.readFileSync(FINGERPRINT, 'utf8'));

const PORT = 8095;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.SQLITE_PATH = DB;
// The same secrets the fixture used, which is the point: a deploy changes the
// code, not the environment.
process.env.JWT_SECRET = 'migration-test-jwt-secret-0123456789abcdef';
process.env.KEY_ENCRYPTION_SECRET = 'migration-test-key-secret-0123456789abcd';
process.env.LITELLM_MASTER_KEY = 'sk-test-master';
process.env.LITELLM_BASE_URL = 'http://litellm.test';
process.env.REGISTRATION_ACCESS_CODE = '';
process.env.ALLOWED_EMAIL_DOMAIN = 'jsan.com';
process.env.MAX_USERS = '6';
process.env.ADMIN_EMAILS = 'admindev@jsan.com';
process.env.SEED_ACCOUNTS = JSON.stringify([
  { name: 'Admin', email: 'admindev@jsan.com', password: 'admindev@43' }
]);

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

function client(startingCookie = '') {
  let cookie = startingCookie;
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

// openDatabase rather than connect: connect() runs initSchema, so reading the
// database with it would perform the very upgrade this test exists to watch -
// from inside the assertion meant to catch it.
const { openDatabase } = await import('@jsan/database');
const peek = (fn) => { const db = openDatabase({ file: DB }); try { return fn(db); } finally { db.close(); } };

const TABLES = Object.keys(before).filter(t => !t.startsWith('_'));
const fingerprintNow = () => peek(db => {
  const out = {};
  for (const table of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const stable = rows.map(r => JSON.stringify(r, Object.keys(r).sort())).sort();
    out[table] = { rows: rows.length, digest: crypto.createHash('sha256').update(stable.join('\n')).digest('hex') };
  }
  return out;
});

// --- What we were handed ---------------------------------------------------
const asHandedOver = peek(db => ({
  version: db.prepare("SELECT value FROM jsan_schema_meta WHERE key='schema_version'").get()?.value,
  tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
}));
await check('the fixture really is a version 5 database', async () => {
  assert.equal(asHandedOver.version, '5');
  assert.ok(!asHandedOver.tables.includes('jsan_password_resets'), 'it already had the reset table');
  assert.ok(!asHandedOver.tables.includes('jsan_disabled_users'), 'it already had the disabled table');
  assert.ok(before.jsan_users.rows >= 3, `only ${before.jsan_users.rows} accounts in the fixture`);
  assert.ok(before.jsan_conversations.rows >= 5, `only ${before.jsan_conversations.rows} conversations`);
  assert.ok(before.jsan_messages.rows >= 10, `only ${before.jsan_messages.rows} messages`);
  assert.ok(before.jsan_message_images.rows >= 1, 'no attached images');
  assert.ok(before.jsan_access_code_redemptions.rows >= 2, 'nobody redeemed a code');
});

// A session from before the upgrade, signed the way the running portal signed
// it - so what is tested afterwards is a cookie already in somebody's browser.
const jwt = (await import('jsonwebtoken')).default;
const priyaId = before._userIds.priya;
const oldSession = jwt.sign({ sub: priyaId, email: 'priya@jsan.com', name: 'Priya Nair' },
  process.env.JWT_SECRET, { expiresIn: '12h', issuer: 'jsan-dev-ai' });

// --- The upgrade -----------------------------------------------------------
await import('../src/server.js');
for (let i = 0; i < 60; i++) { try { await realFetch(`${BASE}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
await new Promise(r => setTimeout(r, 1500));

await check('the database is now at version 6, with the two new tables', async () => {
  const after = peek(db => ({
    version: db.prepare("SELECT value FROM jsan_schema_meta WHERE key='schema_version'").get()?.value,
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  }));
  assert.equal(after.version, '6');
  assert.ok(after.tables.includes('jsan_password_resets'));
  assert.ok(after.tables.includes('jsan_disabled_users'));
});

await check('every row that was there is still there, unchanged', async () => {
  const after = fingerprintNow();
  for (const table of TABLES) {
    if (table === 'jsan_schema_meta') continue;   // the version marker is meant to move
    assert.equal(after[table].rows, before[table].rows, `${table}: ${before[table].rows} rows became ${after[table].rows}`);
    assert.equal(after[table].digest, before[table].digest, `${table} was rewritten by the upgrade`);
  }
});

await check('the only thing the upgrade changed is the version marker', async () => {
  const meta = peek(db => db.prepare('SELECT * FROM jsan_schema_meta').all());
  assert.equal(meta.length, before.jsan_schema_meta.rows, 'a row appeared in or vanished from the meta table');
  assert.equal(meta.find(r => r.key === 'schema_version')?.value, '6');
});

await check('the new tables are empty - nothing was invented for anybody', async () => {
  const counts = peek(db => ({
    resets: db.prepare('SELECT COUNT(*) n FROM jsan_password_resets').get().n,
    disabled: db.prepare('SELECT COUNT(*) n FROM jsan_disabled_users').get().n
  }));
  assert.deepEqual(counts, { resets: 0, disabled: 0 });
});

// --- The people who were already using it ----------------------------------
const priya = client();
await check('an existing developer signs in with the password they already had', async () => {
  const { status, data } = await priya('POST', '/api/auth/login', { email: 'priya@jsan.com', password: 'priyapassword1' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.user.email, 'priya@jsan.com');
});

await check('their conversations and messages all came through', async () => {
  const list = await priya('GET', '/api/conversations');
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 3, `${list.data.length} conversations`);
  const opened = await priya('GET', `/api/conversations/${list.data[0].id}`);
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.ok(opened.data.messages.length >= 2, 'the messages did not come with it');
});

await check('an attached image survived the upgrade', async () => {
  const images = peek(db => db.prepare('SELECT * FROM jsan_message_images').all());
  assert.equal(images.length, before.jsan_message_images.rows);
  assert.equal(images[0].name, 'screenshot.png');
  assert.ok(images[0].data.startsWith('data:image/png;base64,'));
});

await check('their developer key still decrypts', async () => {
  const { status, data } = await priya('GET', '/api/me/api-key');
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(String(data.apiKey).startsWith('sk-'), 'the key came back unreadable');
});

await check('a session issued before the upgrade is still a session after it', async () => {
  const carried = client(`jsan_session=${oldSession}`);
  const { status, data } = await carried('GET', '/api/me');
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.email, 'priya@jsan.com');
});

await check('the seat count reads the accounts that were already there', async () => {
  // health is where the count itself is reported; /api/auth/status gives the
  // seats left, which is the same fact from the other end.
  const { data } = await client()('GET', '/api/health');
  assert.equal(data.registeredUsers, before.jsan_users.rows, `${data.registeredUsers} of ${before.jsan_users.rows}`);
});

// --- The new machinery, on a database it did not create ---------------------
const admin = client();
await admin('POST', '/api/auth/login', { email: 'admindev@jsan.com', password: 'admindev@43' });
const findUser = async (email) => (await admin('GET', '/api/admin/users')).data.users.find(u => u.email === email);

await check('the admin page reads accounts that predate the feature', async () => {
  const user = await findUser('priya@jsan.com');
  assert.ok(user, 'the developer is missing from the list');
  assert.equal(user.disabledAt, null);
  assert.equal(user.passwordReset, null);
  assert.equal(user.canResetPassword, true);
  assert.equal(user.canDeactivate, true);
});

await check('a reset can be issued and used on an account created before it existed', async () => {
  const user = await findUser('priya@jsan.com');
  const issued = await admin('POST', `/api/admin/users/${user.id}/password-reset`);
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  const used = await client()('POST', '/api/auth/reset-password',
    { email: 'priya@jsan.com', code: issued.data.code, password: 'priyanewpassword2', confirmPassword: 'priyanewpassword2' });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  const back = await client()('POST', '/api/auth/login', { email: 'priya@jsan.com', password: 'priyanewpassword2' });
  assert.equal(back.status, 200);
});

await check('resetting a password did not touch a single conversation', async () => {
  const after = fingerprintNow();
  for (const table of ['jsan_conversations', 'jsan_messages', 'jsan_message_images']) {
    assert.equal(after[table].digest, before[table].digest, `${table} changed when a password was reset`);
  }
});

await check('a developer who predates the feature can be deactivated and restored', async () => {
  const user = await findUser('vikram@jsan.com');
  const off = await admin('POST', `/api/admin/users/${user.id}/deactivate`);
  assert.equal(off.status, 200, JSON.stringify(off.data));
  // Sign-in refuses a deactivated account with 403. The 401 is what a session
  // that was already open gets on its next request.
  const refused = await client()('POST', '/api/auth/login', { email: 'vikram@jsan.com', password: 'vikrampassword1' });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.data.code, 'account_disabled');
  // Their work is still there while they are away.
  const theirs = peek(db => db.prepare('SELECT COUNT(*) n FROM jsan_conversations WHERE user_id=?').get(before._userIds.vikram).n);
  assert.equal(theirs, 2, `${theirs} conversations left`);
  const on = await admin('POST', `/api/admin/users/${user.id}/restore`);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  const back = await client()('POST', '/api/auth/login', { email: 'vikram@jsan.com', password: 'vikrampassword1' });
  assert.equal(back.status, 200, 'the password they had before the upgrade stopped working');
});

await check('after all of that, every conversation and message is still the one it was', async () => {
  const after = fingerprintNow();
  for (const table of ['jsan_conversations', 'jsan_messages', 'jsan_message_images', 'jsan_access_codes', 'jsan_access_code_redemptions']) {
    assert.equal(after[table].rows, before[table].rows, `${table}: ${before[table].rows} rows became ${after[table].rows}`);
    assert.equal(after[table].digest, before[table].digest, `${table} was modified`);
  }
});

await check('the database is sound', async () => {
  const { checkIntegrity } = await import('@jsan/database');
  const db = openDatabase({ file: DB });
  const problems = checkIntegrity(db);
  db.close();
  assert.deepEqual(problems, []);
});

for (const name of passed) console.log(`  PASS  ${name}`);
for (const name of failed) console.log(`  FAIL  ${name}`);
console.log(`\n${passed.length} passed, ${failed.length} failed`);
console.log(`\nThrowaway database: ${dir}`);
process.exit(failed.length ? 1 : 0);
