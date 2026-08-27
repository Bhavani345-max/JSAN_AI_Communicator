import dotenv from 'dotenv';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { connect, transaction, nowIso, databasePath } from '@jsan/database';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { createDocumentRoutes } from './documents/routes.js';

// Resolve .env from this file's location rather than the working directory, so
// the server loads the same configuration whether it is started from portal/,
// from portal/backend/ (`npm start`) or from /app in the container. Earlier
// paths win; missing files are skipped, as happens on Railway where the
// platform injects the variables directly.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: [path.resolve(__dirname, '../.env'), path.resolve(__dirname, '../../.env')],
  quiet: true
});

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = requireSecret('JWT_SECRET');
const KEY_ENCRYPTION_SECRET = requireSecret('KEY_ENCRYPTION_SECRET');
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 12));
const MAX_USERS = Math.min(100, Math.max(1, Number(process.env.MAX_USERS || 20)));
// The one code every developer types, shared by the whole team.
//
// No longer required, because it is no longer the only way in: an admin can
// issue a code per person from the Admin page, and those are checked against
// jsan_access_codes. Leave this unset and an issued code becomes the only way
// to claim a seat, which is what makes a code withdrawable from one developer
// without withdrawing it from everybody. Set, it keeps working exactly as it
// did, so a deployment that has already handed it out is not broken by this.
const REGISTRATION_ACCESS_CODE = optionalSecret('REGISTRATION_ACCESS_CODE');
const ALLOWED_EMAIL_DOMAIN = String(process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
const LITELLM_BASE_URL = String(process.env.LITELLM_BASE_URL || 'http://litellm:4000').replace(/\/$/, '');
const LITELLM_MASTER_KEY = requireSecret('LITELLM_MASTER_KEY');
// The four modes a developer picks in the composer.
const DEV_MODELS = ['auto', 'code', 'think', 'fast'];
// Not a fifth mode: the four above are text-in, text-out and cannot be handed a
// screenshot at all, so the portal switches to this by itself for any question
// that carries an image. Developers never select it, but their virtual keys
// have to allow it, which is what KEY_MODELS is for.
const VISION_MODEL = 'see';
const KEY_MODELS = [...DEV_MODELS, VISION_MODEL];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 1_500_000;
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// How far back a conversation keeps resending its images. An image costs far
// more context than the words around it and the free vision models have the
// smallest windows on the roster, so only the last few messages carry theirs -
// which also lets a conversation drop back to the chosen text mode once the
// screenshots stop being the subject.
const IMAGE_LOOKBACK_MESSAGES = 6;
// Answer shape.
//
// The earlier version of this asked the model to "state important assumptions",
// which it read as a standing instruction: every reply came back with an
// assumptions block, a list of clarifying questions and an offer of further
// help, whatever was asked. A two-word question was answered in 1,900
// characters. What follows is written to stop that padding specifically.
const SYSTEM_PROMPT = `You are JSAN Dev AI, a senior software engineering copilot.

Answer the question that was asked, at the length it deserves - a one-line question gets a one-line answer. Open with the answer itself: no preamble, no restating the question back, no announcing what you are about to do.

Never pad a reply with sections nobody asked for. No standing assumptions block, no list of clarifying questions attached to an answer you have already given, no closing offer of further help. Where a single assumption genuinely changes the answer, say it in one sentence at the point it matters. Where a request is broad or ambiguous, answer its most likely reading rather than asking which one was meant; ask a single question only when no useful answer is possible without it.

For code work, prioritize correctness, security, maintainability and verifiable next steps. Never claim to have run or inspected something you have not. Prefer focused changes over unnecessary rewrites.`;
const DEV_MONTHLY_BUDGET = Number(process.env.DEVELOPER_MONTHLY_BUDGET_USD || 0);
const DEV_RPM_LIMIT = Number(process.env.DEVELOPER_RPM_LIMIT || 0);
const DEV_TPM_LIMIT = Number(process.env.DEVELOPER_TPM_LIMIT || 0);
// Failed sign-in policy. LOGIN_MAX_ATTEMPTS wrong passwords lock the address
// for LOGIN_LOCKOUT_MINUTES, counted in the database rather than in memory so
// the lockout outlives a restart.
const LOGIN_MAX_ATTEMPTS = Math.max(1, Number(process.env.LOGIN_MAX_ATTEMPTS || 3));
const LOGIN_LOCKOUT_MINUTES = Math.max(1, Number(process.env.LOGIN_LOCKOUT_MINUTES || 30));

// Accounts that must exist on every run.
//
// Registering through the form is how a developer gets a seat, but it is a
// one-time act against whichever database happened to be mounted at the time.
// Reset the file, deploy without a volume, or start on a second machine and the
// account is gone with it. The accounts this portal is operated with cannot
// depend on that, so they are declared as configuration and reconciled at boot
// rather than typed into the form once and hoped for.
//
// SEED_ACCOUNTS is a JSON array of {name, email, password}. Seeding does not go
// through /api/auth/register and so is not subject to the access code or
// ALLOWED_EMAIL_DOMAIN: both exist to control who may claim a seat from
// outside, and this list is the operator stating who already holds one. The
// accounts do still occupy seats once created, so MAX_USERS closes public
// registration that much earlier, which is the intended reading of the cap.
const SEED_ACCOUNTS = parseSeedAccounts(process.env.SEED_ACCOUNTS);

// Who may open the Admin page and issue team access codes.
//
// A comma-separated list of addresses rather than a column on jsan_users:
// being an admin is an operator decision, and keeping it in configuration
// means it is granted or withdrawn by editing one variable, takes effect on
// the next request, and cannot be escalated by anything the portal itself
// writes - there is no route that can make an account an admin.
//
// Unset, it falls back to the first SEED_ACCOUNTS entry: the account the
// operator has already declared as their own, so a deployment that set up seed
// accounts and nothing else still has somebody who can issue codes. With
// neither configured there are no admins, and REGISTRATION_ACCESS_CODE is the
// only way anyone registers - which is exactly how the portal behaved before
// issued codes existed.
const ADMIN_EMAILS = parseAdminEmails(process.env.ADMIN_EMAILS);

// Chat streaming budgets.
//
// A single wall-clock deadline cannot serve both cases here: a real engineering
// answer from a reasoning model runs for minutes, while a gateway that has
// stopped responding must not hold the browser open. So the deadline that
// matters is the idle one — silence on the wire — and the total is only a
// backstop against a stream that dribbles forever.
//
// CHAT_IDLE_TIMEOUT_MS is generous because these models think before they emit:
// the first token can legitimately be a minute away while the model reasons.
const CHAT_IDLE_TIMEOUT_MS = 120 * 1000;
const CHAT_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
// SSE comment sent while the model is quiet, so proxies between the browser and
// this process see traffic and do not close an idle connection.
const CHAT_HEARTBEAT_MS = 15 * 1000;

// Per-turn gateway telemetry: which deployment answered, how many tokens it
// cost, and whether the router had to retry or fall back to get it.
//
// The staged concurrency report asks for token usage, provider distribution and
// a fallback count. None of those are visible from the portal side: a turn that
// Cerebras rate-limited and OpenRouter then served looks identical to one
// Cerebras answered first time. LiteLLM knows which it was; this asks it.
//
// Off by way of a single variable, because it touches the chat hot path and the
// answer matters more than the measurement. With CHAT_TELEMETRY=off the request
// body and the `done` payload are exactly what they were before this existed -
// no stream_options is sent and no telemetry key is emitted - so turning it off
// is a true revert without a deploy. Anything other than off/0/false/no leaves
// it on, so a typo measures rather than silently stops measuring.
const CHAT_TELEMETRY = !/^(off|0|false|no)$/i.test(String(process.env.CHAT_TELEMETRY ?? '').trim());

// One SQLite handle for the whole process. connect() applies the pragmas the
// schema depends on - foreign_keys above all, without which ON DELETE CASCADE
// silently does nothing - and creates the tables when the file is new, so there
// is no separate migration step at boot.
const db = connect();

function requireSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value || value.includes('change-me')) throw new Error(`${name} must be configured`);
  return value;
}

/**
 * The same read as requireSecret, for a secret the portal can run without.
 *
 * A placeholder is treated as absent rather than accepted: `change-me` left in
 * an environment file is somebody who has not chosen a value yet, and honouring
 * it as a real registration code would let anyone who has read the example file
 * claim a seat.
 */
function optionalSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) return '';
  if (value.includes('change-me')) {
    console.warn(`${name} still holds a placeholder value and is being ignored`);
    return '';
  }
  return value;
}

