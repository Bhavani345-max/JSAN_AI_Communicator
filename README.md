# JSAN Dev AI — Railway Production Edition

Production-oriented Railway package for the 20-seat JSAN developer AI gateway.

## Services

1. `portal` — JSAN Dev AI web UI + API + public `/v1` gateway edge.
2. `litellm` — private LiteLLM gateway; no public domain required.
3. `Postgres` — Railway PostgreSQL for LiteLLM persistence. The portal keeps its own state in SQLite on an attached volume.

## Layout

```
portal/            the public service - one image serving all three
├── frontend/      Vite + React UI
├── backend/       Express API and the /v1 gateway edge
├── database/      @jsan/database - SQLite store the backend reads and writes
└── scripts/       operational tooling, not shipped in the image
litellm/           private LiteLLM gateway config
```

The frontend and backend ship in a single container: the Dockerfile builds
`frontend/` and copies the bundle into the runtime image that runs the Express
server, which serves it as static files.

`POST /api/chat` answers with Server-Sent Events rather than a single JSON body.
A real engineering answer from these models runs for minutes, so the browser
renders it as it arrives instead of waiting — and a turn that fails is rolled
back rather than left in the history as a question with nothing under it. The
public `/v1` edge is untouched: it proxies LiteLLM directly and streams whatever
the calling tool asked for.

A question carrying a screenshot is routed to a vision model automatically — the
four modes are text-only — and the image is stored beside the message rather than
inside it, so reopening a conversation shows the picture and not a megabyte of
base64. Answers render each code block with its own download control. Read the
free-tier request ceiling in `RAILWAY_DEPLOYMENT_GUIDE.md` before putting a team
on this.

Anyone with the team access code can register from the sign-in screen, which
asks for a username, work email, and the password twice. Three wrong passwords
lock that address for 30 minutes; the count lives in the database rather than in
process memory, so restarting the portal does not hand the allowance back.

One developer may have two model calls running at once — `/api/chat`,
`/api/documents` and `/v1` draw on the same allowance, and the third simultaneous
call is refused with a `429` rather than queued. The per-minute limits cap how
often a turn may *start*; this caps how many run together, which is the one a
coding agent looping on `/v1` would otherwise exhaust on everyone else's behalf.
Unlike the lockout counter above, this one is deliberately in process memory: a
restart drops the in-flight requests it was counting, so the tally should go with
them. That makes it correct only while the portal runs as a single replica —
see `RAILWAY_DEPLOYMENT_GUIDE.md` before scaling out. Set
`MAX_CONCURRENT_REQUESTS_PER_USER` to change it.

Run the two backing services locally with
`docker compose -f docker-compose.local.yml up -d`.

Then start the portal from `portal/` with `npm run dev`, which runs the API on
8080 and the UI on 5173 together and stops both on one Ctrl+C. Open
`http://localhost:5173` — the dev server proxies `/api` and `/v1` through to the
backend, so the UI works from there and not from 8080. `npm run dev:backend` and
`npm run dev:frontend` run either half alone, which is also how to get Vite's
interactive shortcuts back; `npm run dev` cannot offer them, because two
processes cannot share one terminal's input.

None of the `dev` scripts install dependencies — a restart should not pay for
that every time. After cloning, run `npm run check:backend && npm run
check:frontend` once; `npm run dev` checks for this and says so rather than
failing somewhere inside a child process.

Only `portal` is public. Use `https://ai.jsanconsulting.com` for the UI and `https://ai.jsanconsulting.com/v1` for developer tools.

Start with `RAILWAY_DEPLOYMENT_GUIDE.md`.
