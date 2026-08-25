#!/usr/bin/env node
/**
 * Staged concurrency harness for the JSAN Dev AI portal.
 *
 * Drives N simulated developers through the portal's own /api/chat path -
 * cookie session, SSE stream, the concurrency guard, the per-minute limiter -
 * and reports what the run actually did. It measures the portal and whatever
 * gateway is behind it; it does not simulate a provider.
 *
 * Reports per stage: success rate, 429s split by which limiter refused them,
 * average and P95 latency, token usage, which deployment served what share,
 * and how many turns the router had to retry or fall back to complete. It also
 * probes the /v1 surface once before the load, because Codex and Claude Code
 * never touch /api/chat and a clean chat run says nothing about them.
 *
 * The last four of those come from the portal's per-turn telemetry, which needs
 * CHAT_TELEMETRY on (its default) in the portal, and a LiteLLM build that sets
 * the x-litellm-* response headers. Where either is missing the figure prints
 * as "not reported" rather than as a zero - an unmeasured number and a measured
 * zero are different claims, and only one of them belongs in a pilot report.
 *
 * Accounts come from ACCOUNTS_JSON (a JSON array of {email, password}) or, if
 * that is unset, from SEED_ACCOUNTS in portal/.env. Sessions are spread across
 * whatever accounts exist, round-robin. If there are fewer accounts than the
 * stage's session count the run is still valid load on the gateway, but it is
 * NOT a test of N distinct developers: the per-developer concurrency guard
 * will refuse the surplus, which is the correct behaviour and is reported as
 * such. Say which of the two you ran when quoting these numbers.
 *
 *   node scripts/load-test.mjs --stages 5,10,20 --turns 2
 *   ACCOUNTS_JSON='[{"email":"...","password":"..."}]' node scripts/load-test.mjs
 *
 * Twenty genuinely distinct developers needs twenty seats on the deployed
 * environment. Registering them against a local database consumes MAX_USERS
 * and issues twenty real virtual keys, so this script deliberately does not
 * create accounts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PORTAL_BASE_URL || 'http://localhost:8080';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const STAGES = String(arg('stages', '5,10,20')).split(',').map(Number).filter(Boolean);
const TURNS = Number(arg('turns', 2));
const MODE = arg('mode', 'fast');
const PROMPT = arg('prompt', 'Reply with only the word OK.');

function loadAccounts() {
  if (process.env.ACCOUNTS_JSON) return JSON.parse(process.env.ACCOUNTS_JSON);
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) throw new Error('No ACCOUNTS_JSON and no portal/.env to read SEED_ACCOUNTS from');
  const raw = fs.readFileSync(envPath, 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('SEED_ACCOUNTS='));
  if (!line) throw new Error('SEED_ACCOUNTS not found in portal/.env');
  return JSON.parse(line.slice('SEED_ACCOUNTS='.length));
}

async function login({ email, password }) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** One chat turn. Never throws: a failed turn is a data point, not a crash. */
async function turn(cookie, message) {
  const started = Date.now();
  const out = {
    ok: false, status: 0, ms: 0, chars: 0, deltas: 0,
    refusedConcurrency: false, rateLimited: false, streamError: null, cid: null,
    // Null means the portal reported nothing for this turn - either
    // CHAT_TELEMETRY is off or the gateway did not say. It is kept distinct
    // from a reported zero throughout, so the report never presents a gap in
    // instrumentation as a measurement of "never fell back".
    telemetry: null,
  };
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ message, mode: MODE }),
    });
    out.status = res.status;
    if (res.status !== 200) {
      const body = await res.json().catch(() => ({}));
      out.refusedConcurrency = body?.code === 'concurrency_limit';
      out.rateLimited = res.status === 429 && !out.refusedConcurrency;
      out.ms = Date.now() - started;
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const p of parts) {
        const ev = (p.match(/^event: (.+)$/m) || [])[1];
        const dm = (p.match(/^data: (.*)$/m) || [])[1];
        if (!ev || dm === undefined) continue;
        let d; try { d = JSON.parse(dm); } catch { continue; }
        if (ev === 'delta') { out.deltas++; out.chars += (d.text || '').length; }
        if (ev === 'start') out.cid = d.conversationId;
        if (ev === 'done') { out.ok = true; out.cid = d.conversationId; out.telemetry = d.telemetry || null; }
        if (ev === 'error') out.streamError = d.error;
      }
    }
  } catch (e) {
    out.streamError = e.message;
  }
  out.ms = Date.now() - started;
  return out;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

