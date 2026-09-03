# Deploying Meridian

## Topology

```
                      ┌──────────────┐
   clients ──────────▶│  web (N)     │  Fastify. Stateless. Public API + console.
                      │  server.ts   │  Connects as meridian_app (RLS enforced). No DDL, no admin.
                      └──────┬───────┘
                             │ SQL
                      ┌──────▼───────────────────┐        ┌────────────────────┐
                      │  Postgres 16 (primary)   │◀───────│  workers (M)       │
                      │  + streaming replica      │        │  worker.ts         │
                      │  data, queue, rate limits,│───────▶│  graphile-worker   │
                      │  circuit breakers, events │        │  crontab + tasks   │
                      └──────┬───────────────────┘        └─────────┬──────────┘
                             │                                       │ HTTPS (SSRF-guarded)
                      ┌──────▼───────┐                        ┌──────▼───────┐
                      │ object store │  S3 / Cloudflare R2    │  networks    │  Bluesky, X, LINE, …
                      │ (media)      │  presigned up/download │  + webhooks  │  (customer endpoints)
                      └──────────────┘                        └──────────────┘
```

There is **no Redis and no separate scheduler process**. The job queue, cron schedule, rate-limit
windows, and circuit breakers all live in Postgres (graphile-worker owns the cron); the "scheduler" is
just the `due-scan` cron running inside every worker. One fewer moving part to run, monitor, and lose.

## Production target and reasoning

**Containers on a managed platform** (ECS/Fargate, Cloud Run, or Kubernetes) fronted by a load
balancer, with **managed Postgres** (RDS/Cloud SQL/Neon) and **S3 or R2** for media.

- *Managed Postgres* — the entire system's correctness (exactly-once publish, RLS, leases) rests on
  one Postgres. Automated backups, PITR, failover, and minor-version patching are not things to
  hand-roll. Provision with `NOBYPASSRLS` enforced for the app role.
- *R2 over S3* if egress matters — media is served to networks and browsers; R2 has zero egress fees.
  The `StorageAdapter` (S3Storage) already speaks both (set `S3_ENDPOINT`, `S3_REGION=auto`).
- *Fargate/Cloud Run* — web and workers are stateless and horizontal; a serverless-container platform
  scales each on its own signal without us running nodes.

## Roles from one image

The same image runs three commands (see `docker-compose.yml`):

| role    | command                     | scale on                    | DB role            |
|---------|-----------------------------|-----------------------------|--------------------|
| migrate | `tsx scripts/migrate.ts`    | one-shot, pre-deploy        | admin (owns schema)|
| web     | `tsx src/server.ts`         | request rate / p95 latency  | `meridian_app`     |
| worker  | `tsx src/worker.ts`         | queue depth / oldest job    | admin (maintenance scans) |

**Workers scale independently of web.** Web scales with request traffic; workers scale with *queue
depth* and *oldest-unclaimed-job* (both exported at `/internal/metrics`). Because every worker claims
targets with `SELECT … FOR UPDATE SKIP LOCKED` and a per-attempt mutex, adding workers never
double-publishes — it just drains the queue faster. A publish spike (e.g. 9am in a big market) is a
worker-only scale event; web is untouched.

> Note: workers use the admin connection for cross-tenant *discovery* scans (due-scan, sweeper,
> webhook fan-out) but every *write* still goes through `meridian_app` in a tenant context. Web does
> not need admin creds; grant them only to workers (and the metrics endpoint if enabled there).

## Migrations

`scripts/migrate.ts` applies `db/schema.sql` then `db/migrations/*.sql` in order, each in its own
transaction, recorded in `_migrations` so re-runs are no-ops. Run it as a **pre-deploy step** (a
Fargate task / k8s Job / Cloud Run job) that must succeed before new web/worker tasks roll out.

**Zero-downtime rule: migrations must be backward-compatible with the currently-running code.**
Old and new code overlap during a rolling deploy, so:

1. **Expand** — add columns/tables/indexes as nullable/defaulted; deploy code that writes both old and
   new. Build indexes `CONCURRENTLY` (outside the single-tx runner) for large tables.
2. **Migrate** — backfill in batches.
3. **Contract** — only in a *later* release, once no running code reads the old shape, drop it.

Never rename/drop a column in the same release that stops using it. A `NOT NULL` on an existing column
is a two-step: add nullable + backfill, then set `NOT NULL` next release.

## Zero-downtime deploy sequence

1. Run `migrate` (expand-only) → must go green.
2. Rolling-replace **workers** first (they're idempotent; a killed worker's lease expires and the
   sweeper reconciles — no lost or double posts). `dumb-init` + graceful `SIGTERM` lets the in-flight
   attempt finish.
3. Rolling-replace **web** behind the load balancer (drain connections, health-check `/internal` or a
   cheap route before shifting traffic).
4. In a later release, run the **contract** migration.

## Backups and restore

- **Backups**: managed automated daily snapshots **plus** PITR / WAL archiving (target RPO ≤ 5 min).
  Media in object storage: enable **versioning** + lifecycle, and cross-region replication for DR.
- **What's encrypted**: OAuth tokens and webhook signing secrets are AES-256-GCM at rest under
  `MERIDIAN_KEYRING`. **The keyring is NOT in the database** — back it up in the secrets manager
  separately. A DB restore without the keyring leaves every token/secret undecryptable (by design).
- **Restore procedure**:
  1. Restore Postgres to the target timestamp (PITR).
  2. Confirm the **matching keyring version** is available in the secrets manager (check `key_id`
     values present in `oauth_tokens`/`webhook_endpoints` vs. keys in `MERIDIAN_KEYRING`).
  3. Point object storage at the versioned bucket (or its replica).
  4. Bring up **workers paused** or with the due-scan cron disabled; sanity-check `/internal/metrics`
     (queue depth, stuck-in-flight) before re-enabling publishing — a restore can resurrect targets
     that already published, so let the reconcile/`recentPosts` path adopt rather than re-post.
  5. Rotate any secret you can't prove stayed confidential during the incident.
- **Test the restore quarterly.** An untested backup is a hope, not a backup.

## Required configuration

`DATABASE_URL` (app role), `DATABASE_URL_ADMIN` (workers/migrate), `MERIDIAN_KEYRING` +
`MERIDIAN_KEY_CURRENT`, `ACCESS_TOKEN_SECRET`, `STORAGE_BACKEND=s3` + `S3_*`, and per-provider OAuth
client credentials. Optional: `OPS_METRICS_TOKEN` (enables `/internal/metrics`), `RESEND_API_KEY`
(email), `SLACK_*`. `.env` is gitignored and must never ship in an image (see `.dockerignore`).
