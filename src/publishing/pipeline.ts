// src/publishing/pipeline.ts
// The exactly-once publishing core.
//
// EFFECTIVELY-ONCE = at-least-once delivery (graphile-worker) + an idempotent handler. Two guards:
//   1. The claim moves scheduled->publishing with SELECT ... FOR UPDATE OF pt SKIP LOCKED, so of N
//      racing workers exactly one locks a given row; the others skip it. In the same transaction it
//      writes content_fingerprint (Correction 1) and bumps `version`.
//   2. Every subsequent write is a compare-and-set on (id, state, version). A redelivered job
//      reloads the row, sees it has moved on, and exits without touching the provider.
// The lost-response case (provider accepted, we never heard) is NEVER retried blindly: it goes
// through resolveAmbiguous() — recentPosts lookup + fingerprint match, else idempotent retry, else
// a human (needs_review).
import { sql } from 'drizzle-orm';
import { withTenant, SYSTEM_USER_ID, type Tx, type TenantContext } from '../db/tenant';
import { resolveAdapter } from '../providers/registry';
import { ensureFreshToken } from '../accounts/refresh';
import {
  NormalizedError, AmbiguousFailure, RETRY_POLICY, nextBackoffSeconds, userMessage, resolveAmbiguous,
  type FailureCode,
} from '../providers/errors';
import { contentFingerprint, textFingerprint } from '../providers/fingerprint';
import { emitEvent } from '../events/emit';
import { circuitAllows, circuitSuccess, circuitFailure } from './circuit';
import { providerRateLimit } from './ratelimit';
import { resolveMediaUrls } from '../media/signed-urls';
import { getStorage } from '../media/storage';
import type { RenderedPost } from '../providers/types';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

const DEFAULT_LEASE_SEC = 600;
const RECONCILE_WINDOW_MS = 45 * 60_000; // only match a recent post created within this window
const AMBIGUOUS_ATTEMPT_CAP = 5;         // after this many ambiguous retries, hand to a human

// Stable per-target provider key: providers that honour it dedupe across every retry.
export const idempotencyKey = (targetId: string): string => `mrdn-${targetId}`;

export interface ClaimedTarget {
  id: string; postId: string; workspaceId: string; connectedAccountId: string;
  providerAccountId: string; provider: string; renderedPayload: unknown;
  version: number; attempt: number; idempotencyKey: string; claimedAt: Date;
}

function rendered(payload: unknown): RenderedPost {
  return (payload ?? { text: '', media: [] }) as RenderedPost;
}
function fpContent(payload: unknown): string {
  const r = rendered(payload);
  return contentFingerprint({ text: r.text ?? '', media: (r.media ?? []).map((m) => ({ kind: m.kind, url: m.url })) });
}

// --- CLAIM (scheduled -> publishing). Correction 1: content_fingerprint written HERE, same tx. ---
export async function claimDueTargets(tx: Tx, opts: { batch: number; workerId: string; now?: Date }): Promise<ClaimedTarget[]> {
  const due = rows<{ id: string; post_id: string; workspace_id: string; connected_account_id: string; provider_account_id: string; provider: string; rendered_payload: unknown; version: number }>(
    await tx.execute(sql`
      select pt.id, pt.post_id, pt.workspace_id, pt.connected_account_id, ca.provider_account_id, ca.provider,
             pt.rendered_payload, pt.version
      from post_targets pt
      join connected_accounts ca on ca.id = pt.connected_account_id
      where pt.state = 'scheduled' and pt.publish_due_at <= now() and ca.status = 'active'
      order by pt.publish_due_at
      for update of pt skip locked
      limit ${opts.batch}
    `),
  );

  const claimed: ClaimedTarget[] = [];
  for (const t of due) {
    // Never let one bad row crash the whole scan: a target for a provider with no registered adapter
    // (a removed network, or a stale row) is left untouched rather than claimed. It stays 'scheduled'
    // and is surfaced by monitoring, not by a thrown batch.
    let caps;
    try {
      caps = resolveAdapter(t.provider).capabilities;
    } catch {
      continue;
    }
    const lease = caps.publishLeaseSeconds ?? DEFAULT_LEASE_SEC;
    const upd = rows<{ version: number; attempt_count: number; claimed_at: Date }>(await tx.execute(sql`
      update post_targets set
        state = 'publishing', attempt_count = attempt_count + 1,
        lease_expires_at = now() + make_interval(secs => ${lease}), claimed_by = ${opts.workerId},
        claimed_at = now(), content_fingerprint = ${fpContent(t.rendered_payload)}, version = version + 1
      where id = ${t.id} and state = 'scheduled' and version = ${t.version}
      returning version, attempt_count, claimed_at
    `));
    if (!upd.length) continue; // lost the CAS (cannot happen while we hold the row lock)
    await emitEvent(tx, { workspaceId: t.workspace_id, aggregateType: 'post_target', aggregateId: t.id, type: 'post_target.publishing' });
    claimed.push({
      id: t.id, postId: t.post_id, workspaceId: t.workspace_id, connectedAccountId: t.connected_account_id,
      providerAccountId: t.provider_account_id, provider: t.provider, renderedPayload: t.rendered_payload,
      version: upd[0].version, attempt: upd[0].attempt_count, idempotencyKey: idempotencyKey(t.id), claimedAt: upd[0].claimed_at,
    });
  }
  return claimed;
}

