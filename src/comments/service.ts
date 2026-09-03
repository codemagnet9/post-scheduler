// src/comments/service.ts
// Threaded notes on a post, visible to anyone who can see the post, with @mentions of workspace
// members. Comments are never deleted on publish — the history is the point.
import { sql } from 'drizzle-orm';
import { withTenant } from '../db/tenant';
import { pgArray } from '../db/index';
import { authorize, type Actor } from '../authz/abilities';
import { emitEvent } from '../events/emit';

export class CommentError extends Error {
  constructor(code: string) { super(code); this.name = 'CommentError'; }
}
export type ScopedActor = Actor & { workspaceId: string };
type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const ctxOf = (a: ScopedActor) => ({ workspaceId: a.workspaceId, userId: a.userId, role: a.role });
const DRAFTISH = ['draft', 'pending_approval', 'changes_requested', 'approved'];
const viewAbility = (status: string) => (DRAFTISH.includes(status) ? 'post:view_drafts' : 'post:view');

export async function addComment(actor: ScopedActor, postId: string, body: string, mentions: string[] = []) {
  return withTenant(ctxOf(actor), async (tx) => {
    const p = rows<{ author_id: string | null; status: string }>(await tx.execute(sql`select author_id, status from posts where id = ${postId}`))[0];
    if (!p) throw new CommentError('not_found');
    authorize(actor, viewAbility(p.status), { authorId: p.author_id ?? undefined }); // must be able to see the post

    // Keep only mentions that are real members of this workspace.
    const valid = mentions.length
      ? rows<{ user_id: string }>(await tx.execute(sql`select user_id from memberships where user_id = any(${pgArray(mentions)}::uuid[])`)).map((r) => r.user_id)
      : [];

    const c = rows<{ id: string }>(await tx.execute(sql`
      insert into comments (post_id, workspace_id, author_id, body, mentions)
      values (${postId}, ${actor.workspaceId}, ${actor.userId}, ${body}, ${JSON.stringify(valid)}::jsonb) returning id
    `))[0];

    if (valid.length) {
      await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post', aggregateId: postId, type: 'comment.mentioned', payload: { mentions: valid.filter((u) => u !== actor.userId), excerpt: body.slice(0, 120) } });
    }
    return { commentId: c.id };
  });
}

export async function listComments(actor: ScopedActor, postId: string) {
  return withTenant(ctxOf(actor), async (tx) => {
    const p = rows<{ author_id: string | null; status: string }>(await tx.execute(sql`select author_id, status from posts where id = ${postId}`))[0];
    if (!p) throw new CommentError('not_found');
    authorize(actor, viewAbility(p.status), { authorId: p.author_id ?? undefined });
    return tx.execute(sql`select id, author_id, body, mentions, created_at, edited_at from comments where post_id = ${postId} and deleted_at is null order by created_at`);
  });
}
