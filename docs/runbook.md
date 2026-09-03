# Operator runbook (3am edition)

You were paged. Start here. Every metric below is at `GET /internal/metrics` (needs `X-Ops-Token`).
Most fixes are Postgres queries run as the **admin** role; the app role can't see across tenants.

Quick orientation:
```sql
-- the health board in one query
select
  (select count(*) from post_targets where state='scheduled' and publish_due_at<=now()) as due_now,
  (select count(*) from post_targets where state in ('publishing','reconciling') and (lease_expires_at is null or lease_expires_at<now())) as stuck,
  (select count(*) from dead_letters where requeued_at is null) as dead_letters,
  (select count(*) from connected_accounts where status='auth_expired') as need_reconnect,
  (select count(*) from webhook_deliveries where status in ('pending','failed')) as wh_backlog;
```

---

## 1. A provider is down

**Symptom:** `meridian_publish_success_rate{provider="x"}` drops; failures spike for one provider only.

**Diagnose:**
```sql
select state, count(*) from post_targets pt join connected_accounts ca on ca.id=pt.connected_account_id
 where ca.provider='x' and pt.updated_at>now()-interval '1 hour' group by state;
select * from provider_circuits where provider='x';   -- state=open means we already backed off
```
If `provider_circuits.state='open'`, the breaker is doing its job — we're not hammering them; targets
requeue with backoff. If it's `closed` but failures are auth-shaped, it may be an auth change, not an
outage (see #4).

**Fix:** Usually **nothing** — the breaker + retry policy ride it out and posts publish when the
provider recovers (verified by `publishing.test.ts` rate-limit-recovery). If it's a hard multi-hour
outage, tell affected customers their queue is paused for that network. Do **not** manually retry in a
loop — you'll trip the breaker open again. To resume early after confirmed recovery:
`update provider_circuits set state='closed', failure_count=0, opened_at=null, next_probe_at=null where provider='x';`

---

## 2. The queue is backing up

**Symptom:** `meridian_queue_due_now` high and rising; `meridian_oldest_unclaimed_seconds` > 300.

**Diagnose:** Is it *us* or *them*?
```sql
select count(*) from post_targets where state='scheduled' and publish_due_at<=now();   -- backlog
select ca.provider, count(*) from post_targets pt join connected_accounts ca on ca.id=pt.connected_account_id
 where pt.state='scheduled' and pt.publish_due_at<=now() group by ca.provider order by 2 desc;
```
- Backlog spread across providers, workers healthy → **under-provisioned.** Scale workers.
- Backlog concentrated on one provider → it's rate-limiting/down (see #1), not a capacity problem.
- `oldest_unclaimed` climbing but `due_now` small → workers may be **down**. Check they're running and
  connected (graphile-worker logs; `select count(*) from graphile_worker.jobs`).

**Fix:** `docker compose up --scale worker=N` (or bump the platform's worker replica count). Workers
coordinate via SKIP LOCKED — more workers just drain faster, never double-publish. Watch
`oldest_unclaimed_seconds` fall.

---

## 3. A customer says a post did not go out

**Symptom:** support ticket, one post.

**Diagnose:** find the target and read its actual state — this is the source of truth, not the UI cache.
```sql
select pt.id, pt.state, pt.failure_code, pt.last_error, pt.attempt_count, pt.provider_post_id, pt.published_at
 from post_targets pt join posts p on p.id=pt.post_id
 where p.workspace_id=:ws order by pt.updated_at desc limit 20;
```
Interpretations:
- `published` + `provider_post_id` set → **it did publish**; check the permalink. Likely a
  provider-side display delay or the customer looked at the wrong account.
- `failed` → read `last_error.plainLanguage` (a real reason, e.g. duplicate content, media rejected).
- `needs_review` → we couldn't confirm delivery (ambiguous) and refused to double-post. A human
  decides. Inspect the account for a matching post; adopt or requeue.
- `scheduled` with `publish_due_at` in the future → not late, just not due yet.
- `scheduled` and overdue → queue problem (#2).

**Fix:** for `needs_review`/`failed` after you've confirmed it truly didn't post:
`update post_targets set state='scheduled', publish_due_at=now(), failure_code=null, last_error=null, version=version+1 where id=:id;`
For a dead-lettered one, use the operator requeue path (`requeueDeadLetter`) so the dead-letter row is
marked. **Never** just flip a `published` row — you'll double-post.

---

## 4. Token refresh is failing across many accounts

**Symptom:** `meridian_token_auth_expired` / `meridian_token_refresh_fail_rate` jump; many accounts on
**one provider** go `auth_expired` at once.

**Diagnose:**
```sql
select ca.provider, count(*) from connected_accounts ca where ca.status='auth_expired' group by 1 order by 2 desc;
```
Many accounts, one provider, same hour → **the provider changed its OAuth** (rotated a secret, changed
the refresh endpoint/scopes), or our client credentials for that provider expired. One-off scattered
accounts → normal user reconnects, ignore.

**Fix:** This is a code/config fix, not a data fix. Check our OAuth client id/secret and the adapter's
refresh call for that provider. Our refresh classifier **fails safe** — unknown errors map to
`auth_expired` (reconnect), never `revoked`, so queued targets stay `scheduled` and resume the moment
the account reconnects. Once the provider issue is fixed and clients reconnect, the queue drains
itself. Do not mass-mutate token rows.

---

## 5. A webhook endpoint is flooding us with errors

**Symptom:** `meridian_webhook_fail_rate` high; `meridian_webhook_backlog` climbing; one endpoint.

**Diagnose:**
```sql
select we.id, we.url, we.active, we.disabled_reason,
       count(*) filter (where d.status='failed') as failing,
       count(*) filter (where d.status='exhausted') as dead
 from webhook_endpoints we join webhook_deliveries d on d.endpoint_id=we.id
 where d.created_at>now()-interval '6 hours' group by we.id order by failing desc;
```

**Fix:** The system **self-heals** here: the per-endpoint concurrency cap stops one bad endpoint from
starving delivery, backoff spreads retries over 24h, and an endpoint failing the full window is
**auto-disabled** with `disabled_reason` set (customer sees it). If it's overwhelming things *now*,
disable it immediately: `update webhook_endpoints set active=false, disabled_at=now(),
disabled_reason='ops: disabled during incident' where id=:id;` The customer re-enables by replaying a
delivery once they've fixed their side. If deliveries are being *refused before sending* with an SSRF
reason in `response_body_snippet`, the customer pointed the URL at a private/metadata address —
disabled correctly; tell them.

---

## 6. A target is stuck in reconciling

**Symptom:** `meridian_targets_stuck_in_flight` > 0 and not clearing.

**Diagnose:**
```sql
select id, state, lease_expires_at, claimed_by, attempt_count, updated_at
 from post_targets where state in ('publishing','reconciling') and lease_expires_at<now() order by updated_at;
```
A target in `publishing`/`reconciling` with an **expired lease** should be reclaimed by the
`lease-sweeper` cron within a minute. If they're piling up, the **sweeper isn't running** (workers
down, or the cron isn't firing).

**Fix:** Confirm workers are alive and the crontab loaded (worker boot log lists the schedule). The
sweeper moves each expired-lease target to `reconciling` and runs reconciliation: it looks the post up
on the provider (`recentPosts`) and **adopts** it if it's live (no double-post) or moves it to
`needs_review` if it truly can't tell. If a single target is wedged (e.g. an adapter bug), force one
sweeper pass by clearing its lease so the next tick re-picks it:
`update post_targets set lease_expires_at=now()-interval '1 minute' where id=:id;`
Do not manually set it to `published` unless you've **confirmed on the provider** that it posted.
