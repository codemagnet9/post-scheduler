// test/helpers/db.ts
// Two connections for the isolation suite:
//   - the app's own `db` (from src) connects as meridian_app and is subject to RLS.
//   - adminDb connects as the superuser/owner (DATABASE_URL_ADMIN) and BYPASSES RLS — used only
//     by the canary to prove that RLS, not a missing row, is what hides cross-tenant data.
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is required for the isolation tests');

export const adminClient = postgres(adminUrl, { max: 2 });
export const adminDb = drizzle(adminClient);

export type Row = Record<string, unknown>;
export const asRows = <T = Row>(r: unknown): T[] => r as unknown as T[];