const ctxOf = (c: ClaimedTarget): TenantContext => ({ workspaceId: c.workspaceId, userId: SYSTEM_USER_ID, role: 'system' });

// Reload the row under a CAS: proceed only if it is still (publishing|reconciling) at our version.
async function stillOurs(tx: Tx, c: ClaimedTarget): Promise<boolean> {
  const r = rows<{ state: string; version: number }>(await tx.execute(sql`select state, version from post_targets where id = ${c.id}`));
  return r.length > 0 && (r[0].state === 'publishing' || r[0].state === 'reconciling') && r[0].version === c.version;
}

// Per-attempt mutex. The UNIQUE(post_target_id, attempt_number) means only one delivery can insert
// the 'started' row for a given attempt; a concurrent duplicate delivery gets no row back and aborts
// BEFORE touching the provider. This closes the read-check-then-publish gap in publishClaimed if
// graphile-worker ever ran the same job twice at once.
async function claimAttemptSlot(c: ClaimedTarget): Promise<boolean> {
  return withTenant(ctxOf(c), async (tx) => {
    const r = rows(await tx.execute(sql`
      insert into publish_attempts (post_target_id, workspace_id, attempt_number, idempotency_key, status)
      values (${c.id}, ${c.workspaceId}, ${c.attempt}, ${c.idempotencyKey}, 'started')
      on conflict (post_target_id, attempt_number) do nothing returning id
    `));
    return r.length > 0;
  });
}

// --- PUBLISH one claimed target. Idempotent: a duplicate delivery exits at the entry check. ---
export async function publishClaimed(c: ClaimedTarget): Promise<void> {
  const ctx = ctxOf(c);
  const adapter = resolveAdapter(c.provider);
  const caps = adapter.capabilities;

  // Entry idempotency check for redelivered jobs, then the per-attempt mutex.
  const proceed = await withTenant(ctx, (tx) => stillOurs(tx, c));
  if (!proceed) return;
  if (!(await claimAttemptSlot(c))) return; // a concurrent delivery owns this attempt

  if (!(await circuitAllows(c.provider))) { await requeueScheduled(c, 60, 'provider_unavailable'); return; }

  const rl = await providerRateLimit(c.provider, c.connectedAccountId, caps);
  if (!rl.allowed) { await requeueScheduled(c, rl.retryAfterSec, 'rate_limited'); return; }

  let credentials;
  try {
    credentials = await ensureFreshToken(ctx, c.provider, c.connectedAccountId);
  } catch {
    // Refresh failed -> the account is now auth_expired (health module notified once). Pause the
    // target back to scheduled; the claim's `ca.status='active'` gate keeps it from re-firing until
    // the user reconnects, at which point it resumes automatically.
    await requeueScheduled(c, 0, 'auth_expired', 'Reconnect the account to publish.');
    return;
  }

  try {
    // rendered_payload holds STORAGE KEYS (stable, canonicalised); mint ephemeral signed URLs here,
    // at publish time, so the preview==publish guarantee survives signature rotation.
    const post = await resolveMediaUrls(rendered(c.renderedPayload), getStorage());
    const result = await adapter.publish({ account: { providerAccountId: c.providerAccountId, credentials }, post }, { idempotencyKey: c.idempotencyKey });
    await markPublished(c, result.providerPostId, result.permalink);
    await circuitSuccess(c.provider);
  } catch (e) {
    if (e instanceof AmbiguousFailure) { await reconcile(c); return; }
    if (e instanceof NormalizedError) { await handleNormalizedError(c, e); return; }
    // Unknown throw during publish: we cannot be sure the post was NOT sent -> treat as ambiguous.
    await reconcile(c);
  }
}

