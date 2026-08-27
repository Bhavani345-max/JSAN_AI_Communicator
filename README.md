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

Registering from the sign-in screen asks for a username, work email, the
password twice, and a team access code. An account listed in `ADMIN_EMAILS`
gets an Admin page, which is where those codes come from. Paste in a whole
intake — one address per line, or comma-separated — and one submission cuts a
code each, bound so that only the named address can spend it; a bad line is
reported beside the codes rather than costing the rest of the list. Set how
many times a code may be used and when it lapses, then copy the ready-written
message for each developer. Leave the address box empty for a single code
anybody on the team may use.

The Admin page also answers the other direction: **Developers** lists everyone
with a seat beside the code that let them in, so an admin who is asked "what
was my code again?" can read it off months later. Every code is shown in full,
because a code nobody can look up is a code that has to be reissued; one
control blanks them all out for a screen share. Withdrawing a code refuses it
from that moment on without touching anybody else's, which the single shared
`REGISTRATION_ACCESS_CODE` could never do; that variable still works where it
is set, and leaving it unset makes issued codes the only way in.

Three wrong passwords lock that address for 30 minutes; the count lives in the
database rather than in process memory, so restarting the portal does not hand
the allowance back. An admin can lift a lockout from the Developers list rather
than leaving somebody to wait it out.

A forgotten password is recovered the same way a seat is granted. The portal
sends no email — there is no mail service behind it — so a self-service reset
link would have nowhere to go. Instead the admin issues a reset code from the
developer's row and passes it on, and the developer sets a new password on the
sign-in card under **Use a reset code**. The code is bound to one address, works
once, lapses after a day, and clears any lockout on the way through. Issuing a
second reset retires the first, so only one is ever live. Seeded accounts are
refused one: `ensureSeedAccounts` reapplies their configured password at every
boot, so a reset would quietly undo itself, and the page says so instead.

A password you still know is changed without involving an admin at all: the key
icon beside the theme toggle asks for the current one and sets a new one. That
route exists so an ordinary change does not have to become a reset code on a
chat thread, which is what asking an admin for one amounts to. The current
password is required even though the session already proves who is asking,
because a session is what somebody finds at an unlocked desk. A change also
retires any reset an admin had issued, so nothing is left behind as a spare key.

Deactivating a developer frees their seat and deletes their key at the gateway,
which are the two things a departure is actually about. Nothing is destroyed:
the account, its conversations and its messages stay exactly where they are, and
restoring returns the seat and issues a fresh key. That matters because
`MAX_USERS` counts seats, not accounts — without a way to give one back, a team
that has churned through twenty people could never admit a twenty-first. Admin
accounts are refused: deactivating the account you are signed in as would close
the Admin page behind you, so the address has to leave `ADMIN_EMAILS` first.

On a phone it is the same page, with a few things deliberately different. The
sidebar and the conversations list become drawers — opened from the bar across
the top, which is also the only place the JSAN mark appears at that width, and
closed by tapping beside them. Enter types a new line instead of sending,
because a phone keyboard has no Shift to hold and the send button is an inch
away; the composer says **Tap to send** rather than **Enter to send** so nobody
has to guess.

Deleting a conversation asks first. It is worth saying why: the control that
does it sits inside the row that opens the conversation, and it used to appear
only on hover — which on a touch screen means invisible, but still perfectly
tappable. An aimed-at row could delete instead of open, and there is no undo. It
is now visible, reaches the edge of the row, and asks.

Heights are measured in `dvh` rather than `vh`, so the composer is not left
underneath Chrome's address bar; the page cannot be pulled down to reload in the
middle of an answer arriving; and a message typed but not sent warns before
Android's back gesture leaves the site. The copy buttons fall back to an older
mechanism when the portal is reached over plain http — the clipboard API does
not exist outside a secure context, which is exactly the case the first time
somebody tries the portal from their phone on the office network.

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

The browser icons in `frontend/public` are generated rather than drawn:
`npm run icons` writes the SVG favicon, its PNG fallback and the iOS
home-screen icon from one description of the JSAN mark in
`frontend/scripts/icons.mjs`, so they cannot drift apart. Run it after changing
that file; the build itself does not, since the icons change about as often as
the logo does.

None of the `dev` scripts install dependencies — a restart should not pay for
that every time. After cloning, run `npm run check:backend && npm run
check:frontend` once; `npm run dev` checks for this and says so rather than
failing somewhere inside a child process.

Only `portal` is public. Use `https://ai.jsanconsulting.com` for the UI and `https://ai.jsanconsulting.com/v1` for developer tools.

Start with `RAILWAY_DEPLOYMENT_GUIDE.md`.
