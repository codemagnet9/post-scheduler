// src/publishing/circuit.ts
// Per-provider circuit breaker in Postgres, so all workers share one view. Closed -> normal; after
// N consecutive failures it OPENS (stop hammering) for a cooldown; then HALF-OPEN allows a single
// probe; a probe success closes it, a probe failure re-opens. Observable via getCircuits().
import { sql } from 'drizzle-orm';
import { db } from '../db/index';

const THRESHOLD = 5;
const COOLDOWN_SEC = 60;
type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

export async function circuitAllows(provider: string): Promise<boolean> {
  // The open -> half_open flip is a single conditional UPDATE ... RETURNING, so under concurrency
  // the row lock lets exactly ONE caller win the transition (and send the probe); everyone else
  // reads/keeps 'open' and is denied. A plain SELECT-then-UPDATE would let a herd of probes through.
  const flipped = rows(await db.execute(sql`
    update provider_circuits set state = 'half_open', updated_at = now()
    where provider = ${provider} and state = 'open' and next_probe_at is not null and next_probe_at <= now()
    returning provider
  `));
  if (flipped.length) return true; // we won the single probe slot

  const r = rows<{ state: string }>(await db.execute(sql`select state from provider_circuits where provider = ${provider}`));
  if (!r.length) return true;            // no record => closed
  return r[0].state !== 'open';          // closed / half_open allow; open denies (probe already out)
}

export async function circuitSuccess(provider: string): Promise<void> {
  await db.execute(sql`
    insert into provider_circuits (provider, state, failure_count) values (${provider}, 'closed', 0)
    on conflict (provider) do update set state = 'closed', failure_count = 0, opened_at = null, next_probe_at = null, updated_at = now()
  `);
}

export async function circuitFailure(provider: string): Promise<void> {
  await db.execute(sql`
    insert into provider_circuits (provider, state, failure_count, opened_at, next_probe_at)
    values (${provider}, 'closed', 1, null, null)
    on conflict (provider) do update set
      failure_count = provider_circuits.failure_count + 1,
      state         = case when provider_circuits.failure_count + 1 >= ${THRESHOLD} then 'open' else provider_circuits.state end,
      opened_at     = case when provider_circuits.failure_count + 1 >= ${THRESHOLD} then now() else provider_circuits.opened_at end,
      next_probe_at = case when provider_circuits.failure_count + 1 >= ${THRESHOLD} then now() + make_interval(secs => ${COOLDOWN_SEC}) else provider_circuits.next_probe_at end,
      updated_at = now()
  `);
}

// Operator observability: which providers are throttled/broken right now.
export function getCircuits(): Promise<unknown> {
  return db.execute(sql`select provider, state, failure_count, opened_at, next_probe_at, updated_at from provider_circuits order by provider`);
}