// --- outcome writers (all compare-and-set on version) ---

async function markPublished(c: ClaimedTarget, providerPostId: string, permalink?: string): Promise<void> {
  await withTenant(ctxOf(c), async (tx) => {
    const upd = rows(await tx.execute(sql`
      update post_targets set state = 'published', provider_post_id = ${providerPostId}, provider_permalink = ${permalink ?? null},
        published_at = now(), lease_expires_at = null, claimed_by = null, failure_code = null, version = version + 1
      where id = ${c.id} and state in ('publishing','reconciling') and version = ${c.version}
      returning id
    `));
    if (!upd.length) return; // someone else already resolved it — no double write, no double event
    await recordAttempt(tx, c, 'succeeded', providerPostId);
    await bumpUsage(tx, c.workspaceId, 'posts_published');
    await emitEvent(tx, { workspaceId: c.workspaceId, aggregateType: 'post_target', aggregateId: c.id, type: 'post_target.published', payload: { providerPostId, permalink } });
    await recomputeRollup(tx, c.postId);
  });
}

async function requeueScheduled(c: ClaimedTarget, backoffSec: number, code: FailureCode, plain?: string): Promise<void> {
  await withTenant(ctxOf(c), async (tx) => {
    const upd = rows(await tx.execute(sql`
      update post_targets set state = 'scheduled', publish_due_at = now() + make_interval(secs => ${Math.max(0, Math.round(backoffSec))}),
        lease_expires_at = null, claimed_by = null, failure_code = ${code},
        last_error = ${JSON.stringify({ code, plainLanguage: plain ?? userMessage(code, c.provider) })}::jsonb, version = version + 1
      where id = ${c.id} and state in ('publishing','reconciling') and version = ${c.version}
      returning id
    `));
    if (!upd.length) return;
    await emitEvent(tx, { workspaceId: c.workspaceId, aggregateType: 'post_target', aggregateId: c.id, type: 'post_target.retrying', payload: { code, retryInSec: Math.round(backoffSec) } });
  });
}

async function markFailed(c: ClaimedTarget, code: FailureCode, providerRaw: unknown, deadLetter: boolean, reason = ''): Promise<void> {
  const plain = userMessage(code, c.provider, reason);
  await withTenant(ctxOf(c), async (tx) => {
    const upd = rows(await tx.execute(sql`
      update post_targets set state = 'failed', failure_code = ${code}, lease_expires_at = null, claimed_by = null,
        last_error = ${JSON.stringify({ code, plainLanguage: plain })}::jsonb, version = version + 1
      where id = ${c.id} and state in ('publishing','reconciling') and version = ${c.version}
      returning id
    `));
    if (!upd.length) return;
    await recordAttempt(tx, c, 'failed', undefined, providerRaw);
    if (deadLetter) {
      await tx.execute(sql`
        insert into dead_letters (workspace_id, post_target_id, reason, error) values (${c.workspaceId}, ${c.id}, ${code}, ${JSON.stringify({ plainLanguage: plain })}::jsonb)
        on conflict (post_target_id) do nothing
      `);
    }
    await emitEvent(tx, { workspaceId: c.workspaceId, aggregateType: 'post_target', aggregateId: c.id, type: 'post_target.failed', payload: { code, message: plain } });
    await recomputeRollup(tx, c.postId);
  });
}

