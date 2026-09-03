// src/webhooks/dispatcher.ts
// Two workers, both wired to cron:
//   fanOutTick   — consume the events outbox on ITS OWN `fanned_out` cursor (separate from the
//                  notifications dispatcher's notified_at), creating one pending delivery per
//                  subscribed endpoint. Each event fans out exactly once (UNIQUE(endpoint,event)).
//   deliverTick  — send due deliveries: sign, POST, and on failure retry with exponential backoff for
//                  24h. A delivery that exhausts the window DISABLES its endpoint with a stated reason.
import { sql } from 'drizzle-orm';
import { decrypt } from '../vault/crypto';
import { sign } from './signing';
import { safeFetch } from './ssrf';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

export interface MaintenanceDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts a drizzle sql query
  execute: (q: any) => Promise<any>;
}

const RETRY_WINDOW_MS = 24 * 3600_000;   // give up (and disable) after 24h of failures
const BACKOFF_BASE_SEC = 30;
const BACKOFF_CAP_SEC = 6 * 3600;        // 6h ceiling between attempts
const DELIVER_TIMEOUT_MS = 10_000;
const DELIVER_LEASE_SEC = 60;            // hold a claimed delivery this long during the HTTP call
const PER_ENDPOINT_CAP = 5;              // at most this many of one endpoint's deliveries per tick

// --- FAN-OUT: outbox -> one pending delivery per subscribed, active endpoint. ---
export async function fanOutTick(maint: MaintenanceDb, opts: { batch?: number } = {}): Promise<number> {
  const events = rows<{ id: string; workspace_id: string; type: string }>(await maint.execute(sql`
    select id, workspace_id, type from events where fanned_out = false order by occurred_at limit ${opts.batch ?? 200}`));
  for (const e of events) {
    await maint.execute(sql`
      insert into webhook_deliveries (workspace_id, endpoint_id, event_id, status, next_attempt_at)
      select ${e.workspace_id}, we.id, ${e.id}, 'pending', now()
      from webhook_endpoints we
      where we.workspace_id = ${e.workspace_id} and we.active = true
        and we.subscribed_events @> to_jsonb(${e.type}::text)
      on conflict (endpoint_id, event_id) do nothing`);
    await maint.execute(sql`update events set fanned_out = true where id = ${e.id}`);
  }
  return events.length;
}

// The transport is injectable so tests can capture the signed request without a network.
export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>;

// Real transport goes through the SSRF guard: resolve+validate the host (and every redirect), cap
// redirects/size/time. A blocked destination throws SsrfError, which deliverTick treats as a failure.
const realSend: Sender = (url, body, headers) => safeFetch(url, { body, headers, timeoutMs: DELIVER_TIMEOUT_MS });

function backoffSec(attempt: number): number {
  const raw = BACKOFF_BASE_SEC * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(BACKOFF_CAP_SEC, raw);
  return Math.round(capped * (0.85 + 0.3 * ((attempt * 2654435761) % 1000) / 1000)); // deterministic jitter
}

// A stable, signed envelope. The EXACT string we sign is the EXACT string we send (customers verify
// over the raw bytes), so we serialize once and reuse it.
function buildBody(d: { event_id: string; type: string; workspace_id: string; occurred_at: string; aggregate_type: string; aggregate_id: string; payload: unknown }): string {
  return JSON.stringify({
    id: d.event_id,
    type: d.type,
    created_at: new Date(d.occurred_at).toISOString(),
    workspace_id: d.workspace_id,
    data: { aggregate_type: d.aggregate_type, aggregate_id: d.aggregate_id, ...(d.payload && typeof d.payload === 'object' ? d.payload : {}) },
  });
}

