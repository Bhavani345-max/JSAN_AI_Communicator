// JSAN Dev AI - the shared registration code, end to end.
//
//   npm run test:shared      (from portal/backend)
//
// The other half of test/access-codes.mjs: a deployment that still sets
// REGISTRATION_ACCESS_CODE must register developers exactly as it did before
// issued codes existed, and must accept both kinds side by side. Also covers
// the ADMIN_EMAILS fallback to the first seed account.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert'; import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsan-e2e2-'));
const PORT = 8098; const BASE = `http://127.0.0.1:${PORT}`;
process.env.NODE_ENV='test'; process.env.PORT=String(PORT);
process.env.SQLITE_PATH=path.join(dir,'e2e.db');
process.env.JWT_SECRET=crypto.randomBytes(32).toString('hex');
process.env.KEY_ENCRYPTION_SECRET=crypto.randomBytes(32).toString('hex');
process.env.LITELLM_MASTER_KEY='sk-test-master';
process.env.LITELLM_BASE_URL='http://litellm.test';
process.env.REGISTRATION_ACCESS_CODE='shared-team-code-2026';
process.env.ALLOWED_EMAIL_DOMAIN='jsan.com';
process.env.MAX_USERS='20';
process.env.ADMIN_EMAILS='';
process.env.SEED_ACCOUNTS=JSON.stringify([{name:'Admin',email:'boss@jsan.com',password:'bosspass1234'}]);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!target.startsWith(process.env.LITELLM_BASE_URL)) return realFetch(url, options);
  const route = target.slice(process.env.LITELLM_BASE_URL.length).split('?')[0];
  const reply = (b) => new Response(JSON.stringify(b), {status:200, headers:{'Content-Type':'application/json'}});
  if (route === '/user/new') return reply({ user_id: JSON.parse(options.body).user_id });
  if (route === '/key/generate') return reply({ key: `sk-${crypto.randomUUID()}` });
  if (route === '/user/list') return reply({ users: [] });
  return reply({ ok: true });
};

function client(){ let cookie='';
  return async (method, route, body) => {
    const res = await realFetch(`${BASE}${route}`, { method,
      headers:{...(body?{'Content-Type':'application/json'}:{}) ,...(cookie?{Cookie:cookie}:{})},
      ...(body?{body:JSON.stringify(body)}:{}) });
    for (const line of res.headers.getSetCookie?.()||[]) { const p=line.split(';')[0]; if(p.startsWith('jsan_session=')) cookie=p; }
    const text = await res.text(); let data; try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    return { status: res.status, data };
  };
}
const passed=[],failed=[];
async function check(name,fn){ try{ await fn(); passed.push(name);}catch(e){failed.push(`${name}: ${e.message}`);} }

await import('../src/server.js');
for(let i=0;i<60;i++){ try{ await realFetch(`${BASE}/api/health`); break;}catch{ await new Promise(r=>setTimeout(r,200)); } }
await new Promise(r=>setTimeout(r,1200));

await check('the shared environment code still registers a developer', async () => {
  const { status, data } = await client()('POST','/api/auth/register',
    {name:'Old Way',email:'oldway@jsan.com',password:'oldwaypass12',confirmPassword:'oldwaypass12',accessCode:'shared-team-code-2026'});
  assert.equal(status,201,JSON.stringify(data));
});

await check('the shared code is matched verbatim, not normalized', async () => {
  const { status } = await client()('POST','/api/auth/register',
    {name:'Loud',email:'loud@jsan.com',password:'loudpass1234',confirmPassword:'loudpass1234',accessCode:'SHARED-TEAM-CODE-2026'});
  assert.equal(status,403,'a case-folded shared code was accepted');
});

await check('ADMIN_EMAILS falls back to the first seed account', async () => {
  const boss = client();
  const login = await boss('POST','/api/auth/login',{email:'boss@jsan.com',password:'bosspass1234'});
  assert.equal(login.data.user.isAdmin, true, 'the seeded owner is not an admin');
  const overview = await boss('GET','/api/admin/overview');
  assert.equal(overview.status,200);
  assert.equal(overview.data.sharedCodeEnabled, true);
  assert.deepEqual(overview.data.admins, ['boss@jsan.com']);
});

await check('an issued code works alongside the shared one', async () => {
  const boss = client();
  await boss('POST','/api/auth/login',{email:'boss@jsan.com',password:'bosspass1234'});
  const issued = await boss('POST','/api/admin/access-codes',{label:'Both ways',assignedEmail:'mix@jsan.com'});
  assert.equal(issued.status,201,JSON.stringify(issued.data));
  const reg = await client()('POST','/api/auth/register',
    {name:'Mix',email:'mix@jsan.com',password:'mixpass12345',confirmPassword:'mixpass12345',accessCode:issued.data.code});
  assert.equal(reg.status,201,JSON.stringify(reg.data));
});

for(const n of passed) console.log(`  PASS  ${n}`);
for(const n of failed) console.log(`  FAIL  ${n}`);
console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length?1:0);
