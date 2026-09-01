// scripts/seed.ts
// Creates two demo workspaces, each with a member in every role. Idempotent on email.
// Run after `npm run migrate`. Connects as the app role (RLS enforced), same as production.
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { hashPassword } from '../src/auth/password';
import type { Role } from '../src/authz/abilities';

const DEMO_PASSWORD = 'password123';

async function upsertUser(email: string, name: string): Promise<string> {
  const pw = await hashPassword(DEMO_PASSWORD);
  const r = (await db.execute(sql`
    insert into users (email, name, password_hash, email_verified_at)
    values (${email}, ${name}, ${pw}, now())
    on conflict (email) do update set name = excluded.name
    returning id
  `)) as unknown as Array<{ id: string }>;
  return r[0].id;
}

async function seedWorkspace(label: string): Promise<{ workspaceId: string; owner: string }> {
  const roles: Role[] = ['owner', 'approver', 'editor', 'analyst'];
  const users: Record<Role, string> = {} as Record<Role, string>;
  for (const role of roles) {
    users[role] = await upsertUser(`${role}+${label.toLowerCase()}@demo.meridian`, `${role[0].toUpperCase()}${role.slice(1)} ${label}`);
  }
  const { workspaceId } = await createWorkspace(users.owner, `Demo ${label}`);
  await withTenant({ workspaceId, userId: users.owner, role: 'owner' }, async (tx) => {
    for (const role of ['approver', 'editor', 'analyst'] as Role[]) {
      await tx.execute(sql`
        insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${users[role]}, ${role})
        on conflict (workspace_id, user_id) do update set role = excluded.role
      `);
    }
  });
  return { workspaceId, owner: users.owner };
}

async function main(): Promise<void> {
  const a = await seedWorkspace('Alpha');
  const b = await seedWorkspace('Bravo');
  console.log('Seeded workspaces:');
  console.log(`  Demo Alpha  ${a.workspaceId}`);
  console.log(`  Demo Bravo  ${b.workspaceId}`);
  console.log('Logins (password for all): ' + DEMO_PASSWORD);
  console.log('  owner+alpha@demo.meridian, approver+alpha@demo.meridian, editor+alpha@demo.meridian, analyst+alpha@demo.meridian');
  console.log('  owner+bravo@demo.meridian, ... (same pattern)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