// --- DELIVERY: send due deliveries; retry/backoff; disable on 24h exhaustion. ---
export async function deliverTick(maint: MaintenanceDb, opts: { batch?: number; send?: Sender; now?: Date } = {}): Promise<number> {
  const send = opts.send ?? realSend;
  const now = opts.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  // Claim due deliveries (pending/failed due, or a delivering one whose lease expired), leasing each.
  // PER-ENDPOINT CONCURRENCY CAP: row_number() partitions by endpoint so one endpoint's backlog can
  // claim at most PER_ENDPOINT_CAP slots per tick — a flooding/failing endpoint can't monopolise a
  // worker or hammer one destination with a burst.
  // FOR UPDATE and a window function can't share one SELECT, so lock first, then rank the locked set.
  const claimed = rows<{ id: string }>(await maint.execute(sql`
    with locked as (
      select d.id, d.endpoint_id, d.next_attempt_at
      from webhook_deliveries d
      where d.next_attempt_at <= now() and d.status in ('pending','failed','delivering')
      order by d.next_attempt_at
      for update of d skip locked
      limit ${opts.batch ?? 50}
    ),
    ranked as (select id, row_number() over (partition by endpoint_id order by next_attempt_at) as rn from locked),
    due as (select id from ranked where rn <= ${PER_ENDPOINT_CAP})
    update webhook_deliveries d set status = 'delivering', next_attempt_at = now() + make_interval(secs => ${DELIVER_LEASE_SEC})
    from due where d.id = due.id
    returning d.id`));

  let processed = 0;
  for (const { id } of claimed) {
    const d = rows<{ endpoint_id: string; url: string; secret_ciphertext: Buffer; key_id: string; attempt_count: number; created_at: string; event_id: string; type: string; workspace_id: string; occurred_at: string; aggregate_type: string; aggregate_id: string; payload: unknown }>(
      await maint.execute(sql`
        select d.endpoint_id, d.attempt_count, d.created_at, we.url, we.secret_ciphertext, we.key_id,
               e.id as event_id, e.type, e.workspace_id, e.occurred_at, e.aggregate_type, e.aggregate_id, e.payload
        from webhook_deliveries d join webhook_endpoints we on we.id = d.endpoint_id join events e on e.id = d.event_id
        where d.id = ${id}`))[0];
    if (!d) continue;

    const body = buildBody(d);
    const secret = decrypt(Buffer.isBuffer(d.secret_ciphertext) ? d.secret_ciphertext : Buffer.from(d.secret_ciphertext as unknown as Uint8Array), d.key_id);
    const headers = { 'content-type': 'application/json', 'meridian-signature': sign(secret, nowSec, body), 'meridian-event': d.type, 'meridian-delivery': id };

    const attempt = d.attempt_count + 1;
    let ok = false;
    let status: number | null = null;
    let snippet = '';
    try {
      const res = await send(d.url, body, headers);
      status = res.status;
      snippet = (res.text ?? '').slice(0, 500);
      ok = res.status >= 200 && res.status < 300;
    } catch (err) {
      snippet = String((err as Error)?.message ?? err).slice(0, 500);
    }

    if (ok) {
      await maint.execute(sql`update webhook_deliveries set status = 'succeeded', attempt_count = ${attempt}, response_status = ${status}, response_body_snippet = ${snippet}, delivered_at = now() where id = ${id}`);
    } else {
      const exhausted = new Date(d.created_at).getTime() + RETRY_WINDOW_MS <= now.getTime();
      if (exhausted) {
        await maint.execute(sql`update webhook_deliveries set status = 'exhausted', attempt_count = ${attempt}, response_status = ${status}, response_body_snippet = ${snippet} where id = ${id}`);
        // Failing for a full day means the endpoint is down: disable it and record WHY (customer sees it).
        await maint.execute(sql`update webhook_endpoints set active = false, disabled_at = now(),
          disabled_reason = ${`Automatically disabled after 24h of failed deliveries (last status ${status ?? 'no response'}).`} where id = ${d.endpoint_id} and active = true`);
      } else {
        await maint.execute(sql`update webhook_deliveries set status = 'failed', attempt_count = ${attempt}, response_status = ${status}, response_body_snippet = ${snippet}, next_attempt_at = now() + make_interval(secs => ${backoffSec(attempt)}) where id = ${id}`);
      }
    }
    processed += 1;
  }
  return processed;
}
