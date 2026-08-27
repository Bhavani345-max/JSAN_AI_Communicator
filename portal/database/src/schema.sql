-- JSAN Dev AI — SQLite schema
--
-- Mirrors the PostgreSQL schema in src/server.js (initDb) so the same
-- application logic works against either engine.
--
-- Translation notes:
--   UUID          -> TEXT   (crypto.randomUUID() strings, as the app already generates)
--   TIMESTAMPTZ   -> TEXT   ISO-8601 UTC, e.g. 2026-08-18T13:56:12.345Z
--                           Same wire format as JSON.stringify(new Date()), lexically
--                           sortable, so ORDER BY created_at keeps working unchanged.
--   NOW()         -> strftime('%Y-%m-%dT%H:%M:%fZ','now')
--
-- STRICT tables reject values of the wrong type instead of silently coercing
-- them, which SQLite would otherwise do. ON DELETE CASCADE only fires when the
-- connection has `PRAGMA foreign_keys = ON` — sqlite.js sets it on every open.

CREATE TABLE IF NOT EXISTS jsan_schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS jsan_users (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  -- The app lowercases emails before writing; NOCASE makes that a guarantee
  -- rather than a convention, so two casings cannot both claim a seat.
  email                  TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash          TEXT NOT NULL,
  litellm_user_id        TEXT NOT NULL UNIQUE,
  litellm_key_ciphertext TEXT NOT NULL,
  litellm_key_iv         TEXT NOT NULL,
  litellm_key_tag        TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at          TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS jsan_conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES jsan_users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','code','think','fast')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE IF NOT EXISTS jsan_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES jsan_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- Images attached to a question. Kept out of jsan_messages.content because that
-- column is text the model is given verbatim, and because SQLite truncates a
-- TEXT value at its first NUL byte - which is 9 bytes into any PNG. The bytes
-- live here base64-encoded, and the message keeps only the developer's words.
CREATE TABLE IF NOT EXISTS jsan_message_images (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES jsan_messages(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- image/png, image/jpeg, image/webp or image/gif; the server rejects the rest.
  mime       TEXT NOT NULL,
  -- base64 payload only, with no `data:` prefix; the prefix is rebuilt on use.
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS jsan_message_images_message_idx
  ON jsan_message_images(message_id);

CREATE INDEX IF NOT EXISTS jsan_conversations_user_updated_idx
  ON jsan_conversations(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS jsan_messages_conversation_created_idx
  ON jsan_messages(conversation_id, created_at);

-- Failed sign-in tracking, so an account lockout survives a restart.
--
-- express-rate-limit, which guards the rest of the unauthenticated routes,
-- counts in memory. That is fine for smoothing bursts but wrong for a lockout:
-- restarting the process would hand an attacker a fresh allowance, and on
-- Railway a deploy does exactly that. This table is the durable half.
--
-- Keyed on the submitted email rather than a user id so an address with no
-- account behind it is counted the same way. Were unknown addresses skipped,
-- they would answer faster and never lock, and that difference is itself an
-- answer to "does this person have an account here?".
--
-- failures resets to 0 when the lock is applied, so a developer who waits out
-- a lockout gets the full allowance back rather than one attempt.
CREATE TABLE IF NOT EXISTS jsan_login_attempts (
  email          TEXT PRIMARY KEY COLLATE NOCASE,
  failures       INTEGER NOT NULL DEFAULT 0,
  -- ISO-8601 UTC, or NULL when the address is not locked.
  locked_until   TEXT,
  last_failed_at TEXT NOT NULL
) STRICT;

-- Team access codes an admin issues from the portal, one per developer.
--
-- REGISTRATION_ACCESS_CODE is a single shared string in the environment: every
-- developer types the same one, it cannot be withdrawn from one person without
-- withdrawing it from everybody, and changing it needs a redeploy. This table
-- is the per-person replacement — an admin generates a code, hands it to one
-- developer, and it stops working the moment they have used it.
--
-- The code is held two ways because two different jobs need it:
--
--   code_hash    SHA-256 hex, UNIQUE. What registration looks the code up by,
--                so a submitted code is matched in one indexed read rather
--                than by decrypting every row and comparing.
--   code_cipher* AES-256-GCM under KEY_ENCRYPTION_SECRET, same scheme the
--                developers' LiteLLM keys use. A hash alone would mean the
--                plaintext exists only in the response that created it, so an
--                admin who closed the tab before copying it would have to
--                issue another one. This lets them read it back.
--
-- assigned_email is what makes a code personal: when set, only that address
-- may spend it, so a code forwarded to somebody else is refused.
CREATE TABLE IF NOT EXISTS jsan_access_codes (
  id                TEXT PRIMARY KEY,
  code_hash         TEXT NOT NULL UNIQUE,
  code_ciphertext   TEXT NOT NULL,
  code_iv           TEXT NOT NULL,
  code_tag          TEXT NOT NULL,
  -- Enough of the code to recognise it in the list without revealing it.
  code_hint         TEXT NOT NULL,
  -- Free text from the admin: who it was cut for, which team, why.
  label             TEXT NOT NULL DEFAULT '',
  -- NULL means any address that passes ALLOWED_EMAIL_DOMAIN may use it.
  assigned_email    TEXT COLLATE NOCASE,
  max_uses          INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses              INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  -- ISO-8601 UTC, or NULL for a code that does not expire on its own.
  expires_at        TEXT,
  revoked_at        TEXT,
  last_used_at      TEXT,
  last_used_by      TEXT,
  -- SET NULL rather than CASCADE: an admin account being removed must not
  -- delete the codes it issued, which are still the record of who was let in.
  created_by        TEXT REFERENCES jsan_users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS jsan_access_codes_created_idx
  ON jsan_access_codes(created_at DESC);

-- Which code let which developer in.
--
-- jsan_access_codes carries last_used_by, which answers the question only for a
-- code used once. A code an admin cut for a pair or a whole squad is used
-- several times and keeps only the most recent address, so "show me the access
-- code for this developer" could not be answered from it. One row per
-- redemption can.
--
-- CASCADE from the code rather than SET NULL: deleting a code is the admin
-- saying they want no record of it, and a redemption pointing at a code that no
-- longer exists would be a row nothing could explain. The user reference is
-- SET NULL instead, so removing a developer's account leaves the history of
-- which code was spent, and on what address, intact.
CREATE TABLE IF NOT EXISTS jsan_access_code_redemptions (
  id          TEXT PRIMARY KEY,
  code_id     TEXT NOT NULL REFERENCES jsan_access_codes(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES jsan_users(id) ON DELETE SET NULL,
  -- Kept beside user_id, not derived from it, for the same reason above.
  email       TEXT NOT NULL COLLATE NOCASE,
  redeemed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS jsan_access_code_redemptions_code_idx
  ON jsan_access_code_redemptions(code_id);

-- The admin users list joins on this to name each developer's code.
CREATE INDEX IF NOT EXISTS jsan_access_code_redemptions_user_idx
  ON jsan_access_code_redemptions(user_id);

-- Password resets an admin hands to one developer.
--
-- The portal has no email sender and no route that mails anybody anything, so
-- a self-service "forgot my password" link has nowhere to send the link to.
-- Before this table existed that left a forgotten password unrecoverable: the
-- developer could not reset it and the admin had no way to help, and the only
-- repair was editing SEED_ACCOUNTS or the database by hand.
--
-- So a reset is issued the same way a seat is - the admin generates a code and
-- passes it to the person however they already talk to them. Held both ways for
-- the same two reasons jsan_access_codes gives: hashed so a submitted code is
-- matched in one indexed read, encrypted so the admin can read it back to
-- somebody who lost the message rather than having to issue a second one.
--
-- Bound to a user id as well as an address, so a reset cannot be carried over
-- to a different account by anyone who learns the code.
CREATE TABLE IF NOT EXISTS jsan_password_resets (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES jsan_users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL COLLATE NOCASE,
  code_hash       TEXT NOT NULL UNIQUE,
  code_ciphertext TEXT NOT NULL,
  code_iv         TEXT NOT NULL,
  code_tag        TEXT NOT NULL,
  code_hint       TEXT NOT NULL,
  -- ISO-8601 UTC. Always set: a reset that never lapses is a spare key.
  expires_at      TEXT NOT NULL,
  used_at         TEXT,
  -- Set when a newer reset supersedes this one, so only one is ever live.
  revoked_at      TEXT,
  created_by      TEXT REFERENCES jsan_users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS jsan_password_resets_user_idx
  ON jsan_password_resets(user_id);

-- Developers who no longer have a seat.
--
-- A row here rather than a flag on jsan_users, and a row rather than a DELETE,
-- for three separate reasons:
--
--   Deleting the account would take its conversations and messages with it -
--   ON DELETE CASCADE reaches all of them - and a developer leaving is not a
--   reason to destroy the work the team did with them.
--
--   The seat has to come back. MAX_USERS counts accounts, so without a way to
--   give one up, a team that has churned through twenty people can never admit
--   a twenty-first even with empty desks.
--
--   Their gateway key has to stop working, which is the part that matters on
--   the day somebody leaves. That is done at LiteLLM when this row is written,
--   and a fresh key is issued if they are ever restored.
--
-- Kept as its own table so no existing table has to be altered: every table in
-- this schema appears through CREATE TABLE IF NOT EXISTS, which means a
-- database written by an older version of the portal gains this one on the next
-- boot without a migration step and without touching a byte of what it holds.
CREATE TABLE IF NOT EXISTS jsan_disabled_users (
  user_id     TEXT PRIMARY KEY REFERENCES jsan_users(id) ON DELETE CASCADE,
  -- Denormalised so the record still reads if the account is ever removed.
  email       TEXT NOT NULL COLLATE NOCASE,
  reason      TEXT NOT NULL DEFAULT '',
  disabled_by TEXT REFERENCES jsan_users(id) ON DELETE SET NULL,
  disabled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- Updated rather than left alone, so a database created before the image table
-- existed reports the version it has actually been migrated to.
INSERT INTO jsan_schema_meta(key, value) VALUES ('schema_version', '6')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
