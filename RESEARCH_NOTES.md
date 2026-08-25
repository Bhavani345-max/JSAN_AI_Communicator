# Design decisions based on current platform capabilities

- Railway private networking uses per-environment `*.railway.internal` DNS and encrypted WireGuard transport. This package keeps LiteLLM and Postgres off the public internet.
- Railway public networking provides custom domains and automatic TLS, so host-level Nginx/Certbot are intentionally removed.
- Railway deployment healthchecks gate cutover until a new deployment returns HTTP 200. Portal uses `/api/health`; LiteLLM uses `/health/readiness`.
- Railway PostgreSQL exposes `DATABASE_URL` and supports native backups; current Railway also offers Postgres point-in-time recovery.
- LiteLLM remains the system of record for virtual keys, model routing, budgets, rate limits and provider credentials.
- The portal proxies `/v1/*` to private LiteLLM while preserving streaming, so developer tools use one branded endpoint without exposing the LiteLLM Admin UI.
