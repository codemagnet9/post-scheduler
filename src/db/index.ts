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