/** The admin address list, lowercased, with the documented fallback applied. */
function parseAdminEmails(raw) {
  const listed = String(raw || '')
    .split(/[,;\s]+/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (listed.length) return new Set(listed);
  const fallback = SEED_ACCOUNTS[0]?.email;
  if (fallback) console.log(`ADMIN_EMAILS is not set - the first seed account (${fallback}) is the admin`);
  else console.log('ADMIN_EMAILS is not set and there are no seed accounts - no account can issue access codes');
  return new Set(fallback ? [fallback] : []);
}

/**
 * Read and validate SEED_ACCOUNTS. Throws rather than skipping a malformed
 * entry: a seeded account that silently fails to appear looks exactly like a
 * forgotten password to whoever tries to sign in with it, and the portal
 * already refuses to boot on unusable configuration (see requireSecret).
 */
function parseSeedAccounts(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let entries;
  try { entries = JSON.parse(text); }
  catch { throw new Error('SEED_ACCOUNTS must be a JSON array of {name, email, password}'); }
  if (!Array.isArray(entries)) throw new Error('SEED_ACCOUNTS must be a JSON array of {name, email, password}');
  const seen = new Set();
  return entries.map((entry, index) => {
    const at = `SEED_ACCOUNTS[${index}]`;
    const name = String(entry?.name || '').trim();
    const email = String(entry?.email || '').trim().toLowerCase();
    const password = String(entry?.password || '');
    if (name.length < 2 || name.length > 80) throw new Error(`${at} needs a name`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${at} needs a valid email`);
    // The floor the registration form enforces, applied here too so a declared
    // account is never weaker than one somebody signed up for.
    if (password.length < 10) throw new Error(`${at} needs a password of at least 10 characters`);
    if (seen.has(email)) throw new Error(`${at} repeats ${email}`);
    seen.add(email);
    return { name, email, password };
  });
}

app.use(cookieParser());
// Attached images arrive base64-encoded inside the JSON body, which is a third
// larger than the files themselves; MAX_IMAGES * MAX_IMAGE_BYTES has to fit.
app.use(express.json({ limit: '25mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Rate limiting.
//
// A whole team typically shares one public IP, so limits keyed only on IP are
// consumed by the group rather than the individual: 20 developers behind one
// office NAT would share a single 30-requests-per-minute chat allowance, and
// onboarding the team would stop after the tenth registration.
//
// Anything that runs after authentication is therefore keyed on the user id.
// Unauthenticated routes stay keyed on IP — that is what makes them useful
// against brute force — but are sized for a shared network. The per-account
// control on login is not here at all: it is a durable lockout, described
// where it is enforced.
const byIp = (req) => ipKeyGenerator(req.ip);

// Chat: per developer. `auth` runs before this limiter, so req.user is set.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? byIp(req),
  message: { error: 'You are sending messages too quickly. Wait a moment and try again.' }
});

// Documents: per developer, like chat. A conversion is a PDF parse plus a
// model call, so it costs far more than a chat turn and is allowed
// correspondingly less often.
const documentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? byIp(req),
  message: { error: 'Too many conversions in a row. Wait a few minutes and try again.' }
});

// Login, per account: deliberately not a rate limiter. A fixed number of tries
// followed by a fixed cool-off is a lockout, and this store keeps its counters
// in memory — a restart, or a Railway deploy mid-attack, would hand the
// allowance straight back. It is enforced against jsan_login_attempts instead;
// see LOGIN_MAX_ATTEMPTS and the login route.

// Login, per network. Sized so a full office can sign in each morning, while
// still capping credential stuffing spread across many accounts.
const loginIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  message: { error: 'Too many sign-in attempts from this network. Try again shortly.' }
});

// Registration: per network, sized so the whole team can onboard in one
// sitting. The access code and the seat cap are the real controls here; this
// limit only exists to slow down guessing at the code.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  message: { error: 'Too many registration attempts from this network. Try again later.' }
});

// Password resets: per network, like registration, and for the same reason -
// the code is the control, and this only slows down guessing at one. Sized well
// below registration because a reset is a rarer event than onboarding a team.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  message: { error: 'Too many reset attempts from this network. Try again later.' }
});

// Changing your own password: per account, not per network. The session says
// who this is, so the network is the wrong thing to count - and the guessing
// this slows down is somebody at an unlocked desk trying the current password,
// which is a per-account attack. Sized so a genuine mistyped attempt or three
// never gets in the way.
const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? byIp(req),
  message: { error: 'Too many password changes attempted. Try again later.' }
});

// Fair use: how many model calls one developer may have running at once.
//
// The rate limiters above cap how often a turn may *start*; neither caps how
// many are in flight. A coding agent looping on /v1 opens requests faster than
// they finish, so a per-minute count lets one session hold every upstream slot
// the shared provider quota allows. This bounds that without touching the
// per-minute allowance a person working normally actually uses - two at once
// covers a developer chatting while their agent works.
// Number() first, then `|| 2`: a typo'd value parses to NaN, and NaN inside the
// clamp would survive into the comparison below, where `running >= NaN` is
// false for every request - silently removing the protection instead of
// applying it. Falling back to the default keeps a misconfigured deployment
// limited rather than unlimited. floor() keeps a fractional value from
// producing an off-by-one allowance.
const MAX_CONCURRENT_PER_USER = Math.max(1, Math.floor(Number(process.env.MAX_CONCURRENT_REQUESTS_PER_USER) || 2));
const inFlight = new Map();

/**
 * Hold a concurrency slot for the life of the response.
 *
 * The slot is released on the response's `close` event rather than in the
 * route body: `close` fires once the response finishes *and* when the socket
 * is destroyed under a half-written stream, so a developer who closes the tab
 * mid-answer gets their slot back. Releasing inside the handler would miss
 * that case and leak the slot until restart.
 *
 * Rejection happens before any route sets streaming headers, so it is still a
 * plain JSON 429 with a real status code rather than an SSE error frame.
 */
function limitConcurrency(identify) {
  return (req, res, next) => {
    const id = identify(req);
    if (!id) return next();
    const running = inFlight.get(id) || 0;
    if (running >= MAX_CONCURRENT_PER_USER) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({
        error: `You already have ${running} requests running. Wait for one to finish, then try again.`,
        code: 'concurrency_limit',
        limit: MAX_CONCURRENT_PER_USER
      });
    }
    inFlight.set(id, running + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (inFlight.get(id) || 1) - 1;
      if (left > 0) inFlight.set(id, left); else inFlight.delete(id);
    };
    res.on('close', release);
    next();
  };
}

// Chat and document routes run after `auth`, so the developer's row is known.
const byUser = limitConcurrency((req) => req.user?.id || null);

// The /v1 edge is deliberately unauthenticated here - it forwards the
// developer's virtual key to LiteLLM, which is what authenticates it. The key
// is therefore the only stable identity available, so slots are counted
// against a hash of it. Hashing keeps the plaintext key out of process memory
// maps and out of anything that might later be dumped or logged.
const byApiKey = limitConcurrency((req) => {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
});

function encryptionKey() {
  return crypto.createHash('sha256').update(KEY_ENCRYPTION_SECRET).digest();
}
function encryptText(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decryptText({ ciphertext, iv, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
function decryptKey(row) {
  return decryptText({ ciphertext: row.litellm_key_ciphertext, iv: row.litellm_key_iv, tag: row.litellm_key_tag });
}

function createSession(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h`, issuer: 'jsan-dev-ai' });
}
function setSessionCookie(res, token) {
  res.cookie('jsan_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
    path: '/'
  });
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

// ---------------------------------------------------------------------------
// Team access codes
//
// One code, one developer. An admin generates a code in the portal, hands it to
// the person it was cut for, and it stops working once they have used it - so a
// seat can be withdrawn from one developer without changing anything for the
// rest, which the single shared REGISTRATION_ACCESS_CODE could never do.
// ---------------------------------------------------------------------------

// Codes get read out over a call, typed by hand and pasted into chat, so the
// alphabet leaves out every pair that gets mistaken for the other: no O or 0,
// no I, L or 1. 31 symbols over 15 positions is about 74 bits, which is far
// past anything the registration rate limit would let through.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_SIZE = 5;
// Bounds on what an admin may ask for. A code for one person is the default;
// the upper bound exists so a slip in the form cannot mint an open invitation.
const CODE_MAX_USES_LIMIT = 20;
const CODE_MAX_EXPIRY_DAYS = 365;
const CODE_DEFAULT_EXPIRY_DAYS = 14;

const CODE_INVALID = 'The team access code is not valid';
const CODE_REFUSALS = {
  revoked: 'That access code has been withdrawn. Ask your JSAN admin for a new one.',
  expired: 'That access code has expired. Ask your JSAN admin for a new one.',
  used: 'That access code has already been used. Ask your JSAN admin for a new one.',
  wrongEmail: 'That access code was issued for a different email address.'
};

/** A fresh code, in the PREFIX-XXXXX-XXXXX-XXXXX shape the admin page shows. */
function newCode(prefix) {
  const groups = [];
  for (let group = 0; group < CODE_GROUPS; group++) {
    let text = '';
    // randomInt is rejection-sampled, so no symbol in the alphabet is likelier
    // than another - which `randomBytes(1) % 31` would not give.
    for (let i = 0; i < CODE_GROUP_SIZE; i++) text += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    groups.push(text);
  }
  return `${prefix}-${groups.join('-')}`;
}

/** A code that admits somebody to a seat. */
const newAccessCode = () => newCode('JSAN');

// A reset code carries the same 74 bits, under a prefix nobody can mistake for
// a seat invitation: the two arrive by the same channel, are typed into forms
// on the same card, and doing the wrong one with the wrong code should read as
// an obvious mistake rather than a puzzling refusal.
const newResetCode = () => newCode('RESET');
// Short by design. A reset is a live credential for one account that somebody
// is waiting on, not an invitation left open for a fortnight.
const RESET_EXPIRY_HOURS = 24;

/**
 * The form a code is matched in.
 *
 * Somebody typing a code out of an email will lowercase it, drop the dashes or
 * paste it with a trailing space, and none of those are a different code. The
 * separators carry no information - they are there to make 15 characters
 * readable - so they are removed before hashing rather than demanded back.
 */
function normalizeAccessCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Lookup key for a code, or null when nothing usable was submitted. */
function accessCodeDigest(value) {
  const normalized = normalizeAccessCode(value);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Enough of a code to recognise it in a list, without handing it back. */
function accessCodeHint(code) {
  return `${code.slice(0, 4)}…${code.slice(-4)}`;
}

/** active | used | expired | revoked. The order matters: revoked wins. */
function accessCodeStatus(row, now = Date.now()) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && Date.parse(row.expires_at) <= now) return 'expired';
  if (row.uses >= row.max_uses) return 'used';
  return 'active';
}

/**
 * The admin page's view of a code, the plaintext code included.
 *
 * An admin has to be able to answer "what is this developer's code?" months
 * after issuing it - somebody loses the email, or joins a call asking to be let
 * in again - so the code is decrypted for every row rather than one at a time
 * behind a button. That is only ever sent to a signed-in admin, and the page
 * has a control to blank them all out for screen sharing.
 *
 * `code` is null and `readable` false where the row cannot be decrypted, which
 * in practice means KEY_ENCRYPTION_SECRET was rotated after it was issued. The
 * code still works for whoever holds it - registration matches on the hash,
 * which is untouched - so this is reported rather than treated as a failure.
 */
function serializeAccessCode(row) {
  const status = accessCodeStatus(row);
  let code = null;
  try { code = decryptText({ ciphertext: row.code_ciphertext, iv: row.code_iv, tag: row.code_tag }); }
  catch { code = null; }
  return {
    id: row.id,
    code,
    readable: code !== null,
    hint: row.code_hint,
    label: row.label || '',
    assignedEmail: row.assigned_email || null,
    maxUses: row.max_uses,
    uses: row.uses,
    remaining: Math.max(0, row.max_uses - row.uses),
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    lastUsedAt: row.last_used_at || null,
    lastUsedBy: row.last_used_by || null,
    createdByEmail: row.created_by_email || null
  };
}

/**
 * Decide whether a submitted code admits this address.
 *
 * Returns `{ ok: true, code }` where `code` is the row to spend, or null when
 * the shared environment code was used and there is no row to spend. A refusal
 * carries the sentence the person will read.
 *
 * Read-only on purpose: nothing is consumed here. The code is spent inside the
 * registration transaction, so a signup that fails afterwards - a full portal,
 * a duplicate address - leaves the code still usable.
 */
function checkAccessCode(submitted, email) {
  // The shared code is an arbitrary secret rather than one of the issued ones,
  // so it is compared verbatim and in constant time, not normalized.
  if (REGISTRATION_ACCESS_CODE && safeEqual(submitted, REGISTRATION_ACCESS_CODE)) return { ok: true, code: null };
  const digest = accessCodeDigest(submitted);
  if (!digest) return { ok: false, error: CODE_INVALID };
  const row = db.prepare('SELECT * FROM jsan_access_codes WHERE code_hash=?').get(digest);
  if (!row) return { ok: false, error: CODE_INVALID };
  const status = accessCodeStatus(row);
  if (status !== 'active') return { ok: false, error: CODE_REFUSALS[status] };
  if (row.assigned_email && row.assigned_email.toLowerCase() !== email) {
    return { ok: false, error: CODE_REFUSALS.wrongEmail };
  }
  return { ok: true, code: row };
}

/** Is this signed-in account allowed to issue codes? */
function isAdmin(user) {
  return !!user && ADMIN_EMAILS.has(String(user.email || '').toLowerCase());
}

// ---------------------------------------------------------------------------
// Seats
//
// A disabled account keeps its row, its conversations and its messages, and
// gives up only the two things a departure is actually about: the seat, and the
// gateway key. So every question of the form "how many seats are in use?" has
// to ask about accounts that are not disabled, never about rows in jsan_users.
// ---------------------------------------------------------------------------

/** Accounts holding a seat right now. */
function activeUserCount() {
  return db.prepare(`SELECT COUNT(*) AS count FROM jsan_users u
    WHERE NOT EXISTS (SELECT 1 FROM jsan_disabled_users d WHERE d.user_id = u.id)`).get().count;
}

/** The deactivation record for an account, or null while it holds a seat. */
function disabledRecord(userId) {
  return db.prepare('SELECT * FROM jsan_disabled_users WHERE user_id=?').get(userId) || null;
}

/**
 * Why this account may not be deactivated, or null when it may.
 *
 * Admins are refused outright. Deactivating the account you are signed in as
 * would close the Admin page behind you with no route back, and deactivating
 * another admin lets two people lock each other out of the only page that can
 * undo it. Taking the address out of ADMIN_EMAILS first is the deliberate act
 * that makes it possible.
 */
function deactivationProblem(user) {
  if (isAdmin(user)) {
    return 'This is an admin account. Remove the address from ADMIN_EMAILS first, then deactivate it.';
  }
  return null;
}

/**
 * Why this account's password cannot be reset here, or null when it can.
 *
 * A seeded account's password is configuration: ensureSeedAccounts puts it back
 * at every boot, so a reset would hold only until the next deploy and then
 * silently undo itself. Refusing says so, which is more use than a reset that
 * appears to work.
 */
function passwordResetProblem(user) {
  const seeded = SEED_ACCOUNTS.some(account => account.email === String(user.email).toLowerCase());
  if (seeded) {
    return 'This account\'s password is set in SEED_ACCOUNTS and is reapplied at every restart. Change it there instead.';
  }
  return null;
}

/** The live reset for an account, or null. Expiry is judged on read. */
function livePasswordReset(userId, now = Date.now()) {
  const row = db.prepare(`SELECT * FROM jsan_password_resets
    WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1`).get(userId);
  if (!row) return null;
  return Date.parse(row.expires_at) > now ? row : null;
}

/** The admin page's view of a reset. Carries the code, as the code list does. */
function serializePasswordReset(row) {
  let code = null;
  try { code = decryptText({ ciphertext: row.code_ciphertext, iv: row.code_iv, tag: row.code_tag }); }
  catch { code = null; }
  return {
    id: row.id,
    code,
    readable: code !== null,
    hint: row.code_hint,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}
// A shared daily allowance that is spent behaves nothing like a momentary burst
// limit: no amount of retrying clears it. Telling someone to "try again in a
// moment" for hours is what makes a working portal look broken, so it is
// recognised separately.
const DAILY_LIMIT = /free-models-per-day|free_tier_daily|per-?day|daily limit/i;

/** The provider often says when the allowance resets; pass that on verbatim. */
function dailyResetNote(raw) {
  const stamp = /"X-RateLimit-Reset"\s*:\s*"?(\d{10,})"?/.exec(raw);
  if (!stamp) return '';
  const when = new Date(Number(stamp[1]));
  if (Number.isNaN(when.getTime())) return '';
  return ` It resets at ${when.toISOString().replace('T', ' ').slice(0, 16)} UTC.`;
}

function cleanError(error, fallback = 'Something went wrong') {
  const raw = String(error?.message || error || '');
  if (DAILY_LIMIT.test(raw)) {
    return `This workspace has used up its shared daily AI allowance.${dailyResetNote(raw)} Retrying will not help until then - contact the platform owner if the team needs more.`;
  }
  if (/budget/i.test(raw)) return 'Your AI usage limit has been reached. Contact the platform owner if you need more access.';
  if (/rate.?limit|429/i.test(raw)) return 'AI is busy right now. Try again in a moment.';
  // What LiteLLM says once it has cooled a failing model down. Left generic on
  // purpose: the underlying cause is already reported above on the first hit.
  if (/no deployments available/i.test(raw)) return 'AI is briefly unavailable while the gateway backs off from repeated provider errors. Try again in a minute.';
  if (/authentication|api.?key|401|403/i.test(raw)) return 'AI access needs attention. Please contact the platform owner.';
  return fallback;
}

async function litellmFetch(endpoint, { method = 'GET', body, key = LITELLM_MASTER_KEY, timeout = 20000 } = {}) {
  const response = await fetch(`${LITELLM_BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.detail?.error || data?.detail || data?.error?.message || data?.message || text || `LiteLLM ${response.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return data;
}

/** The user id LiteLLM already holds for an address. */
async function findLiteLLMUserId(email) {
  const found = await litellmFetch(`/user/list?user_email=${encodeURIComponent(email)}`);
  const match = (found?.users || []).find((u) => String(u?.user_email || '').toLowerCase() === email);
  if (!match?.user_id) throw new Error(`LiteLLM reports ${email} already exists but did not return its user id`);
  return match.user_id;
}

// LiteLLM keeps its own database, and it is not the portal's. On Railway it is
// a managed Postgres that outlives the SQLite volume; locally it is a container
// volume that outlives the file. So an account this portal has no row for can
// still be present upstream — after a database reset, a redeploy onto an empty
// volume, or a seeded account arriving on a fresh machine — and both halves of
// provisioning refuse it: /user/new rejects the duplicate email, and
// /key/generate rejects the duplicate alias, which LiteLLM requires to be
// unique across every key it holds. Neither is a reason to fail, because what
// actually grants access is the key, and a new one is issued either way.
/**
 * One non-streaming call to the gateway, on a developer's own virtual key.
 *
 * /api/chat streams because somebody is watching the answer arrive. The deck
 * planner is not: it waits on a single JSON object and has nothing to show
 * until that object is complete, so it wants the whole reply or an error.
 */
/**
 * Start a telemetry record from a gateway response's headers.
 *
 * LiteLLM reports what the router did in response headers rather than in the
 * body, and they are the only place a retry or a fallback is visible at all -
 * the stream itself looks the same either way. The model and token counts
 * arrive later, inside the stream, so they start null and are filled in by
 * readStreamTelemetry as the frames go past.
 *
 * `modelId` is an opaque deployment hash, not a model name, and `model` on the
 * stream is the mode the caller asked for - "fast", not the model behind it.
 * Neither names a provider on its own. GET /v1/model/info maps the hash to the
 * provider/model string and accepts a developer virtual key, which is where
 * scripts/load-test.mjs resolves it. Deliberately not resolved here: it would
 * put a gateway round trip and a cache in the chat path to label something no
 * developer is shown.
 *
 * Absent headers stay null rather than becoming 0. `Number(null)` is 0 and
 * finite, so a naive read would report "0 fallbacks" for a gateway that never
 * said - which reads as a measurement rather than a gap, and would make the
 * report claim the router never fell back when in truth nobody asked it.
 * Header names are not guaranteed across LiteLLM versions, so treat a null as
 * "not reported" and confirm against the gateway before trusting a zero.
 */
function gatewayTelemetry(response) {
  const text = (name) => response.headers.get(name) || null;
  const count = (name) => {
    const raw = response.headers.get(name);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    model: null,
    usage: null,
    modelId: text('x-litellm-model-id'),
    modelGroup: text('x-litellm-model-group'),
    callId: text('x-litellm-call-id'),
    attemptedRetries: count('x-litellm-attempted-retries'),
    attemptedFallbacks: count('x-litellm-attempted-fallbacks')
  };
}

/**
 * Fold one streamed frame into the telemetry record.
 *
 * Deliberately total: it reads, never throws, and never touches the answer.
 * A malformed usage block or a missing model must not be able to fail a turn
 * that the developer is already watching arrive.
 */
function readStreamTelemetry(telemetry, frame) {
  if (!telemetry || !frame) return;
  // First non-empty wins. Every frame repeats it, and the first is the one that
  // answered - a later frame cannot mean a different deployment took over
  // mid-stream, because a fallback restarts the stream rather than continuing it.
  if (!telemetry.model && frame.model) telemetry.model = String(frame.model);
  const usage = frame.usage;
  if (usage && typeof usage === 'object') {
    telemetry.usage = {
      promptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
      completionTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
      totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null
    };
  }
}

async function callModel({ key, model, messages, user, timeout = 120000 }) {
  const upstream = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, ...(user ? { user } : {}) }),
    signal: AbortSignal.timeout(timeout)
  });
  const raw = await upstream.text();
  let data; try { data = JSON.parse(raw); } catch { data = {}; }
  if (!upstream.ok) throw new Error(data?.error?.message || data?.detail?.error || raw.slice(0, 500));
  return data.choices?.[0]?.message?.content || '';
}

