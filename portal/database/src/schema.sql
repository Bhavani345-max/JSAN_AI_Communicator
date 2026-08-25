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

-- Updated rather than left alone, so a database created before the image table
-- existed reports the version it has actually been migrated to.
INSERT INTO jsan_schema_meta(key, value) VALUES ('schema_version', '3')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