async function markNeedsReview(c: ClaimedTarget): Promise<void> {
  const plain = "We couldn't confirm this published, so a teammate needs to check the account before we try again.";
  await withTenant(ctxOf(c), async (tx) => {
    const upd = rows(await tx.execute(sql`
      update post_targets set state = 'needs_review', lease_expires_at = null, claimed_by = null,
        last_error = ${JSON.stringify({ code: 'ambiguous', plainLanguage: plain })}::jsonb, version = version + 1
      where id = ${c.id} and state in ('publishing','reconciling') and version = ${c.version}
      returning id
    `));
    if (!upd.length) return;
    await emitEvent(tx, { workspaceId: c.workspaceId, aggregateType: 'post_target', aggregateId: c.id, type: 'post_target.needs_review', payload: { message: plain } });
    await recomputeRollup(tx, c.postId);
  });
}

// Before marking a target terminally failed, confirm the provider didn't actually accept it. A
// provider that returns an error AFTER creating the post would otherwise strand a live post as
// "failed"; the user re-posts manually and now there are two. On a lookup-capable provider we do one
// lookup first: adopt if the post is live, needs_review if we can't tell, fail only on confirmed
// absence (or when the provider has no lookup at all).
async function markFailedWithReconcile(c: ClaimedTarget, e: NormalizedError, deadLetter: boolean): Promise<void> {
  const adapter = resolveAdapter(c.provider);
  if (adapter.capabilities.supportsRecentPostLookup) {
    const outcome = await lookupOutcome(ctxOf(c), c, adapter);
    if (outcome.kind === 'adopt') { await markPublished(c, outcome.id); return; }
    if (outcome.kind === 'ambiguous') { await markNeedsReview(c); return; }
    // 'absent' => the provider really didn't create it => genuinely failed, fall through.
  }
  await markFailed(c, e.code, e.providerRaw, deadLetter, e.plainMessage);
}

// --- retry policy, driven off the taxonomy (Phase 3) ---
async function handleNormalizedError(c: ClaimedTarget, e: NormalizedError): Promise<void> {
  const rule = RETRY_POLICY[e.code];
  if (e.code === 'provider_unavailable') await circuitFailure(c.provider);
  if (!rule.retryable) { await markFailedWithReconcile(c, e, false); return; }
  if (c.attempt >= rule.maxAttempts) { await markFailedWithReconcile(c, e, true); return; }
  // RateLimited honours retryAfter; ProviderUnavailable backs off exponentially with jitter.
  const base = nextBackoffSeconds(e.code, c.attempt, e.retryAfterSec);
  const jitter = e.code === 'provider_unavailable' ? base * 0.25 * Math.random() : 0;
  await requeueScheduled(c, base + jitter, e.code, e.plainMessage);
}

// --- ambiguous reconciliation: the lost-response case. Never "post it again" blindly. ---
type LookupOutcome = { kind: 'adopt'; id: string } | { kind: 'absent' } | { kind: 'ambiguous' };