async function provisionLiteLLMUser({ id, name, email }) {
  const keyAlias = `jsan-${email}`;
  let litellmUserId = id;
  try {
    const userResult = await litellmFetch('/user/new', {
      method: 'POST',
      body: { user_id: id, user_email: email, user_alias: name, user_role: 'internal_user' }
    });
    litellmUserId = userResult?.user_id || id;
  } catch (e) {
    if (!/already exists/i.test(String(e.message))) throw e;
    litellmUserId = await findLiteLLMUserId(email);
    console.log(`Adopted the LiteLLM user already registered for ${email}`);
  }

  const keyBody = {
    user_id: litellmUserId,
    key_alias: keyAlias,
    models: KEY_MODELS,
    metadata: { app: 'jsan-dev-ai', email }
  };
  if (DEV_MONTHLY_BUDGET > 0) {
    keyBody.max_budget = DEV_MONTHLY_BUDGET;
    keyBody.budget_duration = '30d';
  }
  if (DEV_RPM_LIMIT > 0) keyBody.rpm_limit = DEV_RPM_LIMIT;
  if (DEV_TPM_LIMIT > 0) keyBody.tpm_limit = DEV_TPM_LIMIT;

  let keyResult;
  try {
    keyResult = await litellmFetch('/key/generate', { method: 'POST', body: keyBody });
  } catch (e) {
    if (!/alias.*already exists/i.test(String(e.message))) throw e;
    // The key issued for this address last time still holds the alias. It can
    // never be handed back - its plaintext lived only in the row that is gone,
    // and the portal stores nothing it can decrypt any more - so retire it and
    // issue a fresh one. That is what /api/me/api-key/rotate does to a key it
    // is replacing, and it leaves one live key per account either way.
    await litellmFetch('/key/delete', { method: 'POST', body: { key_aliases: [keyAlias] } });
    console.log(`Retired the unreachable key previously issued to ${email}`);
    keyResult = await litellmFetch('/key/generate', { method: 'POST', body: keyBody });
  }
  const key = keyResult?.key || keyResult?.token;
  if (!key) throw new Error('LiteLLM did not return a virtual key');
  return { litellmUserId, key };
}

// Retire a virtual key that was issued for an account that then failed to be
// created. Without this the key keeps working while no portal account owns it.
// Failures are logged rather than raised: the caller is already reporting a
// more useful error to the developer.
async function revokeLiteLLMUser({ litellmUserId, key }) {
  try { await litellmFetch('/key/delete', { method: 'POST', body: { keys: [key] } }); }
  catch (e) { console.error('Could not delete orphaned LiteLLM key:', e.message); }
  try { await litellmFetch('/user/delete', { method: 'POST', body: { user_ids: [litellmUserId] } }); }
  catch (e) { console.error('Could not delete orphaned LiteLLM user:', e.message); }
}

// Distinguishes "this signup cannot be allowed" (409) from an infrastructure
// failure (502) once both are raised out of the same transaction.
class RegistrationConflict extends Error {}

// An error whose message is already written for the developer who will read it.
// cleanError() rewrites raw upstream failures into something presentable; these
// are passed through untouched, since rewriting them only loses detail.
class ChatUserError extends Error {}

function getUserById(id) {
  return db.prepare('SELECT * FROM jsan_users WHERE id=?').get(id) || null;
}
/** The account behind the session cookie, with the claims that carried it. */
async function sessionUser(req) {
  const token = req.cookies.jsan_session;
  if (!token) return null;
  try {
    const claims = jwt.verify(token, JWT_SECRET, { issuer: 'jsan-dev-ai' });
    const user = getUserById(claims.sub);
    return user ? { user, claims } : null;
  } catch { return null; }
}

/**
 * Renew a session that is being used.
 *
 * Without this a session is a fixed SESSION_HOURS from the moment somebody
 * signed in, whatever they are doing when it runs out. An admin part way
 * through issuing codes had their next click answered with "Sign in required"
 * on a page that was still showing them signed in, which reads as the feature
 * being broken rather than the session having ended.
 *
 * Renewed only in the second half of its life, so a busy portal is not
 * re-signing a token on every request. This makes the window idle time rather
 * than total time: someone actively working stays signed in, and a session
 * nobody has touched for SESSION_HOURS still lapses, which is the part that
 * matters for a shared or forgotten machine.
 */
function renewSessionIfStale(res, session) {
  const expiresAt = Number(session.claims?.exp) * 1000;
  if (!Number.isFinite(expiresAt)) return;
  const halfLife = (SESSION_HOURS * 60 * 60 * 1000) / 2;
  if (expiresAt - Date.now() > halfLife) return;
  // Safe on the streaming routes too: `auth` runs before any handler writes a
  // header, so the Set-Cookie is in place well before an SSE body starts.
  setSessionCookie(res, createSession(session.user));
}

// Told to the developer rather than a generic refusal: somebody whose account
// was closed on purpose should be able to tell that apart from a fault.
const DISABLED_MESSAGE = 'This account has been deactivated. Contact your JSAN admin.';

async function auth(req, res, next) {
  const session = await sessionUser(req);
  if (session && disabledRecord(session.user.id)) {
    // Checked on every request rather than only at sign-in, so a session that
    // was already open when the account was closed stops working at once.
    res.clearCookie('jsan_session', { path: '/' });
    return res.status(401).json({ error: DISABLED_MESSAGE, code: 'account_disabled' });
  }
  if (!session) {
    // `code` is what the browser keys on: it tells a 401 that means "your
    // session has ended" apart from a 401 that means "that password is wrong",
    // so the app can stop claiming to be signed in without treating a failed
    // sign-in as a lost session.
    return res.status(401).json({ error: 'Sign in required', code: 'session_expired' });
  }
  req.user = session.user;
  renewSessionIfStale(res, session);
  next();
}

