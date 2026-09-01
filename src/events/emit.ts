// src/events/emit.ts
// Minimal event emitter. Every state change appends here; webhooks, the activity feed and the audit
// projection read from it (full outbox dispatch is Phase 10). Called inside the change's tx.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/tenant';

export interface DomainEvent {
  workspaceId: string;
  aggregateType: string; // 'connected_account', 'post_target', ...
  aggregateId: string;
  type: string;          // 'connected_account.auth_expired', ...
  payload?: unknown;
}

export async function emitEvent(tx: Tx, e: DomainEvent): Promise<void> {
  await tx.execute(sql`
    insert into events (workspace_id, aggregate_type, aggregate_id, type, payload)
    values (${e.workspaceId}, ${e.aggregateType}, ${e.aggregateId}, ${e.type}, ${JSON.stringify(e.payload ?? {})}::jsonb)
  `);
}