async function lookupOutcome(ctx: TenantContext, c: ClaimedTarget, adapter: ReturnType<typeof resolveAdapter>): Promise<LookupOutcome> {
  const targetFp = textFingerprint(rendered(c.renderedPayload).text ?? '');
  // Coerce: over a graphile job payload claimedAt arrives as a string.
  const claimTs = new Date(c.claimedAt as unknown as string).getTime();
  const backstop = Date.now() - RECONCILE_WINDOW_MS;

  let recent;
  try {
    const credentials = await ensureFreshToken(ctx, c.provider, c.connectedAccountId);
    recent = adapter.recentPosts ? await adapter.recentPosts({ account: { providerAccountId: c.providerAccountId, credentials }, limit: 30 }) : [];
  } catch {
    return { kind: 'ambiguous' }; // the lookup itself failed
  }

  // Candidate = same text, created AT/AFTER our claim (Improvement 2: excludes an older identical
  // post), and within the backstop window. Skew note: createdAt is the provider's clock; a genuine
  // post whose reported time is slightly before our claim is missed and we fall through to a
  // capped retry / needs_review — fail-safe, never a wrong adoption.
  const candidates = recent.filter((r) =>
    r.text != null && textFingerprint(r.text) === targetFp &&
    r.createdAt != null && r.createdAt.getTime() >= claimTs && r.createdAt.getTime() >= backstop,
  );
  if (candidates.length === 0) return { kind: 'absent' }; // provider has no matching post => not posted

  // Improvement 1: never adopt a provider_post_id already owned by another of our targets — two of
  // our targets can never legitimately own one provider post.
  for (const cand of candidates) {
    const taken = rows(await withTenant(ctx, (tx) => tx.execute(sql`select 1 from post_targets where provider_post_id = ${cand.providerPostId} and id <> ${c.id} limit 1`)));
    if (!taken.length) return { kind: 'adopt', id: cand.providerPostId };
  }

  // UNRESOLVABLE CASE — every matching post is already adopted by another target. Text + created-at +
  // not-already-adopted still cannot separate "our lost post" from a HUMAN posting byte-identical
  // text to the same account during our publish window. We deliberately do NOT adopt an id we are
  // unsure of (wrong permalink/metrics). This returns 'ambiguous', which for a lookup-only provider
  // (no idempotency key) lands in needs_review below — a human decides, we never adopt the wrong id.
  return { kind: 'ambiguous' };
}

export async function reconcile(c: ClaimedTarget): Promise<void> {
  const adapter = resolveAdapter(c.provider);
  const caps = adapter.capabilities;
  const decision = resolveAmbiguous(caps);

  if (decision === 'needs_review') { await markNeedsReview(c); return; }

  if (decision === 'retry_idempotent') {
    if (c.attempt >= AMBIGUOUS_ATTEMPT_CAP) { await markNeedsReview(c); return; }
    await requeueScheduled(c, 0, 'provider_unavailable', 'Confirming delivery…');
    return;
  }

  // decision === 'lookup'
  const outcome = await lookupOutcome(ctxOf(c), c, adapter);
  if (outcome.kind === 'adopt') { await markPublished(c, outcome.id); return; }
  if (outcome.kind === 'absent') {
    // FIX 1: cap the confirmed-not-posted retry so a forever-timing-out provider can't loop.
    if (c.attempt >= AMBIGUOUS_ATTEMPT_CAP) { await markNeedsReview(c); return; }
    await requeueScheduled(c, 0, 'provider_unavailable', 'Retrying…');
    return;
  }
  // outcome.kind === 'ambiguous' (lookup failed, or all matches already adopted).
  if (caps.supportsIdempotencyKey && c.attempt < AMBIGUOUS_ATTEMPT_CAP) await requeueScheduled(c, 30, 'provider_unavailable');
  else await markNeedsReview(c);
}