// Admin gate. Always mounted after `auth`, so req.user is the row this process
// just read - admin is decided from the account's current address against the
// current ADMIN_EMAILS, never from a claim inside the session cookie. An
// address removed from the list therefore loses the Admin page immediately,
// rather than at the end of a twelve-hour session.
function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin access is required' });
  next();
}

// Admin actions: authenticated and few, so this only bounds a stuck client or
// a script looping on code generation. Keyed on the account, like chat.
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? byIp(req),
  message: { error: 'Too many admin requests in a row. Wait a moment and try again.' }
});

app.get('/api/health', async (_req, res) => {
  // Named dbOk because `db` at module scope is the connection itself.
  let dbOk = false, gateway = false, registeredUsers = 0;
  try {
    registeredUsers = activeUserCount();
    dbOk = true;
  } catch {}
  try {
    await litellmFetch('/v1/models', { timeout: 5000 });
    gateway = true;
  } catch {}
  res.json({ ok: dbOk && gateway, db: dbOk, gateway, registeredUsers, maxUsers: MAX_USERS, registrationOpen: registeredUsers < MAX_USERS });
});

app.get('/api/auth/registration-status', (_req, res) => {
  const count = activeUserCount();
  // The sign-in policy travels with this so the form can state the rule
  // before anyone breaks it, and name the right domain wherever it is deployed.
  res.json({
    registeredUsers: count,
    maxUsers: MAX_USERS,
    remaining: Math.max(0, MAX_USERS - count),
    registrationOpen: count < MAX_USERS,
    emailDomain: ALLOWED_EMAIL_DOMAIN || null,
    maxAttempts: LOGIN_MAX_ATTEMPTS,
    lockoutMinutes: LOGIN_LOCKOUT_MINUTES
  });
});

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');
  const accessCode = String(req.body?.accessCode || '');

  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid work email' });
  if (ALLOWED_EMAIL_DOMAIN && !email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) return res.status(400).json({ error: `Use your ${ALLOWED_EMAIL_DOMAIN} email` });
  // The address is checked before the code, which is a change from when the
  // code was a single shared string: an issued code can be bound to one
  // address, so it cannot be judged until there is a valid address to judge it
  // against. A typo'd email would otherwise be reported as somebody else's code.
  const admitted = checkAccessCode(accessCode, email);
  if (!admitted.ok) return res.status(403).json({ error: admitted.error });
  if (password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for your password' });
  // Checked here as well as in the form: /api/auth/register is reachable
  // without it, and a typo confirmed only by the browser is still a typo that
  // locks somebody out of the account they just made.
  if (confirmPassword !== password) return res.status(400).json({ error: 'The two passwords do not match' });

  // Cheap pre-checks so an obviously doomed signup never reaches LiteLLM. They
  // are advisory only; the authoritative versions run under the write lock below.
  if (activeUserCount() >= MAX_USERS) {
    return res.status(409).json({ error: 'Registration is full' });
  }
  const priorAccount = db.prepare('SELECT id FROM jsan_users WHERE email=?').get(email);
  if (priorAccount) {
    // Registering again would not work anyway - the address is unique - and
    // "an account already exists" sends somebody looking for a password they
    // never had. Restoring the account is the actual repair, and it keeps the
    // conversations the deactivation preserved.
    return res.status(409).json(disabledRecord(priorAccount.id)
      ? { error: 'That account was deactivated. Ask your JSAN admin to restore it rather than registering again.' }
      : { error: 'An account already exists for this email' });
  }

  // Provisioning is a network call, so it cannot sit inside the transaction the
  // way it did on PostgreSQL: SQLite's write lock is held by a synchronous
  // block. Issuing the key first and inserting second means a signup rejected
  // at the last moment can leave a key behind, which is why the failure path
  // below revokes it. Holding the lock across a 20s LiteLLM call would have
  // serialized every other registration behind it anyway.
  const id = crypto.randomUUID();
  let provision;
  try {
    provision = await provisionLiteLLMUser({ id, name, email });
  } catch (e) {
    console.error('Registration failed while provisioning:', e.message);
    return res.status(502).json({ error: cleanError(e, 'Could not create the account. Please try again or contact the platform owner.') });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const encrypted = encryptText(provision.key);
    transaction(db, () => {
      // BEGIN IMMEDIATE takes the single writer lock for the whole block, so a
      // concurrent signup cannot pass the same seat check. This is the job
      // pg_advisory_xact_lock did before.
      if (activeUserCount() >= MAX_USERS) {
        throw new RegistrationConflict('Registration is full');
      }
      if (db.prepare('SELECT id FROM jsan_users WHERE email=?').get(email)) {
        throw new RegistrationConflict('An account already exists for this email');
      }
      // Spend the issued code in the same transaction as the row it admits.
      // Checked again rather than trusted from above: the earlier read was not
      // under the write lock, so two people holding the same single-use code
      // could both have passed it. Here the second one finds uses already at
      // max_uses and is refused, and a rollback for any other reason - a full
      // portal, a duplicate address - leaves the code unspent and still usable.
      if (admitted.code) {
        const current = db.prepare('SELECT * FROM jsan_access_codes WHERE id=?').get(admitted.code.id);
        if (!current) throw new RegistrationConflict(CODE_INVALID);
        const status = accessCodeStatus(current);
        if (status !== 'active') throw new RegistrationConflict(CODE_REFUSALS[status]);
        if (current.assigned_email && current.assigned_email.toLowerCase() !== email) {
          throw new RegistrationConflict(CODE_REFUSALS.wrongEmail);
        }
        db.prepare('UPDATE jsan_access_codes SET uses=uses+1,last_used_at=?,last_used_by=? WHERE id=?')
          .run(nowIso(), email, current.id);
      }
      db.prepare(`INSERT INTO jsan_users(id,name,email,password_hash,litellm_user_id,litellm_key_ciphertext,litellm_key_iv,litellm_key_tag,last_login_at)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(id, name, email, passwordHash, provision.litellmUserId, encrypted.ciphertext, encrypted.iv, encrypted.tag, nowIso());
      // One row per redemption, beside the running count on the code itself.
      // The count says how much of a code is spent; this says by whom, which is
      // the only way to answer "what is this developer's code?" for a code an
      // admin cut for more than one person.
      //
      // After the user row, not before: it points at jsan_users(id), and SQLite
      // checks a foreign key as the statement runs rather than at COMMIT, so
      // the other order fails the whole registration.
      if (admitted.code) {
        db.prepare('INSERT INTO jsan_access_code_redemptions(id,code_id,user_id,email) VALUES(?,?,?,?)')
          .run(crypto.randomUUID(), admitted.code.id, id, email);
      }
    });
  } catch (e) {
    await revokeLiteLLMUser(provision);
    if (e instanceof RegistrationConflict) return res.status(409).json({ error: e.message });
    console.error('Registration failed:', e.message);
    return res.status(502).json({ error: cleanError(e, 'Could not create the account. Please try again or contact the platform owner.') });
  }

  const user = { id, name, email };
  setSessionCookie(res, createSession(user));
  return res.status(201).json({ user: { ...user, isAdmin: isAdmin(user) } });
});

// Failed sign-ins.
//
// The lockout is applied to the address that was typed, whether or not an
// account exists behind it. Skipping unknown addresses would make them answer
// faster and never lock, and that difference is itself an answer to "does this
// person have an account here?".

/** Human wait, for a message somebody reads while they are locked out. */
function describeWait(seconds) {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? 'a minute' : `${minutes} minutes`;
}

// Rows matter only while they can still lock someone out. Pruning on write
// keeps the table proportional to recent activity rather than to every address
// ever typed into the form, so a stream of invented ones cannot grow it.
function pruneLoginAttempts(now) {
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - LOGIN_LOCKOUT_MINUTES * 60_000).toISOString();
  db.prepare('DELETE FROM jsan_login_attempts WHERE last_failed_at < ? AND (locked_until IS NULL OR locked_until < ?)')
    .run(cutoff, stamp);
}

/** The live lockout on an address, or null when it may try again. */
function loginLock(email, now = new Date()) {
  const row = db.prepare('SELECT locked_until FROM jsan_login_attempts WHERE email=?').get(email);
  if (!row?.locked_until) return null;
  const seconds = Math.ceil((new Date(row.locked_until).getTime() - now.getTime()) / 1000);
  return seconds > 0 ? { until: row.locked_until, seconds } : null;
}

/**
 * Count one wrong password, and lock the address once it has used up its
 * tries. `failures` is reset as the lock is written, so waiting a lockout out
 * returns the full allowance rather than a single attempt.
 */
function recordLoginFailure(email) {
  const now = new Date();
  pruneLoginAttempts(now);
  const stamp = now.toISOString();
  const previous = db.prepare('SELECT failures FROM jsan_login_attempts WHERE email=?').get(email);
  const failures = (previous?.failures || 0) + 1;

  if (failures >= LOGIN_MAX_ATTEMPTS) {
    const until = new Date(now.getTime() + LOGIN_LOCKOUT_MINUTES * 60_000).toISOString();
    db.prepare(`INSERT INTO jsan_login_attempts(email,failures,locked_until,last_failed_at) VALUES(?,0,?,?)
      ON CONFLICT(email) DO UPDATE SET failures=0, locked_until=excluded.locked_until, last_failed_at=excluded.last_failed_at`)
      .run(email, until, stamp);
    return { locked: true, until, seconds: LOGIN_LOCKOUT_MINUTES * 60, attemptsRemaining: 0 };
  }

  db.prepare(`INSERT INTO jsan_login_attempts(email,failures,locked_until,last_failed_at) VALUES(?,?,NULL,?)
    ON CONFLICT(email) DO UPDATE SET failures=excluded.failures, locked_until=NULL, last_failed_at=excluded.last_failed_at`)
    .run(email, failures, stamp);
  return { locked: false, attemptsRemaining: LOGIN_MAX_ATTEMPTS - failures };
}

/** A correct password clears the address's history. */
function clearLoginFailures(email) {
  db.prepare('DELETE FROM jsan_login_attempts WHERE email=?').run(email);
}

function lockedResponse(res, { until, seconds }, error) {
  res.setHeader('Retry-After', String(seconds));
  return res.status(429).json({ error, lockedUntil: until, retryAfterSeconds: seconds, attemptsRemaining: 0 });
}

app.post('/api/auth/login', loginIpLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  // Read before the password is checked, so a locked address costs one indexed
  // lookup instead of a bcrypt comparison. A lockout that still spent the CPU
  // would leave the cheapest thing to attack untouched.
  const existingLock = loginLock(email);
  if (existingLock) {
    return lockedResponse(res, existingLock,
      `Too many failed attempts. This account is locked — try again in ${describeWait(existingLock.seconds)}.`);
  }

  const user = db.prepare('SELECT * FROM jsan_users WHERE email=?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    const failure = recordLoginFailure(email);
    if (failure.locked) {
      return lockedResponse(res, failure,
        `That is ${LOGIN_MAX_ATTEMPTS} incorrect attempts. This account is locked for ${LOGIN_LOCKOUT_MINUTES} minutes.`);
    }
    return res.status(401).json({
      error: 'Email or password is incorrect',
      attemptsRemaining: failure.attemptsRemaining,
      maxAttempts: LOGIN_MAX_ATTEMPTS,
      lockoutMinutes: LOGIN_LOCKOUT_MINUTES
    });
  }

  // After the password check, not before it: answering faster for a
  // deactivated address would say which addresses have accounts behind them.
  if (disabledRecord(user.id)) {
    clearLoginFailures(email);
    return res.status(403).json({ error: DISABLED_MESSAGE, code: 'account_disabled' });
  }

  clearLoginFailures(email);
  db.prepare('UPDATE jsan_users SET last_login_at=? WHERE id=?').run(nowIso(), user.id);
  setSessionCookie(res, createSession(user));
  res.json({ user: { id: user.id, name: user.name, email: user.email, isAdmin: isAdmin(user) } });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('jsan_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email, isAdmin: isAdmin(req.user) }));

app.get('/api/me/api-key', auth, (req, res) => {
  try { res.json({ apiKey: decryptKey(req.user) }); }
  catch { res.status(500).json({ error: 'Could not read your developer key' }); }
});

app.post('/api/me/api-key/rotate', auth, async (req, res) => {
  try {
    const oldKey = decryptKey(req.user);
    const result = await litellmFetch('/key/regenerate', { method: 'POST', body: { key: oldKey } });
    const newKey = result?.key || result?.token;
    if (!newKey) throw new Error('LiteLLM did not return the regenerated key');
    const encrypted = encryptText(newKey);
    db.prepare('UPDATE jsan_users SET litellm_key_ciphertext=?,litellm_key_iv=?,litellm_key_tag=? WHERE id=?')
      .run(encrypted.ciphertext, encrypted.iv, encrypted.tag, req.user.id);
    res.json({ apiKey: newKey });
  } catch (e) {
    console.error('Key rotation failed:', e.message);
    res.status(502).json({ error: cleanError(e, 'Could not rotate your key') });
  }
});

// ---------------------------------------------------------------------------
// Admin: issuing team access codes
//
// Every route here is `auth, adminOnly, adminLimiter`. adminOnly reads the
// account this process just loaded rather than a claim in the cookie, so an
// address dropped from ADMIN_EMAILS loses these routes on its next request.
//
// These routes do return codes in plaintext, and that is the point: an admin
// has to be able to answer "what is my code?" for any developer at any time,
// which a write-only store cannot do. What guards them is the gate above, not
// obscurity - and the page itself can blank every code on screen for a share.
// ---------------------------------------------------------------------------

const LIST_CODES = `SELECT c.*, u.email AS created_by_email
  FROM jsan_access_codes c LEFT JOIN jsan_users u ON u.id = c.created_by
  ORDER BY c.created_at DESC LIMIT 200`;

/** One code with the issuing admin's address attached, as the list returns it. */
function accessCodeById(id) {
  return db.prepare(`SELECT c.*, u.email AS created_by_email
    FROM jsan_access_codes c LEFT JOIN jsan_users u ON u.id = c.created_by WHERE c.id=?`).get(id);
}

app.get('/api/admin/overview', auth, adminOnly, adminLimiter, (_req, res) => {
  const count = activeUserCount();
  const codes = db.prepare('SELECT revoked_at, expires_at, uses, max_uses FROM jsan_access_codes').all();
  const now = Date.now();
  const active = codes.filter(row => accessCodeStatus(row, now) === 'active').length;
  res.json({
    registeredUsers: count,
    maxUsers: MAX_USERS,
    seatsRemaining: Math.max(0, MAX_USERS - count),
    registrationOpen: count < MAX_USERS,
    activeCodes: active,
    totalCodes: codes.length,
    deactivatedUsers: db.prepare('SELECT COUNT(*) AS count FROM jsan_disabled_users').get().count,
    // Seats already promised to somebody holding a code they have not spent.
    // Shown beside the seat count so an admin can see the portal running out
    // before a developer is the one to discover it.
    outstandingCodeUses: outstandingCodeUses(),
    emailDomain: ALLOWED_EMAIL_DOMAIN || null,
    // Whether the old team-wide code is still accepted beside issued ones. The
    // code itself is never sent - only whether one is configured, so an admin
    // can see that a second way in exists and turn it off if they meant to.
    sharedCodeEnabled: Boolean(REGISTRATION_ACCESS_CODE),
    admins: [...ADMIN_EMAILS],
    limits: { defaultExpiryDays: CODE_DEFAULT_EXPIRY_DAYS, maxUses: CODE_MAX_USES_LIMIT, maxExpiryDays: CODE_MAX_EXPIRY_DAYS }
  });
});

app.get('/api/admin/access-codes', auth, adminOnly, adminLimiter, (_req, res) => {
  res.json({ codes: db.prepare(LIST_CODES).all().map(serializeAccessCode) });
});

// How many addresses one submission may carry. Past this the form is being
// used as a mailing list, and a slip would mint dozens of live codes at once.
const CODE_BULK_LIMIT = 50;

/**
 * The addresses a submission is asking for codes for.
 *
 * Liberal in what it accepts, because an admin onboarding a team is pasting
 * from somewhere else: an array from the form, or one string with the
 * addresses separated by newlines, commas, semicolons or spaces - which is
 * what a column out of a spreadsheet or an email's To: line gives you.
 * Lowercased and de-duplicated, so the same person listed twice gets one code
 * rather than two, and an empty list means one code bound to nobody.
 */
function readAssignedEmails(body) {
  const parts = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'string') parts.push(...value.split(/[,;\s]+/));
  };
  collect(body?.assignedEmails);
  collect(body?.assignedEmail);
  const seen = new Set();
  const emails = [];
  for (const part of parts) {
    const email = part.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

/**
 * Why this address cannot be given a code, or null when it can.
 *
 * Returned per address rather than thrown, because one bad line in a pasted
 * list must not cost the admin the other nineteen: the route reports what it
 * skipped and issues the rest.
 */
function assignedEmailProblem(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Not a valid email address';
  if (ALLOWED_EMAIL_DOMAIN && !email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
    return `Registration only accepts ${ALLOWED_EMAIL_DOMAIN} addresses`;
  }
  const account = db.prepare('SELECT id FROM jsan_users WHERE email=?').get(email);
  if (account) {
    return disabledRecord(account.id)
      ? 'Deactivated - restore the account instead of issuing a code'
      : 'Already has an account';
  }
  // A second live code for one person is almost always the form submitted
  // twice rather than a deliberate reissue, and both would work - leaving a
  // spare seat nobody is tracking. Withdrawing the first is the explicit way
  // to replace it.
  const held = db.prepare('SELECT expires_at,revoked_at,uses,max_uses FROM jsan_access_codes WHERE assigned_email=?').all(email);
  if (held.some(row => accessCodeStatus(row) === 'active')) {
    return 'Already holds an unused code - withdraw it first to issue another';
  }
  return null;
}

/** Write one code. Returns its id and plaintext; the row is read back after. */
function insertAccessCode({ assignedEmail, label, maxUses, expiresAt, createdBy }) {
  const id = crypto.randomUUID();
  const code = newAccessCode();
  const encrypted = encryptText(code);
  db.prepare(`INSERT INTO jsan_access_codes(id,code_hash,code_ciphertext,code_iv,code_tag,code_hint,label,assigned_email,max_uses,expires_at,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, accessCodeDigest(code), encrypted.ciphertext, encrypted.iv, encrypted.tag,
         accessCodeHint(code), label, assignedEmail, maxUses, expiresAt, createdBy);
  return { id, code };
}

/** Unused seats promised by codes that have been issued but not spent. */
function outstandingCodeUses() {
  return db.prepare('SELECT expires_at,revoked_at,uses,max_uses FROM jsan_access_codes').all()
    .filter(row => accessCodeStatus(row) === 'active')
    .reduce((total, row) => total + (row.max_uses - row.uses), 0);
}

/**
 * Issue codes - one for nobody in particular, or one each for a list of
 * developers in a single submission.
 *
 * The limits (how many uses, when it lapses) apply to the whole submission and
 * are rejected rather than clamped, because a form that silently turned "3o"
 * into a code that never expires would be worse than one that says no. The
 * addresses are judged one at a time and reported back in two lists, so
 * onboarding twenty people does not stop at the one who already has an account.
 */
app.post('/api/admin/access-codes', auth, adminOnly, adminLimiter, (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 80);
  const emails = readAssignedEmails(req.body);
  if (emails.length > CODE_BULK_LIMIT) {
    return res.status(400).json({ error: `That is ${emails.length} addresses. Issue at most ${CODE_BULK_LIMIT} codes at a time.` });
  }

  const rawUses = req.body?.maxUses;
  const maxUses = rawUses === undefined || rawUses === null || rawUses === '' ? 1 : Number(rawUses);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > CODE_MAX_USES_LIMIT) {
    return res.status(400).json({ error: `A code may be used between 1 and ${CODE_MAX_USES_LIMIT} times` });
  }
  const rawDays = req.body?.expiresInDays;
  const days = rawDays === undefined || rawDays === null || rawDays === '' ? CODE_DEFAULT_EXPIRY_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 0 || days > CODE_MAX_EXPIRY_DAYS) {
    return res.status(400).json({ error: `Expiry must be between 0 and ${CODE_MAX_EXPIRY_DAYS} days, where 0 never expires` });
  }
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;

  // An empty list is one code bound to nobody, which is what the form does
  // when the addresses box is left blank.
  const targets = emails.length ? emails : [null];
  const issued = [], skipped = [];
  try {
    // One transaction for the whole submission. BEGIN IMMEDIATE holds the write
    // lock across it, so "does this address already have an account, or a live
    // code?" cannot be answered from a state that a concurrent registration or
    // a second admin changes underneath it. All-or-nothing as well: a batch
    // that fails half way leaves no codes to reconcile against the list the
    // admin thinks they sent.
    transaction(db, () => {
      for (const email of targets) {
        const problem = email ? assignedEmailProblem(email) : null;
        if (problem) { skipped.push({ email, error: problem }); continue; }
        const written = insertAccessCode({ assignedEmail: email, label, maxUses, expiresAt, createdBy: req.user.id });
        issued.push({ email, ...written });
      }
    });
  } catch (e) {
    console.error('Could not issue access codes:', e.message);
    return res.status(500).json({ error: 'Could not issue the access codes. Nothing was created - try again.' });
  }

  const entries = issued.map(item => ({
    email: item.email,
    code: item.code,
    entry: serializeAccessCode(accessCodeById(item.id))
  }));
  for (const item of issued) {
    console.log(`Access code ${accessCodeHint(item.code)} issued by ${req.user.email}${item.email ? ` for ${item.email}` : ''}`);
  }

  // Said rather than enforced: a code is often cut before the seat is needed,
  // and refusing to issue one would be the wrong call. Registration still
  // stops at MAX_USERS, so without this the admin would find out by way of a
  // developer being turned away.
  const registered = activeUserCount();
  const outstanding = outstandingCodeUses();
  const warning = registered + outstanding > MAX_USERS
    ? `${registered} of ${MAX_USERS} seats are taken and ${outstanding} unused code uses are outstanding. Whoever arrives after the last seat will be refused.`
    : null;

  res.status(entries.length ? 201 : 200).json({
    issued: entries,
    skipped,
    warning,
    // The single-code shape this route has always answered with, kept so a
    // caller that asked for one code does not have to read a list to find it.
    code: entries[0]?.code ?? null,
    entry: entries[0]?.entry ?? null
  });
});

/**
 * Every developer, and the code that let them in.
 *
 * The join runs through jsan_access_code_redemptions rather than the counter on
 * the code, so it stays right for a code an admin cut for several people. An
 * account with no redemption behind it was either declared in SEED_ACCOUNTS or
 * registered on the shared REGISTRATION_ACCESS_CODE - including anyone who
 * signed up before codes could be issued at all - and is labelled accordingly
 * rather than shown as having no way in.
 */
app.get('/api/admin/users', auth, adminOnly, adminLimiter, (_req, res) => {
  const seeded = new Set(SEED_ACCOUNTS.map(account => account.email));
  const users = db.prepare('SELECT id,name,email,created_at,last_login_at FROM jsan_users ORDER BY created_at DESC LIMIT 200').all();
  const byUser = new Map();
  for (const row of db.prepare(`SELECT r.user_id, r.redeemed_at, c.*, a.email AS created_by_email
      FROM jsan_access_code_redemptions r
      JOIN jsan_access_codes c ON c.id = r.code_id
      LEFT JOIN jsan_users a ON a.id = c.created_by
      WHERE r.user_id IS NOT NULL`).all()) {
    byUser.set(row.user_id, row);
  }
  res.json({
    users: users.map(user => {
      const redemption = byUser.get(user.id);
      const address = String(user.email).toLowerCase();
      const lock = loginLock(user.email);
      const disabled = disabledRecord(user.id);
      const reset = livePasswordReset(user.id);
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
        isAdmin: ADMIN_EMAILS.has(address),
        admittedBy: redemption ? 'issued-code' : (seeded.has(address) ? 'seed-account' : 'shared-code'),
        redeemedAt: redemption?.redeemed_at || null,
        accessCode: redemption ? serializeAccessCode(redemption) : null,
        // What an admin can do something about, and why they cannot always.
        lockedUntil: lock?.until || null,
        disabledAt: disabled?.disabled_at || null,
        passwordReset: reset ? serializePasswordReset(reset) : null,
        canResetPassword: !disabled && passwordResetProblem(user) === null,
        canDeactivate: !disabled && deactivationProblem(user) === null
      };
    })
  });
});

