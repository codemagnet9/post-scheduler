// test/global-setup.ts
// Test isolation: CLEAN SCHEMA PER RUN. Before the suite starts, truncate every application table
// (keeping the schema and _migrations) so state never leaks across runs. Chosen over per-test
// teardown because most tests already create their own workspace — this just guarantees each run
// begins from empty, which is what was hiding the cross-run state-dependence.
import 'dotenv/config';
import postgres from 'postgres';

export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is required for the test globalSetup');
  const sql = postgres(adminUrl, { max: 1 });
  try {
    const tables = await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public' and tablename <> '_migrations'
    `;
    if (tables.length) {
      const list = tables.map((t) => `"${t.tablename}"`).join(', ');
      await sql.unsafe(`truncate table ${list} restart identity cascade`);
    }
  } finally {
    await sql.end();
  }
}
