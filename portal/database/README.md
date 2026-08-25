# @jsan/database

The portal's SQLite store, carrying the same schema the API uses on PostgreSQL.
It needs no service and no native dependency: it runs on the `node:sqlite`
module built into Node 22.5+. Node prints an `ExperimentalWarning` for that
module — set `NODE_NO_WARNINGS=1` to silence it.

```
database/
├── package.json      exposes the package as @jsan/database
├── data/             jsan.db lives here (git-ignored)
└── src/
    ├── schema.sql    the tables, indexes and constraints
    ├── sqlite.js     open, pragmas, transactions, integrity check
    ├── cli.js        init / status / reset
    └── verify.js     14 checks against a throwaway database
```

## Commands

From `portal/database`:

```bash
npm run init     # create data/jsan.db (idempotent — safe to re-run)
npm run status   # path, size, row counts, indexes, integrity check
npm run verify   # exercise the constraints against a throwaway database
npm run reset    # delete and recreate it — requires --force
```

Or from `portal`, which proxies them: `npm run db:init`, `db:status`,
`db:verify`, `db:reset`.

Set `SQLITE_PATH` to move the file; relative values resolve against this
package's root, not the working directory.

## Using it from the backend

The backend depends on this package as `"@jsan/database": "file:../database"`,
so it imports across the folder boundary by name rather than by reaching into
another directory's source tree:

```js
import { connect, transaction, nowIso } from '@jsan/database';

const db = connect();                                   // opens + applies schema
const user = db.prepare('SELECT * FROM jsan_users WHERE email=?').get(email);
transaction(db, () => { /* ... */ });                   // BEGIN IMMEDIATE + rollback
```

## Differences from the PostgreSQL schema

| PostgreSQL | SQLite | Why |
|---|---|---|
| `UUID` | `TEXT` | The app already generates `crypto.randomUUID()` strings. |
| `TIMESTAMPTZ` | `TEXT` ISO-8601 UTC | Same format `JSON.stringify(new Date())` emits, and lexically sortable, so `ORDER BY created_at` is unchanged. |
| `NOW()` | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` | |
| implicit type checking | `STRICT` tables | SQLite otherwise coerces silently. |
| `pg_advisory_xact_lock` | `BEGIN IMMEDIATE` | Serializes the seat-cap check against a concurrent signup. |

Two behaviours are per-connection rather than stored in the file, so
`openDatabase()` sets them on every open: `foreign_keys` (without it,
`ON DELETE CASCADE` silently does nothing) and `busy_timeout`.

SQLite allows one writer at a time. That is ample for a 20-seat portal, but the
database has to live on a disk local to the process — on Railway that requires
an attached volume, since the container filesystem is ephemeral.

## Deployment

SQLite allows one writer on one node, so the backend must run as a single
replica against a disk that survives restarts. On Railway that means an attached
volume with `SQLITE_PATH` pointing into it; the container filesystem is
ephemeral. Postgres remains in the stack for LiteLLM's own persistence.
