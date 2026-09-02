// src/db/index.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

// One pool. The app MUST connect as meridian_app (NOSUPERUSER, NOBYPASSRLS) so RLS is enforced;
// connecting as a superuser silently disables every tenant policy in db/migrations/0004.
export const client = postgres(connectionString, { max: Number(process.env.PG_POOL_MAX ?? 10) });
export const db = drizzle(client);
export type Db = typeof db;

// drizzle's sql`${arr}` spreads a JS array into a tuple ($1,$2) — right for `IN (...)`, WRONG for an
// array column or `= any(...)`, where an empty array even becomes `()` (a syntax error). This builds
// a Postgres array literal to bind as a single `::type[]` parameter: pgArray([]) -> '{}'.
export function pgArray(items: readonly (string | number)[]): string {
  return '{' + items.map((v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`).join(',') + '}';
}

// drizzle's sql`${date}` does NOT serialize a JS Date (postgres-js rejects it at bind). Bind an ISO
// string instead; the target timestamptz column infers the cast. null passes through.
export const toTs = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
