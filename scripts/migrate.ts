// scripts/migrate.ts
// Applies db/schema.sql (base) then db/migrations/*.sql in order, as the admin/owner role.
// Each step runs in its own transaction and is recorded in _migrations so re-runs are no-ops.
// Finally, sets the meridian_app role's password to match DATABASE_URL so the app can connect.
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const adminUrl = process.env.DATABASE_URL_ADMIN;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is required');
if (!appUrl) throw new Error('DATABASE_URL is required');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const sql = postgres(adminUrl, { max: 1 });

interface Step { name: string; path: string }

async function main(): Promise<void> {
  await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`;

  const steps: Step[] = [
    { name: '0001_init', path: join(root, 'db', 'schema.sql') },
    ...readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ name: f, path: join(migrationsDir, f) })),
  ];

  const applied = new Set((await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name));

  for (const step of steps) {
    if (applied.has(step.name)) {
      console.log(`· skip   ${step.name}`);
      continue;
    }
    const content = readFileSync(step.path, 'utf8');
    console.log(`→ apply  ${step.name}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`insert into _migrations (name) values (${step.name})`;
    });
  }

  // Ensure the app role can log in with the credentials in DATABASE_URL (role is created in 0004).
  const u = new URL(appUrl);
  const appUser = decodeURIComponent(u.username);
  const appPass = decodeURIComponent(u.password);
  if (appPass) {
    await sql.unsafe(`ALTER ROLE ${appUser} WITH LOGIN PASSWORD '${appPass.replace(/'/g, "''")}'`);
    console.log(`✓ set login password for role '${appUser}'`);
  }

  console.log('migrations complete');
  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