/**
 * Deployment id -> the provider/model string it stands for.
 *
 * LiteLLM identifies the deployment that served a turn by an opaque hash, not
 * by name: `x-litellm-model-id` comes back as 6611ee36d91b… and the `model`
 * field on the stream is the mode name the caller asked for ("fast"), not the
 * model behind it. Grouping the report by either would produce a provider
 * distribution that names no provider. /v1/model/info carries the mapping and
 * accepts a developer virtual key, so one call at startup turns the hashes back
 * into openrouter/… and cerebras/… .
 *
 * Left empty if that call fails, in which case the raw id is printed. An
 * unresolved hash is ugly but true; substituting the mode name would put a
 * label in the provider column that is not a provider.
 */
const deployments = new Map();

async function loadDeployments(apiKey) {
  if (!apiKey) return;
  try {
    const res = await fetch(`${BASE}/v1/model/info`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return;
    const { data } = await res.json();
    for (const entry of data || []) {
      const id = entry?.model_info?.id;
      const name = entry?.litellm_params?.model;
      if (id && name) deployments.set(id, name);
    }
  } catch { /* the raw ids still identify distinct deployments, just not by name */ }
}

/** The developer virtual key behind a session, or null if it cannot be read. */
async function developerKey(cookie) {
  try {
    const res = await fetch(`${BASE}/api/me/api-key`, { headers: { Cookie: cookie } });
    if (!res.ok) return null;
    return (await res.json()).apiKey || null;
  } catch { return null; }
}

/**
 * Roll per-turn gateway telemetry into the figures the pilot report asks for:
 * token usage, which deployment served what share, and how often the router
 * retried or fell back.
 *
 * Every figure carries how many turns it was drawn from, because these are only
 * as good as the gateway's headers. A fallback count of 0 over 0 reporting
 * turns means nobody measured; the same 0 over 40 means the router genuinely
 * never fell back. Collapsing those into a bare "0" is exactly how a load
 * report ends up asserting something it never tested, so where nothing was
 * reported this says so in words instead of printing a number.
 */
function summariseTelemetry(results) {
  const withTel = results.filter((r) => r.telemetry);
  const providers = {};
  let promptTokens = 0, completionTokens = 0, totalTokens = 0, usageReportedBy = 0;
  let fellBack = 0, retried = 0, routingReportedBy = 0;

  for (const { telemetry: t } of withTel) {
    // Resolved name first, raw deployment id second, and only then the stream's
    // `model`. That order matters: on LiteLLM `model` is the mode the caller
    // asked for, so promoting it would fill the provider column with "fast"
    // and read as though a provider called fast had served the turn.
    // 'unreported' keeps an unlabelled turn in the denominator rather than
    // silently dropping it.
    const who = (t.modelId && deployments.get(t.modelId)) || t.modelId || t.model || 'unreported';
    providers[who] = (providers[who] || 0) + 1;

    if (t.usage && t.usage.totalTokens != null) {
      usageReportedBy++;
      promptTokens += t.usage.promptTokens || 0;
      completionTokens += t.usage.completionTokens || 0;
      totalTokens += t.usage.totalTokens || 0;
    }
    if (t.attemptedFallbacks != null || t.attemptedRetries != null) {
      routingReportedBy++;
      if ((t.attemptedFallbacks || 0) > 0) fellBack++;
      if ((t.attemptedRetries || 0) > 0) retried++;
    }
  }

  return {
    telemetryReportedBy: `${withTel.length}/${results.length} successful turns`,
    providerDistribution: Object.keys(providers).length ? providers : 'not reported by the gateway',
    tokens: usageReportedBy
      ? { promptTokens, completionTokens, totalTokens, reportedBy: `${usageReportedBy}/${results.length}` }
      : 'not reported by the gateway',
    routing: routingReportedBy
      ? { turnsThatFellBack: fellBack, turnsThatRetried: retried, reportedBy: `${routingReportedBy}/${results.length}` }
      : 'not reported by the gateway',
  };
}

async function stage(sessions, cookies, accountCount) {
  const label = `${sessions} concurrent sessions across ${accountCount} account(s), ${TURNS} turn(s) each`;
  console.log(`\n--- STAGE: ${label} ---`);
  const t0 = Date.now();
  const results = (await Promise.all(
    Array.from({ length: sessions }, async (_, s) => {
      const cookie = cookies[s % cookies.length];
      const rs = [];
      // Carry the session's cookie on each result. Cleanup below deletes with
      // it rather than re-deriving it from an array index: results are
      // flattened across turns and then filtered to those that produced a
      // conversation, so by that point the index no longer identifies the
      // session, and deleting with another account's cookie matches no row -
      // leaving the test conversation in the database.
      for (let t = 0; t < TURNS; t++) rs.push({ ...await turn(cookie, `${PROMPT} (s${s + 1} t${t + 1})`), cookie });
      return rs;
    }),
  )).flat();
  const wall = Date.now() - t0;

  const total = results.length;
  const ok = results.filter((r) => r.ok);
  const conc = results.filter((r) => r.refusedConcurrency);
  const rl = results.filter((r) => r.rateLimited);
  const other = results.filter((r) => !r.ok && !r.refusedConcurrency && !r.rateLimited);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);

  const row = {
    stage: label,
    totalRequests: total,
    successful: ok.length,
    failed: total - ok.length,
    successRatePct: total ? Number(((ok.length / total) * 100).toFixed(1)) : 0,
    refusedByConcurrencyGuard: conc.length,
    refusedByRateLimiter: rl.length,
    otherFailures: other.length,
    otherFailureSamples: [...new Set(other.map((r) => r.streamError || `HTTP ${r.status}`))].slice(0, 3),
    avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    p95LatencyMs: lat.length ? pct(lat, 0.95) : null,
    answeredChars: ok.reduce((a, r) => a + r.chars, 0),
    // Drawn from successful turns only: a refused or failed turn consumed no
    // provider tokens and was served by nobody, so counting it would dilute
    // both the token totals and the provider shares.
    ...summariseTelemetry(ok),
    wallClockMs: wall,
  };
  console.log(JSON.stringify(row, null, 2));

  // Leave no test conversations behind.
  await Promise.all(results.filter((r) => r.cid).map((r) =>
    fetch(`${BASE}/api/conversations/${r.cid}`, { method: 'DELETE', headers: { Cookie: r.cookie } }).catch(() => {})));
  return row;
}

