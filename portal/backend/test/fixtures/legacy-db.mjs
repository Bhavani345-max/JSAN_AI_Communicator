// Builds a schema-version-5 database with real content in it, for migration.mjs.
//
// Run as its own process, and deliberately so: the point of the test next door
// is that a database written by the PREVIOUS version of the portal is opened by
// this one. Both halves cannot live in one process, because a server is booted
// once per process and the whole question is what the second boot does to what
// the first one left behind.
//
//   node test/fixtures/legacy-db.mjs <database path> <fingerprint path>
//
// The content is made through the real routes - registration, access codes -
// rather than by hand, so the rows are the rows the portal actually writes.
// Only the conversations are inserted directly, because writing one otherwise
// needs the model.

import fs from 'node:fs';
import crypto from 'node:crypto';

const [DB, FINGERPRINT] = process.argv.slice(2);
if (!DB || !FINGERPRINT) { console.error('usage: legacy-db.mjs <db> <fingerprint>'); process.exit(2); }

const PORT = 8094;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.SQLITE_PATH = DB;
// Fixed rather than random: migration.mjs reopens this database in another
// process and has to verify that a session issued before the upgrade is still
// accepted after it, which needs the same signing key on both sides.
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
    return { status: res.status, data, cookie };
  };
}

await import('../../src/server.js');
for (let i = 0; i < 60; i++) { try { await realFetch(`${BASE}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
await new Promise(r => setTimeout(r, 1500));

const admin = client();
await admin('POST', '/api/auth/login', { email: 'admindev@jsan.com', password: 'admindev@43' });

// Two developers, admitted the way developers are admitted.
const issued = await admin('POST', '/api/admin/access-codes', { assignedEmails: ['priya@jsan.com', 'vikram@jsan.com'] });
if (issued.status !== 201) { console.error('could not issue codes', issued.data); process.exit(1); }
const people = [
  { name: 'Priya Nair', email: 'priya@jsan.com', password: 'priyapassword1' },
  { name: 'Vikram Rao', email: 'vikram@jsan.com', password: 'vikrampassword1' }
];
for (const [i, person] of people.entries()) {
  const reg = await client()('POST', '/api/auth/register', {
    ...person, confirmPassword: person.password, accessCode: issued.data.issued[i].code
  });
  if (reg.status !== 201) { console.error('could not register', person.email, reg.data); process.exit(1); }
}

// A failed sign-in, so the attempts table is not empty either.
await client()('POST', '/api/auth/login', { email: 'priya@jsan.com', password: 'wrong' });

// Conversations, messages and an attached image, written straight in: a chat
// turn needs the model, and what this fixture needs is rows.
const { connect } = await import('@jsan/database');
const db = connect({ file: DB });
const now = () => new Date().toISOString();
const priya = db.prepare("SELECT id FROM jsan_users WHERE email='priya@jsan.com'").get();
const vikram = db.prepare("SELECT id FROM jsan_users WHERE email='vikram@jsan.com'").get();
const conversationsFor = (user, titles) => titles.map((title, i) => {
  const cid = crypto.randomUUID();
  db.prepare('INSERT INTO jsan_conversations(id,user_id,title,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(cid, user.id, title, 'auto', now(), now());
  const userMessage = crypto.randomUUID();
  db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)')
    .run(userMessage, cid, 'user', `${title}?`, now());
  db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), cid, 'assistant', `The answer to "${title}", at length.`, now());
  if (i === 0) {
    db.prepare('INSERT INTO jsan_message_images(id,message_id,name,mime,data,created_at) VALUES(?,?,?,?,?,?)')
      .run(crypto.randomUUID(), userMessage, 'screenshot.png', 'image/png', 'data:image/png;base64,iVBORw0KGgo=', now());
  }
  return cid;
});
conversationsFor(priya, ['The retry loop in the ingest worker', 'Seat count after a restart', 'Access code migration']);
conversationsFor(vikram, ['Why the build is slow', 'A question about the gateway']);

// What has to come through the upgrade unchanged.
const TABLES = ['jsan_schema_meta', 'jsan_users', 'jsan_conversations', 'jsan_messages', 'jsan_message_images',
  'jsan_login_attempts', 'jsan_access_codes', 'jsan_access_code_redemptions'];
const fingerprint = {};
for (const table of TABLES) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  const stable = rows.map(r => JSON.stringify(r, Object.keys(r).sort())).sort();
  fingerprint[table] = { rows: rows.length, digest: crypto.createHash('sha256').update(stable.join('\n')).digest('hex') };
}

// Down to version 5: the two tables version 6 adds, and the marker itself.
// This is what a database written by the previous release actually looks like.
db.exec('DROP TABLE IF EXISTS jsan_password_resets');
db.exec('DROP TABLE IF EXISTS jsan_disabled_users');
db.prepare("UPDATE jsan_schema_meta SET value='5' WHERE key='schema_version'").run();
fingerprint.jsan_schema_meta = (() => {
  const rows = db.prepare('SELECT * FROM jsan_schema_meta').all();
  const stable = rows.map(r => JSON.stringify(r, Object.keys(r).sort())).sort();
  return { rows: rows.length, digest: crypto.createHash('sha256').update(stable.join('\n')).digest('hex') };
})();
fingerprint._accounts = people.map(p => ({ email: p.email, password: p.password }));
fingerprint._userIds = { priya: priya.id, vikram: vikram.id };
db.close();

fs.writeFileSync(FINGERPRINT, JSON.stringify(fingerprint, null, 2));
console.log(`legacy database written: ${DB}`);
process.exit(0);
