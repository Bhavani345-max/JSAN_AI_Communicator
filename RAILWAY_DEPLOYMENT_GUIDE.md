# Railway deployment — owner runbook

## 1. Create the production project
Create a Railway **Pro** project named `JSAN Dev AI` and a `production` environment. Keep staging separate if you add it later.

## 2. Add PostgreSQL
Add Railway PostgreSQL from `+ New`. It serves **LiteLLM only** — the portal keeps its own state in SQLite. Keep it private; LiteLLM uses its reference variable. Enable daily backups before inviting users; enable PITR when this becomes business-critical.

## 3. Deploy LiteLLM
Create a service named exactly `litellm` from this repository and set **Root Directory** to `/litellm`.

Add variables from `litellm/.env.railway.example`. Generate the master and salt keys locally. Never change `LITELLM_SALT_KEY` after provider credentials have been stored.

Do **not** generate a public domain for LiteLLM. Its Railway healthcheck is `/health/readiness`.

## 4. Deploy the JSAN portal
Create a service named `portal` from the same repository and set **Root Directory** to `/portal`.

Attach a **volume** to the service and mount it at `/data`, then set `SQLITE_PATH=/data/jsan.db`. The container filesystem is ephemeral, so without a volume every deploy starts from an empty database and all accounts are lost.

Add variables from `portal/.env.railway.example`. Railway reference variables connect it privately to LiteLLM.

The portal listens on Railway's injected `PORT`. Healthcheck: `/api/health`.

### Fair use between developers
`MAX_CONCURRENT_REQUESTS_PER_USER` (default `2`) caps how many model calls one developer may have **running at once**, across `/api/chat`, `/api/documents` and the public `/v1` edge. `DEVELOPER_RPM_LIMIT` caps how often a turn may *start*; neither of them caps how many are in flight, and the two do different jobs.

This exists because of `/v1`. A coding agent looping against the gateway opens requests faster than they finish, so a per-minute count alone lets one session hold every upstream slot the shared provider quota allows — which, on the free tier described in section 6, is the whole team's daily allowance. Two at once covers a developer chatting while their agent works; a third concurrent call gets a plain `429` with `"code":"concurrency_limit"` and a `Retry-After` header, before any streaming headers are sent.

Raise it if normal work is being refused. The floor is 1 — a value of `0`, a negative number or a typo falls back to the default rather than disabling the cap, because an unlimited gateway is the failure this protects against.

## 5. Add the public domain
On `portal` only: Settings → Networking → Custom Domain → `ai.jsanconsulting.com`.

Create the CNAME/TXT DNS records Railway gives you. Railway provisions and renews TLS automatically.

Do not expose PostgreSQL or LiteLLM publicly for normal operation.

## 6. Provider onboarding
All four logical groups run on OpenRouter free-tier models, so one OpenRouter key is the only provider credential needed:
- `auto` — Nemotron 3 Super 120B
- `code` — Poolside Laguna S 2.1
- `think` — Nemotron 3 Ultra 550B
- `fast` — Nemotron 3.5 Lightning
- `see` — Nemotron Nano 12B VL (images; selected automatically, never by hand)

A fifth route, `see`, is not a mode anyone selects: the portal switches to it by itself whenever a question carries an image, because the four above are text-in, text-out and cannot be handed a screenshot. It runs on `nvidia/nemotron-nano-12b-v2-vl:free` with `nemotron-3-nano-omni-30b-a3b-reasoning:free` behind it. No model on OpenRouter that *generates* images is free, so the portal cannot produce one; that would need credit and a paid route.

**Measured on 2026-08-18, and the blocker for this pilot:** the OpenRouter free tier allows **50 free-model requests per day for the whole account**, not per developer — verified from a live `429`, which reports `X-RateLimit-Limit: 50`. Across 20 seats that is 2.5 questions per developer per day, which is not a usable service. Adding **$10 of credit raises it to 1000/day** (50 per developer per day), which is. Decide this before inviting the team; free models stay free per token either way, the credit only lifts the request ceiling. Moving a mode to a paid model or a direct provider key is a one-line change in `litellm/config.yaml`.