/**
 * Look up the developer an admin action names.
 *
 * Returns null and answers 404 itself, so each route below is one line of
 * lookup rather than five of the same guard.
 */
function adminTargetUser(req, res) {
  const user = getUserById(req.params.id);
  if (!user) { res.status(404).json({ error: 'That developer no longer has an account here' }); return null; }
  return user;
}

/**
 * Issue a password reset for one developer.
 *
 * Any reset still outstanding for them is revoked in the same breath, so there
 * is never more than one live code for an account - two would both work, and
 * the admin would have no way to tell which one they had sent.
 */
app.post('/api/admin/users/:id/password-reset', auth, adminOnly, adminLimiter, (req, res) => {
  const user = adminTargetUser(req, res);
  if (!user) return;
  if (disabledRecord(user.id)) {
    return res.status(409).json({ error: 'That account is deactivated. Restore it first, then reset the password.' });
  }
  const problem = passwordResetProblem(user);
  if (problem) return res.status(409).json({ error: problem });

  const id = crypto.randomUUID();
  const code = newResetCode();
  const encrypted = encryptText(code);
  const expiresAt = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  try {
    transaction(db, () => {
      db.prepare('UPDATE jsan_password_resets SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL')
        .run(nowIso(), user.id);
      db.prepare(`INSERT INTO jsan_password_resets(id,user_id,email,code_hash,code_ciphertext,code_iv,code_tag,code_hint,expires_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(id, user.id, user.email, accessCodeDigest(code), encrypted.ciphertext, encrypted.iv, encrypted.tag,
             accessCodeHint(code), expiresAt, req.user.id);
    });
  } catch (e) {
    console.error('Could not issue a password reset:', e.message);
    return res.status(500).json({ error: 'Could not issue the reset. Nothing was changed - try again.' });
  }
  console.log(`Password reset ${accessCodeHint(code)} issued by ${req.user.email} for ${user.email}`);
  res.status(201).json({
    code,
    reset: serializePasswordReset(db.prepare('SELECT * FROM jsan_password_resets WHERE id=?').get(id)),
    email: user.email,
    expiresInHours: RESET_EXPIRY_HOURS
  });
});

/**
 * Lift a sign-in lockout.
 *
 * The lockout is deliberately durable - it is counted in the database so a
 * restart cannot clear it - which also meant nobody could clear it. Three
 * mistyped passwords cost a developer half an hour with no way for anyone to
 * help. This is that way.
 */
app.post('/api/admin/users/:id/unlock', auth, adminOnly, adminLimiter, (req, res) => {
  const user = adminTargetUser(req, res);
  if (!user) return;
  const lock = loginLock(user.email);
  clearLoginFailures(user.email);
  console.log(`Sign-in lockout cleared for ${user.email} by ${req.user.email}`);
  res.json({ ok: true, wasLocked: Boolean(lock) });
});

/**
 * Give up a developer's seat without destroying anything they did.
 *
 * Their key is deleted at the gateway first: that is the half that matters the
 * day somebody leaves, and if it fails the seat is left alone rather than
 * marked free while the key still works. The account, its conversations and its
 * messages all stay exactly where they are.
 */
app.post('/api/admin/users/:id/deactivate', auth, adminOnly, adminLimiter, async (req, res) => {
  const user = adminTargetUser(req, res);
  if (!user) return;
  if (disabledRecord(user.id)) return res.status(409).json({ error: 'That account is already deactivated' });
  const problem = deactivationProblem(user);
  if (problem) return res.status(409).json({ error: problem });

  try {
    await litellmFetch('/key/delete', { method: 'POST', body: { key_aliases: [`jsan-${user.email}`] } });
  } catch (e) {
    // A key the gateway has already lost is not a reason to refuse: the state
    // being asked for is "this key does not work", and it does not.
    if (!/not found|does not exist|no keys/i.test(String(e.message))) {
      console.error(`Could not revoke the gateway key for ${user.email}:`, e.message);
      return res.status(502).json({ error: cleanError(e, 'Could not revoke their gateway key, so the seat was left as it was. Try again.') });
    }
    console.log(`Gateway key for ${user.email} was already gone`);
  }

  db.prepare('INSERT INTO jsan_disabled_users(user_id,email,reason,disabled_by) VALUES(?,?,?,?)')
    .run(user.id, user.email, String(req.body?.reason || '').trim().slice(0, 120), req.user.id);
  console.log(`${user.email} deactivated by ${req.user.email} - seat released, conversations kept`);
  res.json({ ok: true });
});

/**
 * Give the seat back.
 *
 * A fresh key is issued rather than the old one restored: the old one was
 * deleted at the gateway, and the ciphertext this portal holds for it decrypts
 * to a string that no longer authenticates anything. provisionLiteLLMUser
 * already knows how to adopt an existing gateway user and retire a stale alias,
 * which is exactly the state a restored account is in.
 */
app.post('/api/admin/users/:id/restore', auth, adminOnly, adminLimiter, async (req, res) => {
  const user = adminTargetUser(req, res);
  if (!user) return;
  if (!disabledRecord(user.id)) return res.status(409).json({ error: 'That account already has a seat' });
  if (activeUserCount() >= MAX_USERS) {
    return res.status(409).json({ error: `Every one of the ${MAX_USERS} seats is taken. Deactivate somebody else first.` });
  }

  let provision;
  try {
    provision = await provisionLiteLLMUser({ id: user.litellm_user_id || user.id, name: user.name, email: user.email });
  } catch (e) {
    console.error(`Could not reissue a gateway key for ${user.email}:`, e.message);
    return res.status(502).json({ error: cleanError(e, 'Could not issue them a new gateway key, so the account was left deactivated.') });
  }

  const encrypted = encryptText(provision.key);
  transaction(db, () => {
    db.prepare('UPDATE jsan_users SET litellm_user_id=?,litellm_key_ciphertext=?,litellm_key_iv=?,litellm_key_tag=? WHERE id=?')
      .run(provision.litellmUserId, encrypted.ciphertext, encrypted.iv, encrypted.tag, user.id);
    db.prepare('DELETE FROM jsan_disabled_users WHERE user_id=?').run(user.id);
  });
  console.log(`${user.email} restored by ${req.user.email} - new gateway key issued`);
  res.json({ ok: true });
});

/**
 * Set a new password with a reset code.
 *
 * Public, because the person using it cannot sign in - that is the whole
 * point - so it is rate limited per network like registration, and the code is
 * matched by hash exactly as an access code is.
 *
 * The address is required beside the code so a code on its own is not enough,
 * and the two must agree with the same account. A successful reset also clears
 * the sign-in lockout: somebody who has just proved they hold the code should
 * not then be told to wait half an hour.
 */
app.post('/api/auth/reset-password', resetLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || req.body?.accessCode || '');
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');

  const REFUSED = 'That reset code is not valid for this email address';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter the email the reset was issued for' });
  if (password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for your new password' });
  if (confirmPassword !== password) return res.status(400).json({ error: 'The two passwords do not match' });

  const digest = accessCodeDigest(code);
  if (!digest) return res.status(403).json({ error: REFUSED });
  const reset = db.prepare('SELECT * FROM jsan_password_resets WHERE code_hash=?').get(digest);
  if (!reset) return res.status(403).json({ error: REFUSED });
  if (reset.used_at) return res.status(403).json({ error: 'That reset code has already been used. Ask your JSAN admin for another.' });
  if (reset.revoked_at) return res.status(403).json({ error: 'That reset code was replaced by a newer one. Use the most recent code you were sent.' });
  if (Date.parse(reset.expires_at) <= Date.now()) return res.status(403).json({ error: 'That reset code has expired. Ask your JSAN admin for another.' });
  if (String(reset.email).toLowerCase() !== email) return res.status(403).json({ error: REFUSED });

  const user = getUserById(reset.user_id);
  if (!user) return res.status(403).json({ error: REFUSED });
  if (disabledRecord(user.id)) return res.status(403).json({ error: DISABLED_MESSAGE, code: 'account_disabled' });

  // Hashed before the transaction: bcrypt is deliberately slow, and SQLite's
  // single write lock is held for the whole of a transaction body.
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    transaction(db, () => {
      // Re-read under the write lock, so two people racing the same code
      // cannot both spend it.
      const current = db.prepare('SELECT used_at,revoked_at FROM jsan_password_resets WHERE id=?').get(reset.id);
      if (!current || current.used_at || current.revoked_at) throw new RegistrationConflict('That reset code has already been used. Ask your JSAN admin for another.');
      db.prepare('UPDATE jsan_users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
      db.prepare('UPDATE jsan_password_resets SET used_at=? WHERE id=?').run(nowIso(), reset.id);
    });
  } catch (e) {
    if (e instanceof RegistrationConflict) return res.status(409).json({ error: e.message });
    console.error('Password reset failed:', e.message);
    return res.status(500).json({ error: 'Could not set the new password. Nothing was changed - try again.' });
  }

  clearLoginFailures(email);
  db.prepare('UPDATE jsan_users SET last_login_at=? WHERE id=?').run(nowIso(), user.id);
  console.log(`${user.email} set a new password with reset ${reset.code_hint}`);
  const signedIn = { id: user.id, name: user.name, email: user.email };
  setSessionCookie(res, createSession(signedIn));
  res.json({ user: { ...signedIn, isAdmin: isAdmin(signedIn) } });
});

/**
 * A developer changes their own password, knowing the current one.
 *
 * The reset route above is the assisted path, for somebody who cannot get in at
 * all; this is the ordinary one. Without it the only way to change a password
 * you still knew was to ask an admin to issue a reset - which puts a live code
 * on a chat thread for something that needed no code at all.
 *
 * The current password is asked for even though the session already proves who
 * this is, because a session is what somebody finds at an unlocked desk. The
 * password is the part they would have to know.
 *
 * A change also retires any reset the admin has issued: the developer clearly
 * did not need it, and leaving it live leaves a spare key to the account.
 */
app.post('/api/auth/change-password', auth, passwordChangeLimiter, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');

  if (!currentPassword) return res.status(400).json({ error: 'Enter your current password' });
  if (password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for your new password' });
  if (confirmPassword !== password) return res.status(400).json({ error: 'The two passwords do not match' });
  if (password === currentPassword) return res.status(400).json({ error: 'That is already your password. Choose a different one.' });

  const user = getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'That account no longer exists' });

  // The same refusal a reset gets, for the same reason: ensureSeedAccounts puts
  // the configured password back at the next boot, so this would quietly undo
  // itself. Checked before the current password, so a seeded account is told
  // why rather than being walked through a form that cannot work.
  const problem = passwordResetProblem(user);
  if (problem) return res.status(409).json({ error: problem });

  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(403).json({ error: 'That is not your current password' });
  }

  // Hashed outside the transaction: bcrypt is deliberately slow, and SQLite
  // holds one write lock for the whole of a transaction body.
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    transaction(db, () => {
      db.prepare('UPDATE jsan_users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
      db.prepare(`UPDATE jsan_password_resets SET revoked_at=?
        WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL`).run(nowIso(), user.id);
    });
  } catch (e) {
    console.error('Password change failed:', e.message);
    return res.status(500).json({ error: 'Could not change the password. Nothing was changed - try again.' });
  }

  // Their own doing, so the failure count that a mistyped password left behind
  // goes with it. The session cookie is untouched: the JWT carries no password,
  // and signing somebody out of the tab they just used would read as an error.
  clearLoginFailures(String(user.email).toLowerCase());
  console.log(`${user.email} changed their own password`);
  res.json({ ok: true });
});

app.post('/api/admin/access-codes/:id/revoke', auth, adminOnly, adminLimiter, (req, res) => {
  const row = db.prepare('SELECT * FROM jsan_access_codes WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'That access code no longer exists' });
  if (!row.revoked_at) db.prepare('UPDATE jsan_access_codes SET revoked_at=? WHERE id=?').run(nowIso(), row.id);
  console.log(`Access code ${row.code_hint} revoked by ${req.user.email}`);
  res.json({ entry: serializeAccessCode(accessCodeById(row.id)) });
});

// Removes the record entirely. Revoking is the safer action and the one the
// page leads with - a revoked code stays in the list as the account of who was
// let in and when - so this is for tidying up codes that were never used.
app.delete('/api/admin/access-codes/:id', auth, adminOnly, adminLimiter, (req, res) => {
  const row = db.prepare('SELECT code_hint FROM jsan_access_codes WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'That access code no longer exists' });
  db.prepare('DELETE FROM jsan_access_codes WHERE id=?').run(req.params.id);
  console.log(`Access code ${row.code_hint} deleted by ${req.user.email}`);
  res.json({ ok: true });
});

// The composer sends an attached file as its full text, because that is what the
// model has to read. The developer has already seen that file - replaying its
// body inside their own message turns a one-line question into a wall of code
// the moment the conversation is reopened. Stored messages keep the full text
// for the model; what is sent back for display carries the same chip the
// composer showed when the message was sent.
// Matches one opening marker, anchored to a single line so it cannot backtrack.
const ATTACHMENT_OPEN = /^--- Attached file: (.+) ---$/;

/**
 * Fold each attached file's body back into the chip the composer showed.
 *
 * Deliberately a line scan rather than one regex over the whole message. The
 * regex this replaced paired the markers with a lazy quantifier and a
 * backreference, which is quadratic when a closing marker is missing: a crafted
 * 12 MB message carrying 20k unclosed markers blocked the event loop for 11
 * seconds, stalling every other developer on a single-replica portal. This
 * version is linear, and an unterminated block simply runs to the end.
 */
function foldAttachments(content) {
  const text = String(content);
  // The common case is a message with no attachment at all, which should not
  // pay for a scan of its own length.
  if (!text.includes('--- Attached file: ')) return text;
  const names = [];
  const kept = [];
  let closing = null;
  for (const line of text.split('\n')) {
    if (closing !== null) {
      if (line === closing) closing = null;
      continue;
    }
    const opened = ATTACHMENT_OPEN.exec(line);
    if (!opened) { kept.push(line); continue; }
    names.push(opened[1]);
    closing = `--- End ${opened[1]} ---`;
    // The blank line the composer writes before a block belongs to the block.
    if (kept[kept.length - 1] === '') kept.pop();
  }
  const folded = kept.join('\n');
  return names.length ? `${folded}\n\n${names.map(name => `\u{1F4CE} ${name}`).join('\n')}` : folded;
}

app.get('/api/conversations', auth, (req, res) => {
  res.json(db.prepare('SELECT id,title,mode,created_at,updated_at FROM jsan_conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 60').all(req.user.id));
});
app.get('/api/conversations/:id', auth, (req, res) => {
  const conversation = db.prepare('SELECT * FROM jsan_conversations WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  // created_at has millisecond resolution, so rowid breaks ties in insertion
  // order and a question can never sort after its own answer.
  // One query for every image in the conversation rather than one per message.
  // The bytes stay behind /api/images/:id so reopening a conversation does not
  // drag megabytes of screenshots through this response.
  const byMessage = new Map();
  for (const row of db.prepare(`SELECT i.id, i.message_id, i.name FROM jsan_message_images i
      JOIN jsan_messages m ON m.id = i.message_id
      WHERE m.conversation_id = ? ORDER BY i.rowid`).all(req.params.id)) {
    if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, []);
    byMessage.get(row.message_id).push({ id: row.id, name: row.name });
  }
  const messages = db.prepare('SELECT id,role,content,created_at FROM jsan_messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC').all(req.params.id)
    .map(m => {
      const withText = m.role === 'user' ? { ...m, content: foldAttachments(m.content) } : { ...m };
      const attached = byMessage.get(m.id);
      return attached ? { ...withText, images: attached } : withText;
    });
  res.json({ ...conversation, messages });
});
app.delete('/api/conversations/:id', auth, (req, res) => {
  db.prepare('DELETE FROM jsan_conversations WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

/**
 * Split a byte stream of Server-Sent Events into `data:` payloads.
 *
 * Chunk boundaries fall wherever the network puts them, so a frame can arrive
 * split across two reads: everything after the last blank line is held back
 * until the rest of it turns up.
 */
async function* sseData(webStream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Readable.fromWeb(webStream)) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const payload = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('');
      if (payload) yield payload;
    }
  }
}

// Chat turn.
//
// The response is streamed as SSE rather than returned whole. That is not
// cosmetic: a real answer from these reasoning models runs for minutes, and the
// single-shot version of this route timed out at two minutes with nothing to
// show for the wait. Streaming also keeps bytes moving, so no proxy in between
// decides the connection is idle.
//
// Frames sent to the browser:
//   start     {conversationId}  — sent before the model is called
//   thinking  {}                — sent once, if the model reasons before it
//                                 answers. A status only: the reasoning text
//                                 itself is the model's scratchpad and is never
//                                 forwarded, so nothing the developer did not
//                                 type can end up in the conversation
//   delta     {text}            — answer text, to append
//   done      {conversationId, truncated}
//   error     {error}           — after `start`, failures arrive here, not as
//                                 an HTTP status, because 200 is already sent
// Serves an image back to the developer who sent it. The join to
// jsan_conversations is the authorization: an id belonging to somebody else's
// conversation returns 404 rather than the picture.
app.get('/api/images/:id', auth, (req, res) => {
  const row = db.prepare(`SELECT i.mime, i.data FROM jsan_message_images i
    JOIN jsan_messages m ON m.id = i.message_id
    JOIN jsan_conversations c ON c.id = m.conversation_id
    WHERE i.id = ? AND c.user_id = ?`).get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Image not found' });
  const bytes = Buffer.from(row.data, 'base64');
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Length', bytes.length);
  // Private: the response is scoped to one signed-in developer, so no shared
  // cache between them may keep a copy.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.end(bytes);
});

app.post('/api/chat', auth, chatLimiter, byUser, async (req, res) => {
  const mode = String(req.body?.mode || 'auto');
  const conversationId = req.body?.conversationId;
  const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, MAX_IMAGES) : [];
  // An image on its own is a complete question - "what is wrong here?" is
  // implied by sending a screenshot - so it does not also need typed words.
  const message = String(req.body?.message || '').trim() || (images.length ? 'What is in this image?' : '');
  if (!message) return res.status(400).json({ error: 'Write a message first' });
  if (!DEV_MODELS.includes(mode)) return res.status(400).json({ error: 'Unknown mode' });
  for (const image of images) {
    if (!ALLOWED_IMAGE_MIME.has(String(image?.mime))) {
      return res.status(400).json({ error: 'Images must be PNG, JPEG, WebP or GIF' });
    }
    if (typeof image?.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image.data)) {
      return res.status(400).json({ error: 'An attached image could not be read' });
    }
    // Bytes from base64 length, without decoding megabytes to find out.
    if (Math.floor(image.data.length * 3 / 4) > MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: `Each image must be under ${(MAX_IMAGE_BYTES / 1e6).toFixed(1)} MB` });
    }
  }

  // Read the key before anything is written, so a key this process cannot
  // decrypt fails as a plain HTTP error and leaves no half-finished turn behind.
  let key;
  try { key = decryptKey(req.user); }
  catch { return res.status(500).json({ error: 'Could not read your developer key' }); }

  let cid = conversationId;
  let conversationIsNew = false;
  if (!cid) {
    cid = crypto.randomUUID();
    const title = foldAttachments(message).replace(/\s+/g, ' ').trim().slice(0, 64) || 'New conversation';
    db.prepare('INSERT INTO jsan_conversations(id,user_id,title,mode) VALUES(?,?,?,?)').run(cid, req.user.id, title, mode);
    conversationIsNew = true;
  } else {
    const owned = db.prepare('SELECT id FROM jsan_conversations WHERE id=? AND user_id=?').get(cid, req.user.id);
    if (!owned) return res.status(404).json({ error: 'Conversation not found' });
    db.prepare('UPDATE jsan_conversations SET mode=?,updated_at=? WHERE id=?').run(mode, nowIso(), cid);
  }

  const userMessageId = crypto.randomUUID();
  db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES(?,?,?,?)').run(userMessageId, cid, 'user', message);
  for (const image of images) {
    db.prepare('INSERT INTO jsan_message_images(id,message_id,name,mime,data) VALUES(?,?,?,?,?)')
      .run(crypto.randomUUID(), userMessageId, String(image.name || 'image'), image.mime, image.data);
  }
  const history = db.prepare('SELECT id,role,content FROM jsan_messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC LIMIT 60').all(cid);

  // Collect the images still close enough to the end of the conversation to be
  // worth resending, newest first so the cap keeps the most relevant ones.
  const carried = new Map();
  let carriedCount = 0;
  for (const m of history.slice(-IMAGE_LOOKBACK_MESSAGES).reverse()) {
    if (m.role !== 'user' || carriedCount >= MAX_IMAGES) continue;
    const rows = db.prepare('SELECT name,mime,data FROM jsan_message_images WHERE message_id=? ORDER BY rowid').all(m.id)
      .slice(0, MAX_IMAGES - carriedCount);
    if (!rows.length) continue;
    carried.set(m.id, rows);
    carriedCount += rows.length;
  }

  // A payload holding an image can only go to the vision route, whatever mode
  // the composer had selected.
  const usesVision = carried.size > 0;
  const modelMessages = history.map(m => {
    const attached = carried.get(m.id);
    if (!attached) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content },
        ...attached.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } }))
      ]
    };
  });

  // A turn that produced no answer is removed again. Without this the question
  // stays in the developer's history with nothing under it, and every later
  // turn in that conversation resends it to the model as unanswered context.
  //
  // Whether it took the whole conversation with it is reported to the browser
  // on the error event. The browser is holding this conversation's id as the
  // one it will send with the next message, and a deleted id comes back 404 -
  // so without being told, a single failed first turn leaves every later
  // message in that workspace failing too, with New chat the only way out and
  // nothing on screen saying so. It cannot infer this: the same rollback
  // deletes only the question when the conversation already existed.
  let conversationDiscarded = false;
  const discardTurn = () => {
    try {
      // Both cascade to jsan_message_images, so a discarded turn takes its
      // screenshots with it rather than orphaning them in the database.
      if (conversationIsNew) {
        db.prepare('DELETE FROM jsan_conversations WHERE id=?').run(cid);
        conversationDiscarded = true;
      } else {
        db.prepare('DELETE FROM jsan_messages WHERE id=?').run(userMessageId);
      }
    } catch (e) {
      console.error('Could not roll back the failed turn:', e.message);
    }
  };

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tells nginx-style proxies not to buffer the response into oblivion.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // A browser that goes away mid-answer destroys the socket under us, and a
  // write to a destroyed socket raises on the response object. Both are normal
  // here, so neither is allowed to take the process down.
  res.on('error', () => {});
  const open = () => !res.writableEnded && !res.destroyed;
  const send = (event, data) => {
    if (open()) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('start', { conversationId: cid });

  const controller = new AbortController();
  let stopReason = null; // 'idle' | 'total' | 'client'
  const stop = (reason) => { stopReason = reason; controller.abort(); };

  let idleTimer = null;
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('idle'), CHAT_IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => stop('total'), CHAT_TOTAL_TIMEOUT_MS);
  const heartbeat = setInterval(() => { if (open()) res.write(': ping\n\n'); }, CHAT_HEARTBEAT_MS);
  // The browser closing the tab or pressing stop should not leave a generation
  // running against the developer's rate limit.
  res.on('close', () => { if (!res.writableEnded) stop('client'); });
  bumpIdle();

  let answer = '';
  let truncated = false;
  let announcedThinking = false;
  // Stays null when telemetry is off, which is what keeps it out of the `done`
  // payload without a second flag being consulted at the point of sending.
  let telemetry = null;
  try {
    const upstream = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: usesVision ? VISION_MODEL : mode,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...modelMessages],
        stream: true,
        // Asks for a final frame carrying token counts. It arrives with an
        // empty `choices`, which the loop below already skips, so it changes
        // what is measured and not what is rendered. `drop_params: true` in
        // litellm/config.yaml removes it for any provider that cannot take it,
        // rather than failing the turn.
        ...(CHAT_TELEMETRY ? { stream_options: { include_usage: true } } : {}),
        user: req.user.id
      }),
      signal: controller.signal
    });
    if (!upstream.ok || !upstream.body) {
      const raw = await upstream.text().catch(() => '');
      let data; try { data = JSON.parse(raw); } catch { data = {}; }
      throw new Error(data?.error?.message || data?.detail?.error || data?.detail || raw.slice(0, 500) || `Gateway ${upstream.status}`);
    }
    // After the failure check, so a rejected turn cannot be counted as a served
    // one in the provider distribution.
    if (CHAT_TELEMETRY) telemetry = gatewayTelemetry(upstream);

    for await (const payload of sseData(upstream.body)) {
      bumpIdle();
      if (payload === '[DONE]') break;
      let frame; try { frame = JSON.parse(payload); } catch { continue; }
      // LiteLLM reports a mid-stream provider failure inside the stream, where
      // it would otherwise be swallowed as a short answer.
      if (frame.error) throw new Error(frame.error?.message || String(frame.error));
      // Before the `choices` guard below, because the frame carrying token
      // counts has no choices at all and would otherwise be skipped unread.
      readStreamTelemetry(telemetry, frame);
      const choice = frame.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      // Reasoning is the model's scratchpad, not its answer. The fact that it is
      // reasoning is worth showing; the text of it is not, so only the status
      // goes out, once.
      if (delta.reasoning && !announcedThinking) { announcedThinking = true; send('thinking', {}); }
      if (delta.content) {
        answer += delta.content;
        send('delta', { text: delta.content });
      }
      if (choice.finish_reason === 'length') truncated = true;
    }

    if (stopReason === 'client') throw new Error('CLIENT_CLOSED');
    if (!answer.trim()) {
      // Reaching here means the whole output allowance went on reasoning.
      // Saying so is more useful than storing an empty turn nobody can act on.
      throw new ChatUserError('The model spent its whole output allowance on reasoning and returned no answer. Try Fast or Code mode, or ask for a shorter answer.');
    }

    db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES(?,?,?,?)').run(crypto.randomUUID(), cid, 'assistant', answer);
    db.prepare('UPDATE jsan_conversations SET updated_at=? WHERE id=?').run(nowIso(), cid);
    // `telemetry` is additive and absent when the flag is off. The browser
    // reads conversationId and truncated and ignores the rest, so this is for
    // the load harness; developers still see one set of modes and never which
    // provider served them.
    send('done', { conversationId: cid, truncated, ...(telemetry ? { telemetry } : {}) });
  } catch (e) {
    // A partial answer is worth keeping: the developer watched it arrive, and
    // losing it on a dropped connection is worse than storing it unfinished.
    if (stopReason === 'client' && answer.trim()) {
      try {
        db.prepare('INSERT INTO jsan_messages(id,conversation_id,role,content) VALUES(?,?,?,?)').run(crypto.randomUUID(), cid, 'assistant', answer);
        db.prepare('UPDATE jsan_conversations SET updated_at=? WHERE id=?').run(nowIso(), cid);
      } catch (saveError) {
        console.error('Could not save the partial answer:', saveError.message);
      }
    } else {
      discardTurn();
      if (stopReason !== 'client') {
        const timedOut = stopReason === 'idle' || stopReason === 'total';
        console.error('Chat failed:', timedOut ? `stream ${stopReason} timeout` : e.message);
        send('error', {
          error: timedOut
            ? 'The model stopped responding. Try again, or use Fast mode for a quicker answer.'
            : e instanceof ChatUserError ? e.message
            : cleanError(e, 'AI is unavailable right now. Try again shortly.'),
          conversationDiscarded
        });
      }
    }
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    clearInterval(heartbeat);
    if (open()) res.end();
  }
});

app.get('/api/usage/me', auth, async (req, res) => {
  try {
    const key = decryptKey(req.user);
    const info = await litellmFetch('/user/info', { key, timeout: 10000 });
    const userInfo = info?.user_info || info?.user || info || {};
    res.json({
      spend: Number(userInfo.spend || 0),
      maxBudget: userInfo.max_budget == null ? null : Number(userInfo.max_budget),
      budgetDuration: userInfo.budget_duration || null,
      models: DEV_MODELS,
      rpmLimit: userInfo.rpm_limit || DEV_RPM_LIMIT || null,
      tpmLimit: userInfo.tpm_limit || DEV_TPM_LIMIT || null
    });
  } catch (e) {
    console.error('Usage lookup failed:', e.message);
    res.status(502).json({ error: 'Usage is temporarily unavailable' });
  }
});

app.get('/api/tools/config', auth, (_req, res) => {
  const base = String(process.env.PUBLIC_BASE_URL || 'https://ai.jsanconsulting.com').replace(/\/$/, '');
  res.json({
    baseUrl: `${base}/v1`,
    codex: `model = "code"\nmodel_provider = "jsan"\n\n[model_providers.jsan]\nname = "JSAN Dev AI"\nbase_url = "${base}/v1"\nenv_key = "JSAN_AI_KEY"\nwire_api = "responses"`,
    claude: `export ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=<your developer key>\nclaude`,
    env: `OPENAI_BASE_URL=${base}/v1\nOPENAI_API_KEY=<your developer key>`,
    curl: `curl ${base}/v1/models -H "Authorization: Bearer <your developer key>"`
  });
});

// Document generation (PDF -> PPTX today). Auth, metering and the model call
// are injected so the feature stays self-contained under src/documents and can
// be given a second generator without either file knowing about the other.
//
// modelKeyFor is decryptKey unchanged: every account here holds a personal
// virtual key - registration fails rather than writing a row without one - so a
// conversion is metered against the developer who asked for it, exactly as
// their chat turns are. The key is read server-side and never leaves it.
app.use('/api/documents', createDocumentRoutes({
  auth,
  // Express expands an array in place, so the router's single `limiter` slot
  // carries both the per-minute cap and the concurrency slot. A conversion is
  // a PDF parse plus a model call, so it counts against the same two-at-once
  // allowance as a chat turn rather than running beside it uncounted.
  limiter: [documentLimiter, byUser],
  callModel,
  modelKeyFor: decryptKey
}));

const staticDir = path.resolve(__dirname, '../../frontend/dist');
// Public developer API edge. LiteLLM itself stays private on Railway.
// This preserves streaming and lets Codex / Claude Code / SDKs use one JSAN domain.
app.use('/v1', byApiKey, async (req, res) => {
  try {
    const upstreamUrl = `${LITELLM_BASE_URL}/v1${req.originalUrl.slice('/v1'.length)}`;
    const headers = {};
    for (const name of ['authorization', 'content-type', 'anthropic-version', 'anthropic-beta', 'openai-organization', 'openai-project']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const body = hasBody && req.body != null
      ? (Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body))
      : undefined;
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    res.status(upstream.status);
    for (const [name, value] of upstream.headers.entries()) {
      if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding'].includes(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  } catch (error) {
    console.error('Gateway proxy failed:', error.message);
    if (!res.headersSent) res.status(502).json({ error: 'AI gateway is temporarily unavailable' });
    else res.end();
  }
});

app.use(express.static(staticDir, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

// Single-page fallback: an address a developer can navigate to is answered with
// index.html, because the portal's pages are state inside one document rather
// than routes this server knows about.
//
// A path that names a file is exempt, and that exemption is the point.
// express.static has already looked for it and not found it, so answering with
// index.html would return HTML under a .js, .png or .ico name - a 200 hiding a
// 404. That is how a missing favicon becomes a blank tab instead of an error
// somebody can see: every browser asks for /favicon.ico whether or not the page
// links to one, and a 200 carrying HTML is read as a broken icon and cached as
// one. The same fallback turns a mis-hashed bundle into "Unexpected token '<'"
// rather than "not found". Missing files now 404, which is what they are.
const PATH_NAMES_A_FILE = /\.[a-z0-9]+$/i;
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || PATH_NAMES_A_FILE.test(req.path)) return next();
  res.sendFile(path.join(staticDir, 'index.html'));
});

// A virtual key is scoped to a fixed list of model names when it is issued, so
// keys handed out before `see` existed would be refused the vision route and
// screenshots would fail for exactly the developers who have been here longest.
// Run once at boot: idempotent, bounded by the seat cap, and a failure is logged
// rather than fatal, since text still works without it.
async function widenKeyScopes() {
  // Deactivated accounts are skipped: their key was deleted at LiteLLM when the
  // seat was given up, so widening it would fail on every boot for an account
  // that is meant to have no access at all.
  const users = db.prepare(`SELECT u.id,u.email,u.litellm_key_ciphertext,u.litellm_key_iv,u.litellm_key_tag
    FROM jsan_users u
    WHERE NOT EXISTS (SELECT 1 FROM jsan_disabled_users d WHERE d.user_id = u.id)`).all();
  if (!users.length) return;
  let updated = 0;
  for (const user of users) {
    try {
      await litellmFetch('/key/update', { method: 'POST', body: { key: decryptKey(user), models: KEY_MODELS } });
      updated++;
    } catch (e) {
      console.error(`Could not widen the key scope for ${user.email}:`, e.message);
    }
  }
  console.log(`Developer keys scoped to [${KEY_MODELS.join(', ')}]: ${updated}/${users.length}`);
}

// Bring the declared accounts into existence, and back into agreement with the
// configured password where they have drifted from it. Same contract as
// widenKeyScopes: runs once at boot, is idempotent, and logs a failure rather
// than raising it, since the rest of the portal works without it and the next
// boot tries again — which matters because LiteLLM may still be starting.
//
// The password is reapplied rather than left alone because this portal has no
// change-password route: configuration is the only source of truth for these
// accounts, so agreeing with it is what makes the credentials work on every
// run instead of only on the one where the row was first written.
async function ensureSeedAccounts() {
  if (!SEED_ACCOUNTS.length) return;
  let created = 0, restored = 0, failed = 0;
  for (const account of SEED_ACCOUNTS) {
    try {
      const existing = db.prepare('SELECT * FROM jsan_users WHERE email=?').get(account.email);
      if (existing) {
        if (await bcrypt.compare(account.password, existing.password_hash)) continue;
        db.prepare('UPDATE jsan_users SET password_hash=? WHERE id=?')
          .run(await bcrypt.hash(account.password, 12), existing.id);
        restored++;
        console.log(`Seed account ${account.email}: password restored from configuration`);
        continue;
      }
      const id = crypto.randomUUID();
      const provision = await provisionLiteLLMUser({ id, name: account.name, email: account.email });
      try {
        const passwordHash = await bcrypt.hash(account.password, 12);
        const encrypted = encryptText(provision.key);
        db.prepare(`INSERT INTO jsan_users(id,name,email,password_hash,litellm_user_id,litellm_key_ciphertext,litellm_key_iv,litellm_key_tag)
          VALUES(?,?,?,?,?,?,?,?)`)
          .run(id, account.name, account.email, passwordHash, provision.litellmUserId,
               encrypted.ciphertext, encrypted.iv, encrypted.tag);
      } catch (e) {
        // The virtual key exists by this point; an insert that fails would
        // otherwise leave it usable with no account behind it.
        await revokeLiteLLMUser(provision);
        throw e;
      }
      created++;
      console.log(`Seed account ${account.email}: created`);
    } catch (e) {
      failed++;
      console.error(`Could not reconcile the seed account ${account.email}:`, e.message);
    }
  }
  console.log(`Seed accounts: ${SEED_ACCOUNTS.length} declared, ${created} created, ${restored} restored, ${failed} failed`);
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`JSAN Dev AI listening on ${PORT} - database ${databasePath()}`);
  // After listen, never before it: the healthcheck must not wait on LiteLLM.
  // Seeding runs first so an account created now is counted by the scope pass.
  await ensureSeedAccounts();
  widenKeyScopes();
});
