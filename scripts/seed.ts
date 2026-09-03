// scripts/seed.ts
// Demo data that makes the app look ALIVE on first run — treated as a deliverable, not fixtures. One
// "Meridian Demo" workspace with all four roles, ten accounts spanning global + regional networks
// (demo/fake connections, not real OAuth), 90 days of published posts with plausible immutable metric
// snapshots, a full forward queue, three posts awaiting approval, one hard failure with a real-looking
// provider error, and one account that needs reconnecting.
//
// Idempotent: it deletes any prior "Meridian Demo" workspace (admin connection, cascade) then rebuilds.
// Run after `npm run migrate`. Business writes go through the app role (RLS enforced), same as prod.
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant, type Tx } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { hashPassword } from '../src/auth/password';
import { storeTokens } from '../src/vault/tokens';
import { maintenanceDb } from '../src/db/maintenance';
import type { Role } from '../src/authz/abilities';

const DEMO = 'Meridian Demo';
const PASSWORD = 'password123';
type R = Record<string, unknown>;
const rows = <T = R>(r: unknown): T[] => r as unknown as T[];
const NOW = Date.now();
const days = (d: number) => new Date(NOW - d * 86_400_000);
const ahead = (d: number, h = 15) => new Date(NOW + d * 86_400_000 + h * 3_600_000);
const iso = (d: Date) => d.toISOString();