/**
 * Exercise the developer-facing /v1 surface the way the configured tools
 * actually address it.
 *
 * The staged runs drive /api/chat, which is the browser's path. Codex, Claude
 * Code and the SDKs never touch it - they go straight to /v1 with a virtual
 * key, through a different route, a different limiter and a different identity
 * (the key hash rather than the user row). A clean chat run therefore says
 * nothing about whether those tools work, which is why item 8 asks about them
 * separately.
 *
 * The endpoint differs per tool, and /api/tools/config is what tells each one
 * where to go: Codex is handed wire_api = "responses" and calls /v1/responses,
 * Claude Code is pointed at the portal root and calls /v1/messages, and SDKs
 * and curl use /v1/chat/completions. A 404 on one of these normally means the
 * gateway behind the portal does not implement that API rather than that the
 * portal is broken - worth knowing before a developer is told to configure it.
 *
 * Probes run one at a time on purpose. Fired together they would trip the
 * per-key concurrency guard and report a 429 that says nothing about whether
 * the surface works.
 */
async function toolSurfaceProbe(apiKey) {
  if (!apiKey) {
    return [{ surface: 'developer virtual key', status: 0, ms: 0, totalTokens: null,
      note: 'key could not be read, so every /v1 probe was skipped' }];
  }
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const messages = [{ role: 'user', content: PROMPT }];

  const probes = [
    ['GET /v1/models (all tools)', () => fetch(`${BASE}/v1/models`, { headers })],
    ['POST /v1/chat/completions (SDK/curl)', () => fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ model: MODE, messages }) })],
    ['POST /v1/chat/completions streaming', () => fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ model: MODE, messages, stream: true }) })],
    ['POST /v1/responses (Codex)', () => fetch(`${BASE}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ model: MODE, input: PROMPT }) })],
    ['POST /v1/messages (Claude Code)', () => fetch(`${BASE}/v1/messages`, {
      method: 'POST', headers, body: JSON.stringify({ model: MODE, max_tokens: 64, messages }) })],
  ];

  const rows = [];
  for (const [surface, run] of probes) {
    const started = Date.now();
    try {
      const res = await run();
      const body = await res.text();
      let totalTokens = null;
      try { totalTokens = JSON.parse(body)?.usage?.total_tokens ?? null; } catch {}
      rows.push({
        surface, status: res.status, ms: Date.now() - started, totalTokens,
        note: res.ok ? '' : body.slice(0, 100).replace(/\s+/g, ' '),
      });
    } catch (e) {
      rows.push({ surface, status: 0, ms: Date.now() - started, totalTokens: null, note: e.message });
    }
  }
  return rows;
}

(async () => {
  const accounts = loadAccounts();
  const cookies = [];
  for (const a of accounts) cookies.push(await login(a));
  console.log(`portal: ${BASE}`);
  console.log(`accounts available: ${accounts.length}`);
  console.log(`mode: ${MODE}   turns per session: ${TURNS}`);
  if (Math.max(...STAGES) > accounts.length) {
    console.log(`\nNOTE: stages above ${accounts.length} reuse accounts. Those runs measure gateway`);
    console.log('load and the per-developer concurrency guard, NOT N distinct developers.');
  }
  // One key serves both: the /v1 probes authenticate with it, and the
  // deployment-name lookup needs it before any stage produces telemetry to
  // resolve.
  const apiKey = await developerKey(cookies[0]);
  await loadDeployments(apiKey);
  console.log(`deployment names resolved: ${deployments.size || 'none - provider column will show raw ids'}`);

  // Before the stages, so a failure here is read as "this surface is broken"
  // rather than "the gateway was saturated at the time".
  console.log('\n=== TOOL / API SURFACE (/v1), unloaded ===');
  console.table(await toolSurfaceProbe(apiKey));

  const rows = [];
  for (const s of STAGES) rows.push(await stage(s, cookies, accounts.length));

  console.log('\n=== SUMMARY ===');
  console.table(rows.map((r) => ({
    stage: r.stage, total: r.totalRequests, ok: r.successful, fail: r.failed,
    'success%': r.successRatePct, concurrency429: r.refusedByConcurrencyGuard,
    rate429: r.refusedByRateLimiter, other: r.otherFailures,
    avgMs: r.avgLatencyMs, p95Ms: r.p95LatencyMs,
    // 'n/r' rather than 0: see summariseTelemetry on why an unmeasured figure
    // must not be printed as a measured zero.
    tokens: typeof r.tokens === 'object' ? r.tokens.totalTokens : 'n/r',
    fellBack: typeof r.routing === 'object' ? r.routing.turnsThatFellBack : 'n/r',
  })));

  console.log('\n=== PROVIDER DISTRIBUTION PER STAGE ===');
  for (const r of rows) {
    console.log(`\n${r.stage}`);
    if (typeof r.providerDistribution === 'string') {
      console.log(`  ${r.providerDistribution}`);
    } else {
      for (const [who, n] of Object.entries(r.providerDistribution).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(4)}  ${who}`);
      }
    }
  }

  console.log('\nn/r = not reported by the gateway, which is not the same as zero.');
  console.log('If these are empty, check CHAT_TELEMETRY is on in the portal and that the');
  console.log('LiteLLM build in use sets the x-litellm-* response headers.');
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