// --- lease sweeper (Phase 2 debt, wired here). Reclaims targets a dead worker stranded. ---
export interface MaintenanceRunner {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
export async function leaseSweeperTick(maint: MaintenanceRunner, opts: { batch?: number; workerId?: string } = {}): Promise<number> {
  const batch = opts.batch ?? 50;
  // Discover expired leases across tenants (bypasses RLS via the maintenance connection), move each
  // publishing|reconciling -> reconciling with a fresh lease + version bump, under the row lock.
  const claimed = await maint.transaction(async (tx) => {
    const expired = rows<{ id: string; post_id: string; workspace_id: string; connected_account_id: string; provider_account_id: string; provider: string; rendered_payload: unknown; version: number; attempt_count: number; claimed_at: Date }>(
      await tx.execute(sql`
        select pt.id, pt.post_id, pt.workspace_id, pt.connected_account_id, ca.provider_account_id, ca.provider,
               pt.rendered_payload, pt.version, pt.attempt_count, pt.claimed_at
        from post_targets pt join connected_accounts ca on ca.id = pt.connected_account_id
        where pt.lease_expires_at is not null and pt.lease_expires_at <= now() and pt.state in ('publishing','reconciling')
        order by pt.lease_expires_at
        for update of pt skip locked
        limit ${batch}
      `),
    );
    const out: ClaimedTarget[] = [];
    for (const t of expired) {
      const caps = resolveAdapter(t.provider).capabilities;
      const lease = caps.publishLeaseSeconds ?? DEFAULT_LEASE_SEC;
      const upd = rows<{ version: number }>(await tx.execute(sql`
        update post_targets set state = 'reconciling', lease_expires_at = now() + make_interval(secs => ${lease}),
          claimed_by = ${opts.workerId ?? 'sweeper'}, version = version + 1
        where id = ${t.id} and version = ${t.version}
        returning version
      `));
      if (!upd.length) continue;
      await emitEvent(tx, { workspaceId: t.workspace_id, aggregateType: 'post_target', aggregateId: t.id, type: 'post_target.reconciling' });
      // Keep the ORIGINAL claimed_at (the attempt that may have created a post), not the reclaim time.
      out.push({ id: t.id, postId: t.post_id, workspaceId: t.workspace_id, connectedAccountId: t.connected_account_id, providerAccountId: t.provider_account_id, provider: t.provider, renderedPayload: t.rendered_payload, version: upd[0].version, attempt: t.attempt_count, idempotencyKey: idempotencyKey(t.id), claimedAt: t.claimed_at });
    }
    return out;
  });

  // Reconcile each in its own tenant context. A crash here just lets the (new) lease expire and the
  // next sweep re-picks it — idempotent by the version CAS.
  for (const c of claimed) await reconcile(c);
  return claimed.length;
}

// --- operator: requeue a dead-lettered target ---
export async function requeueDeadLetter(ctx: TenantContext, targetId: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx.execute(sql`update post_targets set state = 'scheduled', publish_due_at = now(), failure_code = null, last_error = null, version = version + 1 where id = ${targetId} and state = 'failed'`);
    await tx.execute(sql`update dead_letters set requeued_at = now(), requeued_by = ${ctx.userId} where post_target_id = ${targetId}`);
  });
}

// --- helpers ---
async function recordAttempt(tx: Tx, c: ClaimedTarget, status: string, providerPostId?: string, error?: unknown): Promise<void> {
  await tx.execute(sql`
    insert into publish_attempts (post_target_id, workspace_id, attempt_number, idempotency_key, status, provider_post_id, error, finished_at)
    values (${c.id}, ${c.workspaceId}, ${c.attempt}, ${c.idempotencyKey}, ${status}, ${providerPostId ?? null}, ${error ? JSON.stringify(error) : null}::jsonb, now())
    on conflict (post_target_id, attempt_number) do update set status = excluded.status, provider_post_id = excluded.provider_post_id, error = excluded.error, finished_at = now()
  `);
}

async function bumpUsage(tx: Tx, workspaceId: string, metric: string): Promise<void> {
  await tx.execute(sql`
    insert into usage_counters (workspace_id, metric, period_start, count) values (${workspaceId}, ${metric}, date_trunc('month', now())::date, 1)
    on conflict (workspace_id, metric, period_start) do update set count = usage_counters.count + 1, updated_at = now()
  `);
}

// Post rollup is a projection of its targets' states (computed inside the transition's tx).
async function recomputeRollup(tx: Tx, postId: string): Promise<void> {
  // Lock the post row first so two targets of the same post finishing concurrently can't lost-update
  // the rollup (one computing a stale 'publishing' and overwriting the other's 'published').
  await tx.execute(sql`select id from posts where id = ${postId} for update`);
  const counts = rows<{ state: string; c: number }>(await tx.execute(sql`select state, count(*)::int as c from post_targets where post_id = ${postId} group by state`));
  const by: Record<string, number> = {};
  let total = 0;
  for (const r of counts) { by[r.state] = r.c; total += r.c; }
  const inflight = (by.publishing ?? 0) + (by.reconciling ?? 0);
  const published = by.published ?? 0;
  const terminalBad = (by.failed ?? 0) + (by.needs_review ?? 0) + (by.skipped ?? 0);
  let status: string | null = null;
  if (inflight > 0) status = 'publishing';
  else if (published === total && total > 0) status = 'published';
  else if (published > 0 && published + terminalBad === total) status = 'partially_published';
  else if (terminalBad === total && total > 0) status = 'failed';
  if (status) await tx.execute(sql`update posts set status = ${status}, updated_at = now() where id = ${postId}`);
}
