// src/db/maintenance.ts
// A privileged connection for background workers to DISCOVER cross-tenant work (the due-scan, the
// lease sweeper, the refresh sweep, re-encryption). It bypasses RLS by virtue of the admin role, so
// it is used ONLY for read/claim scans — all business writes still happen in tenant context as
// meridian_app via withTenant. Keep this out of request paths.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const url = process.env.DATABASE_URL_ADMIN;
if (!url) throw new Error('DATABASE_URL_ADMIN is required for background workers');

export const maintenanceClient = postgres(url, { max: Number(process.env.PG_MAINT_POOL_MAX ?? 4) });
export const maintenanceDb = drizzle(maintenanceClient);