Models can be stored in LiteLLM's DB (`STORE_MODEL_IN_DB=True`). If you need the LiteLLM Admin UI during maintenance, expose it only temporarily or put it behind your organization's access control; remove public exposure when finished. Never share the master key with developers.

## 7. Registration
Open `https://ai.jsanconsulting.com`, register the owner/test account with the team access code, then verify:
- login/logout
- conversation persistence
- Auto / Code / Think / Fast
- developer key display/rotation
- `/v1/models`
- Codex configuration
- Claude Code configuration

Only then invite the remaining developers. The portal stops new registration at 20 users.

## 8. Production settings
For the 20-user pilot:
- Portal: **exactly 1 replica** — two independent reasons now, and both must be answered before scaling out. First, SQLite allows a single writer on a single node, so a second replica would run against its own copy of the database. Second, the `MAX_CONCURRENT_REQUESTS_PER_USER` guard counts in-flight requests in process memory, so N replicas would grant each developer N times the intended allowance and the `/v1` protection would quietly weaken in proportion. Scale up rather than out; moving to Postgres fixes only the first reason, and the guard would need shared state (Redis, or LiteLLM's own per-key limits) before a second replica is safe. 0.5–1 vCPU / 512 MB–1 GB is normally enough.
- LiteLLM: 1 replica initially; 1 vCPU / 1–2 GB.
- PostgreSQL: Railway default, with backups enabled.
- Restart policy: On Failure.
- Healthchecks: enabled on both application services.
- Set Railway cost alerts and a hard limit only if you accept the risk that Railway will stop workloads at that limit.

Scale based on measured CPU/memory/latency rather than pre-allocating VM-sized resources.

## 9. Production smoke tests
```bash
curl -fsS https://ai.jsanconsulting.com/api/health
curl -fsS https://ai.jsanconsulting.com/v1/models \
  -H "Authorization: Bearer <developer-key>"
```

Then send one request through each logical mode.

Confirm the concurrency guard is actually in force — a misconfigured value fails open-looking, in that everything still answers, so it has to be tested rather than assumed. Fire three long requests at once with one developer key and expect the third to be refused:

```bash
for i in 1 2 3; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    https://ai.jsanconsulting.com/v1/chat/completions \
    -H "Authorization: Bearer <developer-key>" \
    -H "Content-Type: application/json" \
    -d '{"model":"think","messages":[{"role":"user","content":"Explain CAP in depth."}]}' &
done; wait
```

Two `200`s and one `429` is correct at the default of 2. Three `200`s means the guard is not applying — check the variable is set on the service and that the portal is on one replica.

`portal/scripts/load-test.mjs` drives the same path through the browser API for a staged run; read its header first, because a run with fewer accounts than sessions measures the guard refusing the surplus rather than N distinct developers.

### Staged concurrency report
```bash
PORTAL_BASE_URL=https://ai.jsanconsulting.com \
  node portal/scripts/load-test.mjs --stages 5,10,20 --turns 2
```

Per stage it reports success rate, 429s split by which limiter refused them, average and P95 latency, token usage, which deployment served what share, and how many turns the router retried or fell back. It also probes `/v1/models`, `/v1/chat/completions`, `/v1/responses` (Codex) and `/v1/messages` (Claude Code) once before the load, since those never touch `/api/chat` and a clean chat run says nothing about them.

The last four figures depend on `CHAT_TELEMETRY` being on in the portal — it is by default — and on the LiteLLM build setting `x-litellm-*` response headers. Where either is missing, the report prints **"not reported"** rather than `0`. Treat that literally: it means nothing measured, not that the router never fell back. Confirm which you are looking at before quoting a fallback count.

Twenty genuinely distinct developers needs twenty seats on the environment under test. With fewer accounts than sessions the surplus is refused by the concurrency guard — correct behaviour, and reported as such, but not a test of twenty developers. Say which of the two you ran when quoting the numbers.

## 10. Release discipline
Use a Git repository. Protect `main`; deploy production from reviewed commits/tags. Keep provider secrets only in Railway Variables. Do not commit `.env` files. Use a staging environment for gateway upgrades/provider changes before production.