// Deterministic PRNG so the demo is stable across runs.
let _s = 987654321;
const rnd = () => (_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const sample = <T>(a: T[], k: number): T[] => [...a].sort(() => rnd() - 0.5).slice(0, k);

// Global + regional networks. `metrics:false` networks expose NO impressions (analytics shows them as
// unavailable, never zero) — exactly the honesty the read models were built for.
const PROVIDERS = [
  { key: 'bluesky', name: 'Bluesky', tz: 'America/New_York', market: 'US', metrics: false },
  { key: 'x', name: 'X', tz: 'America/New_York', market: 'US', metrics: true },
  { key: 'linkedin', name: 'LinkedIn', tz: 'America/Los_Angeles', market: 'US', metrics: true },
  { key: 'instagram', name: 'Instagram', tz: 'America/Chicago', market: 'US', metrics: true },
  { key: 'threads', name: 'Threads', tz: 'Europe/London', market: 'GB', metrics: true },
  { key: 'mastodon', name: 'Mastodon', tz: 'Europe/Berlin', market: 'DE', metrics: false },
  { key: 'tiktok', name: 'TikTok', tz: 'America/Los_Angeles', market: 'US', metrics: true },
  { key: 'line', name: 'LINE', tz: 'Asia/Tokyo', market: 'JP', metrics: false },
  { key: 'vk', name: 'VK', tz: 'Europe/Moscow', market: 'RU', metrics: true },
  { key: 'zalo', name: 'Zalo', tz: 'Asia/Ho_Chi_Minh', market: 'VN', metrics: false },
];

const COPY = [
  'Big news: our winter release is live. Here is everything that shipped 🧵',
  'Behind the scenes of how we build — a quick look at this week.',
  'Customer spotlight: how Northwind cut their publishing time in half.',
  'We are hiring across engineering and design. Come build with us.',
  'Three lessons from scaling to a million scheduled posts.',
  'New guide: planning a 90-day content calendar that actually holds.',
  'Thank you to everyone who joined the launch stream today ❤️',
  'A small feature we are quietly proud of: audience-local scheduling.',
];

async function upsertUser(email: string, name: string): Promise<string> {
  const pw = await hashPassword(PASSWORD);
  return rows<{ id: string }>(await db.execute(sql`
    insert into users (email, name, password_hash, email_verified_at) values (${email}, ${name}, ${pw}, now())
    on conflict (email) do update set name = excluded.name returning id`))[0].id;
}

async function insertAccount(tx: Tx, workspaceId: string, connectedBy: string, p: typeof PROVIDERS[number], status: string): Promise<string> {
  const id = rows<{ id: string }>(await tx.execute(sql`
    insert into connected_accounts (workspace_id, provider, provider_account_id, handle, display_name, timezone, market, status, connected_by, last_synced_at)
    values (${workspaceId}, ${p.key}, ${'demo-' + p.key}, ${'@meridian_' + p.key}, ${'Meridian on ' + p.name}, ${p.tz}, ${p.market}, ${status}, ${connectedBy}, now())
    returning id`))[0].id;
  // Encrypted tokens so health/refresh render. The X account (auth_expired) still keeps its stored
  // tokens; the LinkedIn account gets a near-expiry refresh token to show the "expiring soon" state.
  const refreshExp = p.key === 'linkedin' ? days(-2) : days(-60);
  await storeTokens(tx, { connectedAccountId: id, workspaceId, credentials: { accessToken: `demo-access-${p.key}`, refreshToken: `demo-refresh-${p.key}`, accessExpiresAt: days(-30), refreshExpiresAt: refreshExp } });
  return id;
}

async function insertPost(tx: Tx, workspaceId: string, authorId: string, status: string, text: string): Promise<string> {
  const content = { text, link: rnd() > 0.6 ? 'https://meridian.example/blog' : null, firstComment: null, media: [] as string[] };
  return rows<{ id: string }>(await tx.execute(sql`
    insert into posts (workspace_id, author_id, status, content) values (${workspaceId}, ${authorId}, ${status}, ${JSON.stringify(content)}::jsonb) returning id`))[0].id;
}

async function insertSnapshot(tx: Tx, workspaceId: string, targetId: string, accountId: string, capturedAt: Date, hasImpr: boolean, scale: number): Promise<void> {
  const eng = int(5, 60) * scale;
  const impr = hasImpr ? int(400, 5000) * scale : null;       // unavailable networks store NULL, never 0
  const reach = hasImpr ? Math.round((impr as number) * 0.8) : null;
  const clicks = hasImpr ? int(2, 40) * scale : null;
  const m = { impressions: impr, reach, engagements: eng, clicks, saves: int(0, 8), shares: int(0, 12) };
  await tx.execute(sql`
    insert into metric_snapshots (workspace_id, post_target_id, connected_account_id, captured_at, metrics, impressions, reach, engagements, clicks, saves, shares)
    values (${workspaceId}, ${targetId}, ${accountId}, ${iso(capturedAt)}, ${JSON.stringify(m)}::jsonb, ${impr}, ${reach}, ${eng}, ${clicks}, ${m.saves}, ${m.shares})`);
}

async function main(): Promise<void> {
  // Idempotency: drop any prior demo workspace (admin conn, cascades to all children).
  await maintenanceDb.execute(sql`delete from workspaces where name = ${DEMO}`);

  const roles: Role[] = ['owner', 'approver', 'editor', 'analyst'];
  const users = {} as Record<Role, string>;
  for (const role of roles) users[role] = await upsertUser(`${role}@demo.meridian`, `${role[0].toUpperCase()}${role.slice(1)} Demo`);

  const { workspaceId } = await createWorkspace(users.owner, DEMO);
  const ctx = { workspaceId, userId: users.owner, role: 'owner' as const };

  await withTenant(ctx, async (tx) => {
    for (const role of ['approver', 'editor', 'analyst'] as Role[]) {
      await tx.execute(sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${users[role]}, ${role}) on conflict (workspace_id, user_id) do update set role = excluded.role`);
    }

    // 10 accounts; X needs reconnection (auth_expired).
    const accounts: Array<{ id: string; p: typeof PROVIDERS[number] }> = [];
    for (const p of PROVIDERS) {
      const status = p.key === 'x' ? 'auth_expired' : 'active';
      accounts.push({ id: await insertAccount(tx, workspaceId, users.owner, p, status), p });
    }
    // Mark the reconnection alert as already sent (so the UI shows the banner, not a fresh event storm).
    await tx.execute(sql`update connected_accounts set health_notified_status = 'auth_expired', health_notified_at = now() where workspace_id = ${workspaceId} and provider = 'x'`);
    const activeAccounts = accounts.filter((a) => a.p.key !== 'x');

    // 90 days of published history with immutable snapshots.
    let published = 0;
    for (let d = 89; d >= 1; d -= 1) {
      if (rnd() > 0.7) continue; // ~30% of days have a post => plausible cadence
      const author = pick([users.owner, users.editor, users.approver]);
      const postId = await insertPost(tx, workspaceId, author, 'published', pick(COPY));
      const chosen = sample(activeAccounts, int(1, 3));
      const publishedAt = days(d);
      for (const a of chosen) {
        const permalink = `https://${a.p.key}.example/p/${postId.slice(0, 8)}`;
        const tid = rows<{ id: string }>(await tx.execute(sql`
          insert into post_targets (post_id, workspace_id, connected_account_id, state, scheduled_at, publish_due_at, published_at, provider_post_id, provider_permalink, rendered_payload, attempt_count)
          values (${postId}, ${workspaceId}, ${a.id}, 'published', ${iso(publishedAt)}, ${iso(publishedAt)}, ${iso(publishedAt)}, ${'pp-' + postId.slice(0, 8)}, ${permalink}, ${JSON.stringify({ text: 'demo', media: [] })}::jsonb, 1)
          returning id`))[0].id;
        // Two immutable snapshots: +1h and +24h (growing), unavailable networks store NULL impressions.
        await insertSnapshot(tx, workspaceId, tid, a.id, new Date(publishedAt.getTime() + 3_600_000), a.p.metrics, 1);
        await insertSnapshot(tx, workspaceId, tid, a.id, new Date(publishedAt.getTime() + 86_400_000), a.p.metrics, int(2, 4));
      }
      await tx.execute(sql`update posts set status = 'published', updated_at = now() where id = ${postId}`);
      published += 1;
    }

    // A full forward QUEUE: weekly slots for two markets + scheduled posts landing in the next fortnight.
    for (const market of ['America/New_York', 'Asia/Tokyo']) {
      for (const dow of [1, 3, 5]) {
        for (const t of ['09:00', '17:00']) {
          await tx.execute(sql`insert into queue_slots (workspace_id, market_timezone, label, day_of_week, local_time) values (${workspaceId}, ${market}, ${'Prime'}, ${dow}, ${t}) on conflict do nothing`);
        }
      }
    }
    for (let i = 0; i < 16; i += 1) {
      const postId = await insertPost(tx, workspaceId, users.editor, 'scheduled', pick(COPY));
      const due = ahead(int(1, 14), int(8, 20));
      for (const a of sample(activeAccounts, int(1, 2))) {
        await tx.execute(sql`
          insert into post_targets (post_id, workspace_id, connected_account_id, state, scheduled_at, publish_due_at, rendered_payload)
          values (${postId}, ${workspaceId}, ${a.id}, 'scheduled', ${iso(due)}, ${iso(due)}, ${JSON.stringify({ text: 'demo', media: [] })}::jsonb)`);
      }
      await tx.execute(sql`update posts set status = 'scheduled', schedule_type = 'fixed_instant', scheduled_at = ${iso(due)}, updated_at = now() where id = ${postId}`);
    }

    // Three posts AWAITING APPROVAL (targets stay draft; one open approval request each).
    for (let i = 0; i < 3; i += 1) {
      const postId = await insertPost(tx, workspaceId, users.editor, 'pending_approval', pick(COPY));
      for (const a of sample(activeAccounts, 2)) {
        await tx.execute(sql`insert into post_targets (post_id, workspace_id, connected_account_id, state, rendered_payload) values (${postId}, ${workspaceId}, ${a.id}, 'draft', ${JSON.stringify({ text: 'demo', media: [] })}::jsonb)`);
      }
      await tx.execute(sql`insert into approval_requests (post_id, workspace_id, requested_by, status) values (${postId}, ${workspaceId}, ${users.editor}, 'pending')`);
    }

    // One post that FAILED on a real-looking provider error (partially published: one ok, one failed).
    const failPost = await insertPost(tx, workspaceId, users.owner, 'partially_published', 'Reminder: our webinar starts in one hour. Save your seat →');
    const okAcc = activeAccounts[0];
    const badAcc = activeAccounts[1];
    const okTid = rows<{ id: string }>(await tx.execute(sql`
      insert into post_targets (post_id, workspace_id, connected_account_id, state, published_at, provider_post_id, provider_permalink, rendered_payload, attempt_count)
      values (${failPost}, ${workspaceId}, ${okAcc.id}, 'published', ${iso(days(1))}, ${'pp-ok'}, ${'https://ok.example/p/1'}, ${JSON.stringify({ text: 'demo', media: [] })}::jsonb, 1) returning id`))[0].id;
    await insertSnapshot(tx, workspaceId, okTid, okAcc.id, days(0), okAcc.p.metrics, 2);
    const realError = { code: 'content_rejected', providerRaw: { error: 'DuplicateContent', message: 'Status is a duplicate of a recently posted status.', http_status: 403 }, plainLanguage: 'This network rejected the post as a duplicate of one posted in the last 24 hours.' };
    const failTid = rows<{ id: string }>(await tx.execute(sql`
      insert into post_targets (post_id, workspace_id, connected_account_id, state, failure_code, last_error, rendered_payload, attempt_count)
      values (${failPost}, ${workspaceId}, ${badAcc.id}, 'failed', 'content_rejected', ${JSON.stringify(realError)}::jsonb, ${JSON.stringify({ text: 'demo', media: [] })}::jsonb, 6) returning id`))[0].id;
    await tx.execute(sql`insert into dead_letters (workspace_id, post_target_id, reason, error) values (${workspaceId}, ${failTid}, 'content_rejected', ${JSON.stringify({ plainLanguage: realError.plainLanguage })}::jsonb) on conflict (post_target_id) do nothing`);

    console.log(`Seeded "${DEMO}"  workspace=${workspaceId}`);
    console.log(`  ${accounts.length} accounts (1 needs reconnect: X), ${published} published posts, 16 queued, 3 awaiting approval, 1 failed+dead-lettered`);
  });

  console.log('Logins (password for all): ' + PASSWORD);
  console.log('  owner@demo.meridian · approver@demo.meridian · editor@demo.meridian · analyst@demo.meridian');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
