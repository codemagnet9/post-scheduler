# Meridian

Backend for a multi-tenant social media post scheduler with a first-class public API. Publishes
one logical post, fanned out to N connected accounts, across global networks (Bluesky, X, LinkedIn,
Instagram, …) and country-dominant ones (LINE, VK, Zalo, …) — each target publishing independently
with its own state, rendered payload, provider post id, and failure handling.

**Stack:** TypeScript · Fastify · PostgreSQL (RLS for tenant isolation) · graphile-worker
(Postgres-backed jobs) · Drizzle · AES-256-GCM token vault.

## Status

Built in phases; each ships with tests.

| Phase | Scope | State |
|------|------|------|
| 1 | Architecture & data model (`db/schema.sql`) | ✅ |
| 2 | Identity, workspaces, roles/permissions, RLS | ✅ |
| 3 | Provider abstraction (adapter interface, capability registry, error taxonomy, Bluesky + LINE) | ✅ |
| 4 | OAuth connect, token vault, refresh worker, account health | ✅ |
| 5–11 | Posts/overrides/validation, scheduling, media, approvals, analytics, public API, hardening | ⏳ |

## Getting started

Requires Node ≥ 20 and Docker.

```bash
cp .env.example .env          # dev keyring/secrets are throwaway — replace for production
docker compose up -d          # Postgres 16 on :5432
npm install
npm run migrate               # base schema + migrations; sets the meridian_app role password
npm run seed                  # two demo workspaces, a member in each role
npm test                      # unit (authz, providers) + integration (RLS isolation, vault, refresh)
npm run dev                   # start the API
```

The app connects as the non-privileged `meridian_app` role so Row-Level Security is enforced;
migrations run as the admin role (`DATABASE_URL_ADMIN`). The tenant-isolation suite asserts this and
fails if pointed at a superuser.

## Layout

```
db/            schema.sql (canonical DDL) + migrations/ + the migration runner (scripts/migrate.ts)
src/api/       Fastify routes; the tenant chokepoint (resolveTenant)
src/authz/     the explicit permission ability map
src/db/        connection + withTenant/withUser RLS context
src/auth/      password, sessions/refresh, OAuth sign-in, rate limits
src/accounts/  connect flow, token vault usage, refresh worker, health, disconnect
src/vault/     versioned AES-256-GCM token encryption
src/providers/ the ONLY place that knows specific networks — interface, registry, capabilities, adapters
test/          unit + integration suites
```

Adding a network touches exactly two places: a new `src/providers/adapters/<network>/` folder and one
`registerAdapter(...)` line — enforced by the ESLint import boundary in `eslint.config.js`.
